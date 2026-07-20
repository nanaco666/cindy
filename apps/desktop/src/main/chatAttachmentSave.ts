/**
 * chatAttachmentSave
 * ---------------------------------------------------------------------------
 * 聊天消息里的安全降级附件会以随机 `.bin` 文件落在受控缓存中，但展示名仍
 * 保留原始扩展名。本模块提供唯一的“另存为”业务体：源路径必须通过桌面端
 * 文件路径策略，目标名只取安全 basename，复制完成后绝不自动打开或执行。
 *
 * Electron 对话框与文件系统依赖全部注入，便于覆盖取消、路径拒绝和写入失败。
 */

import path from 'node:path';

/** Windows 保留设备名；带扩展名时同样非法，例如 `NUL.exe`。 */
const WINDOWS_RESERVED_BASENAME_RE = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(\.|$)/i;

export type ChatAttachmentSaveErrorCode =
  'invalid_source' | 'forbidden' | 'not_found' | 'not_file' | 'dialog_failed' | 'copy_failed';

export type ChatAttachmentSaveResult =
  | { status: 'saved'; savedPath: string }
  | { status: 'canceled' }
  | { status: 'error'; code: ChatAttachmentSaveErrorCode };

/** “另存为”业务体依赖；生产由 Electron 注入，测试使用内存 fake。 */
export interface ChatAttachmentSaveDeps {
  isPathAllowed(filePath: string): boolean;
  stat(filePath: string): Promise<{ isFile(): boolean }>;
  copyFile(sourcePath: string, targetPath: string): Promise<void>;
  showSaveDialog(opts: { defaultPath: string }): Promise<{ canceled: boolean; filePath?: string }>;
  getDownloadsDir(): string;
}

/**
 * 不可信展示名转成本机可用文件名：剥目录、控制字符、跨平台非法字符、前导点
 * 和尾随点/空格，并规避 Windows 设备名。保留尾部 128 字符可优先保住扩展名。
 */
export function sanitizeAttachmentSaveName(raw: unknown): string {
  const base = (typeof raw === 'string' ? raw : '').split(/[\\/]/).pop() ?? '';
  let cleaned = base
    // eslint-disable-next-line no-control-regex -- 控制字符是显式清洗目标
    .replace(/[\u0000-\u001f<>:"|?*]/g, '')
    .replace(/^\.+/, '')
    .replace(/[. ]+$/, '')
    .trim();
  if (!cleaned || cleaned === '..') return 'download.bin';
  if (cleaned.length > 128) cleaned = cleaned.slice(-128);
  if (WINDOWS_RESERVED_BASENAME_RE.test(cleaned)) cleaned = `_${cleaned}`;
  return cleaned;
}

/** 创建聊天附件“另存为”处理器。 */
export function createChatAttachmentSaveHandler(deps: ChatAttachmentSaveDeps) {
  return async function saveChatAttachment(params: {
    sourcePath?: unknown;
    suggestedName?: unknown;
  }): Promise<ChatAttachmentSaveResult> {
    const sourcePath = typeof params?.sourcePath === 'string' ? params.sourcePath : '';
    if (!sourcePath || !path.isAbsolute(sourcePath)) {
      return { status: 'error', code: 'invalid_source' };
    }
    if (!deps.isPathAllowed(sourcePath)) {
      return { status: 'error', code: 'forbidden' };
    }

    try {
      const stat = await deps.stat(sourcePath);
      if (!stat.isFile()) return { status: 'error', code: 'not_file' };
    } catch (err) {
      const code = (err as NodeJS.ErrnoException | null)?.code;
      return { status: 'error', code: code === 'ENOENT' ? 'not_found' : 'not_file' };
    }

    let dialogResult: { canceled: boolean; filePath?: string };
    try {
      dialogResult = await deps.showSaveDialog({
        defaultPath: path.join(
          deps.getDownloadsDir(),
          sanitizeAttachmentSaveName(params?.suggestedName),
        ),
      });
    } catch {
      return { status: 'error', code: 'dialog_failed' };
    }
    if (dialogResult.canceled || !dialogResult.filePath) return { status: 'canceled' };

    try {
      await deps.copyFile(sourcePath, dialogResult.filePath);
      return { status: 'saved', savedPath: dialogResult.filePath };
    } catch {
      return { status: 'error', code: 'copy_failed' };
    }
  };
}
