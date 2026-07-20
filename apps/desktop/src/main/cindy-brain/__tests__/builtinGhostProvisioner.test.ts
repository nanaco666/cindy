import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  PROVISIONING_CONFIG_FILE,
  PROVISIONING_STATE_FILE,
  clearBuiltinTombstone,
  hashDirContent,
  listBuiltinSeedIds,
  listEnterpriseSeedIds,
  listRestorableBuiltinGhosts,
  matchesAudience,
  provisionBuiltinGhosts,
  readBuiltinTombstones,
  recordBuiltinTombstone,
  type ProvisionDeps,
  type ProvisionIdentity,
} from '../builtinGhostProvisioner';

/** 每个用例独立的临时种子根 + 仓库根(规则 23:测试路径一律 os.tmpdir)。 */
let workDir: string;
let seedRootDir: string;
let repoRootDir: string;

beforeEach(async () => {
  workDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'cindy-builtin-test-'));
  seedRootDir = path.join(workDir, 'builtin-ghosts');
  repoRootDir = path.join(workDir, 'cindy-brain');
  await fs.promises.mkdir(seedRootDir, { recursive: true });
  await fs.promises.mkdir(repoRootDir, { recursive: true });
});

afterEach(async () => {
  await fs.promises.rm(workDir, { recursive: true, force: true });
});

function goodManifest(id: string): Record<string, unknown> {
  return {
    schemaVersion: 2,
    id,
    name: `Builtin ${id}`,
    version: '1.0.0',
    kind: 'chip',
    entry: 'main.js',
    slots: ['tool'],
    tools: [{ name: 'do_thing', description: '做点事' }],
  };
}

/** 在种子根写一个意识源码目录。 */
async function writeSeed(id: string, files: Record<string, string>, manifest?: Record<string, unknown>): Promise<void> {
  const dir = path.join(seedRootDir, id);
  await fs.promises.mkdir(dir, { recursive: true });
  await fs.promises.writeFile(path.join(dir, 'ghost.json'), JSON.stringify(manifest ?? goodManifest(id)));
  for (const [name, content] of Object.entries(files)) {
    const dest = path.join(dir, name);
    await fs.promises.mkdir(path.dirname(dest), { recursive: true });
    await fs.promises.writeFile(dest, content);
  }
}

async function provision(extra?: Partial<ProvisionDeps>) {
  return provisionBuiltinGhosts({ seedRootDir, repoRootDir, ...extra });
}

/** 写受众配置文件(种子根下)。 */
async function writeConfig(config: unknown): Promise<void> {
  const content = typeof config === 'string' ? config : JSON.stringify(config);
  await fs.promises.writeFile(path.join(seedRootDir, PROVISIONING_CONFIG_FILE), content);
}

const alice: ProvisionIdentity = { userId: 'u-alice', email: 'Alice@XD.com' };
const bob: ProvisionIdentity = { userId: 'u-bob', email: null };

function installedFile(id: string, rel: string): string {
  return fs.readFileSync(path.join(repoRootDir, id, rel), 'utf-8');
}

describe('provisionBuiltinGhosts · 首装', () => {
  it('把种子播进仓库根,默认唤醒(无 .disabled)', async () => {
    await writeSeed('art', { 'main.js': 'v1' });
    const outcome = await provision();
    expect(outcome.installed.map((m) => m.id)).toEqual(['art']);
    expect(outcome.updated).toEqual([]);
    expect(installedFile('art', 'main.js')).toBe('v1');
    expect(fs.existsSync(path.join(repoRootDir, 'art', '.disabled'))).toBe(false);
  });

  it('种子根不存在 → 静默空结果', async () => {
    await fs.promises.rm(seedRootDir, { recursive: true, force: true });
    const outcome = await provision();
    expect(outcome).toEqual({ installed: [], updated: [], removed: [], skipped: [] });
  });

  it('manifest 不合格 / id 与目录名不符的种子跳过,不拖垮其它种子', async () => {
    await writeSeed('bad', {}, { schemaVersion: 2, id: 'bad' }); // 缺必填字段
    await writeSeed('mismatch', {}, goodManifest('other-id'));
    await writeSeed('good', { 'main.js': 'ok' });
    const outcome = await provision();
    expect(outcome.installed.map((m) => m.id)).toEqual(['good']);
    expect(outcome.skipped.sort()).toEqual(['bad', 'mismatch']);
    expect(fs.existsSync(path.join(repoRootDir, 'bad'))).toBe(false);
  });
});

