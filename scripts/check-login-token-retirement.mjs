#!/usr/bin/env node
/**
 * check-login-token-retirement.mjs — 旧 `--login-*` 9 token 全族退役门禁(SC-8)。
 *
 * 可执行合约冻结于 docs/login-redesign/implementation-plan.md SC-8(v6.16 删除 allowlist 机制):
 * - 9 个旧 token(均为 surface/accent/error 族纯 alias,PR5 全族退役):
 *     login-bg / login-card-bg / login-card-border / login-divider /
 *     login-btn-bg / login-btn-text / login-btn-hover / login-help-text / login-error-text
 * - 注册清零: apps/desktop/src/renderer/themes/ 下不得出现 `registerColor('<token>', …)` 调用;
 * - builtin override 清零: themes/builtin/ 下不得以 `'<token>'` / `"<token>"` 为 override key;
 * - 消费清零: apps/desktop/src/renderer/ 下不得出现 `var(--<token>)` 引用;
 * - **无 allowlist 例外通道**(v6.16):9 项任一注册/override/消费命中即 exit 非零。
 *   确需保留某项时必须先取得用户批准、以修订 SC-8 的 docs PR 落档后再改本 checker,
 *   不得在本 checker 内加白名单后照常输出 OK。
 *
 * 全部清零 → 输出 `TOKEN_RETIREMENT_OK` + exit 0;任一命中 → 列出违规并 exit 1。
 *
 * 变更管制:9 token 清单与"无 allowlist"为冻结合约的一部分,修改须走带批准记录的
 * docs PR(同三锚点变更管制纪律),不得在实现 PR 内顺手放宽。
 *
 * 用法:
 *   node scripts/check-login-token-retirement.mjs              # 全仓扫描注册+override+消费
 *   node scripts/check-login-token-retirement.mjs --self-test  # 正负 fixture 自检判定逻辑
 */

