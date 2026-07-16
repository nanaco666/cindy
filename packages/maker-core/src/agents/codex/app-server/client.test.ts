import { describe, expect, it, vi } from 'vitest';

import { AppServerClient, detectAuthInvalidationReason } from './client.js';
import type { Logger } from '../../../interfaces/logger.js';
import type { Transport, LineHandler, CloseHandler } from './transport.js';

class FakeTransport implements Transport {
  readonly lines: string[] = [];
  private readonly lineHandlers = new Set<LineHandler>();
  private readonly closeHandlers = new Set<CloseHandler>();

  async writeLine(line: string): Promise<void> {
    this.lines.push(line);
  }

  onLine(handler: LineHandler): () => void {
    this.lineHandlers.add(handler);
    return () => this.lineHandlers.delete(handler);
  }

  onClose(handler: CloseHandler): () => void {
    this.closeHandlers.add(handler);
    return () => this.closeHandlers.delete(handler);
  }

  async close(reason = 'test close'): Promise<void> {
    for (const handler of this.closeHandlers) handler({ reason });
  }

  emitLine(value: unknown): void {
    const line = typeof value === 'string' ? value : JSON.stringify(value);
    for (const handler of this.lineHandlers) handler(line);
  }
}

const logger: Logger = {
  trace: vi.fn(),
  debug: vi.fn(),
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
  fatal: vi.fn(),
  child: () => logger,
};

describe('detectAuthInvalidationReason', () => {
  it('detects Codex app session termination', () => {
    const line = JSON.stringify({
      level: 'ERROR',
      fields: {
        message:
          'Failed to refresh token: 400 Bad Request: { "error": { "message": "Your session has ended. Please log in again.", "code": "app_session_terminated" } }',
      },
    });

    expect(detectAuthInvalidationReason(line)).toBe('app_session_terminated');
  });

  it('detects invalidated ChatGPT auth tokens', () => {
    const line =
      'remote plugin catalog request failed with status 401 Unauthorized: {"error":{"message":"Your authentication token has been invalidated. Please try signing in again.","code":"token_invalidated"}}';

    expect(detectAuthInvalidationReason(line)).toBe('token_invalidated');
  });

  it('detects revoked Codex OAuth tokens', () => {
    const line =
      'failed to refresh available models: unexpected status 401 Unauthorized: auth error code: token_revoked';

    expect(detectAuthInvalidationReason(line)).toBe('token_revoked');
  });

  it('keeps the legacy refresh-token reuse detection', () => {
    expect(detectAuthInvalidationReason('OAuth refresh token was already used')).toBe(
      'refresh_token_reused',
    );
  });

  it('does not classify transient websocket failures as auth invalidation', () => {
    expect(
      detectAuthInvalidationReason(
        'stream disconnected - retrying sampling request (2/5 in 434ms)...',
      ),
    ).toBeNull();
    expect(
      detectAuthInvalidationReason('failed to connect to websocket: HTTP error: 502 Bad Gateway'),
    ).toBeNull();
    expect(
      detectAuthInvalidationReason('Failed to refresh token: timeout while contacting auth service'),
    ).toBeNull();
  });
});

describe('AppServerClient server requests', () => {
  it('passes request id/method metadata to handlers and answers the original JSON-RPC request', async () => {
    const transport = new FakeTransport();
    const client = new AppServerClient({
      createTransport: () => transport,
      logger,
    });
    const handler = vi.fn(async (params, meta) => {
      expect(params).toEqual({ question: 'Pick one' });
      expect(meta).toEqual({ id: 'server-req-1', method: 'item/tool/requestUserInput' });
      return { answers: { q1: { answers: ['A'] } } };
    });

    client.setRequestHandler('item/tool/requestUserInput', handler);
    client.start();
    transport.emitLine({
      id: 'server-req-1',
      method: 'item/tool/requestUserInput',
      params: { question: 'Pick one' },
    });

    await vi.waitFor(() => {
      expect(transport.lines).toHaveLength(1);
    });
    expect(handler).toHaveBeenCalledTimes(1);
    expect(JSON.parse(transport.lines[0] ?? '')).toEqual({
      id: 'server-req-1',
      result: { answers: { q1: { answers: ['A'] } } },
    });
  });
});
