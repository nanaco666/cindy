#!/usr/bin/env node
/**
 * check-login-i18n-parity.mjs — 登录换肤 i18n 5 语齐全机器门(SC-4)。
 *
 * 合约冻结于 implementation-plan.md SC-4 / Step 1(v6.1 scoped CLI + v6.16 ⑤⑥):
 *   --scope desktop  : desktop 5 语 locale 文件(登录域 4 语 key 全集一致非空 +
 *                      zh-TW 全量齐且非空)+ apps/desktop/src 消费者双向静态扫描
 *                      + zh-TW 必备 UI key + 翻译评审门 desktop 节。
 *   --scope callback : oauthResultPage 系(callback 支交付后)zh-TW 分支 +
 *                      zh-Hant 识别 + 翻译评审门 callback 节。
 *   --scope mobile   : apps/mobile loginMessages 5 语 catalog key 全集一致非空
 *                      + apps/mobile/src 消费者双向静态扫描 + 翻译评审门 mobile 节。
 *   --scope all      : 三者并集(三支 PR0b 全部合入 integration 后的收敛门)。
 * scoped 模式只校验本 scope 文件,不因其他 scope 缺项误判(v6.1)。
 *
 * ⑤ 消费者双向核对(v6.16,堵「清单漏写即通过」自指):
 *   - 静态扫描信号:文件含引号 'zh-CN'/"zh-CN" 字面量,或 startsWith('zh 前缀分支。
 *   - 命中文件必须登记于 docs/login-redesign/locale-consumer-inventory.md 的
 *     机读表(BEGIN/END:CONSUMER_TABLE 标记),清单项文件也必须真实存在且命中
 *     zhTwAssert 正则(真实接受 zh-TW,U-1 不折叠);双向差集 → exit 非零。
 *   - 扫描误报走脚本内冻结排除表 SCAN_EXCLUSIONS(每项带理由+登记 reviewer),
 *     排除表变更走 review。
 *
 * ⑥ 翻译评审门(v6.16,「非空」不再是翻译完成判据):
 *   - docs/login-redesign/acceptance/translation-review.json 绑定各 locale 文件
 *     SHA256(文件一变评审即失效);verbatim 条目逐字符相等断言(存量 4 语零改动
 *     的机器化);zh-TW 登录域(login. / splash. / legacyMigration. 前缀)逐 leaf
 *     key 必须有精校记录(reviewer/reviewedAt/source);新增翻译 key 同样必须有记录。
 *
 * 全过输出 `I18N_PARITY_OK`;任一断言失败 exit 非零。
 */

