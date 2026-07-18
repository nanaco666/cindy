#!/usr/bin/env node
import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadProductionEndpoints } from './shared/production-endpoints.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const rootDir = path.resolve(__dirname, '..');
const gracefulTimeoutMs = 3000;
const forceTimeoutMs = 5000;
const pollIntervalMs = 150;
const forceKillLabel = process.platform === 'win32' ? 'taskkill /F /T' : 'kill -9';

/**
 * 产品 userData 目录基名(--isolated 沙箱目录 `<BRAND_USER_DATA_DIR_NAME>-dev[-<名字>]`
 * 的派生基座)。⚠️ 值必须与 packages/maker-shared/src/brandIdentity.ts 的
 * BRAND_IDENTITY.userDataDirName 一致——.mjs 无法 import TS 单点,只能镜像字面量;
 * 一致性由 scripts/__tests__/brand-identity-sync.test.mjs 断言兜底。
 * 主进程侧(devCliFlags.ts)以 app.getPath('userData') 为基座派生同名目录,两边
 * 必须落在同一路径,否则 restart 脚本创建的沙箱目录与实际生效目录分家。
 */
export const BRAND_USER_DATA_DIR_NAME = 'Cindy';

// 桌面端 .env 默认值。2026-07 端点清单重构后 .env 不再承载任何端点 URL
// (运行期端点全部来自清单:dev 默认读仓内 config/endpoint.json,local 模式读
// 生成的 config/endpoint.local.json,--endpoints-cdn 走线上 CDN),这里只剩
// 构建身份字段:VITE_FEISHU_APP_ID / VITE_CINDY_AUTH_REGION 补空值、保留用户已填的值。
function desktopEnvSpec(content) {
  let productionConfig;
  const configValue = (key) => {
    productionConfig ??= loadProductionEndpoints();
    return productionConfig[key];
  };
  const existingFeishuAppId = readEnvValue(content, 'VITE_FEISHU_APP_ID');
  return [
    { key: 'VITE_CINDY_AUTH_REGION', value: 'cn', force: false },
    {
      key: 'VITE_FEISHU_APP_ID',
      value: existingFeishuAppId || configValue('feishuAppId'),
      force: false,
    },
  ];
}
const closeDarwinTerminalTtyScript = Object.freeze([
  'on closeMatchingTerminalTab(targetTty)',
  'tell application "Terminal"',
  'repeat with terminalWindow in windows',
  'repeat with terminalTab in tabs of terminalWindow',
  'if (tty of terminalTab) is targetTty then',
  'try',
  'if busy of terminalTab is false then do script "exit" in terminalTab',
  'end try',
  'delay 1',
  'try',
  'if not (exists terminalWindow) then return',
  'if not (exists terminalTab) then return',
  'if (count of tabs of terminalWindow) is 1 then',
  'close terminalWindow',
  'else',
  'close terminalTab',
  'end if',
  'end try',
  'return',
  'end if',
  'end repeat',
  'end repeat',
  'end tell',
  'end closeMatchingTerminalTab',
  'on run argv',
  'my closeMatchingTerminalTab(item 1 of argv)',
  'end run',
]);
const launchDarwinTerminalScript = Object.freeze([
  'on run argv',
  'set devCommand to item 1 of argv',
  'tell application "Terminal"',
  'set targetTab to do script devCommand',
  'set targetWindow to front window',
  'activate',
  'end tell',
  'repeat',
  'delay 1',
  'tell application "Terminal"',
  'if not (exists targetWindow) then return',
  'if not (exists targetTab) then return',
  'if busy of targetTab is false then',
  'try',
  'if (count of tabs of targetWindow) is 1 then',
  'close targetWindow',
  'else',
  'close targetTab',
  'end if',
  'end try',
  'return',
  'end if',
  'end tell',
  'end repeat',
  'end run',
]);

function normalize(value) {
  return value.replaceAll('\\', '/').toLowerCase();
}

