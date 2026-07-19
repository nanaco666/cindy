/**
 * VendorIcon — sidebar session 行的 vendor + running 状态指示器
 * ---------------------------------------------------------------------------
 * 2026-07-19(用户拍板,撤销 D4-1):恢复 Claude(AA 字标)/Codex(六瓣)厂商 glyph。
 *   D4-1 曾统一替换为品牌箭头(BrandArrow),实测后发现依赖图标区分 agent 类型的
 *   场景(创建自动化 chips、侧栏混排)全部失效,故换回按 vendor 分支渲染。
 *
 * 状态(不变):
 *   - idle (默认)   : Stone 灰 #737373 / dark #a3a3a3
 *   - running=true  : 品牌红系(== --sidebar-item-active,E1D 侧栏强调态;与 E5D 状态点新橙解耦——状态点归橙,行首强调图标归红)+ session-breathing 呼吸
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
  /** 覆盖默认取色(如红胶囊选中态传反白前景 —— 用户规则 2026-07-19:选中态上
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
