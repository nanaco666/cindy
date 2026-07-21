// =============================================================================
// publish-lib.mjs — 桌面端 canary 发布(publish-desktop.mjs)的纯逻辑层
//
// 与 package-lib.mjs 对称:只放无副作用、可被 node --test 直接覆盖的函数——
// 参数解析、build-info 发布前校验、签名门禁、版本推进判定、manifest 组装。
// 所有 IO(读文件 / 网络 / OSS)留在 publish-desktop.mjs 编排层。
// =============================================================================

import { PLATFORM_ARCHS, SUPPORTED_PLATFORMS, SUPPORTED_REGIONS, isExplicitVersion } from './package-lib.mjs';

/**
 * 解析 publish-desktop.mjs 的命令行参数。非法输入直接 throw(编排层统一打印)。
 * 发布侧不接受 bump 关键字——版本号在打包阶段已经定死,发布只认显式 x.y.z。
 * @param {string[]} argv  process.argv.slice(2)
 * @param {{ platform?: string }} [defaults]  默认取当前机器平台
 */
export function parsePublishArgs(argv, defaults = {}) {
  const out = {
    region: 'cn',
    version: null,
    platform: defaults.platform ?? process.platform,
    arch: null, // null = 发布该平台在产物目录下能找到的全部 arch(mac 双架构)
    execute: false,
    requireRelogin: false,
    force: false,
  };
  const takeValue = (flag, i) => {
    const v = argv[i + 1];
    if (!v || v.startsWith('--')) throw new Error(`${flag} 需要一个值`);
    return v;
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    switch (a) {
      // 同 package-lib:pnpm 会把 run-script 后的 `--` 原样透传,裸 `--` 跳过。
      case '--': break;
      case '--region': out.region = takeValue(a, i); i++; break;
      case '--version': out.version = takeValue(a, i); i++; break;
      case '--platform': out.platform = takeValue(a, i); i++; break;
      case '--arch': out.arch = takeValue(a, i); i++; break;
      case '--execute': out.execute = true; break;
      case '--require-relogin': out.requireRelogin = true; break;
      case '--force': out.force = true; break;
      default:
        throw new Error(`未知参数: ${a}(支持 --region/--version/--platform/--arch/--execute/--require-relogin/--force)`);
    }
  }

  if (!SUPPORTED_REGIONS.includes(out.region)) {
    throw new Error(`不支持的 region: ${out.region}(可选 ${SUPPORTED_REGIONS.join('/')})`);
  }
  if (!out.version) {
    throw new Error('缺少 --version x.y.z(发布侧只认打包时定死的显式版本,不做 bump)');
  }
  if (!isExplicitVersion(out.version)) {
    throw new Error(`非法 --version: ${out.version}(发布侧只接受 x.y.z,不接受 major/minor/patch)`);
  }
  if (!SUPPORTED_PLATFORMS.includes(out.platform)) {
    throw new Error(`不支持的 platform: ${out.platform}(可选 ${SUPPORTED_PLATFORMS.join('/')})`);
  }
  if (out.arch !== null && !PLATFORM_ARCHS[out.platform].includes(out.arch)) {
    throw new Error(`platform ${out.platform} 不支持 arch: ${out.arch}(可选 ${PLATFORM_ARCHS[out.platform].join('/')})`);
  }
  return out;
}

/** 平台可发布的 platformKey 列表(--arch 未指定时的候选面)。 */
export function candidatePlatformKeys(platform, arch = null) {
  const archs = PLATFORM_ARCHS[platform];
  if (!archs) throw new Error(`不支持的 platform: ${platform}`);
  return (arch ? [arch] : archs).map((a) => `${platform}-${a}`);
}

/**
 * 发布前校验 build-info.json 与本次发布意图一致,并取出 installer / hotfix 条目。
 * 任何不一致直接 throw——发布侧信任 build-info,但绝不发布"拿错的" build-info。
 * @param {any} buildInfo  build-info.json 解析结果
 * @param {{ region: string, version: string, platformKey: string }} expected
 * @returns {{ installer: object, hotfix: object | null }}
 */
