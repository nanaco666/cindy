#!/usr/bin/env node
/**
 * check-oauth-regression-baseline.mjs — 回调链 escape/security 基线回归门(PR0a 交付)。
 *
 * 合约来源(逐字执行):
 *  - docs/login-redesign/implementation-plan.md SC-3(v6.16:基线不再取自 PR Description
 *    自报——冻结锚点 acceptance/oauth-escape-baseline.json 为唯一权威,变更只增不减且走
 *    带用户批准记录的单独 docs PR;PR3 新品牌分支用例作为必需 testId 追加进 baseline 后
 *    本 checker 自动生效);
 *  - §「分支拓扑」第 1 条③(b)(oauth-escape-baseline 冻结锚点,只读消费)。
 *
 * 行为:
 *  1. 读 baseline(files[].file 为仓根相对路径 apps/desktop/…;执行时剥前缀相对 desktop 包);
 *  2. `pnpm --filter desktop exec vitest run <三文件> --reporter=json --outputFile=<tmp>`
 *     真实执行并解析 JSON 结果;
 *  3. 断言:基线内每个 testId 存在、非 skip/todo/pending、全部 passed;
 *     current = 本轮执行结果中命中 baseline testId 清单的用例数(baseline 追加即自动生效),
 *     须满足 current ≥ baseline.totalCount;
 *  4. 全过输出 `OAUTH_REGRESSION_BASELINE_OK current=<N> baseline=<N0>`,否则 exit 非零。
 *  testId 匹配规则:vitest JSON 用例全名 = [ancestorTitles…, title].join(" > "),
 *  与 baseline testId 完全相等(baseline.testIdFormat 同款)。
 *
 * 用法:
 *   node scripts/check-oauth-regression-baseline.mjs            # 真实执行三文件
 *   node scripts/check-oauth-regression-baseline.mjs --self-test # mock JSON 验证解析与失败路径
 * 覆盖参数(自测/联调用): --baseline <path> --run-json <path>(跳过真实执行,直接消费现成结果)
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(SCRIPT_DIR, '..');
const DEFAULT_BASELINE = path.join(REPO_ROOT, 'docs', 'login-redesign', 'acceptance', 'oauth-escape-baseline.json');
const FIXTURE_DIR = path.join(SCRIPT_DIR, '__fixtures__', 'login-fidelity', 'oauth');
const DESKTOP_PREFIX = 'apps/desktop/';

function readJson(file) {
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

/** baseline 结构轻校验(冻结锚点只读消费,结构坏了必须硬失败而非静默跳过) */
function validateBaseline(baseline, errors) {
  if (!Array.isArray(baseline.files) || baseline.files.length === 0) {
    errors.push('[BASELINE_SHAPE] baseline.files 必须为非空数组');
    return;
  }
  let sum = 0;
  for (const f of baseline.files) {
    if (typeof f.file !== 'string' || !Array.isArray(f.testIds) || f.testIds.some((t) => typeof t !== 'string' || !t)) {
      errors.push(`[BASELINE_SHAPE] files 条目非法: ${JSON.stringify(f).slice(0, 120)}`);
      continue;
    }
    if (typeof f.count === 'number' && f.count !== f.testIds.length) {
      errors.push(`[BASELINE_COUNT] ${f.file} 的 count(${f.count}) 与 testIds 数(${f.testIds.length})不符`);
    }
    sum += f.testIds.length;
  }
  if (typeof baseline.totalCount !== 'number' || baseline.totalCount !== sum) {
    errors.push(`[BASELINE_COUNT] totalCount(${baseline.totalCount}) 与 testIds 总数(${sum})不符`);
  }
}

/** 解析 vitest run --reporter=json:文件(仓根相对路径,posix 分隔) → testId → status */
function parseRunJson(raw, errors) {
  let data;
  try {
    data = typeof raw === 'string' ? JSON.parse(raw) : raw;
  } catch (e) {
    errors.push(`[RUN_PARSE] vitest JSON 解析失败: ${e.message}`);
    return new Map();
  }
  const byFile = new Map();
  for (const tr of data.testResults ?? []) {
    // tr.name 为绝对路径 → 归一成仓根相对(posix),与 baseline files[].file 对齐
    let rel = path.isAbsolute(tr.name) ? path.relative(REPO_ROOT, tr.name) : tr.name;
    rel = rel.split(path.sep).join('/');
    if (!byFile.has(rel)) byFile.set(rel, new Map());
    const m = byFile.get(rel);
    for (const ar of tr.assertionResults ?? []) {
      m.set([...(ar.ancestorTitles ?? []), ar.title].join(' > '), ar.status);
    }
  }
  return byFile;
}

