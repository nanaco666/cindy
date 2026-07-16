/**
 * feishuBlockManifest.test.ts
 * ---------------------------------------------------------------------------
 * Locks in the contract for extractImagesWithSection: section_hint inference,
 * dedup, ordering, malformed-input tolerance.
 *
 * Block type cheat sheet (Feishu docx):
 *   2=text/paragraph, 3-11=heading1-heading9, 27=image
 */

import { describe, it, expect } from 'vitest';
import {
  extractImagesWithSection,
  extractEmbeddedBlocks,
  extractFoldedSections,
  extractMentionedDocs,
  extractMentionedUserIds,
  extractTodos,
  extractStrikethroughs,
  buildDisplayHints,
  splitBitableToken,
  splitCompositeToken,
  applyCanonicalUrl,
} from '../mcp/blockManifest.js';
import { FEISHU_DOC_LINK_BASE } from '../docLinks.js';

function heading(level: number, text: string, blockId = `h${level}-${text}`) {
  return {
    block_id: blockId,
    block_type: 2 + level, // heading1 → 3
    [`heading${level}`]: {
      elements: [{ text_run: { content: text } }],
    },
  };
}

function image(token: string, blockId = `img-${token}`) {
  return {
    block_id: blockId,
    block_type: 27,
    image: { token },
  };
}

function paragraph(text: string) {
  return {
    block_type: 2,
    text: { elements: [{ text_run: { content: text } }] },
  };
}

describe('extractImagesWithSection', () => {
  it('returns empty array for empty input', () => {
    expect(extractImagesWithSection([])).toEqual([]);
  });

  it('attaches the most recent heading as section_hint', () => {
    const blocks = [
      heading(1, 'Stage 1'),
      image('tokenA'),
      heading(1, 'Stage 2'),
      image('tokenB'),
      image('tokenC'),
      heading(2, 'Substage'),
      image('tokenD'),
    ];
    const out = extractImagesWithSection(blocks);
    expect(out).toEqual([
      { index: 1, file_token: 'tokenA', section_hint: 'Stage 1', block_id: 'img-tokenA' },
      { index: 2, file_token: 'tokenB', section_hint: 'Stage 2', block_id: 'img-tokenB' },
      { index: 3, file_token: 'tokenC', section_hint: 'Stage 2', block_id: 'img-tokenC' },
      { index: 4, file_token: 'tokenD', section_hint: 'Substage', block_id: 'img-tokenD' },
    ]);
  });

  it('uses "(开头)" when no heading precedes the image', () => {
    const blocks = [image('tokenA'), heading(1, 'Stage 1'), image('tokenB')];
    const out = extractImagesWithSection(blocks);
    expect(out[0].section_hint).toBe('(开头)');
    expect(out[1].section_hint).toBe('Stage 1');
  });

  it('dedups repeated file_tokens, keeping first occurrence', () => {
    const blocks = [
      heading(1, 'A'),
      image('shared'),
      heading(1, 'B'),
      image('shared'), // same token, different section — should be skipped
      image('uniq'),
    ];
    const out = extractImagesWithSection(blocks);
    expect(out).toHaveLength(2);
    expect(out[0]).toMatchObject({ file_token: 'shared', section_hint: 'A' });
    expect(out[1]).toMatchObject({ file_token: 'uniq', section_hint: 'B' });
  });

  it('handles all heading levels 1-9', () => {
    const blocks = [
      heading(1, 'H1'), image('t1'),
      heading(2, 'H2'), image('t2'),
      heading(3, 'H3'), image('t3'),
      heading(4, 'H4'), image('t4'),
      heading(5, 'H5'), image('t5'),
      heading(6, 'H6'), image('t6'),
      heading(7, 'H7'), image('t7'),
      heading(8, 'H8'), image('t8'),
      heading(9, 'H9'), image('t9'),
    ];
    const out = extractImagesWithSection(blocks);
    expect(out.map((e) => e.section_hint)).toEqual([
      'H1', 'H2', 'H3', 'H4', 'H5', 'H6', 'H7', 'H8', 'H9',
    ]);
  });

  it('concatenates multi-element heading text', () => {
    const blocks = [
      {
        block_type: 3,
        heading1: {
          elements: [
            { text_run: { content: '第一部分' } },
            { text_run: { content: ' — ' } },
            { text_run: { content: '简介' } },
          ],
        },
      },
      image('t1'),
    ];
    const out = extractImagesWithSection(blocks);
    expect(out[0].section_hint).toBe('第一部分 — 简介');
  });

  it('skips non-text_run heading elements (e.g. mentions) without crashing', () => {
    const blocks = [
      {
        block_type: 3,
        heading1: {
          elements: [
            { text_run: { content: '标题' } },
            { mention_user: { user_id: 'u123' } }, // not text_run, skip
          ],
        },
      },
      image('t1'),
    ];
    const out = extractImagesWithSection(blocks);
    expect(out[0].section_hint).toBe('标题');
  });

  it('ignores paragraph blocks for heading tracking', () => {
    const blocks = [
      heading(1, 'Real Heading'),
      paragraph('some body text'),
      image('t1'),
    ];
    expect(extractImagesWithSection(blocks)[0].section_hint).toBe('Real Heading');
  });

  it('ignores images with missing or empty file_token', () => {
    const blocks = [
      heading(1, 'A'),
      { block_type: 27, image: {} }, // no token
      { block_type: 27, image: { token: '' } }, // empty token
      { block_type: 27 }, // no image field at all
      image('valid'),
    ];
    const out = extractImagesWithSection(blocks);
    expect(out).toHaveLength(1);
    expect(out[0].file_token).toBe('valid');
  });

  it('tolerates malformed block entries (null, primitives, missing fields)', () => {
    const blocks: unknown[] = [
      null,
      undefined,
      'string',
      42,
      heading(1, 'OK'),
      image('t1'),
      {}, // empty object
      { block_type: 99 }, // unknown type
    ];
    const out = extractImagesWithSection(blocks);
    expect(out).toHaveLength(1);
    expect(out[0]).toMatchObject({ file_token: 't1', section_hint: 'OK' });
  });

  it('tolerates heading blocks with missing elements / empty text', () => {
    const blocks = [
      { block_type: 3, heading1: {} },                           // no elements
      { block_type: 3, heading1: { elements: [] } },             // empty elements
      { block_type: 3, heading1: { elements: [{ text_run: { content: '' } }] } }, // empty content
      image('t1'),                                                // should fall back to '(开头)'
    ];
    const out = extractImagesWithSection(blocks);
    expect(out[0].section_hint).toBe('(开头)');
  });

  it('omits block_id when source block has no block_id field', () => {
    const blocks = [
      heading(1, 'A'),
      { block_type: 27, image: { token: 'no-id' } }, // no block_id
    ];
    const out = extractImagesWithSection(blocks);
    expect(out[0].block_id).toBeUndefined();
  });

  it('1-based index reflects post-dedup position', () => {
    const blocks = [
      image('a'),
      image('a'), // dup, skipped
      image('b'),
      image('a'), // dup, skipped
      image('c'),
    ];
    const out = extractImagesWithSection(blocks);
    expect(out.map((e) => e.index)).toEqual([1, 2, 3]);
    expect(out.map((e) => e.file_token)).toEqual(['a', 'b', 'c']);
  });
});