function stripTrailingSlashes(value) {
  return value.replace(/\/+$/, '');
}

export function commandContainsPath(command, candidatePath) {
  const normalizedCommand = normalize(command);
  const normalizedPath = stripTrailingSlashes(normalize(candidatePath));
  if (!normalizedPath) return false;
  let index = normalizedCommand.indexOf(normalizedPath);
  while (index !== -1) {
    const before = normalizedCommand[index - 1];
    const after = normalizedCommand[index + normalizedPath.length];
    const hasStartBoundary = before === undefined || /\s|["'=]/.test(before);
    // 命令行字符串无法安全区分裸 root 参数后接参数，和带空格的 sibling 路径。
    // kill 旧进程宁可漏杀也不能误杀其它 checkout，所以这里不把空格当结束边界。
    const hasEndBoundary = after === undefined || after === '/' || after === '"' || after === "'";
    if (hasStartBoundary && hasEndBoundary) return true;
    index = normalizedCommand.indexOf(normalizedPath, index + 1);
  }
  return false;
}

function run(command, args, options = {}) {
  return spawnSync(command, args, {
    encoding: 'utf8',
    windowsHide: true,
    ...options,
  });
}

function ensureDesktopEnv() {
  const envPath = path.join(rootDir, 'apps', 'desktop', '.env');
  const examplePath = path.join(rootDir, 'apps', 'desktop', '.env.example');
  let content = '';
  let created = false;

  if (fs.existsSync(envPath)) {
    content = fs.readFileSync(envPath, 'utf8');
  } else {
    created = true;
    content = fs.existsSync(examplePath)
      ? fs.readFileSync(examplePath, 'utf8')
      : '';
  }

  for (const { key, value, force } of desktopEnvSpec(content)) {
    content = upsertEnvValue(content, key, value, { overwrite: created || force });
  }

  fs.mkdirSync(path.dirname(envPath), { recursive: true });
  fs.writeFileSync(envPath, content.endsWith('\n') ? content : `${content}\n`);

  if (created) {
    console.log(`==> Created desktop env: ${path.relative(rootDir, envPath)}`);
  } else {
    console.log(`==> Checked desktop env: ${path.relative(rootDir, envPath)}`);
  }
}

function readEnvValue(content, key) {
  const pattern = new RegExp(`^\\s*${escapeRegExp(key)}\\s*=\\s*(.*?)\\s*$`, 'm');
  return content.match(pattern)?.[1]?.trim() ?? '';
}

function upsertEnvValue(content, key, value, options = {}) {
  const lines = content.split(/\r?\n/);
  const pattern = new RegExp(`^\\s*${escapeRegExp(key)}\\s*=`);
  let found = false;

  const next = lines.map((line) => {
    if (!pattern.test(line)) return line;
    found = true;
    const current = line.slice(line.indexOf('=') + 1).trim();
    return current && !options.overwrite ? line : `${key}=${value}`;
  });

  if (!found) next.push(`${key}=${value}`);
  return next.join('\n');
}

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function listWindowsProcesses() {
  const script = `
$ErrorActionPreference = 'SilentlyContinue'
Get-CimInstance Win32_Process |
  Where-Object { $_.CommandLine } |
  Select-Object ProcessId,ParentProcessId,CommandLine |
  ConvertTo-Json -Compress
`;
  const result = run('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-Command', script]);
  if (result.status !== 0 || !result.stdout.trim()) return [];
  try {
    const parsed = JSON.parse(result.stdout);
    return (Array.isArray(parsed) ? parsed : [parsed]).map((item) => ({
      pid: Number(item.ProcessId),
      ppid: Number(item.ParentProcessId) || 0,
      command: String(item.CommandLine ?? ''),
    }));
  } catch {
    return [];
  }
}

