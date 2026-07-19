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
 *   - SDK 结果整体覆盖(权威);
 *   - HTTP 结果按 id 合并:HTTP 自带能力信息(hasCapabilityInfo)则覆盖,否则
 *     保留已发现条目的能力字段(防止「登录时的粗清单」把「SDK 精化过的档位」打回默认);
 *   - 失败不清列表(上一次成功结果 + 磁盘缓存是「陈旧的真数据」,可溯源),
 *     只有**登出**才清空并删缓存。
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
/** 最近一次生效的发现结果(含缓存加载),HTTP 合并时的能力字段保留源。 */
let lastApplied: CatalogModel[] = [];
let httpRefreshInflight: Promise<void> | null = null;

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

/**
 * SDK `supportedModels()` 条目 → CatalogModel。纯函数。
 * 只收 `claude` 开头的显式版本 id(规则 10:禁止 opus/sonnet 裸别名进目录);
 * SDK 是能力权威:supportsEffort=false / 缺档位 = 不可调,supportsFastMode 缺省 = false。
 */
export function mapAnthropicSdkModels(raw: unknown): CatalogModel[] {
  if (!Array.isArray(raw)) return [];
  const out: CatalogModel[] = [];
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
    const efforts = e.supportsEffort === false ? [] : (toEfforts(e.supportedEffortLevels) ?? []);
    out.push({
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
    });
  }
  return out;
}

/** HTTP 映射结果:能力字段是响应明说的还是合成默认的(决定合并时是否覆盖已精化条目)。 */
export interface HttpMappedModel {
  model: CatalogModel;
  hasCapabilityInfo: boolean;
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
    const efforts: Effort[] = capEfforts ?? (/haiku/.test(id) ? [] : ['low', 'medium', 'high']);
    const maxInput = typeof e.max_input_tokens === 'number' ? e.max_input_tokens : undefined;
    out.push({
      hasCapabilityInfo,
      model: {
        id,
        name: typeof e.display_name === 'string' && e.display_name.length > 0 ? e.display_name : id,
        group: 'anthropic',
        sortOrder: out.length,
        contextWindow: contextWindowFor(id, maxInput),
        efforts,
        defaultEffort: pickDefaultEffort(efforts),
        supportsFastMode: caps?.fast_mode === true,
        status: 'active',
      },
    });
  }
  return out;
}

/** 生效 + 可选持久化 + 收口(能力刷新 / 广播由注入的 onApplied 负责)。 */
async function applyModels(models: CatalogModel[], persist: boolean): Promise<void> {
  lastApplied = models;
  setAnthropicDiscoveredModels(models);
  if (persist) {
    try {
      const file = cacheFilePath();
      await fsp.mkdir(path.dirname(file), { recursive: true });
      await fsp.writeFile(
        file,
        JSON.stringify({ fetchedAt: new Date().toISOString(), models }, null, 2),
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

/** SDK 会话 init 捕获入口(maker-core setClaudeSupportedModelsListener 接线)。 */
export function noteAnthropicSdkSupportedModels(raw: unknown): void {
  const models = mapAnthropicSdkModels(raw);
  if (models.length === 0) return;
  log.info(`anthropic models captured from SDK init: ${models.length}`);
  void applyModels(models, true);
}

/**
 * HTTP `/v1/models` 拉取(登录成功 / 启动时)。single-flight;失败只记日志、
 * 保留现值(缓存是上次成功的真数据);成功按合并纪律生效并持久化。
 */
export function refreshAnthropicModelsFromHttp(): Promise<void> {
  if (httpRefreshInflight) return httpRefreshInflight;
  httpRefreshInflight = (async () => {
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
    const mapped = mapAnthropicHttpModels(entries);
    if (mapped.length === 0) {
      log.warn('anthropic /v1/models returned no usable models; keeping current list');
      return;
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
    httpRefreshInflight = null;
  });
  return httpRefreshInflight;
}

/** 登出收口:清空清单 + 删磁盘缓存(旧账号的清单不能跨登录残留)。 */
export async function clearAnthropicDiscoveredModels(): Promise<void> {
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
  httpRefreshInflight = null;
}
