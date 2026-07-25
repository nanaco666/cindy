/**
 * CompanionHost — Electron 侧控制层，负责管理 Cindy Computer Use.app 的
 * 安装、启动、心跳与停止。
 *
 * 架构定位（Task 2B，二期计划）：
 *   Electron main 是薄客户端；TCC 身份、daemon 归责、权限传感器全部在
 *   companion bundle（com.xd.cindy.computer-use）内。CompanionHost 只做：
 *     1. ensureInstalled()  — 指纹对比 + 原子替换 + dev 时先触发构建脚本
 *     2. start()            — 检测已运行 → 重用；否则 `open -na` 启动 + 握手等待
 *     3. 运行期            — ping/pong 心跳、daemon-status 事件
 *     4. stop()            — 发 shutdown → 等待退出(3s) → 兜底 kill(pid)
 *
 * 平台闸：非 darwin 时所有方法均 no-op 或返回 not-supported 错误，不抛异常。
 *
 * 控制 socket 协议（NDJSON，UTF-8，每行一个 JSON，协议版本 2）：
 *   companion→host:
 *     {"type":"hello","protocolVersion":2,"companionFingerprint":"<fp>","pid":N}
 *     {"type":"daemon-status","running":bool,"pid":N|null,"restarts":N}
 *     {"type":"pong","id":N}
 *     {"type":"guide-attached","systemX":N,"systemY":N,"systemWidth":N,"systemHeight":N,"panelX":N,"panelY":N}
 *     {"type":"guide-close-requested"}
 *     {"type":"guide-completed"}
 *     {"type":"guide-drag-began","permission":"accessibility"|"screenRecording"}
 *     {"type":"guide-drag-ended","permission":"...","operation":N}
 *     {"type":"guide-error","message":"..."}
 *     {"type":"switch-location","id":N,"status":"found"|"not-found"|"unavailable",...payload}
 *     {"type":"permission-state","accessibility":bool,"screenRecording":bool}
 *   host→companion:
 *     {"type":"ping","id":N}
 *     {"type":"shutdown"}
 *     {"type":"guide-update","state":{...ComputerPermissionGuideNativeState,appBundlePath:"..."}}
 *     {"type":"guide-dismiss"}
 *     {"type":"locate-switch","id":N}
 *     {"type":"watch-permissions","enabled":bool}
 *   未知 type 双向忽略。
 */

import net from 'node:net';
import fs from 'node:fs';
import path from 'node:path';
import { EventEmitter } from 'node:events';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

import type { Logger } from '../logger.js';
import { createLogger } from '../logger.js';

const execFileAsync = promisify(execFile);

/** companion bundle 内指纹文件的相对路径（Swift 侧写入） */
const FINGERPRINT_RELATIVE = path.join('Contents', 'Resources', '.build-fingerprint');

/** companion 在 packaged/dev resources 下的相对路径 */
const COMPANION_RESOURCE_RELATIVE = path.join(
  'tools',
  'computer-use-companion',
  'Cindy Computer Use.app',
);

/** userData 下的安装目录名 */
const COMPANION_INSTALL_DIR = 'computer-use';

/** userData 下安装稳定路径的 bundle 名称 */
const COMPANION_BUNDLE_NAME = 'Cindy Computer Use.app';

/** 控制 socket 文件名 */
const SOCKET_FILE_NAME = 'companion.sock';

/** companion 日志目录名（相对于安装目录） */
const COMPANION_LOG_DIR_NAME = 'logs';

/** 等待 socket 可连 + hello 到达的总超时 (ms) */
const START_TIMEOUT_MS = 15_000;

/** 心跳间隔 (ms) */
const PING_INTERVAL_MS = 30_000;

/** 允许的最大 pong 缺失次数（超过则判失联） */
const MAX_MISSED_PONGS = 2;

/** stop() 等待 companion 退出的超时 (ms) */
const STOP_WAIT_MS = 3_000;

/** connect 重试间隔 (ms) */
const CONNECT_RETRY_INTERVAL_MS = 200;

// ── 协议消息类型 ──────────────────────────────────────────────────────────────

/** companion 向 host 发送的 hello 消息 */
export interface CompanionHelloMessage {
  type: 'hello';
  protocolVersion: number;
  companionFingerprint: string;
  pid: number;
}

/** companion 向 host 汇报的 daemon 状态 */
export interface CompanionDaemonStatusMessage {
  type: 'daemon-status';
  running: boolean;
  pid: number | null;
  restarts: number;
}

/** companion 回应 ping 的 pong */
export interface CompanionPongMessage {
  type: 'pong';
  id: number;
}

/** companion 向 host 推送的引导面板事件（镜像旧版 helper 的 stdout 消息） */
export interface CompanionGuideAttachedMessage {
  type: 'guide-attached';
  systemX: number;
  systemY: number;
  systemWidth: number;
  systemHeight: number;
  panelX: number;
  panelY: number;
}
export interface CompanionGuideCloseRequestedMessage { type: 'guide-close-requested' }
export interface CompanionGuideCompletedMessage { type: 'guide-completed' }
export interface CompanionGuideDragBeganMessage { type: 'guide-drag-began'; permission: string }
export interface CompanionGuideDragEndedMessage { type: 'guide-drag-ended'; permission: string; operation: number }
export interface CompanionGuideErrorMessage { type: 'guide-error'; message: string }

/** companion 回应 locate-switch 请求的消息 */
export interface CompanionSwitchLocationMessage {
  type: 'switch-location';
  id: number;
  status: 'found' | 'not-found' | 'unavailable';
  x?: number;
  y?: number;
  windowWidth?: number;
  windowHeight?: number;
  value?: boolean;
}

