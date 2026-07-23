/**
 * xdproxyHttp.ts
 * ---------------------------------------------------------------------------
 * Shared low-level helpers for any client talking to the xdproxy backend.
 *
 * Today: image client (xdproxyImageClient.ts) and the seedance video provider
 * (video/providers/seedance.ts) both need the same things — load the API key
 * from the host's safeStorage, normalize a base URL, and join it with an
 * endpoint path. Future video providers (kling, luma, wan, ...) reuse them
 * too instead of each rolling its own copy.
 */

import type { LiziMcpLogger } from '@cindy/mcps';
import type { CindyProxyMediaMaybePromise } from '../types.js';

export class XdproxyHttpError extends Error {
  constructor(
    message: string,
    public readonly status: number,
    public readonly body?: unknown,
  ) {
    super(message);
    this.name = 'XdproxyHttpError';
  }
}

export interface XdproxyHttpAuth {
  getApiKey(): CindyProxyMediaMaybePromise<string | null>;
}

export async function requireApiKey(auth: XdproxyHttpAuth): Promise<string> {
  const key = await Promise.resolve(auth.getApiKey());
  if (!key) {
    throw new XdproxyHttpError(
      'xdproxy api key not found - please log in via Feishu first',
      401,
    );
  }
  return key;
}

export function normalizeBaseUrl(baseUrl: string): string {
  const trimmed = baseUrl.trim();
  if (!trimmed) {
    throw new Error('art: proxy.baseUrl is required');
  }
  return trimmed.replace(/\/+$/, '');
}

export function joinProxyUrl(baseUrl: string, endpointPath: string): string {
  const trimmed = endpointPath.trim();
  if (!trimmed) {
    throw new Error('art: proxy endpoint path is required');
  }
  return `${normalizeBaseUrl(baseUrl)}/${trimmed.replace(/^\/+/, '')}`;
}

/**
 * Decode a JSON body, throwing an XdproxyHttpError when the response is not
 * 2xx or the body isn't JSON. Used by clients that always expect JSON
 * (image generations, seedance task submit/poll). Binary endpoints (video
 * download) bypass this and use raw fetch + arrayBuffer.
 */
export async function parseJsonResponse<T>(
  res: Response,
  logger?: LiziMcpLogger,
): Promise<T> {
  const text = await res.text();
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    logger?.warn?.(
      `[xdproxy] non-JSON response (HTTP ${res.status}): ${text.slice(0, 200)}`,
    );
    throw new XdproxyHttpError(
      `xdproxy returned non-JSON (HTTP ${res.status}): ${text.slice(0, 200)}`,
      res.status,
      text,
    );
  }
  if (!res.ok) {
    const errMsg =
      (parsed as { error?: { message?: string } })?.error?.message ??
      (parsed as { detail?: string })?.detail ??
      `xdproxy HTTP ${res.status}`;
    throw new XdproxyHttpError(errMsg, res.status, parsed);
  }
  return parsed as T;
}
