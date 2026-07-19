/**
 * model-discovery/anthropic —— Anthropic(Claude.ai 订阅)模型清单的动态发现。
 * ---------------------------------------------------------------------------
 * 2026-07-19 模型列表统一重构:anthropic 供应商的清单**唯一来源是动态发现**,
 * 产品目录静态段已退役(bundled 恒为空)。两条互补通道,汇入同一个 apply:
 *
 *   1. **HTTP `/v1/models`**(登录成功 / 启动时):订阅 OAuth Bearer +
 *      `anthropic-beta: oauth-2025-04-20`(与 title-one-shot 同一套已验证的头)。
 *      即时出清单;响应可能不带 effort/fast 能力信息,此时按确定性默认合成
 *      (见 mapAnthropicHttpModels),等 SDK 通道精化。
 *   2. **SDK `supportedModels()`**(每次 claude-code 会话 init 后捕获,经
 *      maker-core setClaudeSupportedModelsListener):效力最高——effort 档 /
 *      fastMode 是 SDK 明说的,逐字段可信。
 *
 * 合并纪律(确定性,无隐藏兜底):
 *   - 两条通道都按 id 合并:条目自带能力信息(hasCapabilityInfo)则覆盖,否则保留
 *     已发现条目的能力字段(防止「不带能力字段的粗清单」把「已精化的档位」打回默认);
 *   - HTTP 明说的 max_input_tokens 单独记账(explicitWindows,随缓存持久化),SDK
 *     通道覆盖时不许把精确窗口打回 1M/200k 猜测值;
 *   - 失败不清列表(上一次成功结果 + 磁盘缓存是「陈旧的真数据」,可溯源),
 *     只有**登出**才清空并删缓存。
 *
 * 登录态门控(2026-07-19 对抗性 review P1):两条通道的 apply 都必须以「当前确有
 * Claude.ai OAuth」为前提——SDK 捕获来自本地 CLI 注册表,不需要 Anthropic 凭证也能
 * 应答,不设门会让未登录 / 已登出用户长出 anthropic 清单并重建刚删掉的缓存;HTTP
 * 在途请求跨越登出完成时同理。世代计数(authGeneration)在登出时自增,作废一切
 * 在途写回,并让换号后的新拉取不被旧 single-flight 吞掉。
 *
 * contextWindow 规则(Anthropic 无任何动态通道下发窗口,2026-07-19 与 Lizi 定案):
 *   HTTP 响应带 max_input_tokens 用之;否则默认 1M,仅 id 含 "haiku" 例外 200k。
 *   猜错 1M 的后果是该模型请求被拒(带 [1m] 后缀),由会话报错 + usage 校准暴露。
 *
 * 磁盘缓存:`<userData>/model-discovery/anthropic-models.json`
 * ({ fetchedAt, models });只缓存动态获取的成功结果,与静态兜底是两回事。
 */

import { app } from 'electron';
import fsp from 'node:fs/promises';
import path from 'node:path';

import type { CatalogModel, Effort } from '@lizi/model-providers';

import { createLogger } from '../../logger.js';
import { getActiveCatalog, setAnthropicDiscoveredModels } from '../active-catalog.js';
import { hasClaudeAiOAuth } from '../claude-credentials-store.js';
import { getValidClaudeAiOAuth } from '../claude-oauth-refresh.js';

const log = createLogger('model-discovery:anthropic');

const VALID_EFFORTS: ReadonlySet<string> = new Set(['minimal', 'low', 'medium', 'high', 'xhigh', 'max']);
const HTTP_TIMEOUT_MS = 15_000;
/** /v1/models 游标分页的最大页数(现实模型数远小于单页 1000,纯防御)。 */
const MAX_MODEL_PAGES = 5;

/** apply 后的收口回调(refreshCatalogDerivedModels + PROVIDER_CHANGED 广播),由 bootstrap 注入。 */
let onApplied: (() => void) | null = null;
/** 最近一次生效的发现结果(含缓存加载),合并时的能力字段保留源。 */
let lastApplied: CatalogModel[] = [];
/** HTTP 明说过 max_input_tokens 的模型窗口(id → tokens);SDK 覆盖时优先于启发式规则。 */
const explicitWindows = new Map<string, number>();
/** 登出时自增:在途 HTTP 拉取完成时若世代已变,结果作废不写回。 */
let authGeneration = 0;
let httpRefreshInflight: Promise<void> | null = null;
/** 在途拉取所属的世代;世代已变时新调用不复用旧 promise(换号补拉不被吞)。 */
let httpRefreshInflightGen = -1;

