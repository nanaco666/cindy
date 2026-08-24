import { useLocalSearchParams, useRouter } from 'expo-router';
import { useCallback, useEffect, useRef, useState } from 'react';
import { Archive, CornerDownRight, Send, X } from 'lucide-react-native';
import { Alert, Pressable, RefreshControl, ScrollView, StyleSheet, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { useTranslation } from 'react-i18next';

import { Text, TextInput } from '@/components/AppText';
import { ConnectionBanner } from '@/components/ConnectionBanner';
import { MainWindowEmptyState, RemoteListSyncingPlaceholder, ScreenHeader } from '@/components/MobilePrimitives';
import { InteractionPanel } from '@/session/InteractionPanel';
import { normalizeRemoteBotGroupMessages, normalizeRemoteBotGroupRoom, resolveRemoteBotGroupInteraction, remoteBotGroupsUnsupported, type RemoteBotGroupMessage, type RemoteBotGroupRoom } from '@/bots/remoteBotGroups';
import { useDeviceLink } from '@/device-link/DeviceLinkContext';
import { withTransientRemoteRetry } from '@/device-link/remoteRetry';
import { formatRemoteError } from '@/device-link/remoteStatus';
import { useRemoteSyncTask } from '@/device-link/remoteSyncTask';
import { remoteSessionStore } from '@/session/remoteSessionStore';
import { goBackGuarded } from '@/utils/backGuard';
import { fontWeight, iconSize, iconStroke, radius, spacing, typeScale, useTheme, useThemedStyles, type ThemeColors } from '@/theme';

function routeText(value: string | string[] | undefined): string {
  return Array.isArray(value) ? value[0] ?? '' : value ?? '';
}

export default function RemoteBotGroupRoomScreen() {
  const styles = useThemedStyles(makeStyles);
  const { colors } = useTheme();
  const { t } = useTranslation();
  const router = useRouter();
  const params = useLocalSearchParams<{ deviceId: string; deviceName?: string; roomId: string }>();
  const deviceId = routeText(params.deviceId);
  const deviceName = routeText(params.deviceName) || deviceId;
  const roomId = routeText(params.roomId);
  const { connectionIssue, invoke, status, subscribe, unsubscribe } = useDeviceLink();
  const [room, setRoom] = useState<RemoteBotGroupRoom | null>(null);
  const [messages, setMessages] = useState<RemoteBotGroupMessage[]>([]);
  const [draft, setDraft] = useState('');
  const [replyThreadId, setReplyThreadId] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [synced, setSynced] = useState(false);
  const [unsupported, setUnsupported] = useState(false);
  const [sending, setSending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [lastSyncedAt, setLastSyncedAt] = useState<number | null>(null);
  const [manageOpen, setManageOpen] = useState(false);
  const [editName, setEditName] = useState('');
  const [editAvatar, setEditAvatar] = useState('👥');
  const [manageBusy, setManageBusy] = useState(false);
  const scrollRef = useRef<ScrollView | null>(null);

  const sync = useCallback(async () => {
    if (!deviceId || !roomId) return;
    setLoading(true);
    setError(null);
    try {
      const rawRoom = await withTransientRemoteRetry(async () => {
        await subscribe(`bot-group:${roomId}`, deviceId, ['sessions']);
        return invoke<unknown>(deviceId, 'maker:bots:group-get', [roomId]);
      });
      const nextRoom = normalizeRemoteBotGroupRoom(rawRoom);
      if (!nextRoom) {
        setRoom(null);
        setMessages([]);
      } else {
        const rawMessages = await withTransientRemoteRetry(() => invoke<unknown>(deviceId, 'local-db:messages:list', [nextRoom.roomSessionId, { limit: 300 }]));
        setRoom(nextRoom);
        setMessages(normalizeRemoteBotGroupMessages(rawMessages, roomId));
      }
      setUnsupported(false);
      setLastSyncedAt(Date.now());
    } catch (reason) {
      if (remoteBotGroupsUnsupported(reason)) {
        setUnsupported(true);
      } else {
        setError(formatRemoteError(reason));
      }
    } finally {
      setSynced(true);
      setLoading(false);
    }
  }, [deviceId, invoke, roomId, subscribe]);
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
      void unsubscribe(`bot-group:${roomId}`, deviceId, ['sessions']).catch(() => undefined);
    };
  }, [deviceId, load, roomId, unsubscribe]);

  useEffect(() => {
    if (!room?.running) return;
    const timer = setInterval(() => void load(), 1_500);
    return () => clearInterval(timer);
  }, [load, room?.running]);

  useEffect(() => {
    scrollRef.current?.scrollToEnd({ animated: synced });
  }, [messages.length, synced]);

  useEffect(() => {
    if (!room || manageOpen) return;
    setEditName(room.name);
    setEditAvatar(room.avatar);
  }, [manageOpen, room]);

  const send = async () => {
    const text = draft.trim();
    if (!text || sending || !room || room.status !== 'active') return;
    setSending(true);
    setError(null);
    try {
      await invoke(deviceId, 'maker:bots:group-send', [room.id, text, replyThreadId ? { threadId: replyThreadId } : {}]);
      setDraft('');
      setReplyThreadId(null);
      await load();
    } catch (reason) {
      setError(formatRemoteError(reason));
    } finally {
      setSending(false);
    }
  };
  const saveIdentity = async () => {
    if (!room || manageBusy || !editName.trim() || !editAvatar.trim()) return;
    setManageBusy(true);
    setError(null);
    try {
      await invoke(deviceId, 'maker:bots:group-update', [room.id, {
        name: editName.trim(),
        avatar: editAvatar.trim(),
      }]);
      setManageOpen(false);
      await load();
    } catch (reason) {
      setError(formatRemoteError(reason));
    } finally {
      setManageBusy(false);
    }
  };
  const confirmArchive = () => {
    if (!room || manageBusy) return;
    Alert.alert(
      t('devices.bots.groups.archiveTitle'),
      t('devices.bots.groups.archiveDescription', { name: room.name }),
      [
        { text: t('common.cancel'), style: 'cancel' },
        {
          text: t('devices.bots.groups.archive'),
          style: 'destructive',
          onPress: () => {
            setManageBusy(true);
            setError(null);
            void invoke(deviceId, 'maker:bots:group-archive', [room.id])
              .then(async () => {
                setManageOpen(false);
                await load();
              })
              .catch((reason) => setError(formatRemoteError(reason)))
              .finally(() => setManageBusy(false));
          },
        },
      ],
    );
  };
  const activeInteraction = room?.interactions[0] ?? null;

  return (
    <SafeAreaView style={styles.safeArea} testID="remoteBotGroupRoom.screen">
      <ScreenHeader
        eyebrow={room ? t('devices.bots.groups.memberCount', { count: room.members.length }) : t('devices.bots.groups.title')}
        onBack={() => goBackGuarded(router)}
        subtitle={deviceName}
        title={room?.name || t('devices.bots.groups.roomTitle')}
        action={room ? {
          label: t('devices.bots.groups.manage'),
          onPress: () => {
            setEditName(room.name);
            setEditAvatar(room.avatar);
            setManageOpen((current) => !current);
          },
        } : undefined}
      />
      <ConnectionBanner error={error} issue={connectionIssue} lastSyncedAt={lastSyncedAt} loading={loading} onSync={() => void load()} status={status} />
      {manageOpen && room ? (
        <View style={styles.manageCard}>
          <View style={styles.manageFields}>
            <TextInput
              accessibilityLabel={t('devices.bots.groups.avatarLabel')}
              maxLength={16}
              onChangeText={setEditAvatar}
              style={[styles.manageInput, styles.avatarInput]}
              value={editAvatar}
            />
            <TextInput
              accessibilityLabel={t('devices.bots.groups.nameLabel')}
              maxLength={120}
              onChangeText={setEditName}
              style={[styles.manageInput, styles.nameInput]}
              value={editName}
            />
          </View>
          <View style={styles.manageActions}>
            <Pressable disabled={manageBusy || room.status === 'archived'} onPress={confirmArchive} style={[styles.archiveButton, (manageBusy || room.status === 'archived') && styles.disabled]}>
              <Archive color={colors.destructive} size={iconSize.sm} strokeWidth={iconStroke.regular} />
              <Text style={styles.archiveText}>{t('devices.bots.groups.archive')}</Text>
            </Pressable>
            <Pressable disabled={manageBusy || !editName.trim() || !editAvatar.trim() || room.status !== 'active'} onPress={() => void saveIdentity()} style={[styles.saveButton, (manageBusy || !editName.trim() || !editAvatar.trim() || room.status !== 'active') && styles.disabled]}>
              <Text style={styles.saveText}>{manageBusy ? t('devices.bots.groups.saving') : t('common.save')}</Text>
            </Pressable>
          </View>
        </View>
      ) : null}
      {!synced ? <RemoteListSyncingPlaceholder testID="remoteBotGroupRoom.syncing" /> : unsupported ? (
        <MainWindowEmptyState centered copy={t('devices.bots.groups.unsupportedCopy')} title={t('devices.bots.groups.unsupportedTitle')} />
      ) : !room ? (
        <MainWindowEmptyState centered copy={t('devices.bots.groups.missingCopy')} title={t('devices.bots.groups.missingTitle')} />
      ) : (
        <>
          <ScrollView
            contentContainerStyle={styles.messages}
            onContentSizeChange={() => scrollRef.current?.scrollToEnd({ animated: true })}
            ref={scrollRef}
            refreshControl={<RefreshControl refreshing={loading} onRefresh={() => void load()} />}
          >
            {messages.length === 0 ? (
              <MainWindowEmptyState centered copy={t('devices.bots.groups.roomEmptyCopy')} title={t('devices.bots.groups.roomEmptyTitle')} />
            ) : messages.map((message) => (
              <View key={message.id} style={[styles.messageRow, message.kind === 'user' && styles.userRow]}>
                <View style={[styles.bubbleWrap, message.kind === 'user' && styles.userBubbleWrap]}>
                  <Text style={styles.speaker}>{message.name}</Text>
                  <View style={[styles.bubble, message.kind === 'user' ? styles.userBubble : styles.botBubble]}>
                    {message.text ? (
                      <Text style={message.kind === 'user' ? styles.userText : styles.botText}>{message.text}</Text>
                    ) : null}
                    {message.attachments.length > 0 ? (
                      <View style={[styles.attachments, !message.text && styles.attachmentsOnly]}>
                        {message.attachments.map((name, index) => (
                          <View
                            key={`${name}:${index}`}
                            style={[
                              styles.attachment,
                              message.kind === 'user' ? styles.userAttachment : styles.botAttachment,
                            ]}
                          >
                            <Text
                              numberOfLines={1}
                              style={message.kind === 'user' ? styles.userText : styles.botText}
                            >
                              {name}
                            </Text>
                          </View>
                        ))}
                      </View>
                    ) : null}
                  </View>
                  <Pressable
                    accessibilityLabel={t('devices.bots.groups.replyThread')}
                    onPress={() => setReplyThreadId(message.threadId)}
                    style={styles.replyButton}
                  >
                    <CornerDownRight color={colors.textTertiary} size={iconSize.sm} strokeWidth={iconStroke.regular} />
                    <Text style={styles.replyText}>{t('devices.bots.groups.replyThread')}</Text>
                  </Pressable>
                </View>
              </View>
            ))}
            {room.running ? <Text style={styles.responding}>{t('devices.bots.groups.responding')}</Text> : null}
          </ScrollView>
          {activeInteraction ? (
            <InteractionPanel
              deviceId={deviceId}
              sessionId={activeInteraction.sessionId}
              interactions={[{ request: activeInteraction.request, ...(activeInteraction.persistId ? { persistId: activeInteraction.persistId } : {}) }]}
              onError={setError}
              resolveDecision={async (requestId, decision) => {
                await resolveRemoteBotGroupInteraction(
                  invoke,
                  deviceId,
                  room.id,
                  requestId,
                  decision,
                );
                await load();
              }}
            />
          ) : (
          <>
          {replyThreadId ? (
            <View style={styles.replyingBar}>
              <Text style={styles.replyingText}>{t('devices.bots.groups.replyingThread')}</Text>
              <Pressable accessibilityLabel={t('common.cancel')} onPress={() => setReplyThreadId(null)} style={styles.replyingCancel}>
                <X color={colors.textTertiary} size={iconSize.sm} strokeWidth={iconStroke.regular} />
              </Pressable>
            </View>
          ) : null}
          <View style={styles.composer}>
            <TextInput
              editable={!sending && room.status === 'active'}
              multiline
              onChangeText={setDraft}
              placeholder={t('devices.bots.groups.placeholder')}
              placeholderTextColor={colors.textTertiary}
              style={styles.input}
              value={draft}
            />
            <Pressable disabled={!draft.trim() || sending} onPress={() => void send()} style={[styles.send, (!draft.trim() || sending) && styles.disabled]}>
              <Send color={colors.ctaText} size={iconSize.md} strokeWidth={iconStroke.regular} />
            </Pressable>
          </View>
          </>
          )}
        </>
      )}
    </SafeAreaView>
  );
}

