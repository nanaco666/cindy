// @vitest-environment jsdom

import { act, cleanup, render, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { OrcaWorkerPanel } from '../OrcaWorkerPanel';

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

describe('OrcaWorkerPanel create Worker shortcut', () => {
  beforeEach(() => {
    mocks.hardLimit = 2;
    mocks.refresh.mockReset();
    mocks.setCreateOpen.mockReset();
  });

  afterEach(cleanup);

  it('leaves an in-flight intent pending when the panel unmounts, so a new owner can retry it', async () => {
    const firstRefresh = deferred<{ status: 'applied'; workers: [] }>();
    mocks.refresh
      .mockReturnValueOnce(firstRefresh.promise)
      .mockResolvedValueOnce({ status: 'applied', workers: [] });
    const onConsumed = vi.fn();
    const first = render(
      <OrcaWorkerPanel
        leadSessionId="lead-1"
        viewVisible
        createWorkerRequestPending
        createWorkerRequestRevision={1}
        onCreateWorkerRequestConsumed={onConsumed}
      />,
    );

    expect(onConsumed).not.toHaveBeenCalled();
    first.unmount();
    await act(async () => firstRefresh.resolve({ status: 'applied', workers: [] }));
    expect(onConsumed).not.toHaveBeenCalled();
    expect(mocks.setCreateOpen).not.toHaveBeenCalled();

    render(
      <OrcaWorkerPanel
        leadSessionId="lead-1"
        viewVisible
        createWorkerRequestPending
        createWorkerRequestRevision={1}
        onCreateWorkerRequestConsumed={onConsumed}
      />,
    );
    await waitFor(() => expect(mocks.setCreateOpen).toHaveBeenCalledWith(true));
    expect(onConsumed).toHaveBeenCalledWith(1);
  });

  it('uses the latest hard limit when an in-flight refresh completes', async () => {
    const pendingRefresh = deferred<{
      status: 'applied';
      workers: Array<{ status: 'running' }>;
    }>();
    mocks.hardLimit = 1;
    mocks.refresh.mockReturnValue(pendingRefresh.promise);
    const onConsumed = vi.fn();
    const view = render(
      <OrcaWorkerPanel
        leadSessionId="lead-1"
        viewVisible
        createWorkerRequestPending
        createWorkerRequestRevision={1}
        onCreateWorkerRequestConsumed={onConsumed}
      />,
    );

    mocks.hardLimit = 2;
    view.rerender(
      <OrcaWorkerPanel
        leadSessionId="lead-1"
        viewVisible
        createWorkerRequestPending
        createWorkerRequestRevision={1}
        onCreateWorkerRequestConsumed={onConsumed}
      />,
    );
    await act(async () => pendingRefresh.resolve({ status: 'applied', workers: [{ status: 'running' }] }));

    expect(mocks.setCreateOpen).toHaveBeenCalledWith(true);
    expect(onConsumed).toHaveBeenCalledWith(1);
    expect(mocks.refresh).toHaveBeenCalledTimes(1);
  });
});