/** companion 推送的权限状态快照 */
export interface CompanionPermissionStateMessage {
  type: 'permission-state';
  accessibility: boolean;
  screenRecording: boolean;
}

/** companion 向 host 发送的所有消息类型 */
export type CompanionIncomingMessage =
  | CompanionHelloMessage
  | CompanionDaemonStatusMessage
  | CompanionPongMessage
  | CompanionGuideAttachedMessage
  | CompanionGuideCloseRequestedMessage
  | CompanionGuideCompletedMessage
  | CompanionGuideDragBeganMessage
  | CompanionGuideDragEndedMessage
  | CompanionGuideErrorMessage
  | CompanionSwitchLocationMessage
  | CompanionPermissionStateMessage
  | { type: string; [key: string]: unknown };

/** start() 成功时返回的握手信息 */
export interface CompanionHandshake {
  /** companion 进程 PID */
  pid: number;
  /** companion 报告的协议版本 */
  protocolVersion: number;
  /** companion 构建指纹 */
  companionFingerprint: string;
  /** true 表示复用了已在运行的 companion 实例 */
  reused: boolean;
}

/**
 * 权限引导状态（发送给 companion 的 guide-update 消息中的 state 字段）。
 * appBundlePath 通过消息携带，companion 据此定位要拖入 System Settings 的 app bundle。
 */
export interface CompanionGuideState {
  accessibilityGranted: boolean;
  screenRecordingGranted: boolean;
  draggedAccessibility: boolean;
  draggedScreenRecording: boolean;
  switchTargetX?: number;
  switchTargetY?: number;
  switchWindowWidth?: number;
  switchWindowHeight?: number;
  /** companion 应用 bundle 路径（替代旧版 helper 的 argv[1]） */
  appBundlePath: string;
}

/** locateSwitch() 的返回结果 */
export type LocateSwitchResult =
  | { status: 'found'; id: number; x: number; y: number; windowWidth: number; windowHeight: number; value?: boolean }
  | { status: 'not-found'; id: number }
  | { status: 'unavailable'; id: number };

/** CompanionHost 对外暴露的事件 */
export interface CompanionHostEvents {
  /** daemon 状态更新 */
  'daemon-status': (msg: CompanionDaemonStatusMessage) => void;
  /** 心跳失联（连续 MAX_MISSED_PONGS 次 pong 无响应） */
  disconnected: () => void;
  /** 引导面板事件（原始事件对象，与旧版 helper 消息语义一致） */
  'guide-event': (msg: CompanionGuideAttachedMessage | CompanionGuideCloseRequestedMessage | CompanionGuideCompletedMessage | CompanionGuideDragBeganMessage | CompanionGuideDragEndedMessage | CompanionGuideErrorMessage) => void;
  /** companion 自身 TCC 权限状态（辅助功能 + 屏幕录制），初次 watch-permissions 或状态变化时推送 */
  'permission-state': (msg: CompanionPermissionStateMessage) => void;
}

// ── 依赖注入接口（便于测试） ───────────────────────────────────────────────────

/**
 * CompanionHost 的构造函数选项。
 *
 * 所有 I/O 依赖都可替换，核心逻辑无直接 electron import，
 * 满足仓规第 14 条「可注入依赖、不依赖 Electron 顶层」。
 */
export interface CompanionHostDeps {
  /**
   * 返回 companion 在 resources 下的源路径（packaged: process.resourcesPath；
   * dev: app.getAppPath() 内 resources 目录）。
   */
  getResourcesCompanionPath: () => string;
  /**
   * 返回 companion 应安装到的 userData 目录（userData/computer-use/），
   * 以及 socket、log 目录的基准路径。
   */
  getInstallDir: () => string;
  /** 构建脚本路径（dev 环境才实际执行） */
  getBuildScriptPath: () => string;
  /** 当前是否为 packaged 应用（true 时跳过构建脚本） */
  isPackaged: () => boolean;
  /** 当前平台（non-darwin 时 no-op） */
  platform: string;
  /** fs 操作（可替换为内存 fake） */
  fs: {
    existsSync: (p: string) => boolean;
    mkdirSync: (p: string, opts?: { recursive?: boolean }) => void;
    readFileSync: (p: string, encoding: string) => string;
    renameSync: (from: string, to: string) => void;
    rmSync: (p: string, opts?: { recursive?: boolean; force?: boolean }) => void;
    unlinkSync: (p: string) => void;
    copyFileSync: (src: string, dest: string) => void;
  };
  /** cp -R 用于整体拷贝 bundle（可替换为 fake） */
  copyBundle: (src: string, dest: string) => Promise<void>;
  /** 运行构建脚本 */
  runBuildScript: (scriptPath: string, platformKey: string) => Promise<string>;
  /** `open -na` 启动 companion（可替换为 fake） */
  openApp: (bundlePath: string, args: string[]) => Promise<void>;
  /** 尝试连接 unix socket，返回 net.Socket 或 null（连接失败时） */
  connectSocket: (sockPath: string) => Promise<net.Socket | null>;
  /** setTimeout/clearTimeout（可替换为 fake timers） */
  setTimeout: typeof globalThis.setTimeout;
  clearTimeout: typeof globalThis.clearTimeout;
  /** setInterval/clearInterval */
  setInterval: typeof globalThis.setInterval;
  clearInterval: typeof globalThis.clearInterval;
  /** logger（可替换为 fake） */
  logger: Logger;
}

/**
 * 构建「真实」依赖集（生产代码调用路径）。
 * 此函数在 bootstrap 里被调用，不直接 import electron 模块到 CompanionHost 中。
 */
