#!/usr/bin/env node

// =============================================================================
// publish-desktop.mjs — 桌面端 canary 发布入口(只发布,不打包)
//
// 打包/发布拆分(2026-07)的发布侧:输入是 package-desktop.mjs 产出的
// build-info.json + 本地产物,职责是校验 → 上传 OSS → 更新 canary manifest。
// 全程不碰 electron-forge / 签名——签名在打包阶段已完成,这里只做门禁复核。
// canary 验证通过后用 promote-canary-*.mjs 提升 stable(三步模型的第三步)。
//
// 用法:
//   node scripts/publish-desktop.mjs --region cn --version 0.1.0 [options]
//
//   --region   cn|global|dev        默认 cn;决定发布目标(OSS bucket/prefix/CDN)
//   --version  x.y.z                必填;只认打包时定死的显式版本,不做 bump
//   --platform win32|darwin|linux   默认当前平台(发布是纯上传,允许跨平台代传)
//   --arch     x64|arm64            默认发布产物目录里该平台的全部 arch(mac 双架构)
//   --execute                       真正上传;缺省 dry-run 只校验并打印计划
//   --require-relogin               manifest 写 requireRelogin(强制更新后重登)
//   --force                         放行版本回退 / 覆盖远端已存在的同名产物对象
//
// 输入: release/artifacts/<region>/<version>/<platformKey>/build-info.json
// 上传: app/<platformKey>/<installer>、hotfix/<platformKey>/<hotfix zip>、
//       claude-code / codex 版本化 gz(与 CDN 比对,immutable 守卫)、
//       manifest-<platformKey>-canary.json
//
// 安全门禁(全部 fail closed):
//   - 渠道冻结硬闸(禁止发进老 /xdt-maker 前缀);
//   - build-info 与 --region/--version/platformKey 逐字段核对,versionless 拒发;
//   - 本地产物 sha256/size 与 build-info 复核(防拿错/损坏的产物);
//   - 签名门禁(win installerSigned / mac developer-id+notarized);
//   - 版本单调性(< CDN 当前版本默认拒绝,--force 才放行);
//   - 产物对象覆盖守卫(远端同名对象哈希不同默认拒绝,防 CDN 边缘缓存字节分裂)。
// =============================================================================

import fs from 'node:fs';
import path from 'node:path';
import { ensureBinary } from '../../../scripts/ensure-agent-binaries.mjs';
import { resolveReleaseCdnBaseUrl } from '../../../scripts/shared/release-env.mjs';
import {
  RELEASE_DIR,
  OSS_PREFIX,
  loadDotenv,
  sha256,
  refreshOssConfig,
  createOSSClient,
  uploadToOSS,
  uploadVersionedGzImmutable,
  maybeBuildClaudeCodeGz,
  maybeBuildCodexGz,
  assertNotPublishingCindyToLegacyChannel,
} from './ci/lib.mjs';
import { applyReleaseRegionConfigToEnv } from './ci/release-regions.mjs';
import { artifactRelDir } from './ci/package-lib.mjs';
import {
  parsePublishArgs,
  candidatePlatformKeys,
  validateBuildInfoForPublish,
  assertPublishableSigning,
  assertAgentProbeSupported,
  assertManifestAgentEntries,
  resolveVersionAdvance,
  applyAppToManifest,
  planArtifactUploads,
} from './ci/publish-lib.mjs';

// ── CDN manifest 读取(区域感知;ci/lib.mjs 的同名函数默认 cn,这里不用)──────

async function fetchWithRetry(url, { retries = 3, delayMs = 1000 } = {}) {
  let lastErr;
  for (let attempt = 1; attempt <= retries; attempt++) {
    try {
      return await fetch(url);
    } catch (err) {
      lastErr = err;
      const code = err?.cause?.code || err?.code || err?.message || String(err);
      console.warn(`    fetch ${url} failed (attempt ${attempt}/${retries}): ${code}; retrying in ${delayMs}ms`);
      await new Promise((r) => setTimeout(r, delayMs));
    }
  }
  throw lastErr;
}

