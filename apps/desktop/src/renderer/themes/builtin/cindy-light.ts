import type { Theme } from '../types';
import cindyLogoLight from '../../assets/cindy-logo-light.png';

/*
 * CINDY Light — 品牌红 CTA + 中性灰底(#EDEDED)+ AA 正文;U2 二级信息色忠于 Figma 原值。
 * 值的唯一权威: 2026-07-17-cindy-token-decision-table.md §3(用户 U8 批准)。
 * 每个 override 注释来源(直映/插值比例/裁决);零自由裁量。
 */

const overrides = {
  surface: '#EDEDED', // 直映: 背景
  'surface-hsl': '0.0 0.0% 92.9%', // 直映: 背景 -> HSL
  'surface-elevated': '#F8F8F8', // 直映: 卡片/输入框
  'surface-elevated-soft': '#F4F4F4', // 插值: 背景->卡片 65%
  'surface-card-ivory': '#F8F8F8', // 直映: 卡片/输入框
  'surface-chip': '#F1F1F1', // 插值: Light 40% / Dark 75%
  'surface-chip-alt': '#F4F4F4', // 插值: 65%
  'surface-hover': '#F1F1F1', // 插值: hover
  'surface-hover-soft': '#EFEFEF', // 插值: 20%
  'surface-hover-hsl': '0.0 0.0% 94.5%', // 插值: hover -> HSL
  'surface-on-card': '#FFFFFF', // 裁决: 中性反相前景,不作红 CTA 专用
  'status-badge-fg': '#1F1F1F', // §7 必炸点(lead 裁决 2026-07-17):× status-bar-accent #FF6600=5.93 ≥4.5
  'border-default': '#DCDFE3', // 直映: 边框
  'border-default-hsl': '214.3 11.1% 87.6%', // 边框 -> HSL
  'border-shadcn-hsl': '214.3 11.1% 87.6%', // 边框 -> HSL
  'border-transparent-mixed': 'transparent', // light transparent / dark 边框
  'text-primary': '#3C3F43', // 直映: 正文
  'text-primary-on-dark': '#FFFFFF', // 深底/红底前景白
  'text-primary-emphasis': '#2E3237', // 强调正文
  'text-primary-inv': '#FFFFFF', // 反相文字
  'text-primary-body-strong': '#3C3F43', // 直映: 正文
  'text-primary-hsl': '214.3 5.5% 24.9%', // 正文 -> HSL
  'text-secondary': '#9A9DA3', // 直映: 二级信息; U2 例外
  'text-secondary-cross': '#9A9DA3', // 直映: 二级信息; U2 例外
  'text-secondary-mid': '#686B72', // 整改: 小正文 AA
  'text-tertiary': '#686B72', // 整改: 非 U2 token AA
  'text-tertiary-stone': '#686B72', // 整改: 非 U2 token AA
  'text-tertiary-mid': '#686B72', // 整改: 非 U2 token AA
  'text-tertiary-hsl': '222.0 4.6% 42.7%', // tertiary -> HSL
  'text-disabled': '#686B72', // 整改: 文档矩阵 AA; 禁用视觉用 opacity
  'text-disabled-tertiary': '#686B72', // 整改: disabled tertiary AA
  'accent-cta-bg': '#DF0C27', // 裁决: 品牌红 CTA
  'accent-cta-bg-pure': '#DF0C27', // 裁决: 品牌红 CTA
  'accent-emphasis': '#DF0C27', // 裁决: 品牌红 CTA
  'accent-soft': '#A61629', // 品牌深红 soft
  'accent-hover': '#A61629', // 品牌深红 hover/pressed
  'accent-pure-cta-fg': '#FFFFFF', // 红 CTA 专用白前景
  accent: '0.0 0.0% 94.5%', // 裁决: shadcn 中性 hover
  'agent-actions-rail': '#DCDFE3', // 边框/rail
  'ask-checkbox-border': '#686B72', // AA checkbox border
  background: '0.0 0.0% 92.9%', // 背景 -> HSL
  'chat-input-bg': '#F8F8F8', // 输入框
  'chat-input-chip-border': '#DCDFE3', // 边框
  'chat-input-text': '#3C3F43', // 正文
  'color-primary': '#3C3F43', // 正文
  'confirm-bg': '#F8F8F8', // 卡片
  'confirm-btn-primary-bg': '#DF0C27', // 品牌红 CTA
  'confirm-btn-primary-text': '#FFFFFF', // CTA 白字
  'confirm-btn-secondary-border': '#DCDFE3', // 边框
  'confirm-btn-secondary-hover': 'rgba(0, 0, 0, 0.06)', // 中性 alpha hover
  'confirm-btn-secondary-text': '#3C3F43', // 正文
  'confirm-title': '#3C3F43', // 正文
  'drop-overlay-bg': 'rgba(223, 12, 39, 0.10)', // 品牌红 10% alpha
  'file-chip-bg': '#D8D9DB', // neutral chip thumb
  'file-remove-bg': '#686B72', // AA remove affordance
  'info-700': '#1D4ED8', // 信息/链接蓝
  'migration-bar-fill': '#DF0C27', // progress 品牌红
  'migration-bar-track': '#F1F1F1', // track surface
  'model-trigger-hover': '#F1F1F1', // hover
  'msg-link': '#1D4ED8', // 链接蓝
  'msg-scrollbar-hover': '#D8D9DB', // 弱档
  'msg-user-bg': '#F8F8F8', // 卡片
  muted: '0.0 0.0% 94.5%', // muted surface
  'muted-foreground': '222.0 4.6% 42.7%', // AA muted 前景
  'perm-auto-selected-text': '#1D4ED8', // auto approval 功能色
  'perm-allow-btn-bg': '#DF0C27', // 允许 CTA 品牌红
  'perm-allow-btn-text': '#FFFFFF', // 允许 CTA 白字
  'perm-allow-kbd-bg': '#F4F4F4', // kbd bg
  'perm-allow-kbd-border': '#DCDFE3', // 边框
  'perm-code-bg': '#F5F5F5', // code bg
  'perm-item-selected-bg': '#F1F1F1', // selected bg
  'plan-outline-active-bg': '#F1F1F1', // active bg
  'plan-toolbar-btn-hover-bg': '#F1F1F1', // hover bg
  popover: '0.0 0.0% 97.3%', // elevated -> HSL
  'primary-foreground': '0.0 0.0% 100.0%', // 白前景
  'search-match-fg': '214.3 5.5% 24.9%', // search fg
  secondary: '0.0 0.0% 94.5%', // neutral secondary
  'settings-btn-primary-text': '#FFFFFF', // 红 CTA 白字
  'settings-btn-secondary-hover-bg': '#F1F1F1', // secondary hover
  'text-placeholder': '#686B72', // 整改: placeholder AA; 透明度由组件控制
  'settings-integration-avatar-bg': '#F8F8F8', // avatar chip
  'settings-logout-bg': '#F8F8F8', // 卡片
  'settings-menu-bg-hover': '#EFEFEF', // menu hover 20%
  'settings-menu-bg-selected': '#F1F1F1', // menu selected
  'settings-source-link': '#1D4ED8', // 可访问链接蓝
  'settings-theme-auto-dark': '#2A2828', // Auto 预览 dark 固定
  'sidebar-action-icon': '222.0 4.6% 42.7%', // AA action icon
  'sidebar-item-active': '352.3 89.8% 46.1%', // active 品牌红
  'splash-bg': '0.0 0.0% 92.9%', // 背景 -> HSL
  'splash-text': '222.0 4.6% 42.7%', // AA splash text
  'splash-text-destructive': '214.3 5.5% 24.9%', // destructive splash text
  'splash-text-muted': '222.0 4.6% 42.7%', // AA splash muted
  'titlebar-icon': '222.0 4.6% 42.7%', // AA icon
  'tooltip-bg': '#3C3F43', // tooltip 深底
  'tooltip-text': '#FFFFFF', // tooltip 白字
  'update-btn-border': '#DF0C27', // 更新 CTA 红边
  'update-btn-text': '#DF0C27', // 更新 CTA 红字
  'accent-foreground': '214.3 5.5% 24.9%', // 裁决: accent 成对中性前景
  'panel-bg': '#EDEDED', // 依赖 D1: 注册后直映背景
  primary: '352.3 89.8% 46.1%', // 品牌红 primary
  ring: '217.2 91.2% 59.8%', // 固定蓝
  'settings-theme-auto-light': '#EDEDED', // Auto 预览 light 固定
  foreground: '214.3 5.5% 24.9%', // alias closure 直接值
  border: '214.3 11.1% 87.6%', // alias closure
  input: '214.3 11.1% 87.6%', // alias closure
  'secondary-foreground': '214.3 5.5% 24.9%', // alias closure
  'popover-foreground': '214.3 5.5% 24.9%', // alias closure
  titlebar: '0.0 0.0% 92.9%', // alias closure: surface
  'titlebar-border': '214.3 11.1% 87.6%', // alias closure: border
  'titlebar-button-hover': '0.0 0.0% 94.5%', // alias closure: hover
  'titlebar-control-hover': '0.0 0.0% 94.5%', // alias closure: hover
  sidebar: '0.0 0.0% 92.9%', // alias closure: surface
  'sidebar-border': '214.3 11.1% 87.6%', // alias closure: border
  'sidebar-item-hover': '0.0 0.0% 94.5%', // alias closure: hover
  'sidebar-search-bg': '0.0 0.0% 92.9%', // alias closure: surface
  'sidebar-muted': '222.0 4.6% 42.7%', // alias closure: tertiary
} as const;

export const cindyLight: Theme = {
  id: 'cindy-light',
  name: 'CINDY Light',
  type: 'light',
  colors: overrides,
  // U5 品牌版 logo:黑字+红箭头 wordmark(浅底可见),logoScale=1 对齐默认 logo 视觉大小。
  logo: cindyLogoLight,
  logoScale: 1,
};
