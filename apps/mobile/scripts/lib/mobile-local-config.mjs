import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadSelfHostRegions } from './self-host-region.mjs';

const defaultMobileDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');

/** Parse the path and branch fields needed to rank reusable local configs. */
export function parseGitWorktreeEntries(text) {
  const entries = [];
  let current = null;
  for (const line of text.split(/\r?\n/)) {
    if (line.startsWith('worktree ')) {
      current = { path: line.slice('worktree '.length), branch: null };
      entries.push(current);
    } else if (current && line.startsWith('branch ')) {
      current.branch = line.slice('branch '.length);
    }
  }
  return entries;
}

/**
 * A Git worktree does not inherit gitignored machine config. Reuse a validated
 * config from another worktree without printing any of its values.
 */
export function ensureMobileLocalRegionConfig(options = {}) {
  const mobileDir = path.resolve(options.mobileDir ?? defaultMobileDir);
  const worktreeRoot = path.resolve(mobileDir, '../..');
  const configPath = path.join(mobileDir, 'scripts', 'self-host-regions.json');
  const validateConfig = options.validateConfig ?? ((candidate) => loadSelfHostRegions({ filePath: candidate }));

  if (fs.existsSync(configPath)) {
    validateConfig(configPath);
    return { configPath, copiedFrom: null };
  }

  const entries = options.worktreeEntries ?? readWorktreeEntries(worktreeRoot);
  const candidates = entries
    .filter((entry) => path.resolve(entry.path) !== worktreeRoot)
    .sort((a, b) => candidateRank(a) - candidateRank(b));
  const invalidCandidates = [];

  for (const candidate of candidates) {
    const sourcePath = path.join(candidate.path, 'apps', 'mobile', 'scripts', 'self-host-regions.json');
    if (!fs.existsSync(sourcePath)) continue;
    try {
      validateConfig(sourcePath);
    } catch {
      invalidCandidates.push(sourcePath);
      continue;
    }
    fs.copyFileSync(sourcePath, configPath, fs.constants.COPYFILE_EXCL);
    fs.chmodSync(configPath, 0o600);
    validateConfig(configPath);
    return { configPath, copiedFrom: sourcePath };
  }

  const invalidHint = invalidCandidates.length > 0
    ? ` Found ${invalidCandidates.length} invalid config candidate(s); values were not copied.`
    : '';
  throw new Error(
    `Missing mobile local region config: ${configPath}. Copy self-host-regions.json from a configured Cindy worktree or fill self-host-regions.json.example.${invalidHint}`,
  );
}

export function formatMobileLocalConfigStatus(result, worktreeRoot) {
  if (!result.copiedFrom) return null;
  return `==> Reused validated mobile local config from ${path.relative(path.dirname(worktreeRoot), result.copiedFrom)} (values hidden)`;
}

function readWorktreeEntries(worktreeRoot) {
  try {
    const text = execFileSync('git', ['worktree', 'list', '--porcelain'], {
      cwd: worktreeRoot,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    return parseGitWorktreeEntries(text);
  } catch {
    return [];
  }
}

function candidateRank(entry) {
  const basename = path.basename(entry.path);
  if (entry.branch?.startsWith('refs/heads/dash/personal-client-') || basename.endsWith('personal-client')) return 0;
  if (entry.branch === 'refs/heads/main' || entry.branch === 'refs/heads/master') return 1;
  return 2;
}
