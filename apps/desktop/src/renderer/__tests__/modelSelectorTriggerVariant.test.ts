// @vitest-environment jsdom

import { act, fireEvent, render, screen, within } from '@testing-library/react';
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
        {
          id: 'claude-sonnet-4-6',
          displayName: 'Sonnet 4.6',
          contextWindow: 200000,
          efforts: ['low', 'medium', 'high'],
          defaultEffort: 'medium',
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
    expect(screen.getByRole('group', { name: /Opus 4\.8/ })).toBeTruthy();
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
