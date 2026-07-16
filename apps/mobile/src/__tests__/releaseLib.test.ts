import { afterEach, describe, expect, it, vi } from 'vitest';
import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import {
  addBetaDeveloperProfile,
  assertBuildPlatformWithinReleasePlatforms,
  assertColdReleaseAllowed,
  assertEasLoggedIn,
  assertPublicEnv,
  assertProductionGitGate,
  assertProductionPlatformAllowed,
  assertProductionSubmitTarget,
  assertReleaseTargetsAllowed,
  assertVersionMonotonic,
  buildBetaChannelLinkCommands,
  buildColdBuildCommand,
  buildEasCommandEnv,
  buildEasWhoamiArgs,
  buildLatestBuildRuntimeArgs,
  buildReleaseEnvExecCommand,
  buildReleaseEnvExecShellCommand,
  buildUpdateCommand,
  buildWindowsCmdCommand,
  decideReleaseMode,
  decideTargetReleaseMode,
  easBuildPlatformForReleasePlatforms,
  EAS_CLI_SPEC,
  EAS_LOGIN_ERROR_MESSAGE,
  formatLatestRuntime,
  formatLocalRuntime,
  parseArgs,
  parseFingerprintOutput,
  quoteWindowsCmdArg,
  requireExplicitDev,
  resolveBuildProfile,
  resolveCommandPublicEnv,
  resolveReleaseEnvExecRuns,
  resolveReleaseEnvExecRunPlan,
  resolveDesktopVersion,
  resolveReleaseEnvExecEnvironment,
  resolveTarget,
  runBetaChannelLink,
  shouldAutoSubmitColdBuild,
  slugifyDevName,
  summarizeLatestBuildRuntime,
  targetPlatformsForRelease,
} from '../../scripts/release-lib.mjs';

const require = createRequire(import.meta.url);
const fingerprintConfig = require('../../fingerprint.config.cjs');
const { stripBetaProfiles } = fingerprintConfig;

const easJson = {
  build: {
    base: {
      node: '22.19.0',
      env: {
        EXPO_PUBLIC_FEISHU_APP_ID: 'cli_testapp',
        EXPO_PUBLIC_XDT_API_BASE_URL: 'https://api.example.com',
        EXPO_PUBLIC_XDT_DEVICE_LINK_API_BASE_URL: 'https://relay.example.com',
        EXPO_PUBLIC_TAPTAP_CLIENT_ID: 'tap-client-id',
        EXPO_PUBLIC_TAPTAP_CLIENT_TOKEN: 'tap-client-token',
      },
    },
    'beta-base': {
      extends: 'base',
      distribution: 'store',
      env: {
        EXPO_PUBLIC_APP_VARIANT: 'beta',
      },
    },
    'beta-dash': {
      extends: 'beta-base',
      channel: 'beta-dash',
      env: {
        EXPO_PUBLIC_BETA_DEV: 'dash',
      },
    },
    production: {
      extends: 'base',
      channel: 'production',
    },
    adhoc: {
      extends: 'base',
      channel: 'staging',
    },
  },
};

