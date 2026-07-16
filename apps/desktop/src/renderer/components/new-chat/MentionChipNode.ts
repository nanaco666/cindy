/**
 * Tiptap / ProseMirror node spec for the @-mention chip (command-palette
 * F2.5 / F4). A mention chip is an *atomic inline node* — the cursor can
 * sit before or after it, arrow keys jump across it as a unit, and
 * Backspace deletes it entirely instead of nibbling characters.
 *
 * Six chip kinds share one node type, differentiated by the `kind`
 * attribute:
 *   - 'file'    → lucide:file  + basename (e.g. `sessions.ts`)
 *   - 'dir'     → lucide:folder + basename + trailing slash
 *   - 'agent'   → lucide:sparkles + bare agent name
 *   - 'slash'   → no icon, text only (e.g. `/compact`)
 *   - 'session' → lucide:corner-down-right + session title (pasted
 *                 `xdt-maker://session/…` deep link; label starts as the
 *                 short session id and is patched in place once the title
 *                 resolves — see sessionLinkPaste.ts)
 *   - 'project' → lucide:folder-open + project dir basename (pasted
 *                 `xdt-maker://project/…` deep link — see pastePipeline.ts)
 *
 * We intentionally keep the node spec minimal — the *visual* chip is
 * rendered in `toDOM` as plain HTML because:
 *  (a) it lives inside an atomic inline node that Tiptap flags as leaf,
 *  (b) no interactive UI lives inside the chip (just icon + text),
 *  (c) avoiding NodeViewRenderer keeps the bundle small and dodges the
 *      React-inside-ProseMirror perf gotchas.
 *
 * Serialization (F6 spec) happens in `serializeEditorContent` in ChatInput,
 * not here — we just store the raw attrs needed to rebuild the prompt
 * string on submit.
 */
import { Node, mergeAttributes } from '@tiptap/core';

export interface MentionChipAttrs {
  /** Chip kind — decides icon + trailing slash behaviour + serialization. */
  kind: 'file' | 'dir' | 'agent' | 'slash' | 'session' | 'project';
  /** Display label:
   *  - file: basename (e.g. `sessions.ts`)
   *  - dir:  basename without trailing slash (slash added visually + on serialize)
   *  - agent: bare agent name (no `.md` extension)
   *  - session: session title (explicit pasted markdown label / resolved
   *    title), or the short session id while unresolved
   *  - project: explicit pasted markdown label, or the workingDir basename
   */
  label: string;
  /** Path used at serialization:
   *  - file: relative/path/basename.ext   → `@relative/path/basename.ext`
   *  - dir:  relative/path/dirname        → `@relative/path/dirname/`
   *  - agent: bare agent name             → `@.claude/agents/{name}.md`
   *  - session: full deep link href       → `[label](href)` / bare href
   *  - project: full deep link href       → `[label](href)` / bare href
   *
   * For `agent`, this must equal the bare `label` (the ChatInput layer
   * prepends the `.claude/agents/` prefix so that a deleted agent
   * degrades gracefully to `@<name>`).
   */
  path: string;
  /** session / project only — label is an explicit title (serialize as
   *  `[label](href)`); false means a derived placeholder is showing
   *  (session: short id / project: dir basename) and the chip serializes
   *  to the bare href. Other kinds ignore this. */
  titled?: boolean;
}

