import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

describe('native e2e environment', () => {
  it('uses a Java 17 runtime for Maestro without requiring global shell changes', () => {
    const helper = readFileSync(resolve(process.cwd(), 'scripts/java-runtime-env.mjs'), 'utf8');
    const doctor = readFileSync(resolve(process.cwd(), 'scripts/native-e2e-doctor.mjs'), 'utf8');
    const runner = readFileSync(resolve(process.cwd(), 'scripts/maestro-e2e.mjs'), 'utf8');

    expect(helper).toContain('const MIN_JAVA_MAJOR = 17');
    expect(helper).toContain("brew', ['--prefix', 'openjdk@17']");
    expect(helper).toContain("'/usr/libexec/java_home', ['-v', version]");
    expect(helper).toContain('JAVA_HOME: javaHome');
    expect(helper).toContain("PATH: [join(javaHome, 'bin'), baseEnv.PATH]");
    expect(doctor).toContain("import { javaRuntimeDetail, resolveJavaRuntimeEnv } from './java-runtime-env.mjs';");
    expect(doctor).toContain('const toolEnv = resolveJavaRuntimeEnv(process.env);');
    expect(doctor).toContain("spawnSync('maestro', ['--version'], { encoding: 'utf8', env: toolEnv })");
    expect(runner).toContain("import { resolveJavaRuntimeEnv } from './java-runtime-env.mjs';");
    expect(runner).toContain('const toolEnv = resolveJavaRuntimeEnv(process.env);');
    expect(runner).toContain('...toolEnv');
    expect(runner).toContain("process.env.XDT_MOBILE_E2E_EXPO_LAUNCH_DELAY_MS ?? '20000'");
    expect(runner).toContain("process.env.XDT_MOBILE_E2E_EXPO_TERMINATE_BEFORE_OPEN ?? 'true'");
    expect(runner).toContain("process.env.XDT_MOBILE_E2E_EXPO_OPEN_BEFORE_TEST ?? 'true'");
    expect(runner).toContain("if (expoUrl && expoTerminateBeforeOpen === 'true') terminateExpoApp(platform);");
    expect(runner).toContain('function expoUrlWithRoute(url, route)');
    expect(runner).toContain('XDT_MOBILE_E2E_HOST_AUTOMATIONS_URL');
    expect(runner).toContain('function terminateExpoApp(platform)');
    expect(runner).toContain('function terminateApp(targetAppId, platform)');
    expect(runner).toContain('function launchNativeApp(targetAppId, platform)');
    expect(runner).toContain('terminateApp(appId, platform);');
    expect(runner).toContain('launchNativeApp(appId, platform);');
    expect(runner).toContain("MAESTRO_DRIVER_STARTUP_TIMEOUT: process.env.MAESTRO_DRIVER_STARTUP_TIMEOUT ?? '120000'");
    expect(runner).toContain("`XDT_MOBILE_E2E_EXPO_URL=${expoUrl ?? ''}`");
    expect(runner).toContain('sleepSync(expoLaunchDelayMs)');
  });

  it('opens the Expo target route before shared flows while cleaning native stale overlays', () => {
    const loginFlow = readFileSync(resolve(process.cwd(), 'e2e/maestro/login_mock_no_clear.yaml'), 'utf8');
    const loginLaunchFlow = readFileSync(resolve(process.cwd(), 'e2e/maestro/login_mock.yaml'), 'utf8');
    const openSessionFlow = readFileSync(resolve(process.cwd(), 'e2e/maestro/open_session.yaml'), 'utf8');
    const openSessionNoLaunchFlow = readFileSync(resolve(process.cwd(), 'e2e/maestro/open_session_no_launch.yaml'), 'utf8');
    const messageSelectionFlow = readFileSync(resolve(process.cwd(), 'e2e/maestro/message_selection.yaml'), 'utf8');
    const filePreviewFlow = readFileSync(resolve(process.cwd(), 'e2e/maestro/file_preview.yaml'), 'utf8');
    const visualOfflineFlow = readFileSync(resolve(process.cwd(), 'e2e/maestro/visual_session_offline.yaml'), 'utf8');

    expect(loginFlow).toContain('id: "devices.screen"');
    expect(loginFlow).toContain('id: "session.backButton"');
    expect(loginFlow).toContain('text: "^允许$"');
    expect(loginFlow).not.toContain('text: "Continue"');
    expect(loginFlow).not.toContain('text: "Close"');
    expect(loginLaunchFlow).not.toContain('openLink');
    expect(loginLaunchFlow).toContain('- runFlow: login_mock_no_clear.yaml');
    for (const flow of [openSessionFlow, openSessionNoLaunchFlow]) {
      expect(flow).toContain('id: "connection.syncButton"');
      expect(flow).toContain('optional: true');
      expect(flow).toContain('Sync devices when the connection row is visible');
    }
    expect(openSessionFlow).toContain('Open the recent Expo Go XDMaker project if launchApp lands on Expo Home');
    expect(openSessionFlow).toContain('text: "XDMaker"');
    expect(openSessionFlow).toContain('waitForAnimationToEnd');
    expect(loginFlow).toContain('waitForAnimationToEnd');
    expect(messageSelectionFlow).toContain('- runFlow: open_session_no_launch.yaml');
    expect(messageSelectionFlow).not.toContain('- runFlow: open_session.yaml');
    expect(filePreviewFlow).toContain('- runFlow: open_session_no_launch.yaml');
    expect(filePreviewFlow).not.toContain('- runFlow: open_session.yaml');
    expect(visualOfflineFlow).toContain('id: "session.composerInput"');
    expect(visualOfflineFlow).toContain('- eraseText');
    expect(visualOfflineFlow).toContain('- inputText: "Offline visual draft"');
    expect(visualOfflineFlow).toContain('- hideKeyboard');
    expect(visualOfflineFlow).toContain('id: "session.sendButton"');
    expect(visualOfflineFlow).not.toContain('session.collaborationReadOnlyComposer');
  });

  it('can own the Expo lifecycle for iOS local runtime smoke', () => {
    const packageJson = readFileSync(resolve(process.cwd(), 'package.json'), 'utf8');
    const localSmoke = readFileSync(resolve(process.cwd(), 'scripts/local-device-link-smoke.mjs'), 'utf8');

    expect(packageJson).toContain('"test:e2e:local:ios"');
    expect(packageJson).toContain('--start-server --start-expo --mock-host --profile ios-iphone-17-pro-expo-go');
    expect(packageJson).toContain('"test:e2e:local:voice:ios:credential"');
    expect(packageJson).toContain('--voice-credential-from-device --voice-cloud-preflight');
    expect(localSmoke).toContain("if (arg === '--start-expo')");
    expect(localSmoke).toContain("if (arg === '--no-mock-audio')");
    expect(localSmoke).toContain("const useMockAudio = voiceProxySelected && !options.noMockAudio;");
    expect(localSmoke).toContain("if (arg === '--voice-cloud-preflight')");
    expect(localSmoke).toContain("if (arg === '--voice-cloud-all-candidates')");
    expect(localSmoke).toContain("if (arg === '--voice-credential-from-device')");
    expect(localSmoke).toContain("if (arg === '--voice-credential-file')");
    expect(localSmoke).toContain("if (arg === '--voice-credential-target-device-id')");
    expect(localSmoke).toContain('function runVoiceCredentialFetch()');
    expect(localSmoke).toContain('runNodeScript(fetchVoiceCredentialScript, args);');
    expect(localSmoke).toContain("...(voiceCredentialFile ? ['--voice-credential-file', voiceCredentialFile] : [])");
    expect(localSmoke).toContain('const voiceCredentialTargetDeviceId = options.voiceCredentialTargetDeviceId');
    expect(localSmoke).toContain('?? (options.mockHost && willFetchVoiceCredential ? mockHostDeviceId : undefined)');
    expect(localSmoke).toContain("...(voiceCredentialTargetDeviceId ? ['--target-device-id', voiceCredentialTargetDeviceId] : [])");
    expect(localSmoke).toContain('const hasProvidedVoiceCredentialOverride');
    expect(localSmoke).toContain('!hasProvidedVoiceCredentialOverride ? resolveVoiceProxyBaseUrl(platform, voiceProxyPort) : null');
    expect(localSmoke).toContain("import { existsSync, readFileSync, unlinkSync } from 'node:fs';");
    expect(localSmoke).toContain('if (existsSync(generatedVoiceCredentialFile)) unlinkSync(generatedVoiceCredentialFile);');
    expect(localSmoke).toContain('expectedControllableDeviceId: options.mockHost ? mockHostDeviceId : undefined');
    expect(localSmoke).toContain('function isControllableDevice(device)');
    expect(localSmoke).toContain('function runVoiceCloudPreflight()');
    expect(localSmoke).toContain("...(options.voiceCloudAllCandidates ? ['--all-candidates'] : [])");
    expect(localSmoke).toContain('preflightEnv.XDT_MOBILE_VOICE_PROXY_BASE_URL = voiceProxyBaseUrl;');
    expect(localSmoke).toContain("preflightEnv.XDT_MOBILE_VOICE_PROXY_API_KEY = 'sk-mock-mobile-voice-key';");
    expect(localSmoke).toContain('runNodeScript(voiceCloudPreflightScript, args, preflightEnv);');
    expect(localSmoke).toContain('if (willFetchVoiceCredential) {');
    expect(localSmoke).toContain('startMockHostProcess(apiBase, mockHostDeviceId, mockHostScenario, mockHostRealDb, voiceProxyBaseUrl, null);');
    expect(localSmoke).toContain('await stopMockHost.ready;');
    expect(localSmoke.indexOf('startMockHostProcess(apiBase, mockHostDeviceId, mockHostScenario, mockHostRealDb, voiceProxyBaseUrl, null);')).toBeLessThan(
      localSmoke.indexOf('runVoiceCredentialFetch();'),
    );
    expect(localSmoke.indexOf('await stopMockHost.ready;')).toBeLessThan(
      localSmoke.indexOf('runVoiceCredentialFetch();'),
    );
    expect(localSmoke).toContain('function startMockHostProcess(baseUrl, hostDeviceId, scenario, realDbPath, voiceProxyUrl, voiceCredentialFile)');
    expect(localSmoke).toContain('mock host did not become ready within');
    expect(localSmoke).toContain("line.includes('mock-device-link-host ready')");
    expect(localSmoke).toContain('async function stopActiveMockHost()');
    expect(localSmoke.indexOf('await stopActiveMockHost();')).toBeLessThan(
      localSmoke.indexOf('if (options.mockHost) await cleanupE2eDeviceRecords(apiBase, mockHostDeviceId);'),
    );
    expect(localSmoke).toContain('if (!willFetchVoiceCredential) {');
    expect(localSmoke).toContain('async function startExpoProcess(url)');
    expect(localSmoke).toContain('async function assertExpoReady(url');
    expect(localSmoke).toContain('Expo Go native E2E needs Metro before Maestro opens the app.');
    expect(localSmoke).toContain('EXPO_PUBLIC_XDT_API_BASE_URL: apiBase');
    expect(localSmoke).toContain("&& (flowSuite === 'visual' || flowSuite === 'full' || flowSuite === 'file' || flowSuite === 'automations')");
    expect(localSmoke).toContain("flowSuite === 'visual' ? `${mockHostDeviceId}-${flowSlug(flow)}` : mockHostDeviceId");
    expect(localSmoke).toContain("if (flowSuite === 'full' && flow === 'fixture_controls_smoke.yaml') return 'controls';");
    expect(localSmoke).toContain("if (suite === 'controls') return 'controls';");
  });

  it('can run the iOS smoke against local desktop SQLite data without hardcoding a user path', () => {
    const packageJson = readFileSync(resolve(process.cwd(), 'package.json'), 'utf8');
    const mockHost = readFileSync(resolve(process.cwd(), 'scripts/mock-device-link-host.mjs'), 'utf8');

    expect(packageJson).toContain('"test:e2e:local:real-db:ios"');
    expect(packageJson).toContain('--mock-host-real-db auto');
    expect(mockHost).toContain('function resolveRealDbPath(dbPath, Database)');
    expect(mockHost).toContain("rawPath && rawPath !== 'auto'");
    expect(mockHost).toContain("path.join(home, 'Library', 'Application Support', 'xdt-maker')");
    expect(mockHost).toContain("path.join(appData, 'xdt-maker')");
    expect(mockHost).toContain('--real-db auto could not find a readable XDMaker SQLite DB with sessions');
  });

  it('can run reconnect smoke as a self-contained local relay gate', () => {
    const packageJson = readFileSync(resolve(process.cwd(), 'package.json'), 'utf8');
    const reconnectSmoke = readFileSync(resolve(process.cwd(), 'scripts/device-link-reconnect-smoke.mjs'), 'utf8');

    expect(packageJson).toContain('"test:e2e:reconnect:local": "node scripts/device-link-reconnect-smoke.mjs --start-server"');
    expect(reconnectSmoke).toContain("if (arg === '--start-server')");
    expect(reconnectSmoke).toContain('function startServerProcess()');
    expect(reconnectSmoke).toContain("XDT_DEV_AUTH_ENABLED: process.env.XDT_DEV_AUTH_ENABLED ?? '1'");
    expect(reconnectSmoke).toContain('Or pass --start-server.');
  });

  it('keeps real cloud voice preflight opt-in and secret-redacted', () => {
    const packageJson = readFileSync(resolve(process.cwd(), 'package.json'), 'utf8');
    const preflight = readFileSync(resolve(process.cwd(), 'scripts/mobile-voice-cloud-preflight.mjs'), 'utf8');
    const doctor = readFileSync(resolve(process.cwd(), 'scripts/mobile-voice-real-desktop-doctor.mjs'), 'utf8');
    const mockVoiceProxy = readFileSync(resolve(process.cwd(), 'scripts/mock-voice-proxy.mjs'), 'utf8');
    const mockHost = readFileSync(resolve(process.cwd(), 'scripts/mock-device-link-host.mjs'), 'utf8');
    const fetchCredential = readFileSync(resolve(process.cwd(), 'scripts/fetch-mobile-voice-credential.mjs'), 'utf8');
    const localDesktopCredential = readFileSync(resolve(process.cwd(), 'scripts/export-local-desktop-voice-credential.mjs'), 'utf8');
    const relaySmoke = readFileSync(resolve(process.cwd(), 'scripts/local-desktop-voice-credential-relay-smoke.mjs'), 'utf8');
    const realCloudSmoke = readFileSync(resolve(process.cwd(), 'scripts/mobile-voice-real-cloud-smoke.mjs'), 'utf8');
    const readme = readFileSync(resolve(process.cwd(), 'README.md'), 'utf8');

    expect(packageJson).toContain('"test:voice-cloud:preflight": "node scripts/mobile-voice-cloud-preflight.mjs"');
    expect(packageJson).toContain('"test:voice-cloud:preflight:run": "node scripts/mobile-voice-cloud-preflight.mjs --run"');
    expect(packageJson).toContain('"test:voice-cloud:doctor": "node scripts/mobile-voice-real-desktop-doctor.mjs"');
    expect(packageJson).toContain('"voice:credential:local-desktop": "node scripts/export-local-desktop-voice-credential.mjs"');
    expect(packageJson).toContain('"voice:credential:fetch": "node scripts/fetch-mobile-voice-credential.mjs"');
    expect(packageJson).toContain('"test:voice-cloud:local-desktop-relay": "node scripts/local-desktop-voice-credential-relay-smoke.mjs"');
    expect(packageJson).toContain('"test:voice-cloud:device": "node scripts/mobile-voice-real-cloud-smoke.mjs"');
    expect(packageJson).toContain('"test:voice-cloud:device:run": "node scripts/mobile-voice-real-cloud-smoke.mjs --run"');
    expect(preflight).toContain('dry run passed; add --run to call the cloud endpoints');
    expect(preflight).toContain('XDT_MOBILE_VOICE_CREDENTIAL_JSON');
    expect(preflight).toContain('XDT_MOBILE_VOICE_PROXY_API_KEY');
    expect(preflight).toContain('XDT_MOBILE_VOICE_PREFLIGHT_ALL_CANDIDATES');
    expect(preflight).toContain("if (arg === '--all-candidates')");
    expect(preflight).toContain('async function preflightAsrCandidates');
    expect(preflight).toContain('async function preflightRefinerCandidates');
    expect(preflight).toContain("credentialAsrChain(credential).slice(0, 1)");
    expect(preflight).toContain("credentialRefinerChain(credential).slice(0, 1)");
    expect(preflight).toContain('mobileRealtimeAsrUnsupportedReason');
    expect(preflight).toContain('asr.mode is not supported for mobile realtime preflight');
    expect(preflight).toContain("validateProviderChain(credential, 'asrProviderChain'");
    expect(preflight).toContain("validateProviderChain(credential, 'refinerProviderChain'");
    expect(preflight).toContain('function credentialAsrChain(credential)');
    expect(preflight).toContain('function credentialRefinerChain(credential)');
    expect(preflight).toContain("const primary = normalized.split(/[-_]/)[0];");
    expect(preflight).toContain("case 'mandarin':");
    expect(preflight).toContain('function redactionCandidates(secret)');
    expect(preflight).not.toContain('console.log(credential.proxyApiKey');
    expect(preflight).not.toContain('console.warn(credential.proxyApiKey');
    expect(preflight).not.toContain('console.error(credential.proxyApiKey');
    expect(fetchCredential).toContain("const DL_VOICE_CREDENTIAL_SYNC_CHANNEL = 'device-link:voice:credential-sync';");
    expect(fetchCredential).toContain('XDT_MOBILE_AUTH_ACCESS_TOKEN_FILE');
    expect(fetchCredential).toContain("console.log(`- auth: ${accessTokenOverride ? 'provided access token' : 'local dev-login'}`);");
    expect(fetchCredential).toContain('pnpm restart:desktop:local');
    expect(fetchCredential).toContain('stops existing XDMaker desktop dev processes');
    expect(fetchCredential).toContain('constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY, 0o600');
    expect(fetchCredential).toContain('chmodSync(path, 0o600);');
    expect(fetchCredential).toContain('function cleanupDevSession(accessToken)');
    expect(fetchCredential).toContain("label: 'fetcher device cleanup'");
    expect(fetchCredential).toContain("label: 'fetcher logout'");
    expect(fetchCredential).toContain('process.exitCode = 1;');
    expect(fetchCredential).not.toContain('process.exit(1)');
    expect(fetchCredential).toContain("console.log(`- proxy: ${redactUrl(credential.proxyBaseUrl)}`);");
    expect(fetchCredential).toContain("assertProviderChainShape(credential, 'asrProviderChain'");
    expect(fetchCredential).toContain("assertProviderChainShape(credential, 'refinerProviderChain'");
    expect(fetchCredential).toContain("credentialProviderChain(credential, 'asrProviderChain', credential.asr)");
    expect(fetchCredential).toContain("credentialProviderChain(credential, 'refinerProviderChain', credential.refiner)");
    expect(fetchCredential).toContain('function redactionCandidates(secret)');
    expect(fetchCredential).not.toContain('console.log(credential');
    expect(fetchCredential).not.toContain('console.warn(credential');
    expect(fetchCredential).not.toContain('console.error(credential');
    expect(fetchCredential).not.toContain('console.log(fetchedCredential');
    expect(fetchCredential).not.toContain('console.warn(fetchedCredential');
    expect(fetchCredential).not.toContain('console.error(fetchedCredential');
    expect(localDesktopCredential).toContain('export-local-desktop-voice-credential passed');
    expect(localDesktopCredential).toContain("app.setName('xdt-maker');");
    expect(localDesktopCredential).toContain("app.setPath('userData', userDataDir);");
    expect(localDesktopCredential).toContain("join(userDataDir, 'safe-storage', 'api_key.enc')");
    expect(localDesktopCredential).toContain('constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY, 0o600');
    expect(localDesktopCredential).toContain('chmodSync(pathname, 0o600);');
    expect(localDesktopCredential).toContain('rmSync(outputPath, { force: true });');
    expect(localDesktopCredential).toContain("runNode(preflightScript, [");
    expect(localDesktopCredential).toContain("...(options.allCandidates ? ['--all-candidates'] : [])");
    expect(localDesktopCredential).toContain('let credentialForRedaction = null;');
    expect(localDesktopCredential).toContain('credentialForRedaction = { proxyApiKey: apiKey };');
    expect(localDesktopCredential).toContain('credentialForRedaction = credential;');
    expect(localDesktopCredential).toContain('redactError(error, credentialForRedaction)');
    expect(localDesktopCredential).toContain('function redactionCandidates(secret)');
    expect(localDesktopCredential).not.toContain('spawn(pnpmBin()');
    expect(localDesktopCredential).not.toContain('dev:desktop');
    expect(localDesktopCredential).not.toContain('restart:desktop');
    expect(localDesktopCredential).not.toContain('console.log(credential');
    expect(localDesktopCredential).not.toContain('console.warn(credential');
    expect(localDesktopCredential).not.toContain('console.error(credential');
    expect(relaySmoke).toContain('export-local-desktop-voice-credential.mjs');
    expect(relaySmoke).toContain('fetch-mobile-voice-credential.mjs');
    expect(relaySmoke).toContain('mobile-voice-cloud-preflight.mjs');
    expect(relaySmoke).toContain('mock-device-link-host.mjs');
    expect(relaySmoke).toContain("XDT_MOBILE_VOICE_CREDENTIAL_FILE: sourceCredentialFile");
    expect(relaySmoke).toContain("'--voice-credential-file'");
    expect(relaySmoke).toContain("'--target-device-id'");
    expect(relaySmoke).toContain('fetchedCredentialFile');
    expect(relaySmoke).toContain('cleanupFile(sourceCredentialFile, shouldCleanupSource);');
    expect(relaySmoke).toContain('cleanupFile(fetchedCredentialFile, shouldCleanupFetched);');
    expect(relaySmoke).toContain('desktop process: not started or restarted');
    expect(relaySmoke).toContain('pnpm dev:server');
    expect(relaySmoke).not.toContain('restart:desktop');
    expect(relaySmoke).not.toContain('dev:desktop');
    expect(relaySmoke).not.toContain('console.log(credential');
    expect(relaySmoke).not.toContain('console.warn(credential');
    expect(relaySmoke).not.toContain('console.error(credential');
    expect(realCloudSmoke).toContain('mobile-voice-real-cloud-smoke dry run');
    expect(realCloudSmoke).toContain("if (arg === '--all-candidates')");
    expect(realCloudSmoke).toContain("...(options.allCandidates ? ['--all-candidates'] : [])");
    expect(realCloudSmoke).toContain("if (arg === '--list-devices')");
    expect(realCloudSmoke).toContain('mobile-voice-real-cloud-smoke device list');
    expect(realCloudSmoke).toContain('Pass --target-device-id <deviceId> when running the real cloud smoke.');
    expect(realCloudSmoke).toContain('Add --run to fetch the desktop credential and call ASR/refine cloud endpoints.');
    expect(realCloudSmoke).toContain("Use --list-devices first if more than one desktop may be online.");
    expect(realCloudSmoke).toContain("if (arg === '--start-server')");
    expect(realCloudSmoke).toContain('function startServerProcess()');
    expect(realCloudSmoke).toContain('function devLogin(deviceId)');
    expect(realCloudSmoke).toContain('function fetchDevices(accessToken)');
    expect(realCloudSmoke).toContain('function isControllableDevice(device)');
    expect(realCloudSmoke).toContain('function isRealDesktopCandidate(device)');
    expect(realCloudSmoke).toContain('function isFixtureDevice(device)');
    expect(realCloudSmoke).toContain('target is a real desktop, not a mobile E2E/mock fixture');
    expect(realCloudSmoke).toContain('mobile-voice-real-cloud-smoke target:');
    expect(realCloudSmoke).toContain('appVersion=');
    expect(realCloudSmoke).toContain("target.deviceId");
    expect(realCloudSmoke).toContain("XDT_DEV_AUTH_ENABLED: process.env.XDT_DEV_AUTH_ENABLED ?? '1'");
    expect(realCloudSmoke).toContain('mobile-voice-real-cloud-smoke server ready');
    expect(realCloudSmoke).toContain("const serverKillPortScript = resolve(repoRoot, 'scripts/kill-port.mjs');");
    expect(realCloudSmoke).toContain('function cleanupServerPort()');
    expect(realCloudSmoke).toContain('unlinkSync(credentialFile);');
    expect(realCloudSmoke).toContain("runNode(fetchCredentialScript, [");
    expect(realCloudSmoke).toContain("...(options.controllerDeviceId ? ['--controller-device-id', options.controllerDeviceId] : [])");
    expect(realCloudSmoke).toContain("runNode(preflightScript, [");
    expect(doctor).toContain('mobile-voice-real-desktop-doctor');
    expect(doctor).toContain('fetch credential:');
    expect(doctor).toContain("if (arg === '--fetch-credential')");
    expect(doctor).toContain("if (arg === '--start-server')");
    expect(doctor).toContain('runCredentialFetch(target.deviceId)');
    expect(doctor).toContain('fetch-mobile-voice-credential.mjs');
    expect(doctor).toContain('unlinkSync(credentialFile);');
    expect(doctor).toContain('pnpm restart:desktop:local');
    expect(doctor).toContain('function startServerProcess()');
    expect(doctor).toContain("XDT_DEV_AUTH_ENABLED: process.env.XDT_DEV_AUTH_ENABLED ?? '1'");
    expect(doctor).toContain('function cleanupServerPort()');
    expect(doctor).toContain('function isRealDesktopCandidate(device)');
    expect(doctor).toContain('function isFixtureDevice(device)');
    expect(doctor).toContain('target is a real desktop, not a mobile E2E/mock fixture');
    expect(doctor).toContain('appVersion=');
    expect(doctor).not.toContain('dev:desktop');
    expect(readme).toContain('pnpm --filter mobile test:voice-cloud:device -- --list-devices --api-base http://localhost:3333');
    expect(readme).toContain('pnpm --filter mobile test:voice-cloud:doctor -- --start-server --api-base http://localhost:3333 --fetch-credential');
    expect(readme).toContain('pnpm --filter mobile test:voice-cloud:local-desktop-relay -- --user-data-dir "$HOME/Library/Application Support/xdt-maker" --all-candidates');
    expect(readme).toContain('pnpm --filter mobile test:voice-cloud:device:run -- --api-base http://localhost:3333 --target-device-id <desktop-device-id>');
    expect(readme).toContain('--all-candidates');
    expect(readme).toContain('--voice-cloud-all-candidates');
    expect(readme).toContain('voice:credential:local-desktop');
    expect(readme).toContain('It does not open or restart desktop and does not prove the device-link relay path');
    expect(readme).toContain('This restart command stops existing XDMaker desktop dev processes.');
    expect(mockVoiceProxy).toContain("url.pathname !== '/dashscope/api-ws/v1/realtime'");
    expect(mockHost).toContain('function loadVoiceCredentialOverride(file, rawJson)');
    expect(mockHost).toContain("if (arg === '--voice-credential-file')");
    expect(mockHost).toContain("console.log('- voice credential override: configured')");
    expect(mockHost).toContain('asrProviderChain');
    expect(mockHost).toContain('refinerProviderChain');
    expect(mockHost).toContain("case 'device-link:voice:dictionary-learning':");
    expect(mockHost).toContain("ignoreReason: 'mock-host'");
    expect(mockHost).toContain('function assertVoiceCredentialChain(credential, property, requiredFields)');
    expect(mockHost).not.toContain('console.log(voiceCredentialOverride');
    expect(mockHost).not.toContain('console.warn(voiceCredentialOverride');
    expect(mockHost).not.toContain('console.error(voiceCredentialOverride');
  });

  it('clears local mobile voice credentials on logout', () => {
    const authContext = readFileSync(resolve(process.cwd(), 'src/auth/AuthContext.tsx'), 'utf8');

    expect(authContext).toContain(
      "from '@/session/mobileVoiceCredentialStore'",
    );
    expect(authContext).toContain(
      "from '@/session/mobileVoiceLiteLlmSettings'",
    );
    expect(authContext).toContain("from '@/session/mobileVoiceHistoryStore'");
    expect(authContext).toContain(
      'await clearAllMobileVoiceCredentials().catch(() => undefined);',
    );
    expect(authContext).toContain(
      'await clearMobileVoiceLiteLlmSettings().catch(() => undefined);',
    );
    expect(authContext).toContain(
      'await clearAllMobileVoiceInputHistories().catch(() => undefined);',
    );
    // Scope the ordering check to the logout body: refresh-token deletion is serialized so a
    // racing refresh cannot restore credentials after logout has begun.
    const logoutStart = authContext.indexOf('const logout = useCallback(async () => {');
    const logoutBody = authContext.slice(logoutStart, authContext.indexOf('}, [', logoutStart));
    const refreshTokenDelete = logoutBody.indexOf('await serializeRefreshTokenMutation(() =>');
    expect(refreshTokenDelete).toBeGreaterThanOrEqual(0);
    expect(logoutBody).toContain('deleteSecureItem(REFRESH_TOKEN_KEY).catch(() => undefined)');
    expect(logoutBody.indexOf('await clearAllMobileVoiceCredentials().catch(() => undefined);')).toBeLessThan(refreshTokenDelete);
    expect(logoutBody.indexOf('await clearMobileVoiceLiteLlmSettings().catch(() => undefined);')).toBeLessThan(refreshTokenDelete);
    expect(logoutBody.indexOf('await clearAllMobileVoiceInputHistories().catch(() => undefined);')).toBeLessThan(refreshTokenDelete);
  });

  it('keeps Android voice input as an explicit unsupported native boundary for now', () => {
    const expoModuleConfig = readFileSync(
      resolve(process.cwd(), 'modules/xdt-mobile-realtime-audio/expo-module.config.json'),
      'utf8',
    );
    const realtimeAudio = readFileSync(resolve(process.cwd(), 'src/session/mobileRealtimeAudio.ts'), 'utf8');

    expect(expoModuleConfig).toContain('"platforms": ["apple"]');
    expect(expoModuleConfig).not.toContain('"android"');
    expect(realtimeAudio).toContain("throw new UnavailabilityError('Cindy mobile voice input', 'realtime microphone PCM capture')");
    expect(realtimeAudio).toContain('EXPO_PUBLIC_XDT_MOBILE_E2E_MOCK_AUDIO');
  });

  it('sends the realtime voice draft returned by the controller instead of stale React state', () => {
    const sessionScreen = readFileSync(resolve(process.cwd(), 'app/sessions/[sessionId].tsx'), 'utf8');

    expect(sessionScreen).toContain('const latestDraft = await controller.stop();');
    expect(sessionScreen).toContain('await sendLatest({ draftOverride: latestDraft });');
    expect(sessionScreen.indexOf('const latestDraft = await controller.stop();')).toBeLessThan(
      sessionScreen.indexOf('await sendLatest({ draftOverride: latestDraft });'),
    );
    expect(sessionScreen).toContain('readCurrentDraft: () => draftRef.current');
    expect(sessionScreen).toContain('onDraftChanged: setComposerDraft');
    expect(sessionScreen).toContain('createMobileVoiceControllerSession({');
    expect(sessionScreen).not.toContain('await sendLatest({ draftOverride: draft });');
  });

  it('guards the mobile voice composer against the legacy desktop transcription path', () => {
    const scopeGuard = readFileSync(resolve(process.cwd(), 'scripts/mobile-scope-guard.mjs'), 'utf8');

    expect(scopeGuard).toContain("roots: ['app']");
    expect(scopeGuard).toContain("'transcribeVoice('");
    expect(scopeGuard).toContain("'DEVICE_LINK_VOICE_TRANSCRIBE_CHANNEL'");
    expect(scopeGuard).toContain("'device-link:voice:transcribe'");
    expect(scopeGuard).toContain('Mobile voice composer must use realtime controller + local LiteLLM settings');
  });
});
