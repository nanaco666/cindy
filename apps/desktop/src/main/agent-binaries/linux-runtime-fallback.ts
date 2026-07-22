/**
 * Packaged Linux runtime fallback for Claude Code / Codex binaries.
 *
 * Linux manifests intentionally do not publish agent assets. The packaged app
 * first reuses a compatible system CLI, then migrates the legacy Cindy-managed
 * cache, and finally downloads the pinned official binary with SHA-256
 * verification. No system Node/npm/curl installation is required.
 */
import { execFile } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { pipeline } from 'node:stream/promises';
import { createGunzip } from 'node:zlib';
import { app, net } from 'electron';

import claudeLatest from '../../../../../tools/claude/latest.json';
import codexLatest from '../../../../../tools/codex/latest.json';
import { download, type ProgressEvent } from '../downloader/index.js';

export type LinuxRuntimeFallbackKind = 'claude-code' | 'codex';

interface RuntimeConfig {
  commandName: string;
  version: string;
}

interface OfficialAssetDescriptor {
  url: string;
  sha256: string;
  size?: number;
}

const CONFIG: Record<LinuxRuntimeFallbackKind, RuntimeConfig> = {
  'claude-code': {
    commandName: 'claude',
    version: (claudeLatest as { version: string }).version,
  },
  codex: {
    commandName: 'codex',
    version: (codexLatest as { version: string }).version,
  },
};

const STARTUP_INSTALL_TIMEOUT_MS = 5 * 60_000;
const VERIFY_TIMEOUT_MS = 15_000;
const LOOKUP_TIMEOUT_MS = 5_000;
const JSON_RESPONSE_LIMIT_BYTES = 4 * 1024 * 1024;
const LINUX_PLATFORM_KEY = 'linux-x64';
const CODEX_LINUX_ASSET = 'codex-x86_64-unknown-linux-musl.tar.gz';

function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

function commandLookupScript(commandName: string): string {
  const quotedName = shellQuote(commandName);
  return `
name=${quotedName}
if command -v "$name" >/dev/null 2>&1; then
  command -v "$name"
  exit 0
fi
for dir in "$HOME/.local/bin" "$HOME/.npm-global/bin" "$HOME/.npm/bin" "/usr/local/bin" "/usr/bin"; do
  candidate="$dir/$name"
  if [ -x "$candidate" ]; then
    printf '%s\\n' "$candidate"
    exit 0
  fi
done
exit 1
`.trim();
}

export function runtimeInstallRoot(userDataPath: string, kind: LinuxRuntimeFallbackKind): string {
  return path.join(userDataPath, 'agent-runtime', kind);
}

export function privateBinaryPath(userDataPath: string, kind: LinuxRuntimeFallbackKind): string {
  return path.join(runtimeInstallRoot(userDataPath, kind), 'bin', CONFIG[kind].commandName);
}

function runtimeVersionMarkerPath(
  userDataPath: string,
  kind: LinuxRuntimeFallbackKind,
): string {
  return path.join(runtimeInstallRoot(userDataPath, kind), '.version');
}

/** Path used by the previous CDN-backed BinaryProvisioner. */
export function legacyManagedBinaryPath(
  userDataPath: string,
  kind: LinuxRuntimeFallbackKind,
): string {
  return path.join(userDataPath, kind, CONFIG[kind].version, CONFIG[kind].commandName);
}

/** Keep a user-managed npm Claude shim runnable from a desktop-file launch. */
export function claudeLauncherScript(packageBinaryPath: string, nodeBinDir: string): string {
  return `#!/bin/sh
NODE_BIN_DIR=${shellQuote(nodeBinDir)}
export PATH="$NODE_BIN_DIR\${PATH:+:$PATH}"
exec ${shellQuote(packageBinaryPath)} "$@"
`;
}

function materializeSystemClaudeLauncher(candidate: string, nodeBinDir: string): string {
  const destination = privateBinaryPath(app.getPath('userData'), 'claude-code');
  const tempPath = `${destination}.launcher-${process.pid}`;
  fs.mkdirSync(path.dirname(destination), { recursive: true });
  try {
    fs.writeFileSync(tempPath, claudeLauncherScript(candidate, nodeBinDir), {
      encoding: 'utf8',
      mode: 0o755,
    });
    fs.renameSync(tempPath, destination);
    return destination;
  } finally {
    try { fs.rmSync(tempPath, { force: true }); } catch { /* ignore */ }
  }
}

function legacyVerifiedMarkerPath(
  userDataPath: string,
  kind: LinuxRuntimeFallbackKind,
): string {
  return path.join(path.dirname(legacyManagedBinaryPath(userDataPath, kind)), '.verified');
}

