import { randomUUID } from 'node:crypto';

import type { AgentKind } from '@cindy/maker-core';
import { and, asc, eq, inArray, isNull } from 'drizzle-orm';

import {
  validateBotGroupMembers,
  type BotGroupMember,
  type BotGroupRoomIdentityPatch,
  type BotGroupRoomProjection,
} from '../../shared/botGroupChat.js';
import { getDbClient } from '../localDb/client/current.js';
import { ensureDialogueWorkspaceDir } from '../localDb/dialogueWorkspace.js';
import {
  botGroupMembers,
  botGroupMemberWatermarks,
  botGroupRooms,
  botProfiles,
  botSessionLinks,
  sessions,
} from '../localDb/schema.js';
import type { BotGroupRoomRuntime } from './botGroupChatCoordinator.js';
import { createBotGroupSessionMessageStore } from './botGroupSessionMessages.js';
import { getActiveCatalog } from '../maker-host/active-catalog.js';
import { deriveAvailableModels } from '../maker-host/catalog-to-descriptors.js';

interface BotGroupChatStoreDeps {
  createId?: () => string;
  now?: () => number;
  ensureDialogueWorkspaceDir?: (sessionId: string, now?: number) => string;
}

type CanonicalSeed = {
  botId: string;
  name: string;
  profileVersion: number;
  canonicalSessionId: string;
  title: string;
  workingDir: string | null;
  workspaceKind: 'project' | 'dialogue';
  model: string;
  effort: string;
  permissionMode: string;
  fastMode: boolean;
  agentKind: string;
  worktreePath: string | null;
  extraDirs: string;
  remoteHostId: string | null;
  providerId: string | null;
};

function catalogDefaultSessionConfig(
  agentKind: string,
  catalog = getActiveCatalog(),
): { model: string; effort: string | null } {
  const agent: AgentKind = agentKind === 'codex' ? 'codex' : agentKind === 'pi' ? 'pi' : 'claude-code';
  const models = deriveAvailableModels(catalog, agent);
  const model = models.find((candidate) => candidate.newSessionDefault?.includes(agent))
    ?? models[0];
  return { model: model?.id ?? '', effort: model?.defaultEffort ?? null };
}

