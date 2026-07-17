// @vitest-environment jsdom

/**
 * Cindy AI 固定在模型供应商列表首位;实时模型清单不可用时来源行仍保留,
 * 但不渲染静态模型,点击展开入口给出明确错误提示。
 */

import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import React from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import type { ProviderView } from '@lizi/model-providers';

const { toastError } = vi.hoisted(() => ({ toastError: vi.fn() }));

vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}));

vi.mock('@/hooks/useProviders', () => ({
  useProviders: () => ({
    providers: [
      {
        id: 'anthropic',
        name: 'Anthropic',
        source: 'builtin',
        agents: ['claude-code'],
        auth: { method: 'oauth' },
        routing: {},
        models: {
          'claude-code': [
            {
              id: 'claude-sonnet-5',
              name: 'Sonnet 5',
              contextWindow: 200_000,
              efforts: [],
              defaultEffort: null,
            },
          ],
        },
        connected: false,
      } satisfies ProviderView,
      {
        id: 'xd',
        name: 'XD Gateway',
        source: 'builtin',
        agents: ['claude-code', 'codex'],
        auth: { method: 'managed' },
        routing: {},
        models: { 'claude-code': [], codex: [] },
        connected: false,
      } satisfies ProviderView,
    ],
    loading: false,
    refetch: vi.fn(),
  }),
}));

vi.mock('@/hooks/useCodexAuth', () => ({
  useCodexAuth: () => ({
    state: { kind: 'unauthenticated' },
    triggerLogin: vi.fn(),
    cancelLogin: vi.fn(),
    logout: vi.fn(),
  }),
}));

vi.mock('@/hooks/useApiKey', () => ({
  useApiKey: () => ({ key: '', hasSavedKey: false, clearKey: vi.fn() }),
}));

vi.mock('@/hooks/useModelAccessStatus', () => ({
  useModelAccessStatus: () => ({ state: 'failed', source: null, endpoint: null }),
}));

vi.mock('@/components/ui/confirm-dialog-provider', () => ({
  useConfirmDialog: () => ({ confirm: vi.fn() }),
}));

vi.mock('@/lib/toast', () => ({
  toast: { error: toastError, success: vi.fn() },
}));

vi.mock('@/lib/customProviders', () => ({
  deleteCustomProvider: vi.fn(),
}));

vi.mock('@/lib/providerModels', () => ({
  providerMonogram: () => 'X',
}));

vi.mock('@/lib/providerSubtitle', () => ({
  customProviderSubtitleForDisplay: () => '',
  providerSubtitleForDisplay: () => 'XD Gateway',
}));

vi.mock('@/state/modelVisibilityPrefs', () => ({
  isModelEnabled: () => true,
  setManyVisibility: vi.fn(),
  setModelVisibility: vi.fn(),
  useModelVisibilityVersion: () => 0,
}));

vi.mock('@/components/settings/CustomProviderDialog', () => ({
  CustomProviderDialog: () => null,
}));

import { ProvidersSection } from '@/components/settings/ProvidersSection';

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe('ProvidersSection — Cindy AI', () => {
  it('固定置顶;模型拉取失败时保留展开入口并给出错误提示', () => {
    render(React.createElement(ProvidersSection));

    const expandButtons = screen.getAllByRole('button', {
      name: 'settings.providers.models.expandAria',
    });
    expect(expandButtons).toHaveLength(2);
    fireEvent.click(expandButtons[0]);

    expect(toastError).toHaveBeenCalledWith('settings.providers.xd.sync.modelsFetchFailed');
    expect(screen.queryByText('settings.providers.models.available')).toBeNull();
  });
});