describe('mobile release scripts core logic', () => {
  it('resolves inherited beta build profiles without losing base env', () => {
    const profile = resolveBuildProfile(easJson, 'beta-dash');
    expect(profile).toMatchObject({
      node: '22.19.0',
      distribution: 'store',
      channel: 'beta-dash',
      env: {
        EXPO_PUBLIC_FEISHU_APP_ID: 'cli_testapp',
        EXPO_PUBLIC_XDT_API_BASE_URL: 'https://api.example.com',
        EXPO_PUBLIC_XDT_DEVICE_LINK_API_BASE_URL: 'https://relay.example.com',
        EXPO_PUBLIC_TAPTAP_CLIENT_ID: 'tap-client-id',
        EXPO_PUBLIC_TAPTAP_CLIENT_TOKEN: 'tap-client-token',
        EXPO_PUBLIC_APP_VARIANT: 'beta',
        EXPO_PUBLIC_BETA_DEV: 'dash',
      },
    });
  });

  it('resolves per-dev beta targets to same-name profile/channel/branch', () => {
    const target = resolveTarget({ easJson }, { kind: 'beta', dev: 'dash' });
    expect(target).toEqual({
      kind: 'beta',
      dev: 'dash',
      profile: 'beta-dash',
      channel: 'beta-dash',
      branch: 'beta-dash',
      environment: 'preview',
      variant: 'beta',
      publicEnv: {
        EXPO_PUBLIC_APP_VARIANT: 'beta',
        EXPO_PUBLIC_BETA_DEV: 'dash',
        EXPO_PUBLIC_FEISHU_APP_ID: 'cli_testapp',
        EXPO_PUBLIC_XDT_API_BASE_URL: 'https://api.example.com',
        EXPO_PUBLIC_XDT_DEVICE_LINK_API_BASE_URL: 'https://relay.example.com',
        EXPO_PUBLIC_TAPTAP_CLIENT_ID: 'tap-client-id',
        EXPO_PUBLIC_TAPTAP_CLIENT_TOKEN: 'tap-client-token',
      },
    });
  });

  it('keeps production and staging target mapping explicit', () => {
    expect(resolveTarget({ easJson }, { kind: 'production' })).toMatchObject({
      profile: 'production',
      channel: 'production',
      branch: 'production',
      environment: 'production',
    });
    expect(resolveTarget({ easJson }, { kind: 'staging' })).toMatchObject({
      profile: 'adhoc',
      channel: 'staging',
      branch: 'staging',
      environment: 'preview',
    });
  });

  it('requires OTA public env and beta variant env', () => {
    expect(() => assertPublicEnv({
      EXPO_PUBLIC_FEISHU_APP_ID: 'app',
      EXPO_PUBLIC_XDT_API_BASE_URL: 'https://api.example.com',
      EXPO_PUBLIC_XDT_DEVICE_LINK_API_BASE_URL: 'https://relay.example.com',
      EXPO_PUBLIC_TAPTAP_CLIENT_ID: 'tap-client-id',
      EXPO_PUBLIC_TAPTAP_CLIENT_TOKEN: 'tap-client-token',
      EXPO_PUBLIC_APP_VARIANT: 'beta',
      EXPO_PUBLIC_BETA_DEV: 'dash',
    }, { variant: 'beta' })).not.toThrow();
    expect(() => assertPublicEnv({
      EXPO_PUBLIC_FEISHU_APP_ID: 'app',
    }, { variant: 'beta' })).toThrow(/EXPO_PUBLIC_XDT_API_BASE_URL/);
    expect(() => assertPublicEnv({
      EXPO_PUBLIC_FEISHU_APP_ID: 'app',
      EXPO_PUBLIC_XDT_API_BASE_URL: 'https://api.example.com',
      EXPO_PUBLIC_XDT_DEVICE_LINK_API_BASE_URL: 'https://relay.example.com',
      EXPO_PUBLIC_APP_VARIANT: 'beta',
    }, { variant: 'beta' })).toThrow(/EXPO_PUBLIC_BETA_DEV/);
    expect(() => assertPublicEnv({
      EXPO_PUBLIC_FEISHU_APP_ID: 'app',
      EXPO_PUBLIC_XDT_API_BASE_URL: 'https://api.example.com',
      EXPO_PUBLIC_XDT_DEVICE_LINK_API_BASE_URL: 'https://relay.example.com',
      EXPO_PUBLIC_APP_VARIANT: 'beta',
    }, { variant: 'production' })).toThrow(/Production OTA environment/);
  });

  it('allows only TapDB public env to come from the external release environment', () => {
    const profileEnv = {
      EXPO_PUBLIC_FEISHU_APP_ID: 'app',
      EXPO_PUBLIC_XDT_API_BASE_URL: 'https://api.example.com',
      EXPO_PUBLIC_XDT_DEVICE_LINK_API_BASE_URL: 'https://relay.example.com',
      EXPO_PUBLIC_APP_VARIANT: 'beta',
      EXPO_PUBLIC_BETA_DEV: 'dash',
    };
    const ambientEnv: NodeJS.ProcessEnv = {
      NODE_ENV: 'test',
      PATH: '/usr/bin',
      EXPO_PUBLIC_TAPTAP_CLIENT_ID: 'tap-client-id',
      EXPO_PUBLIC_TAPTAP_CLIENT_TOKEN: 'tap-client-token',
      EXPO_PUBLIC_TAPDB_CHANNEL: 'TestFlight',
      EXPO_PUBLIC_TAPDB_REGION: 'global',
      EXPO_PUBLIC_XDT_DEV_LOGIN_ENABLED: '1',
      EXPO_PUBLIC_BETA_DEV: 'ambient-should-not-win',
      KEEP_ME: 'yes',
    };

    const commandPublicEnv = resolveCommandPublicEnv(profileEnv, ambientEnv);
    expect(() => assertPublicEnv(commandPublicEnv, { variant: 'beta' })).not.toThrow();
    expect(commandPublicEnv).toMatchObject({
      ...profileEnv,
      EXPO_PUBLIC_TAPTAP_CLIENT_ID: 'tap-client-id',
      EXPO_PUBLIC_TAPTAP_CLIENT_TOKEN: 'tap-client-token',
      EXPO_PUBLIC_TAPDB_CHANNEL: 'TestFlight',
      EXPO_PUBLIC_TAPDB_REGION: 'global',
    });

    const commandEnv = buildEasCommandEnv(profileEnv, ambientEnv);
    expect(commandEnv).toMatchObject({
      KEEP_ME: 'yes',
      EXPO_NO_DOTENV: '1',
      EXPO_PUBLIC_TAPTAP_CLIENT_ID: 'tap-client-id',
      EXPO_PUBLIC_TAPTAP_CLIENT_TOKEN: 'tap-client-token',
      EXPO_PUBLIC_TAPDB_CHANNEL: 'TestFlight',
      EXPO_PUBLIC_TAPDB_REGION: 'global',
      EXPO_PUBLIC_BETA_DEV: 'dash',
    });
    expect(commandEnv).not.toHaveProperty('EXPO_PUBLIC_XDT_DEV_LOGIN_ENABLED');
  });

  it('routes fixed mobile release scripts through the matching EAS environment', () => {
    expect(resolveReleaseEnvExecEnvironment('beta', {})).toBe('preview');
    expect(resolveReleaseEnvExecEnvironment('prod', {})).toBe('production');
    expect(resolveReleaseEnvExecEnvironment('prod', { targets: 'production,staging' })).toBe('production');
    expect(resolveReleaseEnvExecEnvironment('prod', { targets: 'staging' })).toBe('preview');
    expect(resolveReleaseEnvExecEnvironment('check', { target: 'beta', dev: 'dash' })).toBe('preview');
    expect(resolveReleaseEnvExecEnvironment('check', { target: 'staging' })).toBe('preview');
    expect(resolveReleaseEnvExecEnvironment('check', { target: 'production' })).toBe('production');
    expect(resolveReleaseEnvExecEnvironment('check', {})).toBe('production');
    expect(() => resolveReleaseEnvExecEnvironment('unknown', {})).toThrow(/Unknown mobile release command/);

    expect(buildReleaseEnvExecShellCommand('beta', ['--dev', 'dash', '--message', 'TapDB check'], 'linux')).toBe(
      "cd ../.. && node apps/mobile/scripts/release-beta.mjs --dev dash --message 'TapDB check'",
    );
    expect(buildReleaseEnvExecShellCommand('beta', ['--dev', 'dash', '--message', 'TapDB check'], 'win32')).toBe(
      'cd /d ..\\.. && node apps/mobile/scripts/release-beta.mjs --dev dash --message "TapDB check"',
    );
    expect(resolveReleaseEnvExecRuns('prod', [])).toEqual([
      { environment: 'production', forwardedArgs: ['--targets', 'production'] },
      { environment: 'preview', forwardedArgs: ['--targets', 'staging'] },
    ]);
    expect(resolveReleaseEnvExecRuns('prod', ['--targets=staging', '--message', 'Staging only'])).toEqual([
      { environment: 'preview', forwardedArgs: ['--targets=staging', '--message', 'Staging only'] },
    ]);
    expect(resolveReleaseEnvExecRunPlan('prod', ['--execute', '--message', 'Ship TapDB'])).toEqual([
      { environment: 'production', forwardedArgs: ['--message', 'Ship TapDB', '--targets', 'production'], phase: 'preflight' },
      { environment: 'preview', forwardedArgs: ['--message', 'Ship TapDB', '--targets', 'staging'], phase: 'preflight' },
      { environment: 'production', forwardedArgs: ['--execute', '--message', 'Ship TapDB', '--targets', 'production'], phase: 'run' },
      { environment: 'preview', forwardedArgs: ['--execute', '--message', 'Ship TapDB', '--targets', 'staging'], phase: 'run' },
    ]);
    expect(resolveReleaseEnvExecRunPlan('prod', ['--targets=staging', '--execute'])).toEqual([
      { environment: 'preview', forwardedArgs: ['--targets=staging', '--execute'], phase: 'run' },
    ]);
    expect(buildReleaseEnvExecCommand('preview', 'cd ../.. && node apps/mobile/scripts/release-check.mjs')).toMatchObject({
      args: ['--yes', EAS_CLI_SPEC, 'env:exec', 'preview', 'cd ../.. && node apps/mobile/scripts/release-check.mjs', '--non-interactive'],
    });
    expect(() => buildReleaseEnvExecShellCommand('unknown')).toThrow(/Unknown mobile release command/);
  });

  it('prefixes beta OTA commands with deterministic variant env', () => {
    const target = resolveTarget({ easJson }, { kind: 'beta', dev: 'dash' });
    expect(buildUpdateCommand(target, 'beta update', { platform: 'ios' })).toMatchObject({
      args: ['--yes', EAS_CLI_SPEC, 'update', '--branch', 'beta-dash', '--platform', 'ios', '--message', 'beta update', '--environment', 'preview', '--non-interactive'],
      env: {
        EXPO_PUBLIC_FEISHU_APP_ID: 'cli_testapp',
        EXPO_PUBLIC_XDT_API_BASE_URL: 'https://api.example.com',
        EXPO_PUBLIC_XDT_DEVICE_LINK_API_BASE_URL: 'https://relay.example.com',
        EXPO_PUBLIC_TAPTAP_CLIENT_ID: 'tap-client-id',
        EXPO_PUBLIC_TAPTAP_CLIENT_TOKEN: 'tap-client-token',
        EXPO_PUBLIC_APP_VARIANT: 'beta',
        EXPO_PUBLIC_BETA_DEV: 'dash',
      },
    });
    const prodCmd = buildUpdateCommand(resolveTarget({ easJson }, { kind: 'production' }), 'prod update', { platform: 'ios' });
    expect(prodCmd.bin.endsWith('npx') || prodCmd.bin.endsWith('npx.cmd')).toBe(true);
    expect(prodCmd.env).toMatchObject({ EXPO_PUBLIC_FEISHU_APP_ID: 'cli_testapp' });
    expect(prodCmd.env).not.toHaveProperty('EXPO_PUBLIC_APP_VARIANT');
    expect(prodCmd.env).not.toHaveProperty('EXPO_PUBLIC_BETA_DEV');
    expect(prodCmd.args).toContain('--environment');
    expect(prodCmd.args).toContain('production');
  });

  it('strips ambient EXPO_PUBLIC dev/test flags from EAS subprocesses', () => {
    const ambientEnv: NodeJS.ProcessEnv = {
      NODE_ENV: 'test',
      PATH: '/usr/bin',
      EXPO_PUBLIC_APP_VARIANT: 'beta',
      EXPO_PUBLIC_BETA_DEV: 'dash',
      EXPO_PUBLIC_XDT_DEV_LOGIN_ENABLED: '1',
      EXPO_PUBLIC_XDT_GIT_BRANCH: 'feature/dev-overlay',
      EXPO_PUBLIC_XDT_MOBILE_E2E_MOCK_AUDIO: '1',
      KEEP_ME: 'yes',
    };
    const devPublicKeys = [
      'EXPO_PUBLIC_XDT_DEV_LOGIN_ENABLED',
      'EXPO_PUBLIC_XDT_GIT_BRANCH',
      'EXPO_PUBLIC_XDT_MOBILE_E2E_MOCK_AUDIO',
    ];
    const production = resolveTarget({ easJson }, { kind: 'production' });
    const staging = resolveTarget({ easJson }, { kind: 'staging' });
    const beta = resolveTarget({ easJson }, { kind: 'beta', dev: 'dash' });

    const productionEnv = buildEasCommandEnv(buildUpdateCommand(production, 'prod update', { platform: 'ios' }).env, ambientEnv);
    expect(productionEnv).toMatchObject({
      KEEP_ME: 'yes',
      EXPO_NO_DOTENV: '1',
      EXPO_PUBLIC_FEISHU_APP_ID: 'cli_testapp',
    });
    expect(productionEnv).not.toHaveProperty('EXPO_PUBLIC_APP_VARIANT');
    expect(productionEnv).not.toHaveProperty('EXPO_PUBLIC_BETA_DEV');
    for (const key of devPublicKeys) expect(productionEnv).not.toHaveProperty(key);

    const stagingEnv = buildEasCommandEnv(buildUpdateCommand(staging, 'staging update', { platform: 'ios' }).env, ambientEnv);
    expect(stagingEnv).toHaveProperty('EXPO_NO_DOTENV', '1');
    expect(stagingEnv).not.toHaveProperty('EXPO_PUBLIC_APP_VARIANT');
    expect(stagingEnv).not.toHaveProperty('EXPO_PUBLIC_BETA_DEV');
    for (const key of devPublicKeys) expect(stagingEnv).not.toHaveProperty(key);

    const coldBuildEnv = buildEasCommandEnv(buildColdBuildCommand(production, { platform: 'ios' }).env, ambientEnv);
    expect(coldBuildEnv).toHaveProperty('EXPO_NO_DOTENV', '1');
    expect(coldBuildEnv).not.toHaveProperty('EXPO_PUBLIC_APP_VARIANT');
    expect(coldBuildEnv).not.toHaveProperty('EXPO_PUBLIC_BETA_DEV');
    for (const key of devPublicKeys) expect(coldBuildEnv).not.toHaveProperty(key);

    const betaEnv = buildEasCommandEnv(buildUpdateCommand(beta, 'beta update', { platform: 'ios' }).env, ambientEnv);
    expect(betaEnv).toMatchObject({
      EXPO_NO_DOTENV: '1',
      EXPO_PUBLIC_APP_VARIANT: 'beta',
      EXPO_PUBLIC_BETA_DEV: 'dash',
      EXPO_PUBLIC_FEISHU_APP_ID: 'cli_testapp',
      EXPO_PUBLIC_XDT_API_BASE_URL: 'https://api.example.com',
      EXPO_PUBLIC_XDT_DEVICE_LINK_API_BASE_URL: 'https://relay.example.com',
      EXPO_PUBLIC_TAPTAP_CLIENT_ID: 'tap-client-id',
      EXPO_PUBLIC_TAPTAP_CLIENT_TOKEN: 'tap-client-token',
    });
    for (const key of devPublicKeys) expect(betaEnv).not.toHaveProperty(key);
  });

  it('pins OTA update platform to the checked release platforms', () => {
    const appJsonWithoutAndroidVersion = { expo: { android: {} } };
    const appJsonWithAndroidVersion = { expo: { android: { versionCode: 2026062701 } } };
    const beta = resolveTarget({ easJson }, { kind: 'beta', dev: 'dash' });
    const production = resolveTarget({ easJson }, { kind: 'production' });
    const updatePlatform = (target: ReturnType<typeof resolveTarget>, appJson: object) => easBuildPlatformForReleasePlatforms(targetPlatformsForRelease(target, appJson));
    const platformArg = (target: ReturnType<typeof resolveTarget>, appJson: object) => {
      const args = buildUpdateCommand(target, 'update', { platform: updatePlatform(target, appJson) }).args;
      return args[args.indexOf('--platform') + 1];
    };

    expect(platformArg(beta, appJsonWithoutAndroidVersion)).toBe('ios');
    expect(platformArg(beta, appJsonWithAndroidVersion)).toBe('all');
    expect(platformArg(production, appJsonWithAndroidVersion)).toBe('ios');
    expect(() => buildUpdateCommand(beta, 'update', {} as { platform: string })).toThrow(/requires platform/);
  });

  it('quotes Windows command arguments for npx.cmd shell execution', () => {
    expect(quoteWindowsCmdArg('plain')).toBe('plain');
    expect(quoteWindowsCmdArg('release build')).toBe('"release build"');
    expect(quoteWindowsCmdArg('say "hi"')).toBe('"say ^"hi^""');
    expect(buildWindowsCmdCommand('npx.cmd', [
      EAS_CLI_SPEC,
      'update',
      '--message',
      'release "candidate" build',
    ])).toBe('npx.cmd eas-cli@20.4.0 update --message "release ^"candidate^" build"');
    expect(buildWindowsCmdCommand('npx.cmd', [
      '--yes',
      EAS_CLI_SPEC,
      'update',
      '--message',
      'release "candidate" build',
    ])).toBe('npx.cmd --yes eas-cli@20.4.0 update --message "release ^"candidate^" build"');
  });

  it('checks iOS buildNumber and Android versionCode monotonicity', () => {
    expect(() => assertVersionMonotonic({
      appJson: { expo: { ios: { buildNumber: '2026062609' }, android: { versionCode: 2026062609 } } },
      latestBuilds: { ios: { appBuildVersion: '2026062608' }, android: { appBuildVersion: '2026062608' } },
    })).not.toThrow();
    expect(() => assertVersionMonotonic({
      appJson: { expo: { ios: { buildNumber: '2026062608' }, android: { versionCode: 2026062608 } } },
      latestBuilds: { ios: { appBuildVersion: '2026062608' }, android: { appBuildVersion: '2026062609' } },
    })).toThrow(/ios.buildNumber/);
    expect(() => assertVersionMonotonic({
      appJson: { expo: { ios: { buildNumber: '2026062609' }, android: {} } },
      latestBuilds: { ios: { appBuildVersion: '2026062608' }, android: { appBuildVersion: '2026062609' } },
    })).not.toThrow();
  });

  it('summarizes latest build runtime and decides OTA vs cold build', () => {
    const latest = summarizeLatestBuildRuntime([
      { id: 'ios1', platform: 'IOS', runtimeVersion: 'abc', appBuildVersion: '10' },
      { id: 'android1', platform: 'ANDROID', runtimeVersion: 'abc', appBuildVersion: '11' },
    ], { channel: 'production' });
    expect(latest.runtimeVersion).toBe('abc');
    expect(decideReleaseMode('abc', latest.runtimeVersion)).toBe('OTA_OK');
    expect(decideReleaseMode('def', latest.runtimeVersion)).toBe('COLD_BUILD_REQUIRED');
    expect(decideReleaseMode('def', null)).toBe('BASELINE_UNKNOWN');
  });

  it('filters latest build runtime by both channel and build profile', () => {
    expect(buildLatestBuildRuntimeArgs(resolveTarget({ easJson }, { kind: 'production' }))).toEqual([
      '--yes',
      EAS_CLI_SPEC,
      'build:list',
      '--platform',
      'all',
      '--status',
      'finished',
      '--channel',
      'production',
      '--build-profile',
      'production',
      '--limit',
      '10',
      '--json',
      '--non-interactive',
    ]);
  });

  it('decides release mode across every target platform', () => {
    const local = {
      byPlatform: {
        ios: { hash: 'ios-runtime' },
        android: { hash: 'android-runtime' },
      },
    };
    expect(decideTargetReleaseMode(local, {
      byPlatform: {
        ios: { runtimeVersion: 'ios-runtime' },
        android: { runtimeVersion: 'android-runtime' },
      },
    }, ['ios', 'android'])).toBe('OTA_OK');
    expect(decideTargetReleaseMode(local, {
      byPlatform: {
        ios: { runtimeVersion: 'ios-runtime' },
        android: { runtimeVersion: 'old-android-runtime' },
      },
    }, ['ios', 'android'])).toBe('COLD_BUILD_REQUIRED');
    expect(decideTargetReleaseMode(local, {
      byPlatform: {
        ios: { runtimeVersion: 'ios-runtime' },
      },
    }, ['ios', 'android'])).toBe('BASELINE_UNKNOWN');
    expect(decideTargetReleaseMode(local, {
      byPlatform: {
        ios: { runtimeVersion: 'ios-runtime' },
      },
    }, ['ios'])).toBe('OTA_OK');
  });

  it('keeps beta/staging iOS-only until Android versionCode is declared', () => {
    const appJsonWithoutAndroidVersion = { expo: { android: {} } };
    const appJsonWithAndroidVersion = { expo: { android: { versionCode: 2026062701 } } };
    expect(targetPlatformsForRelease(resolveTarget({ easJson }, { kind: 'production' }), appJsonWithAndroidVersion)).toEqual(['ios']);
    expect(targetPlatformsForRelease(resolveTarget({ easJson }, { kind: 'production' }), appJsonWithoutAndroidVersion)).toEqual(['ios']);
    expect(targetPlatformsForRelease(resolveTarget({ easJson }, { kind: 'beta', dev: 'dash' }), appJsonWithoutAndroidVersion)).toEqual(['ios']);
    expect(targetPlatformsForRelease(resolveTarget({ easJson }, { kind: 'staging' }), appJsonWithoutAndroidVersion)).toEqual(['ios']);
    expect(targetPlatformsForRelease(resolveTarget({ easJson }, { kind: 'beta', dev: 'dash' }), appJsonWithAndroidVersion)).toEqual(['ios', 'android']);
    expect(targetPlatformsForRelease(resolveTarget({ easJson }, { kind: 'staging' }), appJsonWithAndroidVersion)).toEqual(['ios', 'android']);
  });

  it('derives cold-build platform from the checked release platforms', () => {
    expect(easBuildPlatformForReleasePlatforms(['ios'])).toBe('ios');
    expect(easBuildPlatformForReleasePlatforms(['ios', 'android'])).toBe('all');
    expect(easBuildPlatformForReleasePlatforms(['android'])).toBe('android');
    expect(() => assertBuildPlatformWithinReleasePlatforms('all', 'ios')).toThrow(/exceeds checked release platform/);
    expect(() => assertBuildPlatformWithinReleasePlatforms('android', 'ios')).toThrow(/exceeds checked release platform/);
    expect(() => assertBuildPlatformWithinReleasePlatforms('windows', 'ios')).toThrow(/must be ios/);
    expect(() => assertBuildPlatformWithinReleasePlatforms('ios', 'all')).not.toThrow();
    expect(() => buildColdBuildCommand(resolveTarget({ easJson }, { kind: 'beta', dev: 'dash' }), {} as { platform: string })).toThrow(/requires platform/);

    expect(buildColdBuildCommand(resolveTarget({ easJson }, { kind: 'beta', dev: 'dash' }), {
      platform: easBuildPlatformForReleasePlatforms(['ios']),
      message: 'beta dash',
    }).args).toEqual([
      '--yes',
      EAS_CLI_SPEC,
      'build',
      '--platform',
      'ios',
      '--profile',
      'beta-dash',
      '--non-interactive',
      '--message',
      'beta dash',
    ]);
  });

  it('keeps production release target lists explicit', () => {
    expect(() => assertReleaseTargetsAllowed(['production', 'staging'], ['production', 'staging'], 'mobile:release:prod')).not.toThrow();
    expect(() => assertReleaseTargetsAllowed(['beta'], ['production', 'staging'], 'mobile:release:prod')).toThrow(/targets must be production, staging/);
    expect(() => assertReleaseTargetsAllowed([], ['production', 'staging'], 'mobile:release:prod')).toThrow(/at least one target/);
  });

  it('checks production git gate against the remote main tip source', () => {
    const head = '1111111111111111111111111111111111111111';
    const makeGit = (status = '') => (args: string[]) => {
      const key = args.join(' ');
      if (key === 'branch --show-current') return 'main';
      if (key === 'status --short') return status;
      if (key === 'rev-parse HEAD') return head;
      throw new Error(`unexpected git call: ${key}`);
    };

    expect(() => assertProductionGitGate({
      git: makeGit(),
      getRemoteMainTip: () => head,
    })).not.toThrow();
    expect(() => assertProductionGitGate({
      git: makeGit(),
      getRemoteMainTip: () => '2222222222222222222222222222222222222222',
    })).toThrow(/remote origin\/main/);
    expect(() => assertProductionGitGate({
      git: makeGit(' M apps/mobile/app.json'),
      getRemoteMainTip: () => head,
    })).toThrow(/clean worktree/);
    expect(() => assertProductionGitGate({
      git: (args: string[]) => (args.join(' ') === 'branch --show-current' ? 'release' : ''),
      getRemoteMainTip: () => head,
    })).toThrow(/current branch is release/);
  });

  it('formats multi-platform runtime summaries for release plans', () => {
    expect(formatLocalRuntime({
      byPlatform: {
        ios: { hash: 'ios-runtime' },
        android: { hash: 'android-runtime' },
      },
    }, ['ios', 'android'])).toBe('ios=ios-runtime, android=android-runtime');
    expect(formatLatestRuntime({
      byPlatform: {
        ios: { runtimeVersion: 'ios-runtime' },
      },
    }, ['ios', 'android'])).toBe('ios=ios-runtime, android=unknown');
  });

  it('requires known baselines and version gates for production cold paths', () => {
    const target = resolveTarget({ easJson }, { kind: 'production' });
    const appJson = { expo: { ios: { buildNumber: '2026062609' }, android: {} } };
    expect(() => assertColdReleaseAllowed({
      target,
      mode: 'BASELINE_UNKNOWN',
      latest: { byPlatform: {} },
      appJson,
    })).toThrow(/known latest build baseline/);
    expect(() => assertColdReleaseAllowed({
      target,
      mode: 'BASELINE_UNKNOWN',
      latest: { byPlatform: { ios: { appBuildVersion: '2026062608' } } },
      appJson,
      allowUnknownBaseline: true,
      platforms: ['ios'],
    })).not.toThrow();
    expect(() => assertColdReleaseAllowed({
      target,
      mode: 'COLD_BUILD_REQUIRED',
      latest: { byPlatform: { ios: { appBuildVersion: '2026062608', runtimeVersion: 'ios-runtime' } } },
      appJson: { expo: { ios: { buildNumber: '2026062608' }, android: {} } },
      platforms: ['ios'],
    })).toThrow(/ios.buildNumber/);
  });

  it('rejects Android production cold-build platforms while Android production is pending', () => {
    const target = resolveTarget({ easJson }, { kind: 'production' });
    expect(() => assertProductionPlatformAllowed(target, 'ios')).not.toThrow();
    expect(() => assertProductionPlatformAllowed(target, 'all')).toThrow(/Production release only supports/);
    expect(() => assertProductionPlatformAllowed(target, 'android')).toThrow(/Production release only supports/);
    expect(() => assertProductionPlatformAllowed(resolveTarget({ easJson }, { kind: 'staging' }), 'all')).not.toThrow();
  });

  it('requires com.xd.lizcn production auto-submit to use the matching ASC app', () => {
    const target = { kind: 'production', profile: 'production' };
    const appJson = { expo: { ios: { bundleIdentifier: 'com.xd.lizcn' } } };
    const legacySubmitConfig = { submit: { production: { ios: { ascAppId: '6782341575' } } } };

    expect(() => assertProductionSubmitTarget({ target, appJson, easJson: legacySubmitConfig })).toThrow(/submit\.production\.ios\.ascAppId.*6785851372/);
    expect(() => assertProductionSubmitTarget({
      target: { kind: 'production', profile: 'testflight' },
      appJson,
      easJson: { submit: { testflight: { ios: { ascAppId: '6782341575' } } } },
    })).toThrow(/submit\.testflight\.ios\.ascAppId.*6785851372/);
    expect(() => assertProductionSubmitTarget({
      target,
      appJson,
      easJson: { submit: { production: { ios: { ascAppId: 'com-xd-lizcn-asc-id' } } } },
    })).toThrow(/submit\.production\.ios\.ascAppId.*6785851372/);
    expect(() => assertProductionSubmitTarget({
      target,
      appJson,
      easJson: { submit: { production: { ios: { ascAppId: '6785851372' } } } },
    })).not.toThrow();
  });

  it('only enables production auto-submit when an iOS baseline proves buildNumber monotonicity', () => {
    const target = resolveTarget({ easJson }, { kind: 'production' });
    expect(shouldAutoSubmitColdBuild({
      target,
      mode: 'COLD_BUILD_REQUIRED',
      latest: { byPlatform: { ios: { appBuildVersion: '2026062608' } } },
    })).toBe(true);
    expect(shouldAutoSubmitColdBuild({
      target,
      mode: 'BASELINE_UNKNOWN',
      latest: { byPlatform: {} },
    })).toBe(false);
    expect(shouldAutoSubmitColdBuild({
      target,
      mode: 'OTA_OK',
      latest: { byPlatform: { ios: { appBuildVersion: '2026062608' } } },
    })).toBe(false);
    expect(shouldAutoSubmitColdBuild({
      target: resolveTarget({ easJson }, { kind: 'staging' }),
      mode: 'COLD_BUILD_REQUIRED',
      latest: { byPlatform: { ios: { appBuildVersion: '2026062608' } } },
    })).toBe(false);
  });

  it('adds beta developer profiles deterministically', () => {
    const next = JSON.parse(JSON.stringify(easJson));
    const result = addBetaDeveloperProfile(next, 'Alice Zhang');
    expect(result).toEqual({
      dev: 'alice-zhang',
      profile: 'beta-alice-zhang',
      channel: 'beta-alice-zhang',
      branch: 'beta-alice-zhang',
      created: true,
      easJson: next,
    });
    expect(next.build['beta-alice-zhang']).toEqual({
      extends: 'beta-base',
      channel: 'beta-alice-zhang',
      env: { EXPO_PUBLIC_BETA_DEV: 'alice-zhang' },
    });
  });

  it('plans beta channel creation and branch association for new developers', () => {
    const commands = buildBetaChannelLinkCommands({ channel: 'beta-alice', branch: 'beta-alice' });
    expect(commands.map((command) => command.args)).toEqual([
      ['--yes', EAS_CLI_SPEC, 'branch:create', 'beta-alice', '--non-interactive'],
      ['--yes', EAS_CLI_SPEC, 'channel:create', 'beta-alice', '--non-interactive'],
      ['--yes', EAS_CLI_SPEC, 'channel:edit', 'beta-alice', '--branch', 'beta-alice', '--non-interactive'],
    ]);

    const dryRunCalls: string[][] = [];
    const dryRun = runBetaChannelLink({
      channel: 'beta-alice',
      execute: false,
      run: (command) => {
        dryRunCalls.push((command as { args: string[] }).args);
        return { status: 0 };
      },
    });
    expect(dryRun.executed).toBe(false);
    expect(dryRunCalls).toEqual([]);

    const executeCalls: string[][] = [];
    const executed = runBetaChannelLink({
      channel: 'beta-alice',
      execute: true,
      run: (command) => {
        const args = (command as { args: string[] }).args;
        executeCalls.push(args);
        if (args.includes('branch:create')) {
          return { status: 1, stderr: 'Branch beta-alice already exists' };
        }
        if (args.includes('channel:create')) {
          return { status: 1, stderr: 'Channel beta-alice already exists' };
        }
        return { status: 0 };
      },
    });
    expect(executed).toMatchObject({ executed: true, branchCreated: false, channelCreated: false, created: false, linked: true });
    expect(executeCalls).toEqual(commands.map((command) => command.args));
  });

  it('slugifies developer names', () => {
    expect(slugifyDevName(' Dash_Huang ')).toBe('dash-huang');
  });

  it('treats standalone -- as a separator so positional args survive pnpm forwarding', () => {
    // `pnpm run beta:add-dev -- alice` 会把 `--` 一起转发,positional 必须仍能拿到。
    expect(parseArgs(['--', 'alice'])._[0]).toBe('alice');
    expect(parseArgs(['--', '--dev', 'dash']).dev).toBe('dash');
    expect(parseArgs(['--', '--dev', 'dash'])._).toEqual([]);
  });

  it('requires explicit beta developer names at CLI boundaries', () => {
    expect(() => requireExplicitDev({}, 'mobile:release:beta')).toThrow(/requires --dev/);
    expect(() => requireExplicitDev({ dev: 'dash' }, 'mobile:release:beta')).not.toThrow();
  });

  it('fails fast with a stable EAS login preflight message', () => {
    expect(buildEasWhoamiArgs()).toEqual(['--yes', EAS_CLI_SPEC, 'whoami']);
    expect(buildEasWhoamiArgs()).not.toContain('--non-interactive');
    expect(() => assertEasLoggedIn({ check: () => 'dash' })).not.toThrow();
    expect(() => assertEasLoggedIn({ check: () => '' })).toThrow(EAS_LOGIN_ERROR_MESSAGE);
    expect(() => assertEasLoggedIn({ check: () => { throw new Error('not logged in'); } })).toThrow(EAS_LOGIN_ERROR_MESSAGE);
  });

  it('parses eas fingerprint:generate JSON output', () => {
    expect(parseFingerprintOutput('{ "hash": "abc123", "sources": [] }').hash).toBe('abc123');
    expect(() => parseFingerprintOutput('{ "sources": [] }')).toThrow(/hash/);
  });

  it('normalizes eas.json for fingerprinting by stripping only beta profiles', () => {
    const current = JSON.parse(readFileSync(resolve(process.cwd(), 'eas.json'), 'utf8'));
    const normalized = stripBetaProfiles(current);

    expect(normalized).toEqual({
      cli: { version: '>= 15.0.0', appVersionSource: 'local' },
      build: {
        testflight: {
          distribution: 'store',
          channel: 'production',
          environment: 'production',
          node: '22.19.0',
          ios: { resourceClass: 'm-medium' },
          env: {
            EXPO_PUBLIC_XDT_NATIVE_FEISHU_LOGIN_ENABLED: '1',
            XDT_SKIP_AGENT_BIN_INSTALL: '1',
          },
        },
        production: {
          distribution: 'store',
          channel: 'production',
          environment: 'production',
          node: '22.19.0',
          ios: { resourceClass: 'm-medium' },
          env: {
            EXPO_PUBLIC_XDT_NATIVE_FEISHU_LOGIN_ENABLED: '1',
            XDT_SKIP_AGENT_BIN_INSTALL: '1',
          },
        },
        adhoc: {
          distribution: 'internal',
          channel: 'staging',
          environment: 'preview',
          node: '22.19.0',
          ios: { resourceClass: 'm-medium' },
          env: {
            EXPO_PUBLIC_XDT_NATIVE_FEISHU_LOGIN_ENABLED: '1',
            XDT_SKIP_AGENT_BIN_INSTALL: '1',
          },
        },
      },
      submit: {
        testflight: { ios: { ascAppId: '6785851372' } },
        production: { ios: { ascAppId: '6785851372' } },
      },
    });
    expect(JSON.stringify(normalized)).not.toContain('EXPO_PUBLIC_TAPTAP_CLIENT_ID');
    expect(JSON.stringify(normalized)).not.toContain('EXPO_PUBLIC_TAPTAP_CLIENT_TOKEN');
  });

  it('fingerprint eas.json transform includes the chunk delivered with EOF', () => {
    const eas = JSON.stringify({
      cli: { version: '>= 15.0.0' },
      build: {
        production: { channel: 'production' },
        'beta-dash': { channel: 'beta-dash' },
      },
    });
    const transformed = fingerprintConfig.fileHookTransform({
      type: 'file',
      filePath: 'eas.json',
    }, eas, true);
    expect(JSON.parse(transformed)).toEqual({
      cli: { version: '>= 15.0.0' },
      build: {
        production: { channel: 'production' },
      },
    });
  });
});

