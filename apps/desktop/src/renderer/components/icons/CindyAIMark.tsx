/**
 * CindyAIMark —— CINDY 品牌 small icon(旗形箭头),单色 currentColor 灰阶友好。
 *
 * SVG path 来自品牌包 SMALL ICON(原始 viewBox 48×48)。
 * viewBox x 取 -3.5 做光学居中:旗形箭头视觉重心偏左,整体右移约 1px(size 13 时)才显居中。
 * Light/Dark 主题切换由父级 fill 颜色驱动(currentColor 继承),与 ClaudeMark / CodexMark 同模式。
 */

interface CindyAIMarkProps {
  size?: number;
  className?: string;
}

export function CindyAIMark({ size = 14, className }: CindyAIMarkProps) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="-3.5 0 48 48"
      xmlns="http://www.w3.org/2000/svg"
      className={className}
      aria-hidden
    >
      <path
        d="M38 21.1894V26.8105L11 46V30.8394L20.5323 23.9942L11 17.149V2L38 21.1894Z"
        fill="currentColor"
      />
    </svg>
  );
}
