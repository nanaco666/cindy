import { useEffect } from 'react';
import { Outlet, useOutletContext } from 'react-router-dom';

import { useOwnTopNavScrollableRows } from '../feature-context';
import { BotsSidebar } from './BotsSidebar';
import { refreshBotGroupRooms } from './botGroupStore';
import { refreshBotProfiles } from './botStore';

export function BotsFeatureLayout() {
  useOwnTopNavScrollableRows(false);
  useEffect(() => {
    refreshBotProfiles();
    void refreshBotGroupRooms();
    const unsubscribeLifecycle = window.electronAPI.maker.onBotLifecycleChanged(() => refreshBotProfiles());
    const unsubscribeGroups = window.electronAPI.maker.botGroups.onChanged(() => {
      void refreshBotGroupRooms();
    });
    return () => {
      unsubscribeLifecycle();
      unsubscribeGroups();
    };
  }, []);
  const shellContext = useOutletContext<{
    sidebarWidth?: number;
    rightSidebarCollapsed?: boolean;
    onToggleRightSidebar?: () => void;
    rightSidebarSide?: 'left' | 'right';
    setRightSidebarAvailable?: (available: boolean) => void;
    setRightSidebarSessionId?: (
      sessionId: string | null,
      opts?: { initialCollapsed?: boolean; writeInitialCollapsedRecord?: boolean },
    ) => void;
    setRightSidebarWorkdir?: (
      workdir: string,
      remoteHostId?: string | null,
      deviceLinkDeviceId?: string | null,
    ) => void;
  } | null>();
  return (
    <>
      <BotsSidebar />
      <Outlet context={shellContext} />
    </>
  );
}
