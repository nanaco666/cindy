/**
 * hook-control/store.ts
 * ---------------------------------------------------------------------------
 * Slack Hook 配置存储(单配置形态)。
 *
 *   - 持久化为 <userData>/slack-hook.json: { enabled, urlOverride?, workspaces }
 *     —— 属配置而非业务数据, 不进 localDb, 免去 migration 链; 原子写防半截文件。
 *   - **没有密钥**: 鉴权走登录 JWT(manager 注入 token 源), 本模块不再有
 *     safeStorage 依赖。
 *   - 服务器地址的系统默认值由 deps.defaultUrl 注入(生产 = 运行期端点清单的
 *     slackHookWsUrl); urlOverride 是无 UI 的隐藏覆写位(规则 20: 未自定义的
 *     用户随版本吃到新默认值, 覆写过的保留)。
 *   - 一次性迁移: 旧多连接文件 hook-connections.json 存在且新文件不存在时,
 *     取最早创建的启用条目的 enabled + workspaces 落进新文件, 旧文件与旧
 *     secret 加密文件 best-effort 清除(该功能无存量真实用户, 迁移从简)。
 *   - 工厂注入 filePath / log, 单测内存 harness 直接驱动(规则 14)。
 */

import fs from 'node:fs';
import path from 'node:path';

import {
  HOOK_CHAT_WORKSPACE_ALIAS,
  HOOK_WORKSPACE_ALIAS_RE,
} from '../../shared/hookControlIpc.js';

/** 持久化的单配置(不含任何凭证)。 */
export interface SlackHookConfigState {
  enabled: boolean;
  /** 服务器地址覆写(高级/调试用, 无 UI 入口); null = 跟随内置默认。 */
  urlOverride: string | null;
  /** 别名 -> 本地绝对路径。 */
  workspaces: Record<string, string>;
}

export interface SlackHookStoreDeps {
  filePath: string;
  /** 旧多连接配置文件路径(迁移源; 不存在则跳过迁移)。 */
  legacyFilePath?: string;
  /** 旧 secret 加密文件清理钩子(best-effort; 生产传 safe-storage 目录清理)。 */
  cleanupLegacySecrets?: (legacyIds: string[]) => void;
  /** 无覆写时的默认服务器地址(生产注入运行期端点清单读取;烘焙常量已退役)。 */
  defaultUrl: () => string;
  log: { info(msg: string): void; warn(msg: string): void };
}

/** 校验失败以该错误抛出, IPC 层翻译成 throwIpcError('INVALID_PARAMS')。 */
export class HookConnectionValidationError extends Error {}

/**
 * dispatcher 消费的连接视图(保留多连接时代的形状 —— dispatcher / bindings
 * 不感知单连接化, 单配置由 ipc 组装层映射成固定 id 'slack' 的一条)。
 */
export interface HookConnectionConfig {
  id: string;
  name: string;
  url: string;
  enabled: boolean;
  workspaces: Record<string, string>;
  createdAt: number;
}

const MAX_WORKSPACES = 32;

/** 校验工作目录清单(别名格式 / 路径绝对), 返回规整副本。 */
export function validateWorkspaces(input: Record<string, string>): Record<string, string> {
  const entries = Object.entries(input ?? {});
  if (entries.length > MAX_WORKSPACES) {
    throw new HookConnectionValidationError(`at most ${MAX_WORKSPACES} workspaces`);
  }
  const workspaces: Record<string, string> = {};
  for (const [alias, dir] of entries) {
    if (!HOOK_WORKSPACE_ALIAS_RE.test(alias)) {
      throw new HookConnectionValidationError(
        `workspace alias "${alias}" must match ${HOOK_WORKSPACE_ALIAS_RE.source}`,
      );
    }
    // 保留别名: 内置「对话」伪目录占用, 真实目录不许撞名(撞了会被枚举/派发
    // 侧的保留名优先规则遮蔽, 用户还以为绑到了自己的目录)
    if (alias === HOOK_CHAT_WORKSPACE_ALIAS) {
      throw new HookConnectionValidationError(
        `workspace alias "${alias}" is reserved for the built-in chat workspace`,
      );
    }
    const trimmed = typeof dir === 'string' ? dir.trim() : '';
    if (!trimmed || !path.isAbsolute(trimmed)) {
      throw new HookConnectionValidationError(`workspace "${alias}" path must be an absolute path`);
    }
    workspaces[alias] = trimmed;
  }
  return workspaces;
}

