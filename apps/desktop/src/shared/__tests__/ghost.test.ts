import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import {
  GHOST_CARD_ACTION_ID_RE,
  diffGhostPermissionItems,
  ghostContentKeys,
  ghostNetworkHostMatches,
  ghostPanelKind,
  ghostPartition,
  ghostPermissionItems,
  ghostWebviewEntryPaths,
  isGhostCallToolName,
  isValidGhostId,
  isOfficialGhostId,
  isValidGhostNetworkHostPattern,
  layoutWithGhostPanel,
  parseGhostPartition,
  validateGhostManifest,
  type GhostManifest,
} from '../ghost';
import { createDefaultLayout, type SplitNode } from '../layoutTree';

/** 一份全绿的清单基底(意识唯一形态:芯片,2026-07-12 单形态定案),单点破坏它来测各字段规则。 */
function goodManifest(): Record<string, unknown> {
  return {
    schemaVersion: 2,
    id: 'hello',
    name: 'Hello 意识',
    version: '1.0.0',
    kind: 'chip',
    entry: 'main.js',
    slots: ['panel'],
    panel: { title: 'Hello', html: 'panel.html', minWidth: 240, defaultFraction: 0.18 },
  };
}

/** 一份全绿的芯片型清单基底(C3a)。 */
function goodChipManifest(): Record<string, unknown> {
  return {
    schemaVersion: 2,
    id: 'hello-chip',
    name: 'Hello 芯片',
    version: '1.0.0',
    kind: 'chip',
    entry: 'main.js',
    slots: ['panel', 'model'],
    panel: { title: 'Hello 芯片', html: 'panel.html', minWidth: 240 },
  };
}

describe('ghost · ghost_call 工具名匹配(Claude / Codex 双形态)', () => {
  it('认 Claude Code 形态 mcp__<server>__ghost_call(含旧 server 名)', () => {
    expect(isGhostCallToolName('mcp__cindy__ghost_call')).toBe(true);
    expect(isGhostCallToolName('mcp__cindy_ghosts__ghost_call')).toBe(true);
  });

  it('认 Codex translator 形态 mcp:<server>:ghost_call(含旧 server 名)——漏了会让 Codex 会话退化成通用 MCP 行', () => {
    expect(isGhostCallToolName('mcp:cindy:ghost_call')).toBe(true);
    expect(isGhostCallToolName('mcp:cindy_ghosts:ghost_call')).toBe(true);
  });

  it('不误伤其它工具名', () => {
    expect(isGhostCallToolName('mcp__cindy__ghost_list')).toBe(false);
    expect(isGhostCallToolName('mcp:cindy:ghost_list')).toBe(false);
    expect(isGhostCallToolName('ghost_call')).toBe(false);
    expect(isGhostCallToolName(undefined)).toBe(false);
    expect(isGhostCallToolName(null)).toBe(false);
  });
});

describe('ghost · id 规则', () => {
  it('合法:小写字母/数字/连字符,1–32 位', () => {
    for (const id of ['a', 'hello', 'hello-world', 'a1-b2', 'x'.repeat(32)]) {
      expect(isValidGhostId(id), id).toBe(true);
    }
  });

  it('非法:大写/下划线/路径字符/连字符开头/超长/非字符串', () => {
    for (const id of ['Hello', 'a_b', '../evil', 'a/b', 'a\\b', '-abc', '', 'x'.repeat(33), 42, null]) {
      expect(isValidGhostId(id), String(id)).toBe(false);
    }
  });

  it('panelKind 前缀拼接', () => {
    expect(ghostPanelKind('hello')).toBe('ghost:hello');
  });

  it('内容清单:面板/代码/能力槽按序列出,panel 槽不重复', () => {
    const base = validateGhostManifest(goodManifest());
    expect(base.ok && ghostContentKeys(base.manifest)).toEqual(['panel', 'code']);
    const chip = validateGhostManifest(goodChipManifest());
    expect(chip.ok && ghostContentKeys(chip.manifest)).toEqual(['panel', 'code', 'slotCindy']);
    const noPanel: Record<string, unknown> = {
      ...goodManifest(),
      slots: ['tool'],
      tools: [{ name: 'do_thing', description: '做点事' }],
    };
    delete noPanel.panel;
    const bare = validateGhostManifest(noPanel);
    expect(bare.ok && ghostContentKeys(bare.manifest)).toEqual(['code', 'slotTool']);
  });

  it('沙箱分区名:拼接与解析互逆,非意识分区/非法 id 解析为 null', () => {
    expect(ghostPartition('art')).toBe('cindy-ghost-art');
    expect(parseGhostPartition('cindy-ghost-art')).toBe('art');
    expect(parseGhostPartition('persist:xdmaker-browser-app')).toBeNull();
    expect(parseGhostPartition('cindy-ghost-')).toBeNull();
    expect(parseGhostPartition('cindy-ghost-BAD_ID')).toBeNull();
    expect(parseGhostPartition(undefined)).toBeNull();
  });
});

describe('ghost · 清单校验', () => {
  it('全字段合法清单通过,并按已知字段收窄输出', () => {
    const v = validateGhostManifest({ ...goodManifest(), unknownField: 'ignored' });
    expect(v.ok).toBe(true);
    const manifest = (v as { ok: true; manifest: GhostManifest }).manifest;
    expect(manifest).toEqual(goodManifest()); // 未知字段被丢弃
  });

  it('panel 可省略(slots 不含 panel 时)', () => {
    const raw: Record<string, unknown> = {
      ...goodManifest(),
      slots: ['tool'],
      tools: [{ name: 'do_thing', description: '做点事' }],
    };
    delete raw.panel;
    const v = validateGhostManifest(raw);
    expect(v.ok).toBe(true);
    expect((v as { ok: true; manifest: GhostManifest }).manifest.panel).toBeUndefined();
  });

  it('非对象 / schemaVersion 不是 2 → 拒绝(v1 声明型已移除)', () => {
    expect(validateGhostManifest(null).ok).toBe(false);
    expect(validateGhostManifest([]).ok).toBe(false);
    expect(validateGhostManifest({ ...goodManifest(), schemaVersion: 1 }).ok).toBe(false);
    expect(validateGhostManifest({ ...goodManifest(), schemaVersion: 3 }).ok).toBe(false);
  });

  it('id / name / version 的边界', () => {
    expect(validateGhostManifest({ ...goodManifest(), id: 'Bad_Id' }).ok).toBe(false);
    expect(validateGhostManifest({ ...goodManifest(), name: '' }).ok).toBe(false);
    expect(validateGhostManifest({ ...goodManifest(), name: 'x'.repeat(65) }).ok).toBe(false);
    expect(validateGhostManifest({ ...goodManifest(), version: '' }).ok).toBe(false);
    expect(validateGhostManifest({ ...goodManifest(), version: 'v'.repeat(33) }).ok).toBe(false);
  });

  it('kind 可省略:缺省归一化为 chip(2026-07-12 晚定案,单形态后纯冗余)', () => {
    const m = goodManifest();
    delete m.kind;
    const v = validateGhostManifest(m);
    expect(v.ok).toBe(true);
    if (v.ok) expect(v.manifest.kind).toBe('chip');
  });

  it('kind 只认 chip;declaration 已移除(2026-07-12 单形态定案)', () => {
    expect(validateGhostManifest({ ...goodManifest(), kind: 'plugin' }).ok).toBe(false);
    // v2 清单标 kind: declaration → 拒,错误话术点明形态已移除
    const declV2 = validateGhostManifest({ ...goodManifest(), kind: 'declaration' });
    expect(declV2.ok).toBe(false);
    expect(!declV2.ok && declV2.reason).toContain('chip');
    // 完整的老声明型清单(v1 + declaration + 静态 body 面板)→ 拒
    const legacy = validateGhostManifest({
      schemaVersion: 1,
      id: 'legacy',
      name: '老声明型',
      version: '1.0.0',
      kind: 'declaration',
      panel: { title: '静态面板', body: '一段文字' },
    });
    expect(legacy.ok).toBe(false);
  });

  it('panel 字段边界:html 必填、title 长度、minWidth/defaultFraction 数值范围', () => {
    const withPanel = (panel: Record<string, unknown>) =>
      validateGhostManifest({ ...goodManifest(), panel: { html: 'panel.html', ...panel } });
    expect(validateGhostManifest({ ...goodManifest(), panel: 'not-object' }).ok).toBe(false);
    // html 必填(declaration 时代的静态 body 面板已随单形态定案移除)
    expect(validateGhostManifest({ ...goodManifest(), panel: { title: 'X' } }).ok).toBe(false);
    expect(validateGhostManifest({ ...goodManifest(), panel: { title: 'X', body: '正文' } }).ok).toBe(false);
    expect(withPanel({ title: '' }).ok).toBe(false);
    expect(withPanel({ title: 'x'.repeat(65) }).ok).toBe(false);
    expect(withPanel({ minWidth: 119 }).ok).toBe(false);
    expect(withPanel({ minWidth: 1201 }).ok).toBe(false);
    expect(withPanel({ minWidth: Number.NaN }).ok).toBe(false);
    expect(withPanel({ defaultFraction: 0.04 }).ok).toBe(false);
    expect(withPanel({ defaultFraction: 0.81 }).ok).toBe(false);
    // 边界值本身合法
    expect(withPanel({ minWidth: 120, defaultFraction: 0.05 }).ok).toBe(true);
    expect(withPanel({ minWidth: 1200, defaultFraction: 0.8 }).ok).toBe(true);
    // 只有 html 的 panel 合法(其余字段可选)
    expect(withPanel({}).ok).toBe(true);
  });

  it('author:可选展示名,1–64 字符,原样输出', () => {
    const base = validateGhostManifest({ ...goodManifest(), author: 'Lizi' });
    expect(base.ok && (base as { ok: true; manifest: GhostManifest }).manifest.author).toBe('Lizi');
    const chip = validateGhostManifest({ ...goodChipManifest(), author: 'Lizi' });
    expect(chip.ok && (chip as { ok: true; manifest: GhostManifest }).manifest.author).toBe('Lizi');
    expect(validateGhostManifest({ ...goodManifest(), author: '' }).ok).toBe(false);
    expect(validateGhostManifest({ ...goodManifest(), author: '  ' }).ok).toBe(false);
    expect(validateGhostManifest({ ...goodManifest(), author: 'x'.repeat(65) }).ok).toBe(false);
    expect(validateGhostManifest({ ...goodManifest(), author: 42 }).ok).toBe(false);
  });

  it('icon:可选包内相对路径,扩展名白名单;非法路径/扩展名 → 拒', () => {
    const base = validateGhostManifest({ ...goodManifest(), icon: 'assets/icon.png' });
    expect(base.ok && (base as { ok: true; manifest: GhostManifest }).manifest.icon).toBe('assets/icon.png');
    const chip = validateGhostManifest({ ...goodChipManifest(), icon: 'icon.webp' });
    expect(chip.ok && (chip as { ok: true; manifest: GhostManifest }).manifest.icon).toBe('icon.webp');
    // 大小写不敏感的扩展名
    expect(validateGhostManifest({ ...goodManifest(), icon: 'ICON.PNG' }).ok).toBe(true);
    for (const icon of ['../evil.png', '/abs.png', 'a\\b.png', 'icon.svg', 'icon.js', 'icon', 42]) {
      expect(validateGhostManifest({ ...goodManifest(), icon }).ok, String(icon)).toBe(false);
    }
  });
});