export function validateBuildInfoForPublish(buildInfo, expected) {
  if (!buildInfo || typeof buildInfo !== 'object') {
    throw new Error('build-info.json 不是合法 JSON object');
  }
  if (buildInfo.schemaVersion !== 2) {
    throw new Error(`build-info schemaVersion 不支持: ${buildInfo.schemaVersion}(本发布脚本只认 2;老产物请用对应版本的打包脚本重打)`);
  }
  if (buildInfo.product !== 'cindy-desktop') {
    throw new Error(`build-info product 不匹配: ${buildInfo.product}(期望 cindy-desktop)`);
  }
  if (buildInfo.versionless) {
    throw new Error('版本无关包(versionless)不参与热更新、禁止发布;请用 --version x.y.z 重新打包');
  }
  if (buildInfo.version !== expected.version) {
    throw new Error(`build-info 版本不匹配: ${buildInfo.version}(期望 ${expected.version})`);
  }
  if (buildInfo.region !== expected.region) {
    throw new Error(`build-info region 不匹配: ${buildInfo.region}(期望 ${expected.region});禁止把 ${buildInfo.region} 身份的产物发进 ${expected.region} 渠道`);
  }
  if (buildInfo.platformKey !== expected.platformKey) {
    throw new Error(`build-info platformKey 不匹配: ${buildInfo.platformKey}(期望 ${expected.platformKey})`);
  }
  if (!Array.isArray(buildInfo.files) || buildInfo.files.length === 0) {
    throw new Error('build-info files 为空');
  }
  for (const f of buildInfo.files) {
    if (!f || typeof f.name !== 'string' || !f.name
      || typeof f.sha256 !== 'string' || !/^[0-9a-f]{64}$/.test(f.sha256)
      || typeof f.size !== 'number' || !(f.size > 0)) {
      throw new Error(`build-info files 条目非法: ${JSON.stringify(f)}`);
    }
  }
  const installer = buildInfo.files.find((f) => f.role === 'installer') ?? null;
  const hotfix = buildInfo.files.find((f) => f.role === 'hotfix') ?? null;
  if (!installer) {
    throw new Error('build-info 缺少 installer 产物条目');
  }
  // Linux 首发无热更链路(installer-only);其它平台的有版本包必须带热更包,
  // 否则发布出去的版本无法被存量用户自动更新到。
  if (!hotfix && buildInfo.platform !== 'linux') {
    throw new Error(`build-info 缺少 hotfix 产物条目(${buildInfo.platform} 的发布包必须带热更 zip)`);
  }
  return { installer, hotfix };
}

/**
 * 签名门禁:未签名产物禁止出渠道(与 release-*.mjs 的 NPKG / 公证硬闸同口径)。
 * 无 --allow-unsigned 之类的逃生门——调试产物走 package-desktop.mjs,不进发布。
 */
export function assertPublishableSigning(buildInfo) {
  const signing = buildInfo.signing ?? {};
  switch (buildInfo.platform) {
    case 'win32':
      if (signing.installerSigned !== true) {
        throw new Error('Windows 产物未签名(signing.installerSigned != true),禁止发布;请带 NPKG_TOKEN 重新打包');
      }
      return;
    case 'darwin':
      if (signing.mode !== 'developer-id+notarized') {
        throw new Error(`macOS 产物签名模式为 "${signing.mode}"(要求 developer-id+notarized),禁止发布;ad-hoc 包过不了 Gatekeeper`);
      }
      return;
    case 'linux':
      return; // Linux 首发不签名
    default:
      throw new Error(`未知 platform: ${buildInfo.platform}`);
  }
}

/**
 * 跨平台代传硬闸:agent 二进制(claude / codex)的版本探测需要**执行**目标
 * 平台的二进制(ci/lib.mjs getLocal*Version 走 execSync),异平台上探测必失败
 * 并被静默当成 SKIP——全新渠道会发出缺 claudeCode/codex 段的废 manifest,
 * 存量渠道会静默漏掉 agent 更新。在把 build-info 记入 agent 二进制指纹之前,
 * 发布必须在目标平台的发版机上执行。
 */
export function assertAgentProbeSupported(targetPlatform, hostPlatform = process.platform) {
  if (targetPlatform !== hostPlatform) {
    throw new Error(
      `跨平台代传暂不支持: 发布 ${targetPlatform} 产物需要在 ${targetPlatform} 发版机上执行`
      + `(当前 ${hostPlatform};agent 二进制版本探测要运行目标平台的 claude/codex)。`,
    );
  }
}

/**
 * manifest 出闸前的 agent 段断言:claudeCode / codex 必须是完整可下载条目。
 * 兜住两类静默缺口——全新渠道 + 本地二进制探测失败(manifest 从空骨架起步,
 * agent 段整个缺失),以及历史 manifest 被误删字段。缺 agent 段的 manifest
 * 发出去 = 客户端环境初始化必失败。
 */
export function assertManifestAgentEntries(manifest) {
  for (const key of ['claudeCode', 'codex']) {
    const entry = manifest?.[key];
    if (!entry?.version || entry.version === '0.0.0' || !entry.file) {
      throw new Error(
        `manifest 缺少完整的 ${key} 段(version/file),拒绝发布:`
        + '客户端依赖它下载 agent 二进制。检查本地 claude/codex 二进制是否就位'
        + '(pnpm install:agent-binaries),或先用 release:claude-code / release:codex 补齐渠道。',
      );
    }
  }
}

