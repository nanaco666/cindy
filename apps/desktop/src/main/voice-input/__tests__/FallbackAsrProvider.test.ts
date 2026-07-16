import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { AsrEvent, AsrProvider } from '@lizi/voice-input-core';

import { FallbackAsrProvider, type FallbackAsrCandidate } from '../FallbackAsrProvider.js';
import {
  isVoiceInputProviderCoolingDown,
  resetVoiceInputProviderHealthForTests,
} from '../VoiceInputProviderHealth.js';
import type { VoiceInputProviderKind } from '../voiceInputAsrConfig.js';

type MockAsrProvider = AsrProvider & {
  emit: (event: AsrEvent) => void;
  appended: ArrayBuffer[];
};

function makeMockProvider(options?: {
  startError?: Error;
  recover?: () => Promise<void>;
}): MockAsrProvider {
  const callbacks: Array<(event: AsrEvent) => void> = [];
  const appended: ArrayBuffer[] = [];
  const provider: MockAsrProvider = {
    appended,
    start: vi.fn(async () => {
      if (options?.startError) throw options.startError;
    }),
    stop: vi.fn(async () => {}),
    appendAudio: vi.fn((chunk: ArrayBuffer) => {
      appended.push(chunk);
    }),
    flushAudio: vi.fn(async () => {}),
    onEvent: (callback) => {
      callbacks.push(callback);
    },
    dispose: vi.fn(async () => {}),
    emit: (event) => {
      for (const callback of callbacks) callback(event);
    },
  };
  if (options?.recover) provider.recover = options.recover;
  return provider;
}

function candidate(kind: string, provider: MockAsrProvider | (() => Promise<AsrProvider>)): FallbackAsrCandidate {
  return {
    kind: kind as VoiceInputProviderKind,
    create: typeof provider === 'function' ? provider : async () => provider,
  };
}

const chunk = (byte: number): ArrayBuffer => new Uint8Array([byte]).buffer;

