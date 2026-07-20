/**
 * ClaudeMark —— Claude Code 官方像素方块脸 mark(CLI 品牌),Anthropic 陶土橙
 * #d97757 固定品牌色(跨主题一致,语义豁免——同 DESIGN.md Toast 三色逻辑,
 * 不走主题 token,不吃 currentColor)。
 *
 * 2026-07-20 由单色 Anthropic "AA" wordmark 换成彩色品牌 mark(参考 open-design
 * 的 agent-icons 处理:品牌 mark 原样渲染不做主题染色,辨识度优先)。父级传入
 * 的着色 class 对本 mark 无效(fill 固定),布局类照常生效。
 */

interface ClaudeMarkProps {
  size?: number;
  className?: string;
}

export function ClaudeMark({ size = 14, className }: ClaudeMarkProps) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      xmlns="http://www.w3.org/2000/svg"
      className={className}
      aria-hidden
    >
      <path
        fill="#d97757"
        fillRule="evenodd"
        clipRule="evenodd"
        d="M20.998 10.949H24v3.102h-3v3.028h-1.487V20H18v-2.921h-1.487V20H15v-2.921H9V20H7.488v-2.921H6V20H4.487v-2.921H3V14.05H0v-3.1h3V5h17.998zM6 10.949h1.488V8.102H6zm10.51 0H18V8.102h-1.49z"
      />
    </svg>
  );
}
