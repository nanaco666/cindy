/**
 * VendorIcon — sidebar session 行的 Agent 身份 + running 状态指示器
 * ---------------------------------------------------------------------------
 * 2026-07-21(Dash 语义纠偏):Agent 身份保留 Claude Code 像素脸 / Codex CLI
 * 花形+`>_` glyph;模型厂牌另用 AnthropicMark / OpenAIMark。
 * 2026-07-19(用户拍板,撤销 D4-1):恢复按 Agent 类型区分的 glyph。
 *   D4-1 曾统一替换为品牌箭头(BrandArrow),实测后发现依赖图标区分 agent 类型的
 *   场景(创建自动化 chips、侧栏混排)全部失效,故换回按 vendor 分支渲染。
 *
 * 状态(不变):
 *   - idle (默认)   : Stone 灰 #737373 / dark #a3a3a3
 *   - running=true  : 跟随 --sidebar-item-active 强调态;CINDY 2026-07-20 撤红后为中性选中色 + session-breathing 呼吸
 *
 * 设计参考:doc/design_docs/cc-agent-view.pen 节点 ugsrn (方案 C)。
 */

import { cn } from '@/lib/utils';
import { ClaudeMark } from '@/components/icons/ClaudeMark';
import { CodexMark } from '@/components/icons/CodexMark';

interface VendorIconProps {
  vendor: 'cc' | 'codex';
  size?: number;
  /** true → 切 Thinking Orange + 呼吸动画,复用 .session-status-breathing */
  running?: boolean;
  className?: string;
  /** 覆盖默认取色(如选中态传 active 前景 —— 用户规则 2026-07-20:选中态上
   *  所有前景元素与文字同色);running 呼吸动画不受影响。 */
  colorClassName?: string;
}

export function VendorIcon({
  vendor,
  size = 12,
  running = false,
  className,
  colorClassName,
}: VendorIconProps) {
  const wrapperClassName = cn(
    'inline-flex shrink-0',
    running && 'session-status-breathing',
    colorClassName ?? (running ? 'text-sidebar-item-active' : 'text-[hsl(var(--sidebar-muted))]'),
    className,
  );

  return (
    <span className={wrapperClassName}>
      {vendor === 'codex' ? <CodexMark size={size} /> : <ClaudeMark size={size} />}
    </span>
  );
}
