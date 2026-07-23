#!/usr/bin/env node
/**
 * check-fidelity-matrix.mjs — 登录换肤 fidelity 总矩阵校验器（PR0a 交付）。
 *
 * 合约来源（逐字执行,不得自行放宽）：
 *  - docs/login-redesign/implementation-plan.md 附录 B（ManifestRow/CellRef/EvidenceMeta/Cell
 *    冻结 schema + 硬适用性不变量 + 负 fixture ①~⑬ 清单,v6.19）;
 *  - 同文件 §「百分百还原验收框架」（五枚举格值/证据复用 evidenceReuseGroups/sidecar/
 *    终态精确定义/--for-main tree-entry tuple 提交语义/artifact allowlist 四项）;
 *  - SC-6/SC-7（--slice 分片门禁,输出 SLICE_OK）与 SC-9（--final 终态门,输出
 *    FIDELITY_MATRIX_OK:VERIFIED|:WAIVERS;--for-main 只接受 :VERIFIED + Git 校验）。
 *
 * 模式：
 *   node scripts/check-fidelity-matrix.mjs --slice pr1            # 分片门禁(违规 exit 非零)
 *   node scripts/check-fidelity-matrix.mjs --preview-slice pr1    # 同逻辑仅警告,恒 exit 0
 *   node scripts/check-fidelity-matrix.mjs --final                # 全矩阵终态判定
 *   node scripts/check-fidelity-matrix.mjs --final --for-main     # main 终审(附加 Git tuple 校验)
 *   node scripts/check-fidelity-matrix.mjs --self-test            # 跑全部 fixture 场景
 * 通用覆盖参数（fixture 自测用;正式运行走仓内默认路径）：
 *   --matrix <path> --manifest <path> --catalog <path> --evidence-root <path>
 *   --git-dir <repoDir> --for-main-commit <sha>
 */
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import os from 'node:os';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(SCRIPT_DIR, '..');
const ACCEPTANCE_DIR = path.join(REPO_ROOT, 'docs', 'login-redesign', 'acceptance');
const FIXTURE_ROOT = path.join(SCRIPT_DIR, '__fixtures__', 'login-fidelity');

// ---- 冻结枚举（附录 B v6.18 类型冻结） ----
const DEVICES = Object.freeze(['mac', 'windows', 'iphone', 'android-phone', 'ipad', 'android-pad']);
const LOCALES = Object.freeze(['zh-CN', 'zh-TW', 'en', 'ja', 'ko']);
const REGIONS = Object.freeze(['cn', 'global']);
const ROW_KINDS = Object.freeze(['desktop', 'all-mobile', 'phone-only', 'pad-only']);
const SLICES = Object.freeze(['pr1', 'pr2a', 'pr2b', 'pr3', 'pr4a', 'pr4b', 'pr5']);
const NA_REASONS = Object.freeze([
  'surface-not-on-platform',
  'region-exclusive',
  'platform-exclusive-feature',
]);
// rowKind → 必须精确等于的 devices 集合（硬适用性不变量,manifest 不可豁免）
const DEVICES_BY_ROWKIND = Object.freeze({
  desktop: ['mac', 'windows'],
  'all-mobile': ['iphone', 'android-phone', 'ipad', 'android-pad'],
  'phone-only': ['iphone', 'android-phone'],
  'pad-only': ['ipad', 'android-pad'],
});
// PASS 证据扩展名白名单
const EVIDENCE_EXTS = Object.freeze(['png', 'jpg', 'jpeg', 'webp', 'mp4', 'mov', 'json', 'txt', 'md']);
// --for-main artifact allowlist（冻结四项,v6.18 收窄;前两/后两项为目录前缀）
const ALLOWLIST_FILES = Object.freeze([
  'docs/login-redesign/acceptance/fidelity-matrix.md',
  'docs/login-redesign/acceptance/e2e/report.json',
]);
const ALLOWLIST_DIRS = Object.freeze([
  'docs/login-redesign/acceptance/evidence/',
  'docs/login-redesign/acceptance/e2e/evidence/',
]);
const CANON_MATRIX = 'docs/login-redesign/acceptance/fidelity-matrix.md';
const CANON_EVIDENCE_DIR = 'docs/login-redesign/acceptance/evidence';
const CANON_E2E_REPORT = 'docs/login-redesign/acceptance/e2e/report.json';
const CANON_E2E_EVIDENCE_DIR = 'docs/login-redesign/acceptance/e2e/evidence';

