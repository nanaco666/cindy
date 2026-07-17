import { useEffect, useRef, useState } from 'react';
import {
  KeyboardAvoidingView,
  Platform,
  Pressable,
  ScrollView,
  StyleSheet,
  View,
} from 'react-native';
import {
  Building2,
  ChevronLeft,
  Mail,
  Phone,
  UserRound,
} from 'lucide-react-native';
import { useObserve } from 'expo-observe';
import { SafeAreaView } from 'react-native-safe-area-context';
import type { SocialProvider, VerificationKind } from '@cindy/auth-client';

import { useAuth } from '@/auth/AuthContext';
import { authErrorText, loginText } from '@/auth/loginMessages';
import { isNativeSocialProviderSupported } from '@/auth/nativeSocial';
import { Text, TextInput } from '@/components/AppText';
import { MainWindowActionButton } from '@/components/MobilePrimitives';
import { AUTH_REGION, getMobileConfigIssues } from '@/config/env';
import { useTheme, useThemedStyles, type ThemeColors } from '@/theme';
import {
  fontWeight,
  iconSize,
  lineHeight,
  radius,
  spacing,
  typeScale,
} from '@/theme/tokens';

/** Auth-server login presentation. Credentials and tickets remain in AuthContext. */
export default function LoginScreen() {
  const styles = useThemedStyles(makeStyles);
  const { colors } = useTheme();
  const auth = useAuth();
  const { markInteractive } = useObserve();
  const initializedLoginRef = useRef(false);
  const [identifierKind, setIdentifierKind] =
    useState<VerificationKind>('email');
  const [identifier, setIdentifier] = useState('');
  // 企业 SSO 入口子视图：在 identifier 步骤内输入企业 ID（本地展示态）
  const [ssoOrgMode, setSsoOrgMode] = useState(false);
  const [ssoOrg, setSsoOrg] = useState('');
  const [verificationCode, setVerificationCode] = useState('');
  const [bindingContact, setBindingContact] = useState('');
  const [bindingCode, setBindingCode] = useState('');
  const configIssues = getMobileConfigIssues();
  const disabled = auth.isBusy || !auth.initialized || configIssues.length > 0;

  useEffect(() => {
    if (
      !auth.initialized ||
      auth.isAuthenticated ||
      initializedLoginRef.current
    )
      return;
    initializedLoginRef.current = true;
    void auth.dispatchLoginAction({ type: 'reset' });
  }, [auth]);

  useEffect(() => {
    if (auth.loginState?.step !== 'identifier') return;
    setIdentifierKind(auth.loginState.providers.attribution);
    setSsoOrgMode(false);
    setVerificationCode('');
    setBindingContact('');
    setBindingCode('');
  }, [auth.loginState]);

  // EAS Observe: the stable login surface is ready before network actions complete.
  useEffect(() => {
    if (auth.initialized) markInteractive();
  }, [auth.initialized, markInteractive]);

  const reset = () => {
    auth.clearAuthError();
    void auth.dispatchLoginAction({ type: 'reset' });
  };

  const renderIdentifier = () => {
    const state = auth.loginState;
    if (state?.step !== 'identifier') return null;
    const providers = state.providers;
    const socialProviders = providers.social.filter(
      isNativeSocialProviderSupported,
    );
    const showTabs = providers.email && providers.phone;
    if (ssoOrgMode) {
      const submitSsoOrg = () => {
        const value = ssoOrg.trim();
        if (!value) return;
        void auth.dispatchLoginAction({ type: 'discover-sso-org', org: value });
      };
      return (
        <>
          <BackButton
            disabled={disabled}
            onPress={() => {
              auth.clearAuthError();
              setSsoOrgMode(false);
            }}
          />
          <StepHeader
            title={loginText('ssoOrgTitle')}
            subtitle={loginText('ssoOrgSubtitle')}
          />
          <TextInput
            autoCapitalize="none"
            autoComplete="off"
            autoCorrect={false}
            editable={!disabled}
            maxLength={64}
            onChangeText={setSsoOrg}
            onSubmitEditing={submitSsoOrg}
            placeholder={loginText('ssoOrgPlaceholder')}
            placeholderTextColor={colors.textTertiary}
            returnKeyType="go"
            style={styles.input}
            testID="login.ssoOrgInput"
            value={ssoOrg}
          />
          <MainWindowActionButton
            action={{
              busy: auth.isBusy,
              disabled: disabled || !ssoOrg.trim(),
              label: loginText('continue'),
              onPress: submitSsoOrg,
              testID: 'login.ssoOrgContinueButton',
              tone: 'primary',
            }}
            style={styles.fullButton}
          />
          <Text style={styles.helper}>{loginText('ssoOrgHint')}</Text>
        </>
      );
    }
    const submit = () => {
      const value = identifier.trim();
      if (!value) return;
      if (identifierKind === 'email') {
        void auth.dispatchLoginAction({ type: 'discover', email: value });
      } else {
        void auth.dispatchLoginAction({
          type: 'request-code',
          kind: 'phone',
          identifier: value,
        });
      }
    };
    return (
      <>
        {showTabs ? (
          <View style={styles.segmented}>
            {(['phone', 'email'] as const).map((kind) => (
              <Pressable
                accessibilityRole="button"
                accessibilityState={{ selected: identifierKind === kind }}
                disabled={disabled}
                key={kind}
                onPress={() => {
                  setIdentifierKind(kind);
                  setIdentifier('');
                  auth.clearAuthError();
                }}
                style={({ pressed }) => [
                  styles.segment,
                  identifierKind === kind && styles.segmentSelected,
                  pressed && styles.pressed,
                ]}
                testID={`login.${kind}Tab`}
              >
                {kind === 'phone' ? (
                  <Phone color={colors.textSecondary} size={iconSize.md} />
                ) : (
                  <Mail color={colors.textSecondary} size={iconSize.md} />
                )}
                <Text style={styles.segmentText}>{loginText(kind)}</Text>
              </Pressable>
            ))}
          </View>
        ) : null}
        <TextInput
          autoCapitalize="none"
          autoComplete={identifierKind === 'email' ? 'email' : 'tel'}
          autoCorrect={false}
          editable={!disabled}
          keyboardType={
            identifierKind === 'email' ? 'email-address' : 'phone-pad'
          }
          onChangeText={setIdentifier}
          onSubmitEditing={submit}
          placeholder={loginText(
            identifierKind === 'email'
              ? 'emailPlaceholder'
              : 'phonePlaceholder',
          )}
          placeholderTextColor={colors.textTertiary}
          returnKeyType="go"
          style={styles.input}
          testID="login.identifierInput"
          value={identifier}
        />
        <MainWindowActionButton
          action={{
            busy: auth.isBusy,
            disabled: disabled || !identifier.trim(),
            label: loginText('continue'),
            onPress: submit,
            testID: 'login.continueButton',
            tone: 'primary',
          }}
          style={styles.fullButton}
        />
        {socialProviders.length > 0 ? (
          <>
            <Divider />
            {socialProviders.map((provider) => (
              <MainWindowActionButton
                action={{
                  disabled,
                  label: socialLabel(provider),
                  onPress: () =>
                    void auth.dispatchLoginAction({
                      type: 'native-social',
                      provider,
                    }),
                  testID: `login.${provider}Button`,
                }}
                key={provider}
                style={styles.fullButton}
              />
            ))}
          </>
        ) : null}
        {/* 企业 SSO 入口：输入企业 ID 发起单点登录（国内版隐藏邮箱后企业用户的登录路径） */}
        <MainWindowActionButton
          action={{
            disabled,
            label: loginText('ssoEntry'),
            onPress: () => {
              auth.clearAuthError();
              setSsoOrgMode(true);
            },
            testID: 'login.ssoEntryButton',
          }}
          density="compact"
          style={styles.fullButton}
        />
      </>
    );
  };

  const renderMethodChoice = () => {
    const state = auth.loginState;
    if (state?.step !== 'method-choice') return null;
    const ssoMethods = state.methods.filter((method) => method.type === 'sso');
    const emailAllowed =
      state.methods.some((method) => method.type === 'email_code') &&
      !ssoMethods.some((method) => method.ssoRequired);
    // 命中企业域名时按 console 同款框架提示「企业身份 / 个人身份」；无 SSO 时保持纯邮箱确认
    const orgName = ssoMethods[0]?.orgName;
    return (
      <>
        <BackButton disabled={disabled} onPress={reset} />
        <StepHeader
          title={loginText('chooseMethod')}
          subtitle={
            orgName
              ? state.email
                ? loginText('orgDetected')
                    .replace('{org}', orgName)
                    .replace('{email}', state.email)
                : // 企业 SSO 入口路径没有邮箱上下文，只提示命中的企业
                  loginText('ssoOrgDetected').replace('{org}', orgName)
              : state.email
          }
        />
        {ssoMethods.map((method) => (
          <MainWindowActionButton
            action={{
              disabled,
              label:
                ssoMethods.length > 1
                  ? `${loginText('enterpriseLogin')} · ${method.connectionName || method.orgName}`
                  : loginText('enterpriseLogin'),
              onPress: () =>
                void auth.dispatchLoginAction({
                  type: 'start-sso',
                  connectionId: method.connectionId,
                  label: method.connectionName || method.orgName,
                }),
              testID: `login.sso.${method.connectionId}`,
              tone: 'primary',
            }}
            key={method.connectionId}
            style={styles.fullButton}
          />
        ))}
        {emailAllowed ? (
          <MainWindowActionButton
            action={{
              busy: auth.isBusy,
              disabled,
              label: loginText(ssoMethods.length > 0 ? 'personalLogin' : 'emailCode'),
              onPress: () =>
                void auth.dispatchLoginAction({
                  type: 'request-code',
                  kind: 'email',
                  identifier: state.email,
                }),
              testID: 'login.emailCodeButton',
              tone: ssoMethods.length === 0 ? 'primary' : 'secondary',
            }}
            style={styles.fullButton}
          />
        ) : null}
        {ssoMethods.some((method) => method.ssoRequired) ? (
          <Text style={styles.helper}>{loginText('ssoRequired')}</Text>
        ) : null}
      </>
    );
  };

  const renderVerification = () => {
    const state = auth.loginState;
    if (state?.step !== 'verification-code') return null;
    const verify = () => {
      if (verificationCode.length !== 6) return;
      void auth.dispatchLoginAction({
        type: 'verify-code',
        kind: state.kind,
        identifier: state.identifier,
        code: verificationCode,
      });
    };
    return (
      <>
        <BackButton disabled={disabled} onPress={reset} />
        <StepHeader
          title={loginText('enterCode')}
          subtitle={`${loginText('codeSentTo')} ${state.identifier}`}
        />
        <CodeInput
          disabled={disabled}
          onChange={setVerificationCode}
          onSubmit={verify}
          value={verificationCode}
        />
        <MainWindowActionButton
          action={{
            busy: auth.isBusy,
            disabled: disabled || verificationCode.length !== 6,
            label: loginText('signIn'),
            onPress: verify,
            testID: 'login.verifyButton',
            tone: 'primary',
          }}
          style={styles.fullButton}
        />
        <MainWindowActionButton
          action={{
            disabled,
            label: loginText('resendCode'),
            onPress: () =>
              void auth.dispatchLoginAction({
                type: 'request-code',
                kind: state.kind,
                identifier: state.identifier,
              }),
            testID: 'login.resendButton',
          }}
          density="compact"
          style={styles.fullButton}
        />
      </>
    );
  };

  const renderAccountSelection = () => {
    const state = auth.loginState;
    if (state?.step !== 'account-selection') return null;
    return (
      <>
        <BackButton disabled={disabled} onPress={reset} />
        <StepHeader
          title={loginText('chooseAccount')}
          subtitle={loginText('chooseAccountSubtitle')}
        />
        {state.accounts.map((account) => (
          <Pressable
            accessibilityLabel={account.displayName}
            accessibilityRole="button"
            disabled={disabled}
            key={account.id}
            onPress={() =>
              void auth.dispatchLoginAction({
                type: 'select-account',
                accountId: account.id,
              })
            }
            style={({ pressed }) => [
              styles.accountRow,
              pressed && styles.pressed,
            ]}
            testID={`login.account.${account.id}`}
          >
            {account.kind === 'org' ? (
              <Building2 color={colors.textSecondary} size={iconSize.action} />
            ) : (
              <UserRound color={colors.textSecondary} size={iconSize.action} />
            )}
            <View style={styles.accountCopy}>
              <Text numberOfLines={1} style={styles.accountTitle}>
                {account.displayName}
              </Text>
              <Text numberOfLines={1} style={styles.accountSubtitle}>
                {account.orgName ||
                  account.email ||
                  loginText('personalAccount')}
              </Text>
            </View>
          </Pressable>
        ))}
      </>
    );
  };

  const renderBinding = () => {
    const state = auth.loginState;
    if (state?.step !== 'binding') return null;
    const contact = state.contact ?? bindingContact;
    const request = () => {
      if (!bindingContact.trim()) return;
      void auth.dispatchLoginAction({
        type: 'request-binding-code',
        contact: bindingContact,
      });
    };
    const verify = () => {
      if (!contact || bindingCode.length !== 6) return;
      void auth.dispatchLoginAction({
        type: 'verify-binding',
        contact,
        code: bindingCode,
      });
    };
    const isEmail = state.bindType === 'email';
    return (
      <>
        <BackButton disabled={disabled} onPress={reset} />
        <StepHeader
          title={loginText(isEmail ? 'bindEmailTitle' : 'bindPhoneTitle')}
          subtitle={loginText(
            isEmail ? 'bindEmailSubtitle' : 'bindPhoneSubtitle',
          )}
        />
        {!state.codeRequested ? (
          <>
            <TextInput
              autoCapitalize="none"
              autoComplete={isEmail ? 'email' : 'tel'}
              autoCorrect={false}
              editable={!disabled}
              keyboardType={isEmail ? 'email-address' : 'phone-pad'}
              onChangeText={setBindingContact}
              onSubmitEditing={request}
              placeholder={loginText(
                isEmail ? 'emailPlaceholder' : 'phonePlaceholder',
              )}
              placeholderTextColor={colors.textTertiary}
              returnKeyType="go"
              style={styles.input}
              testID="login.bindingContactInput"
              value={bindingContact}
            />
            <MainWindowActionButton
              action={{
                busy: auth.isBusy,
                disabled: disabled || !bindingContact.trim(),
                label: loginText('sendCode'),
                onPress: request,
                testID: 'login.bindingSendButton',
                tone: 'primary',
              }}
              style={styles.fullButton}
            />
          </>
        ) : (
          <>
            <Text style={styles.helper}>{contact}</Text>
            <CodeInput
              disabled={disabled}
              onChange={setBindingCode}
              onSubmit={verify}
              value={bindingCode}
            />
            <MainWindowActionButton
              action={{
                busy: auth.isBusy,
                disabled: disabled || bindingCode.length !== 6,
                label: loginText('signIn'),
                onPress: verify,
                testID: 'login.bindingVerifyButton',
                tone: 'primary',
              }}
              style={styles.fullButton}
            />
          </>
        )}
      </>
    );
  };

  const error = authErrorText(auth.authError);
  const stateContent =
    renderIdentifier() ??
    renderMethodChoice() ??
    renderVerification() ??
    renderAccountSelection() ??
    renderBinding();

  return (
    <SafeAreaView style={styles.safeArea} testID="login.screen">
      <KeyboardAvoidingView
        behavior={Platform.OS === 'ios' ? 'padding' : undefined}
        style={styles.flex}
      >
        <ScrollView
          contentContainerStyle={styles.scrollContent}
          keyboardShouldPersistTaps="handled"
        >
          <View style={styles.brandBlock}>
            <View style={styles.brandRow}>
              <Text style={styles.product}>{loginText('product')}</Text>
              {/* 区域标识仅 global 构建显示，国内版不特意标注 */}
              {AUTH_REGION === 'global' ? (
                <View style={styles.regionBadge}>
                  <Text style={styles.regionText}>
                    {loginText('regionGlobal')}
                  </Text>
                </View>
              ) : null}
            </View>
            <Text style={styles.title} testID="login.title">
              {loginText('title')}
            </Text>
            <Text style={styles.subtitle}>
              {loginText(
                AUTH_REGION === 'global' ? 'subtitleGlobal' : 'subtitleCn',
              )}
            </Text>
          </View>

          <View style={styles.card}>
            {error ? (
              <Text style={styles.error} testID="login.error">
                {error}
              </Text>
            ) : null}
            {configIssues.length > 0 ? (
              <View style={styles.configPanel} testID="login.configPanel">
                <Text style={styles.configTitle}>
                  {loginText('configTitle')}
                </Text>
                {configIssues.map((issue) => (
                  <Text key={issue.key} style={styles.configCopy}>
                    {issue.key}: {issue.message}
                  </Text>
                ))}
              </View>
            ) : null}

            {stateContent}

            {auth.loginState?.step === 'browser-redirect' ? (
              <>
                <StepHeader
                  title={loginText('browserTitle')}
                  subtitle={`${auth.loginState.label} · ${loginText('browserSubtitle')}`}
                />
                <MainWindowActionButton
                  action={{
                    disabled: auth.isBusy,
                    label: loginText('cancel'),
                    onPress: reset,
                    testID: 'login.cancelBrowserButton',
                  }}
                  style={styles.fullButton}
                />
              </>
            ) : null}

            {!auth.loginState && configIssues.length === 0 ? (
              <MainWindowActionButton
                action={{
                  busy: auth.isBusy,
                  disabled: !auth.initialized,
                  label: auth.isBusy
                    ? loginText('working')
                    : loginText('continue'),
                  onPress: reset,
                  testID: 'login.retryButton',
                  tone: 'primary',
                }}
                style={styles.fullButton}
              />
            ) : null}
          </View>
        </ScrollView>
      </KeyboardAvoidingView>
    </SafeAreaView>
  );
}