export function createProductionDeps(
  getElectronPaths: () => { resourcesPath: string; userData: string; appPath: string; isPackaged: boolean },
): CompanionHostDeps {
  return {
    platform: process.platform,
    isPackaged: () => getElectronPaths().isPackaged,
    getResourcesCompanionPath: () => {
      const { resourcesPath, appPath, isPackaged } = getElectronPaths();
      if (isPackaged) {
        return path.join(resourcesPath, COMPANION_RESOURCE_RELATIVE);
      }
      // dev：从 app.getAppPath() 下 resources/ 目录定位
      return path.join(appPath, 'resources', COMPANION_RESOURCE_RELATIVE);
    },
    getInstallDir: () => {
      const { userData } = getElectronPaths();
      return path.join(userData, COMPANION_INSTALL_DIR);
    },
    getBuildScriptPath: () => {
      const { appPath } = getElectronPaths();
      return path.join(appPath, 'scripts', 'build-computer-use-companion.mjs');
    },
    fs: {
      existsSync: fs.existsSync.bind(fs),
      mkdirSync: (p, opts) => { fs.mkdirSync(p, opts); },
      readFileSync: (p, enc) => fs.readFileSync(p, enc as BufferEncoding) as string,
      renameSync: fs.renameSync.bind(fs),
      rmSync: fs.rmSync.bind(fs),
      unlinkSync: fs.unlinkSync.bind(fs),
      copyFileSync: fs.copyFileSync.bind(fs),
    },
    copyBundle: async (src, dest) => {
      await execFileAsync('cp', ['-R', src, dest]);
    },
    runBuildScript: async (scriptPath, platformKey) => {
      const { stdout } = await execFileAsync(
        'node',
        [scriptPath, `--platform-key=${platformKey}`],
        { timeout: 120_000 },
      );
      const lastLine = stdout.trim().split('\n').pop() ?? '';
      return lastLine;
    },
    openApp: async (bundlePath, args) => {
      await execFileAsync('open', ['-na', bundlePath, '--args', ...args]);
    },
    connectSocket: (sockPath) => tryConnectSocket(sockPath),
    setTimeout: globalThis.setTimeout.bind(globalThis),
    clearTimeout: globalThis.clearTimeout.bind(globalThis),
    setInterval: globalThis.setInterval.bind(globalThis),
    clearInterval: globalThis.clearInterval.bind(globalThis),
    logger: createLogger('computer-use-companion'),
  };
}

// ── CompanionHost ─────────────────────────────────────────────────────────────

/**
 * Electron main 侧对 Cindy Computer Use.app 的控制宿主。
 *
 * 生命周期：
 *   ensureInstalled() → start() → [运行期心跳 + 事件] → stop()
 *
 * 非 darwin 平台所有方法均立即返回 not-supported，不抛异常。
 */
// eslint-disable-next-line @typescript-eslint/no-unsafe-declaration-merging
export class CompanionHost extends EventEmitter {
  private readonly deps: CompanionHostDeps;
  private readonly log: Logger;

  /** 当前活跃的控制 socket 连接 */
  private socket: net.Socket | null = null;

  /** 接收缓冲区（NDJSON 行拼装） */
  private recvBuf = '';

  /** 握手时记录的 companion PID，供 stop() 兜底 kill 使用 */
  private companionPid: number | null = null;

  /** 最近一次握手结果，供 start() 幂等早返回使用 */
  private lastHandshake: { pid: number; protocolVersion: number; companionFingerprint: string } | null = null;

  /** 心跳 timer handle */
  private pingTimer: ReturnType<typeof setInterval> | null = null;

  /** 递增 ping id */
  private nextPingId = 1;

  /** 当前未响应的 pong 计数 */
  private missedPongs = 0;

  /** 是否已调用过 stop() */
  private stopped = false;

  /** locate-switch 请求的递增 ID */
  private nextLocateSwitchId = 1;

  constructor(deps?: Partial<CompanionHostDeps>) {
    super();
    // 测试时允许传入 partial deps；生产路径由 createProductionDeps 构造完整 deps
    this.deps = {
      platform: process.platform,
      isPackaged: () => false,
      getResourcesCompanionPath: () => '',
      getInstallDir: () => '',
      getBuildScriptPath: () => '',
      fs: {
        existsSync: fs.existsSync.bind(fs),
        mkdirSync: (p, opts) => { fs.mkdirSync(p, opts); },
        readFileSync: (p, enc) => fs.readFileSync(p, enc as BufferEncoding) as string,
        renameSync: fs.renameSync.bind(fs),
        rmSync: fs.rmSync.bind(fs),
        unlinkSync: fs.unlinkSync.bind(fs),
        copyFileSync: fs.copyFileSync.bind(fs),
      },
      copyBundle: async (src, dest) => { await execFileAsync('cp', ['-R', src, dest]); },
      runBuildScript: async () => '',
      openApp: async () => {},
      connectSocket: tryConnectSocket,
      setTimeout: globalThis.setTimeout.bind(globalThis),
      clearTimeout: globalThis.clearTimeout.bind(globalThis),
      setInterval: globalThis.setInterval.bind(globalThis),
      clearInterval: globalThis.clearInterval.bind(globalThis),
      logger: createLogger('computer-use-companion'),
      ...deps,
    };
    this.log = this.deps.logger;
  }

  // ── 公开 API ──────────────────────────────────────────────────────────────

