// @vitest-environment jsdom

import { act, fireEvent, render, screen, within } from '@testing-library/react';
import React from 'react';
import { describe, expect, it, vi } from 'vitest';

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (
      key: string,
      options?: {
        defaultValue?: string;
        input?: string;
        output?: string;
        source?: string;
        value?: string;
      },
    ) => {
      const translations: Record<string, string> = {
        'effortLevels.xhigh': '超高',
        'settings.providers.anthropic.title': 'Anthropic',
      };
      if (key === 'newChat.modelSelector.priceTip') {
        return `Input ${options?.input} · Output ${options?.output} per 1M tokens`;
      }
      if (key === 'newChat.modelSelector.meta.context') {
        return `${options?.value} context`;
      }
      if (key === 'newChat.modelSelector.source.viaSource') {
        return `Source: ${options?.source}`;
      }
      return translations[key] ?? options?.defaultValue ?? key;
    },
  }),
}));

vi.mock('@/components/ui/popover', async () => {
  const React = await import('react');
  const OpenContext = React.createContext(true);
  return {
    Popover: ({ children, open }: { children: React.ReactNode; open?: boolean }) =>
      React.createElement(OpenContext.Provider, { value: open ?? true }, children),
    PopoverTrigger: ({ children }: { children: React.ReactNode }) => children,
    PopoverAnchor: ({ children }: { children: React.ReactNode }) => children,
    PopoverContent: ({
      children,
      className,
      onPointerEnter,
      onPointerLeave,
    }: {
      children: React.ReactNode;
      className?: string;
      onPointerEnter?: React.PointerEventHandler<HTMLDivElement>;
      onPointerLeave?: React.PointerEventHandler<HTMLDivElement>;
    }) => {
      const open = React.useContext(OpenContext);
      return open
        ? React.createElement(
            'div',
            {
              className,
              'data-testid': 'model-options-popover',
              onPointerEnter,
              onPointerLeave,
            },
            children,
          )
        : null;
    },
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
          description: 'Most capable for ambitious work',
          contextWindow: 200000,
          efforts: ['low', 'medium', 'high', 'xhigh', 'max'],
          defaultEffort: 'high',
          effortDisplayNames: {
            xhigh: 'X-High',
          },
        },
        {
          id: 'claude-sonnet-4-6',
          displayName: 'Sonnet 4.6',
          contextWindow: 200000,
          efforts: ['low', 'medium', 'high'],
          defaultEffort: 'medium',
        },
        {
          id: 'claude-haiku-4-5',
          displayName: 'Haiku 4.5',
          description: 'Fastest for quick answers',
          contextWindow: 200000,
          efforts: [],
          defaultEffort: null,
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
  useModelPricing: () => ({
    'claude-opus-4-8': {
      inputUsdPerMtok: 3,
      outputUsdPerMtok: 15,
    },
  }),
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
        connected: true,
        models: {
          'claude-code': [
            {
              id: 'claude-opus-4-8',
              name: 'Opus 4.8',
              description: 'Most capable for ambitious work',
              contextWindow: 200000,
              efforts: ['low', 'medium', 'high', 'xhigh', 'max'],
              defaultEffort: 'high',
            },
            {
              id: 'claude-sonnet-4-6',
              name: 'Sonnet 4.6',
              contextWindow: 200000,
              efforts: ['low', 'medium', 'high'],
              defaultEffort: 'medium',
            },
            {
              id: 'claude-haiku-4-5',
              name: 'Haiku 4.5',
              description: 'Fastest for quick answers',
              contextWindow: 200000,
              efforts: [],
              defaultEffort: null,
            },
          ],
        },
      },
    ],
  }),
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
      description: 'Most capable for ambitious work',
      contextWindow: 200000,
      efforts: ['low', 'medium', 'high', 'xhigh', 'max'],
      defaultEffort: 'high',
      effortDisplayNames: {
        xhigh: 'X-High',
      },
    },
    {
      id: 'claude-sonnet-4-6',
      displayName: 'Sonnet 4.6',
      contextWindow: 200000,
      efforts: ['low', 'medium', 'high'],
      defaultEffort: 'medium',
    },
    {
      id: 'claude-haiku-4-5',
      displayName: 'Haiku 4.5',
      description: 'Fastest for quick answers',
      contextWindow: 200000,
      efforts: [],
      defaultEffort: null,
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

  it('forwards an overlay-specific z-index to the model information panel', () => {
    render(
      React.createElement(ModelSelectorContent, {
        modelId: 'claude-opus-4-8',
        effort: 'high',
        onModelChange: vi.fn(),
        onEffortChange: vi.fn(),
        vendorKey: 'cc',
        overlayContentClassName: 'z-[10020]',
      }),
    );

    fireEvent.pointerEnter(screen.getByRole('option', { name: /Opus 4\.8/ }));
    expect(screen.getByTestId('model-options-popover').className).toContain('z-[10020]');
  });

  it('reveals the selected model options on row hover or keyboard focus without an Edit click', () => {
    vi.useFakeTimers();
    render(
      React.createElement(ModelSelectorContent, {
        modelId: 'claude-opus-4-8',
        effort: 'high',
        onModelChange: vi.fn(),
        onEffortChange: vi.fn(),
        vendorKey: 'cc',
      }),
    );

    const row = screen.getByRole('option', { name: /Opus 4\.8/ });
    expect(screen.queryByRole('group', { name: /Opus 4\.8/ })).toBeNull();
    expect(screen.queryByText('newChat.modelSelector.edit')).toBeNull();

    fireEvent.pointerEnter(row);
    const options = screen.getByRole('group', { name: /Opus 4\.8/ });
    expect(options).toBeTruthy();
    expect(within(options).getByText('Most capable for ambitious work')).toBeTruthy();
    expect(within(options).getByText('Source: Anthropic')).toBeTruthy();
    expect(within(options).getByText('200K context')).toBeTruthy();
    expect(within(options).getByText('Input $3 · Output $15 per 1M tokens')).toBeTruthy();
    expect(row.getAttribute('data-model-options-active')).toBe('true');

    fireEvent.pointerLeave(row);
    act(() => vi.advanceTimersByTime(79));
    expect(screen.getByRole('group', { name: /Opus 4\.8/ })).toBeTruthy();
    act(() => vi.advanceTimersByTime(1));
    expect(screen.queryByRole('group', { name: /Opus 4\.8/ })).toBeNull();

    fireEvent.focus(row);
    expect(screen.getByRole('group', { name: /Opus 4\.8/ })).toBeTruthy();
    vi.useRealTimers();
  });

  it('shows model information even when a model has no configurable options', () => {
    render(
      React.createElement(ModelSelectorContent, {
        modelId: 'claude-opus-4-8',
        effort: 'high',
        onModelChange: vi.fn(),
        onEffortChange: vi.fn(),
        vendorKey: 'cc',
      }),
    );

    fireEvent.pointerEnter(screen.getByRole('option', { name: /Haiku 4\.5/ }));
    const information = screen.getByRole('group', { name: /Haiku 4\.5/ });
    expect(within(information).getByText('Fastest for quick answers')).toBeTruthy();
    expect(within(information).getByText('200K context')).toBeTruthy();
    expect(within(information).queryByRole('option')).toBeNull();
  });

  it('lets inactive provider rows edit scoped memory without switching the model', () => {
    const onProviderChange = vi.fn();
    const setEffort = vi.fn();
    const modelMemory = {
      getEffort: vi.fn(),
      setEffort,
      getFast: vi.fn(),
      setFast: vi.fn(),
    };

    render(
      React.createElement(ModelSelectorContent, {
        modelId: 'claude-opus-4-8',
        effort: 'high',
        onModelChange: vi.fn(),
        onEffortChange: vi.fn(),
        vendorKey: 'cc',
        currentProviderId: 'anthropic',
        onProviderChange,
        modelMemory,
      }),
    );

    const opusRow = screen.getByRole('option', { name: /Opus 4\.8/ });
    const sonnetRow = screen.getByRole('option', { name: /Sonnet 4\.6/ });
    fireEvent.pointerEnter(opusRow);
    expect(screen.getByRole('group', { name: /Opus 4\.8/ })).toBeTruthy();

    fireEvent.pointerEnter(sonnetRow);
    expect(screen.queryByRole('group', { name: /Opus 4\.8/ })).toBeNull();
    const options = screen.getByRole('group', { name: /Sonnet 4\.6/ });
    expect(sonnetRow.getAttribute('data-model-options-active')).toBe('true');
    expect(opusRow.getAttribute('data-model-options-active')).toBeNull();
    fireEvent.click(within(options).getByRole('option', { name: 'high' }));

    expect(setEffort).toHaveBeenCalledWith('claude-code', 'anthropic', 'claude-sonnet-4-6', 'high');
    expect(onProviderChange).not.toHaveBeenCalled();
  });
});
