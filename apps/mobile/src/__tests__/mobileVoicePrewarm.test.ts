import { afterEach, describe, expect, it, vi } from 'vitest';
import type { AsrEvent, AsrProvider, AudioTrace } from '@lizi/voice-input-core';

const prewarmMobileRealtimeAudio = vi.fn();
const resolveCredential = vi.fn();
const createProvider = vi.fn();

vi.mock('@/session/mobileRealtimeAudio', () => ({
  prewarmMobileRealtimeAudio: (...args: unknown[]) => prewarmMobileRealtimeAudio(...args),
}));
vi.mock('@/session/mobileVoiceLiteLlmSettings', () => ({
  resolveMobileVoiceCredentialFromLiteLlmSettings: (...args: unknown[]) => resolveCredential(...args),
}));
vi.mock('@/session/mobileRealtimeAsrProvider', () => ({
  createMobileAsrProvider: (...args: unknown[]) => createProvider(...args),
}));

import {
  __testing,
  discardPendingPrewarm,
  prewarmMobileVoiceStart,
  takePrewarmedMobileVoiceAsr,
} from '@/session/mobileVoicePrewarm';

class FakeProvider implements AsrProvider {
  startCalls = 0;
  stopCalls = 0;
  private release: (() => void) | null = null;
  private fail: ((error: Error) => void) | null = null;

  async start(): Promise<void> {
    this.startCalls += 1;
    await new Promise<void>((resolve, reject) => {
      this.release = resolve;
      this.fail = reject;
    });
  }

  resolveStart(): void {
    this.release?.();
  }

  failStart(error: Error): void {
    this.fail?.(error);
  }

  async stop(): Promise<void> {
    this.stopCalls += 1;
  }

  appendAudio(_chunk: ArrayBuffer, _trace?: AudioTrace): void {}

  async flushAudio(): Promise<void> {}

  private callback: (event: AsrEvent) => void = () => {};

  onEvent(callback: (event: AsrEvent) => void): void {
    this.callback = callback;
  }

  emit(event: AsrEvent): void {
    this.callback(event);
  }
}

const CREDENTIAL = { hostDeviceId: 'host-a' } as never;

async function settle(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();
}

describe('mobileVoicePrewarm', () => {
  afterEach(() => {
    __testing.reset();
    vi.clearAllMocks();
  });

  it('starts the ASR connect at prewarm and hands the in-flight connection to the claiming run', async () => {
    const provider = new FakeProvider();
    resolveCredential.mockResolvedValue(CREDENTIAL);
    createProvider.mockReturnValue(provider);

    prewarmMobileVoiceStart('device-1');
    expect(prewarmMobileRealtimeAudio).toHaveBeenCalledTimes(1);
    await settle();
    expect(provider.startCalls).toBe(1);

    const claimed = await takePrewarmedMobileVoiceAsr('device-1');
    expect(claimed?.credential).toBe(CREDENTIAL);
    expect(__testing.hasPending()).toBe(false);

    // The consumer's first start() joins the in-flight connect instead of
    // restarting the provider.
    let started = false;
    const startPromise = claimed!.asr.start().then(() => {
      started = true;
    });
    await settle();
    expect(provider.startCalls).toBe(1);
    expect(started).toBe(false);
    provider.resolveStart();
    await startPromise;
    expect(provider.startCalls).toBe(1);

    // A later run on the same session starts the provider normally.
    void claimed!.asr.start();
    expect(provider.startCalls).toBe(2);
  });

  it('does not hand a prewarmed connection to a different device', async () => {
    const provider = new FakeProvider();
    resolveCredential.mockResolvedValue(CREDENTIAL);
    createProvider.mockReturnValue(provider);

    prewarmMobileVoiceStart('device-1');
    expect(takePrewarmedMobileVoiceAsr('device-2')).toBeNull();
    expect(__testing.hasPending()).toBe(true);
  });

  it('discard closes the speculative connection once its connect settles', async () => {
    const provider = new FakeProvider();
    resolveCredential.mockResolvedValue(CREDENTIAL);
    createProvider.mockReturnValue(provider);

    prewarmMobileVoiceStart('device-1');
    await settle();
    discardPendingPrewarm();
    // Not yet closed: the socket is still opening and cannot be closed early.
    await settle();
    expect(provider.stopCalls).toBe(0);

    provider.resolveStart();
    await settle();
    expect(provider.stopCalls).toBe(1);
  });

  it('repeated pressIn for the same device reuses the pending prewarm instead of reconnecting', async () => {
    const provider = new FakeProvider();
    resolveCredential.mockResolvedValue(CREDENTIAL);
    createProvider.mockReturnValue(provider);

    prewarmMobileVoiceStart('device-1');
    prewarmMobileVoiceStart('device-1');
    await settle();
    expect(createProvider).toHaveBeenCalledTimes(1);
    expect(provider.startCalls).toBe(1);
  });

  it('retries with a fresh connection when the speculative connect failed', async () => {
    const provider = new FakeProvider();
    resolveCredential.mockResolvedValue(CREDENTIAL);
    createProvider.mockReturnValue(provider);

    prewarmMobileVoiceStart('device-1');
    await settle();
    // The speculative connect fails (e.g. transient network blip at pressIn).
    provider.failStart(new Error('blip'));
    await settle();

    // The claimed connection must not block the recording with the stale
    // failure: its first start() falls back to one fresh connect.
    const claimed = await takePrewarmedMobileVoiceAsr('device-1');
    const startPromise = claimed!.asr.start();
    await settle();
    expect(provider.startCalls).toBe(2);
    provider.resolveStart();
    await expect(startPromise).resolves.toBeUndefined();
  });

  it('reconnects when the transport dropped after the speculative connect succeeded', async () => {
    const provider = new FakeProvider();
    resolveCredential.mockResolvedValue(CREDENTIAL);
    createProvider.mockReturnValue(provider);

    prewarmMobileVoiceStart('device-1');
    await settle();
    provider.resolveStart();
    await settle();
    // The socket dies while parked (e.g. server-side idle timeout) — this
    // event goes to the prewarm sentinel, not to any consumer.
    provider.emit({ type: 'disconnected', at: Date.now() });

    // The claiming run must get a live transport, not the silently dead one.
    const claimed = await takePrewarmedMobileVoiceAsr('device-1');
    const startPromise = claimed!.asr.start();
    await settle();
    expect(provider.startCalls).toBe(2);
    provider.resolveStart();
    await expect(startPromise).resolves.toBeUndefined();
  });

  it('falls back to null when the credential cannot be resolved', async () => {
    resolveCredential.mockRejectedValue(new Error('no litellm key'));

    prewarmMobileVoiceStart('device-1');
    const claimed = await takePrewarmedMobileVoiceAsr('device-1');
    expect(claimed).toBeNull();
  });
});
