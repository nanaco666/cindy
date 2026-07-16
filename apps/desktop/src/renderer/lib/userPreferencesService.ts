import { apiRequest } from '@/lib/httpClient';
import type { Effort, UserPreferences } from '@/lib/userPreferences.types';

interface PatchResponse {
  defaultModel: string;
  defaultEffort: Effort;
  updatedAt: string;
}

/**
 * PATCH /api/users/me/preferences
 *
 * 薄封装，透传到后端 `services/userPreferences.ts` 的 updatePreferences。
 * 只返回 `{ defaultModel, defaultEffort }` 两字段给调用方，忽略 `updatedAt`
 * （本地 Context 不需要它——需要时未来再扩）。
 *
 * 失败时抛出 `ApiError`（由 httpClient 统一构造），调用方（Context）自行捕获。
 */
export async function patchPreferences(
  patch: Partial<UserPreferences>,
): Promise<UserPreferences> {
  const res = await apiRequest<PatchResponse>('/api/users/me/preferences', {
    method: 'PATCH',
    body: patch,
  });
  return {
    defaultModel: res.defaultModel,
    defaultEffort: res.defaultEffort,
  };
}
