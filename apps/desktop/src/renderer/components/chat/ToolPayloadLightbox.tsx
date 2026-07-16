/**
 * ToolPayloadLightbox
 * ---------------------------------------------------------------------------
 * F11 / F12 (cc-agent-compact-blocks v2) — full-screen overlay for showing
 * tool payloads:
 *   - mode: 'diff' → renders DiffView (Edit / Write / MultiEdit)
 *   - mode: 'json' → renders Input JSON + tool_result side-by-side blocks
 *   - mode: 'text' → renders a single plain-text block (in-memory content,
 *     e.g. ChatInput 长文本粘贴 chip 的预览 — 无文件路径可给 TextLightbox)
 *
 * Pattern intentionally mirrors TextLightbox: portal to body, 80vw/80vh
 * doc card, Esc / backdrop close, scroll-lock on the message stream
 * container. Kept as a SEPARATE component (rather than overloading
 * TextLightbox) because:
 *   - TextLightbox loads file content via IPC + Web Worker syntax-highlight,
 *     none of which is needed here.
 *   - textLightbox.test.ts contains tight source-scan invariants; adding a
 *     mode dispatch there would risk breaking unrelated assertions.
 *   - Separation keeps each lightbox's concerns minimal and easy to reason
 *     about.
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { Copy, FileText, Folder, X } from 'lucide-react';
import { useTranslation } from 'react-i18next';

import { cn, basename } from '@/lib/utils';
import { toast } from '@/lib/toast';
import { Tooltip } from '@/components/ui/tooltip';

import { DiffView } from './DiffView';
import { isRemoteFileOrigin } from '@/lib/sessionFileOrigin';
import { revealRemoteChatFile } from '@/lib/remoteFileOpen';
import { useChatSessionFile } from './ChatSessionFileContext';

export type ToolPayloadMode =
  | {
      kind: 'diff';
      /** Full path used for toolbar display + clipboard copy. */
      filePath: string;
      /** One or more diff segments. MultiEdit produces N. */
      diffs: Array<{ key: string; oldString: string; newString: string; label?: string }>;
    }
  | {
      kind: 'json';
      /** Display title — usually the tool name + a short subtitle. */
      title: string;
      /** Raw input object — JSON.stringify'd for display. */
      toolInput: unknown;
      /** Optional tool_result text. Empty / missing → only Input shown. */
      toolResult?: string;
    }
  | {
      kind: 'text';
      /** Display title(调用方已本地化)。 */
      title: string;
      /** 原样展示的纯文本内容。 */
      text: string;
    };

interface ToolPayloadLightboxProps {
  payload: ToolPayloadMode;
  /** Focus return target — usually the chip / chevron that opened us. */
  triggerRef?: React.RefObject<HTMLElement | null>;
  onClose: () => void;
}