  /**
   * 确保 companion bundle 已安装到 userData 稳定路径。
   *
   * 策略：
   *   - dev 环境先执行构建脚本（幂等、指纹缓存，源码不变秒回）
   *   - 对比 resources 产物与已安装版本的 `.build-fingerprint`
   *   - 不一致或未安装时原子替换（临时目录 → rename）
   *   - 替换会导致 ad-hoc 签名 cdhash 变化，TCC 需重新授权——记 info 日志说明
   *
   * 非 darwin 返回 not-supported 结构，不抛。
   */
  async ensureInstalled(): Promise<{ ok: true } | { ok: false; reason: string }> {
    if (this.deps.platform !== 'darwin') {
      return { ok: false, reason: 'not-supported: non-darwin platform' };
    }
    const resourcesBundle = this.deps.getResourcesCompanionPath();
    const installDir = this.deps.getInstallDir();
    const installBundle = path.join(installDir, COMPANION_BUNDLE_NAME);

    // dev：先确保构建脚本已产出最新产物
    if (!this.deps.isPackaged()) {
      const scriptPath = this.deps.getBuildScriptPath();
      // 构建脚本只接受 darwin-arm64 / darwin-x64，用宿主 arch 派生正确 key（P1-1 修复）
      const platformKey = `darwin-${process.arch === 'arm64' ? 'arm64' : 'x64'}`;
      this.log.debug('running companion build script (dev)', { scriptPath, platformKey });
      try {
        const outPath = await this.deps.runBuildScript(scriptPath, platformKey);
        this.log.debug('companion build script succeeded', { outPath });
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        this.log.warn('companion build script failed; will try existing resources bundle', { error: msg });
        // 不中止：可能 resources 下已有旧产物可用
      }
    }

    // 读取 resources 产物指纹
    if (!this.deps.fs.existsSync(resourcesBundle)) {
      const reason = `companion bundle not found in resources: ${resourcesBundle}`;
      this.log.warn(reason);
      return { ok: false, reason };
    }
    const resourcesFingerprint = this.readBundleFingerprint(resourcesBundle);

    // 检查已安装版本指纹
    if (this.deps.fs.existsSync(installBundle)) {
      const installedFingerprint = this.readBundleFingerprint(installBundle);
      if (installedFingerprint && installedFingerprint === resourcesFingerprint) {
        this.log.debug('companion already installed and up-to-date', { fingerprint: installedFingerprint });
        return { ok: true };
      }
      this.log.info(
        'companion fingerprint mismatch — will replace installed bundle; ' +
        'if the companion was ad-hoc signed, TCC grants for com.xd.cindy.computer-use ' +
        'may need to be re-granted after replacement (cdhash change)',
        { installed: installedFingerprint ?? '(missing)', resources: resourcesFingerprint ?? '(missing)' },
      );
    } else {
      this.log.info('companion not yet installed; installing', { target: installBundle });
    }

    // 原子替换：先拷到临时名再 rename
    this.deps.fs.mkdirSync(installDir, { recursive: true });
    const tmpBundle = `${installBundle}.tmp-${Date.now()}`;
    try {
      await this.deps.copyBundle(resourcesBundle, tmpBundle);
      // 清理旧安装（rename 在不同目录需先删目标）
      if (this.deps.fs.existsSync(installBundle)) {
        this.deps.fs.rmSync(installBundle, { recursive: true, force: true });
      }
      this.deps.fs.renameSync(tmpBundle, installBundle);
      this.log.info('companion installed successfully', { path: installBundle });
      return { ok: true };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      // 清理临时目录残留
      try { this.deps.fs.rmSync(tmpBundle, { recursive: true, force: true }); } catch { /* ignore */ }
      this.log.error('companion installation failed', { error: msg });
      return { ok: false, reason: `install failed: ${msg}` };
    }
  }

