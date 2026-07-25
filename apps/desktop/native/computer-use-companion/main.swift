// main.swift — Cindy Computer Use.app 入口
//
// 职责:
//   1. 以 LaunchServices 身份(com.xd.cindy.computer-use)spawn 内嵌 cua-driver daemon,
//      令 daemon 的 TCC 辅助功能与屏幕录制权限归因到本 bundle。
//   2. 在 --control-socket 路径上 listen unix socket(NDJSON),提供与 Electron 主进程
//      的控制协议(协议版本 2):
//        companion→host: hello / daemon-status / pong / guide-attached / guide-close-requested /
//                        guide-completed / guide-drag-began / guide-drag-ended / guide-error /
//                        switch-location / permission-state
//        host→companion: ping / shutdown / guide-update / guide-dismiss /
//                        locate-switch / watch-permissions
//   3. 带退避的 daemon 重启监督:60 秒窗口内最多 3 次;超限后停止重试并上报状态。
//   4. 收到 shutdown 或 SIGTERM:先 SIGTERM daemon、2 秒兜底 SIGKILL,清 socket、退出 0。
//   5. 无 --control-socket 参数时也可独立运行(仅监督 daemon),方便调试。
//   6. 权限引导面板:响应 guide-update/guide-dismiss,将旧版独立 helper 的 NSPanel 逻辑
//      内聚到本 companion,避免独立子进程的 TCC 归责问题。
//
// 启动方式(由 Electron 侧负责):
//   open -na "Cindy Computer Use.app" --args --control-socket <sock路径> --log-dir <目录>
//
// 协议消息格式见文件末尾的 MARK: - Protocol Types。

import AppKit
import ApplicationServices
import Foundation

// MARK: - 全局常量

/// 内嵌 daemon 可执行文件相对于本 bundle 的路径
private let kEngineRelPath = "Contents/Resources/engine/cua-driver"

/// daemon 退避重启:时间窗口(秒)
private let kRestartWindowSeconds: TimeInterval = 60

/// daemon 退避重启:窗口内最多重启次数
private let kMaxRestartsInWindow = 3

/// shutdown 时先 SIGTERM,等待超时后 SIGKILL(秒)
private let kShutdownGracePeriodSeconds: TimeInterval = 2

/// System Settings 的 bundle identifier
private let kSystemSettingsBundleId = "com.apple.systempreferences"

/// 引导面板尺寸(与旧版 helper 保持一致)
private let kHostSize = NSSize(width: 500, height: 226)
private let kCardFrame = NSRect(x: 68, y: 12, width: 432, height: 152)
private let kSwitchGuideSize = NSSize(width: 196, height: 44)
private let kSettingsOverlap: CGFloat = 68
private let kSwitchTargetGap: CGFloat = 28
private let kTrackingInterval: TimeInterval = 0.16

/// 权限轮询间隔(秒);spec 要求约 900ms
private let kPermissionPollInterval: TimeInterval = 0.9

/// locate-switch 请求超时(秒),在 CompanionHost.ts 侧设 8s,Swift 侧不主动超时,由 host 侧控制
private let kLocateSwitchTimeout: TimeInterval = 5.0

// MARK: - 全局日志

/// 日志文件句柄;nil 表示未打开(无 --log-dir 时不落盘)
private var gCompanionLogHandle: FileHandle?

/// 时间戳格式器(companion 进程生命周期内复用)
private let gLogDateFormatter: DateFormatter = {
    let f = DateFormatter()
    f.dateFormat = "yyyy-MM-dd HH:mm:ss.SSS"
    return f
}()

/// 将一行日志写入 companion.log;同时输出到 stderr 便于调试
private func log(_ msg: String) {
    let ts = gLogDateFormatter.string(from: Date())
    let line = "[\(ts)] [companion] \(msg)\n"
    if let data = line.data(using: .utf8) {
        if let fh = gCompanionLogHandle {
            fh.write(data)
        }
        fputs(line, stderr)
    }
}

/// 初始化日志目录与文件
private func setupLogDirectory(at logDir: String) {
    let fm = FileManager.default
    try? fm.createDirectory(atPath: logDir, withIntermediateDirectories: true)
    let path = (logDir as NSString).appendingPathComponent("companion.log")
    if !fm.fileExists(atPath: path) {
        fm.createFile(atPath: path, contents: nil)
    }
    gCompanionLogHandle = FileHandle(forWritingAtPath: path)
    gCompanionLogHandle?.seekToEndOfFile()
}

// MARK: - 命令行解析

/// 从 CommandLine.arguments 中解析 --key=value 或 --key value 形式的参数
private func parseArg(key: String) -> String? {
    let args = CommandLine.arguments
    let prefix = "--\(key)="
    for (i, arg) in args.enumerated() {
        if arg.hasPrefix(prefix) {
            let val = String(arg.dropFirst(prefix.count))
            return val.isEmpty ? nil : val
        }
        if arg == "--\(key)", i + 1 < args.count {
            return args[i + 1]
        }
    }
    return nil
}

// MARK: - 协议类型

/**
 * companion 向 Electron 发出的消息类型(协议版本 2)。
 *
 * hello            — 连接建立后立即发出,含协议版本、本 bundle 指纹、当前 PID
 * daemon-status    — daemon 状态变化时推送
 * pong             — 回复 Electron 的 ping
 * guide-attached   — 引导面板首次吸附到 System Settings 时发出
 * guide-close-requested — 用户点击关闭按钮
 * guide-completed  — 权限均已授予
 * guide-drag-began — 拖拽会话开始
 * guide-drag-ended — 拖拽会话结束
 * guide-error      — 引导面板发生错误
 * switch-location  — 响应 locate-switch 请求
 * permission-state — 响应 watch-permissions 或权限状态变化推送
 */
private enum OutboundMessage {
    case hello(pid: Int32, fingerprint: String)
    case daemonStatus(running: Bool, pid: Int32?, restarts: Int)
    case pong(id: Int64)
    // 引导面板事件(镜像旧版 helper stdin/stdout 消息语义)
    case guideAttached(systemX: CGFloat, systemY: CGFloat, systemWidth: CGFloat, systemHeight: CGFloat, panelX: CGFloat, panelY: CGFloat)
    case guideCloseRequested
    case guideCompleted
    case guideDragBegan(permission: String)
    case guideDragEnded(permission: String, operation: UInt)
    case guideError(message: String)
    // 开关定位结果
    case switchLocation(id: Int64, status: String, payload: [String: Any])
    // 权限状态快照
    case permissionState(accessibility: Bool, screenRecording: Bool)

    func toDict() -> [String: Any] {
        switch self {
        case let .hello(pid, fingerprint):
            return [
                "type": "hello",
                "protocolVersion": 2,
                "companionFingerprint": fingerprint,
                "pid": pid,
            ]
        case let .daemonStatus(running, daemonPid, restarts):
            var d: [String: Any] = [
                "type": "daemon-status",
                "running": running,
                "restarts": restarts,
            ]
            d["pid"] = daemonPid.map { Int($0) } as Any
            return d
        case let .pong(id):
            return ["type": "pong", "id": id]
        case let .guideAttached(sysX, sysY, sysW, sysH, panX, panY):
            return [
                "type": "guide-attached",
                "systemX": sysX, "systemY": sysY,
                "systemWidth": sysW, "systemHeight": sysH,
                "panelX": panX, "panelY": panY,
            ]
        case .guideCloseRequested:
            return ["type": "guide-close-requested"]
        case .guideCompleted:
            return ["type": "guide-completed"]
        case let .guideDragBegan(permission):
            return ["type": "guide-drag-began", "permission": permission]
        case let .guideDragEnded(permission, operation):
            return ["type": "guide-drag-ended", "permission": permission, "operation": operation]
        case let .guideError(message):
            return ["type": "guide-error", "message": message]
        case let .switchLocation(id, status, payload):
            var d: [String: Any] = ["type": "switch-location", "id": id, "status": status]
            d.merge(payload) { _, new in new }
            return d
        case let .permissionState(accessibility, screenRecording):
            return [
                "type": "permission-state",
                "accessibility": accessibility,
                "screenRecording": screenRecording,
            ]
        }
    }
}

/**
 * Electron 向 companion 发出的消息(协议版本 2 新增);未知 type 忽略。
 */
private enum InboundMessage {
    case ping(id: Int64)
    case shutdown
    // 版本 2 新增
    case guideUpdate(state: GuideState)
    case guideDismiss
    case locateSwitch(id: Int64)
    case watchPermissions(enabled: Bool)
    case unknown
}

/// 权限引导状态(从 guide-update 消息中解析)
private struct GuideState {
    var accessibilityGranted: Bool
    var screenRecordingGranted: Bool
    var draggedAccessibility: Bool
    var draggedScreenRecording: Bool
    var switchTargetX: CGFloat?
    var switchTargetY: CGFloat?
    var switchWindowWidth: CGFloat?
    var switchWindowHeight: CGFloat?
    /// 应用 bundle 路径(替代旧版 helper 的 argv[1])
    var appBundlePath: String
}

/// 将 JSON 字典序列化为 NDJSON 行(附尾部换行)
private func ndjsonLine(_ dict: [String: Any]) -> Data? {
    guard JSONSerialization.isValidJSONObject(dict),
          let data = try? JSONSerialization.data(withJSONObject: dict),
          var s = String(data: data, encoding: .utf8) else { return nil }
    s.append("\n")
    return s.data(using: .utf8)
}

// MARK: - Daemon 监督器

/**
 * DaemonSupervisor 负责 spawn 并监督内嵌 cua-driver 进程。
 *
 * 使用 Foundation.Process 以 CUA_DRIVER_EMBEDDED=1 启动 daemon;
 * daemon 退出时在 60 秒时间窗口内最多自动重启 3 次;超限停止重试。
 * 所有状态变化通过 onStatusChange 回调通知调用方。
 */
private final class DaemonSupervisor {
    /// daemon 状态变化回调(在主线程上调用)
    var onStatusChange: ((Bool, Int32?, Int) -> Void)?

    private let enginePath: String
    private let daemonLogPath: String?
    private let hostBundleId: String

    /// 当前 daemon 进程;nil 表示未运行
    private var process: Process?

    /// 退避重启历史:记录每次重启的时间戳
    private var restartTimestamps: [Date] = []

    /// 是否已停止重试(超限后设为 true)
    private var retriesStopped = false

    /// 是否处于主动 teardown(避免 terminationHandler 触发重启)
    private var isTearingDown = false

