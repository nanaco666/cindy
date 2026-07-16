/** 延迟卸载所需的旧安装文件身份捕获与 fail-closed 比对。 */

import fs from 'node:fs';
import path from 'node:path';

import type { LegacyInstallIdentity } from './types';

/** 在 Cindy 等待旧进程退出前捕获旧可执行文件身份；无法可靠读取时返回 null。 */
export function captureLegacyInstallIdentity(
  legacyInstallDir: string | undefined,
  legacyApp: string,
  platform: NodeJS.Platform,
): LegacyInstallIdentity | null {
  if (!legacyInstallDir || !/^[a-z0-9][a-z0-9-]*$/i.test(legacyApp)) return null;
  const segments = platform === 'win32'
    ? [`${legacyApp}.exe`]
    : ['Contents', 'MacOS', legacyApp];
  const executableRelativePath = segments.join('/');
  return readIdentity(path.join(legacyInstallDir, ...segments), executableRelativePath);
}

/** 当前安装仍是首启捕获的同一个可执行文件对象时才返回 true。 */
export function matchesLegacyInstallIdentity(
  legacyInstallDir: string,
  expected: LegacyInstallIdentity | null | undefined,
): boolean {
  if (expected?.schemaVersion !== 1) return false;
  const segments = safeRelativeSegments(expected.executableRelativePath);
  if (segments == null) return false;
  const actual = readIdentity(
    path.join(legacyInstallDir, ...segments),
    segments.join('/'),
  );
  return actual != null
    && actual.executableRelativePath === expected.executableRelativePath
    && actual.dev === expected.dev
    && actual.ino === expected.ino
    && actual.size === expected.size
    && actual.mtimeNs === expected.mtimeNs
    && actual.birthtimeNs === expected.birthtimeNs;
}

function safeRelativeSegments(relativePath: string): string[] | null {
  if (typeof relativePath !== 'string' || !relativePath || relativePath.includes('\\')) return null;
  const segments = relativePath.split('/');
  if (segments.some((segment) => (
    !segment
    || segment === '.'
    || segment === '..'
    || segment.includes(':')
  ))) return null;
  return segments;
}

function readIdentity(
  executablePath: string,
  executableRelativePath: string,
): LegacyInstallIdentity | null {
  try {
    const stat = fs.statSync(executablePath, { bigint: true });
    if (
      !stat.isFile()
      || stat.ino <= 0n
      || stat.size <= 0n
      || stat.mtimeNs <= 0n
      || stat.birthtimeNs <= 0n
    ) return null;
    return {
      schemaVersion: 1,
      executableRelativePath,
      dev: String(stat.dev),
      ino: String(stat.ino),
      size: String(stat.size),
      mtimeNs: String(stat.mtimeNs),
      birthtimeNs: String(stat.birthtimeNs),
    };
  } catch {
    return null;
  }
}
