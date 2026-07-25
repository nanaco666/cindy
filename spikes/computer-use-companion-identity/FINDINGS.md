# Spike Findings: TCC Responsibility Inheritance via Companion Identity

**Date:** 2026-07-24  
**Engine version:** cua-driver-rs v0.12.3  
**SHA256 (arm64 binary):** `a0c5e34a35949ac0eb13775d7082282652206a16bf60a0653d3a994ab715166b`

---

## 1a. Daemon Startup Mechanism

Source: `responsibility.rs` (entire), `bundle.rs` (entire), `main.rs:283–501`

The `serve` subcommand is the long-running daemon. On macOS `main.rs:354` calls `responsibility::reexec_disclaimed_if_needed()`. That function uses Apple's private SPI `responsibility_spawnattrs_setdisclaim` to posix_spawn a copy of itself with responsibility disclaimed — making the daemon its **own** responsible process — then waits on the child and exits.

This disclaim re-exec is **suppressed** by any of (responsibility.rs:25–27):
```rust
fn should_skip_disclaim(embedded: bool, already_disclaimed: bool, inside_bundle: bool) -> bool {
    embedded || already_disclaimed || inside_bundle
}
```
- `embedded` = env var `CUA_DRIVER_EMBEDDED=1` (exact value `"1"`)
- `already_disclaimed` = `CUA_DRIVER_RS_RESPONSIBILITY_DISCLAIMED` present (set by first re-exec)
- `inside_bundle` = exe path contains `/CuaDriver.app/Contents/MacOS/` or `/CuaDriverLocal.app/Contents/MacOS/`

**Setting `CUA_DRIVER_EMBEDDED=1` suppresses the disclaim entirely — daemon stays in caller's responsibility chain.** The daemon does NOT check the embedding host's bundle path or ID. It does NOT register with launchd, use LaunchAgent plists, or self-exec back to `/Applications/CuaDriver.app`.

## 1b. CLI↔Daemon Communication & Discovery

Source: `serve.rs:1–27`, `cua-driver-core/src/daemon.rs:141–165`

Unix domain socket at `~/Library/Caches/cua-driver/cua-driver.sock` (macOS). Derived from namespace `"cua-driver"` (binary name is `cua-driver`, not `cua-driver-local`). Discovery is **path-based, not identity-based** — the CLI just connects to the socket file, no bundle ID check.

## 1c. Release Product Layout

Source: `_install-rust.sh:548–577`, tarball inspection

Tarball `cua-driver-rs-0.12.3-darwin-arm64.tar.gz` contains:
```
cua-driver-rs-0.12.3-darwin-arm64/
├── cua-driver                      ← bare CLI/daemon Mach-O (arm64)
├── CuaDriver.app/Contents/MacOS/cua-driver  ← same binary
├── libcua_driver_sdk.dylib
└── cua_driver_node_runtime.node
```
The `.app` is a minimal wrapper with `Info.plist` (`CFBundleIdentifier=com.trycua.driver`, `LSUIElement=true`) that gives LaunchServices TCC identity. For embedded use, only the bare `cua-driver` binary is needed.

## 1d. License

MIT License — Copyright 2025 Cua AI, Inc. Redistribution in binary form is permitted; license notice must be included.

## 1e. TCC API Call Points

Source: `platform-macos/src/tools/check_permissions.rs` (entire)

- **AXIsProcessTrusted** via `accessibility_granted()` — called at `check_permissions.rs:198`
- **CGPreflightScreenCaptureAccess** via `screen_recording_granted()` — `check_permissions.rs:199`
- **CGRequestScreenCaptureAccess** via `request_screen_recording()` — `check_permissions.rs:195–196`, gated by `!embedded_mode()` (`check_permissions.rs:192`)
- **SCShareableContent.get()** — live capture probe at `check_permissions.rs:36` (only with `prompt:true`) and actual screenshot path (`video_sckit.rs:80`)

In embedded mode, `check_permissions.rs:192` hard-disables all prompts. `permissions status --json` CLI command checks for `com.trycua.driver` attribution and reports `daemon_running: false` in embedded mode — this is expected. The correct read-only probe for embedded mode is `cua-driver call check_permissions '{"prompt":false}'`.

---

## 2. Binary

Version `0.12.3`, URL `https://github.com/trycua/cua/releases/download/cua-driver-rs-v0.12.3/cua-driver-rs-0.12.3-darwin-arm64.tar.gz`, SHA256 `a0c5e34a35949ac0eb13775d7082282652206a16bf60a0653d3a994ab715166b`, 47 MB arm64. Placed at `engine/cua-driver` (gitignored).

