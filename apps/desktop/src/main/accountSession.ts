/**
 * Desktop account-session coordination.
 *
 * Account tokens only authorize Passport-level identity selection. They stay
 * independent from the resource session used by the rest of the application.
 * This module owns the account refresh in-flight/generation rules so logout,
 * re-login, and shared-userData processes cannot overwrite a newer session.
 */
import { AuthApiError, type AccountTokenPair } from '@cindy/auth-client';

import { runRefreshWithReplacementRetry, type RefreshFetchResult } from './authRefreshFailure';
import { awaitWithStartupTimeout } from './authStartupGate';

interface AccountRefreshErrorBody {
  error?: {
    code?: string;
    message?: string;
  };
}

type AccountRefreshResult = RefreshFetchResult<AccountTokenPair | AccountRefreshErrorBody>;

export interface DesktopAccountSessionDependencies {
  readRefreshToken: () => string | null;
  writeRefreshToken: (refreshToken: string) => void;
  removeRefreshToken: () => void;
  refreshAccount: (refreshToken: string) => Promise<AccountTokenPair>;
  isAccessTokenExpiring: (accessToken: string) => boolean;
  /** Short read-after-401 delays covering another process's pending disk write. */
  replacementRecheckDelaysMs?: readonly number[];
  /** Test-only replacement for setTimeout-based recheck waits. */
  replacementRecheckSleep?: (delayMs: number) => Promise<void>;
}

function accountRefreshFailure(error: unknown): AccountRefreshResult {
  if (error instanceof AuthApiError) {
    return {
      ok: false,
      status: error.statusCode,
      data: { error: { code: error.code, message: error.message } },
    };
  }
  return {
    ok: false,
    status: 0,
    data: { error: { code: 'ACCOUNT_REFRESH_FAILED' } },
  };
}

function accountRefreshErrorCode(result: AccountRefreshResult): string | undefined {
  if (result.ok) return undefined;
  return (result.data as AccountRefreshErrorBody).error?.code;
}

/**
 * Keeps the desktop account session independent from the resource session.
 * Clearing or superseding this object never touches a resource access/refresh
 * token, so an already authenticated user keeps using their current resource.
 */
export class DesktopAccountSession {
  private accessToken: string | null = null;
  private generation = 0;
  private refreshInFlight: Promise<boolean> | null = null;

  constructor(private readonly dependencies: DesktopAccountSessionDependencies) {}

  install(pair: AccountTokenPair): void {
    this.generation += 1;
    // Detach a refresh from the previous generation. Its result is discarded.
    this.refreshInFlight = null;
    this.accessToken = pair.accountToken;
    this.dependencies.writeRefreshToken(pair.accountRefreshToken);
  }

  clear(): void {
    this.generation += 1;
    this.accessToken = null;
    // A new login/refresh must not wait for a superseded, potentially hung call.
    this.refreshInFlight = null;
    this.dependencies.removeRefreshToken();
  }

  invalidateAccessToken(): void {
    this.accessToken = null;
  }

  peekAccessToken(): string | null {
    return this.accessToken;
  }

  hasRecoverableSession(): boolean {
    if (this.accessToken && !this.dependencies.isAccessTokenExpiring(this.accessToken)) return true;
    return this.refreshInFlight !== null || this.dependencies.readRefreshToken() !== null;
  }

  refresh(): Promise<boolean> {
    if (this.refreshInFlight) return this.refreshInFlight;

    const storedToken = this.dependencies.readRefreshToken();
    if (!storedToken) return Promise.resolve(false);

    const generation = this.generation;
    const run = this.performRefresh(storedToken, generation).catch(() => false);
    this.refreshInFlight = run;
    const releaseIfCurrent = () => {
      // A previous generation may finish after clear/install and after a new
      // refresh has started. It must not clear that newer in-flight reference.
      if (this.refreshInFlight === run) this.refreshInFlight = null;
    };
    run.then(releaseIfCurrent, releaseIfCurrent);
    return run;
  }