export function configureAnthropicDiscovery(deps: { onApplied: () => void }): void {
  onApplied = deps.onApplied;
}

function cacheFilePath(): string {
  return path.join(app.getPath('userData'), 'model-discovery', 'anthropic-models.json');
}

/** 剥掉 dated wire id 的日期后缀(claude-opus-4-8-20260401 → claude-opus-4-8)。 */
function normalizeModelId(raw: string): string {
  return raw.replace(/-20\d{6}$/, '');
}

/** contextWindow 规则:默认 1M,仅 haiku 系例外 200k(定案见文件头)。 */
function contextWindowFor(id: string, explicit?: number): number {
  if (typeof explicit === 'number' && explicit > 0) return explicit;
  return /haiku/.test(id) ? 200_000 : 1_000_000;
}

function pickDefaultEffort(efforts: Effort[]): Effort | null {
  if (efforts.length === 0) return null;
  return efforts.includes('high') ? 'high' : efforts[efforts.length - 1];
}

function toEfforts(raw: unknown): Effort[] | null {
  if (!Array.isArray(raw)) return null;
  const out = raw.filter((e): e is Effort => typeof e === 'string' && VALID_EFFORTS.has(e));
  return out;
}

/** SDK 映射结果:能力字段是条目明说的还是合成默认的(决定合并时是否覆盖已精化条目)。 */
export interface SdkMappedModel {
  model: CatalogModel;
  hasCapabilityInfo: boolean;
}

/** 无能力信息时的确定性默认档位(与 HTTP 通道同一套):3 档,haiku 系例外 0 档。 */
function defaultEffortsFor(id: string): Effort[] {
  return /haiku/.test(id) ? [] : ['low', 'medium', 'high'];
}

/**
 * SDK `supportedModels()` 条目 → 映射结果。纯函数。
 * 只收 `claude` 开头的显式版本 id(规则 10:禁止 opus/sonnet 裸别名进目录)。
 * ModelInfo 的能力字段全部 optional:字段在场时 SDK 是能力权威(supportsEffort=false =
 * 不可调);**全缺席 = 未知**,按确定性默认合成并标记 hasCapabilityInfo=false,合并时
 * 保留已精化条目——不能把「CLI 没填」解读成「不支持」而抹掉档位(review P2)。
 */
export function mapAnthropicSdkModels(raw: unknown): SdkMappedModel[] {
  if (!Array.isArray(raw)) return [];
  const out: SdkMappedModel[] = [];
  const seen = new Set<string>();
  for (const entry of raw) {
    if (!entry || typeof entry !== 'object') continue;
    const e = entry as {
      value?: unknown;
      displayName?: unknown;
      description?: unknown;
      supportsEffort?: unknown;
      supportedEffortLevels?: unknown;
      supportsFastMode?: unknown;
    };
    if (typeof e.value !== 'string' || e.value.length === 0) continue;
    const id = normalizeModelId(e.value);
    if (!id.startsWith('claude') || seen.has(id)) continue;
    seen.add(id);
    const hasCapabilityInfo =
      e.supportsEffort !== undefined ||
      e.supportedEffortLevels !== undefined ||
      e.supportsFastMode !== undefined;
    let efforts: Effort[];
    if (!hasCapabilityInfo) {
      efforts = defaultEffortsFor(id);
    } else if (e.supportsEffort === false) {
      efforts = [];
    } else {
      const levels = toEfforts(e.supportedEffortLevels);
      // supportsEffort=true 但没给档位清单:按确定性默认合成,不解读为不可调。
      efforts = levels && levels.length > 0 ? levels : e.supportsEffort === true ? defaultEffortsFor(id) : [];
    }
    out.push({
      hasCapabilityInfo,
      model: {
        id,
        name: typeof e.displayName === 'string' && e.displayName.length > 0 ? e.displayName : id,
        group: 'anthropic',
        sortOrder: out.length,
        ...(typeof e.description === 'string' && e.description.length > 0
          ? { description: e.description }
          : {}),
        contextWindow: contextWindowFor(id),
        efforts,
        defaultEffort: pickDefaultEffort(efforts),
        supportsFastMode: e.supportsFastMode === true,
        status: 'active',
        // 旧产品目录刻意把 haiku 收起(defaultEnabled:false);默认可见性是客户端
        // 展示策略,不随清单动态化而漂移。
        ...(/haiku/.test(id) ? { defaultEnabled: false } : {}),
      },
    });
  }
  return out;
}

