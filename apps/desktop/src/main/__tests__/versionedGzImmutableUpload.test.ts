// uploadVersionedGzImmutable(scripts/ci/lib.mjs)的回归测试。
//
// 背景:2026-07-03 事故——同一版本号的 claude.exe.gz 被两次发版重复 gzip + 覆盖上传,
// 字节不同(gzip 不可复现),manifest 指向新字节而内网 CDN 边缘缓存旧字节,客户端
// sha256 校验失败,内网 Windows 用户全部「环境初始化失败」。
// 守卫的行为契约(必须被这些用例钉死):
//   - 远端不存在 → 上传,并带 x-oss-meta sha 元数据
//   - 远端存在且二进制同源 → 绝不覆盖,复用远端 sha256/size
//   - 远端存在但二进制不同 → 默认抛错;force 才允许覆盖
//   - 远端老对象无 meta → 下载解压复核,不允许拿本地哈希凑数
import { createRequire } from 'node:module';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import zlib from 'node:zlib';
import { afterEach, describe, expect, it, vi } from 'vitest';

const require = createRequire(import.meta.url);
const { uploadVersionedGzImmutable } = require('../../../scripts/ci/lib.mjs') as {
  uploadVersionedGzImmutable: (args: {
    client: unknown;
    ossKey: string;
    gzPath: string;
    gzSha256: string;
    gzSize: number;
    binarySha256: string;
    force?: boolean;
  }) => Promise<{ uploaded: boolean; gzSha256: string; gzSize: number; binarySha256: string }>;
};

function sha256Hex(buf: Buffer): string {
  return crypto.createHash('sha256').update(buf).digest('hex');
}

const tempFiles: string[] = [];

function writeTempFile(name: string, content: Buffer): string {
  const p = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'gz-guard-')), name);
  fs.writeFileSync(p, content);
  tempFiles.push(path.dirname(p));
  return p;
}

