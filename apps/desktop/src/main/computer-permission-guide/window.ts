/**
 * Electron Computer Use 权限引导协调层（迁移后版本）。
 *
 * 架构变化（Stage B 迁移）：
 *   - 引导面板显示/更新/关闭改为走 CompanionHost.showGuide / updateGuide / dismissGuide。
 *   - 权限状态监控改为走 CompanionHost.watchPermissions + 'permission-state' 事件；
 *     事件只作为「何时刷新」的触发信号，最终真值仍以 daemon check_permissions 为准。
 *   - 开关定位改为走 CompanionHost.locateSwitch()；删除旧的 MCP stdio 探测路径。
 *   - 旧版 helper 二进制（独立 Swift 进程、stdin/stdout 协议）已整体删除。
 *
 * 保留不变：
 *   - lifecycle generation 防竞态。
 *   - 30 秒 attach 超时回退（未收到 guide-attached 则关闭引导并播报 CANCELLED）。
 *   - 对 renderer 推送 COMPUTER_PERMISSION_GUIDE_STATUS_CHANGED / _CANCELLED 的时机与 payload 结构。
 *   - PermissionDragState 持久化文件路径与格式。
 *   - Electron fallback 窗口（companion 不可用时的备用渲染层）。
 */

import fs from 'node:fs';
import path from 'node:path';
import {
  app,
  BrowserWindow,
  nativeImage,
  screen,
  shell,
} from 'electron';
import type { Rectangle, WebContents } from 'electron';

import { scheduleMainAppPresenceRestore } from '../appPresence.js';
import { createLogger } from '../logger.js';
import { MAKER_PUSH } from '../maker-ipc/channels.js';
import type { CompanionGuideState } from '../computer-use-companion/CompanionHost.js';
import type {
  CompanionGuideAttachedMessage,
  CompanionGuideCloseRequestedMessage,
  CompanionGuideCompletedMessage,
  CompanionGuideDragBeganMessage,
  CompanionGuideDragEndedMessage,
  CompanionGuideErrorMessage,
} from '../computer-use-companion/CompanionHost.js';
import {
  cancelComputerDriverPermissionGrant,
  getComputerDriverAppBundlePath,
  getComputerDriverStatus,
  getSharedCompanionHost,
  isComputerDriverPermissionProbePaused,
  resumeComputerDriverPermissionProbe,
} from '../mcp-integrations/computer.js';
import { computeComputerPermissionGuideBounds } from './placement.js';

const log = createLogger('computer-permission-guide');

// v1 was also used as evidence that the row existed. That is not safe: a
// stale record survives when the user removes CuaDriver from System Settings,
// and the old locator can then re-register the app while checking the page.
// v2 is an interaction hint only and is written after a confirmed copy drag.
const DRAG_STATE_FILE_NAME = 'cua-driver-drag-state-v2.json';

/** 引导处于开关指引阶段时 locateSwitch 低频重定位循环的间隔（ms）。 */
const SWITCH_RELOCATE_INTERVAL_MS = 2_000;

/** 拖拽后自动恢复的超时（ms）。 */
const DRAG_RESTORE_TIMEOUT_MS = 12_000;

/** companion 面板未在此时限内 guide-attached 则触发回退关闭。 */
const NATIVE_ATTACH_TIMEOUT_MS = 30_000;

const MAC_ACCESSIBILITY_SETTINGS_URL =
  'x-apple.systempreferences:com.apple.preference.security?Privacy_Accessibility';
const MAC_SCREEN_RECORDING_SETTINGS_URL =
  'x-apple.systempreferences:com.apple.preference.security?Privacy_ScreenCapture';
const GUIDE_WINDOW_WIDTH = 480;
const GUIDE_WINDOW_HEIGHT = 272;
const GUIDE_WINDOW_MARGIN = 16;

/** companion guide-event 消息的联合类型（本文件内部使用）。 */
type GuideEvent =
  | CompanionGuideAttachedMessage
  | CompanionGuideCloseRequestedMessage
  | CompanionGuideCompletedMessage
  | CompanionGuideDragBeganMessage
  | CompanionGuideDragEndedMessage
  | CompanionGuideErrorMessage;

type ComputerStatus = Awaited<ReturnType<typeof getComputerDriverStatus>>;
type PermissionKind = 'accessibility' | 'screenRecording';

// ── 模块级状态 ─────────────────────────────────────────────────────────────────

