/**
 * feishu/token.ts — Feishu OAuth token state machine.
 *
 * Holds:
 *   - access_token        in-memory only (never serialized)
 *   - refresh_token       persisted via host-injected `tokenStore` (encrypted on disk)
 *   - host JWT            in-memory only (used to authenticate refresh-feishu call)
 *   - refresh timer       scheduled 10 min before expiry, deduped via shared promise
 *
 * Originally apps/desktop/src/main/feishuTokenManager.ts. The Electron-specific
 * pieces (safeStorage encryption, electron `net.fetch`, server URL) are now
 * passed in via `FeishuTokenManagerOptions` so the package is host-agnostic
 * and unit-testable.
 */

import type { LiziMcpLogger } from '../types.js';
import type {
  FeishuAuthState,
  FeishuTokenFacade,
  FeishuTokenManagerOptions,
} from './types.js';

interface RefreshSuccess {
  feishuAccessToken: string;
  feishuRefreshToken: string;
  feishuExpiresIn: number;
}

const REFRESH_LEAD_MS = 10 * 60 * 1000; // refresh 10 min before expiry

class FeishuTokenManager implements FeishuTokenFacade {
  private accessToken: string | null = null;
  private expiresAt = 0;
  private jwt: string | null = null;
  private refreshTimer: ReturnType<typeof setTimeout> | null = null;
  private refreshPromise: Promise<
    { token: string } | { error: 'AUTH_EXPIRED' }
  > | null = null;
  private hasRT = false;
  private authGeneration = 0;

  private readonly opts: FeishuTokenManagerOptions;
  private readonly log: LiziMcpLogger | undefined;

  constructor(opts: FeishuTokenManagerOptions) {
    this.opts = opts;
    this.log = opts.logger;
  }

  // ── Lifecycle ─────────────────────────────────────────────────────────────

  async init(): Promise<void> {
    const generation = ++this.authGeneration;
    this.accessToken = null;
    this.expiresAt = 0;
    this.jwt = null;
    this.refreshPromise = null;
    if (this.refreshTimer !== null) {
      clearTimeout(this.refreshTimer);
      this.refreshTimer = null;
    }
    const existing = await Promise.resolve(this.opts.tokenStore.readRefreshToken());
    if (generation !== this.authGeneration) return;
    this.hasRT = existing !== null;
    this.broadcastState();
  }

  dispose(): void {
    if (this.refreshTimer !== null) {
      clearTimeout(this.refreshTimer);
      this.refreshTimer = null;
    }
  }

  handleResume(): void {
    if (
      this.hasRT &&
      this.accessToken !== null &&
      this.expiresAt - Date.now() <= REFRESH_LEAD_MS
    ) {
      void this.doRefresh();
    }
  }

  // ── Public token access ───────────────────────────────────────────────────

  async ensureToken(): Promise<{ token: string } | { error: 'AUTH_EXPIRED' }> {
    if (
      this.accessToken !== null &&
      this.expiresAt - Date.now() > REFRESH_LEAD_MS
    ) {
      return { token: this.accessToken };
    }
    const result = await this.doRefresh();
    if ('token' in result) return { token: result.token };
    return { error: 'AUTH_EXPIRED' };
  }

  async forceRefresh(): Promise<
    { token: string } | { error: 'AUTH_EXPIRED' }
  > {
    this.accessToken = null;
    this.expiresAt = 0;
    return this.doRefresh();
  }

  // ── Mutations ─────────────────────────────────────────────────────────────

  setJwt(jwtString: string | null): void {
    this.jwt = jwtString;
    if (
      this.hasRT &&
      (this.accessToken === null || this.expiresAt <= Date.now())
    ) {
      void this.doRefresh();
    }
  }

  async storeFeishuToken(data: {
    accessToken: string;
    refreshToken: string;
    expiresIn: number;
  }): Promise<{ success: boolean }> {
    const generation = ++this.authGeneration;
    this.refreshPromise = null;
    this.accessToken = data.accessToken;
    this.expiresAt = Date.now() + data.expiresIn * 1000;
    const writeOk = await Promise.resolve(
      this.opts.tokenStore.writeRefreshToken(data.refreshToken),
    );
    if (generation !== this.authGeneration) {
      if (writeOk) await this.removeRefreshTokenIfStillCurrent(data.refreshToken);
      return { success: false };
    }
    if (!writeOk) {
      this.log?.error(
        `[feishuToken] storeFeishuToken INITIAL WRITE FAILED — RT not persisted, will be lost on restart`,
      );
    }
    this.hasRT = true;
    this.scheduleRefresh(data.expiresIn);
    this.broadcastState();
    return { success: true };
  }

