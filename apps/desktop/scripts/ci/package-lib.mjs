// =============================================================================
// package-lib.mjs — 桌面端打包(package-desktop.mjs)的纯逻辑层
//
// 只放无副作用、可被 node --test 直接覆盖的函数:参数解析、版本解析、
// 产物目录/文件命名、build-info 组装。所有 IO(forge / 签名 / 拷贝 / 网络)
// 留在 package-desktop.mjs 编排层。
// =============================================================================

/** 版本无关打包写入 package.json / APP_VERSION 的占位版本。
 *  必须保持纯数字段(NSIS / rcedit 的 PE FileVersion 只接受数字),且与
 *  CDN manifest 的「无有效版本」哨兵 '0.0.0' 同值——updateService 据此
 *  (isVersionlessAppVersion)禁用热更新,开源社区拉仓打的包不会被线上
 *  manifest 拉去自更。 */
export const VERSIONLESS_VERSION = '0.0.0';

export const SUPPORTED_PLATFORMS = Object.freeze(['win32', 'darwin', 'linux']);
export const SUPPORTED_REGIONS = Object.freeze(['cn', 'global', 'dev']);
export const SUPPORTED_CHANNELS = Object.freeze(['dev', 'release']);
const VERSION_BUMP_KINDS = Object.freeze(['major', 'minor', 'patch']);

const PLATFORM_ARCHS = Object.freeze({
  win32: ['x64'],
  darwin: ['arm64', 'x64'],
  linux: ['x64'],
});

/** x.y.z 显式版本(不接受前缀 v / 预发布后缀——发布版本号是 CDN 比较键,保持纯净)。 */
export function isExplicitVersion(value) {
  return /^\d+\.\d+\.\d+$/.test(value);
}

/**
 * 解析 package-desktop.mjs 的命令行参数。非法输入直接 throw(编排层统一打印)。
 * @param {string[]} argv  process.argv.slice(2)
 * @param {{ platform?: string, arch?: string }} [defaults]  默认取当前机器
 */
export function parsePackageArgs(argv, defaults = {}) {
  const out = {
    platform: defaults.platform ?? process.platform,
    arch: defaults.arch ?? process.arch,
    region: 'cn',
    channel: 'dev',
    versionSpec: null,
    skipSmoke: false,
    allowUnsigned: false,
    noSign: false,
  };
  const takeValue = (flag, i) => {
    const v = argv[i + 1];
    if (!v || v.startsWith('--')) throw new Error(`${flag} 需要一个值`);
    return v;
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    switch (a) {
      case '--platform': out.platform = takeValue(a, i); i++; break;
      case '--arch': out.arch = takeValue(a, i); i++; break;
      case '--region': out.region = takeValue(a, i); i++; break;
      case '--channel': out.channel = takeValue(a, i); i++; break;
      case '--version': out.versionSpec = takeValue(a, i); i++; break;
      case '--skip-smoke': out.skipSmoke = true; break;
      case '--allow-unsigned': out.allowUnsigned = true; break;
      // 主动跳过签名(即使凭证在手)。npkg 签名产物下载要求内网,非内网机器
      // 打版本无关包时用它;与 --allow-unsigned(放行"缺凭证")语义互补。
      case '--no-sign': out.noSign = true; out.allowUnsigned = true; break;
      default:
        throw new Error(`未知参数: ${a}(支持 --platform/--arch/--region/--channel/--version/--skip-smoke/--allow-unsigned/--no-sign)`);
    }
  }

  if (!SUPPORTED_PLATFORMS.includes(out.platform)) {
    throw new Error(`不支持的 platform: ${out.platform}(可选 ${SUPPORTED_PLATFORMS.join('/')})`);
  }
  const archs = PLATFORM_ARCHS[out.platform];
  if (!archs.includes(out.arch)) {
    throw new Error(`platform ${out.platform} 不支持 arch: ${out.arch}(可选 ${archs.join('/')})`);
  }
  if (!SUPPORTED_REGIONS.includes(out.region)) {
    throw new Error(`不支持的 region: ${out.region}(可选 ${SUPPORTED_REGIONS.join('/')})`);
  }
  if (!SUPPORTED_CHANNELS.includes(out.channel)) {
    throw new Error(`不支持的 channel: ${out.channel}(可选 ${SUPPORTED_CHANNELS.join('/')})`);
  }
  if (
    out.versionSpec !== null &&
    !VERSION_BUMP_KINDS.includes(out.versionSpec) &&
    !isExplicitVersion(out.versionSpec)
  ) {
    throw new Error(`非法 --version: ${out.versionSpec}(可选 x.y.z / major / minor / patch)`);
  }
  return out;
}

