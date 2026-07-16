/**
 * ClaudeMark —— Anthropic 官方 wordmark "AA" path,单色 currentColor 灰阶友好。
 *
 * SVG path 来自 simpleicons.org 收录的 Anthropic 标准 mark(viewBox 24×24)。
 * Light/Dark 主题切换由父级 fill 颜色驱动(currentColor 继承)。
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
        d="M13.827 3.52h3.603L24 20h-3.603l-6.57-16.48zm-7.258 0h3.767L16.906 20h-3.674l-1.343-3.461H5.017l-1.344 3.461H0L6.57 3.52zm4.132 9.876L8.453 7.247 6.205 13.396z"
        fill="currentColor"
      />
    </svg>
  );
}
