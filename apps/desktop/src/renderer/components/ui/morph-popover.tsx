import { useCallback, useEffect, useLayoutEffect, useRef, useState, type ReactNode } from 'react';
import { createPortal } from 'react-dom';

import { cn } from '@/lib/utils';

/**
 * MorphPopover —— 「chip 原位长成弹层」的容器形变原语(docs/design-rules/cindy-design-system.md §14.4 容器形变类目)。
 *
 * 与 Radix Popover 的本质区别:弹层不是浮现盖在 trigger 上,而是以 trigger chip 的
 * 精确几何(位置/尺寸/胶囊圆角/pill 底色)为起点,宽/高/圆角/底色/阴影同步过渡到
 * 面板形态。形变期间 chip 本体隐藏,由面板内的「ghost 幽灵层」承接 chip 视觉,随
 * 生长 crossfade 成面板内容;全程整体不透明度恒为 1。
 *
 * 实现要点(每条都对应一个踩过的坑):
 * - portal + position:fixed 锚定 trigger 视口坐标,天然豁免 composer 工具条
 *   `overflow-hidden` 的裁剪(这是不能沿用 Radix in-flow 方案后自建 portal 的原因)。
 * - side='top' 底边锚定向上生长 / side='bottom' 顶边锚定向下生长;
 *   align='start' 左缘对齐 / align='end' 右缘对齐(右缘锚定时内容加宽自动向左扩)。
 * - 测量目标几何时必须临时禁用 transition:否则 offsetHeight 在宽度过渡第 0 帧
 *   按旧宽度排版,含换行文本时会量出几十行的假高度(§14.4 实现红线 b)。
 * - 形变起点圆角 = chip 高度一半,禁止 9999px(9999→12 插值中途帧会变形,红线)。
 * - 打开期间 ResizeObserver 跟随内容尺寸变化(搜索过滤 / 模型 Edit 面板 320↔516
 *   展宽),同一条形变曲线平滑跟随,不跳变。
 * - prefers-reduced-motion 降级为直切(红线 a);focus/Esc/outside-click 语义与
 *   §14.2 相同(红线 d):打开聚焦 [data-morph-autofocus] → 首个 input → 首个主操作,
 *   关闭后焦点归还 trigger。
 *
 * 职责边界:本组件只管几何形变与开合语义;面板内容的 role(listbox/menu)、行高亮、
 * i18n 全部由调用方提供。业务不进这里。
 */

const MORPH_MS = 300;
const MORPH_EASE = 'cubic-bezier(0.3, 0.9, 0.25, 1)';
/** 面板与视口边缘的最小留白(对齐 Radix collisionPadding 习惯) */
const VIEWPORT_PADDING = 8;

/** 形变属性集(与 §14.4 参数一致);reduced-motion 时整组置空实现直切 */
const MORPH_TRANSITION = [
  `left ${MORPH_MS}ms ${MORPH_EASE}`,
  `width ${MORPH_MS}ms ${MORPH_EASE}`,
  `height ${MORPH_MS}ms ${MORPH_EASE}`,
  `border-radius ${MORPH_MS}ms ${MORPH_EASE}`,
  `background-color ${MORPH_MS}ms ease`,
  `border-color ${MORPH_MS}ms ease`,
  `box-shadow ${MORPH_MS}ms ease`,
].join(', ');

interface MorphPopoverProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** trigger chip(调用方渲染完整按钮,含 aria-expanded/haspopup)。 */
  trigger: ReactNode;
  /**
   * 形变期间承接 chip 视觉的幽灵层。缺省时在打开瞬间自动 cloneNode(trigger DOM),
   * 保证像素级一致 —— trigger 内容复杂(多状态分支)的调用方应走缺省;
   * 只有需要自定义幽灵视觉时才显式传。
   */
  ghost?: ReactNode;
  /** 面板内容(role/选项行由调用方定义)。 */
  children: ReactNode;
  /** 生长方向:top = 底边锚定向上(composer 默认);bottom = 顶边锚定向下(settings 场景)。 */
  side?: 'top' | 'bottom';
  /** 水平对齐:start = 左缘对齐 chip;end = 右缘对齐(工具条右端控件用,防溢出视口)。 */
  align?: 'start' | 'end';
  /**
   * 固定面板宽度(px)。内容含换行文本(描述行等)时必须提供 —— 自适应测量对
   * 换行内容无法稳定收敛;不提供则按 max-content 自适应(仅限 nowrap / 自带定宽的内容)。
   */
  panelWidth?: number;
  /** 面板形变起点底色/边色(= chip 的),默认 composer pill 规格。 */
  startBg?: string;
  startBorderColor?: string;
  /** 面板终态底色/边色,默认 model dropdown 规格。 */
  endBg?: string;
  endBorderColor?: string;
  /**
   * 形变起点圆角(px)。默认取 chip 高度一半(胶囊等效值);
   * trigger 不是胶囊时(settings field 8px 矩形)必须显式传,否则起点圆角失真。
   */
  startRadius?: number;
  /** 面板内容容器 className(padding 等由调用方给)。 */
  panelClassName?: string;
  /** trigger 外层 wrapper className(布局用,如 shrink)。 */
  wrapperClassName?: string;
  /** 面板 aria-label(容器为 group 语义时可选)。 */
  panelAriaLabel?: string;
}