let guideWindow: BrowserWindow | null = null;
let backdropWindow: BrowserWindow | null = null;
let guideOwner: BrowserWindow | null = null;
let guideStatus: ComputerStatus | null = null;

/** 防止竞态的单调递增计数器；每次 beginGuideLifecycle 时自增。 */
let guideLifecycleGeneration = 0;

/**
 * companion 面板是否已发出 guide-attached（吸附到 System Settings）。
 * 未 attach 时 NATIVE_ATTACH_TIMEOUT_MS 到期则触发回退。
 */
let companionGuideAttached = false;

/**
 * companion showGuide 成功后置 true，完整关闭（closeComputerPermissionGuideWindow）或
 * lifecycle 重置时置 false。
 * guide-attached 后 Electron fallback 窗口已关闭，guideWindow 为 null，
 * 但 companion 面板仍活跃——hasPermissionGuide 须包含此状态，
 * 否则 isGuideLifecycleActive 在 attach 之后会恒返回 false，
 * 导致后续所有 companion 事件（guide-completed / guide-close-requested 等）被丢弃。
 */
let companionGuideActive = false;

/** 30 秒未 attach 的超时 handle。 */
let nativeAttachTimeout: ReturnType<typeof setTimeout> | null = null;

/** 当前是否处于拖拽中。 */
let dragInProgress = false;

/** 本次拖拽对应的权限类型。 */
let draggedPermission: PermissionKind | null = null;

/** 拖拽后自动恢复的 timer handle。 */
let dragRestoreTimer: ReturnType<typeof setTimeout> | null = null;

/** 内存缓存的拖拽标记文件内容。 */
let permissionDragStateCache: PermissionDragState | null = null;

/** 上次从 companion 收到的开关坐标（用于 updateGuide 回传）。 */
let lastSwitchTargetX: number | undefined;
let lastSwitchTargetY: number | undefined;
let lastSwitchWindowWidth: number | undefined;
let lastSwitchWindowHeight: number | undefined;

/** 开关重定位循环 timer handle。 */
let switchRelocateTimer: ReturnType<typeof setInterval> | null = null;

/** 上次打开的权限设置 URL（去重）。 */
let lastOpenedPermissionPaneUrl: string | null = null;

// ── 公开接口 ───────────────────────────────────────────────────────────────────

/** Per-pane lifecycle state that public macOS permission APIs do not expose. */
export interface PermissionDragState {
  accessibility: boolean;
  screenRecording: boolean;
}

// ── 持久化拖拽标记 ──────────────────────────────────────────────────────────────

function getPermissionDragStatePath(): string {
  return path.join(app.getPath('userData'), 'computer-permission-guide', DRAG_STATE_FILE_NAME);
}

/** 读取用户已对各权限面板完成 app 拖拽的标记。 */
export function readPermissionDragState(): PermissionDragState {
  if (permissionDragStateCache) return { ...permissionDragStateCache };
  try {
    const parsed = JSON.parse(
      fs.readFileSync(getPermissionDragStatePath(), 'utf8'),
    ) as Partial<PermissionDragState>;
    permissionDragStateCache = {
      accessibility: parsed.accessibility === true,
      screenRecording: parsed.screenRecording === true,
    };
  } catch {
    permissionDragStateCache = { accessibility: false, screenRecording: false };
  }
  return { ...permissionDragStateCache };
}

/** 仅供单测使用：清除内存缓存以便重新从 fs 读取（不影响生产路径）。 */
export function _resetPermissionDragStateCacheForTest(): void {
  permissionDragStateCache = null;
}

function writePermissionDragState(state: PermissionDragState): void {
  permissionDragStateCache = { ...state };
  const filePath = getPermissionDragStatePath();
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, `${JSON.stringify(state)}\n`, 'utf8');
}

function clearPermissionDragState(permission: PermissionKind): void {
  const state = readPermissionDragState();
  if (!state[permission]) return;
  state[permission] = false;
  writePermissionDragState(state);
  log.debug('已清除过期权限拖拽标记（System Settings 中找不到对应行）', { permission });
}

// ── Renderer 窗口工具 ──────────────────────────────────────────────────────────

function loadPermissionView(
  window: BrowserWindow,
  view: 'computer-permission-guide' | 'computer-permission-backdrop',
): void {
  if (MAIN_WINDOW_VITE_DEV_SERVER_URL) {
    const url = new URL(MAIN_WINDOW_VITE_DEV_SERVER_URL);
    url.searchParams.set('view', view);
    void window.loadURL(url.toString());
    return;
  }
  void window.loadFile(
    path.join(__dirname, `../renderer/${MAIN_WINDOW_VITE_NAME}/index.html`),
    { query: { view } },
  );
}

