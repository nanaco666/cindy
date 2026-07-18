#!/usr/bin/env node
// cleanup.mjs — 收尾(对应 skill 清理章节 + 3A「同步本地主干」)
//
// 覆盖所有结束路径:回到最初分支、删本地 pr-<N>、可选同步默认分支、报告 git 状态。
// 参数:
//   --original <branch>   必需,最初记录的分支(回到这里)
//   --pr <N>              可选,删本地 pr-<N>(存在才删;格式门未 checkout 就不传)
//   --sync-main           可选,合并成功后用:切默认分支 + git pull --ff-only
//
// 退出码:0 = 干净收尾;1 = 脚本自身出错。
// 跑:node scripts/review-pr/cleanup.mjs --original main --pr 123 [--sync-main]

import { git, print, fail } from './lib.mjs';
import { existsSync, unlinkSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));
const LOCK_FILE = join(SCRIPT_DIR, '.lock');

function flag(name) {
  const i = process.argv.indexOf(name);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

try {
  const original = flag('--original');
  const pr = flag('--pr');
  const syncMain = process.argv.includes('--sync-main');
  if (!original) fail('缺少 --original <分支名>');

  git(['checkout', original]);

  let deletedBranch = false;
  if (pr) {
    const br = `pr-${pr}`;
    const exists = git(['rev-parse', '--verify', '--quiet', br], { allowFail: true }).ok;
    if (exists) {
      git(['branch', '-D', br]);
      deletedBranch = true;
    }
  }

  let mainSynced = false;
  let defaultBranch = null;
  if (syncMain) {
    const sym = git(['symbolic-ref', '--quiet', 'refs/remotes/origin/HEAD'], { allowFail: true });
    defaultBranch = sym.ok && sym.stdout.trim()
      ? sym.stdout.trim().replace(/^refs\/remotes\/origin\//, '')
      : 'main';
    git(['checkout', defaultBranch]);
    mainSynced = git(['pull', '--ff-only', 'origin', defaultBranch], { allowFail: true }).ok;
  }

  // 释放互斥锁
  let lockReleased = false;
  if (existsSync(LOCK_FILE)) {
    unlinkSync(LOCK_FILE);
    lockReleased = true;
  }

  const clean = git(['status', '--porcelain']).stdout.trim() === '';
  const currentBranch = git(['rev-parse', '--abbrev-ref', 'HEAD']).stdout.trim();

  print({ ok: true, currentBranch, clean, deletedBranch, mainSynced, defaultBranch, lockReleased });
} catch (e) {
  fail(e);
}