describe('provisionBuiltinGhosts · 指纹对账', () => {
  it('内容一致 → 跳过不动', async () => {
    await writeSeed('art', { 'main.js': 'v1' });
    await provision();
    const before = await fs.promises.stat(path.join(repoRootDir, 'art', 'main.js'));
    const outcome = await provision();
    expect(outcome.skipped).toEqual(['art']);
    const after = await fs.promises.stat(path.join(repoRootDir, 'art', 'main.js'));
    expect(after.mtimeMs).toBe(before.mtimeMs); // 目录没被重建
  });

  it('种子内容变了 → 覆盖(永远以最新包为准),本地多余文件被清掉', async () => {
    await writeSeed('art', { 'main.js': 'v1' });
    await provision();
    // 用户/旧版在本地目录里留下的杂文件
    await fs.promises.writeFile(path.join(repoRootDir, 'art', 'stale.txt'), 'old');
    await writeSeed('art', { 'main.js': 'v2' });
    const outcome = await provision();
    expect(outcome.updated.map((m) => m.id)).toEqual(['art']);
    expect(installedFile('art', 'main.js')).toBe('v2');
    expect(fs.existsSync(path.join(repoRootDir, 'art', 'stale.txt'))).toBe(false);
  });

  it('本地被改动(即使比种子"新")也收敛回种子内容', async () => {
    await writeSeed('art', { 'main.js': 'seed' });
    await provision();
    await fs.promises.writeFile(path.join(repoRootDir, 'art', 'main.js'), 'local-hack');
    const outcome = await provision();
    expect(outcome.updated.map((m) => m.id)).toEqual(['art']);
    expect(installedFile('art', 'main.js')).toBe('seed');
  });

  it('覆盖时保留 .disabled 停用标记(以最新包为准管版本,不管开关)', async () => {
    await writeSeed('art', { 'main.js': 'v1' });
    await provision();
    await fs.promises.writeFile(path.join(repoRootDir, 'art', '.disabled'), '');
    await writeSeed('art', { 'main.js': 'v2' });
    const outcome = await provision();
    expect(outcome.updated.map((m) => m.id)).toEqual(['art']);
    expect(fs.existsSync(path.join(repoRootDir, 'art', '.disabled'))).toBe(true);
    expect(installedFile('art', 'main.js')).toBe('v2');
  });

  it('.disabled 不参与指纹:仅停用状态差异不触发覆盖', async () => {
    await writeSeed('art', { 'main.js': 'v1' });
    await provision();
    await fs.promises.writeFile(path.join(repoRootDir, 'art', '.disabled'), '');
    const outcome = await provision();
    expect(outcome.skipped).toEqual(['art']);
    expect(fs.existsSync(path.join(repoRootDir, 'art', '.disabled'))).toBe(true);
  });
});

describe('provisionBuiltinGhosts · 墓碑', () => {
  it('用户卸载过的内置意识永不装回;清墓碑后恢复播种', async () => {
    await writeSeed('art', { 'main.js': 'v1' });
    recordBuiltinTombstone(repoRootDir, 'art');
    const outcome = await provision();
    expect(outcome.skipped).toEqual(['art']);
    expect(fs.existsSync(path.join(repoRootDir, 'art'))).toBe(false);

    clearBuiltinTombstone(repoRootDir, 'art');
    const second = await provision();
    expect(second.installed.map((m) => m.id)).toEqual(['art']);
  });

  it('墓碑读写幂等;状态文件损坏当空处理', async () => {
    recordBuiltinTombstone(repoRootDir, 'a');
    recordBuiltinTombstone(repoRootDir, 'a');
    recordBuiltinTombstone(repoRootDir, 'b');
    expect(readBuiltinTombstones(repoRootDir)).toEqual(['a', 'b']);
    clearBuiltinTombstone(repoRootDir, 'a');
    clearBuiltinTombstone(repoRootDir, 'a');
    expect(readBuiltinTombstones(repoRootDir)).toEqual(['b']);

    await fs.promises.writeFile(path.join(repoRootDir, PROVISIONING_STATE_FILE), 'not json');
    expect(readBuiltinTombstones(repoRootDir)).toEqual([]);
  });
});