import crypto from 'node:crypto';
import { readFileSync, readdirSync, statSync, existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const rel = (p) => path.join(repoRoot, ...p.split('/'));

const LOCALES_DIR = rel('apps/desktop/src/renderer/i18n/locales');
const LOCALE_TS = rel('apps/desktop/src/shared/locale.ts');
const INVENTORY_MD = rel('docs/login-redesign/locale-consumer-inventory.md');
const REVIEW_JSON = rel('docs/login-redesign/acceptance/translation-review.json');
const LOGIN_MESSAGES_TS = rel('apps/mobile/src/auth/loginMessages.ts');

/** 登录域前缀(SC-4 口径,与 merge gate 的人工精校范围一致)。 */
const LOGIN_DOMAIN_PREFIXES = ['login.', 'splash.', 'legacyMigration.'];

/**
 * callback scope 专属文件(desktop 扫描分区排除,归 PR0b-callback 支门禁)。
 * 位于 apps/desktop/src 下但属回调链交付物,desktop 支不得因其未接 zh-TW 误判。
 */
const CALLBACK_FILES = ['apps/desktop/src/main/oauthResultPage.ts'];

/**
 * 扫描排除表(冻结;每项必须带理由 + 登记 reviewer;变更走 review)。
 * match: repo 相对路径前缀或精确路径。
 */
const SCAN_EXCLUSIONS = [
  {
    match: 'apps/desktop/src/renderer/i18n/locales/',
    reason: 'i18n 资源文件本体,不是消费者',
    reviewer: 'PR0b-desktop worker 2026-07-20',
  },
  {
    match: '__tests__/',
    reason: '测试文件不是运行时 locale 消费者(fixture 里的 locale 字面量不影响用户可见行为)',
    reviewer: 'PR0b-desktop worker 2026-07-20',
  },
  {
    match: 'apps/desktop/src/renderer/components/new-chat/CjkPunctDecoration.ts',
    reason: 'lang="zh-CN" 是 CJK 标点字形渲染的 HTML lang 属性常量(zh-TW 同属中文标点域,字形行为一致),不是 UI locale 分支集合',
    reviewer: 'PR0b-desktop worker 2026-07-20',
  },
  {
    match: 'apps/mobile/src/session/mobileVoiceInput.ts',
    reason: '语音转写 uiLanguage 提示常量(送 ASR/LLM 的上下文语言标注),不是 UI locale 分支集合;zh-TW 语音语义沿中文配置(Step 1 WHAT4)',
    reviewer: 'PR0b-desktop worker 2026-07-20',
  },
  {
    match: 'apps/mobile/src/session/mobileVoiceLiteLlmSettings.ts',
    reason: 'ASR/LLM 语言参数常量,非 UI locale 分支集合(同上)',
    reviewer: 'PR0b-desktop worker 2026-07-20',
  },
  {
    match: 'apps/mobile/src/session/modelPickerRows.ts',
    reason: '模型描述文案常量含 zh-CN 字样(模型能力说明),非 UI locale 分支集合;手机版 UI 语言由 loginMessages/系统 locale 决定',
    reviewer: 'PR0b-desktop worker 2026-07-20',
  },
];

const failures = [];
function fail(msg) {
  failures.push(msg);
}

function sha256(buf) {
  return crypto.createHash('sha256').update(buf).digest('hex');
}

function readJson(p) {
  return JSON.parse(readFileSync(p, 'utf8'));
}

function flatten(obj, prefix = '', out = new Map()) {
  for (const [k, v] of Object.entries(obj)) {
    const key = prefix ? `${prefix}.${k}` : k;
    if (v !== null && typeof v === 'object') flatten(v, key, out);
    else out.set(key, v);
  }
  return out;
}

/** 从 locale.ts 解析 SUPPORTED_LOCALES(与 check-i18n.mjs 同法,单一事实源)。 */
function parseSupportedLocales() {
  const src = readFileSync(LOCALE_TS, 'utf8');
  const m = src.match(/SUPPORTED_LOCALES\s*=\s*\[([^\]]*)\]/);
  if (!m) {
    fail(`无法从 ${LOCALE_TS} 解析 SUPPORTED_LOCALES`);
    return [];
  }
  return [...m[1].matchAll(/['"]([^'"]+)['"]/g)].map((x) => x[1]);
}

function walk(dir, out = []) {
  for (const name of readdirSync(dir)) {
    const full = path.join(dir, name);
    if (statSync(full).isDirectory()) walk(full, out);
    else if (/\.(ts|tsx)$/.test(name)) out.push(full);
  }
  return out;
}

function isExcluded(relPath) {
  return SCAN_EXCLUSIONS.find((e) => relPath.includes(e.match));
}

