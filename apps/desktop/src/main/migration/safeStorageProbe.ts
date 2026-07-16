/** 首启迁移验收阶段对 safe-storage 存量文件的容错探针。 */

import fs from 'node:fs';
import path from 'node:path';

/** Electron safeStorage 的最小只读切面，便于跨平台单测。 */
export interface SafeStorageDecryptor {
  isAvailable: () => boolean;
  decryptFromBase64: (content: string) => void;
}

/** 探针结果；不可解密的历史孤儿仅登记，不阻断迁移。 */
export interface SafeStorageProbeResult {
  total: number;
  readable: number;
  unreadableStores: string[];
}

/**
 * 验证加密后端可用，并逐个尝试现有 `.enc`。历史损坏/跨机器 blob 在老 app
 * 中本就不可用，与 handoff 导出侧一样容忍跳过，避免随机采样误杀整场迁移。
 */
export function probeSafeStorageDirectory(
  userDataDir: string,
  decryptor: SafeStorageDecryptor,
): SafeStorageProbeResult {
  const dir = path.join(userDataDir, 'safe-storage');
  let files: string[];
  try {
    files = fs.readdirSync(dir).filter((file) => file.endsWith('.enc')).sort();
  } catch {
    return { total: 0, readable: 0, unreadableStores: [] };
  }
  if (files.length === 0) return { total: 0, readable: 0, unreadableStores: [] };
  if (!decryptor.isAvailable()) {
    throw new Error('safeStorage backend unavailable while encrypted secrets exist');
  }

  let readable = 0;
  const unreadableStores: string[] = [];
  for (const file of files) {
    try {
      decryptor.decryptFromBase64(fs.readFileSync(path.join(dir, file), 'utf8').trim());
      readable += 1;
    } catch {
      unreadableStores.push(file.slice(0, -'.enc'.length));
    }
  }
  return { total: files.length, readable, unreadableStores };
}
