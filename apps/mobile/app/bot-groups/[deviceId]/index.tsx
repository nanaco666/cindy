import { useLocalSearchParams, useRouter } from 'expo-router';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { Check, ChevronRight, MessagesSquare, Plus } from 'lucide-react-native';
import { Pressable, RefreshControl, ScrollView, StyleSheet, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { useTranslation } from 'react-i18next';

import { Text, TextInput } from '@/components/AppText';
import { ConnectionBanner } from '@/components/ConnectionBanner';
import { MainWindowEmptyState, MainWindowRowButton, RemoteListSyncingPlaceholder, ScreenHeader } from '@/components/MobilePrimitives';
import { normalizeRemoteBotProfiles, type RemoteBotProfile } from '@/bots/remoteBots';
import { normalizeRemoteBotGroupRoom, normalizeRemoteBotGroupRooms, remoteBotGroupsUnsupported, type RemoteBotGroupRoom } from '@/bots/remoteBotGroups';
import { useDeviceLink } from '@/device-link/DeviceLinkContext';
import { withTransientRemoteRetry } from '@/device-link/remoteRetry';
import { formatRemoteError } from '@/device-link/remoteStatus';
import { useRemoteSyncTask } from '@/device-link/remoteSyncTask';
import { remoteSessionStore } from '@/session/remoteSessionStore';
import { goBackGuarded } from '@/utils/backGuard';
import { useGuardedPush } from '@/utils/useGuardedPush';
import { fontWeight, iconSize, iconStroke, radius, spacing, typeScale, useTheme, useThemedStyles, type ThemeColors } from '@/theme';

function routeText(value: string | string[] | undefined): string {
  return Array.isArray(value) ? value[0] ?? '' : value ?? '';
}

export default function RemoteBotGroupsScreen() {
  const styles = useThemedStyles(makeStyles);
  const { colors } = useTheme();
  const { t } = useTranslation();
  const router = useRouter();
  const guardedPush = useGuardedPush();
  const params = useLocalSearchParams<{ deviceId: string; deviceName?: string }>();
  const deviceId = routeText(params.deviceId);
  const deviceName = routeText(params.deviceName) || deviceId;
  const { connectionIssue, invoke, status, subscribe, unsubscribe } = useDeviceLink();
  const [rooms, setRooms] = useState<RemoteBotGroupRoom[]>([]);
  const [bots, setBots] = useState<RemoteBotProfile[]>([]);
  const [loading, setLoading] = useState(false);
  const [synced, setSynced] = useState(false);
  const [unsupported, setUnsupported] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [lastSyncedAt, setLastSyncedAt] = useState<number | null>(null);
  const [creating, setCreating] = useState(false);
  const [name, setName] = useState('');
  const [selected, setSelected] = useState<string[]>([]);
  const selectedSet = useMemo(() => new Set(selected), [selected]);

  const sync = useCallback(async () => {
    if (!deviceId) return;
    setLoading(true);
    setError(null);
    try {
      const [rawRooms, rawBots] = await withTransientRemoteRetry(async () => {
        await subscribe(`bot-groups:${deviceId}`, deviceId, ['sessions']);
        return Promise.all([
          invoke<unknown>(deviceId, 'maker:bots:group-list', []),
          invoke<unknown>(deviceId, 'local-db:bots:list', []),
        ]);
      });
      setRooms(normalizeRemoteBotGroupRooms(rawRooms));
      setBots(normalizeRemoteBotProfiles(rawBots).filter((bot) => bot.status === 'active' && bot.canonicalSessionId));
      setUnsupported(false);
      setLastSyncedAt(Date.now());
    } catch (reason) {
      if (remoteBotGroupsUnsupported(reason)) {
        setUnsupported(true);
        setRooms([]);
      } else {
        setError(formatRemoteError(reason));
      }
    } finally {
      setSynced(true);
      setLoading(false);
    }
  }, [deviceId, invoke, subscribe]);
  const load = useRemoteSyncTask(sync);

  useEffect(() => {
    void load();
  }, [load]);

  useEffect(() => {
    const unregisterReseed = remoteSessionStore.registerBotGroupReseedHandler(
      deviceId,
      () => void load(),
    );
    return () => {
      unregisterReseed();
      void unsubscribe(`bot-groups:${deviceId}`, deviceId, ['sessions']).catch(() => undefined);
    };
  }, [deviceId, load, unsubscribe]);

  const toggle = (botId: string) => {
    setSelected((current) => current.includes(botId)
      ? current.filter((id) => id !== botId)
      : current.length < 6 ? [...current, botId] : current);
  };

  const create = async () => {
    if (creating || selected.length < 2 || selected.length > 6) return;
    setCreating(true);
    setError(null);
    try {
      const raw = await invoke<unknown>(deviceId, 'maker:bots:group-create', [{
        name: name.trim() || t('devices.bots.groups.defaultName'),
        memberBotIds: selected,
      }]);
      const room = normalizeRemoteBotGroupRoom(raw);
      if (!room) throw new Error(t('devices.bots.groups.invalidResponse'));
      guardedPush({
        pathname: '/bot-groups/[deviceId]/[roomId]',
        params: { deviceId, deviceName, roomId: room.id },
      });
      setCreating(false);
      setName('');
      setSelected([]);
      void load();
    } catch (reason) {
      setError(formatRemoteError(reason));
      setCreating(false);
    }
  };

  return (
    <SafeAreaView style={styles.safeArea} testID="remoteBotGroups.screen">
      <ScreenHeader
        eyebrow={t('devices.bots.eyebrow')}
        onBack={() => goBackGuarded(router)}
        subtitle={t('devices.bots.groups.subtitle', { deviceName })}
        title={t('devices.bots.groups.title')}
      />
      <ConnectionBanner error={error} issue={connectionIssue} lastSyncedAt={lastSyncedAt} loading={loading} onSync={() => void load()} status={status} />
      <ScrollView contentContainerStyle={styles.content} refreshControl={<RefreshControl refreshing={loading} onRefresh={() => void load()} />}>
        {!synced ? <RemoteListSyncingPlaceholder testID="remoteBotGroups.syncing" /> : null}
        {unsupported ? (
          <MainWindowEmptyState centered copy={t('devices.bots.groups.unsupportedCopy')} title={t('devices.bots.groups.unsupportedTitle')} />
        ) : (
          <>
            <View style={styles.createCard}>
              <View style={styles.createTitleRow}>
                <Plus color={colors.textSecondary} size={iconSize.md} strokeWidth={iconStroke.regular} />
                <Text style={styles.createTitle}>{t('devices.bots.groups.create')}</Text>
              </View>
              <TextInput
                accessibilityLabel={t('devices.bots.groups.nameLabel')}
                onChangeText={setName}
                placeholder={t('devices.bots.groups.namePlaceholder')}
                placeholderTextColor={colors.textTertiary}
                style={styles.input}
                value={name}
              />
              <Text style={styles.memberHint}>{t('devices.bots.groups.membersLabel', { count: selected.length })}</Text>
              <View style={styles.memberList}>
                {bots.map((bot) => {
                  const checked = selectedSet.has(bot.id);
                  return (
                    <Pressable key={bot.id} onPress={() => toggle(bot.id)} style={[styles.memberRow, checked && styles.memberRowSelected]}>
                      <Text style={styles.memberAvatar}>{bot.avatar}</Text>
                      <Text numberOfLines={1} style={styles.memberName}>{bot.name}</Text>
                      <View style={[styles.check, checked && styles.checkSelected]}>
                        {checked ? <Check color={colors.ctaText} size={iconSize.sm} strokeWidth={iconStroke.regular} /> : null}
                      </View>
                    </Pressable>
                  );
                })}
              </View>
              <Pressable disabled={creating || selected.length < 2} onPress={() => void create()} style={[styles.createButton, (creating || selected.length < 2) && styles.disabled]}>
                <Text style={styles.createButtonText}>{creating ? t('devices.bots.groups.creating') : t('devices.bots.groups.create')}</Text>
              </Pressable>
            </View>

            {synced && rooms.length === 0 && !error ? (
              <MainWindowEmptyState centered copy={t('devices.bots.groups.emptyCopy')} title={t('devices.bots.groups.emptyTitle')} />
            ) : (
              <View style={styles.list}>
                {rooms.map((room) => (
                  <MainWindowRowButton
                    accessibilityLabel={t('devices.bots.groups.openRoomA11y', { name: room.name })}
                    key={room.id}
                    onPress={() => guardedPush({ pathname: '/bot-groups/[deviceId]/[roomId]', params: { deviceId, deviceName, roomId: room.id } })}
                    style={styles.row}
                  >
                    <View style={styles.groupIcon}><Text style={styles.groupAvatar}>{room.avatar}</Text></View>
                    <View style={styles.rowText}>
                      <Text numberOfLines={1} style={styles.roomName}>{room.name}</Text>
                      <Text style={styles.meta}>{room.needsUser ? t('devices.bots.groups.state.needsUser') : room.running ? t('devices.bots.groups.state.running') : room.status === 'archived' ? t('devices.bots.groups.state.archived') : room.status === 'error' ? t('devices.bots.groups.state.error') : t('devices.bots.groups.state.idle')} · {t('devices.bots.groups.memberCount', { count: room.members.length })}</Text>
                    </View>
                    <ChevronRight color={colors.textTertiary} size={iconSize.md} strokeWidth={iconStroke.regular} />
                  </MainWindowRowButton>
                ))}
              </View>
            )}
          </>
        )}
      </ScrollView>
    </SafeAreaView>
  );
}

const makeStyles = (colors: ThemeColors) => StyleSheet.create({
  safeArea: { backgroundColor: colors.surface, flex: 1 },
  content: { flexGrow: 1, gap: spacing.lg, padding: spacing.lg },
  createCard: { backgroundColor: colors.surfaceElevated, borderColor: colors.border, borderRadius: radius.container, borderWidth: StyleSheet.hairlineWidth, gap: spacing.md, padding: spacing.lg },
  createTitleRow: { alignItems: 'center', flexDirection: 'row', gap: spacing.sm },
  createTitle: { color: colors.textPrimary, fontSize: typeScale.body, fontWeight: fontWeight.medium },
  input: { backgroundColor: colors.surface, borderColor: colors.border, borderRadius: radius.control, borderWidth: StyleSheet.hairlineWidth, color: colors.textPrimary, minHeight: 44, paddingHorizontal: spacing.md },
  memberHint: { color: colors.textSecondary, fontSize: typeScale.caption },
  memberList: { gap: spacing.xs },
  memberRow: { alignItems: 'center', borderColor: colors.border, borderRadius: radius.control, borderWidth: StyleSheet.hairlineWidth, flexDirection: 'row', gap: spacing.sm, minHeight: 46, paddingHorizontal: spacing.md },
  memberRowSelected: { backgroundColor: colors.surfaceListExpanded, borderColor: colors.cta },
  memberAvatar: { fontSize: typeScale.title },
  memberName: { color: colors.textPrimary, flex: 1, fontSize: typeScale.body },
  check: { alignItems: 'center', borderColor: colors.border, borderRadius: radius.pill, borderWidth: StyleSheet.hairlineWidth, height: 22, justifyContent: 'center', width: 22 },
  checkSelected: { backgroundColor: colors.cta, borderColor: colors.cta },
  createButton: { alignItems: 'center', backgroundColor: colors.cta, borderRadius: radius.control, minHeight: 44, justifyContent: 'center' },
  createButtonText: { color: colors.ctaText, fontSize: typeScale.body, fontWeight: fontWeight.medium },
  disabled: { opacity: 0.45 },
  list: { borderBottomColor: colors.border, borderBottomWidth: StyleSheet.hairlineWidth },
  row: { alignItems: 'center', borderTopColor: colors.border, borderTopWidth: StyleSheet.hairlineWidth, flexDirection: 'row', gap: spacing.md, minHeight: 76, paddingHorizontal: spacing.md },
  groupIcon: { alignItems: 'center', backgroundColor: colors.surfaceElevated, borderRadius: radius.pill, height: 44, justifyContent: 'center', width: 44 },
  groupAvatar: { fontSize: typeScale.title },
  rowText: { flex: 1, gap: spacing.xs, minWidth: 0 },
  roomName: { color: colors.textPrimary, fontSize: typeScale.body, fontWeight: fontWeight.medium },
  meta: { color: colors.textTertiary, fontSize: typeScale.caption },
});