describe('extractEmbeddedBlocks', () => {
  it('returns empty array for empty input', () => {
    expect(extractEmbeddedBlocks([])).toEqual([]);
  });

  it('skips text-flow blocks (text, headings, lists, code, quote, divider, image, table_cell)', () => {
    const blocks = [
      heading(1, 'Section'),
      paragraph('hello'),
      { block_type: 12, bullet: { elements: [] } },
      { block_type: 13, ordered: { elements: [] } },
      { block_type: 14, code: { elements: [] } },
      { block_type: 15, quote: { elements: [] } },
      { block_type: 17, todo: { elements: [] } },
      { block_type: 19, callout: {} },
      { block_type: 22, divider: {} },
      { block_type: 24, grid: {} },
      { block_type: 25, grid_column: {} },
      image('img1'),
      { block_type: 32, table_cell: {} },
    ];
    expect(extractEmbeddedBlocks(blocks)).toEqual([]);
  });

  it('reports embedded table block with section_hint and friendly type_name', () => {
    const blocks = [
      heading(1, '第一节'),
      paragraph('正文'),
      { block_id: 'tbl-1', block_type: 31, table: {} },
    ];
    const out = extractEmbeddedBlocks(blocks);
    expect(out).toEqual([
      {
        index: 1,
        block_id: 'tbl-1',
        block_type: 31,
        type_name: 'table',
        section_hint: '第一节',
      },
    ]);
  });

  it('extracts ref tokens for file / iframe / bitable / sheet blocks', () => {
    const blocks = [
      heading(1, 'Embeds'),
      { block_id: 'f1', block_type: 23, file: { token: 'file-token-1' } },
      { block_id: 'i1', block_type: 26, iframe: { component: { url: 'https://example.com' } } },
      { block_id: 'b1', block_type: 18, bitable: { token: 'bitable-token-1' } },
      { block_id: 's1', block_type: 30, sheet: { token: 'sheet-token-1' } },
    ];
    const out = extractEmbeddedBlocks(blocks);
    expect(out).toHaveLength(4);
    expect(out[0]).toMatchObject({ type_name: 'file', ref: 'file-token-1' });
    expect(out[1]).toMatchObject({ type_name: 'iframe', ref: 'https://example.com' });
    expect(out[2]).toMatchObject({ type_name: 'bitable', ref: 'bitable-token-1' });
    expect(out[3]).toMatchObject({ type_name: 'sheet', ref: 'sheet-token-1' });
  });

  it('extracts file.name as title for free (no API call needed)', () => {
    const blocks = [
      { block_id: 'f1', block_type: 23, file: { token: 'tok-1', name: '员工手册.pdf' } },
      { block_id: 'f2', block_type: 23, file: { token: 'tok-2' } }, // no name → no title
      { block_id: 'f3', block_type: 23, file: { token: 'tok-3', name: '' } }, // empty name → no title
    ];
    const out = extractEmbeddedBlocks(blocks);
    expect(out[0].title).toBe('员工手册.pdf');
    expect(out[1].title).toBeUndefined();
    expect(out[2].title).toBeUndefined();
  });

  it('does not set title for non-file embed types (they need drive.meta lookup)', () => {
    const blocks = [
      { block_type: 30, sheet: { token: 'shtAAA' } },
      { block_type: 18, bitable: { token: 'bascBBB' } },
      { block_type: 43, board: { token: 'wbnCCC' } },
    ];
    const out = extractEmbeddedBlocks(blocks);
    expect(out[0].title).toBeUndefined();
    expect(out[1].title).toBeUndefined();
    expect(out[2].title).toBeUndefined();
  });

  it('extracts whiteboard ref from either board.token or whiteboard.token', () => {
    const blocks = [
      { block_id: 'w1', block_type: 43, board: { token: 'board-token-1' } },
      { block_id: 'w2', block_type: 43, whiteboard: { token: 'board-token-2' } },
      { block_id: 'w3', block_type: 43 }, // no token → no ref
    ];
    const out = extractEmbeddedBlocks(blocks);
    expect(out).toHaveLength(3);
    expect(out[0]).toMatchObject({ type_name: 'board', ref: 'board-token-1' });
    expect(out[1]).toMatchObject({ type_name: 'board', ref: 'board-token-2' });
    expect(out[2].type_name).toBe('board');
    expect(out[2].ref).toBeUndefined();
  });

  it('builds user-clickable url for sheet / bitable / whiteboard, passes iframe through', () => {
    const blocks = [
      { block_type: 30, sheet: { token: 'shtcnAAA' } },
      { block_type: 18, bitable: { token: 'bascnBBB' } },
      { block_type: 43, board: { token: 'wbnCCC' } },
      { block_type: 26, iframe: { component: { url: 'https://embed.example.com/x' } } },
    ];
    const out = extractEmbeddedBlocks(blocks);
    expect(out[0].url).toBe(`${FEISHU_DOC_LINK_BASE}/sheets/shtcnAAA`);
    expect(out[1].url).toBe(`${FEISHU_DOC_LINK_BASE}/base/bascnBBB`);
    expect(out[2].url).toBe(`${FEISHU_DOC_LINK_BASE}/board/wbnCCC`);
    expect(out[3].url).toBe('https://embed.example.com/x');
  });

  it('omits url for types with no standalone public URL (file, in-doc table, unknown)', () => {
    const blocks = [
      { block_type: 23, file: { token: 'file-tok' } }, // file has ref but no public URL
      { block_type: 31, table: {} }, // in-doc table
      { block_type: 20, chat_card: {} }, // chat card (real block_type 20)
      { block_type: 999 }, // unknown type
    ];
    const out = extractEmbeddedBlocks(blocks);
    expect(out[0].ref).toBe('file-tok'); // still has ref
    expect(out[0].url).toBeUndefined(); // but no url
    expect(out[1].url).toBeUndefined();
    expect(out[2].url).toBeUndefined();
    expect(out[3].url).toBeUndefined();
  });

  it('omits url when ref is missing even for url-capable types', () => {
    const blocks = [
      { block_type: 30, sheet: {} },
      { block_type: 18, bitable: {} },
    ];
    const out = extractEmbeddedBlocks(blocks);
    expect(out[0].url).toBeUndefined();
    expect(out[1].url).toBeUndefined();
  });

  it('falls back to iframe.url when component.url is absent', () => {
    const blocks = [
      { block_type: 26, iframe: { url: 'https://fallback.example.com' } },
    ];
    expect(extractEmbeddedBlocks(blocks)[0]).toMatchObject({
      ref: 'https://fallback.example.com',
    });
  });

  it('uses (开头) when no heading precedes the embed', () => {
    const blocks = [{ block_type: 31, table: {} }];
    expect(extractEmbeddedBlocks(blocks)[0].section_hint).toBe('(开头)');
  });

  it('reports unknown block types as block_<n> so new types are not silently dropped', () => {
    // Use a truly unknown number (5000) — 999 maps to 'undefined' per Feishu enum.
    const blocks = [
      heading(1, 'X'),
      { block_id: 'unk-1', block_type: 5000 },
    ];
    const out = extractEmbeddedBlocks(blocks);
    expect(out[0]).toMatchObject({
      block_type: 5000,
      type_name: 'block_5000',
      section_hint: 'X',
    });
  });

  it('omits ref when the embed has no recognizable token / url', () => {
    const blocks = [
      { block_id: 'f-noref', block_type: 23, file: {} },
      { block_id: 'i-noref', block_type: 26, iframe: {} },
    ];
    const out = extractEmbeddedBlocks(blocks);
    expect(out[0].ref).toBeUndefined();
    expect(out[1].ref).toBeUndefined();
  });

  it('tolerates malformed entries without crashing', () => {
    const blocks: unknown[] = [
      null,
      undefined,
      'string',
      42,
      heading(1, 'OK'),
      { block_id: 't', block_type: 31, table: {} },
      {}, // empty object - no block_type
    ];
    const out = extractEmbeddedBlocks(blocks);
    expect(out).toHaveLength(1);
    expect(out[0]).toMatchObject({ type_name: 'table', section_hint: 'OK' });
  });

  it('1-based index follows document order across mixed embed types', () => {
    const blocks = [
      heading(1, 'A'),
      { block_type: 31, table: {} },
      heading(1, 'B'),
      { block_type: 23, file: { token: 'f1' } },
      { block_type: 26, iframe: { url: 'u' } },
    ];
    const out = extractEmbeddedBlocks(blocks);
    expect(out.map((e) => e.index)).toEqual([1, 2, 3]);
    expect(out.map((e) => e.type_name)).toEqual(['table', 'file', 'iframe']);
    expect(out.map((e) => e.section_hint)).toEqual(['A', 'B', 'B']);
  });
});

