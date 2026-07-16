#!/usr/bin/env node
import {
  buildReleaseEnvExecCommand,
  MOBILE_DIR,
  buildReleaseEnvExecShellCommand,
  runCommandSync,
  resolveReleaseEnvExecRunPlan,
} from './release-lib.mjs';

function main() {
  const [command, ...forwardedArgs] = process.argv.slice(2);
  if (!command) throw new Error('Usage: release-with-env.mjs <check|beta|prod> [...args]');

  for (const run of resolveReleaseEnvExecRunPlan(command, forwardedArgs)) {
    const shellCommand = buildReleaseEnvExecShellCommand(command, run.forwardedArgs);
    const result = runCommandSync(buildReleaseEnvExecCommand(run.environment, shellCommand), {
      cwd: MOBILE_DIR,
      env: process.env,
      stdio: 'inherit',
    });

    if (result.error) throw result.error;
    if (result.status !== 0) process.exit(result.status ?? 1);
  }
}

main();
