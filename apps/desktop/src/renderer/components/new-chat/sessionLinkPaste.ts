/**
 * sessionLinkPaste — 会话深链粘贴 chip 的 session 专属逻辑(attrs 构造 /
 * 序列化 / 标题异步解析)。
 *
 * 粘贴文本的**分段**在 pastePipeline.ts(统一管线:长文本 / session /
 * project / path);本文件只负责 session 段落地后的部分:
 *   - markdown 形式自带标题 → chip 直接显示该标题(titled=true);
 *   - 裸 URL → 先显示短会话 ID 占位(titled=false),随后
 *     `resolveSessionChipTitles` 异步查到标题后原地 patch 节点 attrs
 *     (addToHistory:false,不污染撤销栈)——先占位再增量刷新,不产生
 *     空白帧 / 跳变(设计规范规则 7)。
 *
 * 发送时的序列化(serializeSessionChipText):titled 的 chip 还原成
 * `[标题](href)` markdown 链接(消息侧 SessionLinkChip 显式 label 优先,
 * 手机端 MarkdownBody 同样支持),未解析出标题的还原成裸 href。标题里的
 * ASCII 方括号会破坏 markdown 链接语法,清洗为空格。
 */
import type { Editor } from '@tiptap/core';

import { parseSessionDeepLinkHref } from '@/lib/deepLink';
import { shortSessionId } from '@/lib/sessionId';

import type { MentionChipAttrs } from './MentionChipNode';

/**
 * 序列化用 label 清洗:
 *   - ASCII 方括号破坏 `[..](..)` 语法 → 换空格;
 *   - `@` 会被 UserMessage 的 mention 切词先于 linkify 拆碎(标题含
 *     `@src/App.tsx` / 邮箱时整段 markdown 形式失效,PR #970 review P2)
 *     → 归一为全角 `＠`(视觉近似,发送文本对 mention 解析安全)。
 */
export function sanitizeSessionChipTitle(title: string): string {
  return title.replace(/[[\]]/g, ' ').replace(/@/g, '＠').replace(/\s+/g, ' ').trim();
}

/** 粘贴段 → session chip 的节点 attrs(带标题即 titled,否则短 ID 占位)。 */
export function pastedSessionChipAttrs(
  seg: { href: string; label: string | null },
): MentionChipAttrs {
  const target = parseSessionDeepLinkHref(seg.href);
  const sessionId = target?.sessionId ?? seg.href;
  const label = seg.label ? sanitizeSessionChipTitle(seg.label) : '';
  return label
    ? { kind: 'session', label, path: seg.href, titled: true }
    : { kind: 'session', label: shortSessionId(sessionId), path: seg.href, titled: false };
}

/** session chip → 发送文本:有标题 `[标题](href)`,无标题裸 href。 */
export function serializeSessionChipText(attrs: MentionChipAttrs): string {
  return attrs.titled && attrs.label ? `[${attrs.label}](${attrs.path})` : attrs.path;
}

/**
 * 默认标题解析:本地库 → device-link 远程会话镜像 → null(保持短 ID)。
 * 降级顺序与消息侧 SessionLinkChip 一致。服务依赖走动态 import:本模块的
 * 纯函数(分段 / 序列化)被单测直接引用,不把 sessionService 的传输层
 * import 图拖进测试环境;app 运行时这些模块早已被 ChatInput 加载,动态
 * import 命中缓存无额外开销。
 */
export async function resolvePastedSessionTitle(sessionId: string): Promise<string | null> {
  const sessionService = await import('@/lib/sessionService');
  try {
    const session = await sessionService.get(sessionId);
    const title = session.title?.trim();
    if (title) return title;
  } catch {
    // 本地库没有(远程 / 未知会话)→ 走远程镜像降级
  }
  const { remoteProjectsStore } = await import('@/features/device-link/remoteProjectsStore');
  const remote = remoteProjectsStore
    .getMergedRemoteSessions()
    .find((s) => s.id === sessionId);
  return remote?.title?.trim() || null;
}

/**
 * 扫描编辑器里所有未解析标题(titled=false)的 session chip,异步查标题后
 * 原地 patch 节点 attrs。要点:
 *   - 解析回来后按「当时」的文档重新定位节点(粘贴后用户可能已编辑,
 *     不能缓存粘贴时的位置);
 *   - patch 事务标 addToHistory:false——撤销粘贴应一步回到粘贴前,
 *     不该先退回「短 ID 占位」中间态;
 *   - 查不到标题(远程离线 / 会话已删)→ 保持短 ID,序列化走裸 href。
 */
export function resolveSessionChipTitles(
  editor: Editor,
  resolveTitle: (sessionId: string) => Promise<string | null> = resolvePastedSessionTitle,
): void {
  const pendingIds = new Set<string>();
  editor.state.doc.descendants((node) => {
    if (node.type.name !== 'mentionChip') return;
    const attrs = node.attrs as MentionChipAttrs;
    if (attrs.kind !== 'session' || attrs.titled) return;
    const target = parseSessionDeepLinkHref(attrs.path);
    if (target) pendingIds.add(target.sessionId);
  });
  for (const sessionId of pendingIds) {
    void resolveTitle(sessionId)
      .then((title) => {
        const clean = title ? sanitizeSessionChipTitle(title) : '';
        if (!clean || editor.isDestroyed) return;
        const tr = editor.state.tr;
        let changed = false;
        editor.state.doc.descendants((node, pos) => {
          if (node.type.name !== 'mentionChip') return;
          const attrs = node.attrs as MentionChipAttrs;
          if (attrs.kind !== 'session' || attrs.titled) return;
          if (parseSessionDeepLinkHref(attrs.path)?.sessionId !== sessionId) return;
          tr.setNodeMarkup(pos, undefined, { ...attrs, label: clean, titled: true });
          changed = true;
        });
        if (!changed) return;
        tr.setMeta('addToHistory', false);
        editor.view.dispatch(tr);
      })
      .catch(() => {
        // 解析失败 → 保持短 ID 占位,不打扰用户
      });
  }
}
