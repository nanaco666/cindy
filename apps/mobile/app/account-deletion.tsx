import { useCallback, useEffect, useState } from 'react';
import { useRouter } from 'expo-router';
import {
  KeyboardAvoidingView,
  Platform,
  Pressable,
  ScrollView,
  StyleSheet,
  View,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { Check } from 'lucide-react-native';
import {
  AuthApiError,
  type AccountDeletionAvailability,
  type AccountDeletionChallenge,
} from '@cindy/auth-client';

import { useAuth } from '@/auth/AuthContext';
import { Text, TextInput } from '@/components/AppText';
import {
  MainWindowActionButton,
  ScreenHeader,
} from '@/components/MobilePrimitives';
import { goBackGuarded } from '@/utils/backGuard';
import { useTheme, useThemedStyles, type ThemeColors } from '@/theme';
import {
  fontWeight,
  iconSize,
  iconStroke,
  lineHeight,
  radius,
  spacing,
  typeScale,
} from '@/theme/tokens';

export default function AccountDeletionScreen() {
  const auth = useAuth();
  const router = useRouter();
  const styles = useThemedStyles(makeStyles);
  const { colors } = useTheme();
  const [availability, setAvailability] =
    useState<AccountDeletionAvailability | null>(null);
  const [challenge, setChallenge] =
    useState<AccountDeletionChallenge | null>(null);
  const [code, setCode] = useState('');
  const [acknowledged, setAcknowledged] = useState(false);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    void auth
      .getAccountDeletionAvailability()
      .then((result) => {
        if (!cancelled) setAvailability(result);
      })
      .catch((cause) => {
        if (!cancelled) setError(accountDeletionErrorText(cause));
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [auth.getAccountDeletionAvailability]);

  const requestChallenge = useCallback(async () => {
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      const next = await auth.requestAccountDeletionChallenge();
      setChallenge(next);
      setCode('');
      setAcknowledged(false);
    } catch (cause) {
      setError(accountDeletionErrorText(cause));
    } finally {
      setBusy(false);
    }
  }, [auth, busy]);

  const confirm = useCallback(async () => {
    if (!challenge || code.length !== 6 || !acknowledged || busy) return;
    setBusy(true);
    setError(null);
    try {
      await auth.confirmAccountDeletion({
        challengeId: challenge.challengeId,
        receiptToken: challenge.receiptToken,
        code,
      });
    } catch (cause) {
      setError(accountDeletionErrorText(cause));
    } finally {
      setBusy(false);
    }
  }, [acknowledged, auth, busy, challenge, code]);

  const available = availability?.available;
  return (
    <SafeAreaView style={styles.safeArea} testID="accountDeletion.screen">
      <ScreenHeader
        backTestID="accountDeletion.backButton"
        onBack={() => goBackGuarded(router)}
        title="注销账号"
        titleTestID="accountDeletion.title"
      />
      <KeyboardAvoidingView
        behavior={Platform.OS === 'ios' ? 'padding' : undefined}
        style={styles.flex}
      >
        <ScrollView
          contentContainerStyle={styles.content}
          keyboardShouldPersistTaps="handled"
          testID="accountDeletion.scroll"
        >
          {loading ? (
            <Text style={styles.helper} testID="accountDeletion.loading">
              正在确认账号状态…
            </Text>
          ) : !available ? (
            <View style={styles.card} testID="accountDeletion.unavailable">
              <Text style={styles.cardTitle}>当前无法进行此操作</Text>
              <Text style={styles.helper}>请返回设置页稍后重试。</Text>
            </View>
          ) : challenge ? (
            <>
              <View style={styles.card}>
                <Text style={styles.cardTitle}>验证账号所有权</Text>
                <Text style={styles.body}>
                  验证码已发送至 {challenge.maskedTarget}，10 分钟内有效。
                </Text>
                <TextInput
                  autoComplete="one-time-code"
                  editable={!busy}
                  keyboardType="number-pad"
                  maxLength={6}
                  onChangeText={(value) =>
                    setCode(value.replace(/\D/g, ''))
                  }
                  onSubmitEditing={() => void confirm()}
                  placeholder="6 位验证码"
                  placeholderTextColor={colors.textTertiary}
                  returnKeyType="done"
                  style={styles.codeInput}
                  testID="accountDeletion.codeInput"
                  value={code}
                />
              </View>

              <Pressable
                accessibilityLabel="确认了解账号注销影响"
                accessibilityRole="checkbox"
                accessibilityState={{ checked: acknowledged }}
                disabled={busy}
                onPress={() => setAcknowledged((value) => !value)}
                style={({ pressed }) => [
                  styles.acknowledgement,
                  pressed && styles.pressed,
                ]}
                testID="accountDeletion.acknowledgement"
              >
                <View
                  style={[
                    styles.checkbox,
                    acknowledged && styles.checkboxChecked,
                  ]}
                >
                  {acknowledged ? (
                    <Check
                      color={colors.ctaText}
                      size={iconSize.sm}
                      strokeWidth={iconStroke.bold}
                    />
                  ) : null}
                </View>
                <Text style={styles.acknowledgementText}>
                  我已了解：确认后所有设备会立即退出；30 天内重新登录可撤销；到期后账号和数据将永久删除且无法恢复。
                </Text>
              </Pressable>

              {error ? (
                <Text style={styles.error} testID="accountDeletion.error">
                  {error}
                </Text>
              ) : null}
              <MainWindowActionButton
                action={{
                  accessibilityLabel: busy ? '正在确认注销' : '确认注销账号',
                  busy,
                  disabled: busy || code.length !== 6 || !acknowledged,
                  label: busy ? '确认中' : '确认注销账号',
                  onPress: () => void confirm(),
                  testID: 'accountDeletion.confirmButton',
                  tone: 'danger',
                }}
              />
              <MainWindowActionButton
                action={{
                  disabled: busy,
                  label: '重新发送验证码',
                  onPress: () => void requestChallenge(),
                  testID: 'accountDeletion.resendButton',
                }}
                density="compact"
              />
            </>
          ) : (
            <>
              <View style={styles.card}>
                <Text style={styles.cardTitle}>注销前请确认</Text>
                <ImpactRow text="确认后，这台手机和其他在线设备会立即退出登录。" />
                <ImpactRow text="账号进入 30 天等待期；期间重新登录即可取消注销。" />
                <ImpactRow text="等待期结束后，账号、会话和云端个人数据将被永久删除。" />
                <ImpactRow text="依法需要保留的交易记录会去标识化保存。" />
              </View>
              {availability.manualAppleRevocationRequired ? (
                <View style={styles.notice} testID="accountDeletion.appleNotice">
                  <Text style={styles.body}>
                    使用 Apple 登录的授权可能需要你在 Apple ID 设置中手动停止使用 Cindy。
                  </Text>
                </View>
              ) : null}
              <Text style={styles.helper}>
                验证码将发送至 {availability.verification?.maskedTarget}。
              </Text>
              {error ? (
                <Text style={styles.error} testID="accountDeletion.error">
                  {error}
                </Text>
              ) : null}
              <MainWindowActionButton
                action={{
                  busy,
                  disabled: busy,
                  label: busy ? '发送中' : '发送验证码',
                  onPress: () => void requestChallenge(),
                  testID: 'accountDeletion.sendCodeButton',
                  tone: 'danger',
                }}
              />
            </>
          )}
        </ScrollView>
      </KeyboardAvoidingView>
    </SafeAreaView>
  );
}

function ImpactRow({ text }: { text: string }) {
  const styles = useThemedStyles(makeStyles);
  return (
    <View style={styles.impactRow}>
      <View style={styles.bullet} />
      <Text style={styles.body}>{text}</Text>
    </View>
  );
}

function accountDeletionErrorText(cause: unknown): string {
  if (cause instanceof AuthApiError) {
    switch (cause.code) {
      case 'ACCOUNT_DELETION_CHALLENGE_INVALID':
        return '验证码错误或已过期，请检查后重试。';
      case 'CODE_ATTEMPTS_EXCEEDED':
        return '验证次数过多，请重新发送验证码。';
      case 'RATE_LIMITED':
        return '操作过于频繁，请稍后再试。';
      case 'ACCOUNT_DELETION_PENDING':
        return '账号已进入注销等待期。';
      case 'ACCOUNT_DELETION_PROCESSING':
        return '账号正在注销处理中。';
      case 'ACCOUNT_DELETION_UNAVAILABLE':
        return '当前无法进行此操作。';
      case 'NETWORK_ERROR':
      case 'REQUEST_TIMEOUT':
        return '网络连接异常，请稍后重试。';
      default:
        break;
    }
  }
  return '操作未完成，请稍后重试。';
}

const makeStyles = (colors: ThemeColors) =>
  StyleSheet.create({
    safeArea: { backgroundColor: colors.surface, flex: 1 },
    flex: { flex: 1 },
    content: {
      gap: spacing.lg,
      paddingBottom: spacing.xxl,
      paddingHorizontal: spacing.lg,
      paddingTop: spacing.xl,
    },
    card: {
      backgroundColor: colors.surfaceElevated,
      borderColor: colors.border,
      borderRadius: radius.container,
      borderWidth: StyleSheet.hairlineWidth,
      gap: spacing.md,
      padding: spacing.lg,
    },
    cardTitle: {
      color: colors.textPrimary,
      fontSize: typeScale.title,
      fontWeight: fontWeight.semibold,
    },
    body: {
      color: colors.textSecondary,
      flex: 1,
      fontSize: typeScale.body,
      lineHeight: lineHeight.body,
    },
    helper: {
      color: colors.textTertiary,
      fontSize: typeScale.footnote,
      lineHeight: lineHeight.caption,
      paddingHorizontal: spacing.sm,
    },
    error: {
      color: colors.errorText,
      fontSize: typeScale.footnote,
      lineHeight: lineHeight.caption,
      paddingHorizontal: spacing.sm,
    },
    impactRow: {
      alignItems: 'flex-start',
      flexDirection: 'row',
      gap: spacing.sm,
    },
    bullet: {
      backgroundColor: colors.textTertiary,
      borderRadius: radius.pill,
      height: 5,
      marginTop: 9,
      width: 5,
    },
    notice: {
      backgroundColor: colors.surfaceElevated,
      borderColor: colors.borderStrong,
      borderRadius: radius.container,
      borderWidth: StyleSheet.hairlineWidth,
      padding: spacing.lg,
    },
    codeInput: {
      backgroundColor: colors.surface,
      borderColor: colors.border,
      borderRadius: radius.control,
      borderWidth: StyleSheet.hairlineWidth,
      color: colors.textPrimary,
      fontSize: typeScale.title,
      letterSpacing: 8,
      minHeight: 56,
      paddingHorizontal: spacing.lg,
      textAlign: 'center',
    },
    acknowledgement: {
      alignItems: 'flex-start',
      flexDirection: 'row',
      gap: spacing.md,
      paddingHorizontal: spacing.sm,
    },
    acknowledgementText: {
      color: colors.textSecondary,
      flex: 1,
      fontSize: typeScale.footnote,
      lineHeight: lineHeight.caption,
    },
    checkbox: {
      alignItems: 'center',
      borderColor: colors.borderStrong,
      borderRadius: radius.micro,
      borderWidth: 1,
      height: 22,
      justifyContent: 'center',
      marginTop: 1,
      width: 22,
    },
    checkboxChecked: {
      backgroundColor: colors.cta,
      borderColor: colors.cta,
    },
    pressed: { opacity: 0.6 },
  });