function socialLabel(provider: SocialProvider): string {
  return loginText(provider);
}

function StepHeader({ title, subtitle }: { title: string; subtitle: string }) {
  const styles = useThemedStyles(makeStyles);
  return (
    <View style={styles.stepHeader}>
      <Text style={styles.stepTitle}>{title}</Text>
      <Text style={styles.stepSubtitle}>{subtitle}</Text>
    </View>
  );
}

function BackButton({
  disabled,
  onPress,
}: {
  disabled: boolean;
  onPress: () => void;
}) {
  const styles = useThemedStyles(makeStyles);
  const { colors } = useTheme();
  return (
    <Pressable
      accessibilityLabel={loginText('back')}
      accessibilityRole="button"
      disabled={disabled}
      onPress={onPress}
      style={({ pressed }) => [styles.backButton, pressed && styles.pressed]}
      testID="login.backButton"
    >
      <ChevronLeft color={colors.textSecondary} size={iconSize.action} />
      <Text style={styles.backText}>{loginText('back')}</Text>
    </Pressable>
  );
}

function CodeInput({
  disabled,
  onChange,
  onSubmit,
  value,
}: {
  disabled: boolean;
  onChange: (value: string) => void;
  onSubmit: () => void;
  value: string;
}) {
  const styles = useThemedStyles(makeStyles);
  const { colors } = useTheme();
  return (
    <TextInput
      autoComplete="one-time-code"
      editable={!disabled}
      keyboardType="number-pad"
      maxLength={6}
      onChangeText={(next) => onChange(next.replace(/\D/g, ''))}
      onSubmitEditing={onSubmit}
      placeholder={loginText('codePlaceholder')}
      placeholderTextColor={colors.textTertiary}
      returnKeyType="done"
      style={[styles.input, styles.codeInput]}
      testID="login.codeInput"
      value={value}
    />
  );
}

