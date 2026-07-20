/**
 * localCliDetect 单测 —— 纯函数 + 注入 fs deps,不碰真实 home(规则 23:
 * 测试一律用 os.tmpdir 下的临时目录并收尾清理;本测更进一步,全内存 stub 零落盘)。
 */

import { describe, expect, it } from 'vitest';
import { join } from 'node:path';

import { scanLocalCliAuth, type LocalCliScanDeps } from '../localCliDetect.js';

const HOME = join('/tmp', 'cli-detect-home');

function depsWith(dirs: string[], files: string[]): LocalCliScanDeps {
  const dirSet = new Set(dirs.map((d) => join(HOME, d)));
  const fileSet = new Set(files.map((f) => join(HOME, f)));
  return {
    homeDir: HOME,
    isDirectory: async (p) => dirSet.has(p),
    isFile: async (p) => fileSet.has(p),
  };
}

describe('scanLocalCliAuth', () => {
  it('两个 CLI 都未安装 → installed/loggedIn 全 false', async () => {
    const r = await scanLocalCliAuth(depsWith([], []));
    expect(r).toHaveLength(2);
    expect(r.every((d) => !d.installed && !d.loggedIn)).toBe(true);
  });

  it('claude 已安装已登录 / codex 仅安装未登录', async () => {
    const r = await scanLocalCliAuth(
      depsWith(['.claude', '.codex'], [join('.claude', '.credentials.json')]),
    );
    const claude = r.find((d) => d.cli === 'claude-cli');
    const codex = r.find((d) => d.cli === 'codex-cli');
    expect(claude).toMatchObject({ providerId: 'anthropic', installed: true, loggedIn: true });
    expect(codex).toMatchObject({ providerId: 'openai', installed: true, loggedIn: false });
  });

  it('未安装时不探测凭证文件(即使文件存在也不误报 loggedIn)', async () => {
    // 目录不存在但同名文件存在的顶替场景:installed=false → loggedIn 恒 false。
    const r = await scanLocalCliAuth(depsWith([], [join('.claude', '.credentials.json')]));
    const claude = r.find((d) => d.cli === 'claude-cli');
    expect(claude).toMatchObject({ installed: false, loggedIn: false });
  });

  it('探测抛错按未安装处理(fail-quiet)', async () => {
    const deps: LocalCliScanDeps = {
      homeDir: HOME,
      isDirectory: async () => {
        throw new Error('EACCES');
      },
      isFile: async () => true,
    };
    // createLocalCliScanDeps 生产实现在 stat 层吞错;这里验证 handler 侧约定:
    // deps 抛错时由 handler 降级空数组 —— scanLocalCliAuth 本身不吞 deps 的异常。
    await expect(scanLocalCliAuth(deps)).rejects.toThrow('EACCES');
  });
});