function closeWindow(window: BrowserWindow | null): void {
  if (window && !window.isDestroyed()) window.close();
}

function guideBoundsForWorkArea(workArea: Rectangle): Rectangle {
  const width = Math.min(GUIDE_WINDOW_WIDTH, workArea.width);
  const height = Math.min(GUIDE_WINDOW_HEIGHT, workArea.height);
  return {
    x: workArea.x + workArea.width - width - Math.min(GUIDE_WINDOW_MARGIN, workArea.width - width),
    y: workArea.y + workArea.height - height - Math.min(GUIDE_WINDOW_MARGIN, workArea.height - height),
    width,
    height,
  };
}

function currentDisplay(): Electron.Display {
  if (guideOwner && !guideOwner.isDestroyed()) {
    return screen.getDisplayMatching(guideOwner.getBounds());
  }
  return screen.getDisplayNearestPoint(screen.getCursorScreenPoint());
}

// ── 权限设置面板 ───────────────────────────────────────────────────────────────

export function getComputerPermissionPaneUrl(status: ComputerStatus | null): string | null {
  switch (missingPermission(status)) {
    case 'accessibility':
      return MAC_ACCESSIBILITY_SETTINGS_URL;
    case 'screenRecording':
      return MAC_SCREEN_RECORDING_SETTINGS_URL;
    default:
      return null;
  }
}

export function seedOpenedPermissionPane(url: string): void {
  if (
    url === MAC_ACCESSIBILITY_SETTINGS_URL
    || url === MAC_SCREEN_RECORDING_SETTINGS_URL
  ) {
    lastOpenedPermissionPaneUrl = url;
  }
}

export async function openComputerPermissionPaneForStatus(
  status: ComputerStatus | null,
): Promise<void> {
  if (process.platform !== 'darwin') return;
  const url = getComputerPermissionPaneUrl(status);
  if (!url || lastOpenedPermissionPaneUrl === url) return;
  lastOpenedPermissionPaneUrl = url;
  try {
    await shell.openExternal(url);
    log.debug('已打开 Computer Use 权限设置面板', { url });
  } catch (error) {
    log.warn('打开 Computer Use 权限设置面板失败', {
      url,
      error: error instanceof Error ? error.message : String(error),
    });
  }
}

function missingPermission(status: ComputerStatus | null): PermissionKind | null {
  if (status?.permissionState?.accessibility !== 'granted') return 'accessibility';
  if (
    status.permissionState.screenRecording !== 'granted'
    || status.permissionState.screenRecordingCapturable !== 'granted'
  ) {
    return 'screenRecording';
  }
  return null;
}

// ── 广播 ──────────────────────────────────────────────────────────────────────

function broadcastPermissionGuideStatus(status: ComputerStatus): void {
  guideStatus = status;
  for (const win of BrowserWindow.getAllWindows()) {
    if (!win.isDestroyed()) {
      win.webContents.send(MAKER_PUSH.COMPUTER_PERMISSION_GUIDE_STATUS_CHANGED, status);
    }
  }
}

function broadcastPermissionGuideCancelled(): void {
  for (const win of BrowserWindow.getAllWindows()) {
    if (!win.isDestroyed()) {
      win.webContents.send(MAKER_PUSH.COMPUTER_PERMISSION_GUIDE_CANCELLED);
    }
  }
}

// ── lifecycle 工具 ─────────────────────────────────────────────────────────────

function hasPermissionGuide(): boolean {
  return companionGuideActive || Boolean(guideWindow && !guideWindow.isDestroyed());
}

function isGuideLifecycleActive(generation: number): boolean {
  return generation === guideLifecycleGeneration && hasPermissionGuide();
}

function beginGuideLifecycle(): void {
  guideLifecycleGeneration += 1;
  guideStatus = null;
  companionGuideAttached = false;
  companionGuideActive = false;
  lastSwitchTargetX = undefined;
  lastSwitchTargetY = undefined;
  lastSwitchWindowWidth = undefined;
  lastSwitchWindowHeight = undefined;
}

// ── Attach 超时 ───────────────────────────────────────────────────────────────

function clearNativeAttachTimeout(): void {
  if (!nativeAttachTimeout) return;
  clearTimeout(nativeAttachTimeout);
  nativeAttachTimeout = null;
}

