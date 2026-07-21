// @vitest-environment jsdom

import { act, cleanup, render, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { OrcaWorkerPanel } from '../OrcaWorkerPanel';
import { requestNewWorkerFromShortcut } from '../lib/newWorkerShortcut';

const mocks = vi.hoisted(() => ({
  hardLimit: 2,
  refresh: vi.fn(),
  setCreateOpen: vi.fn(),
}));

vi.mock('react-router-dom', () => ({ useNavigate: () => vi.fn() }));
vi.mock('react-i18next', () => ({ useTranslation: () => ({ t: (key: string) => key }) }));
vi.mock('@/hooks/useAgentIslandSettings', () => ({ isAgentIslandSupported: () => false }));
vi.mock('@/lib/sidebarWindow', () => ({ isSidebarWindow: () => false }));
vi.mock('../CCAgentSessionView', () => ({ CCAgentSessionView: () => null }));
vi.mock('../CreateWorkerPopover', () => ({ CreateWorkerPopover: () => null }));
vi.mock('../RolePillDropdown', () => ({ WorkerListToolbar: () => null }));
vi.mock('../hooks/useOrcaWorkerSelection', () => ({
  useOrcaWorkerSelection: () => ({
    workers: [],
    focusedWorker: null,
    activeWorkerCount: 0,
    softLimit: 1,
    hardLimit: mocks.hardLimit,
    refresh: mocks.refresh,
    selectedWorkerRecord: null,
    selectedWorkerId: null,
    workerSessionId: null,
    createOpen: false,
    setCreateOpen: mocks.setCreateOpen,
    handleCreateWorker: vi.fn(),
    handleSwitchFocus: vi.fn(),
    handleArchiveWorker: vi.fn(),
  }),
}));

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((resolvePromise) => {
    resolve = resolvePromise;
  });
  return { promise, resolve };
}

describe('OrcaWorkerPanel New Maker shortcut', () => {
  beforeEach(() => {
    mocks.hardLimit = 2;
    mocks.refresh.mockReset();
    mocks.setCreateOpen.mockReset();
  });

  afterEach(() => {
    cleanup();
  });

  it('opens the existing create dialog only from the visible collaboration panel', async () => {
    mocks.refresh.mockResolvedValue({ status: 'applied', workers: [] });
    render(<OrcaWorkerPanel leadSessionId="lead-1" viewVisible />);

    await expect(requestNewWorkerFromShortcut()).resolves.toBe(true);
    expect(mocks.refresh).toHaveBeenCalledOnce();
    expect(mocks.setCreateOpen).toHaveBeenCalledWith(true);
  });

  it('consumes the shortcut without opening when the refreshed team is at the hard limit', async () => {
    mocks.hardLimit = 1;
    mocks.refresh.mockResolvedValue({
      status: 'applied',
      workers: [{ status: 'running' }],
    });
    render(<OrcaWorkerPanel leadSessionId="lead-1" viewVisible />);

    await expect(requestNewWorkerFromShortcut()).resolves.toBe(true);
    expect(mocks.setCreateOpen).not.toHaveBeenCalled();
  });

  it('does not retain an in-flight shortcut after the visible panel unmounts', async () => {
    const pending = deferred<{ status: 'applied'; workers: [] }>();
    mocks.refresh.mockReturnValue(pending.promise);
    const panel = render(<OrcaWorkerPanel leadSessionId="lead-1" viewVisible />);

    const request = requestNewWorkerFromShortcut();
    await waitFor(() => expect(mocks.refresh).toHaveBeenCalledOnce());
    panel.unmount();
    await act(async () => pending.resolve({ status: 'applied', workers: [] }));

    await expect(request).resolves.toBe(true);
    expect(mocks.setCreateOpen).not.toHaveBeenCalled();
    await expect(requestNewWorkerFromShortcut()).resolves.toBe(false);
  });
});