function listPosixProcesses() {
  const result = run('ps', ['-eo', 'pid=,ppid=,tty=,command=']);
  if (result.status !== 0) return [];
  return result.stdout
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => {
      const match = line.match(/^(\d+)\s+(\d+)\s+(\S+)\s+(.+)$/);
      if (!match) return null;
      return {
        pid: Number(match[1]),
        ppid: Number(match[2]) || 0,
        tty: match[3],
        command: match[4],
      };
    })
    .filter(Boolean);
}

// 沿 ppid 链向上找祖先里有没有 Cindy desktop dev 进程。
// 用途：拦住"agent 跑在 Cindy desktop dev 进程内还调 restart"这种自杀场景——
// 一旦 taskkill /T 走到祖先 dev 进程，整棵树（包括正在跑的本脚本）都会被收掉，
// 新 cmd 要么没机会起、要么撞上未释放的端口/文件锁，结果是看不懂的 ELIFECYCLE。
// 检测到就直接 exit 1 + 清晰提示，让 agent 把控制权交回给开发者。
function findDevAncestor() {
  const processes = process.platform === 'win32' ? listWindowsProcesses() : listPosixProcesses();
  const byPid = new Map(processes.map((proc) => [proc.pid, proc]));
  let cursor = byPid.get(process.pid)?.ppid ?? 0;
  for (let i = 0; cursor && i < 64; i += 1) {
    const ancestor = byPid.get(cursor);
    if (!ancestor) break;
    const command = normalize(ancestor.command);
    if (
      !command.includes('apps/claude-code-bin') &&
      !command.includes('apps/codex-bin') &&
      hasCurrentCheckoutPath(command) &&
      hasDesktopDevSignature(command)
    ) {
      return ancestor;
    }
    cursor = ancestor.ppid;
  }
  return null;
}

function hasCurrentCheckoutPath(command) {
  return commandContainsPath(command, rootDir);
}

function hasDesktopDevSignature(command) {
  return (
    command.includes('electron-forge') ||
    command.includes('@electron-forge') ||
    command.includes('dev:desktop') ||
    command.includes('pnpm --filter desktop dev') ||
    command.includes('/node_modules/electron/') ||
    (command.includes('/apps/desktop/') && (
      command.includes('vite.main.config') ||
      command.includes('vite.renderer.config') ||
      command.includes('vite.preload.config') ||
      command.includes('--app-path=')
    ))
  );
}

function shouldKill(proc) {
  if (!proc.pid || proc.pid === process.pid) return false;
  const command = normalize(proc.command);
  if (command.includes('apps/claude-code-bin') || command.includes('apps/codex-bin')) return false;

  return hasCurrentCheckoutPath(command) && hasDesktopDevSignature(command);
}

function killProcess(pid) {
  if (process.platform === 'win32') {
    return run('taskkill.exe', ['/F', '/T', '/PID', String(pid)]).status === 0;
  }

  try {
    process.kill(pid, 'SIGTERM');
  } catch {
    return false;
  }
  return true;
}

