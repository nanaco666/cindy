import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { gzipSync } from 'node:zlib';
import { afterEach, describe, expect, it } from 'vitest';

import {
  claudeLauncherScript,
  claudeOfficialAssetDescriptor,
  codexOfficialAssetDescriptor,
  extractCodexBinaryFromTarGz,
  legacyManagedBinaryPath,
  privateBinaryPath,
  runtimeInstallRoot,
  runtimeVersionMatchesPin,
} from '../linux-runtime-fallback';

const tempDirs: string[] = [];

afterEach(() => {
  for (const dir of tempDirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

function tarOctal(value: number, length: number): Buffer {
  return Buffer.from(value.toString(8).padStart(length - 1, '0') + '\0');
}

function singleFileTar(name: string, content: Buffer): Buffer {
  const header = Buffer.alloc(512);
  header.write(name, 0, 100, 'utf8');
  tarOctal(0o755, 8).copy(header, 100);
  tarOctal(content.length, 12).copy(header, 124);
  header[156] = 48;
  header.write('ustar\0', 257, 6, 'ascii');
  const padding = Buffer.alloc(Math.ceil(content.length / 512) * 512 - content.length);
  return Buffer.concat([header, content, padding, Buffer.alloc(1024)]);
}

describe('runtimeVersionMatchesPin', () => {
  it('requires Cindy-managed Claude and Codex binaries to match their pins exactly', () => {
    expect(runtimeVersionMatchesPin('claude-code', '2.1.215 (Claude Code)')).toBe(true);
    expect(runtimeVersionMatchesPin('claude-code', '2.1.214 (Claude Code)')).toBe(false);
    expect(runtimeVersionMatchesPin('codex', 'codex-cli 0.144.6')).toBe(true);
    expect(runtimeVersionMatchesPin('codex', 'codex-cli 0.144.5')).toBe(false);
  });

  it('rejects empty or unparsable version output', () => {
    expect(runtimeVersionMatchesPin('claude-code', '')).toBe(false);
    expect(runtimeVersionMatchesPin('codex', 'development build')).toBe(false);
  });
});

describe('install path helpers', () => {
  it('places pinned private binaries under userData/agent-runtime/<kind>/bin', () => {
    expect(runtimeInstallRoot('/userdata', 'codex')).toBe('/userdata/agent-runtime/codex');
    expect(runtimeInstallRoot('/userdata', 'claude-code')).toBe('/userdata/agent-runtime/claude-code');
    expect(privateBinaryPath('/userdata', 'codex')).toBe(
      '/userdata/agent-runtime/codex/bin/codex',
    );
    expect(privateBinaryPath('/userdata', 'claude-code')).toBe(
      '/userdata/agent-runtime/claude-code/bin/claude',
    );
  });

  it('resolves the exact legacy CDN cache path for migration', () => {
    expect(legacyManagedBinaryPath('/userdata', 'claude-code')).toBe(
      '/userdata/claude-code/2.1.215/claude',
    );
    expect(legacyManagedBinaryPath('/userdata', 'codex')).toBe(
      '/userdata/codex/0.144.6/codex',
    );
  });

  it('keeps the Node lookup path in a user-managed Claude launcher', () => {
    const script = claudeLauncherScript('/home/user/.npm/bin/claude', '/home/user/.nvm/bin');
    expect(script).toContain("NODE_BIN_DIR='/home/user/.nvm/bin'");
    expect(script).toContain('export PATH="$NODE_BIN_DIR${PATH:+:$PATH}"');
    expect(script).toContain("exec '/home/user/.npm/bin/claude' \"$@\"");
  });
});

describe('official asset descriptors', () => {
  it('uses the trusted Claude release-manifest checksum and size', () => {
    const sha256 = 'a'.repeat(64);
    expect(claudeOfficialAssetDescriptor('2.1.215', {
      platforms: { 'linux-x64': { checksum: sha256, size: 123 } },
    })).toEqual({
      url: 'https://downloads.claude.ai/claude-code-releases/2.1.215/linux-x64/claude',
      sha256,
      size: 123,
    });
  });

  it('uses the GitHub release asset digest and rejects missing integrity metadata', () => {
    const sha256 = 'b'.repeat(64);
    expect(codexOfficialAssetDescriptor('0.144.6', {
      assets: [{
        name: 'codex-x86_64-unknown-linux-musl.tar.gz',
        browser_download_url: 'https://example.test/codex.tar.gz',
        digest: `sha256:${sha256}`,
        size: 456,
      }],
    })).toEqual({ url: 'https://example.test/codex.tar.gz', sha256, size: 456 });
    expect(() => codexOfficialAssetDescriptor('0.144.6', { assets: [] })).toThrow(
      /trusted SHA-256 digest/,
    );
  });
});

describe('extractCodexBinaryFromTarGz', () => {
  it('extracts the verified archive binary without a system tar dependency', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cindy-codex-tar-'));
    tempDirs.push(dir);
    const archivePath = path.join(dir, 'codex.tar.gz');
    const destinationPath = path.join(dir, 'bin', 'codex');
    fs.writeFileSync(
      archivePath,
      gzipSync(singleFileTar('codex-x86_64-unknown-linux-musl', Buffer.from('codex-binary'))),
    );

    await extractCodexBinaryFromTarGz(archivePath, destinationPath);

    expect(fs.readFileSync(destinationPath, 'utf8')).toBe('codex-binary');
    expect(fs.statSync(destinationPath).mode & 0o111).not.toBe(0);
  });
});
