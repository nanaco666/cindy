#!/usr/bin/env node
// sync-agent-instructions.mjs — 由 agent-use/docs/ 的单一源生成 review-pr 产物。
//
// 产物(需 commit,勿手改;手改会在下次 sync 被覆盖):
//   - .claude/skills/review-pr/SKILL.md / .agents/skills/review-pr/SKILL.md   ← review-pr.skill.base.md
//
// 注:AGENTS.md / CLAUDE.md / .github/PULL_REQUEST_TEMPLATE.md 均为手写正本,不由本脚本生成。
//   AGENTS.md 是 agent 指令正本,CLAUDE.md 是只含 `@AGENTS.md` import 的真文件(Claude Code 只读 CLAUDE.md,靠 import 引入 AGENTS.md;用真文件而非 symlink 以兼容 Windows)。
//
// 同时做一致性校验:pr-rules.json(review-pr 脚本 context.mjs 的格式判定单一真相源)
// 必须与 .github/PULL_REQUEST_TEMPLATE.md 的必填段落对得上,否则 exit 1
// —— 防止改了 json 没改模板(或反之)导致脚本判定与文档漂移。
// 本仓模板是统一三节制(无 Title 节 / Feature·Bugfix 分段,与原 XDMaker 仓不同):
// 校验对模板全文的「## …」标题与 featureSections / bugfixSections 做双向比对;
// titleTypes 无模板锚点,单一真相源就是 pr-rules.json 自己,不校验。
//
// 跨平台:纯 node fs/path,无 bash 依赖。

import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));
const ROOT = join(SCRIPT_DIR, '..', '..');
const DOCS = join(SCRIPT_DIR, '..', 'docs');

const read = (rel) => readFileSync(rel, 'utf8');
const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

function writeGeneratedFile(rel, content) {
  const target = join(ROOT, rel);
  mkdirSync(dirname(target), { recursive: true });
  writeFileSync(target, content);
  console.log(`✓ ${rel}`);
}

// ── 1. review-pr SKILL.md(单源 → 两份:渲染条件块 + 替换 {{AGENT_DOC}})──────
const skillBase = read(join(DOCS, 'review-pr.skill.base.md'));

/**
 * 渲染 agent-specific 条件块:保留 target 块、删除 other 块。
 * 约定:`{{#claude}}` / `{{/claude}}`(及 codex)各自独占一行,块不嵌套。
 */
function renderConditionals(text, target) {
  const other = target === 'claude' ? 'codex' : 'claude';
  // 行尾用 \r?\n:Windows 检出(autocrlf)下源文件是 CRLF,写死 \n 会导致标记剥不掉、坏产物直出。
  text = text.replace(new RegExp(`\\{\\{#${other}\\}\\}\\r?\\n[\\s\\S]*?\\{\\{\\/${other}\\}\\}\\r?\\n`, 'g'), '');
  text = text.replace(new RegExp(`\\{\\{#${target}\\}\\}\\r?\\n`, 'g'), '');
  text = text.replace(new RegExp(`\\{\\{\\/${target}\\}\\}\\r?\\n`, 'g'), '');
  return text;
}

function genSkill(target, agentDoc, outFile) {
  const out = renderConditionals(skillBase, target).replaceAll('{{AGENT_DOC}}', agentDoc);
  writeGeneratedFile(outFile, out);
}

// {{AGENT_DOC}} 用 'AGENTS.md' 而非 'CLAUDE.md':skill 里都是"Read 该文件的设计实现规范节"这类引用,
// 而 CLAUDE.md 只是 `@AGENTS.md` import 真文件、不含规范正文,指向它会让 Read 拿不到规则。AGENTS.md 才是两端共用的正本。
genSkill('claude', 'AGENTS.md', join('.claude', 'skills', 'review-pr', 'SKILL.md'));
genSkill('codex', 'AGENTS.md', join('.agents', 'skills', 'review-pr', 'SKILL.md'));

// ── 2. 一致性校验:pr-rules.json ↔ .github/PULL_REQUEST_TEMPLATE.md ─────────────
const prDoc = read(join(ROOT, '.github', 'PULL_REQUEST_TEMPLATE.md'));
const rules = JSON.parse(read(join(DOCS, 'pr-rules.json')));
const errors = [];

// 必填段落(双向):json 每个关键词必须是模板里某个 `## …关键词…` 标题;
// 模板里每个 `## …` 标题也必须被某 json 关键词覆盖。
// 本仓 feature / bugfix 共用同一套三节,两个列表都对模板全文校验。
const checkSections = (list, key) => {
  for (const kw of list) {
    if (!new RegExp('^##\\s.*' + escapeRe(kw), 'm').test(prDoc)) {
      errors.push(`${key} 的 "${kw}" 在 PR 模板里找不到对应「## …」段落标题(json→模板 漂移)`);
    }
  }
  for (const m of prDoc.matchAll(/^##\s+(.+)$/gm)) {
    const head = m[1].trim();
    if (!list.some((kw) => head.includes(kw))) {
      errors.push(`PR 模板的段落「## ${head}」在 pr-rules.json ${key} 里没有对应关键词(模板→json 漂移)`);
    }
  }
};
checkSections(rules.featureSections, 'featureSections');
checkSections(rules.bugfixSections, 'bugfixSections');

if (errors.length) {
  console.error('\n✗ pr-rules.json 与 .github/PULL_REQUEST_TEMPLATE.md 不一致:');
  for (const e of errors) console.error('  - ' + e);
  console.error('\n改必填段落时,pr-rules.json 与 PR 模板必须同步更新。');
  process.exit(1);
}
console.log('✓ pr-rules.json ↔ .github/PULL_REQUEST_TEMPLATE.md 一致性校验通过');