// canary 优先、stable 兜底、双 404 = 全新渠道(null)。?t= cache-bust 必须带:
// CDN 边缘缓存的陈旧基线是 2026-07-03 事故的直接诱因。
async function fetchExistingManifest(cdnBase, platformKey) {
  const canaryUrl = `${cdnBase}/manifest-${platformKey}-canary.json?t=${Date.now()}`;
  const canaryRes = await fetchWithRetry(canaryUrl);
  if (canaryRes.ok) return await canaryRes.json();
  if (canaryRes.status !== 404) {
    throw new Error(`Failed to fetch canary manifest (${canaryRes.status}): ${canaryUrl}`);
  }
  console.warn('    canary manifest missing — falling back to stable manifest for baseline');
  const stableUrl = `${cdnBase}/manifest-${platformKey}.json?t=${Date.now()}`;
  const stableRes = await fetchWithRetry(stableUrl);
  if (stableRes.ok) return await stableRes.json();
  if (stableRes.status !== 404) {
    throw new Error(`Failed to fetch stable manifest (${stableRes.status}): ${stableUrl}`);
  }
  return null;
}

// ── 产物对象覆盖守卫 ─────────────────────────────────────────────────────────
//
// installer / hotfix 的 OSS key 含版本号,同 key 重传字节不同会与 CDN 边缘缓存
// 产生字节分裂(客户端 sha256 校验必失败)。上传时写 x-oss-meta-sha256,重发同
// 版本时按 meta 判定:同哈希 → 跳过(断点续跑幂等);不同/无 meta → 默认拒绝。

async function headObjectSha(client, ossKey) {
  try {
    const res = await client.head(ossKey);
    const headers = res?.res?.headers ?? {};
    const meta = res?.meta ?? {};
    return { exists: true, sha256: meta.sha256 ?? headers['x-oss-meta-sha256'] ?? null };
  } catch (err) {
    const status = err?.status ?? err?.res?.status;
    if (status === 404 || err?.code === 'NoSuchKey') return { exists: false, sha256: null };
    throw err;
  }
}

async function uploadArtifactGuarded(client, { ossKey, localPath, sha256: expectedSha, force }) {
  const remote = await headObjectSha(client, ossKey);
  if (remote.exists && remote.sha256 === expectedSha) {
    console.log(`    guard: ${ossKey} already holds the same bytes — skip upload`);
    return { uploaded: false };
  }
  if (remote.exists && !force) {
    throw new Error(
      `覆盖守卫: ${ossKey} 已存在且内容${remote.sha256 ? '不同' : '未知(无 sha meta,可能来自老发布脚本)'}`
      + `(remote sha256 ${remote.sha256 ?? '(none)'} vs local ${expectedSha})。`
      + '版本化产物路径不允许静默覆盖——覆盖会与 CDN 边缘缓存字节分裂(2026-07-03 事故同源)。'
      + '确认远端对象确实要替换时加 --force,覆盖后必须手动刷新内外网 CDN 该 URL 的缓存。',
    );
  }
  if (remote.exists) {
    console.warn(`    !! FORCE overwrite of existing object: ${ossKey}`);
    console.warn('    !! 上传完成后必须手动刷新内外网 CDN 该 URL 的缓存,否则边缘节点继续下发旧字节。');
  }
  await uploadToOSS(client, ossKey, localPath, { meta: { sha256: expectedSha } });
  return { uploaded: true };
}

// ── 本地产物完整性复核 ───────────────────────────────────────────────────────

function verifyLocalArtifact(artifactDir, fileEntry) {
  const localPath = path.join(artifactDir, fileEntry.name);
  if (!fs.existsSync(localPath)) {
    throw new Error(`产物文件缺失: ${localPath}`);
  }
  const actualSize = fs.statSync(localPath).size;
  if (actualSize !== fileEntry.size) {
    throw new Error(`产物 size 与 build-info 不符: ${localPath}(${actualSize} != ${fileEntry.size})`);
  }
  const actualSha = sha256(localPath);
  if (actualSha !== fileEntry.sha256) {
    throw new Error(`产物 sha256 与 build-info 不符: ${localPath}(产物可能损坏或被替换,请重新打包)`);
  }
  return localPath;
}

// ── agent 二进制(claude / codex)────────────────────────────────────────────
//
// 与 release-*.mjs 同一策略:本地 pin 版本与 CDN manifest 比对(版本或二进制
// 哈希任一不同就上传),版本化 gz 走 immutable 守卫。manifest 段用守卫返回值
// 回写(reuse 场景必须描述远端对象,不能用本地重压的值)。