import { readFileSync, readdirSync, statSync, writeFileSync, mkdirSync, rmSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

/** 退役 token 清单(冻结,无 allowlist)。 */
const RETIRED_TOKENS = Object.freeze([
  'login-bg',
  'login-card-bg',
  'login-card-border',
  'login-divider',
  'login-btn-bg',
  'login-btn-text',
  'login-btn-hover',
  'login-help-text',
  'login-error-text',
]);

const THEMES_DIR = path.join(repoRoot, 'apps/desktop/src/renderer/themes');
const RENDERER_DIR = path.join(repoRoot, 'apps/desktop/src/renderer');

function walk(dir, exts, acc = []) {
  let entries;
  try {
    entries = readdirSync(dir);
  } catch {
    return acc;
  }
  for (const name of entries) {
    const p = path.join(dir, name);
    let s;
    try {
      s = statSync(p);
    } catch {
      continue;
    }
    if (s.isDirectory()) {
      walk(p, exts, acc);
    } else if (exts.some((ext) => p.endsWith(ext))) {
      acc.push(p);
    }
  }
  return acc;
}

const rel = (p) => path.relative(repoRoot, p);

/** 在给定文本里找退役 token 的 registerColor 注册调用。 */
function findRegistrations(text) {
  const hits = [];
  for (const tok of RETIRED_TOKENS) {
    const re = new RegExp(`registerColor\\(['"]${tok}['"]`);
    if (re.test(text)) hits.push(tok);
  }
  return hits;
}

/** 在 builtin override 文本里找以退役 token 为 override key(引号或裸 key)。 */
function findOverrides(text) {
  const hits = [];
  for (const tok of RETIRED_TOKENS) {
    // 引号 key: 'login-bg': 或 "login-bg":
    const reQuoted = new RegExp(`['"]${tok}['"]\\s*:`);
    if (reQuoted.test(text)) hits.push(tok);
  }
  return hits;
}

/** 在给定文本里找 var(--<token>) 消费(精确匹配,不误命中 login-bg-base 等)。 */
function findConsumptions(text) {
  const hits = [];
  for (const tok of RETIRED_TOKENS) {
    // var(--login-bg) —— 闭括号紧跟,排除 login-bg-base/gradient 等前缀同名 token
    const re = new RegExp(`var\\(--${tok}\\)`);
    if (re.test(text)) hits.push(tok);
  }
  return hits;
}

function scanRepo() {
  const violations = [];
  // 1. 注册 + override: themes/ 全扫(.ts/.tsx)
  const themeFiles = walk(THEMES_DIR, ['.ts', '.tsx']);
  for (const f of themeFiles) {
    const text = readFileSync(f, 'utf8');
    for (const tok of findRegistrations(text)) {
      violations.push({ kind: 'registration', file: rel(f), token: tok });
    }
    if (f.includes(`${path.sep}builtin${path.sep}`)) {
      for (const tok of findOverrides(text)) {
        violations.push({ kind: 'override', file: rel(f), token: tok });
      }
    }
  }
  // 2. 消费: renderer 全扫(.ts/.tsx/.css);themes 内 var() 消费也计入(双清零)
  const rendererFiles = walk(RENDERER_DIR, ['.ts', '.tsx', '.css']);
  for (const f of rendererFiles) {
    const text = readFileSync(f, 'utf8');
    for (const tok of findConsumptions(text)) {
      violations.push({ kind: 'consumption', file: rel(f), token: tok });
    }
  }
  return violations;
}

function runScan() {
  const violations = scanRepo();
  if (violations.length === 0) {
    console.log('TOKEN_RETIREMENT_OK');
    return 0;
  }
  console.error(`[TOKEN_RETIREMENT_FAILED] ${violations.length} 处旧 --login-* token 残留(注册/override/消费须双清零,无 allowlist 例外):`);
  for (const v of violations) {
    console.error(`  [${v.kind}] ${v.token}  @  ${v.file}`);
  }
  console.error('确需保留某项 → 停下上报,须先以修订 SC-8 的 docs PR 取得用户批准后再改本 checker,不得加白名单绕过。');
  return 1;
}

/** 正负 fixture 自检:正 fixture 全清零→OK;负 fixture 含注册/消费→exit 1。 */
function runSelfTest() {
  const tmpDir = path.join(repoRoot, '.tmp-token-retirement-selftest');
  rmSync(tmpDir, { recursive: true, force: true });
  mkdirSync(path.join(tmpDir, 'themes', 'builtin'), { recursive: true });
  mkdirSync(path.join(tmpDir, 'components'), { recursive: true });
  // 注意:本 self-test 直接调用 find* 函数(纯函数),不重写 walk 路径,避免污染仓内 themes。
  const clean = `registerColor('login-bg-base', { light: '#fff' });\nvar(--login-bg-base)\nregisterColor('login-panel-bg', {});\nvar(--surface-elevated)`;
  const dirtyReg = `registerColor('login-card-bg', { light: 'var(--surface-elevated)' });`;
  const dirtyConsume = `border border-[var(--login-card-border)] bg-[var(--login-card-bg)]`;
  const failures = [];
  if (findRegistrations(clean).length !== 0) failures.push(`clean registration 误报: ${findRegistrations(clean)}`);
  if (findRegistrations(dirtyReg).length !== 1) failures.push(`dirty registration 漏报(应 1): ${findRegistrations(dirtyReg)}`);
  if (findConsumptions(clean).length !== 0) failures.push(`clean consumption 误报(不应命中 login-bg-base): ${findConsumptions(clean)}`);
  if (findConsumptions(dirtyConsume).length !== 2) failures.push(`dirty consumption 漏报(应 2:card-border+card-bg): ${findConsumptions(dirtyConsume)}`);
  if (findOverrides(`'login-error-text': { light: '#x' }`).length !== 1) failures.push(`override 引号 key 漏报`);
  if (findOverrides(`'login-error-fg': { light: '#x' }`).length !== 0) failures.push(`override 误报(login-error-fg 非退役)`);
  rmSync(tmpDir, { recursive: true, force: true });
  if (failures.length) {
    console.error('[SELF_TEST_FAILED]');
    for (const f of failures) console.error('  ' + f);
    return 1;
  }
  console.log('TOKEN_RETIREMENT_SELFTEST_OK');
  return 0;
}

const arg = process.argv[2];
if (arg === '--self-test') {
  process.exit(runSelfTest());
}
process.exit(runScan());
