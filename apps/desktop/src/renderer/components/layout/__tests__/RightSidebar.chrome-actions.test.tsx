// @vitest-environment jsdom

import { render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string) => key,
  }),
}));

vi.mock('@/features/right-sidebar/RightSidebarShell', () => ({
  RightSidebarShell: () => null,
}));

import { CHROME_ACTIONS_GEOMETRY } from '../chromeActionsGeometry';
import { RightSidebar } from '../RightSidebar';

/** 渲染只覆盖 Windows titlebar app-region 结构所需的最小 RightSidebar props。 */
function renderSidebar(isMac: boolean): void {
  render(
    <RightSidebar
      isCollapsed={false}
      width={320}
      isMac={isMac}
      sessionId="session-a"
      workdir="/repo"
      remoteHostId={null}
    />,
  );
}

describe('RightSidebar Windows chrome actions hit hole', () => {
  it('keeps a descendant no-drag hole aligned with the floating ChromeActions', () => {
    renderSidebar(false);

    const spacer = screen.getByTestId('right-sidebar-titlebar-spacer');
    const hitHole = screen.getByTestId('right-sidebar-chrome-actions-hit-hole');

    expect(spacer.contains(hitHole)).toBe(true);
    expect(
      (spacer.style as CSSStyleDeclaration & { WebkitAppRegion: string }).WebkitAppRegion,
    ).toBe('drag');
    expect(
      (hitHole.style as CSSStyleDeclaration & { WebkitAppRegion: string }).WebkitAppRegion,
    ).toBe('no-drag');
    expect(hitHole.style.marginLeft).toBe(`${CHROME_ACTIONS_GEOMETRY.defaultLeft}px`);
    expect(hitHole.style.width).toBe(`${CHROME_ACTIONS_GEOMETRY.clusterWidth}px`);
  });

  it('does not add the Windows-only hit hole on macOS', () => {
    renderSidebar(true);

    expect(screen.queryByTestId('right-sidebar-titlebar-spacer')).toBeNull();
    expect(screen.queryByTestId('right-sidebar-chrome-actions-hit-hole')).toBeNull();
  });
});
