/**
 * PastedTextChipNode — 长文本粘贴折叠 chip(Tiptap / ProseMirror 原子行内节点)。
 *
 * 用户往输入框粘贴超过阈值的大段文本(log / diff / 报错栈)时,不直接灌进
 * 编辑器(会把输入框撑爆),折叠成一枚可点开预览的 chip,交互对齐 Claude
 * Code CLI 的 `[Pasted text #N]` 心智:
 *   - chip 显示「粘贴的文本」标签 + 行数;点击打开可编辑弹窗(ChatInput 的
 *     editorProps.handleClickOn 分支 → ToolPayloadLightbox text 编辑模式);
 *   - Backspace 整删、光标整体跳过,与 mentionChip 同一套原子节点行为;
 *   - 发送时 serializeEditorContent 把 `text` attr 原文内联进消息正文——
 *     对 agent / 远程会话 / 手机端而言它就是普通文本,无任何附件通道依赖,
 *     消息气泡侧由既有「长消息收起」逻辑兜住展示。
 *
 * 与 MentionChipNode 分开建节点而不是加 kind:`text` attr 是大体量 payload,
 * 挂在 mentionChip 上会让所有 @chip 的 getJSON / 草稿序列化都背上这个字段;
 * 且本节点有独立的点击交互与展示语义,混在一起两头都难读。
 *
 * 阈值 / 上限常量与纯函数在 pastePipeline.ts(便于单测,不 import Tiptap)。
 *
 * i18n 注意:toDOM 是纯 HTML(无 React context),label 文案由插入方在
 * attrs.display 里传入(ChatInput 用 t() 生成),节点本身不做翻译。
 */
import { Node, mergeAttributes, type Editor } from '@tiptap/core';
import { closeHistory } from '@tiptap/pm/history';

export interface PastedTextChipAttrs {
  /** 粘贴的完整原文(发送时原样内联)。 */
  text: string;
  /** chip 上显示的完整文案(插入方已本地化,含行数,如「粘贴的文本(87 行)」)。 */
  display: string;
}

/**
 * 原位提交长文本 chip 的编辑结果。捕获的位置或 payload 已失效时 fail closed，
 * 避免弹窗打开期间草稿 / 会话被替换后误改同一位置上的其它节点。
 * `nextAttrs=null` 表示用户清空文本，直接删除 atom chip。
 */
export function applyPastedTextChipEdit(
  editor: Editor,
  nodePos: number,
  expectedText: string,
  nextAttrs: PastedTextChipAttrs | null,
): boolean {
  const { doc } = editor.state;
  if (!Number.isInteger(nodePos) || nodePos < 0 || nodePos >= doc.content.size) return false;
  const current = doc.nodeAt(nodePos);
  if (
    !current ||
    current.type.name !== 'pastedTextChip' ||
    (current.attrs as PastedTextChipAttrs).text !== expectedText
  ) {
    return false;
  }

  const tr = nextAttrs
    ? editor.state.tr.setNodeMarkup(nodePos, undefined, { ...current.attrs, ...nextAttrs })
    : editor.state.tr.delete(nodePos, nodePos + current.nodeSize);
  // 弹窗编辑是一个独立用户动作:即使紧跟粘贴发生,Undo 也只回滚本次编辑，
  // 不应把创建 chip 的粘贴事务一起撤销。
  editor.view.dispatch(closeHistory(tr));
  return true;
}

export const PastedTextChipNode = Node.create<Record<string, never>, Record<string, never>>({
  name: 'pastedTextChip',

  inline: true,
  group: 'inline',
  atom: true,
  selectable: true,
  draggable: true,

  addAttributes() {
    return {
      text: {
        default: '',
        // 原文必须进 DOM attribute:ProseMirror 的剪贴板序列化走同一个
        // toDOM,复制 / 剪切本 chip 再粘回时靠 parseHTML 从 attribute 还原
        // ——不输出就会静默丢掉整段粘贴内容(review P1)。体积由
        // pastePipeline 的 LONG_PASTE_MAX_CHARS 上限兜底,超限的粘贴根本
        // 不会折叠成本节点。
        parseHTML: (element) => element.getAttribute('data-pasted-text') ?? '',
        renderHTML: (attrs) => ({ 'data-pasted-text': attrs.text }),
      },
      display: {
        default: '',
        parseHTML: (element) => element.getAttribute('data-display') ?? '',
        renderHTML: (attrs) => ({ 'data-display': attrs.display }),
      },
    };
  },

  parseHTML() {
    return [{ tag: 'span[data-pasted-text-chip]' }];
  },

  renderHTML({ HTMLAttributes, node }) {
    const display = (node.attrs as PastedTextChipAttrs).display;
    const chipAttrs = mergeAttributes(HTMLAttributes, {
      'data-pasted-text-chip': '',
      class:
        'inline-flex items-center align-middle gap-[4px] px-[6px] py-[1px] ' +
        'rounded-[4px] border ' +
        'bg-[var(--chat-input-chip-bg)] ' +
        'border-[var(--chat-input-chip-border)] ' +
        'text-[var(--chat-input-chip-text)] ' +
        'font-mono text-[14px] leading-[18px] ' +
        'select-none cursor-pointer whitespace-nowrap',
      style: `color: var(--chat-input-chip-text); -webkit-user-drag: element;`,
      contenteditable: 'false',
    });
    return [
      'span',
      chipAttrs,
      // lucide FileText — 文档 + 文本行
      [
        'http://www.w3.org/2000/svg svg',
        {
          xmlns: 'http://www.w3.org/2000/svg',
          width: '14',
          height: '14',
          viewBox: '0 0 24 24',
          fill: 'none',
          stroke: 'currentColor',
          'stroke-width': '2',
          'stroke-linecap': 'round',
          'stroke-linejoin': 'round',
          style: `color: var(--chat-input-chip-icon); flex-shrink: 0;`,
        },
        ['path', { d: 'M15 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V7Z' }],
        ['path', { d: 'M14 2v4a2 2 0 0 0 2 2h4' }],
        ['path', { d: 'M10 9H8' }],
        ['path', { d: 'M16 13H8' }],
        ['path', { d: 'M16 17H8' }],
      ],
      display,
    ];
  },
});
