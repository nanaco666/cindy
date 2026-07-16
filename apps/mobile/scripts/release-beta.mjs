#!/usr/bin/env node
import {
  assertBuildPlatformWithinReleasePlatforms,
  assertEasLoggedIn,
  assertPublicEnv,
  assertTargetProfile,
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
  requireExplicitDev,
  resolveCommandPublicEnv,
  resolveTarget,
  targetPlatformsForRelease,
} from './release-lib.mjs';

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const config = loadMobileConfig();
  requireExplicitDev(args, 'mobile:release:beta');
  assertEasLoggedIn({ mobileDir: config.mobileDir });
  const target = resolveTarget(config, { kind: 'beta', dev: args.dev, environment: args.environment });
  assertTargetProfile(config, target);

  assertPublicEnv(resolveCommandPublicEnv(target.publicEnv), { variant: 'beta' });

  const platforms = targetPlatformsForRelease(target, config.appJson);
  const fingerprints = await computeTargetFingerprints({ mobileDir: config.mobileDir, target, platforms });
  let latest = null;
  try {
    latest = readLatestBuildRuntime(target, { cwd: config.mobileDir });
  } catch (error) {
    console.warn(`warning: unable to read latest beta build runtime: ${error.message}`);
  }
  const mode = args.cold ? 'COLD_BUILD_REQUIRED' : decideTargetReleaseMode(fingerprints, latest, platforms);
  const message = String(args.message ?? args.m ?? `beta ${target.dev}`);
  const releasePlatform = easBuildPlatformForReleasePlatforms(platforms);
  const platform = args.platform ?? releasePlatform;
  assertBuildPlatformWithinReleasePlatforms(platform, releasePlatform);
  const command = mode === 'OTA_OK'
    ? buildUpdateCommand(target, message, { platform: releasePlatform })
    : buildColdBuildCommand(target, { platform, message });

  executePlan({
    target,
    mode,
    localRuntime: formatLocalRuntime(fingerprints, platforms),
    latestRuntime: formatLatestRuntime(latest, platforms),
    commands: [command],
    execute: Boolean(args.execute),
  }, { cwd: config.mobileDir });
}

main().catch((error) => {
  console.error(error.message);
  process.exit(1);
});