    /// 当前重启计数
    var restartCount: Int { restartTimestamps.count }

    init(enginePath: String, daemonLogPath: String?, hostBundleId: String) {
        self.enginePath = enginePath
        self.daemonLogPath = daemonLogPath
        self.hostBundleId = hostBundleId
    }

    /// 在 spawn daemon 之前,同步运行 `cua-driver stop` 抢占全局 socket,
    /// 并确保 stale socket/pid 文件被清理干净。
    ///
    /// 背景:daemon 非正常退出(crash / SIGKILL)后,
    ///   ~/Library/Caches/cua-driver/cua-driver.sock
    ///   ~/Library/Caches/cua-driver/cua-driver.pid
    /// 两个文件会残留在磁盘上。新 daemon 启动时先检查这两个文件——sock 存在且能
    /// connect 则认为已有实例在跑并立即退出("already running")。sock 残留但连接
    /// 失败时 daemon 行为不定(版本相关),因此本函数在 stop 命令返回非零(无存活
    /// daemon 应答)后主动等待 sock 消失,若等待超时则强制删除 sock + pid 文件,
    /// 保证新 daemon 每次都能找到干净环境。
    ///
    /// stop 成功(exitCode==0)说明有存活 daemon 正常关闭,它会自行清理这两个文件;
    /// 此时同样等待 sock 消失并在超时后兜底删除,避免竞态(daemon 写磁盘比退出慢)。
    private func stopExistingDaemon() {
        log("DaemonSupervisor: running 'cua-driver stop' to take over global socket")
        let stopProc = Process()
        stopProc.executableURL = URL(fileURLWithPath: enginePath)
        stopProc.arguments = ["stop"]

        // 继承与 serve 相同的环境,以便 stop 命令能找到正确的 socket 路径
        var env = ProcessInfo.processInfo.environment
        env["CUA_DRIVER_EMBEDDED"] = "1"
        env["CUA_DRIVER_HOST_BUNDLE_ID"] = hostBundleId
        env["CUA_LOG"] = "info"
        stopProc.environment = env

        // 丢弃 stop 命令的 stdout/stderr,避免污染 daemon 日志
        stopProc.standardOutput = FileHandle.nullDevice
        stopProc.standardError = FileHandle.nullDevice

        do {
            try stopProc.run()
        } catch {
            log("DaemonSupervisor: failed to run stop: \(error); proceeding to spawn anyway")
            cleanupStaleDaemonFiles()
            return
        }

        // 等待 stop 进程退出,最多 5 秒;超时则强制杀掉并继续 spawn
        let kStopTimeoutSeconds: TimeInterval = 5
        let deadline = Date().addingTimeInterval(kStopTimeoutSeconds)
        var timedOut = false
        while stopProc.isRunning {
            if Date() > deadline {
                timedOut = true
                break
            }
            Thread.sleep(forTimeInterval: 0.05)
        }
        if timedOut {
            log("DaemonSupervisor: stop timed out after \(Int(kStopTimeoutSeconds))s; killing stop process and proceeding")
            stopProc.terminate()
        } else {
            log("DaemonSupervisor: stop completed (exitCode=\(stopProc.terminationStatus))")
        }

        // stop 完成后(无论 exit code),等待 sock 文件消失再 spawn。
        // stop 失败(非零)= 无存活 daemon,但 sock/pid 可能是 crash 残留;
        // stop 成功(0) = 存活 daemon 刚关闭,它正在自行清理这两个文件——
        // 两种情况都等一下,超时后兜底删除,保证新 daemon 看到干净环境。
        cleanupStaleDaemonFiles()
    }

    /// 等待 cua-driver.sock 自然消失(最多约 1 秒);若等待超时则强制删除
    /// sock 和 pid 文件。忽略删除错误,仅记录日志。
    private func cleanupStaleDaemonFiles() {
        let cacheDir = (NSHomeDirectory() as NSString)
            .appendingPathComponent("Library/Caches/cua-driver")
        let sockPath = (cacheDir as NSString).appendingPathComponent("cua-driver.sock")
        let pidPath  = (cacheDir as NSString).appendingPathComponent("cua-driver.pid")

        let fm = FileManager.default

        // 轮询等待 sock 文件消失(最多 1 秒,50ms 间隔)
        let kSockWaitDeadline = Date().addingTimeInterval(1.0)
        while fm.fileExists(atPath: sockPath), Date() < kSockWaitDeadline {
            Thread.sleep(forTimeInterval: 0.05)
        }

        // 若 sock 依然存在,强制删除 sock + pid
        if fm.fileExists(atPath: sockPath) {
            do {
                try fm.removeItem(atPath: sockPath)
                log("DaemonSupervisor: removed stale cua-driver.sock")
            } catch {
                log("DaemonSupervisor: failed to remove stale sock (ignored): \(error)")
            }
        }
        if fm.fileExists(atPath: pidPath) {
            do {
                try fm.removeItem(atPath: pidPath)
                log("DaemonSupervisor: removed stale cua-driver.pid")
            } catch {
                log("DaemonSupervisor: failed to remove stale pid (ignored): \(error)")
            }
        }
    }

    /// 启动 daemon(首次或重启)
    func start() {
        guard !retriesStopped else {
            log("DaemonSupervisor: retries exhausted, not starting")
            return
        }
        guard FileManager.default.isExecutableFile(atPath: enginePath) else {
            log("DaemonSupervisor: engine binary not executable at \(enginePath)")
            onStatusChange?(false, nil, restartCount)
            return
        }

        // 每次 spawn 前先抢占全局 socket,防止残留或外部 daemon 阻断启动
        stopExistingDaemon()

        let proc = Process()
        proc.executableURL = URL(fileURLWithPath: enginePath)
        // serve 是长驻 daemon 子命令
        // --no-permissions-gate 抑制 daemon 自身的权限弹框;权限由 companion(host)负责引导
        proc.arguments = ["serve", "--no-permissions-gate"]

        // 注入嵌入模式环境变量:daemon 跳过 disclaim re-exec,留在本 bundle 的 TCC 归责链
        var env = ProcessInfo.processInfo.environment
        env["CUA_DRIVER_EMBEDDED"] = "1"
        env["CUA_DRIVER_HOST_BUNDLE_ID"] = hostBundleId
        env["CUA_LOG"] = "info"
        proc.environment = env

        // 重定向 daemon stdout/stderr 到 companion-daemon.log
        if let logPath = daemonLogPath {
            let fm = FileManager.default
            if !fm.fileExists(atPath: logPath) {
                fm.createFile(atPath: logPath, contents: nil)
            }
            if let fh = FileHandle(forWritingAtPath: logPath) {
                fh.seekToEndOfFile()
                proc.standardOutput = fh
                proc.standardError = fh
            }
        }

        proc.terminationHandler = { [weak self] p in
            let code = p.terminationStatus
            DispatchQueue.main.async {
                guard let self, !self.isTearingDown else { return }
                log("DaemonSupervisor: daemon exited (code=\(code), pid=\(p.processIdentifier))")
                self.process = nil
                self.onStatusChange?(false, nil, self.restartCount)
                self.scheduleRestartIfAllowed()
            }
        }

        do {
            try proc.run()
            process = proc
            let pid = proc.processIdentifier
            log("DaemonSupervisor: daemon started (pid=\(pid))")
            onStatusChange?(true, pid, restartCount)
        } catch {
            log("DaemonSupervisor: failed to spawn daemon: \(error)")
            process = nil
            onStatusChange?(false, nil, restartCount)
            scheduleRestartIfAllowed()
        }
    }

    /// 主动停止 daemon(teardown 路径)
    func stop() {
        isTearingDown = true
        guard let proc = process, proc.isRunning else {
            log("DaemonSupervisor: stop called but daemon not running")
            return
        }
        let pid = proc.processIdentifier
        log("DaemonSupervisor: sending SIGTERM to daemon pid=\(pid)")
        proc.terminate()

        // 等待最多 kShutdownGracePeriodSeconds 后 SIGKILL 兜底
        let deadline = DispatchTime.now() + kShutdownGracePeriodSeconds
        DispatchQueue.global().asyncAfter(deadline: deadline) { [weak proc] in
            guard let proc, proc.isRunning else { return }
            log("DaemonSupervisor: SIGKILL daemon pid=\(proc.processIdentifier) (grace period elapsed)")
            kill(proc.processIdentifier, SIGKILL)
        }

        proc.waitUntilExit()
        process = nil
        log("DaemonSupervisor: daemon stopped (pid=\(pid))")
    }

    /// 检查是否还允许重启;允许则在稍后重启
    private func scheduleRestartIfAllowed() {
        let now = Date()
        // 清理时间窗口外的旧记录
        restartTimestamps = restartTimestamps.filter {
            now.timeIntervalSince($0) < kRestartWindowSeconds
        }

        if restartTimestamps.count >= kMaxRestartsInWindow {
            log("DaemonSupervisor: restart limit (\(kMaxRestartsInWindow) in \(Int(kRestartWindowSeconds))s) reached; stopping retries")
            retriesStopped = true
            onStatusChange?(false, nil, restartCount)
            return
        }

        restartTimestamps.append(now)
        let delay = backoffDelay(attempt: restartTimestamps.count)
        log("DaemonSupervisor: scheduling restart #\(restartTimestamps.count) in \(String(format: "%.1f", delay))s")
        DispatchQueue.main.asyncAfter(deadline: .now() + delay) { [weak self] in
            guard let self, !self.isTearingDown else { return }
            self.start()
        }
    }

    /// 简单指数退避:1s, 2s, 4s…
    private func backoffDelay(attempt: Int) -> TimeInterval {
        return min(pow(2.0, Double(attempt - 1)), 16.0)
    }

    /// 当前 daemon PID;nil 表示未运行
    var currentPid: Int32? { process?.isRunning == true ? process?.processIdentifier : nil }
}

// MARK: - 引导面板 UI 组件(从旧版 helper 移植)

/**
 * 不激活应用的 NSPanel;点击时不夺焦,System Settings 保持前台。
 */
private final class PermissionAccessoryPanel: NSPanel {
    override var canBecomeKey: Bool { false }
    override var canBecomeMain: Bool { false }
}

/**
 * 透传 hit-test 的宿主视图;只有卡片区域参与交互。
 */
private final class PassthroughHostView: NSView {
    weak var interactiveView: NSView?

    override func hitTest(_ point: NSPoint) -> NSView? {
        guard let interactiveView else { return nil }
        let localPoint = convert(point, to: interactiveView)
        guard interactiveView.bounds.contains(localPoint) else { return nil }
        return interactiveView.hitTest(localPoint)
    }
}

