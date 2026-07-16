/**
 * providerModelMemory —— 按「(agent, 来源/provider, model) → effort」记忆,外加每个来源
 * 「上次选中的模型」,localStorage 持久化,跨会话 / 跨重启在本机生效。
 *
 * 背景:
 *   用户在不同来源(provider)下、对不同模型偏好不同的 effort —— 例如在 Anthropic 给 opus 用
 *   high、在 XD 网关给同一个 opus 用 medium;同一来源里 opus 用 high、haiku 用 low。此前 renderer
 *   的模型记忆都没有「按 (来源, 模型) 分别记 effort」这一维度:
 *     1) 全局单槽默认(服务端 UserPreferences.defaultModel/defaultEffort);
 *     2) per-session(sessions 表 model/effort/providerId 各一份);
 *     3) per-model effort(effortByModel,只按 modelId 记,跨来源会串)。
 *   本 store 补「(agent, provider, model) → effort」这一维度,并保留「该来源上次用过哪个模型」
 *   (lastModel)用于切来源时落到正确的模型。
 *
 * 谁读谁写:
 *   - 写:ChatInput —— 用户在某来源下选定 (model, effort) 后,把 effort 记进
 *         (agent, provider, model) 槽,并更新该来源的 lastModel(setProviderModelChoice)。
 *   - 读:
 *       · ModelSelector 的 resolveSourceSwitch —— 切来源时取该来源 lastModel + 其 effort
 *         (getProviderModelChoice)作为落点 hint;
 *       · ChatInput 的 effort 解析 —— 选回某 (provider, model) 时精确恢复其 effort
 *         (getProviderModelEffort)。
 *
 * key 设计:`${agentKind}:${providerId}` → ProviderMemory。
 *   xd 来源同时服务 cc / codex 两个 agent,若只按 providerId 分槽,cc 会话与 codex 会话会
 *   互相覆盖对方在 xd 下的选择。按 (agent, provider) 分槽彻底规避;每个槽内再按 modelId 分 effort。
 *
 * 持久化频率极低(仅用户点 dropdown 触发),同步写 localStorage,不做 batch / debounce
 * —— 与 newMakerDraft 的取舍一致(避免热更新 relaunch 强退丢最近一次改动)。
 *
 * 版本:STORAGE_KEY 为 v2(多槽)。冷启动时若只有历史 v1(单槽 {model,effort})数据,惰性迁移
 * 进缓存(下次 set 落盘到 v2),不破坏老用户的「来源 lastModel」连续性。
 */

import { useSyncExternalStore } from 'react';

import type { AgentKind } from '@/hooks/useAgentCapabilities';
import type { Effort } from '@/lib/userPreferences.types';

const STORAGE_KEY = 'xdt:providerModelMemory:v2';
/** 历史单槽版本 key —— 冷启动迁移源(只读,不再写)。 */
const LEGACY_STORAGE_KEY_V1 = 'xdt:providerModelMemory:v1';

/**
 * 单个来源槽:记该来源「上次选中的模型」+「每个模型各自的 effort / fast」。
 * lastModel 可为空(只记过 effort/fast 没法确定 lastModel 的脏数据);
 * effortByModel / fastByModel 至少一边非空才保留。fast 与 effort 同维度(per agent/provider/model),
 * 让「选回某来源下的某模型」能恢复它上次的 fast(对齐 effort 的恢复行为)。
 */
interface ProviderMemory {
  lastModel: string;
  effortByModel: Record<string, Effort>;
  fastByModel: Record<string, boolean>;
}

/** getProviderModelChoice 的返回形状(该来源上次的 model + 其 effort)。供 resolveSourceSwitch 消费。 */
export interface ProviderModelChoice {
  model: string;
  effort: Effort;
}

function keyOf(agent: AgentKind, providerId: string): string {
  return `${agent}:${providerId}`;
}

/**
 * 严格校验 v2:每个槽收敛成 { lastModel, effortByModel },其中 effortByModel 只保留
 * model / effort 都是非空 string 的条目;effortByModel 为空的槽整条丢弃(无可恢复信息)。
 * 老版本 / 手改 localStorage 损坏时静默回退空表(不抛)。
 */
