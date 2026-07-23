import fs from 'node:fs/promises';
import path from 'node:path';
import type {
  XdproxyImageEditParams,
  XdproxyImageGenerateParams,
  XdproxyImageResponse,
} from '../types.js';
import type { LiziMcpLogger } from '@cindy/mcps';
import type { CindyProxyMediaMaybePromise, CindyProxyMediaProxyConfig } from '../types.js';

export class XdproxyImageError extends Error {
  constructor(
    message: string,
    public readonly status: number,
    public readonly body?: unknown,
  ) {
    super(message);
    this.name = 'XdproxyImageError';
  }
}

export interface CreateXdproxyImageClientOptions {
  getApiKey(): CindyProxyMediaMaybePromise<string | null>;
  proxy: CindyProxyMediaProxyConfig;
  fetchImplementation?: typeof fetch;
  logger?: LiziMcpLogger;
}

async function parseResponse(res: Response): Promise<XdproxyImageResponse> {
  const text = await res.text();
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new XdproxyImageError(
      `xdproxy returned non-JSON (HTTP ${res.status}): ${text.slice(0, 200)}`,
      res.status,
      text,
    );
  }

  if (!res.ok) {
    const errMsg =
      (parsed as { error?: { message?: string } })?.error?.message ??
      `xdproxy HTTP ${res.status}`;
    throw new XdproxyImageError(errMsg, res.status, parsed);
  }

  const body = parsed as XdproxyImageResponse;
  if (!body?.data || !Array.isArray(body.data) || body.data.length === 0) {
    throw new XdproxyImageError(
      'xdproxy response missing data[]',
      res.status,
      parsed,
    );
  }
  return body;
}

function mimeFromFilename(filename: string): string {
  const lower = filename.toLowerCase();
  if (lower.endsWith('.png')) return 'image/png';
  if (lower.endsWith('.webp')) return 'image/webp';
  if (lower.endsWith('.gif')) return 'image/gif';
  return 'image/jpeg';
}

export function createXdproxyImageClient(opts: CreateXdproxyImageClientOptions): {
  generateImage(
    params: XdproxyImageGenerateParams,
    signal?: AbortSignal,
  ): Promise<XdproxyImageResponse>;
  editImage(
    params: XdproxyImageEditParams,
    signal?: AbortSignal,
  ): Promise<XdproxyImageResponse>;
} {
  const baseUrl = normalizeBaseUrl(opts.proxy.baseUrl);
  const generateUrl = joinProxyUrl(baseUrl, opts.proxy.generatePath);
  const editUrl = joinProxyUrl(baseUrl, opts.proxy.editPath);
  const doFetch = opts.fetchImplementation ?? fetch;

  async function requireApiKey(): Promise<string> {
    const key = await Promise.resolve(opts.getApiKey());
    if (!key) {
      throw new XdproxyImageError(
        'xdproxy api key not found - please log in via Feishu first',
        401,
      );
    }
    return key;
  }

  async function generateImage(
    params: XdproxyImageGenerateParams,
    signal?: AbortSignal,
  ): Promise<XdproxyImageResponse> {
    const apiKey = await requireApiKey();
    const body: Record<string, unknown> = {
      model: params.model,
      prompt: params.prompt,
      n: params.n ?? 1,
      size: params.size ?? 'auto',
    };
    if (params.quality) body.quality = params.quality;

    const res = await doFetch(generateUrl, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(body),
      signal,
    });
    return parseResponse(res);
  }

  async function editImage(
    params: XdproxyImageEditParams,
    signal?: AbortSignal,
  ): Promise<XdproxyImageResponse> {
    const apiKey = await requireApiKey();
    if (params.imagePaths.length === 0) {
      throw new XdproxyImageError('image_edit requires at least 1 image', 400);
    }

    const form = new FormData();
    form.append('model', params.model);
    form.append('prompt', params.prompt);
    form.append('n', String(params.n ?? 1));
    form.append('size', params.size ?? 'auto');
    if (params.quality) form.append('quality', params.quality);

    for (const p of params.imagePaths) {
      const buf = await fs.readFile(p);
      const filename = path.basename(p);
      form.append('image[]', new Blob([buf], { type: mimeFromFilename(filename) }), filename);
    }

    const res = await doFetch(editUrl, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${apiKey}`,
      },
      body: form as unknown as BodyInit,
      signal,
    });
    return parseResponse(res);
  }

  return { generateImage, editImage };
}

function normalizeBaseUrl(baseUrl: string): string {
  const trimmed = baseUrl.trim();
  if (!trimmed) {
    throw new Error('art: proxy.baseUrl is required');
  }
  return trimmed.replace(/\/+$/, '');
}

function joinProxyUrl(baseUrl: string, endpointPath: string): string {
  const trimmed = endpointPath.trim();
  if (!trimmed) {
    throw new Error('art: proxy endpoint path is required');
  }
  return `${baseUrl}/${trimmed.replace(/^\/+/, '')}`;
}