function forceKillProcess(pid) {
  if (process.platform === 'win32') {
    return killProcess(pid);
  }

  try {
    process.kill(pid, 'SIGKILL');
  } catch {
    return false;
  }
  return true;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function listDesktopDevProcesses() {
  const processes = process.platform === 'win32' ? listWindowsProcesses() : listPosixProcesses();
  return processes.filter(shouldKill);
}

async function waitForDesktopDevProcessesToExit(timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  let remaining = listDesktopDevProcesses();

  while (remaining.length > 0 && Date.now() < deadline) {
    await sleep(pollIntervalMs);
    remaining = listDesktopDevProcesses();
  }

  return remaining;
}

function hasInteractiveTty() {
  return Boolean(process.stdin.isTTY && process.stdout.isTTY);
}

function psSingleQuote(value) {
  return `'${value.replaceAll("'", "''")}'`;
}

function cmdDoubleQuote(value) {
  return `"${value.replaceAll('"', '""')}"`;
}

function shellSingleQuote(value) {
  return `'${value.replaceAll("'", "'\\''")}'`;
}

function osascriptCloseDarwinTerminalTtyArgs(ttyPath) {
  return closeDarwinTerminalTtyScript
    .flatMap((line) => ['-e', line])
    .concat(ttyPath);
}

export function osascriptLaunchDarwinTerminalArgs(command) {
  return launchDarwinTerminalScript
    .flatMap((line) => ['-e', line])
    .concat(command);
}

function darwinTtyPath(tty) {
  if (!tty || tty === '??' || tty === '?') return null;
  return tty.startsWith('/dev/') ? tty : `/dev/${tty}`;
}

function darwinTerminalTtysForProcesses(processes) {
  if (process.platform !== 'darwin') return [];
  return [...new Set(processes.map((proc) => darwinTtyPath(proc.tty)).filter(Boolean))];
}

function closeDarwinTerminalTtys(ttys) {
  if (process.platform !== 'darwin' || ttys.length === 0) return;

  for (const ttyPath of ttys) {
    const result = run('osascript', osascriptCloseDarwinTerminalTtyArgs(ttyPath));
    if (result.status !== 0 && result.stderr.trim()) {
      console.warn(`==> Failed to close Terminal tab for ${ttyPath}: ${result.stderr.trim()}`);
    }
  }
}

/**
 * --isolated 的默认独立 userData 目录:与正式版的 `Cindy` 平级、名字带 -dev 后缀,
 * 稳定不随 checkout 变(多个 worktree 共享同一个 dev 沙箱,想再细分用命名沙箱
 * `--isolated=<名字>` 或自己设 XDT_USER_DATA_DIR 覆盖)。命名沙箱目录再追加
 * `-<名字>` 后缀,每个名字一条完全独立的沙箱。只在 dev 生效——主进程入口只在
 * 非 packaged 时应用该覆写。
 */
function defaultIsolatedUserDataDir(isolationName) {
  const dirName = `${BRAND_USER_DATA_DIR_NAME}-dev${isolationName ? `-${isolationName}` : ''}`;
  if (process.platform === 'win32') {
    const appData = process.env.APPDATA || path.join(process.env.USERPROFILE || '', 'AppData', 'Roaming');
    return path.join(appData, dirName);
  }
  if (process.platform === 'darwin') {
    return path.join(process.env.HOME || '', 'Library', 'Application Support', dirName);
  }
  const xdgConfig = process.env.XDG_CONFIG_HOME || path.join(process.env.HOME || '', '.config');
  return path.join(xdgConfig, dirName);
}

function devScriptForMode(mode) {
  return mode === 'local' ? 'dev:desktop' : 'dev:desktop:remote';
}

function packageManagerCommand(mode) {
  const devScript = devScriptForMode(mode);
  const pnpmExecPath = process.env.npm_execpath;
  if (!pnpmExecPath) {
    return process.platform === 'win32'
      ? `set "COREPACK_ENABLE_AUTO_PIN=0" && pnpm ${devScript}`
      : `COREPACK_ENABLE_AUTO_PIN=0 pnpm ${devScript}`;
  }

  if (process.platform === 'win32') {
    return `${cmdDoubleQuote(process.execPath)} ${cmdDoubleQuote(pnpmExecPath)} ${devScript}`;
  }

  return `${shellSingleQuote(process.execPath)} ${shellSingleQuote(pnpmExecPath)} ${devScript}`;
}

function darwinEnvPrefix() {
  const corepackShimDir = path.resolve(path.dirname(process.execPath), '..', 'lib', 'node_modules', 'corepack', 'shims');
  const pnpmExecPath = process.env.npm_execpath;
  const preferredPathParts = [
    pnpmExecPath ? path.dirname(pnpmExecPath) : null,
    path.dirname(process.execPath),
  ].filter(Boolean);
  // corepack shims 只能放在 "$PATH" 之后兜底:它的 pnpm 版本由 corepack 自己决定,
  // 排在用户 PATH 前面会盖掉用户自己装好的 pnpm(proto / homebrew 等),
  // corepack 默认版本漂到 pnpm 11 后就会撞本仓 engines 上限炸掉 dev 启动。
  const fallbackPathParts = [
    ...(fs.existsSync(corepackShimDir) ? [corepackShimDir] : []),
    '/opt/homebrew/bin',
    '/opt/homebrew/sbin',
    '/usr/local/bin',
    '/usr/bin',
    '/bin',
    '/usr/sbin',
    '/sbin',
  ];

  return `export PATH=${shellSingleQuote([...new Set(preferredPathParts)].join(path.delimiter))}:"$PATH":${shellSingleQuote([...new Set(fallbackPathParts)].join(path.delimiter))}; `;
}

function devEnvPrefix() {
  const envEntries = [
    ['XDT_VOICE_INPUT_RECORD', process.env.XDT_VOICE_INPUT_RECORD],
    ['XDT_USER_DATA_DIR', process.env.XDT_USER_DATA_DIR],
    ['XDT_DEVICE_ID_OVERRIDE', process.env.XDT_DEVICE_ID_OVERRIDE],
    ['XDT_SCHEDULER_PASSIVE', process.env.XDT_SCHEDULER_PASSIVE],
    ['XDT_ISOLATED', process.env.XDT_ISOLATED],
    ['XDT_ISOLATED_NAME', process.env.XDT_ISOLATED_NAME],
    // 端点清单来源覆写:--endpoints-cdn(dev 走线上 CDN)/ local 模式的
    // endpoint.local.json 文件路径,均由主进程 clientEndpointsService 消费。
    ['XDT_ENDPOINTS_CDN', process.env.XDT_ENDPOINTS_CDN],
    ['XDT_ENDPOINT_MANIFEST_FILE', process.env.XDT_ENDPOINT_MANIFEST_FILE],
    // 启动即自动打开 DevTools(main 的 ready-to-show 里消费;见 bootstrap-electron)。
    // 给"快捷键/菜单打不开 DevTools"的环境兜底,QA 控制台验证依赖它。
    ['OPEN_DEVTOOLS', process.env.OPEN_DEVTOOLS],
  ].filter(([, value]) => value);
  if (envEntries.length === 0) return '';

  if (process.platform === 'win32') {
    return envEntries
      .map(([key, value]) => `set "${key}=${String(value).replaceAll('"', '')}" && `)
      .join('');
  }

  return envEntries
    .map(([key, value]) => `${key}=${shellSingleQuote(String(value))}`)
    .join(' ') + ' ';
}

function launchInSystemTerminal(mode) {
  if (process.platform === 'win32') {
    const command = `cd /d ${cmdDoubleQuote(rootDir)} && ${devEnvPrefix()}${packageManagerCommand(mode)}`;
    const script = [
      "Start-Process -FilePath 'cmd.exe'",
      `-ArgumentList @('/c', ${psSingleQuote(command)})`,
      `-WorkingDirectory ${psSingleQuote(rootDir)}`,
    ].join(' ');
    const result = run('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-Command', script], {
      stdio: 'inherit',
      windowsHide: false,
    });
    if (result.status !== 0) process.exit(result.status ?? 1);
    console.log(`==> Started desktop ${mode} dev in a new cmd window.`);
    return;
  }

  if (process.platform === 'darwin') {
    const command = `${darwinEnvPrefix()}cd ${shellSingleQuote(rootDir)} && ${devEnvPrefix()}${packageManagerCommand(mode)}; exitCode=$?; exit $exitCode`;
    const child = spawn('osascript', osascriptLaunchDarwinTerminalArgs(command), {
      detached: true,
      stdio: 'ignore',
    });
    child.unref();
    if (child.pid === undefined) {
      console.error('Failed to open Terminal.app');
      process.exit(1);
    }
    console.log(`==> Started desktop ${mode} dev in a new Terminal window.`);
    return;
  }

  console.warn('==> Non-interactive terminal detected, but no system terminal launcher is configured for this platform.');
  console.warn('==> Falling back to current process; this may fail if electron-forge requires a TTY.');
}

