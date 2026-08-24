import { useSyncExternalStore } from 'react';

import type { BotGroupRoomProjection } from '../../../shared/botGroupChat';
import type { BotGroupRoomIdentityPatch } from '../../../shared/botGroupChat';

let rooms: BotGroupRoomProjection[] = [];
const listeners = new Set<() => void>();

function emit(): void {
  for (const listener of listeners) listener();
}

export async function refreshBotGroupRooms(): Promise<void> {
  rooms = await window.electronAPI.maker.botGroups.list();
  emit();
}

export async function refreshBotGroupRoom(
  roomId: string,
): Promise<BotGroupRoomProjection | null> {
  const room = await window.electronAPI.maker.botGroups.get(roomId);
  rooms = room
    ? [...rooms.filter((candidate) => candidate.id !== room.id), room]
        .sort((left, right) => left.createdAt - right.createdAt)
    : rooms.filter((candidate) => candidate.id !== roomId);
  emit();
  return room;
}

export function useBotGroupRooms(): BotGroupRoomProjection[] {
  return useSyncExternalStore(
    (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    () => rooms,
    () => rooms,
  );
}

export function getBotGroupRoom(roomId: string): BotGroupRoomProjection | null {
  return rooms.find((room) => room.id === roomId) ?? null;
}

export async function createBotGroupRoom(input: {
  name: string;
  memberBotIds: string[];
}): Promise<BotGroupRoomProjection> {
  const created = await window.electronAPI.maker.botGroups.create(input);
  await refreshBotGroupRooms();
  return created;
}

export async function updateBotGroupRoom(
  roomId: string,
  patch: BotGroupRoomIdentityPatch,
): Promise<BotGroupRoomProjection> {
  const updated = await window.electronAPI.maker.botGroups.update(roomId, patch);
  await refreshBotGroupRoom(roomId);
  return updated;
}

export async function archiveBotGroupRoom(roomId: string): Promise<BotGroupRoomProjection> {
  const archived = await window.electronAPI.maker.botGroups.archive(roomId);
  await refreshBotGroupRoom(roomId);
  return archived;
}