  async clearFeishuTokens(): Promise<void> {
    this.authGeneration += 1;
    this.refreshPromise = null;
    this.accessToken = null;
    this.expiresAt = 0;
    this.jwt = null;
    this.hasRT = false;
    if (this.refreshTimer !== null) {
      clearTimeout(this.refreshTimer);
      this.refreshTimer = null;
    }
    await Promise.resolve(this.opts.tokenStore.removeRefreshToken());
    this.broadcastState();
  }

  hasRefreshToken(): boolean {
    return this.hasRT;
  }

  getAccessToken(): string | null {
    return this.accessToken;
  }

  // ── Internal: refresh scheduling ──────────────────────────────────────────

  private scheduleRefresh(expiresInSec: number): void {
    if (this.refreshTimer !== null) {
      clearTimeout(this.refreshTimer);
      this.refreshTimer = null;
    }
    const delayMs = (expiresInSec - 600) * 1000;
    if (delayMs <= 0) {
      this.log?.warn(
        `[feishuToken] scheduleRefresh delay<=0 (expiresInSec=${expiresInSec}), refreshing immediately`,
      );
      void this.doRefresh();
      return;
    }
    this.refreshTimer = setTimeout(() => {
      void this.doRefresh();
    }, delayMs);
    if (
      this.refreshTimer &&
      typeof (this.refreshTimer as NodeJS.Timeout).unref === 'function'
    ) {
      (this.refreshTimer as NodeJS.Timeout).unref();
    }
  }

  // ── Internal: actual refresh call ─────────────────────────────────────────

  private async doRefresh(): Promise<
    { token: string } | { error: 'AUTH_EXPIRED' }
  > {
    if (this.refreshPromise) {
      return this.refreshPromise;
    }

    const callId = Math.random().toString(36).slice(2, 8);
    const generation = this.authGeneration;

    const refreshPromise = (async () => {
      const feishuRefreshToken = await Promise.resolve(
        this.opts.tokenStore.readRefreshToken(),
      );
      if (generation !== this.authGeneration) {
        return { error: 'AUTH_EXPIRED' as const };
      }
      if (!feishuRefreshToken || !this.jwt) {
        this.log?.warn(
          `[feishuToken] doRefresh call=${callId} ABORT: ${!feishuRefreshToken ? 'no_refresh_token' : 'no_jwt'}`,
        );
        return { error: 'AUTH_EXPIRED' as const };
      }

      try {
        const ok = await this.callRefreshFeishu(
          callId,
          this.jwt,
          feishuRefreshToken,
          generation,
        );
        if (ok) return ok;
        return { error: 'AUTH_EXPIRED' as const };
      } catch (err) {
        const msg = err instanceof Error ? `${err.name}: ${err.message}` : 'unknown';
        this.log?.error(
          `[feishuToken] doRefresh call=${callId} NETWORK/THROW: ${msg}`,
        );
        return { error: 'AUTH_EXPIRED' as const };
      }
    })();
    this.refreshPromise = refreshPromise;

    try {
      return await refreshPromise;
    } finally {
      if (this.authGeneration === generation) {
        this.refreshPromise = null;
      }
    }
  }

