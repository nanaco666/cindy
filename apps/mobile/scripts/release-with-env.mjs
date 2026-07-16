#!/usr/bin/env node
import {
  buildReleaseEnvExecCommand,
  MOBILE_DIR,
  buildReleaseEnvExecShellCommand,
  runCommandSync,
  resolveReleaseEnvExecRunPlan,
} from './release-lib.mjs';
import { injectMobileEndpointsIntoEasFile } from './mobile-endpoints.mjs';
import { productionMobileEnv } from '../../../scripts/shared/production-endpoints.mjs';

function main() {
  const [command, ...forwardedArgs] = process.argv.slice(2);
  if (!command) throw new Error('Usage: release-with-env.mjs <check|beta|prod> [...args]');

  const mobileBuildEnv = productionMobileEnv();
  const restoreEasJson = injectMobileEndpointsIntoEasFile(`${MOBILE_DIR}/eas.json`);
  const handleSigint = () => {
    restoreEasJson();
    process.exit(130);
  };
  const handleSigterm = () => {
    restoreEasJson();
    process.exit(143);
  };
  process.once('SIGINT', handleSigint);
  process.once('SIGTERM', handleSigterm);
  try {
    for (const run of resolveReleaseEnvExecRunPlan(command, forwardedArgs)) {
      const shellCommand = buildReleaseEnvExecShellCommand(command, run.forwardedArgs);
      const result = runCommandSync(buildReleaseEnvExecCommand(run.environment, shellCommand), {
        cwd: MOBILE_DIR,
        env: { ...process.env, ...mobileBuildEnv },
        stdio: 'inherit',
      });

      if (result.error) throw result.error;
      if (result.status !== 0) process.exitCode = result.status ?? 1;
      if (process.exitCode) return;
    }
  } finally {
    process.off('SIGINT', handleSigint);
    process.off('SIGTERM', handleSigterm);
    restoreEasJson();
  }
}

main();
