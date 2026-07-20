/**
 * CopyAsImageBlock — 表格 / 块级公式的「复制为图片 / 标注」hover 外壳。
 *
 * 与 CodeBlockPre / MarkdownMermaidBlock 同一套 hover 工具栏配方(右上角
 * `h-7 w-7` 图标按钮、group-hover 显隐、Check 1.5s 反馈)。内容经
 * `domToPngBlob`(html-to-image foreignObject 序列化)光栅化:
 *   - 外层 `group relative` 只承载定位,内层才是 overflow 容器——工具栏挂在
 *     overflow 容器内会被裁剪并随横向滚动漂移;
 *   - 光栅化目标是内层内容节点,`scrollWidth` 取完整内容宽,宽表格不被可视
 *     口截断;
 *   - 标注入口仅在聊天会话上下文出现(useCopyAsImage.canAnnotate)。
 */

import { useRef, type ReactNode } from 'react';
import { Check, ImageDown, Pen } from 'lucide-react';
import { useTranslation } from 'react-i18next';

import { cn } from '@/lib/utils';
import { domToPngBlob, resolveExportBackground } from '@/lib/rasterizeToImage';
import { useCopyAsImage } from './useCopyAsImage';

interface CopyAsImageBlockProps {
  children: ReactNode;
  /** 外层 wrapper 追加类(如 `my-3`)。 */
  className?: string;
  /** 内层内容容器类(如表格的 `overflow-x-auto`);光栅化以该节点为目标。 */
  contentClassName?: string;
}

export function CopyAsImageBlock({
  children,
  className,
  contentClassName,
}: CopyAsImageBlockProps) {
  const { t } = useTranslation();
  const contentRef = useRef<HTMLDivElement>(null);

  const { copiedImage, copyAsImage, canAnnotate, openAnnotate, annotateNode } =
    useCopyAsImage(async () => {
      const node = contentRef.current;
      if (!node) throw new Error('content not mounted');
      return domToPngBlob(node, { background: resolveExportBackground(node) });
    });

  const buttonClass = cn(
    'inline-flex h-7 w-7 items-center justify-center',
    'rounded-md border border-[var(--msg-code-block-border)]',
    'bg-[var(--msg-code-block-bg)] text-[var(--msg-tool-text)]',
    'hover:bg-[var(--cmd-palette-item-hover)] hover:text-[var(--msg-assistant-text)]',
  );

  return (
    <div className={cn('group relative', className)}>
      <div ref={contentRef} className={contentClassName}>
        {children}
      </div>
      <div
        className={cn(
          'absolute right-2 top-2 flex gap-1 select-none',
          'opacity-0 transition-opacity duration-150',
          'group-hover:opacity-100 focus-within:opacity-100',
        )}
      >
        <button
          type="button"
          onClick={copyAsImage}
          aria-label={
            copiedImage
              ? t('chat.markdownRenderer.imageCopied')
              : t('chat.markdownRenderer.copyAsImage')
          }
          title={
            copiedImage
              ? t('chat.markdownRenderer.imageCopied')
              : t('chat.markdownRenderer.copyAsImage')
          }
          className={buttonClass}
        >
          {copiedImage ? <Check className="h-3.5 w-3.5" /> : <ImageDown className="h-3.5 w-3.5" />}
        </button>
        {canAnnotate ? (
          <button
            type="button"
            onClick={openAnnotate}
            aria-label={t('chat.markdownRenderer.annotateImage')}
            title={t('chat.markdownRenderer.annotateImage')}
            className={buttonClass}
          >
            <Pen className="h-3.5 w-3.5" />
          </button>
        ) : null}
      </div>
      {annotateNode}
    </div>
  );
}
