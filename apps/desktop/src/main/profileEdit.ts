/**
 * profileEdit.ts — 个人资料本地覆写(改名 / 换头像)的业务体。
 * ---------------------------------------------------------------------------
 * IPC adapter 在 bootstrap-electron 注册(profile:* channel),这里是完全
 * 依赖注入的纯逻辑(规则 14:测试用内存 harness 直接 invoke,不启 Electron)。
 *
 * 数据模型见 profileOverrideStore.ts 文件头:服务端 /api/user/me 是默认真源,
 * 这里只维护本设备的显式 override。头像字节按规则 25 走 cindy-media 媒体总仓:
 * ingest 指纹落盘 + 挂 'profile-avatar' 引用行(refId = userId),换头像后清旧
 * 指纹引用、恢复默认时清空引用——业务只删自己名下的 ref,字节回收交回收器。
 *
 * 「输入值 == 服务端默认值」时**清 override 而非存快照**(规则 20:未自定义的
 * 用户应随服务端资料变化;存快照会把默认值冻结在本机)。
 */

import { throwIpcError } from './utils/ipcValidate';
import type { ProfileOverride } from './profileOverrideStore';
import type { IngestedMedia, IngestRef } from './cindy-media/ingest';

// ── 常量 ────────────────────────────────────────────────────────────────────

/** 头像源文件体积上限。超过直接拒(头像展示尺寸 ≤52px,5MB 绰绰有余)。 */
export const AVATAR_MAX_BYTES = 5 * 1024 * 1024;
/** 自定义名字长度上限(码点数)。 */
export const NAME_MAX_LENGTH = 40;

/** 头像允许的扩展名(含点)→ mime。cindy-media 图片白名单的子集。 */
const AVATAR_MIME_BY_EXT: Record<string, string> = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
};

/** 文件选择器 filter 用的扩展名清单(不含点)。 */
export const AVATAR_FILE_EXTENSIONS = ['png', 'jpg', 'jpeg', 'gif', 'webp'];

// ── 依赖注入面 ──────────────────────────────────────────────────────────────

export interface ProfileEditDeps {
  /** 当前登录用户 id;未登录 null。 */
  getCurrentUserId(): string | null;
  /** 服务端资料真值(判断"输入 == 默认 → 清 override")。 */
  getServerProfile(): { name: string; avatar: string | null } | null;
  /** 弹系统文件选择器,返回所选路径;取消返回 null。 */
  showAvatarOpenDialog(): Promise<string | null>;
  /** 读文件字节(fs.promises.readFile)。 */
  readFile(filePath: string): Promise<Buffer>;
  /** 头像入总仓(cindy-media ingestMedia)。 */
  ingestMedia(params: {
    buffer: Uint8Array;
    mimeType: string;
    refs: IngestRef[];
  }): Promise<IngestedMedia>;
  /** 清旧头像引用(换头像:保留新指纹之外的全删)。 */
  removeRefsExceptHash(params: {
    refKind: 'profile-avatar';
    refId: string;
    keepHash: string;
  }): Promise<number>;
  /** 清全部头像引用(恢复默认头像)。 */
  removeRefs(params: { refKind: 'profile-avatar'; refId: string }): Promise<number>;
  readOverride(userId: string): ProfileOverride | null;
  writeOverride(userId: string, override: ProfileOverride): void;
  /** 保存成功后的登录态重广播(authManager.notifyProfileOverrideChanged)。 */
  notifyChanged(): void;
  /** 非致命失败记日志(旧引用清理失败等,不影响保存结果)。 */
  logWarn(message: string, err: unknown): void;
}

// ── IPC payload 类型(preload / renderer 共用形状) ─────────────────────────

/** profile:get-state 返回:编辑弹窗的预填数据。 */
export interface ProfileEditState {
  serverName: string;
  serverAvatar: string | null;
  overrideName: string | null;
  overrideAvatarUrl: string | null;
}

export interface ChooseAvatarResult {
  canceled: boolean;
  filePath?: string;
  /** 弹窗内预览用 data URL(一次性,不落任何缓存)。 */
  previewDataUrl?: string;
}

export type AvatarAction =
  | { type: 'keep' }
  | { type: 'set'; filePath: string }
  | { type: 'reset' };

export interface UpdateProfileParams {
  /** 期望的显示名;null / 空串 = 恢复默认(清 override)。 */
  name: string | null;
  avatar: AvatarAction;
}

// ── 内部工具 ────────────────────────────────────────────────────────────────

function avatarMimeForPath(filePath: string): string | null {
  const dot = filePath.lastIndexOf('.');
  if (dot < 0) return null;
  return AVATAR_MIME_BY_EXT[filePath.slice(dot).toLowerCase()] ?? null;
}

function requireUserId(deps: ProfileEditDeps): string {
  const userId = deps.getCurrentUserId();
  if (!userId) throwIpcError('PRECONDITION_FAILED', 'not logged in');
  return userId;
}

function parseAvatarAction(value: unknown): AvatarAction | null {
  if (value === null || typeof value !== 'object') return null;
  const action = value as { type?: unknown; filePath?: unknown };
  if (action.type === 'keep') return { type: 'keep' };
  if (action.type === 'reset') return { type: 'reset' };
  if (action.type === 'set' && typeof action.filePath === 'string' && action.filePath !== '') {
    return { type: 'set', filePath: action.filePath };
  }
  return null;
}

// ── 业务入口(bootstrap 的 IPC handler 直调) ───────────────────────────────

