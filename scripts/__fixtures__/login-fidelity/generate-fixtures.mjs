#!/usr/bin/env node
/**
 * generate-fixtures.mjs — 登录换肤验收矩阵 checker 的 fixture 生成器(一次性运行,产物入仓)。
 *
 * 合约来源:implementation-plan.md 附录 B(负 fixture ①~⑬ + 自洽例要求:覆盖全部四种
 * 合法 rowKind、≥2 locale 格共享同一 evidenceSha256 的真实复用组(真实小 png 字节)、
 * 合法 N/A(region-exclusive)与批准 WAIVER 例、终态四例)+ §百分百还原验收框架。
 *
 * 运行(仓库根): node scripts/__fixtures__/login-fidelity/generate-fixtures.mjs
 * 产物为确定性输出(固定时间戳/固定内容),重跑不产生 diff。
 * --for-main git 专项四例(⑫a-d)不在此生成——由 check-fidelity-matrix.mjs --self-test
 * 于 os.tmpdir 下临时 git 仓构造(计划负 fixture ⑫专项要求)。
 */
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { fileURLToPath } from 'node:url';

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const LOCALES = ['zh-CN', 'zh-TW', 'en', 'ja', 'ko'];
const REGIONS = ['cn', 'global'];
const DEVICES_BY_ROWKIND = {
  desktop: ['mac', 'windows'],
  'all-mobile': ['iphone', 'android-phone', 'ipad', 'android-pad'],
  'phone-only': ['iphone', 'android-phone'],
  'pad-only': ['ipad', 'android-pad'],
};
const FIXTURE_COMMIT = 'f'.repeat(40); // 非 --for-main 模式下 sidecar 占位 commit
const CAPTURED_AT = '2026-07-20T00:00:00.000Z';

// ---- 最小合法 PNG(1×1 RGBA,颜色可变以产生不同 SHA) ----
function crc32(buf) {
  let c = ~0;
  for (const b of buf) {
    c ^= b;
    for (let i = 0; i < 8; i += 1) c = (c >>> 1) ^ (0xedb88320 & -(c & 1));
  }
  return ~c >>> 0;
}
function pngChunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([len, body, crc]);
}
function makePng(r, g, b) {
  const sig = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(1, 0); // width
  ihdr.writeUInt32BE(1, 4); // height
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // color type RGBA
  const raw = Buffer.from([0, r, g, b, 255]); // filter byte + RGBA
  const idat = zlib.deflateSync(raw, { level: 9 });
  return Buffer.concat([sig, pngChunk('IHDR', ihdr), pngChunk('IDAT', idat), pngChunk('IEND', Buffer.alloc(0))]);
}

// ---- fixture catalog(6 行,覆盖四种合法 rowKind + wave4 基准行 + asset/geometry 拆行 + naAllowed 行) ----
function makeRow(rowId, platform, rowKind, stateFamily, dimension, source, ref, naAllowed = []) {
  return {
    rowId,
    platform,
    rowKind,
    stateFamily,
    dimension,
    source,
    ref,
    applicability: {
      devices: [...DEVICES_BY_ROWKIND[rowKind]],
      locales: [...LOCALES],
      regions: [...REGIONS],
    },
    naAllowed,
  };
}
const catalogRows = [
  makeRow('desktop.brand-background.style', 'desktop', 'desktop', 'brand-background', 'style', 'wave4', '368:1375'),
  makeRow('mobile.wordmark.asset', 'mobile', 'all-mobile', 'wordmark', 'asset', 'wave4', '368:1381'),
  makeRow('mobile.wordmark.geometry', 'mobile', 'all-mobile', 'wordmark', 'geometry', 'demo', 'mobile-wordmark-frame'),
  makeRow('mobile.orientation-layout.phone-fallback-geometry', 'mobile', 'phone-only', 'orientation-layout', 'geometry', 'demo', 'phone-fallback'),
  makeRow('mobile.orientation-layout.pad-landscape-geometry', 'mobile', 'pad-only', 'orientation-layout', 'geometry', 'demo', 'pad-landscape'),
  makeRow('desktop.legacy-migration.confirm-state', 'desktop', 'desktop', 'legacy-migration', 'state', 'demo', 'migration-confirm', [
    { match: { region: ['global'] }, reasonCode: 'region-exclusive' },
  ]),
];
const catalog = {
  version: 1,
  title: 'fixture catalog(仅供 checker self-test,非正式锚点)',
  rows: catalogRows,
};

