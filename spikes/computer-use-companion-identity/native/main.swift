// CindyComputerUseSpike – companion identity spike harness
//
// Purpose: validate that daemon spawned as a child of this LaunchServices-started
// .app inherits TCC responsibility from this bundle (com.xd.cindy.computer-use.spike).
//
// Key facts from source research:
//  - cua-driver `serve` subcommand is the long-running daemon.
//  - When CUA_DRIVER_EMBEDDED=1 is set, daemon skips disclaim re-exec and stays
//    in the TCC responsibility chain of its parent (this .app).
//  - Without embedded mode: `serve` calls reexec_disclaimed_if_needed() which would
//    posix_spawn a new child with responsibility_spawnattrs_setdisclaim(attr, 1),
//    making the daemon its OWN responsible process and breaking inheritance.
//  - Socket: ~/Library/Caches/cua-driver/cua-driver.sock
//
// Usage: launched via `open -n -g` from run-spike.sh; no UI, no Dock icon (LSUIElement).

import Foundation
import AppKit

// MARK: - Paths

let bundleDir = Bundle.main.bundlePath
let spikeDir = (bundleDir as NSString).deletingLastPathComponent
let enginePath = (spikeDir as NSString).appendingPathComponent("engine/cua-driver")
let logsDir = (spikeDir as NSString).appendingPathComponent("logs")
let daemonLogPath = (logsDir as NSString).appendingPathComponent("daemon.log")
let companionLogPath = (logsDir as NSString).appendingPathComponent("companion.log")
let daemonPidPath = (logsDir as NSString).appendingPathComponent("daemon.pid")

// MARK: - Logging

let logDateFormatter: DateFormatter = {
    let f = DateFormatter()
    f.dateFormat = "yyyy-MM-dd HH:mm:ss.SSS"
    return f
}()

func log(_ msg: String) {
    let ts = logDateFormatter.string(from: Date())
    let line = "[\(ts)] [companion] \(msg)\n"
    if let data = line.data(using: .utf8) {
        // Append to log file
        if let fh = FileHandle(forWritingAtPath: companionLogPath) {
            fh.seekToEndOfFile()
            fh.write(data)
            fh.closeFile()
        }
    }
    // Also write to stderr for run-spike.sh to capture
    fputs(line, stderr)
}

func setupLogs() {
    let fm = FileManager.default
    try? fm.createDirectory(atPath: logsDir, withIntermediateDirectories: true)
    // Truncate log files
    fm.createFile(atPath: companionLogPath, contents: nil)
    fm.createFile(atPath: daemonLogPath, contents: nil)
}

// MARK: - Daemon lifecycle

var daemonProcess: Process?

func spawnDaemon() {
    guard FileManager.default.isExecutableFile(atPath: enginePath) else {
        log("ERROR: engine binary not found at \(enginePath)")
        NSApp.terminate(nil)
        return
    }

    log("Spawning daemon: \(enginePath) serve")
    log("Bundle: \(bundleDir)")
    log("Bundle id: com.xd.cindy.computer-use.spike")

    let proc = Process()
    proc.executableURL = URL(fileURLWithPath: enginePath)
    // `serve` is the long-running daemon subcommand.
    // `--no-permissions-gate` suppresses the startup TCC prompt gate so the
    // daemon starts without raising any permission dialogs during the smoke test.
    // The daemon still correctly reports TCC status via `permissions status --json`.
    proc.arguments = ["serve", "--no-permissions-gate"]

    // CUA_DRIVER_EMBEDDED=1: tells the daemon to skip responsibility disclaim
    // re-exec and remain in this .app's TCC responsibility chain.
    // CUA_DRIVER_HOST_BUNDLE_ID: advisory label echoed in check_permissions output.
    var env = ProcessInfo.processInfo.environment
    env["CUA_DRIVER_EMBEDDED"] = "1"
    env["CUA_DRIVER_HOST_BUNDLE_ID"] = "com.xd.cindy.computer-use.spike"
    // Suppress verbose telemetry output; daemon logs to stderr which we capture.
    env["CUA_LOG"] = "info"
    proc.environment = env

    // Redirect stdout+stderr to daemon log file
    let daemonLogUrl = URL(fileURLWithPath: daemonLogPath)
    FileManager.default.createFile(atPath: daemonLogPath, contents: nil)
    if let fh = FileHandle(forWritingAtPath: daemonLogPath) {
        proc.standardOutput = fh
        proc.standardError = fh
    }

    // Termination handler
    proc.terminationHandler = { p in
        let code = p.terminationStatus
        log("Daemon exited with code \(code). Terminating companion.")
        NSApp.terminate(nil)
    }

    do {
        try proc.run()
        daemonProcess = proc
        let pid = proc.processIdentifier
        log("Daemon started: pid=\(pid)")
        // Write pid for run-spike.sh
        try "\(pid)\n".write(toFile: daemonPidPath, atomically: true, encoding: .utf8)
    } catch {
        log("ERROR: failed to spawn daemon: \(error)")
        NSApp.terminate(nil)
    }
}

func teardown() {
    if let proc = daemonProcess, proc.isRunning {
        log("Terminating daemon pid=\(proc.processIdentifier)")
        proc.terminate()
        proc.waitUntilExit()
        log("Daemon exited.")
    }
    daemonProcess = nil
    try? FileManager.default.removeItem(atPath: daemonPidPath)
}

// MARK: - Signal handling

func setupSignalHandlers() {
    signal(SIGTERM) { _ in
        DispatchQueue.main.async {
            teardown()
            NSApp.terminate(nil)
        }
    }
    signal(SIGINT) { _ in
        DispatchQueue.main.async {
            teardown()
            NSApp.terminate(nil)
        }
    }
}

// MARK: - Application delegate

class AppDelegate: NSObject, NSApplicationDelegate {
    func applicationDidFinishLaunching(_ notification: Notification) {
        setupLogs()
        setupSignalHandlers()
        log("CindyComputerUseSpike launched (pid=\(ProcessInfo.processInfo.processIdentifier))")
        log("Will spawn daemon from: \(enginePath)")

        // Small delay to let LaunchServices finish establishing this process as
        // the responsible process before we spawn the child.
        DispatchQueue.main.asyncAfter(deadline: .now() + 0.5) {
            spawnDaemon()
        }
    }

    func applicationWillTerminate(_ notification: Notification) {
        teardown()
    }
}

// MARK: - Entry point

let app = NSApplication.shared
let delegate = AppDelegate()
app.delegate = delegate
app.run()