/** 是否处于 reduced-motion(SSR/jsdom 无 matchMedia 时按 false) */
function prefersReducedMotion(): boolean {
  return (
    typeof window !== 'undefined' &&
    !!window.matchMedia?.('(prefers-reduced-motion: reduce)').matches
  );
}

export function MorphPopover({
  open,
  onOpenChange,
  trigger,
  ghost,
  children,
  side = 'top',
  align = 'start',
  panelWidth,
  startBg = 'var(--composer-pill-bg)',
  startBorderColor = 'var(--border-default)',
  endBg = 'var(--model-dropdown-bg)',
  endBorderColor = 'var(--model-dropdown-border)',
  startRadius,
  panelClassName,
  wrapperClassName,
  panelAriaLabel,
}: MorphPopoverProps) {
  // mounted 独立于 open:关闭时先播收合动画,动画完再卸载 portal
  const [mounted, setMounted] = useState(false);
  const wrapRef = useRef<HTMLSpanElement>(null);
  const panelRef = useRef<HTMLDivElement>(null);
  const contentRef = useRef<HTMLDivElement>(null);
  const closeTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const openRafOneRef = useRef<number | null>(null);
  const openRafTwoRef = useRef<number | null>(null);
  // 关闭收合的目标几何 = 打开瞬间的 chip rect(打开后 chip 隐藏,rect 不可再量)
  const chipRectRef = useRef<DOMRect | null>(null);
  // 初始形变是否已完成(ResizeObserver 只在其后接管,避免和开场动画打架)
  const settledRef = useRef(false);

  const requestClose = useCallback(() => onOpenChange(false), [onOpenChange]);
  // ghost 是否由调用方自定义(布尔化,避免 JSX 身份变化触发 effect 重跑)
  const hasCustomGhost = ghost !== undefined;

  if (open && !mounted) setMounted(true);

  const cancelOpeningFrames = useCallback(() => {
    if (openRafOneRef.current !== null) cancelAnimationFrame(openRafOneRef.current);
    if (openRafTwoRef.current !== null) cancelAnimationFrame(openRafTwoRef.current);
    openRafOneRef.current = null;
    openRafTwoRef.current = null;
  }, []);

  /** 定宽量高。调用前必须已把 panel.style.transition 置为 'none'(红线 b)。 */
  const measure = useCallback(
    (panel: HTMLDivElement, chipRect: DOMRect) => {
      const prevW = panel.style.width;
      const prevH = panel.style.height;
      panel.style.height = 'auto';
      let desiredW: number;
      if (panelWidth) {
        desiredW = Math.max(panelWidth, chipRect.width);
      } else {
        panel.style.width = 'max-content';
        desiredW = Math.max(panel.offsetWidth, chipRect.width);
      }
      const maxW = Math.max(0, window.innerWidth - VIEWPORT_PADDING * 2);
      const targetW = Math.min(desiredW, maxW);
      panel.style.width = `${targetW}px`;
      // 可视高度钳制:top 侧最多长到视口顶,bottom 侧最多长到视口底(内容区自滚)
      const avail =
        side === 'top'
          ? chipRect.bottom - VIEWPORT_PADDING
          : window.innerHeight - chipRect.top - VIEWPORT_PADDING;
      const targetH = Math.min(panel.offsetHeight, Math.max(0, avail));
      const anchoredLeft = align === 'start' ? chipRect.left : chipRect.right - targetW;
      const targetLeft = Math.min(
        Math.max(anchoredLeft, VIEWPORT_PADDING),
        Math.max(VIEWPORT_PADDING, window.innerWidth - VIEWPORT_PADDING - targetW),
      );
      panel.style.width = prevW;
      panel.style.height = prevH;
      return { w: targetW, h: targetH, left: targetLeft };
    },
    [align, panelWidth, side],
  );

  /**
   * 把已展开面板同步到内容的最新尺寸。
   *
   * opening 期间 ResizeObserver 仍会消费通知，但那时不能与开场动画同时改几何；
   * 因此 settle 时必须无条件补量一次，避免异步 capability / provider 列表恰好在
   * 前 300ms 内返回后，面板永久停在旧高度。
   */
  const syncPanelToContent = useCallback(() => {
    const panel = panelRef.current;
    const rect = chipRectRef.current;
    if (!panel || !rect) return;
    const prevTransition = panel.style.transition;
    panel.style.transition = 'none';
    const measured = measure(panel, rect);
    const currentWidth = panel.offsetWidth;
    const currentHeight = panel.offsetHeight;
    panel.style.width = `${currentWidth}px`;
    panel.style.height = `${currentHeight}px`;
    void panel.offsetHeight;
    panel.style.transition = prevTransition;
    // 差 1px 内不动,防 ResizeObserver 观察回环。
    if (
      Math.abs(measured.w - currentWidth) <= 1 &&
      Math.abs(measured.h - currentHeight) <= 1
    ) return;
    panel.style.left = `${measured.left}px`;
    panel.style.width = `${measured.w}px`;
    panel.style.height = `${measured.h}px`;
  }, [measure]);

  /** 把面板锚到 chip 的形变起点几何(closed 视觉态) */
  const applyChipGeometry = useCallback(
    (panel: HTMLDivElement, rect: DOMRect) => {
      panel.style.left = `${rect.left}px`;
      panel.style.right = 'auto';
      panel.style.top = side === 'bottom' ? `${rect.top}px` : 'auto';
      panel.style.bottom = side === 'top' ? `${window.innerHeight - rect.bottom}px` : 'auto';
      panel.style.width = `${rect.width}px`;
      panel.style.height = `${rect.height}px`;
      panel.style.borderRadius = `${startRadius ?? rect.height / 2}px`;
      panel.style.backgroundColor = startBg;
      panel.style.borderColor = startBorderColor;
      panel.style.boxShadow = '0 0 0 rgba(0,0,0,0)';
    },
    [side, startBg, startBorderColor, startRadius],
  );

  /** 开合主流程:全部几何走 DOM 直写(避免 state 往返打断同帧测量) */
  useLayoutEffect(() => {
    const panel = panelRef.current;
    const wrap = wrapRef.current;
    if (!mounted || !panel || !wrap) return;
    if (closeTimerRef.current) clearTimeout(closeTimerRef.current);
    cancelOpeningFrames();

    const reduced = prefersReducedMotion();

    if (open) {
      settledRef.current = false;
      const rect = wrap.getBoundingClientRect();
      chipRectRef.current = rect;
      // 1) 面板落到 chip 精确几何,transition 关闭防测量污染
      panel.style.transition = 'none';
      applyChipGeometry(panel, rect);
      panel.dataset.state = 'closed';
      // 2) chip 隐形:面板完全承接视觉,不是盖一层;ghost 撑到 chip 几何对齐基线。
      //    未传 ghost 时克隆 trigger DOM 兜底(像素级一致,克隆层 aria-hidden + 不可交互)
      const ghostEl = panel.querySelector<HTMLElement>('[data-morph-ghost]');
      if (ghostEl) {
        ghostEl.style.height = `${rect.height}px`;
        ghostEl.style.width = `${rect.width}px`;
        if (!hasCustomGhost) {
          ghostEl.replaceChildren(
            ...Array.from(wrap.children, (c) => c.cloneNode(true) as Element),
          );
        }
      }
      wrap.style.visibility = 'hidden';
      // 3) 定宽量高(transition 已关,量到的是真实终态排版)
      const m = measure(panel, rect);
      // 4) 回初始几何并强制 reflow,再恢复 transition
      panel.style.width = `${rect.width}px`;
      panel.style.height = `${rect.height}px`;
      void panel.offsetHeight;
      panel.style.transition = reduced ? 'none' : MORPH_TRANSITION;
      // 5) 双 rAF 过渡到面板形态(reduced-motion 时等效直切)
      openRafOneRef.current = requestAnimationFrame(() => {
        openRafOneRef.current = null;
        openRafTwoRef.current = requestAnimationFrame(() => {
          openRafTwoRef.current = null;
          if (!panelRef.current) return;
          panel.dataset.state = 'open';
          panel.style.left = `${m.left}px`;
          panel.style.width = `${m.w}px`;
          panel.style.height = `${m.h}px`;
          panel.style.borderRadius = '12px';
          panel.style.backgroundColor = endBg;
          panel.style.borderColor = endBorderColor;
          panel.style.boxShadow = 'var(--shadow-menu)';
        });
      });
      // 6) §14.2 焦点:autofocus 标记 → 首个输入 → 首个主操作/菜单项 → 面板容器
      const focusDelay = reduced ? 0 : MORPH_MS;
      closeTimerRef.current = setTimeout(() => {
        settledRef.current = true;
        // RO 在 opening 期间收到的尺寸变化不会在 settled 后自动重发；这里补量一次。
        syncPanelToContent();
        const focusRoot = contentRef.current ?? panel;
        const target =
          focusRoot.querySelector<HTMLElement>('[data-morph-autofocus]:not([disabled])') ??
          focusRoot.querySelector<HTMLElement>('input:not([disabled]), textarea:not([disabled])') ??
          focusRoot.querySelector<HTMLElement>(
            '[data-morph-primary]:not([disabled]), [role="option"]:not([disabled]), [role="menuitem"]:not([disabled]), [role="menuitemcheckbox"]:not([disabled]), button:not([disabled])',
          ) ??
          panel;
        target.focus({ preventScroll: true });
      }, focusDelay);
    } else {
      // 收合:回 chip 几何 + closed 视觉态,动画完卸载并复形 chip、归还焦点
      settledRef.current = false;
      // trigger 可能在打开期间因工具条重排而移动;收合前重新测量,避免飞回旧坐标。
      const measuredRect = wrap.getBoundingClientRect();
      const rect = measuredRect.width || measuredRect.height ? measuredRect : chipRectRef.current;
      chipRectRef.current = rect;
      const reducedClose = reduced || !rect;
      panel.dataset.state = 'closed';
      if (rect) applyChipGeometry(panel, rect);
      closeTimerRef.current = setTimeout(
        () => {
          setMounted(false);
          wrap.style.visibility = '';
          // 仅当焦点仍留在正在关闭的面板(或浏览器已退到 body)时归还 trigger。
          // 选项动作若已打开 Dialog / 把焦点交给其它控件,不得在动画结束后抢回来。
          const active = document.activeElement;
          if (active === document.body || (active && panel.contains(active))) {
            wrap.querySelector<HTMLElement>('button, [tabindex]')?.focus({ preventScroll: true });
          }
        },
        reducedClose ? 0 : MORPH_MS + 20,
      );
    }
    return () => {
      if (closeTimerRef.current) clearTimeout(closeTimerRef.current);
      cancelOpeningFrames();
    };
  }, [
    mounted,
    open,
    measure,
    applyChipGeometry,
    cancelOpeningFrames,
    endBg,
    endBorderColor,
    hasCustomGhost,
    syncPanelToContent,
  ]);

  /** 打开稳定后跟随内容尺寸变化(搜索过滤 / Edit 面板展宽),同曲线平滑过渡 */
  useEffect(() => {
    const panel = panelRef.current;
    const content = contentRef.current;
    if (!mounted || !open || !panel || !content || typeof ResizeObserver === 'undefined') return;
    let roRaf = 0;
    const ro = new ResizeObserver(() => {
      // RO 回调内直接写布局会触发 \"ResizeObserver loop completed with
      // undelivered notifications\" 告警(2026-07-22 日志实捕)——把测量与几何
      // 更新推迟到下一帧,并合并同帧内的多次通知。
      if (roRaf) return;
      roRaf = requestAnimationFrame(() => {
        roRaf = 0;
        const p = panelRef.current;
        if (!p || !settledRef.current) return;
        syncPanelToContent();
      });
    });
    ro.observe(content);
    return () => {
      if (roRaf) cancelAnimationFrame(roRaf);
      ro.disconnect();
    };
  }, [mounted, open, syncPanelToContent]);

  /** 卸载兜底:组件树移除时恢复 chip 可见性(否则 chip 永久隐形) */
  useEffect(() => {
    const wrap = wrapRef.current;
    return () => {
      if (wrap) wrap.style.visibility = '';
      if (closeTimerRef.current) clearTimeout(closeTimerRef.current);
      cancelOpeningFrames();
    };
  }, [cancelOpeningFrames]);

  /** 幂等兜底:面板未挂载时 chip 必须可见。正常路径由收合 timer 恢复;
      这里兜住一切时序被打断的情况(HMR 换组件、异常卸载等,2026-07-22 实捕)。 */
  useEffect(() => {
    if (!mounted && wrapRef.current) wrapRef.current.style.visibility = '';
  }, [mounted]);

  /** 打开期间的全局关闭手势:outside pointer/focus / Esc / 外部滚动 / 窗口 resize */
  useEffect(() => {
    if (!mounted || !open) return;
    const onPointerDown = (e: PointerEvent) => {
      const t = e.target as Node;
      if (panelRef.current?.contains(t) || wrapRef.current?.contains(t)) return;
      // 面板内容可能再弹 Radix 浮层(portal 到 body,如模型行的 effort/Fast 配置
      // 子面板)——点它不算 outside,否则子面板永远点不了(整个面板会先被关掉)
      if ((t as Element).closest?.('[data-radix-popper-content-wrapper]')) return;
      requestClose();
    };
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return;
      // 分层关闭:面板内还开着 Radix 浮层(role=dialog,如 effort 子面板)时,
      // 这次 Esc 让给内层关,下一次 Esc 才关本面板(对齐 Radix 嵌套层语义;
      // tooltip 是 role=tooltip 不挡)。
      // 必须挂 capture:keydown 是 discrete 事件,Radix 的 capture 处理器关层后
      // React 会同步 flush DOM 移除,bubble 阶段已经看不到 dialog;本监听注册早于
      // 内层(面板先开、子面板后开),capture 同阶段按注册序先跑,此时 dialog 必在。
      if (document.querySelector('[data-radix-popper-content-wrapper] [role="dialog"]')) return;
      requestClose();
    };
    const onResize = () => requestClose();
    const onScroll = (event: Event) => {
      const target = event.target;
      if (target instanceof Node && panelRef.current?.contains(target)) return;
      requestClose();
    };
    const onFocusIn = (event: FocusEvent) => {
      const target = event.target;
      if (!(target instanceof Node)) return;
      if (panelRef.current?.contains(target) || wrapRef.current?.contains(target)) return;
      // 模型面板中的 effort/Fast 等 Radix 子浮层 portal 到 body,仍属于当前交互层。
      if ((target as Element).closest?.('[data-radix-popper-content-wrapper]')) return;
      requestClose();
    };
    document.addEventListener('pointerdown', onPointerDown, true);
    document.addEventListener('keydown', onKeyDown, true);
    document.addEventListener('scroll', onScroll, true);
    document.addEventListener('focusin', onFocusIn, true);
    window.addEventListener('resize', onResize);
    return () => {
      document.removeEventListener('pointerdown', onPointerDown, true);
      document.removeEventListener('keydown', onKeyDown, true);
      document.removeEventListener('scroll', onScroll, true);
      document.removeEventListener('focusin', onFocusIn, true);
      window.removeEventListener('resize', onResize);
    };
  }, [mounted, open, requestClose]);

  return (
    <>
      <span ref={wrapRef} className={cn('relative inline-flex', wrapperClassName)}>
        {trigger}
      </span>
      {mounted &&
        createPortal(
          <div
            ref={panelRef}
            data-state="closed"
            role="group"
            aria-label={panelAriaLabel}
            tabIndex={-1}
            className="group fixed z-50 overflow-hidden border outline-none data-[state=closed]:pointer-events-none"
            // 初始几何由 useLayoutEffect 直写;这里只兜首帧不可见位置
            style={{ left: -9999, bottom: -9999 }}
          >
            {/* ghost 幽灵层: chip 内容克隆,钉在 chip 原位角落,开场可见,随生长淡出 */}
            <div
              aria-hidden
              inert
              data-morph-ghost
              className={cn(
                'pointer-events-none absolute flex items-center',
                align === 'start' ? 'left-0' : 'right-0',
                side === 'top' ? 'bottom-0' : 'top-0',
                'opacity-100 transition-opacity duration-[130ms] group-data-[state=open]:opacity-0',
                'motion-reduce:transition-none',
              )}
            >
              {ghost}
            </div>
            {/* 面板内容: 随生长淡入(70ms 延迟 + 5px 浮入);高度钳制时内部自滚 */}
            <div
              ref={contentRef}
              inert={!open}
              className={cn(
                'max-h-full overflow-y-auto',
                side === 'top' ? 'translate-y-[5px]' : 'translate-y-[-5px]',
                'opacity-0 transition-[opacity,transform] delay-[70ms] duration-[180ms] ease-out',
                'group-data-[state=open]:translate-y-0 group-data-[state=open]:opacity-100',
                'motion-reduce:transition-none',
                panelClassName,
              )}
            >
              {children}
            </div>
          </div>,
          document.body,
        )}
    </>
  );
}
