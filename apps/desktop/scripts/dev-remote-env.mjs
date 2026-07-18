#!/usr/bin/env node
/**
 * dev-remote-env.mjs — dev:remote / dev:inspect 的构建身份注入包装。
 *
 * 2026-07 端点清单重构后,运行期业务端点全部来自启动时解析的端点清单
 * (dev 默认读仓内 config/endpoint.json,--endpoints-cdn 走线上 CDN),本包装
 * 不再注入任何端点 URL;剩余职责是「remote 模式不读 apps/desktop/.env」的
 * 构建身份注入:VITE_FEISHU_APP_ID / VITE_CINDY_AUTH_REGION(强制覆盖,
 * allowEnvOverride: false 语义保持——不吃 shell env / .env 的同名变量)。
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

const productionEnv = productionViteEnv({ allowEnvOverride: false });
const env = {
  ...process.env,
  VITE_FEISHU_APP_ID: productionEnv.VITE_FEISHU_APP_ID,
  VITE_CINDY_AUTH_REGION: productionEnv.VITE_CINDY_AUTH_REGION,
};
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
