import type { Theme } from '../types';
import cindyLogoDark from '../../assets/cindy-logo-dark.png';

/*
 * CINDY Dark — 品牌红 CTA + 深灰底(#2A2828)+ AA 正文;U2 二级信息色忠于 Figma 原值。
 * 值的唯一权威: 2026-07-17-cindy-token-decision-table.md §3(用户 U8 批准)。
 * 每个 override 注释来源(直映/插值比例/裁决);零自由裁量。
 */

const overrides = {
  surface: '#2A2828', // 直映: 背景
  'surface-hsl': '0.0 2.4% 16.1%', // 直映: 背景 -> HSL
  'surface-elevated': '#312F2F', // 直映: 卡片/输入框
  'surface-elevated-soft': '#2F2D2D', // 插值: 背景->卡片 65%
  'surface-card-ivory': '#312F2F', // 直映: 卡片/输入框
  'surface-chip': '#2F2D2D', // 插值: Light 40% / Dark 75%
  'surface-chip-alt': '#2F2D2D', // 插值: 65%
  'surface-hover': '#2F2D2D', // 插值: hover
  'surface-hover-soft': '#2B2929', // 插值: 20%
  'surface-hover-hsl': '0.0 2.2% 18.0%', // 插值: hover -> HSL
  'surface-on-card': '#2A2828', // 裁决: 中性反相前景,不作红 CTA 专用
  'status-badge-fg': '#1F1F1F', // §7 必炸点:值经队列震荡后按 HEAD 冻结(#1F1F1F,5.61:1 × #FF6600 ≥4.5),批准依据:用户亲批方案 2026-07-17
  'border-default': '#434343', // 直映: 边框
  'border-default-hsl': '0.0 0.0% 26.3%', // 边框 -> HSL
  'border-shadcn-hsl': '0.0 0.0% 26.3%', // 边框 -> HSL
  'border-transparent-mixed': '#434343', // light transparent / dark 边框
  'text-primary': '#D4D4D4', // 直映: 正文
  'text-primary-on-dark': '#FFFFFF', // 深底/红底前景白
  'text-primary-emphasis': '#FFFFFF', // 强调正文
  'text-primary-inv': '#2A2828', // 反相文字
  'text-primary-body-strong': '#D4D4D4', // 直映: 正文
  'text-primary-hsl': '0.0 0.0% 83.1%', // 正文 -> HSL
  'text-secondary': '#6F6F6F', // 直映: 二级信息; U2 例外
  'text-secondary-cross': '#6F6F6F', // 直映: 二级信息; U2 例外
  'text-secondary-mid': '#BFC1C4', // 整改: 小正文 AA
  'text-tertiary': '#BFC1C4', // 整改: 非 U2 token AA
  'text-tertiary-stone': '#BFC1C4', // 整改: 非 U2 token AA
  'text-tertiary-mid': '#BFC1C4', // 整改: 非 U2 token AA
  'text-tertiary-hsl': '216.0 4.1% 75.9%', // tertiary -> HSL
  'text-disabled': '#BFC1C4', // 整改: 文档矩阵 AA; 禁用视觉用 opacity
  'text-disabled-tertiary': '#BFC1C4', // 整改: disabled tertiary AA
  'accent-cta-bg': '#DF0C27', // 裁决: 品牌红 CTA
  'accent-cta-bg-pure': '#DF0C27', // 裁决: 品牌红 CTA
  'accent-emphasis': '#DF0C27', // 裁决: 品牌红 CTA
  'accent-soft': '#A61629', // 品牌深红 soft
  'accent-hover': '#A61629', // 品牌深红 hover/pressed
  'accent-pure-cta-fg': '#FFFFFF', // 红 CTA 专用白前景
  accent: '0.0 2.2% 18.0%', // 裁决: shadcn 中性 hover
  'agent-actions-rail': '#434343', // 边框/rail
  'ask-checkbox-border': '#BFC1C4', // AA checkbox border
  background: '0.0 2.4% 16.1%', // 背景 -> HSL
  'chat-input-bg': '#312F2F', // 输入框
  'chat-input-chip-border': '#434343', // 边框
  'chat-input-text': '#D4D4D4', // 正文
  'color-primary': '#D4D4D4', // 正文
  'caret-accent': '#417CDD', // 用户改稿 2026-07-18:光标撤红改回蓝(对齐 focus 蓝 #417CDD)
  'confirm-bg': '#312F2F', // 卡片
  'confirm-btn-primary-bg': '#DF0C27', // 品牌红 CTA
  'confirm-btn-primary-text': '#FFFFFF', // CTA 白字
  'confirm-btn-secondary-border': '#434343', // 边框
  'confirm-btn-secondary-hover': 'rgba(255, 255, 255, 0.08)', // 中性 alpha hover
  'confirm-btn-secondary-text': '#D4D4D4', // 正文
  'confirm-title': '#D4D4D4', // 正文
  'drop-overlay-bg': 'rgba(223, 12, 39, 0.10)', // 品牌红 10% alpha
  'file-chip-bg': '#3B3A3A', // neutral chip thumb
  'file-remove-bg': '#BFC1C4', // AA remove affordance
  'info-700': '#93C5FD', // 信息/链接蓝
  'migration-bar-fill': '#DF0C27', // progress 品牌红
  'migration-bar-track': '#2F2D2D', // track surface
  'model-trigger-hover': '#2F2D2D', // hover
  'msg-link': '#93C5FD', // 链接蓝
  'msg-scrollbar-hover': '#504F4F', // 弱档
  'msg-user-bg': '#312F2F', // 卡片
  muted: '0.0 2.2% 18.0%', // muted surface
  'muted-foreground': '216.0 4.1% 75.9%', // AA muted 前景
  'perm-auto-selected-text': '#00D9C5', // auto approval 功能色
  'perm-allow-btn-bg': '#DF0C27', // 允许 CTA 品牌红
  'perm-allow-btn-text': '#FFFFFF', // 允许 CTA 白字
  'perm-allow-kbd-bg': '#2F2D2D', // kbd bg
  'perm-allow-kbd-border': '#434343', // 边框
  'perm-code-bg': '#2B2929', // code bg
  'perm-item-selected-bg': '#2F2D2D', // selected bg
  'plan-outline-active-bg': '#2F2D2D', // active bg
  'plan-toolbar-btn-hover-bg': '#2F2D2D', // hover bg
  popover: '0.0 2.1% 18.8%', // elevated -> HSL
  'primary-foreground': '0.0 0.0% 100.0%', // 白前景
  'search-match-fg': '0.0 0.0% 83.1%', // search fg
  secondary: '0.0 2.2% 18.0%', // neutral secondary
  'settings-btn-primary-text': '#FFFFFF', // 红 CTA 白字
  'settings-btn-secondary-hover-bg': '#2F2D2D', // secondary hover
  'text-placeholder': '#BFC1C4', // 整改: placeholder AA; 透明度由组件控制
  'settings-integration-avatar-bg': '#2F2D2D', // avatar chip
  'settings-logout-bg': '#312F2F', // 卡片
  'settings-menu-bg-hover': '#2B2929', // menu hover 20%
  'settings-menu-bg-selected': '#2F2D2D', // menu selected
  'settings-source-link': '#93C5FD', // 可访问链接蓝
  'settings-theme-auto-dark': '#2A2828', // Auto 预览 dark 固定
  'send-btn-bg': '#EEEEEE', // 红色新规:常规发送按钮反相中性
  'send-btn-icon': '#252222', // 反相中性图标
  'send-btn-hover-bg': '#E2E2E2', // 反相中性 hover
  'send-btn-pressed-bg': '#D4D4D4', // 反相中性 pressed
  'sidebar-action-icon': '216.0 4.1% 75.9%', // AA action icon
  'sidebar-item-active': '352.3 89.8% 46.1%', // active 品牌红
  'sidebar-item-active-foreground': '#D4D4D4', // active 红底前景
  'splash-bg': '0.0 2.4% 16.1%', // 背景 -> HSL
  'splash-text': '216.0 4.1% 75.9%', // AA splash text
  'splash-text-destructive': '0.0 0.0% 100.0%', // destructive splash text
  'splash-text-muted': '216.0 4.1% 75.9%', // AA splash muted
  'titlebar-icon': '216.0 4.1% 75.9%', // AA icon
  'tooltip-bg': '#2A2828', // tooltip 深底
  'tooltip-text': '#FFFFFF', // tooltip 白字
  'update-btn-border': '#DF0C27', // 更新 CTA 红边
  'update-btn-text': '#DF0C27', // 更新 CTA 红字
  'accent-foreground': '0.0 0.0% 83.1%', // 裁决: accent 成对中性前景
  'panel-bg': '#2A2828', // 依赖 D1: 注册后直映背景
  primary: '352.3 89.8% 46.1%', // 品牌红 primary
  ring: '217.2 91.2% 59.8%', // 固定蓝
  'settings-theme-auto-light': '#EDEDED', // Auto 预览 light 固定
  foreground: '0.0 0.0% 83.1%', // alias closure 直接值
  border: '0.0 0.0% 26.3%', // alias closure
  input: '0.0 0.0% 26.3%', // alias closure
  'secondary-foreground': '0.0 0.0% 83.1%', // alias closure
  'popover-foreground': '0.0 0.0% 83.1%', // alias closure
  titlebar: '0.0 2.4% 16.1%', // alias closure: surface
  'titlebar-border': '0.0 0.0% 26.3%', // alias closure: border
  'titlebar-button-hover': '0.0 2.2% 18.0%', // alias closure: hover
  'titlebar-control-hover': '0.0 2.2% 18.0%', // alias closure: hover
  sidebar: '0.0 2.4% 16.1%', // alias closure: surface
  'sidebar-border': '0.0 0.0% 26.3%', // alias closure: border
  'sidebar-item-hover': '0.0 2.2% 18.0%', // alias closure: hover
  'sidebar-search-bg': '0.0 2.4% 16.1%', // alias closure: surface
  'sidebar-muted': '216.0 4.1% 75.9%', // alias closure: tertiary
  'surface-translucent-sidebar': 'rgba(18, 15, 15, 0.75)', // 用户观感定稿(2026-07-18:75%)
} as const;

export const cindyDark: Theme = {
  id: 'cindy-dark',
  name: 'CINDY Dark',
  type: 'dark',
  colors: overrides,
  // U5 品牌版 logo:白字+红箭头 wordmark(深底可见),logoScale=1 对齐默认 logo 视觉大小。
  logo: cindyLogoDark,
  logoScale: 1,
};
