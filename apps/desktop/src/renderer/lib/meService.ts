/**
 * meService — `GET /api/me` 的薄封装
 * ---------------------------------------------------------------------------
 * V0.3 新增。AuthContext mount 后调一次拿到 role，与现有 token 体系正交
 * （ADR-V0.3-1：role 不嵌入 JWT，避免变更需要用户重新登录）。
 *
 * 失败不阻断：调用方应 catch 掉异常，按视为 user 处理。
 */

import { apiRequest } from '@/lib/httpClient';
import type { UserRole } from '@/lib/authService';

export interface MeResponse {
  id: string;
  name: string;
  avatarUrl: string | null;
  role: UserRole;
}

export function getMe(): Promise<MeResponse> {
  return apiRequest<MeResponse>('/api/me');
}