const SLICE_BY_ROW = {
  'desktop.brand-background.style': 'pr1',
  'desktop.legacy-migration.confirm-state': 'pr1',
  'mobile.wordmark.asset': 'pr4a',
  'mobile.wordmark.geometry': 'pr4a',
  'mobile.orientation-layout.phone-fallback-geometry': 'pr4a',
  'mobile.orientation-layout.pad-landscape-geometry': 'pr4a',
};
function toManifestRow(cr) {
  return {
    ...structuredClone(cr),
    slice: SLICE_BY_ROW[cr.rowId],
    baselineRequirements: [{ dimension: cr.dimension, source: cr.source, ref: cr.ref }],
    tests: [],
  };
}

// ---- 证据/复用组/矩阵格生成 ----
// 每行 × device × region 一个 locale 复用组:1 份证据文件被 5 语格共享(真实复用组)。
// row6(legacy-migration)的 global 列为合法 N/A(region-exclusive),仅 cn 列建组。
const shortName = {
  'desktop.brand-background.style': 'bb',
  'mobile.wordmark.asset': 'wm-asset',
  'mobile.wordmark.geometry': 'wm-geo',
  'mobile.orientation-layout.phone-fallback-geometry': 'orient-phone',
  'mobile.orientation-layout.pad-landscape-geometry': 'orient-pad',
  'desktop.legacy-migration.confirm-state': 'migration',
};
function buildBase() {
  const groups = [];
  const evidenceFiles = new Map(); // rel → Buffer
  const sidecars = new Map(); // rel(.meta.json) → object
  const cells = {};
  let pngSeq = 0;

  for (const row of catalogRows) {
    const regionsWithEvidence = row.rowId === 'desktop.legacy-migration.confirm-state' ? ['cn'] : REGIONS;
    for (const device of DEVICES_BY_ROWKIND[row.rowKind]) {
      for (const region of REGIONS) {
        if (!regionsWithEvidence.includes(region)) {
          // 合法 N/A 格(region-exclusive)
          for (const locale of LOCALES) {
            cells[`${row.rowId}|${device}|${locale}|${region}`] = {
              value: 'N/A',
              reasonCode: 'region-exclusive',
              detail: '迁移弹窗 cn-only(fixture)',
            };
          }
          continue;
        }
        const groupId = `g-${shortName[row.rowId]}-${device}-${region}`;
        const isPng = row.rowId === 'desktop.brand-background.style';
        const rel = `${shortName[row.rowId]}-${device}-${region}.${isPng ? 'png' : 'txt'}`;
        const content = isPng
          ? makePng(200, 30 + pngSeq * 17, (pngSeq += 1) * 41)
          : Buffer.from(`fixture-evidence ${row.rowId} ${device} ${region}\n`, 'utf8');
        evidenceFiles.set(rel, content);
        const refs = LOCALES.map((locale) => ({ rowId: row.rowId, device, locale, region }));
        groups.push({
          groupId,
          cells: refs,
          dimension: 'locale',
          rationale: '纯图形行,语言不参与渲染(fixture)',
        });
        sidecars.set(`${rel}.meta.json`, {
          evidenceSha256: null, // 由写盘阶段按内容实算
          testedCodeCommit: FIXTURE_COMMIT,
          capturedCellRef: refs[0],
          reuseGroupId: groupId,
          applicableCellRefs: refs,
          scenario: 'fixture 采集(self-test)',
          capturedAt: CAPTURED_AT,
          __contentRel: rel,
        });
        for (const locale of LOCALES) {
          cells[`${row.rowId}|${device}|${locale}|${region}`] = {
            value: 'PASS',
            evidence: rel,
            baseline: { source: row.source, ref: row.ref },
            reviewer: 'fixture-reviewer',
            approvedAt: CAPTURED_AT,
          };
        }
      }
    }
  }
  const manifest = {
    version: 1,
    rows: catalogRows.map(toManifestRow),
    evidenceReuseGroups: groups,
  };
  return { manifest, evidenceFiles, sidecars, cells };
}