describe('ghost · 芯片型清单(schemaVersion 2,C3a)', () => {
  it('全字段合法芯片清单通过', () => {
    const v = validateGhostManifest(goodChipManifest());
    expect(v.ok).toBe(true);
    const manifest = (v as { ok: true; manifest: GhostManifest }).manifest;
    expect(manifest.kind).toBe('chip');
    expect(manifest.entry).toBe('main.js');
    expect(manifest.slots).toEqual(['panel', 'cindy']); // 'model' 旧名归一化
    expect(manifest.panel?.html).toBe('panel.html');
  });

  it('entry 必填且必须是安全相对路径', () => {
    const without = goodChipManifest();
    delete without.entry;
    expect(validateGhostManifest(without).ok).toBe(false);
    for (const entry of ['../evil.js', '/abs.js', 'a\\b.js', 'a//b.js', '.env', 'C:/x.js']) {
      expect(validateGhostManifest({ ...goodChipManifest(), entry }).ok, entry).toBe(false);
    }
    expect(validateGhostManifest({ ...goodChipManifest(), entry: 'src/main.js' }).ok).toBe(true);
  });

  it('slots 必填非空、只认六卡槽、不许重复', () => {
    expect(validateGhostManifest({ ...goodChipManifest(), slots: undefined }).ok).toBe(false);
    expect(validateGhostManifest({ ...goodChipManifest(), slots: [] }).ok).toBe(false);
    expect(validateGhostManifest({ ...goodChipManifest(), slots: ['panel', 'filesystem'] }).ok).toBe(false);
    expect(validateGhostManifest({ ...goodChipManifest(), slots: ['model', 'model'] }).ok).toBe(false);
    const noPanel = goodChipManifest();
    noPanel.slots = ['subscribe', 'tool', 'card', 'model'];
    noPanel.tools = [{ name: 'do_thing', description: '做点事' }];
    delete noPanel.panel;
    expect(validateGhostManifest(noPanel).ok).toBe(true);
  });

  it('工具声明(卡槽②)与 tool 槽成对;名/描述/条数校验', () => {
    const withTools = (slots: string[], tools: unknown) =>
      validateGhostManifest({ ...goodChipManifest(), slots, tools });
    // 成对:有 tool 槽必须有 tools,反之亦然
    expect(validateGhostManifest({ ...goodChipManifest(), slots: ['panel', 'tool'] }).ok).toBe(false);
    expect(withTools(['panel'], [{ name: 'x', description: 'y' }]).ok).toBe(false);
    // 合法
    expect(withTools(['panel', 'tool'], [{ name: 'gen_image', description: '生成图片' }]).ok).toBe(true);
    // 名字非法 / 重名 / 描述空 / 超 16 条
    expect(withTools(['panel', 'tool'], [{ name: 'Bad', description: 'y' }]).ok).toBe(false);
    expect(
      withTools(['panel', 'tool'], [
        { name: 'a', description: 'y' },
        { name: 'a', description: 'z' },
      ]).ok,
    ).toBe(false);
    expect(withTools(['panel', 'tool'], [{ name: 'a', description: '' }]).ok).toBe(false);
    expect(
      withTools(
        ['panel', 'tool'],
        Array.from({ length: 17 }, (_, i) => ({ name: `t${i}`, description: 'y' })),
      ).ok,
    ).toBe(false);
  });

  it('panel.html 与 panel 槽必须成对出现', () => {
    // 有 html 无 panel 槽
    expect(validateGhostManifest({ ...goodChipManifest(), slots: ['model'] }).ok).toBe(false);
    // 有 panel 槽无 html
    const noHtml = goodChipManifest();
    (noHtml.panel as Record<string, unknown>).html = undefined;
    delete (noHtml.panel as Record<string, unknown>).html;
    expect(validateGhostManifest(noHtml).ok).toBe(false);
  });

  it('显式指令 command:字符规则 + 必须有工具可干活', () => {
    const chipWithTool = () => ({
      ...goodChipManifest(),
      slots: ['panel', 'tool'],
      tools: [{ name: 'gen_image', description: '生成图片' }],
    });
    expect(validateGhostManifest({ ...chipWithTool(), command: '画图' }).ok).toBe(true);
    expect(validateGhostManifest({ ...chipWithTool(), command: 'draw' }).ok).toBe(true);
    expect(validateGhostManifest({ ...chipWithTool(), command: '' }).ok).toBe(false);
    expect(validateGhostManifest({ ...chipWithTool(), command: 'a b' }).ok).toBe(false);
    expect(validateGhostManifest({ ...chipWithTool(), command: 'a/b' }).ok).toBe(false);
    expect(validateGhostManifest({ ...chipWithTool(), command: 'x'.repeat(33) }).ok).toBe(false);
    // 没有工具的指令无事可做
    expect(validateGhostManifest({ ...goodChipManifest(), command: '画图' }).ok).toBe(false);
  });

  it('settingsHtml 可选,给了必须是安全相对路径', () => {
    expect(validateGhostManifest({ ...goodChipManifest(), settingsHtml: 'settings.html' }).ok).toBe(true);
    expect(validateGhostManifest({ ...goodChipManifest(), settingsHtml: '../s.html' }).ok).toBe(false);
  });
});

describe('ghost · layoutWithGhostPanel(装入即停靠)', () => {
  const manifest = (): GhostManifest => ({
    schemaVersion: 2,
    id: 'hello',
    name: 'Hello 意识',
    version: '1.0.0',
    kind: 'chip',
    entry: 'main.js',
    slots: ['panel'],
    panel: { html: 'panel.html', minWidth: 240, defaultFraction: 0.18 },
  });

  it('新装缺省 position:停在主聊天窗右侧(默认 right,2026-07-12 定案)', () => {
    const next = layoutWithGhostPanel(createDefaultLayout(), manifest());
    expect(next).not.toBeNull();
    const split = next!.content as SplitNode;
    expect(split.children.map((c) => (c.node.type === 'pane' ? c.node.panelKind : '?'))).toEqual([
      'chat-main',
      'ghost:hello',
      'right-tabs',
    ]);
    const pane = split.children[1];
    expect(pane.fraction).toBeCloseTo(0.18, 5);
    expect(pane.node.type === 'pane' && pane.node.minWidth).toBe(240);
    // 全体份额仍归一
    expect(split.children.reduce((s, c) => s + c.fraction, 0)).toBeCloseTo(1, 5);
  });

  it("position: 'left' → 停在主聊天窗左侧(chat-main 之前)", () => {
    const m = manifest();
    m.panel!.position = 'left';
    const next = layoutWithGhostPanel(createDefaultLayout(), m);
    const split = next!.content as SplitNode;
    expect(split.children.map((c) => (c.node.type === 'pane' ? c.node.panelKind : '?'))).toEqual([
      'ghost:hello',
      'chat-main',
      'right-tabs',
    ]);
  });

  it('重装:树上已有同 kind 的 pane → 返回 null(位置记忆保留,原位复活)', () => {
    const first = layoutWithGhostPanel(createDefaultLayout(), manifest());
    expect(layoutWithGhostPanel(first!, manifest())).toBeNull();
  });

  it('没声明面板的意识 → null,树不动', () => {
    const m = manifest();
    delete m.panel;
    expect(layoutWithGhostPanel(createDefaultLayout(), m)).toBeNull();
  });

  it('清单未给 defaultFraction → 默认 0.2', () => {
    const m = manifest();
    delete m.panel!.defaultFraction;
    const next = layoutWithGhostPanel(createDefaultLayout(), m);
    // 缺省 position=right,面板在 chat-main 之后(下标 1)。
    expect((next!.content as SplitNode).children[1].fraction).toBeCloseTo(0.2, 5);
  });
});