/**
 * 不激活窗口的关闭按钮;保持 System Settings 前台。
 */
private final class NonactivatingCloseButton: NSButton {
    override func acceptsFirstMouse(for event: NSEvent?) -> Bool { true }

    override func mouseDown(with event: NSEvent) {
        NSApp.preventWindowOrdering()
        super.mouseDown(with: event)
    }
}

/**
 * 可拖拽的应用行视图;发起 AppKit 文件拖拽会话。
 */
private final class DraggableApplicationView: NSView, NSDraggingSource {
    private let appURL: URL
    private let appIcon: NSImage
    private var mouseDownEvent: NSEvent?
    private var didBeginDrag = false
    var dragEnabled = true
    var onDragBegan: (() -> Void)?
    var onDragEnded: ((NSDragOperation) -> Void)?

    init(appURL: URL, appIcon: NSImage) {
        self.appURL = appURL
        self.appIcon = appIcon
        super.init(frame: .zero)
        wantsLayer = true
        layer?.cornerRadius = 12
        layer?.cornerCurve = .continuous
        layer?.backgroundColor = NSColor.white.cgColor
        layer?.borderColor = NSColor.white.cgColor
        layer?.borderWidth = 1
        layer?.shadowColor = NSColor.black.cgColor
        layer?.shadowOpacity = 0.28
        layer?.shadowRadius = 14
        layer?.shadowOffset = NSSize(width: 0, height: -5)
        setAccessibilityElement(true)
        setAccessibilityRole(.button)
        setAccessibilityLabel("Computer Use")
    }

    required init?(coder: NSCoder) { nil }

    override var acceptsFirstResponder: Bool { false }

    override func acceptsFirstMouse(for event: NSEvent?) -> Bool { true }

    override func layout() {
        super.layout()
        layer?.shadowPath = CGPath(
            roundedRect: bounds,
            cornerWidth: 12,
            cornerHeight: 12,
            transform: nil
        )
    }

    override func mouseDown(with event: NSEvent) {
        guard dragEnabled else { return }
        NSApp.preventWindowOrdering()
        mouseDownEvent = event
        didBeginDrag = false
        NSAnimationContext.runAnimationGroup { context in
            context.duration = 0.12
            animator().alphaValue = 0.82
        }
    }

    override func mouseDragged(with event: NSEvent) {
        guard dragEnabled, !didBeginDrag, let mouseDownEvent else { return }
        let dx = event.locationInWindow.x - mouseDownEvent.locationInWindow.x
        let dy = event.locationInWindow.y - mouseDownEvent.locationInWindow.y
        guard hypot(dx, dy) >= 4 else { return }
        didBeginDrag = true

        // 在进入 AppKit 嵌套拖拽循环前,重新激活 System Settings,确保它是拖放目标
        NSRunningApplication.runningApplications(withBundleIdentifier: kSystemSettingsBundleId)
            .first?
            .activate()

        let item = NSDraggingItem(pasteboardWriter: appURL as NSURL)
        let imageSize = NSSize(width: 64, height: 64)
        item.setDraggingFrame(
            NSRect(
                x: event.locationInWindow.x - imageSize.width / 2,
                y: event.locationInWindow.y - imageSize.height / 2,
                width: imageSize.width,
                height: imageSize.height
            ),
            contents: appIcon
        )
        onDragBegan?()
        beginDraggingSession(with: [item], event: event, source: self)
    }

    override func mouseUp(with event: NSEvent) {
        if !didBeginDrag {
            NSAnimationContext.runAnimationGroup { context in
                context.duration = 0.12
                animator().alphaValue = 1
            }
        }
        mouseDownEvent = nil
    }

    func draggingSession(
        _ session: NSDraggingSession,
        sourceOperationMaskFor context: NSDraggingContext
    ) -> NSDragOperation {
        .copy
    }

    func ignoreModifierKeys(for session: NSDraggingSession) -> Bool { true }

    func draggingSession(
        _ session: NSDraggingSession,
        endedAt screenPoint: NSPoint,
        operation: NSDragOperation
    ) {
        mouseDownEvent = nil
        didBeginDrag = false
        alphaValue = 1
        onDragEnded?(operation)
    }
}

/**
 * 拖拽后显示的开关引导小浮层。
 */
private final class SwitchGuideController: NSViewController {
    private let closeButton = NonactivatingCloseButton()
    private let instructionLabel = NSTextField(labelWithString: "")
    private let arrowView = NSImageView()
    var onClose: (() -> Void)?

    private var usesChineseCopy: Bool {
        Locale.preferredLanguages.first?.lowercased().hasPrefix("zh") == true
    }

    override func loadView() {
        let root = NSView(frame: NSRect(origin: .zero, size: kSwitchGuideSize))
        root.wantsLayer = true
        view = root

        closeButton.translatesAutoresizingMaskIntoConstraints = false
        closeButton.image = NSImage(
            systemSymbolName: "xmark.circle.fill",
            accessibilityDescription: usesChineseCopy ? "关闭" : "Close"
        )
        closeButton.imageScaling = .scaleProportionallyDown
        closeButton.isBordered = false
        closeButton.contentTintColor = .tertiaryLabelColor
        closeButton.target = self
        closeButton.action = #selector(closeRequested)
        root.addSubview(closeButton)

        instructionLabel.translatesAutoresizingMaskIntoConstraints = false
        instructionLabel.stringValue = usesChineseCopy ? "打开这一项" : "Turn this on"
        instructionLabel.font = .systemFont(ofSize: 13, weight: .semibold)
        instructionLabel.textColor = .controlAccentColor
        instructionLabel.alignment = .right
        root.addSubview(instructionLabel)

        arrowView.translatesAutoresizingMaskIntoConstraints = false
        arrowView.wantsLayer = true
        arrowView.image = NSImage(
            systemSymbolName: "arrow.right",
            accessibilityDescription: usesChineseCopy ? "指向开关" : "Points to the switch"
        )
        arrowView.symbolConfiguration = NSImage.SymbolConfiguration(pointSize: 19, weight: .semibold)
        arrowView.contentTintColor = .controlAccentColor
        root.addSubview(arrowView)

        NSLayoutConstraint.activate([
            closeButton.leadingAnchor.constraint(equalTo: root.leadingAnchor),
            closeButton.centerYAnchor.constraint(equalTo: root.centerYAnchor),
            closeButton.widthAnchor.constraint(equalToConstant: 24),
            closeButton.heightAnchor.constraint(equalToConstant: 24),

            instructionLabel.leadingAnchor.constraint(equalTo: closeButton.trailingAnchor, constant: 8),
            instructionLabel.centerYAnchor.constraint(equalTo: root.centerYAnchor),

            arrowView.leadingAnchor.constraint(equalTo: instructionLabel.trailingAnchor, constant: 10),
            arrowView.trailingAnchor.constraint(equalTo: root.trailingAnchor, constant: -4),
            arrowView.centerYAnchor.constraint(equalTo: root.centerYAnchor),
            arrowView.widthAnchor.constraint(equalToConstant: 28),
            arrowView.heightAnchor.constraint(equalToConstant: 28),
        ])
    }

    func prepareForDisplay() {
        guard isViewLoaded else { return }
        startGuidanceAnimation()
    }

    func prepareForDismissal() {
        guard isViewLoaded else { return }
        arrowView.layer?.removeAllAnimations()
    }

    private func startGuidanceAnimation() {
        arrowView.layer?.removeAllAnimations()
        guard !NSWorkspace.shared.accessibilityDisplayShouldReduceMotion else { return }

        // 简单的水平摇摆动效引导用户注意开关位置
        let movement = CAKeyframeAnimation(keyPath: "transform.translation.x")
        movement.values = [0, 6, 0, 0]
        movement.keyTimes = [0, 0.24, 0.48, 1]
        movement.duration = 1.6
        movement.repeatCount = .infinity
        movement.timingFunctions = [
            CAMediaTimingFunction(name: .easeInEaseOut),
            CAMediaTimingFunction(name: .easeInEaseOut),
            CAMediaTimingFunction(name: .linear),
        ]
        arrowView.layer?.add(movement, forKey: "switchGuideMovement")
    }

    @objc private func closeRequested() {
        onClose?()
    }
}

/**
 * 权限引导卡片控制器,包含拖拽教学 UI。
 */
private final class PermissionCardController: NSViewController {
    enum Permission: String {
        case accessibility
        case screenRecording
        case complete
    }

    private let appURL: URL
    /// 从 appURL bundle 取到的显示名(FileManager.displayName 去掉 .app 后缀)
    private let appDisplayName: String
    private let materialView = NSVisualEffectView()
    private let eyebrowLabel = NSTextField(labelWithString: "")
    private let titleLabel = NSTextField(labelWithString: "")
    private let statusLabel = NSTextField(labelWithString: "")
    private let appNameLabel = NSTextField(labelWithString: "CuaDriver")
    private let closeButton = NonactivatingCloseButton()
    private let dragCoach = NSView()
    private let dragCoachIcon = NSImageView()
    private let dragCoachPill = NSVisualEffectView()
    private let dragCoachLabel = NSTextField(labelWithString: "")
    private let appIconView = NSImageView()
    private let appRow: DraggableApplicationView
    private var permission: Permission = .accessibility
    private var hasBeenDragged = false
    private var closeTimer: Timer?
    var onClose: (() -> Void)?
    var onComplete: (() -> Void)?
    var onDragBegan: ((Permission) -> Void)?
    var onDragEnded: ((Permission, NSDragOperation) -> Void)?

    private var usesChineseCopy: Bool {
        Locale.preferredLanguages.first?.lowercased().hasPrefix("zh") == true
    }

    init(appURL: URL) {
        self.appURL = appURL
        // 从 bundle 取真实显示名,确保与系统设置列表中显示的行名一致
        var rawName = FileManager.default.displayName(atPath: appURL.path)
        if rawName.hasSuffix(".app") {
            rawName = String(rawName.dropLast(4))
        }
        self.appDisplayName = rawName
        let icon = NSWorkspace.shared.icon(forFile: appURL.path)
        icon.size = NSSize(width: 64, height: 64)
        self.appRow = DraggableApplicationView(appURL: appURL, appIcon: icon)
        super.init(nibName: nil, bundle: nil)
    }

    required init?(coder: NSCoder) { nil }

