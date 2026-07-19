// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import React from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  writeText: vi.fn(),
  toastSuccess: vi.fn(),
  toastError: vi.fn(),
}));

vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}));

vi.mock('@/contexts/AuthContext', () => ({
  useAuth: () => ({
    user: {
      id: 'user-123',
      name: 'Lizi',
      avatar: null,
    },
  }),
}));

vi.mock('@/lib/toast', () => ({
  toast: { success: mocks.toastSuccess, error: mocks.toastError },
}));

vi.mock('@/components/settings/ProfileEditDialog', () => ({
  ProfileEditDialog: ({ open }: { open: boolean }) =>
    open ? <div data-testid="profile-edit-dialog" /> : null,
}));

import { UserProfileCard } from '@/components/settings/UserProfileCard';

describe('UserProfileCard copy user ID', () => {
  beforeEach(() => {
    Object.defineProperty(navigator, 'clipboard', {
      configurable: true,
      value: { writeText: mocks.writeText },
    });
    mocks.writeText.mockResolvedValue(undefined);
  });

  afterEach(() => {
    cleanup();
    vi.clearAllMocks();
  });

  it('copies the user ID and shows a success toast when the name is clicked', async () => {
    render(<UserProfileCard />);

    const nameButton = screen.getByRole('button', {
      name: 'settings.userProfile.copyUserId.action',
    });
    expect(nameButton.className).toContain('cursor-pointer');
    expect(nameButton.className).toContain('hover:bg-[var(--settings-profile-avatar-bg)]');

    fireEvent.click(nameButton);

    await waitFor(() => expect(mocks.writeText).toHaveBeenCalledWith('user-123'));
    expect(mocks.toastSuccess).toHaveBeenCalledWith('settings.userProfile.copyUserId.success');
  });

  it('opens the profile edit dialog when the avatar is clicked', () => {
    render(<UserProfileCard />);

    expect(screen.queryByTestId('profile-edit-dialog')).toBeNull();

    // 头像与铅笔共用 edit.open 标签;取第一个(头像)点击。
    const [avatarButton] = screen.getAllByRole('button', {
      name: 'settings.userProfile.edit.open',
    });
    expect(avatarButton.className).toContain('cursor-pointer');

    fireEvent.click(avatarButton);

    expect(screen.getByTestId('profile-edit-dialog')).toBeTruthy();
    expect(mocks.writeText).not.toHaveBeenCalled();
  });

  it('shows an error toast when clipboard access fails', async () => {
    mocks.writeText.mockRejectedValueOnce(new Error('clipboard denied'));
    render(<UserProfileCard />);

    fireEvent.click(screen.getByRole('button', { name: 'settings.userProfile.copyUserId.action' }));

    await waitFor(() =>
      expect(mocks.toastError).toHaveBeenCalledWith('settings.userProfile.copyUserId.failed'),
    );
  });
});