/**
 * 在 companion 不支持/未连接时，可能无法使用 guide 面板，此时 Electron 窗口充当 fallback。
 * Attach 超时仅在 companion guide 模式下生效（有 appBundlePath 时）。
 */
function armNativeAttachTimeout(generation: number): void {
  clearNativeAttachTimeout();
  if (!isGuideLifecycleActive(generation) || companionGuideAttached) return;
  const timeout = setTimeout(() => {
    if (nativeAttachTimeout === timeout) nativeAttachTimeout = null;
    if (!isGuideLifecycleActive(generation) || companionGuideAttached) return;
    log.warn('companion 引导面板未在规定时间内吸附到 System Settings');
    closeComputerPermissionGuideWindow();
    broadcastPermissionGuideCancelled();
  }, NATIVE_ATTACH_TIMEOUT_MS);
  nativeAttachTimeout = timeout;
}

// ── 开关定位循环 ───────────────────────────────────────────────────────────────

function stopSwitchRelocate(): void {
  if (switchRelocateTimer) clearInterval(switchRelocateTimer);
  switchRelocateTimer = null;
}

/**
 * 在引导处于开关指引阶段（draggedAccessibility 或 draggedScreenRecording 为 true）时，
 * 以低频轮询 locateSwitch，将最新坐标经 updateGuide 回传给 companion，
 * 让面板能跟随 System Settings 窗口移动后的实际开关位置。
 */
function startSwitchRelocate(generation: number): void {
  stopSwitchRelocate();
  switchRelocateTimer = setInterval(() => {
    if (!isGuideLifecycleActive(generation)) {
      stopSwitchRelocate();
      return;
    }
    const dragState = readPermissionDragState();
    const activePermission = missingPermission(guideStatus) ?? 'accessibility';
    // 仅在有确认拖拽标记时才定位，避免 System Settings 里出现 companion 行之前就探测
    if (!dragState[activePermission]) return;
    void doLocateSwitchAndUpdateGuide(generation);
  }, SWITCH_RELOCATE_INTERVAL_MS);
}

async function doLocateSwitchAndUpdateGuide(generation: number): Promise<void> {
  const host = getSharedCompanionHost();
  if (!host || !isGuideLifecycleActive(generation)) return;
  const result = await host.locateSwitch();
  if (!isGuideLifecycleActive(generation)) return;
  applyLocateSwitchResult(result);
  // 无论是否找到，都把最新坐标（包括 undefined）更新给 companion
  const dragState = readPermissionDragState();
  void host.updateGuide(buildGuideState(dragState));
}

/**
 * 根据 locateSwitch 结果更新模块级坐标缓存与过期拖拽标记。
 *
 * 导出供单测直接验证逻辑，不依赖 companion host。
 */
export function applyLocateSwitchResult(
  result: { status: 'found'; x: number; y: number; windowWidth: number; windowHeight: number }
    | { status: 'not-found' }
    | { status: 'unavailable' },
): void {
  if (result.status === 'found') {
    lastSwitchTargetX = result.x;
    lastSwitchTargetY = result.y;
    lastSwitchWindowWidth = result.windowWidth;
    lastSwitchWindowHeight = result.windowHeight;
  } else if (result.status === 'not-found') {
    // AX 可用但行确实不存在——持久化标记只记录历史交互，系统设置里的行才是真值；
    // 标记过期（如 TCC 被外部重置）时清除，避免 companion 永久停在 switchGuide 零 UI 状态。
    // 注：'unavailable' 代表 AX 本身不可用，无法据此判断行是否存在，不清。
    clearPermissionDragState(missingPermission(guideStatus) ?? 'accessibility');
    // 行不存在，旧坐标必然失效
    lastSwitchTargetX = undefined;
    lastSwitchTargetY = undefined;
    lastSwitchWindowWidth = undefined;
    lastSwitchWindowHeight = undefined;
  }
  // 'unavailable': AX 本身不可用，不能据此判断行是否存在，保留标记与坐标不变
}

// ── CompanionGuideState 构建 ───────────────────────────────────────────────────

