// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { CustomProviderConfig } from '@cindy/model-providers';

const { toastSuccess } = vi.hoisted(() => ({ toastSuccess: vi.fn() }));

const labels: Record<string, string> = {
  'settings.providers.custom.protocol.claude': 'Claude Code',
  'settings.providers.custom.protocol.codex': 'Codex',
  'settings.providers.custom.fields.baseUrl': 'Base URL',
  'settings.providers.custom.runtimeFill.action': 'Fill other runtimes',
  'settings.providers.custom.runtimeFill.reviewTitle': 'Fill other runtimes review',
  'settings.providers.custom.runtimeFill.confirmTitle': 'Confirm overwrites',
  'settings.providers.custom.runtimeFill.continue': 'Review overwrites',
  'settings.providers.custom.runtimeFill.apply': 'Confirm fill',
  'settings.providers.custom.runtimeFill.applyOverwrite': 'Overwrite and fill',
  'settings.providers.custom.runtimeFill.back': 'Back to differences',
  'settings.providers.custom.runtimeFill.fields.baseUrl': 'Base URL',
  'settings.providers.custom.runtimeFill.fields.apiKey': 'API key',
  'settings.providers.custom.runtimeFill.fields.models': 'Models',
  'settings.providers.custom.runtimeFill.fields.headers': 'Advanced headers',
  'settings.providers.custom.runtimeFill.fields.modelsUrl': 'Model list endpoint',
};

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string, options?: { count?: number; targets?: string; target?: string }) =>
      labels[key] ?? options?.targets ?? options?.target ?? (options?.count ?? key).toString(),
    i18n: { language: 'en' },
  }),
}));

vi.mock('@/lib/toast', () => ({
  toast: {
    info: vi.fn(),
    error: vi.fn(),
    success: toastSuccess,
  },
}));

vi.mock('@/lib/customProviders', () => ({
  createCustomProvider: vi.fn(),
  updateCustomProvider: vi.fn(),
  replaceCustomProviderModelId: (model: { id: string; name: string }, nextId: string) => ({
    ...model,
    id: nextId,
  }),
  readCustomProviderKey: vi.fn(async (_providerId: string, agent: string) =>
    agent === 'claude-code' ? 'source-secret-not-real' : 'target-secret-not-real',
  ),
}));

import { CustomProviderDialog } from '@/components/settings/CustomProviderDialog';

const initial: CustomProviderConfig = {
  id: 'nebula',
  name: 'Nebula',
  runtimes: {
    'claude-code': {
      baseUrl: 'https://source.example.com',
      models: [{ id: 'source-model', name: 'Source Model' }],
      headers: { 'x-tenant': 'source' },
    },
    codex: {
      baseUrl: 'https://target.example.com/v1',
      models: [{ id: 'target-model', name: 'Target Model' }],
      headers: { 'x-tenant': 'target' },
    },
  },
};

beforeEach(() => {
  (window as unknown as { electronAPI: unknown }).electronAPI = { maker: {} };
});

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe('CustomProviderDialog runtime fill', () => {
  it('keeps the action in the Base URL heading and confirms overwrites before copying', async () => {
    render(<CustomProviderDialog initial={initial} onSaved={vi.fn()} onClose={vi.fn()} />);

    await waitFor(() => expect(screen.getByDisplayValue('source-secret-not-real')).not.toBeNull());

    const action = screen.getByRole('button', { name: 'Fill other runtimes' });
    const baseUrlHeading = screen.getByText('Base URL').parentElement;
    expect(baseUrlHeading).not.toBeNull();
    expect(within(baseUrlHeading!).getByRole('button', { name: 'Fill other runtimes' })).toBe(
      action,
    );

    fireEvent.click(action);
    expect(screen.getByText('Fill other runtimes review')).not.toBeNull();
    expect(screen.queryByText('source-secret-not-real')).toBeNull();
    expect(screen.queryByText('target-secret-not-real')).toBeNull();

    fireEvent.click(screen.getByRole('button', { name: 'Review overwrites' }));
    expect(screen.getByText('Confirm overwrites')).not.toBeNull();

    fireEvent.click(screen.getByRole('button', { name: 'Overwrite and fill' }));
    expect(toastSuccess).toHaveBeenCalledOnce();

    fireEvent.click(screen.getByRole('tab', { name: /Codex/ }));
    expect(screen.getByDisplayValue('https://source.example.com')).not.toBeNull();
    expect(screen.getByDisplayValue('source-model')).not.toBeNull();

    fireEvent.click(screen.getByRole('tab', { name: /Claude Code/ }));
    fireEvent.change(screen.getByDisplayValue('https://source.example.com'), {
      target: { value: 'https://changed-later.example.com' },
    });
    fireEvent.click(screen.getByRole('tab', { name: /Codex/ }));

    expect(screen.getByDisplayValue('https://source.example.com')).not.toBeNull();
    expect(screen.queryByDisplayValue('https://changed-later.example.com')).toBeNull();
  });

  it('applies directly after the user returns and leaves only empty target fields selected', async () => {
    const withModelsUrl: CustomProviderConfig = {
      ...initial,
      runtimes: {
        ...initial.runtimes,
        'claude-code': {
          ...initial.runtimes['claude-code']!,
          modelsUrl: 'https://source.example.com/models',
        },
      },
    };
    render(<CustomProviderDialog initial={withModelsUrl} onSaved={vi.fn()} onClose={vi.fn()} />);

    await waitFor(() => expect(screen.getByDisplayValue('source-secret-not-real')).not.toBeNull());
    fireEvent.click(screen.getByRole('button', { name: 'Fill other runtimes' }));
    fireEvent.click(screen.getByRole('button', { name: 'Review overwrites' }));

    for (const name of [/Base URL/, /API key/, /Models/, /Advanced headers/]) {
      fireEvent.click(screen.getByRole('checkbox', { name }));
    }
    fireEvent.click(screen.getByRole('button', { name: 'Back to differences' }));

    fireEvent.click(screen.getByRole('button', { name: 'Confirm fill' }));
    expect(screen.queryByText('Confirm overwrites')).toBeNull();
    expect(toastSuccess).toHaveBeenCalledOnce();
  });
});