  /**
   * 启动 companion（或复用已运行实例）并完成握手。
   *
   * 流程：
   *   1. ensureInstalled()
   *   2. 尝试连接 socket → 已通则复用（读 hello）
   *   3. 否则：删 stale socket、`open -na` 启动、带超时等待 socket 可连 + hello
   *   4. 启动心跳
   *
   * 非 darwin 返回 not-supported 错误，不抛。
   */
  async start(): Promise<
    { ok: true; handshake: CompanionHandshake } | { ok: false; reason: string }
  > {
    if (this.deps.platform !== 'darwin') {
      return { ok: false, reason: 'not-supported: non-darwin platform' };
    }

    // companion server 是单客户端设计（listen backlog 1，串行 accept 循环），
    // 重复拨号会落入内核 backlog、收不到 hello、5 秒超时后误判进程异常并重启。
    // socket 仍活跃且 PID 已知时直接复用，跳过新连接。
    if (this.socket && !this.socket.destroyed && this.companionPid != null && this.lastHandshake) {
      return {
        ok: true,
        handshake: { ...this.lastHandshake, reused: true },
      };
    }

    const installDir = this.deps.getInstallDir();
    const installBundle = path.join(installDir, COMPANION_BUNDLE_NAME);
    const sockPath = path.join(installDir, SOCKET_FILE_NAME);
    const logDir = path.join(installDir, COMPANION_LOG_DIR_NAME);

    // Step 1: 确保安装
    const installResult = await this.ensureInstalled();
    if (!installResult.ok) {
      return { ok: false, reason: `ensureInstalled failed: ${installResult.reason}` };
    }

    // Step 2: 尝试复用已运行实例
    const existingSocket = await this.deps.connectSocket(sockPath);
    if (existingSocket) {
      this.log.info('companion socket already reachable; checking fingerprint before reuse');
      const helloResult = await this.waitForHello(existingSocket, 5_000);
      if (helloResult.ok) {
        // P1-3：比对 hello 报告的指纹与已安装 bundle 的 .build-fingerprint
        // dev 改源码 → 重建 → ensureInstalled 原子替换了安装目录后，旧进程 hello
        // 会带旧指纹；不一致时发 shutdown 让旧实例退出，再走正常启动路径。
        const installedFingerprint = this.readBundleFingerprint(installBundle);
        if (installedFingerprint && helloResult.hello.companionFingerprint !== installedFingerprint) {
          this.log.info(
            'companion fingerprint mismatch — running instance is stale; sending shutdown and restarting',
            {
              running: helloResult.hello.companionFingerprint,
              installed: installedFingerprint,
            },
          );
          // 发 shutdown，等 socket 关闭（兜底 SIGTERM by hello.pid）
          try { existingSocket.write(`${JSON.stringify({ type: 'shutdown' })}\n`); } catch { /* ignore */ }
          const closed = await waitForSocketClose(existingSocket, STOP_WAIT_MS);
          if (!closed) {
            try { process.kill(helloResult.hello.pid, 'SIGTERM'); } catch { /* ignore */ }
          }
          if (!existingSocket.destroyed) existingSocket.destroy();
          // 清理 stale socket 文件，继续走 Step 3 启动新实例
        } else {
          // 指纹一致（或无法读取已安装指纹），安全复用
          this.attachSocket(existingSocket, helloResult.remainingBuf);
          this.startHeartbeat();
          this.lastHandshake = { ...helloResult.hello };
          return {
            ok: true,
            handshake: { ...helloResult.hello, reused: true },
          };
        }
      } else {
        existingSocket.destroy();
        this.log.warn('existing companion socket connected but hello not received; will restart');
      }
    }

    // Step 3: 清理 stale socket 文件、启动新实例
    if (this.deps.fs.existsSync(sockPath)) {
      try { this.deps.fs.unlinkSync(sockPath); } catch { /* ignore */ }
    }
    this.deps.fs.mkdirSync(logDir, { recursive: true });

    this.log.info('launching companion', { bundle: installBundle, sockPath, logDir });
    try {
      await this.deps.openApp(installBundle, [
        '--control-socket', sockPath,
        '--log-dir', logDir,
      ]);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      this.log.error('failed to open companion app', { error: msg });
      return { ok: false, reason: `open failed: ${msg}` };
    }

    // Step 4: 带超时轮询 socket 可连 + 等待 hello
    const deadline = Date.now() + START_TIMEOUT_MS;
    let socket: net.Socket | null = null;
    while (Date.now() < deadline) {
      socket = await this.deps.connectSocket(sockPath);
      if (socket) break;
      await sleep(CONNECT_RETRY_INTERVAL_MS);
    }
    if (!socket) {
      const reason = `companion socket not reachable after ${START_TIMEOUT_MS}ms`;
      this.log.error(reason, { sockPath });
      return { ok: false, reason };
    }

    const remaining = deadline - Date.now();
    const helloResult = await this.waitForHello(socket, Math.max(remaining, 1_000));
    if (!helloResult.ok) {
      socket.destroy();
      return { ok: false, reason: helloResult.reason };
    }

    // P1-2：把 hello 后的剩余缓冲 seed 给 attachSocket，避免同 chunk 的 daemon-status 丢失
    this.attachSocket(socket, helloResult.remainingBuf);
    this.startHeartbeat();
    this.lastHandshake = { ...helloResult.hello };
    this.log.info('companion started and handshake complete', {
      pid: helloResult.hello.pid,
      protocolVersion: helloResult.hello.protocolVersion,
      companionFingerprint: helloResult.hello.companionFingerprint,
    });
    return {
      ok: true,
      handshake: { ...helloResult.hello, reused: false },
    };
  }

  /**
   * 停止 companion：发 shutdown → 等待 socket 关闭（3s）→ 兜底 kill(pid)。
   * 非 darwin 或未启动时 no-op。
   */
  async stop(): Promise<void> {
    if (this.deps.platform !== 'darwin') return;
    if (this.stopped) return;
    this.stopped = true;

    this.stopHeartbeat();

    const socket = this.socket;
    const pid = this.companionPid;
    this.socket = null;
    this.companionPid = null;

    if (socket && !socket.destroyed) {
      // 发送 shutdown 指令
      try {
        socket.write(`${JSON.stringify({ type: 'shutdown' })}\n`);
      } catch {
        // socket 可能已半关闭
      }

      // 等待 socket 关闭（companion 退出时会关闭连接）
      const closed = await waitForSocketClose(socket, STOP_WAIT_MS);
      if (!closed) {
        this.log.warn('companion did not close socket after shutdown; attempting kill by pid', { pid });
      }
      if (!socket.destroyed) socket.destroy();
    }

    // 兜底：通过 pid kill
    if (pid != null) {
      try {
        process.kill(pid, 'SIGTERM');
        this.log.debug('sent SIGTERM to companion', { pid });
      } catch (err) {
        // 进程可能已退出——忽略 ESRCH
        const code = (err as NodeJS.ErrnoException).code;
        if (code !== 'ESRCH') {
          this.log.warn('failed to SIGTERM companion', { pid, code });
        }
      }
    }
  }

  // ── 引导面板 API（协议版本 2 新增）───────────────────────────────────────────

  /**
   * 显示权限引导面板（发送首次 guide-update）。
   * 若 companion 未启动则先尝试 start()；失败时返回结构化错误，不抛。
   */
  async showGuide(state: CompanionGuideState): Promise<{ ok: true } | { ok: false; error: string }> {
    const conn = await this.ensureConnected();
    if (!conn.ok) return { ok: false, error: conn.error };
    return this.sendGuideUpdate(state);
  }

  /**
   * 更新引导面板状态（发送后续 guide-update）。
   * 若 companion 未连接则先尝试 start()；失败时返回结构化错误，不抛。
   */
  async updateGuide(state: CompanionGuideState): Promise<{ ok: true } | { ok: false; error: string }> {
    const conn = await this.ensureConnected();
    if (!conn.ok) return { ok: false, error: conn.error };
    return this.sendGuideUpdate(state);
  }