    override func loadView() {
        let root = NSView(frame: NSRect(origin: .zero, size: kCardFrame.size))
        root.wantsLayer = true
        view = root

        materialView.translatesAutoresizingMaskIntoConstraints = false
        materialView.material = .hudWindow
        materialView.blendingMode = .behindWindow
        materialView.state = .active
        materialView.wantsLayer = true
        materialView.layer?.cornerRadius = 14
        materialView.layer?.cornerCurve = .continuous
        materialView.layer?.masksToBounds = true
        materialView.layer?.borderWidth = 0.5
        materialView.layer?.borderColor = NSColor.white.withAlphaComponent(0.13).cgColor
        root.addSubview(materialView)

        closeButton.translatesAutoresizingMaskIntoConstraints = false
        closeButton.image = NSImage(
            systemSymbolName: "xmark",
            accessibilityDescription: usesChineseCopy ? "关闭" : "Close"
        )
        closeButton.imageScaling = .scaleProportionallyDown
        closeButton.isBordered = false
        closeButton.bezelStyle = .circular
        closeButton.contentTintColor = .secondaryLabelColor
        closeButton.target = self
        closeButton.action = #selector(closeRequested)
        materialView.addSubview(closeButton)

        titleLabel.translatesAutoresizingMaskIntoConstraints = false
        titleLabel.font = .systemFont(ofSize: 20, weight: .semibold)
        titleLabel.textColor = .labelColor
        titleLabel.lineBreakMode = .byTruncatingTail
        materialView.addSubview(titleLabel)

        eyebrowLabel.translatesAutoresizingMaskIntoConstraints = false
        eyebrowLabel.font = .monospacedSystemFont(ofSize: 11, weight: .medium)
        eyebrowLabel.textColor = .tertiaryLabelColor
        eyebrowLabel.lineBreakMode = .byTruncatingTail
        materialView.addSubview(eyebrowLabel)

        appRow.translatesAutoresizingMaskIntoConstraints = false
        materialView.addSubview(appRow)

        appIconView.translatesAutoresizingMaskIntoConstraints = false
        appIconView.image = NSWorkspace.shared.icon(forFile: appURL.path)
        appIconView.imageScaling = .scaleProportionallyUpOrDown
        appRow.addSubview(appIconView)

        appNameLabel.translatesAutoresizingMaskIntoConstraints = false
        appNameLabel.font = .systemFont(ofSize: 15, weight: .medium)
        appNameLabel.textColor = .labelColor
        appRow.addSubview(appNameLabel)

        statusLabel.translatesAutoresizingMaskIntoConstraints = false
        statusLabel.font = .systemFont(ofSize: 12, weight: .regular)
        statusLabel.textColor = .secondaryLabelColor
        statusLabel.alignment = .right
        appRow.addSubview(statusLabel)

        root.addSubview(dragCoach)
        configureDragCoach(in: root)

        NSLayoutConstraint.activate([
            materialView.leadingAnchor.constraint(equalTo: root.leadingAnchor),
            materialView.trailingAnchor.constraint(equalTo: root.trailingAnchor),
            materialView.topAnchor.constraint(equalTo: root.topAnchor),
            materialView.bottomAnchor.constraint(equalTo: root.bottomAnchor),

            closeButton.trailingAnchor.constraint(equalTo: materialView.trailingAnchor, constant: -12),
            closeButton.topAnchor.constraint(equalTo: materialView.topAnchor, constant: 10),
            closeButton.widthAnchor.constraint(equalToConstant: 28),
            closeButton.heightAnchor.constraint(equalToConstant: 28),

            titleLabel.leadingAnchor.constraint(equalTo: materialView.leadingAnchor, constant: 16),
            titleLabel.trailingAnchor.constraint(equalTo: closeButton.leadingAnchor, constant: -8),
            titleLabel.topAnchor.constraint(equalTo: eyebrowLabel.bottomAnchor, constant: 3),
            titleLabel.heightAnchor.constraint(equalToConstant: 28),

            eyebrowLabel.leadingAnchor.constraint(equalTo: materialView.leadingAnchor, constant: 16),
            eyebrowLabel.trailingAnchor.constraint(equalTo: closeButton.leadingAnchor, constant: -8),
            eyebrowLabel.topAnchor.constraint(equalTo: materialView.topAnchor, constant: 12),
            eyebrowLabel.heightAnchor.constraint(equalToConstant: 15),

            appRow.leadingAnchor.constraint(equalTo: materialView.leadingAnchor, constant: 16),
            appRow.trailingAnchor.constraint(equalTo: materialView.trailingAnchor, constant: -16),
            appRow.bottomAnchor.constraint(equalTo: materialView.bottomAnchor, constant: -18),
            appRow.heightAnchor.constraint(equalToConstant: 64),

            appIconView.leadingAnchor.constraint(equalTo: appRow.leadingAnchor, constant: 12),
            appIconView.centerYAnchor.constraint(equalTo: appRow.centerYAnchor),
            appIconView.widthAnchor.constraint(equalToConstant: 44),
            appIconView.heightAnchor.constraint(equalToConstant: 44),

            appNameLabel.leadingAnchor.constraint(equalTo: appIconView.trailingAnchor, constant: 12),
            appNameLabel.centerYAnchor.constraint(equalTo: appRow.centerYAnchor),

            statusLabel.leadingAnchor.constraint(greaterThanOrEqualTo: appNameLabel.trailingAnchor, constant: 8),
            statusLabel.trailingAnchor.constraint(equalTo: appRow.trailingAnchor, constant: -14),
            statusLabel.centerYAnchor.constraint(equalTo: appRow.centerYAnchor),
        ])

        appRow.onDragBegan = { [weak self] in
            guard let self else { return }
            stopDragCoachAnimation()
            dragCoach.isHidden = true
            NSAnimationContext.runAnimationGroup { context in
                context.duration = 0.16
                self.materialView.animator().alphaValue = 0.18
            }
            onDragBegan?(permission)
        }
        appRow.onDragEnded = { [weak self] operation in
            guard let self else { return }
            hasBeenDragged = true
            NSAnimationContext.runAnimationGroup { context in
                context.duration = 0.18
                self.materialView.animator().alphaValue = 1
            }
            updateCopy()
            onDragEnded?(permission, operation)
        }
    }

    override func viewDidAppear() {
        super.viewDidAppear()
        updateCopy()
    }

    func update(
        accessibilityGranted: Bool,
        screenRecordingGranted: Bool,
        draggedAccessibility: Bool,
        draggedScreenRecording: Bool
    ) {
        closeTimer?.invalidate()
        if !accessibilityGranted {
            permission = .accessibility
            hasBeenDragged = draggedAccessibility
        } else if !screenRecordingGranted {
            permission = .screenRecording
            hasBeenDragged = draggedScreenRecording
        } else {
            permission = .complete
            hasBeenDragged = true
            closeTimer = Timer.scheduledTimer(withTimeInterval: 1.1, repeats: false) { [weak self] _ in
                self?.onComplete?()
            }
        }
        updateCopy()
    }

    private func configureDragCoach(in root: NSView) {
        dragCoach.translatesAutoresizingMaskIntoConstraints = false
        dragCoach.wantsLayer = true

        dragCoachIcon.translatesAutoresizingMaskIntoConstraints = false
        dragCoachIcon.image = NSImage(systemSymbolName: "cursorarrow", accessibilityDescription: nil)
        dragCoachIcon.symbolConfiguration = NSImage.SymbolConfiguration(pointSize: 17, weight: .medium)
        dragCoachIcon.contentTintColor = .labelColor
        dragCoach.addSubview(dragCoachIcon)

        dragCoachPill.translatesAutoresizingMaskIntoConstraints = false
        dragCoachPill.material = .popover
        dragCoachPill.blendingMode = .withinWindow
        dragCoachPill.state = .active
        dragCoachPill.wantsLayer = true
        dragCoachPill.layer?.cornerRadius = 13
        dragCoachPill.layer?.cornerCurve = .continuous
        dragCoach.addSubview(dragCoachPill)

        dragCoachLabel.translatesAutoresizingMaskIntoConstraints = false
        dragCoachLabel.font = .systemFont(ofSize: 12, weight: .medium)
        dragCoachLabel.textColor = .labelColor
        dragCoachPill.addSubview(dragCoachLabel)

        NSLayoutConstraint.activate([
            dragCoach.widthAnchor.constraint(equalToConstant: 92),
            dragCoach.heightAnchor.constraint(equalToConstant: 40),
            dragCoach.trailingAnchor.constraint(equalTo: root.trailingAnchor, constant: -24),
            dragCoach.bottomAnchor.constraint(equalTo: root.bottomAnchor, constant: -30),

            dragCoachIcon.leadingAnchor.constraint(equalTo: dragCoach.leadingAnchor),
            dragCoachIcon.centerYAnchor.constraint(equalTo: dragCoach.centerYAnchor),
            dragCoachIcon.widthAnchor.constraint(equalToConstant: 34),
            dragCoachIcon.heightAnchor.constraint(equalToConstant: 34),

            dragCoachPill.leadingAnchor.constraint(equalTo: dragCoachIcon.trailingAnchor, constant: 4),
            dragCoachPill.centerYAnchor.constraint(equalTo: dragCoach.centerYAnchor),
            dragCoachPill.heightAnchor.constraint(equalToConstant: 26),
            dragCoachPill.widthAnchor.constraint(equalToConstant: 52),

            dragCoachLabel.centerXAnchor.constraint(equalTo: dragCoachPill.centerXAnchor),
            dragCoachLabel.centerYAnchor.constraint(equalTo: dragCoachPill.centerYAnchor),
        ])
    }

    private func updateCopy() {
        guard isViewLoaded else { return }
        let permissionName: String
        switch permission {
        case .accessibility:
            permissionName = usesChineseCopy ? "辅助功能" : "Accessibility"
        case .screenRecording:
            permissionName = usesChineseCopy ? "屏幕录制" : "Screen Recording"
        case .complete:
            permissionName = ""
        }

        if permission == .complete {
            eyebrowLabel.stringValue = usesChineseCopy ? "已完成" : "READY"
            titleLabel.stringValue = usesChineseCopy ? "Computer Use 已就绪" : "Computer Use is ready"
            statusLabel.stringValue = ""
            appRow.dragEnabled = false
            dragCoach.isHidden = true
            stopDragCoachAnimation()
            return
        }

        eyebrowLabel.stringValue = usesChineseCopy ? "打开自动操作电脑" : "Open computer automation"
        // 非完成阶段始终允许拖拽:标记过期时系统设置里的行可能已不存在,
        // 保留拖拽能力让用户可以重新拖一次完成自救。
        appRow.dragEnabled = true
        if hasBeenDragged {
            titleLabel.stringValue = usesChineseCopy
                ? "在「\(permissionName)」中打开 \(appDisplayName)"
                : "Turn on \(appDisplayName) in \(permissionName)"
            statusLabel.stringValue = usesChineseCopy ? "等待你开启" : "Waiting for you"
            dragCoach.isHidden = true
            stopDragCoachAnimation()
        } else {
            titleLabel.stringValue = usesChineseCopy
                ? "将 \(appDisplayName) 拖入「\(permissionName)」"
                : "Drag \(appDisplayName) into \(permissionName)"
            statusLabel.stringValue = ""
            dragCoachLabel.stringValue = usesChineseCopy ? "拖拽" : "Drag"
            dragCoach.isHidden = false
            startDragCoachAnimation()
        }
    }

