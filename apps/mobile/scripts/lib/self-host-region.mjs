// =============================================================================
// self-host-region.mjs —— 自建线「地区分包」配置的唯一加载入口(cn / global)
//
// 自建冷更/热更脚本(release-{ios,android}-{local,ota,check}.mjs)通过 `--region cn|global`
// 选出本次出包的地区,所有随地区变化的**非机密**分包参数(bundleId / package /
// TapDB 公开 client 配置 / OSS 落点 bucket / 非机密签名描述符)集中在打包机本地的
// scripts/self-host-regions.json 里(纯值,不进 git;缺失时报错指向 .example)。真机密
// (keystore 两个口令、OSS AK/SK)仍走 env,凭证不入仓。
// OTA 更新域名不属于构建/分包参数:由对应地区 endpoint.json 的 mobileUpdateBaseUrl 运行时下发。
//
// 设计对齐 scripts/shared/production-endpoints.mjs 的 loadProductionEndpoints:
//   - 缺文件 / 非法 JSON / 缺 region / 身份字段为空或 URL 非法 → 立即抛错,禁止回落默认值。
//   - oss.* 与 *Signing.* 的叶子值在“加载”时允许为空(dry-run 只需身份字段),
//     真正 --execute 用到时由签名 resolver / OSS 应用点各自强校验非空(与既有“签名零默认值、
//     构建时才强制解析”一致)。
// =============================================================================

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const SCRIPTS_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const SELF_HOST_REGIONS_PATH = path.join(SCRIPTS_DIR, 'self-host-regions.json');
export const SELF_HOST_REGIONS_EXAMPLE_PATH = path.join(SCRIPTS_DIR, 'self-host-regions.json.example');

/** 合法地区集合(与 EAS 线 resolveAuthRegion 保持一致)。 */
export const SELF_HOST_REGIONS = Object.freeze(['cn', 'global']);

/** 每个 region 必须“加载即非空”的身份字段(dry-run 也要用来打印计划 / 选 bundle)。 */
const REQUIRED_IDENTITY_FIELDS = Object.freeze([
  'iosBundleId',
  'androidPackage',
  'npkgExpectBundle',
]);
/** 必须存在(但叶子值允许 --execute 时才填)的子对象。 */
const REQUIRED_OSS_KEYS = Object.freeze(['cdnBaseUrl', 'bucket', 'prefix', 'ossRegion']);
const REQUIRED_TAPDB_KEYS = Object.freeze(['clientId', 'clientToken']);
const SELF_HOST_TAPDB_ENV_KEYS = Object.freeze([
  'EXPO_PUBLIC_TAPTAP_CLIENT_ID',
  'EXPO_PUBLIC_TAPTAP_CLIENT_TOKEN',
  'EXPO_PUBLIC_TAPDB_CHANNEL',
  'EXPO_PUBLIC_TAPDB_REGION',
]);

/** 解析真文件路径;显式 env 覆盖仅供测试 / 特殊打包机。 */
export function resolveSelfHostRegionsPath(filePath = process.env.CINDY_SELF_HOST_REGIONS_FILE) {
  if (!filePath?.trim()) return SELF_HOST_REGIONS_PATH;
  return path.resolve(SCRIPTS_DIR, filePath.trim());
}

/**
 * 读取并校验打包机本地的 self-host-regions.json。返回冻结的 { cn, global }。
 * @param {{ filePath?: string }} [options]
 */
export function loadSelfHostRegions(options = {}) {
  const configPath = resolveSelfHostRegionsPath(options.filePath);
  let raw;
  try {
    raw = fs.readFileSync(configPath, 'utf8');
  } catch (error) {
    if (error && typeof error === 'object' && error.code === 'ENOENT') {
      throw new Error(
        `缺少自建线地区配置: ${configPath}。请复制 ${SELF_HOST_REGIONS_EXAMPLE_PATH} 为 self-host-regions.json 并在打包机上填值(该文件已 gitignore)。`,
      );
    }
    throw error;
  }
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error(`自建线地区配置不是合法 JSON: ${configPath}`);
  }
  return validateSelfHostRegions(parsed, { source: configPath });
}

