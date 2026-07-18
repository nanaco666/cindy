/**
 * userInfoSectionHover.test.ts
 * ---------------------------------------------------------------------------
 * Regression test for: user-message-selected-full-row-bg (回路 #2, 方案 D)
 *
 * Symptom: hover 高亮被压成药丸形,只盖中间按钮,不覆盖整条 66px 横栏。
 * Fix: hover 从内部按钮搬到外层 div;Flame 加 .flame-btn 标识 class,
 *      外层用 has-[.flame-btn:hover]:!bg-transparent 反向抑制,让 Flame
 *      hover 时整栏 hover 消失,仅显示 Flame 自己的胶囊高亮。
 *
 * 这份测试做静态源码扫描,确保以下契约不被未来的提交悄悄回退:
 * 1. 外层 div 接管整栏 hover (含 transition + has-[.flame-btn:hover] 抑制)
 * 2. 内部主按钮不再有 rounded-full / hover:bg-sidebar-item-hover (避免药丸 + 双层叠色)
 * 3. Flame button className 列表带有 'flame-btn' 标识符 (供 :has() 选择器钩取)
 */

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const sourcePath = resolve(
  __dirname,
  '..',
  'components',
  'sidebar',
  'UserInfoSection.tsx',
);
const source = readFileSync(sourcePath, 'utf8');
const localePath = resolve(__dirname, '..', 'i18n', 'locales', 'zh-CN', 'common.json');
const locale = JSON.parse(readFileSync(localePath, 'utf8')) as {
  sidebar: { user: { settingsLink: string; canaryBadge: string } };
};

// ── 改动 1: 外层 div 接管整栏 hover + Flame 反向抑制 ─────────────────────

describe('UserInfoSection — outer wrapper takes over full-row hover', () => {
  it('outer div has hover:bg-sidebar-item-hover (whole row lights up)', () => {
    // 锁定外层 div 那一整段 className 字符串字面量,避免误匹配到内部 fallback
    const outerDivMatch = source.match(
      /<div className="mt-auto border-t border-sidebar-border h-\[66px\][^"]*"/,
    );
    expect(outerDivMatch).not.toBeNull();
    expect(outerDivMatch![0]).toContain('hover:bg-sidebar-item-hover');
  });

  it('outer div uses transition-colors for smooth hover (matches list-item style)', () => {
    const outerDivMatch = source.match(
      /<div className="mt-auto border-t border-sidebar-border h-\[66px\][^"]*"/,
    );
    expect(outerDivMatch).not.toBeNull();
    expect(outerDivMatch![0]).toContain('transition-colors');
  });

  it('outer div uses has-[.flame-btn:hover]:!bg-transparent to suppress row hover when Flame is hovered', () => {
    // 方案 D 核心: Flame 是上层独立按钮,鼠标移到 Flame 上时整栏 hover 必须让位
    const outerDivMatch = source.match(
      /<div className="mt-auto border-t border-sidebar-border h-\[66px\][^"]*"/,
    );
    expect(outerDivMatch).not.toBeNull();
    expect(outerDivMatch![0]).toContain('has-[.flame-btn:hover]:!bg-transparent');
  });
});

describe('UserInfoSection — version label', () => {
  it('shows only the app version without the retired XD.Inc prefix', () => {
    expect(source).toContain('{appDisplayVersion}');
    expect(source).not.toContain('XD.Inc - {appDisplayVersion}');
  });
});

describe('UserInfoSection — Canary avatar badge', () => {
  it('shows only the shield decoration when isCanary is true', () => {
    expect(source).toContain("import { Flame, Shield } from 'lucide-react';");
    expect(source).toContain('const { user, isCanary } = useAuth();');
    expect(source).toContain('{isCanary && (');
    expect(source).toContain("aria-label={t('sidebar.user.canaryBadge')}");
    expect(source).not.toContain("isCanary && 'ring-[1.5px] ring-foreground'");
    expect(source).not.toContain("user.role === 'admin'");
    expect(locale.sidebar.user.canaryBadge).toBe('灰度用户');
  });
});

// ── 改动 2: 内部主按钮去掉冗余 hover / 圆角 ───────────────────────────

describe('UserInfoSection — inner main button no longer owns hover background', () => {
  it('does not contain a "rounded-full" + "hover:bg-sidebar-item-hover" combo on the same className line', () => {
    // 旧 className 长这样: 'flex w-full items-center gap-[10px] rounded-full',
    // 我们要求这一行(主按钮第一行 cn() 字面量)不再带 rounded-full
    expect(source).not.toMatch(/'flex w-full items-center gap-\[10px\] rounded-full'/);
  });

  it('main button does not own hover:bg-sidebar-item-hover (delegated to outer div)', () => {
    // 旧第二行: 'transition-colors text-left hover:bg-sidebar-item-hover',
    expect(source).not.toMatch(
      /'transition-colors text-left hover:bg-sidebar-item-hover'/,
    );
  });

  it('main button keeps its layout classes (flex / w-full / gap)', () => {
    // 保留布局,只去掉视觉
    expect(source).toMatch(/'flex min-w-0 flex-1 items-center gap-\[10px\]'/);
  });

  it('main button keeps text-left for left-aligned content', () => {
    expect(source).toMatch(/'text-left'/);
  });

  it('main button preserves onClick / role="link" / aria-label (跳转和无障碍不破)', () => {
    expect(source).toContain('onClick={handleClick}');
    expect(source).toContain('role="link"');
    expect(source).toContain("aria-label={t('sidebar.user.settingsLink', { name: user.name })}");
    expect(locale.sidebar.user.settingsLink).toBe('设置, 当前用户: {{name}}');
  });
});

// ── 改动 3: Flame button 加 .flame-btn 标识 class ────────────────────────

describe('UserInfoSection — Flame button carries .flame-btn marker class', () => {
  it("Flame button className list includes 'flame-btn' as the first entry", () => {
    // 关键: 外层 div 的 has-[.flame-btn:hover] 选择器必须能钩到这个 class
    expect(source).toMatch(/'flame-btn',\s*\n\s*'flex h-\[38px\] w-\[38px\]/);
  });

  it("Flame button retains its own hover:bg-sidebar-item-hover (capsule highlight when hovered)", () => {
    // Flame 自己的胶囊 hover 不能丢,这是方案 D 的视觉表达
    expect(source).toMatch(
      /'transition-colors hover:bg-sidebar-item-hover'/,
    );
  });

  it('Flame button keeps rounded-full + 38x38 size (capsule shape unchanged)', () => {
    expect(source).toContain('flex h-[38px] w-[38px] shrink-0 items-center justify-center rounded-full');
  });
});
