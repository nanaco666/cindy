// 模拟器 / Metro 端口归属与 git env 的共享判断,供 sim-start.mjs / sim-rebuild.mjs 复用,
// 避免两边各自重复一套(以及"一个脚本加了校验、另一个忘了"的不一致)。macOS 专用(lsof/ps -E)。

import { execFileSync } from 'node:child_process';
import net from 'node:net';
import { relative } from 'node:path';

// 连接探测:连得上 = 有进程在监听。比 listen(127.0.0.1) 可靠 —— Metro 监听 *:port(可能带
// SO_REUSEADDR),用 listen 探测会误判成空闲。
export function portInUse(port) {
  return new Promise((res) => {
    const sock = net.connect({ port, host: '127.0.0.1' });
    const done = (v) => { sock.destroy(); res(v); };
    sock.once('connect', () => done(true));
    sock.once('error', () => done(false));
    sock.setTimeout(500, () => done(false));
  });
}

// 监听该端口的第一个进程 pid(LISTEN)。
export function listenerPid(port) {
  try {
    return execFileSync('lsof', ['-nP', `-iTCP:${port}`, '-sTCP:LISTEN', '-t'], { encoding: 'utf8' })
      .trim().split('\n')[0] || null;
  } catch {
    return null;
  }
}

// 进程工作目录(用 cwd 判 worktree,而非解析命令行 —— 命令行常是 `pnpm exec expo`、取不到
// worktree,且各 checkout 目录名不同)。macOS:lsof -a -p <pid> -d cwd -Fn。
export function cwdOfPid(pid) {
  try {
    const out = execFileSync('lsof', ['-a', '-p', pid, '-d', 'cwd', '-Fn'], { encoding: 'utf8' });
    const line = out.split('\n').find((l) => l.startsWith('n'));
    return line ? line.slice(1) : null;
  } catch {
    return null;
  }
}

// 读运行中 Metro 进程注入的 EXPO_PUBLIC_XDT_GIT_BRANCH(ps -E 打印进程环境)。用于判断
// 该 Metro 是否带了当前分支的 git env —— 没带的话 __DEV__ build label branch 会是旧值/unknown。
export function gitBranchOfPid(pid) {
  try {
    const out = execFileSync('ps', ['-ww', '-E', '-p', pid], { encoding: 'utf8' });
    const m = out.match(/EXPO_PUBLIC_XDT_GIT_BRANCH=(\S*)/);
    return m ? m[1] : null;
  } catch {
    return null;
  }
}

// 真正的路径边界判断:避免 /workspace/XDMaker 与 /workspace/XDMaker-old 这种字符串前缀误判。
export function isInside(root, child) {
  const rel = relative(root, child);
  return rel === '' || !rel.startsWith('..');
}