function readText(filePath: string): string | null {
  try {
    return fs.readFileSync(filePath, 'utf8').trim() || null;
  } catch {
    return null;
  }
}

function writeRuntimeVersionMarker(userDataPath: string, kind: LinuxRuntimeFallbackKind): void {
  fs.writeFileSync(runtimeVersionMarkerPath(userDataPath, kind), `${CONFIG[kind].version}\n`);
}

function normalizeSha256(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const normalized = value.replace(/^sha256:/i, '').toLowerCase();
  return /^[0-9a-f]{64}$/.test(normalized) ? normalized : null;
}

function parseVersionOutput(versionOutput: string): string | null {
  const match = versionOutput.trim().match(/\bv?(\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?)\b/i);
  return match?.[1] ?? null;
}

/** Cindy-managed binaries must match the repository pin exactly. */
export function runtimeVersionMatchesPin(
  kind: LinuxRuntimeFallbackKind,
  versionOutput: string,
): boolean {
  return parseVersionOutput(versionOutput) === CONFIG[kind].version;
}

function probeCancelledError(command: string): Error {
  return new Error(`${path.basename(command)} install cancelled`);
}

/** Run a short CLI probe without blocking Electron's main thread. */
function execProbe(
  command: string,
  args: string[],
  options: { env?: NodeJS.ProcessEnv; signal?: AbortSignal; timeoutMs: number },
): Promise<{ stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    if (options.signal?.aborted) {
      reject(probeCancelledError(command));
      return;
    }
    execFile(
      command,
      args,
      {
        encoding: 'utf8',
        env: options.env,
        signal: options.signal,
        timeout: options.timeoutMs,
        windowsHide: true,
      },
      (error, stdout, stderr) => {
        if (error) {
          reject(options.signal?.aborted ? probeCancelledError(command) : error);
          return;
        }
        resolve({ stdout: String(stdout), stderr: String(stderr) });
      },
    );
  });
}

async function findCommandAsync(
  commandName: string,
  signal?: AbortSignal,
): Promise<string | null> {
  try {
    const result = await execProbe('/bin/sh', ['-c', commandLookupScript(commandName)], {
      signal,
      timeoutMs: LOOKUP_TIMEOUT_MS,
    });
    return result.stdout.split(/\r?\n/).map((line) => line.trim()).find(Boolean) ?? null;
  } catch {
    if (signal?.aborted) throw probeCancelledError(commandName);
    return null;
  }
}

async function readExecutableVersion(
  binaryPath: string,
  signal?: AbortSignal,
): Promise<string | null> {
  try {
    fs.accessSync(binaryPath, fs.constants.X_OK);
    const result = await execProbe(binaryPath, ['--version'], {
      signal,
      timeoutMs: VERIFY_TIMEOUT_MS,
    });
    return result.stdout || result.stderr;
  } catch {
    if (signal?.aborted) throw probeCancelledError(binaryPath);
    return null;
  }
}

async function findSystemBinaryAsync(
  kind: LinuxRuntimeFallbackKind,
  signal?: AbortSignal,
): Promise<string | null> {
  const candidate = await findCommandAsync(CONFIG[kind].commandName, signal);
  if (!candidate) return null;
  const versionOutput = await readExecutableVersion(candidate, signal);
  if (!versionOutput) return null;
  // Preserve the historical behavior for a user-managed Claude CLI. Codex's
  // app-server protocol is versioned and must match the repository pin.
  if (kind === 'claude-code') {
    const nodePath = await findCommandAsync('node', signal);
    if (!nodePath) return candidate;
    try {
      const launcher = materializeSystemClaudeLauncher(candidate, path.dirname(nodePath));
      return await readExecutableVersion(launcher, signal) ? launcher : candidate;
    } catch {
      if (signal?.aborted) throw probeCancelledError(candidate);
      return candidate;
    }
  }
  if (runtimeVersionMatchesPin(kind, versionOutput)) return candidate;
  return null;
}

function privateBinaryCandidates(
  userDataPath: string,
  kind: LinuxRuntimeFallbackKind,
): string[] {
  const canonical = privateBinaryPath(userDataPath, kind);
  if (kind !== 'codex') return [canonical];
  // Compatibility with the first private installer implementation.
  return [
    canonical,
    path.join(
      runtimeInstallRoot(userDataPath, kind),
      'codex-home',
      'packages',
      'standalone',
      'current',
      'codex',
    ),
  ];
}

