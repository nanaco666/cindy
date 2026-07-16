#!/usr/bin/env node

import { execSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import {
  DESKTOP_ROOT,
  ensureLinuxRuntimeAssets,
  logLinuxPackagingRequirements,
  loadDotenv,
  runDbValidate,
  runSmokeTest,
  writePackageVersion,
} from './lib.mjs';
import { productionViteEnv } from '../../../../scripts/shared/production-endpoints.mjs';

loadDotenv();

function parseArgs() {
  const args = process.argv.slice(2);
  let version = null;
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--version' && args[i + 1]) version = args[++i];
  }
  if (!version) {
    console.error('ERROR: --version <x.y.z> is required');
    process.exit(1);
  }
  return { version };
}

async function main() {
  const { version } = parseArgs();
  writePackageVersion(version);
  await ensureLinuxRuntimeAssets();
  logLinuxPackagingRequirements();
  runDbValidate();

  const outDir = path.join(DESKTOP_ROOT, 'out');
  if (fs.existsSync(outDir)) {
    fs.rmSync(outDir, { recursive: true, force: true });
  }

  execSync('npx electron-forge make --platform linux --arch x64', {
    cwd: DESKTOP_ROOT,
    stdio: 'inherit',
    env: {
      ...process.env,
      NODE_ENV: 'production',
      ...productionViteEnv(),
      APP_VERSION: version,
    },
  });

  runSmokeTest('linux', 'x64');
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
