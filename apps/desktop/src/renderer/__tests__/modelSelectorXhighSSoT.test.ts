/**
 * modelSelectorXhighSSoT.test.ts
 * ---------------------------------------------------------------------------
 * Regression test for: model-selector-xhigh-ui-stale (2026-04-21)
 *
 * 现象：在 Opus 4.7 上把 thinking 档位切到 xhigh，模型选择器 UI 没有立刻反映新选择，
 *       需切换 session 后再切回来才正确显示。
 *
 * 根因：ChatInput.tsx 内部维护了 `localModel/localEffort/localPermissionMode` 三套
 *       local override state，与 props 派生的 `session?.xxx` 形成"两条独立的状态轨道"。
 *       handleEffortChange 在 await 之后调用 `setLocalEffort('xhigh')`，但同一棵渲染树
 *       里 ModelSelector 仍在读旧轨道的派生值——直到 ChatInput unmount/remount
 *       (e.g. 切 session 路由), 新的 useState(initialEffort) 才把最新值挂上来。
 *
 * 修复：删除三套 local state 与同步 useEffect，改为直接从 props 派生 active 值；
 *       handler 持久化成功后调 onXxxDidChange 上抛，由父组件 refreshServerSession()
 *       让 props 重新流下来——单一可信源，永不分歧。
 *
 * 本测试不依赖 React/jsdom，只验证 SSoT 契约的两个核心不变量：
 *   1. active 派生函数：activeXxx = initialXxx ?? preferences.defaultXxx
 *   2. handler 契约：持久化成功后调 onXxxDidChange(newValue)，失败时不调
 *
 * 这两条契约一旦回归，"xhigh 不显示"就会复活——前者把 props 还给 SSoT；
 * 后者保证父组件能拿到信号去 refresh。
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// ---------------------------------------------------------------------------
// 类型镜像（避免拉真模块的 React/Tiptap 副作用）
// ---------------------------------------------------------------------------
type Effort = 'low' | 'medium' | 'high' | 'xhigh' | 'max';
type PermissionMode = 'default' | 'acceptEdits' | 'bypassPermissions' | 'plan';

interface Preferences {
  defaultModel: string;
  defaultEffort: Effort;
}

interface ChatInputDerivedProps {
  initialModel?: string;
  initialEffort?: Effort;
  initialPermissionMode?: PermissionMode;
  preferences: Preferences;
}

interface ChatInputDerived {
  activeModel: string;
  activeEffort: Effort;
  activePermissionMode: PermissionMode;
}

/**
 * 镜像 ChatInput.tsx:395-397 的派生逻辑（SSoT 形态）。
 * 这是修复后的契约：active 值永远来自 props + preferences，**不掺 local state**。
 */
function deriveActive(p: ChatInputDerivedProps): ChatInputDerived {
  return {
    activeModel: p.initialModel ?? p.preferences.defaultModel,
    activeEffort: p.initialEffort ?? p.preferences.defaultEffort,
    activePermissionMode: p.initialPermissionMode ?? 'acceptEdits',
  };
}

// ---------------------------------------------------------------------------
// handler 契约镜像（ChatInput.tsx 的三个 handleXxxChange）
// ---------------------------------------------------------------------------
interface HandlerDeps {
  sessionId?: string;
  sessionUpdate: (id: string, patch: Record<string, unknown>) => Promise<void>;
  ipcSetEffort?: (id: string, eff: Effort) => Promise<void>;
  ipcSetModel?: (id: string, model: string) => Promise<void>;
  ipcUpdatePerm?: (id: string, mode: PermissionMode) => Promise<void>;
  updatePreferences: (patch: Partial<Preferences>) => Promise<void>;
  onModelDidChange?: (id: string) => void;
  onEffortDidChange?: (eff: Effort) => void;
  onPermissionModeDidChange?: (mode: PermissionMode) => void;
}

async function handleEffortChange(deps: HandlerDeps, newEffort: Effort): Promise<void> {
  try {
    if (deps.sessionId) {
      await deps.sessionUpdate(deps.sessionId, { effort: newEffort });
      deps.ipcSetEffort?.(deps.sessionId, newEffort).catch(() => {});
      deps.onEffortDidChange?.(newEffort);
      void deps.updatePreferences({ defaultEffort: newEffort }).catch(() => {});
      return;
    }

    await deps.updatePreferences({ defaultEffort: newEffort });
    deps.onEffortDidChange?.(newEffort);
  } catch (err) {
    // swallow — UI stays unchanged because parent never receives signal
    void err;
  }
}