describe('resolveDesktopVersion（自建线设置页二级版本号取值）', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('显式值优先，跳过网络', async () => {
    const fetchSpy = vi.fn();
    vi.stubGlobal('fetch', fetchSpy);
    await expect(resolveDesktopVersion({ explicit: ' 0.0.147 ' })).resolves.toBe('0.0.147');
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('无显式值时从 CDN manifest 的 app.version 读取', async () => {
    const fetchSpy = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ app: { version: '0.0.151' } }),
    });
    vi.stubGlobal('fetch', fetchSpy);
    await expect(
      resolveDesktopVersion({ cdnBase: 'https://cdn.example.com/xdt-maker/', platformKey: 'darwin-arm64' }),
    ).resolves.toBe('0.0.151');
    // baseUrl 末尾斜杠被归一化，platformKey 拼进 manifest 文件名。
    expect(fetchSpy).toHaveBeenCalledTimes(1);
    expect(String(fetchSpy.mock.calls[0][0])).toContain('https://cdn.example.com/xdt-maker/manifest-darwin-arm64.json');
  });

  it('HTTP 非 2xx / 缺 app.version / 网络异常一律回退空串（设置页不显示该行）', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: false, json: async () => ({}) }));
    await expect(resolveDesktopVersion({ cdnBase: 'https://cdn.example.com' })).resolves.toBe('');

    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: true, json: async () => ({ app: {} }) }));
    await expect(resolveDesktopVersion({ cdnBase: 'https://cdn.example.com' })).resolves.toBe('');

    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('network down')));
    await expect(resolveDesktopVersion({ cdnBase: 'https://cdn.example.com' })).resolves.toBe('');
  });
});
