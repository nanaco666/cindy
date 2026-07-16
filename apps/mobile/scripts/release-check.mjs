#!/usr/bin/env node
import {
  assertEasLoggedIn,
  computeTargetFingerprints,
  decideTargetReleaseMode,
  formatLatestRuntime,
  formatLocalRuntime,
  formatPlan,
  loadMobileConfig,
  parseArgs,
  readLatestBuildRuntime,
  requireExplicitDev,
  assertPublicEnv,
  resolveCommandPublicEnv,
  resolveTarget,
  targetPlatformsForRelease,
} from './release-lib.mjs';

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const config = loadMobileConfig();
  if (args.target === 'beta') requireExplicitDev(args, 'mobile:release:check --target beta');
  assertEasLoggedIn({ mobileDir: config.mobileDir });
  const target = resolveTarget(config, {
    kind: args.target ?? (args.dev ? 'beta' : 'production'),
    dev: args.dev,
    environment: args.environment,
  });
  assertPublicEnv(resolveCommandPublicEnv(target.publicEnv), { variant: target.variant });
  const platforms = targetPlatformsForRelease(target, config.appJson);
  const fingerprints = await computeTargetFingerprints({ mobileDir: config.mobileDir, target, platforms });

  if (args.fingerprintBaseline) {
    const expected = args.expected ? String(args.expected) : null;
    console.log(`baseline: ${args.fingerprintBaseline}`);
    console.log(`target: ${target.kind}`);
    console.log(`fingerprint: ${formatLocalRuntime(fingerprints, platforms)}`);
    if (expected) {
      const actual = fingerprints.byPlatform.ios?.hash;
      if (actual !== expected) throw new Error(`Fingerprint mismatch: ${actual} != ${expected}`);
      console.log('fingerprint baseline: OK');
    }
    return;
  }

  let latest = null;
  try {
    latest = readLatestBuildRuntime(target, { cwd: config.mobileDir });
  } catch (error) {
    console.warn(`warning: unable to read latest EAS build runtime: ${error.message}`);
  }
  const mode = decideTargetReleaseMode(fingerprints, latest, platforms);
  console.log(formatPlan({
    target,
    mode,
    localRuntime: formatLocalRuntime(fingerprints, platforms),
    latestRuntime: formatLatestRuntime(latest, platforms),
    commands: [],
    execute: false,
  }));
}

main().catch((error) => {
  console.error(error.message);
  process.exit(1);
});
