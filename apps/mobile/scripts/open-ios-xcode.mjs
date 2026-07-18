#!/usr/bin/env node
// 按显式 region 重新生成 iOS 原生工程、安装 Pods，然后打开 app 的 .xcworkspace。
// 这是本地开发入口：不 archive、不上传 NPKG/OSS，也不写任何发版记录。

import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { mobileClientBuildEnv } from '../../../scripts/shared/client-endpoint-build-env.mjs';
import { podInstallBounded } from './sim-pod-install.mjs';
import {
  mobileXcodeGeneratedDir,
  parseMobileXcodeArgs,
  selectMobileXcodeWorkspace,
  updateMobileXcodeEnvContent,
} from './lib/mobile-xcode.mjs';

const mobileDir = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const iosDir = resolve(mobileDir, 'ios');
const envPath = resolve(mobileDir, '.env');

function printUsage() {
  console.log(`用法:
  pnpm mobile:xcode --region=cn       # 国服
  pnpm mobile:xcode --region=global   # 海外

流程:切换 apps/mobile/.env 地区 → clean prebuild → 安装 Pods → 打开 Xcode workspace
说明:只准备本地 Xcode 工程，不会上传或发布。`);
}

async function main() {
  const args = parseMobileXcodeArgs(process.argv.slice(2));
  if (args.help) {
    printUsage();
    return;
  }
  if (process.platform !== 'darwin') {
    throw new Error('mobile:xcode 只能在安装了 Xcode 的 macOS 上运行');
  }

  const buildEnv = mobileClientBuildEnv({ authRegion: args.region });
  const env = { ...process.env, ...buildEnv };
  const previousEnv = existsSync(envPath) ? readFileSync(envPath, 'utf8') : '';
  const nextEnv = updateMobileXcodeEnvContent(previousEnv, buildEnv);
  if (nextEnv !== previousEnv) writeFileSync(envPath, nextEnv);

  console.log(`\n› 准备 Cindy iOS Xcode 工程(region=${args.region})`);
  console.log(`  bundle: ${args.region === 'global' ? 'com.xd.cindy' : 'com.xd.cindycn'}`);
  console.log(`  已同步 apps/mobile/.env；后续 Metro 将沿用 ${args.region}。`);
  console.log('› clean prebuild(重新生成 ios/，避免沿用另一地区的 bundle/scheme)…');
  execFileSync('pnpm', ['exec', 'expo', 'prebuild', '-p', 'ios', '--clean', '--no-install'], {
    cwd: mobileDir,
    env,
    stdio: 'inherit',
  });

  console.log('› pod install(本地 specs 优先，输出空转看门狗兜底)…');
  await podInstallBounded({ iosDir, env });

  const workspace = selectMobileXcodeWorkspace(iosDir, readdirSync(iosDir));
  console.log(`› 打开 ${workspace}`);
  execFileSync('open', ['-a', 'Xcode', workspace], { cwd: mobileDir, stdio: 'inherit' });
  console.log(`\n✓ ${args.region === 'global' ? '海外版' : '国服版'} Xcode 工程已生成并打开。`);
  console.log(`  工程目录: ${mobileXcodeGeneratedDir(workspace)}`);
  console.log('  在 Xcode 选择真机或模拟器后点击 Run；如果 Metro 已在运行，请重启它以加载新地区 env。');
}

main().catch((error) => {
  console.error(`✗ ${error.message}`);
  process.exit(1);
});
