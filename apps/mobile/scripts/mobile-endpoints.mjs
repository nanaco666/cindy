/** Mobile/EAS 的生产端点构建适配器。 */
import { readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { productionMobileEnv } from '../../../scripts/shared/production-endpoints.mjs';

/**
 * 临时向所有 EAS build profile 注入生产端点，并返回幂等恢复函数。
 * 真实 URL 只在构建工作区短暂出现，不进入 Git；恢复时逐字节写回原文件。
 */
export function injectMobileEndpointsIntoEasFile(
  easJsonPath,
  { endpointEnv = productionMobileEnv() } = {},
) {
  const resolvedPath = resolve(easJsonPath);
  const original = readFileSync(resolvedPath, 'utf8');
  const easJson = JSON.parse(original);
  if (!easJson.build || typeof easJson.build !== 'object' || Array.isArray(easJson.build)) {
    throw new Error(`eas.json 缺少 build profiles: ${resolvedPath}`);
  }
  for (const profile of Object.values(easJson.build)) {
    if (!profile || typeof profile !== 'object' || Array.isArray(profile)) continue;
    profile.env = { ...(profile.env ?? {}), ...endpointEnv };
  }

  writeFileSync(resolvedPath, `${JSON.stringify(easJson, null, 2)}\n`);
  let restored = false;
  return () => {
    if (restored) return;
    restored = true;
    writeFileSync(resolvedPath, original);
  };
}