describe('ghost · keywords(语义触发扩展词表)', () => {
  function chipWithKeywords(keywords: unknown): Record<string, unknown> {
    return {
      ...goodChipManifest(),
      slots: ['tool', 'panel'],
      tools: [{ name: 'gen_image', description: '生成图片' }],
      keywords,
    };
  }

  it('合法词表通过,重复词(大小写折叠)静默去重', () => {
    const v = validateGhostManifest(chipWithKeywords(['插画', '配图', 'Draw', 'draw ']));
    expect(v.ok, JSON.stringify(v)).toBe(true);
    if (v.ok) expect(v.manifest.keywords).toEqual(['插画', '配图', 'Draw']);
  });

  it('单字词 / 超长词 / 空数组 / 超过 8 个 → 拒', () => {
    expect(validateGhostManifest(chipWithKeywords(['画'])).ok).toBe(false);
    expect(validateGhostManifest(chipWithKeywords(['x'.repeat(25)])).ok).toBe(false);
    expect(validateGhostManifest(chipWithKeywords([])).ok).toBe(false);
    expect(validateGhostManifest(chipWithKeywords(Array(9).fill('插画'))).ok).toBe(false);
  });

  it('没 tools 光有 keywords → 拒', () => {
    const m = chipWithKeywords(['插画']);
    delete m.tools;
    m.slots = ['panel'];
    expect(validateGhostManifest(m).ok).toBe(false);
  });
});

describe('ghost · cindy 能力详单校验(字段旧名 model 别名兼容)', () => {
  function chipWithModel(model: unknown): Record<string, unknown> {
    return { ...goodChipManifest(), model };
  }

  it('合法详单:类目 image + 动作 generate/edit', () => {
    const v = validateGhostManifest(chipWithModel({ image: ['generate', 'edit'] }));
    expect(v.ok, JSON.stringify(v)).toBe(true);
    expect(v.ok && v.manifest.cindy).toEqual({ image: ['generate', 'edit'] });
  });

  it('有槽无详单允许装入(老包兼容,运行时零能力)', () => {
    const v = validateGhostManifest(goodChipManifest());
    expect(v.ok).toBe(true);
    expect(v.ok && v.manifest.cindy).toBeUndefined();
  });

  it('有详单但 slots 没有 model → 拒', () => {
    const m = chipWithModel({ image: ['generate'] });
    m.slots = ['panel'];
    const v = validateGhostManifest(m);
    expect(v.ok).toBe(false);
    expect(!v.ok && v.reason).toContain('cindy');
  });

  it('未知类目 / 未知动作 / 空数组 / 空对象 / 重复动作 / 非对象 → 拒', () => {
    for (const bad of [
      { text: ['complete'] },
      { image: ['upscale'] },
      { image: [] },
      {},
      { image: ['generate', 'generate'] },
      'image',
    ]) {
      const v = validateGhostManifest(chipWithModel(bad));
      expect(v.ok, JSON.stringify(bad)).toBe(false);
    }
  });

});

describe('ghost · model → cindy 旧名兼容(2026-07-11 更名)', () => {
  it("slots 里的 'model' 与字段 model 都归一化为 cindy(老包不消失)", () => {
    const v = validateGhostManifest({
      ...goodChipManifest(),
      slots: ['panel', 'model'],
      model: { image: ['generate'] },
    });
    expect(v.ok, JSON.stringify(v)).toBe(true);
    expect(v.ok && v.manifest.slots).toEqual(['panel', 'cindy']);
    expect(v.ok && v.manifest.cindy).toEqual({ image: ['generate'] });
    expect(v.ok && (v.manifest as unknown as Record<string, unknown>).model).toBeUndefined();
  });

  it("新旧名并存时以 cindy 为准;'model' 与 'cindy' 同列 slots 视为重复", () => {
    const both = validateGhostManifest({
      ...goodChipManifest(),
      slots: ['panel', 'cindy'],
      cindy: { image: ['generate', 'edit'] },
      model: { image: ['generate'] },
    });
    expect(both.ok && both.manifest.cindy).toEqual({ image: ['generate', 'edit'] });

    const dup = validateGhostManifest({ ...goodChipManifest(), slots: ['panel', 'model', 'cindy'] });
    expect(dup.ok).toBe(false);
  });
});

describe('ghost · subscribe 订阅详单校验(卡槽①,2026-07-12)', () => {
  const withSub = (subscribe: unknown, extra: Record<string, unknown> = {}) => ({
    ...goodManifest(),
    slots: ['panel', 'subscribe'],
    subscribe,
    ...extra,
  });

  it('topics 合法值放行并归一化进清单', () => {
    const r = validateGhostManifest(withSub({ topics: ['turn', 'session'] }));
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.manifest.subscribe).toEqual({ topics: ['turn', 'session'] });
  });

  it('hooks 必须搭配 launch:"resident",否则拒装', () => {
    const noResident = validateGhostManifest(withSub({ hooks: ['will-user-message'] }));
    expect(noResident.ok).toBe(false);
    if (!noResident.ok) expect(noResident.reason).toContain('resident');

    const ok = validateGhostManifest(
      withSub({ hooks: ['will-user-message'] }, { launch: 'resident' }),
    );
    expect(ok.ok).toBe(true);
    if (ok.ok) expect(ok.manifest.subscribe).toEqual({ hooks: ['will-user-message'] });
  });

  it('未知主题/钩子/空对象/空数组/无槽有详单一律拒', () => {
    expect(validateGhostManifest(withSub({ topics: ['messages'] })).ok).toBe(false);
    expect(validateGhostManifest(withSub({ hooks: ['will-tool-call'] }, { launch: 'resident' })).ok).toBe(false);
    expect(validateGhostManifest(withSub({})).ok).toBe(false);
    expect(validateGhostManifest(withSub({ topics: [] })).ok).toBe(false);
    expect(validateGhostManifest(withSub({ topics: ['turn', 'turn'] })).ok).toBe(false);
    expect(
      validateGhostManifest({ ...goodManifest(), subscribe: { topics: ['turn'] } }).ok,
    ).toBe(false); // slots 没含 subscribe
  });

  it('有槽无详单允许装入(零事件,老包语义)', () => {
    const r = validateGhostManifest({ ...goodManifest(), slots: ['panel', 'subscribe'] });
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.manifest.subscribe).toBeUndefined();
  });

  it('权限清单两档:hooks 排最顶加重,topics 常规位;无详单不列', () => {
    const both = validateGhostManifest(
      withSub({ topics: ['turn'], hooks: ['will-user-message'] }, { launch: 'resident' }),
    );
    expect(both.ok).toBe(true);
    if (both.ok) {
      const items = ghostPermissionItems(both.manifest);
      expect(items[0]).toMatchObject({ key: 'subscribe:hooks', labelKey: 'subscribeHooks' });
      expect(items.some((i) => i.key === 'subscribe:topics')).toBe(true);
    }
    const bare = validateGhostManifest({ ...goodManifest(), slots: ['panel', 'subscribe'] });
    if (bare.ok) {
      expect(ghostPermissionItems(bare.manifest).some((i) => i.kind === 'subscribe')).toBe(false);
    }
  });

  it('will-assistant-message:出口钩子合法(继承 resident 要求),单列一档权限行', () => {
    const noResident = validateGhostManifest(withSub({ hooks: ['will-assistant-message'] }));
    expect(noResident.ok).toBe(false); // resident 要求 key 在 hooks 非空,自动覆盖新钩子

    const both = validateGhostManifest(
      withSub(
        { hooks: ['will-user-message', 'will-assistant-message'] },
        { launch: 'resident' },
      ),
    );
    expect(both.ok).toBe(true);
    if (both.ok) {
      const items = ghostPermissionItems(both.manifest);
      // 两个钩点各一行,都在最顶(拦截最重),入口在出口之前。
      expect(items[0]).toMatchObject({ key: 'subscribe:hooks', labelKey: 'subscribeHooks' });
      expect(items[1]).toMatchObject({
        key: 'subscribe:hooks:assistant',
        labelKey: 'subscribeAssistantReply',
      });
    }
    // 只声明出口钩子:只出该行,不误带入口行。
    const outOnly = validateGhostManifest(
      withSub({ hooks: ['will-assistant-message'] }, { launch: 'resident' }),
    );
    if (outOnly.ok) {
      const items = ghostPermissionItems(outOnly.manifest);
      expect(items.some((i) => i.key === 'subscribe:hooks:assistant')).toBe(true);
      expect(items.some((i) => i.key === 'subscribe:hooks')).toBe(false);
    }
  });
});

describe('ghost · description(自我介绍)', () => {
  it('可选携带,原样输出;超长/空串/非字符串拒', () => {
    const base = validateGhostManifest({ ...goodManifest(), description: '画图小助手' });
    expect(base.ok && base.manifest.description).toBe('画图小助手');
    const chip = validateGhostManifest({ ...goodChipManifest(), description: '画图小助手' });
    expect(chip.ok && chip.manifest.description).toBe('画图小助手');

    for (const bad of ['', '  ', 'x'.repeat(301), 42]) {
      expect(validateGhostManifest({ ...goodManifest(), description: bad }).ok, JSON.stringify(bad)).toBe(false);
    }
  });
});

describe('ghost · panel.position 校验', () => {
  it('left/right 通过并进清单;top/bottom 收词但明确拒绝;野值拒', () => {
    const withPos = (position: unknown) => ({
      ...goodManifest(),
      panel: { title: 'Hello', html: 'panel.html', position },
    });
    const left = validateGhostManifest(withPos('left'));
    expect(left.ok && left.manifest.panel?.position).toBe('left');
    const right = validateGhostManifest(withPos('right'));
    expect(right.ok && right.manifest.panel?.position).toBe('right');

    for (const pending of ['top', 'bottom']) {
      const v = validateGhostManifest(withPos(pending));
      expect(v.ok).toBe(false);
      expect(!v.ok && v.reason).toContain('暂未支持');
    }
    expect(validateGhostManifest(withPos('center')).ok).toBe(false);
  });
});

