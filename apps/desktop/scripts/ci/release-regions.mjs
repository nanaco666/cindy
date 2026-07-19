// =============================================================================
// release-regions.mjs —— desktop 发布「地区渠道」配置的唯一加载入口(cn / global)
//
// 对齐 mobile 自建线的 self-host-regions 模式(apps/mobile/scripts/lib/self-host-region.mjs):
// 随地区变化的**非机密**发布目标(CDN 基址 / OSS bucket / prefix / ossRegion)集中在
// 发版机本地的 scripts/release-regions.json 里(纯值,不入仓;只提交 .json.example)。
// 真机密(阿里云 AK/SK、APPLE_APP_PASSWORD、NPKG_TOKEN)仍走 env / .env,凭证不入仓。
//
// 与既有 env 驱动(XDT_* / XDT_GLOBAL_*,CI secret 场景)的关系:
//   - env 已显式设置的键永远优先,JSON 只补 env 里缺失的键(与 .env 加载语义一致);
//   - env 四件套齐全时允许没有 JSON 文件(CI 不需要发版机文件);
//   - 两边合并后仍缺键 → 立即抛错并同时指出 JSON 字段与 env 变量名,禁止回落默认值。
// =============================================================================

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { resolveReleaseRegion } from '../../../../scripts/shared/oss.mjs';

const SCRIPTS_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const RELEASE_REGIONS_PATH = path.join(SCRIPTS_DIR, 'release-regions.json');
export const RELEASE_REGIONS_EXAMPLE_PATH = path.join(SCRIPTS_DIR, 'release-regions.json.example');

/** 每个 region 的 oss 配置块字段 → 对应的既有 env 变量名(refreshOssConfig 的最终读取面)。 */
export const RELEASE_REGION_ENV_NAMES = Object.freeze({
  cn: Object.freeze({
    cdnBaseUrl: 'XDT_CDN_BASE_URL',
    bucket: 'XDT_OSS_BUCKET',
    prefix: 'XDT_OSS_PREFIX',
    ossRegion: 'XDT_OSS_REGION',
  }),
  global: Object.freeze({
    cdnBaseUrl: 'XDT_GLOBAL_CDN_BASE_URL',
    bucket: 'XDT_GLOBAL_OSS_BUCKET',
    prefix: 'XDT_GLOBAL_OSS_PREFIX',
    ossRegion: 'XDT_GLOBAL_OSS_REGION',
  }),
});

const OSS_KEYS = Object.freeze(['cdnBaseUrl', 'bucket', 'prefix', 'ossRegion']);

/** 解析真文件路径;显式 env 覆盖仅供测试 / 特殊发版机。 */
export function resolveReleaseRegionsPath(filePath = process.env.CINDY_RELEASE_REGIONS_FILE) {
  if (!filePath?.trim()) return RELEASE_REGIONS_PATH;
  return path.resolve(SCRIPTS_DIR, filePath.trim());
}

/**
 * 读取并校验发版机本地的 release-regions.json。返回冻结的 { cn, global }。
 * 叶子值允许为空字符串(只发单渠道的机器不必填另一渠道),用到时由
 * applyReleaseRegionConfigToEnv 按本次 --region 强校验。
 * @param {{ filePath?: string }} [options]
 */
export function loadReleaseRegions(options = {}) {
  const configPath = resolveReleaseRegionsPath(options.filePath);
  let raw;
  try {
    raw = fs.readFileSync(configPath, 'utf8');
  } catch (error) {
    if (error && typeof error === 'object' && error.code === 'ENOENT') {
      throw new Error(
        `缺少 desktop 发布地区配置: ${configPath}。请复制 ${RELEASE_REGIONS_EXAMPLE_PATH} 为 release-regions.json 并在发版机上填值(该文件已 gitignore)。`,
      );
    }
    throw error;
  }
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error(`desktop 发布地区配置不是合法 JSON: ${configPath}`);
  }
  return validateReleaseRegions(parsed, { source: configPath });
}

/**
 * 校验 { cn: { oss }, global: { oss } } 结构;叶子必须是字符串,允许为空。
 * @param {unknown} value
 * @param {{ source?: string }} [options]
 */
export function validateReleaseRegions(value, options = {}) {
  const source = options.source ?? 'release regions';
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`${source} 必须是 JSON object`);
  }
  const result = {};
  for (const region of Object.keys(RELEASE_REGION_ENV_NAMES)) {
    const block = value[region];
    if (!block || typeof block !== 'object' || Array.isArray(block)) {
      throw new Error(`${source} 缺少 region 配置块: ${region}`);
    }
    const oss = block.oss;
    if (!oss || typeof oss !== 'object' || Array.isArray(oss)) {
      throw new Error(`${source} 的 ${region}.oss 必须是 object`);
    }
    const normalizedOss = {};
    for (const key of OSS_KEYS) {
      if (typeof oss[key] !== 'string') {
        throw new Error(`${source} 的 ${region}.oss.${key} 必须是字符串(可留空,发该渠道时才要求非空)`);
      }
      normalizedOss[key] = oss[key].trim();
    }
    result[region] = Object.freeze({ oss: Object.freeze(normalizedOss) });
  }
  return Object.freeze(result);
}

/**
 * 把本次发布 region 的 JSON 配置合并进 env(只补 env 缺失的键,env 显式值优先),
 * 供随后的 refreshOssConfig(region) / resolveReleaseCdnBaseUrl(region) 读取。
 *
 * 行为:
 *   - env 四件套齐全 → 不要求 JSON 文件存在(CI secret 场景),返回 { source: 'env' };
 *   - 否则必须能读到 JSON 且补齐缺口,返回 { source: 'file' };
 *   - 合并后仍缺 → 抛错,同时指出 JSON 字段与 env 变量名。
 * @param {string} region cn | global
 * @param {{ filePath?: string }} [options]
 */
export function applyReleaseRegionConfigToEnv(region, options = {}) {
  const normalized = resolveReleaseRegion(region);
  const envNames = RELEASE_REGION_ENV_NAMES[normalized];
  const missingFromEnv = OSS_KEYS.filter((key) => !process.env[envNames[key]]?.trim());
  if (missingFromEnv.length === 0) return { source: 'env' };

  const configPath = resolveReleaseRegionsPath(options.filePath);
  if (!fs.existsSync(configPath)) {
    throw new Error(
      `缺少 ${normalized} 渠道发布配置。二选一:\n` +
        `  1) 复制 ${RELEASE_REGIONS_EXAMPLE_PATH} 为 release-regions.json 并填入 ${normalized}.oss.*(推荐,已 gitignore);\n` +
        `  2) 设置环境变量 ${missingFromEnv.map((key) => envNames[key]).join(' / ')}(CI secret 场景)。`,
    );
  }

  const regions = loadReleaseRegions({ filePath: options.filePath });
  const block = regions[normalized].oss;
  const stillMissing = [];
  for (const key of OSS_KEYS) {
    const envName = envNames[key];
    if (process.env[envName]?.trim()) continue;
    if (block[key]) {
      process.env[envName] = block[key];
    } else {
      stillMissing.push(`${normalized}.oss.${key}(或 env ${envName})`);
    }
  }
  if (stillMissing.length > 0) {
    throw new Error(`${configPath} 的 ${normalized} 渠道配置不完整,缺: ${stillMissing.join(', ')}`);
  }
  return { source: 'file' };
}