// ---- 写盘工具 ----
function writeJson(file, obj) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(obj, null, 2) + '\n');
}
function writeMatrixMd(file, cells, title) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const body = ['# ' + title, '', '> fixture 矩阵(仅供 checker self-test)。唯一 ```json 机读块如下。', '', '```json', JSON.stringify({ cells }, null, 2), '```', ''].join('\n');
  fs.writeFileSync(file, body);
}
function cryptoSha(buf) {
  return crypto.createHash('sha256').update(buf).digest('hex');
}
function writeEvidenceDir(dir, evidenceFiles, sidecars) {
  fs.mkdirSync(dir, { recursive: true });
  for (const [rel, buf] of evidenceFiles) fs.writeFileSync(path.join(dir, rel), buf);
  for (const [rel, meta] of sidecars) {
    const { __contentRel, ...rest } = meta;
    rest.evidenceSha256 = cryptoSha(evidenceFiles.get(__contentRel));
    writeJson(path.join(dir, rel), rest);
  }
}
function mutateManifest(manifest, fn) {
  const m = structuredClone(manifest);
  fn(m);
  return m;
}
function dropRows(manifest, rowIds) {
  return mutateManifest(manifest, (m) => {
    m.rows = m.rows.filter((r) => !rowIds.includes(r.rowId));
    m.evidenceReuseGroups = m.evidenceReuseGroups.filter((g) => !rowIds.includes(g.cells[0].rowId));
  });
}
const rowOf = (m, id) => m.rows.find((r) => r.rowId === id);

