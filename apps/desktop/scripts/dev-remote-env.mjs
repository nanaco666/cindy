#!/usr/bin/env node
/**
 * dev-remote-env.mjs — dev:remote / dev:inspect 的生产端点注入包装。
 *
 * VITE_API_BASE_URL / VITE_CINDY_AUTH_BASE_URL / VITE_DEVICE_LINK_API_BASE_URL /
 * VITE_OAUTH_BROKER_API_BASE_URL 均从 config/production-endpoints.json 权威源读取。
 *
 * 语义与原 cross-env 字面量完全一致:强制覆盖(allowEnvOverride: false,不吃
 * shell env / .env 的同名变量)——remote 模式从来不看 apps/desktop/.env。
 *
 * 用法:node scripts/dev-remote-env.mjs <command> [args...]
 */
import { spawn } from 'node:child_process';

import { productionViteEnv } from '../../../scripts/shared/production-endpoints.mjs';

const [command, ...args] = process.argv.slice(2);
if (!command) {
  console.error('usage: node scripts/dev-remote-env.mjs <command> [args...]');
  process.exit(2);
}

const env = { ...process.env, ...productionViteEnv({ allowEnvOverride: false }) };
const isWindows = process.platform === 'win32';

// Windows 下 electron-forge 等 .cmd shim 需要经 shell 解析;shell 模式下 Node 不转义
// args 数组(DEP0190),这里自行做最小引号处理(实际参数均为简单 token,含空格时兜底)。
const quote = (a) => (/[\s"]/.test(a) ? `"${a.replace(/"/g, '""')}"` : a);
const child = isWindows
  ? spawn([command, ...args].map(quote).join(' '), { stdio: 'inherit', env, shell: true })
  : spawn(command, args, { stdio: 'inherit', env });

child.on('exit', (code, signal) => {
  if (signal) {
    process.kill(process.pid, signal);
    return;
  }
  process.exit(code ?? 1);
});
child.on('error', (err) => {
  console.error(`[dev-remote-env] failed to launch ${command}: ${err.message}`);
  process.exit(1);
});