function foldedHeading(level: number, text: string, blockId = `h${level}-${text}`) {
  return {
    block_id: blockId,
    block_type: 2 + level,
    [`heading${level}`]: {
      elements: [{ text_run: { content: text } }],
      style: { folded: true },
    },
  };
}

describe('extractFoldedSections', () => {
  it('returns empty array for empty input', () => {
    expect(extractFoldedSections([])).toEqual([]);
  });

  it('returns empty array when no heading has folded=true', () => {
    const blocks = [
      heading(1, 'Plain'),
      paragraph('body'),
      {
        block_type: 3,
        heading1: { elements: [{ text_run: { content: 'Not folded' } }], style: { folded: false } },
      },
    ];
    expect(extractFoldedSections(blocks)).toEqual([]);
  });

  it('collects folded headings with level + text + block_id', () => {
    const blocks = [
      heading(1, 'Open'),
      foldedHeading(1, '收起的一级'),
      paragraph('inside'),
      foldedHeading(3, '收起的三级'),
    ];
    const out = extractFoldedSections(blocks);
    expect(out).toEqual([
      { index: 1, block_id: 'h1-收起的一级', level: 1, text: '收起的一级' },
      { index: 2, block_id: 'h3-收起的三级', level: 3, text: '收起的三级' },
    ]);
  });

  it('falls back to (无标题) when folded heading has no text', () => {
    const blocks = [
      { block_id: 'h-empty', block_type: 3, heading1: { elements: [], style: { folded: true } } },
    ];
    const out = extractFoldedSections(blocks);
    expect(out[0].text).toBe('(无标题)');
  });

  it('ignores non-heading blocks even when they have folded-shaped fields', () => {
    const blocks = [
      paragraph('body'),
      { block_type: 31, table: { style: { folded: true } } },
      { block_type: 2, text: { style: { folded: true } } },
    ];
    expect(extractFoldedSections(blocks)).toEqual([]);
  });

  it('tolerates malformed entries without crashing', () => {
    const blocks: unknown[] = [
      null,
      undefined,
      'string',
      42,
      foldedHeading(1, 'OK'),
      {},
    ];
    const out = extractFoldedSections(blocks);
    expect(out).toHaveLength(1);
    expect(out[0]).toMatchObject({ text: 'OK', level: 1 });
  });
});