/**
 * 校验 { cn, global } 结构。身份字段与 TapDB 公开 client 配置严格非空;
 * oss/signing 叶子值允许空(用时再校验)。
 * @param {unknown} value
 * @param {{ source?: string }} [options]
 */
export function validateSelfHostRegions(value, options = {}) {
  const source = options.source ?? 'self-host regions';
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`${source} 必须是 JSON object`);
  }
  const result = {};
  for (const region of SELF_HOST_REGIONS) {
    const block = value[region];
    if (!block || typeof block !== 'object' || Array.isArray(block)) {
      throw new Error(`${source} 缺少 region 配置块: ${region}`);
    }
    if (block.authRegion !== region) {
      throw new Error(`${source} 的 ${region}.authRegion 必须等于 "${region}"`);
    }
    for (const key of REQUIRED_IDENTITY_FIELDS) {
      if (typeof block[key] !== 'string' || !block[key].trim()) {
        throw new Error(`${source} 的 ${region}.${key} 必须是非空字符串`);
      }
    }
    const tapdb = block.tapdb;
    if (!tapdb || typeof tapdb !== 'object' || Array.isArray(tapdb)) {
      throw new Error(`${source} 的 ${region}.tapdb 必须是 object`);
    }
    for (const key of REQUIRED_TAPDB_KEYS) {
      if (typeof tapdb[key] !== 'string' || !tapdb[key].trim()) {
        throw new Error(`${source} 的 ${region}.tapdb.${key} 必须是非空字符串`);
      }
    }
    // oss 子对象必须存在且含全部键(叶子值允许空,--execute 应用 OSS 时再强校验非空)。
    const oss = block.oss;
    if (!oss || typeof oss !== 'object' || Array.isArray(oss)) {
      throw new Error(`${source} 的 ${region}.oss 必须是 object`);
    }
    for (const key of REQUIRED_OSS_KEYS) {
      if (typeof oss[key] !== 'string') {
        throw new Error(`${source} 的 ${region}.oss.${key} 必须是字符串(可留空,--execute 时才需填)`);
      }
    }
    // 签名子对象存在即可(叶子值由签名 resolver 在 --execute 时强校验)。
    for (const key of ['iosSigning', 'androidSigning']) {
      if (!block[key] || typeof block[key] !== 'object' || Array.isArray(block[key])) {
        throw new Error(`${source} 的 ${region}.${key} 必须是 object`);
      }
    }
    result[region] = Object.freeze({
      ...block,
      tapdb: Object.freeze({ ...tapdb }),
      oss: Object.freeze({ ...oss }),
      iosSigning: Object.freeze({ ...block.iosSigning }),
      androidSigning: Object.freeze({ ...block.androidSigning }),
    });
  }
  return Object.freeze(result);
}

/**
 * 自建线的 TapDB 配置来自 self-host-regions.json → Expo extra。主动清掉同名
 * EXPO_PUBLIC_* 环境变量,避免打包机 shell/.env 残留值被 Metro 再次内联进 bundle。
 * @param {Record<string, string | undefined>} env
 */
export function stripSelfHostTapdbEnv(env) {
  for (const key of SELF_HOST_TAPDB_ENV_KEYS) delete env[key];
  return env;
}

/**
 * 从 parseArgs 的结果里解析 region,**必填、不 fallback**。
 * @param {{ region?: unknown }} args
 * @param {{ regions?: Record<string, unknown> }} [options] 测试可注入 regions 免文件 IO。
 */
export function resolveSelfHostRegion(args, options = {}) {
  const raw = args?.region;
  if (typeof raw !== 'string' || !raw.trim()) {
    throw new Error(
      '自建线出包必须显式指定 --region cn|global(不提供默认值);例:pnpm mobile:release:ios:local -- --region global',
    );
  }
  const region = raw.trim();
  if (!SELF_HOST_REGIONS.includes(region)) {
    throw new Error(`--region 只能是 ${SELF_HOST_REGIONS.join(' 或 ')},收到: ${region}`);
  }
  const regions = options.regions ?? loadSelfHostRegions();
  const block = regions[region];
  if (!block) throw new Error(`自建线地区配置缺少 region: ${region}`);
  return block;
}

