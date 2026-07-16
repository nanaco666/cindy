import { describe, expect, it } from 'vitest';
import { createFeishuTokenManager } from '../feishu/token.js';

function deferred<T>(): { promise: Promise<T>; resolve(value: T): void } {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

async function waitUntil(condition: () => boolean): Promise<void> {
  for (let i = 0; i < 200; i += 1) {
    if (condition()) return;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error('condition was not met');
}

describe('FeishuTokenManager', () => {
  it('drops initially stored tokens when clear wins during refresh-token write', async () => {
    const writeGate = deferred<void>();
    let refreshToken: string | null = null;
    let writeStarted = false;
    const states: string[] = [];

    const manager = createFeishuTokenManager({
      tokenStore: {
        readRefreshToken: () => refreshToken,
        writeRefreshToken: async (value) => {
          writeStarted = true;
          await writeGate.promise;
          refreshToken = value;
          return true;
        },
        removeRefreshToken: () => {
          refreshToken = null;
        },
      },
      fetchImplementation: async () => new Response(null, { status: 500 }),
      serverApiBaseUrl: 'https://api.example.test',
      onAuthStateChange: (state) => {
        states.push(state.status);
      },
    });

    const storeResult = manager.storeFeishuToken({
      accessToken: 'access-A',
      refreshToken: 'rt-A',
      expiresIn: 3600,
    });
    await waitUntil(() => writeStarted);

    await manager.clearFeishuTokens();
    writeGate.resolve();

    await expect(storeResult).resolves.toEqual({ success: false });
    expect(refreshToken).toBeNull();
    expect(manager.getAccessToken()).toBeNull();
    expect(manager.hasRefreshToken()).toBe(false);
    expect(states).toEqual(['not_connected']);
  });

  it('drops initially stored tokens when init wins during refresh-token write', async () => {
    const writeGate = deferred<void>();
    let refreshToken: string | null = null;
    let writeStarted = false;

    const manager = createFeishuTokenManager({
      tokenStore: {
        readRefreshToken: () => refreshToken,
        writeRefreshToken: async (value) => {
          writeStarted = true;
          await writeGate.promise;
          refreshToken = value;
          return true;
        },
        removeRefreshToken: () => {
          refreshToken = null;
        },
      },
      fetchImplementation: async () => new Response(null, { status: 500 }),
      serverApiBaseUrl: 'https://api.example.test',
    });

    const storeResult = manager.storeFeishuToken({
      accessToken: 'access-A',
      refreshToken: 'rt-A',
      expiresIn: 3600,
    });
    await waitUntil(() => writeStarted);

    await manager.init();
    writeGate.resolve();

    await expect(storeResult).resolves.toEqual({ success: false });
    expect(refreshToken).toBeNull();
    expect(manager.getAccessToken()).toBeNull();
    expect(manager.hasRefreshToken()).toBe(false);
  });

  it('drops refreshed tokens when auth reload happens during refresh-token write', async () => {
    const writeGate = deferred<void>();
    let refreshToken: string | null = 'rt-old';
    let writeStarted = false;

    const manager = createFeishuTokenManager({
      tokenStore: {
        readRefreshToken: () => refreshToken,
        writeRefreshToken: async (value) => {
          writeStarted = true;
          await writeGate.promise;
          refreshToken = value;
          return true;
        },
        removeRefreshToken: () => {
          refreshToken = null;
        },
      },
      fetchImplementation: async () => new Response(JSON.stringify({
        feishuAccessToken: 'access-A',
        feishuRefreshToken: 'rt-new-A',
        feishuExpiresIn: 3600,
      }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      }),
      serverApiBaseUrl: 'https://api.example.test',
    });

    await manager.init();
    manager.setJwt('jwt-A');
    const refreshResult = manager.ensureToken();
    await waitUntil(() => writeStarted);

    await manager.clearFeishuTokens();
    writeGate.resolve();

    await expect(refreshResult).resolves.toEqual({ error: 'AUTH_EXPIRED' });
    expect(refreshToken).toBeNull();
    expect(manager.getAccessToken()).toBeNull();
    expect(manager.hasRefreshToken()).toBe(false);
  });
});
