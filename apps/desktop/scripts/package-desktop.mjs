#!/usr/bin/env node

// =============================================================================
// package-desktop.mjs — 桌面端统一打包入口(只打包,不发布)
//
// 打包/发布拆分(2026-07):本脚本产出可分发的本地产物 + build-info.json,
// 全程不写 OSS/CDN;发布(上传、update manifest、canary/stable)由后续的
// publish 侧脚本读 build-info.json 接手。
//
// 用法:
//   node scripts/package-desktop.mjs [options]
//
//   --platform win32|darwin|linux   默认当前平台(不支持交叉打包)
//   --arch     x64|arm64            默认当前 arch
//   --region   cn|global            默认 cn;烘焙 auth region + 端点清单自举基址
//   --channel  dev|release          默认 dev;当前只进产物目录与 build-info
//                                   (per-channel 端点/更新目标随发布侧重构落地)
//   --version  x.y.z|major|minor|patch
//              缺省 = 版本无关打包:占位版本 0.0.0,包不参与热更新
//              (updateService 对 0.0.0 短路),开源社区拉仓即可打;
//              bump 关键字会只读拉一次 CDN manifest 取基线——这是打包阶段
//              仅存的 CDN 依赖,显式 x.y.z 则完全离线。
//   --skip-smoke                    跳过 packaged smoke test(调试用)
//   --allow-unsigned                有版本打包放行无签名(win 缺 NPKG_TOKEN /
//                                   mac 缺 APPLE_APP_PASSWORD 时降级 ad-hoc)
//   --no-sign                       主动跳过签名(即使凭证在手;隐含 --allow-unsigned)。
//                                   npkg 签名产物下载要求内网,非内网机器打
//                                   版本无关包时用它
//
// 产物: release/artifacts/<region>-<channel>/<version|dev>/<platform-arch>/
//   cindy-<version|dev>-Setup.exe / -<arch>.dmg / .deb   安装包
//   cindy-<version>-hotfix.zip                           热更包(仅有版本时)
//   build-info.json                                      发布侧唯一输入
// =============================================================================

import { execSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { ensureBinary } from '../../../scripts/ensure-agent-binaries.mjs';
import { productionViteEnv } from '../../../scripts/shared/production-endpoints.mjs';
import {
  DESKTOP_ROOT,
  RELEASE_DIR,
  PACKAGED_APP_NAME,
  loadDotenv,
  exec,
  sha256,
  writePackageVersion,
  runDbValidate,
  verifyPackagedDrizzle,
  runSmokeTest,
  fetchExistingManifestIfAvailable,
  findInstallerArtifact,
  ensureLinuxRuntimeAssets,
  logLinuxPackagingRequirements,
  writeMacEntitlements,
  adhocSignMacApp,
  resolveAppleIdentity,
  signMacAppWithIdentity,
  notarizeMacApp,
  createMacDMG,
} from './ci/lib.mjs';
import {
  parsePackageArgs,
  resolvePackageVersion,
  artifactRelDir,
  artifactBaseName,
  buildBuildInfo,
} from './ci/package-lib.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// ── 构建元数据收集(commit / drizzle journal / electron 版本)────────────────

function collectBuildMeta() {
  const journal = JSON.parse(
    fs.readFileSync(path.join(DESKTOP_ROOT, 'drizzle', 'meta', '_journal.json'), 'utf8'),
  );
  const entries = Array.isArray(journal.entries) ? journal.entries : [];
  const schemaVersionMax = entries.reduce(
    (max, e) => (typeof e.idx === 'number' && e.idx > max ? e.idx : max),
    -1,
  );
  const migrationFiles = fs
    .readdirSync(path.join(DESKTOP_ROOT, 'drizzle'))
    .filter((f) => /^\d{4}_.*\.sql$/.test(f))
    .sort();

  let commitSha = '';
  try {
    commitSha = execSync('git rev-parse HEAD', { encoding: 'utf8', cwd: DESKTOP_ROOT }).trim();
  } catch { /* not in a git work tree */ }

  let electronVersion = '';
  try {
    const pkg = JSON.parse(fs.readFileSync(path.join(DESKTOP_ROOT, 'package.json'), 'utf8'));
    electronVersion = pkg.devDependencies?.electron ?? '';
  } catch { /* ignore */ }

  return { schemaVersionMax, migrationFiles, commitSha, electronVersion };
}

// ── CDN 基线(仅 --version major/minor/patch 时调用,只读)─────────────────────

async function fetchCdnBaselineVersion(platformKey) {
  // mac 双架构 manifest 同版本,任一即可;win/linux 用各自 key。
  const manifest = await fetchExistingManifestIfAvailable(platformKey);
  if (!manifest) {
    throw new Error(`CDN 上没有 ${platformKey} 的 manifest,无法计算 bump 基线;请显式传 --version x.y.z`);
  }
  return manifest.app?.version ?? '';
}

// ── 通用步骤 ────────────────────────────────────────────────────────────────

function cleanOutDir() {
  const outDir = path.join(DESKTOP_ROOT, 'out');
  if (!fs.existsSync(outDir)) return;
  console.log('==> Cleaning previous build output...');
  try {
    fs.rmSync(outDir, { recursive: true, force: true });
  } catch (err) {
    console.error(`ERROR: Cannot remove ${outDir} — is ${PACKAGED_APP_NAME} still running or antivirus scanning it?`);
    console.error(err.message);
    process.exit(1);
  }
}

function runForgeMake({ platform, arch, region, version, noSign }) {
  console.log('==> Building remote bundles...');
  execSync('node scripts/build-remote-bundles.mjs', { cwd: DESKTOP_ROOT, stdio: 'inherit' });

  console.log(`==> Running electron-forge make (${platform}-${arch}, region=${region})...`);
  const forgeEnv = {
    ...process.env,
    NODE_ENV: 'production',
    // 烘焙面 = 构建身份三件套(appId/region + 端点清单自举基址),按 region 二选一。
    ...productionViteEnv({ allowEnvOverride: false, authRegion: region }),
    // forge.config.ts 的 NSIS appId / AUMID 优先读这个(与 VITE_ 同源,双保险)。
    CINDY_AUTH_REGION: region,
    // forge.config.ts 注入 packagerConfig.appVersion;版本无关时为占位 0.0.0。
    APP_VERSION: version,
  };
  // Git Bash(agent 常用 shell)会导出 NoDefaultCurrentDirectoryInExePath=1,
  // 使 cmd.exe 不再搜索当前目录——node-pty rebuild 时 winpty.gyp 的
  // `cmd /c "cd shared && GetCommitHash.bat"` 会直接 not recognized 挂掉。
  // 人类在 cmd/PowerShell 跑没有这个变量;这里对构建子进程摘掉它,
  // 把 agent shell 归一到人类 shell 的行为(仅作用于 forge make 子进程)。
  for (const key of Object.keys(forgeEnv)) {
    if (key.toLowerCase() === 'nodefaultcurrentdirectoryinexepath') delete forgeEnv[key];
  }
  // --no-sign:摘掉 NPKG_TOKEN,让 forge postPackage 的内部 exe 签名一并跳过
  // (它只认这个 env;不摘的话非内网机器会在签名产物下载 403 上挂整个 make)。
  if (noSign) delete forgeEnv.NPKG_TOKEN;
  execSync(`npx electron-forge make --platform ${platform} --arch ${arch}`, {
    cwd: DESKTOP_ROOT,
    stdio: 'inherit',
    env: forgeEnv,
  });
}

function fileEntry(role, filePath) {
  return {
    role,
    name: path.basename(filePath),
    sha256: sha256(filePath),
    size: fs.statSync(filePath).size,
  };
}

function signWindowsInstaller(exePath, token) {
  const signScript = path.join(__dirname, 'sign.py');
  execSync(`python "${signScript}" "${path.resolve(exePath)}" "${token}"`, { stdio: 'inherit' });
}

// ── 平台收尾:签名 + 产物归集,返回 files/signing 供 build-info ────────────────

function findSetupExe(makeBaseDir) {
  // 只认文件名含 setup 的 .exe(NSIS 产物目录里可能还有其它 exe)。
  function walk(dir) {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        const found = walk(full);
        if (found) return found;
      } else if (entry.name.endsWith('.exe') && entry.name.toLowerCase().includes('setup')) {
        return full;
      }
    }
    return null;
  }
  return walk(makeBaseDir);
}