describe('ghost · whenToUse(语义召回线索)', () => {
  it('可带并原样输出;超长/空串拒', () => {
    const chip = validateGhostManifest({ ...goodChipManifest(), whenToUse: '需要出图时找我' });
    expect(chip.ok && chip.manifest.whenToUse).toBe('需要出图时找我');
    expect(validateGhostManifest({ ...goodChipManifest(), whenToUse: '' }).ok).toBe(false);
    expect(validateGhostManifest({ ...goodChipManifest(), whenToUse: 'x'.repeat(301) }).ok).toBe(false);
  });
});

describe('ghost · cindy 详单 video 类目(C3c-5)', () => {
  const withCindy = (cindy: unknown): Record<string, unknown> => ({
    ...goodChipManifest(),
    slots: ['panel', 'cindy'],
    cindy,
  });

  it('video 类目合法收入;image/video 可并存', () => {
    const v = validateGhostManifest(withCindy({ video: ['generate', 'edit'] }));
    expect(v.ok && v.manifest.cindy?.video).toEqual(['generate', 'edit']);
    const both = validateGhostManifest(withCindy({ image: ['generate'], video: ['generate'] }));
    expect(both.ok && both.manifest.cindy?.image).toEqual(['generate']);
    expect(both.ok && both.manifest.cindy?.video).toEqual(['generate']);
  });

  it('video 未知动作 / 空数组 / 重复动作 → 拒;错误话术带类目名', () => {
    const bad = validateGhostManifest(withCindy({ video: ['transcode'] }));
    expect(bad.ok).toBe(false);
    expect(!bad.ok && bad.reason).toContain('video');
    expect(validateGhostManifest(withCindy({ video: [] })).ok).toBe(false);
    expect(validateGhostManifest(withCindy({ video: ['generate', 'generate'] })).ok).toBe(false);
  });

  it('未知类目报错列出全部支持类目(image / video)', () => {
    const bad = validateGhostManifest(withCindy({ audio: ['generate'] }));
    expect(bad.ok).toBe(false);
    expect(!bad.ok && bad.reason).toContain('video');
  });

  it('权限清单推导:video 详单产出对应权限项(确认框自动吃到)', () => {
    const v = validateGhostManifest(withCindy({ image: ['generate'], video: ['generate', 'edit'] }));
    expect(v.ok).toBe(true);
    if (!v.ok) return;
    const keys = ghostPermissionItems(v.manifest).filter((i) => i.kind === 'cindy').map((i) => i.key);
    expect(keys).toEqual(['cindy:image.generate', 'cindy:video.generate', 'cindy:video.edit']);
    const labels = ghostPermissionItems(v.manifest).filter((i) => i.kind === 'cindy').map((i) => i.labelKey);
    expect(labels).toContain('cindyVideoGenerate');
    expect(labels).toContain('cindyVideoEdit');
  });

});

describe('ghost · 逐项权限清单(C3c-1)', () => {
  /** 全能力芯片清单:cindy 两动作 + 两工具 + 指令 + 左停面板。 */
  const fullChip = (): GhostManifest => ({
    schemaVersion: 2,
    id: 'art-like',
    name: '画图',
    version: '1.0.0',
    kind: 'chip',
    entry: 'main.js',
    slots: ['panel', 'cindy', 'tool'],
    cindy: { image: ['generate', 'edit'] },
    tools: [
      { name: 'gen_image', description: '出图' },
      { name: 'edit_image', description: '改图' },
    ],
    command: '画图',
    panel: { title: '画廊', html: 'panel.html', position: 'left' },
  });

  it('推导顺序与内容:cindy → 工具 → 指令 → 面板 → 代码', () => {
    const items = ghostPermissionItems(fullChip());
    expect(items.map((i) => i.key)).toEqual([
      'cindy:image.generate',
      'cindy:image.edit',
      'tool:gen_image',
      'tool:edit_image',
      'command:画图',
      'panel:left',
      'code',
    ]);
    const tool = items.find((i) => i.key === 'tool:gen_image');
    expect(tool).toMatchObject({ kind: 'tool', labelKey: 'tool', labelArgs: { name: 'gen_image' }, detail: '出图' });
    const panel = items.find((i) => i.kind === 'panel');
    expect(panel).toMatchObject({ labelKey: 'panelLeft', labelArgs: { title: '画廊' } });
    expect(items.find((i) => i.kind === 'code')).toMatchObject({ detailKey: 'codeDetail' });
  });

  it('缺省推导:面板缺 position 记 right、缺 title 用意识名;有槽无详单 = 零 cindy 项', () => {
    const plain: GhostManifest = {
      schemaVersion: 2,
      id: 'plain',
      name: '说明书',
      version: '1.0.0',
      kind: 'chip',
      entry: 'main.js',
      slots: ['panel'],
      panel: { html: 'panel.html' },
    };
    const items = ghostPermissionItems(plain);
    expect(items.map((i) => i.key)).toEqual(['panel:right', 'code']);
    expect(items[0]).toMatchObject({ labelKey: 'panelRight', labelArgs: { title: '说明书' } });

    const chipNoNeeds: GhostManifest = {
      schemaVersion: 2,
      id: 'c',
      name: 'C',
      version: '1.0.0',
      kind: 'chip',
      entry: 'main.js',
      slots: ['cindy', 'tool'],
      tools: [{ name: 't', description: 'd' }],
    };
    expect(ghostPermissionItems(chipNoNeeds).filter((i) => i.kind === 'cindy')).toEqual([]);
  });

  it('diff:新增/移除按稳定 key 对齐,面板换边 = 移除+新增,unchanged 取新版条目', () => {
    const prev = fullChip();
    const next: GhostManifest = {
      ...fullChip(),
      version: '2.0.0',
      cindy: { image: ['generate'] }, // 移除 edit
      tools: [...(fullChip().tools ?? []), { name: 'style_image', description: '风格化' }], // 新增工具
      panel: { title: '画廊', html: 'panel.html', position: 'right' }, // 换边
    };
    const diff = diffGhostPermissionItems(prev, next);
    expect(diff.added.map((i) => i.key).sort()).toEqual(['panel:right', 'tool:style_image']);
    expect(diff.removed.map((i) => i.key).sort()).toEqual(['cindy:image.edit', 'panel:left']);
    expect(diff.unchanged.map((i) => i.key)).toEqual([
      'cindy:image.generate',
      'tool:gen_image',
      'tool:edit_image',
      'command:画图',
      'code',
    ]);
  });

  it('diff:完全一致 → added/removed 皆空', () => {
    const d = diffGhostPermissionItems(fullChip(), { ...fullChip(), version: '1.0.1' });
    expect(d.added).toEqual([]);
    expect(d.removed).toEqual([]);
    expect(d.unchanged.length).toBe(7);
  });
});

describe('ghost · launch 启动模式(2026-07-12)', () => {
  it('缺省合法:不写 launch → 清单不含该字段(运行时按 on-demand 处理)', () => {
    const v = validateGhostManifest(goodManifest());
    expect(v.ok).toBe(true);
    if (v.ok) expect(v.manifest.launch).toBeUndefined();
  });

  it('两个合法值原样收入', () => {
    for (const launch of ['on-demand', 'resident'] as const) {
      const v = validateGhostManifest({ ...goodManifest(), launch });
      expect(v.ok, launch).toBe(true);
      if (v.ok) expect(v.manifest.launch).toBe(launch);
    }
  });

  it('未知值拒绝(不静默降级,规则 9)', () => {
    for (const launch of ['always', 'RESIDENT', 42, null, {}]) {
      const v = validateGhostManifest({ ...goodManifest(), launch });
      expect(v.ok, String(launch)).toBe(false);
      if (!v.ok) expect(v.reason).toContain('launch');
    }
  });

  it('resident → 权限清单多一行"常驻运行"(排在可执行代码之前);on-demand 不列', () => {
    const base = validateGhostManifest(goodManifest());
    expect(base.ok).toBe(true);
    if (!base.ok) return;
    expect(ghostPermissionItems(base.manifest).map((i) => i.key)).not.toContain('resident');

    const res = validateGhostManifest({ ...goodManifest(), launch: 'resident' });
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    const keys = ghostPermissionItems(res.manifest).map((i) => i.key);
    expect(keys.indexOf('resident')).toBeGreaterThanOrEqual(0);
    expect(keys.indexOf('resident')).toBeLessThan(keys.indexOf('code'));
  });
});

describe('ghost · 官方保留 id 前缀(cindy-)', () => {
  it('isOfficialGhostId:cindy- 前缀命中,其它不命中', () => {
    expect(isOfficialGhostId('cindy-web-search')).toBe(true);
    expect(isOfficialGhostId('cindy-art')).toBe(true);
    // 前缀必须完整命中:cindyart 无连字符、my-cindy- 前缀不在最左都不算官方。
    expect(isOfficialGhostId('cindyart')).toBe(false);
    expect(isOfficialGhostId('my-cindy-tool')).toBe(false);
    expect(isOfficialGhostId('web-search')).toBe(false);
  });
});

