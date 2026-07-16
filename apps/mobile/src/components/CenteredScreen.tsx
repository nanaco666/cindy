import { ActivityIndicator, StyleSheet, View } from 'react-native';
import { Text } from '@/components/AppText';
import { fontWeight, useTheme, useThemedStyles, type ThemeColors } from '@/theme';
import { spacing, typeScale } from '@/theme/tokens';

export function CenteredScreen({ title, subtitle }: { title: string; subtitle?: string }) {
  const styles = useThemedStyles(makeStyles);
  const { colors } = useTheme();
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
