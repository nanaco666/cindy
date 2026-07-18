#!/usr/bin/env node

// =============================================================================
// build-macos.mjs — CI 构建阶段：仅构建 macOS .app
//
// 用法: node scripts/ci/build-macos.mjs --arch <arm64|x64> --version <x.y.z>
//
// 流程:
//   1. 写版本号到 package.json (退出时自动恢复)
//   2. db:validate 校验
//   3. electron-forge make (含 APP_VERSION 注入)
//   4. 验证 packaged 内 drizzle 文件
//   5. ad-hoc 签名，附带本地测试所需 entitlements
//   6. 运行 packaged smoke test
//
// 输出: out/<PACKAGED_APP_NAME>-darwin-<arch>/<PACKAGED_APP_NAME>.app (ad-hoc signed)
//
// 这一步不使用开发者证书、不公证、不上传 OSS。后续由 publish-macos.mjs
// 用真实证书重新签名。这里的 ad-hoc 签名是为了让本地 packaged app
// 测试语音输入时具备 audio-input entitlement，否则 macOS 可能不会真正
// 激活麦克风。
// =============================================================================

import { execSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import {
  DESKTOP_ROOT,
  loadDotenv,
  writePackageVersion,
  runDbValidate,
  verifyPackagedDrizzle,
  runSmokeTest,
  writeMacEntitlements,
  adhocSignMacApp,
  PACKAGED_APP_NAME,
} from './lib.mjs';
import { desktopClientBuildEnv } from '../../../../scripts/shared/client-endpoint-build-env.mjs';

loadDotenv(undefined, { refreshReleaseConfig: false });

// ── 参数解析 ──────────────────────────────────────────────────────────────

function parseArgs() {
  const args = process.argv.slice(2);
  let arch = null;
  let version = null;
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--arch' && args[i + 1]) { arch = args[++i]; continue; }
    if (args[i] === '--version' && args[i + 1]) { version = args[++i]; continue; }
  }
  if (!arch || !['arm64', 'x64'].includes(arch)) {
    console.error('ERROR: --arch <arm64|x64> is required');
    process.exit(1);
  }
  if (!version) {
    console.error('ERROR: --version <x.y.z> is required');
    process.exit(1);
  }
  return { arch, version };
}

// ── Main ──────────────────────────────────────────────────────────────────

async function main() {
  const { arch, version } = parseArgs();

  console.log('='.repeat(60));
  console.log(`==> Build macOS ${arch}, version ${version}`);
  console.log('='.repeat(60));

  // 1. 写版本号 (退出时自动恢复)
  writePackageVersion(version);

  // 2. db:validate
  runDbValidate();

  // 3. 清理 + electron-forge make
  const outDir = path.join(DESKTOP_ROOT, 'out');
  if (fs.existsSync(outDir)) {
    console.log('==> Cleaning previous build output...');
    fs.rmSync(outDir, { recursive: true, force: true });
  }

  console.log('==> Running electron-forge make...');
  execSync(`npx electron-forge make --platform darwin --arch ${arch}`, {
    cwd: DESKTOP_ROOT,
    stdio: 'inherit',
    env: {
      ...process.env,
      NODE_ENV: 'production',
      ...desktopClientBuildEnv(),
      APP_VERSION: version, // forge.config.ts 读取此变量注入到 packagerConfig.appVersion
    },
  });

  // 4. 验证 .app 存在
  const packagedDir = path.join(DESKTOP_ROOT, 'out', `${PACKAGED_APP_NAME}-darwin-${arch}`);
  const appPath = path.join(packagedDir, `${PACKAGED_APP_NAME}.app`);
  if (!fs.existsSync(appPath)) {
    console.error(`ERROR: ${appPath} not found`);
    process.exit(1);
  }
  console.log(`==> Found app: ${appPath}`);

  // 5. 验证 drizzle 资源
  const drizzleOut = path.join(appPath, 'Contents', 'Resources', 'drizzle');
  verifyPackagedDrizzle(drizzleOut);

  // 6. Ad-hoc sign with the same runtime entitlements used by the release
  // signer. Local packaged voice-input tests need audio-input entitlement even
  // though publish-macos.mjs will later replace this with a real certificate.
  const helperEntitlementsPath = path.join(outDir, 'build-local-helper.entitlements');
  const mainEntitlementsPath = path.join(outDir, 'build-local-main.entitlements');
  writeMacEntitlements(helperEntitlementsPath);
  writeMacEntitlements(mainEntitlementsPath, { appleEvents: true });
  adhocSignMacApp(appPath, helperEntitlementsPath, mainEntitlementsPath);

  // 7. Smoke test
  runSmokeTest('darwin', arch);

  console.log('');
  console.log('=== Build complete ===');
  console.log(`Output: ${appPath}`);
  console.log(`Next:   node scripts/ci/publish-macos.mjs --arch ${arch} --version ${version}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