describe('buildDisplayHints', () => {
  it('returns undefined when both lists are empty', () => {
    expect(buildDisplayHints([], [])).toBeUndefined();
  });

  it('renders embedded entries as label + token (NO markdown links, regardless of url)', () => {
    // URLs we infer for sheet/bitable/file/iframe don't reliably route to
    // the right tenant — only wiki paths do. Dropping the hyperlink in
    // favour of "label + token" lets the user paste the token into Feishu's
    // tenant-aware search box. See isWikiUrl + buildDisplayHints rationale.
    const out = buildDisplayHints(
      [
        {
          index: 1,
          block_id: 's1',
          block_type: 30,
          type_name: 'sheet',
          section_hint: '第二节',
          ref: 'shtcnAAA',
          url: `${FEISHU_DOC_LINK_BASE}/sheets/shtcnAAA`, // url present but NOT rendered as link
        },
        {
          index: 2,
          block_id: 'b1',
          block_type: 18,
          type_name: 'bitable',
          section_hint: '第三节',
          ref: 'bascnBBB',
          url: `${FEISHU_DOC_LINK_BASE}/base/bascnBBB`,
        },
      ],
      [],
    );
    expect(out).toContain('- 电子表格(在「第二节」) `shtcnAAA`');
    expect(out).toContain('- 多维表格(在「第三节」) `bascnBBB`');
    // No markdown link of any flavour in the embedded section
    expect(out).not.toMatch(/\]\(https?:\/\/[^)]*\/(sheets|base|docx|file|board|slides)\//);
    expect(out).toContain('=== 推荐附在总结末尾的清单');
  });

  it('prefers title over generic label when title is resolved (still no link)', () => {
    const out = buildDisplayHints(
      [
        {
          index: 1,
          block_id: 's1',
          block_type: 30,
          type_name: 'sheet',
          section_hint: '第二节',
          ref: 'shtAAA',
          url: `${FEISHU_DOC_LINK_BASE}/sheets/shtAAA`,
          title: 'Q4 销售数据表',
        },
        {
          index: 2,
          block_id: 'f1',
          block_type: 23,
          type_name: 'file',
          section_hint: '附件',
          ref: 'filtok',
          title: '员工手册.pdf', // file blocks get free title from file.name
        },
      ],
      [],
    );
    expect(out).toContain('- Q4 销售数据表(电子表格,在「第二节」) `shtAAA`');
    expect(out).toContain('- 员工手册.pdf(附件文件,在「附件」) `filtok`');
  });

  it('falls back to block_id locator when url is missing', () => {
    const out = buildDisplayHints(
      [
        {
          index: 1,
          block_id: 'tbl-1',
          block_type: 31,
          type_name: 'table',
          section_hint: '第二节',
        },
      ],
      [],
    );
    expect(out).toContain('文档内嵌表格');
    expect(out).toContain('block_id `tbl-1`');
    expect(out).toContain('第二节');
    expect(out).not.toMatch(/\]\(http/); // no markdown link without url
  });

  it('renders folded sections as one-line bullet with title list', () => {
    const out = buildDisplayHints(
      [],
      [
        { index: 1, block_id: 'h1', level: 1, text: '附录' },
        { index: 2, block_id: 'h2', level: 2, text: 'FAQ' },
      ],
    );
    expect(out).toContain('📁 默认折叠的章节');
    expect(out).toContain('共 2 个');
    expect(out).toContain('「附录」');
    expect(out).toContain('「FAQ」');
  });

  it('combines embedded + folded into one block separated by blank line', () => {
    const out = buildDisplayHints(
      [
        {
          index: 1,
          block_id: 's1',
          block_type: 30,
          type_name: 'sheet',
          section_hint: '一',
          ref: 'aaa',
          url: `${FEISHU_DOC_LINK_BASE}/sheets/aaa`,
        },
      ],
      [{ index: 1, block_id: 'h1', level: 1, text: '附录' }],
    );
    const lines = out!.split('\n');
    const embedIdx = lines.findIndex((l) => l.includes('📎'));
    const foldedIdx = lines.findIndex((l) => l.includes('📁'));
    expect(embedIdx).toBeGreaterThanOrEqual(0);
    expect(foldedIdx).toBeGreaterThan(embedIdx);
  });

  it('uses friendly Chinese labels for known type_names', () => {
    const make = (typeName: string) => ({
      index: 1,
      block_type: 0,
      type_name: typeName,
      section_hint: 's',
      url: 'https://example.com',
    });
    expect(buildDisplayHints([make('sheet')], [])).toContain('电子表格');
    expect(buildDisplayHints([make('bitable')], [])).toContain('多维表格');
    expect(buildDisplayHints([make('whiteboard')], [])).toContain('画板');
    expect(buildDisplayHints([make('iframe')], [])).toContain('外部嵌入');
    expect(buildDisplayHints([make('file')], [])).toContain('附件文件');
    expect(buildDisplayHints([make('table')], [])).toContain('文档内嵌表格');
  });

  it('passes unknown type_name through verbatim (forward-compat with new block types)', () => {
    const out = buildDisplayHints(
      [
        {
          index: 1,
          block_type: 999,
          type_name: 'block_999',
          section_hint: 's',
          url: 'https://example.com',
        },
      ],
      [],
    );
    expect(out).toContain('block_999');
  });

  it('renders non-wiki mentioned_docs as label + token (no link), wiki kept as link', () => {
    // Wiki paths route correctly across tenants (Feishu's wiki layer is
    // tenant-aware), so wiki URLs survive as clickable markdown links.
    // Everything else is dropped to label + token, same reasoning as for
    // embedded entries.
    const out = buildDisplayHints(
      [],
      [],
      [
        {
          index: 1,
          token: 'doxcnAAA',
          obj_type: 'docx',
          url: `${FEISHU_DOC_LINK_BASE}/docx/doxcnAAA`,
          section_hint: '相关资料',
        },
        {
          index: 2,
          token: 'shtcnBBB',
          obj_type: 'sheet',
          url: `${FEISHU_DOC_LINK_BASE}/sheets/shtcnBBB`,
          section_hint: '数据',
        },
        {
          index: 3,
          token: 'wikiCCC',
          obj_type: 'unknown', // wiki obj_type isn't in the numeric map; URL string is what matters
          url: 'https://xindong.feishu.cn/wiki/wikiCCC',
          section_hint: '知识库',
        },
      ],
      [],
    );
    expect(out).toContain('🔗 文中引用的飞书文档');
    // Non-wiki: label + token, no markdown link
    expect(out).toContain('- 新版文档(在「相关资料」) `doxcnAAA`');
    expect(out).toContain('- 电子表格(在「数据」) `shtcnBBB`');
    // Wiki: kept as markdown link
    expect(out).toContain(
      '- [飞书文档(在「知识库」)](https://xindong.feishu.cn/wiki/wikiCCC) `wikiCCC`',
    );
    // Non-wiki paths must not appear as markdown link targets
    expect(out).not.toMatch(/\]\(https?:\/\/[^)]*\/(docx|sheets|base|file|slides)\//);
  });

  it('always appends raw token after embedded entry (works even when URL is wrong)', () => {
    const out = buildDisplayHints(
      [
        {
          index: 1,
          block_id: 'b1',
          block_type: 18,
          type_name: 'bitable',
          section_hint: '第二节',
          ref: 'KNsh_tbl96rJe2AmaiH2x',
          url: `${FEISHU_DOC_LINK_BASE}/base/KNsh?table=tbl96rJe2AmaiH2x`,
        },
        {
          // Hypothetical misidentified type (画册 maybe surfacing as bitable
          // or unknown): even if URL fails, user has the token to search.
          index: 2,
          block_id: 'b2',
          block_type: 999,
          type_name: 'block_999',
          section_hint: '附录',
          ref: 'unknownTokenXXX',
        },
      ],
      [],
    );
    expect(out).toContain('`KNsh_tbl96rJe2AmaiH2x`');
    expect(out).toContain('`unknownTokenXXX`');
  });

  it('renders ⚠️ + token (no link) when entry is type_uncertain', () => {
    const out = buildDisplayHints(
      [
        {
          index: 1,
          block_id: 'b1',
          block_type: 18,
          type_name: 'bitable',
          section_hint: '画册章节',
          ref: 'KNshXXX_tblYYY',
          type_uncertain: true,
        },
      ],
      [],
    );
    expect(out).toContain('⚠️');
    expect(out).toContain('`KNshXXX_tblYYY`');
    expect(out).toContain('类型识别可能有误');
    // No markdown link rendered for uncertain entries
    expect(out).not.toMatch(/\]\(http/);
  });

  it('falls back to block_id when ref is missing (in-doc table / chat_card)', () => {
    const out = buildDisplayHints(
      [
        {
          index: 1,
          block_id: 'tbl-abc',
          block_type: 31,
          type_name: 'table',
          section_hint: '第二节',
        },
      ],
      [],
    );
    expect(out).toContain('block_id `tbl-abc`');
  });

  it('always appends token after every mentioned_doc entry', () => {
    const out = buildDisplayHints(
      [],
      [],
      [
        {
          index: 1,
          token: 'doxcnAAA',
          obj_type: 'docx',
          url: `${FEISHU_DOC_LINK_BASE}/docx/doxcnAAA`,
          section_hint: '参考',
          title: '支付方案',
        },
        {
          index: 2,
          token: 'shtcnBBB',
          obj_type: 'sheet',
          url: `${FEISHU_DOC_LINK_BASE}/sheets/shtcnBBB`,
          section_hint: '数据',
        },
      ],
      [],
    );
    expect(out).toContain('`doxcnAAA`');
    expect(out).toContain('`shtcnBBB`');
  });

  it('mentioned_docs uses title when resolved (non-wiki: no link, wiki: link)', () => {
    // Non-wiki keeps title in the label but drops the markdown link.
    const docx = buildDisplayHints(
      [],
      [],
      [
        {
          index: 1,
          token: 'doxcnAAA',
          obj_type: 'docx',
          url: `${FEISHU_DOC_LINK_BASE}/docx/doxcnAAA`,
          section_hint: '参考',
          title: '支付重构方案',
        },
      ],
      [],
    );
    expect(docx).toContain('- 支付重构方案(新版文档,在「参考」) `doxcnAAA`');
    expect(docx).not.toMatch(/\]\(http/);

    // Wiki keeps both title in the label AND the markdown link.
    const wiki = buildDisplayHints(
      [],
      [],
      [
        {
          index: 1,
          token: 'wikiXXX',
          obj_type: 'unknown',
          url: 'https://xindong.feishu.cn/wiki/wikiXXX',
          section_hint: '参考',
          title: '支付重构方案',
        },
      ],
      [],
    );
    expect(wiki).toContain(
      '- [支付重构方案(飞书文档,在「参考」)](https://xindong.feishu.cn/wiki/wikiXXX) `wikiXXX`',
    );
  });

  it('renders todos section with checkbox + open/done counts', () => {
    const out = buildDisplayHints(
      [],
      [],
      [],
      [
        { index: 1, block_id: 't1', done: true, text: '完成 API 设计', section_hint: '里程碑' },
        { index: 2, block_id: 't2', done: false, text: '和后端对接', section_hint: '里程碑' },
        { index: 3, block_id: 't3', done: false, text: '写文档', section_hint: '(开头)' },
      ],
    );
    expect(out).toContain('共 3 个');
    expect(out).toContain('已完成 1');
    expect(out).toContain('未完成 2');
    expect(out).toContain('- [x] 完成 API 设计');
    expect(out).toContain('- [ ] 和后端对接');
    expect(out).toContain('- [ ] 写文档');
    // section_hint "(开头)" should NOT be rendered as italic suffix
    expect(out).not.toContain('_(开头)_');
  });
});