async function finishWindows({ artifactDir, baseName, versionless, allowUnsigned, noSign }) {
  const makeBaseDir = path.join(DESKTOP_ROOT, 'out', 'make');
  const setupExe = findSetupExe(makeBaseDir);
  if (!setupExe) {
    console.error(`ERROR: No Setup.exe found under ${makeBaseDir}`);
    process.exit(1);
  }

  const installerPath = path.join(artifactDir, `${baseName}-Setup.exe`);
  fs.copyFileSync(setupExe, installerPath);

  // 签名策略:有版本的包默认必须签(NPKG_TOKEN);版本无关包缺 token 时放行。
  // 注意 forge postPackage 已用同一 token 签过内部 exe(Cindy/cindy-updater/
  // xdt-helper),没 token 时那步也被静默跳过——所以这里的报错要提示两层影响。
  const npkgToken = noSign ? undefined : process.env.NPKG_TOKEN;
  let installerSigned = false;
  if (noSign) {
    console.log('==> --no-sign: skipping installer and internal exe signing');
  }
  if (npkgToken) {
    console.log('==> Signing installer via npkg...');
    signWindowsInstaller(installerPath, npkgToken);
    installerSigned = true;
  } else if (!versionless && !allowUnsigned) {
    console.error('ERROR: 有版本的 Windows 打包要求 NPKG_TOKEN(安装包 + 内部 exe 签名)。');
    console.error('       缺签名的包在严格策略 Windows 机器上热更/启动会被拦。');
    console.error('       确要产出未签名包时加 --allow-unsigned。');
    process.exit(1);
  } else {
    console.log('==> NPKG_TOKEN not set — installer and internal exes are UNSIGNED');
  }

  const files = [fileEntry('installer', installerPath)];

  // 热更 ZIP 只对有版本的包有意义(版本无关包不参与热更新)。
  if (!versionless) {
    const packagedDir = path.join(DESKTOP_ROOT, 'out', `${PACKAGED_APP_NAME}-win32-x64`);
    const hotfixZipPath = path.join(artifactDir, `${baseName}-hotfix.zip`);
    console.log('==> Creating hotfix ZIP from packaged app...');
    if (fs.existsSync(hotfixZipPath)) fs.unlinkSync(hotfixZipPath);
    execSync(
      `powershell -NoProfile -Command "Compress-Archive -Path '${packagedDir}\\*' -DestinationPath '${hotfixZipPath}'"`,
      { stdio: 'inherit' },
    );
    files.push(fileEntry('hotfix', hotfixZipPath));
  }

  return { files, signing: { installerSigned, internalExesSigned: Boolean(npkgToken) } };
}

