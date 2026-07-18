#!/usr/bin/env node
import { copyFileSync, existsSync, mkdirSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { createRequire } from 'node:module';
import { basename, dirname, join, resolve } from 'node:path';
import { homedir } from 'node:os';

const DEFAULT_APP_SUPPORT = join(homedir(), 'Library', 'Application Support', 'xdt-maker');
const DEFAULT_OUT_DIR = '/tmp/cindy-mobile-realdata';
const DEFAULT_LIMIT = 100;
const DEFAULT_MESSAGE_LIMIT = 80;
const DEFAULT_PORT = 3344;

const options = parseArgs(process.argv.slice(2));
const repoRoot = resolve(options.repo ?? join(import.meta.dirname, '..'));
const requireFromRepo = createRequire(join(repoRoot, 'package.json'));
const Database = requireFromRepo('better-sqlite3');

const sourceDb = resolveDbPath(options.db ?? 'auto');
const outDir = resolve(options.outDir ?? DEFAULT_OUT_DIR);
mkdirSync(outDir, { recursive: true });

const dbCopy = join(outDir, 'xdt-maker-realdata.db');
copySqliteBundle(sourceDb, dbCopy);

const snapshotPath = resolve(options.out ?? join(outDir, 'visualMockRealData.local.json'));
const snapshot = buildSnapshot(dbCopy, {
  sourceDbName: basename(sourceDb),
  deviceId: options.deviceId ?? 'cindy-realdata-mac',
  deviceName: options.deviceName ?? 'CINDY Real Data Mac',
  limit: positiveInt(options.limit, DEFAULT_LIMIT),
  messageLimit: positiveInt(options.messageLimit, DEFAULT_MESSAGE_LIMIT),
});
writeFileSync(snapshotPath, JSON.stringify(snapshot, null, 2), 'utf8');

console.log(`snapshot: ${snapshotPath}`);
console.log(`db copy: ${dbCopy}`);
console.log(`sessions: ${snapshot.sessions.length}`);
console.log(`messages: ${Object.values(snapshot.messagesBySession).reduce((sum, list) => sum + list.length, 0)}`);
console.log(`selected session: ${snapshot.selectedSessionId}`);

if (options.serve) {
  const port = positiveInt(options.port, DEFAULT_PORT);
  createServer((req, res) => {
    const url = new URL(req.url ?? '/', `http://${req.headers.host ?? `127.0.0.1:${port}`}`);
    if (url.pathname !== '/' && url.pathname !== '/visualMockRealData.local.json') {
      res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' });
      res.end('not found');
      return;
    }
    res.writeHead(200, {
      'access-control-allow-origin': '*',
      'cache-control': 'no-store',
      'content-type': 'application/json; charset=utf-8',
    });
    res.end(JSON.stringify(snapshot, null, 2));
  }).listen(port, '127.0.0.1', () => {
    console.log(`serving: http://127.0.0.1:${port}/visualMockRealData.local.json`);
  });
}

function buildSnapshot(dbPath, opts) {
  const db = new Database(dbPath, { readonly: true, fileMustExist: true });
  db.pragma('query_only = ON');
  db.pragma('busy_timeout = 1000');

  const sessions = db.prepare(`
    select
      s.id as id,
      s.title as title,
      s.working_dir as workingDir,
      s.workspace_kind as workspaceKind,
      s.model as model,
      s.effort as effort,
      s.permission_mode as permissionMode,
      s.status as status,
      s.sdk_session_id as sdkSessionId,
      s.total_token_usage as totalTokenUsage,
      s.total_cost_usd as totalCostUsd,
      s.context_tokens as contextTokens,
      s.context_window as contextWindow,
      s.fast_mode as fastMode,
      s.cleared_at as clearedAt,
      s.pinned_at as pinnedAt,
      s.user_send_at as userSendAt,
      s.agent_kind as agentKind,
      s.source as source,
      s.orca_role as orcaRole,
      s.parent_session_id as parentSessionId,
      s.forked_at_message_id as forkedAtMessageId,
      s.worktree_path as worktreePath,
      s.used_project_context as usedProjectContext,
      s.extra_dirs as extraDirs,
      s.remote_host_id as remoteHostId,
      s.created_at as createdAt,
      s.updated_at as updatedAt,
      (
        select count(*)
        from messages m
        where m.session_id = s.id
          and m.rewind_at is null
      ) as messageCount,
      (
        select m.content
        from messages m
        where m.session_id = s.id
          and m.rewind_at is null
          and m.role in ('user', 'assistant', 'error')
        order by m.created_at desc, m.id desc
        limit 1
      ) as latestContent
    from sessions s
    where s.status = 'active'
    order by
      case when s.pinned_at is null then 1 else 0 end,
      coalesce(s.user_send_at, s.updated_at, s.created_at) desc,
      s.created_at desc
    limit ?
  `).all(opts.limit).map(sessionRow);

  const messageStmt = db.prepare(`
    select
      id,
      client_id as clientId,
      session_id as sessionId,
      role,
      content,
      tool_use_id as toolUseId,
      agent_meta as agentMeta,
      created_at as createdAt
    from messages
    where session_id = ?
      and rewind_at is null
    order by created_at desc, id desc
    limit ?
  `);
  const messagesBySession = {};
  for (const session of sessions) {
    messagesBySession[session.id] = messageStmt.all(session.id, opts.messageLimit).reverse().map(messageRow);
  }
  db.close();

  return {
    schema: 'cindy-mobile-visual-realdata-v1',
    generatedAt: new Date().toISOString(),
    source: {
      dbCopyPath: dbPath,
      sourceDbName: opts.sourceDbName,
    },
    device: {
      deviceId: opts.deviceId,
      name: opts.deviceName,
      platform: 'darwin',
      appVersion: '0.0.0-realdata-preview',
    },
    selectedSessionId: sessions[0]?.id ?? null,
    sessions,
    messagesBySession,
    pendingInteractionsBySession: {},
    projectionsBySession: {},
  };
}

function sessionRow(row) {
  const createdAt = msToIso(row.createdAt) ?? new Date().toISOString();
  return {
    id: String(row.id),
    userId: '',
    title: stringOr(row.title, 'New Maker'),
    workingDir: row.workingDir ?? null,
    workspaceKind: row.workspaceKind === 'dialogue' ? 'dialogue' : 'project',
    model: stringOr(row.model, 'claude-sonnet-4-6'),
    effort: stringOr(row.effort, 'medium'),
    permissionMode: stringOr(row.permissionMode, 'ask'),
    status: normalizeSessionStatus(row.status),
    sdkSessionId: row.sdkSessionId ?? null,
    totalTokenUsage: numberOrZero(row.totalTokenUsage),
    totalCostUsd: numberOrZero(row.totalCostUsd),
    contextTokens: numberOrZero(row.contextTokens),
    contextWindow: numberOrZero(row.contextWindow),
    fastMode: row.fastMode === 1 || row.fastMode === true,
    clearedAt: msToIso(row.clearedAt),
    pinnedAt: msToIso(row.pinnedAt),
    userSendAt: msToIso(row.userSendAt),
    agentKind: row.agentKind === 'codex' ? 'codex' : 'cc',
    source: row.source === 'scheduler' ? 'scheduler' : 'desktop',
    orcaRole: row.orcaRole ?? null,
    parentSessionId: row.parentSessionId ?? null,
    forkedAtMessageId: row.forkedAtMessageId ?? null,
    worktreePath: row.worktreePath ?? null,
    usedProjectContext: row.usedProjectContext === 1 || row.usedProjectContext === true,
    extraDirs: parseStringArray(row.extraDirs),
    remoteHostId: row.remoteHostId ?? null,
    createdAt,
    updatedAt: msToIso(row.updatedAt) ?? createdAt,
    preview: previewText(row.latestContent),
    _count: { messages: numberOrZero(row.messageCount) },
  };
}

function messageRow(row) {
  return {
    id: String(row.id),
    clientId: String(row.clientId ?? row.id),
    sessionId: String(row.sessionId),
    role: normalizeMessageRole(row.role),
    content: parseJson(row.content, row.content),
    toolUseId: row.toolUseId ?? null,
    agentMeta: row.agentMeta == null ? null : parseJson(row.agentMeta, null),
    createdAt: msToIso(row.createdAt) ?? new Date().toISOString(),
  };
}

function resolveDbPath(input) {
  if (input && input !== 'auto') return resolve(input);
  const entries = [];
  for (const name of safeReaddir(DEFAULT_APP_SUPPORT)) {
    if (!/^xdt-maker-.+\.db$/.test(name)) continue;
    const full = join(DEFAULT_APP_SUPPORT, name);
    try {
      const stat = statSync(full);
      if (stat.isFile()) entries.push({ full, mtimeMs: stat.mtimeMs, size: stat.size });
    } catch {}
  }
  entries.sort((a, b) => b.mtimeMs - a.mtimeMs || b.size - a.size);
  if (!entries[0]) throw new Error(`no xdt-maker-*.db found in ${DEFAULT_APP_SUPPORT}`);
  return entries[0].full;
}

function copySqliteBundle(source, target) {
  mkdirSync(dirname(target), { recursive: true });
  copyFileSync(source, target);
  for (const suffix of ['-wal', '-shm']) {
    if (existsSync(`${source}${suffix}`)) copyFileSync(`${source}${suffix}`, `${target}${suffix}`);
  }
}

function parseArgs(args) {
  const parsed = {};
  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i];
    if (arg === '--db') parsed.db = args[++i];
    else if (arg === '--out') parsed.out = args[++i];
    else if (arg === '--out-dir') parsed.outDir = args[++i];
    else if (arg === '--repo') parsed.repo = args[++i];
    else if (arg === '--limit') parsed.limit = args[++i];
    else if (arg === '--message-limit') parsed.messageLimit = args[++i];
    else if (arg === '--device-id') parsed.deviceId = args[++i];
    else if (arg === '--device-name') parsed.deviceName = args[++i];
    else if (arg === '--serve') parsed.serve = true;
    else if (arg === '--port') parsed.port = args[++i];
    else if (arg === '--help' || arg === '-h') {
      console.log('Usage: node scripts/export-realdata-visual-snapshot.mjs [--db auto|path] [--serve] [--port 3344]');
      process.exit(0);
    } else {
      throw new Error(`unknown arg: ${arg}`);
    }
  }
  return parsed;
}

