// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { CreateWorkerPopover } from '../CreateWorkerPopover';

vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}));

vi.mock('@/hooks/useAgentCapabilities', () => ({
  useAgentCapabilities: () => ({ capabilities: {} }),
}));

vi.mock('@/hooks/useProviders', () => ({
  useProviders: () => ({ providers: [] }),
}));

vi.mock('@/hooks/useDeviceProviders', () => ({
  useDeviceProviders: () => ({ providers: [], loading: false, error: null }),
}));

vi.mock('@/components/new-chat/FastModeToggle', () => ({
  FastModeToggle: () => null,
}));

vi.mock('@/components/new-chat/ModelSelector', () => ({
  ModelSelector: () => <div data-testid="model-selector" />,
}));

vi.mock('../workerModelAvailability', () => ({
  selectWorkerModels: () => [
    {
      id: 'codex/gpt-5.5',
      efforts: ['high'],
      defaultEffort: 'high',
      supportsFastMode: true,
    },
  ],
}));

describe('CreateWorkerPopover submission guard', () => {
  afterEach(() => cleanup());

  it('disables immediately and collapses repeated click events into one request', async () => {
    let finishCreate!: () => void;
    const onCreate = vi.fn(
      () =>
        new Promise<void>((resolve) => {
          finishCreate = resolve;
        }),
    );
    render(<CreateWorkerPopover open onClose={vi.fn()} onCreate={onCreate} />);
    const submit = screen.getByRole('button', { name: 'orca.createWorker.submit' });

    fireEvent.click(submit);
    fireEvent.click(submit);

    expect(onCreate).toHaveBeenCalledTimes(1);
    expect((submit as HTMLButtonElement).disabled).toBe(true);
    expect(submit.getAttribute('aria-busy')).toBe('true');

    finishCreate();
    await waitFor(() => expect((submit as HTMLButtonElement).disabled).toBe(false));
    expect(submit.getAttribute('aria-busy')).toBe('false');
  });
});
