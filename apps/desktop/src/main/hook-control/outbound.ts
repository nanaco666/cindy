/**
 * hook-control/outbound.ts
 * ---------------------------------------------------------------------------
 * turn.end 出站附件收集: 从最终文本的 xdt-image / xdt-file 引用与 tool_result
 * 旁路图片(session-runner 收集的 absPath)读盘、编码 base64、施加限额, 产出
 * 协议 TaskAttachment[] 与"引用已剥离/替换"的正文。
 *
 * 引用语义与 IM 渠道收口(lizi-im slack/streamingText.doFinalize)一致:
 *   - 图片引用 `![alt](xdt-image://...)` → 附件, 正文替换成"已作为附件发送"提示
 *   - 文件引用 `[name](xdt-file:///abs/path)` → 附件, 正文整体剥离
 * (正则与 packages/lizi-im/src/xdtRefs.ts 对齐 —— 该包未导出这些工具,
 * 这里维护精简副本, 改动语义时两处同步。)
 *
 * 限额(protocol 单帧 48MiB 的安全水位): 单图 5MiB(与入站一致)、单文件
 * 10MiB、总数 8、总字节 30MiB(base64 膨胀 4/3 后约 40MiB)。xdt-file
 * 来源是模型最终文本, 必须先落在 allowedFileRoots 内才允许读盘; 超限 /
 * 越界跳过并计入 skipped, 由调用方决定是否在文本里注明。
 *
 * 纯逻辑 + 注入式 IO(readFile / resolveImageUrl), 单测不碰真盘(规则 14)。
 */

import path from 'node:path';
import { promises as fsp } from 'node:fs';

import type { TaskAttachment } from '@cindy/slack-hook-protocol';

// 双协议:老 xdt-image + 新 cindy-media(媒体总仓),与 lizi-im/xdtRefs.ts 对齐
const XDT_IMAGE_REGEX = /!\[([^\]]*)\]\(((?:xdt-image|cindy-media):\/\/[^)]+)\)/g;
const XDT_FILE_REGEX = /\[([^\]]*)\]\((xdt-file:\/\/[^)]+)\)/g;

const MAX_OUT_IMAGE_BYTES = 5 * 1024 * 1024;
const MAX_OUT_FILE_BYTES = 10 * 1024 * 1024;
const MAX_OUT_ATTACHMENTS = 8;
const MAX_OUT_TOTAL_BYTES = 30 * 1024 * 1024;

/**
 * hook 派发 turn 时附在用户消息末尾的渠道说明(session-runner 消费)。
 * 本收集器的出站契约只认最终回复文本里的 xdt-file / xdt-image 引用,但
 * 没有任何提示教模型这个约定 —— 实踩(2026-07-16)里模型两次把「把文件
 * 发给我」路由到 lizi_feishu_bot(hook 会话里唯一可见的推送工具)并失败。
 * 固定文本、逐 turn 追加,保证行为确定(规则 9);修改措辞时同步
 * collectOutboundAttachments 的实际语义,别让说明和收集器漂移。
 */
export const SLACK_HOOK_PROMPT_NOTE =
  '[渠道说明] 本会话来自 Slack。要把文件发给用户:在最终回复文本里写 ' +
  '`[文件名](xdt-file:///绝对路径)`;图片直接引用其地址 ' +
  '`![说明](cindy-media://… 或 xdt-image://…)`,无需复制文件。' +
  '系统会在回复结束后自动把它们作为 Slack 附件发回,无需调用任何工具;' +
  'xdt-file 文件必须位于当前工作目录内(目录外的引用会被静默丢弃)。' +
  '不要用 lizi_feishu_bot 发送,除非用户明确要求发到飞书。';

/** 扩展名 -> 图片 MIME(agent 产图只有这几种; 其它按二进制流)。 */
const IMAGE_MIME_BY_EXT: Record<string, string> = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
};