function sanitize(raw: unknown): Record<string, ProviderMemory> {
  if (!raw || typeof raw !== 'object') return {};
  const out: Record<string, ProviderMemory> = {};
  for (const [k, v] of Object.entries(raw as Record<string, unknown>)) {
    if (!k || !v || typeof v !== 'object') continue;
    const rec = v as { lastModel?: unknown; effortByModel?: unknown; fastByModel?: unknown };
    const effortByModel: Record<string, Effort> = {};
    if (rec.effortByModel && typeof rec.effortByModel === 'object' && !Array.isArray(rec.effortByModel)) {
      for (const [mid, eff] of Object.entries(rec.effortByModel as Record<string, unknown>)) {
        if (mid && typeof eff === 'string' && eff.length > 0) effortByModel[mid] = eff as Effort;
      }
    }
    const fastByModel: Record<string, boolean> = {};
    if (rec.fastByModel && typeof rec.fastByModel === 'object' && !Array.isArray(rec.fastByModel)) {
      for (const [mid, fb] of Object.entries(rec.fastByModel as Record<string, unknown>)) {
        if (mid && typeof fb === 'boolean') fastByModel[mid] = fb;
      }
    }
    if (Object.keys(effortByModel).length === 0 && Object.keys(fastByModel).length === 0) continue;
    out[k] = { lastModel: typeof rec.lastModel === 'string' ? rec.lastModel : '', effortByModel, fastByModel };
  }
  return out;
}

/** 迁移历史 v1 单槽({model,effort})→ v2 多槽({lastModel:model, effortByModel:{model:effort}})。 */
function migrateV1(raw: unknown): Record<string, ProviderMemory> {
  if (!raw || typeof raw !== 'object') return {};
  const out: Record<string, ProviderMemory> = {};
  for (const [k, v] of Object.entries(raw as Record<string, unknown>)) {
    if (!k || !v || typeof v !== 'object') continue;
    const model = (v as { model?: unknown }).model;
    const effort = (v as { effort?: unknown }).effort;
    if (typeof model === 'string' && model.length > 0 && typeof effort === 'string' && effort.length > 0) {
      out[k] = { lastModel: model, effortByModel: { [model]: effort as Effort }, fastByModel: {} };
    }
  }
  return out;
}

// 进程内缓存(惰性加载)。读多写少,避免每次读都 parse localStorage。
let cache: Record<string, ProviderMemory> | null = null;

function load(): Record<string, ProviderMemory> {
  if (cache) return cache;
  if (typeof window === 'undefined') {
    cache = {};
    return cache;
  }
  try {
    const rawV2 = window.localStorage.getItem(STORAGE_KEY);
    if (rawV2) {
      cache = sanitize(JSON.parse(rawV2));
      return cache;
    }
    // 无 v2 → 尝试从历史 v1 迁移(只灌缓存,下次 set 再落盘 v2)。
    const rawV1 = window.localStorage.getItem(LEGACY_STORAGE_KEY_V1);
    cache = rawV1 ? migrateV1(JSON.parse(rawV1)) : {};
  } catch {
    cache = {};
  }
  return cache;
}

// 变更通知:device-link 被控端要把 providerModelMemory 镜像给 main(草稿列表行的真实读源),
// 控制端的镜像 / ModelSelector 也据此重渲染。persist 是唯一写路径(set* 同值短路后才到这里),
// 故在此统一 bump version + emit。
const listeners = new Set<() => void>();
let version = 0;
function emit(): void {
  version++;
  for (const l of listeners) l();
}
function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}
function getVersion(): number {
  return version;
}
/** React hook —— 订阅 providerModelMemory 变更版本号(useSyncExternalStore)。 */
export function useProviderModelMemoryVersion(): number {
  return useSyncExternalStore(subscribe, getVersion, getVersion);
}
/** 订阅 providerModelMemory 变更(非 React,如 App.tsx 把快照镜像给 main)。 */
export function subscribeProviderModelMemory(listener: () => void): () => void {
  return subscribe(listener);
}

function persist(map: Record<string, ProviderMemory>): void {
  cache = map;
  emit();
  if (typeof window === 'undefined') return;
  try {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(map));
  } catch {
    // localStorage 满 / 私密窗口禁写 —— 忽略,不影响内存缓存。
  }
}

/**
 * 读某 (agent, 来源) 上次选中的 (model, effort);无记录 / 无法确定 lastModel 返回 undefined。
 * 用于切来源时决定落到哪个模型 + 哪一档(resolveSourceSwitch)。
 */