    private func startDragCoachAnimation() {
        dragCoach.layer?.opacity = 1
        guard !NSWorkspace.shared.accessibilityDisplayShouldReduceMotion else {
            dragCoach.layer?.removeAllAnimations()
            return
        }
        guard dragCoach.layer?.animation(forKey: "dragCoachPosition") == nil else { return }
        view.layoutSubtreeIfNeeded()
        let base = dragCoach.layer?.position ?? .zero

        let position = CAKeyframeAnimation(keyPath: "position")
        position.values = [
            NSValue(point: base),
            NSValue(point: CGPoint(x: base.x - 5, y: base.y + 9)),
            NSValue(point: CGPoint(x: base.x - 32, y: base.y + 62)),
            NSValue(point: CGPoint(x: base.x - 32, y: base.y + 62)),
            NSValue(point: base),
        ]
        position.keyTimes = [0, 0.12, 0.46, 0.62, 1]
        position.duration = 2.0
        position.repeatCount = .infinity
        position.timingFunctions = [
            CAMediaTimingFunction(name: .easeOut),
            CAMediaTimingFunction(name: .easeInEaseOut),
            CAMediaTimingFunction(name: .linear),
            CAMediaTimingFunction(name: .easeInEaseOut),
        ]
        dragCoach.layer?.add(position, forKey: "dragCoachPosition")

        let pickup = CAKeyframeAnimation(keyPath: "transform.scale")
        pickup.values = [1, 1.05, 1.05, 1.05, 1]
        pickup.keyTimes = position.keyTimes
        pickup.duration = position.duration
        pickup.repeatCount = .infinity
        pickup.timingFunctions = position.timingFunctions
        dragCoach.layer?.add(pickup, forKey: "dragCoachPickup")
    }

    private func stopDragCoachAnimation() {
        dragCoach.layer?.removeAnimation(forKey: "dragCoachPosition")
        dragCoach.layer?.removeAnimation(forKey: "dragCoachPickup")
        dragCoach.layer?.opacity = 1
    }

    @objc private func closeRequested() {
        onClose?()
    }
}

// MARK: - 引导面板协调器

/**
 * PermissionGuideCoordinator 管理两个 NSPanel 的生命周期与跟踪定时器。
 *
 * 生命周期:
 *   - guide-update 首次到达时创建并显示面板(attach 到 System Settings)。
 *   - guide-dismiss 或客户端断开时关闭面板(tearDown)。
 *   - 客户端断开时面板必须被关闭,避免孤立浮层残留在 System Settings 上方。
 *
 * 线程:所有 UI 操作均在主线程执行;ControlSocketServer 通过 DispatchQueue.main.async 调用。
 */
private final class PermissionGuideCoordinator {
    private enum Presentation {
        case hidden
        case drag
        case switchGuide
        case complete
    }

    private let panel: PermissionAccessoryPanel
    private let switchPanel: PermissionAccessoryPanel
    private let hostView: PassthroughHostView
    private let cardController: PermissionCardController
    private let switchGuideController: SwitchGuideController
    private var timer: Timer?
    private var hasActivatedSettings = false
    private var settingsMissingSince: Date?
    private var didNotifySettingsClosed = false
    private var isDragging = false
    private var presentation: Presentation = .hidden
    private var switchTarget: NSPoint?
    private var switchWindowSize: NSSize?

    // 诊断日志用:记录上次状态,仅变化时落盘
    private var lastLoggedSettingsVisible: Bool? = nil
    private var lastLoggedFrontmostBlocked: Bool? = nil
    private var lastLoggedPresentation: Presentation? = nil
    private var lastLoggedPanelVisible: Bool? = nil
    private var lastLoggedSwitchPanelVisible: Bool? = nil

    // 发送事件到 socket 的回调(由 ControlSocketServer 注入)
    var onEvent: ((OutboundMessage) -> Void)?

    init(appURL: URL) {
        panel = PermissionAccessoryPanel(
            contentRect: NSRect(origin: .zero, size: kHostSize),
            styleMask: [.borderless, .nonactivatingPanel],
            backing: .buffered,
            defer: false
        )
        switchPanel = PermissionAccessoryPanel(
            contentRect: NSRect(origin: .zero, size: kSwitchGuideSize),
            styleMask: [.borderless, .nonactivatingPanel],
            backing: .buffered,
            defer: false
        )
        hostView = PassthroughHostView(frame: NSRect(origin: .zero, size: kHostSize))
        cardController = PermissionCardController(appURL: appURL)
        switchGuideController = SwitchGuideController()

        panel.isOpaque = false
        panel.backgroundColor = .clear
        panel.hasShadow = true
        panel.level = .floating
        panel.isFloatingPanel = true
        panel.hidesOnDeactivate = false
        panel.becomesKeyOnlyIfNeeded = true
        panel.worksWhenModal = true
        panel.collectionBehavior = [.canJoinAllSpaces, .fullScreenAuxiliary, .transient, .ignoresCycle]
        panel.contentView = hostView

        switchPanel.isOpaque = false
        switchPanel.backgroundColor = .clear
        switchPanel.hasShadow = false
        switchPanel.level = .floating
        switchPanel.isFloatingPanel = true
        switchPanel.hidesOnDeactivate = false
        switchPanel.becomesKeyOnlyIfNeeded = true
        switchPanel.worksWhenModal = true
        switchPanel.collectionBehavior = [.canJoinAllSpaces, .fullScreenAuxiliary, .transient, .ignoresCycle]
        switchPanel.contentViewController = switchGuideController

        let card = cardController.view
        card.frame = kCardFrame
        card.autoresizingMask = []
        hostView.addSubview(card)
        hostView.interactiveView = card

        cardController.onClose = { [weak self] in
            self?.tearDown()
            self?.onEvent?(.guideCloseRequested)
        }
        switchGuideController.onClose = { [weak self] in
            self?.tearDown()
            self?.onEvent?(.guideCloseRequested)
        }
        cardController.onComplete = { [weak self] in
            self?.tearDown()
            self?.onEvent?(.guideCompleted)
        }
        cardController.onDragBegan = { [weak self] permission in
            self?.isDragging = true
            self?.onEvent?(.guideDragBegan(permission: permission.rawValue))
        }
        cardController.onDragEnded = { [weak self] permission, operation in
            guard let self else { return }
            isDragging = false
            if operation.contains(.copy) {
                presentation = .switchGuide
            }
            onEvent?(.guideDragEnded(permission: permission.rawValue, operation: operation.rawValue))
            refreshAttachment()
        }
    }

    func start() {
        refreshAttachment()
        timer = Timer.scheduledTimer(withTimeInterval: kTrackingInterval, repeats: true) { [weak self] _ in
            self?.refreshAttachment()
        }
    }

    func apply(_ state: GuideState) {
        if let x = optionalFinite(state.switchTargetX),
           let y = optionalFinite(state.switchTargetY),
           x >= 0, y >= 0 {
            switchTarget = NSPoint(x: x, y: y)
        } else {
            switchTarget = nil
        }
        if let width = optionalFinite(state.switchWindowWidth),
           let height = optionalFinite(state.switchWindowHeight),
           width > 0, height > 0 {
            switchWindowSize = NSSize(width: width, height: height)
        } else {
            switchWindowSize = nil
        }
        if !state.accessibilityGranted {
            presentation = state.draggedAccessibility ? .switchGuide : .drag
        } else if !state.screenRecordingGranted {
            presentation = state.draggedScreenRecording ? .switchGuide : .drag
        } else {
            presentation = .complete
        }
        cardController.update(
            accessibilityGranted: state.accessibilityGranted,
            screenRecordingGranted: state.screenRecordingGranted,
            draggedAccessibility: state.draggedAccessibility,
            draggedScreenRecording: state.draggedScreenRecording
        )
        refreshAttachment()
    }

    /// 关闭面板并停止跟踪定时器。
    /// 在 guide-dismiss 或客户端断开时调用,避免孤立浮层。
    func tearDown() {
        timer?.invalidate()
        timer = nil
        panel.orderOut(nil)
        switchGuideController.prepareForDismissal()
        switchPanel.orderOut(nil)
    }

