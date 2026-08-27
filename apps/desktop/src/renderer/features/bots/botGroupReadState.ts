const STORAGE_KEY_PREFIX = 'cindy.botGroups.readState.v1';

type ReadStateMap = Record<string, number>;

let activeOwnerId: string | null = null;
let cache: ReadStateMap | null = null;
const subscribers = new Set<() => void>();

function storageKey(): string {
  return `${STORAGE_KEY_PREFIX}.${activeOwnerId ?? 'signed-out'}`;
}

function readStorage(): ReadStateMap {
  if (cache) return cache;
  const next: ReadStateMap = {};
  try {
    const raw = window.localStorage.getItem(storageKey());
    const parsed = raw ? JSON.parse(raw) as unknown : null;
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      for (const [roomId, at] of Object.entries(parsed as Record<string, unknown>)) {
        if (typeof at === 'number' && Number.isFinite(at) && at > 0) next[roomId] = at;
      }
    }
  } catch {
    // A broken read marker may add a badge, but must never break group navigation.
  }
  cache = next;
  return next;
}

function writeStorage(next: ReadStateMap): void {
  cache = next;
  try {
    window.localStorage.setItem(storageKey(), JSON.stringify(next));
  } catch {
    // Keep the current window correct even when persistence is unavailable.
  }
  for (const subscriber of subscribers) subscriber();
}

export function setBotGroupReadStateOwner(ownerId: string | null): void {
  if (activeOwnerId === ownerId) return;
  activeOwnerId = ownerId;
  cache = null;
  for (const subscriber of subscribers) subscriber();
}

export function getBotGroupLastReadAt(roomId: string): number | null {
  return readStorage()[roomId] ?? null;
}

export function markBotGroupRead(roomId: string, at: number = Date.now()): boolean {
  if (!roomId || !Number.isFinite(at) || at <= 0) return false;
  const current = readStorage();
  if (at <= (current[roomId] ?? 0)) return false;
  writeStorage({ ...current, [roomId]: Math.floor(at) });
  return true;
}

export function seedMissingBotGroupReadState(
  roomIds: readonly string[],
  at: number = Date.now(),
): boolean {
  if (!Number.isFinite(at) || at <= 0) return false;
  const current = readStorage();
  const next = { ...current };
  let changed = false;
  for (const roomId of roomIds) {
    if (!roomId || next[roomId] !== undefined) continue;
    next[roomId] = Math.floor(at);
    changed = true;
  }
  if (changed) writeStorage(next);
  return changed;
}

export function subscribeBotGroupReadState(listener: () => void): () => void {
  subscribers.add(listener);
  return () => subscribers.delete(listener);
}

export function resetBotGroupReadStateForTests(): void {
  activeOwnerId = null;
  cache = null;
  subscribers.clear();
}
