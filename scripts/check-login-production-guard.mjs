#!/usr/bin/env node
/**
 * check-login-production-guard.mjs — 登录 scenario fixtures 生产泄漏机器门(SC-1)。
 *
 * 合约冻结于 implementation-plan.md SC-1(v6.16):fixtures 模块内置唯一字符串
 * sentinel `__CINDY_LOGIN_FIXTURE_SENTINEL__`(字面量,minify 不改名);生产构建经
 * bundler 条件把 fixtures 整模块替换为空 stub(desktop vite alias、mobile metro
 * resolveRequest)。本脚本**冻结构建目标与产物路径全集**:
 *   1. desktop main dev 对照构建(vite --mode development,真实 vite.main.config)
 *      → 必须**含** sentinel(证明扫描通道有效 + fixtures 静态可达,防假阴);
 *   2. desktop main 生产构建(--mode production,同配置)→ 必须**不含**;
 *   3. desktop renderer 生产构建(vite build --config vite.renderer.config.ts)
 *      → 必须不含;
 *   4. mobile expo export dev 对照(NODE_ENV=development)→ 必须含;
 *   5. mobile expo export 生产(NODE_ENV=production,metro stub 生效)→ 必须不含。
 * 全过输出 `LOGIN_PRODUCTION_GUARD_OK`;任一断言失败 exit 非零。
 *
 * 构建 wrapper 配置与全部产物写入 os.tmpdir(规则 23:运行时生成物不落仓)。
 * 可选参数:--skip-mobile / --skip-desktop(局部调试用;正式门禁不带参数跑全量,
 * 带 skip 参数时最终输出为 LOGIN_PRODUCTION_GUARD_PARTIAL 而非 OK,防止误当全量证据)。
 */

