// @vitest-environment jsdom

import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { useRef, useState, type ReactNode } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { MorphPopover } from '../components/ui/morph-popover';

function setReducedMotion(reduced: boolean): void {
  Object.defineProperty(window, 'matchMedia', {
    configurable: true,
    value: vi.fn().mockImplementation(() => ({
      matches: reduced,
      media: '(prefers-reduced-motion: reduce)',
      onchange: null,
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
      addListener: vi.fn(),
      removeListener: vi.fn(),
      dispatchEvent: vi.fn(),
    })),
  });
}

function Harness({ children, panelWidth }: { children?: ReactNode; panelWidth?: number }) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <MorphPopover
        open={open}
        onOpenChange={setOpen}
        panelWidth={panelWidth}
        panelAriaLabel="Morph panel"
        trigger={
          <button type="button" onClick={() => setOpen((current) => !current)}>
            Toggle
          </button>
        }
      >
        {children ?? <button type="button">First action</button>}
      </MorphPopover>
      <button type="button">Outside</button>
      <div data-radix-popper-content-wrapper="">
        <button type="button">Nested portal action</button>
      </div>
    </>
  );
}

beforeEach(() => {
  setReducedMotion(true);
});

afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe('MorphPopover interaction contract', () => {
  it('focuses the first enabled menu action and restores the trigger on Escape', async () => {
    render(<Harness />);
    const trigger = screen.getByRole('button', { name: 'Toggle' });

    fireEvent.click(trigger);
    const firstAction = await screen.findByRole('button', { name: 'First action' });
    await waitFor(() => expect(document.activeElement).toBe(firstAction));

    fireEvent.keyDown(document, { key: 'Escape' });
    await waitFor(() => expect(screen.queryByRole('group', { name: 'Morph panel' })).toBeNull());
    expect(document.activeElement).toBe(trigger);
  });

  it('does not steal focus back when an action hands it to another surface', async () => {
    function FocusHandoffHarness() {
      const [open, setOpen] = useState(false);
      const destinationRef = useRef<HTMLButtonElement>(null);
      return (
        <>
          <MorphPopover
            open={open}
            onOpenChange={setOpen}
            trigger={
              <button type="button" onClick={() => setOpen(true)}>
                Toggle
              </button>
            }
          >
            <button
              type="button"
              onClick={() => {
                destinationRef.current?.focus();
                setOpen(false);
              }}
            >
              Continue elsewhere
            </button>
          </MorphPopover>
          <button ref={destinationRef} type="button">
            Destination
          </button>
        </>
      );
    }

    render(<FocusHandoffHarness />);
    fireEvent.click(screen.getByRole('button', { name: 'Toggle' }));
    fireEvent.click(await screen.findByRole('button', { name: 'Continue elsewhere' }));

    await waitFor(() =>
      expect(screen.queryByRole('button', { name: 'Continue elsewhere' })).toBeNull(),
    );
    expect(document.activeElement).toBe(screen.getByRole('button', { name: 'Destination' }));
  });

  it('keeps nested Radix portals active, but closes on focus leaving the interaction layer', async () => {
    render(<Harness />);
    fireEvent.click(screen.getByRole('button', { name: 'Toggle' }));
    await screen.findByRole('group', { name: 'Morph panel' });

    act(() => screen.getByRole('button', { name: 'Nested portal action' }).focus());
    expect(screen.getByRole('group', { name: 'Morph panel' })).toBeTruthy();

    act(() => screen.getByRole('button', { name: 'Outside' }).focus());
    await waitFor(() => expect(screen.queryByRole('group', { name: 'Morph panel' })).toBeNull());
  });

  it('ignores its own content scroll and closes on external scroll', async () => {
    render(
      <Harness>
        <div data-testid="scrollable">Scrollable content</div>
      </Harness>,
    );
    fireEvent.click(screen.getByRole('button', { name: 'Toggle' }));
    const panel = await screen.findByRole('group', { name: 'Morph panel' });

    fireEvent.scroll(screen.getByTestId('scrollable'));
    expect(panel.isConnected).toBe(true);

    fireEvent.scroll(document);
    await waitFor(() => expect(screen.queryByRole('group', { name: 'Morph panel' })).toBeNull());
  });

  it('makes the ghost and closing content inert', async () => {
    setReducedMotion(false);
    render(<Harness />);
    fireEvent.click(screen.getByRole('button', { name: 'Toggle' }));
    const panel = await screen.findByRole('group', { name: 'Morph panel' });
    const ghost = panel.querySelector<HTMLElement>('[data-morph-ghost]');
    expect(ghost?.hasAttribute('inert')).toBe(true);

    fireEvent.keyDown(document, { key: 'Escape' });
    expect(panel.dataset.state).toBe('closed');
    expect(panel.querySelector<HTMLElement>('.max-h-full')?.hasAttribute('inert')).toBe(true);
  });

  it('clamps an oversized panel to the viewport and remeasures the trigger before closing', async () => {
    setReducedMotion(false);
    Object.defineProperty(window, 'innerWidth', { configurable: true, value: 320 });
    let triggerLeft = 24;
    vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(function (
      this: HTMLElement,
    ) {
      if (this.matches('span.relative')) {
        return {
          x: triggerLeft,
          y: 100,
          left: triggerLeft,
          top: 100,
          right: triggerLeft + 40,
          bottom: 130,
          width: 40,
          height: 30,
          toJSON: () => ({}),
        } as DOMRect;
      }
      return {
        x: 0,
        y: 0,
        left: 0,
        top: 0,
        right: 0,
        bottom: 0,
        width: 0,
        height: 0,
        toJSON: () => ({}),
      } as DOMRect;
    });
    vi.spyOn(HTMLElement.prototype, 'offsetHeight', 'get').mockReturnValue(180);

    render(<Harness panelWidth={500} />);
    fireEvent.click(screen.getByRole('button', { name: 'Toggle' }));
    const panel = await screen.findByRole('group', { name: 'Morph panel' });
    await waitFor(() => expect(panel.style.width).toBe('304px'));
    expect(panel.style.left).toBe('8px');

    triggerLeft = 80;
    fireEvent.keyDown(document, { key: 'Escape' });
    expect(panel.style.left).toBe('80px');
  });

  it('cancels a queued opening frame when closing interrupts the animation', async () => {
    let nextFrame = 1;
    const requestFrame = vi.fn(() => nextFrame++);
    const cancelFrame = vi.fn();
    vi.stubGlobal('requestAnimationFrame', requestFrame);
    vi.stubGlobal('cancelAnimationFrame', cancelFrame);

    render(<Harness />);
    const trigger = screen.getByRole('button', { name: 'Toggle' });
    fireEvent.click(trigger);
    await screen.findByRole('group', { name: 'Morph panel' });
    fireEvent.click(trigger);

    expect(requestFrame).toHaveBeenCalled();
    expect(cancelFrame).toHaveBeenCalledWith(1);
  });

  it('remeasures content that grows during the opening animation after settling', () => {
    setReducedMotion(false);
    vi.useFakeTimers();

    let resizeCallback: ResizeObserverCallback | null = null;
    class TestResizeObserver {
      constructor(callback: ResizeObserverCallback) {
        resizeCallback = callback;
      }
      observe() {}
      unobserve() {}
      disconnect() {}
    }
    vi.stubGlobal('ResizeObserver', TestResizeObserver);

    let nextFrame = 1;
    const queuedFrames = new Map<number, FrameRequestCallback>();
    vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => {
      const id = nextFrame++;
      queuedFrames.set(id, callback);
      return id;
    });
    vi.stubGlobal('cancelAnimationFrame', (id: number) => queuedFrames.delete(id));
    const runFrame = () => {
      const callbacks = [...queuedFrames.values()];
      queuedFrames.clear();
      callbacks.forEach((callback) => callback(performance.now()));
    };

    let contentHeight = 100;
    vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(function (
      this: HTMLElement,
    ) {
      if (this.matches('span.relative')) {
        return {
          x: 24,
          y: 570,
          left: 24,
          top: 570,
          right: 64,
          bottom: 600,
          width: 40,
          height: 30,
          toJSON: () => ({}),
        } as DOMRect;
      }
      return {
        x: 0,
        y: 0,
        left: 0,
        top: 0,
        right: 0,
        bottom: 0,
        width: 0,
        height: 0,
        toJSON: () => ({}),
      } as DOMRect;
    });
    vi.spyOn(HTMLElement.prototype, 'offsetWidth', 'get').mockImplementation(function (
      this: HTMLElement,
    ) {
      return this.style.width && this.style.width !== 'max-content'
        ? Number.parseFloat(this.style.width)
        : 240;
    });
    vi.spyOn(HTMLElement.prototype, 'offsetHeight', 'get').mockImplementation(function (
      this: HTMLElement,
    ) {
      return this.style.height && this.style.height !== 'auto'
        ? Number.parseFloat(this.style.height)
        : contentHeight;
    });

    render(<Harness panelWidth={240} />);
    fireEvent.click(screen.getByRole('button', { name: 'Toggle' }));
    const panel = screen.getByRole('group', { name: 'Morph panel' });
    act(runFrame);
    act(runFrame);
    expect(panel.style.height).toBe('100px');

    contentHeight = 240;
    act(() => resizeCallback?.([], {} as ResizeObserver));
    act(runFrame);
    expect(panel.style.height).toBe('100px');

    act(() => vi.advanceTimersByTime(300));
    expect(panel.style.height).toBe('240px');
  });
});
