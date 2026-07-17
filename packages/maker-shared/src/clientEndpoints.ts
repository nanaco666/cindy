/**
 * clientEndpoints — 客户端远程端点清单的共享 schema / 校验 / 严格解析。
 *
 * 背景:desktop / mobile 的生产端点在构建期内联进包体,发版后无法变更。OSS 上
 * 存放一份公开读的清单(仓内正本 `config/client-endpoints.json`,人肉上传),
 * 应用启动第一步、**先于检查更新**从 CDN 拉取;OSS 清单修改后重启应用生效。
 *
 * 语义是**清单即唯一事实源**(2026-07 与 Lizi 定案,两次收紧):
 *  - 拉不到 / 清单非法 / **任一字段缺失** → 启动阻断,宿主报错并提供重试;
 *  - **没有缓存回退、没有超时后静默继续、没有逐字段烘焙回退**——任何本地兜底
 *    都会把 CDN 配置错误静默掩盖成"部分端点漂移",这里要的是配置错就立刻炸出来;
 *  - 构建期烘焙值仅存在于两个无法消除的位置:拉清单用的 CDN 基址(自举必需,
 *    且防"清单配错 CDN 把自己锁死"),以及 dev 构建(desktop 未打包 / mobile
 *    __DEV__)整个跳过拉取的开发路径。
 *
 * 职责边界(仓规则 2):本模块是纯逻辑层,不做任何 IO——fetch / 报错交互由宿主
 * (desktop main / mobile 启动闸门)实现,这里只提供确定性的解析与校验(仓规则 9)。
 *
 * 校验语义:
 *  - **全字段必填**:CLIENT_ENDPOINT_KEYS 每个字段都必须出现且合法,缺一个整份拒绝;
 *  - 未知字段忽略(向前兼容:新客户端加字段后,老清单先补字段再发新客户端;
 *    新清单多出的字段老客户端不认识但不报错);
 *  - 协议白名单(与 scripts/shared/production-endpoints.mjs 对齐)、禁 URL 凭据、
 *    尾斜杠归一;
 *  - schemaVersion 缺失、非正整数或大于当前支持版本 → 整份拒绝(breaking change
 *    才 bump 版本)。
 */

/** 当前客户端支持的清单 schema 版本;清单里更大的版本号会被整份拒绝。 */
export const CLIENT_ENDPOINTS_SCHEMA_VERSION = 1;

/**
 * 清单字段全集 = 客户端实际消费的端点集合,**每个都是必填**。
 * 不放没有消费方的字段(死配置也是故障点);新增消费点时同步扩这里 + 先给
 * 线上清单补字段再发版(老清单缺新字段会让新版客户端启动阻断)。
 */
export const CLIENT_ENDPOINT_KEYS = [
  'apiBaseUrl',
  // auth 不分 cn/global:国内/海外是两条 CDN 各发各的清单,清单本身已 region 化,
  // 客户端无脑取本字段即可。
  'authApiBaseUrl',
  'deviceLinkApiBaseUrl',
  'oauthBrokerApiBaseUrl',
  'heartbeatUrl',
  'slackHookWsUrl',
  'websiteUrl',
  'xdGatewayBaseUrl',
] as const;

export type ClientEndpointKey = (typeof CLIENT_ENDPOINT_KEYS)[number];

/** 解析成功后的端点全集(全字段必有值,值全部来自清单)。 */
export type ClientEndpointMap = Record<ClientEndpointKey, string>;

/** 各字段允许的 URL 协议白名单。 */
const FIELD_PROTOCOLS: Record<ClientEndpointKey, readonly string[]> = {
  apiBaseUrl: ['https:'],
  authApiBaseUrl: ['https:'],
  deviceLinkApiBaseUrl: ['https:'],
  oauthBrokerApiBaseUrl: ['https:'],
  heartbeatUrl: ['https:'],
  slackHookWsUrl: ['wss:'],
  websiteUrl: ['https:'],
  xdGatewayBaseUrl: ['https:'],
};

export type ParseClientEndpointManifestResult =
  | { ok: true; endpoints: ClientEndpointMap }
  | { ok: false; reason: string };

/**
 * 解析并校验一份清单原文。纯函数,输入任意文本都不会抛出。
 * 全字段必填:缺失 / 非法 / 协议不符 / 带凭据,任一命中整份拒绝。
 */
export function parseClientEndpointManifest(rawText: string): ParseClientEndpointManifestResult {
  let parsed: unknown;
  try {
    parsed = JSON.parse(rawText);
  } catch {
    return { ok: false, reason: 'invalid-json' };
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return { ok: false, reason: 'not-an-object' };
  }
  const record = parsed as Record<string, unknown>;

  const schemaVersion = record.schemaVersion;
  if (
    typeof schemaVersion !== 'number' ||
    !Number.isInteger(schemaVersion) ||
    schemaVersion < 1
  ) {
    return { ok: false, reason: 'invalid-schema-version' };
  }
  if (schemaVersion > CLIENT_ENDPOINTS_SCHEMA_VERSION) {
    return { ok: false, reason: `unsupported-schema-version:${schemaVersion}` };
  }

  const endpoints = {} as ClientEndpointMap;
  for (const key of CLIENT_ENDPOINT_KEYS) {
    if (!(key in record)) {
      return { ok: false, reason: `missing-field:${key}` };
    }
    const raw = record[key];
    if (typeof raw !== 'string' || !raw.trim()) {
      return { ok: false, reason: `invalid-field:${key}` };
    }
    const normalized = raw.trim().replace(/\/+$/, '');
    let url: URL;
    try {
      url = new URL(normalized);
    } catch {
      return { ok: false, reason: `invalid-field:${key}` };
    }
    if (!FIELD_PROTOCOLS[key].includes(url.protocol)) {
      return { ok: false, reason: `invalid-protocol:${key}` };
    }
    if (url.username || url.password) {
      return { ok: false, reason: `credentials-in-url:${key}` };
    }
    endpoints[key] = normalized;
  }
  return { ok: true, endpoints };
}

export type ResolveClientEndpointsResult =
  | { ok: true; endpoints: ClientEndpointMap }
  | { ok: false; reason: string };

/**
 * 严格解析:清单原文 → 完整端点 map(值全部来自清单,无任何本地合并)。
 * rawText 为 null(拉取失败/超时)→ ok:false('fetch-failed'),宿主必须阻断并重试。
 */
export function resolveClientEndpointsStrict(
  rawText: string | null,
): ResolveClientEndpointsResult {
  if (rawText === null) {
    return { ok: false, reason: 'fetch-failed' };
  }
  return parseClientEndpointManifest(rawText);
}