/** 比较两个 x.y.z 版本;返回 -1 / 0 / 1。 */
export function compareSemver(a, b) {
  if (!isExplicitVersion(a) || !isExplicitVersion(b)) {
    throw new Error(`非法版本号比较: ${a} vs ${b}`);
  }
  const pa = a.split('.').map(Number);
  const pb = b.split('.').map(Number);
  for (let i = 0; i < 3; i++) {
    if (pa[i] !== pb[i]) return pa[i] < pb[i] ? -1 : 1;
  }
  return 0;
}

/**
 * 版本推进判定(发布前的单调性断言,防拿旧 build-info 把渠道回滚):
 *   - CDN 无有效版本 → fresh(全新渠道首发);
 *   - 新版本 > CDN → advance(正常推进);
 *   - 新版本 == CDN → republish(同版本重发,断链续传/重跑场景,上传层再按
 *     对象哈希守卫防字节分裂);
 *   - 新版本 < CDN → 默认抛错;force 时放行为 rollback-forced(人工决策回滚)。
 * @returns {{ kind: 'fresh' | 'advance' | 'republish' | 'rollback-forced' }}
 */
export function resolveVersionAdvance({ newVersion, cdnVersion, force = false }) {
  if (!cdnVersion || cdnVersion === '0.0.0') return { kind: 'fresh' };
  const cmp = compareSemver(newVersion, cdnVersion);
  if (cmp > 0) return { kind: 'advance' };
  if (cmp === 0) return { kind: 'republish' };
  if (force) return { kind: 'rollback-forced' };
  throw new Error(
    `版本回退被拒绝: 待发布 ${newVersion} < CDN 当前 ${cdnVersion}。`
    + '确认要回滚渠道时加 --force(并知晓客户端不会自动降级,回滚只影响新装/未更新用户)。',
  );
}

/**
 * 把本次产物写进(深拷贝后的)现有 canary manifest:app.version / installer /
 * hotfix / requireRelogin。Linux 走 installer-only 语义(无 hotfix / requireRelogin,
 * 与 ci/lib.mjs createLinuxFirstReleaseManifest 同口径)。
 * claudeCode / codex 段不在这里动——由编排层按 immutable 守卫结果写入。
 * @param {any} existingManifest  CDN 上的现有 manifest;全新渠道传 null
 * @param {{
 *   platform: string, platformKey: string, version: string, requireRelogin: boolean,
 *   installer: { name: string, sha256: string, size: number },
 *   hotfix: { name: string, sha256: string, size: number } | null,
 * }} ctx
 */
export function applyAppToManifest(existingManifest, ctx) {
  const manifest = existingManifest ? structuredClone(existingManifest) : { app: {} };
  if (!manifest.app || typeof manifest.app !== 'object') manifest.app = {};

  manifest.app.version = ctx.version;
  manifest.app.installer = {
    file: `app/${ctx.platformKey}/${ctx.installer.name}`,
    sha256: ctx.installer.sha256,
    size: ctx.installer.size,
  };

  if (ctx.platform === 'linux') {
    delete manifest.app.hotfix;
    delete manifest.app.requireRelogin;
    delete manifest.installer; // 历史字段,防 copy/paste 回渗
    return manifest;
  }

  manifest.app.hotfix = {
    file: `hotfix/${ctx.platformKey}/${ctx.hotfix.name}`,
    sha256: ctx.hotfix.sha256,
    size: ctx.hotfix.size,
  };
  // 写 true / 删字段的不对称语义与 release-*.mjs 一致:不需要时必须删干净,
  // 避免 CDN 上残留旧标记把后续每次更新都变成强制重登。
  if (ctx.requireRelogin) {
    manifest.app.requireRelogin = true;
  } else {
    delete manifest.app.requireRelogin;
  }
  return manifest;
}

/** 本次发布要上传的产物对象清单(不含 manifest 本身)。 */
export function planArtifactUploads(ossPrefix, platformKey, { installer, hotfix }) {
  const uploads = [{
    role: 'installer',
    name: installer.name,
    sha256: installer.sha256,
    size: installer.size,
    ossKey: `${ossPrefix}/app/${platformKey}/${installer.name}`,
  }];
  if (hotfix) {
    uploads.push({
      role: 'hotfix',
      name: hotfix.name,
      sha256: hotfix.sha256,
      size: hotfix.size,
      ossKey: `${ossPrefix}/hotfix/${platformKey}/${hotfix.name}`,
    });
  }
  return uploads;
}
