#!/usr/bin/env node
// 校验 review-pr 的机器规则与公开 PR 模板保持双向一致。

import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));
const ROOT = join(SCRIPT_DIR, '..');

const read = (path) => readFileSync(path, 'utf8');
const escapeRegExp = (value) => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

const template = read(join(ROOT, '.github', 'PULL_REQUEST_TEMPLATE.md'));
const rules = JSON.parse(read(join(ROOT, 'agent-use', 'docs', 'pr-rules.json')));
const errors = [];

/**
 * 双向核对规则关键词与模板二级标题，避免自动判定和贡献者看到的模板漂移。
 */
function checkSections(sectionKeywords, ruleKey) {
  for (const keyword of sectionKeywords) {
    if (!new RegExp(`^##\\s.*${escapeRegExp(keyword)}`, 'm').test(template)) {
      errors.push(`${ruleKey} 的「${keyword}」在 PR 模板中没有对应的二级标题`);
    }
  }

  for (const match of template.matchAll(/^##\s+(.+)$/gm)) {
    const heading = match[1].trim();
    if (!sectionKeywords.some((keyword) => heading.includes(keyword))) {
      errors.push(`PR 模板标题「${heading}」在 ${ruleKey} 中没有对应关键词`);
    }
  }
}

checkSections(rules.featureSections, 'featureSections');
checkSections(rules.bugfixSections, 'bugfixSections');

if (errors.length > 0) {
  console.error('pr-rules.json 与 PR 模板不一致：');
  for (const error of errors) console.error(`- ${error}`);
  process.exit(1);
}

console.log('pr-rules.json 与 PR 模板一致');