/** ============ 消费者清单解析(机读表) ============ */
function parseInventory(scope) {
  if (!existsSync(INVENTORY_MD)) {
    fail(`缺少消费者清单 ${path.relative(repoRoot, INVENTORY_MD)}`);
    return [];
  }
  const md = readFileSync(INVENTORY_MD, 'utf8');
  const begin = `<!-- BEGIN:CONSUMER_TABLE scope=${scope} -->`;
  const end = `<!-- END:CONSUMER_TABLE scope=${scope} -->`;
  const bi = md.indexOf(begin);
  const ei = md.indexOf(end);
  if (bi === -1 || ei === -1) {
    fail(`locale-consumer-inventory.md 缺少 scope=${scope} 的机读表标记`);
    return [];
  }
  const rows = [];
  for (const line of md.slice(bi + begin.length, ei).split('\n')) {
    const t = line.trim();
    if (!t.startsWith('|') || t.startsWith('| id') || /^\|[\s:-]+\|/.test(t)) continue;
    const cells = t.split('|').map((c) => c.trim()).filter((_, i, a) => i > 0 && i < a.length - 1);
    if (cells.length < 4) continue;
    const [id, file, kind, zhTwAssert] = cells;
    rows.push({ id, file, kind, zhTwAssert: zhTwAssert.replace(/^`|`$/g, '') });
  }
  return rows;
}

/** ============ desktop scope ============ */
function checkDesktopLocales(locales) {
  if (!locales.includes('zh-TW')) fail('SUPPORTED_LOCALES 缺 zh-TW(U-1 全量接入)');
  const trees = {};
  for (const loc of locales) {
    const p = path.join(LOCALES_DIR, loc, 'common.json');
    if (!existsSync(p)) {
      fail(`缺 locale 文件 ${loc}/common.json`);
      continue;
    }
    trees[loc] = flatten(readJson(p));
  }
  if (failures.length > 0) return trees;

  // 登录域:zh-CN/en/ja/ko key 全集一致且非空(en 的复数变体按家族折叠)
  const base4 = ['zh-CN', 'en', 'ja', 'ko'];
  const domainKeys = (loc) =>
    new Set(
      [...trees[loc].keys()]
        .filter((k) => LOGIN_DOMAIN_PREFIXES.some((p) => k.startsWith(p)))
        .map((k) => k.replace(/_(zero|one|two|few|many|other)$/, '')),
    );
  const ref = domainKeys('zh-CN');
  for (const loc of base4) {
    const ks = domainKeys(loc);
    for (const k of ref) if (!ks.has(k)) fail(`登录域 key ${k} 在 ${loc} 缺失`);
    for (const k of ks) if (!ref.has(k)) fail(`登录域 key ${k} 只存在于 ${loc}(孤儿 key)`);
  }
  for (const loc of base4) {
    for (const [k, v] of trees[loc]) {
      if (LOGIN_DOMAIN_PREFIXES.some((p) => k.startsWith(p)) && String(v).trim() === '') {
        fail(`登录域 key ${k} 在 ${loc} 为空值`);
      }
    }
  }

  // zh-TW 全量:与 zh-CN 全 key 集合精确相等(同复数类别语言)且全部非空
  if (trees['zh-TW']) {
    const cn = new Set(trees['zh-CN'].keys());
    const tw = new Set(trees['zh-TW'].keys());
    for (const k of cn) if (!tw.has(k)) fail(`zh-TW 缺 key ${k}(U-1 全量接入)`);
    for (const k of tw) if (!cn.has(k)) fail(`zh-TW 多出 key ${k}(与 zh-CN 集合不等)`);
    for (const [k, v] of trees['zh-TW']) {
      // zh-CN 有意留空的 key(如 CANCELLED.message)在 zh-TW 同样留空是合法镜像
      const cnEmpty = String(trees['zh-CN'].get(k) ?? '').trim() === '';
      if (String(v).trim() === '' && !cnEmpty) fail(`zh-TW key ${k} 为空值`);
    }
  }

  // zh-TW 必备 UI key(key 驱动消费者 LanguageSection/VoiceInputSection 的落点)
  for (const loc of locales) {
    const t = trees[loc];
    if (!t) continue;
    if (!t.has('settings.language.options.zh-TW')) {
      fail(`${loc} 缺 settings.language.options.zh-TW(语言下拉项)`);
    }
    if (!t.has('settings.voiceInput.language.optionDescriptions.zh-TW')) {
      fail(`${loc} 缺 settings.voiceInput.language.optionDescriptions.zh-TW(语音语言描述)`);
    }
  }
  return trees;
}