async function publishAgentBinaries(client, manifest, platformKey, platform, force) {
  for (const kind of ['claude', 'codex']) {
    await ensureBinary(kind, platformKey);
  }

  const claudeBinaryName = platform === 'win32' ? 'claude.exe' : 'claude';
  const cc = await maybeBuildClaudeCodeGz({ platformKey, manifest, binaryName: claudeBinaryName });
  if (cc) {
    const fileRel = `claude-code/${cc.localCCVersion}/${platformKey}/${cc.gzName}`;
    console.log(`    Uploading ${cc.gzName} → ${OSS_PREFIX}/${fileRel}`);
    const pub = await uploadVersionedGzImmutable({
      client,
      ossKey: `${OSS_PREFIX}/${fileRel}`,
      gzPath: cc.gzPath,
      gzSha256: cc.ccHash,
      gzSize: cc.ccSize,
      binarySha256: cc.localBinHash,
      force,
    });
    manifest.claudeCode = {
      version: cc.localCCVersion,
      file: fileRel,
      sha256: pub.gzSha256,
      size: pub.gzSize,
      binarySha256: pub.binarySha256,
    };
  }

  const codexBinaryName = platform === 'win32' ? 'codex.exe' : 'codex';
  const codex = await maybeBuildCodexGz({ platformKey, manifest, binaryName: codexBinaryName });
  if (codex) {
    const fileRel = `codex/${codex.localCodexVersion}/${platformKey}/${codex.gzName}`;
    console.log(`    Uploading ${codex.gzName} → ${OSS_PREFIX}/${fileRel}`);
    const pub = await uploadVersionedGzImmutable({
      client,
      ossKey: `${OSS_PREFIX}/${fileRel}`,
      gzPath: codex.gzPath,
      gzSha256: codex.codexHash,
      gzSize: codex.codexSize,
      binarySha256: codex.localBinHash,
      force,
    });
    manifest.codex = {
      version: codex.localCodexVersion,
      file: fileRel,
      sha256: pub.gzSha256,
      size: pub.gzSize,
      binarySha256: pub.binarySha256,
    };
  }
}

// ── Main ────────────────────────────────────────────────────────────────────