describe('ghost · network 域名条目格式与匹配(C4)', () => {
  it('合法条目:小写域名至少两段,通配只允许最左一段', () => {
    for (const p of ['api.example.com', 'example.com', '*.weather.com', 'a-b.c1.io']) {
      expect(isValidGhostNetworkHostPattern(p), p).toBe(true);
    }
  });

  it('非法条目:裸 TLD/单段/IP/端口/路径/协议/大写/中缀通配', () => {
    for (const p of [
      'com', '*.com', 'localhost', '127.0.0.1', 'api.example.com:8080',
      'api.example.com/v1', 'https://api.example.com', 'API.Example.com',
      'a.*.example.com', 'api.*.com', '', 42, null, '-bad.example.com',
    ]) {
      expect(isValidGhostNetworkHostPattern(p), String(p)).toBe(false);
    }
  });

  it('匹配语义:精确逐字;通配只命中子域不命中裸域', () => {
    expect(ghostNetworkHostMatches('api.example.com', 'api.example.com')).toBe(true);
    expect(ghostNetworkHostMatches('api.example.com', 'evil-api.example.com')).toBe(false);
    expect(ghostNetworkHostMatches('*.example.com', 'a.example.com')).toBe(true);
    expect(ghostNetworkHostMatches('*.example.com', 'a.b.example.com')).toBe(true);
    expect(ghostNetworkHostMatches('*.example.com', 'example.com')).toBe(false);
    // 后缀伪装:evilexample.com 不该命中 *.example.com
    expect(ghostNetworkHostMatches('*.example.com', 'evilexample.com')).toBe(false);
  });
});