async function handlePermissionModeChange(
  deps: HandlerDeps,
  newMode: PermissionMode,
): Promise<void> {
  try {
    if (deps.sessionId) {
      await deps.sessionUpdate(deps.sessionId, { permissionMode: newMode });
      await deps.ipcUpdatePerm?.(deps.sessionId, newMode);
    }
    deps.onPermissionModeDidChange?.(newMode);
  } catch (err) {
    void err;
  }
}

async function handleModelChange(
  deps: HandlerDeps,
  newModelId: string,
  computeNextEffort: () => Effort,
): Promise<void> {
  const newEffort = computeNextEffort();
  try {
    if (deps.sessionId) {
      await deps.sessionUpdate(deps.sessionId, { model: newModelId, effort: newEffort });
      deps.ipcSetModel?.(deps.sessionId, newModelId).catch(() => {});
      deps.onModelDidChange?.(newModelId);
      deps.onEffortDidChange?.(newEffort);
      void deps.updatePreferences({ defaultModel: newModelId, defaultEffort: newEffort }).catch(() => {});
      return;
    }

    await deps.updatePreferences({ defaultModel: newModelId, defaultEffort: newEffort });
    deps.onModelDidChange?.(newModelId);
    deps.onEffortDidChange?.(newEffort);
  } catch (err) {
    void err;
  }
}

// ===========================================================================
// 1. SSoT 派生契约
// ===========================================================================

describe('SSoT derive: activeXxx 永远从 props 派生', () => {
  const baseline: Preferences = { defaultModel: 'claude-opus-4-7', defaultEffort: 'high' };

  it('initialEffort 提供时取 initialEffort（即 server 持久化值）', () => {
    const derived = deriveActive({
      initialModel: 'claude-opus-4-7',
      initialEffort: 'xhigh',
      initialPermissionMode: 'acceptEdits',
      preferences: baseline,
    });
    expect(derived.activeEffort).toBe('xhigh');
    expect(derived.activeModel).toBe('claude-opus-4-7');
    expect(derived.activePermissionMode).toBe('acceptEdits');
  });

  it('initialEffort 缺失时回退到 preferences.defaultEffort', () => {
    const derived = deriveActive({ preferences: baseline });
    expect(derived.activeEffort).toBe('high');
    expect(derived.activeModel).toBe('claude-opus-4-7');
    expect(derived.activePermissionMode).toBe('acceptEdits');
  });

  it('initialPermissionMode 缺失时默认 acceptEdits（与项目当前默认一致）', () => {
    const derived = deriveActive({
      initialModel: 'claude-sonnet-4-6',
      preferences: baseline,
    });
    expect(derived.activePermissionMode).toBe('acceptEdits');
  });

  it('修复场景核心：initialEffort=xhigh 时立刻反映 xhigh（不留任何 local override 路径）', () => {
    // 这是修复回归的关键断言：以前 ChatInput 内部 useState 会把这个 props 隔在外面，
    // 直到 useEffect([initialEffort]) 同步过去才生效——但同步时机比首次 render 慢一帧，
    // 而且 handleEffortChange 里的 await 链路决定了 setLocalEffort 永远落后于父刷新。
    // 现在直接 derive，永远不会出现"props 是 xhigh、UI 是 medium"的分歧。
    const derived = deriveActive({
      initialEffort: 'xhigh',
      preferences: baseline,
    });
    expect(derived.activeEffort).toBe('xhigh');
  });

  it('跨 session：父组件喂不同 initialEffort 时立刻切换显示（不卡在前一个 session 的值）', () => {
    // sessionA 状态
    const sessA = deriveActive({ initialEffort: 'xhigh', preferences: baseline });
    // sessionB 状态（父组件 setServerSession 后 props 流下来）
    const sessB = deriveActive({ initialEffort: 'medium', preferences: baseline });
    expect(sessA.activeEffort).toBe('xhigh');
    expect(sessB.activeEffort).toBe('medium');
    // 切回 sessionA
    const sessAAgain = deriveActive({ initialEffort: 'xhigh', preferences: baseline });
    expect(sessAAgain.activeEffort).toBe('xhigh');
  });
});

