import fs from 'node:fs';
import path from 'node:path';
import yaml from 'js-yaml';
import type { ConfigFile } from './types.js';

export const CONTEXT_DIR = '.xdmaker/project-knowledge';
export const CONFIG_FILENAME = 'config.yaml';
export const MANIFEST_FILENAME = 'manifest.yaml';
export const MODULES_SUBDIR = 'modules';
export const CONCERNS_SUBDIR = 'concerns';
export const LOCK_FILENAME = '.lock';
/**
 * Pre-rendered TOC for session-time injection. Written by init/update/refresh after
 * manifest is updated. Consumers (e.g. apps/desktop) read this file directly instead
 * of dynamically extracting summaries from every .md at session start. Source of
 * truth for module summaries remains the `## 是什么` H2 section of each module .md;
 * this file is a derived artifact, regenerated whenever knowledge changes.
 */
export const TOC_FILENAME = 'TOC.md';

const DEFAULT_CONFIG: ConfigFile = {
  small_diff_threshold: {
    files: 5,
    lines: 200,
  },
  agent: 'claude-code',
  agent_options: {
    timeout: 300,
  },
};

export interface ResolvedPaths {
  repoRoot: string;
  contextDir: string;
  configPath: string;
  manifestPath: string;
  modulesDir: string;
  concernsDir: string;
  lockPath: string;
  tocPath: string;
}

export function resolvePaths(repoRoot: string): ResolvedPaths {
  const contextDir = path.join(repoRoot, CONTEXT_DIR);
  return {
    repoRoot,
    contextDir,
    configPath: path.join(contextDir, CONFIG_FILENAME),
    manifestPath: path.join(contextDir, MANIFEST_FILENAME),
    modulesDir: path.join(contextDir, MODULES_SUBDIR),
    concernsDir: path.join(contextDir, CONCERNS_SUBDIR),
    lockPath: path.join(contextDir, LOCK_FILENAME),
    tocPath: path.join(contextDir, TOC_FILENAME),
  };
}

export function loadConfig(configPath: string): ConfigFile {
  if (!fs.existsSync(configPath)) {
    return { ...DEFAULT_CONFIG };
  }
  const raw = fs.readFileSync(configPath, 'utf8');
  const parsed = (yaml.load(raw) ?? {}) as Partial<ConfigFile>;
  return mergeConfig(parsed);
}

export function mergeConfig(partial: Partial<ConfigFile>): ConfigFile {
  return {
    module_roots: partial.module_roots,
    ignore: partial.ignore,
    module_ignore: partial.module_ignore,
    small_diff_threshold: {
      ...DEFAULT_CONFIG.small_diff_threshold,
      ...(partial.small_diff_threshold ?? {}),
    },
    agent: partial.agent ?? DEFAULT_CONFIG.agent,
    agent_options: {
      ...DEFAULT_CONFIG.agent_options,
      ...(partial.agent_options ?? {}),
    },
  };
}

export function writeDefaultConfigIfMissing(configPath: string): boolean {
  if (fs.existsSync(configPath)) return false;
  const sample = `# project-context configuration. See docs/project-context.md §4.4 for full schema.
#
# module_roots: optional. Defaults to package-manager auto-discovery
#   (pnpm-workspace.yaml / package.json workspaces).
# module_roots:
#   - packages/*
#   - apps/*
#
# ignore: extra patterns on top of .gitignore + builtin defaults.
# ignore:
#   - apps/landing-page
#
small_diff_threshold:
  files: 5
  lines: 200

agent: claude-code
agent_options:
  timeout: 300
`;
  fs.mkdirSync(path.dirname(configPath), { recursive: true });
  fs.writeFileSync(configPath, sample, 'utf8');
  return true;
}
