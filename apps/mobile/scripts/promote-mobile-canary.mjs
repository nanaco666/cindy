#!/usr/bin/env node
// =============================================================================
// promote-mobile-canary.mjs —— Mobile 自建线 canary → stable
//
// 不重复上传 IPA/APK、OTA bundle 或 assets，只提升可变 JSON 指针：
//   canary-release.json -> release.json（必有）
//   canary-latest.json  -> latest.json（当前 runtime 有 canary OTA 时才提升）
//
// 默认 dry-run；--yes 才写 OSS。安装地址等 release record 字段保持原样复制。
// =============================================================================

import { mkdtempSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import { parseArgs } from './release-lib.mjs';
import {
  assertMobilePlatform,
  assertExpoManifestForPromotion,
  assertReleaseRecordForPromotion,
  baselineRuntimeVersion,
  buildOtaPointerLocation,
  buildReleasePointerLocation,
  fetchJsonPointer,
} from './lib/release-pointers.mjs';
import {
  assertRegionOssComplete,
  regionEnvOverrides,
  resolveSelfHostRegion,
} from './lib/self-host-region.mjs';
import {
  CDN_BASE,
  OSS_PREFIX,
  createOSSClient,
  deleteFromOSS,
  refreshOssConfig,
  uploadToOSS,
} from '../../../scripts/shared/oss.mjs';

function safeSegment(value, fallback) {
  const normalized = String(value ?? '').trim().replace(/[^A-Za-z0-9._-]+/g, '-');
  return normalized || fallback;
}

async function uploadJson(client, key, value) {
  const dir = mkdtempSync(join(tmpdir(), 'cindy-mobile-promote-'));
  const file = join(dir, 'pointer.json');
  writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`);
  await uploadToOSS(client, key, file, { headers: { 'Content-Type': 'application/json' } });
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const platform = assertMobilePlatform(args.platform);
  const region = resolveSelfHostRegion(args);
  const yes = args.yes === true;

  Object.assign(process.env, regionEnvOverrides(region));
  refreshOssConfig();
  if (yes) assertRegionOssComplete(region);

  const canaryRelease = buildReleasePointerLocation({
    cdnBase: CDN_BASE, ossPrefix: OSS_PREFIX, platform, channel: 'canary',
  });
  const stableRelease = buildReleasePointerLocation({
    cdnBase: CDN_BASE, ossPrefix: OSS_PREFIX, platform, channel: 'stable',
  });

  const canaryBaseline = {
    record: await fetchJsonPointer(canaryRelease.url),
    source: 'canary',
    url: canaryRelease.url,
  };
  const canaryRecord = assertReleaseRecordForPromotion(canaryBaseline);
  const runtimeVersion = baselineRuntimeVersion(canaryBaseline);
  const canaryLatest = buildOtaPointerLocation({
    cdnBase: CDN_BASE, ossPrefix: OSS_PREFIX, platform, runtimeVersion, channel: 'canary',
  });
  const stableLatest = buildOtaPointerLocation({
    cdnBase: CDN_BASE, ossPrefix: OSS_PREFIX, platform, runtimeVersion, channel: 'stable',
  });

  const [stableRecord, canaryManifest, currentStableManifest] = await Promise.all([
    fetchJsonPointer(stableRelease.url),
    fetchJsonPointer(canaryLatest.url),
    fetchJsonPointer(stableLatest.url),
  ]);

  if (canaryManifest) {
    assertExpoManifestForPromotion(canaryManifest, runtimeVersion, canaryLatest.url);
  }

  console.log('');
  console.log(`=== Mobile canary → stable (${platform}, region=${region.authRegion}) ===`);
  console.log(`canary release : ${canaryRelease.url}`);
  console.log(`stable release : ${stableRelease.url}`);
  console.log(`version        : ${String(canaryRecord.version ?? '')}`);
  console.log(`buildNumber    : ${String(canaryRecord.buildNumber ?? '')}`);
  console.log(`runtimeVersion : ${runtimeVersion}`);
  console.log(`canary OTA     : ${canaryManifest ? canaryLatest.url : '(无,不改 stable latest.json)'}`);

  if (!yes) {
    console.log('dry-run:未写线上；确认后加 --yes');
    return;
  }

  const client = createOSSClient();
  const backupId = safeSegment(
    stableRecord?.buildNumber ?? stableRecord?.version,
    `pre-first-${Date.now()}`,
  );
  const backupRoot = `${OSS_PREFIX}/back-up/mobile/${platform}/${backupId}`;

  // 任何即将被覆盖的 stable 指针先备份；备份失败会抛错，提升随即中止。
  if (stableRecord) {
    await uploadJson(client, `${backupRoot}/release.json`, stableRecord);
    console.log(`backup stable release → ${backupRoot}/release.json`);
  }
  if (canaryManifest && currentStableManifest) {
    await uploadJson(client, `${backupRoot}/${runtimeVersion}/latest.json`, currentStableManifest);
    console.log(`backup stable OTA     → ${backupRoot}/${runtimeVersion}/latest.json`);
  }

  // OTA 指针先就绪，整包 release 指针最后切换，避免 stable release 已宣告新 runtime
  // 而同一轮准备好的 stable OTA 指针尚未可读。每个成功写入都登记，后续失败时
  // 按相反顺序恢复旧值；原来没有指针则删除新 key，避免留下半提升状态。
  let stableLatestWritten = false;
  let stableReleaseWritten = false;
  try {
    if (canaryManifest) {
      stableLatestWritten = true;
      await uploadJson(client, stableLatest.key, canaryManifest);
      console.log(`promote OTA            → ${stableLatest.url}`);
    }
    stableReleaseWritten = true;
    await uploadJson(client, stableRelease.key, canaryRecord);
    console.log(`promote release        → ${stableRelease.url}`);
  } catch (error) {
    console.error(`promote 写入失败: ${error instanceof Error ? error.message : String(error)}`);
    const rollbackErrors = [];
    const rollback = async (written, key, previous, label) => {
      if (!written) return;
      try {
        if (previous) {
          await uploadJson(client, key, previous);
        } else {
          await deleteFromOSS(client, key);
        }
        console.error(`rollback ${label} 完成`);
      } catch (rollbackError) {
        rollbackErrors.push(`${label}: ${rollbackError instanceof Error ? rollbackError.message : String(rollbackError)}`);
        console.error(`rollback ${label} 失败: ${rollbackErrors.at(-1)}`);
      }
    };
    // release 是最后写入的，先回滚它，再回滚 OTA，恢复到提升前的可读组合。
    await rollback(stableReleaseWritten, stableRelease.key, stableRecord, 'stable release');
    await rollback(stableLatestWritten, stableLatest.key, currentStableManifest, 'stable OTA');
    const suffix = rollbackErrors.length
      ? `；回滚也失败(${rollbackErrors.join('；')})，请立即按 backup 路径人工恢复`
      : '；已恢复提升前指针状态';
    throw new Error(`mobile canary promote 未完成${suffix}`);
  }
  console.log('=== Mobile promote complete ===');
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});