/** HTTP 映射结果:能力字段是响应明说的还是合成默认的(决定合并时是否覆盖已精化条目)。 */
export interface HttpMappedModel {
  model: CatalogModel;
  hasCapabilityInfo: boolean;
  /** 响应明说的 max_input_tokens(null = 未下发,窗口来自启发式规则)。 */
  explicitContextWindow: number | null;
}

/**
 * HTTP `GET /v1/models` 单页条目数组 → 映射结果。纯函数,对响应形状容错:
 * 能力字段(capabilities.efforts / fast_mode)是 Anthropic 侧未固化的扩展,认得出
 * 就用(hasCapabilityInfo=true),认不出按确定性默认合成——3 档(low/medium/high,
 * 默认 high),haiku 系例外 0 档(与 contextWindow 同源的 haiku 判别,haiku 从未
 * 支持档位调节);fastMode 默认 false(SDK 通道会精化)。
 */
export function mapAnthropicHttpModels(raw: unknown): HttpMappedModel[] {
  if (!Array.isArray(raw)) return [];
  const out: HttpMappedModel[] = [];
  const seen = new Set<string>();
  for (const entry of raw) {
    if (!entry || typeof entry !== 'object') continue;
    const e = entry as {
      id?: unknown;
      type?: unknown;
      display_name?: unknown;
      max_input_tokens?: unknown;
      capabilities?: unknown;
    };
    if (e.type !== undefined && e.type !== 'model') continue;
    if (typeof e.id !== 'string' || e.id.length === 0) continue;
    const id = normalizeModelId(e.id);
    // /v1/models 新发布在前;dated 变体剥后缀去重 first-wins = 保留最新。
    if (!id.startsWith('claude') || seen.has(id)) continue;
    seen.add(id);
    const caps =
      e.capabilities && typeof e.capabilities === 'object'
        ? (e.capabilities as { efforts?: unknown; effort_levels?: unknown; fast_mode?: unknown })
        : null;
    const capEfforts = caps ? (toEfforts(caps.efforts) ?? toEfforts(caps.effort_levels)) : null;
    const hasCapabilityInfo = capEfforts !== null;
    const efforts: Effort[] = capEfforts ?? defaultEffortsFor(id);
    const maxInput =
      typeof e.max_input_tokens === 'number' && e.max_input_tokens > 0 ? e.max_input_tokens : null;
    out.push({
      hasCapabilityInfo,
      explicitContextWindow: maxInput,
      model: {
        id,
        name: typeof e.display_name === 'string' && e.display_name.length > 0 ? e.display_name : id,
        group: 'anthropic',
        sortOrder: out.length,
        contextWindow: contextWindowFor(id, maxInput ?? undefined),
        efforts,
        defaultEffort: pickDefaultEffort(efforts),
        supportsFastMode: caps?.fast_mode === true,
        status: 'active',
        ...(/haiku/.test(id) ? { defaultEnabled: false } : {}),
      },
    });
  }
  return out;
}

/**
 * 生效 + 可选持久化 + 收口(能力刷新 / 广播由注入的 onApplied 负责)。
 * 内容与现值一致时整体跳过(SDK 捕获每会话触发,清单通常一字不变——不做比较会
 * 每开一个会话就白跑一次落盘 + 全窗口广播 + capabilities 重 derive,review P2)。
 */
