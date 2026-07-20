// @vitest-environment jsdom

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { ConfirmDialogProvider, useConfirmDialog } from '@/components/ui/confirm-dialog-provider';
import {
  AGENT_SWITCH_CONFIRMATION_OVERRIDE_KEY,
  confirmAgentSwitchRisk,
  type AgentSwitchConfirmationReason,
  type AgentSwitchTarget,
} from '@/components/new-chat/agentSwitchConfirmation';

vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}));

const STORAGE_KEY = `confirm-dialog.skip:${AGENT_SWITCH_CONFIRMATION_OVERRIDE_KEY}`;
const CHAT_INPUT_SOURCE = readFileSync(
  resolve(__dirname, '..', 'components', 'new-chat', 'ChatInput.tsx'),
  'utf8',
);
const COPY = {
  title: 'Switch Agent?',
  description: 'Switching agents has handoff costs.',
  confirmText: 'Switch Agent',
  cancelText: 'Keep Current Agent',
  dontShowAgainLabel: 'Don’t remind me again',
};

function Harness({
  existingIntentTarget,
  targetAgentKind,
  reason = 'model-selection',
  onPerform,
}: {
  existingIntentTarget?: AgentSwitchTarget | null;
  targetAgentKind: AgentSwitchTarget;
  reason?: AgentSwitchConfirmationReason;
  onPerform: () => void;
}) {
  const { confirm } = useConfirmDialog();
  return (
    <button
      type="button"
      onClick={() => {
        void confirmAgentSwitchRisk({
          existingIntentTarget,
          targetAgentKind,
          reason,
          confirm,
          copy: COPY,
        }).then((proceed) => {
          if (proceed) onPerform();
        });
      }}
    >
      Choose Target Model
    </button>
  );
}

function renderHarness(props: Parameters<typeof Harness>[0]) {
  return render(
    <ConfirmDialogProvider>
      <Harness {...props} />
    </ConfirmDialogProvider>,
  );
}

describe('Agent switch confirmation', () => {
  beforeEach(() => {
    localStorage.clear();
  });

  afterEach(() => {
    cleanup();
  });

  it('prompts before the first switch and cancel leaves the switch untouched', async () => {
    const onPerform = vi.fn();
    renderHarness({ targetAgentKind: 'codex', onPerform });

    fireEvent.click(screen.getByRole('button', { name: 'Choose Target Model' }));
    expect(await screen.findByText(COPY.title)).toBeTruthy();

    fireEvent.click(screen.getByRole('checkbox', { name: COPY.dontShowAgainLabel }));
    fireEvent.click(screen.getByRole('button', { name: COPY.cancelText }));
    await waitFor(() => expect(screen.queryByText(COPY.title)).toBeNull());
    expect(onPerform).not.toHaveBeenCalled();
    expect(localStorage.getItem(STORAGE_KEY)).toBeNull();
  });

  it('also prompts when an existing intent selects another target model', async () => {
    const onPerform = vi.fn();
    renderHarness({
      existingIntentTarget: 'codex',
      targetAgentKind: 'codex',
      onPerform,
    });

    fireEvent.click(screen.getByRole('button', { name: 'Choose Target Model' }));
    expect(await screen.findByText(COPY.title)).toBeTruthy();
    expect(onPerform).not.toHaveBeenCalled();
  });

  it('does not prompt when selecting the original engine to cancel an intent', async () => {
    const onPerform = vi.fn();
    renderHarness({
      existingIntentTarget: 'codex',
      targetAgentKind: 'claude-code',
      onPerform,
    });

    fireEvent.click(screen.getByRole('button', { name: 'Choose Target Model' }));
    await waitFor(() => expect(onPerform).toHaveBeenCalledTimes(1));
    expect(screen.queryByText(COPY.title)).toBeNull();
  });

  it('persists the explicit skip override only after checked confirmation', async () => {
    const onPerform = vi.fn();
    const first = renderHarness({ targetAgentKind: 'codex', onPerform });

    fireEvent.click(screen.getByRole('button', { name: 'Choose Target Model' }));
    fireEvent.click(await screen.findByRole('checkbox', { name: COPY.dontShowAgainLabel }));
    fireEvent.click(screen.getByRole('button', { name: COPY.confirmText }));
    await waitFor(() => expect(onPerform).toHaveBeenCalledTimes(1));
    expect(localStorage.getItem(STORAGE_KEY)).toBe('1');

    first.unmount();
    renderHarness({ targetAgentKind: 'codex', onPerform });
    act(() => {
      fireEvent.click(screen.getByRole('button', { name: 'Choose Target Model' }));
    });
    await waitFor(() => expect(onPerform).toHaveBeenCalledTimes(2));
    expect(screen.queryByText(COPY.title)).toBeNull();
  });

  it('does not reprompt for effort or Fast updates on an existing intent', async () => {
    const confirm = vi.fn(async () => true);
    await expect(
      confirmAgentSwitchRisk({
        existingIntentTarget: 'codex',
        targetAgentKind: 'codex',
        reason: 'intent-preference-update',
        confirm,
        copy: COPY,
      }),
    ).resolves.toBe(true);
    expect(confirm).not.toHaveBeenCalled();
  });

  it('keeps the confirmation gate before ChatInput registers an intent', () => {
    const confirmationIndex = CHAT_INPUT_SOURCE.indexOf(
      'const confirmed = await confirmAgentSwitchRisk',
    );
    const cancelIndex = CHAT_INPUT_SOURCE.indexOf('if (!confirmed) return;', confirmationIndex);
    const switchIpcIndex = CHAT_INPUT_SOURCE.indexOf(
      'await window.electronAPI.maker.switchSessionAgent',
      confirmationIndex,
    );

    expect(confirmationIndex).toBeGreaterThan(-1);
    expect(cancelIndex).toBeGreaterThan(confirmationIndex);
    expect(switchIpcIndex).toBeGreaterThan(cancelIndex);
    expect(CHAT_INPUT_SOURCE.match(/confirmationReason: 'intent-preference-update'/g)).toHaveLength(
      2,
    );
  });
});
