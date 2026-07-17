// @vitest-environment jsdom

/**
 * useTheme 跨窗口主题同步(D2-3,计划 §2 D2-3):
 * - 其他窗口切 theme/familyId → localStorage storage 事件 → 本窗口 state + applyTheme 跟随
 * - 本窗口 setItem 不触发 storage(storage 事件语义),不会循环
 * - 非法值/无关 key 不触发
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';
import { act, renderHook } from '@testing-library/react';
import { createElement, type ReactNode } from 'react';

import { themeService } from '../../themes/theme-service';
import { ThemeProvider, useTheme } from '../useTheme';

// jsdom 无 matchMedia,ThemeProvider 初始化与 system 模式需要它。
vi.stubGlobal('matchMedia', (q: string) => ({
  matches: false,
  media: q,
  addEventListener: () => {},
  removeEventListener: () => {},
}));

function wrapper({ children }: { children: ReactNode }) {
  return createElement(ThemeProvider, null, children);
}

describe('useTheme 跨窗口主题同步(D2-3)', () => {
  beforeEach(() => {
    localStorage.clear();
    vi.spyOn(themeService, 'applyTheme').mockImplementation(() => {});
  });

  it('其他窗口切 theme → storage 事件 → 本窗口 theme state 跟随并重应用', () => {
    const { result } = renderHook(() => useTheme(), { wrapper });
    expect(result.current.theme).toBe('system');
    act(() => {
      window.dispatchEvent(
        new StorageEvent('storage', { key: 'theme', newValue: 'dark' }),
      );
    });
    expect(result.current.theme).toBe('dark');
    expect(themeService.applyTheme).toHaveBeenCalled();
  });

  it('其他窗口切 familyId=cindy → 本窗口 familyId 跟随', () => {
    const { result } = renderHook(() => useTheme(), { wrapper });
    expect(result.current.familyId).toBe('default');
    act(() => {
      window.dispatchEvent(
        new StorageEvent('storage', { key: 'theme.familyId', newValue: 'cindy' }),
      );
    });
    expect(result.current.familyId).toBe('cindy');
  });

  it('非法 theme 值不触发 state 变更', () => {
    const { result } = renderHook(() => useTheme(), { wrapper });
    const before = result.current.theme;
    act(() => {
      window.dispatchEvent(
        new StorageEvent('storage', { key: 'theme', newValue: 'garbage' }),
      );
    });
    expect(result.current.theme).toBe(before);
  });

  it('非法 familyId(未注册)不触发变更', () => {
    const { result } = renderHook(() => useTheme(), { wrapper });
    const before = result.current.familyId;
    act(() => {
      window.dispatchEvent(
        new StorageEvent('storage', {
          key: 'theme.familyId',
          newValue: 'no-such-family',
        }),
      );
    });
    expect(result.current.familyId).toBe(before);
  });

  it('无关 key 的 storage 事件不触发主题变更', () => {
    const applySpy = themeService.applyTheme as unknown as ReturnType<typeof vi.fn>;
    applySpy.mockClear();
    const { result } = renderHook(() => useTheme(), { wrapper });
    const beforeTheme = result.current.theme;
    const beforeFamily = result.current.familyId;
    act(() => {
      window.dispatchEvent(
        new StorageEvent('storage', { key: 'unrelated.key', newValue: 'x' }),
      );
    });
    expect(result.current.theme).toBe(beforeTheme);
    expect(result.current.familyId).toBe(beforeFamily);
  });
});
