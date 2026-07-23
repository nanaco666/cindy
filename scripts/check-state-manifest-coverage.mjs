#!/usr/bin/env node
/**
 * check-state-manifest-coverage.mjs — 登录换肤 state-manifest 测试覆盖校验器(PR0a 交付)。
 *
 * 合约来源(逐字执行):
 *  - docs/login-redesign/implementation-plan.md SC-2(桌面)/SC-7(移动)v6.16 三重职责:
 *    ① 全集独立锚定——manifest 中 platform=目标 的行,rowId 集合与
 *       acceptance/required-state-catalog.json 同 platform 行精确相等(空/子/超集均败),
 *       且逐行 ground-truth 八字段(platform/rowKind/stateFamily/dimension/source/ref/
 *       applicability/naAllowed)与 catalog 深等(v6.17,期望权威在 catalog 不在 manifest);
 *    ② 每行 tests 映射到 test file + 唯一 testId——用 `vitest list --json` 子命令解析
 *       (本仓 Vitest 3.2.7 无 --list 参数,已实测;注意 --json 必须放在文件过滤参数之后,
 *       否则其后的位置参数会被当作 --json 的输出文件路径吞掉并覆盖该文件);
 *       0 命中或重名均败;
 *    ③ --run-mapped——真实执行全部映射用例(vitest run --reporter=json)并逐 testId 断言
 *       status==="passed";skipped/todo/pending/仅收集未执行一律失败(收集≠通过)。
 *  - 附录 B ManifestRow.tests 字段与 catalog 变更管制。
 *
 * 用法:
 *   node scripts/check-state-manifest-coverage.mjs --platform desktop [--run-mapped] [--slice prN]
 *   node scripts/check-state-manifest-coverage.mjs --platform mobile [--run-mapped] [--slice prN]
 *   node scripts/check-state-manifest-coverage.mjs --self-test
 * 覆盖参数(fixture 自测用): --manifest <path> --catalog <path>
 *
 * `--slice prN`(PR1 追加,additive):②tests 映射与 ③--run-mapped 只作用于
 * manifest 中 slice===prN 的行(各实现 PR 的合并门,未到门禁的 slice 行不误判);
 * ①全集独立锚定始终对全平台行执行(锚不随 slice 收窄,防「切片绕锚」)。
 * 不带 --slice 时语义与 PR0a 完全一致(全行必须有映射,--run-mapped 全量)。
 *
 * 注:manifest tests 由各 slice PR 逐步填入;未填 slice 的行在对应 --slice 门禁
 * 到来前不参与 ②③(但始终参与 ①)。
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(SCRIPT_DIR, '..');
const ACCEPTANCE_DIR = path.join(REPO_ROOT, 'docs', 'login-redesign', 'acceptance');
// 目录名不能叫 coverage/:仓根 .gitignore 的 `coverage/` 规则会把 fixture 静默
// 排除出提交(PR0a 实踩——self-test 本地绿但 fixture 未入仓,PR1 更名修复)。
const FIXTURE_DIR = path.join(SCRIPT_DIR, '__fixtures__', 'login-fidelity', 'manifest-coverage');
const VITEST_MJS = path.join(REPO_ROOT, 'node_modules', 'vitest', 'vitest.mjs');

// platform → pnpm workspace filter 与 manifest tests[].file 的仓根前缀
const PLATFORM_PKG = Object.freeze({
  desktop: { filter: 'desktop', prefix: 'apps/desktop/' },
  mobile: { filter: 'mobile', prefix: 'apps/mobile/' },
});

const GROUND_TRUTH_FIELDS = Object.freeze([
  'platform',
  'rowKind',
  'stateFamily',
  'dimension',
  'source',
  'ref',
  'applicability',
  'naAllowed',
]);

function deepEqual(a, b) {
  if (a === b) return true;
  if (typeof a !== typeof b) return false;
  if (Array.isArray(a) || Array.isArray(b)) {
    if (!Array.isArray(a) || !Array.isArray(b) || a.length !== b.length) return false;
    return a.every((v, i) => deepEqual(v, b[i]));
  }
  if (a && b && typeof a === 'object') {
    const ka = Object.keys(a).sort();
    const kb = Object.keys(b).sort();
    if (!deepEqual(ka, kb)) return false;
    return ka.every((k) => deepEqual(a[k], b[k]));
  }
  return false;
}
function setEquals(a, b) {
  const sa = new Set(a);
  const sb = new Set(b);
  return sa.size === sb.size && [...sa].every((v) => sb.has(v));
}
function readJson(file) {
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

// ---- ① 全集独立锚定(与 check-fidelity-matrix.mjs 同口径,输出一致) ----
function checkGroundTruth(manifest, catalog, platform, errors) {
  const mRows = (manifest.rows ?? []).filter((r) => r.platform === platform);
  const cRows = (catalog.rows ?? []).filter((r) => r.platform === platform);
  const mIds = mRows.map((r) => r.rowId);
  const cIds = cRows.map((r) => r.rowId);
  if (!setEquals(mIds, cIds)) {
    const missing = cIds.filter((id) => !mIds.includes(id));
    const extra = mIds.filter((id) => !cIds.includes(id));
    errors.push(`[ROWSET_MISMATCH] platform=${platform} manifest rowId 集合与 catalog 不精确相等: 缺失=${JSON.stringify(missing)} 多余=${JSON.stringify(extra)}`);
  }
  const cById = new Map(cRows.map((r) => [r.rowId, r]));
  for (const row of mRows) {
    const cr = cById.get(row.rowId);
    if (!cr) continue;
    for (const f of GROUND_TRUTH_FIELDS) {
      if (!deepEqual(row[f] ?? null, cr[f] ?? null)) {
        errors.push(`[CATALOG_FIELD_MISMATCH] 行 ${row.rowId} ground-truth 字段 ${f} 与 catalog 不等(期望权威在 catalog)`);
      }
    }
  }
  return mRows;
}

/**
 * --slice 附加过滤(PR1,additive):只收窄 ②③ 的作用行;不传 slice 时原样返回
 * (与 PR0a 全量语义逐字一致)。未知 slice → SLICE_EMPTY 报错。
 */
