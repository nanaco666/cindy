#!/usr/bin/env node
import {
  assertProductionGitGate,
  assertPublicEnv,
  assertColdReleaseAllowed,
  assertBuildPlatformWithinReleasePlatforms,
  assertEasLoggedIn,
  assertReleaseTargetsAllowed,
  assertProductionPlatformAllowed,
  assertProductionSubmitTarget,
  buildColdBuildCommand,
  buildUpdateCommand,
  computeTargetFingerprints,
  decideTargetReleaseMode,
  easBuildPlatformForReleasePlatforms,
  executePlan,
  formatLatestRuntime,
  formatLocalRuntime,
  loadMobileConfig,
  parseArgs,
  readLatestBuildRuntime,
  resolveCommandPublicEnv,
  resolveTarget,
  shouldAutoSubmitColdBuild,
  targetPlatformsForRelease,
} from './release-lib.mjs';

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const config = loadMobileConfig();
  assertProductionGitGate();

  const targetNames = String(args.targets ?? 'production,staging').split(',').map((item) => item.trim()).filter(Boolean);
  assertReleaseTargetsAllowed(targetNames, ['production', 'staging'], 'mobile:release:prod');
  assertEasLoggedIn({ mobileDir: config.mobileDir });
  const commands = [];
  const summaries = [];
  for (const targetName of targetNames) {
    const target = resolveTarget(config, { kind: targetName, environment: args.environment });
    // 本地校验 profile env + allowlisted 外部 EXPO_PUBLIC_* 齐全(与 release-beta 一致)。
    assertPublicEnv(resolveCommandPublicEnv(target.publicEnv), { variant: target.variant });

    const platforms = targetPlatformsForRelease(target, config.appJson);
    const fingerprints = await computeTargetFingerprints({ mobileDir: config.mobileDir, target, platforms });
    let latest = null;
    try {
      latest = readLatestBuildRuntime(target, { cwd: config.mobileDir });
    } catch (error) {
      console.warn(`warning: unable to read latest ${target.kind} build runtime: ${error.message}`);
    }
    const mode = args.cold ? 'COLD_BUILD_REQUIRED' : decideTargetReleaseMode(fingerprints, latest, platforms);
    assertColdReleaseAllowed({
      target,
      mode,
      latest,
      appJson: config.appJson,
      allowUnknownBaseline: Boolean(args.allowUnknownBaseline),
      platforms,
    });
    const message = String(args.message ?? args.m ?? `mobile ${target.kind}`);
    const releasePlatform = easBuildPlatformForReleasePlatforms(platforms);
    const platform = args.platform ?? releasePlatform;
    assertBuildPlatformWithinReleasePlatforms(platform, releasePlatform);
    assertProductionPlatformAllowed(target, platform);
    const autoSubmit = shouldAutoSubmitColdBuild({ target, mode, latest });
    if (autoSubmit) {
      assertProductionSubmitTarget({ target, appJson: config.appJson, easJson: config.easJson });
    }
    commands.push(mode === 'OTA_OK'
      ? buildUpdateCommand(target, message, { platform: releasePlatform })
      : buildColdBuildCommand(target, {
        // 正式服 store 路径只出 iOS(App Store / TestFlight);Android 走 NPKG 企业包,单独流程。
        platform,
        autoSubmit,
        message,
      }));
    summaries.push({
      target,
      mode,
      localRuntime: formatLocalRuntime(fingerprints, platforms),
      latestRuntime: formatLatestRuntime(latest, platforms),
    });
  }

  for (const summary of summaries) {
    executePlan({ ...summary, commands: [], execute: false }, { cwd: config.mobileDir });
    console.log('');
  }
  executePlan({
    target: summaries[0].target,
    mode: summaries.map((summary) => `${summary.target.kind}:${summary.mode}`).join(','),
    commands,
    execute: Boolean(args.execute),
  }, { cwd: config.mobileDir });
}

main().catch((error) => {
  console.error(error.message);
  process.exit(1);
});
