#!/usr/bin/env node
// "我现在看到的到底是哪一版?" 的终端体检。一次性打印:
//   1) 当前 booted 模拟器
//   2) 模拟器里装的 com.xd.lizcn 的 version / buildNumber(= 哪个 native dev client)
//   3) 8081-8086 各端口上的 Metro 分别属于哪个 worktree(多 worktree 时 8081 常是别的分支)
//
// 这替代了反复手敲 PlistBuddy + lsof + ps 的组合。注意:native 版本号只证明安装包,
// 证明不了 JS 新鲜度——JS 要看连的是哪个 worktree 的 Metro(配合模拟器里的 __DEV__ build label)。
//
// 用法:pnpm mobile:sim:whoami  或  node apps/mobile/scripts/sim-whoami.mjs

import { execSync } from 'node:child_process';

const BUNDLE_ID = 'com.xd.lizcn';
const PORTS = [8081, 8082, 8083, 8084, 8085, 8086];

function sh(cmd) {
  try {
    return execSync(cmd, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
  } catch {
    return '';
  }
}

console.log('==== booted 模拟器 ====');
const booted = sh('xcrun simctl list devices booted').split('\n').filter((l) => /\(Booted\)/.test(l));
if (booted.length === 0) console.log('  (没有 booted 模拟器)');
else booted.forEach((l) => console.log('  ' + l.trim()));

console.log('\n==== 模拟器里装的 ' + BUNDLE_ID + '(native 安装包版本)====');
const container = sh(`xcrun simctl get_app_container booted ${BUNDLE_ID} app`);
if (!container) {
  console.log('  (未安装 / 无 booted 设备)');
} else {
  const plist = `${container}/Info.plist`;
  const pb = (key) => sh(`/usr/libexec/PlistBuddy -c 'Print :${key}' "${plist}"`);
  console.log('  version    :', pb('CFBundleShortVersionString'));
  console.log('  buildNumber:', pb('CFBundleVersion'));
  console.log('  ⚠️ 版本号只证明装的是哪个 dev client,证明不了 JS bundle 是不是当前分支最新。');
}

// 读进程 cwd 来判 worktree —— 比解析 `ps -o command` 可靠:命令行常是 `pnpm exec expo`、
// 取不到 worktree 路径,且各 checkout 目录名不一(如 /workspace/XDMaker)。macOS 用 lsof cwd。
function cwdOf(pid) {
  const out = sh(`lsof -a -p ${pid} -d cwd -Fn`);
  const line = out.split('\n').find((l) => l.startsWith('n'));
  return line ? line.slice(1) : '';
}

console.log('\n==== Metro 端口归属(哪个端口 = 哪个 worktree)====');
let anyMetro = false;
for (const port of PORTS) {
  const pids = sh(`lsof -nP -iTCP:${port} -sTCP:LISTEN -t`).split('\n').filter(Boolean);
  for (const pid of pids) {
    const cwd = cwdOf(pid);
    // Metro 由 sim:start 以 cwd=<worktree>/apps/mobile 启动,故进程 cwd 即 worktree 位置。
    const wt = cwd ? cwd.replace(/\/apps\/mobile$/, '') : '(无法读取进程 cwd)';
    const isMetro = /expo|metro/i.test(sh(`ps -p ${pid} -o command=`));
    if (isMetro) anyMetro = true;
    console.log(`  :${port}  pid ${pid}  →  ${wt}${isMetro ? '' : '  (非 Metro?)'}`);
  }
}
if (!anyMetro) console.log('  (8081-8086 上没发现 Metro;用 `pnpm mobile:sim:start` 启一个)');

console.log('\n结论:模拟器新建会话页顶部 __DEV__ build label 显示的 host:port,应当指向你当前分支这台 Metro。');
console.log('若 build label 端口对应的 worktree 不是你正在改的分支 → 你看到的是旧代码,重连正确端口。');
