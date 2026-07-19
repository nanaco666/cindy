// @vitest-environment jsdom

import { render, screen } from '@testing-library/react';
import React from 'react';
import { describe, expect, it, vi } from 'vitest';

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string, options?: { defaultValue?: string }) => {
      const translations: Record<string, string> = {
        'effortLevels.xhigh': '超高',
      };
      return translations[key] ?? options?.defaultValue ?? key;
    },
  }),
}));

vi.mock('@/components/ui/popover', () => ({
  Popover: ({ children }: { children: React.ReactNode }) => children,
  PopoverTrigger: ({ children }: { children: React.ReactNode }) => children,
  PopoverContent: () => null,
}));

vi.mock('@/components/ui/tooltip', async () => {
  const React = await import('react');
  return {
    Tip: ({
      children,
      contentClassName,
    }: {
      children: React.ReactElement;
      contentClassName?: string;
    }) => React.createElement('div', { 'data-tooltip-class': contentClassName }, children),
  };
});

vi.mock('@/lib/scrollbarAutoHide', () => ({
  flashScrollbar: vi.fn(),
}));

vi.mock('@/hooks/useAgentCapabilities', () => ({
  useAgentCapabilities: () => ({
    capabilities: {
      availableModels: [
        {
          id: 'claude-opus-4-8',
          displayName: 'Opus 4.8',
          contextWindow: 200000,
          efforts: ['low', 'medium', 'high', 'xhigh', 'max'],
          defaultEffort: 'high',
          effortDisplayNames: {
            xhigh: 'X-High',
          },
        },
      ],
      effortLevels: [{ id: 'xhigh', displayName: 'X-High' }],
      hasFastMode: false,
    },
  }),
}));

vi.mock('@/hooks/useApiKey', () => ({
  useApiKey: () => ({ hasSavedKey: true }),
}));

vi.mock('@/hooks/useConnectedSource', () => ({
  useConnectedSource: () => ({ hasConnectedSource: true, loading: false }),
}));

vi.mock('@/hooks/useModelPricing', () => ({
  useModelPricing: () => ({}),
}));

vi.mock('@/hooks/useProviders', () => ({
  useProviders: () => ({ providers: [] }),
}));

vi.mock('@/hooks/useDeviceProviders', () => ({
  useDeviceProviders: () => ({ providers: [], loading: false }),
}));

vi.mock('@/lib/providerModels', () => ({
  providerMonogram: (name: string) => name.slice(0, 1).toUpperCase(),
  selectVisibleModels: () => [
    {
      id: 'claude-opus-4-8',
      displayName: 'Opus 4.8',
      contextWindow: 200000,
      efforts: ['low', 'medium', 'high', 'xhigh', 'max'],
      defaultEffort: 'high',
      effortDisplayNames: {
        xhigh: 'X-High',
      },
    },
  ],
}));

vi.mock('@/state/modelVisibilityPrefs', () => ({
  isModelEnabled: () => true,
  useModelVisibilityVersion: () => 0,
}));

vi.mock('@/state/sessionModelMemory', () => ({
  useSessionModelMemoryVersion: () => 0,
}));

vi.mock('@/state/providerModelMemory', () => ({
  useProviderModelMemoryVersion: () => 0,
}));

vi.mock('@/state/deviceLinkModelMirror', () => ({
  useDeviceLinkModelMirrorVersion: () => 0,
}));

import {
  ModelSelector,
  ModelSelectorContent,
  modelEffortLabel,
  resolveModelBrandKind,
} from '@/components/new-chat/ModelSelector';

describe('ModelSelector trigger variants', () => {
  it('renders the field trigger as a settings input and localizes effort before provider labels', () => {
    render(
      React.createElement(ModelSelector, {
        modelId: 'claude-opus-4-8',
        effort: 'xhigh',
        onModelChange: vi.fn(),
        onEffortChange: vi.fn(),
        vendorKey: 'cc',
        triggerVariant: 'field',
      }),
    );

    const trigger = screen.getByRole('button', {
      name: /Current: Opus 4\.8, 超高 effort/,
    });

    expect(trigger.className).toContain('w-full');
    expect(trigger.className).toContain('border-[var(--border-default)]');
    expect(trigger.className).toContain('bg-[var(--settings-input-bg)]');
    expect(trigger.textContent).toContain('Opus 4.8');
    expect(trigger.textContent).toContain('超高');
    expect(trigger.textContent).not.toContain('X-High');
  });

  it('uses model effort display names only as fallback when i18n has no translation', () => {
    const t = (key: string, options?: { defaultValue?: string }) =>
      key === 'effortLevels.xhigh' ? '超高' : (options?.defaultValue ?? key);

    expect(
      modelEffortLabel(t, { effortDisplayNames: { xhigh: 'Extra High' } }, 'xhigh', 'X-High'),
    ).toBe('超高');
    expect(
      modelEffortLabel(t, { effortDisplayNames: { xhigh: 'Extra High' } }, 'max', 'Max'),
    ).toBe('Max');
  });

  it('renders an active fallback option without model effort metadata', () => {
    render(
      React.createElement(ModelSelector, {
        modelId: '',
        effort: 'high',
        onModelChange: vi.fn(),
        onEffortChange: vi.fn(),
        vendorKey: 'cc',
        triggerVariant: 'field',
        fallbackOption: {
          active: true,
          label: '不指定（跟随原逻辑）',
          onSelect: vi.fn(),
        },
      }),
    );

    const trigger = screen.getByRole('button', { name: /不指定（跟随原逻辑）/ });
    expect(trigger.textContent).toContain('不指定（跟随原逻辑）');
    expect(trigger.textContent).not.toContain('high');
  });

  it('can hide model effort and Fast editing controls for model-id-only settings', () => {
    render(
      React.createElement(ModelSelectorContent, {
        modelId: 'claude-opus-4-8',
        effort: 'high',
        onModelChange: vi.fn(),
        onEffortChange: vi.fn(),
        vendorKey: 'cc',
        configurationEnabled: false,
      }),
    );

    expect(screen.queryByRole('button', { name: 'newChat.modelSelector.edit' })).toBeNull();
  });

  it('forwards an overlay-specific z-index to model tooltips', () => {
    render(
      React.createElement(ModelSelectorContent, {
        modelId: 'claude-opus-4-8',
        effort: 'high',
        onModelChange: vi.fn(),
        onEffortChange: vi.fn(),
        vendorKey: 'cc',
        tooltipContentClassName: 'z-[10020]',
      }),
    );

    expect(
      screen
        .getByRole('option', { name: /Opus 4\.8/ })
        .parentElement?.getAttribute('data-tooltip-class'),
    ).toBe('z-[10020]');
  });

  it('resolves the model mark from the model brand before the current runtime', () => {
    expect(
      resolveModelBrandKind({
        modelId: 'gpt-5.5',
        displayName: 'GPT-5.5 · 中',
        agentKind: 'claude-code',
        fallbackProviderId: 'anthropic',
      }),
    ).toBe('codex');
    expect(
      resolveModelBrandKind({
        modelId: 'claude-opus-4-8',
        displayName: 'Opus 4.8',
        agentKind: 'codex',
        fallbackProviderId: 'openai',
      }),
    ).toBe('claude');
  });
});
