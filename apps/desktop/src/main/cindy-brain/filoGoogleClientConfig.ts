import type { GhostManifest } from '../../shared/ghost.js';
import type { GhostOauthVault } from './ghostOauthAccounts.js';
import { FILO_GOOGLE_GHOST_ID, FILO_GOOGLE_SECRET_KEY } from './googleAccountsMigration.js';

/**
 * Filo Google 的 OAuth client 不再写进 Git。开发机从 .env 注入，正式包由
 * 发布环境注入；这里只在 main 内存里的出网声明上补值，不改磁盘 manifest，
 * 也不把 client 凭证广播给 renderer。
 */
export interface FiloGoogleBuildClientConfig {
  clientId?: string;
  clientSecret?: string;
}

/** 给 main 内部使用的 Filo Google manifest 补上构建环境里的 OAuth client。 */
export function withFiloGoogleBuildClientConfig(
  manifest: GhostManifest,
  config: FiloGoogleBuildClientConfig,
): GhostManifest {
  const clientId = config.clientId?.trim();
  if (manifest.id !== FILO_GOOGLE_GHOST_ID || !clientId || !manifest.network) return manifest;

  let changed = false;
  const clientSecret = config.clientSecret?.trim();
  const secrets = manifest.network.secrets?.map((secret) => {
    if (
      secret.key !== FILO_GOOGLE_SECRET_KEY ||
      secret.source !== 'oauth' ||
      !secret.oauth
    ) {
      return secret;
    }
    changed = true;
    const oauth = { ...secret.oauth, clientId };
    delete oauth.clientSecret;
    if (clientSecret) oauth.clientSecret = clientSecret;
    return {
      ...secret,
      oauth,
    };
  });
  if (!changed || !secrets) return manifest;
  return { ...manifest, network: { ...manifest.network, secrets } };
}

/**
 * 升级兼容：旧包曾把 Google desktop client 写在已安装意识的 ghost.json 里。
 * 新包播种前先把那一对值搬进 safeStorage，保证旧 refresh token 仍能刷新。
 * 新用户不会走到这条迁移，直接使用发布环境注入的 client。
 */
export function migrateLegacyBundledFiloGoogleClientConfig(
  rawManifest: unknown,
  vault: GhostOauthVault,
): boolean {
  if (!isRecord(rawManifest) || rawManifest.id !== FILO_GOOGLE_GHOST_ID) return false;
  const network = rawManifest.network;
  if (!isRecord(network) || !Array.isArray(network.secrets)) return false;

  const clientIdKey = `${FILO_GOOGLE_SECRET_KEY}-client-id`;
  const clientSecretKey = `${FILO_GOOGLE_SECRET_KEY}-client-secret`;
  // 用户已经自填过 client 时绝不覆盖。
  if (vault.read(FILO_GOOGLE_GHOST_ID, clientIdKey)) return false;

  for (const secret of network.secrets) {
    if (!isRecord(secret) || secret.key !== FILO_GOOGLE_SECRET_KEY || secret.source !== 'oauth') continue;
    const oauth = secret.oauth;
    if (!isRecord(oauth) || typeof oauth.clientId !== 'string' || oauth.clientId.trim().length === 0) {
      return false;
    }
    const clientId = oauth.clientId.trim();
    const clientSecret = typeof oauth.clientSecret === 'string' ? oauth.clientSecret.trim() : '';
    if (!vault.store(FILO_GOOGLE_GHOST_ID, clientIdKey, clientId)) return false;
    if (clientSecret && !vault.store(FILO_GOOGLE_GHOST_ID, clientSecretKey, clientSecret)) {
      vault.remove(FILO_GOOGLE_GHOST_ID, clientIdKey);
      vault.remove(FILO_GOOGLE_GHOST_ID, clientSecretKey);
      return false;
    }
    return true;
  }
  return false;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