  private async callRefreshFeishu(
    callId: string,
    jwt: string,
    refreshToken: string,
    generation: number,
  ): Promise<{ token: string } | null> {
    const response = await this.opts.fetchImplementation(
      `${this.opts.serverApiBaseUrl}/api/auth/refresh-feishu`,
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${jwt}`,
        },
        body: JSON.stringify({ feishuRefreshToken: refreshToken }),
      },
    );

    if (response.ok) {
      const data = (await response.json()) as RefreshSuccess;
      if (generation !== this.authGeneration) return null;
      return await this.applyRefreshSuccess(callId, refreshToken, data, generation);
    }

    let bodyText = '';
    try {
      bodyText = await response.text();
    } catch {
      // ignore
    }
    this.log?.error(
      `[feishuToken] doRefresh call=${callId} server REJECTED status=${response.status} body=${bodyText.slice(0, 500)}`,
    );

    if (response.status === 401 && this.opts.onJwtRefreshNeeded) {
      const jwtRefreshed = await Promise.resolve(this.opts.onJwtRefreshNeeded());
      // host's refresh callback is expected to push the new JWT back via setJwt()
      if (generation !== this.authGeneration) return null;
      if (jwtRefreshed && this.jwt) {
        const retryResponse = await this.opts.fetchImplementation(
          `${this.opts.serverApiBaseUrl}/api/auth/refresh-feishu`,
          {
            method: 'POST',
            headers: {
              'Content-Type': 'application/json',
              Authorization: `Bearer ${this.jwt}`,
            },
            body: JSON.stringify({ feishuRefreshToken: refreshToken }),
          },
        );
        if (retryResponse.ok) {
          const retryData = (await retryResponse.json()) as RefreshSuccess;
          if (generation !== this.authGeneration) return null;
          return await this.applyRefreshSuccess(callId, refreshToken, retryData, generation);
        }
        this.log?.warn(
          `[feishuToken] doRefresh call=${callId} retry-after-jwt FAILED status=${retryResponse.status}`,
        );
      }
      this.log?.warn(
        `[feishuToken] doRefresh call=${callId} JWT path exhausted → clearFeishuTokens`,
      );
      if (generation !== this.authGeneration) return null;
      await this.clearFeishuTokens();
      return null;
    }

    if (response.status === 401) {
      this.log?.warn(
        `[feishuToken] doRefresh call=${callId} 401 with no onJwtRefreshNeeded → clearFeishuTokens`,
      );
      if (generation !== this.authGeneration) return null;
      await this.clearFeishuTokens();
    } else {
      this.log?.warn(
        `[feishuToken] doRefresh call=${callId} non-401 error → returning AUTH_EXPIRED but NOT clearing stored token (suspect: Feishu rejected RT, but UI won't know to re-auth)`,
      );
    }
    return null;
  }

  private async applyRefreshSuccess(
    callId: string,
    oldRT: string,
    data: RefreshSuccess,
    generation: number,
  ): Promise<{ token: string } | null> {
    if (generation !== this.authGeneration) return null;
    const nextExpiresAt = Date.now() + data.feishuExpiresIn * 1000;
    const writeOk = await Promise.resolve(
      this.opts.tokenStore.writeRefreshToken(data.feishuRefreshToken),
    );
    if (generation !== this.authGeneration) {
      if (writeOk) await this.removeRefreshTokenIfStillCurrent(data.feishuRefreshToken);
      return null;
    }
    if (!writeOk) {
      this.log?.error(
        `[feishuToken] doRefresh call=${callId} ROTATION SAVED IN MEMORY ONLY — disk write FAILED. The new RT will be lost on restart, and old RT on disk is already invalid on Feishu side.`,
      );
    }
    this.accessToken = data.feishuAccessToken;
    this.expiresAt = nextExpiresAt;
    this.hasRT = true;
    this.scheduleRefresh(data.feishuExpiresIn);
    this.broadcastState();
    return { token: this.accessToken };
  }

  private async removeRefreshTokenIfStillCurrent(refreshToken: string): Promise<void> {
    try {
      const current = await Promise.resolve(this.opts.tokenStore.readRefreshToken());
      if (current === refreshToken) {
        await Promise.resolve(this.opts.tokenStore.removeRefreshToken());
      }
    } catch (err) {
      this.log?.error(
        `[feishuToken] stale refresh token cleanup failed: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }

  private broadcastState(): void {
    if (!this.opts.onAuthStateChange) return;
    const state: FeishuAuthState = {
      status: this.accessToken !== null
        ? 'connected'
        : this.hasRT
          ? 'expired'
          : 'not_connected',
      hasRefreshToken: this.hasRT,
    };
    try {
      this.opts.onAuthStateChange(state);
    } catch (err) {
      this.log?.error(
        `[feishuToken] onAuthStateChange threw: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }
}

export function createFeishuTokenManager(
  opts: FeishuTokenManagerOptions,
): FeishuTokenFacade {
  return new FeishuTokenManager(opts);
}

// re-export so callers don't need to import from types.ts when they only need the helper
export type { FeishuTokenManagerOptions };
