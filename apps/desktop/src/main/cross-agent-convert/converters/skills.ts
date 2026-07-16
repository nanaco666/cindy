/**
 * skills converter: .claude/skills/ ↔ .agents/skills/
 *
 * 子项粒度复制：源里每一个 <name>/ 子目录 → 目标 <name>/，目标里同名跳过。
 * SKILL.md 做术语替换，附属文件原样复制。
 *
 * 子项已在 detector 里枚举到 item.subItems[]，这里逐子项处理；任意子项失败不影响其他子项。
 */

import fs from 'node:fs/promises';
import path from 'node:path';

import type { MigrationItem, MigrationStepStatus } from '../types.js';
import { rewriteTerms } from './term-rewrite.js';

export interface ConvertOutcome {
  status: MigrationStepStatus;
  detail?: string;
}

const TEXT_EXT_FOR_REWRITE = new Set(['.md', '.markdown', '.txt']);

async function exists(p: string): Promise<boolean> {
  try {
    await fs.access(p);
    return true;
  } catch {
    return false;
  }
}

async function copyFileWithOptionalRewrite(
  src: string,
  dst: string,
  direction: MigrationItem['direction'],
): Promise<void> {
  const ext = path.extname(src).toLowerCase();
  if (TEXT_EXT_FOR_REWRITE.has(ext)) {
    const raw = await fs.readFile(src, 'utf8');
    const rewritten = rewriteTerms(raw, direction);
    await fs.writeFile(dst, rewritten, { encoding: 'utf8', flag: 'wx' });
  } else {
    // 二进制 / 其他：原样拷贝（COPYFILE_EXCL = 不覆盖）
    await fs.copyFile(src, dst, fs.constants.COPYFILE_EXCL);
  }
}

async function copyDirRecursiveSkipExisting(
  srcDir: string,
  dstDir: string,
  direction: MigrationItem['direction'],
): Promise<void> {
  await fs.mkdir(dstDir, { recursive: true });
  const entries = await fs.readdir(srcDir, { withFileTypes: true });
  for (const ent of entries) {
    const srcPath = path.join(srcDir, ent.name);
    const dstPath = path.join(dstDir, ent.name);
    if (ent.isDirectory()) {
      await copyDirRecursiveSkipExisting(srcPath, dstPath, direction);
    } else if (ent.isFile()) {
      if (await exists(dstPath)) continue; // 同名子文件已存在 → 跳过
      try {
        await copyFileWithOptionalRewrite(srcPath, dstPath, direction);
      } catch (err) {
        const e = err as NodeJS.ErrnoException;
        if (e && e.code === 'EEXIST') continue;
        throw err;
      }
    }
    // symlinks/sockets/etc 忽略
  }
}

export async function convertSkills(item: MigrationItem): Promise<ConvertOutcome> {
  const subItems = item.subItems ?? [];
  if (subItems.length === 0) return { status: 'skipped', detail: '无新增子项' };

  let copied = 0;
  let skipped = 0;
  let failed = 0;
  const failures: string[] = [];

  for (const sub of subItems) {
    // 二次校验：目标子目录已存在（用户在弹窗期间手动建了）→ 跳过
    if (await exists(sub.targetPath)) {
      skipped += 1;
      continue;
    }
    try {
      await copyDirRecursiveSkipExisting(sub.sourcePath, sub.targetPath, item.direction);
      copied += 1;
    } catch (err) {
      failed += 1;
      failures.push(`${sub.name}: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  if (failed > 0) {
    return {
      status: 'failed',
      detail: `成功 ${copied}, 跳过 ${skipped}, 失败 ${failed} (${failures.slice(0, 2).join('; ')})`,
    };
  }
  if (copied === 0) {
    return { status: 'skipped', detail: `全部 ${skipped} 项已存在` };
  }
  return {
    status: 'success',
    detail: skipped > 0 ? `新增 ${copied} 项，跳过 ${skipped} 项` : `新增 ${copied} 项`,
  };
}