function filterSliceRows(rows, slice, platform, errors) {
  if (!slice) return rows;
  const filtered = rows.filter((r) => r.slice === slice);
  if (filtered.length === 0) {
    errors.push(`[SLICE_EMPTY] platform=${platform} 无 slice=${slice} 的行(slice 名拼错或 manifest 漂移)`);
  }
  return filtered;
}

// ---- vitest 调用(list / run) ----
/** 真实模式:pnpm --filter <pkg> exec vitest …(在仓根执行;Windows 走 shell 解析 pnpm.cmd) */
function runPnpmVitest(filter, vitestArgs) {
  const r = spawnSync('pnpm', ['--filter', filter, 'exec', 'vitest', ...vitestArgs], {
    cwd: REPO_ROOT,
    encoding: 'utf8',
    maxBuffer: 512 * 1024 * 1024,
    shell: process.platform === 'win32',
  });
  return r;
}
/** self-test 模式:直接以 node 调仓根 vitest 入口(真实调用 vitest,不 mock) */
function runLocalVitest(vitestArgs, cwd) {
  return spawnSync(process.execPath, [VITEST_MJS, ...vitestArgs], {
    cwd,
    encoding: 'utf8',
    maxBuffer: 512 * 1024 * 1024,
  });
}
/** 解析 `vitest list <files…> --json` 输出:[{name,file}] */
function parseListJson(stdout, errors) {
  let arr;
  try {
    arr = JSON.parse(stdout);
  } catch (e) {
    errors.push(`[LIST_PARSE] vitest list --json 输出解析失败: ${e.message}`);
    return [];
  }
  if (!Array.isArray(arr)) {
    errors.push('[LIST_PARSE] vitest list --json 输出必须为数组');
    return [];
  }
  return arr.filter((e) => e && typeof e.name === 'string' && typeof e.file === 'string');
}

