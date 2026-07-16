import { StyleSheet, View } from 'react-native';
import { WebView } from 'react-native-webview';
import { buildMermaidWebViewHtml } from '@/session/mermaidWebViewHtml';
import { useTheme, useThemedStyles, type ThemeColors } from '@/theme';
import { radius } from '@/theme/tokens';

export function MermaidDiagramWebView({
  height = 220,
  source,
  testID,
}: {
  height?: number;
  source: string;
  testID?: string;
}) {
  const styles = useThemedStyles(makeStyles);
  const { colors, mode } = useTheme();
  return (
    <View style={styles.container} testID={testID}>
      <WebView
        automaticallyAdjustContentInsets={false}
        javaScriptEnabled
        nestedScrollEnabled
        originWhitelist={['*']}
        scrollEnabled
        setSupportMultipleWindows={false}
        source={{
          html: buildMermaidWebViewHtml(source, {
            surfaceChip: colors.surfaceChip,
            textPrimary: colors.textPrimary,
            textSecondary: colors.textSecondary,
            textTertiary: colors.textTertiary,
            dark: mode === 'dark',
          }),
          baseUrl: 'https://xdt-maker-mobile.local',
        }}
        style={[styles.webView, { height }]}
      />
    </View>
  );
}

const makeStyles = (colors: ThemeColors) => StyleSheet.create({
  container: {
    backgroundColor: colors.surfaceChip,
    borderColor: colors.border,
    borderRadius: radius.container,
    borderWidth: StyleSheet.hairlineWidth,
    overflow: 'hidden',
  },
  webView: {
    backgroundColor: colors.surfaceChip,
    width: '100%',
  },
});