---

## 4. Smoke Validation

### ① Process tree / responsible process

```
ps -o pid,ppid,comm:
  24821    1   CindyComputerUseSpike   ← LaunchServices child (ppid=1, responsible=self)
  24825 24821  cua-driver              ← posix_spawn child of companion
```

Daemon's `check_permissions` response:
```json
"responsible_ppid": 24821,  // = companion PID
"embedded": true
```

Note: `launchctl procinfo` requires root on macOS 13+; responsible PID established via ps PPID chain + daemon's own `responsible_ppid` introspection field.

**PASS ①** — daemon's responsible process is CindyComputerUseSpike (PID 24821, `com.xd.cindy.computer-use.spike`).

### ② Client discovery

Full `cua-driver call check_permissions '{"prompt":false}'` response:
```json
{
  "accessibility": false,
  "screen_recording": false,
  "screen_recording_capturable": null,
  "direct_capture_status": "not_checked",
  "source": {
    "attribution": "host",
    "embedded": true,
    "host_bundle_id": "com.xd.cindy.computer-use.spike",
    "pid": 24825,
    "responsible_ppid": 24821,
    "disclaim_env": false,
    "note": "Embedded mode: these booleans reflect the HOST app's TCC grant..."
  }
}
```

- CLI connected to non-official-path daemon: confirmed
- Attribution `"host"` with `host_bundle_id: "com.xd.cindy.computer-use.spike"`: TCC inheritance confirmed from daemon's own introspection
- Permissions `false` (expected — no grants yet for spike bundle)

**PASS ②** — client discovers and connects to daemon; daemon reports correct host TCC attribution.

### ③ Stability (30 seconds)

Daemon PID 24825 alive at t=5,10,15,20,25,30s. No pid change, no re-exec. Final `check_permissions` at t=30s returned identical `responsible_ppid: 24821`.

**PASS ③** — daemon stable 30s, embedded mode suppression holds throughout.

---

## Gate Verdict

**归责继承路线: 可行 (CONFIRMED VIABLE)**

All three smoke conditions pass. `CUA_DRIVER_EMBEDDED=1` is the upstream-provided embedding API (documented in `Skills/cua-driver/EMBEDDING.md`, referenced at `cua-driver-core/src/lib.rs:18`). It suppresses disclaim re-exec, keeping the daemon in the companion app's responsibility chain. The CLI client discovers the daemon by socket path, not bundle identity.

---

## Remaining Steps Requiring User Cooperation

1. Grant TCC for `com.xd.cindy.computer-use.spike` in System Settings (Accessibility + Screen Recording) while the spike app is running
2. Verify `cua-driver call check_permissions '{"prompt":false}'` shows `accessibility: true, screen_recording: true`
3. Verify `cua-driver call computer_screenshot '{}'` returns a real screenshot
4. Cleanup: `tccutil reset Accessibility com.xd.cindy.computer-use.spike && tccutil reset ScreenCapture com.xd.cindy.computer-use.spike`

## §6 真机授权验证(2026-07-24,主会话与用户配合完成)

- 用户手动将 spike app 加入 辅助功能 + 屏幕录制 列表并开启开关(未触碰其它条目;本机无 CuaDriver/Codex 授权记录)。
- `check_permissions '{"prompt":false}'` → `accessibility: true, screen_recording: true`,`attribution: host, host_bundle_id: com.xd.cindy.computer-use.spike, responsible_ppid: 25106`。
- 真实动作(仅 spike 授权下):
  - `get_desktop_state` → 真实全屏截图,1470×956 pt / 2942×1912 px PNG。
  - `click {"x":700,"y":220,"scope":"desktop"}` → `path: cgevent_hid`,无权限错误。
  - `get_window_state {"pid":24629,"window_id":10276}`(System Settings)→ 完整 AX 树 173 elements(一期开关定位同款调用)。
  - `list_windows` → 返回真实窗口标题(屏幕录制实证)。
- daemon 在屏幕录制授权变更后未被杀,pid 25109 全程稳定。
- 清理:`tccutil reset Accessibility|ScreenCapture com.xd.cindy.computer-use.spike` + `stop-spike.sh`,无残留进程。

**GATE PASSED** — 归责继承路线可行,进入 Task 1。
