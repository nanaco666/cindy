/**
 * userInfoSectionHover.test.ts
 * ---------------------------------------------------------------------------
 * Regression test for: user-message-selected-full-row-bg (回路 #2, 方案 D)
 *
 * Current contract: UserInfoSection follows the CREATE AGENT sidebar capsule
 * design. Flame keeps a .flame-btn marker class, but it now sits inside the
 * compact account pill instead of the old 66px full-row footer.
 *
 * 这份测试做静态源码扫描,确保以下契约不被未来的提交悄悄回退:
 * 1. 外层 div keeps the sidebar footer slot, while the visible account card is
 *    the rounded tokenized capsule.
 * 2. 内部主按钮不再有 hover:bg-sidebar-item-hover (避免双层叠色)
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
  sidebar: { user: { settingsLink: string } };
};

// ── 改动 1: 外层 footer slot + tokenized account capsule ────────────────

describe('UserInfoSection — outer wrapper takes over full-row hover', () => {
  it('outer div keeps the sidebar footer slot', () => {
    expect(source).toContain('mt-auto px-3 pb-3 pt-2');
  });

  it('visible user card uses the rounded tokenized capsule style', () => {
    expect(source).toContain(
      'flex h-10 items-center rounded-full border border-[var(--sidebar-user-card-border)] bg-[var(--sidebar-user-card-bg)] px-[7px]',
    );
  });

  it('visible user card uses the CREATE AGENT sidebar user tokens', () => {
    expect(source).toContain('border-[var(--sidebar-user-card-border)]');
    expect(source).toContain('bg-[var(--sidebar-user-card-bg)]');
    expect(source).toContain('text-[var(--sidebar-user-card-text)]');
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
    expect(source).toMatch(/'flame-btn',\s*\n\s*'flex h-\[19px\] w-\[19px\]/);
  });

  it("Flame button retains its own hover:bg-sidebar-item-hover (capsule highlight when hovered)", () => {
    // Flame 自己的胶囊 hover 不能丢,这是方案 D 的视觉表达
    expect(source).toMatch(
      /'transition-colors hover:bg-sidebar-item-hover'/,
    );
  });

  it('Flame button keeps rounded-full + 19x19 size inside the account capsule', () => {
    expect(source).toContain(
      'flex h-[19px] w-[19px] shrink-0 items-center justify-center rounded-full',
    );
    expect(source).toContain(
      'border border-[var(--sidebar-user-card-border)] bg-[var(--sidebar-user-card-bg)]',
    );
  });
});
