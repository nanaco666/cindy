# Mobile Simulator Debugging

This guide is the fixed local loop for testing `apps/mobile` in an iOS
Simulator. It exists because Expo Go, the iOS development client, and TestFlight
look similar during manual testing but prove different things.

## Current Source Verification Contract

Before anyone claims "the simulator is already showing the new version", they
must produce evidence. The #1 time sink in mobile debugging is staring at a
**stale bundle from another worktree's Metro** and concluding "my change didn't
apply". Treat the following as a contract, not optional steps:

- **The native build number does NOT prove JS freshness.**
  `CFBundleVersion` / the version label only identify which native *development
  client* is installed. A pure JS/UI change (most edits) never bumps it. So a
  matching build number is necessary-but-not-sufficient.
- **JS freshness = which Metro the app is connected to.** With multiple mobile
  worktrees open, several Metro servers run at once and the app silently
  connects to whichever it last used (often `8081`, which is frequently a
  *different* branch). "The app opened" ≠ "it loaded my bundle".
- **Evidence required before trusting the simulator:**
  1. The `__DEV__` build label at the top of the new-session screen shows
     `branch · vX (build) · <metro host:port>`, and that branch is **your**
     branch. (Injected by `mobile:sim:start`; see below.)
  2. `pnpm mobile:sim:whoami` confirms the booted install + maps each Metro port
     to its worktree — the label's port must map to your worktree.
  3. The Metro terminal printed a fresh `iOS Bundled …` after your edit.

### Tools (use these instead of ad-hoc `lsof`/`PlistBuddy`/deep-link dances)

```bash
pnpm mobile:sim:start      # start THIS worktree's dev-client Metro; injects git
                           # branch/commit into the __DEV__ build label (EXPO_PUBLIC_*)
pnpm mobile:sim:whoami     # doctor: booted install + which port = which worktree
pnpm mobile:sim:rebuild    # rebuild + reinstall the native dev app (native changes only)
```

`mobile:sim:start` and `mobile:sim:rebuild` automatically ensure
`apps/mobile/.env` has the required online-login values, sourced from the
`production` env in `apps/mobile/eas.json`; you do not need to copy
`.env.example` by hand.

The new-session build label reads branch/commit from `EXPO_PUBLIC_XDT_GIT_*` (set by
`mobile:sim:start`) and the Metro host from `Constants.expoConfig.hostUri`. It is
`__DEV__`-only and compiled out of release builds. branch/commit are
intentionally NOT injected via `app.config.js`/`extra`: that would change the
`@expo/fingerprint` runtime version on every commit and break OTA. `EXPO_PUBLIC_*`
lives in the JS bundle and does not affect the fingerprint. The sim scripts also
live in the **root** `package.json` (`mobile:sim:*`), not
`apps/mobile/package.json`, because the latter's `scripts` field IS a fingerprint
input — adding a script there would bump the mobile runtime version.

### Multi-worktree Metro pitfall

- The debug app has **no `expo-dev-client` dependency**, so it only ever loads
  its compiled default packager port (`8081`) — a `xdmaker://expo-development-client/?url=…`
  deep link or a `--dev-client` "No apps connected" state will NOT switch it.
  Starting Metro on any other port leaves the app loading a stale `8081` bundle.
- Therefore `mobile:sim:start` **insists on `8081`** (never auto-bumps): if `8081`
  is held by *another* worktree it refuses and tells you to stop that Metro first
  (you can only run one mobile dev session at a time); if it's this worktree's own
  Metro it just says "already running". Use `mobile:sim:whoami` to see who owns
  each port. Override with `-- --port <p>` only if you'll point the app there yourself.

### Native build gotcha

- Do **not** build with `CODE_SIGNING_ALLOWED=NO` for runtime verification: the
  resulting app lacks the keychain entitlement, so `expo-secure-store` fails and
  login/storage break. Use `mobile:sim:rebuild` (signed debug build) instead.