  /**
   * 关闭引导面板（发送 guide-dismiss）。
   * companion 保持存活（daemon supervisor 继续运行）。
   * 若未连接则静默返回（面板本就不存在）。
   */
  async dismissGuide(): Promise<void> {
    if (!this.socket || this.socket.destroyed) return;
    try {
      this.socket.write(`${JSON.stringify({ type: 'guide-dismiss' })}\n`);
    } catch {
      // socket 已半关闭，忽略
    }
  }

  /**
   * 启用或停止 companion 权限状态监控（watch-permissions 消息）。
   * 启用时立即收到一次 'permission-state' 事件（初始快照），之后仅在状态变化时推送。
   * 若未连接则先尝试 start()；失败时返回结构化错误，不抛。
   */
  async watchPermissions(enabled: boolean): Promise<{ ok: true } | { ok: false; error: string }> {
    const conn = await this.ensureConnected();
    if (!conn.ok) return { ok: false, error: conn.error };
    try {
      this.socket!.write(`${JSON.stringify({ type: 'watch-permissions', enabled })}\n`);
      return { ok: true };
    } catch (err) {
      const error = err instanceof Error ? err.message : String(err);
      return { ok: false, error };
    }
  }

  /**
   * 请求 companion 使用 AX 接口定位 System Settings 中的 "Cindy Computer Use" 开关行。
   *
   * 返回 Promise（resolve-only，不 reject）：
   *   - { status: 'found', ... }    — 找到，含中心坐标及当前开关值
   *   - { status: 'not-found', ... } — System Settings 未开启 or 行不存在
   *   - { status: 'unavailable', ... } — companion 缺少辅助功能权限，或 8 秒超时
   *
   * 若未连接则先尝试 start()；失败时返回 status:'unavailable'。
   */
  async locateSwitch(): Promise<LocateSwitchResult> {
    const conn = await this.ensureConnected();
    if (!conn.ok) {
      return { status: 'unavailable', id: 0 };
    }

    const id = this.nextLocateSwitchId++;
    const LOCATE_TIMEOUT_MS = 8_000;

    return new Promise<LocateSwitchResult>((resolve) => {
      let settled = false;

      const timer = this.deps.setTimeout(() => {
        if (settled) return;
        settled = true;
        this.removeListener('switch-location', onResponse);
        resolve({ status: 'unavailable', id });
      }, LOCATE_TIMEOUT_MS);

      const onResponse = (msg: CompanionSwitchLocationMessage) => {
        if (msg.id !== id) return;
        if (settled) return;
        settled = true;
        this.deps.clearTimeout(timer);
        this.removeListener('switch-location', onResponse);
        if (msg.status === 'found') {
          resolve({
            status: 'found',
            id: msg.id,
            x: msg.x ?? 0,
            y: msg.y ?? 0,
            windowWidth: msg.windowWidth ?? 0,
            windowHeight: msg.windowHeight ?? 0,
            value: msg.value,
          });
        } else if (msg.status === 'not-found') {
          resolve({ status: 'not-found', id: msg.id });
        } else {
          resolve({ status: 'unavailable', id: msg.id });
        }
      };

      // 使用内部事件 switch-location 接收响应
      this.on('switch-location', onResponse);

      try {
        this.socket!.write(`${JSON.stringify({ type: 'locate-switch', id })}\n`);
      } catch {
        if (!settled) {
          settled = true;
          this.deps.clearTimeout(timer);
          this.removeListener('switch-location', onResponse);
          resolve({ status: 'unavailable', id });
        }
      }
    });
  }

  // ── 内部方法 ──────────────────────────────────────────────────────────────

  /**
   * 确保 companion socket 已连接（若未连接则调用 start()）。
   * 返回结构化结果，不抛异常。
   */
  private async ensureConnected(): Promise<{ ok: true } | { ok: false; error: string }> {
    if (this.socket && !this.socket.destroyed && this.companionPid != null) {
      return { ok: true };
    }
    const result = await this.start();
    if (!result.ok) {
      return { ok: false, error: `companion not connected: ${result.reason}` };
    }
    return { ok: true };
  }

  /**
   * 向 companion 发送 guide-update 消息。
   */
  private sendGuideUpdate(state: CompanionGuideState): { ok: true } | { ok: false; error: string } {
    if (!this.socket || this.socket.destroyed) {
      return { ok: false, error: 'companion socket not connected' };
    }
    try {
      this.socket.write(`${JSON.stringify({ type: 'guide-update', state })}\n`);
      return { ok: true };
    } catch (err) {
      const error = err instanceof Error ? err.message : String(err);
      return { ok: false, error };
    }
  }

  /**
   * 读取 bundle 内 .build-fingerprint 文件内容（不存在时返回 null）。
   */
  private readBundleFingerprint(bundlePath: string): string | null {
    const fpFile = path.join(bundlePath, FINGERPRINT_RELATIVE);
    if (!this.deps.fs.existsSync(fpFile)) return null;
    try {
      return this.deps.fs.readFileSync(fpFile, 'utf8').trim();
    } catch {
      return null;
    }
  }

