import { useMemo } from 'react';
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
  // 构建含 mermaidAutofix 预算修复版的完整 HTML,非平凡字符串工作——
  // memo 掉,只有源码或主题变化才重建,父级无关重渲染不重付。
  const html = useMemo(
    () =>
      buildMermaidWebViewHtml(source, {
        surfaceChip: colors.surfaceChip,
        textPrimary: colors.textPrimary,
        textSecondary: colors.textSecondary,
        textTertiary: colors.textTertiary,
        dark: mode === 'dark',
      }),
    [source, colors.surfaceChip, colors.textPrimary, colors.textSecondary, colors.textTertiary, mode],
  );
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
          html,
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