function buildGuideState(dragState: PermissionDragState): CompanionGuideState {
  const permissionState = guideStatus?.permissionState;
  return {
    accessibilityGranted: permissionState?.accessibility === 'granted',
    screenRecordingGranted: permissionState?.screenRecording === 'granted'
      && permissionState.screenRecordingCapturable !== 'missing',
    draggedAccessibility: dragState.accessibility,
    draggedScreenRecording: dragState.screenRecording,
    ...(lastSwitchTargetX !== undefined ? { switchTargetX: lastSwitchTargetX } : {}),
    ...(lastSwitchTargetY !== undefined ? { switchTargetY: lastSwitchTargetY } : {}),
    ...(lastSwitchWindowWidth !== undefined ? { switchWindowWidth: lastSwitchWindowWidth } : {}),
    ...(lastSwitchWindowHeight !== undefined ? { switchWindowHeight: lastSwitchWindowHeight } : {}),
    appBundlePath: getComputerDriverAppBundlePath() ?? '',
  };
}

// ── 权限探测刷新 ───────────────────────────────────────────────────────────────

/**
 * 触发一次完整的 daemon 权限探测并更新引导面板状态。
 *
 * companion 的 'permission-state' 事件只是「边沿触发器」——
 * TCC 授权归属校验（host_bundle_id 必须是 com.xd.cindy.computer-use）只有
 * daemon check_permissions 探测才能给出，所以真值必须走 getComputerDriverStatus。
 */
async function refreshPermissionStatus(
  generation: number,
  options: { bypassPermissionProbeCache?: boolean; knownStatus?: ComputerStatus } = {},
): Promise<void> {
  if (!isGuideLifecycleActive(generation)) return;

  let status = options.knownStatus;
  if (!status) {
    if (isComputerDriverPermissionProbePaused()) {
      // 探测暂停期间仅更新 companion 面板展示（不调 daemon），等 drag 结束再探测
      const dragState = readPermissionDragState();
      const activePermission = missingPermission(guideStatus) ?? 'accessibility';
      if (!dragState[activePermission]) {
        const host = getSharedCompanionHost();
        void host?.updateGuide(buildGuideState(dragState));
        return;
      }
      // 探测暂停但已有确认拖拽标记时，执行一次 locateSwitch 检测行是否已出现
      await doLocateSwitchAndUpdateGuide(generation);
      if (!isGuideLifecycleActive(generation)) return;
    }

    status = await getComputerDriverStatus({
      forcePermissionProbe: true,
      ...(options.bypassPermissionProbeCache
        ? { bypassPermissionProbeCache: true }
        : {}),
    });
  }

  if (!isGuideLifecycleActive(generation)) return;

  const dragState = readPermissionDragState();
  const host = getSharedCompanionHost();
  void host?.updateGuide(buildGuideState(dragState));
  void openComputerPermissionPaneForStatus(status);
  broadcastPermissionGuideStatus(status);
}

// ── guide-event 处理 ──────────────────────────────────────────────────────────

/**
 * 处理 companion 发出的引导面板事件，语义与旧版 helper stdout 消息保持一致。
 * generation 闭包确保过期 lifecycle 的事件被静默丢弃。
 */
function handleGuideEvent(generation: number, msg: GuideEvent): void {
  if (!isGuideLifecycleActive(generation)) return;

  switch (msg.type) {
    case 'guide-attached': {
      companionGuideAttached = true;
      clearNativeAttachTimeout();
      log.info('companion 引导面板已吸附到 System Settings', {
        systemBounds: {
          x: msg.systemX,
          y: msg.systemY,
          width: msg.systemWidth,
          height: msg.systemHeight,
        },
        panelOrigin: { x: msg.panelX, y: msg.panelY },
      });
      // 面板已吸附时关闭 Electron fallback 窗口（不再需要）
      closeElectronPermissionGuideWindow();
      break;
    }
    case 'guide-close-requested': {
      cancelComputerDriverPermissionGrant();
      closeComputerPermissionGuideWindow();
      broadcastPermissionGuideCancelled();
      break;
    }
    case 'guide-completed': {
      closeComputerPermissionGuideWindow();
      break;
    }
    case 'guide-drag-began': {
      log.debug('companion 引导面板拖拽开始', { permission: msg.permission });
      break;
    }
    case 'guide-drag-ended': {
      const permission = isPermission(msg.permission) ? msg.permission : null;
      if (permission && (msg.operation & 1) !== 0) {
        const state = readPermissionDragState();
        state[permission] = true;
        writePermissionDragState(state);
        resumeComputerDriverPermissionProbe();
        log.info('拖拽完成，CuaDriver 行已出现，恢复探测', { permission });
      }
      // 拖拽结束后立即刷新状态（绕过缓存获取最新权限）
      void refreshPermissionStatus(generation, { bypassPermissionProbeCache: true });
      break;
    }
    case 'guide-error': {
      log.warn('companion 引导面板报错', { message: msg.message });
      break;
    }
  }
}

