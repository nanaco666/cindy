/**
 * slackAccountsMigration.ts — 老 Slack 官方 MCP 集成账号 → Cindy Slack 意识(一次性搬账)。
 * ---------------------------------------------------------------------------
 * slack-official MCP 集成退役(2026-07-15)前置:老「第三方平台」里授权过的
 * Slack 账号(单账号形态:safe-storage 下 slack_official_mcp_refresh_token.enc +
 * slack_official_mcp_connection.json),refresh token 是同一个 Slack 应用
 * (oauth-broker 持 secret)换的,意识的 tokenBroker 模式走同一 broker 端点
 * 刷新,令牌直接通用——用户无感,不用重新授权。
 *
 * 账号标签用老连接信息里的 userId(U 开头的 Slack 用户 id):它与意识 oauth
 * 声明的 identity(auth.test 的 user_id)同源,未来重连时同身份合并判定才能
 * 命中,不会把同一账号堆成多行。
 *
 * 幂等与安全(与 atlassianAccountsMigration 同纪律):
 * - 意识侧已有账号清单(用户已连接过 / 已迁移过)→ 整体跳过,绝不合并覆盖;
 * - 老存储原样保留(不删不改)——退役删的是代码,用户数据留作回滚余地;
 * - refresh token 只在两个 safeStorage 存储之间搬运,不进日志、不进返回值。
 *
 * 依赖注入(规则 14):老存储读取 / 意识保险库全经 deps,单测内存假体零 Electron。
 */

import { randomUUID } from 'node:crypto';

import type { GhostOauthVault } from './ghostOauthAccounts.js';

/** cindy-slack 意识与其 oauth 凭证槽(与 ghost.json 声明一致,搬账目的地)。 */
export const CINDY_SLACK_GHOST_ID = 'cindy-slack';
export const CINDY_SLACK_SECRET_KEY = 'slack_account';

/**
 * 老集成的 safe-storage 文件名(镜像自已退役的 mcp-integrations/slack-official.ts
 * 的 SAFE_STORAGE_RT_KEY / CONNECTION_FILE;摘壳后常量归此,迁移零 import 老代码)。
 */
export const LEGACY_SLACK_RT_FILE = 'slack_official_mcp_refresh_token.enc';
export const LEGACY_SLACK_CONNECTION_FILE = 'slack_official_mcp_connection.json';

export interface SlackAccountsMigrationDeps {
  /** 读老 refresh token 明文(safeStorage 解密;不存在 / 解密失败回 null)。 */
  readLegacyRefreshToken(): string | null;
  /** 读老连接信息(只消费 userId,坏形态回 null)。 */
  readLegacyConnection(): { userId?: string | null } | null;
  /** 意识 OAuth 保险库(与 GhostOauthAccountManager 同一本账)。 */
  vault: GhostOauthVault;
  log?: { info(msg: string, meta?: Record<string, unknown>): void; warn(msg: string, meta?: Record<string, unknown>): void };
}

/**
 * 执行一次搬账。返回迁移的账号数(老集成是单账号形态,只会是 0 或 1)。
 * 在内置意识对账完成后、确认 cindy-slack 已装入时调用(见 index.ts 启动序列)。
 */
export function migrateSlackAccounts(deps: SlackAccountsMigrationDeps): number {
  const { readLegacyRefreshToken, readLegacyConnection, vault, log } = deps;

  const accountsKey = `${CINDY_SLACK_SECRET_KEY}-accounts`;
  // 意识侧已有账号(用户手动连过 / 上次已迁)→ 不碰,防重复合并。
  if (vault.read(CINDY_SLACK_GHOST_ID, accountsKey) !== null) return 0;

  const refreshToken = readLegacyRefreshToken();
  if (!refreshToken) return 0;

  const connection = readLegacyConnection();
  const userId =
    typeof connection?.userId === 'string' && connection.userId.length > 0 ? connection.userId : null;

  const accountId = randomUUID();
  // rt 先落库再挂清单(与 GhostOauthAccountManager.connectAccount 同顺序,防半身位)。
  if (!vault.store(CINDY_SLACK_GHOST_ID, `${CINDY_SLACK_SECRET_KEY}-rt-${accountId}`, refreshToken)) {
    log?.warn('cindy-slack 搬账:refresh token 写入失败,放弃本轮(下次启动重试)');
    return 0;
  }
  const manifest = {
    defaultAccountId: accountId,
    accounts: [{ id: accountId, label: userId, status: 'connected' as const, createdAt: Date.now() }],
  };
  if (!vault.store(CINDY_SLACK_GHOST_ID, accountsKey, JSON.stringify(manifest))) {
    // 清单写失败:回收已搬的 rt,保持"没迁过"的干净状态,下次启动重试。
    vault.remove(CINDY_SLACK_GHOST_ID, `${CINDY_SLACK_SECRET_KEY}-rt-${accountId}`);
    log?.warn('cindy-slack 搬账:账号清单写入失败,整体回退');
    return 0;
  }
  log?.info('cindy-slack 搬账完成:老 Slack 官方 MCP 集成账号已迁入意识', { hasUserId: userId !== null });
  return 1;
}