export function createBotGroupChatStore(deps: BotGroupChatStoreDeps = {}) {
  const createId = deps.createId ?? randomUUID;
  const now = deps.now ?? Date.now;
  const allocateDialogueDir = deps.ensureDialogueWorkspaceDir ?? ensureDialogueWorkspaceDir;

  const loadCanonicalSeeds = async (botIds: readonly string[]): Promise<CanonicalSeed[]> => {
    const db = getDbClient().drizzle;
    const rows = await db
      .select({
        botId: botProfiles.id,
        name: botProfiles.displayName,
        profileStatus: botProfiles.status,
        profileVersion: botProfiles.currentVersion,
        canonicalSessionId: botSessionLinks.sessionId,
        linkArchivedAt: botSessionLinks.archivedAt,
        sessionStatus: sessions.status,
        sessionSource: sessions.source,
        title: sessions.title,
        workingDir: sessions.workingDir,
        workspaceKind: sessions.workspaceKind,
        model: sessions.model,
        effort: sessions.effort,
        permissionMode: sessions.permissionMode,
        fastMode: sessions.fastMode,
        agentKind: sessions.agentKind,
        worktreePath: sessions.worktreePath,
        extraDirs: sessions.extraDirs,
        remoteHostId: sessions.remoteHostId,
        providerId: sessions.providerId,
      })
      .from(botProfiles)
      .innerJoin(
        botSessionLinks,
        and(
          eq(botSessionLinks.botId, botProfiles.id),
          eq(botSessionLinks.role, 'canonical'),
          isNull(botSessionLinks.archivedAt),
        ),
      )
      .innerJoin(sessions, eq(sessions.id, botSessionLinks.sessionId))
      .where(inArray(botProfiles.id, [...botIds]));

    const byId = new Map(rows.map((row) => [row.botId, row]));
    return botIds.map((botId) => {
      const row = byId.get(botId);
      if (
        !row
        || row.profileStatus !== 'active'
        || row.sessionStatus !== 'active'
        || row.sessionSource !== 'bot'
        || row.linkArchivedAt !== null
      ) {
        throw new Error(`Bot ${botId} has no active canonical Session link`);
      }
      return {
        botId: row.botId,
        name: row.name,
        profileVersion: row.profileVersion,
        canonicalSessionId: row.canonicalSessionId,
        title: row.title,
        workingDir: row.workingDir,
        workspaceKind: row.workspaceKind,
        model: row.model,
        effort: row.effort,
        permissionMode: row.permissionMode,
        fastMode: row.fastMode,
        agentKind: row.agentKind,
        worktreePath: row.worktreePath,
        extraDirs: row.extraDirs,
        remoteHostId: row.remoteHostId,
        providerId: row.providerId,
      };
    });
  };

  const loadRoom = async (roomId: string): Promise<BotGroupRoomProjection | null> => {
    const db = getDbClient().drizzle;
    const [room] = await db
      .select()
      .from(botGroupRooms)
      .where(eq(botGroupRooms.id, roomId))
      .limit(1);
    if (!room) return null;
    const rows = await db
      .select({
        botId: botGroupMembers.botId,
        name: botProfiles.displayName,
        sessionId: botGroupMembers.memberSessionId,
        watermark: botGroupMembers.watermark,
        holdAt: botGroupMembers.holdAt,
        holdMessageId: botGroupMembers.holdMessageId,
        holdThreadId: botGroupMembers.holdThreadId,
        holdNoted: botGroupMembers.holdNoted,
        strandedBeforeSequence: botGroupMembers.strandedBeforeSequence,
        strandedThreadId: botGroupMembers.strandedThreadId,
        strandedStartedAt: botGroupMembers.strandedStartedAt,
        rosterOrder: botGroupMembers.rosterOrder,
      })
      .from(botGroupMembers)
      .innerJoin(botProfiles, eq(botProfiles.id, botGroupMembers.botId))
      .innerJoin(sessions, eq(sessions.id, botGroupMembers.memberSessionId))
      .where(
        and(
          eq(botGroupMembers.roomId, roomId),
          eq(sessions.source, 'bot'),
        ),
      )
      .orderBy(asc(botGroupMembers.rosterOrder));
    const watermarkRows = await db
      .select({
        botId: botGroupMemberWatermarks.botId,
        threadId: botGroupMemberWatermarks.threadId,
        sequence: botGroupMemberWatermarks.sequence,
      })
      .from(botGroupMemberWatermarks)
      .where(eq(botGroupMemberWatermarks.roomId, roomId));
    const watermarksByBot = new Map<string, Record<string, number>>();
    for (const row of watermarkRows) {
      const current = watermarksByBot.get(row.botId) ?? {};
      current[row.threadId] = row.sequence;
      watermarksByBot.set(row.botId, current);
    }
    return {
      id: room.id,
      name: room.displayName,
      avatar: room.avatar,
      roomSessionId: room.roomSessionId,
      status: room.status,
      epoch: room.epoch,
      running: room.running,
      needsUser: room.needsUser,
      createdAt: room.createdAt,
      updatedAt: room.updatedAt,
      members: rows.map((row) => ({
        botId: row.botId,
        name: row.name,
        sessionId: row.sessionId,
        watermark: row.watermark,
        watermarks: watermarksByBot.get(row.botId) ?? {},
        hold: row.holdAt !== null && row.holdThreadId
          ? {
              at: row.holdAt,
              byMessageId: row.holdMessageId,
              threadId: row.holdThreadId,
              noted: row.holdNoted,
            }
          : null,
        stranded: row.strandedBeforeSequence !== null && row.strandedThreadId
          && row.strandedStartedAt !== null
          ? {
              beforeSequence: row.strandedBeforeSequence,
              threadId: row.strandedThreadId,
              startedAt: row.strandedStartedAt,
            }
          : null,
      })),
    };
  };

  const sessionMessages = createBotGroupSessionMessageStore({ createId, loadRoom, now });

  const createRoom = async (input: {
    id?: string;
    name: string;
    memberBotIds: string[];
  }): Promise<BotGroupRoomProjection> => {
    const roomId = input.id?.trim() || createId();
    const name = input.name.trim();
    if (!roomId || !name) throw new Error('Bot group room id and name are required');
    const placeholderMembers: BotGroupMember[] = input.memberBotIds.map((botId) => ({
      botId: botId.trim(),
      name: botId.trim(),
    }));
    const validation = validateBotGroupMembers(placeholderMembers);
    if (!validation.ok) throw new Error(`Invalid Bot group roster: ${validation.reason}`);
    const seeds = await loadCanonicalSeeds(placeholderMembers.map((member) => member.botId));
    const at = now();
    const roomSessionId = createId();
    const first = seeds[0]!;
    const catalog = getActiveCatalog();
    const firstDefaults = catalogDefaultSessionConfig(first.agentKind, catalog);
    const roomModel = firstDefaults.model || first.model;
    const roomEffort = firstDefaults.effort ?? first.effort;
    const roomSession = {
      id: roomSessionId,
      title: `Group: ${name}`,
      workingDir: allocateDialogueDir(roomSessionId, at),
      workspaceKind: 'dialogue' as const,
      model: roomModel,
      effort: roomEffort,
      permissionMode: first.permissionMode,
      fastMode: first.fastMode,
      agentKind: first.agentKind,
      worktreePath: null,
      extraDirs: '[]',
      remoteHostId: null,
      providerId: null,
      source: 'bot',
      createdAt: at,
      updatedAt: at,
    };
    const members = seeds.map((seed, rosterOrder) => {
      const sessionId = createId();
      const defaults = catalogDefaultSessionConfig(seed.agentKind, catalog);
      return {
        id: createId(),
        botId: seed.botId,
        expectedCanonicalSessionId: seed.canonicalSessionId,
        profileVersion: seed.profileVersion,
        rosterOrder,
        session: {
          id: sessionId,
          title: `Group: ${roomId}`,
          workingDir: seed.workingDir,
          workspaceKind: seed.workspaceKind,
          model: defaults.model || seed.model,
          effort: defaults.effort ?? seed.effort,
          permissionMode: seed.permissionMode,
          fastMode: seed.fastMode,
          agentKind: seed.agentKind,
          worktreePath: seed.worktreePath,
          extraDirs: seed.extraDirs,
          remoteHostId: seed.remoteHostId,
          providerId: null,
          source: 'bot',
          createdAt: at,
          updatedAt: at,
        },
      };
    });
    await getDbClient().tx('bots.createGroupRoom', {
      room: { id: roomId, displayName: name, roomSession, createdAt: at },
      members,
    });
    const created = await loadRoom(roomId);
    if (!created || created.members.length !== seeds.length) {
      throw new Error('Bot group room was not persisted completely');
    }
    return created;
  };

  const listRooms = async (botId?: string): Promise<BotGroupRoomProjection[]> => {
    const db = getDbClient().drizzle;
    const ids = botId
      ? (await db
          .select({ id: botGroupMembers.roomId })
          .from(botGroupMembers)
          .where(eq(botGroupMembers.botId, botId))
          .orderBy(asc(botGroupMembers.createdAt)))
          .map((row) => row.id)
      : (await db
          .select({ id: botGroupRooms.id })
          .from(botGroupRooms)
          .orderBy(asc(botGroupRooms.createdAt)))
          .map((row) => row.id);
    const rooms = await Promise.all(ids.map((id) => loadRoom(id)));
    return rooms.filter((room): room is BotGroupRoomProjection => room !== null);
  };

  const updateRoomIdentity = async (
    roomId: string,
    patch: BotGroupRoomIdentityPatch,
  ): Promise<BotGroupRoomProjection> => {
    const name = patch.name?.trim();
    const avatar = patch.avatar?.trim();
    if (patch.name !== undefined && (!name || name.length > 120)) {
      throw new Error('Bot group room name must be 1-120 characters');
    }
    if (patch.avatar !== undefined && (!avatar || avatar.length > 16)) {
      throw new Error('Bot group room avatar must be 1-16 characters');
    }
    if (name === undefined && avatar === undefined) {
      throw new Error('Bot group room identity patch is empty');
    }
    await getDbClient().tx('bots.updateGroupRoomIdentity', {
      roomId,
      ...(name !== undefined ? { name } : {}),
      ...(avatar !== undefined ? { avatar } : {}),
      at: now(),
    });
    const updated = await loadRoom(roomId);
    if (!updated) throw new Error('Bot group room disappeared after identity update');
    return updated;
  };

  const archiveRoom = async (roomId: string): Promise<BotGroupRoomProjection> => {
    await getDbClient().tx('bots.archiveGroupRoom', { roomId, at: now() });
    const archived = await loadRoom(roomId);
    if (!archived) throw new Error('Bot group room disappeared after archive');
    return archived;
  };

  const bumpEpoch = async (roomId: string): Promise<number> => {
    const row = await getDbClient().queryOne<{ epoch: number }>(
      `UPDATE bot_group_rooms SET epoch = epoch + 1, running = 1, needs_user = 0,
        updated_at = MAX(updated_at, ?) WHERE id = ? AND status = 'active' RETURNING epoch`,
      [now(), roomId],
    );
    if (!row) throw new Error('Bot group room is unavailable');
    return row.epoch;
  };

  const readEpoch = async (roomId: string): Promise<number | null> => {
    const row = await getDbClient().queryOne<{ epoch: number }>(
      'SELECT epoch FROM bot_group_rooms WHERE id = ?',
      [roomId],
    );
    return row?.epoch ?? null;
  };

  const setRunning = async (
    roomId: string,
    expectedEpoch: number,
    running: boolean,
  ): Promise<void> => {
    await getDbClient().exec(
      `UPDATE bot_group_rooms SET running = ?, updated_at = MAX(updated_at, ?)
       WHERE id = ? AND epoch = ?`,
      [running ? 1 : 0, now(), roomId, expectedEpoch],
    );
  };

  const setNeedsUser = async (roomId: string, needsUser: boolean): Promise<void> => {
    await getDbClient().exec(
      `UPDATE bot_group_rooms SET needs_user = ?, updated_at = MAX(updated_at, ?)
       WHERE id = ?`,
      [needsUser ? 1 : 0, now(), roomId],
    );
  };

  const advanceWatermark = async (
    roomId: string,
    botId: string,
    threadId: string,
    sequence: number,
  ): Promise<void> => {
    const at = now();
    await getDbClient().exec(
      `INSERT INTO bot_group_member_watermarks
        (id, room_id, bot_id, thread_id, sequence, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(room_id, bot_id, thread_id) DO UPDATE SET
         sequence = MAX(sequence, excluded.sequence),
         updated_at = MAX(updated_at, excluded.updated_at)`,
      [createId(), roomId, botId, threadId, Math.max(0, sequence), at, at],
    );
  };

  const updateMemberHolds = async (input: {
    roomId: string;
    holdBotIds: readonly string[];
    releaseBotIds: readonly string[];
    threadId: string;
    byMessageId: string;
  }): Promise<void> => {
    const at = now();
    for (const botId of input.holdBotIds) {
      await getDbClient().exec(
        `UPDATE bot_group_members SET hold_at = ?, hold_message_id = ?, hold_thread_id = ?,
          hold_noted = 0, updated_at = MAX(updated_at, ?) WHERE room_id = ? AND bot_id = ?`,
        [at, input.byMessageId, input.threadId, at, input.roomId, botId],
      );
    }
    for (const botId of input.releaseBotIds) {
      await getDbClient().exec(
        `UPDATE bot_group_members SET hold_at = NULL, hold_message_id = NULL,
          hold_thread_id = NULL, hold_noted = 0, updated_at = MAX(updated_at, ?)
         WHERE room_id = ? AND bot_id = ?`,
        [at, input.roomId, botId],
      );
    }
  };

  const markHoldNoted = async (roomId: string, botId: string): Promise<void> => {
    await getDbClient().exec(
      `UPDATE bot_group_members SET hold_noted = 1, updated_at = MAX(updated_at, ?)
       WHERE room_id = ? AND bot_id = ? AND hold_at IS NOT NULL`,
      [now(), roomId, botId],
    );
  };

  const setStranded = async (input: {
    roomId: string;
    botId: string;
    beforeSequence: number;
    threadId: string;
    startedAt: number;
  }): Promise<void> => {
    await getDbClient().exec(
      `UPDATE bot_group_members SET stranded_before_sequence = ?, stranded_thread_id = ?,
        stranded_started_at = ?, updated_at = MAX(updated_at, ?)
       WHERE room_id = ? AND bot_id = ?`,
      [input.beforeSequence, input.threadId, input.startedAt, now(), input.roomId, input.botId],
    );
  };

  const clearStranded = async (roomId: string, botId: string): Promise<void> => {
    await getDbClient().exec(
      `UPDATE bot_group_members SET stranded_before_sequence = NULL,
        stranded_thread_id = NULL, stranded_started_at = NULL,
        updated_at = MAX(updated_at, ?) WHERE room_id = ? AND bot_id = ?`,
      [now(), roomId, botId],
    );
  };

  const resetRuntimeState = async (): Promise<void> => {
    await getDbClient().exec(
      `UPDATE bot_group_rooms SET running = 0
       WHERE status = 'active' AND running <> 0`,
    );
  };

  return {
    createRoom,
    updateRoomIdentity,
    archiveRoom,
    listRooms,
    loadRoom,
    ...sessionMessages,
    bumpEpoch,
    readEpoch,
    setRunning,
    setNeedsUser,
    advanceWatermark,
    updateMemberHolds,
    markHoldNoted,
    setStranded,
    clearStranded,
    resetRuntimeState,
  };
}

export type BotGroupChatStore = ReturnType<typeof createBotGroupChatStore>;