// ---- 小工具 ----
/** 深等比较（JSON 值域;数组按序,对象按键集合） */
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
  if (sa.size !== sb.size) return false;
  for (const v of sa) if (!sb.has(v)) return false;
  return true;
}
/** CellRef → 规范化 key（附录 B v6.18 等价规则） */
function cellRefKey(ref) {
  return `${ref.rowId}|${ref.device}|${ref.locale}|${ref.region}`;
}
function isValidCellRef(ref) {
  return (
    ref &&
    typeof ref === 'object' &&
    typeof ref.rowId === 'string' &&
    DEVICES.includes(ref.device) &&
    LOCALES.includes(ref.locale) &&
    REGIONS.includes(ref.region)
  );
}
function sha256(buf) {
  return crypto.createHash('sha256').update(buf).digest('hex');
}
function readJson(file) {
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

/** 校验结果收集器：errors 决定 exit 码;每条带机器码便于 self-test 精确断言 */
class Report {
  constructor() {
    this.errors = [];
  }
  err(code, msg) {
    this.errors.push({ code, msg });
  }
  hasCode(code) {
    return this.errors.some((e) => e.code === code);
  }
}

// ---- 矩阵 md 解析：文档必须含唯一一个 ```json fenced block ----
function parseMatrixMd(matrixPath, report) {
  const text = fs.readFileSync(matrixPath, 'utf8');
  const blocks = [...text.matchAll(/^```json[ \t]*\r?\n([\s\S]*?)^```[ \t]*$/gm)];
  if (blocks.length !== 1) {
    report.err('MATRIX_JSON_BLOCK', `矩阵文档必须含唯一一个 \`\`\`json 机读块,实际 ${blocks.length} 个: ${matrixPath}`);
    return null;
  }
  try {
    const data = JSON.parse(blocks[0][1]);
    if (!data || typeof data !== 'object' || !data.cells || typeof data.cells !== 'object') {
      report.err('MATRIX_JSON_SHAPE', '机读块顶层必须为 { "cells": { ... } }');
      return null;
    }
    return data;
  } catch (e) {
    report.err('MATRIX_JSON_PARSE', `机读块 JSON 解析失败: ${e.message}`);
    return null;
  }
}

// ---- a. manifest schema 校验 ----
function checkManifestSchema(manifest, catalog, report) {
  if (!manifest || !Array.isArray(manifest.rows)) {
    report.err('SCHEMA_TOP', 'manifest 顶层必须含 rows 数组');
    return;
  }
  const byId = new Map();
  for (const row of manifest.rows) {
    const id = row?.rowId;
    if (typeof id !== 'string' || !id) {
      report.err('SCHEMA_ROWID', 'manifest 行缺 rowId');
      continue;
    }
    if (byId.has(id)) report.err('SCHEMA_ROWID_DUP', `rowId 重复: ${id}`);
    byId.set(id, row);
    // rowKind 只认四字面量(负例⑧:别名如 "phone" 拒绝)
    if (!ROW_KINDS.includes(row.rowKind)) {
      report.err('SCHEMA_ROWKIND', `行 ${id} rowKind 非法: ${JSON.stringify(row.rowKind)}(只认 ${ROW_KINDS.join('|')})`);
    }
    if (row.platform !== 'desktop' && row.platform !== 'mobile') {
      report.err('SCHEMA_PLATFORM', `行 ${id} platform 非法: ${JSON.stringify(row.platform)}`);
    }
    if (!SLICES.includes(row.slice)) {
      report.err('SCHEMA_SLICE', `行 ${id} slice 非法: ${JSON.stringify(row.slice)}`);
    }
    if (typeof row.stateFamily !== 'string' || !row.stateFamily) {
      report.err('SCHEMA_STATEFAMILY', `行 ${id} 缺 stateFamily`);
    }
    // baselineRequirements 必填且 length===1(附录 B v6.11/v6.16;负例⑩/⑦c)
    if (!Array.isArray(row.baselineRequirements)) {
      report.err('SCHEMA_BASELINE_MISSING', `行 ${id} 缺 baselineRequirements(v6.16 必填)`);
    } else if (row.baselineRequirements.length !== 1) {
      report.err('SCHEMA_BASELINE_LEN', `行 ${id} baselineRequirements length 必须===1(一行一期望维度),实际 ${row.baselineRequirements.length}`);
    } else {
      const br = row.baselineRequirements[0];
      if (!br || typeof br.dimension !== 'string' || typeof br.source !== 'string' || typeof br.ref !== 'string') {
        report.err('SCHEMA_BASELINE_SHAPE', `行 ${id} baselineRequirements[0] 必须含 dimension/source/ref`);
      } else if (br.dimension !== row.dimension || br.source !== row.source || br.ref !== row.ref) {
        // baselineRequirement 取自本行 dimension/source/ref(PR0a 生成合约),不一致=期望被篡改
        report.err('SCHEMA_BASELINE_INCONSISTENT', `行 ${id} baselineRequirements[0] 与本行 dimension/source/ref 不一致`);
      }
    }
    if (!Array.isArray(row.tests) || row.tests.some((t) => !t || typeof t.file !== 'string' || typeof t.testId !== 'string')) {
      report.err('SCHEMA_TESTS', `行 ${id} tests 必须为 {file,testId}[] 数组`);
    }
    // naAllowed 约束式形态: [{match:{<维度>:[值]}, reasonCode}]
    if (row.naAllowed !== undefined) {
      if (!Array.isArray(row.naAllowed)) {
        report.err('SCHEMA_NAALLOWED', `行 ${id} naAllowed 必须为数组`);
      } else {
        for (const c of row.naAllowed) {
          if (!c || typeof c !== 'object' || !c.match || typeof c.match !== 'object' || !NA_REASONS.includes(c.reasonCode)) {
            report.err('SCHEMA_NAALLOWED', `行 ${id} naAllowed 条目非法(需 {match,reasonCode∈${NA_REASONS.join('|')}})`);
          }
        }
      }
    }
    const ap = row.applicability;
    if (!ap || !Array.isArray(ap.devices) || !Array.isArray(ap.locales) || !Array.isArray(ap.regions)) {
      report.err('SCHEMA_APPLICABILITY', `行 ${id} applicability 必须含 devices/locales/regions 数组`);
    }
  }
  // phone-only/pad-only 机械配对(负例⑥):同 platform 同 stateFamily 必须成对
  const pairKinds = { 'phone-only': 'pad-only', 'pad-only': 'phone-only' };
  for (const row of manifest.rows) {
    const other = pairKinds[row?.rowKind];
    if (!other) continue;
    const paired = manifest.rows.some(
      (r) => r !== row && r.rowKind === other && r.platform === row.platform && r.stateFamily === row.stateFamily,
    );
    if (!paired) {
      report.err('PAIR_PHONE_PAD_MISSING', `行 ${row.rowId}(${row.rowKind}) 缺少同 stateFamily=${row.stateFamily} 的 ${other} 配对行`);
    }
  }
  // 拆行完整性(负例⑦第四变体):以 catalog 为准,同 (platform,stateFamily) 内存在
  // dimension=asset 与 dimension=geometry 配对关系时,manifest 缺任一即败
  if (catalog && Array.isArray(catalog.rows)) {
    const groups = new Map();
    for (const cr of catalog.rows) {
      const key = `${cr.platform}\u0000${cr.stateFamily}`;
      if (!groups.has(key)) groups.set(key, []);
      groups.get(key).push(cr);
    }
    for (const [, rowsInGroup] of groups) {
      const assets = rowsInGroup.filter((r) => r.dimension === 'asset');
      const geos = rowsInGroup.filter((r) => r.dimension === 'geometry');
      if (assets.length && geos.length) {
        for (const need of [...assets, ...geos]) {
          if (!byId.has(need.rowId)) {
            report.err('PAIR_ASSET_GEOMETRY_MISSING', `拆行完整性: catalog 中 ${need.platform}/${need.stateFamily} 存在 asset/geometry 配对,manifest 缺 ${need.rowId}`);
          }
        }
      }
    }
  }
  // evidenceReuseGroups 全局校验(v6.16:dimension 冻结 locale;禁跨 device/region/文案行)
  if (manifest.evidenceReuseGroups !== undefined) {
    if (!Array.isArray(manifest.evidenceReuseGroups)) {
      report.err('SCHEMA_REUSE_TOP', 'evidenceReuseGroups 必须为数组');
    } else {
      const seenGroupIds = new Set();
      for (const g of manifest.evidenceReuseGroups) {
        const gid = g?.groupId;
        if (typeof gid !== 'string' || !gid) {
          report.err('SCHEMA_REUSE_GROUPID', 'evidenceReuseGroups 条目缺 groupId');
          continue;
        }
        if (seenGroupIds.has(gid)) report.err('SCHEMA_REUSE_GROUPID_DUP', `groupId 重复: ${gid}`);
        seenGroupIds.add(gid);
        if (g.dimension !== 'locale') {
          report.err('SCHEMA_REUSE_DIMENSION', `复用组 ${gid} dimension 必须为 "locale"(v6.16 冻结),实际 ${JSON.stringify(g.dimension)}`);
        }
        if (typeof g.rationale !== 'string' || !g.rationale) {
          report.err('SCHEMA_REUSE_RATIONALE', `复用组 ${gid} rationale 必填`);
        }
        if (!Array.isArray(g.cells) || g.cells.length < 2 || g.cells.some((c) => !isValidCellRef(c))) {
          report.err('SCHEMA_REUSE_CELLS', `复用组 ${gid} cells 必须为 ≥2 个合法 CellRef`);
          continue;
        }
        const keys = g.cells.map(cellRefKey);
        if (new Set(keys).size !== keys.length) {
          report.err('SCHEMA_REUSE_CELL_DUP', `复用组 ${gid} cells 含重复 CellRef`);
        }
        // 仅 locale 分量变化:rowId/device/region 必须一致
        const first = g.cells[0];
        if (g.cells.some((c) => c.rowId !== first.rowId || c.device !== first.device || c.region !== first.region)) {
          report.err('SCHEMA_REUSE_CROSS_DIMENSION', `复用组 ${gid} 组内 ref 只允许 locale 分量变化(禁跨 device/region/行)`);
        }
        const row = byId.get(first.rowId);
        if (!row) {
          report.err('SCHEMA_REUSE_ROW', `复用组 ${gid} 引用不存在的 rowId: ${first.rowId}`);
        } else if (row.dimension === 'copy') {
          report.err('SCHEMA_REUSE_COPY_ROW', `复用组 ${gid} 禁止用于文案行(dimension=copy): ${first.rowId}`);
        }
      }
    }
  }
  return byId;
}

// ---- b. catalog 对账(SC-2/SC-7 口径):rowId 集合精确相等 + 逐行 ground-truth 深等 ----
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
function checkCatalogReconciliation(manifest, catalog, report) {
  if (!catalog || !Array.isArray(catalog.rows)) {
    report.err('CATALOG_SHAPE', 'catalog 顶层必须含 rows 数组');
    return;
  }
  const mIds = (manifest.rows ?? []).map((r) => r.rowId);
  const cIds = catalog.rows.map((r) => r.rowId);
  if (!setEquals(mIds, cIds)) {
    const missing = cIds.filter((id) => !mIds.includes(id));
    const extra = mIds.filter((id) => !cIds.includes(id));
    report.err('ROWSET_MISMATCH', `manifest rowId 集合与 catalog 不精确相等(空/子/超集均败): 缺失=${JSON.stringify(missing)} 多余=${JSON.stringify(extra)}`);
  }
  const cById = new Map(catalog.rows.map((r) => [r.rowId, r]));
  for (const row of manifest.rows ?? []) {
    const cr = cById.get(row.rowId);
    if (!cr) continue; // 已由 ROWSET_MISMATCH 报过
    for (const f of GROUND_TRUTH_FIELDS) {
      if (!deepEqual(row[f] ?? null, cr[f] ?? null)) {
        report.err('CATALOG_FIELD_MISMATCH', `行 ${row.rowId} ground-truth 字段 ${f} 与 catalog 不等(期望权威在 catalog):manifest=${JSON.stringify(row[f])} catalog=${JSON.stringify(cr[f])}`);
      }
    }
  }
}

// ---- c. 硬适用性不变量(附录 B,manifest 不可豁免) ----
function checkHardInvariants(manifest, report) {
  for (const row of manifest.rows ?? []) {
    const ap = row.applicability;
    if (!ap || !Array.isArray(ap.devices) || !Array.isArray(ap.locales) || !Array.isArray(ap.regions)) continue;
    if (!setEquals(ap.locales, LOCALES)) {
      report.err('INVARIANT_LOCALES', `行 ${row.rowId} locales 必须精确=5 语全集 ${JSON.stringify(LOCALES)},实际 ${JSON.stringify(ap.locales)}`);
    }
    if (!setEquals(ap.regions, REGIONS)) {
      report.err('INVARIANT_REGIONS', `行 ${row.rowId} regions 必须=[cn,global],实际 ${JSON.stringify(ap.regions)}`);
    }
    const wantDevices = DEVICES_BY_ROWKIND[row.rowKind];
    if (wantDevices && !setEquals(ap.devices, wantDevices)) {
      report.err('INVARIANT_DEVICES', `行 ${row.rowId}(rowKind=${row.rowKind}) devices 必须=${JSON.stringify(wantDevices)},实际 ${JSON.stringify(ap.devices)}`);
    }
  }
}

// ---- d. cell 校验(五枚举/N-A 约束/PASS 证据/sidecar/SHA 复用) ----
function parseCellKey(key) {
  const parts = key.split('|');
  if (parts.length !== 4) return null;
  const [rowId, device, locale, region] = parts;
  return { rowId, device, locale, region };
}
/** N/A 是否命中行的 naAllowed 约束(match 子集判定,reasonCode 须一致) */
function naMatches(row, ref, reasonCode) {
  for (const c of row.naAllowed ?? []) {
    if (c.reasonCode !== reasonCode) continue;
    const dims = Object.keys(c.match ?? {});
    if (dims.length === 0) continue;
    if (dims.every((d) => Array.isArray(c.match[d]) && c.match[d].includes(ref[d]))) return true;
  }
  return false;
}
const PNG_MAGIC = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const JPG_MAGIC = Buffer.from([0xff, 0xd8, 0xff]);

function checkCells(matrixData, manifestById, manifest, evidenceRoot, report) {
  const cells = matrixData?.cells ?? {};
  /** evidencePath(相对) → { sha, cellKeys:Set, meta } */
  const evidenceIndex = new Map();
  const groupById = new Map((manifest.evidenceReuseGroups ?? []).map((g) => [g.groupId, g]));

  for (const [key, cell] of Object.entries(cells)) {
    const ref = parseCellKey(key);
    if (!ref) {
      report.err('CELL_KEY', `cell key 格式非法(需 rowId|device|locale|region): ${key}`);
      continue;
    }
    const row = manifestById?.get(ref.rowId);
    if (!row) {
      report.err('CELL_ROW_UNKNOWN', `cell ${key} 的 rowId 不在 manifest 中`);
      continue;
    }
    if (!DEVICES.includes(ref.device) || !LOCALES.includes(ref.locale) || !REGIONS.includes(ref.region)) {
      report.err('CELL_COORD', `cell ${key} 坐标分量非法`);
      continue;
    }
    const ap = row.applicability ?? {};
    if (!ap.devices?.includes(ref.device) || !ap.locales?.includes(ref.locale) || !ap.regions?.includes(ref.region)) {
      report.err('CELL_OUT_OF_APPLICABILITY', `cell ${key} 超出行 applicability 范围`);
      continue;
    }
    if (!cell || typeof cell !== 'object' || typeof cell.value !== 'string') {
      report.err('CELL_VALUE', `cell ${key} 缺 value`);
      continue;
    }
    switch (cell.value) {
      case 'PASS': {
        if (typeof cell.evidence !== 'string' || !cell.evidence) {
          report.err('PASS_EVIDENCE_FIELD', `PASS 格 ${key} 缺 evidence`);
          break;
        }
        if (!cell.baseline || typeof cell.baseline.source !== 'string' || typeof cell.baseline.ref !== 'string') {
          report.err('PASS_BASELINE_FIELD', `PASS 格 ${key} 缺 baseline{source,ref}`);
          break;
        }
        const br = row.baselineRequirements?.[0];
        if (br && (cell.baseline.source !== br.source || cell.baseline.ref !== br.ref)) {
          report.err('PASS_BASELINE_MISMATCH', `PASS 格 ${key} baseline 与行唯一期望不符: cell=${JSON.stringify(cell.baseline)} manifest=${JSON.stringify({ source: br.source, ref: br.ref })}`);
        }
        if (typeof cell.reviewer !== 'string' || !cell.reviewer || typeof cell.approvedAt !== 'string' || !cell.approvedAt) {
          report.err('PASS_REVIEW_FIELD', `PASS 格 ${key} 缺 reviewer/approvedAt(像素保真人审必填)`);
        }
        // 证据文件:evidence-root 下、非空、扩展名白名单、png/jpg 魔数
        const rel = cell.evidence.replace(/\\/g, '/');
        if (rel.startsWith('/') || rel.split('/').includes('..')) {
          report.err('PASS_EVIDENCE_PATH', `PASS 格 ${key} evidence 路径必须为 evidence 根下相对路径: ${rel}`);
          break;
        }
        const abs = path.join(evidenceRoot, rel);
        if (!fs.existsSync(abs) || !fs.lstatSync(abs).isFile()) {
          report.err('PASS_EVIDENCE_MISSING', `PASS 格 ${key} 证据文件不存在: ${abs}`);
          break;
        }
        const buf = fs.readFileSync(abs);
        if (buf.length === 0) {
          report.err('PASS_EVIDENCE_EMPTY', `PASS 格 ${key} 证据文件为空: ${rel}`);
          break;
        }
        const ext = rel.split('.').pop().toLowerCase();
        if (!EVIDENCE_EXTS.includes(ext)) {
          report.err('PASS_EVIDENCE_EXT', `PASS 格 ${key} 证据扩展名不在白名单(${EVIDENCE_EXTS.join('/')}): ${rel}`);
          break;
        }
        if ((ext === 'png' && !buf.subarray(0, 8).equals(PNG_MAGIC)) || ((ext === 'jpg' || ext === 'jpeg') && !buf.subarray(0, 3).equals(JPG_MAGIC))) {
          report.err('PASS_EVIDENCE_MAGIC', `PASS 格 ${key} 证据头部魔数校验失败(不可解码): ${rel}`);
          break;
        }
        if (!evidenceIndex.has(rel)) {
          evidenceIndex.set(rel, { sha: sha256(buf), cellKeys: new Set(), abs });
        }
        evidenceIndex.get(rel).cellKeys.add(key);
        break;
      }
      case 'FAIL':
        if (typeof cell.note !== 'string' || !cell.note) report.err('FAIL_NOTE', `FAIL 格 ${key} 缺 note`);
        break;
      case 'GAP':
        break; // 字段全可选;final/slice 模式另行判死
      case 'N/A': {
        if (!NA_REASONS.includes(cell.reasonCode)) {
          report.err('NA_REASON', `N/A 格 ${key} reasonCode 非法: ${JSON.stringify(cell.reasonCode)}`);
          break;
        }
        if (!naMatches(row, ref, cell.reasonCode)) {
          report.err('NA_NOT_ALLOWED', `N/A 格 ${key} 未命中 manifest naAllowed 约束(manifest 外 N/A 一律失败)`);
        }
        break;
      }
      case 'WAIVER': {
        for (const f of ['approvedBy', 'approvedAt', 'retestVia', 'deadline']) {
          if (typeof cell[f] !== 'string' || !cell[f]) report.err('WAIVER_FIELD', `WAIVER 格 ${key} 缺 ${f}(未批 WAIVER 无效)`);
        }
        break;
      }
      default:
        report.err('CELL_ENUM', `cell ${key} value 非法(五枚举 PASS/FAIL/GAP/N-A/WAIVER): ${cell.value}`);
    }
  }

  // sidecar 校验(负例⑫族)
  for (const [rel, info] of evidenceIndex) {
    const metaPath = `${info.abs}.meta.json`;
    if (!fs.existsSync(metaPath)) {
      report.err('SIDECAR_MISSING', `证据缺 sidecar: ${rel}.meta.json`);
      continue;
    }
    let meta;
    try {
      meta = readJson(metaPath);
    } catch (e) {
      report.err('SIDECAR_PARSE', `sidecar 解析失败 ${rel}: ${e.message}`);
      continue;
    }
    info.meta = meta;
    if (typeof meta.evidenceSha256 !== 'string' || meta.evidenceSha256 !== info.sha) {
      report.err('SIDECAR_SHA', `sidecar evidenceSha256 与文件实测不符: ${rel}`);
    }
    if (typeof meta.testedCodeCommit !== 'string' || !meta.testedCodeCommit) {
      report.err('SIDECAR_COMMIT', `sidecar 缺 testedCodeCommit: ${rel}`);
    }
    if (typeof meta.capturedAt !== 'string' || !meta.capturedAt) {
      report.err('SIDECAR_CAPTUREDAT', `sidecar 缺 capturedAt: ${rel}`);
    }
    if (!isValidCellRef(meta.capturedCellRef)) {
      report.err('SIDECAR_CAPTURED_REF', `sidecar capturedCellRef 非法: ${rel}`);
      continue;
    }
    if (!Array.isArray(meta.applicableCellRefs) || meta.applicableCellRefs.length === 0 || meta.applicableCellRefs.some((r) => !isValidCellRef(r))) {
      report.err('SIDECAR_APPLICABLE', `sidecar applicableCellRefs 必须为非空合法 CellRef 数组: ${rel}`);
      continue;
    }
    const applKeys = meta.applicableCellRefs.map(cellRefKey);
    if (new Set(applKeys).size !== applKeys.length) {
      report.err('SIDECAR_DUP_CELLREF', `sidecar applicableCellRefs 含重复 CellRef: ${rel}`);
    }
    if (!applKeys.includes(cellRefKey(meta.capturedCellRef))) {
      report.err('SIDECAR_CAPTURED_NOT_IN_APPLICABLE', `sidecar capturedCellRef 必须 ∈ applicableCellRefs: ${rel}`);
    }
    // 引用该证据的每个格必须 ∈ applicableCellRefs
    for (const ck of info.cellKeys) {
      if (!applKeys.includes(ck)) {
        report.err('SIDECAR_CELL_NOT_APPLICABLE', `引用证据 ${rel} 的格 ${ck} 不在 sidecar applicableCellRefs 内`);
      }
    }
    if (meta.reuseGroupId !== undefined) {
      // 复用态:reuseGroupId 必须命中 manifest 组,组 cells 集合与 applicableCellRefs 精确相等
      const g = groupById.get(meta.reuseGroupId);
      if (!g) {
        report.err('SIDECAR_GROUP_NOT_FOUND', `sidecar reuseGroupId 未命中 manifest evidenceReuseGroups: ${rel} → ${meta.reuseGroupId}`);
      } else if (!setEquals((g.cells ?? []).map(cellRefKey), applKeys)) {
        report.err('SIDECAR_GROUP_SET_MISMATCH', `sidecar applicableCellRefs 与复用组 ${meta.reuseGroupId} 的 cells 集合不精确相等: ${rel}`);
      }
      // 组内仅 locale 分量变化(组自身 schema 已查;此处对 applicableCellRefs 再断言)
      const first = meta.applicableCellRefs[0];
      if (meta.applicableCellRefs.some((r) => r.rowId !== first.rowId || r.device !== first.device || r.region !== first.region)) {
        report.err('SIDECAR_CROSS_DIMENSION', `sidecar applicableCellRefs 只允许 locale 分量变化: ${rel}`);
      }
    } else if (meta.applicableCellRefs.length !== 1) {
      // 非复用态:applicableCellRefs 恰 1(且为 capturedCellRef)
      report.err('SIDECAR_NONREUSE_MULTI', `非复用态 sidecar applicableCellRefs 必须恰 1: ${rel}`);
    }
  }

  // SHA256 重复检测(负例⑪):同一 SHA 出现在两格而无声明组 → 败
  const bySha = new Map();
  for (const [rel, info] of evidenceIndex) {
    if (!bySha.has(info.sha)) bySha.set(info.sha, []);
    bySha.get(info.sha).push({ rel, info });
  }
  for (const [sha, entries] of bySha) {
    const allCellKeys = new Set(entries.flatMap((e) => [...e.info.cellKeys]));
    if (allCellKeys.size <= 1) continue;
    if (entries.length > 1) {
      // 同内容拷贝成多个文件跨格使用,等同未声明复用
      report.err('DUPLICATE_SHA', `同一证据 SHA256(${sha.slice(0, 12)}…) 以多个文件出现在多格且无合法声明组: ${entries.map((e) => e.rel).join(', ')}`);
      continue;
    }
    const meta = entries[0].info.meta;
    if (!meta || meta.reuseGroupId === undefined || !groupById.get(meta.reuseGroupId)) {
      report.err('DUPLICATE_SHA', `证据 ${entries[0].rel} 被多格引用但未通过 evidenceReuseGroups 声明复用组`);
    }
    // 组合法性(dimension=locale/集合相等/仅 locale 变化)已在 sidecar/组 schema 校验覆盖
  }
  return { evidenceIndex };
}

// ---- 适用格枚举(slice/final 完整性用) ----
function* applicableRefs(row) {
  const ap = row.applicability ?? {};
  for (const device of ap.devices ?? []) {
    for (const locale of ap.locales ?? []) {
      for (const region of ap.regions ?? []) {
        yield { rowId: row.rowId, device, locale, region };
      }
    }
  }
}

function checkCompleteness(rows, cells, report, label) {
  let waiverCount = 0;
  for (const row of rows) {
    for (const ref of applicableRefs(row)) {
      const key = cellRefKey(ref);
      const cell = cells[key];
      if (!cell) {
        report.err('EMPTY_CELL', `${label}: 格 ${key} 为空(不允许空格)`);
        continue;
      }
      if (cell.value === 'GAP') report.err('GAP_PRESENT', `${label}: 格 ${key} = GAP(GAP=0 门禁)`);
      else if (cell.value === 'FAIL') report.err('FAIL_PRESENT', `${label}: 格 ${key} = FAIL`);
      else if (cell.value === 'WAIVER') waiverCount += 1;
    }
  }
  return { waiverCount };
}

// ---- --for-main Git 校验(v6.18/v6.19 tree-entry tuple 模型) ----
function git(repoDir, args) {
  const r = spawnSync('git', ['-C', repoDir, ...args], { encoding: 'buffer', maxBuffer: 512 * 1024 * 1024 });
  if (r.status !== 0) {
    throw new Error(`git ${args.join(' ')} 失败: ${r.stderr?.toString('utf8').trim()}`);
  }
  return r.stdout;
}
/** git ls-tree -r -z 解析为 Map(path → {mode,type,oid}) */
function lsTree(repoDir, sha) {
  const out = git(repoDir, ['ls-tree', '-r', '-z', sha]).toString('utf8');
  const map = new Map();
  for (const entry of out.split('\0')) {
    if (!entry) continue;
    const tab = entry.indexOf('\t');
    const [mode, type, oid] = entry.slice(0, tab).split(' ');
    map.set(entry.slice(tab + 1), { mode, type, oid });
  }
  return map;
}
function inAllowlist(p) {
  return ALLOWLIST_FILES.includes(p) || ALLOWLIST_DIRS.some((d) => p.startsWith(d));
}

function checkForMain(opts, matrixData, evidenceIndex, report) {
  const repoDir = opts.gitDir ?? REPO_ROOT;
  const C = opts.forMainCommit ?? matrixData?.forMain?.testedCodeCommit;
  if (typeof C !== 'string' || !/^[0-9a-f]{40}$/i.test(C)) {
    report.err('FORMAIN_COMMIT', `--for-main 需要矩阵机读块顶层 forMain.testedCodeCommit 为 C 全 SHA(或 --for-main-commit 注入),实际: ${JSON.stringify(C)}`);
    return;
  }
  let H;
  try {
    H = git(repoDir, ['rev-parse', 'HEAD']).toString('utf8').trim();
    // C 的对象必须存在于对象库(不要求祖先关系,免疫 squash/rebase)
    git(repoDir, ['cat-file', '-e', `${C}^{commit}`]);
  } catch (e) {
    report.err('FORMAIN_GIT', `Git 校验失败: ${e.message}`);
    return;
  }
  let treeC;
  let treeH;
  try {
    treeC = lsTree(repoDir, C);
    treeH = lsTree(repoDir, H);
  } catch (e) {
    report.err('FORMAIN_GIT', `ls-tree 失败: ${e.message}`);
    return;
  }
  // 过滤 artifact allowlist 后,两侧 {path,mode,type,objectId} tuple 集合必须精确相等
  const filt = (m) => new Map([...m].filter(([p]) => !inAllowlist(p)));
  const fc = filt(treeC);
  const fh = filt(treeH);
  for (const [p, e] of fc) {
    const h = fh.get(p);
    if (!h) report.err('FORMAIN_TUPLE_MISMATCH', `allowlist 外路径在 H 被删除: ${p}`);
    else if (h.mode !== e.mode || h.type !== e.type || h.oid !== e.oid) {
      report.err('FORMAIN_TUPLE_MISMATCH', `allowlist 外路径 C/H tuple 不等: ${p} (C=${e.mode}/${e.type}/${e.oid.slice(0, 8)} H=${h.mode}/${h.type}/${h.oid.slice(0, 8)})`);
    }
  }
  for (const p of fh.keys()) {
    if (!fc.has(p)) report.err('FORMAIN_TUPLE_MISMATCH', `allowlist 外路径在 H 新增: ${p}`);
  }

  // artifact 正规文件约束 + 引用闭包(v6.19)
  const requireRegular = (p, required) => {
    const e = treeH.get(p);
    if (!e) {
      if (required) report.err('FORMAIN_ARTIFACT_MISSING', `H 缺 artifact: ${p}`);
      return null;
    }
    if (e.mode !== '100644' || e.type !== 'blob') {
      report.err('FORMAIN_ARTIFACT_NOT_REGULAR', `artifact 必须为 mode=100644 type=blob 正规文件(拒 symlink/gitlink): ${p} 实际 ${e.mode}/${e.type}`);
    }
    return e;
  };
  // fidelity-matrix.md:必须在 H、正规文件、且工作树内容与 H object 一致
  const matrixEntry = requireRegular(CANON_MATRIX, true);
  const relMatrix = path.relative(repoDir, path.resolve(opts.matrix)).split(path.sep).join('/');
  if (relMatrix !== CANON_MATRIX) {
    report.err('FORMAIN_MATRIX_PATH', `--for-main 下矩阵必须位于仓内正规路径 ${CANON_MATRIX},实际 ${relMatrix}`);
  } else if (matrixEntry) {
    const actual = git(repoDir, ['hash-object', '--', path.resolve(opts.matrix)]).toString('utf8').trim();
    if (actual !== matrixEntry.oid) {
      report.err('FORMAIN_MATRIX_DRIFT', '工作树 fidelity-matrix.md 与 H tree object 内容不一致');
    }
  }
  // fidelity 证据闭包:H 中 evidence 目录路径集合 === matrix 引用闭包(证据+sidecar)
  const relEvidenceRoot = path.relative(repoDir, path.resolve(opts.evidenceRoot)).split(path.sep).join('/');
  if (relEvidenceRoot !== CANON_EVIDENCE_DIR) {
    report.err('FORMAIN_EVIDENCE_PATH', `--for-main 下 evidence 根必须为 ${CANON_EVIDENCE_DIR},实际 ${relEvidenceRoot}`);
  }
  const referenced = new Set();
  for (const [rel] of evidenceIndex) {
    referenced.add(`${CANON_EVIDENCE_DIR}/${rel}`);
    referenced.add(`${CANON_EVIDENCE_DIR}/${rel}.meta.json`);
  }
  const inTreeEvidence = [...treeH.keys()].filter((p) => p.startsWith(`${CANON_EVIDENCE_DIR}/`));
  for (const p of inTreeEvidence) {
    if (!referenced.has(p)) report.err('FORMAIN_EVIDENCE_UNREFERENCED', `evidence 目录含未被矩阵引用的文件: ${p}`);
    const e = requireRegular(p, true);
    if (e) {
      const actual = git(repoDir, ['hash-object', '--', path.join(repoDir, p)]).toString('utf8').trim();
      if (actual !== e.oid) report.err('FORMAIN_EVIDENCE_DRIFT', `工作树证据与 H object 不一致: ${p}`);
    }
  }
  for (const p of referenced) {
    if (!treeH.has(p)) report.err('FORMAIN_EVIDENCE_MISSING', `矩阵引用闭包内文件不在 H: ${p}`);
  }
  // sidecar testedCodeCommit 绑定:--for-main 拒旧证据(v6.16)
  for (const [rel, info] of evidenceIndex) {
    if (info.meta && info.meta.testedCodeCommit !== C) {
      report.err('FORMAIN_SIDECAR_COMMIT', `sidecar testedCodeCommit ≠ C(拒旧证据): ${rel} → ${info.meta.testedCodeCommit}`);
    }
  }
  // e2e report/evidence 闭包:report 存在则解析其引用;不存在则 e2e/evidence 必须为空
  const reportEntry = treeH.get(CANON_E2E_REPORT);
  const e2eEvidencePaths = [...treeH.keys()].filter((p) => p.startsWith(`${CANON_E2E_EVIDENCE_DIR}/`));
  if (reportEntry) {
    requireRegular(CANON_E2E_REPORT, true);
    let reportRefs = new Set();
    try {
      const raw = git(repoDir, ['show', `${H}:${CANON_E2E_REPORT}`]).toString('utf8');
      const collect = (v) => {
        if (typeof v === 'string' && v.startsWith(`${CANON_E2E_EVIDENCE_DIR}/`)) reportRefs.add(v);
        else if (Array.isArray(v)) v.forEach(collect);
        else if (v && typeof v === 'object') Object.values(v).forEach(collect);
      };
      collect(JSON.parse(raw));
    } catch (e) {
      report.err('FORMAIN_E2E_REPORT', `e2e report 读取/解析失败: ${e.message}`);
      reportRefs = null;
    }
    if (reportRefs) {
      for (const p of e2eEvidencePaths) {
        if (!reportRefs.has(p)) report.err('FORMAIN_E2E_UNREFERENCED', `e2e/evidence 含未被 report 引用的文件: ${p}`);
        requireRegular(p, true);
      }
      for (const p of reportRefs) {
        if (!treeH.has(p)) report.err('FORMAIN_E2E_MISSING', `report 引用的 e2e 证据不在 H: ${p}`);
      }
    }
  } else if (e2eEvidencePaths.length) {
    report.err('FORMAIN_E2E_UNREFERENCED', `无 e2e report 但 H 存在 e2e/evidence 文件: ${e2eEvidencePaths.join(', ')}`);
  }
}

// ---- 模式编排 ----
function runValidation(opts) {
  const report = new Report();
  let manifest = null;
  let catalog = null;
  try {
    manifest = readJson(opts.manifest);
  } catch (e) {
    report.err('MANIFEST_READ', `manifest 读取失败 ${opts.manifest}: ${e.message}`);
  }
  try {
    catalog = readJson(opts.catalog);
  } catch (e) {
    report.err('CATALOG_READ', `catalog 读取失败 ${opts.catalog}: ${e.message}`);
  }
  let manifestById = new Map();
  if (manifest && catalog) {
    manifestById = checkManifestSchema(manifest, catalog, report) ?? new Map();
    checkCatalogReconciliation(manifest, catalog, report);
    checkHardInvariants(manifest, report);
  }
  const matrixData = fs.existsSync(opts.matrix) ? parseMatrixMd(opts.matrix, report) : (report.err('MATRIX_READ', `矩阵文件不存在: ${opts.matrix}`), null);
  let evidenceIndex = new Map();
  if (matrixData && manifest) {
    ({ evidenceIndex } = checkCells(matrixData, manifestById, manifest, opts.evidenceRoot, report));
  }

  let result = null;
  if (opts.slice) {
    const rows = (manifest?.rows ?? []).filter((r) => r.slice === opts.slice);
    if (rows.length === 0) report.err('SLICE_EMPTY', `slice=${opts.slice} 在 manifest 中没有任何行`);
    if (matrixData) checkCompleteness(rows, matrixData.cells, report, `slice ${opts.slice}`);
    result = report.errors.length === 0 ? 'SLICE_OK' : null;
  } else if (opts.final) {
    let waiverCount = 0;
    if (matrixData && manifest) {
      ({ waiverCount } = checkCompleteness(manifest.rows ?? [], matrixData.cells, report, 'final'));
    }
    if (report.errors.length === 0) {
      if (opts.forMain) {
        if (waiverCount > 0) {
          report.err('FORMAIN_WAIVER', `--for-main 只接受 :VERIFIED,当前存在 ${waiverCount} 个 WAIVER`);
        } else {
          checkForMain(opts, matrixData, evidenceIndex, report);
        }
      }
      if (report.errors.length === 0) {
        result = waiverCount > 0 ? 'FIDELITY_MATRIX_OK:WAIVERS' : 'FIDELITY_MATRIX_OK:VERIFIED';
      }
    }
  } else if (report.errors.length === 0) {
    result = 'BASE_CHECKS_OK';
  }
  return { report, result };
}

function defaultOpts() {
  return {
    matrix: path.join(ACCEPTANCE_DIR, 'fidelity-matrix.md'),
    manifest: path.join(ACCEPTANCE_DIR, 'state-manifest.json'),
    catalog: path.join(ACCEPTANCE_DIR, 'required-state-catalog.json'),
    evidenceRoot: path.join(ACCEPTANCE_DIR, 'evidence'),
    gitDir: undefined,
    forMainCommit: undefined,
    slice: undefined,
    final: false,
    forMain: false,
  };
}

// ---- self-test:跑 scripts/__fixtures__/login-fidelity 下全部场景 ----
function fixtureOpts(over = {}) {
  const base = path.join(FIXTURE_ROOT, 'base');
  return {
    ...defaultOpts(),
    matrix: path.join(base, 'matrix-verified.md'),
    manifest: path.join(base, 'manifest.json'),
    catalog: path.join(base, 'catalog.json'),
    evidenceRoot: path.join(base, 'evidence'),
    ...over,
  };
}
function gitFx(repoDir, args, env = {}) {
  const r = spawnSync('git', ['-C', repoDir, ...args], {
    encoding: 'utf8',
    env: { ...process.env, GIT_AUTHOR_NAME: 'fixture', GIT_AUTHOR_EMAIL: 'fixture@example.com', GIT_COMMITTER_NAME: 'fixture', GIT_COMMITTER_EMAIL: 'fixture@example.com', ...env },
  });
  if (r.status !== 0) throw new Error(`fixture git ${args.join(' ')} 失败: ${r.stderr}`);
  return r.stdout.trim();
}
/**
 * 构造 --for-main 临时 git 仓(os.tmpdir 下 git init + C/H 两 commit,负例⑫git 专项)。
 * C = catalog + manifest + 若干 allowlist 外源文件;H = C + 矩阵/证据 artifact(+variant 注入的篡改)。
 */
function buildForMainRepo(variant) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fidelity-formain-'));
  const acc = path.join(dir, 'docs', 'login-redesign', 'acceptance');
  fs.mkdirSync(acc, { recursive: true });
  fs.mkdirSync(path.join(dir, 'tools'), { recursive: true });
  fs.mkdirSync(path.join(dir, 'assets'), { recursive: true });
  gitFx(dir, ['init', '-q']);
  // C:源码+契约树(catalog/manifest 均在 allowlist 外)
  const base = path.join(FIXTURE_ROOT, 'base');
  fs.copyFileSync(path.join(base, 'catalog.json'), path.join(acc, 'required-state-catalog.json'));
  fs.copyFileSync(path.join(base, 'manifest.json'), path.join(acc, 'state-manifest.json'));
  fs.writeFileSync(path.join(dir, 'tools', 'dummy.sh'), '#!/bin/sh\necho fixture\n');
  fs.writeFileSync(path.join(dir, 'assets', 'note.txt'), 'linktarget');
  gitFx(dir, ['add', '-A']);
  gitFx(dir, ['commit', '-q', '-m', 'C: frozen source+contract tree']);
  const C = gitFx(dir, ['rev-parse', 'HEAD']);

  // H:artifact-only(矩阵+证据;sidecar 的 testedCodeCommit 重写为 C)
  const evidenceSrc = path.join(base, 'evidence');
  const evidenceDst = path.join(acc, 'evidence');
  fs.mkdirSync(evidenceDst, { recursive: true });
  for (const f of fs.readdirSync(evidenceSrc)) {
    if (f.endsWith('.meta.json')) {
      const meta = readJson(path.join(evidenceSrc, f));
      meta.testedCodeCommit = C;
      fs.writeFileSync(path.join(evidenceDst, f), JSON.stringify(meta, null, 2));
    } else {
      fs.copyFileSync(path.join(evidenceSrc, f), path.join(evidenceDst, f));
    }
  }
  // 矩阵:在 verified 基础上注入 forMain.testedCodeCommit=C
  const matrixText = fs.readFileSync(path.join(base, 'matrix-verified.md'), 'utf8');
  const m = matrixText.match(/^```json[ \t]*\r?\n([\s\S]*?)^```[ \t]*$/m);
  const data = JSON.parse(m[1]);
  data.forMain = { testedCodeCommit: C };
  const newMatrix = matrixText.replace(m[0], '```json\n' + JSON.stringify(data, null, 2) + '\n```');
  const matrixDst = path.join(acc, 'fidelity-matrix.md');
  fs.writeFileSync(matrixDst, newMatrix);

  // variant 注入(负例⑫ git 专项 a-d)
  if (variant === 'a') {
    // C..H 改 allowlist 外的 required-state-catalog.json(rows 不动,仅加顶层字段,保证其余校验仍过)
    const cat = readJson(path.join(acc, 'required-state-catalog.json'));
    cat.tampered = true;
    fs.writeFileSync(path.join(acc, 'required-state-catalog.json'), JSON.stringify(cat, null, 2));
  } else if (variant === 'b') {
    // allowlist 外文件 mode 100644→100755(同 blob)
    fs.chmodSync(path.join(dir, 'tools', 'dummy.sh'), 0o755);
    gitFx(dir, ['update-index', '--chmod=+x', 'tools/dummy.sh']);
  } else if (variant === 'c') {
    // allowlist 外普通文件改 symlink 且复用同一 blob OID(目标串=原内容)
    fs.rmSync(path.join(dir, 'assets', 'note.txt'));
    fs.symlinkSync('linktarget', path.join(dir, 'assets', 'note.txt'));
  } else if (variant === 'd-symlink') {
    // allowlist 内 artifact(矩阵)为 symlink
    const real = path.join(dir, 'matrix-real.md');
    fs.renameSync(matrixDst, real);
    fs.symlinkSync(real, matrixDst);
  } else if (variant === 'd-unreferenced') {
    // evidence 目录含未被引用文件
    fs.writeFileSync(path.join(evidenceDst, 'stray-unreferenced.txt'), 'stray');
  }
  gitFx(dir, ['add', '-A']);
  gitFx(dir, ['commit', '-q', '-m', 'H: acceptance artifacts']);
  return {
    dir,
    C,
    opts: fixtureOpts({
      matrix: matrixDst,
      manifest: path.join(acc, 'state-manifest.json'),
      catalog: path.join(acc, 'required-state-catalog.json'),
      evidenceRoot: evidenceDst,
      gitDir: dir,
      final: true,
      forMain: true,
    }),
  };
}