describe('extractMentionedDocs', () => {
  it('returns empty array for empty input', () => {
    expect(extractMentionedDocs([])).toEqual([]);
  });

  it('collects mention_doc from text / heading / bullet / quote / callout-like blocks', () => {
    const blocks = [
      heading(1, '相关'),
      {
        block_type: 2,
        text: {
          elements: [
            { text_run: { content: '详见 ' } },
            { mention_doc: { token: 'doxAAA', obj_type: 22, url: `${FEISHU_DOC_LINK_BASE}/docx/doxAAA` } },
          ],
        },
      },
      {
        block_type: 12,
        bullet: {
          elements: [{ mention_doc: { token: 'shtBBB', obj_type: 3 } }],
        },
      },
      {
        block_type: 15,
        quote: {
          elements: [{ mention_doc: { token: 'bascCCC', obj_type: 8 } }],
        },
      },
    ];
    const out = extractMentionedDocs(blocks);
    expect(out).toHaveLength(3);
    expect(out[0]).toMatchObject({
      token: 'doxAAA',
      obj_type: 'docx',
      url: `${FEISHU_DOC_LINK_BASE}/docx/doxAAA`,
      section_hint: '相关',
    });
    expect(out[1]).toMatchObject({
      token: 'shtBBB',
      obj_type: 'sheet',
      url: `${FEISHU_DOC_LINK_BASE}/sheets/shtBBB`,
      section_hint: '相关',
    });
    expect(out[2]).toMatchObject({
      token: 'bascCCC',
      obj_type: 'bitable',
      url: `${FEISHU_DOC_LINK_BASE}/base/bascCCC`,
    });
  });

  it('dedups by token (first occurrence wins)', () => {
    const blocks = [
      heading(1, 'A'),
      { block_type: 2, text: { elements: [{ mention_doc: { token: 'same', obj_type: 22 } }] } },
      heading(1, 'B'),
      { block_type: 2, text: { elements: [{ mention_doc: { token: 'same', obj_type: 22 } }] } },
      { block_type: 2, text: { elements: [{ mention_doc: { token: 'other', obj_type: 22 } }] } },
    ];
    const out = extractMentionedDocs(blocks);
    expect(out).toHaveLength(2);
    expect(out[0]).toMatchObject({ token: 'same', section_hint: 'A' });
    expect(out[1]).toMatchObject({ token: 'other', section_hint: 'B' });
  });

  it('prefers element.url over the inferred URL', () => {
    const blocks = [
      {
        block_type: 2,
        text: {
          elements: [
            {
              mention_doc: {
                token: 'tok',
                obj_type: 22,
                url: 'https://wiki.example.com/special',
              },
            },
          ],
        },
      },
    ];
    expect(extractMentionedDocs(blocks)[0].url).toBe('https://wiki.example.com/special');
  });

  it('falls back to obj_type=unknown + docx URL path when obj_type missing or unknown', () => {
    const blocks = [
      { block_type: 2, text: { elements: [{ mention_doc: { token: 'noType' } }] } },
      { block_type: 2, text: { elements: [{ mention_doc: { token: 'badType', obj_type: 999 } }] } },
    ];
    const out = extractMentionedDocs(blocks);
    expect(out[0]).toMatchObject({ obj_type: 'unknown', url: `${FEISHU_DOC_LINK_BASE}/docx/noType` });
    expect(out[1]).toMatchObject({ obj_type: 'unknown', url: `${FEISHU_DOC_LINK_BASE}/docx/badType` });
  });

  it('ignores mention_doc with missing or empty token', () => {
    const blocks = [
      { block_type: 2, text: { elements: [{ mention_doc: {} }, { mention_doc: { token: '' } }] } },
    ];
    expect(extractMentionedDocs(blocks)).toEqual([]);
  });

  it('tolerates malformed entries without crashing', () => {
    const blocks: unknown[] = [
      null,
      'string',
      42,
      { block_type: 2, text: { elements: [{ mention_doc: { token: 'ok', obj_type: 22 } }] } },
      {},
    ];
    const out = extractMentionedDocs(blocks);
    expect(out).toHaveLength(1);
    expect(out[0].token).toBe('ok');
  });
});

describe('extractMentionedUserIds', () => {
  it('returns empty array for empty input', () => {
    expect(extractMentionedUserIds([])).toEqual([]);
  });

  it('collects open_ids from text / heading / bullet / todo / etc elements', () => {
    const blocks = [
      {
        block_type: 2,
        text: { elements: [{ mention_user: { user_id: 'ou_alice' } }] },
      },
      {
        block_type: 3,
        heading1: { elements: [{ mention_user: { user_id: 'ou_bob' } }] },
      },
      {
        block_type: 17,
        todo: { elements: [{ mention_user: { user_id: 'ou_carol' } }] },
      },
    ];
    expect(extractMentionedUserIds(blocks)).toEqual(['ou_alice', 'ou_bob', 'ou_carol']);
  });

  it('dedups (first occurrence wins, preserves order)', () => {
    const blocks = [
      { block_type: 2, text: { elements: [{ mention_user: { user_id: 'a' } }] } },
      { block_type: 2, text: { elements: [{ mention_user: { user_id: 'b' } }] } },
      { block_type: 2, text: { elements: [{ mention_user: { user_id: 'a' } }] } },
    ];
    expect(extractMentionedUserIds(blocks)).toEqual(['a', 'b']);
  });

  it('ignores mention_user with missing or empty user_id', () => {
    const blocks = [
      { block_type: 2, text: { elements: [{ mention_user: {} }, { mention_user: { user_id: '' } }] } },
    ];
    expect(extractMentionedUserIds(blocks)).toEqual([]);
  });
});

describe('extractTodos', () => {
  it('returns empty array for empty input', () => {
    expect(extractTodos([])).toEqual([]);
  });

  it('extracts text + done state + section_hint per todo', () => {
    const blocks = [
      heading(1, '里程碑'),
      {
        block_id: 't1',
        block_type: 17,
        todo: {
          elements: [{ text_run: { content: '完成 API 设计' } }],
          style: { done: true },
        },
      },
      {
        block_id: 't2',
        block_type: 17,
        todo: {
          elements: [{ text_run: { content: '和后端对接' } }],
          style: { done: false },
        },
      },
      {
        block_id: 't3',
        block_type: 17,
        todo: {
          elements: [{ text_run: { content: '没有 style 字段' } }],
        },
      },
    ];
    const out = extractTodos(blocks);
    expect(out).toEqual([
      { index: 1, block_id: 't1', done: true, text: '完成 API 设计', section_hint: '里程碑' },
      { index: 2, block_id: 't2', done: false, text: '和后端对接', section_hint: '里程碑' },
      { index: 3, block_id: 't3', done: false, text: '没有 style 字段', section_hint: '里程碑' },
    ]);
  });

  it('joins multi-element todo text from text_runs only (skips mentions in text)', () => {
    const blocks = [
      {
        block_type: 17,
        todo: {
          elements: [
            { text_run: { content: '由 ' } },
            { mention_user: { user_id: 'ou_x' } },
            { text_run: { content: ' 负责发版' } },
          ],
          style: { done: false },
        },
      },
    ];
    expect(extractTodos(blocks)[0].text).toBe('由  负责发版');
  });

  it('falls back to (无内容) when todo has no text_run content', () => {
    const blocks = [
      { block_type: 17, todo: { elements: [], style: { done: false } } },
      { block_type: 17, todo: { style: { done: true } } },
    ];
    const out = extractTodos(blocks);
    expect(out).toHaveLength(2);
    expect(out[0].text).toBe('(无内容)');
    expect(out[1].text).toBe('(无内容)');
  });

  it('ignores non-todo blocks', () => {
    const blocks = [
      heading(1, 'A'),
      paragraph('not a todo'),
      { block_type: 31, table: {} },
    ];
    expect(extractTodos(blocks)).toEqual([]);
  });
});