// ---- ② tests 映射校验(testId 在对应 file 中唯一存在) ----
function checkTestsMapping(rows, listEntries, resolveFile, errors) {
  // file 绝对路径 → name → 出现次数
  const byFile = new Map();
  for (const e of listEntries) {
    const abs = path.resolve(e.file);
    if (!byFile.has(abs)) byFile.set(abs, new Map());
    const names = byFile.get(abs);
    names.set(e.name, (names.get(e.name) ?? 0) + 1);
  }
  for (const row of rows) {
    if (!Array.isArray(row.tests) || row.tests.length === 0) {
      errors.push(`[TESTS_EMPTY] 行 ${row.rowId} tests 为空(每行必须映射 ≥1 个 {file,testId})`);
      continue;
    }
    for (const t of row.tests) {
      if (!t || typeof t.file !== 'string' || typeof t.testId !== 'string' || !t.file || !t.testId) {
        errors.push(`[TESTS_SHAPE] 行 ${row.rowId} tests 条目必须为 {file,testId}`);
        continue;
      }
      const abs = resolveFile(t.file);
      const names = byFile.get(abs);
      if (!names) {
        errors.push(`[TEST_FILE_NOT_COLLECTED] 行 ${row.rowId} 映射文件未被 vitest 收集: ${t.file}`);
        continue;
      }
      const count = names.get(t.testId) ?? 0;
      if (count === 0) {
        errors.push(`[TESTID_NOT_FOUND] 行 ${row.rowId} testId 在 ${t.file} 中 0 命中: ${t.testId}`);
      } else if (count > 1) {
        errors.push(`[TESTID_DUPLICATE] 行 ${row.rowId} testId 在 ${t.file} 中重名(${count} 次): ${t.testId}`);
      }
    }
  }
}

// ---- ③ --run-mapped:解析 vitest run --reporter=json,逐 testId 断言 passed ----
function parseRunJson(raw, errors) {
  let data;
  try {
    data = typeof raw === 'string' ? JSON.parse(raw) : raw;
  } catch (e) {
    errors.push(`[RUN_PARSE] vitest run --reporter=json 结果解析失败: ${e.message}`);
    return new Map();
  }
  // 文件绝对路径 → testId(" > " 连接的全名) → status
  const byFile = new Map();
  for (const tr of data.testResults ?? []) {
    const abs = path.resolve(tr.name);
    if (!byFile.has(abs)) byFile.set(abs, new Map());
    const m = byFile.get(abs);
    for (const ar of tr.assertionResults ?? []) {
      const id = [...(ar.ancestorTitles ?? []), ar.title].join(' > ');
      m.set(id, ar.status);
    }
  }
  return byFile;
}
function checkRunResults(rows, byFile, resolveFile, errors) {
  for (const row of rows) {
    for (const t of row.tests ?? []) {
      if (!t?.file || !t?.testId) continue;
      const m = byFile.get(resolveFile(t.file));
      const status = m?.get(t.testId);
      if (status === undefined) {
        errors.push(`[RUN_NOT_EXECUTED] 行 ${row.rowId} 映射用例未在执行结果中出现(仅收集≠通过): ${t.file} > ${t.testId}`);
      } else if (status !== 'passed') {
        errors.push(`[RUN_NOT_PASSED] 行 ${row.rowId} 映射用例 status=${status}(需 passed;skipped/todo/pending 均败): ${t.file} > ${t.testId}`);
      }
    }
  }
}

