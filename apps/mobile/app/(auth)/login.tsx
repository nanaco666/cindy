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
import { SafeAreaView } from 'react-native-safe-area-context';
import {
  AuthApiError,
  type AccountDeletionStatus,
  type SocialProvider,
  type VerificationKind,
} from '@cindy/auth-client';

import { useAuth } from '@/auth/AuthContext';
import {
  CN_PHONE_PREFIX,
  isCompleteCnPhone,
  sanitizeCnPhoneInput,
  toCnE164,
} from '@/auth/cnPhone';
import { authErrorText, loginText } from '@/auth/loginMessages';
import { isNativeSocialProviderSupported } from '@/auth/nativeSocial';
import { Text, TextInput } from '@/components/AppText';
import { MainWindowActionButton } from '@/components/MobilePrimitives';
import { getMobileConfigIssues } from '@/config/env';
import { useObserve } from '@/observability/observe';
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
  // 企业 SSO 入口子视图：在 identifier 步骤内输入组织标识（本地展示态）
  const [ssoOrgMode, setSsoOrgMode] = useState(false);
  const [ssoOrg, setSsoOrg] = useState('');
  const [verificationCode, setVerificationCode] = useState('');
  const [ssoVerificationCode, setSsoVerificationCode] = useState('');
  const [bindingContact, setBindingContact] = useState('');
  const [bindingCode, setBindingCode] = useState('');
  const [accountDeletionStatus, setAccountDeletionStatus] =
    useState<AccountDeletionStatus | null>(null);
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
    setSsoVerificationCode('');
    setBindingContact('');
    setBindingCode('');
  }, [auth.loginState]);

  useEffect(() => {
    if (
      !auth.initialized ||
      auth.isAuthenticated ||
      !auth.accountDeletionReceipt
    ) {
      setAccountDeletionStatus(null);
      return;
    }
    let cancelled = false;
    let polling = true;
    let timer: ReturnType<typeof setInterval> | undefined;
    const stopPolling = () => {
      polling = false;
      if (timer) {
        clearInterval(timer);
        timer = undefined;
      }
    };
    const refreshStatus = async () => {
      if (!polling) return;
      try {
        const status = await auth.getAccountDeletionStatus();
        if (cancelled || !status) return;
        if (status.status === 'cancelled') {
          stopPolling();
          await auth.clearAccountDeletionReceipt();
          if (!cancelled) setAccountDeletionStatus(null);
          return;
        }
        setAccountDeletionStatus(status);
        if (status.status === 'completed') stopPolling();
      } catch (cause) {
        if (
          cause instanceof AuthApiError &&
          cause.code === 'ACCOUNT_DELETION_RECEIPT_INVALID'
        ) {
          stopPolling();
          await auth.clearAccountDeletionReceipt();
        } else if (
          cause instanceof AuthApiError &&
          cause.code === 'INVALID_RESPONSE'
        ) {
          // 契约漂移不是可重试网络错误：停止本次页面轮询，但保留 receipt，避免
          // 丢失唯一查询能力；下次挂载仍可在服务端恢复后重试。
          stopPolling();
          if (!cancelled) setAccountDeletionStatus(null);
        }
      }
    };
    void refreshStatus();
    timer = setInterval(() => void refreshStatus(), 30_000);
    return () => {
      cancelled = true;
      stopPolling();
    };
  }, [
    auth.accountDeletionReceipt,
    auth.clearAccountDeletionReceipt,
    auth.getAccountDeletionStatus,
    auth.initialized,
    auth.isAuthenticated,
  ]);

  // EAS Observe: the stable login surface is ready before network actions complete.
  useEffect(() => {
    if (auth.initialized) markInteractive();
  }, [auth.initialized, markInteractive]);

  const reset = () => {
    auth.clearAuthError();
    void auth.dispatchLoginAction({ type: 'reset' });
  };

  // 返回按钮固定在屏幕顶栏，不随各步骤内容渲染：首屏(identifier)无返回；
  // SSO 组织标识子视图退回首屏输入；其余步骤(选方式/验证码/选身份/绑定)整体重置。
  const step = auth.loginState?.step;
  const backAction =
    step === 'identifier'
      ? ssoOrgMode
        ? () => {
            auth.clearAuthError();
            setSsoOrgMode(false);
          }
        : null
      : step
        ? reset
        : null;

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
          <StepHeader
            title={loginText('ssoOrgTitle')}
            subtitle={loginText('ssoOrgSubtitle')}
          />
          <TextInput
            autoCapitalize="none"
            autoComplete="off"
            autoCorrect={false}
            editable={!disabled}
            maxLength={253}
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
      if (identifierKind === 'email') {
        const value = identifier.trim();
        if (!value) return;
        void auth.dispatchLoginAction({ type: 'discover', email: value });
      } else {
        // 手机号登录只支持中国大陆号码:UI 固定 +86,输入框只存本地号,提交时拼回完整号码
        if (!isCompleteCnPhone(identifier)) return;
        void auth.dispatchLoginAction({
          type: 'request-code',
          kind: 'phone',
          identifier: toCnE164(identifier),
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
        {identifierKind === 'phone' ? (
          <View style={styles.phoneRow}>
            {/* 固定 +86:手机号登录只支持中国大陆号码,前缀不可切换 */}
            <Text style={styles.phonePrefix}>{CN_PHONE_PREFIX}</Text>
            <TextInput
              autoComplete="tel"
              editable={!disabled}
              keyboardType="phone-pad"
              onChangeText={(text) => setIdentifier(sanitizeCnPhoneInput(text))}
              onSubmitEditing={submit}
              placeholder={loginText('phonePlaceholder')}
              placeholderTextColor={colors.textTertiary}
              returnKeyType="go"
              style={styles.phoneRowInput}
              testID="login.identifierInput"
              value={identifier}
            />
          </View>
        ) : (
          <TextInput
            autoCapitalize="none"
            autoComplete="email"
            autoCorrect={false}
            editable={!disabled}
            keyboardType="email-address"
            onChangeText={setIdentifier}
            onSubmitEditing={submit}
            placeholder={loginText('emailPlaceholder')}
            placeholderTextColor={colors.textTertiary}
            returnKeyType="go"
            style={styles.input}
            testID="login.identifierInput"
            value={identifier}
          />
        )}
        <MainWindowActionButton
          action={{
            busy: auth.isBusy,
            disabled:
              disabled ||
              (identifierKind === 'phone'
                ? !isCompleteCnPhone(identifier)
                : !identifier.trim()),
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
        {/* 企业 SSO 入口：输入组织标识发起单点登录（国内版隐藏邮箱后企业用户的登录路径） */}
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
              label: loginText(
                ssoMethods.length > 0 ? 'personalLogin' : 'emailCode',
              ),
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

  const renderSsoVerification = () => {
    const state = auth.loginState;
    if (state?.step !== 'sso-verification') return null;
    const verify = () => {
      if (ssoVerificationCode.length !== 6) return;
      void auth.dispatchLoginAction({
        type: 'verify-sso-verification',
        code: ssoVerificationCode,
      });
    };
    return (
      <>
        <StepHeader
          title={loginText('ssoVerificationTitle')}
          subtitle={loginText('ssoVerificationSubtitle').replace(
            '{target}',
            state.targetMasked,
          )}
        />
        {!state.codeRequested ? (
          <MainWindowActionButton
            action={{
              busy: auth.isBusy,
              disabled,
              label: loginText('sendCode'),
              onPress: () =>
                void auth.dispatchLoginAction({
                  type: 'request-sso-verification-code',
                }),
              testID: 'login.ssoVerificationSendButton',
              tone: 'primary',
            }}
            style={styles.fullButton}
          />
        ) : (
          <>
            <Text style={styles.helper}>{state.targetMasked}</Text>
            <CodeInput
              disabled={disabled}
              onChange={setSsoVerificationCode}
              onSubmit={verify}
              value={ssoVerificationCode}
            />
            <MainWindowActionButton
              action={{
                busy: auth.isBusy,
                disabled: disabled || ssoVerificationCode.length !== 6,
                label: loginText('signIn'),
                onPress: verify,
                testID: 'login.ssoVerificationVerifyButton',
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
                    type: 'request-sso-verification-code',
                  }),
                testID: 'login.ssoVerificationResendButton',
              }}
              density="compact"
              style={styles.fullButton}
            />
          </>
        )}
      </>
    );
  };

  const renderBinding = () => {
    const state = auth.loginState;
    if (state?.step !== 'binding') return null;
    const isEmail = state.bindType === 'email';
    // 绑定手机号与登录同规则:只支持中国大陆号码,输入框存本地号,提交拼回 +86
    const contact =
      state.contact ?? (isEmail ? bindingContact : toCnE164(bindingContact));
    const contactReady = isEmail
      ? Boolean(bindingContact.trim())
      : isCompleteCnPhone(bindingContact);
    const request = () => {
      if (!contactReady) return;
      void auth.dispatchLoginAction({
        type: 'request-binding-code',
        contact: isEmail ? bindingContact : toCnE164(bindingContact),
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
    return (
      <>
        <StepHeader
          title={loginText(isEmail ? 'bindEmailTitle' : 'bindPhoneTitle')}
          subtitle={loginText(
            isEmail ? 'bindEmailSubtitle' : 'bindPhoneSubtitle',
          )}
        />
        {!state.codeRequested ? (
          <>
            {isEmail ? (
              <TextInput
                autoCapitalize="none"
                autoComplete="email"
                autoCorrect={false}
                editable={!disabled}
                keyboardType="email-address"
                onChangeText={setBindingContact}
                onSubmitEditing={request}
                placeholder={loginText('emailPlaceholder')}
                placeholderTextColor={colors.textTertiary}
                returnKeyType="go"
                style={styles.input}
                testID="login.bindingContactInput"
                value={bindingContact}
              />
            ) : (
              <View style={styles.phoneRow}>
                {/* 固定 +86:同登录首屏,不可切换 */}
                <Text style={styles.phonePrefix}>{CN_PHONE_PREFIX}</Text>
                <TextInput
                  autoComplete="tel"
                  editable={!disabled}
                  keyboardType="phone-pad"
                  onChangeText={(text) =>
                    setBindingContact(sanitizeCnPhoneInput(text))
                  }
                  onSubmitEditing={request}
                  placeholder={loginText('phonePlaceholder')}
                  placeholderTextColor={colors.textTertiary}
                  returnKeyType="go"
                  style={styles.phoneRowInput}
                  testID="login.bindingContactInput"
                  value={bindingContact}
                />
              </View>
            )}
            <MainWindowActionButton
              action={{
                busy: auth.isBusy,
                disabled: disabled || !contactReady,
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
    renderSsoVerification() ??
    renderBinding();

  return (
    <SafeAreaView style={styles.safeArea} testID="login.screen">
      {/* 顶栏恒占位(固定高度)：返回按钮出现/消失时不引起下方内容跳动 */}
      <View style={styles.topBar}>
        {backAction ? (
          <BackButton disabled={disabled} onPress={backAction} />
        ) : null}
      </View>
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
            </View>
            <Text style={styles.title} testID="login.title">
              {loginText('title')}
            </Text>
          </View>

          <View style={styles.card}>
            {accountDeletionStatus ? (
              <AccountDeletionStatusPanel
                onDismiss={
                  accountDeletionStatus.status === 'completed'
                    ? () => void auth.clearAccountDeletionReceipt()
                    : undefined
                }
                status={accountDeletionStatus}
              />
            ) : null}
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

function AccountDeletionStatusPanel({
  onDismiss,
  status,
}: {
  onDismiss?: () => void;
  status: AccountDeletionStatus;
}) {
  const styles = useThemedStyles(makeStyles);
  const pending = status.status === 'pending';
  return (
    <View style={styles.deletionStatus} testID="login.accountDeletionStatus">
      <Text style={styles.deletionStatusTitle}>
        {pending
          ? '账号正在等待注销'
          : status.status === 'processing'
            ? '账号正在注销'
            : '账号已注销'}
      </Text>
      <Text style={styles.deletionStatusCopy}>
        {pending
          ? `预计于 ${formatAccountDeletionDate(status.deleteAfter)} 永久删除。现在重新登录即可取消注销。`
          : status.status === 'processing'
            ? '数据清理正在进行，完成后会向你的验证联系方式发送通知。'
            : '账号和个人数据清理已完成。'}
      </Text>
      {onDismiss ? (
        <MainWindowActionButton
          action={{
            label: '我知道了',
            onPress: onDismiss,
            testID: 'login.accountDeletionDismissButton',
          }}
          density="compact"
          style={styles.fullButton}
        />
      ) : null}
    </View>
  );
}

function formatAccountDeletionDate(value: string): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return new Intl.DateTimeFormat('zh-CN', {
    year: 'numeric',
    month: 'long',
    day: 'numeric',
  }).format(date);
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
      // 顶部锚定(不垂直居中):各步骤卡片高度不同,居中布局会让品牌区/标题
      // 在步骤切换时整体上下重排;固定从顶部排,标题位置跨步骤稳定不跳动。
      paddingHorizontal: spacing.xl,
      paddingVertical: spacing.xxl,
    },
    topBar: {
      justifyContent: 'center',
      minHeight: 44,
      paddingHorizontal: spacing.xl,
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
    title: {
      color: colors.textPrimary,
      fontSize: typeScale.hero,
      fontWeight: fontWeight.bold,
    },
    card: {
      backgroundColor: colors.surfaceElevated,
      borderColor: colors.border,
      borderRadius: radius.container,
      borderWidth: StyleSheet.hairlineWidth,
      gap: spacing.md,
      padding: spacing.lg,
    },
    deletionStatus: {
      borderColor: colors.borderStrong,
      borderRadius: radius.control,
      borderWidth: StyleSheet.hairlineWidth,
      gap: spacing.sm,
      padding: spacing.md,
    },
    deletionStatusTitle: {
      color: colors.textPrimary,
      fontSize: typeScale.body,
      fontWeight: fontWeight.semibold,
    },
    deletionStatusCopy: {
      color: colors.textSecondary,
      fontSize: typeScale.footnote,
      lineHeight: lineHeight.caption,
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
    // 手机号输入:外层容器沿用 input 视觉,内嵌固定 +86 前缀 + 无边框输入框
    phoneRow: {
      alignItems: 'center',
      backgroundColor: colors.surfaceElevated,
      borderColor: colors.border,
      borderRadius: radius.pill,
      borderWidth: StyleSheet.hairlineWidth,
      flexDirection: 'row',
      gap: spacing.xs,
      minHeight: 48,
      paddingHorizontal: spacing.lg,
    },
    phonePrefix: {
      color: colors.textPrimary,
      fontSize: typeScale.body,
    },
    phoneRowInput: {
      color: colors.textPrimary,
      flex: 1,
      fontSize: typeScale.body,
      minHeight: 48,
      paddingVertical: 0,
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
