/**
 * clientEndpointStartup —— 客户端端点清单(`<hotfix CDN base>/endpoint.json`)
 * 的 mobile 启动解析(useStartupEndpointGate 的执行体;依赖注入、可纯函数单测)。
 *
 * 语义:**CDN 清单优先 + 包内正本兜底**(2026-07-18 与 Lizi 定案,放宽此前的
 * 纯阻断语义;背景是 iOS 0.1.0 发版撞上线上清单未同步更新 + CDN 长缓存,
 * 真机全量启动阻断)。解析按三级阶梯,全部确定性代码、无 LLM/启发式:
 *  1. **CDN 严格解析**:清单完整合法 → 全量采用(与旧语义一致);
 *  2. **字段级兜底**:CDN 拉到的是 JSON 对象(且 schemaVersion 未超出本构建
 *     支持范围)但缺字段 / 字段值非 string / 空串 → 以包内正本为底、CDN 的
 *     合法字段覆盖(CDN 值优先,缺的吃包内值)。注意 string 但 URL/协议非法
 *     的值会让合并结果过不了严格校验,整体跌到下一级;
 *  3. **整份兜底**:拉不到 / 非 JSON / schemaVersion 不兼容 / 合并后仍非法 →
 *     整份采用包内正本的端点值。
 * 三级都不可用(理论上只有包内正本损坏)才返回失败、闸门渲染错误屏。
 * 兜底命中时 console.warn 告警,不静默——CDN 配置错误仍要在日志里可见。
 *
 * **`review`(审核模式送审版本号)只信任 live CDN,包内正本的 review 不参与
 * 任何兜底**:正本在送审窗口会携带送审版本号,若随兜底生效,已发包在 CDN
 * 故障时会误进审核模式、静默失去更新通道(违背 env.isReviewModeActive 的
 * 「宁可不进审核模式」原则)。字段级兜底会先剥掉包内 review 再合并(CDN 显式
 * review:"" 的「关闭」语义原样透传);整份兜底恒按 review 未填处理。
 *
 * 包内正本 = 构建期 metro 静态打进 bundle 的仓内 config/endpoint(.global).json
 * (按 region 二选一,~1KB)。它与本构建的 parser schema 恒匹配(守门测试保证
 * 正本能过 parser),因此「新客户端先于线上清单发布」的时序事故不再阻断启动;
 * 代价是清单配错时客户端会静默跑在构建期端点上,靠告警日志与发版 preflight
 * 兜住。desktop 仍维持严格阻断语义(见 maker-shared clientEndpoints 头注)。
 *
 * 共享逻辑(schema / 校验)在 @lizi/maker-shared/client-endpoints;本文件负责
 * mobile 侧 IO(全局 fetch + AbortController)与兜底阶梯;成功后经
 * env.applyResolvedClientEndpoints 回写 live binding。
 */

import {
  CLIENT_ENDPOINT_REVIEW_KEY,
  CLIENT_ENDPOINTS_SCHEMA_VERSION,
  resolveClientEndpointsStrict,
  type ClientEndpointMap,
} from '@lizi/maker-shared/client-endpoints';

import { AUTH_REGION, ENDPOINT_MANIFEST_BASE_URL, applyResolvedClientEndpoints } from './env';

const MANIFEST_RELATIVE_PATH = '/endpoint.json';
/** 单次请求的网络超时——超时即进入兜底阶梯,不是无限等待。 */
const ATTEMPT_TIMEOUT_MS = 10_000;