function startDesktopDev(mode) {
  console.log(`==> Starting desktop ${mode} dev...`);

  if (!hasInteractiveTty() && (process.platform === 'win32' || process.platform === 'darwin')) {
    launchInSystemTerminal(mode);
    return;
  }

  const devScript = devScriptForMode(mode);
  const child = process.platform === 'win32'
    ? spawn('cmd.exe', ['/d', '/s', '/c', `pnpm ${devScript}`], {
        cwd: rootDir,
        stdio: 'inherit',
        windowsHide: false,
        env: process.env,
      })
    : spawn('pnpm', [devScript], {
        cwd: rootDir,
        stdio: 'inherit',
        env: process.env,
      });

  child.on('exit', (code, signal) => {
    if (signal) process.kill(process.pid, signal);
    process.exit(code ?? 0);
  });
}

async function main() {
  const argv = process.argv.slice(2);
  const killOnly = argv.includes('--kill-only');
  // --local 切换到本地模式(连 localhost:3333);缺省走 remote(连 xdt-api)。
  const mode = argv.includes('--local') ? 'local' : 'remote';
  // --passive: 定时任务被动模式 —— 本实例不参与自动触发(交给同机另一个实例,
  // 典型场景 dev + release 双开时 dev 让位)。实现方式是置 XDT_SCHEDULER_PASSIVE=1,
  // 经 devEnvPrefix 白名单透传进新开的系统终端 / 直接 spawn 的 dev 进程。
  if (argv.includes('--passive')) {
    process.env.XDT_SCHEDULER_PASSIVE = '1';
    console.log('==> Scheduler passive mode: this instance will not auto-fire schedules.');
  }
  // --endpoints-cdn: dev 不读仓内 config/endpoint.json,改走与 packaged 相同的
  // 线上 CDN 端点清单拉取链路(测线上清单)。实现方式是置 XDT_ENDPOINTS_CDN=1,
  // 经 devEnvPrefix 白名单透传,主进程 devCliFlags/clientEndpointsService 消费。
  // 注意 local 模式的 endpoint.local.json 生成不在本脚本——dev(local)脚本链里的
  // apps/desktop/scripts/dev-local-env.mjs 统一负责(human 直跑与 restart 同路径)。
  if (argv.includes('--endpoints-cdn')) {
    process.env.XDT_ENDPOINTS_CDN = '1';
    console.log('==> Endpoints via CDN: dev will fetch the online endpoint manifest.');
  }
  // --isolated[=<名字>]: dev 使用独立的 userData 目录(数据库/登录态/会话全部与
  // 正式版隔离,首次要重新走飞书登录)。不带名字 = 默认沙箱(Cindy-dev);
  // 带名字 = 独立命名沙箱(Cindy-dev-<名字>),每个名字一条,可同时多开。
  // 实现:置 XDT_USER_DATA_DIR(主进程入口只在非 packaged 时应用,见
  // apps/desktop/src/main/index.ts),经 devEnvPrefix 白名单透传给 dev 进程。
  // 已手动设了 XDT_USER_DATA_DIR 时尊重用户的值,不覆盖。
  // 同时置 XDT_ISOLATED=1(开关)+ XDT_ISOLATED_NAME(名字,可选)把隔离意图带进
  // 主进程——开关与名字分离,名叫 "1" 的沙箱不会撞开关标记值(codex review P2)。
  // 主进程据此派生独立 deviceId(dev-[<名字>-]<机器指纹>,机器指纹只有主进程能取)
  // ——服务端登录凭证按 (user, device) 一对一存,不派生的话沙箱登录会覆盖正式版
  // 的续期凭证,同机互踢。
  const isolatedArg = argv.find((a) => a === '--isolated' || a.startsWith('--isolated='));
  if (isolatedArg) {
    let isolationName = '';
    if (isolatedArg.includes('=')) {
      isolationName = isolatedArg.slice('--isolated='.length);
      // 名字白名单与主进程 devCliFlags 一致:目录跨平台安全 + deviceId 总长可控。
      if (!/^[A-Za-z0-9_-]{1,32}$/.test(isolationName)) {
        console.error(`==> Invalid --isolated name: "${isolationName}"`);
        console.error('    Allowed: letters / digits / _ / -, max 32 chars. e.g. --isolated=feature-a');
        process.exit(1);
      }
    }
    process.env.XDT_ISOLATED = '1';
    if (isolationName) process.env.XDT_ISOLATED_NAME = isolationName;
    if (!process.env.XDT_USER_DATA_DIR) {
      process.env.XDT_USER_DATA_DIR = defaultIsolatedUserDataDir(isolationName);
    }
    fs.mkdirSync(process.env.XDT_USER_DATA_DIR, { recursive: true });
    console.log(`==> Isolated dev user data${isolationName ? ` (sandbox "${isolationName}")` : ''}: ${process.env.XDT_USER_DATA_DIR}`);
  }
  if (!killOnly) ensureDesktopEnv();

  const devAncestor = findDevAncestor();
  if (devAncestor) {
    console.error('==> Detected this script is running inside an Cindy desktop dev process tree:');
    console.error(`    ancestor pid ${devAncestor.pid}: ${devAncestor.command.slice(0, 180)}`);
    console.error('==> Refusing to restart from within. Killing the ancestor would terminate this');
    console.error('    script mid-flight and leave ports / file locks held by the dying process,');
    console.error('    causing the new electron-forge to fail with ELIFECYCLE.');
    console.error('==> Ask the user to restart from the terminal where they originally launched');
    console.error(`    \`pnpm ${devScriptForMode(mode)}\` (Ctrl+C then re-run), or from any external shell`);
    console.error('    not spawned by the desktop dev tree.');
    process.exit(1);
  }

  const targets = listDesktopDevProcesses();
  const darwinTerminalTtys = darwinTerminalTtysForProcesses(targets);

  if (targets.length === 0) {
    console.log('==> No existing Cindy desktop dev processes found.');
  } else {
    console.log(`==> Stopping ${targets.length} existing Cindy desktop dev process(es)...`);
    for (const target of targets) {
      console.log(`    kill ${target.pid}: ${target.command.slice(0, 180)}`);
      killProcess(target.pid);
    }

    const remainingAfterTerm = await waitForDesktopDevProcessesToExit(gracefulTimeoutMs);
    if (remainingAfterTerm.length > 0) {
      console.log(`==> Force stopping ${remainingAfterTerm.length} stubborn Cindy desktop dev process(es)...`);
      for (const target of remainingAfterTerm) {
        console.log(`    ${forceKillLabel} ${target.pid}: ${target.command.slice(0, 180)}`);
        forceKillProcess(target.pid);
      }
    }

    const remainingAfterForce = await waitForDesktopDevProcessesToExit(forceTimeoutMs);
    if (remainingAfterForce.length > 0) {
      console.error(`==> Failed to stop ${remainingAfterForce.length} Cindy desktop dev process(es); aborting restart.`);
      for (const target of remainingAfterForce) {
        console.error(`    still running ${target.pid}: ${target.command.slice(0, 180)}`);
      }
      process.exit(1);
    }

    closeDarwinTerminalTtys(darwinTerminalTtys);
  }

  if (killOnly) return;

  startDesktopDev(mode);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    console.error(error);
    process.exit(1);
  });
}