describe('ghost · network 详单校验(C4)', () => {
  const withNet = (network: unknown, extra: Record<string, unknown> = {}) => ({
    ...goodManifest(),
    slots: ['panel', 'network'],
    // user 凭证一律意识收单(2026-07-13 宿主凭证渲染退役),声明 user 凭证
    // 必须带 settingsHtml——secrets 用例默认给上,免逐个重复;extra 可覆盖。
    settingsHtml: 'settings.html',
    network,
    ...extra,
  });
  const goodSecret = () => ({
    key: 'api_token',
    label: 'Example API Token',
    hint: '在 example.com/settings 生成',
    inject: { header: 'Authorization', format: 'Bearer {value}' },
  });

  it('hosts 合法放行并归一化(小写化/去首尾空白)', () => {
    const r = validateGhostManifest(withNet({ hosts: [' API.Search.Brave.com ', '*.tavily.com'] }));
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.manifest.network).toEqual({ hosts: ['api.search.brave.com', '*.tavily.com'] });
  });

  it('hosts 缺失/空/超上限/重复/非法条目一律拒', () => {
    expect(validateGhostManifest(withNet({})).ok).toBe(false);
    expect(validateGhostManifest(withNet({ hosts: [] })).ok).toBe(false);
    expect(validateGhostManifest(withNet({ hosts: Array.from({ length: 9 }, (_, i) => `h${i}.example.com`) })).ok).toBe(false);
    expect(validateGhostManifest(withNet({ hosts: ['a.example.com', 'A.Example.com'] })).ok).toBe(false);
    expect(validateGhostManifest(withNet({ hosts: ['localhost'] })).ok).toBe(false);
  });

  it('成对约束:有详单必有槽;有槽无详单允许装入(零能力)', () => {
    expect(validateGhostManifest({ ...goodManifest(), network: { hosts: ['api.example.com'] } }).ok).toBe(false);
    const bare = validateGhostManifest({ ...goodManifest(), slots: ['panel', 'network'] });
    expect(bare.ok).toBe(true);
    if (bare.ok) expect(bare.manifest.network).toBeUndefined();
  });

  it('secrets:合法声明放行,inject 绑定归一化进清单', () => {
    const r = validateGhostManifest(
      withNet({ hosts: ['api.example.com'], secrets: [goodSecret()] }),
    );
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.manifest.network?.secrets?.[0]).toEqual(goodSecret());
    }
  });

  it('secrets.url:https 控制台地址放行;http/内嵌凭证/非法地址拒', () => {
    const withUrl = (url: unknown) =>
      withNet({ hosts: ['api.example.com'], secrets: [{ ...goodSecret(), url }] });
    const ok = validateGhostManifest(withUrl('https://example.com/settings/keys'));
    expect(ok.ok).toBe(true);
    if (ok.ok) expect(ok.manifest.network?.secrets?.[0]?.url).toBe('https://example.com/settings/keys');
    for (const bad of ['http://example.com/keys', 'https://user:pw@example.com/', 'not-a-url', '', 42]) {
      expect(validateGhostManifest(withUrl(bad)).ok, String(bad)).toBe(false);
    }
  });

  it('secrets.source:login-email 收入清单;user 归一化省略;野值拒;login-email 带 url 拒', () => {
    const withSource = (secret: Record<string, unknown>) =>
      validateGhostManifest(withNet({ hosts: ['api.example.com'], secrets: [secret] }));

    // login-email:原样收入(设置页据此只读展示登录邮箱)。
    const identity = withSource({
      key: 'pages_token',
      label: 'Pages 身份',
      source: 'login-email',
      inject: { header: 'X-Pages-Token', format: 'pages_{value}' },
    });
    expect(identity.ok).toBe(true);
    if (identity.ok) expect(identity.manifest.network?.secrets?.[0]?.source).toBe('login-email');

    // 'user' 与缺省同义:归一化后不落清单(权限 diff 不 churn)。
    const explicit = withSource({ ...goodSecret(), source: 'user' });
    expect(explicit.ok).toBe(true);
    if (explicit.ok) expect(explicit.manifest.network?.secrets?.[0]?.source).toBeUndefined();

    for (const bad of ['email', 'host-email', '', 42, {}]) {
      expect(withSource({ ...goodSecret(), source: bad }).ok, String(bad)).toBe(false);
    }
    // login-email 没有"前往控制台"可去,声明 url 是清单自相矛盾。
    expect(
      withSource({
        ...goodSecret(),
        source: 'login-email',
        url: 'https://example.com/console',
      }).ok,
    ).toBe(false);
    // login-email + exchange 组合被禁:登录邮箱不外送交换端点。
    expect(
      withSource({
        ...goodSecret(),
        source: 'login-email',
        exchange: {
          url: 'https://api.example.com/token',
          bodyFormat: '{"sub":"{value}"}',
          tokenPath: 'session',
        },
      }).ok,
    ).toBe(false);
  });

  it('secrets.source:login-feishu-token 已退役:一律拒装(存量清单由播种器覆盖自愈)', () => {
    const r = validateGhostManifest(
      withNet({
        hosts: ['open.feishu.cn'],
        secrets: [
          {
            key: 'feishu_uat',
            label: '飞书登录身份',
            source: 'login-feishu-token',
            inject: { header: 'Authorization', format: 'Bearer {value}' },
          },
        ],
      }),
    );
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toContain('source');
  });

  it('权限清单:login-email 凭证用"将使用登录邮箱"分档文案,key 与 user 凭证同构', () => {
    const r = validateGhostManifest(
      withNet({
        hosts: ['api.example.com'],
        secrets: [
          goodSecret(),
          {
            key: 'pages_token',
            label: 'Pages 身份',
            source: 'login-email',
            inject: { header: 'X-Pages-Token', format: 'pages_{value}' },
          },
        ],
      }),
    );
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const items = ghostPermissionItems(r.manifest);
    const userItem = items.find((i) => i.key === 'network:secret:api_token');
    expect(userItem?.labelKey).toBe('networkSecret');
    expect(userItem?.detailKey).toBe('networkSecretGhostInputDetail');
    const identityItem = items.find((i) => i.key === 'network:secret:pages_token');
    expect(identityItem?.labelKey).toBe('networkSecretIdentity');
    expect(identityItem?.detailKey).toBe('networkSecretIdentityDetail');
  });

  it('secrets:key 格式/重复、label 缺失、inject 缺失/坏 header/坏 format 一律拒', () => {
    const bads: Array<Record<string, unknown>> = [
      { ...goodSecret(), key: 'Bad-Key' },
      { ...goodSecret(), key: '_x' },
      { ...goodSecret(), label: '' },
      { key: 'a', label: 'A' }, // 无 inject
      { ...goodSecret(), inject: { header: 'Host', format: '{value}' } }, // 协议关键头
      { ...goodSecret(), inject: { header: 'Cookie', format: '{value}' } },
      { ...goodSecret(), inject: { header: 'Content-Type', format: '{value}' } }, // 上传通道 boundary 依赖,禁占用
      { ...goodSecret(), inject: { header: 'X Token', format: '{value}' } }, // 头名带空格
      { ...goodSecret(), inject: { header: 'Authorization', format: 'Bearer' } }, // 无占位
      { ...goodSecret(), inject: { header: 'Authorization', format: '{value}{value}' } }, // 双占位
    ];
    for (const s of bads) {
      const r = validateGhostManifest(withNet({ hosts: ['api.example.com'], secrets: [s] }));
      expect(r.ok, JSON.stringify(s)).toBe(false);
    }
    const dup = validateGhostManifest(
      withNet({ hosts: ['api.example.com'], secrets: [goodSecret(), goodSecret()] }),
    );
    expect(dup.ok).toBe(false);
  });

  it('secrets.inject.hosts 必须是 hosts 声明条目的子集(逐字)', () => {
    const ok = validateGhostManifest(
      withNet({
        hosts: ['api.brave.com', 'api.tavily.com'],
        secrets: [{ ...goodSecret(), inject: { header: 'X-Token', format: '{value}', hosts: ['api.brave.com'] } }],
      }),
    );
    expect(ok.ok).toBe(true);

    const outside = validateGhostManifest(
      withNet({
        hosts: ['api.brave.com'],
        secrets: [{ ...goodSecret(), inject: { header: 'X-Token', format: '{value}', hosts: ['api.other.com'] } }],
      }),
    );
    expect(outside.ok).toBe(false);
    // 子域字符串 ≠ 声明的通配条目本身:必须逐字取声明条目
    const literal = validateGhostManifest(
      withNet({
        hosts: ['*.tavily.com'],
        secrets: [{ ...goodSecret(), inject: { header: 'X-Token', format: '{value}', hosts: ['api.tavily.com'] } }],
      }),
    );
    expect(literal.ok).toBe(false);
  });

  it('secrets.exchange:合法二段式声明放行并归一化(含缺省字段省略)', () => {
    const exchange = {
      url: 'https://api.example.com/api/v1/state/token',
      bodyFormat: '{"id":"","sub":"{value}","name":""}',
      tokenPath: 'session',
    };
    const r = validateGhostManifest(
      withNet({ hosts: ['api.example.com'], secrets: [{ ...goodSecret(), exchange }] }),
    );
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.manifest.network?.secrets?.[0]?.exchange).toEqual(exchange);

    const full = validateGhostManifest(
      withNet({
        hosts: ['api.example.com'],
        secrets: [{
          ...goodSecret(),
          exchange: {
            ...exchange,
            contentType: 'application/x-www-form-urlencoded',
            tokenPath: 'data.token',
            ttlSeconds: 86400,
          },
        }],
      }),
    );
    expect(full.ok).toBe(true);
    if (full.ok) {
      expect(full.manifest.network?.secrets?.[0]?.exchange?.contentType).toBe('application/x-www-form-urlencoded');
      expect(full.manifest.network?.secrets?.[0]?.exchange?.ttlSeconds).toBe(86400);
    }
  });

  it('secrets.exchange:坏 url/域名出白名单/坏模板/坏 contentType/坏 tokenPath/坏 ttl 一律拒', () => {
    const good = {
      url: 'https://api.example.com/token',
      bodyFormat: '{"sub":"{value}"}',
      tokenPath: 'session',
    };
    const bads: Array<Record<string, unknown>> = [
      { ...good, url: 'http://api.example.com/token' }, // 非 https
      { ...good, url: 'https://api.example.com:8443/token' }, // 非默认端口
      { ...good, url: 'https://user:pw@api.example.com/token' }, // 内嵌凭证
      { ...good, url: 'https://api.other.com/token' }, // 域名不在白名单
      { ...good, bodyFormat: '{"sub":"key"}' }, // 无 {value} 占位
      { ...good, bodyFormat: '{value}{value}' }, // 双占位
      { ...good, contentType: 'text/plain' }, // contentType 不在白名单
      { ...good, tokenPath: '' },
      { ...good, tokenPath: 'a..b' }, // 空段
      { ...good, tokenPath: 'a[0].b' }, // 数组下标不支持
      { ...good, ttlSeconds: 30 }, // 低于下限
      { ...good, ttlSeconds: 90 * 24 * 3600 }, // 超上限
      { ...good, ttlSeconds: 3600.5 }, // 非整数
    ];
    for (const exchange of bads) {
      const r = validateGhostManifest(
        withNet({ hosts: ['api.example.com'], secrets: [{ ...goodSecret(), exchange }] }),
      );
      expect(r.ok, JSON.stringify(exchange)).toBe(false);
    }
    // exchange 非对象也拒
    const notObj = validateGhostManifest(
      withNet({ hosts: ['api.example.com'], secrets: [{ ...goodSecret(), exchange: 'yes' }] }),
    );
    expect(notObj.ok).toBe(false);
  });

  it('权限清单:域名与凭证逐条列(在工具之前),code 说明换 network 分档版', () => {
    const r = validateGhostManifest(
      withNet({
        hosts: ['api.brave.com', '*.tavily.com'],
        secrets: [goodSecret()],
      }),
    );
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const items = ghostPermissionItems(r.manifest);
    const keys = items.map((i) => i.key);
    expect(keys).toContain('network:host:api.brave.com');
    expect(keys).toContain('network:host:*.tavily.com');
    expect(keys).toContain('network:secret:api_token');
    const secretItem = items.find((i) => i.key === 'network:secret:api_token');
    expect(secretItem).toMatchObject({ kind: 'network', labelKey: 'networkSecret', labelArgs: { name: 'Example API Token' } });
    const code = items.find((i) => i.key === 'code');
    expect(code?.detailKey).toBe('codeDetailNetwork');
    // 无 network 槽的意识维持原说明
    const plain = validateGhostManifest(goodManifest());
    if (plain.ok) {
      expect(ghostPermissionItems(plain.manifest).find((i) => i.key === 'code')?.detailKey).toBe('codeDetail');
    }
  });

  it('内容清单含 slotNetwork;更新 diff 能对出新增域名', () => {
    const v1 = validateGhostManifest(withNet({ hosts: ['api.brave.com'] }));
    const v2 = validateGhostManifest(withNet({ hosts: ['api.brave.com', 'evil.example.com'] }));
    expect(v1.ok && v2.ok).toBe(true);
    if (!v1.ok || !v2.ok) return;
    expect(ghostContentKeys(v2.manifest)).toContain('slotNetwork');
    const diff = diffGhostPermissionItems(v1.manifest, v2.manifest);
    expect(diff.added.map((i) => i.key)).toContain('network:host:evil.example.com');
    expect(diff.removed).toHaveLength(0);
  });

  it('notify 槽过校验;内容清单含 slotNotify、权限清单出 notify 条目(带主机说明)', () => {
    const r = validateGhostManifest({ ...goodManifest(), slots: ['panel', 'notify'] });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(ghostContentKeys(r.manifest)).toContain('slotNotify');
    const item = ghostPermissionItems(r.manifest).find((i) => i.key === 'notify');
    expect(item).toMatchObject({ kind: 'notify', labelKey: 'notify', detailKey: 'notifyDetail' });
  });

  it('内置意识 cindy-web-search 的身份卡永远过校验(随包种子即契约,防腐烂)', () => {
    const p = path.join(
      path.dirname(fileURLToPath(import.meta.url)),
      '../../../resources/builtin-ghosts/cindy-web-search/ghost.json',
    );
    const r = validateGhostManifest(JSON.parse(fs.readFileSync(p, 'utf-8')));
    expect(r.ok, r.ok ? '' : r.reason).toBe(true);
    if (!r.ok) return;
    expect(r.manifest.id).toBe('cindy-web-search');
    expect(r.manifest.network?.hosts).toEqual(['api.search.brave.com', 'api.tavily.com']);
    expect(r.manifest.network?.secrets?.map((s) => s.key)).toEqual(['brave_api_key', 'tavily_api_key']);
  });

  it('内置意识 xd-pages 的身份卡永远过校验(登录邮箱派生凭证 + 5 工具)', () => {
    const p = path.join(
      path.dirname(fileURLToPath(import.meta.url)),
      '../../../resources/builtin-ghosts/xd-pages/ghost.json',
    );
    const r = validateGhostManifest(JSON.parse(fs.readFileSync(p, 'utf-8')));
    expect(r.ok, r.ok ? '' : r.reason).toBe(true);
    if (!r.ok) return;
    expect(r.manifest.id).toBe('xd-pages');
    expect(r.manifest.network?.hosts).toEqual(['api.workers.xd.team']);
    const secret = r.manifest.network?.secrets?.[0];
    expect(secret?.key).toBe('pages_token');
    expect(secret?.source).toBe('login-email');
    expect(secret?.inject).toEqual({ header: 'X-Pages-Token', format: 'pages_{value}' });
    expect(r.manifest.tools?.map((t) => t.name)).toEqual([
      'pages_deploy',
      'pages_list',
      'pages_info',
      'pages_delete',
      'pages_get_worker_template',
    ]);
  });

  it('内置意识 cindy-github 的身份卡永远过校验(user 凭证 PAT + 两段式目录 2 元工具)', () => {
    const p = path.join(
      path.dirname(fileURLToPath(import.meta.url)),
      '../../../resources/builtin-ghosts/cindy-github/ghost.json',
    );
    const r = validateGhostManifest(JSON.parse(fs.readFileSync(p, 'utf-8')));
    expect(r.ok, r.ok ? '' : r.reason).toBe(true);
    if (!r.ok) return;
    expect(r.manifest.id).toBe('cindy-github');
    // 白名单三条:API 主域 + Actions 产物/日志 302 跳转的两个下载域;
    // PAT 只注入 api.github.com(Bearer 不跟去下载域)。
    expect(r.manifest.network?.hosts).toEqual([
      'api.github.com',
      'objects.githubusercontent.com',
      '*.blob.core.windows.net',
    ]);
    const secret = r.manifest.network?.secrets?.[0];
    expect(secret?.key).toBe('github_pat');
    // 来源缺省 'user',校验归一化后不落清单(见 ghost.ts 的 source 归一化)。
    expect(secret?.source).toBeUndefined();
    expect(secret?.inject).toEqual({ header: 'Authorization', format: 'Bearer {value}', hosts: ['api.github.com'] });
    expect(r.manifest.settingsHtml).toBe('settings.html');
    // 两段式目录(FORGE_GUIDE §3.5):117 个操作在电子脑目录里,不平铺进 tools。
    expect(r.manifest.tools?.map((t) => t.name)).toEqual(['list_tools', 'call_tool']);
  });

  it('内置意识 xd-mivo 的身份卡永远过校验(exchange 二段式 + OSS 取件域 + 13 工具)', () => {
    const p = path.join(
      path.dirname(fileURLToPath(import.meta.url)),
      '../../../resources/builtin-ghosts/xd-mivo/ghost.json',
    );
    const r = validateGhostManifest(JSON.parse(fs.readFileSync(p, 'utf-8')));
    expect(r.ok, r.ok ? '' : r.reason).toBe(true);
    if (!r.ok) return;
    expect(r.manifest.id).toBe('xd-mivo');
    // 自绘设置区:mivo key 由意识自己收单(经 /secrets 只写通道入库),
    // 宿主凭证渲染已整体退役,input 字段随之退役、归一化后不落清单;
    // 保管与注入仍在主机(2026-07-13 Lizi 定案)。
    // 不声明 settingsHeight = 高度随内容自适应。
    expect(r.manifest.settingsHtml).toBe('settings.html');
    expect(r.manifest.settingsHeight).toBeUndefined();
    expect(ghostContentKeys(r.manifest)).toContain('settingsUi');
    // OSS 通配域是 307 取件地基(全 region 收口 *.aliyuncs.com,mivo 桶不一定
    // 在 shanghai);凭证注入范围必须锁 aigc(Bearer 不去 OSS)。
    expect(r.manifest.network?.hosts).toEqual(['aigc.xindong.com', '*.aliyuncs.com']);
    const secret = r.manifest.network?.secrets?.[0];
    expect(secret?.key).toBe('mivo_api_key');
    expect(secret && 'input' in secret).toBe(false);
    expect(secret?.inject.hosts).toEqual(['aigc.xindong.com']);
    // exchange 二段式声明:主机代办 key→session,tokenPath 指向 session 字段。
    expect(secret?.exchange).toEqual({
      url: 'https://aigc.xindong.com/api/v1/state/token',
      bodyFormat: '{"id":"","sub":"{value}","name":""}',
      tokenPath: 'session',
      ttlSeconds: 86400,
    });
    expect(r.manifest.tools?.map((t) => t.name)).toEqual([
      'submit_gen_image',
      'poll_result',
      'segment_image',
      'super_resolution_image',
      'mivo_button_action',
      'submit_gen_video',
      'submit_gen_music',
      'submit_gen_sound_effect',
      'submit_gen_3d_model',
      'poll_3d_result',
      // convert 双路落地(2026-07-13):GLB 入媒体库,FBX/OBJ_ZIP 凭
      // save_dir 票据(as:'file')直写用户目录,绕开总仓只收 GLB 的限制。
      'convert_3d_model_format',
      'animate_3d_model',
      'download_file',
    ]);
  });

  it('内置意识 cindy-slack 的身份卡永远过校验(broker 弹跳回调 + 逗号 scope + MCP 网关 3 工具)', () => {
    const p = path.join(
      path.dirname(fileURLToPath(import.meta.url)),
      '../../../resources/builtin-ghosts/cindy-slack/ghost.json',
    );
    const r = validateGhostManifest(JSON.parse(fs.readFileSync(p, 'utf-8')));
    expect(r.ok, r.ok ? '' : r.reason).toBe(true);
    if (!r.ok) return;
    expect(r.manifest.id).toBe('cindy-slack');
    // slack.com = 授权/tokenUrl/identity 的声明域;mcp.slack.com = MCP 数据面。
    // Bearer 只注入 mcp.slack.com(授权域不吃意识发起的注入)。
    expect(r.manifest.network?.hosts).toEqual(['slack.com', 'mcp.slack.com']);
    const secret = r.manifest.network?.secrets?.[0];
    expect(secret?.key).toBe('slack_account');
    expect(secret?.source).toBe('oauth');
    expect(secret?.inject.hosts).toEqual(['mcp.slack.com']);
    // broker 模式 + 双地址弹跳:Slack 后台只收 https redirect,redirect_uri =
    // broker 基地址 + path(运行时拼),302 回本机 53683 的 callbackPath。
    expect(secret?.oauth?.tokenBroker).toBe('slack');
    expect(secret?.oauth?.pkce).toBe(false);
    expect(secret?.oauth?.redirectPort).toBe(53683);
    expect(secret?.oauth?.brokerBounce).toEqual({
      path: '/slack-mcp/bounce',
      callbackPath: '/slack-mcp/callback',
    });
    // Slack 的 scope 参数是逗号分隔(OAuth 标准的空格拼接 Slack 不认)。
    expect(secret?.oauth?.scopeDelimiter).toBe(',');
    // 同身份合并键 = auth.test 的 user_id(与 slackAccountsMigration 迁移
    // 老账号时写入的 label 同源,重连才能命中合并而不是堆多行);展示名走
    // displayTemplate 渲染("workspace · 用户名",user_id 只认不读)。
    expect(secret?.oauth?.identity).toEqual({
      url: 'https://slack.com/api/auth.test',
      labelPath: 'user_id',
      displayTemplate: '{team} · {user}',
    });
    // 写 scope 必须在清单里(设置页"只读连接"走 connect 的 scopes 子集参数)。
    expect(secret?.oauth?.scopes).toContain('chat:write');
    expect(secret?.oauth?.scopes).toContain('reactions:write');
    // 工具面 = Slack 官方托管 MCP 的两工具网关 + 账号自省。
    expect(r.manifest.tools?.map((t) => t.name)).toEqual([
      'slack_accounts',
      'slack_list_tools',
      'slack_call_tool',
    ]);
  });
});

