/**
 * VendorIcon — sidebar session 行的 vendor + running 状态指示器
 * ---------------------------------------------------------------------------
 * D4-1(用户拍板):Claude(AA 字标)/Codex(六瓣)统一替换为品牌箭头(BrandArrow),
 *   常规任务/会话行首视觉统一,vendor 不再区分;vendor prop 保留兼容(未来恢复
 *   glyph 可在此分支)。Claude/Codex 视觉不再区分——若日后要区分再单独加辅助标识。
 *
 * 状态(不变):
 *   - idle (默认)   : Stone 灰 #737373 / dark #a3a3a3
 *   - running=true  : Thinking Orange #FF6600(== --status-bar-accent)+ session-breathing 呼吸
 *
 * 设计参考:doc/design_docs/cc-agent-view.pen 节点 ugsrn (方案 C)。
 */

import { cn } from '@/lib/utils';
import { BrandArrow } from '@/components/icons/BrandArrow';

interface VendorIconProps {
  vendor: 'cc' | 'codex';
  size?: number;
  /** true → 切 Thinking Orange + 呼吸动画,复用 .session-status-breathing */
  running?: boolean;
  className?: string;
}

export function VendorIcon({ vendor, size = 12, running = false, className }: VendorIconProps) {
  // D4-1:vendor 保留兼容(统一品牌箭头,Claude/Codex 不再视觉区分);未来恢复 glyph 可在此分支。
  void vendor;
  const wrapperClassName = cn(
    'inline-flex shrink-0',
    running
      ? 'text-[var(--status-bar-accent)] session-status-breathing'
      : 'text-[var(--sidebar-list-muted)]',
    className,
  );

  return (
    <span className={wrapperClassName}>
      <BrandArrow size={size} />
    </span>
  );
}