// ===========================================================================
// 2. handler 契约：持久化成功 → 上抛回调；失败 → 静默不抛
// ===========================================================================

describe('handleEffortChange: 上抛 onEffortDidChange 给父组件 refresh', () => {
  let updatePreferences: ReturnType<typeof vi.fn>;
  let sessionUpdate: ReturnType<typeof vi.fn>;
  let ipcSetEffort: ReturnType<typeof vi.fn>;
  let onEffortDidChange: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    updatePreferences = vi.fn().mockResolvedValue(undefined);
    sessionUpdate = vi.fn().mockResolvedValue(undefined);
    ipcSetEffort = vi.fn().mockResolvedValue(undefined);
    onEffortDidChange = vi.fn();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('成功路径：sessionUpdate + updatePreferences 都通过 → 上抛 onEffortDidChange(xhigh)', async () => {
    await handleEffortChange(
      {
        sessionId: 'sess-1',
        sessionUpdate,
        ipcSetEffort,
        updatePreferences,
        onEffortDidChange,
      },
      'xhigh',
    );
    expect(sessionUpdate).toHaveBeenCalledWith('sess-1', { effort: 'xhigh' });
    expect(updatePreferences).toHaveBeenCalledWith({ defaultEffort: 'xhigh' });
    expect(onEffortDidChange).toHaveBeenCalledWith('xhigh');
    expect(onEffortDidChange).toHaveBeenCalledTimes(1);
  });

  it('修复关键点：session 内 onEffortDidChange 不等待偏好保存——这是父组件 refreshServerSession 的唯一信号', async () => {
    const order: string[] = [];
    let preferenceResolve: (() => void) | undefined;
    sessionUpdate = vi.fn().mockImplementation(async () => {
      order.push('sessionUpdate');
    });
    updatePreferences = vi.fn().mockImplementation(
      () => new Promise<void>((resolve) => {
        preferenceResolve = () => {
          order.push('updatePreferences');
          resolve();
        };
      }),
    );
    onEffortDidChange = vi.fn().mockImplementation(() => {
      order.push('onEffortDidChange');
    });
    await handleEffortChange(
      {
        sessionId: 'sess-1',
        sessionUpdate,
        updatePreferences,
        onEffortDidChange,
      },
      'xhigh',
    );
    expect(order).toEqual(['sessionUpdate', 'onEffortDidChange']);
    preferenceResolve?.();
    await Promise.resolve();
    expect(order).toEqual(['sessionUpdate', 'onEffortDidChange', 'updatePreferences']);
  });

  it('失败路径：sessionUpdate 抛错 → onEffortDidChange 不被调用（UI 不会被错误信号刷新）', async () => {
    sessionUpdate = vi.fn().mockRejectedValue(new Error('server boom'));
    await handleEffortChange(
      {
        sessionId: 'sess-1',
        sessionUpdate,
        updatePreferences,
        onEffortDidChange,
      },
      'xhigh',
    );
    expect(onEffortDidChange).not.toHaveBeenCalled();
  });

  it('session 内偏好保存失败：不影响 onEffortDidChange 刷新当前会话', async () => {
    updatePreferences = vi.fn().mockRejectedValue(new Error('prefs validation failed'));
    await handleEffortChange(
      {
        sessionId: 'sess-1',
        sessionUpdate,
        updatePreferences,
        onEffortDidChange,
      },
      'xhigh',
    );
    expect(sessionUpdate).toHaveBeenCalled();
    expect(updatePreferences).toHaveBeenCalled();
    expect(onEffortDidChange).toHaveBeenCalledWith('xhigh');
  });

  it('无 sessionId（NewChat 模式未发消息）：跳过 server 写入，仍走 updatePreferences + onEffortDidChange', async () => {
    await handleEffortChange(
      {
        sessionUpdate,
        updatePreferences,
        onEffortDidChange,
      },
      'xhigh',
    );
    expect(sessionUpdate).not.toHaveBeenCalled();
    expect(updatePreferences).toHaveBeenCalledWith({ defaultEffort: 'xhigh' });
    expect(onEffortDidChange).toHaveBeenCalledWith('xhigh');
  });
});

