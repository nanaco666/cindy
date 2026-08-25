// @vitest-environment jsdom

import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  navigate: vi.fn(),
  params: { botId: 'bot-1', sessionId: 'session-1' } as Record<string, string | undefined>,
  profiles: [] as Array<Record<string, unknown>>,
  wide: true,
  mediaListeners: new Set<() => void>(),
}));

vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}));
vi.mock('react-router-dom', () => ({
  useNavigate: () => mocks.navigate,
  useParams: () => mocks.params,
}));
vi.mock('@/features/cc-agent/CCAgentSessionView', () => ({
  CCAgentSessionView: () => <div data-testid="chat" />,
}));
vi.mock('../botStore', () => ({
  useBotProfiles: () => mocks.profiles,
}));
vi.mock('../BotAutomationSettings', () => ({
  BotAutomationSettings: ({ bot, surface }: { bot: { id: string }; surface: string }) => (
    <div data-testid="automation-settings">
      {bot.id}:{surface}
    </div>
  ),
}));

import { BOT_AUTOMATION_TOGGLE_EVENT } from '../BotSessionContentHeader';
import { BotSessionView } from '../BotSessionView';

const canonicalBot = {
  id: 'bot-1',
  name: '总控',
  status: 'active',
  enabled: true,
  capabilities: { permissions: 'ask' },
  sessions: [
    {
      id: 'session-1',
      kind: 'chat',
      role: 'canonical',
      status: 'active',
    },
  ],
};

function installElectronApi(bot: typeof canonicalBot): void {
  Object.defineProperty(window, 'electronAPI', {
    configurable: true,
    writable: true,
    value: {
      localDb: {
        bots: {
          get: vi.fn(async () => bot),
          list: vi.fn(async () => [bot]),
        },
        messages: {
          list: vi.fn(async () => [{ id: 'existing-message' }]),
          create: vi.fn(async () => undefined),
          onCreated: () => () => undefined,
        },
      },
    },
  });
}

beforeEach(() => {
  mocks.navigate.mockReset();
  mocks.params = { botId: 'bot-1', sessionId: 'session-1' };
  mocks.profiles = [canonicalBot];
  mocks.wide = true;
  mocks.mediaListeners.clear();
  installElectronApi(canonicalBot);
  Object.defineProperty(window, 'matchMedia', {
    configurable: true,
    writable: true,
    value: vi.fn(() => ({
      get matches() {
        return mocks.wide;
      },
      media: '(min-width: 1280px)',
      onchange: null,
      addListener: vi.fn(),
      removeListener: vi.fn(),
      addEventListener: (_type: string, listener: () => void) => mocks.mediaListeners.add(listener),
      removeEventListener: (_type: string, listener: () => void) =>
        mocks.mediaListeners.delete(listener),
      dispatchEvent: vi.fn(),
    })),
  });
});

afterEach(() => cleanup());

describe('Bot canonical Chat automation surface', () => {
  it('keeps the Bot automation panel collapsed by default and opens it from the header event', async () => {
    render(<BotSessionView />);

    await waitFor(() => expect(screen.getByTestId('chat')).toBeTruthy());
    expect(screen.queryByTestId('bot-automation-panel')).toBeNull();

    act(() => window.dispatchEvent(new CustomEvent(BOT_AUTOMATION_TOGGLE_EVENT)));

    await waitFor(() => expect(screen.getByTestId('bot-automation-panel')).toBeTruthy());
    expect(screen.getByTestId('automation-settings').textContent).toBe('bot-1:panel');

    act(() => window.dispatchEvent(new CustomEvent(BOT_AUTOMATION_TOGGLE_EVENT)));

    expect(screen.queryByTestId('bot-automation-panel')).toBeNull();
  });

  it('opens a closable drawer on narrow screens', async () => {
    mocks.wide = false;
    render(<BotSessionView />);
    await waitFor(() => expect(screen.getByTestId('chat')).toBeTruthy());

    act(() => window.dispatchEvent(new CustomEvent(BOT_AUTOMATION_TOGGLE_EVENT)));

    const drawer = await screen.findByTestId('bot-automation-drawer');
    expect(drawer).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'bots.close' }));
    await waitFor(() => expect(screen.queryByTestId('bot-automation-drawer')).toBeNull());
  });

  it('closes the narrow drawer when the window grows wide instead of leaving an invisible modal', async () => {
    mocks.wide = false;
    render(<BotSessionView />);
    await waitFor(() => expect(screen.getByTestId('chat')).toBeTruthy());

    act(() => window.dispatchEvent(new CustomEvent(BOT_AUTOMATION_TOGGLE_EVENT)));
    expect(await screen.findByTestId('bot-automation-drawer')).toBeTruthy();

    act(() => {
      mocks.wide = true;
      for (const listener of mocks.mediaListeners) listener();
    });

    await waitFor(() => expect(screen.queryByTestId('bot-automation-drawer')).toBeNull());
    expect(screen.queryByTestId('bot-automation-panel')).toBeNull();
  });

  it('does not expose automation on a non-canonical route task', async () => {
    const routeBot = {
      ...canonicalBot,
      sessions: [
        {
          id: 'session-1',
          kind: 'route',
          role: 'route',
          status: 'active',
        },
      ],
    };
    mocks.profiles = [routeBot];
    installElectronApi(routeBot);
    render(<BotSessionView />);
    await waitFor(() => expect(screen.getByTestId('chat')).toBeTruthy());

    act(() => window.dispatchEvent(new CustomEvent(BOT_AUTOMATION_TOGGLE_EVENT)));

    expect(screen.queryByTestId('bot-automation-panel')).toBeNull();
    expect(screen.queryByTestId('bot-automation-drawer')).toBeNull();
  });
});
