#!/usr/bin/env node
/**
 * build-computer-use-companion.mjs
 *
 * 构建 "Cindy Computer Use.app" companion bundle。
 *
 * 用途:
 *   - dev 开发期:由 forge prePackage 或手动执行,产出 .app 到
 *     apps/desktop/resources/tools/computer-use-companion/
 *   - packaged:forge prePackage hook 调用(buildMacComputerUseCompanion)
 *
 * 接口:
 *   --platform-key=<darwin-arm64|darwin-x64>  默认当前平台
 *   --force                                    强制重建(忽略指纹缓存)
 *
 * 指纹缓存机制:
 *   Contents/Resources/.build-fingerprint = SHA-256(Swift 源 + Info.plist + 引擎 .version)
 *   指纹未变且非 --force 时跳过重建,保持 cdhash 稳定避免 TCC 失效。
 *
 * 退出码:
 *   0  成功(最后一行 stdout = bundle 绝对路径)
 *   1  出错
 */

import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

// ── 路径配置 ──────────────────────────────────────────────────────────────────

const __dirname = path.dirname(fileURLToPath(import.meta.url));

/** apps/desktop 目录 */
const desktopDir = path.resolve(__dirname, '..');

/** Swift 源文件目录 */
const nativeSrcDir = path.join(desktopDir, 'native', 'computer-use-companion');

/** Swift 可执行文件名(与 Info.plist CFBundleExecutable 对齐) */
const EXECUTABLE_NAME = 'CindyComputerUse';

/** bundle 名称 */
const APP_NAME = 'Cindy Computer Use.app';

/** 输出目录 */
const destDir = path.join(desktopDir, 'resources', 'tools', 'computer-use-companion');

/** 输出 bundle 路径 */
const bundlePath = path.join(destDir, APP_NAME);

// ── 参数解析 ──────────────────────────────────────────────────────────────────

function parseArgs() {
  const args = process.argv.slice(2);
  let platformKey = null;
  let force = false;

  for (const arg of args) {
    if (arg.startsWith('--platform-key=')) {
      platformKey = arg.slice('--platform-key='.length);
    } else if (arg === '--force') {
      force = true;
    }
  }

  // 默认当前平台
  if (!platformKey) {
    const plat = process.platform === 'darwin' ? 'darwin' : process.platform;
    const arch = process.arch === 'arm64' ? 'arm64' : process.arch === 'x64' ? 'x64' : process.arch;
    platformKey = `${plat}-${arch}`;
  }

  return { platformKey, force };
}

// ── 平台→Swift target 映射 ────────────────────────────────────────────────────

/** 将 platform-key 转成 swiftc -target triple 列表(universal 时返回两个) */
function swiftTargets(platformKey) {
  const deploymentTarget = '13.0';
  switch (platformKey) {
    case 'darwin-arm64':
      return [`arm64-apple-macos${deploymentTarget}`];
    case 'darwin-x64':
      return [`x86_64-apple-macos${deploymentTarget}`];
    case 'darwin-universal':
      return [
        `arm64-apple-macos${deploymentTarget}`,
        `x86_64-apple-macos${deploymentTarget}`,
      ];
    default:
      throw new Error(`[build-companion] unsupported platform key: ${platformKey}`);
  }
}

// ── 指纹计算 ──────────────────────────────────────────────────────────────────

/**
 * 计算构建指纹:SHA-256(Swift 源内容 + Info.plist 内容 + 引擎 .version 内容)。
 * 任何输入变化都会导致指纹变化,触发重建。
 */
function computeFingerprint(platformKey, swiftSrcFiles, infoPlistPath, engineDir) {
  const h = createHash('sha256');
  h.update(`platform:${platformKey}\n`);

  // Swift 源文件按路径排序后哈希内容
  const sortedSrcs = [...swiftSrcFiles].sort();
  for (const f of sortedSrcs) {
    h.update(`src:${path.basename(f)}\n`);
    h.update(fs.readFileSync(f));
  }

  // Info.plist
  h.update('infoplist:\n');
  h.update(fs.readFileSync(infoPlistPath));

  // 引擎 .version 文件
  const versionPath = path.join(engineDir, '.version');
  if (fs.existsSync(versionPath)) {
    h.update('engine-version:\n');
    h.update(fs.readFileSync(versionPath));
  } else {
    h.update('engine-version:unknown\n');
  }

  return h.digest('hex');
}