async function applyModels(models: CatalogModel[], persist: boolean): Promise<void> {
  if (JSON.stringify(models) === JSON.stringify(lastApplied)) return;
  lastApplied = models;
  setAnthropicDiscoveredModels(models);
  if (persist) {
    try {
      const file = cacheFilePath();
      await fsp.mkdir(path.dirname(file), { recursive: true });
      await fsp.writeFile(
        file,
        JSON.stringify(
          {
            fetchedAt: new Date().toISOString(),
            models,
            explicitWindows: Object.fromEntries(explicitWindows),
          },
          null,
          2,
        ),
        'utf-8',
      );
    } catch (err) {
      log.warn('persist anthropic models cache failed', { error: String(err) });
    }
  }
  try {
    onApplied?.();
  } catch (err) {
    log.warn('anthropic discovery onApplied threw', { error: String(err) });
  }
}

/**
 * 启动时加载磁盘缓存(上一次动态获取的成功结果)。未登录不加载(登出即清,
 * 残留缓存也不能代表可用性);缓存缺失 / 坏 JSON 静默跳过(等 HTTP / SDK 通道)。
 */
export async function loadAnthropicModelsFromDiskCache(): Promise<void> {
  if (!hasClaudeAiOAuth()) return;
  try {
    const raw: unknown = JSON.parse(await fsp.readFile(cacheFilePath(), 'utf-8'));
    const models = (raw as { models?: unknown } | null)?.models;
    if (!Array.isArray(models) || models.length === 0) return;
    // 恢复「窗口来自 HTTP 明说」的记账,否则重启后首个 SDK 捕获会把精确窗口打回猜测值。
    const windows = (raw as { explicitWindows?: unknown }).explicitWindows;
    if (windows && typeof windows === 'object' && !Array.isArray(windows)) {
      for (const [id, win] of Object.entries(windows as Record<string, unknown>)) {
        if (typeof win === 'number' && win > 0) explicitWindows.set(id, win);
      }
    }
    // 缓存内容出自本模块 mapper,仍做最小结构校验防手改坏文件。
    const valid = models.filter(
      (m): m is CatalogModel =>
        !!m &&
        typeof m === 'object' &&
        typeof (m as CatalogModel).id === 'string' &&
        typeof (m as CatalogModel).name === 'string' &&
        typeof (m as CatalogModel).contextWindow === 'number' &&
        Array.isArray((m as CatalogModel).efforts),
    );
    if (valid.length === 0) return;
    await applyModels(valid, false);
    log.info(`anthropic models loaded from disk cache: ${valid.length}`);
  } catch {
    /* 缓存缺失 / 损坏:等动态通道,不影响启动 */
  }
}

/**
 * SDK 会话 init 捕获入口(maker-core setClaudeSupportedModelsListener 接线)。
 * 登录态门控:SDK 应答来自本地 CLI 注册表,任何 provider 的 cc 会话都会触发,
 * 未登录 Claude.ai 时不得注入(否则登出被击穿 / 纯网关用户长出 anthropic 清单)。
 * 按 id 合并:条目带能力信息则覆盖,否则保留已精化条目;HTTP 明说过的窗口不回退。
 */
export function noteAnthropicSdkSupportedModels(raw: unknown): void {
  if (!hasClaudeAiOAuth()) return;
  const mapped = mapAnthropicSdkModels(raw);
  if (mapped.length === 0) return;
  const prevById = new Map(lastApplied.map((m) => [m.id, m]));
  const models = mapped.map(({ model, hasCapabilityInfo }) => {
    const explicit = explicitWindows.get(model.id);
    const base = explicit !== undefined ? { ...model, contextWindow: explicit } : model;
    const prev = prevById.get(model.id);
    if (!prev || hasCapabilityInfo) return base;
    return {
      ...base,
      efforts: prev.efforts,
      defaultEffort: prev.defaultEffort,
      supportsFastMode: prev.supportsFastMode,
    };
  });
  log.info(`anthropic models captured from SDK init: ${models.length}`);
  void applyModels(models, true);
}

/**
 * HTTP `/v1/models` 拉取(登录成功 / 启动时)。single-flight;失败只记日志、
 * 保留现值(缓存是上次成功的真数据);成功按合并纪律生效并持久化。
 */