async function main() {
  loadDotenv(undefined, { refreshReleaseConfig: false });
  let args;
  try {
    args = parsePublishArgs(process.argv.slice(2));
  } catch (err) {
    console.error(`ERROR: ${err.message}`);
    process.exit(1);
  }
  const { region, version, platform, arch, execute, force } = args;
  const requireRelogin =
    args.requireRelogin ||
    process.env.REQUIRE_RELOGIN === '1' ||
    process.env.REQUIRE_RELOGIN === 'true';

  // 跨平台代传硬闸:agent 二进制版本探测要执行目标平台的 claude/codex,
  // 必须在目标平台发版机上发布(dry-run 一并拦,提前暴露而不是 execute 才炸)。
  try {
    assertAgentProbeSupported(platform);
  } catch (err) {
    console.error(`ERROR: ${err.message}`);
    process.exit(1);
  }

  // ensureBinary 的 CDN fallback 按此 region 选择清单基址。
  process.env.CINDY_AUTH_REGION = region;
  // 发布目标(OSS/CDN 四件套)从发版机本地 release-regions.json 或 env 注入。
  applyReleaseRegionConfigToEnv(region);
  refreshOssConfig(region);
  // 渠道冻结硬闸:Cindy 布局产物禁止发布到老 /xdt-maker 前缀。
  assertNotPublishingCindyToLegacyChannel(OSS_PREFIX);
  const cdnBase = resolveReleaseCdnBaseUrl(region);

  // 发现待发布的 platformKey:产物目录里实际存在的 ∩ 本次指定的平台/arch。
  const candidates = candidatePlatformKeys(platform, arch);
  const platformKeys = candidates.filter((key) =>
    fs.existsSync(path.join(
      RELEASE_DIR,
      ...artifactRelDir({ region, version, versionless: false, platformKey: key }).split('/'),
      'build-info.json',
    )),
  );
  if (platformKeys.length === 0) {
    console.error(`ERROR: 在 release/artifacts/${region}/${version}/ 下没有找到 ${candidates.join(' / ')} 的 build-info.json。`);
    console.error(`       先打包: pnpm release:package -- --region ${region} --version ${version}`);
    process.exit(1);
  }

  console.log('='.repeat(60));
  console.log(`==> Publish Cindy desktop → canary${execute ? '' : ' [DRY RUN]'}`);
  console.log(`    region:    ${region}`);
  console.log(`    version:   ${version}`);
  console.log(`    platforms: ${platformKeys.join(', ')}`);
  console.log(`    CDN:       ${cdnBase}`);
  console.log(`    OSS:       prefix=${OSS_PREFIX}`);
  if (requireRelogin) console.log('    requireRelogin: true(更新后强制重登)');
  console.log('='.repeat(60));

  for (const platformKey of platformKeys) {
    console.log(`\n==> [${platformKey}] Validating artifacts...`);
    const artifactDir = path.join(
      RELEASE_DIR,
      ...artifactRelDir({ region, version, versionless: false, platformKey }).split('/'),
    );
    const buildInfo = JSON.parse(fs.readFileSync(path.join(artifactDir, 'build-info.json'), 'utf8'));
    const { installer, hotfix } = validateBuildInfoForPublish(buildInfo, { region, version, platformKey });
    assertPublishableSigning(buildInfo);

    const localPaths = {
      installer: verifyLocalArtifact(artifactDir, installer),
      hotfix: hotfix ? verifyLocalArtifact(artifactDir, hotfix) : null,
    };
    console.log(`    build-info OK: commit=${(buildInfo.commitSha || '(none)').slice(0, 12)} buildTime=${buildInfo.buildTime}`);
    console.log(`    integrity OK: installer + ${hotfix ? 'hotfix' : '(no hotfix, installer-only)'}`);

    const existingManifest = await fetchExistingManifest(cdnBase, platformKey);
    const advance = resolveVersionAdvance({
      newVersion: version,
      cdnVersion: existingManifest?.app?.version,
      force,
    });
    console.log(`    CDN baseline: ${existingManifest?.app?.version ?? '(none — fresh channel)'} → ${version} (${advance.kind})`);

    const manifest = applyAppToManifest(existingManifest, {
      platform: buildInfo.platform,
      platformKey,
      version,
      requireRelogin,
      installer,
      hotfix,
    });
    const uploads = planArtifactUploads(OSS_PREFIX, platformKey, { installer, hotfix });

    if (!execute) {
      console.log('    [DRY RUN] would upload:');
      for (const u of uploads) {
        console.log(`      [${u.role}] ${u.name}  ${(u.size / 1024 / 1024).toFixed(1)} MB → ${u.ossKey}`);
      }
      console.log(`      [manifest] manifest-${platformKey}-canary.json → ${OSS_PREFIX}/manifest-${platformKey}-canary.json`);
      console.log('      [agents]   claude/codex 与 CDN 比对后按需上传(dry-run 跳过比对)');
      continue;
    }

    const client = createOSSClient();

    // 铁律:先传二进制、后传 manifest——manifest 一旦可见,其指向的对象必须已就位。
    console.log(`\n==> [${platformKey}] Publishing agent binaries...`);
    await publishAgentBinaries(client, manifest, platformKey, buildInfo.platform, force);
    // 出闸断言:claudeCode / codex 段必须完整(兜住全新渠道 + 本地探测失败的静默缺口)。
    assertManifestAgentEntries(manifest);

    console.log(`\n==> [${platformKey}] Uploading app artifacts...`);
    for (const u of uploads) {
      console.log(`    Uploading ${u.name} → ${u.ossKey}`);
      await uploadArtifactGuarded(client, {
        ossKey: u.ossKey,
        localPath: u.role === 'installer' ? localPaths.installer : localPaths.hotfix,
        sha256: u.sha256,
        force,
      });
    }

    const manifestName = `manifest-${platformKey}-canary.json`;
    const manifestPath = path.join(artifactDir, manifestName);
    fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2) + '\n');
    const manifestOssKey = `${OSS_PREFIX}/${manifestName}`;
    console.log(`    Uploading ${manifestName} → ${manifestOssKey}`);
    await uploadToOSS(client, manifestOssKey, manifestPath, {
      headers: { 'Cache-Control': 'no-cache' },
    });

    console.log(`\n==> [${platformKey}] Published to canary:`);
    console.log(`    Installer: ${cdnBase}/app/${platformKey}/${installer.name}`);
    if (hotfix) console.log(`    Hotfix:    ${cdnBase}/hotfix/${platformKey}/${hotfix.name}`);
    console.log(`    Manifest:  ${cdnBase}/${manifestName}`);
  }

  console.log('');
  if (!execute) {
    console.log('=== Dry run complete — 加 --execute 真正上传 ===');
    return;
  }
  console.log('=== Canary publish complete ===');
  const promoteCmd = platform === 'darwin' ? 'release:promote:mac' : platform === 'win32' ? 'release:promote:win' : 'release:promote:linux';
  const regionSuffix = platform === 'linux' ? '' : `:${region}`;
  console.log(`canary 验证通过后发布 stable: pnpm ${promoteCmd}${regionSuffix} --yes`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