/** 核心断言:基线内 testId 全部存在、非 skip/todo、全部 passed;返回 current 命中数 */
function checkAgainstBaseline(baseline, byFile, errors) {
  let current = 0;
  for (const f of baseline.files) {
    const m = byFile.get(f.file);
    if (!m) {
      errors.push(`[FILE_NOT_RUN] 基线文件未出现在执行结果中: ${f.file}`);
      continue;
    }
    for (const testId of f.testIds) {
      const status = m.get(testId);
      if (status === undefined) {
        errors.push(`[TESTID_MISSING] 基线 testId 不存在(被删/改名即回退): ${f.file} > ${testId}`);
      } else if (status !== 'passed') {
        errors.push(`[TESTID_NOT_PASSED] 基线 testId status=${status}(需 passed;skipped/todo/pending 均败): ${f.file} > ${testId}`);
      } else {
        current += 1;
      }
    }
  }
  return current;
}

function runVitest(files) {
  const outFile = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'oauth-baseline-')), 'run.json');
  const relFiles = files.map((f) => (f.startsWith(DESKTOP_PREFIX) ? f.slice(DESKTOP_PREFIX.length) : f));
  // 注意参数顺序:文件过滤在前;--reporter/--outputFile 用 = 连写,防止位置参数被吞
  const r = spawnSync('pnpm', ['--filter', 'desktop', 'exec', 'vitest', 'run', ...relFiles, '--reporter=json', `--outputFile=${outFile}`], {
    cwd: REPO_ROOT,
    encoding: 'utf8',
    maxBuffer: 512 * 1024 * 1024,
    shell: process.platform === 'win32',
  });
  return { r, outFile };
}

function runReal(opts) {
  const errors = [];
  const baseline = readJson(opts.baseline);
  validateBaseline(baseline, errors);
  if (errors.length) return { errors };
  let byFile;
  if (opts.runJson) {
    byFile = parseRunJson(fs.readFileSync(opts.runJson, 'utf8'), errors);
  } else {
    const { r, outFile } = runVitest(baseline.files.map((f) => f.file));
    if (r.error || !fs.existsSync(outFile)) {
      errors.push(`[RUN_SPAWN] vitest 执行失败: ${r.error?.message ?? (r.stderr ?? '').slice(-500)}`);
      return { errors };
    }
    byFile = parseRunJson(fs.readFileSync(outFile, 'utf8'), errors);
  }
  const current = checkAgainstBaseline(baseline, byFile, errors);
  if (errors.length === 0 && current < baseline.totalCount) {
    errors.push(`[COUNT_REGRESSION] current(${current}) < baseline(${baseline.totalCount})`);
  }
  return { errors, current, total: baseline.totalCount };
}

// ---- self-test:mock JSON 验证解析与三种失败路径(缺 testId/skipped/failed) ----
function selfTest() {
  const failures = [];
  const baseline = readJson(path.join(FIXTURE_DIR, 'baseline-fixture.json'));
  {
    const errors = [];
    validateBaseline(baseline, errors);
    if (errors.length) failures.push(`baseline fixture 结构: ${errors[0]}`);
  }
  const runCase = (mockFile, expectOk, expectCode) => {
    const errors = [];
    const byFile = parseRunJson(fs.readFileSync(path.join(FIXTURE_DIR, mockFile), 'utf8'), errors);
    const current = checkAgainstBaseline(baseline, byFile, errors);
    if (errors.length === 0 && current < baseline.totalCount) errors.push('[COUNT_REGRESSION]');
    if (expectOk && errors.length) failures.push(`${mockFile}: 预期通过,实际 ${errors[0]}`);
    if (!expectOk && !errors.some((e) => e.includes(expectCode))) {
      failures.push(`${mockFile}: 预期 ${expectCode},实际 ${JSON.stringify(errors)}`);
    }
  };
  runCase('run-all-pass.json', true);
  runCase('run-missing.json', false, 'TESTID_MISSING');
  runCase('run-skipped.json', false, 'TESTID_NOT_PASSED');
  runCase('run-failed.json', false, 'TESTID_NOT_PASSED');
  // baseline 结构损坏也必须硬失败(count 与清单不符)
  {
    const errors = [];
    const bad = structuredClone(baseline);
    bad.totalCount += 1;
    validateBaseline(bad, errors);
    if (!errors.some((e) => e.includes('BASELINE_COUNT'))) failures.push('baseline 计数不符例: 预期 BASELINE_COUNT');
  }
  if (failures.length) {
    console.error('OAUTH_BASELINE_SELF_TEST_FAILED');
    failures.forEach((f) => console.error('  - ' + f));
    process.exit(1);
  }
  console.log('OAUTH_BASELINE_SELF_TEST_OK');
}

function main() {
  const argv = process.argv.slice(2);
  const opts = { baseline: DEFAULT_BASELINE, runJson: undefined, selfTest: false };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === '--self-test') opts.selfTest = true;
    else if (a === '--baseline') opts.baseline = path.resolve(argv[++i]);
    else if (a === '--run-json') opts.runJson = path.resolve(argv[++i]);
    else {
      console.error(`未知参数: ${a}`);
      process.exit(2);
    }
  }
  if (opts.selfTest) {
    selfTest();
    return;
  }
  const { errors, current, total } = runReal(opts);
  if (errors.length) {
    errors.forEach((e) => console.error(e));
    console.error(`共 ${errors.length} 条违规`);
    process.exit(1);
  }
  console.log(`OAUTH_REGRESSION_BASELINE_OK current=${current} baseline=${total}`);
}

main();