async function finishDarwin({ artifactDir, baseName, arch, versionless, allowUnsigned, noSign, version }) {
  const packagedDir = path.join(DESKTOP_ROOT, 'out', `${PACKAGED_APP_NAME}-darwin-${arch}`);
  const appPath = path.join(packagedDir, `${PACKAGED_APP_NAME}.app`);
  if (!fs.existsSync(appPath)) {
    console.error(`ERROR: ${appPath} not found`);
    process.exit(1);
  }

  fs.mkdirSync(RELEASE_DIR, { recursive: true });
  const helperEntitlementsPath = path.join(RELEASE_DIR, 'build-helper.entitlements');
  const mainEntitlementsPath = path.join(RELEASE_DIR, 'build-main.entitlements');
  writeMacEntitlements(helperEntitlementsPath);
  writeMacEntitlements(mainEntitlementsPath, { appleEvents: true });

  const applePassword = noSign ? undefined : process.env.APPLE_APP_PASSWORD;
  const wantsRealSigning = !versionless && !noSign;
  let signingMode = 'adhoc';

  if (wantsRealSigning && !applePassword && !allowUnsigned) {
    console.error('ERROR: 有版本的 macOS 打包要求 APPLE_APP_PASSWORD(Developer ID 签名 + 公证)。');
    console.error('       确要降级 ad-hoc 签名时加 --allow-unsigned(产物无法过 Gatekeeper 分发)。');
    process.exit(1);
  }

  const files = [];
  if (wantsRealSigning && applePassword) {
    const identity = { ...resolveAppleIdentity(), applePassword };
    console.log('==> Signing (Developer ID)...');
    signMacAppWithIdentity(appPath, helperEntitlementsPath, mainEntitlementsPath, identity);
    console.log('==> Notarizing...');
    notarizeMacApp(appPath, identity);
    signingMode = 'developer-id+notarized';

    const dmgPath = path.join(artifactDir, `${baseName}-${arch}.dmg`);
    console.log('==> Creating DMG...');
    createMacDMG(appPath, dmgPath, `Cindy ${version}`, identity);
    files.push(fileEntry('installer', dmgPath));

    const hotfixZipPath = path.join(artifactDir, `${baseName}-${arch}-hotfix.zip`);
    console.log('==> Creating hotfix ZIP...');
    if (fs.existsSync(hotfixZipPath)) fs.unlinkSync(hotfixZipPath);
    exec(`/usr/bin/ditto -c -k "${packagedDir}" "${hotfixZipPath}"`);
    files.push(fileEntry('hotfix', hotfixZipPath));
  } else {
    // 版本无关(或显式放行)→ ad-hoc 签名,产出 .app 的 zip 供本机/内部试用。
    adhocSignMacApp(appPath, helperEntitlementsPath, mainEntitlementsPath);
    const appZipPath = path.join(artifactDir, `${baseName}-${arch}.zip`);
    console.log('==> Creating app ZIP (ad-hoc signed)...');
    if (fs.existsSync(appZipPath)) fs.unlinkSync(appZipPath);
    exec(`/usr/bin/ditto -c -k --keepParent "${appPath}" "${appZipPath}"`);
    files.push(fileEntry('installer', appZipPath));
  }

  return { files, signing: { mode: signingMode } };
}

async function finishLinux({ artifactDir, baseName }) {
  const makeBaseDir = path.join(DESKTOP_ROOT, 'out', 'make');
  const debPath = findInstallerArtifact(makeBaseDir, 'deb');
  if (!debPath) {
    console.error(`ERROR: No .deb found under ${makeBaseDir}`);
    process.exit(1);
  }
  const installerPath = path.join(artifactDir, `${baseName}-amd64.deb`);
  fs.copyFileSync(debPath, installerPath);
  // Linux 首发无热更链路(见 ci/lib.mjs createLinuxFirstReleaseManifest),只出安装包。
  return { files: [fileEntry('installer', installerPath)], signing: { mode: 'none' } };
}

// ── Main ────────────────────────────────────────────────────────────────────