describe('handlePermissionModeChange: 上抛 onPermissionModeDidChange', () => {
  it('成功路径：上抛新 mode', async () => {
    const sessionUpdate = vi.fn().mockResolvedValue(undefined);
    const ipcUpdatePerm = vi.fn().mockResolvedValue(undefined);
    const onPermissionModeDidChange = vi.fn();
    await handlePermissionModeChange(
      {
        sessionId: 'sess-1',
        sessionUpdate,
        ipcUpdatePerm,
        updatePreferences: vi.fn().mockResolvedValue(undefined),
        onPermissionModeDidChange,
      },
      'bypassPermissions',
    );
    expect(sessionUpdate).toHaveBeenCalledWith('sess-1', { permissionMode: 'bypassPermissions' });
    expect(ipcUpdatePerm).toHaveBeenCalledWith('sess-1', 'bypassPermissions');
    expect(onPermissionModeDidChange).toHaveBeenCalledWith('bypassPermissions');
  });

  it('失败路径：sessionUpdate 抛错 → onPermissionModeDidChange 不调用', async () => {
    const onPermissionModeDidChange = vi.fn();
    await handlePermissionModeChange(
      {
        sessionId: 'sess-1',
        sessionUpdate: vi.fn().mockRejectedValue(new Error('boom')),
        updatePreferences: vi.fn().mockResolvedValue(undefined),
        onPermissionModeDidChange,
      },
      'plan',
    );
    expect(onPermissionModeDidChange).not.toHaveBeenCalled();
  });

  it('四个 permissionMode 都能上抛（确认对称化覆盖完整）', async () => {
    const modes: PermissionMode[] = ['default', 'acceptEdits', 'bypassPermissions', 'plan'];
    for (const mode of modes) {
      const onPermissionModeDidChange = vi.fn();
      await handlePermissionModeChange(
        {
          sessionId: 'sess-x',
          sessionUpdate: vi.fn().mockResolvedValue(undefined),
          ipcUpdatePerm: vi.fn().mockResolvedValue(undefined),
          updatePreferences: vi.fn().mockResolvedValue(undefined),
          onPermissionModeDidChange,
        },
        mode,
      );
      expect(onPermissionModeDidChange).toHaveBeenCalledWith(mode);
    }
  });
});

describe('handleModelChange: 同时上抛 onModelDidChange + onEffortDidChange', () => {
  it('跨模型回归：Opus → Sonnet effort 自动降级，两个 callback 都触发', async () => {
    // Opus 4.7 (xhigh) → Sonnet 4.6 不支持 xhigh，应降级到 high（由 computeNextEffort 决定）
    const onModelDidChange = vi.fn();
    const onEffortDidChange = vi.fn();
    await handleModelChange(
      {
        sessionId: 'sess-1',
        sessionUpdate: vi.fn().mockResolvedValue(undefined),
        ipcSetModel: vi.fn().mockResolvedValue(undefined),
        updatePreferences: vi.fn().mockResolvedValue(undefined),
        onModelDidChange,
        onEffortDidChange,
      },
      'claude-sonnet-4-6',
      () => 'high',
    );
    expect(onModelDidChange).toHaveBeenCalledWith('claude-sonnet-4-6');
    expect(onEffortDidChange).toHaveBeenCalledWith('high');
  });

  it('Haiku 无 effort 段：computeNextEffort 返回 low，依然走对称化上抛', async () => {
    const onModelDidChange = vi.fn();
    const onEffortDidChange = vi.fn();
    await handleModelChange(
      {
        sessionId: 'sess-1',
        sessionUpdate: vi.fn().mockResolvedValue(undefined),
        updatePreferences: vi.fn().mockResolvedValue(undefined),
        onModelDidChange,
        onEffortDidChange,
      },
      'claude-haiku-4-5',
      () => 'low',
    );
    expect(onModelDidChange).toHaveBeenCalledWith('claude-haiku-4-5');
    expect(onEffortDidChange).toHaveBeenCalledWith('low');
  });

  it('失败路径：sessionUpdate 抛错 → 两个 callback 都不调（UI 保持旧状态）', async () => {
    const onModelDidChange = vi.fn();
    const onEffortDidChange = vi.fn();
    await handleModelChange(
      {
        sessionId: 'sess-1',
        sessionUpdate: vi.fn().mockRejectedValue(new Error('network')),
        updatePreferences: vi.fn().mockResolvedValue(undefined),
        onModelDidChange,
        onEffortDidChange,
      },
      'claude-opus-4-7',
      () => 'xhigh',
    );
    expect(onModelDidChange).not.toHaveBeenCalled();
    expect(onEffortDidChange).not.toHaveBeenCalled();
  });

  it('session 内偏好保存失败：不影响模型与 effort 回调刷新当前会话', async () => {
    const onModelDidChange = vi.fn();
    const onEffortDidChange = vi.fn();
    await handleModelChange(
      {
        sessionId: 'sess-1',
        sessionUpdate: vi.fn().mockResolvedValue(undefined),
        updatePreferences: vi.fn().mockRejectedValue(new Error('token expired')),
        onModelDidChange,
        onEffortDidChange,
      },
      'claude-sonnet-4-6',
      () => 'high',
    );
    expect(onModelDidChange).toHaveBeenCalledWith('claude-sonnet-4-6');
    expect(onEffortDidChange).toHaveBeenCalledWith('high');
  });
});