describe('splitBitableToken', () => {
  it('splits composite app_token_tableId form on the first _tbl', () => {
    expect(splitBitableToken('KNshbmwjCan3yisyHl5cCMFUnLe_tbl96rJe2AmaiH2x')).toEqual({
      app_token: 'KNshbmwjCan3yisyHl5cCMFUnLe',
      table_id: 'tbl96rJe2AmaiH2x',
    });
  });

  it('returns whole token as app_token when no _tbl present (backwards compat)', () => {
    expect(splitBitableToken('bascnSimpleToken')).toEqual({
      app_token: 'bascnSimpleToken',
      table_id: undefined,
    });
  });

  it('handles edge cases without crashing', () => {
    expect(splitBitableToken('')).toEqual({ app_token: '', table_id: undefined });
    expect(splitBitableToken('_tblOrphan')).toEqual({ app_token: '', table_id: 'tblOrphan' });
  });
});

describe('splitCompositeToken', () => {
  it('splits on the first underscore for any composite-shaped token', () => {
    expect(splitCompositeToken('OAPmsdEugh84XVtdoYOcbO1Xnee_1x2w9u')).toEqual({
      main_token: 'OAPmsdEugh84XVtdoYOcbO1Xnee',
      sub_id: '1x2w9u',
    });
  });

  it('returns whole token when no underscore present', () => {
    expect(splitCompositeToken('shtcnSimple')).toEqual({
      main_token: 'shtcnSimple',
      sub_id: undefined,
    });
  });

  it('only splits on the first underscore (preserves the rest as sub_id)', () => {
    expect(splitCompositeToken('aa_bb_cc')).toEqual({
      main_token: 'aa',
      sub_id: 'bb_cc',
    });
  });
});

describe('extractEmbeddedBlocks (sheet URL composite token handling — user-reported regression)', () => {
  it('builds sheet URL with ?sheet=... when ref is composite (the OAPmsdEugh84XVtdoYOcbO1Xnee_1x2w9u case)', () => {
    const blocks = [
      {
        block_id: 's1',
        block_type: 30,
        sheet: { token: 'OAPmsdEugh84XVtdoYOcbO1Xnee_1x2w9u' },
      },
    ];
    const out = extractEmbeddedBlocks(blocks);
    expect(out[0].url).toBe(
      `${FEISHU_DOC_LINK_BASE}/sheets/OAPmsdEugh84XVtdoYOcbO1Xnee?sheet=1x2w9u`,
    );
    // ref preserved as the original composite for downstream consumers.
    expect(out[0].ref).toBe('OAPmsdEugh84XVtdoYOcbO1Xnee_1x2w9u');
  });

  it('falls back to base URL only when sheet ref has no underscore', () => {
    const blocks = [
      { block_id: 's1', block_type: 30, sheet: { token: 'shtcnSimpleToken' } },
    ];
    expect(extractEmbeddedBlocks(blocks)[0].url).toBe(
      `${FEISHU_DOC_LINK_BASE}/sheets/shtcnSimpleToken`,
    );
  });
});

describe('extractEmbeddedBlocks (bitable URL composite token handling)', () => {
  it('builds bitable URL with ?table=... when ref is composite', () => {
    const blocks = [
      {
        block_id: 'b1',
        block_type: 18,
        bitable: { token: 'KNshbmwjCan3yisyHl5cCMFUnLe_tbl96rJe2AmaiH2x' },
      },
    ];
    const out = extractEmbeddedBlocks(blocks);
    expect(out[0].url).toBe(
      `${FEISHU_DOC_LINK_BASE}/base/KNshbmwjCan3yisyHl5cCMFUnLe?table=tbl96rJe2AmaiH2x`,
    );
    // ref is kept as the original composite so server.ts can preserve it
    // through the drive.meta round-trip.
    expect(out[0].ref).toBe('KNshbmwjCan3yisyHl5cCMFUnLe_tbl96rJe2AmaiH2x');
  });

  it('falls back to base URL only when bitable ref has no _tbl part', () => {
    const blocks = [
      { block_id: 'b1', block_type: 18, bitable: { token: 'bascSimpleToken' } },
    ];
    expect(extractEmbeddedBlocks(blocks)[0].url).toBe(`${FEISHU_DOC_LINK_BASE}/base/bascSimpleToken`);
  });
});

describe('applyCanonicalUrl', () => {
  it('passes through canonical URL unchanged for non-bitable types', () => {
    expect(applyCanonicalUrl('https://x.feishu.cn/sheets/abc', 34, 'abc')).toBe(
      'https://x.feishu.cn/sheets/abc',
    );
    expect(applyCanonicalUrl('https://x.feishu.cn/docx/def', 22, 'def')).toBe(
      'https://x.feishu.cn/docx/def',
    );
  });

  it('appends ?table=... for bitable composite refs', () => {
    expect(
      applyCanonicalUrl(
        'https://x.feishu.cn/base/KNsh',
        18,
        'KNsh_tbl96rJe2AmaiH2x',
      ),
    ).toBe('https://x.feishu.cn/base/KNsh?table=tbl96rJe2AmaiH2x');
  });

  it('appends ?sheet=... for sheet composite refs', () => {
    expect(
      applyCanonicalUrl(
        'https://x.feishu.cn/sheets/OAPmsdEugh84XVtdoYOcbO1Xnee',
        30,
        'OAPmsdEugh84XVtdoYOcbO1Xnee_1x2w9u',
      ),
    ).toBe('https://x.feishu.cn/sheets/OAPmsdEugh84XVtdoYOcbO1Xnee?sheet=1x2w9u');
  });

  it('uses & when canonical URL already has query params', () => {
    expect(
      applyCanonicalUrl(
        'https://x.feishu.cn/base/KNsh?from=embed',
        18,
        'KNsh_tbl96rJe2AmaiH2x',
      ),
    ).toBe('https://x.feishu.cn/base/KNsh?from=embed&table=tbl96rJe2AmaiH2x');
  });

  it('returns canonical URL unchanged for bitable without table_id', () => {
    expect(applyCanonicalUrl('https://x.feishu.cn/base/abc', 18, 'abc')).toBe(
      'https://x.feishu.cn/base/abc',
    );
  });
});