// ── Swiftc 编译 ───────────────────────────────────────────────────────────────

/** 编译单个 target triple 到目标文件 */
function compileSwift(srcFiles, dest, target) {
  const sdk = spawnSync('xcrun', ['--show-sdk-path'], { encoding: 'utf8' });
  if (sdk.error || sdk.status !== 0) {
    throw new Error('[build-companion] xcrun --show-sdk-path failed: ' + (sdk.stderr || sdk.error));
  }
  const sdkPath = sdk.stdout.trim();

  const args = ['-target', target, '-sdk', sdkPath, '-O', ...srcFiles, '-o', dest];
  console.log(`[build-companion] swiftc (${target}) ...`);
  const r = spawnSync('swiftc', args, { stdio: 'inherit' });
  if (r.error) throw new Error(`[build-companion] swiftc spawn failed: ${r.error.message}`);
  if (r.status !== 0) throw new Error(`[build-companion] swiftc failed (${target}) with exit ${r.status}`);
}

/** 编译并(如需)用 lipo 合并为 universal binary */
function buildExecutable(srcFiles, dest, targets) {
  if (targets.length === 1) {
    compileSwift(srcFiles, dest, targets[0]);
    return;
  }

  // universal:分别编译再 lipo
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cindy-companion-'));
  const slices = targets.map((t) => path.join(tmpDir, `${EXECUTABLE_NAME}-${t.split('-')[0]}`));
  try {
    targets.forEach((t, i) => compileSwift(srcFiles, slices[i], t));
    const lipoArgs = ['-create', ...slices, '-output', dest];
    console.log('[build-companion] lipo -create ...');
    const r = spawnSync('lipo', lipoArgs, { stdio: 'inherit' });
    if (r.error) throw new Error(`[build-companion] lipo spawn failed: ${r.error.message}`);
    if (r.status !== 0) throw new Error(`[build-companion] lipo failed with exit ${r.status}`);
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
}

// ── 引擎 payload staging ──────────────────────────────────────────────────────

/** 将 apps/cua-driver-bin/<platformKey>/ 整体 stage 进 bundle Contents/Resources/engine/ */
function stageEngine(platformKey, bundleResourcesDir) {
  const engineSrcDir = path.join(desktopDir, '..', 'cua-driver-bin', platformKey);
  if (!fs.existsSync(engineSrcDir)) {
    throw new Error(
      `[build-companion] cua-driver payload missing at ${engineSrcDir}.\n` +
        `Run "pnpm install:cua-driver" first.`
    );
  }

  const engineDestDir = path.join(bundleResourcesDir, 'engine');
  fs.rmSync(engineDestDir, { recursive: true, force: true });
  fs.mkdirSync(engineDestDir, { recursive: true });

  // 递归复制 payload 目录下所有文件
  const entries = fs.readdirSync(engineSrcDir, { withFileTypes: true });
  for (const entry of entries) {
    const src = path.join(engineSrcDir, entry.name);
    const dest = path.join(engineDestDir, entry.name);
    if (entry.isDirectory()) {
      fs.cpSync(src, dest, { recursive: true });
    } else {
      fs.copyFileSync(src, dest);
      // 保留可执行位
      const srcMode = fs.statSync(src).mode;
      fs.chmodSync(dest, srcMode);
    }
  }

  // 确保主二进制可执行
  const binDest = path.join(engineDestDir, 'cua-driver');
  if (fs.existsSync(binDest)) {
    fs.chmodSync(binDest, 0o755);
  }

  console.log(`[build-companion] engine staged from ${engineSrcDir} → ${engineDestDir}`);
}

// ── 主流程 ────────────────────────────────────────────────────────────────────

async function main() {
  if (process.platform !== 'darwin') {
    // companion 只能在 macOS 上构建;非 darwin 主机属于错误调用
    console.error('[build-companion] ERROR: companion can only be built on macOS');
    process.exit(1);
  }

  const { platformKey, force } = parseArgs();

  if (!platformKey.startsWith('darwin-')) {
    // 非 darwin platform key 同样属于错误调用
    console.error(`[build-companion] ERROR: companion can only be built on macOS (platform key "${platformKey}" is not darwin)`);
    process.exit(1);
  }

  console.log(`[build-companion] platform-key=${platformKey} force=${force}`);

  // Swift 源文件列表(按字母序)
  const swiftSrcFiles = fs
    .readdirSync(nativeSrcDir)
    .filter((f) => f.endsWith('.swift'))
    .sort()
    .map((f) => path.join(nativeSrcDir, f));

  if (swiftSrcFiles.length === 0) {
    throw new Error(`[build-companion] no Swift source files found in ${nativeSrcDir}`);
  }

  const infoPlistSrc = path.join(nativeSrcDir, 'Info.plist');
  if (!fs.existsSync(infoPlistSrc)) {
    throw new Error(`[build-companion] Info.plist template missing at ${infoPlistSrc}`);
  }

  const engineDir = path.join(desktopDir, '..', 'cua-driver-bin', platformKey);
  const fingerprint = computeFingerprint(platformKey, swiftSrcFiles, infoPlistSrc, engineDir);

  // 检查指纹缓存
  const fingerprintFile = path.join(bundlePath, 'Contents', 'Resources', '.build-fingerprint');
  if (!force && fs.existsSync(fingerprintFile)) {
    const existing = fs.readFileSync(fingerprintFile, 'utf8').trim();
    if (existing === fingerprint) {
      console.log(`[build-companion] fingerprint unchanged (${fingerprint.slice(0, 12)}…) — skipping rebuild`);
      console.log(bundlePath);
      return;
    }
    console.log(`[build-companion] fingerprint changed (${existing.slice(0, 12)}… → ${fingerprint.slice(0, 12)}…) — rebuilding`);
  } else if (force) {
    console.log(`[build-companion] --force specified — rebuilding`);
  } else {
    console.log(`[build-companion] no existing bundle or fingerprint — building fresh`);
  }

  // 清理旧 bundle
  fs.rmSync(bundlePath, { recursive: true, force: true });

  // 创建 bundle 目录结构
  const macOSDir = path.join(bundlePath, 'Contents', 'MacOS');
  const resourcesDir = path.join(bundlePath, 'Contents', 'Resources');
  fs.mkdirSync(macOSDir, { recursive: true });
  fs.mkdirSync(resourcesDir, { recursive: true });

  // 编译 Swift → 可执行文件
  const execDest = path.join(macOSDir, EXECUTABLE_NAME);
  const targets = swiftTargets(platformKey);
  buildExecutable(swiftSrcFiles, execDest, targets);
  fs.chmodSync(execDest, 0o755);

  // 复制 Info.plist
  fs.copyFileSync(infoPlistSrc, path.join(bundlePath, 'Contents', 'Info.plist'));

  // Stage 引擎 payload
  stageEngine(platformKey, resourcesDir);

  // 写入指纹文件(供 companion 运行时读取为 hello.companionFingerprint)
  fs.writeFileSync(fingerprintFile, fingerprint + '\n', 'utf8');

  // Ad-hoc codesign
  console.log('[build-companion] codesigning (ad-hoc)...');
  const sign = spawnSync('codesign', ['--force', '--deep', '--sign', '-', bundlePath], {
    stdio: 'inherit',
  });
  if (sign.error) throw new Error(`[build-companion] codesign spawn failed: ${sign.error.message}`);
  if (sign.status !== 0) throw new Error(`[build-companion] codesign failed with exit ${sign.status}`);

  const sizeMb = (fs.statSync(execDest).size / (1024 * 1024)).toFixed(2);
  console.log(
    `[build-companion] done → ${bundlePath} (executable ${sizeMb} MB, fingerprint ${fingerprint.slice(0, 12)}…)`
  );

  // 成功时最后一行输出 bundle 绝对路径(供调用方解析)
  console.log(bundlePath);
}

main().catch((err) => {
  console.error('[build-companion] ERROR:', err.message || err);
  process.exit(1);
});