    private func refreshAttachment() {
        guard let settingsApp = NSRunningApplication
            .runningApplications(withBundleIdentifier: kSystemSettingsBundleId)
            .first,
              let settingsFrame = systemSettingsWindowFrame(pid: settingsApp.processIdentifier)
        else {
            // 诊断:Settings 窗口消失
            if lastLoggedSettingsVisible != false {
                lastLoggedSettingsVisible = false
                log("Settings 窗口 found→lost")
            }
            if !isDragging {
                if settingsMissingSince == nil {
                    settingsMissingSince = Date()
                }
                // 吸附后 0.6 秒宽限期内 Settings 消失才认为已关闭(与旧版 helper 行为一致)
                if hasActivatedSettings,
                   !didNotifySettingsClosed,
                   let missingSince = settingsMissingSince,
                   Date().timeIntervalSince(missingSince) >= 0.6 {
                    didNotifySettingsClosed = true
                    onEvent?(.guideCloseRequested)
                    tearDown()
                    return
                }
            }
            if !isDragging {
                panel.orderOut(nil)
                switchGuideController.prepareForDismissal()
                switchPanel.orderOut(nil)
            }
            return
        }
        settingsMissingSince = nil
        didNotifySettingsClosed = false

        // 诊断:Settings 窗口重新出现
        if lastLoggedSettingsVisible != true {
            lastLoggedSettingsVisible = true
            log("Settings 窗口 lost→found")
        }

        if !hasActivatedSettings {
            hasActivatedSettings = true
            settingsApp.activate()
        }

        let frontmostBundle = NSWorkspace.shared.frontmostApplication?.bundleIdentifier
        let frontmostBlocked = !isDragging && frontmostBundle != kSystemSettingsBundleId
        if frontmostBlocked != lastLoggedFrontmostBlocked {
            lastLoggedFrontmostBlocked = frontmostBlocked
            log("frontmost 门状态变化: blocked=\(frontmostBlocked) frontmost=\(frontmostBundle ?? "nil")")
        }
        guard isDragging || frontmostBundle == kSystemSettingsBundleId else {
            panel.orderOut(nil)
            switchGuideController.prepareForDismissal()
            switchPanel.orderOut(nil)
            return
        }

        if presentation != lastLoggedPresentation {
            lastLoggedPresentation = presentation
            log("presentation 变化: \(presentation)")
        }

        switch presentation {
        case .hidden, .complete:
            panel.orderOut(nil)
            switchGuideController.prepareForDismissal()
            switchPanel.orderOut(nil)
            return
        case .switchGuide:
            // 开关阶段:switchPanel 仅在能算出 frame 时显示;
            // 主卡片面板(panel)无论是否有坐标都必须显示——AX 不可用时坐标本就 unavailable,
            // 不能因此把主卡片也藏掉,否则引导零 UI。
            if let desiredSwitchFrame = attachedSwitchGuideFrame(settingsFrame: settingsFrame) {
                if !NSEqualRects(switchPanel.frame, desiredSwitchFrame) {
                    switchPanel.setFrame(desiredSwitchFrame, display: switchPanel.isVisible, animate: false)
                }
                if !switchPanel.isVisible {
                    switchGuideController.prepareForDisplay()
                    switchPanel.orderFrontRegardless()
                }
            } else {
                // 拿不到开关坐标:只藏箭头 overlay,主卡片继续走下方统一显示路径
                switchGuideController.prepareForDismissal()
                switchPanel.orderOut(nil)
            }
        case .drag:
            switchGuideController.prepareForDismissal()
            switchPanel.orderOut(nil)
        }

        // 主卡片面板:.drag 与 .switchGuide 均走此路径
        let desiredFrame = attachedPanelFrame(settingsFrame: settingsFrame)
        if !NSEqualRects(panel.frame, desiredFrame) {
            panel.setFrame(desiredFrame, display: panel.isVisible, animate: false)
        }
        if !panel.isVisible && !isDragging {
            panel.orderFrontRegardless()
            onEvent?(.guideAttached(
                systemX: settingsFrame.origin.x, systemY: settingsFrame.origin.y,
                systemWidth: settingsFrame.width, systemHeight: settingsFrame.height,
                panelX: desiredFrame.origin.x, panelY: desiredFrame.origin.y
            ))
        }

        // 诊断:仅在可见性翻转时落盘
        let panelNowVisible = panel.isVisible
        if panelNowVisible != lastLoggedPanelVisible {
            lastLoggedPanelVisible = panelNowVisible
            log("panel 可见性变化: \(panelNowVisible)")
        }
        let switchNowVisible = switchPanel.isVisible
        if switchNowVisible != lastLoggedSwitchPanelVisible {
            lastLoggedSwitchPanelVisible = switchNowVisible
            log("switchPanel 可见性变化: \(switchNowVisible)")
        }
    }

    private func attachedPanelFrame(settingsFrame: NSRect) -> NSRect {
        var origin = NSPoint(
            x: settingsFrame.maxX - kHostSize.width,
            y: settingsFrame.minY - (kCardFrame.height - kSettingsOverlap) - kCardFrame.minY
        )
        if let screen = NSScreen.screens.first(where: { $0.frame.intersects(settingsFrame) }) {
            origin.x = min(max(origin.x, screen.visibleFrame.minX), screen.visibleFrame.maxX - kHostSize.width)
            origin.y = max(origin.y, screen.visibleFrame.minY - kCardFrame.minY)
        }
        return NSRect(origin: origin, size: kHostSize)
    }

    private func attachedSwitchGuideFrame(settingsFrame: NSRect) -> NSRect? {
        guard let switchTarget else { return nil }
        let scaleX = coordinateScale(external: switchWindowSize?.width, native: settingsFrame.width)
        let scaleY = coordinateScale(external: switchWindowSize?.height, native: settingsFrame.height)
        let target = NSPoint(
            x: settingsFrame.minX + switchTarget.x / scaleX,
            y: settingsFrame.maxY - switchTarget.y / scaleY
        )
        var origin = NSPoint(
            x: target.x - kSwitchTargetGap - kSwitchGuideSize.width,
            y: target.y - kSwitchGuideSize.height / 2
        )
        if let screen = NSScreen.screens.first(where: { $0.frame.intersects(settingsFrame) }) {
            origin.x = min(max(origin.x, screen.visibleFrame.minX), screen.visibleFrame.maxX - kSwitchGuideSize.width)
            origin.y = min(max(origin.y, screen.visibleFrame.minY), screen.visibleFrame.maxY - kSwitchGuideSize.height)
        }
        return NSRect(origin: origin, size: kSwitchGuideSize)
    }

    private func coordinateScale(external: CGFloat?, native: CGFloat) -> CGFloat {
        guard let external, native > 0 else { return 1 }
        let ratio = external / native
        return ratio > 1.25 ? ratio : 1
    }

    private func optionalFinite(_ v: CGFloat?) -> CGFloat? {
        guard let v, v.isFinite else { return nil }
        return v
    }
}

// MARK: - System Settings 窗口帧工具

/// 找到 System Settings 进程最大可见 layer-0 窗口的 AppKit 坐标系矩形。
private func systemSettingsWindowFrame(pid: pid_t) -> NSRect? {
    guard let rawList = CGWindowListCopyWindowInfo([.optionOnScreenOnly, .excludeDesktopElements], kCGNullWindowID)
        as? [[String: Any]] else { return nil }
    var candidates: [CGRect] = []
    for info in rawList {
        guard let ownerPID = info[kCGWindowOwnerPID as String] as? NSNumber,
              ownerPID.int32Value == pid,
              let layer = info[kCGWindowLayer as String] as? NSNumber,
              layer.intValue == 0,
              let bounds = info[kCGWindowBounds as String] as? [String: Any],
              let rect = CGRect(dictionaryRepresentation: bounds as CFDictionary),
              rect.width > 360,
              rect.height > 260 else { continue }
        candidates.append(rect)
    }
    guard let cgFrame = candidates.max(by: { $0.width * $0.height < $1.width * $1.height }) else {
        return nil
    }
    return appKitRect(fromQuartz: cgFrame)
}

/// 将 Quartz 坐标系矩形转换为 AppKit 坐标系矩形。
private func appKitRect(fromQuartz quartzRect: CGRect) -> NSRect {
    for screen in NSScreen.screens {
        guard let number = screen.deviceDescription[NSDeviceDescriptionKey("NSScreenNumber")]
            as? NSNumber else { continue }
        let displayBounds = CGDisplayBounds(CGDirectDisplayID(number.uint32Value))
        guard displayBounds.intersects(quartzRect) else { continue }
        let scale = max(
            1,
            min(screen.backingScaleFactor, displayBounds.width / max(screen.frame.width, 1))
        )
        return NSRect(
            x: screen.frame.minX + (quartzRect.minX - displayBounds.minX) / scale,
            y: screen.frame.maxY - (quartzRect.minY - displayBounds.minY) / scale
                - quartzRect.height / scale,
            width: quartzRect.width / scale,
            height: quartzRect.height / scale
        )
    }
    let desktopTop = NSScreen.screens.map(\.frame.maxY).max() ?? 0
    return NSRect(
        x: quartzRect.minX,
        y: desktopTop - quartzRect.maxY,
        width: quartzRect.width,
        height: quartzRect.height
    )
}

// MARK: - AX 开关定位

/**
 * 使用 AXUIElement API 定位 System Settings 中标签为 "Cindy Computer Use" 的复选框行。
 *
 * 本 companion 进程已通过 com.apple.systempreferences 的 Privacy & Security 面板
 * 获得辅助功能授权,因此可以直接调用 AX 接口而无需额外权限提示。
 * 若未获授权则返回 status:'unavailable'。
 *
 * 查找逻辑:
 *   1. 通过 AXUIElementCreateApplication(pid) 取 System Settings 的 AX 树根。
 *   2. 深度优先遍历,找到 role == AXCheckBox 且 label 去除可选的 "_Toggle" 后缀、
 *      忽略大小写等于 "cindy computer use" 的元素。
 *   3. 取其中心点相对于 Settings 窗口左上角的坐标,以及当前 value(开/关)。
 */
private func locateSwitchInSystemSettings() -> (status: String, payload: [String: Any]) {
    // 检查本进程是否已获辅助功能授权
    guard AXIsProcessTrusted() else {
        return (status: "unavailable", payload: [:])
    }

    // 找到 System Settings 进程
    guard let settingsApp = NSRunningApplication
        .runningApplications(withBundleIdentifier: kSystemSettingsBundleId)
        .first else {
        return (status: "not-found", payload: [:])
    }
    let pid = settingsApp.processIdentifier

    // 取 AX 应用根元素
    let axApp = AXUIElementCreateApplication(pid)

    // 取窗口列表
    var windowsRef: CFTypeRef?
    guard AXUIElementCopyAttributeValue(axApp, kAXWindowsAttribute as CFString, &windowsRef) == .success,
          let windows = windowsRef as? [AXUIElement],
          let mainWindow = windows.first else {
        return (status: "not-found", payload: [:])
    }

    // 取 Settings 窗口在屏幕坐标系的位置和尺寸
    var posRef: CFTypeRef?
    var sizeRef: CFTypeRef?
    guard AXUIElementCopyAttributeValue(mainWindow, kAXPositionAttribute as CFString, &posRef) == .success,
          AXUIElementCopyAttributeValue(mainWindow, kAXSizeAttribute as CFString, &sizeRef) == .success else {
        return (status: "not-found", payload: [:])
    }
    var windowPos = CGPoint.zero
    var windowSize = CGSize.zero
    // swiftlint:disable force_cast
    AXValueGetValue(posRef as! AXValue, .cgPoint, &windowPos)
    AXValueGetValue(sizeRef as! AXValue, .cgSize, &windowSize)
    // swiftlint:enable force_cast

    // 深度优先遍历 AX 树,查找目标复选框
    if let (elemPos, elemSize, isChecked) = findTargetCheckbox(in: mainWindow) {
        // 元素中心点相对于窗口左上角(屏幕 Y 轴向下递增)
        let centerX = (elemPos.x + elemSize.width / 2) - windowPos.x
        let centerY = (elemPos.y + elemSize.height / 2) - windowPos.y
        var payload: [String: Any] = [
            "x": centerX,
            "y": centerY,
            "windowWidth": windowSize.width,
            "windowHeight": windowSize.height,
        ]
        if let checked = isChecked {
            payload["value"] = checked
        }
        return (status: "found", payload: payload)
    }

    return (status: "not-found", payload: [:])
}

