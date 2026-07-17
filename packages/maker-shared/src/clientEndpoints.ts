/**
 * clientEndpoints — 客户端远程端点清单的共享 schema / 校验 / 严格解析。
 *
 * 背景:desktop / mobile 的生产端点在构建期内联进包体,发版后无法变更。CDN 上
 * 存放一份公开读的清单(仓内正本 `config/endpoint.json` = cn、
 * `config/endpoint.global.json` = global,人肉上传各自 region 的 CDN),
 * 应用启动第一步、**先于检查更新**从 CDN 拉取;CDN 清单修改后重启应用生效。
 * 完整拉取地址 = `<烘焙的 region 化 hotfix base>/endpoint.json`。
 *
 * 语义是**清单即唯一事实源**(2026-07 与 Lizi 定案,三次收紧):
 *  - 拉不到 / 清单非法 / **任一字段缺失** → 启动阻断,宿主报错并提供重试;
 *  - **没有缓存回退、没有超时后静默继续、没有逐字段烘焙回退**——任何本地兜底
 *    都会把 CDN 配置错误静默掩盖成"部分端点漂移",这里要的是配置错就立刻炸出来;
 *  - 客户端唯一烘焙的远程 URL 是拉清单用的 CDN 基址(自举必需,且防"清单配错
 *    CDN 把自己锁死");**更新/hotfix 链的 CDN base 也来自清单**(cdnBaseUrl)
 *    ——清单阻断在一切更新检查之前,更新链拿到的一定是已解析的清单值,
 *    无鸡生蛋问题;
 *  - dev(desktop 未打包 / mobile __DEV__)默认不走 CDN,改读仓内正本文件
 *    (同一套解析,allowHttp 宽松协议见下);`--endpoints-cdn` /
 *    EXPO_PUBLIC_ENDPOINTS_CDN=1 可让 dev 走完整 CDN 链路。
 *
 * 职责边界(仓规则 2):本模块是纯逻辑层,不做任何 IO——fetch / 读文件 / 报错
 * 交互由宿主(desktop main / mobile 启动闸门)实现,这里只提供确定性的解析与
 * 校验(仓规则 9)。
 *
 * 校验语义:
 *  - **全字段必填**:CLIENT_ENDPOINT_KEYS 每个字段都必须出现且合法,缺一个整份拒绝;
 *  - 未知字段忽略(向前兼容:新客户端加字段后,老清单先补字段再发新客户端;
 *    新清单多出的字段老客户端不认识但不报错);
 *  - 协议白名单(与 scripts/shared/production-endpoints.mjs 对齐)、禁 URL 凭据、
 *    尾斜杠归一;
 *  - `allowHttp` 宽松模式(仅 dev 本地文件路径允许开启):https-only 字段追加
 *    接受 http:、wss 字段追加 ws:,让 endpoint.local.json 能填 localhost;
 *    packaged / CDN 路径一律不开,打包校验零放松;
 *  - schemaVersion 缺失、非正整数或大于当前支持版本 → 整份拒绝(breaking change
 *    才 bump 版本)。2026-07 追加 cdnBaseUrl 时**没有** bump:新字段随全新的
 *    hotfix CDN 域名 + `/endpoint.json` 路径发布,老客户端读的是老 CDN 老路径
 *    (`/config/client-endpoints.json`)看不到新清单;即使把新正本内容双写到
 *    老路径,多出的字段也会被老 parser 按"未知字段"忽略——bump 的语义是
 *    "同一文件的不兼容重释义",纯增字段 + 换发布地址不构成。
 *  - 2026-07 稍后退役 cdnInternalBaseUrl(内网加速镜像下线,更新链只走
 *    cdnBaseUrl)同样没有 bump:删必填字段对**新客户端**是纯放松(清单里多出
 *    的该字段按未知字段忽略);退役时新路径清单尚无已发布的 packaged 消费者,
 *    线上清单已同步删除,无兼容包袱。
 *  - 2026-07-17 追加可选布尔字段 review(手机版审核模式开关,见
 *    CLIENT_ENDPOINT_REVIEW_KEY)同样没有 bump:可选字段、缺失即 false,
 *    老清单不受影响;老客户端按未知字段忽略。
 *  - 2026-07-17 退役 xdGatewayBaseUrl(同样不 bump,理由同上):XD 网关推理
 *    入口一律由 model-access server 随凭据成对下发(desktop
 *    model-access/effectiveEndpoint.ts),清单不再承载网关端点,杜绝
 *    「key 与 endpoint 不同租户」的撕裂组合;mobile 语音的网关地址经桌面端
 *    device-link 凭据同步获得,不再吃清单默认值。
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
  // oss-server(公开资产直传预签名,当前场景:头像上传)。
  'ossApiBaseUrl',
  'heartbeatUrl',
  'slackHookWsUrl',
  'websiteUrl',
  // model-access-server(登录后自动下发 LLM 网关凭据)的 API 基址。
  'modelAccessApiBaseUrl',
  // 更新/hotfix 链的 CDN base(manifest-*.json / hotfix 包 / agent 二进制)。
  'cdnBaseUrl',
  // 自建线手机整包发现的 mobile-update-server 基址(`${base}/latest`)。仅
  // mobile 自建变体(IS_OTA_SELFHOST)消费,desktop 与 EAS 线不读;清单值
  // 优先于烧包的 EXPO_PUBLIC_XDT_OTA_URL,让已发自建包可远程迁域名。
  // 注意热更通道的 updates.url 仍烧在原生层(expo-updates 架构),不吃本字段。
  'mobileUpdateBaseUrl',
] as const;

export type ClientEndpointKey = (typeof CLIENT_ENDPOINT_KEYS)[number];

/** 解析成功后的端点全集(全字段必有值,值全部来自清单)。 */
export type ClientEndpointMap = Record<ClientEndpointKey, string>;