/**
 * 生成自建线发版命令,确保后续操作沿用当前地区,不回落到隐式默认值。
 * @param {'ios' | 'android'} platform
 * @param {'check' | 'local' | 'ota'} action
 * @param {string | { authRegion?: string }} region
 * @param {{ execute?: boolean }} [options]
 */
export function formatSelfHostReleaseCommand(platform, action, region, options = {}) {
  if (!['ios', 'android'].includes(platform)) throw new Error(`未知自建线平台: ${platform}`);
  if (!['check', 'local', 'ota'].includes(action)) throw new Error(`未知自建线操作: ${action}`);
  const authRegion = typeof region === 'string' ? region : region?.authRegion;
  if (!SELF_HOST_REGIONS.includes(authRegion)) {
    throw new Error(`自建线命令 region 只能是 ${SELF_HOST_REGIONS.join(' 或 ')},收到: ${authRegion}`);
  }
  const execute = options.execute === true ? ' --execute' : '';
  return `pnpm mobile:release:${platform}:${action} -- --region ${authRegion}${execute}`;
}

/** region 对应的 env 后缀(CN / GLOBAL),用于机密类 env 变量名。 */
export function regionEnvSuffix(regionConfig) {
  return String(regionConfig.authRegion).toUpperCase();
}

/**
 * 生成把 OSS 落点切到本 region bucket 所需的 process.env 覆盖(纯函数)。
 * - bucket / cdn / prefix / ossRegion 从 region.oss 取(非机密)。
 * - AK/SK 是机密、不入 JSON:优先读 region 后缀 env(XDT_OSS_ACCESS_KEY_ID_<SUFFIX> / ..._SECRET_<SUFFIX>),
 *   有值才覆盖 oss.mjs getAKSK 读取的 FP_DEV_OSS_ACCESS_KEY_ID/SECRET;缺省则不覆盖(走现有 FP_DEV_*,
 *   适配“同账号两 bucket”一套 AK/SK)。
 * 调用方 Object.assign(process.env, ...) 后再 refreshOssConfig()。
 * @param {object} regionConfig
 * @param {Record<string, string | undefined>} [baseEnv]
 */
export function regionEnvOverrides(regionConfig, baseEnv = process.env) {
  const oss = regionConfig.oss ?? {};
  const overrides = {};
  // 只覆盖非空项:空值留给 resolveOssConfig 回落(仅 dry-run 未配置态会命中;--execute 由
  // assertRegionOssComplete 拦截,避免空值静默落到默认桶或 bucket/prefix 半配)。
  const setIf = (key, value) => {
    const v = String(value ?? '').trim();
    if (v) overrides[key] = v;
  };
  setIf('XDT_CDN_BASE_URL', oss.cdnBaseUrl);
  setIf('XDT_OSS_BUCKET', oss.bucket);
  setIf('XDT_OSS_PREFIX', oss.prefix);
  setIf('XDT_OSS_REGION', oss.ossRegion);
  const suffix = regionEnvSuffix(regionConfig);
  const ak = String(baseEnv[`XDT_OSS_ACCESS_KEY_ID_${suffix}`] ?? '').trim();
  const sk = String(baseEnv[`XDT_OSS_ACCESS_KEY_SECRET_${suffix}`] ?? '').trim();
  if (ak) overrides.FP_DEV_OSS_ACCESS_KEY_ID = ak;
  if (sk) overrides.FP_DEV_OSS_ACCESS_KEY_SECRET = sk;
  return overrides;
}

/**
 * --execute 前强校验本 region 的 oss.* 四项都已填(bucket / cdn / prefix / ossRegion 全非空),
 * 防止空值静默回落到默认桶、或 bucket 与 prefix 半配导致上传去错地方。dry-run 不调用。
 */
export function assertRegionOssComplete(regionConfig) {
  const oss = regionConfig.oss ?? {};
  const region = regionConfig.authRegion ?? '?';
  const missing = REQUIRED_OSS_KEYS.filter((k) => !String(oss[k] ?? '').trim());
  if (missing.length) {
    throw new Error(
      `self-host-regions.json 的 ${region}.oss 缺少非空字段:${missing.join(', ')}(--execute 需要完整 OSS 落点;dry-run 可留空)`,
    );
  }
}
