/** 普通 hotfix 与品牌迁移安装包在 userData/updates 下的隔离与清理原语。 */

import fs from 'node:fs';
import path from 'node:path';

export const MIGRATION_PAYLOAD_DIR_NAME = 'migration';

/** 品牌迁移 payload 固定落入独立子目录，避免并发 hotfix 清理误删。 */
export function migrationPayloadTargetPath(userDataDir: string, manifestFile: string): string {
  return path.join(
    userDataDir,
    'updates',
    MIGRATION_PAYLOAD_DIR_NAME,
    path.basename(manifestFile),
  );
}

/**
 * 清理品牌迁移 payload 命名空间。传 keepPayloadPath 时保留当前包及 downloader
 * sidecar，供断点续传/本地 sha fast path；不传时清空全部文件并尝试移除空目录。
 * 仅处理 migration 目录直属文件，不递归也不越过该命名空间。
 */
export function cleanMigrationPayloadFiles(
  userDataDir: string,
  keepPayloadPath?: string,
): void {
  const migrationDir = path.resolve(userDataDir, 'updates', MIGRATION_PAYLOAD_DIR_NAME);
  const keepSet = new Set<string>();
  if (
    keepPayloadPath != null
    && path.resolve(path.dirname(keepPayloadPath)) === migrationDir
  ) {
    const keepFileName = path.basename(keepPayloadPath);
    keepSet.add(keepFileName);
    keepSet.add(`${keepFileName}.part`);
    keepSet.add(`${keepFileName}.meta.json`);
    keepSet.add(`${keepFileName}.meta.json.tmp`);
  }

  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(migrationDir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries) {
    if (entry.isDirectory() || keepSet.has(entry.name)) continue;
    try {
      fs.unlinkSync(path.join(migrationDir, entry.name));
    } catch {
      // best-effort；下次 stage / 启动 / confirmed 仍会重试清理。
    }
  }
  if (keepSet.size === 0) {
    try { fs.rmdirSync(migrationDir); } catch { /* 非空或占用时下次重试 */ }
  }
}

/**
 * 清理普通 hotfix 文件，只保留当前文件及其 sidecar；子目录属于其它更新
 * 流程的命名空间，永不递归或删除。
 */
export function cleanOldUpdateFiles(
  updatesDir: string,
  keepFileName: string,
  persistentFileNames: readonly string[],
): void {
  const keepSet = new Set([
    keepFileName,
    `${keepFileName}.part`,
    `${keepFileName}.meta.json`,
    `${keepFileName}.meta.json.tmp`,
    ...persistentFileNames,
  ]);
  for (const entry of fs.readdirSync(updatesDir, { withFileTypes: true })) {
    if (entry.isDirectory() || keepSet.has(entry.name)) continue;
    try {
      fs.unlinkSync(path.join(updatesDir, entry.name));
    } catch {
      // 清理是 best-effort；下载器会自行处理当前目标文件的完整性。
    }
  }
}