function Divider() {
  const styles = useThemedStyles(makeStyles);
  return (
    <View style={styles.divider}>
      <View style={styles.dividerLine} />
      <Text style={styles.dividerText}>{loginText('or')}</Text>
      <View style={styles.dividerLine} />
    </View>
  );
}

const makeStyles = (colors: ThemeColors) =>
  StyleSheet.create({
    flex: { flex: 1 },
    safeArea: {
      backgroundColor: colors.surface,
      flex: 1,
    },
    scrollContent: {
      flexGrow: 1,
      gap: spacing.xl,
      justifyContent: 'center',
      paddingHorizontal: spacing.xl,
      paddingVertical: spacing.xxl,
    },
    brandBlock: { gap: spacing.sm },
    brandRow: {
      alignItems: 'center',
      flexDirection: 'row',
      justifyContent: 'space-between',
    },
    product: {
      color: colors.textTertiary,
      fontSize: typeScale.caption,
      fontWeight: fontWeight.semibold,
      textTransform: 'uppercase',
    },
    regionBadge: {
      backgroundColor: colors.surfaceChip,
      borderRadius: radius.pill,
      paddingHorizontal: spacing.sm,
      paddingVertical: spacing.xs,
    },
    regionText: {
      color: colors.textSecondary,
      fontSize: typeScale.micro,
      fontWeight: fontWeight.medium,
    },
    title: {
      color: colors.textPrimary,
      fontSize: typeScale.hero,
      fontWeight: fontWeight.bold,
    },
    subtitle: {
      color: colors.textSecondary,
      fontSize: typeScale.body,
      lineHeight: lineHeight.bodyRelaxed,
    },
    card: {
      backgroundColor: colors.surfaceElevated,
      borderColor: colors.border,
      borderRadius: radius.container,
      borderWidth: StyleSheet.hairlineWidth,
      gap: spacing.md,
      padding: spacing.lg,
    },
    stepHeader: { gap: spacing.xs, marginBottom: spacing.xs },
    stepTitle: {
      color: colors.textPrimary,
      fontSize: typeScale.title,
      fontWeight: fontWeight.semibold,
    },
    stepSubtitle: {
      color: colors.textSecondary,
      fontSize: typeScale.footnote,
      lineHeight: lineHeight.caption,
    },
    segmented: {
      backgroundColor: colors.surfaceChip,
      borderRadius: radius.pill,
      flexDirection: 'row',
      padding: spacing.xs,
    },
    segment: {
      alignItems: 'center',
      borderRadius: radius.pill,
      flex: 1,
      flexDirection: 'row',
      gap: spacing.xs,
      justifyContent: 'center',
      minHeight: 36,
    },
    segmentSelected: { backgroundColor: colors.surfaceElevated },
    segmentText: {
      color: colors.textPrimary,
      fontSize: typeScale.footnote,
      fontWeight: fontWeight.medium,
    },
    input: {
      backgroundColor: colors.surfaceElevated,
      borderColor: colors.border,
      borderRadius: radius.pill,
      borderWidth: StyleSheet.hairlineWidth,
      color: colors.textPrimary,
      fontSize: typeScale.body,
      minHeight: 48,
      paddingHorizontal: spacing.lg,
    },
    codeInput: {
      fontWeight: fontWeight.semibold,
      letterSpacing: spacing.sm,
      textAlign: 'center',
    },
    fullButton: { minHeight: 48, minWidth: 0 },
    helper: {
      color: colors.textSecondary,
      fontSize: typeScale.footnote,
      lineHeight: lineHeight.caption,
      textAlign: 'center',
    },
    error: {
      borderColor: colors.errorBorder,
      borderRadius: radius.control,
      borderWidth: StyleSheet.hairlineWidth,
      color: colors.errorText,
      fontSize: typeScale.footnote,
      lineHeight: lineHeight.caption,
      padding: spacing.md,
    },
    configPanel: {
      borderColor: colors.borderStrong,
      borderRadius: radius.control,
      borderWidth: StyleSheet.hairlineWidth,
      gap: spacing.xs,
      padding: spacing.md,
    },
    configTitle: {
      color: colors.textPrimary,
      fontSize: typeScale.footnote,
      fontWeight: fontWeight.semibold,
    },
    configCopy: {
      color: colors.textSecondary,
      fontSize: typeScale.caption,
      lineHeight: lineHeight.caption,
    },
    divider: {
      alignItems: 'center',
      flexDirection: 'row',
      gap: spacing.sm,
      marginVertical: spacing.xs,
    },
    dividerLine: {
      backgroundColor: colors.border,
      flex: 1,
      height: StyleSheet.hairlineWidth,
    },
    dividerText: { color: colors.textTertiary, fontSize: typeScale.caption },
    backButton: {
      alignItems: 'center',
      alignSelf: 'flex-start',
      flexDirection: 'row',
      gap: spacing.xs,
      minHeight: 36,
    },
    backText: { color: colors.textSecondary, fontSize: typeScale.footnote },
    accountRow: {
      alignItems: 'center',
      borderColor: colors.border,
      borderRadius: radius.container,
      borderWidth: StyleSheet.hairlineWidth,
      flexDirection: 'row',
      gap: spacing.md,
      minHeight: 60,
      paddingHorizontal: spacing.md,
      paddingVertical: spacing.sm,
    },
    accountCopy: { flex: 1, minWidth: 0 },
    accountTitle: {
      color: colors.textPrimary,
      fontSize: typeScale.body,
      fontWeight: fontWeight.medium,
    },
    accountSubtitle: {
      color: colors.textSecondary,
      fontSize: typeScale.caption,
    },
    pressed: { opacity: 0.72 },
  });