import { spawnSync } from 'node:child_process';
import { mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const desktopDir = path.join(repoRoot, 'apps', 'desktop');
const mobileDir = path.join(repoRoot, 'apps', 'mobile');
const SENTINEL = '__CINDY_LOGIN_FIXTURE' + '_SENTINEL__'; // 拼接防本脚本自身被扫描误判

const args = process.argv.slice(2);
const skipMobile = args.includes('--skip-mobile');
const skipDesktop = args.includes('--skip-desktop');

const tmpRoot = mkdtempSync(path.join(os.tmpdir(), 'cindy-login-guard-'));
process.on('exit', () => {
  try {
    rmSync(tmpRoot, { recursive: true, force: true });
  } catch {
    /* 清理尽力而为 */
  }
});

/** 运行子命令(继承 env,可覆写),失败即整体失败。 */
function run(command, commandArgs, opts = {}) {
  console.log(`[guard] $ ${command} ${commandArgs.join(' ')}`);
  const result = spawnSync(command, commandArgs, {
    cwd: opts.cwd ?? repoRoot,
    env: { ...process.env, ...opts.env },
    stdio: ['ignore', 'pipe', 'pipe'],
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
  });
  if (result.status !== 0) {
    console.error(result.stdout?.slice(-4000) ?? '');
    console.error(result.stderr?.slice(-4000) ?? '');
    console.error(`LOGIN_PRODUCTION_GUARD_FAIL: 构建命令失败(exit ${result.status}): ${command} ${commandArgs.join(' ')}`);
    process.exit(1);
  }
  return result;
}

/** 递归收集目录下全部文件。 */
function collectFiles(dir) {
  const out = [];
  for (const name of readdirSync(dir)) {
    const full = path.join(dir, name);
    if (statSync(full).isDirectory()) out.push(...collectFiles(full));
    else out.push(full);
  }
  return out;
}

/** 目录内是否有任一文件含 sentinel(二进制安全:按 buffer 查)。 */
function scanDirForSentinel(dir) {
  const needle = Buffer.from(SENTINEL, 'utf8');
  const hits = [];
  for (const file of collectFiles(dir)) {
    if (readFileSync(file).includes(needle)) hits.push(path.relative(dir, file));
  }
  return hits;
}

function assertSentinel(label, dir, expectPresent) {
  const hits = scanDirForSentinel(dir);
  if (expectPresent && hits.length === 0) {
    console.error(`LOGIN_PRODUCTION_GUARD_FAIL: ${label} 未扫到 sentinel——扫描通道失效或 fixtures 不可达(假阴风险),拒绝出具生产结论`);
    process.exit(1);
  }
  if (!expectPresent && hits.length > 0) {
    console.error(`LOGIN_PRODUCTION_GUARD_FAIL: ${label} 生产产物含 sentinel(fixtures 泄漏): ${hits.join(', ')}`);
    process.exit(1);
  }
  console.log(`[guard] ${label}: sentinel ${expectPresent ? '命中(dev 对照通过)' : '未命中(生产干净)'}`);
}

/**
 * desktop main 构建 wrapper(写在 tmp,包真实 vite.main.config 并注入入口)。
 *
 * 保真口径:entry = 注入点模块 authManager.ts 本体,经**真实 vite.main.config**
 * (其 fixtures 生产 alias 条件即被测对象)打包;除 auth-client 包(含 fixtures/
 * stub)外的一切 import 全部外部化——被测机制是「'@cindy/auth-client/fixtures'
 * 在 dev/production 两种 mode 下分别解析到真模块/空 stub」,与 forge 全量 main
 * 打包共享同一配置文件与同一 mode 分支,判定等价且秒级完成(全量 main 图束
 * 包含 maker-core 等巨型依赖,在 lib 模式下有独立的 rollup 兼容问题,与本门
 * 无关)。renderer 与 mobile 段扫描的是真实产物。
 */
function buildDesktopMain(mode, outDir) {
  const baseConfigUrl = pathToFileURL(path.join(desktopDir, 'vite.main.config.ts')).href;
  const entry = path.join(desktopDir, 'src', 'main', 'authManager.ts');
  const wrapper = `
import baseFactory from ${JSON.stringify(baseConfigUrl)};

// 生产泄漏门 wrapper:复用真实 vite.main.config(含 fixtures 生产 alias 条件),
// 仅注入 forge 同款主入口与输出目录;electron/forge 注入的外部化在此显式补齐。
// 不 import 'vite'(wrapper 位于 os.tmpdir,解析不到包)——手工合并配置对象。
export default async (env) => {
  const base = typeof baseFactory === 'function' ? await baseFactory(env) : baseFactory;
  const baseBuild = base.build ?? {};
  const baseRollup = baseBuild.rollupOptions ?? {};
  const baseExternal = Array.isArray(baseRollup.external) ? baseRollup.external : [];
  return {
    ...base,
    logLevel: 'warn',
    build: {
      ...baseBuild,
      lib: {
        entry: ${JSON.stringify(entry)},
        formats: ['cjs'],
        fileName: () => 'guard-main.js',
      },
      outDir: ${JSON.stringify(outDir)},
      emptyOutDir: true,
      minify: false,
      sourcemap: false,
      rollupOptions: {
        ...baseRollup,
        // lib 单入口输出与 manualChunks 不兼容;guard 只关心字节内容,去掉分块策略。
        output: undefined,
        // 只内联 auth-client 包(fixtures/stub 与其 src);其余一律外部化——
        // 被测对象是 fixtures 子路径在两种 mode 下的解析结果,不是全量 main 图束。
        external: (id) => {
          if (id === ${JSON.stringify(entry)}) return false;
          if (id.startsWith('\\0')) return false;
          if (id === '@cindy/auth-client' || id === '@cindy/auth-client/fixtures') return false;
          const norm = id.replace(/\\\\/g, '/');
          if (norm.includes('packages/auth-client/')) return false;
          return true;
        },
      },
    },
  };
};
`;
  const wrapperPath = path.join(tmpRoot, `vite-guard-main-${mode}.config.mts`);
  writeFileSync(wrapperPath, wrapper);
  run('pnpm', ['--filter', 'desktop', 'exec', 'vite', 'build', '--config', wrapperPath, '--mode', mode], {
    cwd: repoRoot,
  });
}

if (!skipDesktop) {
  // 1) desktop main dev 对照:必须含 sentinel
  const devOut = path.join(tmpRoot, 'desktop-main-dev');
  buildDesktopMain('development', devOut);
  assertSentinel('desktop main(dev 对照)', devOut, true);

  // 2) desktop main 生产:必须不含
  const prodOut = path.join(tmpRoot, 'desktop-main-prod');
  buildDesktopMain('production', prodOut);
  assertSentinel('desktop main(production)', prodOut, false);

  // 3) desktop renderer 生产(真实 config,输出到 .vite/renderer/main_window)
  run('pnpm', ['--filter', 'desktop', 'exec', 'vite', 'build', '--config', 'vite.renderer.config.ts'], {
    cwd: repoRoot,
  });
  const rendererOut = path.join(desktopDir, '.vite', 'renderer', 'main_window');
  assertSentinel('desktop renderer(production)', rendererOut, false);
}

if (!skipMobile) {
  // 4) mobile expo export dev 对照(NODE_ENV=development → metro stub 不生效)
  const mobileDevOut = path.join(tmpRoot, 'mobile-export-dev');
  run(
    'pnpm',
    ['--filter', 'mobile', 'exec', 'expo', 'export', '--platform', 'ios', '--dev', '--output-dir', mobileDevOut],
    { cwd: repoRoot, env: { NODE_ENV: 'development', CI: '1' } },
  );
  assertSentinel('mobile expo export(dev 对照)', mobileDevOut, true);

  // 5) mobile expo export 生产(NODE_ENV=production → metro stub 生效)
  const mobileProdOut = path.join(tmpRoot, 'mobile-export-prod');
  run(
    'pnpm',
    ['--filter', 'mobile', 'exec', 'expo', 'export', '--platform', 'ios', '--output-dir', mobileProdOut],
    { cwd: repoRoot, env: { NODE_ENV: 'production', CI: '1' } },
  );
  assertSentinel('mobile expo export(production)', mobileProdOut, false);
}

if (skipMobile || skipDesktop) {
  console.log('LOGIN_PRODUCTION_GUARD_PARTIAL(带 --skip-* 参数,不构成全量生产证据)');
} else {
  console.log('LOGIN_PRODUCTION_GUARD_OK');
}