// ---- 主流程 ----
function main() {
  const { manifest, evidenceFiles, sidecars, cells } = buildBase();
  const base = path.join(ROOT, 'base');
  fs.rmSync(base, { recursive: true, force: true });
  writeJson(path.join(base, 'catalog.json'), catalog);
  writeJson(path.join(base, 'manifest.json'), manifest);
  writeEvidenceDir(path.join(base, 'evidence'), evidenceFiles, sidecars);

  // 终态四例(计划§框架第 2 条)
  writeMatrixMd(path.join(base, 'matrix-verified.md'), cells, 'fixture 矩阵 · 纯 PASS + 合法 N/A → :VERIFIED');
  {
    const c = structuredClone(cells);
    for (const locale of LOCALES) {
      c[`mobile.orientation-layout.pad-landscape-geometry|ipad|${locale}|cn`] = {
        value: 'WAIVER',
        approvedBy: 'U-4 裁决(fixture)',
        approvedAt: CAPTURED_AT,
        retestVia: 'Lizi QA 实测',
        deadline: '合入 main 前',
      };
    }
    writeMatrixMd(path.join(base, 'matrix-waivers.md'), c, 'fixture 矩阵 · 含批准 WAIVER → :WAIVERS');
  }
  {
    const c = structuredClone(cells);
    c['desktop.brand-background.style|mac|zh-CN|cn'] = { value: 'GAP', decidedBy: 'fixture', decidedAt: CAPTURED_AT, conclusion: '待裁决' };
    writeMatrixMd(path.join(base, 'matrix-gap.md'), c, 'fixture 矩阵 · 含 GAP → final 必败');
  }
  {
    const c = structuredClone(cells);
    c['desktop.brand-background.style|windows|en|global'] = { value: 'N/A', reasonCode: 'region-exclusive', detail: '越权 N/A(fixture)' };
    writeMatrixMd(path.join(base, 'matrix-illegal-na.md'), c, 'fixture 矩阵 · manifest 外 N/A → final 必败');
  }

  // ---- 负例 manifest 变体(①~⑩/⑪b/⑬) ----
  const neg = (name, m) => writeJson(path.join(ROOT, name, 'manifest.json'), m);
  neg('neg-01-naallowed', mutateManifest(manifest, (m) => {
    rowOf(m, 'desktop.legacy-migration.confirm-state').naAllowed = [
      { match: { region: ['cn', 'global'] }, reasonCode: 'region-exclusive' },
    ];
  }));
  neg('neg-02-locales', mutateManifest(manifest, (m) => {
    rowOf(m, 'desktop.brand-background.style').applicability.locales = ['zh-CN', 'en', 'ja', 'ko'];
  }));
  neg('neg-03-ipad', mutateManifest(manifest, (m) => {
    rowOf(m, 'mobile.wordmark.asset').applicability.devices = ['iphone', 'android-phone', 'android-pad'];
  }));
  neg('neg-04-android-pad', mutateManifest(manifest, (m) => {
    rowOf(m, 'mobile.wordmark.asset').applicability.devices = ['iphone', 'android-phone', 'ipad'];
  }));
  neg('neg-05-regions', mutateManifest(manifest, (m) => {
    rowOf(m, 'desktop.brand-background.style').applicability.regions = ['cn'];
  }));
  // ⑥ 专用 catalog+manifest:catalog 自身缺 pad-only 配对行 → manifest 集合相等仍须败于机械配对
  {
    const cat6 = structuredClone(catalog);
    cat6.rows = cat6.rows.filter((r) => r.rowId !== 'mobile.orientation-layout.pad-landscape-geometry');
    writeJson(path.join(ROOT, 'neg-06-pairing', 'catalog.json'), cat6);
    neg('neg-06-pairing', dropRows(manifest, ['mobile.orientation-layout.pad-landscape-geometry']));
  }
  neg('neg-07a-source', mutateManifest(manifest, (m) => {
    const r = rowOf(m, 'desktop.brand-background.style');
    r.source = 'demo';
    r.baselineRequirements[0].source = 'demo';
  }));
  neg('neg-07b-ref', mutateManifest(manifest, (m) => {
    const r = rowOf(m, 'desktop.brand-background.style');
    r.ref = '999:999';
    r.baselineRequirements[0].ref = '999:999';
  }));
  neg('neg-07c-baseline-len', mutateManifest(manifest, (m) => {
    const r = rowOf(m, 'desktop.brand-background.style');
    r.baselineRequirements = [r.baselineRequirements[0], { dimension: 'geometry', source: 'demo', ref: 'extra' }];
  }));
  neg('neg-07d-split-row', dropRows(manifest, ['mobile.wordmark.geometry']));
  neg('neg-08-rowkind', mutateManifest(manifest, (m) => {
    rowOf(m, 'mobile.orientation-layout.phone-fallback-geometry').rowKind = 'phone';
  }));
  neg('neg-09-rowset', dropRows(manifest, ['mobile.orientation-layout.phone-fallback-geometry', 'mobile.orientation-layout.pad-landscape-geometry']));
  neg('neg-10-baseline-missing', mutateManifest(manifest, (m) => {
    delete rowOf(m, 'desktop.brand-background.style').baselineRequirements;
  }));
  neg('neg-11b-group-dimension', mutateManifest(manifest, (m) => {
    m.evidenceReuseGroups[0].dimension = 'device';
  }));
  neg('neg-13-tampered', mutateManifest(manifest, (m) => {
    const r = rowOf(m, 'mobile.wordmark.asset');
    r.source = 'demo';
    r.ref = 'mobile-wordmark-frame';
    r.baselineRequirements[0].source = 'demo';
    r.baselineRequirements[0].ref = 'mobile-wordmark-frame';
  }));

  // ---- 负例矩阵+证据变体(⑪/⑫族;均针对 row1=desktop.brand-background.style) ----
  const passCell = (evidence) => ({
    value: 'PASS',
    evidence,
    baseline: { source: 'wave4', ref: '368:1375' },
    reviewer: 'fixture-reviewer',
    approvedAt: CAPTURED_AT,
  });
  const ref1 = (locale) => ({ rowId: 'desktop.brand-background.style', device: 'mac', locale, region: 'cn' });
  const sidecarOf = (contentBuf, extra) => ({
    evidenceSha256: cryptoSha(contentBuf),
    testedCodeCommit: FIXTURE_COMMIT,
    capturedAt: CAPTURED_AT,
    ...extra,
  });

  // ⑪ 未声明复用组的重复 SHA(两个同内容文件分别挂两格,各自 sidecar 均为非复用态)
  {
    const dir = path.join(ROOT, 'neg-11-dup-sha');
    fs.rmSync(dir, { recursive: true, force: true });
    const buf = Buffer.from('duplicated-bytes fixture\n', 'utf8');
    const ev = path.join(dir, 'evidence');
    fs.mkdirSync(ev, { recursive: true });
    fs.writeFileSync(path.join(ev, 'dup-a.txt'), buf);
    fs.writeFileSync(path.join(ev, 'dup-b.txt'), buf);
    writeJson(path.join(ev, 'dup-a.txt.meta.json'), sidecarOf(buf, { capturedCellRef: ref1('zh-CN'), applicableCellRefs: [ref1('zh-CN')] }));
    writeJson(path.join(ev, 'dup-b.txt.meta.json'), sidecarOf(buf, { capturedCellRef: ref1('zh-TW'), applicableCellRefs: [ref1('zh-TW')] }));
    writeMatrixMd(path.join(dir, 'matrix.md'), {
      'desktop.brand-background.style|mac|zh-CN|cn': passCell('dup-a.txt'),
      'desktop.brand-background.style|mac|zh-TW|cn': passCell('dup-b.txt'),
    }, 'fixture 负例⑪ · 未声明复用组的重复 SHA');
  }
  // ⑫i 缺 sidecar
  {
    const dir = path.join(ROOT, 'neg-12i-missing-sidecar');
    fs.rmSync(dir, { recursive: true, force: true });
    fs.mkdirSync(path.join(dir, 'evidence'), { recursive: true });
    fs.writeFileSync(path.join(dir, 'evidence', 'solo.txt'), 'solo evidence without sidecar\n');
    writeMatrixMd(path.join(dir, 'matrix.md'), { 'desktop.brand-background.style|mac|zh-CN|cn': passCell('solo.txt') }, 'fixture 负例⑫i · PASS 格缺 sidecar');
  }
  // ⑫ii 引用格 ∉ applicableCellRefs
  {
    const dir = path.join(ROOT, 'neg-12ii-cell-not-applicable');
    fs.rmSync(dir, { recursive: true, force: true });
    const buf = Buffer.from('cell-not-applicable fixture\n', 'utf8');
    fs.mkdirSync(path.join(dir, 'evidence'), { recursive: true });
    fs.writeFileSync(path.join(dir, 'evidence', 'solo.txt'), buf);
    writeJson(path.join(dir, 'evidence', 'solo.txt.meta.json'), sidecarOf(buf, { capturedCellRef: ref1('en'), applicableCellRefs: [ref1('en')] }));
    writeMatrixMd(path.join(dir, 'matrix.md'), { 'desktop.brand-background.style|mac|zh-CN|cn': passCell('solo.txt') }, 'fixture 负例⑫ii · 引用格不在 applicableCellRefs');
  }
  // ⑫iii 复用组 cells 集合与 applicableCellRefs 不精确相等(sidecar 少一个 locale)
  {
    const dir = path.join(ROOT, 'neg-12iii-group-set');
    fs.rmSync(dir, { recursive: true, force: true });
    const buf = Buffer.from('group-set-mismatch fixture\n', 'utf8');
    fs.mkdirSync(path.join(dir, 'evidence'), { recursive: true });
    fs.writeFileSync(path.join(dir, 'evidence', 'shared.txt'), buf);
    writeJson(path.join(dir, 'evidence', 'shared.txt.meta.json'), sidecarOf(buf, {
      capturedCellRef: ref1('zh-CN'),
      reuseGroupId: 'g-bb-mac-cn',
      applicableCellRefs: LOCALES.slice(0, 4).map(ref1), // 组是 5 语,这里只 4 → 集合不等
    }));
    const c = {};
    for (const locale of LOCALES) c[`desktop.brand-background.style|mac|${locale}|cn`] = passCell('shared.txt');
    writeMatrixMd(path.join(dir, 'matrix.md'), c, 'fixture 负例⑫iii · 复用组集合不精确相等');
  }
  // ⑫iv applicableCellRefs 含重复 CellRef
  {
    const dir = path.join(ROOT, 'neg-12iv-dup-cellref');
    fs.rmSync(dir, { recursive: true, force: true });
    const buf = Buffer.from('dup-cellref fixture\n', 'utf8');
    fs.mkdirSync(path.join(dir, 'evidence'), { recursive: true });
    fs.writeFileSync(path.join(dir, 'evidence', 'solo.txt'), buf);
    writeJson(path.join(dir, 'evidence', 'solo.txt.meta.json'), sidecarOf(buf, { capturedCellRef: ref1('zh-CN'), applicableCellRefs: [ref1('zh-CN'), ref1('zh-CN')] }));
    writeMatrixMd(path.join(dir, 'matrix.md'), { 'desktop.brand-background.style|mac|zh-CN|cn': passCell('solo.txt') }, 'fixture 负例⑫iv · applicableCellRefs 重复 CellRef');
  }
  // ⑫v 非复用场景带未声明 reuseGroupId
  {
    const dir = path.join(ROOT, 'neg-12v-bogus-group');
    fs.rmSync(dir, { recursive: true, force: true });
    const buf = Buffer.from('bogus-group fixture\n', 'utf8');
    fs.mkdirSync(path.join(dir, 'evidence'), { recursive: true });
    fs.writeFileSync(path.join(dir, 'evidence', 'solo.txt'), buf);
    writeJson(path.join(dir, 'evidence', 'solo.txt.meta.json'), sidecarOf(buf, { capturedCellRef: ref1('zh-CN'), reuseGroupId: 'g-nonexistent', applicableCellRefs: [ref1('zh-CN')] }));
    writeMatrixMd(path.join(dir, 'matrix.md'), { 'desktop.brand-background.style|mac|zh-CN|cn': passCell('solo.txt') }, 'fixture 负例⑫v · reuseGroupId 未命中 manifest');
  }

  console.log('fixtures generated under', ROOT);
}

main();
