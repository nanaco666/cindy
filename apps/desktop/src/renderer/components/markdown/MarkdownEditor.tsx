/**
 * MarkdownEditor — unified WYSIWYG markdown editor for SkillHub (and future
 * .md editing surfaces). Wraps MDXEditor with the plugin set that fits our
 * Claude Code customization use case (frontmatter, code blocks, tables, diff
 * source-toggle), normalizes its theming against our DESIGN.md greyscale,
 * and exposes a small ref API for "save" callers to pull the current md.
 *
 * Why MDXEditor:
 *   - WYSIWYG so non-technical users can edit without learning syntax
 *   - frontmatterPlugin renders YAML as a key-value table — covers both
 *     SKILL.md (name/description/version) and command .md (description)
 *     without per-kind UI work
 *   - Round-trips through mdast — formatting survives save/load, which a
 *     ProseMirror-only editor would not guarantee
 *
 * Bundle cost: ~850 KB gzipped. Acceptable for a desktop Electron app
 * (not a web bundle); revisit if we ship a web-shell flavor later.
 */

import '@mdxeditor/editor/style.css';
import './markdown-editor.css';

import {
  type MDXEditorMethods,
  MDXEditor,
  headingsPlugin,
  listsPlugin,
  quotePlugin,
  thematicBreakPlugin,
  markdownShortcutPlugin,
  linkPlugin,
  linkDialogPlugin,
  tablePlugin,
  codeBlockPlugin,
  codeMirrorPlugin,
  frontmatterPlugin,
  diffSourcePlugin,
  toolbarPlugin,
  UndoRedo,
  BoldItalicUnderlineToggles,
  BlockTypeSelect,
  CreateLink,
  InsertTable,
  InsertThematicBreak,
  ListsToggle,
  CodeToggle,
  InsertCodeBlock,
  DiffSourceToggleWrapper,
  InsertFrontmatter,
} from '@mdxeditor/editor';
import { forwardRef, useEffect, useImperativeHandle, useRef } from 'react';

import { cn } from '@/lib/utils';

export interface MarkdownEditorHandle {
  /** Pull the current markdown — used by the save action. */
  getMarkdown: () => string;
}

export interface MarkdownEditorProps {
  /** Initial raw markdown including frontmatter. Subsequent prop changes
   *  are NOT respected by MDXEditor — remount via key={filePath} to swap. */
  initialValue: string;
  /** Fires on every content change. Use to drive the dirty flag. */
  onChange?: (markdown: string) => void;
  /** When true, editor renders read-only — lets us reuse this component
   *  for diff/preview surfaces without a separate component. */
  readOnly?: boolean;
  /** Forwarded to the outermost wrapper for sizing / positioning. */
  className?: string;
  /** Detected dark mode — Tailwind's `dark` class on <html>. We pass it in
   *  so the parent can switch via its own theme observer instead of every
   *  editor instance reading the DOM. */
  isDarkMode?: boolean;
}

// CodeMirror language map — covers the languages most likely to appear inside
// a SKILL.md / command body. MDXEditor falls back to plain text for unknown
// langs, so missing entries degrade gracefully.
const CODE_BLOCK_LANGUAGES: Record<string, string> = {
  js: 'JavaScript',
  ts: 'TypeScript',
  tsx: 'TSX',
  jsx: 'JSX',
  json: 'JSON',
  yaml: 'YAML',
  yml: 'YAML',
  md: 'Markdown',
  py: 'Python',
  sh: 'Shell',
  bash: 'Bash',
  zsh: 'Zsh',
  rust: 'Rust',
  go: 'Go',
  sql: 'SQL',
  html: 'HTML',
  css: 'CSS',
  '': 'Plain text',
};