describe('ghost · network 多连接声明(connections)', () => {
  // connections 的收单入口是意识 settingsHtml(地址与 token 都由它收),
  // 基底默认带上;extra 可覆盖(测"缺 settingsHtml 拒"时显式抹掉)。
  const withNet = (network: unknown, extra: Record<string, unknown> = {}) => ({
    ...goodManifest(),
    slots: ['panel', 'network'],
    settingsHtml: 'settings.html',
    network,
    ...extra,
  });
  const goodConn = () => ({
    key: 'gitlab',
    label: 'GitLab 实例',
    hint: '填实例域名与 Personal Access Token',
    inject: { header: 'Private-Token', format: '{value}' },
    maxConnections: 4,
  });

  it('合法声明放行并归一化(hint/maxConnections 透传;未声明的可选字段不落清单)', () => {
    const r = validateGhostManifest(withNet({ hosts: ['api.example.com'], connections: [goodConn()] }));
    expect(r.ok, r.ok ? '' : r.reason).toBe(true);
    if (!r.ok) return;
    expect(r.manifest.network?.connections).toEqual([
      {
        key: 'gitlab',
        label: 'GitLab 实例',
        hint: '填实例域名与 Personal Access Token',
        inject: { header: 'Private-Token', format: '{value}' },
        maxConnections: 4,
      },
    ]);
    // 可选字段缺省不落清单(权限 diff 不 churn)。
    const minimal = validateGhostManifest(
      withNet({ hosts: ['api.example.com'], connections: [{ key: 'gl', label: 'GL', inject: { header: 'X-T', format: '{value}' } }] }),
    );
    expect(minimal.ok).toBe(true);
    if (!minimal.ok) return;
    const decl = minimal.manifest.network?.connections?.[0];
    expect(decl && 'hint' in decl).toBe(false);
    expect(decl && 'maxConnections' in decl).toBe(false);
  });

  it('connections 在场时 hosts 可缺省/空数组(归一化为 []);无 connections 时 hosts 仍必填', () => {
    const noHosts = validateGhostManifest(withNet({ connections: [goodConn()] }));
    expect(noHosts.ok, noHosts.ok ? '' : noHosts.reason).toBe(true);
    if (noHosts.ok) expect(noHosts.manifest.network?.hosts).toEqual([]);
    const emptyHosts = validateGhostManifest(withNet({ hosts: [], connections: [goodConn()] }));
    expect(emptyHosts.ok).toBe(true);
    // 双双缺席仍拒(既有回归):静态域名与动态连接至少有其一。
    expect(validateGhostManifest(withNet({})).ok).toBe(false);
    expect(validateGhostManifest(withNet({ hosts: [] })).ok).toBe(false);
  });

  it('声明了 connections 必须同时声明 settingsHtml(没人收地址和 token)', () => {
    const r = validateGhostManifest(
      withNet({ hosts: ['api.example.com'], connections: [goodConn()] }, { settingsHtml: undefined }),
    );
    expect(r.ok).toBe(false);
    expect(!r.ok && r.reason).toContain('settingsHtml');
  });

  it('key 撞 secrets 的 key / connections 内重复 key 一律拒', () => {
    const secret = {
      key: 'gitlab',
      label: 'Token',
      inject: { header: 'Authorization', format: 'Bearer {value}' },
    };
    const clash = validateGhostManifest(
      withNet({ hosts: ['api.example.com'], secrets: [secret], connections: [goodConn()] }),
    );
    expect(clash.ok).toBe(false);
    expect(!clash.ok && clash.reason).toContain('撞名');
    const dup = validateGhostManifest(
      withNet({ hosts: ['api.example.com'], connections: [goodConn(), goodConn()] }),
    );
    expect(dup.ok).toBe(false);
    expect(!dup.ok && dup.reason).toContain('重复');
  });

  it('inject.hosts 禁止声明(注入范围恒等于连接自身地址);header/format 规则同 secrets', () => {
    const withHosts = validateGhostManifest(
      withNet({
        hosts: ['api.example.com'],
        connections: [{ ...goodConn(), inject: { header: 'X-T', format: '{value}', hosts: ['api.example.com'] } }],
      }),
    );
    expect(withHosts.ok).toBe(false);
    expect(!withHosts.ok && withHosts.reason).toContain('inject.hosts');
    // 协议关键头拒;format 必须恰含一个 {value}。
    expect(
      validateGhostManifest(
        withNet({ hosts: ['api.example.com'], connections: [{ ...goodConn(), inject: { header: 'Cookie', format: '{value}' } }] }),
      ).ok,
    ).toBe(false);
    expect(
      validateGhostManifest(
        withNet({ hosts: ['api.example.com'], connections: [{ ...goodConn(), inject: { header: 'X-T', format: 'no-placeholder' } }] }),
      ).ok,
    ).toBe(false);
  });

  it('声明超 2 条 / maxConnections 越界 / key 形状非法一律拒', () => {
    const three = validateGhostManifest(
      withNet({
        hosts: ['api.example.com'],
        connections: [
          { ...goodConn(), key: 'a1' },
          { ...goodConn(), key: 'b2' },
          { ...goodConn(), key: 'c3' },
        ],
      }),
    );
    expect(three.ok).toBe(false);
    for (const bad of [0, 9, 1.5, '4', Number.NaN]) {
      const r = validateGhostManifest(
        withNet({ hosts: ['api.example.com'], connections: [{ ...goodConn(), maxConnections: bad }] }),
      );
      expect(r.ok, String(bad)).toBe(false);
    }
    for (const badKey of ['Gitlab', '1gl', 'gl-b', 'x'.repeat(33), '']) {
      const r = validateGhostManifest(
        withNet({ hosts: ['api.example.com'], connections: [{ ...goodConn(), key: badKey }] }),
      );
      expect(r.ok, badKey).toBe(false);
    }
  });

  it('权限清单:每条连接声明生成一条 networkConnections 条目(带 label 与主机说明)', () => {
    const r = validateGhostManifest(withNet({ hosts: ['api.example.com'], connections: [goodConn()] }));
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const item = ghostPermissionItems(r.manifest).find((i) => i.key === 'connections:gitlab');
    expect(item).toMatchObject({
      kind: 'network',
      labelKey: 'networkConnections',
      labelArgs: { label: 'GitLab 实例' },
      detailKey: 'networkConnectionsDetail',
    });
  });
});

