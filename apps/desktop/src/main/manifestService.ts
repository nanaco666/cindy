/**
 * manifestService.ts
 * ---------------------------------------------------------------------------
 * Fetches and caches the CDN manifest.json that drives both app hot-updates
 * and Claude Code binary management.
 *
 * - CDN base URLs (external + intranet mirror) come from the client endpoint
 *   manifest (`getClientEndpoint('cdnBaseUrl' / 'cdnInternalBaseUrl')`) — the
 *   endpoint manifest is resolved blocking-style BEFORE any update check
 *   (bootstrap-electron: initClientEndpoints → …later… update chain), so all
 *   reads here happen strictly after init. Base URLs are therefore read
 *   lazily inside functions — NEVER capture them in module-level constants
 *   (module evaluation happens before initClientEndpoints and would throw).
 * - In dev mode (app.isPackaged === false), fetching is skipped entirely.
 */

import { app, net } from 'electron';
import * as canaryFlagStore from './canaryFlagStore';

import { createLogger } from './logger';
import { getClientEndpoint } from './clientEndpointsService';

const log = createLogger('manifestService');

// ── Types ──────────────────────────────────────────────────────────────────

export interface PlatformAsset {
  /** Relative path under baseUrl, e.g. "claude-code/2.1.108/win32-x64/claude.exe.gz" */
  file: string;
  sha256: string;
  size: number;
}

export interface AppManifest {
  version: string;
  releaseNotes?: string;
  /** Hotfix ZIP for auto-update */
  hotfix?: PlatformAsset;
  /** Full installer for fresh install / manual download */
  installer?: PlatformAsset;
  /**
   * Force users to re-authorize Feishu after auto-update relaunch into this version.
   * Set true when the release adds new Feishu OAuth scopes / changes auth contract.
   * Consumed once on the first launch of the new version, then cleared.
   */
  requireRelogin?: boolean;
}

export interface ClaudeCodeManifest {
  version: string;
  file: string;
  sha256: string;
  size: number;
  binarySha256?: string;
}

export interface CodexManifest {
  version: string;
  file: string;
  sha256: string;
  size: number;
  binarySha256?: string;
}

export interface RipgrepManifest {
  version: string;
  file: string;
  sha256: string;
  size: number;
  binarySha256?: string;
}

export interface Manifest {
  app: AppManifest;
  claudeCode: ClaudeCodeManifest;
  codex?: CodexManifest;
  ripgrep?: RipgrepManifest;
}

// ── Constants ──────────────────────────────────────────────────────────────

const REQUEST_TIMEOUT_MS = 30_000;

// 惰性读取(见文件顶注):清单在 initClientEndpoints 之后才可读,模块级捕获会炸。
function externalBaseUrl(): string {
  return getClientEndpoint('cdnBaseUrl');
}
function internalBaseUrl(): string {
  return getClientEndpoint('cdnInternalBaseUrl');
}
const INTERNAL_PROBE_TIMEOUT_MS = 1500;

// ── State ──────────────────────────────────────────────────────────────────

let cached: Manifest | null = null;
let internalProbeResult: 'internal' | 'external' | null = null;

// ── Helpers ────────────────────────────────────────────────────────────────

/**
 * Probe internal_test.txt on the intranet CDN to decide if we're inside the
 * company network. Re-runs on every fetchManifest() so a "home → office" move
 * mid-session flips over on the next 30-min poll without needing a restart.
 *
 * - In-memory only (no disk cache).
 * - Tight timeout so external networks pay at most INTERNAL_PROBE_TIMEOUT_MS
 *   per poll cycle.
 * - XDT_CDN_BASE_URL env override skips the probe entirely.
 */
function probeInternalNetwork(): Promise<void> {
  if (process.env.XDT_CDN_BASE_URL) {
    internalProbeResult = 'external';
    return Promise.resolve();
  }

  return new Promise((resolve) => {
    let settled = false;
    const finish = (result: 'internal' | 'external') => {
      if (settled) return;
      settled = true;
      internalProbeResult = result;
      log.info('Internal probe result: %s', result);
      resolve();
    };

    try {
      const request = net.request(`${internalBaseUrl()}/internal_test.txt?t=${Date.now()}`);
      const timeout = setTimeout(() => {
        request.abort();
        finish('external');
      }, INTERNAL_PROBE_TIMEOUT_MS);

      request.on('response', (response) => {
        clearTimeout(timeout);
        finish(response.statusCode === 200 ? 'internal' : 'external');
        response.on('data', () => {});
        response.on('end', () => {});
      });
      request.on('error', () => {
        clearTimeout(timeout);
        finish('external');
      });
      request.end();
    } catch {
      finish('external');
    }
  });
}