/** major/minor/patch bump。baseline 必须是合法 x.y.z。 */
export function bumpVersion(baseline, kind) {
  if (!isExplicitVersion(baseline)) {
    throw new Error(`CDN 基线版本非法: ${baseline}`);
  }
  const [major, minor, patch] = baseline.split('.').map(Number);
  switch (kind) {
    case 'major': return `${major + 1}.0.0`;
    case 'minor': return `${major}.${minor + 1}.0`;
    case 'patch': return `${major}.${minor}.${patch + 1}`;
    default: throw new Error(`未知 bump 类型: ${kind}`);
  }
}

/**
 * 解析最终打包版本。
 * - null → 版本无关(占位 0.0.0,包不参与热更新);
 * - x.y.z → 原样;
 * - major/minor/patch → 调 fetchBaseline()(只读拉 CDN 当前版本)后 bump。
 *   只有 bump 关键字才联网——这是打包阶段仅存的 CDN 依赖。
 * @param {string|null} versionSpec
 * @param {() => Promise<string>} fetchBaseline
 * @returns {Promise<{ version: string, versionless: boolean }>}
 */
export async function resolvePackageVersion(versionSpec, fetchBaseline) {
  if (versionSpec === null) {
    return { version: VERSIONLESS_VERSION, versionless: true };
  }
  if (isExplicitVersion(versionSpec)) {
    if (versionSpec === VERSIONLESS_VERSION) {
      throw new Error(`--version ${VERSIONLESS_VERSION} 是版本无关占位符,不能作为发布版本;要打版本无关包直接省略 --version`);
    }
    return { version: versionSpec, versionless: false };
  }
  const baseline = await fetchBaseline();
  if (!baseline || baseline === VERSIONLESS_VERSION) {
    throw new Error(`CDN manifest 没有有效基线版本(got "${baseline}"),无法 ${versionSpec} bump;请显式传 --version x.y.z`);
  }
  return { version: bumpVersion(baseline, versionSpec), versionless: false };
}

/** 产物目录(相对 apps/desktop/release/):artifacts/<region>-<channel>/<version|dev>/<platformKey> */
export function artifactRelDir({ region, channel, version, versionless, platformKey }) {
  const versionSeg = versionless ? 'dev' : version;
  return ['artifacts', `${region}-${channel}`, versionSeg, platformKey].join('/');
}

/**
 * 新渠道产物文件基名(老 release 脚本的 xdt-maker-* 命名不动,新产物统一
 * cindy-*)。两区同名(owner 决策):发布渠道靠不同 OSS bucket 区分,本地
 * 产物已按 artifactRelDir 的 `<region>-<channel>/` 目录分层,文件名不再
 * 叠区域前缀。
 */
export function artifactBaseName({ version, versionless }) {
  return `cindy-${versionless ? 'dev' : version}`;
}

/**
 * 组装 build-info.json 内容(发布侧未来只读它决定上传什么)。
 * 所有字段由编排层收集后传入,本函数保持纯组装。
 * @param {{
 *   version: string, versionless: boolean, region: string, channel: string,
 *   platform: string, arch: string, commitSha: string, electronVersion: string,
 *   schemaVersionMax: number, migrationFiles: string[],
 *   files: Array<{ role: string, name: string, sha256: string, size: number }>,
 *   signing: Record<string, unknown>,
 * }} ctx
 */
export function buildBuildInfo(ctx) {
  return {
    schemaVersion: 1,
    product: 'cindy-desktop',
    // 版本无关包 version 记 null,占位符不冒充真实版本。
    version: ctx.versionless ? null : ctx.version,
    versionless: ctx.versionless,
    region: ctx.region,
    channel: ctx.channel,
    platform: ctx.platform,
    arch: ctx.arch,
    platformKey: `${ctx.platform}-${ctx.arch}`,
    commitSha: ctx.commitSha,
    buildTime: new Date().toISOString(),
    nodeVersion: process.version,
    electronVersion: ctx.electronVersion,
    schemaVersionMax: ctx.schemaVersionMax,
    migrationFiles: ctx.migrationFiles,
    files: ctx.files,
    signing: ctx.signing,
  };
}
