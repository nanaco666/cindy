import Constants from 'expo-constants';
import * as Clipboard from 'expo-clipboard';
import * as Updates from 'expo-updates';
import { useUpdates } from 'expo-updates';
import { useRouter } from 'expo-router';
import { Children, Fragment, isValidElement, useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import {
  Image,
  Platform,
  Pressable,
  ScrollView,
  StyleSheet,
  View,
} from 'react-native';
import { Text, TextInput } from '@/components/AppText';
import { SafeAreaView } from 'react-native-safe-area-context';
import { ChevronDown, ChevronRight, X } from 'lucide-react-native';
import type { DeviceView } from '@lizi/device-link';
import { useAuth } from '@/auth/AuthContext';
import { goBackGuarded } from '@/utils/backGuard';
import { configureCollapseAnimation } from '@/utils/collapseAnimation';
import {
  MainWindowActionButton,
  MainWindowActionGroup,
  ScreenHeader,
  StatusDot,
} from '@/components/MobilePrimitives';
import { AUTH_API_BASE_URL, AUTH_REGION, DESKTOP_PACKAGE_VERSION, DEVICE_LINK_API_BASE_URL, IS_OTA_SELFHOST, REVIEW_MODE } from '@/config/env';
import { useDeviceLink } from '@/device-link/DeviceLinkContext';
import { buildMobileDeviceName } from '@/device-link/mobileDeviceIdentity';
import { formatRemoteError } from '@/device-link/remoteStatus';
import {
  buildMobileSettingsOverview,
  type MobileSettingsRow,
} from '@/settings/mobileSettings';
import {
  clearMobileVoiceLiteLlmSettings,
  hasMobileVoiceLiteLlmSettings,
  saveMobileVoiceLiteLlmSettings,
} from '@/session/mobileVoiceLiteLlmSettings';
import { buildMobileUpdateInfoRows, currentMobileOtaVersion } from '@/settings/updateInfo';
import { runManualUpdateCheck } from '@/update/manualUpdateCheck';
import { useBundleUpdatePrompt } from '@/update/useBundleUpdatePrompt';
import { useTheme, useThemedStyles, type ThemeColors } from '@/theme';
import { fontWeight, iconSize, iconStroke, lineHeight, radius, spacing, typeScale } from '@/theme/tokens';

type UpdatePhase = 'idle' | 'checking' | 'downloading' | 'uptodate' | 'error';
type SelfDeviceNameSaveOptions = { acceptClosedDraft?: boolean };
type SelfDeviceNameQueuedWrite =
  | { kind: 'rename'; name: string; options: SelfDeviceNameSaveOptions }
  | { kind: 'reset' };
const SETTINGS_DEVICE_TIMEOUT_MS = 12_000;

export default function SettingsScreen() {
  const styles = useThemedStyles(makeStyles);
  const { colors } = useTheme();
  const router = useRouter();
  const auth = useAuth();
  const { status } = useDeviceLink();
  const [copiedRowId, setCopiedRowId] = useState<string | null>(null);
  const [loggingOut, setLoggingOut] = useState(false);
  const [debugExpanded, setDebugExpanded] = useState(false);
  const [voiceExpanded, setVoiceExpanded] = useState(false);
  const [voiceLiteLlmConfigured, setVoiceLiteLlmConfigured] = useState(false);
  const [voiceLiteLlmDraft, setVoiceLiteLlmDraft] = useState('');
  const [voiceSettingsBusy, setVoiceSettingsBusy] = useState(false);
  const [voiceSettingsMessage, setVoiceSettingsMessage] = useState<string | null>(null);
  const [updatePhase, setUpdatePhase] = useState<UpdatePhase>('idle');
  const [updateMessage, setUpdateMessage] = useState<string | null>(null);
  const updateCheckInFlightRef = useRef(false);
  const [selfDeviceName, setSelfDeviceName] = useState<string | null>(null);
  const [selfDeviceNameDraft, setSelfDeviceNameDraft] = useState('');
  const [selfDeviceNameEditing, setSelfDeviceNameEditing] = useState(false);
  const [selfDeviceNameSaving, setSelfDeviceNameSaving] = useState(false);
  const [selfDeviceNameMessage, setSelfDeviceNameMessage] = useState<string | null>(null);
  const selfDeviceNameDraftRef = useRef('');
  const selfDeviceNameSaveSeqRef = useRef(0);
  const selfDeviceNameWriteInFlightRef = useRef(false);
  const selfDeviceNameCurrentWriteRef = useRef<SelfDeviceNameQueuedWrite | null>(null);
  const selfDeviceNameQueuedWriteRef = useRef<SelfDeviceNameQueuedWrite | null>(null);
  const selfDeviceNameRunQueuedWriteRef = useRef<() => void>(() => {});

  const systemDeviceName = buildMobileDeviceName({
    constantsDeviceName: Constants.deviceName,
    platform: Platform.OS,
  });
  const deviceName = selfDeviceName ?? systemDeviceName;
  const overview = useMemo(
    () => buildMobileSettingsOverview({
      authBaseUrl: AUTH_API_BASE_URL,
      authRegion: AUTH_REGION,
      deviceId: auth.deviceId,
      deviceName,
      platform: Platform.OS,
      relayStatus: status,
      userEmail: auth.user?.email,
      userId: auth.user?.id,
      userName: auth.user?.name,
    }),
    [auth.deviceId, auth.user?.email, auth.user?.id, auth.user?.name, deviceName, status],
  );

  const appVersion = Constants.expoConfig?.version ?? '0.0.0';
  const updatesEnabled = Updates.isEnabled;
  // 当前运行的 OTA bundle 信息(只读),折进「调试」分组,用于核验热更是否生效。
  const { currentlyRunning } = useUpdates();
  const updateInfoRows = useMemo(() => buildMobileUpdateInfoRows(currentlyRunning), [currentlyRunning]);
  const otaVersion = useMemo(() => currentMobileOtaVersion(currentlyRunning), [currentlyRunning]);
  // 自建变体的统一入口先查整包;无整包时再由 checkForUpdate 继续查 JS OTA。
  const { checkNow: checkBundleUpdate } = useBundleUpdatePrompt({ auto: false });
  const updateCheckEnabled = IS_OTA_SELFHOST || updatesEnabled;

  const aboutSection = overview.sections.find((section) => section.id === 'about');
  const debugSection = overview.sections.find((section) => section.id === 'debug');

  useEffect(() => {
    if (!auth.isAuthenticated || !auth.deviceId) {
      setSelfDeviceName(null);
      return;
    }

    let cancelled = false;
    void auth.apiFetch<{ devices: DeviceView[] }>('/api/device-link/devices', {
      baseUrl: DEVICE_LINK_API_BASE_URL,
      timeoutMs: SETTINGS_DEVICE_TIMEOUT_MS,
    })
      .then((res) => {
        if (cancelled) return;
        const self = res.devices.find((device) => device.deviceId === auth.deviceId);
        setSelfDeviceName(self?.name?.trim() || null);
      })
      .catch(() => {
        if (!cancelled) setSelfDeviceName(null);
      });

    return () => {
      cancelled = true;
    };
  }, [auth]);

  const copyRow = useCallback(async (row: MobileSettingsRow) => {
    if (!row.copyValue) return;
    await Clipboard.setStringAsync(row.copyValue);
    setCopiedRowId(row.id);
  }, []);

  const checkForUpdate = useCallback(async () => {
    // 审核模式:入口按钮已隐藏,这里再挡一层(状态由代码保证,不依赖 UI 层记得隐藏)。
    if (REVIEW_MODE || !updateCheckEnabled || updateCheckInFlightRef.current) return;
    updateCheckInFlightRef.current = true;
    setUpdateMessage(null);
    try {
      const outcome = await runManualUpdateCheck({
        checkBundleUpdate: IS_OTA_SELFHOST ? checkBundleUpdate : undefined,
        otaEnabled: updatesEnabled,
        checkOtaUpdate: () => Updates.checkForUpdateAsync(),
        fetchOtaUpdate: () => Updates.fetchUpdateAsync(),
        reload: () => Updates.reloadAsync(),
        onPhase: (phase) => setUpdatePhase(phase),
      });
      if (outcome.kind === 'bundle-update-available') {
        setUpdatePhase('idle');
        setUpdateMessage('发现整包更新');
      } else if (outcome.kind === 'up-to-date') {
        setUpdatePhase('uptodate');
        setUpdateMessage('已是最新版本');
      } else if (outcome.kind === 'ota-unavailable') {
        setUpdatePhase('uptodate');
        setUpdateMessage('整包已是最新，当前版本不支持热更新');
      } else if (outcome.kind === 'reloading') {
        setUpdatePhase('downloading');
        setUpdateMessage('更新已下载，正在重启');
      } else if (outcome.kind === 'busy') {
        setUpdatePhase('idle');
      } else {
        setUpdatePhase('error');
        setUpdateMessage(outcome.message);
      }
    } finally {
      updateCheckInFlightRef.current = false;
    }
  }, [checkBundleUpdate, updateCheckEnabled, updatesEnabled]);

  useEffect(() => {
    let cancelled = false;
    void hasMobileVoiceLiteLlmSettings()
      .then((configured) => {
        if (!cancelled) setVoiceLiteLlmConfigured(configured);
      })
      .catch(() => {
        if (!cancelled) setVoiceLiteLlmConfigured(false);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const saveVoiceLiteLlmKey = useCallback(async () => {
    if (voiceSettingsBusy) return;
    setVoiceSettingsBusy(true);
    setVoiceSettingsMessage(null);
    try {
      await saveMobileVoiceLiteLlmSettings({ proxyApiKey: voiceLiteLlmDraft });
      setVoiceLiteLlmDraft('');
      setVoiceLiteLlmConfigured(true);
      setVoiceSettingsMessage('LiteLLM Key 已保存。');
    } catch (err) {
      setVoiceSettingsMessage(err instanceof Error ? err.message : String(err));
    } finally {
      setVoiceSettingsBusy(false);
    }
  }, [voiceLiteLlmDraft, voiceSettingsBusy]);

  const clearVoiceLiteLlmKey = useCallback(async () => {
    if (voiceSettingsBusy) return;
    setVoiceSettingsBusy(true);
    setVoiceSettingsMessage(null);
    try {
      await clearMobileVoiceLiteLlmSettings();
      setVoiceLiteLlmDraft('');
      setVoiceLiteLlmConfigured(false);
      setVoiceSettingsMessage('LiteLLM Key 已清除。');
    } finally {
      setVoiceSettingsBusy(false);
    }
  }, [voiceSettingsBusy]);

  const updateSelfDeviceNameDraft = useCallback((value: string) => {
    selfDeviceNameDraftRef.current = value;
    setSelfDeviceNameMessage(null);
    setSelfDeviceNameDraft(value);
  }, []);

  const saveSelfDeviceNameDraft = useCallback(async (rawName: string, options: SelfDeviceNameSaveOptions = {}) => {
    const name = rawName.trim();
    if (name.length === 0) {
      setSelfDeviceNameMessage('设备名称不能为空。');
      return;
    }
    if (!auth.deviceId) {
      setSelfDeviceNameMessage('设备还在初始化，请稍后再试。');
      return;
    }
    if (selfDeviceNameWriteInFlightRef.current) {
      if (
        name === systemDeviceName.trim() &&
        (selfDeviceNameCurrentWriteRef.current?.kind === 'reset' ||
          selfDeviceNameQueuedWriteRef.current?.kind === 'reset')
      ) {
        return;
      }
      if (
        selfDeviceNameCurrentWriteRef.current?.kind === 'rename' &&
        selfDeviceNameCurrentWriteRef.current.name === name
      ) {
        return;
      }
      selfDeviceNameQueuedWriteRef.current = { kind: 'rename', name, options };
      setSelfDeviceNameMessage('保存中…');
      return;
    }
    if (name === deviceName.trim()) {
      setSelfDeviceNameMessage(null);
      return;
    }

    const seq = selfDeviceNameSaveSeqRef.current + 1;
    selfDeviceNameSaveSeqRef.current = seq;
    selfDeviceNameWriteInFlightRef.current = true;
    selfDeviceNameCurrentWriteRef.current = { kind: 'rename', name, options };
    setSelfDeviceNameSaving(true);
    setSelfDeviceNameMessage('保存中…');
    try {
      const res = await auth.apiFetch<{ deviceId: string; name: string }>(
        `/api/device-link/devices/${encodeURIComponent(auth.deviceId)}`,
        {
          baseUrl: DEVICE_LINK_API_BASE_URL,
          body: { name },
          method: 'PATCH',
          timeoutMs: SETTINGS_DEVICE_TIMEOUT_MS,
        },
      );
      const draftStillCurrent = options.acceptClosedDraft === true || selfDeviceNameDraftRef.current.trim() === name;
      if (selfDeviceNameSaveSeqRef.current === seq && draftStillCurrent) {
        setSelfDeviceName(res.name);
        setSelfDeviceNameMessage('已保存。');
      }
    } catch (err) {
      if (selfDeviceNameSaveSeqRef.current === seq) setSelfDeviceNameMessage(formatRemoteError(err));
    } finally {
      if (selfDeviceNameSaveSeqRef.current === seq) {
        selfDeviceNameWriteInFlightRef.current = false;
        selfDeviceNameCurrentWriteRef.current = null;
        setSelfDeviceNameSaving(false);
        selfDeviceNameRunQueuedWriteRef.current();
      }
    }
  }, [auth, deviceName, systemDeviceName]);

  const resetSelfDeviceName = useCallback(async () => {
    if (!auth.deviceId) {
      setSelfDeviceNameMessage('设备还在初始化，请稍后再试。');
      return;
    }
    if (selfDeviceNameWriteInFlightRef.current) {
      selfDeviceNameQueuedWriteRef.current = { kind: 'reset' };
      setSelfDeviceNameMessage('正在恢复默认名称…');
      return;
    }

    const seq = selfDeviceNameSaveSeqRef.current + 1;
    selfDeviceNameSaveSeqRef.current = seq;
    selfDeviceNameWriteInFlightRef.current = true;
    selfDeviceNameCurrentWriteRef.current = { kind: 'reset' };
    setSelfDeviceNameSaving(true);
    setSelfDeviceNameMessage('正在恢复默认名称…');
    try {
      const res = await auth.apiFetch<{ deviceId: string; name: string; manualName?: string | null }>(
        `/api/device-link/devices/${encodeURIComponent(auth.deviceId)}`,
        {
          baseUrl: DEVICE_LINK_API_BASE_URL,
          body: { name: null },
          method: 'PATCH',
          timeoutMs: SETTINGS_DEVICE_TIMEOUT_MS,
        },
      );
      if (selfDeviceNameSaveSeqRef.current === seq) {
        setSelfDeviceName(res.name);
        updateSelfDeviceNameDraft(res.name);
        setSelfDeviceNameMessage('已恢复默认名称。');
      }
    } catch (err) {
      if (selfDeviceNameSaveSeqRef.current === seq) setSelfDeviceNameMessage(formatRemoteError(err));
    } finally {
      if (selfDeviceNameSaveSeqRef.current === seq) {
        selfDeviceNameWriteInFlightRef.current = false;
        selfDeviceNameCurrentWriteRef.current = null;
        setSelfDeviceNameSaving(false);
        selfDeviceNameRunQueuedWriteRef.current();
      }
    }
  }, [auth, updateSelfDeviceNameDraft]);

  selfDeviceNameRunQueuedWriteRef.current = () => {
    const queued = selfDeviceNameQueuedWriteRef.current;
    if (!queued) return;
    selfDeviceNameQueuedWriteRef.current = null;
    if (queued.kind === 'reset') {
      void resetSelfDeviceName();
      return;
    }
    void saveSelfDeviceNameDraft(queued.name, queued.options);
  };

  useEffect(() => {
    if (!selfDeviceNameEditing) return;
    const name = selfDeviceNameDraft.trim();
    if (name.length === 0) {
      setSelfDeviceNameMessage('设备名称不能为空。');
      return;
    }
    if (name === deviceName.trim()) {
      return;
    }
    if (selfDeviceNameSaving) return;
    const timer = setTimeout(() => {
      void saveSelfDeviceNameDraft(name);
    }, 650);
    return () => clearTimeout(timer);
  }, [deviceName, saveSelfDeviceNameDraft, selfDeviceNameDraft, selfDeviceNameEditing, selfDeviceNameSaving]);

  const openSelfDeviceNameEditor = useCallback(() => {
    updateSelfDeviceNameDraft(deviceName);
    setSelfDeviceNameMessage(null);
    setSelfDeviceNameEditing(true);
  }, [deviceName, updateSelfDeviceNameDraft]);

  const closeSelfDeviceNameEditor = useCallback(() => {
    const name = selfDeviceNameDraftRef.current.trim();
    if (name.length === 0) {
      updateSelfDeviceNameDraft(deviceName);
      setSelfDeviceNameMessage(null);
      setSelfDeviceNameEditing(false);
      return;
    }
    if (name !== deviceName.trim()) {
      void saveSelfDeviceNameDraft(name, { acceptClosedDraft: true });
    }
    setSelfDeviceNameEditing(false);
  }, [deviceName, saveSelfDeviceNameDraft, updateSelfDeviceNameDraft]);

  const logout = useCallback(async () => {
    if (loggingOut) return;
    setLoggingOut(true);
    try {
      await auth.logout();
      router.replace('/login');
    } finally {
      setLoggingOut(false);
    }
  }, [auth, loggingOut, router]);

  const toggleDebug = useCallback(() => {
    configureCollapseAnimation();
    setDebugExpanded((value) => !value);
  }, []);

  const toggleVoice = useCallback(() => {
    configureCollapseAnimation();
    setVoiceExpanded((value) => !value);
  }, []);

  const avatarLabel = (overview.header.name.trim()[0] ?? '?').toUpperCase();
  const updateBusy = updatePhase === 'checking' || updatePhase === 'downloading';
  const updateButtonLabel = updatePhase === 'checking' ? '检查中'
    : updatePhase === 'downloading' ? '更新中'
    : '检查更新';

  if (selfDeviceNameEditing) {
    return (
      <RenameSelfDeviceScreen
        draft={selfDeviceNameDraft}
        message={selfDeviceNameMessage}
        onChangeDraft={updateSelfDeviceNameDraft}
        onDone={closeSelfDeviceNameEditor}
        onResetDefault={resetSelfDeviceName}
      />
    );
  }

  return (
    <SafeAreaView style={styles.safeArea} testID="settings.screen">
      <ScreenHeader
        backTestID="settings.backButton"
        onBack={() => goBackGuarded(router)}
        title="设置"
        titleTestID="settings.title"
      />

      <ScrollView contentContainerStyle={styles.content} testID="settings.scroll">
        {/* 账号头部:身份 + 连接状态一次性呈现,下面分组不再重复 */}
        <View style={styles.headerCard} testID="settings.accountHeader">
          <View style={styles.avatar}>
            {auth.user?.avatar ? (
              <Image source={{ uri: auth.user.avatar }} style={styles.avatarImage} />
            ) : (
              <Text style={styles.avatarText}>{avatarLabel}</Text>
            )}
          </View>
          <View style={styles.headerTexts}>
            <Text style={styles.headerName} numberOfLines={1}>{overview.header.name}</Text>
            {overview.header.email ? (
              <Text style={styles.headerEmail} numberOfLines={1}>{overview.header.email}</Text>
            ) : null}
            <View style={styles.headerStatusRow}>
              <StatusDot tone={overview.header.relayTone} pulsing={status === 'connecting'} />
              <Text style={styles.headerStatusText} numberOfLines={1}>
                {`${overview.header.relayLabel} · ${overview.header.relayDetail}`}
              </Text>
            </View>
          </View>
        </View>

        {/* 版本:只保留统一检查入口,自建线严格先查整包、无整包再查热更。 */}
        <SettingsGroup title="版本">
          {[
            <View key="version" style={styles.versionRow} testID="settings.version">
              <View style={styles.versionTexts}>
                <Text style={styles.rowLabel}>当前版本</Text>
                <Text style={styles.versionValue} numberOfLines={1}>整包版本 {appVersion}</Text>
                <Text style={styles.rowDetail} numberOfLines={1} testID="settings.otaVersion">热更版本 {otaVersion}</Text>
                {/* 二级版本号:自建线打包所配对的桌面产品线版本(0.0.x);仅自建线且已注入时显示 */}
                {IS_OTA_SELFHOST && DESKTOP_PACKAGE_VERSION ? (
                  <Text style={styles.rowDetail} numberOfLines={1} testID="settings.desktopVersion">桌面版 {DESKTOP_PACKAGE_VERSION}</Text>
                ) : null}
                {updateMessage ? (
                  <Text style={styles.rowDetail} numberOfLines={2} testID="settings.updateMessage">{updateMessage}</Text>
                ) : !REVIEW_MODE && !updatesEnabled ? (
                  <Text style={styles.rowDetail} numberOfLines={1}>开发版，热更不可用</Text>
                ) : null}
              </View>
              {/* 审核模式(清单 review 命中当前二进制版本):隐藏检查更新入口,版本号照常展示 */}
              {!REVIEW_MODE ? (
                <MainWindowActionButton
                  action={{
                    accessibilityLabel: updateBusy ? '正在检查更新' : '检查更新',
                    busy: updateBusy,
                    disabled: !updateCheckEnabled,
                    label: updateButtonLabel,
                    onPress: () => void checkForUpdate(),
                    testID: 'settings.checkUpdateButton',
                    tone: 'primary',
                  }}
                  density="compact"
                  style={styles.versionButton}
                />
              ) : null}
            </View>,
          ]}
        </SettingsGroup>

        {/* 语音输入:折叠披露,展开才露出 Key 配置,不在外层摊开一大块 */}
        <SettingsGroup title="语音输入">
          {[
            <Pressable
              key="voice-header"
              accessibilityRole="button"
              accessibilityState={{ expanded: voiceExpanded }}
              onPress={toggleVoice}
              style={({ pressed }) => [styles.discloseRow, pressed && styles.pressed]}
              testID="settings.voiceDisclose"
            >
              <Text style={styles.rowLabel}>实时语音</Text>
              <Text style={styles.discloseStatus} numberOfLines={1} testID="settings.voiceLiteLlmStatus">
                {voiceLiteLlmConfigured ? '已配置' : '未配置'}
              </Text>
              {voiceExpanded
                ? <ChevronDown color={colors.textTertiary} size={iconSize.action} strokeWidth={iconStroke.regular} />
                : <ChevronRight color={colors.textTertiary} size={iconSize.action} strokeWidth={iconStroke.regular} />}
            </Pressable>,
            voiceExpanded ? (
              <View key="voice-body" style={styles.voiceBody} testID="settings.voiceLiteLlmCard">
                <Text style={styles.hint}>
                  手机端实时 ASR 和润色都通过 LiteLLM 网关。Key 只保存在这台手机，不从被控电脑同步。
                </Text>
                <TextInput
                  autoCapitalize="none"
                  autoCorrect={false}
                  importantForAutofill="no"
                  onChangeText={setVoiceLiteLlmDraft}
                  placeholder={voiceLiteLlmConfigured ? '已保存，输入新 Key 可替换' : '输入 LiteLLM Key'}
                  placeholderTextColor={colors.textTertiary}
                  secureTextEntry
                  spellCheck={false}
                  style={styles.secretInput}
                  testID="settings.voiceLiteLlmKeyInput"
                  textContentType="password"
                  value={voiceLiteLlmDraft}
                />
                {voiceSettingsMessage ? (
                  <Text style={styles.hint} testID="settings.voiceLiteLlmMessage">{voiceSettingsMessage}</Text>
                ) : null}
                <MainWindowActionGroup
                  density="compact"
                  primaryActions={[
                    {
                      accessibilityLabel: voiceSettingsBusy ? '正在保存 LiteLLM Key' : '保存 LiteLLM Key',
                      busy: voiceSettingsBusy,
                      disabled: voiceSettingsBusy || voiceLiteLlmDraft.trim().length === 0,
                      label: voiceSettingsBusy ? '保存中' : '保存',
                      onPress: () => void saveVoiceLiteLlmKey(),
                      testID: 'settings.voiceLiteLlmSaveButton',
                      tone: 'primary',
                    },
                  ]}
                  secondaryActions={[
                    {
                      accessibilityLabel: '清除 LiteLLM Key',
                      disabled: voiceSettingsBusy || !voiceLiteLlmConfigured,
                      label: '清除',
                      onPress: () => void clearVoiceLiteLlmKey(),
                      testID: 'settings.voiceLiteLlmClearButton',
                    },
                  ]}
                  testID="settings.voiceLiteLlmActions"
                />
              </View>
            ) : null,
          ]}
        </SettingsGroup>

        {/* 关于这台手机 */}
        {aboutSection ? (
          <SettingsGroup title={aboutSection.title}>
            {aboutSection.rows.map((row) => (
              row.id === 'about.deviceName' ? (
                <EditableInfoRow
                  detail={selfDeviceNameMessage ?? row.detail}
                  key={row.id}
                  label={row.label}
                  onPress={openSelfDeviceNameEditor}
                  testID="settings.selfDeviceNameRow"
                  value={row.value}
                />
              ) : (
                <InfoRow key={row.id} detail={row.detail} label={row.label} testID={`settings.row.${row.id}`} value={row.value} />
              )
            ))}
          </SettingsGroup>
        ) : null}

        {/* 调试 / 开发者:默认折叠 */}
        {debugSection ? (
          <SettingsGroup
            onToggle={toggleDebug}
            title={debugSection.title}
            titleAccessory={groupChevron(debugExpanded, colors)}
          >
            {debugExpanded
              ? [
                ...debugSection.rows.map((row) => (
                  row.copyValue ? (
                    <CopyRow copied={copiedRowId === row.id} key={row.id} onCopy={copyRow} row={row} />
                  ) : (
                    <InfoRow key={row.id} detail={row.detail} label={row.label} testID={`settings.row.${row.id}`} value={row.value} />
                  )
                )),
                ...updateInfoRows.map((row) => (
                  <InfoRow key={row.id} label={row.label} testID={`settings.updateInfo.${row.id}`} value={row.value} />
                )),
              ]
              : []}
          </SettingsGroup>
        ) : null}

        {/* App 备案信息:仅国内版显示,置于退出账号上方 */}
        {AUTH_REGION === 'cn' ? (
          <SettingsGroup title="备案信息">
            <InfoRow
              key="app-filing-number"
              label="App 备案号"
              testID="settings.appFilingNumber"
              value="沪ICP备11033765号-89A"
            />
          </SettingsGroup>
        ) : null}

        {/* 账号操作:低调置底 */}
        <View style={styles.dangerArea} testID="settings.accountActions">
          <Text style={styles.dangerHint}>
            退出只会清除这台手机上的登录态和本地远程镜像，不会影响电脑端会话。
          </Text>
          <MainWindowActionGroup
            dangerActions={[
              {
                accessibilityLabel: loggingOut ? '正在退出登录' : '退出登录',
                busy: loggingOut,
                disabled: loggingOut,
                label: loggingOut ? '退出中' : '退出登录',
                onPress: () => void logout(),
                testID: 'settings.logoutButton',
                tone: 'danger',
              },
            ]}
            testID="settings.logoutActions"
          />
        </View>
      </ScrollView>
    </SafeAreaView>
  );
}

/** 可折叠分组标题右侧的展开/收起指示箭头。 */
function groupChevron(expanded: boolean, colors: ThemeColors): ReactNode {
  return expanded
    ? <ChevronDown color={colors.textTertiary} size={iconSize.lg} strokeWidth={iconStroke.regular} />
    : <ChevronRight color={colors.textTertiary} size={iconSize.lg} strokeWidth={iconStroke.regular} />;
}

/**
 * iOS 风格分组:组标题在外侧 gutter,组内一块统一卡片,行间用 inset 分隔线。
 * 标题可点(onToggle)时承担折叠开关。rows 为空则不渲染卡片(折叠态)。
 */
function SettingsGroup({
  children,
  onToggle,
  title,
  titleAccessory,
}: {
  children: ReactNode;
  onToggle?: () => void;
  title: string;
  titleAccessory?: ReactNode;
}) {
  const styles = useThemedStyles(makeStyles);
  // Children.toArray 会丢弃 null/false 并给每个 child 赋稳定 key(沿用元素自身 key),
  // 比 key={index} 更稳:后续插入/重排调试行时不会让无关行 remount。
  const rows = Children.toArray(children);
  return (
    <View style={styles.group}>
      {onToggle ? (
        <Pressable
          accessibilityRole="button"
          onPress={onToggle}
          style={({ pressed }) => [styles.groupTitleRow, pressed && styles.pressed]}
        >
          <Text style={styles.groupTitle}>{title}</Text>
          {titleAccessory}
        </Pressable>
      ) : (
        <View style={styles.groupTitleRow}>
          <Text style={styles.groupTitle}>{title}</Text>
          {titleAccessory}
        </View>
      )}
      {rows.length > 0 ? (
        <View style={styles.card}>
          {rows.map((row, index) => (
            <Fragment key={isValidElement(row) && row.key != null ? row.key : index}>
              {index > 0 ? <View style={styles.divider} /> : null}
              {row}
            </Fragment>
          ))}
        </View>
      ) : null}
    </View>
  );
}

/** 单行信息:标签左、值右;可选 detail 另起一行(较弱)。 */
function InfoRow({
  detail,
  label,
  testID,
  value,
}: {
  detail?: string;
  label: string;
  testID?: string;
  value: string;
}) {
  const styles = useThemedStyles(makeStyles);
  return (
    <View style={styles.row} testID={testID}>
      <View style={styles.rowLine}>
        <Text style={styles.rowLabel}>{label}</Text>
        <Text style={styles.rowValue} numberOfLines={1}>{value}</Text>
      </View>
      {detail ? <Text style={styles.rowDetail} numberOfLines={2}>{detail}</Text> : null}
    </View>
  );
}

/** 可点击信息行:用于轻量编辑单个设置项。 */
function EditableInfoRow({
  detail,
  label,
  onPress,
  testID,
  value,
}: {
  detail?: string;
  label: string;
  onPress(): void;
  testID?: string;
  value: string;
}) {
  const styles = useThemedStyles(makeStyles);
  const { colors } = useTheme();
  return (
    <Pressable
      accessibilityLabel={`修改${label}`}
      accessibilityRole="button"
      onPress={onPress}
      style={({ pressed }) => [styles.row, pressed && styles.pressed]}
      testID={testID}
    >
      <View style={styles.rowLine}>
        <Text style={styles.rowLabel}>{label}</Text>
        <Text style={styles.rowValue} numberOfLines={1}>{value}</Text>
        <ChevronRight color={colors.textTertiary} size={iconSize.lg} strokeWidth={iconStroke.regular} />
      </View>
      {detail ? <Text style={styles.rowDetail} numberOfLines={2}>{detail}</Text> : null}
    </Pressable>
  );
}

function RenameSelfDeviceScreen({
  draft,
  message,
  onChangeDraft,
  onDone,
  onResetDefault,
}: {
  draft: string;
  message: string | null;
  onChangeDraft(value: string): void;
  onDone(): void;
  onResetDefault(): void;
}) {
  const styles = useThemedStyles(makeStyles);
  const { colors } = useTheme();
  return (
    <SafeAreaView style={styles.safeArea} testID="settings.renameSelfDevice.screen">
      <ScreenHeader
        backTestID="settings.renameSelfDevice.backButton"
        onBack={onDone}
        title="设备名称"
      />
      <View style={styles.nameEditorContent}>
        <View style={styles.nameEditorInputRow}>
          <TextInput
            autoFocus
            maxLength={64}
            onChangeText={onChangeDraft}
            onSubmitEditing={onDone}
            placeholder="本机名称"
            placeholderTextColor={colors.textTertiary}
            returnKeyType="done"
            selectTextOnFocus
            style={styles.nameEditorInput}
            testID="settings.renameSelfDevice.input"
            value={draft}
          />
          {draft.length > 0 ? (
            <Pressable
              accessibilityLabel="恢复默认本机名称"
              accessibilityRole="button"
              hitSlop={8}
              onPress={onResetDefault}
              style={({ pressed }) => [styles.nameEditorClearButton, pressed && styles.pressed]}
              testID="settings.renameSelfDevice.clear"
            >
              <X color={colors.surfaceElevated} size={iconSize.sm} strokeWidth={iconStroke.bold} />
            </Pressable>
          ) : null}
        </View>
        {message ? <Text style={styles.nameEditorMessage} numberOfLines={2}>{message}</Text> : null}
      </View>
    </SafeAreaView>
  );
}

/** 可复制行(长 ID / URL):标签 + 值堆叠在左,复制按钮在右。 */
function CopyRow({
  copied,
  onCopy,
  row,
}: {
  copied: boolean;
  onCopy(row: MobileSettingsRow): void;
  row: MobileSettingsRow;
}) {
  const styles = useThemedStyles(makeStyles);
  return (
    <View style={styles.copyRow} testID={`settings.row.${row.id}`}>
      <View style={styles.copyText}>
        <Text style={styles.copyLabel}>{row.label}</Text>
        <Text selectable style={styles.copyValue} numberOfLines={2}>{row.value}</Text>
      </View>
      {row.copyValue ? (
        // 自守卫:没有 copyValue 就不渲染复制按钮,避免出现"按了没反应"的死按钮
        // (调用方虽已先判断,但组件自身也要自洽)。
        <MainWindowActionButton
          action={{
            accessibilityLabel: `复制${row.label}`,
            label: copied ? '已复制' : '复制',
            onPress: () => onCopy(row),
            testID: `settings.copy.${row.id}`,
          }}
          density="compact"
          style={styles.copyButton}
        />
      ) : null}
    </View>
  );
}

const makeStyles = (colors: ThemeColors) => StyleSheet.create({
  safeArea: { backgroundColor: colors.surface, flex: 1 },
  content: {
    gap: spacing.xl,
    paddingBottom: spacing.xxl,
    paddingHorizontal: spacing.lg,
    paddingTop: spacing.lg,
  },
  // —— 账号头部 ——
  headerCard: {
    alignItems: 'center',
    flexDirection: 'row',
    gap: spacing.md,
    paddingHorizontal: spacing.xs,
    paddingVertical: spacing.sm,
  },
  avatar: {
    alignItems: 'center',
    backgroundColor: colors.surfaceElevated,
    borderColor: colors.border,
    borderRadius: radius.pill,
    borderWidth: StyleSheet.hairlineWidth,
    height: 56,
    justifyContent: 'center',
    overflow: 'hidden',
    width: 56,
  },
  avatarImage: { height: 56, width: 56 },
  avatarText: { color: colors.textPrimary, fontSize: typeScale.title, fontWeight: fontWeight.semibold },
  headerTexts: { flex: 1, gap: 3, minWidth: 0 },
  headerName: { color: colors.textPrimary, fontSize: typeScale.title, fontWeight: fontWeight.semibold },
  headerEmail: { color: colors.textSecondary, fontSize: typeScale.footnote },
  headerStatusRow: { alignItems: 'center', flexDirection: 'row', gap: spacing.xs, marginTop: 1 },
  headerStatusText: { color: colors.textSecondary, flex: 1, fontSize: typeScale.footnote, minWidth: 0 },
  // —— 分组 ——
  group: { gap: spacing.sm },
  groupTitleRow: {
    alignItems: 'center',
    flexDirection: 'row',
    gap: spacing.xs,
    minHeight: 24,
    paddingHorizontal: spacing.md,
  },
  groupTitle: { color: colors.textTertiary, flex: 1, fontSize: typeScale.footnote, fontWeight: fontWeight.medium },
  card: {
    backgroundColor: colors.surfaceElevated,
    borderColor: colors.border,
    borderRadius: radius.container,
    borderWidth: StyleSheet.hairlineWidth,
    overflow: 'hidden',
  },
  divider: { backgroundColor: colors.border, height: StyleSheet.hairlineWidth, marginLeft: spacing.lg },
  // —— 行 ——
  row: { gap: 3, justifyContent: 'center', minHeight: 52, paddingHorizontal: spacing.lg, paddingVertical: spacing.md },
  rowLine: { alignItems: 'center', flexDirection: 'row', gap: spacing.md },
  rowLabel: { color: colors.textSecondary, flexShrink: 0, fontSize: typeScale.code },
  rowValue: { color: colors.textPrimary, flex: 1, fontSize: typeScale.code, textAlign: 'right' },
  rowDetail: { color: colors.textTertiary, fontSize: typeScale.caption, lineHeight: lineHeight.caption },
  // —— 披露行(语音 / 折叠) ——
  discloseRow: {
    alignItems: 'center',
    flexDirection: 'row',
    gap: spacing.sm,
    minHeight: 52,
    paddingHorizontal: spacing.lg,
    paddingVertical: spacing.md,
  },
  discloseStatus: { color: colors.textTertiary, flex: 1, fontSize: typeScale.code, textAlign: 'right' },
  voiceBody: { gap: spacing.md, paddingBottom: spacing.lg, paddingHorizontal: spacing.lg, paddingTop: spacing.sm },
  // —— 版本行 ——
  versionRow: {
    alignItems: 'center',
    flexDirection: 'row',
    gap: spacing.md,
    minHeight: 60,
    paddingHorizontal: spacing.lg,
    paddingVertical: spacing.md,
  },
  versionTexts: { flex: 1, gap: 2, minWidth: 0 },
  versionValue: { color: colors.textPrimary, fontSize: typeScale.body, fontWeight: fontWeight.semibold },
  versionButton: { flexShrink: 0, minWidth: 84 },
  // —— 可复制行 ——
  copyRow: {
    alignItems: 'center',
    flexDirection: 'row',
    gap: spacing.md,
    minHeight: 60,
    paddingHorizontal: spacing.lg,
    paddingVertical: spacing.md,
  },
  copyText: { flex: 1, gap: 2, minWidth: 0 },
  copyLabel: { color: colors.textTertiary, fontSize: typeScale.caption, fontWeight: fontWeight.medium },
  copyValue: { color: colors.textPrimary, fontSize: typeScale.footnote, lineHeight: lineHeight.caption },
  copyButton: { flexShrink: 0, minWidth: 60 },
  // —— 退出 ——
  dangerArea: { gap: spacing.md, paddingTop: spacing.sm },
  dangerHint: { color: colors.textSecondary, fontSize: typeScale.caption, lineHeight: lineHeight.caption, paddingHorizontal: spacing.md },
  hint: { color: colors.textSecondary, fontSize: typeScale.caption, lineHeight: lineHeight.caption },
  secretInput: {
    backgroundColor: colors.surface,
    borderColor: colors.border,
    borderRadius: radius.pill,
    borderWidth: StyleSheet.hairlineWidth,
    color: colors.textPrimary,
    fontSize: typeScale.body,
    lineHeight: lineHeight.body,
    minHeight: 48,
    paddingHorizontal: spacing.lg,
    paddingVertical: spacing.sm,
  },
  nameEditorContent: {
    gap: spacing.sm,
    paddingHorizontal: spacing.lg,
    paddingTop: spacing.xl,
  },
  nameEditorInputRow: {
    alignItems: 'center',
    backgroundColor: colors.surfaceElevated,
    borderRadius: radius.pill,
    flexDirection: 'row',
    minHeight: 56,
    paddingLeft: spacing.lg,
    paddingRight: spacing.md,
  },
  nameEditorInput: {
    color: colors.textPrimary,
    flex: 1,
    fontSize: typeScale.body,
    lineHeight: lineHeight.body,
    minWidth: 0,
    paddingVertical: spacing.md,
  },
  nameEditorClearButton: {
    alignItems: 'center',
    backgroundColor: colors.textTertiary,
    borderRadius: radius.pill,
    height: 22,
    justifyContent: 'center',
    width: 22,
  },
  nameEditorMessage: {
    color: colors.textTertiary,
    fontSize: typeScale.caption,
    lineHeight: lineHeight.caption,
    paddingHorizontal: spacing.md,
  },
  pressed: { opacity: 0.6 },
});