describe('extractMentionedDocs (URL-derived obj_type — fixes the "幻灯片 mislabel" bug)', () => {
  it('uses URL path to derive obj_type, even when numeric obj_type is unknown / weird', () => {
    // Real-world case: mention_doc has url=/docx/... pointing at a regular
    // docx. Older code mapped some bogus obj_type number to "slide" and
    // labeled all of these as 幻灯片. Now URL wins, label is correct.
    const blocks = [
      {
        block_type: 2,
        text: {
          elements: [
            {
              mention_doc: {
                token: 'doxcnAAA',
                obj_type: 99, // unrecognised number
                url: 'https://xindong.feishu.cn/docx/doxcnAAA',
                title: '设计文档',
              },
            },
          ],
        },
      },
    ];
    const out = extractMentionedDocs(blocks);
    expect(out[0].obj_type).toBe('docx');
    expect(out[0].title).toBe('设计文档');
    expect(out[0].url).toBe('https://xindong.feishu.cn/docx/doxcnAAA');
  });

  it('derives slides type from /slides/ URL', () => {
    const blocks = [
      {
        block_type: 2,
        text: {
          elements: [
            {
              mention_doc: {
                token: 'slidesAAA',
                obj_type: 22, // even if numeric says docx, URL wins
                url: 'https://xindong.feishu.cn/slides/slidesAAA',
              },
            },
          ],
        },
      },
    ];
    expect(extractMentionedDocs(blocks)[0].obj_type).toBe('slides');
  });

  it('derives wiki / mindnote / sheet / bitable / board / file from URL paths', () => {
    const cases: Array<[string, string]> = [
      ['https://x.feishu.cn/wiki/wikXXX', 'wiki'],
      ['https://x.feishu.cn/mindnotes/mnXXX', 'mindnote'],
      ['https://x.feishu.cn/sheets/shtXXX', 'sheet'],
      ['https://x.feishu.cn/base/bascXXX', 'bitable'],
      ['https://x.feishu.cn/board/wbXXX', 'board'],
      ['https://x.feishu.cn/file/fileXXX', 'file'],
      ['https://x.feishu.cn/docs/oldXXX', 'doc'],
    ];
    for (const [url, expectedType] of cases) {
      const out = extractMentionedDocs([
        {
          block_type: 2,
          text: { elements: [{ mention_doc: { token: 'tok', obj_type: 0, url } }] },
        },
      ]);
      expect(out[0].obj_type, `URL ${url}`).toBe(expectedType);
    }
  });

  it('falls back to numeric obj_type when no URL is provided (still imperfect but works for common cases)', () => {
    const blocks = [
      {
        block_type: 2,
        text: {
          elements: [
            { mention_doc: { token: 'tok-docx', obj_type: 22 } }, // no url
            { mention_doc: { token: 'tok-bitable', obj_type: 8 } },
          ],
        },
      },
    ];
    const out = extractMentionedDocs(blocks);
    expect(out[0].obj_type).toBe('docx');
    expect(out[1].obj_type).toBe('bitable');
  });

  it('returns "unknown" when URL is missing and numeric obj_type is unrecognised', () => {
    const blocks = [
      {
        block_type: 2,
        text: { elements: [{ mention_doc: { token: 'tok', obj_type: 9999 } }] },
      },
    ];
    expect(extractMentionedDocs(blocks)[0].obj_type).toBe('unknown');
  });

  it('extracts inline title from mention_doc element when present (skips drive.meta dependency)', () => {
    const blocks = [
      {
        block_type: 2,
        text: {
          elements: [
            {
              mention_doc: {
                token: 'tok',
                obj_type: 22,
                url: 'https://x.feishu.cn/docx/tok',
                title: '已经预填好的标题',
              },
            },
          ],
        },
      },
    ];
    expect(extractMentionedDocs(blocks)[0].title).toBe('已经预填好的标题');
  });
});

describe('extractMentionedDocs (bitable composite token handling)', () => {
  it('splits composite bitable token for the fallback URL', () => {
    const blocks = [
      {
        block_type: 2,
        text: {
          elements: [
            { mention_doc: { token: 'KNsh_tblAAA', obj_type: 8 } },
          ],
        },
      },
    ];
    const out = extractMentionedDocs(blocks);
    expect(out[0].url).toBe(`${FEISHU_DOC_LINK_BASE}/base/KNsh?table=tblAAA`);
  });

  it('still prefers element.url over the split-based fallback', () => {
    const blocks = [
      {
        block_type: 2,
        text: {
          elements: [
            {
              mention_doc: {
                token: 'KNsh_tblAAA',
                obj_type: 8,
                url: 'https://xindong.feishu.cn/base/KNsh?table=tblAAA&from=mention',
              },
            },
          ],
        },
      },
    ];
    expect(extractMentionedDocs(blocks)[0].url).toBe(
      'https://xindong.feishu.cn/base/KNsh?table=tblAAA&from=mention',
    );
  });
});

describe('extractEmbeddedBlocks (sync block extensions: source_synced=49, reference_synced=50)', () => {
  it('reports reference_synced (type 50, the "mirror" block) with proper type_name', () => {
    const blocks = [
      heading(1, 'A'),
      {
        block_id: 'sync-1',
        block_type: 50,
        reference_synced: { source_block_id: 'src-block-1', source_doc_token: 'doxcnXXX' },
      },
    ];
    const out = extractEmbeddedBlocks(blocks);
    expect(out).toHaveLength(1);
    expect(out[0]).toMatchObject({
      type_name: 'reference_synced',
      ref: 'src-block-1',
      url: `${FEISHU_DOC_LINK_BASE}/docx/doxcnXXX#src-block-1`,
      section_hint: 'A',
    });
  });

  it('reports source_synced (type 49, the anchor block) with proper type_name', () => {
    const blocks = [
      {
        block_id: 'sync-src',
        block_type: 49,
        source_synced: { source_block_id: 'self-block', source_doc_token: 'doxcnZZZ' },
      },
    ];
    const out = extractEmbeddedBlocks(blocks);
    expect(out[0]).toMatchObject({
      type_name: 'source_synced',
      ref: 'self-block',
      url: `${FEISHU_DOC_LINK_BASE}/docx/doxcnZZZ#self-block`,
    });
  });

  it('falls back to legacy `sync` / `block_ref` shapes for older SDK versions', () => {
    const blocks = [
      {
        block_id: 'sync-2',
        block_type: 50,
        block_ref: { source_block_id: 'src-2', source_doc_token: 'doxYYY' },
      },
    ];
    const out = extractEmbeddedBlocks(blocks);
    expect(out[0]).toMatchObject({
      type_name: 'reference_synced',
      ref: 'src-2',
      url: `${FEISHU_DOC_LINK_BASE}/docx/doxYYY#src-2`,
    });
  });

  it('omits url for sync block when source_doc_token is missing', () => {
    const blocks = [
      {
        block_id: 'sync-3',
        block_type: 50,
        reference_synced: { source_block_id: 'only-block-id' },
      },
    ];
    const out = extractEmbeddedBlocks(blocks);
    expect(out[0]).toMatchObject({ type_name: 'reference_synced', ref: 'only-block-id' });
    expect(out[0].url).toBeUndefined();
  });
});

