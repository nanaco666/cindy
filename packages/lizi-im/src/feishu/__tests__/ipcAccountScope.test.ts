import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import type { IMHost } from '../../types.js';

const mocks = vi.hoisted(() => ({
  stop: vi.fn(async () => undefined),
  start: vi.fn(async () => 'connected' as const),
  writeCredentials: vi.fn(() => true),
  writeOwnerOpenId: vi.fn(),
  loadOwner: vi.fn(),
  requestRegistration: vi.fn(),
  pollRegistration: vi.fn(),
}));

vi.mock('../wsClient.js', () => ({
  QUIT_OFFLINE_ANNOUNCE_TIMEOUT_MS: 4500,
  getCurrentStatus: () => 'idle',
  setLifecycleAnnouncement: vi.fn(),
  stop: mocks.stop,
  start: mocks.start,
}));

vi.mock('../storage.js', () => ({
  readCredentials: vi.fn(() => null),
  readOwnerOpenId: vi.fn(() => null),
  readLifecycleAnnouncement: vi.fn(() => true),
  writeLifecycleAnnouncement: vi.fn(),
  writeCredentials: mocks.writeCredentials,
  writeOwnerOpenId: mocks.writeOwnerOpenId,
  clearAll: vi.fn(),
}));

vi.mock('../ownerGuard.js', () => ({
  loadFromDisk: mocks.loadOwner,
  firstAllowed: vi.fn(() => null),
  clear: vi.fn(),
}));

vi.mock('../appRegistration.js', () => ({
  requestAppRegistration: mocks.requestRegistration,
  pollAppRegistration: mocks.pollRegistration,
}));

import { FeishuIM } from '../index.js';
import { cancelAppRegistration } from '../ipc.js';

type IpcHandler = (payload?: unknown) => Promise<unknown> | unknown;

function deferred<T>(): { promise: Promise<T>; resolve: (value: T) => void } {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

const handlers = new Map<string, IpcHandler>();
const broadcasts = vi.fn();
const accountRun = vi.fn();
let active = true;
let accountToken = 1;
let operationGate: Promise<void> | null = null;

const host = {
  paths: { feishuMediaDir: '/tmp/lizi-im-feishu-test' },
  secrets: {
    isAvailable: () => false,
    write: () => false,
    read: () => null,
    remove: () => {},
  },
  ipc: {
    handle: (channel: string, handler: IpcHandler) => {
      handlers.set(channel, handler);
    },
    broadcast: broadcasts,
  },
  accountScope: {
    capture: () => (active ? accountToken : null),
    isCurrent: (token: unknown) => active && token === accountToken,
    async run<T>(token: unknown, operation: () => Promise<T>): Promise<T> {
      accountRun(token);
      if (operationGate) await operationGate;
      if (!active || token !== accountToken) {
        throw new Error('[IM_NOT_READY] stale account generation');
      }
      return operation();
    },
  },
  httpPostForm: async () => ({ status: 200, body: {} }),
  createLogger: () => ({
    trace: vi.fn(),
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    fatal: vi.fn(),
  }),
} as unknown as IMHost;

const im = new FeishuIM(host);

beforeAll(() => {
  im.registerIpc();
});

beforeEach(() => {
  cancelAppRegistration();
  active = true;
  accountToken += 1;
  operationGate = null;
  vi.clearAllMocks();
});

afterEach(() => {
  vi.useRealTimers();
});

describe('Feishu IPC account scope', () => {
  it('does not reconnect when credential save loses its account generation', async () => {
    const gate = deferred<void>();
    operationGate = gate.promise;
    const save = handlers.get('feishuBot:save');
    expect(save).toBeDefined();

    const saving = Promise.resolve(save?.({ appId: 'cli_test', appSecret: 'secret' }));
    await vi.waitFor(() => expect(accountRun).toHaveBeenCalledWith(accountToken));

    active = false;
    accountToken += 1;
    gate.resolve();

    await expect(saving).rejects.toThrow('[IM_NOT_READY]');
    expect(mocks.writeCredentials).not.toHaveBeenCalled();
    expect(mocks.stop).not.toHaveBeenCalled();
    expect(mocks.start).not.toHaveBeenCalled();
  });

  it('drops an in-flight registration result after account disposal', async () => {
    vi.useFakeTimers();
    const poll = deferred<{
      status: 'success';
      result: {
        clientId: string;
        clientSecret: string;
        tenantBrand: 'feishu';
        ownerOpenId: string;
      };
    }>();
    mocks.requestRegistration.mockResolvedValue({
      deviceCode: 'device-code',
      userCode: 'user-code',
      verificationUri: 'https://example.test',
      interval: 1,
      expiresIn: 600,
    });
    mocks.pollRegistration.mockReturnValue(poll.promise);

    const begin = handlers.get('feishuBot:registration-begin');
    await expect(Promise.resolve(begin?.())).resolves.toMatchObject({
      ok: true,
    });
    await vi.advanceTimersByTimeAsync(1000);
    expect(mocks.pollRegistration).toHaveBeenCalledOnce();

    await im.dispose();
    poll.resolve({
      status: 'success',
      result: {
        clientId: 'cli_registered',
        clientSecret: 'registered-secret',
        tenantBrand: 'feishu',
        ownerOpenId: 'ou_owner',
      },
    });
    await vi.runAllTimersAsync();

    expect(mocks.writeOwnerOpenId).not.toHaveBeenCalled();
    expect(mocks.writeCredentials).not.toHaveBeenCalled();
    expect(mocks.start).not.toHaveBeenCalled();
  });
});
