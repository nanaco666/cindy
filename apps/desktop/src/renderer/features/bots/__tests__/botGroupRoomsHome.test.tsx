// @vitest-environment jsdom

import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  navigate: vi.fn(),
  setSearchParams: vi.fn(),
  search: '',
  bots: [] as unknown[],
  rooms: [] as unknown[],
  createRoom: vi.fn(),
}));

vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}));

vi.mock('react-router-dom', () => ({
  useNavigate: () => mocks.navigate,
  useSearchParams: () => [new URLSearchParams(mocks.search), mocks.setSearchParams],
}));

vi.mock('../botStore', () => ({
  useBotProfiles: () => mocks.bots,
  canonicalBotSessionId: (bot: { sessions?: Array<{ id: string }> }) => bot.sessions?.[0]?.id,
}));

vi.mock('../botGroupStore', () => ({
  useBotGroupRooms: () => mocks.rooms,
  createBotGroupRoom: mocks.createRoom,
}));

import { BotGroupRoomsHome } from '../BotGroupRoomsHome';

function bot(id: string, name: string) {
  return {
    id,
    name,
    avatar: '🤖',
    avatarColor: 'blue',
    description: '',
    status: 'active',
    sessions: [{ id: `${id}-session` }],
  };
}

describe('BotGroupRoomsHome', () => {
  beforeEach(() => {
    mocks.navigate.mockReset();
    mocks.setSearchParams.mockReset();
    mocks.createRoom.mockReset();
    mocks.search = '';
    mocks.bots = [];
    mocks.rooms = [];
  });

  it('shows one creation empty state when no room exists', () => {
    render(<BotGroupRoomsHome />);
    expect(screen.getAllByRole('button')).toHaveLength(1);
    expect(screen.getByText('bots.groups.emptyTitle')).toBeTruthy();
  });

  it('sends /bots/groups to the most recently updated room', async () => {
    mocks.rooms = [
      { id: 'older', updatedAt: 10 },
      { id: 'latest', updatedAt: 20 },
    ];
    render(<BotGroupRoomsHome />);
    await waitFor(() => expect(mocks.navigate).toHaveBeenCalledWith(
      '/bots/groups/latest',
      { replace: true },
    ));
  });

  it('opens creation directly and persists the ordered default name', async () => {
    mocks.search = 'create=1';
    mocks.bots = [bot('a', 'Alpha'), bot('b', 'Beta'), bot('c', 'Gamma')];
    mocks.createRoom.mockResolvedValue({ id: 'room-new' });
    render(<BotGroupRoomsHome />);

    fireEvent.click(screen.getByText('Alpha').closest('button')!);
    fireEvent.click(screen.getByText('Beta').closest('button')!);
    fireEvent.click(screen.getByText('Gamma').closest('button')!);
    fireEvent.click(screen.getByRole('button', { name: 'bots.groups.create' }));

    await waitFor(() => expect(mocks.createRoom).toHaveBeenCalledWith({
      name: 'Alpha, Beta & Gamma',
      memberBotIds: ['a', 'b', 'c'],
    }));
    expect(mocks.navigate).toHaveBeenCalledWith('/bots/groups/room-new');
  });

  it('keeps a custom name ahead of the generated default', async () => {
    mocks.search = 'create=1';
    mocks.bots = [bot('a', 'Alpha'), bot('b', 'Beta')];
    mocks.createRoom.mockResolvedValue({ id: 'room-custom' });
    render(<BotGroupRoomsHome />);

    fireEvent.change(screen.getByPlaceholderText('bots.groups.namePlaceholder'), {
      target: { value: 'Launch crew' },
    });
    fireEvent.click(screen.getByText('Alpha').closest('button')!);
    fireEvent.click(screen.getByText('Beta').closest('button')!);
    fireEvent.click(screen.getByRole('button', { name: 'bots.groups.create' }));

    await waitFor(() => expect(mocks.createRoom).toHaveBeenCalledWith({
      name: 'Launch crew',
      memberBotIds: ['a', 'b'],
    }));
  });
});