async function findPrivateBinaryAsync(
  kind: LinuxRuntimeFallbackKind,
  signal?: AbortSignal,
): Promise<string | null> {
  const userDataPath = app.getPath('userData');
  for (const candidate of privateBinaryCandidates(userDataPath, kind)) {
    const versionOutput = await readExecutableVersion(candidate, signal);
    if (versionOutput && runtimeVersionMatchesPin(kind, versionOutput)) {
      writeRuntimeVersionMarker(userDataPath, kind);
      return candidate;
    }
  }
  try { fs.rmSync(runtimeVersionMarkerPath(userDataPath, kind), { force: true }); } catch { /* ignore */ }
  return null;
}

async function migrateLegacyManagedBinary(
  kind: LinuxRuntimeFallbackKind,
  signal?: AbortSignal,
): Promise<string | null> {
  const userDataPath = app.getPath('userData');
  const legacyPath = legacyManagedBinaryPath(userDataPath, kind);
  if (!fs.existsSync(legacyVerifiedMarkerPath(userDataPath, kind))) return null;
  const versionOutput = await readExecutableVersion(legacyPath, signal);
  if (!versionOutput || !runtimeVersionMatchesPin(kind, versionOutput)) return null;

  const destination = privateBinaryPath(userDataPath, kind);
  const tempPath = `${destination}.migrate-${process.pid}`;
  fs.mkdirSync(path.dirname(destination), { recursive: true });
  try {
    fs.copyFileSync(legacyPath, tempPath, fs.constants.COPYFILE_FICLONE);
    fs.chmodSync(tempPath, 0o755);
    fs.renameSync(tempPath, destination);
    writeRuntimeVersionMarker(userDataPath, kind);
    return destination;
  } finally {
    try { fs.rmSync(tempPath, { force: true }); } catch { /* ignore */ }
  }
}

/**
 * Synchronous status query: only inspect known paths and version markers. CLI
 * execution and PATH lookup stay on the async startup path.
 */
export function findCachedLinuxRuntimeFallbackBinary(
  kind: LinuxRuntimeFallbackKind,
): string | null {
  if (!app.isPackaged || process.platform !== 'linux') return null;
  const userDataPath = app.getPath('userData');
  if (readText(runtimeVersionMarkerPath(userDataPath, kind)) === CONFIG[kind].version) {
    for (const candidate of privateBinaryCandidates(userDataPath, kind)) {
      try {
        fs.accessSync(candidate, fs.constants.X_OK);
        return candidate;
      } catch {
        // Try the next compatible private layout.
      }
    }
  }

  const legacyPath = legacyManagedBinaryPath(userDataPath, kind);
  try {
    fs.accessSync(legacyPath, fs.constants.X_OK);
    fs.accessSync(legacyVerifiedMarkerPath(userDataPath, kind));
    return legacyPath;
  } catch {
    return null;
  }
}

function fetchJson(
  url: string,
  options: { signal?: AbortSignal; timeoutMs?: number } = {},
): Promise<unknown> {
  return new Promise((resolve, reject) => {
    if (options.signal?.aborted) {
      reject(new Error(`request cancelled: ${url}`));
      return;
    }

    const request = net.request({ url, method: 'GET', redirect: 'follow' });
    let settled = false;
    let body = '';
    const finish = (fn: () => void): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      options.signal?.removeEventListener('abort', onAbort);
      fn();
    };
    const onAbort = (): void => {
      try { request.abort(); } catch { /* ignore */ }
      finish(() => reject(new Error(`request cancelled: ${url}`)));
    };
    const timeout = setTimeout(() => {
      try { request.abort(); } catch { /* ignore */ }
      finish(() => reject(new Error(`request timed out: ${url}`)));
    }, options.timeoutMs ?? 15_000);

    options.signal?.addEventListener('abort', onAbort, { once: true });
    if (options.signal?.aborted) {
      onAbort();
      return;
    }

    request.on('response', (response) => {
      if (response.statusCode < 200 || response.statusCode >= 300) {
        finish(() => reject(new Error(`HTTP ${response.statusCode}: ${url}`)));
        return;
      }
      response.on('data', (chunk: Buffer) => {
        body += chunk.toString('utf8');
        if (Buffer.byteLength(body, 'utf8') > JSON_RESPONSE_LIMIT_BYTES) {
          try { request.abort(); } catch { /* ignore */ }
          finish(() => reject(new Error(`JSON response too large: ${url}`)));
        }
      });
      response.on('end', () => {
        finish(() => {
          try {
            resolve(JSON.parse(body));
          } catch (error) {
            reject(new Error(`invalid JSON from ${url}: ${error instanceof Error ? error.message : String(error)}`));
          }
        });
      });
      response.on('error', (error) => finish(() => reject(error)));
    });
    request.on('error', (error) => finish(() => reject(error)));
    request.end();
  });
}

