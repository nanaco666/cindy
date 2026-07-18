#!/usr/bin/env node

// =============================================================================
// build-windows.mjs — CI 构建阶段：仅构建 Windows 安装包 + packaged 目录
//
// 用法: node scripts/ci/build-windows.mjs --version <x.y.z>
//
// 流程:
//   1. 写版本号到 package.json (退出时自动恢复)
//   2. db:validate 校验
//   3. electron-forge make (含 APP_VERSION 注入)
//   4. 找到 NSIS Setup.exe
//   5. 验证 packaged 内 drizzle 文件
//   6. 运行 packaged smoke test
//
// 输出:
//   out/<PACKAGED_APP_NAME>-win32-x64/                    (packaged 目录)
//   out/make/.../*Setup.exe                                (NSIS 安装包，未签名)
//
// 这一步不签名、不上传 OSS。后续由 publish-windows.mjs 接手。
// =============================================================================

import { execSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import {
  DESKTOP_ROOT,
  loadDotenv,
  writePackageVersion,
  runDbValidate,
  verifyPackagedDrizzle,
  runSmokeTest,
  PACKAGED_APP_NAME,
} from './lib.mjs';
import { desktopClientBuildEnv } from '../../../../scripts/shared/client-endpoint-build-env.mjs';

loadDotenv(undefined, { refreshReleaseConfig: false });

// ── 参数解析 ──────────────────────────────────────────────────────────────

function parseArgs() {
  const args = process.argv.slice(2);
  let version = null;
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--version' && args[i + 1]) { version = args[++i]; continue; }
  }
  if (!version) {
    console.error('ERROR: --version <x.y.z> is required');
    process.exit(1);
  }
  return { version };
}

// ── 找 Setup.exe ──────────────────────────────────────────────────────────

function findSetupExe(makeBaseDir) {
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

// ── Main ──────────────────────────────────────────────────────────────────

async function main() {
  const { version } = parseArgs();

  console.log('='.repeat(60));
  console.log(`==> Build Windows x64, version ${version}`);
  console.log('='.repeat(60));

  // 0. 必须有 NPKG_TOKEN——forge.config.ts 的 postPackage 钩子用它给
  //    Cindy.exe / cindy-updater.exe / xdt-helper.exe 签名。没签名的
  //    内部 exe 会让严格策略 Win 机器在 hot-update 后 spawn updater 时
  //    EACCES。允许 ALLOW_UNSIGNED_BUILD=1 显式跳过(本地调试用)。
  if (!process.env.NPKG_TOKEN && process.env.ALLOW_UNSIGNED_BUILD !== '1') {
    console.error('ERROR: NPKG_TOKEN is required for CI Windows builds.');
    console.error('       Without it, internal exes (Cindy, cindy-updater, xdt-helper) ship unsigned,');
    console.error('       breaking hot-update on machines that block unsigned exes from %TEMP%.');
    console.error('       Set NPKG_TOKEN=xxx, or ALLOW_UNSIGNED_BUILD=1 to override (local debug only).');
    process.exit(1);
  }

  // 1. 写版本号 (退出时自动恢复)
  writePackageVersion(version);

  // 2. db:validate
  runDbValidate();

  // 3. 清理 + electron-forge make
  const outDir = path.join(DESKTOP_ROOT, 'out');
  if (fs.existsSync(outDir)) {
    console.log('==> Cleaning previous build output...');
    try {
      fs.rmSync(outDir, { recursive: true, force: true });
    } catch (err) {
      console.error(`ERROR: Cannot remove ${outDir} — is ${PACKAGED_APP_NAME}.exe running or AV scanning it?`);
      console.error(err.message);
      process.exit(1);
    }
  }

  console.log('==> Running electron-forge make...');
  execSync('npx electron-forge make --platform win32 --arch x64', {
    cwd: DESKTOP_ROOT,
    stdio: 'inherit',
    env: {
      ...process.env,
      NODE_ENV: 'production',
      ...desktopClientBuildEnv(),
      APP_VERSION: version,
    },
  });

  // 4. 找到 Setup.exe
  const makeBaseDir = path.join(DESKTOP_ROOT, 'out', 'make');
  const exePath = findSetupExe(makeBaseDir);
  if (!exePath) {
    console.error('ERROR: No Setup.exe found under', makeBaseDir);
    process.exit(1);
  }
  console.log(`==> Found installer: ${path.basename(exePath)}`);

  // 5. 验证 drizzle 资源 (NSIS 直接打包 packagedDir，验证它即可)
  const packagedDir = path.join(DESKTOP_ROOT, 'out', `${PACKAGED_APP_NAME}-win32-x64`);
  const drizzleOut = path.join(packagedDir, 'resources', 'drizzle');
  verifyPackagedDrizzle(drizzleOut);

  // 6. Smoke test
  runSmokeTest('win32', 'x64');

  console.log('');
  console.log('=== Build complete ===');
  console.log(`Packaged dir: ${packagedDir}`);
  console.log(`Installer:    ${exePath}`);
  console.log(`Next:         node scripts/ci/publish-windows.mjs --version ${version}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