describe('ghost · 交互卡 action id 形状(v2)', () => {
  it('放行含 :: 的 mivo customId 与普通 id;拒空/超长/非法字符/带引号', () => {
    // mivo 真实 customId 形态必须过——正则漏收 `:` 会让整排按钮被净化器丢。
    for (const ok of [
      'MJ::JOB::upsample::1::0f3a2b1c-4d5e-6f70-8a9b-0c1d2e3f4a5b',
      'NANOBANANA::image::imgPrompt::0::6a546d8ddb8533fb8eea063f',
      'reroll',
      'U1',
      'a_b-c:d',
      'x'.repeat(128),
    ]) {
      expect(GHOST_CARD_ACTION_ID_RE.test(ok), ok).toBe(true);
    }
    for (const bad of [
      '',
      'x'.repeat(129),
      'has space',
      'quote"inside',
      "quote'inside",
      'semi;colon',
      'angle<br>',
      '中文动作',
    ]) {
      expect(GHOST_CARD_ACTION_ID_RE.test(bad), bad).toBe(false);
    }
  });
});

describe('ghost · settingsHtml 自绘设置区 + settingsHeight(C3b 收尾)', () => {
  it('settingsHtml 合法相对路径通过并透传;非法路径拒', () => {
    const ok = validateGhostManifest({ ...goodManifest(), settingsHtml: 'ui/settings.html' });
    expect(ok.ok && ok.manifest.settingsHtml).toBe('ui/settings.html');
    for (const bad of ['../evil.html', '/abs.html', 'a\b.html', '']) {
      const r = validateGhostManifest({ ...goodManifest(), settingsHtml: bad });
      expect(r.ok, bad).toBe(false);
    }
  });

  it('settingsHeight:160/800 边界过,159/801/NaN/字符串拒,归一化透传', () => {
    for (const h of [160, 360, 800]) {
      const r = validateGhostManifest({ ...goodManifest(), settingsHtml: 'settings.html', settingsHeight: h });
      expect(r.ok && r.manifest.settingsHeight, String(h)).toBe(h);
    }
    for (const h of [159, 801, Number.NaN, Number.POSITIVE_INFINITY, '360', null]) {
      const r = validateGhostManifest({ ...goodManifest(), settingsHtml: 'settings.html', settingsHeight: h });
      expect(r.ok, String(h)).toBe(false);
    }
  });

  it('单独声明 settingsHeight(没有 settingsHtml)拒——没有界面就没有高度可言', () => {
    const r = validateGhostManifest({ ...goodManifest(), settingsHeight: 360 });
    expect(r.ok).toBe(false);
    expect(!r.ok && r.reason).toContain('settingsHeight');
  });

  it('未声明 settingsHeight 时归一化输出不带该字段', () => {
    const r = validateGhostManifest({ ...goodManifest(), settingsHtml: 'settings.html' });
    expect(r.ok && 'settingsHeight' in r.manifest).toBe(false);
  });

  it('ghostWebviewEntryPaths:只 panel / 只 settings / 双声明 / 都无 / 同文件去重', () => {
    const both = validateGhostManifest({ ...goodManifest(), settingsHtml: 'settings.html' });
    expect(both.ok && ghostWebviewEntryPaths(both.manifest)).toEqual(['/panel.html', '/settings.html']);

    const panelOnly = validateGhostManifest(goodManifest());
    expect(panelOnly.ok && ghostWebviewEntryPaths(panelOnly.manifest)).toEqual(['/panel.html']);

    const settingsOnly: Record<string, unknown> = {
      ...goodManifest(),
      slots: ['tool'],
      tools: [{ name: 'do_thing', description: '做点事' }],
      settingsHtml: 'settings.html',
    };
    delete settingsOnly.panel;
    const so = validateGhostManifest(settingsOnly);
    expect(so.ok && ghostWebviewEntryPaths(so.manifest)).toEqual(['/settings.html']);

    const none: Record<string, unknown> = {
      ...goodManifest(),
      slots: ['tool'],
      tools: [{ name: 'do_thing', description: '做点事' }],
    };
    delete none.panel;
    const n = validateGhostManifest(none);
    expect(n.ok && ghostWebviewEntryPaths(n.manifest)).toEqual([]);

    const same = validateGhostManifest({ ...goodManifest(), settingsHtml: 'panel.html' });
    expect(same.ok && ghostWebviewEntryPaths(same.manifest)).toEqual(['/panel.html']);
  });

  it('内容清单:声明 settingsHtml 的意识含 settingsUi,排在 panel 后 code 前', () => {
    const r = validateGhostManifest({ ...goodManifest(), settingsHtml: 'settings.html' });
    expect(r.ok && ghostContentKeys(r.manifest)).toEqual(['panel', 'settingsUi', 'code']);
  });
});

describe('ghost · 凭证收单一律意识自绘(2026-07-13 宿主凭证渲染退役)', () => {
  function withSecret(secret: Record<string, unknown>, extra: Record<string, unknown> = {}) {
    return validateGhostManifest({
      ...goodManifest(),
      slots: ['panel', 'network'],
      network: {
        hosts: ['api.example.com'],
        secrets: [
          {
            key: 'api_key',
            label: 'API Key',
            inject: { header: 'Authorization', format: 'Bearer {value}' },
            ...secret,
          },
        ],
      },
      ...extra,
    });
  }

  it('user 凭证 + settingsHtml → 过;遗留 input:"ghost" 接受并忽略、归一化不落清单', () => {
    const plain = withSecret({}, { settingsHtml: 'settings.html' });
    expect(plain.ok, plain.ok ? '' : plain.reason).toBe(true);
    expect(plain.ok && 'input' in (plain.manifest.network?.secrets?.[0] ?? {})).toBe(false);

    const legacy = withSecret({ input: 'ghost' }, { settingsHtml: 'settings.html' });
    expect(legacy.ok, legacy.ok ? '' : legacy.reason).toBe(true);
    expect(legacy.ok && 'input' in (legacy.manifest.network?.secrets?.[0] ?? {})).toBe(false);
  });

  it('user 凭证没声明 settingsHtml → 拒(宿主渲染输入行已退役,没有界面就没人收单)', () => {
    for (const secret of [{}, { input: 'ghost' }]) {
      const r = withSecret(secret);
      expect(r.ok, JSON.stringify(secret)).toBe(false);
      expect(!r.ok && r.reason).toContain('settingsHtml');
    }
  });

  it("input:'host' → 拒(宿主收单已退役);其它非法值同拒", () => {
    const host = withSecret({ input: 'host' }, { settingsHtml: 'settings.html' });
    expect(host.ok).toBe(false);
    expect(!host.ok && host.reason).toContain('退役');
    for (const bad of ['both', '', 42, null]) {
      const r = withSecret({ input: bad }, { settingsHtml: 'settings.html' });
      expect(r.ok, String(bad)).toBe(false);
    }
  });

  it("login-email 凭证无需 settingsHtml(没有收单动作);标注 input:'ghost' 仍拒", () => {
    const ok = withSecret({ source: 'login-email', hint: undefined, url: undefined });
    expect(ok.ok, ok.ok ? '' : ok.reason).toBe(true);

    const r = withSecret(
      { input: 'ghost', source: 'login-email', url: undefined },
      { settingsHtml: 'settings.html' },
    );
    expect(r.ok).toBe(false);
    expect(!r.ok && r.reason).toContain('login-email');
  });
});

describe('ghost · 权限清单凭证分档(知情同意面不许说过头话)', () => {
  it('user 凭证 → networkSecretGhostInputDetail;login-email → identity 档', () => {
    const r = validateGhostManifest({
      ...goodManifest(),
      slots: ['panel', 'network'],
      settingsHtml: 'settings.html',
      network: {
        hosts: ['api.example.com'],
        secrets: [
          { key: 'user_key', label: 'U', inject: { header: 'Authorization', format: 'Bearer {value}' } },
          { key: 'pages_token', label: 'P', source: 'login-email', inject: { header: 'X-Pages-Token', format: 'pages_{value}' } },
        ],
      },
    });
    expect(r.ok, r.ok ? '' : r.reason).toBe(true);
    if (!r.ok) return;
    const items = ghostPermissionItems(r.manifest);
    expect(items.find((i) => i.key === 'network:secret:user_key')?.detailKey).toBe(
      'networkSecretGhostInputDetail',
    );
    expect(items.find((i) => i.key === 'network:secret:pages_token')?.detailKey).toBe(
      'networkSecretIdentityDetail',
    );
  });
});