export function ToolPayloadLightbox({ payload, triggerRef, onClose }: ToolPayloadLightboxProps) {
  const { t } = useTranslation();
  // 会话文件来源:remote 时 diff 的"定位文件"改为下载缓存副本后定位。
  const fileCtx = useChatSessionFile();
  const [isVisible, setIsVisible] = useState(false);
  const isClosingRef = useRef(false);

  const handleClose = useCallback(() => {
    if (isClosingRef.current) return;
    isClosingRef.current = true;
    setIsVisible(false);
    setTimeout(() => {
      const trigger = triggerRef?.current;
      if (trigger && document.contains(trigger)) {
        try {
          trigger.focus({ preventScroll: true });
        } catch {
          /* noop */
        }
      }
      onClose();
    }, 200);
  }, [onClose, triggerRef]);

  useEffect(() => {
    const raf = requestAnimationFrame(() => setIsVisible(true));
    return () => cancelAnimationFrame(raf);
  }, []);

  // Esc key
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (e.key === 'Escape') handleClose();
    };
    document.addEventListener('keydown', handler);
    return () => document.removeEventListener('keydown', handler);
  }, [handleClose]);

  // Scroll lock — same selector as TextLightbox / ImageLightbox
  useEffect(() => {
    const container = document.querySelector('[data-scroll-container]') as HTMLElement | null;
    if (container) container.style.overflowY = 'hidden';
    return () => {
      if (container) container.style.overflowY = '';
    };
  }, []);

  // ── Toolbar bits ────────────────────────────────────────────────────────
  const displayName =
    payload.kind === 'diff' ? basename(payload.filePath) : payload.title;
  const fullTitle = payload.kind === 'diff' ? payload.filePath : payload.title;

  async function copyTitle() {
    try {
      await navigator.clipboard.writeText(fullTitle);
      toast.success(payload.kind === 'diff' ? t('chat.lightbox.pathCopied') : t('chat.lightbox.copied'));
    } catch {
      toast.error(t('chat.media.copyFailed'));
    }
  }

  async function copyContent() {
    try {
      let text = '';
      if (payload.kind === 'diff') {
        text = payload.diffs
          .map((d, i) => {
            const head =
              payload.diffs.length > 1
                ? `--- Edit ${i + 1}/${payload.diffs.length} ---\n`
                : '';
            return `${head}--- old\n${d.oldString}\n+++ new\n${d.newString}`;
          })
          .join('\n\n');
      } else if (payload.kind === 'text') {
        text = payload.text;
      } else {
        const inp = JSON.stringify(payload.toolInput, null, 2);
        text = payload.toolResult ? `Input:\n${inp}\n\nResult:\n${payload.toolResult}` : inp;
      }
      await navigator.clipboard.writeText(text);
      toast.success(t('chat.lightbox.contentCopied'));
    } catch {
      toast.error(t('chat.media.copyFailed'));
    }
  }

  async function showInFolder() {
    if (payload.kind !== 'diff') return;
    // remote 会话:远端路径本机不存在(或更糟,存在同路径本机文件)——
    // 下载缓存副本后定位副本。
    if (isRemoteFileOrigin(fileCtx.origin)) {
      await revealRemoteChatFile(fileCtx.origin, fileCtx.workingDir, payload.filePath);
      return;
    }
    const res = await window.electronAPI.showItemInFolder({ filePath: payload.filePath });
    if (!res.success) {
      toast.error(res.error || t('chat.media.openFolderFailed'));
    }
  }

  const overlay = (
    <div
      data-tool-payload-lightbox-overlay
      style={{
        position: 'fixed',
        inset: 0,
        zIndex: 9999,
        background: 'var(--overlay-lightbox)',
        display: 'flex',
        flexDirection: 'column',
        alignItems: 'center',
        justifyContent: 'center',
        transition: 'opacity 200ms ease',
        opacity: isVisible ? 1 : 0,
        cursor: 'default',
      }}
    >
      <button
        type="button"
        aria-label={t('chat.lightbox.close')}
        style={{
          position: 'absolute',
          inset: 0,
          border: 0,
          padding: 0,
          background: 'transparent',
          cursor: 'default',
        }}
        onClick={handleClose}
      />
      <div
        data-tool-payload-lightbox-card
        className={cn(
          'cursor-auto flex flex-col overflow-hidden rounded-[12px]',
          'border border-[var(--msg-tool-card-border)]',
          'bg-[var(--msg-tool-card-bg)]',
        )}
        style={{
          width: '80vw',
          height: '80vh',
          maxWidth: '1600px',
          maxHeight: '1200px',
          position: 'relative',
          zIndex: 1,
        }}
      >
        {/* Toolbar */}
        <div
          className={cn(
            'flex items-center justify-between',
            'h-14 shrink-0 px-5',
            'border-b border-[var(--msg-tool-card-border)]',
          )}
        >
          <Tooltip.Root>
            <Tooltip.Trigger asChild>
              <button
                type="button"
                onClick={copyTitle}
                className={cn(
                  'flex items-center gap-2 min-w-0',
                  'rounded-[6px] px-1 -mx-1 py-0.5',
                  'hover:bg-[var(--msg-code-inline-bg)] transition-colors',
                  'text-left cursor-pointer',
                )}
              >
                <FileText size={16} className="shrink-0 text-[var(--msg-tool-card-chevron)]" />
                <span
                  className={cn(
                    'font-semibold text-[14px]',
                    'text-[var(--msg-tool-card-text)]',
                    'truncate',
                  )}
                >
                  {displayName}
                </span>
              </button>
            </Tooltip.Trigger>
            <Tooltip.Content>
              {payload.kind === 'diff' ? t('chat.lightbox.clickToCopyPath') : t('chat.lightbox.clickToCopy')}
            </Tooltip.Content>
          </Tooltip.Root>

          <div className="flex items-center gap-1">
            {payload.kind === 'diff' && (
              <Tooltip.Root>
                <Tooltip.Trigger asChild>
                  <button
                    type="button"
                    onClick={showInFolder}
                    className={cn(
                      'flex h-8 w-8 items-center justify-center rounded-[6px]',
                      'hover:bg-[var(--msg-code-inline-bg)] transition-colors cursor-pointer',
                    )}
                    aria-label={t('chat.lightbox.openInExplorer')}
                  >
                    <Folder size={18} className="text-[var(--msg-tool-card-chevron)]" />
                  </button>
                </Tooltip.Trigger>
                <Tooltip.Content>{t('chat.lightbox.openInExplorer')}</Tooltip.Content>
              </Tooltip.Root>
            )}
            <Tooltip.Root>
              <Tooltip.Trigger asChild>
                <button
                  type="button"
                  onClick={copyContent}
                  className={cn(
                    'flex h-8 w-8 items-center justify-center rounded-[6px]',
                    'hover:bg-[var(--msg-code-inline-bg)] transition-colors cursor-pointer',
                  )}
                  aria-label={t('chat.lightbox.copyContent')}
                >
                  <Copy size={18} className="text-[var(--msg-tool-card-chevron)]" />
                </button>
              </Tooltip.Trigger>
              <Tooltip.Content>{t('chat.lightbox.copyContent')}</Tooltip.Content>
            </Tooltip.Root>
            <Tooltip.Root>
              <Tooltip.Trigger asChild>
                <button
                  type="button"
                  onClick={handleClose}
                  className={cn(
                    'flex h-8 w-8 items-center justify-center rounded-[6px]',
                    'hover:bg-[var(--msg-code-inline-bg)] transition-colors cursor-pointer',
                  )}
                  aria-label={t('chat.lightbox.close')}
                >
                  <X size={20} className="text-[var(--msg-tool-card-chevron)]" />
                </button>
              </Tooltip.Trigger>
              <Tooltip.Content>{t('chat.lightbox.close')}</Tooltip.Content>
            </Tooltip.Root>
          </div>
        </div>

        {/* Body */}
        <div
          className={cn(
            'flex-1 overflow-auto px-5 py-4 select-text',
            'text-[var(--msg-tool-card-text)]',
          )}
        >
          {payload.kind === 'diff' && (
            <div className="flex flex-col gap-3">
              {payload.diffs.map((d, i) => (
                <div
                  key={d.key}
                  className="flex flex-col gap-1"
                >
                  {payload.diffs.length > 1 && (
                    <div className="text-12 text-[var(--msg-tool-card-chevron)]">
                      {d.label ?? t('chat.lightbox.editIndex', { index: i + 1, total: payload.diffs.length })}
                    </div>
                  )}
                  <DiffView oldString={d.oldString} newString={d.newString} />
                </div>
              ))}
            </div>
          )}

          {payload.kind === 'text' && (
            <pre
              className={cn(
                'overflow-x-auto rounded-[12px] border border-[var(--msg-code-block-border)]',
                'bg-[var(--msg-code-block-bg)] p-3 font-mono text-[length:calc(var(--app-code-font-size)_-_1px)] leading-[1.5]',
                'text-[var(--msg-tool-card-text)] select-text whitespace-pre-wrap break-words',
              )}
            >
              {payload.text}
            </pre>
          )}

          {payload.kind === 'json' && (
            <div className="flex flex-col gap-4">
              <div>
                <div className="mb-1 text-xs font-medium text-[var(--msg-tool-card-chevron)]">
                  Input
                </div>
                <pre
                  className={cn(
                    'overflow-x-auto rounded-[12px] border border-[var(--msg-code-block-border)]',
                    'bg-[var(--msg-code-block-bg)] p-3 font-mono text-[length:calc(var(--app-code-font-size)_-_1px)] leading-[1.5]',
                    'text-[var(--msg-tool-card-text)] select-text whitespace-pre-wrap break-words',
                  )}
                >
                  {JSON.stringify(payload.toolInput, null, 2)}
                </pre>
              </div>
              {payload.toolResult && (
                <div>
                  <div className="mb-1 text-xs font-medium text-[var(--msg-tool-card-chevron)]">
                    Result
                  </div>
                  <pre
                    className={cn(
                      'overflow-x-auto rounded-[12px] border border-[var(--msg-code-block-border)]',
                      'bg-[var(--msg-code-block-bg)] p-3 font-mono text-[length:calc(var(--app-code-font-size)_-_1px)] leading-[1.5]',
                      'text-[var(--msg-tool-card-text)] select-text whitespace-pre-wrap break-words',
                    )}
                  >
                    {payload.toolResult}
                  </pre>
                </div>
              )}
            </div>
          )}
        </div>
      </div>

      <div
        className="mt-5 flex items-center gap-2 select-none"
        style={{ position: 'relative', zIndex: 1 }}
      >
        <span
          className={cn(
            'rounded-[4px] border px-1.5 py-[2px]',
            'text-11 font-medium',
            'text-white/60 border-white/40',
          )}
        >
          Esc
        </span>
        <span className="text-12 text-white/40">or click backdrop to close</span>
      </div>
    </div>
  );

  return createPortal(overlay, document.body);
}
