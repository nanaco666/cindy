// @vitest-environment jsdom

/**
 * XD 网关实时模型清单不可用时的设置页交互契约:
 * 来源行仍保留,但不渲染静态模型;点击展开入口给出明确错误提示。
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

describe('ProvidersSection — XD 网关模型拉取失败', () => {
  it('保留展开入口,点击后报错且不渲染静态模型列表', () => {
    render(React.createElement(ProvidersSection));

    const expand = screen.getByRole('button', {
      name: 'settings.providers.models.expandAria',
    });
    fireEvent.click(expand);

    expect(toastError).toHaveBeenCalledWith('settings.providers.xd.sync.modelsFetchFailed');
    expect(screen.queryByText('settings.providers.models.available')).toBeNull();
  });
});