/// 深度优先递归查找标签匹配 "cindy computer use" 的 AXCheckBox 元素。
private func findTargetCheckbox(in element: AXUIElement) -> (pos: CGPoint, size: CGSize, value: Bool?)? {
    // 检查当前元素
    var roleRef: CFTypeRef?
    if AXUIElementCopyAttributeValue(element, kAXRoleAttribute as CFString, &roleRef) == .success,
       let role = roleRef as? String,
       role == kAXCheckBoxRole as String {
        var titleRef: CFTypeRef?
        let title: String
        if AXUIElementCopyAttributeValue(element, kAXTitleAttribute as CFString, &titleRef) == .success,
           let t = titleRef as? String {
            title = t
        } else {
            title = ""
        }
        // 去除可选 "_Toggle" 后缀后忽略大小写比较
        let normalized = title.replacingOccurrences(of: "_Toggle", with: "", options: [.caseInsensitive, .backwards])
        if normalized.lowercased() == "cindy computer use" {
            var posRef: CFTypeRef?
            var sizeRef: CFTypeRef?
            if AXUIElementCopyAttributeValue(element, kAXPositionAttribute as CFString, &posRef) == .success,
               AXUIElementCopyAttributeValue(element, kAXSizeAttribute as CFString, &sizeRef) == .success {
                var pos = CGPoint.zero
                var size = CGSize.zero
                // swiftlint:disable force_cast
                AXValueGetValue(posRef as! AXValue, .cgPoint, &pos)
                AXValueGetValue(sizeRef as! AXValue, .cgSize, &size)
                // swiftlint:enable force_cast
                var valueRef: CFTypeRef?
                var isChecked: Bool? = nil
                if AXUIElementCopyAttributeValue(element, kAXValueAttribute as CFString, &valueRef) == .success,
                   let v = valueRef as? Bool {
                    isChecked = v
                }
                return (pos, size, isChecked)
            }
        }
    }

    // 递归子元素
    var childrenRef: CFTypeRef?
    guard AXUIElementCopyAttributeValue(element, kAXChildrenAttribute as CFString, &childrenRef) == .success,
          let children = childrenRef as? [AXUIElement] else {
        return nil
    }
    for child in children {
        if let result = findTargetCheckbox(in: child) {
            return result
        }
    }
    return nil
}

// MARK: - 权限状态监控

/**
 * PermissionWatcher 定期采样本进程的 TCC 授权状态,在状态变化时触发回调。
 *
 * 采样的是 companion 进程自身的 TCC 授权(辅助功能 + 屏幕录制),
 * 这正是 cua-driver daemon 运行所需要的权限身份。
 */
private final class PermissionWatcher {
    private var timer: Timer?
    private var lastAccessibility: Bool? = nil
    private var lastScreenRecording: Bool? = nil

    /// 权限状态变化回调(在主线程上触发)
    var onChange: ((Bool, Bool) -> Void)?

    /// 启用监控:立即发送一次初始快照,随后仅在状态变化时触发
    func enable() {
        disable()
        // 立即发送初始快照
        let a = AXIsProcessTrusted()
        let s = CGPreflightScreenCaptureAccess()
        lastAccessibility = a
        lastScreenRecording = s
        onChange?(a, s)

        timer = Timer.scheduledTimer(withTimeInterval: kPermissionPollInterval, repeats: true) { [weak self] _ in
            self?.poll()
        }
    }

    /// 停止监控
    func disable() {
        timer?.invalidate()
        timer = nil
    }

    private func poll() {
        let a = AXIsProcessTrusted()
        let s = CGPreflightScreenCaptureAccess()
        // 仅在状态发生变化时才触发回调(边沿触发)
        if a != lastAccessibility || s != lastScreenRecording {
            lastAccessibility = a
            lastScreenRecording = s
            onChange?(a, s)
        }
    }
}

// MARK: - Control Socket 服务器

/**
 * ControlSocketServer 在指定 unix socket 路径上 listen,循环接受客户端连接
 * (Electron 主进程),以 NDJSON 进行双向通信。
 *
 * 连接建立后立即发出 hello 消息和当前 daemon-status 快照;随后转发 onDaemonStatus
 * 事件、响应 ping/shutdown 以及版本 2 新增的引导与传感器消息。
 * 客户端断开后回到 accept 等待下一个连接。
 * 收到 shutdown 后调用 onShutdownRequested 回调通知应用层。
 *
 * 同一时刻只支持单客户端;Electron dev 重启后新连接可正常复用现有 socket。
 *
 * 注意:客户端断开时必须关闭引导面板(guideCoordinator?.tearDown()),
 * 避免 Electron 进程终止后浮层孤立残留在 System Settings 上方。
 */
private final class ControlSocketServer {
    var onShutdownRequested: (() -> Void)?
    var onPing: ((Int64) -> Void)?
    var onGuideUpdate: ((GuideState) -> Void)?
    var onGuideDismiss: (() -> Void)?
    var onLocateSwitch: ((Int64) -> Void)?
    var onWatchPermissions: ((Bool) -> Void)?

    /// 由 delegate 注入的当前 daemon 状态提供器;在 socket 线程通过主线程 sync 取值
    var currentStatus: (() -> (running: Bool, pid: Int32?, restarts: Int))?

    private let socketPath: String
    private var serverFD: Int32 = -1
    private var clientFD: Int32 = -1
    private var readBuffer = Data()

    /// 伴随 companion 指纹(构建时写入,或按 bundle 路径哈希派生)
    let fingerprint: String

    init(socketPath: String, fingerprint: String) {
        self.socketPath = socketPath
        self.fingerprint = fingerprint
    }

    /// 绑定并开始 listen;阻塞在 accept,所以必须在后台线程调用
    func startListening() {
        let fm = FileManager.default
        if fm.fileExists(atPath: socketPath) {
            try? fm.removeItem(atPath: socketPath)
            log("ControlSocket: removed stale socket at \(socketPath)")
        }

        let parent = (socketPath as NSString).deletingLastPathComponent
        try? fm.createDirectory(atPath: parent, withIntermediateDirectories: true)

        serverFD = socket(AF_UNIX, SOCK_STREAM, 0)
        guard serverFD >= 0 else {
            log("ControlSocket: socket() failed: \(errno)")
            return
        }

        var addr = sockaddr_un()
        addr.sun_family = sa_family_t(AF_UNIX)
        let pathBytes = socketPath.utf8CString
        guard pathBytes.count <= MemoryLayout.size(ofValue: addr.sun_path) else {
            log("ControlSocket: socket path too long (\(pathBytes.count) bytes)")
            close(serverFD)
            serverFD = -1
            return
        }
        withUnsafeMutableBytes(of: &addr.sun_path) { buf in
            _ = pathBytes.withUnsafeBufferPointer { src in
                memcpy(buf.baseAddress!, src.baseAddress!, pathBytes.count)
            }
        }

        let bindResult = withUnsafePointer(to: &addr) { ptr in
            ptr.withMemoryRebound(to: sockaddr.self, capacity: 1) { sockPtr in
                bind(serverFD, sockPtr, socklen_t(MemoryLayout<sockaddr_un>.size))
            }
        }
        guard bindResult == 0 else {
            log("ControlSocket: bind() failed: \(errno)")
            close(serverFD)
            serverFD = -1
            return
        }

        guard listen(serverFD, 1) == 0 else {
            log("ControlSocket: listen() failed: \(errno)")
            close(serverFD)
            serverFD = -1
            return
        }

        log("ControlSocket: listening at \(socketPath)")

        // accept 循环:客户端断开后重新等待下一个连接
        while true {
            let fd = accept(serverFD, nil, nil)
            guard fd >= 0 else {
                log("ControlSocket: accept() returned \(errno) — stopping accept loop")
                break
            }
            clientFD = fd
            log("ControlSocket: client connected (fd=\(clientFD))")

            // 发出 hello
            DispatchQueue.main.async { [weak self] in
                self?.sendHello()
            }

            // 发出当前 daemon-status 快照
            if let provider = currentStatus {
                let snapshot = DispatchQueue.main.sync { provider() }
                send(.daemonStatus(running: snapshot.running, pid: snapshot.pid, restarts: snapshot.restarts))
            }

            // 阻塞读取直到客户端断开
            readLoop()

            // 客户端断开:关闭 fd、清空 readBuffer,回到 accept
            // 同时关闭引导面板,避免孤立浮层残留在 System Settings 上方
            if clientFD >= 0 { close(clientFD); clientFD = -1 }
            readBuffer.removeAll()
            DispatchQueue.main.async { [weak self] in
                self?.onGuideDismiss?()
                self?.onWatchPermissions?(false)
            }
            log("ControlSocket: ready to accept next connection")
        }
    }

    private func sendHello() {
        send(.hello(pid: Int32(ProcessInfo.processInfo.processIdentifier), fingerprint: fingerprint))
    }

    func sendDaemonStatus(running: Bool, pid: Int32?, restarts: Int) {
        send(.daemonStatus(running: running, pid: pid, restarts: restarts))
    }

    func sendPong(id: Int64) {
        send(.pong(id: id))
    }

    /// 向客户端写出一条 NDJSON 行;客户端未连接时静默忽略(与 daemon-status 一致)
    func sendMessage(_ msg: OutboundMessage) {
        send(msg)
    }

    private func send(_ msg: OutboundMessage) {
        guard clientFD >= 0, let data = ndjsonLine(msg.toDict()) else { return }
        data.withUnsafeBytes { bytes in
            _ = write(clientFD, bytes.baseAddress!, bytes.count)
        }
    }

    private func readLoop() {
        var buf = [UInt8](repeating: 0, count: 4096)
        while true {
            let n = read(clientFD, &buf, buf.count)
            if n <= 0 { break }
            readBuffer.append(contentsOf: buf.prefix(n))
            processBuffer()
        }
        log("ControlSocket: client disconnected")
    }

    private func processBuffer() {
        while let newlineIdx = readBuffer.firstIndex(of: 0x0A) {
            let lineData = readBuffer.prefix(upTo: newlineIdx)
            readBuffer.removeSubrange(...newlineIdx)
            guard !lineData.isEmpty else { continue }
            dispatchLine(lineData)
        }
    }