// ── permission-state 事件处理 ─────────────────────────────────────────────────

/**
 * companion 检测到 TCC 状态变化时触发一次 daemon 探测以获取权威真值。
 * 守护：「边沿触发 + daemon 探测」双重机制确保授权归属校验不会被绕过。
 */
function handlePermissionState(generation: number): void {
  if (!isGuideLifecycleActive(generation)) return;
  void refreshPermissionStatus(generation, { bypassPermissionProbeCache: true });
}

// ── 拖拽处理 ──────────────────────────────────────────────────────────────────

function restoreGuideAfterDrag(): void {
  if (dragRestoreTimer) clearTimeout(dragRestoreTimer);
  dragRestoreTimer = null;
  dragInProgress = false;
  draggedPermission = null;
  if (guideWindow && !guideWindow.isDestroyed()) {
    guideWindow.setIgnoreMouseEvents(false);
    guideWindow.setAlwaysOnTop(true, 'floating', 1);
    guideWindow.showInactive();
  }
}

function armDragRestore(): void {
  if (dragRestoreTimer) clearTimeout(dragRestoreTimer);
  dragRestoreTimer = setTimeout(() => {
    log.debug('拖拽超时，恢复 Electron 引导窗口');
    restoreGuideAfterDrag();
    void refreshPermissionStatus(guideLifecycleGeneration, { bypassPermissionProbeCache: true });
  }, DRAG_RESTORE_TIMEOUT_MS);
}

// ── Electron fallback 窗口关闭 ─────────────────────────────────────────────────

/**
 * 仅关闭 Electron fallback 窗口（backdrop + guide renderer），
 * 不关闭 companion 面板，不重置 lifecycle。
 */
function closeElectronPermissionGuideWindow(): void {
  clearNativeAttachTimeout();
  const currentGuide = guideWindow;
  const currentBackdrop = backdropWindow;
  guideWindow = null;
  backdropWindow = null;
  guideOwner = null;
  restoreGuideAfterDrag();
  closeWindow(currentGuide);
  closeWindow(currentBackdrop);
  scheduleMainAppPresenceRestore('computer-permission-guide-closed');
}

// ── 公开 API ──────────────────────────────────────────────────────────────────

/** 关闭 companion 引导面板和 Electron fallback（完整关闭流程）。 */
export function closeComputerPermissionGuideWindow(): void {
  guideLifecycleGeneration += 1;
  companionGuideAttached = false;
  companionGuideActive = false;
  lastOpenedPermissionPaneUrl = null;
  stopSwitchRelocate();
  resumeComputerDriverPermissionProbe();
  // companion 断连时 dismissGuide 会静默返回，无副作用
  const host = getSharedCompanionHost();
  void host?.dismissGuide();
  void host?.watchPermissions(false);
  closeElectronPermissionGuideWindow();
}

/** Return true only for IPC emitted by the independent guide renderer. */
export function isComputerPermissionGuideWebContents(sender: WebContents): boolean {
  return Boolean(
    guideWindow
    && !guideWindow.isDestroyed()
    && guideWindow.webContents.id === sender.id,
  );
}

/** 在 daemon 探测已检查权限状态之后，刷新 Electron 引导面板。 */
export function refreshComputerPermissionGuideWindow(status?: ComputerStatus): void {
  if (status) {
    if (!hasPermissionGuide()) {
      broadcastPermissionGuideStatus(status);
      return;
    }
    const dragState = readPermissionDragState();
    const host = getSharedCompanionHost();
    void host?.updateGuide(buildGuideState(dragState));
    broadcastPermissionGuideStatus(status);
    return;
  }
  void refreshPermissionStatus(guideLifecycleGeneration, { bypassPermissionProbeCache: true });
}

