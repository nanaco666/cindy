/** Mobile/EAS 的生产端点构建适配器。 */
import {
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { randomUUID } from 'node:crypto';
import { resolve } from 'node:path';

import { productionMobileEnv } from '../../../scripts/shared/production-endpoints.mjs';

/**
 * 临时向所有 EAS build profile 注入生产端点，并返回幂等恢复函数。
 * 真实 URL 只在构建工作区短暂出现，不进入 Git；恢复时逐字节写回原文件。
 */
export function injectMobileEndpointsIntoEasFile(
  easJsonPath,
  options = {},
) {
  const resolvedPath = resolve(easJsonPath);
  const lock = acquireEasFileLock(resolvedPath);
  let original;
  try {
    original = readFileSync(resolvedPath, 'utf8');
    const easJson = JSON.parse(original);
    if (!easJson.build || typeof easJson.build !== 'object' || Array.isArray(easJson.build)) {
      throw new Error(`eas.json 缺少 build profiles: ${resolvedPath}`);
    }
    const endpointEnvByRegion = options.endpointEnvByRegion ?? (
      options.endpointEnv
        ? null
        : {
            cn: productionMobileEnv({ authRegion: 'cn' }),
            global: productionMobileEnv({ authRegion: 'global' }),
          }
    );
    const fallbackEndpointEnv = options.endpointEnv ?? endpointEnvByRegion?.cn;
    for (const [profileName, profile] of Object.entries(easJson.build)) {
      if (!profile || typeof profile !== 'object' || Array.isArray(profile)) continue;
      const region = resolveProfileAuthRegion(easJson.build, profileName);
      const endpointEnv = endpointEnvByRegion?.[region] ?? fallbackEndpointEnv;
      profile.env = { ...(profile.env ?? {}), ...endpointEnv };
    }

    writeFileSync(resolvedPath, `${JSON.stringify(easJson, null, 2)}\n`);
  } catch (error) {
    lock.release();
    throw error;
  }

  let restored = false;
  return () => {
    if (restored) return;
    restored = true;
    try {
      writeFileSync(resolvedPath, original);
    } finally {
      lock.release();
    }
  };
}

const EAS_LOCK_WAIT_MS = 100;
const EAS_LOCK_STALE_MS = 10 * 60 * 1000;

/**
 * 通过 mkdir 的原子性串行化同一 checkout 的 release wrapper。
 * 锁覆盖整个注入生命周期，而不是只保护单次写入，避免两个进程分别保存不同原文后互相恢复。
 */
function acquireEasFileLock(easPath) {
  const lockPath = `${easPath}.xdt-lock`;
  const ownerPath = `${lockPath}/owner.json`;
  const token = randomUUID();
  for (;;) {
    try {
      mkdirSync(lockPath);
      writeFileSync(ownerPath, JSON.stringify({ pid: process.pid, token, createdAt: Date.now() }));
      return {
        release() {
          try {
            const owner = JSON.parse(readFileSync(ownerPath, 'utf8'));
            if (owner.token === token) rmSync(lockPath, { recursive: true, force: true });
          } catch {
            // 锁目录已被清理或损坏时无需阻断发布收尾。
          }
        },
      };
    } catch (error) {
      if (error?.code !== 'EEXIST' || !existsSync(lockPath)) throw error;
      if (isEasLockStale(lockPath, ownerPath)) {
        rmSync(lockPath, { recursive: true, force: true });
        continue;
      }
      const waitBuffer = new Int32Array(new SharedArrayBuffer(4));
      Atomics.wait(waitBuffer, 0, 0, EAS_LOCK_WAIT_MS);
    }
  }
}

function isEasLockStale(lockPath, ownerPath) {
  let owner;
  try {
    owner = JSON.parse(readFileSync(ownerPath, 'utf8'));
  } catch {
    try {
      return Date.now() - statSync(lockPath).mtimeMs > EAS_LOCK_STALE_MS;
    } catch {
      return false;
    }
  }
  if (Number.isInteger(owner.pid)) {
    try {
      process.kill(owner.pid, 0);
      return false;
    } catch (error) {
      if (error?.code === 'EPERM') return false;
    }
  }
  return Date.now() - Number(owner.createdAt || 0) > EAS_LOCK_STALE_MS;
}

function resolveProfileAuthRegion(buildProfiles, profileName, seen = new Set()) {
  if (seen.has(profileName)) {
    throw new Error(`Circular EAS profile extends: ${[...seen, profileName].join(' -> ')}`);
  }
  const profile = buildProfiles[profileName];
  const ownRegion = profile?.env?.EXPO_PUBLIC_CINDY_AUTH_REGION;
  if (ownRegion === 'cn' || ownRegion === 'global') return ownRegion;
  if (profile?.extends) {
    return resolveProfileAuthRegion(
      buildProfiles,
      profile.extends,
      new Set([...seen, profileName]),
    );
  }
  return 'cn';
}