    private func dispatchLine(_ data: Data) {
        guard let json = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
              let type = json["type"] as? String else { return }

        let msg: InboundMessage
        switch type {
        case "ping":
            let id = json["id"] as? Int64 ?? (json["id"] as? Int).map { Int64($0) } ?? 0
            msg = .ping(id: id)
        case "shutdown":
            msg = .shutdown
        case "guide-update":
            // 解析引导状态;appBundlePath 为必填字段
            guard let stateDict = json["state"] as? [String: Any],
                  let bundlePath = stateDict["appBundlePath"] as? String else {
                log("ControlSocket: guide-update missing required state.appBundlePath — ignored")
                return
            }
            let state = GuideState(
                accessibilityGranted: stateDict["accessibilityGranted"] as? Bool ?? false,
                screenRecordingGranted: stateDict["screenRecordingGranted"] as? Bool ?? false,
                draggedAccessibility: stateDict["draggedAccessibility"] as? Bool ?? false,
                draggedScreenRecording: stateDict["draggedScreenRecording"] as? Bool ?? false,
                switchTargetX: (stateDict["switchTargetX"] as? NSNumber).map { CGFloat($0.doubleValue) },
                switchTargetY: (stateDict["switchTargetY"] as? NSNumber).map { CGFloat($0.doubleValue) },
                switchWindowWidth: (stateDict["switchWindowWidth"] as? NSNumber).map { CGFloat($0.doubleValue) },
                switchWindowHeight: (stateDict["switchWindowHeight"] as? NSNumber).map { CGFloat($0.doubleValue) },
                appBundlePath: bundlePath
            )
            msg = .guideUpdate(state: state)
        case "guide-dismiss":
            msg = .guideDismiss
        case "locate-switch":
            let id = json["id"] as? Int64 ?? (json["id"] as? Int).map { Int64($0) } ?? 0
            msg = .locateSwitch(id: id)
        case "watch-permissions":
            let enabled = json["enabled"] as? Bool ?? false
            msg = .watchPermissions(enabled: enabled)
        default:
            // 未知 type 忽略(协议扩展兼容)
            msg = .unknown
        }

        DispatchQueue.main.async { [weak self] in
            guard let self else { return }
            switch msg {
            case let .ping(id):
                log("ControlSocket: received ping id=\(id)")
                self.sendPong(id: id)
                self.onPing?(id)
            case .shutdown:
                log("ControlSocket: received shutdown")
                self.onShutdownRequested?()
            case let .guideUpdate(state):
                log("ControlSocket: received guide-update (appBundle=\(state.appBundlePath))")
                self.onGuideUpdate?(state)
            case .guideDismiss:
                log("ControlSocket: received guide-dismiss")
                self.onGuideDismiss?()
            case let .locateSwitch(id):
                log("ControlSocket: received locate-switch id=\(id)")
                self.onLocateSwitch?(id)
            case let .watchPermissions(enabled):
                log("ControlSocket: received watch-permissions enabled=\(enabled)")
                self.onWatchPermissions?(enabled)
            case .unknown:
                break
            }
        }
    }

    func cleanup() {
        if clientFD >= 0 { close(clientFD); clientFD = -1 }
        if serverFD >= 0 { close(serverFD); serverFD = -1 }
        try? FileManager.default.removeItem(atPath: socketPath)
        log("ControlSocket: cleaned up \(socketPath)")
    }
}

// MARK: - 应用代理

/**
 * CompanionApplicationDelegate 是整个 companion 进程的协调器。
 *
 * 启动流程:
 *   1. 解析命令行参数(--control-socket / --log-dir)
 *   2. 初始化日志
 *   3. 创建 DaemonSupervisor 并 start()
 *   4. 若有 --control-socket,在后台线程启动 ControlSocketServer.startListening()
 *
 * 关闭流程(shutdown 或 SIGTERM):
 *   1. 停止 daemon(SIGTERM + SIGKILL 兜底)
 *   2. 清理 socket
 *   3. NSApp.terminate(nil)
 */
private final class CompanionApplicationDelegate: NSObject, NSApplicationDelegate {
    private var supervisor: DaemonSupervisor?
    private var socketServer: ControlSocketServer?
    private var isShuttingDown = false

    /// 当前活跃的权限引导面板协调器(非 nil 表示面板显示中)
    private var guideCoordinator: PermissionGuideCoordinator?

    /// 权限状态监控
    private let permissionWatcher = PermissionWatcher()

    /// DispatchSource 引用;必须持有防止释放导致 source 停止
    private var sigtermSource: DispatchSourceSignal?
    private var sigintSource: DispatchSourceSignal?

    func applicationDidFinishLaunching(_ notification: Notification) {
        NSApp.setActivationPolicy(.accessory)

        let controlSocketPath = parseArg(key: "control-socket")
        let logDir = parseArg(key: "log-dir")

        if let dir = logDir {
            setupLogDirectory(at: dir)
        }

        let bundlePath = Bundle.main.bundlePath
        let enginePath = (bundlePath as NSString).appendingPathComponent(kEngineRelPath)
        let hostBundleId = Bundle.main.bundleIdentifier ?? "com.xd.cindy.computer-use"

        log("companion starting (pid=\(ProcessInfo.processInfo.processIdentifier))")
        log("bundle: \(bundlePath)")
        log("bundleId: \(hostBundleId)")
        log("engine: \(enginePath)")

        let daemonLogPath = logDir.map { ($0 as NSString).appendingPathComponent("companion-daemon.log") }

        let fingerprintPath = (bundlePath as NSString)
            .appendingPathComponent("Contents/Resources/.build-fingerprint")
        let fingerprint = (try? String(contentsOfFile: fingerprintPath, encoding: .utf8))?
            .trimmingCharacters(in: .whitespacesAndNewlines)
            ?? "unknown"

        let sup = DaemonSupervisor(
            enginePath: enginePath,
            daemonLogPath: daemonLogPath,
            hostBundleId: hostBundleId
        )
        supervisor = sup

        sup.onStatusChange = { [weak self] running, pid, restarts in
            log("DaemonStatus: running=\(running) pid=\(pid.map { "\($0)" } ?? "nil") restarts=\(restarts)")
            self?.socketServer?.sendDaemonStatus(running: running, pid: pid, restarts: restarts)
        }

        if let sockPath = controlSocketPath {
            let server = ControlSocketServer(socketPath: sockPath, fingerprint: fingerprint)
            socketServer = server

            server.onShutdownRequested = { [weak self] in
                self?.initiateShutdown()
            }
            server.onPing = { id in
                log("ping id=\(id) handled")
            }

            // 引导面板控制
            server.onGuideUpdate = { [weak self] state in
                self?.handleGuideUpdate(state)
            }
            server.onGuideDismiss = { [weak self] in
                self?.handleGuideDismiss()
            }

            // AX 开关定位(在全局并发队列执行,避免阻塞主线程 AX 树遍历)
            server.onLocateSwitch = { [weak self] id in
                guard let self else { return }
                DispatchQueue.global(qos: .userInitiated).async {
                    let result = locateSwitchInSystemSettings()
                    DispatchQueue.main.async {
                        self.socketServer?.sendMessage(.switchLocation(
                            id: id, status: result.status, payload: result.payload
                        ))
                    }
                }
            }

            // 权限状态监控
            server.onWatchPermissions = { [weak self] enabled in
                self?.handleWatchPermissions(enabled)
            }

            server.currentStatus = { [weak sup] in
                guard let sup else { return (running: false, pid: nil, restarts: 0) }
                let pid = sup.currentPid
                return (running: pid != nil, pid: pid, restarts: sup.restartCount)
            }

            DispatchQueue.global(qos: .utility).async { [weak server] in
                server?.startListening()
            }
        } else {
            log("no --control-socket specified; running daemon-only mode (for debugging)")
        }

        // 注册权限监控回调
        permissionWatcher.onChange = { [weak self] accessibility, screenRecording in
            self?.socketServer?.sendMessage(.permissionState(
                accessibility: accessibility, screenRecording: screenRecording
            ))
        }

        setupSignalHandlers()

        DispatchQueue.main.asyncAfter(deadline: .now() + 0.3) { [weak sup] in
            sup?.start()
        }
    }

    func applicationWillTerminate(_ notification: Notification) {
        if !isShuttingDown {
            isShuttingDown = true
            guideCoordinator?.tearDown()
            permissionWatcher.disable()
            supervisor?.stop()
            socketServer?.cleanup()
        }
    }

    // MARK: 引导面板处理

    private func handleGuideUpdate(_ state: GuideState) {
        let appURL = URL(fileURLWithPath: state.appBundlePath, isDirectory: true)
        if guideCoordinator == nil {
            // 首次 guide-update:创建协调器并启动面板
            let coordinator = PermissionGuideCoordinator(appURL: appURL)
            coordinator.onEvent = { [weak self] msg in
                self?.socketServer?.sendMessage(msg)
            }
            guideCoordinator = coordinator
            coordinator.start()
        }
        guideCoordinator?.apply(state)
    }

    private func handleGuideDismiss() {
        guideCoordinator?.tearDown()
        guideCoordinator = nil
        log("guide dismissed")
    }

    private func handleWatchPermissions(_ enabled: Bool) {
        if enabled {
            permissionWatcher.enable()
        } else {
            permissionWatcher.disable()
        }
    }

    private func initiateShutdown() {
        guard !isShuttingDown else { return }
        isShuttingDown = true
        log("initiating shutdown")
        guideCoordinator?.tearDown()
        permissionWatcher.disable()
        supervisor?.stop()
        socketServer?.cleanup()
        NSApp.terminate(nil)
    }

    private func setupSignalHandlers() {
        signal(SIGTERM, SIG_IGN)
        let termSource = DispatchSource.makeSignalSource(signal: SIGTERM, queue: .main)
        termSource.setEventHandler {
            log("received SIGTERM")
            NSApp.terminate(nil)
        }
        termSource.resume()
        sigtermSource = termSource

        signal(SIGINT, SIG_IGN)
        let intSource = DispatchSource.makeSignalSource(signal: SIGINT, queue: .main)
        intSource.setEventHandler {
            log("received SIGINT")
            NSApp.terminate(nil)
        }
        intSource.resume()
        sigintSource = intSource
    }
}

// MARK: - 入口

private let app = NSApplication.shared
private let delegate = CompanionApplicationDelegate()
app.delegate = delegate
app.run()