afterEach(() => {
  for (const dir of tempFiles.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// 本地待发布的二进制与 gz(level 1 与 level 9 产出字节不同的 gz,内容同源——
// 模拟"同一个 exe 两次 gzip 字节漂移"的事故场景)
const binaryContent = Buffer.from('fake-agent-binary-content-for-immutable-guard-test');
const binarySha = sha256Hex(binaryContent);
const localGzBytes = zlib.gzipSync(binaryContent, { level: 1 });
const localGzSha = sha256Hex(localGzBytes);
const remoteGzBytes = zlib.gzipSync(binaryContent, { level: 9 });
const remoteGzSha = sha256Hex(remoteGzBytes);

function notFoundError(): Error & { status: number } {
  return Object.assign(new Error('Object not found'), { status: 404 });
}

interface FakeClient {
  head: ReturnType<typeof vi.fn>;
  get: ReturnType<typeof vi.fn>;
  put: ReturnType<typeof vi.fn>;
  multipartUpload: ReturnType<typeof vi.fn>;
}

function makeClient(overrides: Partial<FakeClient> = {}): FakeClient {
  return {
    head: vi.fn(async () => { throw notFoundError(); }),
    get: vi.fn(async () => { throw new Error('unexpected get'); }),
    put: vi.fn(async () => ({})),
    multipartUpload: vi.fn(async () => ({})),
    ...overrides,
  };
}

function headResult(meta: Record<string, string>, size: number) {
  return { meta, res: { headers: { 'content-length': String(size) } } };
}

describe('uploadVersionedGzImmutable', () => {
  it('远端不存在 → 上传并写 sha meta,manifest 用本地哈希', async () => {
    const gzPath = writeTempFile('claude.exe.gz', localGzBytes);
    const client = makeClient();

    const result = await uploadVersionedGzImmutable({
      client,
      ossKey: 'xdt-maker/claude-code/9.9.9/win32-x64/claude.exe.gz',
      gzPath,
      gzSha256: localGzSha,
      gzSize: localGzBytes.length,
      binarySha256: binarySha,
    });

    expect(result).toEqual({
      uploaded: true,
      gzSha256: localGzSha,
      gzSize: localGzBytes.length,
      binarySha256: binarySha,
    });
    expect(client.put).toHaveBeenCalledTimes(1);
    const [, , options] = client.put.mock.calls[0];
    expect(options.meta).toEqual({ 'gz-sha256': localGzSha, 'binary-sha256': binarySha });
  });

  it('大文件(>10MB)走 multipartUpload 分支,meta 同样透传', async () => {
    // 真实 claude/codex gz 都是 70-110MB,生产路径走的就是 multipart——meta 透传
    // 是本次对 uploadToOSS 的唯一改动点,必须在这条分支上钉死。
    const bigBytes = Buffer.alloc(11 * 1024 * 1024, 7);
    const bigSha = sha256Hex(bigBytes);
    const gzPath = writeTempFile('claude.exe.gz', bigBytes);
    const client = makeClient();

    const result = await uploadVersionedGzImmutable({
      client,
      ossKey: 'xdt-maker/claude-code/9.9.9/win32-x64/claude.exe.gz',
      gzPath,
      gzSha256: bigSha,
      gzSize: bigBytes.length,
      binarySha256: binarySha,
    });

    expect(result.uploaded).toBe(true);
    expect(client.put).not.toHaveBeenCalled();
    expect(client.multipartUpload).toHaveBeenCalledTimes(1);
    const [, , options] = client.multipartUpload.mock.calls[0];
    expect(options.meta).toEqual({ 'gz-sha256': bigSha, 'binary-sha256': binarySha });
  });

  it('远端有 meta 但 HEAD 缺 content-length → 强制下载复核,不让 size:0 进 manifest', async () => {
    const gzPath = writeTempFile('claude.exe.gz', localGzBytes);
    const client = makeClient({
      head: vi.fn(async () => ({
        meta: { 'gz-sha256': remoteGzSha, 'binary-sha256': binarySha },
        res: { headers: {} },
      })),
      get: vi.fn(async (_key: string, destPath: string) => {
        fs.writeFileSync(destPath, remoteGzBytes);
        return {};
      }),
    });

    const result = await uploadVersionedGzImmutable({
      client,
      ossKey: 'xdt-maker/claude-code/9.9.9/win32-x64/claude.exe.gz',
      gzPath,
      gzSha256: localGzSha,
      gzSize: localGzBytes.length,
      binarySha256: binarySha,
    });

    expect(client.get).toHaveBeenCalledTimes(1);
    expect(result).toEqual({
      uploaded: false,
      gzSha256: remoteGzSha,
      gzSize: remoteGzBytes.length,
      binarySha256: binarySha,
    });
  });

  it('远端已有同源对象(meta 齐全)→ 不上传,复用远端 sha256/size', async () => {
    const gzPath = writeTempFile('claude.exe.gz', localGzBytes);
    const client = makeClient({
      head: vi.fn(async () =>
        headResult({ 'gz-sha256': remoteGzSha, 'binary-sha256': binarySha }, remoteGzBytes.length),
      ),
    });

    const result = await uploadVersionedGzImmutable({
      client,
      ossKey: 'xdt-maker/claude-code/9.9.9/win32-x64/claude.exe.gz',
      gzPath,
      gzSha256: localGzSha,
      gzSize: localGzBytes.length,
      binarySha256: binarySha,
    });

    // manifest 必须描述远端对象(用户实际下载的字节),不是本地重压的等价 gz
    expect(result).toEqual({
      uploaded: false,
      gzSha256: remoteGzSha,
      gzSize: remoteGzBytes.length,
      binarySha256: binarySha,
    });
    expect(client.put).not.toHaveBeenCalled();
    expect(client.multipartUpload).not.toHaveBeenCalled();
  });

  it('远端老对象无 meta → 下载解压复核后复用,不拿本地哈希凑数', async () => {
    const gzPath = writeTempFile('claude.exe.gz', localGzBytes);
    const client = makeClient({
      head: vi.fn(async () => headResult({}, remoteGzBytes.length)),
      get: vi.fn(async (_key: string, destPath: string) => {
        fs.writeFileSync(destPath, remoteGzBytes);
        return {};
      }),
    });

    const result = await uploadVersionedGzImmutable({
      client,
      ossKey: 'xdt-maker/claude-code/9.9.9/win32-x64/claude.exe.gz',
      gzPath,
      gzSha256: localGzSha,
      gzSize: localGzBytes.length,
      binarySha256: binarySha,
    });

    expect(client.get).toHaveBeenCalledTimes(1);
    expect(result).toEqual({
      uploaded: false,
      gzSha256: remoteGzSha,
      gzSize: remoteGzBytes.length,
      binarySha256: binarySha,
    });
    expect(client.put).not.toHaveBeenCalled();
  });

  it('远端存在不同二进制且未 force → 抛错拒绝覆盖', async () => {
    const gzPath = writeTempFile('claude.exe.gz', localGzBytes);
    const otherBinarySha = sha256Hex(Buffer.from('a-different-binary'));
    const client = makeClient({
      head: vi.fn(async () =>
        headResult({ 'gz-sha256': remoteGzSha, 'binary-sha256': otherBinarySha }, remoteGzBytes.length),
      ),
    });

    await expect(
      uploadVersionedGzImmutable({
        client,
        ossKey: 'xdt-maker/claude-code/9.9.9/win32-x64/claude.exe.gz',
        gzPath,
        gzSha256: localGzSha,
        gzSize: localGzBytes.length,
        binarySha256: binarySha,
      }),
    ).rejects.toThrow(/immutable guard/);
    expect(client.put).not.toHaveBeenCalled();
    expect(client.multipartUpload).not.toHaveBeenCalled();
  });

  it('远端存在不同二进制 + force → 允许覆盖上传', async () => {
    const gzPath = writeTempFile('claude.exe.gz', localGzBytes);
    const otherBinarySha = sha256Hex(Buffer.from('a-different-binary'));
    const client = makeClient({
      head: vi.fn(async () =>
        headResult({ 'gz-sha256': remoteGzSha, 'binary-sha256': otherBinarySha }, remoteGzBytes.length),
      ),
    });

    const result = await uploadVersionedGzImmutable({
      client,
      ossKey: 'xdt-maker/claude-code/9.9.9/win32-x64/claude.exe.gz',
      gzPath,
      gzSha256: localGzSha,
      gzSize: localGzBytes.length,
      binarySha256: binarySha,
      force: true,
    });

    expect(result.uploaded).toBe(true);
    expect(result.gzSha256).toBe(localGzSha);
    expect(client.put).toHaveBeenCalledTimes(1);
  });

  it('force + 远端同源 → 仍复用远端,不做无意义覆盖(防止重新制造字节分裂)', async () => {
    const gzPath = writeTempFile('claude.exe.gz', localGzBytes);
    const client = makeClient({
      head: vi.fn(async () =>
        headResult({ 'gz-sha256': remoteGzSha, 'binary-sha256': binarySha }, remoteGzBytes.length),
      ),
    });

    const result = await uploadVersionedGzImmutable({
      client,
      ossKey: 'xdt-maker/claude-code/9.9.9/win32-x64/claude.exe.gz',
      gzPath,
      gzSha256: localGzSha,
      gzSize: localGzBytes.length,
      binarySha256: binarySha,
      force: true,
    });

    expect(result.uploaded).toBe(false);
    expect(result.gzSha256).toBe(remoteGzSha);
    expect(client.put).not.toHaveBeenCalled();
  });
});
