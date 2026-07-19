import { ActivityIndicator, Image, StyleSheet, useWindowDimensions, View } from 'react-native';
import { StatusBar } from 'expo-status-bar';
import { Text } from '@/components/AppText';
import { fontWeight, useTheme, useThemedStyles, type ThemeColors } from '@/theme';
import { spacing, typeScale } from '@/theme/tokens';

const splashIllustration = require('../../assets/splash/cindy-splash-illustration-fade.webp');
const splashWordmark = require('../../assets/splash/cindy-splash-wordmark-white.png');
const splashScript = require('../../assets/splash/cindy-splash-script-white.png');

const SPLASH_CANVAS_WIDTH = 375;
const SPLASH_CANVAS_HEIGHT = 812;
const SPLASH_ILLUSTRATION_TOP = 125.5;
const SPLASH_ILLUSTRATION_SIZE = 354;
const SPLASH_WORDMARK_TOP = 442.5;
const SPLASH_WORDMARK_WIDTH = 217;
const SPLASH_WORDMARK_HEIGHT = 74;
const SPLASH_SCRIPT_TOP = 530.5;
const SPLASH_SCRIPT_LEFT = 182.5;
const SPLASH_SCRIPT_WIDTH = 175.5;
const SPLASH_SCRIPT_HEIGHT = 50;

export function CenteredScreen({
  title,
  subtitle,
  variant = 'default',
}: {
  title: string;
  subtitle?: string;
  variant?: 'default' | 'splash';
}) {
  const styles = useThemedStyles(makeStyles);
  const { colors } = useTheme();
  const { height, width } = useWindowDimensions();

  if (variant === 'splash') {
    const scale = Math.min(width / SPLASH_CANVAS_WIDTH, height / SPLASH_CANVAS_HEIGHT);
    const stageWidth = SPLASH_CANVAS_WIDTH * scale;
    const stageHeight = SPLASH_CANVAS_HEIGHT * scale;
    const stageTop = (height - stageHeight) / 2;
    const stageLeft = (width - stageWidth) / 2;
    const illustrationSize = SPLASH_ILLUSTRATION_SIZE * scale;
    const wordmarkWidth = SPLASH_WORDMARK_WIDTH * scale;
    const scriptWidth = SPLASH_SCRIPT_WIDTH * scale;
    return (
      <View
        accessibilityLabel={title}
        style={styles.splashRoot}
        testID="startup.splash"
      >
        <StatusBar style="light" />
        <Image
          accessibilityIgnoresInvertColors
          resizeMode="contain"
          source={splashIllustration}
          style={[
            styles.splashIllustration,
            {
              height: illustrationSize,
              left: stageLeft + ((SPLASH_CANVAS_WIDTH * scale) - illustrationSize) / 2,
              top: stageTop + SPLASH_ILLUSTRATION_TOP * scale,
              width: illustrationSize,
            },
          ]}
        />
        <Image
          accessibilityIgnoresInvertColors
          resizeMode="contain"
          source={splashWordmark}
          style={[
            styles.splashWordmark,
            {
              height: SPLASH_WORDMARK_HEIGHT * scale,
              left: stageLeft + ((SPLASH_CANVAS_WIDTH * scale) - wordmarkWidth) / 2,
              top: stageTop + SPLASH_WORDMARK_TOP * scale,
              width: wordmarkWidth,
            },
          ]}
        />
        <Image
          accessibilityIgnoresInvertColors
          resizeMode="contain"
          source={splashScript}
          style={[
            styles.splashScript,
            {
              height: SPLASH_SCRIPT_HEIGHT * scale,
              left: stageLeft + SPLASH_SCRIPT_LEFT * scale,
              top: stageTop + SPLASH_SCRIPT_TOP * scale,
              width: scriptWidth,
            },
          ]}
        />
      </View>
    );
  }

  return (
    <View style={styles.root}>
      <ActivityIndicator color={colors.textSecondary} />
      <Text style={styles.title}>{title}</Text>
      {subtitle ? <Text style={styles.subtitle}>{subtitle}</Text> : null}
    </View>
  );
}

const makeStyles = (colors: ThemeColors) => StyleSheet.create({
  root: {
    alignItems: 'center',
    backgroundColor: colors.surface,
    flex: 1,
    gap: spacing.sm,
    justifyContent: 'center',
    padding: spacing.xl,
  },
  splashRoot: {
    backgroundColor: colors.brandSplashBackground,
    flex: 1,
    overflow: 'hidden',
  },
  splashIllustration: {
    position: 'absolute',
  },
  splashWordmark: {
    position: 'absolute',
  },
  splashScript: {
    position: 'absolute',
  },
  title: {
    color: colors.textPrimary,
    fontSize: typeScale.title,
    fontWeight: fontWeight.medium,
  },
  subtitle: {
    color: colors.textSecondary,
    fontSize: typeScale.body,
    textAlign: 'center',
  },
});