export const MarkdownEditor = forwardRef<MarkdownEditorHandle, MarkdownEditorProps>(
  function MarkdownEditor({ initialValue, onChange, readOnly = false, className, isDarkMode }, ref) {
    const editorRef = useRef<MDXEditorMethods>(null);
    const hostRef = useRef<HTMLDivElement>(null);

    useImperativeHandle(
      ref,
      () => ({
        getMarkdown: () => editorRef.current?.getMarkdown() ?? '',
      }),
      [],
    );

    // MDXEditor's frontmatter plugin renders the YAML in a collapsed chip
    // by default — easy to miss. If the document loaded with frontmatter,
    // auto-expand it on mount so the user sees the metadata fields without
    // having to discover the toggle. Runs once per mount; remounts (file
    // switch via key={filePath}) re-trigger naturally.
    useEffect(() => {
      // requestAnimationFrame defers until after MDXEditor's first render,
      // so the toggle button exists in the DOM by the time we look.
      const raf = requestAnimationFrame(() => {
        const wrapper = hostRef.current?.querySelector('[class*="frontmatterWrapper"]');
        if (!wrapper) return; // doc has no frontmatter
        if (wrapper.getAttribute('data-expanded') === 'true') return; // already open
        const toggle = wrapper.querySelector<HTMLButtonElement>('[class*="frontmatterToggleButton"]');
        toggle?.click();
      });
      return () => cancelAnimationFrame(raf);
    }, []);

    return (
      <div
        ref={hostRef}
        className={cn(
          'mdxeditor-host flex min-h-0 flex-1 flex-col',
          // MDXEditor reads `dark-theme` to flip its built-in CSS variable
          // bundle. CodeMirror inside fenced blocks then inherits via the
          // shared variables (no separate `dark-editor` class is shipped).
          isDarkMode && 'dark-theme',
          // select-text:globals.css 全局 user-select:none,MDXEditor 工具栏 / 插槽
          // / 内嵌 CodeMirror 的 .cm-scroller 这些非 contenteditable 元素不加会导
          // 致选区拖动/选词卡顿。.select-text * 递归覆盖所有内部节点。
          'select-text',
          className,
        )}
      >
        <MDXEditor
          ref={editorRef}
          markdown={initialValue}
          onChange={onChange}
          readOnly={readOnly}
          contentEditableClassName="mdxeditor-content"
          plugins={[
            // Node-handling plugins come first.
            headingsPlugin(),
            listsPlugin(),
            quotePlugin(),
            thematicBreakPlugin(),
            linkPlugin(),
            linkDialogPlugin(),
            tablePlugin(),
            // codeBlockPlugin must come BEFORE codeMirrorPlugin — the latter
            // augments the former with syntax-highlighted editing inside
            // fenced blocks.
            codeBlockPlugin({ defaultCodeBlockLanguage: '' }),
            codeMirrorPlugin({ codeBlockLanguages: CODE_BLOCK_LANGUAGES }),
            frontmatterPlugin(),
            diffSourcePlugin({ viewMode: 'rich-text', diffMarkdown: initialValue }),
            toolbarPlugin({
              toolbarContents: () => (
                // DiffSourceToggleWrapper renders the rich-text/source/diff
                // segmented control on the right; everything passed as
                // children renders on the left.
                <DiffSourceToggleWrapper>
                  <UndoRedo />
                  <BoldItalicUnderlineToggles />
                  <CodeToggle />
                  <BlockTypeSelect />
                  <CreateLink />
                  <InsertCodeBlock />
                  <InsertTable />
                  <InsertThematicBreak />
                  <ListsToggle />
                  <InsertFrontmatter />
                </DiffSourceToggleWrapper>
              ),
            }),
            // Markdown-shortcut plugin MUST come last per MDXEditor docs —
            // it observes the node types registered by the plugins above
            // and only converts shortcuts (`# ` → heading) for nodes those
            // plugins know about. Mounting it earlier means later plugins
            // don't get hooked into the shortcut transformer.
            markdownShortcutPlugin(),
          ]}
        />
      </div>
    );
  },
);