const makeStyles = (colors: ThemeColors) => StyleSheet.create({
  safeArea: { backgroundColor: colors.surface, flex: 1 },
  manageCard: { backgroundColor: colors.surfaceElevated, borderBottomColor: colors.border, borderBottomWidth: StyleSheet.hairlineWidth, gap: spacing.sm, padding: spacing.md },
  manageFields: { flexDirection: 'row', gap: spacing.sm },
  manageInput: { backgroundColor: colors.surface, borderColor: colors.border, borderRadius: radius.control, borderWidth: StyleSheet.hairlineWidth, color: colors.textPrimary, minHeight: 40, paddingHorizontal: spacing.md },
  avatarInput: { textAlign: 'center', width: 72 },
  nameInput: { flex: 1 },
  manageActions: { alignItems: 'center', flexDirection: 'row', justifyContent: 'space-between' },
  archiveButton: { alignItems: 'center', flexDirection: 'row', gap: spacing.xs, minHeight: 36, paddingHorizontal: spacing.sm },
  archiveText: { color: colors.destructive, fontSize: typeScale.caption },
  saveButton: { alignItems: 'center', backgroundColor: colors.cta, borderRadius: radius.control, minHeight: 36, justifyContent: 'center', paddingHorizontal: spacing.lg },
  saveText: { color: colors.ctaText, fontSize: typeScale.caption, fontWeight: fontWeight.medium },
  messages: { flexGrow: 1, gap: spacing.md, padding: spacing.lg },
  messageRow: { alignItems: 'flex-start' },
  userRow: { alignItems: 'flex-end' },
  bubbleWrap: { maxWidth: '82%' },
  userBubbleWrap: { alignItems: 'flex-end' },
  speaker: { color: colors.textTertiary, fontSize: typeScale.caption, marginBottom: spacing.xs, paddingHorizontal: spacing.xs },
  bubble: { borderRadius: radius.container, paddingHorizontal: spacing.md, paddingVertical: spacing.sm },
  botBubble: { backgroundColor: colors.surfaceElevated, borderColor: colors.border, borderWidth: StyleSheet.hairlineWidth },
  userBubble: { backgroundColor: colors.cta },
  botText: { color: colors.textPrimary, fontSize: typeScale.body },
  userText: { color: colors.ctaText, fontSize: typeScale.body },
  attachments: { gap: spacing.xs, marginTop: spacing.sm },
  attachmentsOnly: { marginTop: 0 },
  attachment: { borderRadius: radius.control, borderWidth: StyleSheet.hairlineWidth, maxWidth: 240, paddingHorizontal: spacing.sm, paddingVertical: spacing.xs },
  botAttachment: { backgroundColor: colors.surface, borderColor: colors.border },
  userAttachment: { borderColor: colors.ctaText },
  responding: { color: colors.textTertiary, fontSize: typeScale.caption, fontStyle: 'italic' },
  replyButton: { alignItems: 'center', flexDirection: 'row', gap: spacing.xs, marginTop: spacing.xs, paddingHorizontal: spacing.xs, paddingVertical: spacing.xs },
  replyText: { color: colors.textTertiary, fontSize: typeScale.caption },
  replyingBar: { alignItems: 'center', backgroundColor: colors.surfaceElevated, borderTopColor: colors.border, borderTopWidth: StyleSheet.hairlineWidth, flexDirection: 'row', justifyContent: 'space-between', paddingHorizontal: spacing.md, paddingVertical: spacing.sm },
  replyingText: { color: colors.textSecondary, fontSize: typeScale.caption },
  replyingCancel: { alignItems: 'center', height: 32, justifyContent: 'center', width: 32 },
  composer: { alignItems: 'flex-end', borderTopColor: colors.border, borderTopWidth: StyleSheet.hairlineWidth, flexDirection: 'row', gap: spacing.sm, padding: spacing.md },
  input: { backgroundColor: colors.surfaceElevated, borderColor: colors.border, borderRadius: radius.container, borderWidth: StyleSheet.hairlineWidth, color: colors.textPrimary, flex: 1, maxHeight: 128, minHeight: 44, paddingHorizontal: spacing.md, paddingVertical: spacing.sm },
  send: { alignItems: 'center', backgroundColor: colors.cta, borderRadius: radius.pill, height: 44, justifyContent: 'center', width: 44 },
  disabled: { opacity: 0.45 },
});