// ---- 真实模式主流程 ----
function runReal(opts) {
  const errors = [];
  const manifest = readJson(opts.manifest);
  const catalog = readJson(opts.catalog);
  // ① 全集锚定恒对全平台行执行(--slice 不收窄锚,防「切片绕锚」)
  const allRows = checkGroundTruth(manifest, catalog, opts.platform, errors);
  const rows = filterSliceRows(allRows, opts.slice, opts.platform, errors);
  const pkg = PLATFORM_PKG[opts.platform];
  const pkgRoot = path.join(REPO_ROOT, 'apps', pkg.filter);
  // manifest tests[].file 记仓根相对路径(apps/desktop/…);相对 workspace 执行时剥前缀
  const stripPrefix = (f) => (f.startsWith(pkg.prefix) ? f.slice(pkg.prefix.length) : f);
  const resolveFile = (f) => path.resolve(pkgRoot, stripPrefix(f));
  const files = [...new Set(rows.flatMap((r) => (r.tests ?? []).map((t) => t?.file).filter((f) => typeof f === 'string' && f)))].map(stripPrefix);

  if (files.length > 0) {
    // ② vitest list(注意:文件过滤参数在前、--json 兜底放最后)
    const list = runPnpmVitest(pkg.filter, ['list', ...files, '--json']);
    if (list.error) errors.push(`[LIST_SPAWN] vitest list 启动失败: ${list.error.message}`);
    else checkTestsMapping(rows, parseListJson(list.stdout ?? '', errors), resolveFile, errors);

    // ③ --run-mapped 真实执行
    if (opts.runMapped && errors.length === 0) {
      const outFile = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'manifest-coverage-')), 'run.json');
      const run = runPnpmVitest(pkg.filter, ['run', ...files, '--reporter=json', `--outputFile=${outFile}`]);
      if (run.error || !fs.existsSync(outFile)) {
        errors.push(`[RUN_SPAWN] vitest run 执行失败: ${run.error?.message ?? (run.stderr ?? '').slice(-500)}`);
      } else {
        checkRunResults(rows, parseRunJson(fs.readFileSync(outFile, 'utf8'), errors), resolveFile, errors);
      }
    }
  } else {
    // 没有任何映射文件 → ② 的 TESTS_EMPTY 逐行报错(PR0a 阶段的预期失败形态)
    checkTestsMapping(rows, [], resolveFile, errors);
  }
  return errors;
}

