/**
 * newMakerDefaultsCache —— renderer "New Maker" 面板用户当前选择的 main 端缓存。
 *
 * Source of truth 仍是 renderer 的 newMakerDraft (localStorage); renderer 启动
 * 时全量 push 一次, 此后每次 draft 变化都增量 push, main 端只是一份内存镜像。
 *
 * 用途: collab mode spawn worker 时 (enableOrcaInternal / orca-bridge.create_worker)
 * 不再用 hardcode 默认值, 也不再继承 Lead session DB row, 改读这份缓存 ——
 * worker 实际启动参数 = "用户在 New Maker 面板里该 vendor 当前的选择"。
 *
 * Vendor 名称差异: renderer 用 'cc' / 'codex' / 'orca'; worker spawn 路径用
 * 'claude-code' / 'codex'。getWorkerDefaultsFromNewMaker 内部做映射。
 */
type VendorKey = 'cc' | 'codex';

interface VendorPrefsSnapshot {
  model?: string;
  effort?: string;
  /**
   * 该 vendor 当前草稿的权限档 / 来源(供应商)。device-link 远程草稿镜像需要(全量
   * 镜像被控端当前草稿);collab worker spawn 不消费这两项(worker 权限固定、来源走默认)。
   * 老版本 renderer 不推这两项 → undefined,消费方按自己的兜底处理。
   */
  permissionMode?: string;
  providerId?: string | null;
}

export interface NewMakerDraftSnapshot {
  lastByVendor: Partial<Record<VendorKey, VendorPrefsSnapshot>>;
  fastModeByModel: Record<string, boolean>;
  effortByModel: Record<string, string>;
}

let cache: NewMakerDraftSnapshot | null = null;

/**
 * providerModelMemory 全量快照镜像(renderer 经 SYNC_PROVIDER_MODEL_MEMORY 推)。
 * 形状 = providerModelMemory.snapshotForSeed():`${agent}:${providerId}` → {effortByModel, fastByModel}。
 * device-link 草稿列表行的真实读源(非选中行),控制端据此完整镜像被控端草稿模型列表。
 */
export type ProviderModelMemorySnapshot = Record<
  string,
  { effortByModel: Record<string, string>; fastByModel: Record<string, boolean> }
>;
let providerMemoryCache: ProviderModelMemorySnapshot | null = null;

/** Renderer push handler 调; 整体替换缓存 (而不是合并), 跟 source of truth 对齐。 */
export function setNewMakerDraftCache(snapshot: NewMakerDraftSnapshot): void {
  cache = snapshot;
}

/** Renderer push handler 调; 整体替换 providerModelMemory 镜像。 */
export function setProviderModelMemoryCache(snapshot: ProviderModelMemorySnapshot): void {
  providerMemoryCache = snapshot;
}

export interface WorkerDefaultsFromNewMaker {
  model?: string;
  effort?: string;
  fastMode?: boolean;
}

/**
 * 根据 worker agent kind 取该 vendor 在 New Maker 面板里的当前选择。
 * 缓存未就绪 / 该 vendor 没有偏好 → 返回空对象, 调用方按自己的兜底规则处理。
 */
export function getWorkerDefaultsFromNewMaker(
  workerAgent: 'claude-code' | 'codex',
): WorkerDefaultsFromNewMaker {
  if (!cache) return {};
  const vendor: VendorKey = workerAgent === 'claude-code' ? 'cc' : 'codex';
  const prefs = cache.lastByVendor[vendor];
  if (!prefs?.model) return {};
  const model = prefs.model;
  // effortByModel 是跨 vendor 的"按模型记忆", 优先用; 没有就退回 vendor prefs 上次记录的 effort。
  const effort = cache.effortByModel[model] ?? prefs.effort;
  // fastModeByModel 缺省按 false 兜底 (用户没显式开过就是关)。
  const fastMode = cache.fastModeByModel[model] === true;
  return { model, effort, fastMode };
}

/**
 * device-link 远程草稿镜像用:取某 vendor 在 New Maker 草稿里的**当前完整选择**
 * (model/effort/fast/permission/source)+ **整张 per-model 记忆表**。与
 * getWorkerDefaultsFromNewMaker 的区别:
 *   - 多回 permissionMode + providerId(全量镜像)。
 *   - effort 取「当前激活档」—— 被控端 trigger 显示的就是 lastByVendor.effort,故优先它,
 *     缺省再退 effortByModel(切换记忆);worker 那条因语义不同优先 effortByModel,这里不一样。
 *   - 多回 effortByModel + fastModeByModel(整表):控制端在远程草稿里**切到列表里其它模型**时,
 *     按目标模型查这两张表还原被控端为该模型记的 effort/fast,而非沿用上一个模型 / capabilities 默认。
 *     两表跨 vendor 共享、按 model id 区分,控制端只会用自己 capabilities 里存在的 model id 去查,
 *     故整表透传无需按 vendor 过滤。
 * 缓存未就绪 / 该 vendor 没草稿 model → 返回空对象,控制端按 capabilities 默认兜底。
 */
export interface RemoteNewMakerDefaults {
  model?: string;
  effort?: string;
  fastMode?: boolean;
  permissionMode?: string;
  providerId?: string | null;
  /** 每个模型各自记忆的 effort / fast(切模型还原用)。旧版被控端不回 → 控制端拿到 undefined。 */
  effortByModel?: Record<string, string>;
  fastModeByModel?: Record<string, boolean>;
  /**
   * providerModelMemory 全量快照(`${agent}:${providerId}` → {effortByModel, fastByModel})。
   * device-link 草稿列表行(非选中模型)的真实权威读源:控制端据此 1:1 镜像被控端草稿里**每个供应商
   * 每个模型**的 effort/fast(req1 完整列表镜像)。跨 agent 共享(key 带 agent 前缀),控制端按
   * `${agent}:` 前缀过滤。旧版被控端不回 → undefined → 控制端非选中行回落 capabilities 默认。
   */
  providerModelMemory?: Record<
    string,
    { effortByModel: Record<string, string>; fastByModel: Record<string, boolean> }
  >;
}

export function getRemoteNewMakerDefaults(
  agentKind: 'claude-code' | 'codex',
): RemoteNewMakerDefaults {
  // providerModelMemory(草稿列表行真实读源)与「该 vendor 是否选过模型」无关:即便 cache 未就绪 /
  // 该 vendor 无选中模型(lastByVendor 空),只要被控端有 per-(provider,model) 记忆就要全量回给控制端,
  // 否则 req1「完整镜像被控端草稿模型列表」在这条边界上回落 capabilities 默认。故在所有早返回里都带上它。
  const providerModelMemory = providerMemoryCache ?? undefined;
  if (!cache) return providerModelMemory ? { providerModelMemory } : {};
  const vendor: VendorKey = agentKind === 'claude-code' ? 'cc' : 'codex';
  const prefs = cache.lastByVendor[vendor];
  if (!prefs?.model) return providerModelMemory ? { providerModelMemory } : {};
  const model = prefs.model;
  return {
    model,
    effort: prefs.effort ?? cache.effortByModel[model],
    fastMode: cache.fastModeByModel[model] === true,
    permissionMode: prefs.permissionMode,
    providerId: prefs.providerId ?? null,
    effortByModel: cache.effortByModel,
    fastModeByModel: cache.fastModeByModel,
    providerModelMemory,
  };
}
