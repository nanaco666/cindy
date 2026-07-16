import { useEffect, useState } from "react";
import {
  Modal,
  Pressable,
  StyleSheet,
  View,
} from "react-native";
import { Text, TextInput } from "@/components/AppText";
import {
  SafeAreaView,
} from "react-native-safe-area-context";
import { useObserve } from "expo-observe";
import { useAuth } from "@/auth/AuthContext";
import { MainWindowActionButton } from "@/components/MobilePrimitives";
import { DEV_LOGIN_ENABLED, getMobileConfigIssues } from "@/config/env";
import { useTheme, useThemedStyles, type ThemeColors } from "@/theme";
import { fontWeight, lineHeight, radius, spacing, typeScale } from "@/theme/tokens";

export default function LoginScreen() {
  const styles = useThemedStyles(makeStyles);
  const { colors } = useTheme();
  const auth = useAuth();
  const { markInteractive } = useObserve();
  const [error, setError] = useState<string | null>(null);
  const [callbackUrl, setCallbackUrl] = useState("");
  const [debugOpen, setDebugOpen] = useState(false);
  const configIssues = getMobileConfigIssues();
  const showDebugLogin = __DEV__ || DEV_LOGIN_ENABLED;
  const disabled =
    auth.isBusy ||
    !auth.initialized ||
    configIssues.length > 0;

  // EAS Observe:登录屏按钮就绪(可交互)即标记。
  useEffect(() => {
    if (!disabled) markInteractive();
  }, [disabled, markInteractive]);

  const login = async () => {
    setError(null);
    auth.clearAuthError();
    try {
      await auth.loginWithFeishu();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  };

  const localDevLogin = async () => {
    setError(null);
    try {
      await auth.devLogin();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  };

  const completeDevLogin = async () => {
    setError(null);
    try {
      await auth.completeOAuthCallback(callbackUrl);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  };

  return (
    <SafeAreaView style={styles.safeArea} testID="login.screen">
      <View style={styles.shell}>
        <View style={styles.brandBlock}>
          <Text style={styles.product}>XDMaker</Text>
          <Text style={styles.title} testID="login.title">远程控制台</Text>
          <Text style={styles.subtitle}>
            使用手机连接同账号电脑，查看会话、继续发送消息，并处理远程授权请求。
          </Text>
        </View>

        {error ?? auth.authError ? (
          <Text style={styles.error} testID="login.error">{error ?? auth.authError}</Text>
        ) : null}
        {configIssues.length > 0 ? (
          <View style={styles.configPanel} testID="login.configPanel">
            <Text style={styles.configTitle}>移动端配置未完成</Text>
            {configIssues.map((issue) => (
              <Text key={issue.key} style={styles.configCopy}>
                {issue.key}: {issue.message}
              </Text>
            ))}
          </View>
        ) : null}

        <MainWindowActionButton
          action={{
            accessibilityLabel: auth.isBusy ? "正在飞书登录" : "飞书登录",
            busy: auth.isBusy,
            disabled,
            label: "飞书登录",
            onPress: login,
            testID: "login.feishuButton",
            tone: "primary",
          }}
          style={styles.primaryButton}
        />

        {showDebugLogin ? (
          <MainWindowActionButton
            action={{
              accessibilityLabel: "打开开发调试",
              label: "开发调试",
              onPress: () => setDebugOpen(true),
              testID: "login.debugButton",
            }}
            density="compact"
            style={styles.debugEntryButton}
          />
        ) : null}

        {showDebugLogin ? (
          <Modal
            animationType="slide"
            onRequestClose={() => setDebugOpen(false)}
            presentationStyle="overFullScreen"
            transparent
            visible={debugOpen}
          >
            <View style={styles.debugModalRoot}>
              <Pressable
                accessibilityLabel="关闭开发调试"
                accessibilityRole="button"
                onPress={() => setDebugOpen(false)}
                style={styles.debugBackdrop}
                testID="login.debugBackdrop"
              />
              <SafeAreaView style={styles.debugSheet} testID="login.devPanel">
                <View style={styles.debugSheetHeader}>
                  <View style={styles.debugSheetTitleBlock}>
                    <Text style={styles.devTitle}>开发调试</Text>
                    <Text style={styles.devCopy}>
                      仅用于本地联调、mock login 和 callback 兜底。
                    </Text>
                  </View>
                  <MainWindowActionButton
                    action={{
                      accessibilityLabel: "关闭开发调试",
                      label: "关闭",
                      onPress: () => setDebugOpen(false),
                      testID: "login.debugCloseButton",
                    }}
                    density="compact"
                    style={styles.secondaryButton}
                  />
                </View>
                <Text style={styles.devCopy}>
                  本地 server 开启 XDT_DEV_AUTH_ENABLED=1 后，可以跳过飞书，先验证手机和电脑端的 device-link 连接。
                </Text>
                <MainWindowActionButton
                  action={{
                    accessibilityLabel: auth.isBusy ? "正在本地模拟登录" : "本地模拟登录",
                    busy: auth.isBusy,
                    disabled: auth.isBusy,
                    label: "本地模拟登录",
                    onPress: () => void localDevLogin(),
                    testID: "login.devLoginButton",
                  }}
                  style={styles.secondaryWideButton}
                />
                <Text style={styles.devCopy}>
                  如果系统浏览器登录也不可用，再把桌面浏览器里的完整 callback URL 粘贴到这里。
                </Text>
                <TextInput
                  autoCapitalize="none"
                  autoCorrect={false}
                  multiline
                  onChangeText={setCallbackUrl}
                  placeholder="https://xdt-api.magiclizi.com/api/auth/callback?code=..."
                  placeholderTextColor={colors.textTertiary}
                  style={styles.devInput}
                  testID="login.callbackInput"
                  value={callbackUrl}
                />
                <MainWindowActionButton
                  action={{
                    accessibilityLabel: auth.isBusy ? "正在用 callback URL 完成登录" : "用 callback URL 完成登录",
                    busy: auth.isBusy,
                    disabled: auth.isBusy || callbackUrl.trim().length === 0,
                    label: "用 callback URL 完成登录",
                    onPress: () => void completeDevLogin(),
                    testID: "login.callbackButton",
                  }}
                  style={styles.secondaryWideButton}
                />
              </SafeAreaView>
            </View>
          </Modal>
        ) : null}
      </View>
    </SafeAreaView>
  );
}

const makeStyles = (colors: ThemeColors) => StyleSheet.create({
  safeArea: {
    flex: 1,
    backgroundColor: colors.surface,
  },
  shell: {
    flex: 1,
    justifyContent: "space-between",
    paddingHorizontal: spacing.xl,
    paddingVertical: spacing.xxl,
  },
  brandBlock: {
    gap: spacing.md,
  },
  product: {
    color: colors.textTertiary,
    fontSize: typeScale.caption,
    fontWeight: fontWeight.semibold,
    textTransform: "uppercase",
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
  error: {
    borderColor: colors.errorBorder,
    borderRadius: radius.container,
    borderWidth: StyleSheet.hairlineWidth,
    color: colors.errorText,
    fontSize: typeScale.body,
    padding: spacing.md,
  },
  configPanel: {
    borderColor: colors.borderStrong,
    borderRadius: radius.container,
    borderWidth: StyleSheet.hairlineWidth,
    gap: spacing.sm,
    padding: spacing.md,
  },
  configTitle: {
    color: colors.textPrimary,
    fontSize: typeScale.body,
    fontWeight: fontWeight.semibold,
  },
  configCopy: {
    color: colors.textSecondary,
    fontSize: typeScale.caption,
    lineHeight: lineHeight.caption,
  },
  primaryButton: {
    minHeight: 52,
    minWidth: 0,
  },
  debugEntryButton: {
    alignSelf: "center",
    minWidth: 112,
  },
  debugModalRoot: {
    backgroundColor: colors.overlay,
    flex: 1,
    justifyContent: "flex-end",
  },
  debugBackdrop: {
    ...StyleSheet.absoluteFill,
  },
  debugSheet: {
    backgroundColor: colors.surfaceElevated,
    borderColor: colors.border,
    borderTopLeftRadius: radius.container,
    borderTopRightRadius: radius.container,
    borderWidth: StyleSheet.hairlineWidth,
    gap: spacing.md,
    padding: spacing.lg,
  },
  debugSheetHeader: {
    alignItems: "center",
    flexDirection: "row",
    gap: spacing.md,
    justifyContent: "space-between",
  },
  debugSheetTitleBlock: {
    flex: 1,
    gap: spacing.xs,
  },
  devTitle: {
    color: colors.textPrimary,
    fontSize: typeScale.body,
    fontWeight: fontWeight.semibold,
  },
  devCopy: {
    color: colors.textSecondary,
    fontSize: typeScale.caption,
    lineHeight: lineHeight.caption,
  },
  devInput: {
    backgroundColor: colors.surfaceElevated,
    borderColor: colors.border,
    borderRadius: radius.container,
    borderWidth: StyleSheet.hairlineWidth,
    color: colors.textPrimary,
    fontSize: typeScale.caption,
    minHeight: 72,
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.sm,
  },
  secondaryWideButton: {
    minHeight: 44,
    minWidth: 0,
  },
  secondaryButton: {
    minHeight: 36,
    minWidth: 72,
  },
});
