/**
 * MakerContactsStore 单测 — 用真 better-sqlite3 内存库跑全链路
 * (CRUD / 身份唯一约束与冲突 / resolve 三级递降 / FTS 检索 / 事件流 / 分组 / merge / sanity rebuild)。
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import DatabaseCtor from 'better-sqlite3';
import type Database from 'better-sqlite3';

import { MakerContactsStore } from '../store.js';
import { ContactsError } from '../types.js';
import type { Logger } from '../../interfaces/logger.js';

function noopLogger(): Logger {
  const noop = () => {};
  const l: Logger = {
    trace: noop,
    debug: noop,
    info: noop,
    warn: noop,
    error: noop,
    fatal: noop,
    child: () => l,
  };
  return l;
}

describe('MakerContactsStore', () => {
  let db: Database.Database;
  let store: MakerContactsStore;

  beforeEach(() => {
    db = new DatabaseCtor(':memory:');
    store = new MakerContactsStore({ db, logger: noopLogger() });
    store.init();
  });

  afterEach(() => {
    db.close();
  });

  const createDash = () =>
    store.createContact({
      kind: 'person',
      displayName: '黄一孟',
      aliases: ['Dash', 'Dash Huang'],
      summary: '长期老搭档, VeryCD/TapTap 一路合作',
      narrative: '## 与用户的关系\n从 VeryCD 阶段开始的核心协作关系。',
      agentNotes: '遇到 @dashhuang 不要当陌生账号处理',
      source: 'agent',
      identities: [
        { platform: 'email', value: 'dash@xd.com', label: '当前' },
        { platform: 'email', value: 'dash@xindong.com', label: '心动早期' },
        { platform: 'x', value: '@dashhuang' },
      ],
    });

  describe('createContact / getContact', () => {
    it('创建带身份的人物档案并完整读回', () => {
      const p = createDash();
      expect(p.id).toBeTruthy();
      expect(p.kind).toBe('person');
      expect(p.identities).toHaveLength(3);
      expect(p.status).toBe('confirmed');
      const fetched = store.getContact(p.id);
      expect(fetched.displayName).toBe('黄一孟');
      expect(fetched.aliases).toEqual(['Dash', 'Dash Huang']);
      expect(fetched.agentNotes).toContain('dashhuang');
    });

    it('组织实体与 pending 状态', () => {
      const org = store.createContact({
        kind: 'org',
        displayName: '心动网络',
        status: 'pending',
        source: 'agent',
      });
      expect(org.kind).toBe('org');
      expect(org.status).toBe('pending');
    });

    it('身份 (platform, value) 全局唯一 — 撞上返回 identity-conflict 且带占用者 id', () => {
      const p = createDash();
      try {
        store.createContact({
          kind: 'person',
          displayName: '另一个人',
          identities: [{ platform: 'email', value: 'DASH@XD.COM' }], // 大小写不敏感
        });
        expect.unreachable('should throw');
      } catch (e) {
        expect(e).toBeInstanceOf(ContactsError);
        expect((e as ContactsError).code).toBe('identity-conflict');
        expect((e as ContactsError).conflictContactId).toBe(p.id);
      }
    });

    it('入参校验: 空名 / 非法 kind / 非法 platform', () => {
      expect(() => store.createContact({ kind: 'person', displayName: '  ' })).toThrow(/displayName/);
      expect(() =>
        store.createContact({ kind: 'alien' as never, displayName: 'x' }),
      ).toThrow(/invalid kind/);
      expect(() =>
        store.createContact({
          kind: 'person',
          displayName: 'x',
          identities: [{ platform: 'E MAIL!', value: 'a@b.c' }],
        }),
      ).toThrow(/invalid platform/);
    });
  });

  describe('updateContact', () => {
    it('patch 语义: 只更新给出的字段, 其余保持', () => {
      const p = createDash();
      const updated = store.updateContact(p.id, { summary: '新简介', status: 'pending' });
      expect(updated.summary).toBe('新简介');
      expect(updated.status).toBe('pending');
      expect(updated.displayName).toBe('黄一孟');
      expect(updated.narrative).toContain('VeryCD');
    });

    it('不存在的 id 抛 not-found', () => {
      expect(() => store.updateContact('nope', { summary: 'x' })).toThrow(/not-found/);
    });
  });

  describe('resolve(身份反查, 核心场景)', () => {
    it('邮箱精确命中: matchType=identity 且带命中身份', () => {
      const p = createDash();
      const hits = store.resolve('dash@xd.com');
      expect(hits).toHaveLength(1);
      expect(hits[0]!.matchType).toBe('identity');
      expect(hits[0]!.identity?.label).toBe('当前');
      expect(hits[0]!.profile.id).toBe(p.id);
    });

    it('handle 归一化: @前缀与大小写不影响命中', () => {
      createDash();
      expect(store.resolve('@DashHuang')[0]?.matchType).toBe('identity');
      expect(store.resolve('dashhuang', { platform: 'x' })[0]?.matchType).toBe('identity');
    });

    it('platform 过滤: 限定平台后其它平台的值不命中身份级', () => {
      createDash();
      const hits = store.resolve('dash@xd.com', { platform: 'slack' });
      // 身份级 miss, 落到 FTS 兜底(仍可能命中该人), 但绝不是 identity 级
      expect(hits.every((h) => h.matchType !== 'identity')).toBe(true);
    });

    it('别名精确命中: matchType=name', () => {
      const p = createDash();
      const hits = store.resolve('Dash');
      expect(hits[0]!.matchType).toBe('name');
      expect(hits[0]!.profile.id).toBe(p.id);
    });

    it('FTS 兜底: 简介关键词能捞到人', () => {
      const p = createDash();
      const hits = store.resolve('TapTap');
      expect(hits.length).toBeGreaterThan(0);
      expect(hits[0]!.matchType).toBe('fts');
      expect(hits[0]!.profile.id).toBe(p.id);
    });

    it('空值/无命中返回空数组', () => {
      expect(store.resolve('  ')).toEqual([]);
      expect(store.resolve('nobody@nowhere.dev')).toEqual([]);
    });
  });

  describe('search(FTS)', () => {
    it('叙事/事件文本可检索, 带高亮 snippet', () => {
      const p = createDash();
      store.appendEvent(p.id, { date: '2026-06-21', text: '邀请加入 App Store Connect', source: 'email' });
      const hits = store.search('App Store Connect');
      expect(hits).toHaveLength(1);
      expect(hits[0]!.contactId).toBe(p.id);
      expect(hits[0]!.snippet).toContain('<mark>');
    });

    it('中文子串检索: unicode61 单 token 场景走 LIKE 兜底', () => {
      const p = createDash();
      store.appendEvent(p.id, { date: '2026-07-01', text: '一起评审了通讯录设计方案', source: 'session' });
      // "设计方案"是"通讯录设计方案"的子串, phrase MATCH 必漏 — 验证 LIKE 兜底接住
      const hits = store.search('设计方案');
      expect(hits).toHaveLength(1);
      expect(hits[0]!.contactId).toBe(p.id);
      // 简介中文子串同样可命中
      expect(store.search('老搭档')[0]!.contactId).toBe(p.id);
      // LIKE 通配符按字面处理, 不产生意外全匹配
      expect(store.search('100%_安全')).toHaveLength(0);
    });

    it('kind / status 过滤', () => {
      createDash();
      store.createContact({ kind: 'org', displayName: 'TapTap 团队', summary: 'TapTap 相关组织', status: 'pending' });
      expect(store.search('TapTap', { kind: 'org' })).toHaveLength(1);
      expect(store.search('TapTap', { status: 'pending' })).toHaveLength(1);
    });
  });

  describe('identities', () => {
    it('addIdentity / removeIdentity 正常路径', () => {
      const p = createDash();
      const added = store.addIdentity(p.id, { platform: 'github', value: 'dashhuang', note: '公开仓库' });
      expect(store.getContact(p.id).identities).toHaveLength(4);
      store.removeIdentity(added.id);
      expect(store.getContact(p.id).identities).toHaveLength(3);
    });

    it('同 contact 重复挂同一身份抛 already-exists', () => {
      const p = createDash();
      expect(() => store.addIdentity(p.id, { platform: 'email', value: 'dash@xd.com' })).toThrow(/already-exists/);
    });

    it('挂他人身份抛 identity-conflict', () => {
      const p = createDash();
      const other = store.createContact({ kind: 'person', displayName: '路人' });
      try {
        store.addIdentity(other.id, { platform: 'email', value: 'dash@xd.com' });
        expect.unreachable('should throw');
      } catch (e) {
        expect((e as ContactsError).code).toBe('identity-conflict');
        expect((e as ContactsError).conflictContactId).toBe(p.id);
      }
    });
  });

  describe('events', () => {
    it('append-only 事件流按日期倒序', () => {
      const p = createDash();
      store.appendEvent(p.id, { date: '2026-05-01', text: '早一点的事' });
      store.appendEvent(p.id, { date: '2026-07-01', text: '最近的事' });
      const events = store.getContact(p.id).events;
      expect(events.map((e) => e.text)).toEqual(['最近的事', '早一点的事']);
    });

    it('日期格式校验(YYYY-MM-DD 或 YYYY-MM)', () => {
      const p = createDash();
      expect(() => store.appendEvent(p.id, { date: '07/01/2026', text: 'x' })).toThrow(/date/);
      expect(store.appendEvent(p.id, { date: '2026-07', text: '仅到月' }).date).toBe('2026-07');
    });

    it('deleteEvent', () => {
      const p = createDash();
      const ev = store.appendEvent(p.id, { date: '2026-07-01', text: 'x' });
      store.deleteEvent(ev.id);
      expect(store.getContact(p.id).events).toHaveLength(0);
    });
  });

  describe('groups', () => {
    it('分组 CRUD + 成员管理 + 按组过滤列表', () => {
      const p = createDash();
      const q = store.createContact({ kind: 'person', displayName: '张三' });
      const g = store.createGroup('核心协作', '高频协作对象');
      store.addToGroup(g.id, [p.id, q.id]);
      expect(store.listGroups()[0]!.memberCount).toBe(2);
      expect(store.listContacts({ groupId: g.id })).toHaveLength(2);
      expect(store.getContact(p.id).groups.map((x) => x.name)).toEqual(['核心协作']);

      store.removeFromGroup(g.id, [q.id]);
      expect(store.listContacts({ groupId: g.id })).toHaveLength(1);

      const renamed = store.updateGroup(g.id, { name: '老搭档' });
      expect(renamed.name).toBe('老搭档');

      store.deleteGroup(g.id);
      expect(store.listGroups()).toHaveLength(0);
      // 删组不删人
      expect(store.getContact(p.id).displayName).toBe('黄一孟');
    });

    it('组名唯一', () => {
      store.createGroup('A');
      expect(() => store.createGroup('A')).toThrow(/already-exists/);
    });
  });

  describe('同人识别 / 富集(去重确定性)', () => {
    it('findSimilar: identity 精确撞 = 同人(最高置信)', () => {
      const p = createDash();
      const hits = store.findSimilar({
        kind: 'person',
        displayName: '完全不同的名字',
        identities: [{ platform: 'email', value: 'DASH@XD.COM' }],
      });
      expect(hits[0]).toMatchObject({ matchType: 'identity', contactId: p.id });
      expect(hits[0]!.matchedIdentity?.platform).toBe('email');
    });

    it('findSimilar: 名字面相似(拉丁 token 子集 / CJK 子串 / 别名命中)', () => {
      const kros = store.createContact({ kind: 'person', displayName: 'Kros' });
      const yy = store.createContact({ kind: 'person', displayName: '赵宇尧' });
      createDash(); // alias 含 "Dash"

      expect(store.findSimilar({ kind: 'person', displayName: 'Kros Dai' })[0]).toMatchObject({
        matchType: 'name',
        contactId: kros.id,
      });
      expect(store.findSimilar({ kind: 'person', displayName: '宇尧' })[0]).toMatchObject({
        contactId: yy.id,
      });
      expect(
        store.findSimilar({ kind: 'person', displayName: 'Dash Huang' }).length,
      ).toBeGreaterThan(0);
      // 跨 kind 也要暴露(公司被错建成人是高频错档形态); 无关名字不误报
      const cross = store.findSimilar({ kind: 'org', displayName: 'Kros Dai' });
      expect(cross[0]).toMatchObject({ matchType: 'name', kind: 'person' });
      expect(store.findSimilar({ kind: 'person', displayName: '王小明' })).toHaveLength(0);
      // 纯拉丁短别名不做子串匹配: org 别名 "XD" 不应误命中含 "XD" 的任意长名
      store.createContact({ kind: 'org', displayName: '心动(XD Inc)', aliases: ['XD', 'xindong'] });
      expect(store.findSimilar({ kind: 'person', displayName: 'XDMaker端到端测试员' })).toHaveLength(0);
    });

    it('enrichContact: 别名并集 + 空字段填充 + 叙事标注追加 + 身份追加/跳过', () => {
      const p = store.createContact({
        kind: 'person',
        displayName: 'Kros',
        narrative: '已有背景',
        identities: [{ platform: 'email', value: 'kros@xd.com' }],
      });
      const other = createDash();
      const res = store.enrichContact(p.id, {
        kind: 'person',
        displayName: 'Kros Dai',
        aliases: ['KrosDai'],
        summary: 'XD 同事',
        narrative: '新采集的背景',
        identities: [
          { platform: 'email', value: 'kros@xd.com' }, // 已在本人 → skip
          { platform: 'github', value: 'krosdai' }, // 新 → add
          { platform: 'email', value: 'dash@xd.com' }, // 归属它人 → skip conflict
        ],
      });
      expect(res.addedAliases).toEqual(['Kros Dai', 'KrosDai']);
      expect(res.filledFields).toContain('summary');
      expect(res.narrativeAppended).toBe(true);
      expect(res.addedIdentities).toBe(1);
      expect(res.skippedIdentities).toEqual([
        { platform: 'email', value: 'kros@xd.com', reason: 'already-exists' },
        // conflict-other 带占用者 id(bot review: agent 拿它引导 merge, 不用再逐个 resolve)
        { platform: 'email', value: 'dash@xd.com', reason: 'conflict-other', conflictContactId: expect.any(String) },
      ]);
      const after = store.getContact(p.id);
      expect(after.displayName).toBe('Kros'); // 原名保留
      expect(after.narrative).toContain('已有背景');
      expect(after.narrative).toContain('新采集的背景');
      expect(after.identities).toHaveLength(2);
      // 富集后按新名字也能 resolve 到(别名生效)
      expect(store.resolve('Kros Dai')[0]!.profile.id).toBe(p.id);
      expect(other).toBeTruthy();
    });

    it('enrichContact 不改变 pending 状态(裁决权在用户)', () => {
      const p = store.createContact({ kind: 'person', displayName: 'X', status: 'pending' });
      store.enrichContact(p.id, { kind: 'person', displayName: 'X', status: 'confirmed' });
      expect(store.getContact(p.id).status).toBe('pending');
    });

    it('findDuplicatePairs 扫出疑似重复对(含跨 kind 错档)', () => {
      store.createContact({ kind: 'person', displayName: 'Kros' });
      store.createContact({ kind: 'person', displayName: 'Kros Dai' });
      store.createContact({ kind: 'person', displayName: '无关的人' });
      const pairs = store.findDuplicatePairs();
      expect(pairs).toHaveLength(1);
      expect([pairs[0]!.aName, pairs[0]!.bName].sort()).toEqual(['Kros', 'Kros Dai']);
      // 公司被错建成人: 跨 kind 对也要被扫出
      store.createContact({ kind: 'org', displayName: '心动网络' });
      store.createContact({ kind: 'person', displayName: '心动网络' });
      const crossPairs = store.findDuplicatePairs().filter((x) => x.aKind !== x.bKind);
      expect(crossPairs).toHaveLength(1);
    });

    it('updateContact 修正错档类型(person↔org)', () => {
      const wrong = store.createContact({ kind: 'person', displayName: '顺丰速运' });
      const fixed = store.updateContact(wrong.id, { kind: 'org' });
      expect(fixed.kind).toBe('org');
      expect(store.search('顺丰速运', { kind: 'org' })).toHaveLength(1);
    });
  });

  describe('relations(关系边)', () => {
    it('人↔组织任职: 双向可见, 组织名进对方 FTS', () => {
      const p = createDash();
      const org = store.createContact({ kind: 'org', displayName: '心动网络' });
      const rel = store.addRelation(p.id, { toId: org.id, relation: '任职', note: '执行办' });
      expect(rel.relation).toBe('任职');

      const person = store.getContact(p.id);
      expect(person.relations).toHaveLength(1);
      expect(person.relations[0]).toMatchObject({
        contactId: org.id,
        displayName: '心动网络',
        kind: 'org',
        direction: 'out',
        note: '执行办',
      });
      // 对端(组织)以 in 方向看到成员
      const orgProfile = store.getContact(org.id);
      expect(orgProfile.relations[0]).toMatchObject({ contactId: p.id, direction: 'in' });
      // 搜组织名可捞到人(关系文本进 FTS)
      expect(store.search('心动网络').map((h) => h.contactId)).toContain(p.id);
    });

    it('自关联/重复关系/不存在对端 拒绝', () => {
      const p = createDash();
      const org = store.createContact({ kind: 'org', displayName: 'O' });
      store.addRelation(p.id, { toId: org.id, relation: '任职' });
      expect(() => store.addRelation(p.id, { toId: p.id, relation: 'x' })).toThrow(/invalid-params/);
      expect(() => store.addRelation(p.id, { toId: org.id, relation: '任职' })).toThrow(/already-exists/);
      expect(() => store.addRelation(p.id, { toId: 'nope', relation: 'x' })).toThrow(/not-found/);
    });

    it('removeRelation 双向消失并同步 FTS', () => {
      const p = createDash();
      const org = store.createContact({ kind: 'org', displayName: '独特组织名甲乙丙' });
      const rel = store.addRelation(p.id, { toId: org.id, relation: '任职' });
      store.removeRelation(rel.id);
      expect(store.getContact(p.id).relations).toHaveLength(0);
      expect(store.getContact(org.id).relations).toHaveLength(0);
      expect(store.search('独特组织名甲乙丙').map((h) => h.contactId)).not.toContain(p.id);
    });

    it('删除任一端级联删关系', () => {
      const p = createDash();
      const org = store.createContact({ kind: 'org', displayName: 'O' });
      store.addRelation(p.id, { toId: org.id, relation: '任职' });
      store.deleteContact(org.id);
      expect(store.getContact(p.id).relations).toHaveLength(0);
    });
  });

  describe('merge', () => {
    it('关系边随合并迁移, source↔target 自环被清理', () => {
      const target = createDash();
      const dup = store.createContact({ kind: 'person', displayName: 'Dash 副本' });
      const org = store.createContact({ kind: 'org', displayName: '心动' });
      store.addRelation(dup.id, { toId: org.id, relation: '任职' });
      store.addRelation(dup.id, { toId: target.id, relation: '疑似同人' }); // 合并后成自环, 应清理

      store.merge(target.id, dup.id);
      const merged = store.getContact(target.id);
      expect(merged.relations).toHaveLength(1);
      expect(merged.relations[0]).toMatchObject({ contactId: org.id, relation: '任职' });
    });

    it('身份/事件/分组迁移, 别名并集, 叙事拼接, 源档案删除', () => {
      const target = createDash();
      const dup = store.createContact({
        kind: 'person',
        displayName: 'Dash H.',
        narrative: '重复档案里的补充背景',
        identities: [{ platform: 'github', value: 'dashhuang' }],
      });
      store.appendEvent(dup.id, { date: '2026-06-01', text: '重复档案里的事件' });
      const g = store.createGroup('G');
      store.addToGroup(g.id, [dup.id]);

      const res = store.merge(target.id, dup.id);
      expect(res.movedIdentities).toBe(1);
      expect(res.movedEvents).toBe(1);

      const merged = store.getContact(target.id);
      expect(merged.identities).toHaveLength(4);
      expect(merged.events.some((e) => e.text === '重复档案里的事件')).toBe(true);
      expect(merged.aliases).toContain('Dash H.');
      expect(merged.narrative).toContain('重复档案里的补充背景');
      expect(merged.groups.map((x) => x.name)).toEqual(['G']);
      expect(() => store.getContact(dup.id)).toThrow(/not-found/);
      // 合并后身份反查直达 target
      expect(store.resolve('dashhuang', { platform: 'github' })[0]!.profile.id).toBe(target.id);
    });

    it('自合并拒绝', () => {
      const p = createDash();
      expect(() => store.merge(p.id, p.id)).toThrow(/invalid-params/);
    });
  });

  describe('listContacts / stats / resetAll', () => {
    it('过滤与统计', () => {
      createDash();
      store.createContact({ kind: 'org', displayName: '心动', status: 'pending' });
      expect(store.listContacts({ kind: 'person' })).toHaveLength(1);
      expect(store.listContacts({ status: 'pending' })).toHaveLength(1);
      const s = store.stats();
      expect(s).toEqual({ people: 1, orgs: 1, pending: 1, groups: 0 });
    });

    it('resetAll 清空全部并归零 FTS', () => {
      createDash();
      store.createGroup('G');
      const res = store.resetAll();
      expect(res.removedCount).toBe(1);
      expect(store.listContacts()).toHaveLength(0);
      expect(store.listGroups()).toHaveLength(0);
      expect(store.search('黄一孟')).toHaveLength(0);
    });
  });

  describe('deleteContact 与 FTS 一致性', () => {
    it('删档后 FTS 同步移除', () => {
      const p = createDash();
      expect(store.search('黄一孟')).toHaveLength(1);
      store.deleteContact(p.id);
      expect(store.search('黄一孟')).toHaveLength(0);
      expect(store.resolve('dash@xd.com')).toEqual([]);
    });

    it('sanity check: FTS 被外部清坏后 init 自动 rebuild', () => {
      const p = createDash();
      db.exec(`DELETE FROM contacts_fts`);
      // 新 store 实例走 init → sanityCheck → rebuild
      const store2 = new MakerContactsStore({ db, logger: noopLogger() });
      store2.init();
      expect(store2.search('黄一孟')[0]!.contactId).toBe(p.id);
    });
  });
});
