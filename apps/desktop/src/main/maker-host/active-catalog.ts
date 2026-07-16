/**
 * active-catalog —— 进程级「当前生效目录」单例(纯状态 holder,零 Electron 依赖)。
 *
 * 设计(用户敲定):OSS 上的 `providers.json` 是运行时真源,启动时(splash 阶段)由
 * `ensureActiveCatalogLoaded`(见 createDesktopProviderService.ts)拉取一次、存进这里、
 * **无 TTL**;内置 `BUNDLED_CATALOG` 仅作「尚未加载完成 / 拉取失败」时的兜底。
 *
 * **自定义供应商**:用户在本机配置的 user provider(见 custom-provider-store)经
 * `buildUserProvider` 展开成标准 `Provider` 后由 `setCustomProviders` 注入,**追加在内置之后**。
 * `getActiveCatalog()` 返回 base + custom 的合并结果——下游(路由 / 选择器 / listProviders)
 * 不区分内置 / 自定义,统一消费。custom 追加在后:`deriveAvailableModels` first-wins 去重
 * 保证与内置同名 id 时内置元数据胜出,不冲突。
 *
 * 所有消费方统一读 `getActiveCatalog()`,而非各自 import `BUNDLED_CATALOG`:
 *   - maker availableModels 派生(maker-host/index.ts)
 *   - 统一路由器(provider-route.ts)
 *   - 会话标题模型(title-one-shot.ts)
 *   - 供应商注册表(provider-service.ts,经 createDesktopProviderService 注入)
 *
 * 「启动 await 一次、之后全同步读」是关键:`getActiveCatalog()` 同步返回,消费方(含路由
 * 热路径)零额外 async / 零额外网络往返。合并结果惰性缓存(base / custom 变更时失效,
 * 下次读时重算),热路径零额外分配。本模块刻意**不依赖 Electron**——electron net/fs 落地在
 * createDesktopProviderService.ts,这样依赖本 holder 的纯逻辑模块(及其单测)不被 electron 污染。
 */

import { BUNDLED_CATALOG, type AgentKind, type Catalog, type CatalogModel, type Provider } from '@lizi/model-providers';

import { CHATGPT_MODEL_PREFIX } from '../../shared/subscriptionModels.js';

/** OSS / bundled 加载来的基础目录;null = 尚未加载(回落 BUNDLED_CATALOG)。 */
let base: Catalog | null = null;
/** 用户自定义供应商(已 buildUserProvider 展开的标准 Provider),追加在 base 之后。 */
let custom: Provider[] = [];
/**
 * codex cache 派生的规范化模型快照(原始 slug,不带 chatgpt/ 前缀)。先 augment 到
 * openai.codex,再从生效后的 codex 列表投影 openai.claude-code bridge,确保两边名称和排序同源。
 * **additions-only**:静态 id first-wins,cache 只补未来新增模型,不会覆盖目录的受控能力元数据。
 */
let discoveredCodex: CatalogModel[] = [];
/**
 * 通用 OAuth 供应商（auth.oauth 描述符）的动态发现模型:providerId → per-agent 增量。
 * 语义同 discoveredCodex:**additions-only**,只补目录里没有的新 id,静态条目 first-wins,
 * 空/坏数据绝不抹掉静态兜底。由 generic-oauth 的 models 发现流程写入。
 */
const discoveredByProvider = new Map<string, Partial<Record<AgentKind, CatalogModel[]>>>();
/** base + custom + discovered augment 的合并缓存;null = 待重算(惰性)。 */
let merged: Catalog | null = null;

/** additions-only:静态同 id first-wins；Codex 投影可显式要求按 sortOrder 稳定重排。 */
function augmentModels(
  p: Provider,
  agent: AgentKind,
  additions: CatalogModel[],
  sortByOrder = false,
): Provider {
  const existing = p.models[agent] ?? [];
  const existingIds = new Set(existing.map((m) => m.id));
  const fresh = additions.filter((m) => !existingIds.has(m.id));
  if (fresh.length === 0) return p;
  const combined = [...existing, ...fresh];
  const models = sortByOrder
    ? combined
        .map((model, index) => ({ model, index }))
        .sort(
          (a, b) =>
            (a.model.sortOrder ?? Number.MAX_SAFE_INTEGER) -
              (b.model.sortOrder ?? Number.MAX_SAFE_INTEGER) ||
            a.index - b.index,
        )
        .map(({ model }) => model)
    : combined;
  return { ...p, models: { ...p.models, [agent]: models } };
}

/** Codex 规范模型 → Claude bridge 路由模型；显示元数据保持一致，只改路由 id。 */
function toChatgptBridgeModel(model: CatalogModel): CatalogModel {
  return { ...model, id: `${CHATGPT_MODEL_PREFIX}${model.id}` };
}