async function main() {
  loadDotenv();
  let args;
  try {
    args = parsePackageArgs(process.argv.slice(2));
  } catch (err) {
    console.error(`ERROR: ${err.message}`);
    process.exit(1);
  }
  const { platform, arch, region, channel, versionSpec, skipSmoke, allowUnsigned, noSign } = args;
  const platformKey = `${platform}-${arch}`;

  if (platform !== process.platform) {
    console.error(`ERROR: 不支持交叉打包(当前 ${process.platform},目标 ${platform});请在目标平台机器上执行。`);
    process.exit(1);
  }

  const { version, versionless } = await resolvePackageVersion(versionSpec, () =>
    fetchCdnBaselineVersion(platform === 'darwin' ? 'darwin-arm64' : platformKey),
  );

  console.log('='.repeat(60));
  console.log(`==> Package Cindy desktop`);
  console.log(`    platform: ${platformKey}`);
  console.log(`    region:   ${region}`);
  console.log(`    channel:  ${channel}(当前仅记录进产物;发布目标随发布侧重构生效)`);
  console.log(`    version:  ${versionless ? `(版本无关,占位 ${version},不参与热更新)` : version}`);
  console.log('='.repeat(60));

  // agent 二进制按需下载(packaged extraResource + 后续发布上传都要用)。
  if (platform === 'linux') {
    await ensureLinuxRuntimeAssets();
    logLinuxPackagingRequirements();
  } else {
    for (const kind of ['claude', 'codex', 'ripgrep']) {
      await ensureBinary(kind, platformKey);
    }
  }

  runDbValidate();

  // 版本号临时写入 package.json(asar 内 app.getVersion() 的来源),退出自动恢复。
  writePackageVersion(version);

  cleanOutDir();
  runForgeMake({ platform, arch, region, version, noSign });

  // drizzle 资源校验(平台差异只在 packaged 内路径)。
  const drizzleOut =
    platform === 'darwin'
      ? path.join(DESKTOP_ROOT, 'out', `${PACKAGED_APP_NAME}-darwin-${arch}`, `${PACKAGED_APP_NAME}.app`, 'Contents', 'Resources', 'drizzle')
      : path.join(DESKTOP_ROOT, 'out', `${PACKAGED_APP_NAME}-${platformKey}`, 'resources', 'drizzle');
  verifyPackagedDrizzle(drizzleOut);

  if (skipSmoke) {
    console.log('==> Skipping packaged smoke test (--skip-smoke)');
  } else {
    runSmokeTest(platform, arch);
  }

  // 产物目录
  const artifactDir = path.join(
    RELEASE_DIR,
    ...artifactRelDir({ region, channel, version, versionless, platformKey }).split('/'),
  );
  fs.rmSync(artifactDir, { recursive: true, force: true });
  fs.mkdirSync(artifactDir, { recursive: true });
  const baseName = artifactBaseName({ version, versionless });

  const finishers = { win32: finishWindows, darwin: finishDarwin, linux: finishLinux };
  const { files, signing } = await finishers[platform]({
    artifactDir,
    baseName,
    arch,
    version,
    versionless,
    allowUnsigned,
    noSign,
  });

  const meta = collectBuildMeta();
  const buildInfo = buildBuildInfo({
    version,
    versionless,
    region,
    channel,
    platform,
    arch,
    commitSha: meta.commitSha,
    electronVersion: meta.electronVersion,
    schemaVersionMax: meta.schemaVersionMax,
    migrationFiles: meta.migrationFiles,
    files,
    signing,
  });
  const buildInfoPath = path.join(artifactDir, 'build-info.json');
  fs.writeFileSync(buildInfoPath, JSON.stringify(buildInfo, null, 2) + '\n');

  console.log('');
  console.log('=== Package complete ===');
  console.log(`Artifacts:  ${artifactDir}`);
  for (const f of files) {
    console.log(`  [${f.role}] ${f.name}  ${(f.size / 1024 / 1024).toFixed(1)} MB  sha256=${f.sha256.slice(0, 12)}…`);
  }
  console.log(`Build info: ${buildInfoPath}`);
  if (versionless) {
    console.log('注意: 版本无关包(0.0.0)不参与热更新,仅供本地/社区使用,不能作为发布产物。');
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
