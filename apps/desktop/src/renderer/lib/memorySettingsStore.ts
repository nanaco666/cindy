/**
 * memorySettingsStore — Maker Memory 启用状态的 renderer 端镜像。
 * ---------------------------------------------------------------------------
 * **真正的 source of truth 是 main 的 <userData>/memory-settings.json**
 * (memory-settings-store.ts), 这里 localStorage 只是 renderer 端的同步可读镜像 —
 * 让 ChatInput 启 session 时能同步 (`getMakerMemoryEnabled()`) 透传 makerMemoryEnabled,
 * 不引入 async race。
 *
 * 同步路径:
 *   - 启动时: bootstrapFromMain() 调 IPC 拉 main 真值, 写入 localStorage
 *   - toggle: MemorySection 调 IPC 后调 setMakerMemoryEnabled() 更新本地镜像
 *   - 其他改动: main 是单一写入点, renderer 不会从其它路径篡改
 *
 * 二态 (跟 MemorySection UI 的 Maker toggle 对齐):
 *   - true  : Maker Memory 启用 (写 prompt 注入 + 关闭原生 auto-memory + 暴露 lizi_memory MCP)
 *   - false : Maker Memory 关闭, 各 agent 原生 auto-memory 各自由 Claude / Codex 行控制
 *
 * **默认 false** — Maker Memory 实验阶段, 不影响现有用户行为。
 */

const STORAGE_KEY = 'memorySettings.makerEnabled';

type Subscriber = (value: boolean) => void;
const subscribers = new Set<Subscriber>();

/**
 * 同步读 — 给 hook 之外路径用 (ChatInput 启 session 时透传等)。
 * 坏数据 / localStorage 不可用 / 没存过 → 兜底 false (实验阶段默认关)。
 */
export function getMakerMemoryEnabled(): boolean {
  try {
    return localStorage.getItem(STORAGE_KEY) === 'true';
  } catch {
    return false;
  }
}

/** 同步写 — 落盘 + 通知本 tab 内所有 subscriber */
export function setMakerMemoryEnabled(next: boolean): void {
  try {
    localStorage.setItem(STORAGE_KEY, next ? 'true' : 'false');
  } catch {
    // localStorage 不可用 — 忽略, 调用方应自行处理 UI 反馈
  }
  subscribers.forEach((cb) => cb(next));
}

/** 订阅变化 — hook 用, 也可以给非 React 路径用。返回 unsubscribe。 */
export function subscribeMakerMemoryEnabled(cb: Subscriber): () => void {
  subscribers.add(cb);

  // 跨实例 storage 事件 (多窗口兜底; Electron 单窗口下几乎不触发)
  const storageHandler = (e: StorageEvent) => {
    if (e.key !== STORAGE_KEY) return;
    cb(getMakerMemoryEnabled());
  };
  window.addEventListener('storage', storageHandler);

  return () => {
    subscribers.delete(cb);
    window.removeEventListener('storage', storageHandler);
  };
}

/**
 * 启动期一次性从 main 拉真值同步到 localStorage。
 *
 * 时机: app entry (renderer/main.tsx) 在挂载 React 树之前调一次, 让 settings UI 第一次
 * 渲染时 localStorage 已经是真值; ChatInput 启 session 透传也就是真值。
 *
 * 失败兜底: IPC 错误 (preload 没就绪 / main 异常) 静默 — localStorage 留旧值, 不影响 UI 可用性。
 * 用户在 settings 里 toggle 仍能通过 IPC 写 main, 下次启动恢复正常。
 */
export async function bootstrapMemorySettingsFromMain(): Promise<void> {
  try {
    const settings = await window.electronAPI.maker.memoryGetSettings();
    const current = getMakerMemoryEnabled();
    if (current === settings.maker) return;
    setMakerMemoryEnabled(settings.maker);
  } catch {
    // preload 未就绪 / IPC 异常 — 留旧 localStorage, 用户 toggle 时仍会同步到 main
  }
}