function safeReaddir(dir) {
  try {
    return readdirSync(dir);
  } catch {
    return [];
  }
}

function msToIso(value) {
  const n = Number(value);
  if (!Number.isFinite(n) || n <= 0) return null;
  return new Date(n).toISOString();
}

function numberOrZero(value) {
  const n = Number(value);
  return Number.isFinite(n) ? n : 0;
}

function stringOr(value, fallback) {
  return typeof value === 'string' && value.trim() ? value : fallback;
}

function normalizeSessionStatus(value) {
  return value === 'archived' || value === 'deleted' ? value : 'active';
}

function normalizeMessageRole(value) {
  return ['user', 'assistant', 'tool_use', 'tool_result', 'ask_user', 'plan_review', 'thinking', 'system', 'error'].includes(value)
    ? value
    : 'assistant';
}

function parseJson(value, fallback) {
  if (typeof value !== 'string') return fallback;
  try {
    return JSON.parse(value);
  } catch {
    return fallback;
  }
}

function parseStringArray(value) {
  const parsed = parseJson(value, []);
  return Array.isArray(parsed) ? parsed.filter((item) => typeof item === 'string') : [];
}

function previewText(value) {
  const parsed = parseJson(value, value);
  if (typeof parsed === 'string') return parsed.slice(0, 240);
  if (parsed && typeof parsed === 'object') {
    if (typeof parsed.text === 'string') return parsed.text.slice(0, 240);
    if (typeof parsed.message === 'string') return parsed.message.slice(0, 240);
  }
  return null;
}

function positiveInt(value, fallback) {
  const n = Number(value);
  return Number.isInteger(n) && n > 0 ? n : fallback;
}