  async getAccessToken(): Promise<string | null> {
    if (this.accessToken && !this.dependencies.isAccessTokenExpiring(this.accessToken)) {
      return this.accessToken;
    }
    this.accessToken = null;
    await this.refresh();
    // A concurrent login may supersede the refresh while it is in flight. In
    // that case return the newly installed token instead of the old run's false.
    if (this.accessToken && !this.dependencies.isAccessTokenExpiring(this.accessToken)) {
      return this.accessToken;
    }
    return null;
  }

  private async performRefresh(storedToken: string, generation: number): Promise<boolean> {
    const refreshRun = await runRefreshWithReplacementRetry(storedToken, {
      doRefresh: async (refreshToken): Promise<AccountRefreshResult> => {
        // Logout/re-login may supersede this run while its previous network
        // attempt is settling. Never rotate a token installed by that newer
        // generation as a replacement retry.
        if (this.generation !== generation) {
          return {
            ok: false,
            status: 0,
            data: { error: { code: 'ACCOUNT_REFRESH_SUPERSEDED' } },
          };
        }
        try {
          return {
            ok: true,
            status: 200,
            data: await this.dependencies.refreshAccount(refreshToken),
          };
        } catch (error) {
          return accountRefreshFailure(error);
        }
      },
      readLatestStoredToken: () =>
        this.generation === generation ? this.dependencies.readRefreshToken() : null,
      replacementRecheck: {
        delaysMs: this.dependencies.replacementRecheckDelaysMs,
        sleep: this.dependencies.replacementRecheckSleep,
      },
    });

    if (this.generation !== generation) return false;

    if (refreshRun.result.ok) {
      const pair = refreshRun.result.data as AccountTokenPair;
      this.accessToken = pair.accountToken;
      this.dependencies.writeRefreshToken(pair.accountRefreshToken);
      return true;
    }

    if (refreshRun.failureAction?.kind === 'definitive-failure') {
      const code = accountRefreshErrorCode(refreshRun.result);
      if (code === 'INVALID_REFRESH_TOKEN') {
        // Close the final read/delete race: another process may write its
        // replacement after the generic retry helper's last disk read.
        const latestStoredToken = this.dependencies.readRefreshToken();
        if (latestStoredToken && latestStoredToken !== refreshRun.requestedToken) return false;
      }
      this.clear();
    }
    // Transient failures and replacement-retry exhaustion preserve the token.
    return false;
  }
}

export interface RestoreAccountMembershipsDependencies<T> {
  getAccessToken: () => Promise<string | null>;
  invalidateAccessToken: () => void;
  listMemberships: (accessToken: string) => Promise<T[]>;
  isUnauthorized: (error: unknown) => boolean;
}

/**
 * Loads account memberships, refreshing once after a rejected cached access
 * token. Both attempts use the same fallback policy: any remaining failure
 * returns null so the caller can show the normal login entry.
 */
export async function restoreAccountMemberships<T>(
  dependencies: RestoreAccountMembershipsDependencies<T>,
): Promise<T[] | null> {
  for (let attempt = 0; attempt < 2; attempt += 1) {
    let accessToken: string | null;
    try {
      accessToken = await dependencies.getAccessToken();
    } catch {
      return null;
    }
    if (!accessToken) return null;

    try {
      return await dependencies.listMemberships(accessToken);
    } catch (error) {
      if (dependencies.isUnauthorized(error)) {
        dependencies.invalidateAccessToken();
        if (attempt === 0) continue;
      }
      return null;
    }
  }
  return null;
}

/**
 * Account refresh rotates credentials and therefore must not be aborted. Bound
 * only the login page's wait; the underlying operation is left to settle and
 * cannot mutate renderer flow state because this helper only returns data.
 */
export function restoreAccountMembershipsWithinTimeout<T>(
  dependencies: RestoreAccountMembershipsDependencies<T>,
  timeoutMs: number,
): Promise<T[] | null> {
  return awaitWithStartupTimeout(restoreAccountMemberships(dependencies), {
    timeoutMs,
    onTimeout: () => null,
  });
}