export function refreshAnthropicModelsFromHttp(): Promise<void> {
  // 只复用**同世代**的在途拉取:登出后世代已变,旧 promise 的结果注定作废,
  // 复用会吞掉换号后新账号的补拉。
  if (httpRefreshInflight && httpRefreshInflightGen === authGeneration) return httpRefreshInflight;
  const gen = authGeneration;
  const flight = (async () => {
    const oauth = await getValidClaudeAiOAuth();
    if (!oauth?.accessToken) return;
    const provider = getActiveCatalog().providers.find((p) => p.id === 'anthropic');
    const upstream = provider?.routing['claude-code']?.upstream ?? 'https://api.anthropic.com';
    const entries: unknown[] = [];
    let url: string | null = `${upstream.replace(/\/+$/, '')}/v1/models?limit=1000`;
    try {
      for (let page = 0; url && page < MAX_MODEL_PAGES; page += 1) {
        const res: Response = await fetch(url, {
          headers: {
            authorization: `Bearer ${oauth.accessToken}`,
            'anthropic-version': '2023-06-01',
            'anthropic-beta': 'oauth-2025-04-20',
          },
          signal: AbortSignal.timeout(HTTP_TIMEOUT_MS),
        });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const body = (await res.json()) as { data?: unknown[]; has_more?: boolean; last_id?: string };
        if (Array.isArray(body.data)) entries.push(...body.data);
        url =
          body.has_more && typeof body.last_id === 'string'
            ? `${upstream.replace(/\/+$/, '')}/v1/models?limit=1000&after_id=${encodeURIComponent(body.last_id)}`
            : null;
      }
    } catch (err) {
      // 失败不清列表:现值(含磁盘缓存)是上次成功的真数据;SDK 通道随后仍会精化。
      log.warn('anthropic /v1/models fetch failed; keeping current list', { error: String(err) });
      return;
    }
    // 在途期间登出 / 换号:结果作废,不写回、不重建缓存(review P1 竞态豁口)。
    if (gen !== authGeneration || !hasClaudeAiOAuth()) {
      log.info('anthropic /v1/models result discarded: auth changed mid-flight');
      return;
    }
    const mapped = mapAnthropicHttpModels(entries);
    if (mapped.length === 0) {
      log.warn('anthropic /v1/models returned no usable models; keeping current list');
      return;
    }
    for (const { model, explicitContextWindow } of mapped) {
      if (explicitContextWindow != null) explicitWindows.set(model.id, explicitContextWindow);
    }
    // 合并:HTTP 无能力信息的条目保留已精化(SDK/缓存)条目的能力字段。
    const prevById = new Map(lastApplied.map((m) => [m.id, m]));
    const models = mapped.map(({ model, hasCapabilityInfo }) => {
      const prev = prevById.get(model.id);
      if (!prev || hasCapabilityInfo) return model;
      return {
        ...model,
        efforts: prev.efforts,
        defaultEffort: prev.defaultEffort,
        supportsFastMode: prev.supportsFastMode,
      };
    });
    log.info(`anthropic models refreshed via HTTP: ${models.length}`);
    await applyModels(models, true);
  })().finally(() => {
    // 只清自己的登记:世代变化后可能已有新 flight 顶替,不能误清。
    if (httpRefreshInflight === flight) httpRefreshInflight = null;
  });
  httpRefreshInflight = flight;
  httpRefreshInflightGen = gen;
  return flight;
}

/**
 * 登录成功收口(换号可以不经过登出,直接覆盖凭证):作废在途拉取,让紧随其后的
 * refresh 用新凭证起新一轮,而不是被旧账号的 single-flight 吞掉。
 */
export function invalidateAnthropicDiscoveryInflight(): void {
  authGeneration += 1;
}

/** 登出收口:清空清单 + 删磁盘缓存 + 作废在途拉取(旧账号的清单不能跨登录残留)。 */
export async function clearAnthropicDiscoveredModels(): Promise<void> {
  authGeneration += 1;
  explicitWindows.clear();
  await applyModels([], false);
  try {
    await fsp.rm(cacheFilePath(), { force: true });
  } catch {
    /* 删缓存失败无害:下次登录会整体覆盖 */
  }
}

/** 仅测试:重置模块态。 */
export function resetAnthropicDiscoveryForTest(): void {
  onApplied = null;
  lastApplied = [];
  explicitWindows.clear();
  authGeneration = 0;
  httpRefreshInflight = null;
  httpRefreshInflightGen = -1;
}
