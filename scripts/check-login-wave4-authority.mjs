#!/usr/bin/env node
/**
 * check-login-wave4-authority.mjs — 登录换肤 wave4 旧体系残留静态扫描门禁。
 *
 * 可执行合约冻结于 docs/login-redesign/implementation-plan.md「分支拓扑」第 1 条②(v6.9)：
 * - 扫描全集 = 五份权威文件(design / adaptation-spec / token-decision-table /
 *   figma-component-spec / implementation-plan)；
 * - 禁词集 = 旧红底体系执行句词表(本文件内 FORBIDDEN_TOKENS 冻结数组)；
 * - 历史/作废语境的确定性判定(命中即放行,否则命中禁词即失败)：
 *     a. 命中行自身含 `已作废` / `作废)` / `作废）` / `历史:` / `历史：` / `superseded` 标记；
 *     b. 命中行位于「版本记录」/「决策台账」章节内且为表格行；
 *     c. 行首为引用(`>`)或删除线(`~~`)。
 * - 全部通过 → 输出 `WAVE4_AUTHORITY_OK` + exit 0；任一未豁免命中 → 列出并 exit 1。
 *
 * 变更管制：禁词数组与豁免语法为冻结合约的一部分,修改须走带批准记录的 docs PR
 * (implementation-plan「三锚点变更管制」同款纪律),不得在实现 PR 内顺手放宽。
 *
 * 用法：
 *   node scripts/check-login-wave4-authority.mjs              # 扫描仓内五份权威文件
 *   node scripts/check-login-wave4-authority.mjs --self-test  # 用正负 fixture 自检判定逻辑
 */

import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

/** 禁词集(冻结数组)：旧红底体系执行句词表,含 hex 的条目大小写不敏感。 */
const FORBIDDEN_TOKENS = Object.freeze([
  '红底铺满',
  '恒红底',
  '#7A0B19',
  '#F26D7E',
  '白字下划线失败态',
]);

/** 扫描全集(冻结)：五份权威文件,仓根相对路径。 */
const SCAN_FILES = Object.freeze([
  'docs/login-redesign/design.md',
  'docs/login-redesign/adaptation-spec.md',
  'docs/login-redesign/token-decision-table.md',
  'docs/login-redesign/figma-component-spec.md',
  'docs/login-redesign/implementation-plan.md',
]);

/** 命中行自身的作废/历史标记(判定 a)。 */
const LINE_EXEMPT_MARKERS = Object.freeze([
  /已作废/,
  /作废[)）]/,
  /历史[:：]/,
  /superseded/i,
]);

/** 豁免章节名(判定 b)：最近一个 markdown 标题含任一关键词,且命中行为表格行。 */
const EXEMPT_SECTION_KEYWORDS = Object.freeze(['版本记录', '决策台账']);

/**
 * 判定单行是否处于豁免语境。
 * @param {string} line 原始行文本
 * @param {string} currentHeading 该行所属的最近 markdown 标题文本(无标题时为空串)
 * @returns {boolean}
 */
function isExemptLine(line, currentHeading) {
  const trimmed = line.trimStart();
  if (trimmed.startsWith('>')) return true; // 行首引用
  if (trimmed.startsWith('~~')) return true; // 行首删除线
  if (LINE_EXEMPT_MARKERS.some((re) => re.test(line))) return true;
  if (
    trimmed.startsWith('|') &&
    EXEMPT_SECTION_KEYWORDS.some((kw) => currentHeading.includes(kw))
  ) {
    return true; // 版本记录 / 决策台账 表格行
  }
  return false;
}

/**
 * 扫描一段文本,返回未豁免的禁词命中列表。
 * @param {string} content 文件全文
 * @returns {{ lineNo: number, token: string, line: string }[]}
 */
export function scanContent(content) {
  const violations = [];
  let currentHeading = '';
  const lines = content.split(/\r?\n/);
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i];
    const headingMatch = /^#{1,6}\s+(.*)$/.exec(line);
    if (headingMatch) currentHeading = headingMatch[1];
    const lowerLine = line.toLowerCase();
    for (const token of FORBIDDEN_TOKENS) {
      if (!lowerLine.includes(token.toLowerCase())) continue;
      if (isExemptLine(line, currentHeading)) continue;
      violations.push({ lineNo: i + 1, token, line: line.trim() });
    }
  }
  return violations;
}

/** 扫描仓内五份权威文件。 */
function runScan() {
  let total = 0;
  for (const relPath of SCAN_FILES) {
    const absPath = path.join(repoRoot, relPath);
    let content;
    try {
      content = readFileSync(absPath, 'utf8');
    } catch {
      console.error(`WAVE4_AUTHORITY_FAIL: 扫描目标缺失 ${relPath}`);
      process.exit(1);
    }
    const violations = scanContent(content);
    for (const v of violations) {
      total += 1;
      console.error(
        `WAVE4_AUTHORITY_VIOLATION ${relPath}:${v.lineNo} 禁词「${v.token}」未标注作废语境: ${v.line.slice(0, 120)}`,
      );
    }
  }
  if (total > 0) {
    console.error(`WAVE4_AUTHORITY_FAIL: ${total} 处旧体系执行句残留`);
    process.exit(1);
  }
  console.log('WAVE4_AUTHORITY_OK');
}

/** 用正负 fixture 自检判定逻辑(fixture 变更同受冻结合约管制)。 */
function runSelfTest() {
  const fixtureDir = path.join(repoRoot, 'scripts', '__fixtures__', 'check-login-wave4-authority');
  const positive = readFileSync(path.join(fixtureDir, 'positive.md'), 'utf8');
  const negative = readFileSync(path.join(fixtureDir, 'negative.md'), 'utf8');

  const positiveViolations = scanContent(positive);
  if (positiveViolations.length !== 0) {
    console.error(
      `SELF_TEST_FAIL: 正 fixture 应 0 命中,实得 ${positiveViolations.length}: ` +
        positiveViolations.map((v) => `L${v.lineNo}「${v.token}」`).join(', '),
    );
    process.exit(1);
  }

  const negativeViolations = scanContent(negative);
  // 负 fixture 每个禁词各埋一句未标注执行句,须逐一命中。
  const expectedTokens = new Set(FORBIDDEN_TOKENS.map((t) => t.toLowerCase()));
  const hitTokens = new Set(negativeViolations.map((v) => v.token.toLowerCase()));
  const missing = [...expectedTokens].filter((t) => !hitTokens.has(t));
  if (missing.length > 0) {
    console.error(`SELF_TEST_FAIL: 负 fixture 未命中禁词: ${missing.join(', ')}`);
    process.exit(1);
  }
  console.log(
    `SELF_TEST_OK positive=0 violations, negative=${negativeViolations.length} violations(全部 ${FORBIDDEN_TOKENS.length} 个禁词均被侦测)`,
  );
}

const args = process.argv.slice(2);
if (args.includes('--self-test')) {
  runSelfTest();
} else {
  runScan();
}