  /**
   * 将 socket 绑定到实例，注册数据接收与错误处理。
   *
   * @param initialBuf - waitForHello 消费 hello 行后剩余的未处理缓冲数据（P1-2 修复）。
   *   seed 进 recvBuf 并立即跑一遍行解析，确保 hello 之后同一 chunk 的 daemon-status 不丢失。
   */
  private attachSocket(socket: net.Socket, initialBuf = ''): void {
    this.socket = socket;
    // seed 剩余 buffer，稍后在 flush 步骤统一处理
    this.recvBuf = initialBuf;

    socket.setEncoding('utf8');

    // 立即处理 initialBuf 里可能已有完整行（如紧跟 hello 的 daemon-status 快照）
    if (this.recvBuf) {
      let nl = this.recvBuf.indexOf('\n');
      while (nl >= 0) {
        const line = this.recvBuf.slice(0, nl).trim();
        this.recvBuf = this.recvBuf.slice(nl + 1);
        if (line) this.handleLine(line);
        nl = this.recvBuf.indexOf('\n');
      }
    }

    socket.on('data', (chunk: string) => {
      this.recvBuf += chunk;
      let nl = this.recvBuf.indexOf('\n');
      while (nl >= 0) {
        const line = this.recvBuf.slice(0, nl).trim();
        this.recvBuf = this.recvBuf.slice(nl + 1);
        if (line) this.handleLine(line);
        nl = this.recvBuf.indexOf('\n');
      }
    });

    socket.on('error', (err) => {
      this.log.warn('companion socket error', { error: err.message });
    });

    socket.on('close', () => {
      if (this.socket === socket) {
        this.log.info('companion socket closed');
        this.socket = null;
        this.stopHeartbeat();
      }
    });
  }

  /**
   * 处理来自 companion 的单行 NDJSON 消息（运行期，握手后调用）。
   */
  private handleLine(line: string): void {
    let msg: CompanionIncomingMessage;
    try {
      msg = JSON.parse(line) as CompanionIncomingMessage;
    } catch {
      this.log.debug('companion sent invalid JSON; ignoring', { line });
      return;
    }

    if (msg.type === 'pong') {
      const pong = msg as CompanionPongMessage;
      this.log.debug('companion pong', { id: pong.id });
      this.missedPongs = 0;
      return;
    }

    if (msg.type === 'daemon-status') {
      const status = msg as CompanionDaemonStatusMessage;
      this.log.debug('companion daemon-status', {
        running: status.running,
        pid: status.pid,
        restarts: status.restarts,
      });
      this.emit('daemon-status', status);
      return;
    }

    // 引导面板事件（协议版本 2 新增）
    if (
      msg.type === 'guide-attached' ||
      msg.type === 'guide-close-requested' ||
      msg.type === 'guide-completed' ||
      msg.type === 'guide-drag-began' ||
      msg.type === 'guide-drag-ended' ||
      msg.type === 'guide-error'
    ) {
      this.log.debug('companion guide event', { type: msg.type });
      this.emit('guide-event', msg as Parameters<CompanionHostEvents['guide-event']>[0]);
      return;
    }

    // switch-location 响应（由 locateSwitch() 的 Promise 消费）
    if (msg.type === 'switch-location') {
      const loc = msg as CompanionSwitchLocationMessage;
      this.log.debug('companion switch-location', { id: loc.id, status: loc.status });
      this.emit('switch-location', loc);
      return;
    }

    // 权限状态推送
    if (msg.type === 'permission-state') {
      const ps = msg as CompanionPermissionStateMessage;
      this.log.debug('companion permission-state', {
        accessibility: ps.accessibility,
        screenRecording: ps.screenRecording,
      });
      this.emit('permission-state', ps);
      return;
    }

    // 未知 type 静默忽略（协议扩展兼容）
    this.log.debug('companion sent unknown message type; ignoring', { type: msg.type });
  }

