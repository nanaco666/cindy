/**
 * canaryFlagStore.ts
 * ---------------------------------------------------------------------------
 * canary-release V0.1
 *
 * Persists the per-user "isCanary" flag locally so manifestService (which runs
 * on the background poll, *before* renderer mounts and even before login on a
 * fresh install) can decide which manifest URL to fetch from CDN.
 *
 * Storage: plain JSON file at userData/canary-flag.json. The flag is not
 * sensitive — it just toggles between two public CDN URLs — so we don't bother
 * with safeStorage encryption. Plain file also means the value survives
 * safeStorage being unavailable (rare edge case on Linux without keyring).
 *
 * Lifecycle(2026-07 起):
 *   - 服务端 isCanary 字段已随产品 /api/user/me 退役——登录 / 刷新 / 冷启动
 *     恢复路径现在**恒 sync(false) 清标记**(存量 canary 用户回稳定通道);
 *     后续灰度由其它分发方式接管,届时由新机制负责 write()
 *   - Read by manifestService.fetchManifest() to switch URL between
 *     manifest-{platform}.json and manifest-{platform}-canary.json
 *
 * Why not a module-level variable: the background update poll fires before
 * authManager.initialize() resolves on cold start, so we need a value that
 * survives across launches.
 */

import { app } from 'electron';
import path from 'node:path';
import fs from 'node:fs';

import { createLogger } from './logger';

const log = createLogger('canaryFlagStore');

const FLAG_FILE = 'canary-flag.json';

function getFlagPath(): string {
  return path.join(app.getPath('userData'), FLAG_FILE);
}

/**
 * Returns true iff the local flag file exists and contains `{ canary: true }`.
 * Any I/O error or malformed payload → false (fail-safe to stable channel).
 */
export function read(): boolean {
  try {
    const raw = fs.readFileSync(getFlagPath(), 'utf-8');
    const parsed = JSON.parse(raw) as { canary?: unknown };
    return parsed.canary === true;
  } catch {
    return false;
  }
}

export function write(): void {
  try {
    fs.writeFileSync(getFlagPath(), JSON.stringify({ canary: true }));
  } catch (err) {
    log.error('write failed:', err);
  }
}

export function clear(): void {
  try {
    fs.unlinkSync(getFlagPath());
  } catch {
    // ENOENT is fine — flag was never written or already gone
  }
}

/**
 * Convenience: sync local flag to a desired value in one call.
 * 2026-07 起 authManager 在登录/刷新/冷启动恢复路径恒调 sync(false) 清标记;
 * true 分支留给未来的新灰度分发机制。
 */
export function sync(isCanary: boolean): void {
  if (isCanary) write();
  else clear();
}
