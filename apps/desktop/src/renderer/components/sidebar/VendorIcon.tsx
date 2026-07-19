/**
 * VendorIcon — sidebar session 行的 vendor + running 状态指示器
 * ---------------------------------------------------------------------------
 * D4-1(用户拍板):Claude(AA 字标)/Codex(六瓣)统一替换为品牌箭头(BrandArrow),
 *   常规任务/会话行首视觉统一,vendor 不再区分;vendor prop 保留兼容(未来恢复
 *   glyph 可在此分支)。Claude/Codex 视觉不再区分——若日后要区分再单独加辅助标识。
 *
 * 状态(不变):
 *   - idle (默认)   : Stone 灰 #737373 / dark #a3a3a3
 *   - running=true  : 品牌红系(== --sidebar-item-active,E1D 侧栏强调态;与 E5D 状态点新橙解耦——状态点归橙,行首强调箭头归红)+ session-breathing 呼吸
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
  /** 覆盖默认取色(如红胶囊选中态传反白前景 —— 用户规则 2026-07-19:选中态上
   *  所有前景元素与文字同色);running 呼吸动画不受影响。 */
  colorClassName?: string;
}

export function VendorIcon({ vendor, size = 12, running = false, className, colorClassName }: VendorIconProps) {
  // D4-1:vendor 保留兼容(统一品牌箭头,Claude/Codex 不再视觉区分);未来恢复 glyph 可在此分支。
  void vendor;
  const wrapperClassName = cn(
    'inline-flex shrink-0',
    running && 'session-status-breathing',
    colorClassName ?? (running ? 'text-sidebar-item-active' : 'text-[hsl(var(--sidebar-muted))]'),
    className,
  );

  return (
    <span className={wrapperClassName}>
      <BrandArrow size={size} />
    </span>
  );
}
