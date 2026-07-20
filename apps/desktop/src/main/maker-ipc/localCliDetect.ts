/**
 * localCliDetect(main)—— 本机 agent CLI 安装 / 登录态扫描的实现。
 *
 * 纯函数 + 注入 fs 依赖(规则 14:handler body 可脱 Electron 单测)。
 * 只做存在性 stat(目录用 isDirectory、文件用 isFile,防同名文件顶替误报——
 * 见 memory: 存在性探测用 stat 而非 access),**绝不读取凭证内容**(规则 23)。
 * 任一条目探测失败按「未安装」处理(fail-quiet:检测建议是增强,不是功能依赖)。
 */

import { homedir } from 'node:os';
import { join } from 'node:path';
import { stat } from 'node:fs/promises';

import { LOCAL_CLI_DETECT_MAP, type LocalCliDetection } from '../../shared/localCliDetect.js';

export interface LocalCliScanDeps {
  homeDir: string;
  /** 路径存在且是目录。 */
  isDirectory(path: string): Promise<boolean>;
  /** 路径存在且是普通文件。 */
  isFile(path: string): Promise<boolean>;
}

/** 生产 deps:真实 home + fs.stat(异常一律 false)。 */
export function createLocalCliScanDeps(): LocalCliScanDeps {
  return {
    homeDir: homedir(),
    isDirectory: async (path) => {
      try {
        return (await stat(path)).isDirectory();
      } catch {
        return false;
      }
    },
    isFile: async (path) => {
      try {
        return (await stat(path)).isFile();
      } catch {
        return false;
      }
    },
  };
}

/** 按映射表扫描全部条目;installed=false 时 loggedIn 恒 false(不再探测文件)。 */
export async function scanLocalCliAuth(deps: LocalCliScanDeps): Promise<LocalCliDetection[]> {
  const results: LocalCliDetection[] = [];
  for (const entry of LOCAL_CLI_DETECT_MAP) {
    const configDir = join(deps.homeDir, ...entry.configDirSegments);
    const installed = await deps.isDirectory(configDir);
    let loggedIn = false;
    if (installed) {
      const credFile = join(deps.homeDir, ...entry.credentialFileSegments);
      loggedIn = await deps.isFile(credFile);
    }
    results.push({ cli: entry.cli, providerId: entry.providerId, installed, loggedIn });
  }
  return results;
}