describe('extractStrikethroughs', () => {
  // Test helpers — mirror the production text_run shape (content +
  // text_element_style on the inner text_run, NOT on the element root).
  function run(content: string, struck = false) {
    return {
      text_run: {
        content,
        ...(struck ? { text_element_style: { strikethrough: true } } : {}),
      },
    };
  }
  function para(elements: ReturnType<typeof run>[], blockId?: string) {
    return {
      ...(blockId ? { block_id: blockId } : {}),
      block_type: 2,
      text: { elements },
    };
  }

  it('returns empty array for empty input', () => {
    expect(extractStrikethroughs([])).toEqual([]);
  });

  it('returns empty when no text_run carries strikethrough', () => {
    const blocks = [
      heading(1, 'A'),
      para([run('hello'), run(' world')]),
      paragraph('plain'),
    ];
    expect(extractStrikethroughs(blocks)).toEqual([]);
  });

  it('captures the full block text with `~~...~~` around struck runs', () => {
    // Real-world shape: old rule + new rule on the same line, only old is struck.
    const blocks = [
      heading(1, '第三节'),
      para(
        [
          run('旧规则:'),
          run('首充不能退', true),
          run(' 新规则:首充可在 7 天内申请退款'),
        ],
        'blk-rule',
      ),
    ];
    const out = extractStrikethroughs(blocks);
    expect(out).toEqual([
      {
        index: 1,
        block_id: 'blk-rule',
        text: '旧规则:~~首充不能退~~ 新规则:首充可在 7 天内申请退款',
        section_hint: '第三节',
      },
    ]);
  });

  it('emits one entry per block, even with multiple struck spans', () => {
    const blocks = [
      heading(1, 'A'),
      para([run('keep '), run('strike1', true), run(' middle '), run('strike2', true), run(' tail')]),
    ];
    const out = extractStrikethroughs(blocks);
    expect(out).toHaveLength(1);
    expect(out[0].text).toBe('keep ~~strike1~~ middle ~~strike2~~ tail');
  });

  it('tracks section_hint across multiple struck blocks', () => {
    const blocks = [
      heading(1, 'A'),
      para([run('still ok '), run('gone', true)], 'b1'),
      heading(1, 'B'),
      para([run('also gone', true)], 'b2'),
    ];
    const out = extractStrikethroughs(blocks);
    expect(out).toHaveLength(2);
    expect(out[0].section_hint).toBe('A');
    expect(out[1].section_hint).toBe('B');
    expect(out.map((e) => e.index)).toEqual([1, 2]);
  });

  it('uses "(开头)" when no heading precedes the struck block', () => {
    const blocks = [para([run('removed', true)])];
    expect(extractStrikethroughs(blocks)[0].section_hint).toBe('(开头)');
  });

  it('catches strikethrough on heading text itself', () => {
    const blocks = [
      {
        block_id: 'h-struck',
        block_type: 3,
        heading1: {
          elements: [run('旧章节标题', true)],
        },
      },
    ];
    const out = extractStrikethroughs(blocks);
    expect(out).toHaveLength(1);
    expect(out[0].text).toBe('~~旧章节标题~~');
  });

  it('catches strikethrough across multiple text-bearing block types (bullet, ordered, quote, code, todo)', () => {
    const blocks = [
      { block_type: 12, bullet: { elements: [run('bullet '), run('struck', true)] } },
      { block_type: 13, ordered: { elements: [run('ordered '), run('struck', true)] } },
      { block_type: 14, code: { elements: [run('// '), run('TODO', true)] } },
      { block_type: 15, quote: { elements: [run('quote '), run('struck', true)] } },
      { block_type: 17, todo: { elements: [run('todo '), run('struck', true)] } },
    ];
    const out = extractStrikethroughs(blocks);
    expect(out).toHaveLength(5);
    expect(out.map((e) => e.text)).toEqual([
      'bullet ~~struck~~',
      'ordered ~~struck~~',
      '// ~~TODO~~',
      'quote ~~struck~~',
      'todo ~~struck~~',
    ]);
  });

  it('omits empty content runs without crashing', () => {
    const blocks = [
      para([run(''), run('keep'), run('', true), run('struck', true)]),
    ];
    const out = extractStrikethroughs(blocks);
    expect(out[0].text).toBe('keep~~struck~~');
  });

  it('tolerates malformed blocks (null, primitives, missing fields)', () => {
    const blocks: unknown[] = [
      null,
      undefined,
      'string',
      42,
      {},
      { block_type: 99 },
      para([run('keep '), run('struck', true)], 'good'),
    ];
    const out = extractStrikethroughs(blocks);
    expect(out).toHaveLength(1);
    expect(out[0].block_id).toBe('good');
  });

  it('skips non text_run elements (mention_user / mention_doc) without crashing', () => {
    const blocks = [
      {
        block_type: 2,
        text: {
          elements: [
            run('text '),
            { mention_user: { user_id: 'u1' } },
            run('strike', true),
            { mention_doc: { token: 'doxAAA' } },
          ],
        },
      },
    ];
    const out = extractStrikethroughs(blocks);
    expect(out).toHaveLength(1);
    expect(out[0].text).toBe('text ~~strike~~');
  });
});

describe('buildDisplayHints — strikethroughs section', () => {
  it('returns undefined when ALL manifests (including strikethroughs) are empty', () => {
    expect(buildDisplayHints([], [], [], [], [])).toBeUndefined();
  });

  it('renders the 🚫 section solely on strikethroughs (other manifests empty)', () => {
    const hint = buildDisplayHints(
      [],
      [],
      [],
      [],
      [
        {
          index: 1,
          block_id: 'blkX',
          text: '~~旧首充不能退~~',
          section_hint: '第三节',
        },
      ],
    );
    expect(hint).toBeDefined();
    expect(hint).toContain('1 处删除线内容');
    expect(hint).toContain('🚫 删除线内容(共 1 处,全部列出');
    expect(hint).toContain('- ~~旧首充不能退~~ _(第三节)_ block_id `blkX`');
  });

  it('omits section_hint suffix when hint is "(开头)"', () => {
    const hint = buildDisplayHints(
      [],
      [],
      [],
      [],
      [{ index: 1, text: '~~deleted~~', section_hint: '(开头)' }],
    );
    expect(hint).toContain('- ~~deleted~~');
    expect(hint).not.toContain('_((开头))_');
  });

  it('omits block_id suffix when block_id is missing', () => {
    const hint = buildDisplayHints(
      [],
      [],
      [],
      [],
      [{ index: 1, text: '~~deleted~~', section_hint: 'A' }],
    );
    expect(hint).toContain('- ~~deleted~~ _(A)_');
    expect(hint).not.toContain('block_id');
  });

  it('adds the strikethrough count to the 📊 overview alongside other counts', () => {
    const hint = buildDisplayHints(
      [
        {
          index: 1,
          block_type: 30,
          type_name: 'sheet',
          section_hint: 'A',
          ref: 'shtAAA',
        },
      ],
      [],
      [],
      [],
      [
        { index: 1, text: '~~x~~', section_hint: 'A' },
        { index: 2, text: '~~y~~', section_hint: 'B' },
      ],
    );
    expect(hint).toContain('1 个嵌入对象');
    expect(hint).toContain('2 处删除线内容');
  });

  it('places 🚫 section after ✅ todos and before 📁 folded', () => {
    const hint = buildDisplayHints(
      [],
      [{ index: 1, level: 1, text: '附录' }],
      [],
      [{ index: 1, done: false, text: 'do thing', section_hint: 'A' }],
      [{ index: 1, text: '~~old~~', section_hint: 'A' }],
    );
    expect(hint).toBeDefined();
    const todoIdx = hint!.indexOf('✅ 任务项');
    const strikeIdx = hint!.indexOf('🚫 删除线');
    const foldedIdx = hint!.indexOf('📁 默认折叠');
    expect(todoIdx).toBeGreaterThan(-1);
    expect(strikeIdx).toBeGreaterThan(todoIdx);
    expect(foldedIdx).toBeGreaterThan(strikeIdx);
  });
});