/** 编辑弹窗预填数据。 */
export function getProfileEditState(deps: ProfileEditDeps): ProfileEditState {
  const userId = requireUserId(deps);
  const server = deps.getServerProfile();
  if (!server) throwIpcError('PRECONDITION_FAILED', 'not logged in');
  const override = deps.readOverride(userId);
  return {
    serverName: server.name,
    serverAvatar: server.avatar,
    overrideName: override?.name ?? null,
    overrideAvatarUrl: override?.avatarUrl ?? null,
  };
}

/**
 * 选头像文件:系统选择器 → 扩展名 / 体积校验 → 返回路径 + 预览 data URL。
 * 这里**不**入仓——用户点「保存」才 ingest,取消弹窗不留任何账。
 */
export async function chooseAvatarFile(deps: ProfileEditDeps): Promise<ChooseAvatarResult> {
  requireUserId(deps);
  const filePath = await deps.showAvatarOpenDialog();
  if (!filePath) return { canceled: true };
  const mime = avatarMimeForPath(filePath);
  if (!mime) {
    throwIpcError('INVALID_PARAMS', `unsupported avatar file type: ${filePath}`);
  }
  let buffer: Buffer;
  try {
    buffer = await deps.readFile(filePath);
  } catch {
    throwIpcError('INVALID_PARAMS', 'avatar file is not readable');
  }
  if (buffer.byteLength === 0 || buffer.byteLength > AVATAR_MAX_BYTES) {
    throwIpcError('INVALID_PARAMS', `avatar file size out of range: ${buffer.byteLength}`);
  }
  return {
    canceled: false,
    filePath,
    previewDataUrl: `data:${mime};base64,${buffer.toString('base64')}`,
  };
}

/**
 * 保存资料覆写。name 与 avatar 各自独立收敛:
 *   - name:trim 后为空或与服务端一致 → 清名字 override;否则存;
 *   - avatar keep:沿用现有覆写;set:ingest 新图并替换引用;reset:清引用清覆写。
 *
 * 落账顺序(崩溃窗口契约,规则 25):ingest 挂新引用 → store 提交 + 广播 →
 * 最后清旧引用。任何一步失败 / 进程中途死掉,store 指向的指纹都必有引用行
 * 兜着(不会被回收器清成悬空破图);最坏只留"多余引用行"的无害泄漏,下次
 * 换头像时被 removeRefsExceptHash 顺手清掉——因此清理失败只 warn 不回滚。
 */
export async function updateProfile(
  deps: ProfileEditDeps,
  rawParams: unknown,
): Promise<{ ok: true }> {
  const userId = requireUserId(deps);
  const server = deps.getServerProfile();
  if (!server) throwIpcError('PRECONDITION_FAILED', 'not logged in');

  if (rawParams === null || typeof rawParams !== 'object') {
    throwIpcError('INVALID_PARAMS', 'profile update payload must be an object');
  }
  const params = rawParams as { name?: unknown; avatar?: unknown };
  if (params.name !== null && typeof params.name !== 'string') {
    throwIpcError('INVALID_PARAMS', 'name must be a string or null');
  }
  const avatarAction = parseAvatarAction(params.avatar);
  if (!avatarAction) {
    throwIpcError('INVALID_PARAMS', 'avatar action is malformed');
  }

  // ── 名字收敛 ──
  const trimmedName = typeof params.name === 'string' ? params.name.trim() : '';
  if ([...trimmedName].length > NAME_MAX_LENGTH) {
    throwIpcError('INVALID_PARAMS', `name exceeds ${NAME_MAX_LENGTH} characters`);
  }
  const nextName = trimmedName !== '' && trimmedName !== server.name ? trimmedName : undefined;

  // ── 头像收敛(顺序契约见函数头注释) ──
  const existing = deps.readOverride(userId);
  let nextAvatarUrl: string | undefined;
  let newAvatarHash: string | null = null;
  if (avatarAction.type === 'keep') {
    nextAvatarUrl = existing?.avatarUrl;
  } else if (avatarAction.type === 'set') {
    const mime = avatarMimeForPath(avatarAction.filePath);
    if (!mime) {
      throwIpcError('INVALID_PARAMS', `unsupported avatar file type: ${avatarAction.filePath}`);
    }
    let buffer: Buffer;
    try {
      buffer = await deps.readFile(avatarAction.filePath);
    } catch {
      throwIpcError('INVALID_PARAMS', 'avatar file is not readable');
    }
    if (buffer.byteLength === 0 || buffer.byteLength > AVATAR_MAX_BYTES) {
      throwIpcError('INVALID_PARAMS', `avatar file size out of range: ${buffer.byteLength}`);
    }
    const ingested = await deps.ingestMedia({
      buffer,
      mimeType: mime,
      refs: [{ refKind: 'profile-avatar', refId: userId, originKind: 'user' }],
    });
    nextAvatarUrl = ingested.url;
    newAvatarHash = ingested.hash;
  } else {
    nextAvatarUrl = undefined;
  }

  // store 提交 + 广播:此刻新地址(若有)已有引用行兜底,提交即安全。
  deps.writeOverride(userId, { name: nextName, avatarUrl: nextAvatarUrl });
  deps.notifyChanged();

  // 旧引用清理放最后:失败只留无害的多余引用行(字节仍受保护,不破图),
  // 保存结果不回滚,warn 留痕即可。reset 删全部引用后字节交回收器,不直接删文件。
  try {
    if (avatarAction.type === 'set' && newAvatarHash !== null) {
      await deps.removeRefsExceptHash({
        refKind: 'profile-avatar',
        refId: userId,
        keepHash: newAvatarHash,
      });
    } else if (avatarAction.type === 'reset') {
      await deps.removeRefs({ refKind: 'profile-avatar', refId: userId });
    }
  } catch (err) {
    deps.logWarn('profile avatar old-ref cleanup failed (harmless leak, retried on next change)', err);
  }
  return { ok: true };
}