export function getBaseUrl(): string {
  if (process.env.XDT_CDN_BASE_URL) return process.env.XDT_CDN_BASE_URL;
  if (internalProbeResult === 'internal') return internalBaseUrl();
  return externalBaseUrl();
}

/**
 * Async variant of getBaseUrl(): guarantees the internal-network probe has
 * run at least once before returning. Use this on code paths that depend on
 * intranet routing but are NOT downstream of fetchManifest() (e.g. skill
 * install in dev mode, where fetchManifest() short-circuits).
 *
 * Concurrent callers share a single in-flight probe promise; once the probe
 * settles, all subsequent calls hit the cached result synchronously.
 */
let probePromise: Promise<void> | null = null;

export async function ensureBaseUrl(): Promise<string> {
  if (process.env.XDT_CDN_BASE_URL) return process.env.XDT_CDN_BASE_URL;
  if (internalProbeResult === null) {
    if (!probePromise) probePromise = probeInternalNetwork().finally(() => { probePromise = null; });
    await probePromise;
  }
  return getBaseUrl();
}

export function getPlatformKey(): string {
  return `${process.platform}-${process.arch}`;
}

export function isDev(): boolean {
  return !app.isPackaged;
}

// ── Core ───────────────────────────────────────────────────────────────────

/**
 * Fetch manifest.json from CDN. Returns null on any failure (silent).
 * In dev mode, always returns null — no remote fetching.
 *
 * canary-release V0.1: when canaryFlagStore.read() === true (server marked
 * the logged-in user as a canary tester), pull manifest-{platform}-canary.json
 * instead of the stable manifest. On failure we deliberately do NOT fall back
 * to stable — that would silently downgrade canary users to whatever stale
 * version is sitting on the stable channel.
 */
export async function fetchManifest(timeoutMs?: number): Promise<Manifest | null> {
  if (isDev()) return null;

  // Re-probe before every manifest fetch so 30-min poll cycles can switch
  // base URL when the user moves between intranet and external networks
  // without restarting the app.
  await probeInternalNetwork();

  const isCanary = canaryFlagStore.read();
  const channelSuffix = isCanary ? '-canary' : '';
  // Cache-bust: append timestamp to prevent Chromium / CDN serving stale manifest
  const url = `${getBaseUrl()}/manifest-${getPlatformKey()}${channelSuffix}.json?t=${Date.now()}`;
  log.info('Fetching (%s channel): %s', isCanary ? 'canary' : 'stable', url);

  return new Promise<Manifest | null>((resolve) => {
    try {
      const request = net.request(url);
      let body = '';
      let settled = false;

      const timeout = setTimeout(() => {
        if (!settled) {
          settled = true;
          request.abort();
          resolve(null);
        }
      }, timeoutMs ?? REQUEST_TIMEOUT_MS);

      request.on('response', (response) => {
        if (response.statusCode !== 200) {
          log.info('HTTP %d for %s', response.statusCode, url);
          clearTimeout(timeout);
          settled = true;
          resolve(null);
          return;
        }

        response.on('data', (chunk) => {
          body += chunk.toString();
        });
        response.on('end', () => {
          clearTimeout(timeout);
          if (settled) return;
          settled = true;
          try {
            const json = JSON.parse(body) as Manifest;
            cached = json;
            log.info('Fetched OK: app.version=%s, hotfix=%s', json.app?.version, json.app?.hotfix?.file ?? 'none');
            resolve(json);
          } catch (err) {
            log.error('JSON parse failed:', err);
            resolve(null);
          }
        });
        response.on('error', () => {
          clearTimeout(timeout);
          if (!settled) {
            settled = true;
            resolve(null);
          }
        });
      });

      request.on('error', () => {
        clearTimeout(timeout);
        if (!settled) {
          settled = true;
          resolve(null);
        }
      });

      request.end();
    } catch {
      resolve(null);
    }
  });
}

/**
 * Return the in-memory cached manifest (may be null if never fetched or dev mode).
 */
export function getCachedManifest(): Manifest | null {
  return cached;
}
