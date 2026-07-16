/**
 * windowBehavior — 窗口交互行为相关的 IPC 通道 & 常量。
 *
 * 目前只承载一个开关:后台窗口首次左键点击是否吞掉。
 *
 * Windows 上此开关由 renderer 层的 `swallowActivationClick.ts` 用 localStorage
 * 同步读取,toggle 即时生效。macOS 上因为等效能力(`acceptFirstMouse: false`)
 * 是 Electron BrowserWindow 的构造参数、只在窗口创建时读一次,renderer 更新
 * 后需要主进程 persist 到 userData,下次启动才生效——所以 renderer 每次改动
 * 都会通过下面这个 channel 通知 main 落盘,而 main 在创建主窗口时会读回。
 */

export const WINDOW_BEHAVIOR_SET_SWALLOW_ACTIVATION_CLICK_CHANNEL =
  'window-behavior:set-swallow-activation-click';