/**
 * 可选布尔开关字段:`review` = 手机版审核模式(App 审核期间置 true:mobile
 * 关闭全部 **JS 显式更新检查路径**——启动 JS 热更门 / 整包检查 / resume 静默
 * 检查,设置页隐藏「检查更新 / 检查整包更新」;desktop 不消费)。
 * **可选、缺失即 false**——线上已发布的清单没有该字段,若设为必填会让新客户端
 * 对老清单启动阻断;可选纯增量也是不 bump schemaVersion 的前提(见上方版本注释)。
 * 存在但非 boolean 视为配置错,整份拒绝(阻断语义:配置错要炸出来,不静默猜测)。
 * 覆盖边界与影响面(置 true 前必须知晓):
 *  - **管不到 expo-updates 原生层**:CheckOnLaunch 是 build-time 原生配置
 *    (当前烘焙 ALWAYS),冷启动仍会后台静默 check+下载、下次启动生效——
 *    该缺口无法用运行时清单字段封,审核窗口内需同时冻结热更发布;
 *  - **region 级全量开关**:清单被该 region 所有存量 mobile 客户端共享,置
 *    true 期间全量用户(不只送审构建)的 JS 更新检查与强更弹窗一并停摆,
 *    审核结束必须及时改回 false。
 */
export const CLIENT_ENDPOINT_REVIEW_KEY = 'review';

/** 各字段允许的 URL 协议白名单。 */
const FIELD_PROTOCOLS: Record<ClientEndpointKey, readonly string[]> = {
  apiBaseUrl: ['https:'],
  authApiBaseUrl: ['https:'],
  deviceLinkApiBaseUrl: ['https:'],
  oauthBrokerApiBaseUrl: ['https:'],
  ossApiBaseUrl: ['https:'],
  heartbeatUrl: ['https:'],
  slackHookWsUrl: ['wss:'],
  websiteUrl: ['https:'],
  modelAccessApiBaseUrl: ['https:'],
  cdnBaseUrl: ['https:'],
  mobileUpdateBaseUrl: ['https:'],
};

/** 解析选项;allowHttp 仅供 dev 本地文件路径(endpoint.local.json 等)开启。 */
export interface ParseClientEndpointManifestOptions {
  /** true 时 https-only 字段追加接受 http:、wss 字段追加 ws:(localhost 场景)。 */
  allowHttp?: boolean;
}

function allowedProtocols(key: ClientEndpointKey, allowHttp: boolean): readonly string[] {
  const base = FIELD_PROTOCOLS[key];
  if (!allowHttp) return base;
  const relaxed = [...base];
  if (base.includes('https:') && !base.includes('http:')) relaxed.push('http:');
  if (base.includes('wss:') && !base.includes('ws:')) relaxed.push('ws:');
  return relaxed;
}

export type ParseClientEndpointManifestResult =
  | { ok: true; endpoints: ClientEndpointMap; review: boolean }
  | { ok: false; reason: string };

/**
 * 解析并校验一份清单原文。纯函数,输入任意文本都不会抛出。
 * 端点全字段必填:缺失 / 非法 / 协议不符 / 带凭据,任一命中整份拒绝;
 * `review` 可选布尔,缺失 = false(语义见 CLIENT_ENDPOINT_REVIEW_KEY)。
 */
export function parseClientEndpointManifest(
  rawText: string,
  options?: ParseClientEndpointManifestOptions,
): ParseClientEndpointManifestResult {
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
    if (!allowedProtocols(key, options?.allowHttp === true).includes(url.protocol)) {
      return { ok: false, reason: `invalid-protocol:${key}` };
    }
    if (url.username || url.password) {
      return { ok: false, reason: `credentials-in-url:${key}` };
    }
    endpoints[key] = normalized;
  }

  const rawReview = record[CLIENT_ENDPOINT_REVIEW_KEY];
  if (rawReview !== undefined && typeof rawReview !== 'boolean') {
    return { ok: false, reason: `invalid-field:${CLIENT_ENDPOINT_REVIEW_KEY}` };
  }

  return { ok: true, endpoints, review: rawReview === true };
}

export type ResolveClientEndpointsResult =
  | { ok: true; endpoints: ClientEndpointMap; review: boolean }
  | { ok: false; reason: string };

/**
 * 严格解析:清单原文 → 完整端点 map(值全部来自清单,无任何本地合并)。
 * rawText 为 null(拉取失败/超时)→ ok:false('fetch-failed'),宿主必须阻断并重试。
 */
export function resolveClientEndpointsStrict(
  rawText: string | null,
  options?: ParseClientEndpointManifestOptions,
): ResolveClientEndpointsResult {
  if (rawText === null) {
    return { ok: false, reason: 'fetch-failed' };
  }
  return parseClientEndpointManifest(rawText, options);
}