export function claudeOfficialAssetDescriptor(
  version: string,
  manifest: unknown,
): OfficialAssetDescriptor {
  const entry = (manifest as {
    platforms?: Record<string, { checksum?: unknown; size?: unknown }>;
  })?.platforms?.[LINUX_PLATFORM_KEY];
  const sha256 = normalizeSha256(entry?.checksum);
  if (!sha256) throw new Error(`Claude ${version} manifest lacks a trusted linux-x64 checksum`);
  const size = typeof entry?.size === 'number' && entry.size > 0 ? entry.size : undefined;
  return {
    url: `https://downloads.claude.ai/claude-code-releases/${version}/${LINUX_PLATFORM_KEY}/claude`,
    sha256,
    ...(size ? { size } : {}),
  };
}

export function codexOfficialAssetDescriptor(
  version: string,
  release: unknown,
): OfficialAssetDescriptor {
  const asset = (release as {
    assets?: Array<{
      name?: unknown;
      browser_download_url?: unknown;
      digest?: unknown;
      size?: unknown;
    }>;
  })?.assets?.find((candidate) => candidate.name === CODEX_LINUX_ASSET);
  const sha256 = normalizeSha256(asset?.digest);
  if (!asset || typeof asset.browser_download_url !== 'string' || !sha256) {
    throw new Error(`Codex ${version} release lacks ${CODEX_LINUX_ASSET} with a trusted SHA-256 digest`);
  }
  const size = typeof asset.size === 'number' && asset.size > 0 ? asset.size : undefined;
  return {
    url: asset.browser_download_url,
    sha256,
    ...(size ? { size } : {}),
  };
}

function parseTarString(buffer: Buffer, start: number, length: number): string {
  const end = buffer.indexOf(0, start);
  const sliceEnd = end >= start && end < start + length ? end : start + length;
  return buffer.subarray(start, sliceEnd).toString('utf8').trim();
}

/** Extract the single Codex binary from an already SHA-verified tar.gz. */
export async function extractCodexBinaryFromTarGz(
  archivePath: string,
  destinationPath: string,
): Promise<void> {
  const tarPath = `${archivePath}.tar-${process.pid}`;
  const tempDestination = `${destinationPath}.extract-${process.pid}`;
  try {
    await pipeline(
      fs.createReadStream(archivePath),
      createGunzip(),
      fs.createWriteStream(tarPath, { mode: 0o600 }),
    );
    const tarSize = fs.statSync(tarPath).size;
    const fd = fs.openSync(tarPath, 'r');
    try {
      let offset = 0;
      while (offset + 512 <= tarSize) {
        const header = Buffer.alloc(512);
        if (fs.readSync(fd, header, 0, header.length, offset) !== header.length) break;
        if (header.every((byte) => byte === 0)) break;
        const name = parseTarString(header, 0, 100);
        const prefix = parseTarString(header, 345, 155);
        const fullName = prefix ? `${prefix}/${name}` : name;
        const sizeText = parseTarString(header, 124, 12).replace(/\0/g, '').trim();
        const entrySize = Number.parseInt(sizeText || '0', 8);
        if (!Number.isSafeInteger(entrySize) || entrySize < 0) {
          throw new Error(`invalid tar entry size for ${fullName}`);
        }
        const dataOffset = offset + 512;
        const nextOffset = dataOffset + Math.ceil(entrySize / 512) * 512;
        if (nextOffset > tarSize) throw new Error(`truncated tar entry: ${fullName}`);
        const typeFlag = header[156];
        const isRegularFile = typeFlag === 0 || typeFlag === 48;
        const expectedBinaryName = CODEX_LINUX_ASSET.replace(/\.tar\.gz$/, '');
        if (isRegularFile && path.basename(fullName) === expectedBinaryName && entrySize > 0) {
          fs.mkdirSync(path.dirname(destinationPath), { recursive: true });
          await pipeline(
            fs.createReadStream(tarPath, { start: dataOffset, end: dataOffset + entrySize - 1 }),
            fs.createWriteStream(tempDestination, { mode: 0o755 }),
          );
          fs.chmodSync(tempDestination, 0o755);
          fs.renameSync(tempDestination, destinationPath);
          return;
        }
        offset = nextOffset;
      }
    } finally {
      fs.closeSync(fd);
    }
    throw new Error(`Codex binary not found in ${archivePath}`);
  } finally {
    try { fs.rmSync(tarPath, { force: true }); } catch { /* ignore */ }
    try { fs.rmSync(tempDestination, { force: true }); } catch { /* ignore */ }
  }
}