export function getProviderModelChoice(
  agent: AgentKind,
  providerId: string,
): ProviderModelChoice | undefined {
  if (!providerId) return undefined;
  const rec = load()[keyOf(agent, providerId)];
  if (!rec || !rec.lastModel) return undefined;
  const effort = rec.effortByModel[rec.lastModel];
  return effort ? { model: rec.lastModel, effort } : undefined;
}

/**
 * 读某 (agent, 来源, 模型) 精确记下的 effort;无记录返回 undefined。
 * 用于选回某来源下的某模型时恢复它上次的 effort(ChatInput effort 解析),不受同来源其它模型干扰。
 */
export function getProviderModelEffort(
  agent: AgentKind,
  providerId: string,
  model: string,
): Effort | undefined {
  if (!providerId || !model) return undefined;
  return load()[keyOf(agent, providerId)]?.effortByModel[model];
}

/**
 * 写某 (agent, 来源) 下用户选定的 (model, effort):更新该来源 lastModel,并记下该模型的 effort
 * (不覆盖同来源其它模型的 effort)。同值短路,避免无意义落盘。
 */
export function setProviderModelChoice(
  agent: AgentKind,
  providerId: string,
  model: string,
  effort: Effort,
): void {
  if (!providerId || !model || !effort) return;
  const map = load();
  const k = keyOf(agent, providerId);
  const prev = map[k];
  if (prev && prev.lastModel === model && prev.effortByModel[model] === effort) return;
  const effortByModel = { ...(prev?.effortByModel ?? {}), [model]: effort };
  // 保留同槽已记的 fastByModel(effort 写入不应清掉 fast 记忆)。
  persist({ ...map, [k]: { lastModel: model, effortByModel, fastByModel: prev?.fastByModel ?? {} } });
}

/**
 * 读某 (agent, 来源, 模型) 精确记下的 fast(无记录返回 undefined)。与 getProviderModelEffort 同维度,
 * 用于选回某来源下的某模型时恢复它上次的 fast。
 */
export function getProviderModelFast(
  agent: AgentKind,
  providerId: string,
  model: string,
): boolean | undefined {
  if (!providerId || !model) return undefined;
  return load()[keyOf(agent, providerId)]?.fastByModel?.[model];
}

/**
 * 写某 (agent, 来源, 模型) 的 fast(不覆盖同来源其它模型的 fast / effort / lastModel)。同值短路。
 */
export function setProviderModelFast(
  agent: AgentKind,
  providerId: string,
  model: string,
  enabled: boolean,
): void {
  if (!providerId || !model) return;
  const map = load();
  const k = keyOf(agent, providerId);
  const prev = map[k];
  if (prev && prev.fastByModel?.[model] === enabled) return;
  const fastByModel = { ...(prev?.fastByModel ?? {}), [model]: enabled };
  persist({
    ...map,
    [k]: { lastModel: prev?.lastModel ?? '', effortByModel: prev?.effortByModel ?? {}, fastByModel },
  });
}

/**
 * 快照当前全部槽的 (effortByModel, fastByModel)(丢弃 lastModel),供「从草稿创建会话」时把
 * 草稿当前状态整体种进 sessionModelMemory(copy-on-create)。深拷贝:调用方拿到的快照不随
 * 后续草稿改动变化,种进去的会话记忆也不会反向牵动草稿。返回形状与 sessionModelMemory.seedSession
 * 的入参对齐(结构化,故意不互相 import,保持两个 store 解耦)。
 */
export function snapshotForSeed(): Record<
  string,
  { effortByModel: Record<string, Effort>; fastByModel: Record<string, boolean> }
> {
  const out: Record<
    string,
    { effortByModel: Record<string, Effort>; fastByModel: Record<string, boolean> }
  > = {};
  for (const [k, slot] of Object.entries(load())) {
    out[k] = {
      effortByModel: { ...slot.effortByModel },
      fastByModel: { ...slot.fastByModel },
    };
  }
  return out;
}

/** 测试用 —— 重置缓存 + 清 localStorage(其它代码不应调用)。 */
export function __resetForTest(): void {
  cache = null;
  if (typeof window !== 'undefined') {
    try {
      window.localStorage.removeItem(STORAGE_KEY);
      window.localStorage.removeItem(LEGACY_STORAGE_KEY_V1);
    } catch {
      // ignore
    }
  }
}

export const __STORAGE_KEY = STORAGE_KEY;
export const __LEGACY_STORAGE_KEY_V1 = LEGACY_STORAGE_KEY_V1;
