/**
 * MobileProviderMark —— provider-aware 模型下拉里每行前缀 / trigger 药丸的「来源徽标」。
 *
 * 对齐桌面 ProviderMark:三个内置供应商用**官方单色 mark**(Claude / Codex / CindyAI,path 与
 * 桌面同源,见 components/vendorIconPaths),其它(自定义供应商)回退首字母 monogram。与桌面的
 * 一处刻意差异:monogram 容器沿用 pill 圆角(桌面是 4px 方盒)——手机圆角走二元规则
 * (container/pill),不引入中间值。
 */
import { StyleSheet, View } from 'react-native';
import { Text } from '@/components/AppText';
import Svg, { Path } from 'react-native-svg';

import {
  CINDYAI_PATH,
  CINDYAI_VIEW_BOX,
  CLAUDE_PATH,
  CODEX_PATH,
} from '@/components/vendorIconPaths';
import { useTheme, useThemedStyles, type ThemeColors } from '@/theme';
import { fontWeight as fontWeightToken, radius, typeScale } from '@/theme/tokens';

import { providerMonogram } from './providerModelSections';

const MARK_SIZE = 18;

const makeStyles = (c: ThemeColors) =>
  StyleSheet.create({
    monogram: {
      alignItems: 'center',
      borderColor: c.borderStrong,
      borderRadius: radius.pill,
      borderWidth: 1,
      height: MARK_SIZE,
      justifyContent: 'center',
      width: MARK_SIZE,
    },
    monogramText: {
      color: c.textSecondary,
      fontSize: typeScale.micro,
      fontWeight: fontWeightToken.semibold,
      // CJK / 拉丁字母在小圆点里视觉重心略偏下,nudge -0.5 居中。
      includeFontPadding: false,
      textAlign: 'center',
    },
    markBox: {
      alignItems: 'center',
      height: MARK_SIZE,
      justifyContent: 'center',
      width: MARK_SIZE,
    },
  });

export interface MobileProviderMarkProps {
  /** 供应商 id(anthropic / openai / xd → 官方 mark;其它 / 缺省 → monogram)。 */
  providerId?: string;
  /** 供应商展示名(monogram 取首字母;官方 mark 分支不消费)。 */
  name: string;
  /** mark 单色;缺省 textSecondary(列表行口径,trigger 场景可传 textPrimary)。 */
  color?: string;
}

/** 渲染单个供应商的来源徽标(官方 mark 或 monogram)。 */
export function MobileProviderMark({ providerId, name, color }: MobileProviderMarkProps) {
  const styles = useThemedStyles(makeStyles);
  const { colors } = useTheme();
  const fill = color ?? colors.textSecondary;
  // 官方 mark 比 monogram 容器缩一档(桌面同比:行内 mark ≈ 12.3 vs 容器 18),避免视觉过重。
  const glyph = 13;

  switch (providerId) {
    case 'anthropic':
      return (
        <View accessible={false} style={styles.markBox}>
          <Svg width={glyph} height={glyph} viewBox="0 0 24 24">
            <Path d={CLAUDE_PATH} fill={fill} />
          </Svg>
        </View>
      );
    case 'openai':
      return (
        <View accessible={false} style={styles.markBox}>
          <Svg width={glyph} height={glyph} viewBox="0 0 24 24">
            <Path d={CODEX_PATH} fill={fill} />
          </Svg>
        </View>
      );
    case 'xd':
      return (
        <View accessible={false} style={styles.markBox}>
          <Svg width={glyph} height={glyph} viewBox={CINDYAI_VIEW_BOX}>
            <Path d={CINDYAI_PATH} fill={fill} />
          </Svg>
        </View>
      );
    default:
      return (
        <View style={styles.monogram}>
          <Text style={[styles.monogramText, color ? { color } : null]}>
            {providerMonogram(name)}
          </Text>
        </View>
      );
  }
}