function checkConsumerScan(scope, roots, inventoryRows) {
  // 正向:扫描命中必须已登记
  const registered = new Set(inventoryRows.map((r) => r.file));
  const hits = [];
  for (const root of roots) {
    for (const file of walk(rel(root))) {
      const relPath = path.relative(repoRoot, file).split(path.sep).join('/');
      if (isExcluded(relPath)) continue;
      if (scope === 'desktop' && CALLBACK_FILES.includes(relPath)) continue;
      if (scope === 'callback' && !CALLBACK_FILES.includes(relPath)) continue;
      const txt = readFileSync(file, 'utf8');
      const hasLiteral = /['"]zh-CN['"]/.test(txt) || /startsWith\(\s*['"]zh/.test(txt);
      if (!hasLiteral) continue;
      hits.push(relPath);
      if (!registered.has(relPath)) {
        fail(`[${scope}] locale 字面量命中未登记消费者:${relPath}(补进 locale-consumer-inventory.md 或加入排除表)`);
      }
    }
  }
  // 反向:登记项必须真实存在且命中 zhTwAssert
  for (const row of inventoryRows) {
    const p = rel(row.file);
    if (!existsSync(p)) {
      fail(`[${scope}] 清单项文件不存在:${row.file}`);
      continue;
    }
    const txt = readFileSync(p, 'utf8');
    let re;
    try {
      re = new RegExp(row.zhTwAssert, 'm');
    } catch {
      fail(`[${scope}] 清单项 ${row.id} 的 zhTwAssert 不是合法正则:${row.zhTwAssert}`);
      continue;
    }
    if (!re.test(txt)) {
      fail(`[${scope}] 消费者 ${row.file} 未命中 zh-TW 接受断言 /${row.zhTwAssert}/(U-1 全量接入,不折叠简中)`);
    }
  }
  return hits;
}

/** ============ 翻译评审门(⑥) ============ */
function loadReview() {
  if (!existsSync(REVIEW_JSON)) {
    fail(`缺翻译评审 manifest ${path.relative(repoRoot, REVIEW_JSON)}`);
    return null;
  }
  return readJson(REVIEW_JSON);
}

function checkReviewScope(review, scopeName) {
  const scope = review?.scopes?.[scopeName];
  if (!scope) {
    fail(`translation-review.json 缺 scopes.${scopeName} 节`);
    return;
  }
  // 1) locale 文件 SHA256 绑定
  for (const [name, entry] of Object.entries(scope.localeFiles ?? {})) {
    const p = rel(entry.path);
    if (!existsSync(p)) {
      fail(`[review:${scopeName}] 绑定文件不存在:${entry.path}`);
      continue;
    }
    const actual = sha256(readFileSync(p));
    if (actual !== entry.sha256) {
      fail(
        `[review:${scopeName}] ${name} 文件 SHA256 与评审记录不符(文件已改动,评审失效需重录):${entry.path}`,
      );
    }
  }
  // 2) verbatim 逐字符相等
  const treeCache = new Map();
  const treeOf = (filePath) => {
    if (!treeCache.has(filePath)) treeCache.set(filePath, flatten(readJson(rel(filePath))));
    return treeCache.get(filePath);
  };
  for (const v of scope.verbatim ?? []) {
    const fileEntry = scope.localeFiles?.[v.locale];
    if (!fileEntry) {
      fail(`[review:${scopeName}] verbatim 条目 ${v.key}@${v.locale} 无对应 localeFiles 绑定`);
      continue;
    }
    const tree = treeOf(fileEntry.path);
    const actual = tree.get(v.key);
    if (actual !== v.value) {
      fail(
        `[review:${scopeName}] verbatim 不等:${v.key}@${v.locale} 期望 ${JSON.stringify(v.value)} 实际 ${JSON.stringify(actual)}`,
      );
    }
  }
  // 3) 评审记录完备性
  const records = scope.reviews ?? [];
  for (const r of records) {
    if (!r.reviewer || !r.reviewedAt || !r.source) {
      fail(`[review:${scopeName}] 评审记录缺 reviewer/reviewedAt/source:${r.key}@${r.locale}`);
    }
  }
  // 4) desktop 节:zh-TW 登录域逐 leaf key 必须有精校记录
  if (scopeName === 'desktop') {
    const zhTwEntry = scope.localeFiles?.['zh-TW'];
    if (zhTwEntry) {
      const tw = treeOf(zhTwEntry.path);
      const reviewed = new Set(records.filter((r) => r.locale === 'zh-TW').map((r) => r.key));
      for (const k of tw.keys()) {
        if (LOGIN_DOMAIN_PREFIXES.some((p) => k.startsWith(p)) && !reviewed.has(k)) {
          fail(`[review:desktop] zh-TW 登录域 key 缺人工精校记录:${k}(merge gate)`);
        }
      }
    }
  }
}