describe('matchesAudience · 受众命中判定', () => {
  it("'all' / 缺省规则:不看身份,登出也命中", () => {
    expect(matchesAudience('all', null)).toBe(true);
    expect(matchesAudience(undefined, null)).toBe(true);
    expect(matchesAudience('all', alice)).toBe(true);
  });

  it('对象规则:任一维度命中即命中;email 大小写不敏感', () => {
    expect(matchesAudience({ userIds: ['u-alice'] }, alice)).toBe(true);
    expect(matchesAudience({ emails: ['alice@xd.com'] }, alice)).toBe(true);
    expect(matchesAudience({ userIds: ['u-x'], emails: ['x@xd.com'] }, alice)).toBe(false);
    // 已退役的 roles 维度按"不认识的字段"处理:其它维度不命中即不装(fail-closed)。
    expect(matchesAudience({ roles: ['admin'] } as never, bob)).toBe(false);
  });

  it('fail-closed:登出 / 空对象 / 不认识的形态一律不命中', () => {
    expect(matchesAudience({ userIds: ['u-alice'] }, null)).toBe(false);
    expect(matchesAudience({}, alice)).toBe(false);
    expect(matchesAudience('everyone' as never, alice)).toBe(false);
    expect(matchesAudience({ emails: ['x@xd.com'] }, bob)).toBe(false); // email null
  });
});

describe('provisionBuiltinGhosts · 受众与回收', () => {
  it('定向种子:登出不装,登录命中后装上并记 seeded 台账', async () => {
    await writeSeed('vip', { 'main.js': 'v1' });
    await writeConfig({ ghosts: { vip: { audience: { emails: ['alice@xd.com'] } } } });

    const loggedOut = await provision({ identity: null });
    expect(loggedOut.installed).toEqual([]);
    expect(loggedOut.skipped).toEqual(['vip']);

    const loggedIn = await provision({ identity: alice });
    expect(loggedIn.installed.map((m) => m.id)).toEqual(['vip']);
    const state = JSON.parse(await fs.promises.readFile(path.join(repoRootDir, PROVISIONING_STATE_FILE), 'utf-8'));
    expect(state.seeded).toEqual(['vip']);
  });

  it('种子从包里消失(更名/下架)→ 回收播种装的孤儿;手动装的不动', async () => {
    // 播种 old-name + keeper 两个种子。
    await writeSeed('old-name', { 'main.js': 'v1' });
    await writeSeed('keeper', { 'main.js': 'v1' });
    await provision();
    expect(fs.existsSync(path.join(repoRootDir, 'old-name'))).toBe(true);

    // 模拟更名:old-name 种子目录消失,new-name 顶上。
    await fs.promises.rm(path.join(seedRootDir, 'old-name'), { recursive: true, force: true });
    await writeSeed('new-name', { 'main.js': 'v1' });
    const removedIds: string[] = [];
    const outcome = await provision({
      beforeRemove: (id) => {
        removedIds.push(id);
      },
    });
    expect(outcome.installed.map((m) => m.id)).toEqual(['new-name']);
    expect(outcome.removed).toEqual(['old-name']);
    expect(removedIds).toEqual(['old-name']);
    expect(fs.existsSync(path.join(repoRootDir, 'old-name'))).toBe(false);
    expect(fs.existsSync(path.join(repoRootDir, 'keeper'))).toBe(true);
    const state = JSON.parse(await fs.promises.readFile(path.join(repoRootDir, PROVISIONING_STATE_FILE), 'utf-8'));
    expect(state.seeded.sort()).toEqual(['keeper', 'new-name']);

    // 用户手动装的同 id 意识(不在 seeded 台账)不受孤儿回收波及。
    await fs.promises.mkdir(path.join(repoRootDir, 'manual-one'), { recursive: true });
    await fs.promises.writeFile(
      path.join(repoRootDir, 'manual-one', 'ghost.json'),
      JSON.stringify(goodManifest('manual-one')),
    );
    const again = await provision();
    expect(again.removed).toEqual([]);
    expect(fs.existsSync(path.join(repoRootDir, 'manual-one'))).toBe(true);
  });

  it('身份不再命中 → 回收播种装的(先回调 beforeRemove 再删目录)', async () => {
    await writeSeed('vip', { 'main.js': 'v1' });
    await writeConfig({ ghosts: { vip: { audience: { userIds: ['u-alice'] } } } });
    await provision({ identity: alice });
    expect(fs.existsSync(path.join(repoRootDir, 'vip'))).toBe(true);

    const removedIds: string[] = [];
    const outcome = await provision({
      identity: bob,
      beforeRemove: (id) => {
        removedIds.push(id);
        expect(fs.existsSync(path.join(repoRootDir, 'vip'))).toBe(true); // 删目录前被调
      },
    });
    expect(outcome.removed).toEqual(['vip']);
    expect(removedIds).toEqual(['vip']);
    expect(fs.existsSync(path.join(repoRootDir, 'vip'))).toBe(false);
    const state = JSON.parse(await fs.promises.readFile(path.join(repoRootDir, PROVISIONING_STATE_FILE), 'utf-8'));
    expect(state.seeded).toEqual([]);
  });

  it('用户手动装的同 id 意识(不在 seeded 台账)不被回收', async () => {
    await writeSeed('vip', { 'main.js': 'v1' });
    await writeConfig({ ghosts: { vip: { audience: { userIds: ['u-alice'] } } } });
    // 模拟用户手动装入:目录直接在,但从未被播种记账
    await fs.promises.mkdir(path.join(repoRootDir, 'vip'), { recursive: true });
    await fs.promises.writeFile(path.join(repoRootDir, 'vip', 'ghost.json'), JSON.stringify(goodManifest('vip')));

    const outcome = await provision({ identity: null });
    expect(outcome.removed).toEqual([]);
    expect(outcome.skipped).toEqual(['vip']);
    expect(fs.existsSync(path.join(repoRootDir, 'vip'))).toBe(true);
  });

  it('配置文件损坏 → fail-closed:本轮全部跳过,什么都不装', async () => {
    await writeSeed('art', { 'main.js': 'v1' });
    await writeConfig('not json at all');
    const outcome = await provision({ identity: alice });
    expect(outcome.installed).toEqual([]);
    expect(outcome.skipped).toEqual(['art']);
    expect(fs.existsSync(path.join(repoRootDir, 'art'))).toBe(false);
  });

  it("配置条目缺 audience 字段 = 'all';不在配置里的种子也默认 'all'", async () => {
    await writeSeed('a', { 'main.js': 'x' });
    await writeSeed('b', { 'main.js': 'y' });
    await writeConfig({ ghosts: { a: {} } });
    const outcome = await provision({ identity: null });
    expect(outcome.installed.map((m) => m.id).sort()).toEqual(['a', 'b']);
  });

  it('墓碑优先于受众:命中受众但用户删过 → 仍不装回', async () => {
    await writeSeed('vip', { 'main.js': 'v1' });
    await writeConfig({ ghosts: { vip: { audience: { userIds: ['u-alice'] } } } });
    recordBuiltinTombstone(repoRootDir, 'vip');
    const outcome = await provision({ identity: alice });
    expect(outcome.installed).toEqual([]);
    expect(outcome.skipped).toEqual(['vip']);
  });
});

