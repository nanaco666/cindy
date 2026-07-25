/**
 * Regression coverage for installed and restorable Plugin card actions.
 * [PROTOCOL]: 变更时更新此头部，然后检查 CLAUDE.md
 * @vitest-environment jsdom
 */

import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import type { ReactNode } from 'react';

vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}));
vi.mock('@/components/ui/tooltip', () => ({
  Tip: ({ text, children }: { text: string; children: ReactNode }) => (
    <span data-tooltip={text}>{children}</span>
  ),
}));
// GhostPluginPage 顶层引用 useAuth(团队共享分组按 membership 门控);卡片
// 测试不涉及登录态,mock 掉以免拉起 AuthContext 的真实 i18n/store 依赖链。
vi.mock('@/contexts/AuthContext', () => ({
  useAuth: () => ({ user: null }),
}));

import {
  GhostPluginCard,
  InstalledGhostShortcut,
  type GhostPluginCardItem,
} from '../GhostPluginPage';

const uninstalledPlugin: GhostPluginCardItem = {
  id: 'filo-google',
  name: 'Filo Google',
  description: 'Google services',
  version: '1.0.0',
  origin: 'builtin',
  enabled: false,
  canUse: false,
  installed: false,
};

describe('GhostPluginCard', () => {
  it('shows the installed shortcut name through the shared Tooltip', () => {
    const onSelect = vi.fn();
    const item = {
      ...uninstalledPlugin,
      installed: true,
      enabled: true,
      canUse: true,
    };
    const { container } = render(<InstalledGhostShortcut item={item} onSelect={onSelect} />);

    const button = screen.getByRole('button', { name: 'Filo Google' });
    expect(container.querySelector('[data-tooltip="Filo Google"]')).toBeTruthy();
    expect(button.getAttribute('title')).toBeNull();
    fireEvent.click(button);
    expect(onSelect).toHaveBeenCalledWith('filo-google');
  });

  it('opens an uninstalled plugin detail instead of disabling the card', () => {
    const onSelect = vi.fn();
    const onAction = vi.fn();
    const { container } = render(
      <GhostPluginCard
        item={uninstalledPlugin}
        onSelect={onSelect}
        onAction={onAction}
        restoring={false}
      />,
    );

    const detailButton = screen.getByRole('button', { name: 'Filo Google' });
    const card = container.querySelector('article');
    expect((detailButton as HTMLButtonElement).disabled).toBe(false);
    expect(card?.className).not.toContain('border-dashed');
    expect(card?.className).not.toContain('opacity-80');
    const restoreButton = screen.getByRole('button', {
      name: 'settings.ghosts.page.restoreAria',
    });
    expect(restoreButton.textContent).toBe('settings.ghosts.restore');
    fireEvent.click(detailButton);

    expect(onSelect).toHaveBeenCalledTimes(1);
    expect(onAction).not.toHaveBeenCalled();
  });

  it('only disables detail navigation while the plugin is being restored', () => {
    render(
      <GhostPluginCard item={uninstalledPlugin} onSelect={vi.fn()} onAction={vi.fn()} restoring />,
    );

    expect(
      (screen.getByRole('button', { name: 'Filo Google' }) as HTMLButtonElement).disabled,
    ).toBe(true);
  });

  it('disables Use when an installed plugin has no command', () => {
    render(
      <GhostPluginCard
        item={{ ...uninstalledPlugin, installed: true, enabled: true }}
        onSelect={vi.fn()}
        onAction={vi.fn()}
        restoring={false}
      />,
    );

    expect(
      (screen.getByRole('button', { name: 'settings.ghosts.page.useAria' }) as HTMLButtonElement)
        .disabled,
    ).toBe(true);
  });

  it('renders project-scope enabled state and respects the global-disabled lock', () => {
    render(
      <GhostPluginCard
        item={{ ...uninstalledPlugin, installed: true, enabled: false, canUse: false }}
        onSelect={vi.fn()}
        onAction={vi.fn()}
        onToggle={vi.fn()}
        effectiveEnabled={false}
        toggleDisabled
        restoring={false}
      />,
    );

    const toggle = screen.getByRole('switch', { name: 'settings.ghosts.enableAria' });
    expect((toggle as HTMLButtonElement).disabled).toBe(true);
    expect(toggle.getAttribute('data-state')).toBe('unchecked');
  });

  it('renders a functional media symbol when the plugin package has no icon', () => {
    const { container } = render(
      <GhostPluginCard
        item={{
          ...uninstalledPlugin,
          id: 'lizi-mivo',
          name: 'Lizi Mivo',
          origin: 'external',
        }}
        onSelect={vi.fn()}
        onAction={vi.fn()}
        restoring={false}
      />,
    );

    expect(container.querySelector('.lucide-image')).toBeTruthy();
    expect(screen.queryByText('M')).toBeNull();
    expect(
      screen.getByRole('button', { name: 'settings.ghosts.page.installAria' }).textContent,
    ).toBe('settings.ghosts.page.installAction');
  });

  it('renders the Mermaid fallback symbol on the theme elevated surface', () => {
    const { container } = render(
      <GhostPluginCard
        item={{
          ...uninstalledPlugin,
          id: 'cindy-mermaid',
          name: 'Cindy Mermaid',
        }}
        onSelect={vi.fn()}
        onAction={vi.fn()}
        restoring={false}
      />,
    );

    const fallbackIcon = container.querySelector('.lucide-workflow');
    expect(fallbackIcon).toBeTruthy();
    expect(fallbackIcon?.parentElement?.className).toContain('var(--surface-elevated)');
  });
});