/** Slack Hook 配置仓库(写操作同步落盘, 返回写后最新状态)。 */
export interface SlackHookStore {
  get(): SlackHookConfigState;
  /** 实际生效的服务器地址(覆写优先, 否则内置默认)。 */
  effectiveUrl(): string;
  setEnabled(enabled: boolean): SlackHookConfigState;
  setWorkspaces(workspaces: Record<string, string>): SlackHookConfigState;
}

export function createSlackHookStore(deps: SlackHookStoreDeps): SlackHookStore {
  const { filePath, legacyFilePath, cleanupLegacySecrets, log } = deps;

  function write(state: SlackHookConfigState): void {
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    const tmp = `${filePath}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(state, null, 2), 'utf-8');
    fs.renameSync(tmp, filePath);
  }

  /** 旧多连接文件 -> 单配置(最早创建的启用条目优先, 没有启用的取最早一条)。 */
  function migrateLegacy(): SlackHookConfigState | null {
    if (!legacyFilePath || !fs.existsSync(legacyFilePath)) return null;
    try {
      const raw = JSON.parse(fs.readFileSync(legacyFilePath, 'utf-8')) as unknown;
      if (!Array.isArray(raw)) return null;
      const rows = raw
        .filter((r): r is Record<string, unknown> => !!r && typeof r === 'object')
        .sort((a, b) => (Number(a.createdAt) || 0) - (Number(b.createdAt) || 0));
      const source = rows.find((r) => r.enabled === true) ?? rows[0] ?? null;
      const workspaces: Record<string, string> = {};
      if (source?.workspaces && typeof source.workspaces === 'object' && !Array.isArray(source.workspaces)) {
        for (const [k, v] of Object.entries(source.workspaces as Record<string, unknown>)) {
          if (typeof v === 'string' && HOOK_WORKSPACE_ALIAS_RE.test(k)) workspaces[k] = v;
        }
      }
      const migrated: SlackHookConfigState = {
        enabled: source?.enabled === true,
        urlOverride: null, // 旧 url 是自部署地址, 不迁移 —— 新形态用内置中心服务器
        workspaces,
      };
      // 清理旧文件与旧 secret(best-effort, 失败只记日志)
      const legacyIds = rows.map((r) => (typeof r.id === 'string' ? r.id : '')).filter(Boolean);
      try {
        fs.unlinkSync(legacyFilePath);
      } catch {
        /* 清不掉不影响迁移结果 */
      }
      try {
        cleanupLegacySecrets?.(legacyIds);
      } catch {
        /* best-effort */
      }
      log.info(`migrated legacy hook-connections (${rows.length} rows) to slack-hook.json`);
      return migrated;
    } catch (err) {
      log.warn(`legacy hook-connections migration failed: ${err instanceof Error ? err.message : String(err)}`);
      return null;
    }
  }

  function read(): SlackHookConfigState {
    try {
      if (!fs.existsSync(filePath)) {
        const migrated = migrateLegacy();
        if (migrated) {
          write(migrated);
          return migrated;
        }
        return { enabled: false, urlOverride: null, workspaces: {} };
      }
      const raw = JSON.parse(fs.readFileSync(filePath, 'utf-8')) as unknown;
      if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
        return { enabled: false, urlOverride: null, workspaces: {} };
      }
      const row = raw as Record<string, unknown>;
      const workspaces: Record<string, string> = {};
      if (row.workspaces && typeof row.workspaces === 'object' && !Array.isArray(row.workspaces)) {
        for (const [k, v] of Object.entries(row.workspaces as Record<string, unknown>)) {
          if (typeof v === 'string') workspaces[k] = v;
        }
      }
      return {
        enabled: row.enabled === true,
        urlOverride:
          typeof row.urlOverride === 'string' && /^wss?:\/\/.+/.test(row.urlOverride)
            ? row.urlOverride
            : null,
        workspaces,
      };
    } catch (err) {
      log.warn(`read slack-hook config failed: ${err instanceof Error ? err.message : String(err)}`);
      return { enabled: false, urlOverride: null, workspaces: {} };
    }
  }

  return {
    get: () => read(),
    effectiveUrl() {
      return read().urlOverride ?? deps.defaultUrl();
    },
    setEnabled(enabled) {
      const next = { ...read(), enabled };
      write(next);
      return next;
    },
    setWorkspaces(workspaces) {
      const next = { ...read(), workspaces: validateWorkspaces(workspaces) };
      write(next);
      return next;
    },
  };
}