describe('provisionBuiltinGhosts · onApplyStart(UI 提示触发时机)', () => {
  it('有真实变更时整轮恰好触发一次;no-op 对账绝不触发', async () => {
    await writeSeed('a', { 'main.js': 'x' });
    await writeSeed('b', { 'main.js': 'y' });
    let calls = 0;
    await provision({ onApplyStart: () => calls++ });
    expect(calls).toBe(1); // 两个首装,也只触发一次

    await provision({ onApplyStart: () => calls++ });
    expect(calls).toBe(1); // 指纹全一致的 no-op 轮不触发
  });

  it('回收也算真实变更,触发 onApplyStart', async () => {
    await writeSeed('vip', { 'main.js': 'v1' });
    await writeConfig({ ghosts: { vip: { audience: { userIds: ['u-alice'] } } } });
    await provision({ identity: alice });
    let calls = 0;
    await provision({ identity: null, onApplyStart: () => calls++ });
    expect(calls).toBe(1);
  });
});

describe('listRestorableBuiltinGhosts · 可恢复清单(设置页灰态行数据源)', () => {
  it('种子 ∩ 墓碑才列;未删过的不列;恢复流程闭环', async () => {
    await writeSeed('art', { 'main.js': 'v1' });
    await writeSeed('other', { 'main.js': 'x' });
    expect(listRestorableBuiltinGhosts({ seedRootDir, repoRootDir })).toEqual([]);

    recordBuiltinTombstone(repoRootDir, 'art');
    const list = listRestorableBuiltinGhosts({ seedRootDir, repoRootDir });
    expect(list.map((r) => r.id)).toEqual(['art']);
    expect(list[0].name).toBe('Builtin art');
    expect(list[0].version).toBe('1.0.0');
    expect(list[0].manifest.tools).toEqual([{ name: 'do_thing', description: '做点事' }]);

    // 恢复 = 清墓碑 + 对账装回,恢复后不再出现在可恢复清单
    clearBuiltinTombstone(repoRootDir, 'art');
    await provision();
    expect(listRestorableBuiltinGhosts({ seedRootDir, repoRootDir })).toEqual([]);
  });

  it('受众不命中的墓碑不列(恢复了也装不上);配置损坏 fail-closed 返回空', async () => {
    await writeSeed('vip', { 'main.js': 'v1' });
    recordBuiltinTombstone(repoRootDir, 'vip');
    await writeConfig({ ghosts: { vip: { audience: { userIds: ['u-alice'] } } } });
    expect(listRestorableBuiltinGhosts({ seedRootDir, repoRootDir, identity: null })).toEqual([]);
    expect(listRestorableBuiltinGhosts({ seedRootDir, repoRootDir, identity: bob })).toEqual([]);
    expect(listRestorableBuiltinGhosts({ seedRootDir, repoRootDir, identity: alice }).map((r) => r.id)).toEqual([
      'vip',
    ]);

    await writeConfig('broken json');
    expect(listRestorableBuiltinGhosts({ seedRootDir, repoRootDir, identity: alice })).toEqual([]);
  });
});