async function installClaudeFromOfficialAsset(
  signal?: AbortSignal,
  onProgress?: (event: ProgressEvent) => void,
): Promise<string> {
  const version = CONFIG['claude-code'].version;
  const manifestUrl = `https://downloads.claude.ai/claude-code-releases/${version}/manifest.json`;
  const descriptor = claudeOfficialAssetDescriptor(
    version,
    await fetchJson(manifestUrl, { signal }),
  );
  const binaryPath = privateBinaryPath(app.getPath('userData'), 'claude-code');
  fs.mkdirSync(path.dirname(binaryPath), { recursive: true });
  await download({
    url: descriptor.url,
    targetPath: binaryPath,
    sha256: descriptor.sha256,
    expectedSize: descriptor.size,
    signal,
    onProgress,
  });
  fs.chmodSync(binaryPath, 0o755);
  const versionOutput = await readExecutableVersion(binaryPath, signal);
  if (!versionOutput || !runtimeVersionMatchesPin('claude-code', versionOutput)) {
    throw new Error(`Claude Code ${version} downloaded but failed version verification`);
  }
  writeRuntimeVersionMarker(app.getPath('userData'), 'claude-code');
  return binaryPath;
}

async function installCodexFromOfficialAsset(
  signal?: AbortSignal,
  onProgress?: (event: ProgressEvent) => void,
): Promise<string> {
  const version = CONFIG.codex.version;
  const releaseUrl = `https://api.github.com/repos/openai/codex/releases/tags/rust-v${version}`;
  const descriptor = codexOfficialAssetDescriptor(
    version,
    await fetchJson(releaseUrl, { signal }),
  );
  const root = runtimeInstallRoot(app.getPath('userData'), 'codex');
  const archivePath = path.join(root, `${CODEX_LINUX_ASSET}.${version}`);
  const binaryPath = privateBinaryPath(app.getPath('userData'), 'codex');
  fs.mkdirSync(root, { recursive: true });
  await download({
    url: descriptor.url,
    targetPath: archivePath,
    sha256: descriptor.sha256,
    expectedSize: descriptor.size,
    signal,
    onProgress,
  });
  await extractCodexBinaryFromTarGz(archivePath, binaryPath);
  try { fs.rmSync(archivePath, { force: true }); } catch { /* ignore */ }
  const versionOutput = await readExecutableVersion(binaryPath, signal);
  if (!versionOutput || !runtimeVersionMatchesPin('codex', versionOutput)) {
    throw new Error(`Codex ${version} downloaded but failed version verification`);
  }
  writeRuntimeVersionMarker(app.getPath('userData'), 'codex');
  return binaryPath;
}

export async function prepareLinuxRuntimeFallback(
  kind: LinuxRuntimeFallbackKind,
  options: { signal?: AbortSignal; onProgress?: (event: ProgressEvent) => void } = {},
): Promise<{
  ready: boolean;
  binaryPath: string;
  installed: boolean;
  source: 'private' | 'legacy' | 'system' | 'installed';
  error?: string;
}> {
  if (!app.isPackaged || process.platform !== 'linux') {
    return { ready: false, binaryPath: '', installed: false, source: 'system', error: 'not_linux_packaged' };
  }

  const timeoutSignal = AbortSignal.timeout(STARTUP_INSTALL_TIMEOUT_MS);
  const signal = options.signal
    ? AbortSignal.any([options.signal, timeoutSignal])
    : timeoutSignal;

  const privatePath = await findPrivateBinaryAsync(kind, signal);
  if (privatePath) return { ready: true, binaryPath: privatePath, installed: false, source: 'private' };

  const legacyPath = await migrateLegacyManagedBinary(kind, signal);
  if (legacyPath) return { ready: true, binaryPath: legacyPath, installed: false, source: 'legacy' };

  const systemPath = await findSystemBinaryAsync(kind, signal);
  if (systemPath) return { ready: true, binaryPath: systemPath, installed: false, source: 'system' };

  if (signal.aborted) throw new Error(`${kind} install cancelled`);
  const binaryPath = kind === 'codex'
    ? await installCodexFromOfficialAsset(signal, options.onProgress)
    : await installClaudeFromOfficialAsset(signal, options.onProgress);
  return { ready: true, binaryPath, installed: true, source: 'installed' };
}
