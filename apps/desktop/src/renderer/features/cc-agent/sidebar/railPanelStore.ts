/**
 * railPanelStore — 折叠 rail 二级面板的跨组件状态桥。
 * ---------------------------------------------------------------------------
 * 为什么要一个 store:rail 瓷砖(CollapsedView/RailNav,折叠态可见)与面板内容
 * (RailPanels,由 **ExpandedView** 渲染)不在同一子树 —— 面板行要复用展开态的
 * 全套会话操作(archive 两步确认 / 右键菜单 / 重命名 / 移动 / schedule 操作),
 * 这些 handler 全部长在 ExpandedView 内部且深度耦合其状态;两视图常驻挂载
 * (opacity 互换),portal 面板不受隐藏 wrapper 影响,因此让 ExpandedView 渲染
 * 面板即可**零复制**继承全部行为,永不与展开态漂移。
 *
 * 本 store 只承载「开哪个面板 + 锚点 + 120ms hover 桥接计时」这一点点状态,
 * useSyncExternalStore 消费;快照对象引用稳定,只在变更时整体替换。
 */

export type RailPanelSection = 'projects' | 'dialogues';

export interface RailPanelAnchor {
  right: number;
  top: number;
}

export interface RailPanelState {
  openSection: RailPanelSection | null;
  anchor: RailPanelAnchor | null;
  openProjectKey: string | null;
  projectAnchor: RailPanelAnchor | null;
}

/** hover 桥接:指针离开瓷砖/面板后的收回宽限(与 peek 抽屉同量级)。 */
export const RAIL_PANEL_CLOSE_GRACE_MS = 120;

const CLOSED: RailPanelState = {
  openSection: null,
  anchor: null,
  openProjectKey: null,
  projectAnchor: null,
};

let state: RailPanelState = CLOSED;
const listeners = new Set<() => void>();
let closeTimer: ReturnType<typeof setTimeout> | null = null;
let projectCloseTimer: ReturnType<typeof setTimeout> | null = null;

function emit(next: RailPanelState): void {
  state = next;
  for (const listener of listeners) listener();
}

function clearCloseTimer(): void {
  if (closeTimer) { clearTimeout(closeTimer); closeTimer = null; }
}
function clearProjectCloseTimer(): void {
  if (projectCloseTimer) { clearTimeout(projectCloseTimer); projectCloseTimer = null; }
}

export const railPanelStore = {
  subscribe(listener: () => void): () => void {
    listeners.add(listener);
    return () => listeners.delete(listener);
  },
  getSnapshot(): RailPanelState {
    return state;
  },

  /** 打开(或切换)一级面板;同时收起可能开着的项目二级。 */
  openSection(section: RailPanelSection, anchor: RailPanelAnchor): void {
    clearCloseTimer();
    clearProjectCloseTimer();
    emit({ openSection: section, anchor, openProjectKey: null, projectAnchor: null });
  },
  /** 项目一级面板内 hover 具体项目 → 打开二级。 */
  openProject(projectKey: string, anchor: RailPanelAnchor): void {
    clearCloseTimer();
    clearProjectCloseTimer();
    if (state.openSection !== 'projects') return;
    emit({ ...state, openProjectKey: projectKey, projectAnchor: anchor });
  },

  cancelClose(): void {
    clearCloseTimer();
  },
  scheduleClose(): void {
    clearCloseTimer();
    closeTimer = setTimeout(() => { closeTimer = null; railPanelStore.closeAll(); }, RAIL_PANEL_CLOSE_GRACE_MS);
  },
  cancelProjectClose(): void {
    clearProjectCloseTimer();
  },
  scheduleProjectClose(): void {
    clearProjectCloseTimer();
    projectCloseTimer = setTimeout(() => {
      projectCloseTimer = null;
      if (state.openProjectKey) emit({ ...state, openProjectKey: null, projectAnchor: null });
    }, RAIL_PANEL_CLOSE_GRACE_MS);
  },

  closeAll(): void {
    clearCloseTimer();
    clearProjectCloseTimer();
    if (state !== CLOSED) emit(CLOSED);
  },
};
