// @vitest-environment jsdom

import { cleanup, render } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';

import { BotGroupAvatar } from '../BotGroupAvatar';

const members = ['Alpha', 'Beta', 'Gamma', 'Delta', 'Epsilon'].map((name, index) => ({
  id: String(index),
  name,
  avatar: index % 2 === 0 ? '🤖' : '',
  avatarColor: index % 2 === 0 ? 'blue' : 'teal',
}));

afterEach(cleanup);

describe('BotGroupAvatar', () => {
  it.each([2, 3, 4])('keeps %i members inside one regular Bot-sized circle', (count) => {
    const { container } = render(<BotGroupAvatar members={members.slice(0, count)} />);
    const avatar = container.firstElementChild as HTMLElement;

    expect(avatar.className).toContain('h-10');
    expect(avatar.className).toContain('w-10');
    expect(avatar.className).toContain('rounded-full');
    expect(avatar.querySelectorAll('[data-testid="bot-group-avatar-member"]')).toHaveLength(count);
  });

  it('shows at most four portraits when the group has more members', () => {
    const { container } = render(<BotGroupAvatar members={members} />);
    const avatar = container.firstElementChild as HTMLElement;

    expect(avatar.dataset.memberCount).toBe('4');
    expect(avatar.querySelectorAll('[data-testid="bot-group-avatar-member"]')).toHaveLength(4);
    expect(avatar.textContent).not.toContain('E');
  });

  it('uses the three-member split with one tall portrait and two stacked portraits', () => {
    const { container } = render(<BotGroupAvatar members={members.slice(0, 3)} />);
    const cells = container.querySelectorAll<HTMLElement>('[data-testid="bot-group-avatar-member"]');

    expect(cells[0].className).toContain('row-span-2');
    expect(cells[1].className).not.toContain('row-span-2');
    expect(cells[2].className).not.toContain('row-span-2');
  });
});