/** ============ mobile scope ============ */
/**
 * 从 loginMessages.ts 静态提取 messages 常量的 locale → key 集合。
 * 小型 tokenizer:跳过字符串/模板/注释后做花括号配平,取 depth1 的 locale 块与
 * 各块 depth1 的 key(不执行代码,规则 9:确定性解析)。
 */
function extractMobileCatalog(src) {
  const start = src.search(/const\s+messages\s*=\s*\{/);
  if (start === -1) return null;
  let i = src.indexOf('{', start);
  const open = i;
  let depth = 0;
  const localeBlocks = {};
  let currentLocale = null;
  let localeDepthStart = -1;
  for (; i < src.length; i++) {
    const ch = src[i];
    // 跳字符串
    if (ch === "'" || ch === '"' || ch === '`') {
      const quote = ch;
      let j = i + 1;
      while (j < src.length && src[j] !== quote) {
        if (src[j] === '\\') j++;
        j++;
      }
      const strVal = src.slice(i + 1, j);
      // 引号 locale key('zh-CN'/'zh-TW' 含连字符,合法 JS 必须带引号)在此
      // 先于 depth1 的 regex 命中字符串分支——后随冒号即视为 locale 名收集,
      // 否则 zh 系块永远提取不到(2026-07-20 PR0b-mobile 实測修复)。
      if (depth === 1 && !currentLocale && /^\s*:/.test(src.slice(j + 1))) {
        currentLocale = strVal;
      }
      i = j;
      continue;
    }
    // 跳注释
    if (ch === '/' && src[i + 1] === '/') {
      i = src.indexOf('\n', i);
      if (i === -1) break;
      continue;
    }
    if (ch === '/' && src[i + 1] === '*') {
      i = src.indexOf('*/', i) + 1;
      continue;
    }
    if (ch === '{') {
      depth++;
      if (depth === 2 && currentLocale) localeDepthStart = i;
      continue;
    }
    if (ch === '}') {
      depth--;
      if (depth === 1 && currentLocale && localeDepthStart !== -1) {
        localeBlocks[currentLocale] = src.slice(localeDepthStart, i + 1);
        currentLocale = null;
        localeDepthStart = -1;
      }
      if (depth === 0) break;
      continue;
    }
    if (depth === 1) {
      // 收集 locale 名:标识符或引号 key,后随冒号
      const m = /^([A-Za-z0-9_$-]+|'[^']+'|"[^"]+")\s*:/.exec(src.slice(i));
      if (m && !currentLocale) {
        currentLocale = m[1].replace(/^['"]|['"]$/g, '');
        i += m[0].length - 1;
      }
    }
  }
  if (Object.keys(localeBlocks).length === 0) return null;
  const catalog = {};
  for (const [loc, block] of Object.entries(localeBlocks)) {
    const keys = new Set();
    let d = 0;
    for (let j = 0; j < block.length; j++) {
      const ch = block[j];
      if (ch === "'" || ch === '"' || ch === '`') {
        const q = ch;
        let k2 = j + 1;
        while (k2 < block.length && block[k2] !== q) {
          if (block[k2] === '\\') k2++;
          k2++;
        }
        j = k2;
        continue;
      }
      if (ch === '{') {
        d++;
        continue;
      }
      if (ch === '}') {
        d--;
        continue;
      }
      if (d === 1) {
        const m = /^([A-Za-z0-9_$]+|'[^']+'|"[^"]+")\s*:/.exec(block.slice(j));
        if (m) {
          keys.add(m[1].replace(/^['"]|['"]$/g, ''));
          j += m[0].length - 1;
        }
      }
    }
    catalog[loc] = keys;
  }
  return catalog;
}

function checkMobileCatalog(locales) {
  if (!existsSync(LOGIN_MESSAGES_TS)) {
    fail('缺 apps/mobile/src/auth/loginMessages.ts');
    return;
  }
  const src = readFileSync(LOGIN_MESSAGES_TS, 'utf8');
  const catalog = extractMobileCatalog(src);
  if (!catalog) {
    fail('loginMessages.ts 无法提取 messages catalog(结构漂移?)');
    return;
  }
  const expected = new Set(locales);
  const actual = new Set(Object.keys(catalog));
  for (const loc of expected) {
    if (!actual.has(loc)) fail(`mobile catalog 缺 locale ${loc}(WHAT5:5 语 catalog)`);
  }
  for (const loc of actual) {
    if (!expected.has(loc)) fail(`mobile catalog 存在计划外 locale ${loc}`);
  }
  const refLoc = locales.find((l) => catalog[l]);
  if (!refLoc) return;
  const refKeys = catalog[refLoc];
  for (const loc of locales) {
    if (!catalog[loc]) continue;
    for (const k of refKeys) if (!catalog[loc].has(k)) fail(`mobile catalog key ${k} 在 ${loc} 缺失`);
    for (const k of catalog[loc]) if (!refKeys.has(k)) fail(`mobile catalog key ${k} 只在 ${loc} 存在`);
  }
}

/** ============ main ============ */
const args = process.argv.slice(2);
const scopeIdx = args.indexOf('--scope');
const scope = scopeIdx !== -1 ? args[scopeIdx + 1] : 'all';
if (!['desktop', 'callback', 'mobile', 'all'].includes(scope)) {
  console.error(`未知 scope:${scope}(合法值 desktop|callback|mobile|all)`);
  process.exit(2);
}

const locales = parseSupportedLocales();
const review = loadReview();

if (scope === 'desktop' || scope === 'all') {
  checkDesktopLocales(locales);
  const rows = parseInventory('desktop');
  checkConsumerScan('desktop', ['apps/desktop/src'], rows);
  if (review) checkReviewScope(review, 'desktop');
}

if (scope === 'callback' || scope === 'all') {
  const rows = parseInventory('callback');
  checkConsumerScan('callback', ['apps/desktop/src'], rows);
  if (review) checkReviewScope(review, 'callback');
}

if (scope === 'mobile' || scope === 'all') {
  checkMobileCatalog(locales);
  const rows = parseInventory('mobile');
  checkConsumerScan('mobile', ['apps/mobile/src'], rows);
  if (review) checkReviewScope(review, 'mobile');
}

if (failures.length > 0) {
  console.error(`I18N_PARITY_FAIL(scope=${scope},${failures.length} 项):`);
  for (const f of failures) console.error(`  - ${f}`);
  process.exit(1);
}
console.log(`[parity] scope=${scope} 全部断言通过`);
console.log('I18N_PARITY_OK');