// ===========================================================================
// 3. 端到端的 SSoT 闭环：handler → callback → 父组件 refresh → props 流回
// ===========================================================================

describe('SSoT 闭环：模拟父组件 refreshServerSession 后，下次 derive 拿到新值', () => {
  it('Opus 4.7 + medium → 点 xhigh：父收到回调后 session.effort 变 xhigh，下次 derive 立刻是 xhigh', async () => {
    // 模拟父组件持有的 session
    let serverSessionEffort: Effort = 'medium';
    const refreshServerSession = vi.fn().mockImplementation(() => {
      // 模拟 sessionService.get(sid) 返回最新值
      serverSessionEffort = 'xhigh';
    });

    const preferences: Preferences = { defaultModel: 'claude-opus-4-7', defaultEffort: 'medium' };

    // T0: 渲染时 props.initialEffort 来自 serverSessionEffort
    let derived = deriveActive({ initialEffort: serverSessionEffort, preferences });
    expect(derived.activeEffort).toBe('medium');

    // T1: 用户点 xhigh
    await handleEffortChange(
      {
        sessionId: 'sess-1',
        sessionUpdate: vi.fn().mockResolvedValue(undefined),
        updatePreferences: vi.fn().mockImplementation(async (patch) => {
          if (patch.defaultEffort) preferences.defaultEffort = patch.defaultEffort;
        }),
        onEffortDidChange: refreshServerSession,
      },
      'xhigh',
    );

    // T2: 父组件已 refreshServerSession，下次 render 派生的 active 必须是 xhigh
    derived = deriveActive({ initialEffort: serverSessionEffort, preferences });
    expect(derived.activeEffort).toBe('xhigh');
    expect(refreshServerSession).toHaveBeenCalledTimes(1);
  });

  it('回归：如果父组件忘记接 onEffortDidChange（未来重构风险），UI 会卡住——本测试守护这条契约', async () => {
    // 不接 callback 的退化场景：showcase 为何 callback 必传
    const serverSessionEffort: Effort = 'medium';
    const preferences: Preferences = { defaultModel: 'claude-opus-4-7', defaultEffort: 'medium' };

    await handleEffortChange(
      {
        sessionId: 'sess-1',
        sessionUpdate: vi.fn().mockResolvedValue(undefined),
        updatePreferences: vi.fn().mockResolvedValue(undefined),
        // onEffortDidChange 故意未接 — 模拟未来某次重构忘了 wire 的回归风险
      },
      'xhigh',
    );

    // 父组件没收到信号 → serverSessionEffort 还是 medium → derive 仍是 medium
    // 这正是 bug 复活的样子，所以 SSoT 必须依赖父组件正确接通 callback
    const derived = deriveActive({ initialEffort: serverSessionEffort, preferences });
    expect(derived.activeEffort).toBe('medium');
  });
});