export function xdtFileUrlToAbsPath(url: string): string {
  const raw = url.replace(/^xdt-file:\/\//, '');
  let decoded: string;
  try {
    decoded = decodeURIComponent(raw);
  } catch {
    decoded = raw;
  }
  // 约定写法 xdt-file:///<绝对路径>:Unix 下剥掉协议后的首个 `/` 就是根;
  // Windows 盘符路径剥完协议剩 `/C:\...`(或 /C:/...),多余的前导 `/` 会让
  // allowedFileRoots 比对必失败 → 附件静默丢失(2026-07-16 实踩,规则 15),
  // 这里剥掉。与 lizi-im/xdtRefs.ts 同步修改。
  return decoded.replace(/^\/+([A-Za-z]:[\\/])/, '$1');
}

export function guessMime(absPath: string): string {
  return IMAGE_MIME_BY_EXT[path.extname(absPath).toLowerCase()] ?? 'application/octet-stream';
}

/** target 是否落在 base 目录内(含相等)。Windows 大小写不敏感(规则 15)。 */
function isPathWithin(base: string, target: string): boolean {
  const norm = (p: string): string => {
    const resolved = path.resolve(p);
    return process.platform === 'win32' ? resolved.toLowerCase() : resolved;
  };
  const rel = path.relative(norm(base), norm(target));
  return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
}

export interface OutboundDeps {
  /** xdt-image:// URL -> absPath(生产: imageCacheStore.resolveSafe; 失败抛错)。 */
  resolveImageUrl: (url: string) => { absPath: string };
  /** xdt-file:// 允许读取的根目录; 未提供时 fail-closed, 不读取任何本地文件。 */
  allowedFileRoots?: string[];
  /** realpath 校验(生产: fs.promises.realpath; 测试注入)。 */
  realpath?: (absPath: string) => Promise<string>;
  /** 读文件字节(生产: fs.promises.readFile)。 */
  readFile?: (absPath: string) => Promise<Buffer>;
  log: { warn(msg: string): void };
}

export interface OutboundResult {
  /** 引用已剥离/替换后的正文。 */
  text: string;
  attachments: TaskAttachment[];
  /** 因限额 / 读盘失败被跳过的数量(调用方记日志用)。 */
  skipped: number;
}

/** 文本里是否存在任何托管媒体出站引用(快速前置判断, 避免无谓的收集开销)。 */
export function hasOutboundRefs(text: string): boolean {
  // 双协议:老 xdt-image + 媒体总仓 cindy-media(XDT_IMAGE_REGEX 同口径)——
  // 漏了 cindy-media 会让只含总仓图的回帖跳过附件收集,图静默丢失。
  return (
    text.includes('xdt-image://') ||
    text.includes('cindy-media://') ||
    text.includes('xdt-file://')
  );
}

/**
 * 收集出站附件并变换正文。收集失败(单个文件读不到/超限)只跳过该项,
 * 绝不抛错 —— 附件是回帖的增强, 不能因它失败拖垮 turn.end。
 */
export async function collectOutboundAttachments(
  finalText: string,
  extraImageAbsPaths: string[],
  deps: OutboundDeps,
): Promise<OutboundResult> {
  const readFile = deps.readFile ?? ((p: string) => fsp.readFile(p));
  const realpath = deps.realpath ?? ((p: string) => fsp.realpath(p));
  const attachments: TaskAttachment[] = [];
  let totalBytes = 0;
  let skipped = 0;

  const isAllowedFilePath = async (absPath: string): Promise<boolean> => {
    const roots = deps.allowedFileRoots
      ?.map((root) => root.trim())
      .filter((root) => root.length > 0) ?? [];
    if (roots.length === 0) {
      deps.log.warn(`outbound file attachment skipped without allowed roots (${absPath})`);
      return false;
    }

    const targetAbs = path.resolve(absPath);
    for (const root of roots) {
      const rootAbs = path.resolve(root);
      if (!isPathWithin(rootAbs, targetAbs)) continue;
      try {
        const [rootReal, targetReal] = await Promise.all([
          realpath(rootAbs),
          realpath(targetAbs),
        ]);
        if (isPathWithin(rootReal, targetReal)) return true;
      } catch (err) {
        deps.log.warn(
          `outbound file attachment path check failed (${absPath}): ${err instanceof Error ? err.message : String(err)}`,
        );
        continue;
      }
    }

    deps.log.warn(`outbound file attachment skipped outside allowed roots (${absPath})`);
    return false;
  };

  const push = async (absPath: string, maxBytes: number, mimeOverride?: string): Promise<void> => {
    if (attachments.length >= MAX_OUT_ATTACHMENTS) {
      skipped += 1;
      return;
    }
    let bytes: Buffer;
    try {
      bytes = await readFile(absPath);
    } catch (err) {
      skipped += 1;
      deps.log.warn(
        `outbound attachment read failed (${absPath}): ${err instanceof Error ? err.message : String(err)}`,
      );
      return;
    }
    if (bytes.length === 0 || bytes.length > maxBytes || totalBytes + bytes.length > MAX_OUT_TOTAL_BYTES) {
      skipped += 1;
      deps.log.warn(`outbound attachment skipped by size (${absPath}: ${bytes.length} bytes)`);
      return;
    }
    totalBytes += bytes.length;
    attachments.push({
      name: path.basename(absPath),
      mimeType: mimeOverride ?? guessMime(absPath),
      dataBase64: bytes.toString('base64'),
    });
  };

  // 1. 图片: 文本引用 + tool_result 旁路, 按 absPath 去重(模型常重复引用)
  const imageAbsPaths: string[] = [];
  const seenImage = new Set<string>();
  for (const m of finalText.matchAll(XDT_IMAGE_REGEX)) {
    try {
      const { absPath } = deps.resolveImageUrl(m[2]);
      if (!seenImage.has(absPath)) {
        seenImage.add(absPath);
        imageAbsPaths.push(absPath);
      }
    } catch (err) {
      skipped += 1;
      deps.log.warn(
        `resolve xdt-image failed (${m[2]}): ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }
  for (const absPath of extraImageAbsPaths) {
    if (!seenImage.has(absPath)) {
      seenImage.add(absPath);
      imageAbsPaths.push(absPath);
    }
  }
  for (const absPath of imageAbsPaths) {
    await push(absPath, MAX_OUT_IMAGE_BYTES);
  }

  // 2. 文件引用(去重同上)
  const seenFile = new Set<string>();
  for (const m of finalText.matchAll(XDT_FILE_REGEX)) {
    const absPath = xdtFileUrlToAbsPath(m[2]);
    if (seenFile.has(absPath)) continue;
    seenFile.add(absPath);
    if (!(await isAllowedFilePath(absPath))) {
      skipped += 1;
      continue;
    }
    await push(absPath, MAX_OUT_FILE_BYTES);
  }

  // 3. 正文变换(与 IM 收口一致): file 链接剥离, image 引用换成提示
  const text = finalText
    .replace(XDT_IMAGE_REGEX, (_m, alt: string) =>
      alt ? `🖼️ _${alt}(已作为附件发送)_` : '',
    )
    .replace(XDT_FILE_REGEX, '');

  return { text, attachments, skipped };
}