describe('FallbackAsrProvider', () => {
  beforeEach(() => {
    resetVoiceInputProviderHealthForTests();
  });

  it('uses the first candidate when it starts successfully and forwards its events', async () => {
    const first = makeMockProvider();
    const second = makeMockProvider();
    const fallback = new FallbackAsrProvider([
      candidate('litellm-volcengine-sauc-asr', first),
      candidate('litellm-qwen3-asr-flash-realtime', second),
    ]);
    const events: AsrEvent[] = [];
    fallback.onEvent((event) => events.push(event));

    await fallback.start();

    expect(fallback.activeProviderKind).toBe('litellm-volcengine-sauc-asr');
    expect(second.start).not.toHaveBeenCalled();
    first.emit({ type: 'partial', text: 'hello', at: 1 });
    expect(events).toEqual([{ type: 'partial', text: 'hello', at: 1 }]);
    fallback.appendAudio(chunk(1));
    expect(first.appended).toHaveLength(1);
  });

  it('falls back to the next candidate when start() fails and suppresses events from the failed attempt', async () => {
    const first = makeMockProvider({ startError: new Error('dial failed') });
    const second = makeMockProvider();
    const fallback = new FallbackAsrProvider([
      candidate('litellm-volcengine-sauc-asr', first),
      candidate('litellm-qwen3-asr-flash-realtime', second),
    ]);
    const events: AsrEvent[] = [];
    fallback.onEvent((event) => events.push(event));

    await fallback.start();

    expect(fallback.activeProviderKind).toBe('litellm-qwen3-asr-flash-realtime');
    expect(first.dispose).toHaveBeenCalled();
    // Events leaking from the abandoned attempt must not reach the controller.
    first.emit({ type: 'error', message: 'late failure', at: 2 });
    expect(events).toEqual([]);
    second.emit({ type: 'connected', at: 3 });
    expect(events).toEqual([{ type: 'connected', at: 3 }]);
    // Sticky failover: the failed provider entered cooldown.
    expect(isVoiceInputProviderCoolingDown('asr', 'litellm-volcengine-sauc-asr')).toBe(true);
    expect(isVoiceInputProviderCoolingDown('asr', 'litellm-qwen3-asr-flash-realtime')).toBe(false);
  });

  it('falls back when candidate creation itself throws', async () => {
    const second = makeMockProvider();
    const fallback = new FallbackAsrProvider([
      candidate('litellm-volcengine-sauc-asr', async () => {
        throw new Error('missing credential');
      }),
      candidate('litellm-qwen3-asr-flash-realtime', second),
    ]);

    await fallback.start();

    expect(fallback.activeProviderKind).toBe('litellm-qwen3-asr-flash-realtime');
  });

  it('rejects with the last error when every candidate fails', async () => {
    const fallback = new FallbackAsrProvider([
      candidate('litellm-volcengine-sauc-asr', makeMockProvider({ startError: new Error('first down') })),
      candidate('litellm-qwen3-asr-flash-realtime', makeMockProvider({ startError: new Error('second down') })),
    ]);

    await expect(fallback.start()).rejects.toThrow('second down');
    expect(fallback.activeProviderKind).toBeNull();
  });

  it('replays audio buffered before connect once a provider becomes active', async () => {
    const provider = makeMockProvider();
    const fallback = new FallbackAsrProvider([candidate('litellm-volcengine-sauc-asr', provider)]);

    fallback.appendAudio(chunk(1));
    fallback.appendAudio(chunk(2));
    await fallback.start();

    expect(provider.appended).toHaveLength(2);
    fallback.appendAudio(chunk(3));
    expect(provider.appended).toHaveLength(3);
  });

  it('dispose() during candidate creation prevents the provider from ever dialing', async () => {
    let releaseCreate!: () => void;
    const gate = new Promise<void>((resolve) => {
      releaseCreate = resolve;
    });
    const provider = makeMockProvider();
    const fallback = new FallbackAsrProvider([
      {
        kind: 'litellm-volcengine-sauc-asr' as VoiceInputProviderKind,
        create: async () => {
          await gate;
          return provider;
        },
      },
    ]);

    const startPromise = fallback.start();
    await fallback.dispose();
    releaseCreate();

    await expect(startPromise).rejects.toThrow('disposed during start');
    // The provider was created after disposal: it must be disposed without
    // start() ever being invoked.
    expect(provider.start).not.toHaveBeenCalled();
    expect(provider.dispose).toHaveBeenCalled();
    expect(fallback.activeProviderKind).toBeNull();
  });

  it('dispose() during start() prevents committing a late-connecting candidate', async () => {
    let releaseStart!: () => void;
    const gate = new Promise<void>((resolve) => {
      releaseStart = resolve;
    });
    const provider = makeMockProvider();
    (provider.start as ReturnType<typeof vi.fn>).mockImplementation(async () => gate);
    const fallback = new FallbackAsrProvider([candidate('litellm-volcengine-sauc-asr', provider)]);

    const startPromise = fallback.start();
    // Let the loop pass the create/pre-start guards and suspend inside
    // provider.start() before disposing — this exercises the post-connect
    // guard, not the cheaper pre-dial ones.
    while ((provider.start as ReturnType<typeof vi.fn>).mock.calls.length === 0) {
      await Promise.resolve();
    }
    await fallback.dispose();
    releaseStart();

    await expect(startPromise).rejects.toThrow('disposed during start');
    // The late connection must be shut down, not leaked as a live session.
    expect(provider.stop).toHaveBeenCalled();
    expect(provider.dispose).toHaveBeenCalled();
    expect(fallback.activeProviderKind).toBeNull();
  });

  it('only exposes recover() when the active provider supports it, and marks cooldown on recover failure', async () => {
    const noRecover = makeMockProvider();
    const fallbackWithoutRecover = new FallbackAsrProvider([
      candidate('litellm-volcengine-sauc-asr', noRecover),
    ]);
    await fallbackWithoutRecover.start();
    expect(fallbackWithoutRecover.recover).toBeUndefined();

    resetVoiceInputProviderHealthForTests();
    const failingRecover = makeMockProvider({
      recover: async () => {
        throw new Error('recover exhausted');
      },
    });
    const fallbackWithRecover = new FallbackAsrProvider([
      candidate('litellm-qwen3-asr-flash-realtime', failingRecover),
    ]);
    await fallbackWithRecover.start();
    expect(typeof fallbackWithRecover.recover).toBe('function');
    await expect(fallbackWithRecover.recover!()).rejects.toThrow('recover exhausted');
    expect(isVoiceInputProviderCoolingDown('asr', 'litellm-qwen3-asr-flash-realtime')).toBe(true);
  });
});
