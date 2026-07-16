/**
 * macOS 品牌迁移安装原语：先把 zip 解到目标卷的临时目录并校验 bundle，
 * 再用备份交换替换现有应用。解压、校验或交换失败时保留/恢复旧安装。
 */

import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

/** macOS 完整包安装所需的真实世界依赖。 */
export interface MacPayloadInstallArgs {
  payloadPath: string;
  destApp: string;
  expectedExecutableName: string;
  extractArchive: (payloadPath: string, destinationDir: string) => Promise<void>;
}

/** 可跨进程恢复的确定性备份路径。 */
export function macInstallBackupPath(destApp: string): string {
  return path.join(path.dirname(destApp), `.${path.basename(destApp)}.migration-backup`);
}

export type MacInstallRecoveryResult = 'none' | 'restored-backup' | 'removed-stale-backup';

/**
 * 恢复上一次在两次 rename 之间中断的安装：正式路径缺失时回移备份；
 * 正式路径已存在时清理已经过期的备份。
 */
export function recoverInterruptedMacInstall(destApp: string): MacInstallRecoveryResult {
  if (!destApp.endsWith('.app')) {
    throw new Error(`macOS install destination is not an .app bundle: ${destApp}`);
  }
  const backupApp = macInstallBackupPath(destApp);
  const destExists = fs.existsSync(destApp);
  const backupExists = fs.existsSync(backupApp);
  if (!destExists && backupExists) {
    fs.renameSync(backupApp, destApp);
    return 'restored-backup';
  }
  if (destExists && backupExists) {
    fs.rmSync(backupApp, { recursive: true, force: true });
    return 'removed-stale-backup';
  }
  return 'none';
}

/**
 * 在目标 `.app` 的同级目录完成解压和交换，保证任一步失败都不会先删掉
 * 用户已有的 Cindy.app。成功后旧 bundle 备份与 staging 目录均尽力清理。
 */
export async function installMacPayloadAtomic(args: MacPayloadInstallArgs): Promise<void> {
  if (!args.destApp.endsWith('.app')) {
    throw new Error(`macOS install destination is not an .app bundle: ${args.destApp}`);
  }

  const parentDir = path.dirname(args.destApp);
  const bundleName = path.basename(args.destApp);
  const nonce = randomUUID();
  const stagingDir = path.join(parentDir, `.${bundleName}.stage-${nonce}`);
  const backupApp = macInstallBackupPath(args.destApp);
  let backupCreated = false;

  recoverInterruptedMacInstall(args.destApp);
  fs.mkdirSync(stagingDir, { recursive: true });
  try {
    await args.extractArchive(args.payloadPath, stagingDir);

    const stagedApp = path.join(stagingDir, bundleName);
    const expectedExecutable = path.join(
      stagedApp,
      'Contents',
      'MacOS',
      args.expectedExecutableName,
    );
    if (!fs.statSync(stagedApp).isDirectory() || !fs.statSync(expectedExecutable).isFile()) {
      throw new Error(`extracted app failed validation: ${expectedExecutable}`);
    }

    if (fs.existsSync(args.destApp)) {
      fs.renameSync(args.destApp, backupApp);
      backupCreated = true;
    }

    try {
      fs.renameSync(stagedApp, args.destApp);
    } catch (installError) {
      if (backupCreated) {
        try {
          fs.renameSync(backupApp, args.destApp);
        } catch (rollbackError) {
          throw new Error(
            `app swap failed: ${(installError as Error).message}; rollback failed: ${(rollbackError as Error).message}`,
          );
        }
      }
      throw installError;
    }

    if (backupCreated) {
      try {
        fs.rmSync(backupApp, { recursive: true, force: true });
      } catch {
        // 新 bundle 已原子落位；残留备份只占空间，不应把成功安装误判为失败。
      }
    }
  } finally {
    try {
      fs.rmSync(stagingDir, { recursive: true, force: true });
    } catch {
      // staging 清理失败不改变安装结果，下次安装使用独立随机目录。
    }
  }
}
