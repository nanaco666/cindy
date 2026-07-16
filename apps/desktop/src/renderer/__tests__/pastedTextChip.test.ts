// @vitest-environment jsdom
// (Editor 构造与 getHTML/setContent 的 DOM 序列化回环需要 document。)
import { Editor } from '@tiptap/core';
import Document from '@tiptap/extension-document';
import Paragraph from '@tiptap/extension-paragraph';
import Text from '@tiptap/extension-text';
import { afterEach, describe, expect, it } from 'vitest';

import {
  PastedTextChipNode,
  type PastedTextChipAttrs,
} from '@/components/new-chat/PastedTextChipNode';

// Editor 必须逐个 destroy:EditorView 的异步回调(observer / flush)会在
// jsdom 环境拆除后触发 `document is not defined` 未处理异常,vitest 全绿
// 也会 exit 1(CI unit-shard 实撞)。
const editors: Editor[] = [];
afterEach(() => {
  for (const editor of editors.splice(0)) editor.destroy();
});

function makeEditor(): Editor {
  const editor = new Editor({
    extensions: [Document, Paragraph, Text, PastedTextChipNode],
    content: { type: 'doc', content: [{ type: 'paragraph', content: [] }] },
  });
  editors.push(editor);
  return editor;
}

describe('PastedTextChipNode', () => {
  it('round-trips the full text payload through DOM serialization (review P1)', () => {
    // ProseMirror 剪贴板序列化走同一个 toDOM:复制 / 剪切 chip 再粘回,
    // 原文必须能从 data-pasted-text 还原,否则发送时静默丢内容。
    const text = '第一行 log\n第二行 "带引号" 与 <标签>\n第三行';
    const display = '粘贴的文本(3 行)';
    const editor = makeEditor();
    editor.commands.insertContent({ type: 'pastedTextChip', attrs: { text, display } });
    const html = editor.getHTML();

    const restored = makeEditor();
    restored.commands.setContent(html);
    const inline = (restored.getJSON().content?.[0]?.content ?? []) as Array<{
      type?: string;
      attrs?: PastedTextChipAttrs;
    }>;
    expect(inline).toHaveLength(1);
    expect(inline[0].type).toBe('pastedTextChip');
    expect(inline[0].attrs?.text).toBe(text);
    expect(inline[0].attrs?.display).toBe(display);
  });
});
