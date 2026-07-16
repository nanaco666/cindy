import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { createFeishuMcpServer } from '../feishu/mcp/server.js';
import type { FeishuMcpDeps } from '../types.js';

function tools(server: unknown) {
  return (
    server as {
      _registeredTools: Record<string, { handler: (args: unknown) => Promise<unknown> }>;
    }
  )._registeredTools;
}

function parse(result: unknown): Record<string, unknown> {
  const block = (result as { content: Array<{ type: string; text?: string }> }).content[0];
  if (block?.type !== 'text' || typeof block.text !== 'string') {
    throw new Error('expected text block');
  }
  return JSON.parse(block.text) as Record<string, unknown>;
}

describe('feishu im_upload_image file_path boundary', () => {
  let root: string;
  let outsideDir: string;
  let uploadFeishuImage: ReturnType<typeof vi.fn>;

  function makeDeps(workingDir: string | undefined): FeishuMcpDeps {
    return {
      getFeishuClient: () => ({}) as never,
      ensureToken: async () => ({ token: 'tok' }),
      forceRefresh: async () => ({ token: 'tok' }),
      uploadFeishuImage,
      feishuImageMaxBytes: 10 * 1024 * 1024,
      getSessionContext: () => ({ agentKind: 'claude-code', workingDir: workingDir ?? '' }),
      // Unused by this tool path — cast the rest.
    } as unknown as FeishuMcpDeps;
  }

  beforeEach(async () => {
    root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'feishu-up-')));
    outsideDir = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'feishu-out-')));
    uploadFeishuImage = vi.fn(async () => ({ ok: true as const, imageKey: 'img_key' }));
  });

  afterEach(async () => {
    await fs.rm(root, { recursive: true, force: true });
    await fs.rm(outsideDir, { recursive: true, force: true });
  });

  async function callUpload(deps: FeishuMcpDeps, file_path: string) {
    const server = createFeishuMcpServer(deps);
    return tools(server).call_tool.handler({ name: 'im_upload_image', args: { file_path } });
  }

  it('uploads an image inside workingDir with the constrained absolute path', async () => {
    const img = path.join(root, 'pic.png');
    await fs.writeFile(img, 'x', 'utf-8');
    const result = await callUpload(makeDeps(root), 'pic.png');
    expect(parse(result)).toMatchObject({ ok: true });
    expect(uploadFeishuImage).toHaveBeenCalledTimes(1);
    expect(uploadFeishuImage.mock.calls[0][0]).toMatchObject({ absPath: img });
  });

  it('rejects an absolute path outside workingDir (exfil blocked, file never read)', async () => {
    const secret = path.join(outsideDir, 'id_rsa');
    await fs.writeFile(secret, 'PRIVATE', 'utf-8');
    const result = await callUpload(makeDeps(root), secret);
    expect(parse(result)).toMatchObject({ ok: false, errorCode: 'PATH_NOT_ALLOWED' });
    expect(uploadFeishuImage).not.toHaveBeenCalled();
  });

  it('rejects a `..` traversal path', async () => {
    const result = await callUpload(makeDeps(root), '../../etc/hosts');
    expect(parse(result)).toMatchObject({ ok: false, errorCode: 'PATH_NOT_ALLOWED' });
    expect(uploadFeishuImage).not.toHaveBeenCalled();
  });

  it('rejects any upload when workingDir is empty (fail-closed)', async () => {
    const result = await callUpload(makeDeps(''), '/etc/passwd');
    expect(parse(result)).toMatchObject({ ok: false, errorCode: 'PATH_NOT_ALLOWED' });
    expect(uploadFeishuImage).not.toHaveBeenCalled();
  });
});