/** Start a native file drag for the real Computer Use.app bundle. */
export function startComputerPermissionAppDrag(
  sender: WebContents,
  iconDataUrl: unknown,
): void {
  if (!isComputerPermissionGuideWebContents(sender)) return;
  const appBundlePath = getComputerDriverAppBundlePath();
  if (!appBundlePath || typeof iconDataUrl !== 'string') {
    log.warn('Computer Use app 拖拽不可用', {
      hasAppBundle: Boolean(appBundlePath),
      hasIcon: typeof iconDataUrl === 'string',
    });
    return;
  }
  const icon = nativeImage.createFromDataURL(iconDataUrl);
  if (icon.isEmpty()) {
    log.warn('Computer Use app 拖拽图标为空');
    return;
  }

  dragInProgress = true;
  draggedPermission = missingPermission(guideStatus) ?? 'accessibility';
  guideWindow?.setIgnoreMouseEvents(true, { forward: true });
  armDragRestore();
  try {
    sender.startDrag({ file: appBundlePath, icon });
  } catch (error) {
    log.warn('Computer Use Electron app 拖拽失败', {
      error: error instanceof Error ? error.message : String(error),
    });
    restoreGuideAfterDrag();
  }
}

/** Finish the current drag, persist its step, and check for the new row once. */
export function finishComputerPermissionAppDrag(sender: WebContents): void {
  if (!isComputerPermissionGuideWebContents(sender) || !dragInProgress) return;
  const permission = draggedPermission;
  const generation = guideLifecycleGeneration;
  restoreGuideAfterDrag();
  if (permission) {
    const state = readPermissionDragState();
    state[permission] = true;
    writePermissionDragState(state);
  }
  void refreshPermissionStatus(generation, { bypassPermissionProbeCache: true });
}

