import { API_BASE_URL } from '@/config/env';

export class ApiError extends Error {
  constructor(
    public readonly code: string,
    public readonly status: number,
    message: string,
  ) {
    super(message);
    this.name = 'ApiError';
  }
}

export interface ApiFetchOptions {
  baseUrl?: string;
  method?: string;
  token?: string | null;
  body?: unknown;
  timeoutMs?: number;
}

const DEFAULT_API_TIMEOUT_MS = 20_000;

export async function apiFetchRaw<T>(
  path: string,
  opts: ApiFetchOptions = {},
): Promise<T> {
  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  if (opts.token) headers.Authorization = `Bearer ${opts.token}`;

  let response: Response;
  let timeoutId: ReturnType<typeof setTimeout> | null = null;
  const timeoutMs = opts.timeoutMs ?? DEFAULT_API_TIMEOUT_MS;
  const controller = timeoutMs > 0 ? new AbortController() : null;
  try {
    const fetchPromise = fetch((opts.baseUrl ?? API_BASE_URL) + path, {
      method: opts.method ?? 'GET',
      headers,
      body: opts.body === undefined ? undefined : JSON.stringify(opts.body),
      signal: controller?.signal,
    });
    response = timeoutMs > 0
      ? await Promise.race([
        fetchPromise,
        new Promise<Response>((_, reject) => {
          timeoutId = setTimeout(() => {
            void fetchPromise.catch(() => undefined);
            controller?.abort();
            reject(new ApiError('REQUEST_TIMEOUT', 0, '请求超时，请稍后重试'));
          }, timeoutMs);
        }),
      ])
      : await fetchPromise;
  } catch (err) {
    if (err instanceof ApiError) throw err;
    if (isAbortError(err)) {
      throw new ApiError('REQUEST_TIMEOUT', 0, '请求超时，请稍后重试');
    }
    if (err instanceof TypeError) {
      // fetch 的网络层失败统一走类型化离线错误:RN 离线抛 "Network request failed"
      // (不含 "fetch" 子串,旧分支匹配不到,英文原文会一路透传到 UI);浏览器
      // (Web 预览)抛 "Failed to fetch",还可能是 CORS——只在 web 环境附加提示。
      const webHint = typeof document !== 'undefined'
        ? '。Web 预览可能被浏览器 CORS 拦截，请用 Expo Go/模拟器测试'
        : '';
      throw new ApiError('NETWORK_UNAVAILABLE', 0, `网络连接不可用，请检查网络后重试${webHint}`);
    }
    throw err;
  } finally {
    if (timeoutId) clearTimeout(timeoutId);
  }

  let data: unknown = null;
  try {
    data = await response.json();
  } catch {
    data = null;
  }

  if (!response.ok) {
    const error = readError(data);
    throw new ApiError(error.code ?? `HTTP_${response.status}`, response.status, error.message ?? '请求失败');
  }

  return data as T;
}

function isAbortError(err: unknown): boolean {
  return !!err && typeof err === 'object' && 'name' in err && err.name === 'AbortError';
}

function readError(data: unknown): { code?: string; message?: string } {
  if (!data || typeof data !== 'object') return {};
  const payload = data as Record<string, unknown>;
  const nested = payload.error;
  const record = nested && typeof nested === 'object'
    ? nested as Record<string, unknown>
    : payload;
  return {
    code: typeof record.code === 'string' ? record.code : undefined,
    message: typeof record.message === 'string' ? record.message : undefined,
  };
}