// ---- self-test:三例(存在/不存在/重名) + 集合对账正负例 + run-mapped 正负路径 ----
function selfTest() {
  const failures = [];
  const manifest = readJson(path.join(FIXTURE_DIR, 'manifest.json'));
  const catalog = readJson(path.join(FIXTURE_DIR, 'catalog.json'));
  const resolveFile = (f) => path.resolve(FIXTURE_DIR, f);

  // 集合对账正例
  {
    const errors = [];
    checkGroundTruth(manifest, catalog, 'desktop', errors);
    if (errors.length) failures.push(`集合对账正例: 预期通过,实际 ${errors[0]}`);
  }
  // 集合对账负例(删行 → 集合不等)
  {
    const errors = [];
    const m = structuredClone(manifest);
    m.rows = m.rows.slice(0, 1);
    checkGroundTruth(m, catalog, 'desktop', errors);
    if (!errors.some((e) => e.includes('ROWSET_MISMATCH'))) failures.push('集合对账负例(删行): 预期 ROWSET_MISMATCH');
  }
  // ground-truth 篡改负例
  {
    const errors = [];
    const m = structuredClone(manifest);
    m.rows[0].source = 'wave4';
    checkGroundTruth(m, catalog, 'desktop', errors);
    if (!errors.some((e) => e.includes('CATALOG_FIELD_MISMATCH'))) failures.push('集合对账负例(篡改 source): 预期 CATALOG_FIELD_MISMATCH');
  }

  // 真实调用 vitest list(fixture 两个小测试文件;正例路径必须真实走 vitest)
  const list = runLocalVitest(['list', '--root', FIXTURE_DIR, '--json'], FIXTURE_DIR);
  if (list.status !== 0 && !(list.stdout ?? '').trim().startsWith('[')) {
    failures.push(`vitest list 真实调用失败: ${(list.stderr ?? '').slice(-300)}`);
  } else {
    const parseErrors = [];
    const entries = parseListJson(list.stdout ?? '', parseErrors);
    failures.push(...parseErrors);
    // 三例①: testId 存在 → 通过
    {
      const errors = [];
      checkTestsMapping(manifest.rows, entries, resolveFile, errors);
      if (errors.length) failures.push(`testId 存在例: 预期通过,实际 ${errors[0]}`);
    }
    // 三例②: testId 不存在 → 败
    {
      const errors = [];
      const m = structuredClone(manifest);
      m.rows[0].tests[0].testId = 'coverage fixture suite > does not exist';
      checkTestsMapping(m.rows, entries, resolveFile, errors);
      if (!errors.some((e) => e.includes('TESTID_NOT_FOUND'))) failures.push('testId 不存在例: 预期 TESTID_NOT_FOUND');
    }
    // 三例③: testId 重名 → 败
    {
      const errors = [];
      const m = structuredClone(manifest);
      m.rows[0].tests[0] = { file: 'sample-dup.test.mjs', testId: 'coverage dup suite > same name' };
      checkTestsMapping(m.rows, entries, resolveFile, errors);
      if (!errors.some((e) => e.includes('TESTID_DUPLICATE'))) failures.push('testId 重名例: 预期 TESTID_DUPLICATE');
    }
    // tests 为空 → 败(正式 manifest 当前形态)
    {
      const errors = [];
      const m = structuredClone(manifest);
      m.rows[0].tests = [];
      checkTestsMapping(m.rows, entries, resolveFile, errors);
      if (!errors.some((e) => e.includes('TESTS_EMPTY'))) failures.push('tests 空例: 预期 TESTS_EMPTY');
    }
  }

  // --run-mapped:真实执行 fixture 用例(正例) + mock 结果负例(skipped/failed/未执行)
  {
    const outFile = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'manifest-coverage-st-')), 'run.json');
    const run = runLocalVitest(['run', '--root', FIXTURE_DIR, 'sample-pass.test.mjs', '--reporter=json', `--outputFile=${outFile}`], FIXTURE_DIR);
    if (!fs.existsSync(outFile)) {
      failures.push(`vitest run 真实调用失败: ${(run.stderr ?? '').slice(-300)}`);
    } else {
      const errors = [];
      checkRunResults(manifest.rows, parseRunJson(fs.readFileSync(outFile, 'utf8'), errors), resolveFile, errors);
      if (errors.length) failures.push(`run-mapped 正例: 预期通过,实际 ${errors[0]}`);
    }
    const mockRun = (status) => ({
      testResults: [{
        name: path.join(FIXTURE_DIR, 'sample-pass.test.mjs'),
        assertionResults: [
          { ancestorTitles: ['coverage fixture suite'], title: 'passes one', status },
          { ancestorTitles: ['coverage fixture suite'], title: 'passes two', status },
        ],
      }],
    });
    for (const [status, expectCode] of [['skipped', 'RUN_NOT_PASSED'], ['failed', 'RUN_NOT_PASSED'], ['todo', 'RUN_NOT_PASSED']]) {
      const errors = [];
      checkRunResults(manifest.rows, parseRunJson(mockRun(status), errors), resolveFile, errors);
      if (!errors.some((e) => e.includes(expectCode))) failures.push(`run-mapped 负例(${status}): 预期 ${expectCode}`);
    }
    {
      const errors = [];
      checkRunResults(manifest.rows, parseRunJson({ testResults: [] }, errors), resolveFile, errors);
      if (!errors.some((e) => e.includes('RUN_NOT_EXECUTED'))) failures.push('run-mapped 负例(未执行): 预期 RUN_NOT_EXECUTED');
    }
  }

  // --slice 过滤四例(PR1):不传=原样;命中=收窄;未知=SLICE_EMPTY;
  // 切片外 tests 空行不再触发 TESTS_EMPTY(正例),切片内空行仍触发(负例)
  {
    const errors = [];
    const same = filterSliceRows(manifest.rows, undefined, 'desktop', errors);
    if (same !== manifest.rows || errors.length) failures.push('slice 例①: 不传 slice 应原样返回且零错误');
  }
  {
    const errors = [];
    const hit = filterSliceRows(manifest.rows, 'pr1', 'desktop', errors);
    if (errors.length || hit.length === 0 || !hit.every((r) => r.slice === 'pr1')) {
      failures.push('slice 例②: slice=pr1 应收窄到对应行');
    }
    const outside = manifest.rows.filter((r) => r.slice !== 'pr1');
    if (outside.length === 0) failures.push('slice 例② 前置: fixture 需含非 pr1 行');
  }
  {
    const errors = [];
    filterSliceRows(manifest.rows, 'pr999', 'desktop', errors);
    if (!errors.some((e) => e.includes('SLICE_EMPTY'))) failures.push('slice 例③: 未知 slice 应报 SLICE_EMPTY');
  }
  {
    // 切片外空 tests 行不误判 / 切片内空 tests 行仍败
    const m = structuredClone(manifest);
    const other = m.rows.find((r) => r.slice !== 'pr1');
    if (other) {
      other.tests = [];
      const errorsOut = [];
      const sliceRows = filterSliceRows(m.rows, 'pr1', 'desktop', errorsOut);
      checkTestsMapping(sliceRows, [], resolveFile, errorsOut);
      // pr1 行映射的文件未收集会报 TEST_FILE_NOT_COLLECTED,但不应报切片外行的 TESTS_EMPTY
      if (errorsOut.some((e) => e.includes('TESTS_EMPTY') && e.includes(other.rowId))) {
        failures.push('slice 例④a: 切片外空 tests 行不应触发 TESTS_EMPTY');
      }
      const inRow = m.rows.find((r) => r.slice === 'pr1');
      inRow.tests = [];
      const errorsIn = [];
      checkTestsMapping(filterSliceRows(m.rows, 'pr1', 'desktop', errorsIn), [], resolveFile, errorsIn);
      if (!errorsIn.some((e) => e.includes('TESTS_EMPTY') && e.includes(inRow.rowId))) {
        failures.push('slice 例④b: 切片内空 tests 行必须触发 TESTS_EMPTY');
      }
    } else {
      failures.push('slice 例④ 前置: fixture 需含非 pr1 行');
    }
  }

  if (failures.length) {
    console.error('COVERAGE_SELF_TEST_FAILED');
    failures.forEach((f) => console.error('  - ' + f));
    process.exit(1);
  }
  console.log('COVERAGE_SELF_TEST_OK');
}

