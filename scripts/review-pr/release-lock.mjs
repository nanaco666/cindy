#!/usr/bin/env node
// release-lock.mjs — 幂等释放 review-pr 互斥锁。
//
// 用途:任何不走 cleanup.mjs 的早退路径(prepare 失败、no-PR、auto 模式 prepare 异常、
// 候选全跳后异常退出等)都调它来主动释放锁,避免死锁等 60 分钟 TTL 才被清。
// 行为:存在就删、不存在就 no-op,永远 exit 0(失败也只在 stderr 提示,不阻断流程)。
//
// 跑:node scripts/review-pr/release-lock.mjs

import { existsSync, unlinkSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { print } from './lib.mjs';

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));
const LOCK_FILE = join(SCRIPT_DIR, '.lock');

let released = false;
let alreadyAbsent = true;
let error = null;

if (existsSync(LOCK_FILE)) {
  alreadyAbsent = false;
  try {
    unlinkSync(LOCK_FILE);
    released = true;
  } catch (e) {
    error = String(e && e.message ? e.message : e);
  }
}

print({ ok: true, released, alreadyAbsent, error });
