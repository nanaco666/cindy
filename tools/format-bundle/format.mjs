#!/usr/bin/env node
// 批量 beautify JS bundle 文件
//
// Usage:
//   node format.mjs <dir-or-file> [<dir-or-file> ...]
//
// Options (可作为任意位置的参数):
//   --inplace          直接覆盖原文件（默认写到 <name>.pretty.js）
//   --force            忽略缓存，强制重新格式化
//   --max-mb <N>       跳过大于 N MB 的文件（默认 30）
//   --concurrency <N>  并行数（默认 4）
//   --include-pretty   不跳过已有 .pretty.js / .lines.js 文件
//   --quiet            只打印错误
//
// 跳过约定：
//   - 扩展名不是 .js 的文件
//   - 文件名以 .pretty.js / .lines.js / .min.js 结尾
//   - 路径中包含 node_modules / .git
//   - 大于 max-mb 的文件
//   - 已有同名 .pretty.js 且比源文件新（除非 --force）

import beautifyPkg from 'js-beautify';
const beautify = beautifyPkg.js;
import { readFile, writeFile, stat, readdir } from 'node:fs/promises';
import { join, basename, extname, relative, resolve } from 'node:path';
import { performance } from 'node:perf_hooks';

const args = process.argv.slice(2);
const opts = {
  inplace: false,
  force: false,
  maxMb: 30,
  concurrency: 4,
  includePretty: false,
  quiet: false,
  paths: [],
};

for (let i = 0; i < args.length; i++) {
  const a = args[i];
  if (a === '--inplace') opts.inplace = true;
  else if (a === '--force') opts.force = true;
  else if (a === '--include-pretty') opts.includePretty = true;
  else if (a === '--quiet') opts.quiet = true;
  else if (a === '--max-mb') opts.maxMb = Number(args[++i]);
  else if (a === '--concurrency') opts.concurrency = Number(args[++i]);
  else if (a.startsWith('--')) {
    console.error(`Unknown option: ${a}`);
    process.exit(2);
  } else {
    opts.paths.push(a);
  }
}

if (opts.paths.length === 0) {
  console.error('Usage: node format.mjs <dir-or-file> [...] [--inplace] [--force] [--max-mb N] [--concurrency N]');
  process.exit(2);
}

const SKIP_DIRS = new Set(['node_modules', '.git', '.svn', '.hg', 'dist', 'out']);

const log = (...m) => { if (!opts.quiet) console.log(...m); };

async function* walk(p) {
  const s = await stat(p);
  if (s.isFile()) {
    if (extname(p) === '.js') yield { path: p, size: s.size };
    return;
  }
  if (!s.isDirectory()) return;
  const entries = await readdir(p, { withFileTypes: true });
  for (const ent of entries) {
    if (ent.isDirectory()) {
      if (SKIP_DIRS.has(ent.name)) continue;
      yield* walk(join(p, ent.name));
    } else if (ent.isFile() && extname(ent.name) === '.js') {
      const full = join(p, ent.name);
      const st = await stat(full);
      yield { path: full, size: st.size };
    }
  }
}

function shouldSkip(file) {
  const name = basename(file.path);
  if (!opts.includePretty && (name.endsWith('.pretty.js') || name.endsWith('.lines.js') || name.endsWith('.min.js'))) {
    return 'auxiliary file';
  }
  if (file.size > opts.maxMb * 1024 * 1024) {
    return `>${opts.maxMb}MB`;
  }
  return null;
}

async function isCacheFresh(srcPath, destPath) {
  if (opts.force) return false;
  try {
    const [src, dest] = await Promise.all([stat(srcPath), stat(destPath)]);
    return dest.mtimeMs >= src.mtimeMs;
  } catch {
    return false;
  }
}

const BEAUTIFY_OPTS = {
  indent_size: 2,
  max_preserve_newlines: 2,
  preserve_newlines: true,
  end_with_newline: true,
  brace_style: 'collapse,preserve-inline',
  jslint_happy: false,
  space_in_empty_paren: false,
};

async function formatOne(file) {
  const destPath = opts.inplace
    ? file.path
    : file.path.slice(0, -3) + '.pretty.js';

  if (!opts.inplace && await isCacheFresh(file.path, destPath)) {
    return { path: file.path, status: 'cached', destPath };
  }

  const t0 = performance.now();
  const src = await readFile(file.path, 'utf8');
  const out = beautify(src, BEAUTIFY_OPTS);
  await writeFile(destPath, out, 'utf8');
  const ms = performance.now() - t0;
  return {
    path: file.path,
    status: 'formatted',
    destPath,
    inLines: src.split('\n').length,
    outLines: out.split('\n').length,
    ms: Math.round(ms),
  };
}

async function pool(items, n, worker) {
  const results = new Array(items.length);
  let cursor = 0;
  const runners = Array.from({ length: Math.min(n, items.length) }, async () => {
    while (cursor < items.length) {
      const idx = cursor++;
      try {
        results[idx] = await worker(items[idx]);
      } catch (err) {
        results[idx] = { path: items[idx].path, status: 'error', error: err.message };
      }
    }
  });
  await Promise.all(runners);
  return results;
}

async function main() {
  const allFiles = [];
  for (const p of opts.paths) {
    const abs = resolve(p);
    for await (const f of walk(abs)) allFiles.push(f);
  }

  const queue = [];
  let skippedCount = 0;
  for (const f of allFiles) {
    const reason = shouldSkip(f);
    if (reason) {
      skippedCount++;
      log(`  skip ${relative(process.cwd(), f.path)} (${reason})`);
    } else {
      queue.push(f);
    }
  }

  log(`\nFound ${allFiles.length} .js files; ${queue.length} to format, ${skippedCount} skipped`);
  if (queue.length === 0) return;

  log(`Concurrency: ${opts.concurrency}\n`);

  const t0 = performance.now();
  const results = await pool(queue, opts.concurrency, formatOne);
  const totalMs = Math.round(performance.now() - t0);

  let ok = 0, cached = 0, errors = 0;
  for (const r of results) {
    if (r.status === 'formatted') {
      ok++;
      log(`  ✓ ${relative(process.cwd(), r.path)} → ${basename(r.destPath)} (${r.inLines}→${r.outLines} lines, ${r.ms}ms)`);
    } else if (r.status === 'cached') {
      cached++;
      log(`  · ${relative(process.cwd(), r.path)} (cached)`);
    } else {
      errors++;
      console.error(`  ✗ ${relative(process.cwd(), r.path)}: ${r.error}`);
    }
  }

  log(`\nDone in ${totalMs}ms — ${ok} formatted, ${cached} cached, ${errors} errors`);
  if (errors > 0) process.exit(1);
}

main().catch(e => {
  console.error(e);
  process.exit(1);
});
