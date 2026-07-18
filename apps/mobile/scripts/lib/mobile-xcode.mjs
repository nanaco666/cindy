import { dirname, join } from 'node:path';

export const MOBILE_XCODE_REGIONS = Object.freeze(['cn', 'global']);

/**
 * 解析 mobile:xcode 参数。region 必须显式给出，避免误把上一次生成的地区工程
 * 当成本次目标继续编译。
 */
export function parseMobileXcodeArgs(argv) {
  const args = argv.filter((arg) => arg !== '--');
  let region;
  let help = false;

  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === '--help' || arg === '-h') {
      help = true;
      continue;
    }
    if (arg === '--region') {
      if (region !== undefined) throw new Error('--region 只能传一次');
      region = args[index + 1];
      index += 1;
      continue;
    }
    if (arg.startsWith('--region=')) {
      if (region !== undefined) throw new Error('--region 只能传一次');
      region = arg.slice('--region='.length);
      continue;
    }
    throw new Error(`未知参数: ${arg}`);
  }

  if (help) return { help: true, region: undefined };
  if (!region?.trim()) {
    throw new Error('必须显式指定 --region cn|global');
  }
  const normalizedRegion = region.trim();
  if (!MOBILE_XCODE_REGIONS.includes(normalizedRegion)) {
    throw new Error(`--region 只能是 ${MOBILE_XCODE_REGIONS.join(' 或 ')},收到: ${normalizedRegion}`);
  }
  return { help: false, region: normalizedRegion };
}

/**
 * 把地区构建身份持久化到 apps/mobile/.env。这样命令打开 Xcode 后，后续单独启动的
 * Metro 仍会用同一地区，不会出现 native 是 global、JS 却从 cn 配置编译的错配。
 */
export function updateMobileXcodeEnvContent(content, values) {
  const newline = content.includes('\r\n') ? '\r\n' : '\n';
  let lines = content ? content.split(/\r?\n/) : [];

  for (const [key, value] of Object.entries(values)) {
    const pattern = new RegExp(`^\\s*${escapeRegExp(key)}\\s*=`);
    let replaced = false;
    lines = lines.filter((line) => {
      if (!pattern.test(line)) return true;
      if (replaced) return false;
      replaced = true;
      return true;
    }).map((line) => {
      if (!pattern.test(line)) return line;
      return `${key}=${value}`;
    });
    if (!replaced) lines.push(`${key}=${value}`);
  }

  while (lines.length > 0 && lines.at(-1) === '') lines.pop();
  return `${lines.join(newline)}${newline}`;
}

/** 从 ios/ 顶层候选中选择 app workspace，排除 CocoaPods 自己的 workspace。 */
export function selectMobileXcodeWorkspace(iosDir, entries) {
  const candidates = entries
    .filter((entry) => entry.endsWith('.xcworkspace') && entry !== 'Pods.xcworkspace')
    .sort();
  if (candidates.length === 0) {
    throw new Error(`prebuild 后未在 ${iosDir} 找到 app .xcworkspace`);
  }
  if (candidates.length > 1) {
    throw new Error(`在 ${iosDir} 找到多个 app workspace，无法确定要打开哪个: ${candidates.join(', ')}`);
  }
  return join(iosDir, candidates[0]);
}

/** 返回 workspace 所属的生成目录，供调用端输出紧凑提示。 */
export function mobileXcodeGeneratedDir(workspacePath) {
  return dirname(workspacePath);
}

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