// ---- CLI ----
function main() {
  const argv = process.argv.slice(2);
  const opts = {
    platform: undefined,
    runMapped: false,
    selfTest: false,
    manifest: path.join(ACCEPTANCE_DIR, 'state-manifest.json'),
    catalog: path.join(ACCEPTANCE_DIR, 'required-state-catalog.json'),
  };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === '--platform') opts.platform = argv[++i];
    else if (a === '--run-mapped') opts.runMapped = true;
    else if (a === '--slice') opts.slice = argv[++i];
    else if (a === '--self-test') opts.selfTest = true;
    else if (a === '--manifest') opts.manifest = path.resolve(argv[++i]);
    else if (a === '--catalog') opts.catalog = path.resolve(argv[++i]);
    else {
      console.error(`未知参数: ${a}`);
      process.exit(2);
    }
  }
  if (opts.selfTest) {
    selfTest();
    return;
  }
  if (!PLATFORM_PKG[opts.platform]) {
    console.error('用法: --platform desktop|mobile [--run-mapped] | --self-test');
    process.exit(2);
  }
  const errors = runReal(opts);
  if (errors.length) {
    errors.forEach((e) => console.error(e));
    console.error(`共 ${errors.length} 条违规`);
    process.exit(1);
  }
  console.log('MANIFEST_COVERAGE_OK');
}

main();
