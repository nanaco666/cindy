import { i18n } from '@/i18n';

export class ApiError extends Error {
  constructor(
    public readonly code: string,
    public readonly statusCode: number,
    message: string,
  ) {
    super(message);
    this.name = 'ApiError';
  }
}

/**
 * Thin IPC wrapper — all HTTP logic (auth token, retry on 401) is handled
 * by the main process api:request handler. Renderer never touches tokens.
 */
export async function apiRequest<T>(
  path: string,
  options?: { method?: string; body?: unknown },
): Promise<T> {
  const result = await window.electronAPI.apiRequest({
    path,
    method: options?.method,
    body: options?.body,
  });

  if (result.ok) {
    return result.data as T;
  }

  const data = result.data as { error?: { code?: string; message?: string } } | null;
  throw new ApiError(
    data?.error?.code ?? 'UNKNOWN',
    result.status,
    data?.error?.message ?? i18n.t('logic.errors.requestFailed'),
  );
}