## Runtime Choice

Use these runtimes for different jobs:

- Current source debugging: iOS development client, bundle id
  `com.xd.lizcn`, attached to Metro.
- Distribution validation: TestFlight. It does not consume local Metro changes.
- Expo Go: only for explicit Expo Go compatibility checks. It is not the normal
  regression target because this app depends on native config, secure storage,
  Feishu/Lark app handoff, audio, image picker, app scheme, and build-time iOS
  metadata.

When testing a code change, say "development client" or "TestFlight" explicitly.
Do not just say "the app".

## Clean Simulator Loop

From the mobile worktree:

```bash
cd /Users/dash/Code/Tools/xdt-maker-mobile-device-link
pnpm mobile:sim:start
```

Keep that Metro terminal open. In another terminal, install or run the native
development client:

```bash
pnpm --filter mobile ios -- --device "iPhone 17 Pro"
```

If the app is already installed and only JavaScript changed, reload instead of
reinstalling:

```bash
xcrun simctl terminate booted com.xd.lizcn || true
xcrun simctl launch booted com.xd.lizcn
```

Then press `r` in the Metro terminal, or open the Expo dev menu in the simulator
and choose Reload.

Reinstall only when native state or native config changed:

```bash
xcrun simctl uninstall booted com.xd.lizcn || true
pnpm --filter mobile ios -- --device "iPhone 17 Pro"
```

Native rebuilds are required after changes to `app.json`, app schemes, iOS
permissions, plugins, native modules, or `expo prebuild` output.