describe('tier · 企业档分类(仅分组展示,不改播种行为)', () => {
  it('listEnterpriseSeedIds:只列种子里 tier=enterprise 的;缺省/显式 builtin 不列', async () => {
    await writeSeed('corp', { 'main.js': 'x' });
    await writeSeed('pub', { 'main.js': 'y' });
    await writeSeed('explicit', { 'main.js': 'z' });
    await writeConfig({
      ghosts: {
        corp: { audience: 'all', tier: 'enterprise' },
        explicit: { tier: 'builtin' },
        'not-a-seed': { tier: 'enterprise' }, // 配置里有但种子不存在 → 不列
      },
    });
    expect(listEnterpriseSeedIds(seedRootDir)).toEqual(['corp']);
  });

  it('配置缺失或损坏 → 降级空列表(全归内置组),不报错', async () => {
    await writeSeed('corp', { 'main.js': 'x' });
    expect(listEnterpriseSeedIds(seedRootDir)).toEqual([]);
    await writeConfig('broken json');
    expect(listEnterpriseSeedIds(seedRootDir)).toEqual([]);
  });

  it('tier 写错 → 整份配置按损坏处理(与 audience 同一 fail-closed 口径)', async () => {
    await writeSeed('corp', { 'main.js': 'x' });
    await writeConfig({ ghosts: { corp: { tier: 'vip' } } });
    expect(listEnterpriseSeedIds(seedRootDir)).toEqual([]);
    const outcome = await provision();
    expect(outcome.installed).toEqual([]);
    expect(outcome.skipped).toEqual(['corp']);
  });

  it('企业档播种行为与内置完全一致;restorable 行带 tier 供归组', async () => {
    await writeSeed('corp', { 'main.js': 'x' });
    await writeSeed('pub', { 'main.js': 'y' });
    await writeConfig({ ghosts: { corp: { tier: 'enterprise' } } });
    const outcome = await provision();
    expect(outcome.installed.map((m) => m.id).sort()).toEqual(['corp', 'pub']);

    recordBuiltinTombstone(repoRootDir, 'corp');
    recordBuiltinTombstone(repoRootDir, 'pub');
    const list = listRestorableBuiltinGhosts({ seedRootDir, repoRootDir });
    expect(list.find((r) => r.id === 'corp')?.tier).toBe('enterprise');
    expect(list.find((r) => r.id === 'pub')?.tier).toBe('builtin');
  });
});

describe('辅助函数', () => {
  it('listBuiltinSeedIds:只认非点开头子目录,缺根返回空', async () => {
    await writeSeed('b', {});
    await writeSeed('a', {});
    await fs.promises.mkdir(path.join(seedRootDir, '.hidden'));
    await fs.promises.writeFile(path.join(seedRootDir, 'loose-file.txt'), 'x');
    expect(listBuiltinSeedIds(seedRootDir)).toEqual(['a', 'b']);
    expect(listBuiltinSeedIds(path.join(workDir, 'nope'))).toEqual([]);
  });

  it('hashDirContent:内容同则同、异则异、点文件不计入、子目录参与', async () => {
    const d1 = path.join(workDir, 'd1');
    const d2 = path.join(workDir, 'd2');
    for (const d of [d1, d2]) {
      await fs.promises.mkdir(path.join(d, 'sub'), { recursive: true });
      await fs.promises.writeFile(path.join(d, 'a.txt'), 'same');
      await fs.promises.writeFile(path.join(d, 'sub', 'b.txt'), 'same-too');
    }
    await fs.promises.writeFile(path.join(d2, '.disabled'), '');
    expect(await hashDirContent(d1)).toBe(await hashDirContent(d2));

    await fs.promises.writeFile(path.join(d2, 'sub', 'b.txt'), 'changed');
    expect(await hashDirContent(d1)).not.toBe(await hashDirContent(d2));
  });
});