export const MentionChipNode = Node.create<Record<string, never>, Record<string, never>>({
  name: 'mentionChip',

  inline: true,
  group: 'inline',
  // atomic — prevents the cursor from entering the node, so Backspace
  // deletes the whole chip and arrow keys jump over it.
  atom: true,
  selectable: true,
  draggable: true,

  addAttributes() {
    return {
      kind: {
        default: 'file',
        parseHTML: (element) => element.getAttribute('data-kind') ?? 'file',
        renderHTML: (attrs) => ({ 'data-kind': attrs.kind }),
      },
      label: {
        default: '',
        parseHTML: (element) => element.getAttribute('data-label') ?? '',
        renderHTML: (attrs) => ({ 'data-label': attrs.label }),
      },
      path: {
        default: '',
        parseHTML: (element) => element.getAttribute('data-path') ?? '',
        renderHTML: (attrs) => ({ 'data-path': attrs.path }),
      },
      titled: {
        default: false,
        parseHTML: (element) => element.getAttribute('data-titled') === 'true',
        renderHTML: (attrs) => (attrs.titled ? { 'data-titled': 'true' } : {}),
      },
    };
  },

  parseHTML() {
    return [{ tag: 'span[data-mention-chip]' }];
  },

  renderHTML({ HTMLAttributes, node }) {
    // Design spec (command-palette.pen → 9GNAN "At Chip"):
    //   bg #e5e5e5, border 1px #d7d7d4, radius 4, padding 2px 6px, gap 4px,
    //   text #262626 JetBrains Mono 14px, icon 14x14 #262626.
    // We use CSS variables so dark mode flips automatically; the actual
    // values live in globals.css --chat-input-chip-*.
    const kind = (node.attrs as MentionChipAttrs).kind;
    const label = (node.attrs as MentionChipAttrs).label;
    const displayLabel =
      kind === 'dir' ? `${label}/` :
      kind === 'slash' ? `/${label}` :
      label;
    const wrapClass =
      kind === 'file' ? 'text-left whitespace-normal break-all' :
      // session / project labels are prose (often CJK) — wrap at word
      // boundaries instead of nowrap so a long title doesn't overflow.
      kind === 'session' || kind === 'project' ? 'text-left whitespace-normal break-words' :
      'whitespace-nowrap';

    const chipAttrs = mergeAttributes(HTMLAttributes, {
      'data-mention-chip': '',
      class:
        'inline-flex items-center align-middle gap-[4px] px-[6px] py-[1px] ' +
        'rounded-[4px] border ' +
        'bg-[var(--chat-input-chip-bg)] ' +
        'border-[var(--chat-input-chip-border)] ' +
        'text-[var(--chat-input-chip-text)] ' +
        'font-mono text-[14px] leading-[18px] ' +
        `select-none cursor-grab active:cursor-grabbing ${wrapClass}`,
      style: `color: var(--chat-input-chip-text); -webkit-user-drag: element;`,
      contenteditable: 'false',
    });

    // Slash chips have no icon — just text in a chip container.
    if (kind === 'slash') {
      return ['span', chipAttrs, displayLabel];
    }

    // File / dir / agent chips include an inline SVG icon.
    const iconPath = ICON_PATHS[kind];
    return [
      'span',
      chipAttrs,
      // ProseMirror's DOMSerializer.renderSpec uses `createElement` by
      // default. SVG elements require `createElementNS` with the SVG
      // namespace to render. ProseMirror supports a `"namespace tagName"`
      // prefix syntax — the namespace propagates to child elements.
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
        ...iconPath.map((d) => ['path', { d }] as const),
      ],
      displayLabel,
    ];
  },
});

/**
 * Minimal hardcoded lucide icon path data. Matches the *new* lucide naming
 * (shape-first) per project rules — `file`, `folder`, `sparkles`. Keeping
 * this here avoids introducing a lucide-dom runtime dep while matching
 * the design spec icons pixel-for-pixel (lucide v0.468 paths).
 */
const ICON_PATHS: Record<Exclude<MentionChipAttrs['kind'], 'slash'>, string[]> = {
  file: [
    'M15 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V7Z',
    'M14 2v4a2 2 0 0 0 2 2h4',
  ],
  dir: [
    'M20 20a2 2 0 0 0 2-2V8a2 2 0 0 0-2-2h-7.9a2 2 0 0 1-1.69-.9L9.6 3.9A2 2 0 0 0 7.93 3H4a2 2 0 0 0-2 2v13a2 2 0 0 0 2 2Z',
  ],
  agent: [
    // Sparkles — simplified 4-point spark
    'M9.937 15.5A2 2 0 0 0 8.5 14.063l-6.135-1.582a.5.5 0 0 1 0-.962L8.5 9.936A2 2 0 0 0 9.937 8.5l1.582-6.135a.5.5 0 0 1 .963 0L14.063 8.5A2 2 0 0 0 15.5 9.937l6.135 1.581a.5.5 0 0 1 0 .964L15.5 14.063a2 2 0 0 0-1.437 1.437l-1.582 6.135a.5.5 0 0 1-.963 0z',
    'M20 3v4',
    'M22 5h-4',
    'M4 17v2',
    'M5 18H3',
  ],
  session: [
    // CornerDownRight — same icon as the message-side SessionLinkChip
    'M15 10l5 5-5 5',
    'M4 4v7a4 4 0 0 0 4 4h12',
  ],
  project: [
    // FolderOpen — 与 dir(folder)区分:project 指向整个项目节点
    'm6 14 1.45-2.9A2 2 0 0 1 9.24 10H20a2 2 0 0 1 1.94 2.5l-1.55 6a2 2 0 0 1-1.94 1.5H4a2 2 0 0 1-2-2V5c0-1.1.9-2 2-2h3.93a2 2 0 0 1 1.66.9l.82 1.2a2 2 0 0 0 1.66.9H18a2 2 0 0 1 2 2v2',
  ],
};