> Note (Xcode 26.5+): `pnpm --filter mobile ios` (`expo run:ios`) can fail device
> resolution with `xcodebuild: error: Unable to find a destination matching the
> provided destination specifier: { id:<udid> }`. On this Xcode, `expo`'s
> devicectl parsing breaks and xcodebuild only enumerates placeholder
> destinations, so a concrete simulator UDID never matches. Use the rebuild
> script instead — it builds against a generic simulator destination and installs
> via `simctl`, sidestepping device resolution:
>
> ```bash
> pnpm mobile:sim:rebuild           # rebuild + reinstall onto the booted simulator
> pnpm mobile:sim:rebuild -- --clean # uninstall first (clean login-state test)
> ```
>
> It passes `EXCLUDED_ARCHS=''` plus `ARCHS=<host sim arch>` (arm64 on Apple
> Silicon, x86_64 on Intel — derived from `process.arch`) to override the LarkSSO
> pod's simulator arm64 exclusion and build a binary the host's simulator can run
> (otherwise the app won't install / runs under Rosetta). Pure JS/TS changes never
> need this — Metro Fast Refresh covers them.

## Confirm The Installed Build

Before asking someone to retest, confirm which native app is installed:

```bash
xcrun simctl list devices booted
APP_CONTAINER="$(xcrun simctl get_app_container booted com.xd.lizcn app)"
/usr/libexec/PlistBuddy -c 'Print :CFBundleIdentifier' "$APP_CONTAINER/Info.plist"
/usr/libexec/PlistBuddy -c 'Print :CFBundleShortVersionString' "$APP_CONTAINER/Info.plist"
/usr/libexec/PlistBuddy -c 'Print :CFBundleVersion' "$APP_CONTAINER/Info.plist"
```

Expected values come from `apps/mobile/app.json`:

- `ios.bundleIdentifier`
- `version`
- `ios.buildNumber`

The native build number only proves native installation. For JavaScript
freshness, the Metro terminal must show a new bundle/reload after the source
change.

## Environment And Login

`EXPO_PUBLIC_*` values are read by Metro at bundle time. After changing
`apps/mobile/.env`, restart Metro and reload the app.
`mobile:sim:start` / `mobile:sim:rebuild` create or repair the required
functional values automatically from `eas.json`, without enabling dev-only flags.

Required online-login values:

```bash
EXPO_PUBLIC_FEISHU_APP_ID=...
EXPO_PUBLIC_XDT_API_BASE_URL=https://xdt-api.magiclizi.com
```

If the simulator starts already logged in, app data is still present. Use the app
logout path for normal testing, or uninstall the app for a clean login-state
test:

```bash
xcrun simctl uninstall booted com.xd.lizcn
pnpm --filter mobile ios -- --device "iPhone 17 Pro"
```

If Feishu login opens Safari and lands on `Cannot GET /api/auth/callback`, do
not assume the backend auth exchange failed yet. First check:

- The app is the development client, not Expo Go or TestFlight.
- The installed build contains the `lizcn` scheme.
- Metro was restarted after env changes.
- Metro logs show whether `WebBrowser.openAuthSessionAsync` returned success,
  cancel, or dismiss.

## Logs

Use Metro first for JavaScript warnings, React Navigation warnings, fetch
errors, auth errors, and Expo runtime warnings:

```bash
pnpm --filter mobile start -- --dev-client --host lan
```

Use the simulator system log for native crashes or native auth/session issues:

```bash
xcrun simctl spawn booted log stream --style compact --predicate 'process == "XDMaker"'
```

The in-app "Open debugger to view warnings" banner means a JavaScript warning is
active. Read Metro before changing UI code.

For device-link network symptoms, collect:

- Metro log around the symptom.
- The selected device id/name and connection state shown in the app.
- Desktop app logs if the controlled computer is involved.
- Server/device-link relay logs only when both mobile and desktop show relay
  symptoms.

## Keyboard, Rotation, And iPad

Virtual keyboard:

- Simulator menu: `I/O > Keyboard > Toggle Software Keyboard`
- Shortcut: `Cmd+K` in most Xcode Simulator versions

Rotation:

- Simulator toolbar rotate buttons
- Or `Device > Rotate Left` / `Device > Rotate Right`

iPad:

```bash
xcrun simctl list devices available | rg "iPad"
pnpm --filter mobile ios -- --device "<iPad simulator name>"
```

`apps/mobile/app.json` has `supportsTablet: true` and `orientation: default`, so
phone portrait, phone landscape, and iPad should all be treated as layout
regression targets.

## Common Failure Map

`Project is incompatible with this version of Expo Go`
: Wrong runtime. Use the development client for current source testing.

Missing `EXPO_PUBLIC_FEISHU_APP_ID`
: Metro did not see the env value. Run `pnpm mobile:sim:start` to repair
`apps/mobile/.env`, then restart Metro and reload the app.

`The action 'GO_BACK' was not handled`
: The screen called stack back without a previous route. Top-level and modal-like
screens need an explicit destination such as `/devices`.

Local source change is not visible
: Usually one of: wrong runtime, stale Metro bundle, TestFlight instead of
development client, or native rebuild required.

No controllable devices
: Wait for the initial device-list read to finish. If it remains empty, verify
same account, desktop online state, remote control enabled, and device-link
WebSocket connectivity.

Global "connecting" UI when only one device is slow
: Treat connection state as per-device UI. The device chip should show its own
connecting/offline/online state; the whole home screen should not block if other
devices are usable.

Keyboard covers the composer
: Reproduce with the software keyboard enabled, then inspect `KeyboardAvoidingView`
behavior, safe-area insets, and composer bottom spacing together. Do not validate
keyboard layout with only the hardware keyboard.

## Before Asking For Manual Retest

Run this checklist:

- Confirm the exact runtime: development client, Expo Go, or TestFlight.
- Confirm `CFBundleIdentifier`, `CFBundleShortVersionString`, and
  `CFBundleVersion`.
- Restart Metro after env changes.
- Reload the development client and watch Metro print a new bundle.
- Reinstall the development client after native config changes.
- Run `pnpm --filter mobile typecheck` when TypeScript changed.
- Run the narrow relevant test when there is one.
- Manually touch the exact path that regressed in the simulator.
- Tell the tester which simulator/device, runtime, and build were used.