function selfTest() {
  const base = path.join(FIXTURE_ROOT, 'base');
  if (!fs.existsSync(base)) {
    console.error(`fixture 目录缺失: ${base}(先运行 scripts/__fixtures__/login-fidelity/generate-fixtures.mjs)`);
    process.exit(1);
  }
  const cases = [];
  const neg = (name, opts, expectCode) => cases.push({ name, opts, expectOk: false, expectCode });
  const pos = (name, opts, expectResult) => cases.push({ name, opts, expectOk: true, expectResult });
  const fx = (p) => path.join(FIXTURE_ROOT, p);

  // 正例
  pos('正例:schema+catalog+cell 基础校验(verified 矩阵)', fixtureOpts(), 'BASE_CHECKS_OK');
  pos('正例:--slice pr1 全绿', fixtureOpts({ slice: 'pr1' }), 'SLICE_OK');
  pos('正例:--slice pr4a 全绿(四 rowKind 覆盖)', fixtureOpts({ slice: 'pr4a' }), 'SLICE_OK');
  pos('正例:--final VERIFIED(纯 PASS+合法 N/A)', fixtureOpts({ final: true }), 'FIDELITY_MATRIX_OK:VERIFIED');
  pos('正例:--final WAIVERS(含批准 WAIVER)', fixtureOpts({ final: true, matrix: fx('base/matrix-waivers.md') }), 'FIDELITY_MATRIX_OK:WAIVERS');

  // 负例①~⑬(附录 B 编号对齐)
  neg('负例①:naAllowed 塞本应适用格(与 catalog 不等)', fixtureOpts({ manifest: fx('neg-01-naallowed/manifest.json') }), 'CATALOG_FIELD_MISMATCH');
  neg('负例②:locales 漏 zh-TW', fixtureOpts({ manifest: fx('neg-02-locales/manifest.json') }), 'INVARIANT_LOCALES');
  neg('负例③:all-mobile 漏 ipad', fixtureOpts({ manifest: fx('neg-03-ipad/manifest.json') }), 'INVARIANT_DEVICES');
  neg('负例④:all-mobile 漏 android-pad', fixtureOpts({ manifest: fx('neg-04-android-pad/manifest.json') }), 'INVARIANT_DEVICES');
  neg('负例⑤:regions 漏 global', fixtureOpts({ manifest: fx('neg-05-regions/manifest.json') }), 'INVARIANT_REGIONS');
  neg('负例⑥:phone-only 缺 pad-only 配对', fixtureOpts({ catalog: fx('neg-06-pairing/catalog.json'), manifest: fx('neg-06-pairing/manifest.json') }), 'PAIR_PHONE_PAD_MISSING');
  neg('负例⑦a:wave4 基准行 source 错挂 demo', fixtureOpts({ manifest: fx('neg-07a-source/manifest.json') }), 'CATALOG_FIELD_MISMATCH');
  neg('负例⑦b:source 对但 ref 错', fixtureOpts({ manifest: fx('neg-07b-ref/manifest.json') }), 'CATALOG_FIELD_MISMATCH');
  neg('负例⑦c:baselineRequirements length>1', fixtureOpts({ manifest: fx('neg-07c-baseline-len/manifest.json') }), 'SCHEMA_BASELINE_LEN');
  neg('负例⑦d:拆行完整性(几何行缺、资产行在)', fixtureOpts({ manifest: fx('neg-07d-split-row/manifest.json') }), 'PAIR_ASSET_GEOMETRY_MISSING');
  neg('负例⑧:rowKind 别名 "phone"', fixtureOpts({ manifest: fx('neg-08-rowkind/manifest.json') }), 'SCHEMA_ROWKIND');
  neg('负例⑨:删除整 stateFamily(集合不等)', fixtureOpts({ manifest: fx('neg-09-rowset/manifest.json') }), 'ROWSET_MISMATCH');
  neg('负例⑩:行缺 baselineRequirements', fixtureOpts({ manifest: fx('neg-10-baseline-missing/manifest.json') }), 'SCHEMA_BASELINE_MISSING');
  neg('负例⑪:未声明复用组的重复 SHA', fixtureOpts({ matrix: fx('neg-11-dup-sha/matrix.md'), evidenceRoot: fx('neg-11-dup-sha/evidence') }), 'DUPLICATE_SHA');
  neg('负例⑪b:复用组 dimension 非 locale', fixtureOpts({ manifest: fx('neg-11b-group-dimension/manifest.json') }), 'SCHEMA_REUSE_DIMENSION');
  neg('负例⑫i:PASS 格缺 sidecar', fixtureOpts({ matrix: fx('neg-12i-missing-sidecar/matrix.md'), evidenceRoot: fx('neg-12i-missing-sidecar/evidence') }), 'SIDECAR_MISSING');
  neg('负例⑫ii:引用格 ∉ applicableCellRefs', fixtureOpts({ matrix: fx('neg-12ii-cell-not-applicable/matrix.md'), evidenceRoot: fx('neg-12ii-cell-not-applicable/evidence') }), 'SIDECAR_CELL_NOT_APPLICABLE');
  neg('负例⑫iii:复用组集合与 applicableCellRefs 不等', fixtureOpts({ matrix: fx('neg-12iii-group-set/matrix.md'), evidenceRoot: fx('neg-12iii-group-set/evidence') }), 'SIDECAR_GROUP_SET_MISMATCH');
  neg('负例⑫iv:applicableCellRefs 含重复 CellRef', fixtureOpts({ matrix: fx('neg-12iv-dup-cellref/matrix.md'), evidenceRoot: fx('neg-12iv-dup-cellref/evidence') }), 'SIDECAR_DUP_CELLREF');
  neg('负例⑫v:非复用态带未声明 reuseGroupId', fixtureOpts({ matrix: fx('neg-12v-bogus-group/matrix.md'), evidenceRoot: fx('neg-12v-bogus-group/evidence') }), 'SIDECAR_GROUP_NOT_FOUND');
  neg('负例⑬:rowId 集合等但 ground-truth 被篡改(wave4 行改挂 demo)', fixtureOpts({ manifest: fx('neg-13-tampered/manifest.json') }), 'CATALOG_FIELD_MISMATCH');
  // 终态负例(计划§框架第 2 条 fixture 四例中的两败例)
  neg('终态负例:含 GAP → final 必败', fixtureOpts({ final: true, matrix: fx('base/matrix-gap.md') }), 'GAP_PRESENT');
  neg('终态负例:manifest 外 N/A → final 必败', fixtureOpts({ final: true, matrix: fx('base/matrix-illegal-na.md') }), 'NA_NOT_ALLOWED');
  // slice 负例 + preview 恒 exit 0
  neg('slice 负例:--slice pr1 对 GAP 矩阵失败', fixtureOpts({ slice: 'pr1', matrix: fx('base/matrix-gap.md') }), 'GAP_PRESENT');

  let passCnt = 0;
  let negCnt = 0;
  const failures = [];
  for (const c of cases) {
    const { report, result } = runValidation(c.opts);
    const ok = report.errors.length === 0;
    if (c.expectOk) {
      if (!ok || (c.expectResult && result !== c.expectResult)) {
        failures.push(`${c.name}: 预期通过(${c.expectResult}),实际 errors=${JSON.stringify(report.errors.slice(0, 3))} result=${result}`);
      } else passCnt += 1;
    } else if (ok) {
      failures.push(`${c.name}: 预期失败(${c.expectCode}),实际通过`);
    } else if (c.expectCode && !report.hasCode(c.expectCode)) {
      failures.push(`${c.name}: 预期错误码 ${c.expectCode},实际 ${JSON.stringify([...new Set(report.errors.map((e) => e.code))])}`);
    } else negCnt += 1;
  }

  // preview 语义:同 GAP 矩阵下 --preview-slice 违规仅警告、恒 exit 0
  {
    const { report } = runValidation(fixtureOpts({ slice: 'pr1', matrix: path.join(base, 'matrix-gap.md') }));
    if (report.errors.length === 0) failures.push('preview 前置: GAP 矩阵 slice 应产生违规');
    else passCnt += 1; // preview 模式对同一 report 仅告警,由 main() 恒 exit 0,这里验证违规可检出
  }

  // --for-main 临时 git 仓专项(正例 + 负例⑫ git a-d)
  const gitCases = [
    { v: 'ok', name: '正例:--for-main C/H tuple 相等+闭包精确', expectOk: true, expectResult: 'FIDELITY_MATRIX_OK:VERIFIED' },
    { v: 'a', name: '负例⑫git-a:C..H 改 allowlist 外 catalog', expectOk: false, expectCode: 'FORMAIN_TUPLE_MISMATCH' },
    { v: 'b', name: '负例⑫git-b:allowlist 外 mode 100644→100755', expectOk: false, expectCode: 'FORMAIN_TUPLE_MISMATCH' },
    { v: 'c', name: '负例⑫git-c:普通文件改 symlink 复用同 blob OID', expectOk: false, expectCode: 'FORMAIN_TUPLE_MISMATCH' },
    { v: 'd-symlink', name: '负例⑫git-d1:allowlist 内 artifact 为 symlink', expectOk: false, expectCode: 'FORMAIN_ARTIFACT_NOT_REGULAR' },
    { v: 'd-unreferenced', name: '负例⑫git-d2:evidence 目录含未被引用文件', expectOk: false, expectCode: 'FORMAIN_EVIDENCE_UNREFERENCED' },
  ];
  for (const gc of gitCases) {
    let repo;
    try {
      repo = buildForMainRepo(gc.v === 'ok' ? undefined : gc.v);
      const { report, result } = runValidation(repo.opts);
      const ok = report.errors.length === 0;
      if (gc.expectOk) {
        if (!ok || result !== gc.expectResult) failures.push(`${gc.name}: 预期 ${gc.expectResult},实际 errors=${JSON.stringify(report.errors.slice(0, 3))}`);
        else passCnt += 1;
      } else if (ok) failures.push(`${gc.name}: 预期失败(${gc.expectCode}),实际通过`);
      else if (!report.hasCode(gc.expectCode)) failures.push(`${gc.name}: 预期错误码 ${gc.expectCode},实际 ${JSON.stringify([...new Set(report.errors.map((e) => e.code))])}`);
      else negCnt += 1;
    } finally {
      if (repo?.dir) fs.rmSync(repo.dir, { recursive: true, force: true });
    }
  }

  if (failures.length) {
    console.error('FIDELITY_SELF_TEST_FAILED');
    failures.forEach((f) => console.error('  - ' + f));
    process.exit(1);
  }
  console.log(`FIDELITY_SELF_TEST_OK negative=${negCnt} positive=${passCnt}`);
}