/** Show (or bring back) the permission guide. */
export async function showComputerPermissionGuideWindow(
  owner: BrowserWindow | null,
  initialStatus?: ComputerStatus,
): Promise<void> {
  if (process.platform !== 'darwin') return;

  const existingGuide = hasPermissionGuide();
  if (!existingGuide) beginGuideLifecycle();
  const generation = guideLifecycleGeneration;
  guideOwner = owner && !owner.isDestroyed() ? owner : null;
  if (!existingGuide && initialStatus) guideStatus = initialStatus;

  if (existingGuide) {
    // 引导已存在，执行一次带绕过缓存的探测并返回
    await refreshPermissionStatus(generation, {
      bypassPermissionProbeCache: true,
      ...(initialStatus ? { knownStatus: initialStatus } : {}),
    });
    return;
  }

  // 创建 Electron fallback 窗口（companion 不可用时的备用渲染层）
  const display = currentDisplay();
  const guideBounds = guideBoundsForWorkArea(display.workArea);
  let fallbackRequested = false;
  let backdropLoaded = false;
  let guideLoaded = false;

  const showElectronFallback = (): void => {
    if (!fallbackRequested || !backdropLoaded || !guideLoaded) return;
    if (
      generation !== guideLifecycleGeneration
      || backdropWindow !== backdrop
      || guideWindow !== guide
    ) {
      return;
    }
    if (!backdrop.isDestroyed()) {
      backdrop.setAlwaysOnTop(true, 'floating');
      backdrop.setVisibleOnAllWorkspaces(true, {
        visibleOnFullScreen: true,
        skipTransformProcessType: true,
      });
      backdrop.showInactive();
    }
    if (!guide.isDestroyed()) {
      guide.setAlwaysOnTop(true, 'floating', 1);
      guide.setVisibleOnAllWorkspaces(true, {
        visibleOnFullScreen: true,
        skipTransformProcessType: true,
      });
      guide.showInactive();
      scheduleMainAppPresenceRestore('computer-permission-guide-shown');
    }
  };

  const backdrop = new BrowserWindow({
    ...display.workArea,
    frame: false,
    transparent: true,
    resizable: false,
    movable: false,
    minimizable: false,
    maximizable: false,
    fullscreenable: false,
    focusable: false,
    show: false,
    skipTaskbar: false,
    hiddenInMissionControl: true,
    alwaysOnTop: true,
    hasShadow: false,
    backgroundColor: '#00000000',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      backgroundThrottling: false,
      spellcheck: false,
    },
  });
  backdropWindow = backdrop;
  backdrop.setIgnoreMouseEvents(true, { forward: true });
  backdrop.webContents.once('did-finish-load', () => {
    if (
      generation !== guideLifecycleGeneration
      || backdropWindow !== backdrop
      || backdrop.isDestroyed()
    ) {
      return;
    }
    backdropLoaded = true;
    showElectronFallback();
  });
  backdrop.once('closed', () => {
    if (
      generation === guideLifecycleGeneration
      && backdropWindow === backdrop
    ) {
      backdropWindow = null;
    }
  });
  loadPermissionView(backdrop, 'computer-permission-backdrop');

  const guide = new BrowserWindow({
    ...guideBounds,
    frame: false,
    transparent: true,
    resizable: false,
    movable: true,
    minimizable: false,
    maximizable: false,
    fullscreenable: false,
    focusable: true,
    acceptFirstMouse: true,
    show: false,
    skipTaskbar: false,
    hiddenInMissionControl: true,
    alwaysOnTop: true,
    hasShadow: false,
    backgroundColor: '#00000000',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      backgroundThrottling: false,
      spellcheck: false,
    },
  });
  guideWindow = guide;
  guide.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  guide.webContents.once('did-finish-load', () => {
    if (
      !isGuideLifecycleActive(generation)
      || guideWindow !== guide
      || guide.isDestroyed()
    ) {
      return;
    }
    guideLoaded = true;
    showElectronFallback();
  });
  guide.once('closed', () => {
    if (
      generation !== guideLifecycleGeneration
      || guideWindow !== guide
    ) {
      return;
    }
    guideWindow = null;
    restoreGuideAfterDrag();
    if (backdropWindow === backdrop) {
      backdropWindow = null;
      closeWindow(backdrop);
    }
    scheduleMainAppPresenceRestore('computer-permission-guide-closed');
  });
  guide.webContents.on('render-process-gone', (_event, details) => {
    log.warn('computer permission guide renderer 意外退出', { reason: details.reason });
  });
  loadPermissionView(guide, 'computer-permission-guide');

  // 首次打开时执行预检（确保 guideStatus 在 companion 启动前已就位）
  await refreshPermissionStatus(generation, {
    bypassPermissionProbeCache: true,
    ...(initialStatus ? { knownStatus: initialStatus } : {}),
  });
  if (!isGuideLifecycleActive(generation)) return;

  const appBundlePath = getComputerDriverAppBundlePath();
  if (appBundlePath) {
    // 尝试通过 companion 显示原生引导面板
    const host = getSharedCompanionHost();
    if (host) {
      const dragState = readPermissionDragState();
      const showResult = await host.showGuide(buildGuideState(dragState));
      if (!isGuideLifecycleActive(generation)) return;

      if (showResult.ok) {
        // companion 面板已激活；isGuideLifecycleActive 须在 Electron fallback 关闭后仍返回 true
        companionGuideActive = true;
        // 启动 30s attach 超时
        armNativeAttachTimeout(generation);

        // 注册 guide-event 和 permission-state 监听（generation 闭包防竞态）
        const onGuideEvent = (msg: GuideEvent): void => {
          handleGuideEvent(generation, msg);
        };
        const onPermissionState = (): void => {
          handlePermissionState(generation);
        };
        host.on('guide-event', onGuideEvent);
        host.on('permission-state', onPermissionState);

        // 启用 companion 权限状态监控（引导期间持续监听）
        void host.watchPermissions(true);

        // 当该 lifecycle 结束时自动移除监听
        watchGenerationEnd(generation, () => {
          host.removeListener('guide-event', onGuideEvent);
          host.removeListener('permission-state', onPermissionState);
        });

        // 拖拽标记为 true 时启动开关重定位循环（不在此处立即 locate，等循环时机）
        const activePermission = missingPermission(guideStatus) ?? 'accessibility';
        if (readPermissionDragState()[activePermission]) {
          startSwitchRelocate(generation);
        }
        return;
      }
      log.warn('companion showGuide 失败，降级为 Electron fallback', { error: showResult.error });
    } else {
      log.warn('SharedCompanionHost 不可用，降级为 Electron fallback');
    }
  }

  // companion 不可用时展示 Electron fallback 窗口
  fallbackRequested = true;
  showElectronFallback();
}

// ── 工具函数 ──────────────────────────────────────────────────────────────────

function isPermission(value: unknown): value is 'accessibility' | 'screenRecording' {
  return value === 'accessibility' || value === 'screenRecording';
}

/**
 * 轻量 lifecycle 结束监听辅助：通过轮询 generation 变化，
 * 在当前 lifecycle 不再活跃时调用 callback 一次。
 * 不使用 EventEmitter 避免全局状态扩散，使用 setInterval 每 200ms 检查一次即可。
 */
function watchGenerationEnd(generation: number, callback: () => void): void {
  const timer = setInterval(() => {
    if (guideLifecycleGeneration !== generation) {
      clearInterval(timer);
      callback();
    }
  }, 200);
}