async function fetchManifestTextViaCdn(timeoutMs: number): Promise<string | null> {
  // 构建缺自举基址属打包配置事故:CDN 级不可用,交给兜底阶梯
  if (!ENDPOINT_MANIFEST_BASE_URL) return null;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(
      `${ENDPOINT_MANIFEST_BASE_URL}${MANIFEST_RELATIVE_PATH}?t=${Date.now()}`,
      { signal: controller.signal },
    );
    if (!response.ok) return null;
    return await response.text();
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * 包内正本原文(构建期 region 二选一;metro 对两个字面量路径都会静态打包,
 * 运行时只消费其一)。vitest node 环境没有 metro 的 require,catch 后返回
 * null——测试一律经 deps.bundledManifestText 注入,不依赖本默认实现。
 */
function loadBundledManifestText(): string | null {
  try {
    const raw: unknown =
      AUTH_REGION === 'global'
        ? // eslint-disable-next-line @typescript-eslint/no-require-imports
          require('../../../../config/endpoint.global.json')
        : // eslint-disable-next-line @typescript-eslint/no-require-imports
          require('../../../../config/endpoint.json');
    return JSON.stringify(raw);
  } catch {
    return null;
  }
}

function tryParseRecord(text: string | null): Record<string, unknown> | null {
  if (text === null) return null;
  try {
    const parsed: unknown = JSON.parse(text);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null;
    return parsed as Record<string, unknown>;
  } catch {
    return null;
  }
}

/**
 * 字段级兜底合并(纯函数):以包内正本为底,CDN 清单的合法字段覆盖。
 *  - 只接受 string 且 trim 非空的 CDN 值;非 string / 空串按「字段不存在」
 *    处理,吃包内值(避免线上残缺值把合并结果整份带崩);
 *  - `review` 只信 CDN:包内正本的 review 先剥离(送审版本号不得随兜底泄漏
 *    到线上,见文件头注);CDN 侧 review 空串是「显式关闭审核模式」的合法值,
 *    原样透传;
 *  - `schemaVersion` 恒取包内正本(= 本构建支持的版本);CDN 侧 schemaVersion
 *    存在但非法 / 超出本构建支持版本 → 整份放弃合并(不兼容清单的字段值不能
 *    按旧语义收编),返回 null 交由整份兜底路径处理。
 * 任一侧不是 JSON 对象 → null(无从合并,调用方走整份兜底)。
 */
export function mergeManifestWithBundled(
  bundledText: string,
  cdnText: string | null,
): string | null {
  const bundled = tryParseRecord(bundledText);
  const cdn = tryParseRecord(cdnText);
  if (!bundled || !cdn) return null;
  const cdnSchemaVersion = cdn.schemaVersion;
  if (
    cdnSchemaVersion !== undefined &&
    (typeof cdnSchemaVersion !== 'number' ||
      !Number.isInteger(cdnSchemaVersion) ||
      cdnSchemaVersion < 1 ||
      cdnSchemaVersion > CLIENT_ENDPOINTS_SCHEMA_VERSION)
  ) {
    return null;
  }
  const merged: Record<string, unknown> = { ...bundled };
  delete merged[CLIENT_ENDPOINT_REVIEW_KEY];
  for (const [key, value] of Object.entries(cdn)) {
    if (key === 'schemaVersion') continue;
    if (typeof value !== 'string') continue;
    if (key === CLIENT_ENDPOINT_REVIEW_KEY || value.trim()) {
      merged[key] = value;
    }
  }
  return JSON.stringify(merged);
}

/** 测试注入点;生产走默认实现。 */
export interface StartupEndpointResolveDeps {
  fetchManifestText?: (timeoutMs: number) => Promise<string | null>;
  apply?: (resolved: ClientEndpointMap & { reviewVersion: string | null }) => void;
  timeoutMs?: number;
  /** 包内正本原文覆写:string = 指定内容;null = 模拟正本不可用;缺省 = 默认加载。 */
  bundledManifestText?: string | null;
}

export type StartupEndpointResolveOutcome =
  | {
      ok: true;
      /** 生效端点来源:cdn = 清单完整;cdn+bundled = 字段级兜底;bundled = 整份兜底。 */
      source: 'cdn' | 'cdn+bundled' | 'bundled';
      /** 兜底命中时,CDN 严格解析的失败原因(missing-field:xxx / fetch-failed / ...)。 */
      fallbackFrom?: string;
    }
  | { ok: false; reason: string };

/**
 * 单次解析尝试:按「CDN 严格 → 字段级兜底 → 整份兜底」阶梯解析,成功 → 回写
 * env live binding;三级全失败 → 返回 reason,由闸门渲染错误屏,重试 = 再调
 * 一次本函数。本函数自身永不 reject。
 */
export async function runStartupEndpointResolve(
  deps: StartupEndpointResolveDeps = {},
): Promise<StartupEndpointResolveOutcome> {
  try {
    const fetchManifestText = deps.fetchManifestText ?? fetchManifestTextViaCdn;
    const apply = deps.apply ?? applyResolvedClientEndpoints;
    let rawText: string | null = null;
    try {
      rawText = await fetchManifestText(deps.timeoutMs ?? ATTEMPT_TIMEOUT_MS);
    } catch {
      rawText = null;
    }

    const strict = resolveClientEndpointsStrict(rawText);
    if (strict.ok) {
      apply({ ...strict.endpoints, reviewVersion: strict.reviewVersion });
      return { ok: true, source: 'cdn' };
    }

    const bundledText =
      deps.bundledManifestText !== undefined ? deps.bundledManifestText : loadBundledManifestText();
    if (bundledText !== null) {
      const candidates: Array<['cdn+bundled' | 'bundled', string | null]> = [
        ['cdn+bundled', mergeManifestWithBundled(bundledText, rawText)],
        ['bundled', bundledText],
      ];
      for (const [source, text] of candidates) {
        if (text === null) continue;
        const result = resolveClientEndpointsStrict(text);
        if (!result.ok) continue;
        // review 只信 CDN:整份兜底恒按未填处理;字段级兜底的 review 已在
        // merge 内保证只来自 CDN(包内值被剥离)。
        apply({
          ...result.endpoints,
          reviewVersion: source === 'bundled' ? null : result.reviewVersion,
        });
        // eslint-disable-next-line no-console
        console.warn(
          `[clientEndpointStartup] CDN manifest unusable (${strict.reason}), falling back to bundled endpoints (${source})`,
        );
        return { ok: true, source, fallbackFrom: strict.reason };
      }
    }

    return { ok: false, reason: strict.reason };
  } catch {
    return { ok: false, reason: 'internal-error' };
  }
}