// ---- CLI ----
function parseArgs(argv) {
  const opts = { ...defaultOpts(), selfTest: false, previewSlice: undefined };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    const next = () => argv[++i];
    if (a === '--slice') opts.slice = next();
    else if (a === '--preview-slice') opts.previewSlice = next();
    else if (a === '--final') opts.final = true;
    else if (a === '--for-main') opts.forMain = true;
    else if (a === '--self-test') opts.selfTest = true;
    else if (a === '--matrix') opts.matrix = path.resolve(next());
    else if (a === '--manifest') opts.manifest = path.resolve(next());
    else if (a === '--catalog') opts.catalog = path.resolve(next());
    else if (a === '--evidence-root') opts.evidenceRoot = path.resolve(next());
    else if (a === '--git-dir') opts.gitDir = path.resolve(next());
    else if (a === '--for-main-commit') opts.forMainCommit = next();
    else {
      console.error(`未知参数: ${a}`);
      process.exit(2);
    }
  }
  return opts;
}

function main() {
  const opts = parseArgs(process.argv.slice(2));
  if (opts.selfTest) {
    selfTest();
    return;
  }
  if (opts.forMain && !opts.final) {
    console.error('--for-main 必须与 --final 联用');
    process.exit(2);
  }
  if (opts.previewSlice) {
    // 预览模式:同 slice 逻辑但违规只警告,恒 exit 0
    const { report } = runValidation({ ...opts, slice: opts.previewSlice });
    for (const e of report.errors) console.warn(`[preview][${e.code}] ${e.msg}`);
    console.log('SLICE_PREVIEW');
    process.exit(0);
  }
  const { report, result } = runValidation(opts);
  if (report.errors.length) {
    for (const e of report.errors) console.error(`[${e.code}] ${e.msg}`);
    console.error(`共 ${report.errors.length} 条违规`);
    process.exit(1);
  }
  console.log(result ?? 'BASE_CHECKS_OK');
}

main();