/**
 * 以生效 Codex 列表校正 bridge 的展示名称 / 排序，同时保留 bridge 自己的 context、effort、
 * defaultEnabled 等 runtime 能力。这样旧远端目录里曾固化的本地化后缀也不会继续泄漏。
 */
function projectCodexModelsToClaude(p: Provider): Provider {
  const codex = p.models.codex ?? [];
  const canonical = new Map(codex.map((model) => [model.id, model]));
  const existing = p.models['claude-code'] ?? [];
  let aligned = false;
  const alignedExisting = existing.map((model) => {
    if (!model.id.startsWith(CHATGPT_MODEL_PREFIX)) return model;
    const source = canonical.get(model.id.slice(CHATGPT_MODEL_PREFIX.length));
    if (!source || (model.name === source.name && model.sortOrder === source.sortOrder)) return model;
    aligned = true;
    return { ...model, name: source.name, sortOrder: source.sortOrder };
  });
  const withAligned = aligned
    ? { ...p, models: { ...p.models, 'claude-code': alignedExisting } }
    : p;
  return augmentModels(withAligned, 'claude-code', codex.map(toChatgptBridgeModel), true);
}

function computeMerged(): Catalog {
  const b = base ?? BUNDLED_CATALOG;
  let providers = b.providers;

  // 同一份规范快照先进入 Codex,再从「静态 first-wins 后的生效 Codex 列表」投影 bridge。
  // 即使 cache 不可用,静态 Codex 新模型也会自动出现在 Claude tab,不会再维护两份名单。
  const withCodexProjection = providers.map((p) => {
    if (p.id !== 'openai') return p;
    const withDiscovered = augmentModels(p, 'codex', discoveredCodex, true);
    return projectCodexModelsToClaude(withDiscovered);
  });
  if (withCodexProjection.some((p, index) => p !== providers[index])) {
    providers = withCodexProjection;
  }

  // 自定义供应商先追加、再做通用发现 augment——顺序反了的话,自定义 OAuth 供应商
  // 的发现模型永远合不进目录(map 只扫过内置列表)。
  if (custom.length > 0) providers = [...providers, ...custom];

  // 通用 OAuth 供应商的发现模型(additions-only,per provider × agent;内置与自定义同待遇)。
  if (discoveredByProvider.size > 0) {
    providers = providers.map((p) => {
      const byAgent = discoveredByProvider.get(p.id);
      if (!byAgent) return p;
      let next = p;
      for (const [agent, additions] of Object.entries(byAgent) as [AgentKind, CatalogModel[]][]) {
        if (additions.length > 0) next = augmentModels(next, agent, additions);
      }
      return next;
    });
  }
  if (providers === b.providers) return b; // 无 augment、无 custom → 原样返回
  return { ...b, providers }; // spread 保留 presets 等目录顶层字段
}

/**
 * 同步返回当前生效目录(base + 自定义供应商)。未加载完成 → base 回落 `BUNDLED_CATALOG`
 * (安全兜底,绝不抛)。消费方(路由 / 标题 / 能力派生 / 注册表)统一走这里。
 */
export function getActiveCatalog(): Catalog {
  if (!merged) merged = computeMerged();
  return merged;
}

/** 由 host 的目录加载器(ensureActiveCatalogLoaded)在拉取成功后写入基础目录。 */
export function setActiveCatalog(catalog: Catalog): void {
  base = catalog;
  merged = null;
}

/**
 * 注入 / 刷新用户自定义供应商(CRUD 后、或换账号 DB 重开后调用)。
 * 传入的是已 `buildUserProvider` 展开的标准 `Provider[]`(**不含 API key**)。
 */
export function setCustomProviders(providers: Provider[]): void {
  custom = [...providers];
  merged = null;
}

/**
 * 注入 codex cache 派生的规范化模型快照。由 ensureActiveCatalogLoaded 在目录加载后调用。
 * 传空数组 = 有效空快照(回到静态兜底);读取失败时调用方不应调用本 setter,以保留现值。
 */
export function setDiscoveredCodexModels(models: CatalogModel[]): void {
  discoveredCodex = [...models];
  merged = null;
}

/**
 * 注入通用 OAuth 供应商的发现模型(per provider × agent)。additions-only 合并见
 * computeMerged;传空数组 = 清空该 provider×agent 的 discovery(回纯静态)。
 */
export function setDiscoveredProviderModels(
  providerId: string,
  agent: AgentKind,
  models: CatalogModel[],
): void {
  const byAgent = discoveredByProvider.get(providerId) ?? {};
  byAgent[agent] = [...models];
  discoveredByProvider.set(providerId, byAgent);
  merged = null;
}