  /**
   * 启动 ping/pong 心跳（每 PING_INTERVAL_MS 发一次 ping）。
   * 连续 MAX_MISSED_PONGS 次无响应时发 'disconnected' 事件。
   */
  private startHeartbeat(): void {
    this.stopHeartbeat();
    this.missedPongs = 0;
    this.pingTimer = this.deps.setInterval(() => {
      const socket = this.socket;
      if (!socket || socket.destroyed) {
        this.stopHeartbeat();
        return;
      }
      if (this.missedPongs >= MAX_MISSED_PONGS) {
        this.log.warn('companion heartbeat timeout; emitting disconnected', {
          missedPongs: this.missedPongs,
        });
        this.stopHeartbeat();
        this.emit('disconnected');
        return;
      }
      const id = this.nextPingId++;
      try {
        socket.write(`${JSON.stringify({ type: 'ping', id })}\n`);
        this.missedPongs++;
      } catch (err) {
        this.log.warn('failed to send ping to companion', {
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }, PING_INTERVAL_MS);
  }

  /** 停止心跳 timer。 */
  private stopHeartbeat(): void {
    if (this.pingTimer != null) {
      this.deps.clearInterval(this.pingTimer);
      this.pingTimer = null;
    }
  }

  /**
   * 从已连接的 socket 读取第一条 hello 消息（带超时）。
   * 非 hello 的消息忽略，超时或 socket 关闭时返回 ok:false。
   *
   * P1-2 修复：成功时在返回值中携带 hello 行之后的剩余缓冲（remainingBuf），
   * 供 attachSocket 作为初始 buffer seed，避免同一 chunk 里紧跟 hello 的
   * daemon-status 快照被丢弃。
   */
  private waitForHello(
    socket: net.Socket,
    timeoutMs: number,
  ): Promise<
    | { ok: true; hello: Pick<CompanionHandshake, 'pid' | 'protocolVersion' | 'companionFingerprint'>; remainingBuf: string }
    | { ok: false; reason: string }
  > {
    return new Promise((resolve) => {
      let buf = '';
      let settled = false;

      const timer = this.deps.setTimeout(() => {
        if (settled) return;
        settled = true;
        cleanup();
        resolve({ ok: false, reason: `hello not received within ${timeoutMs}ms` });
      }, timeoutMs);

      const onData = (chunk: string) => {
        buf += chunk;
        let nl = buf.indexOf('\n');
        while (nl >= 0) {
          const line = buf.slice(0, nl).trim();
          // 保留 hello 行之后的所有数据（含尚未到换行符的不完整行）
          const remaining = buf.slice(nl + 1);
          buf = remaining;
          if (!line) { nl = buf.indexOf('\n'); continue; }
          let msg: unknown;
          try { msg = JSON.parse(line); } catch { nl = buf.indexOf('\n'); continue; }
          const m = msg as Record<string, unknown>;
          if (m['type'] === 'hello') {
            if (!settled) {
              settled = true;
              this.companionPid = typeof m['pid'] === 'number' ? m['pid'] : null;
              cleanup();
              // 把消费 hello 后剩余的缓冲一并返回，供 attachSocket 作为初始 seed
              resolve({
                ok: true,
                remainingBuf: buf,
                hello: {
                  pid: typeof m['pid'] === 'number' ? m['pid'] : 0,
                  protocolVersion: typeof m['protocolVersion'] === 'number' ? m['protocolVersion'] : 0,
                  companionFingerprint: typeof m['companionFingerprint'] === 'string' ? m['companionFingerprint'] : '',
                },
              });
            }
            return;
          }
          nl = buf.indexOf('\n');
        }
      };

      const onClose = () => {
        if (settled) return;
        settled = true;
        cleanup();
        resolve({ ok: false, reason: 'socket closed before hello' });
      };

      const onError = (err: Error) => {
        if (settled) return;
        settled = true;
        cleanup();
        resolve({ ok: false, reason: `socket error before hello: ${err.message}` });
      };

      const cleanup = () => {
        this.deps.clearTimeout(timer);
        socket.removeListener('data', onData);
        socket.removeListener('close', onClose);
        socket.removeListener('error', onError);
      };

      socket.setEncoding('utf8');
      socket.on('data', onData);
      socket.on('close', onClose);
      socket.on('error', onError);
    });
  }
}

// ── TypeScript EventEmitter 类型声明 ─────────────────────────────────────────

// 声明 EventEmitter 的类型重载，供外部代码使用。
// 必须与 export class 同级导出才能合法 declaration merge（Node.js 标准 EventEmitter 惯用法）。
// eslint-disable-next-line @typescript-eslint/no-unsafe-declaration-merging
export declare interface CompanionHost {
  on(event: 'daemon-status', listener: (msg: CompanionDaemonStatusMessage) => void): this;
  on(event: 'disconnected', listener: () => void): this;
  on(event: 'guide-event', listener: (msg: Parameters<CompanionHostEvents['guide-event']>[0]) => void): this;
  on(event: 'permission-state', listener: (msg: CompanionPermissionStateMessage) => void): this;
  /** 内部事件：locateSwitch() 用于监听 switch-location 响应 */
  on(event: 'switch-location', listener: (msg: CompanionSwitchLocationMessage) => void): this;
  emit(event: 'daemon-status', msg: CompanionDaemonStatusMessage): boolean;
  emit(event: 'disconnected'): boolean;
  emit(event: 'guide-event', msg: Parameters<CompanionHostEvents['guide-event']>[0]): boolean;
  emit(event: 'permission-state', msg: CompanionPermissionStateMessage): boolean;
  emit(event: 'switch-location', msg: CompanionSwitchLocationMessage): boolean;
}

// ── 工具函数 ──────────────────────────────────────────────────────────────────

/**
 * 尝试连接 unix domain socket，成功返回 net.Socket，失败（ENOENT/ECONNREFUSED 等）返回 null。
 *
 * P2 修复：connect 成功后、调用方（waitForHello/attachSocket）挂新 error listener 之前，
 * 存在一个无监听窗口——Node 里无监听的 'error' 事件会抛顶层异常炸主进程。
 * 此处先挂 noop error listener 占位，由后续 waitForHello/attachSocket 覆盖。
 */
async function tryConnectSocket(sockPath: string): Promise<net.Socket | null> {
  return new Promise((resolve) => {
    const socket = net.createConnection({ path: sockPath });
    socket.once('connect', () => {
      socket.removeAllListeners('error');
      // 临时 noop，防止调用方挂 listener 前的空窗期抛顶层异常；
      // waitForHello / attachSocket 会用真正的 error handler 覆盖它。
      socket.on('error', () => {});
      resolve(socket);
    });
    socket.once('error', () => {
      socket.destroy();
      resolve(null);
    });
  });
}

/**
 * 等待 socket 关闭（已 close 或 destroyed），超时返回 false。
 */
function waitForSocketClose(socket: net.Socket, timeoutMs: number): Promise<boolean> {
  if (socket.destroyed) return Promise.resolve(true);
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      socket.removeListener('close', onClose);
      resolve(false);
    }, timeoutMs);
    const onClose = () => {
      clearTimeout(timer);
      resolve(true);
    };
    socket.once('close', onClose);
  });
}

/**
 * sleep 工具（用于 connect 轮询）。
 */
function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// ── prewarm 入口（供 bootstrap-electron.ts 调用） ────────────────────────────

/**
 * 在 createWindow 后延迟触发 ensureInstalled()，不启动 daemon。
 * 仅在 darwin + dev 环境生效（packaged 不预热，Task 3 之前不自动 start）。
 *
 * bootstrap 调用时传入 deps factory，host 内部懒创建；
 * 仅调用 ensureInstalled()，不启动 daemon。
 */
export function prewarmComputerUseCompanion(
  depsFactory: () => CompanionHostDeps,
): void {
  if (process.platform !== 'darwin') return;
  const deps = depsFactory();
  if (deps.isPackaged()) return;
  const host = new CompanionHost(deps);
  void host.ensureInstalled().catch((err) => {
    deps.logger.warn('prewarm companion ensureInstalled failed', {
      error: err instanceof Error ? err.message : String(err),
    });
  });
}
