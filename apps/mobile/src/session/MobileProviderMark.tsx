/**
 * MobileProviderMark —— provider-aware 模型下拉里每行前缀 / trigger 药丸的「来源徽标」。
 *
 * 对齐桌面 ProviderMark:三个内置供应商用**官方单色 mark**(Claude / Codex / XD,path 与桌面
 * 同源,见 components/vendorIconPaths),其它(自定义供应商)回退首字母 monogram。与桌面的
 * 一处刻意差异:monogram 容器沿用 pill 圆角(桌面是 4px 方盒)——手机圆角走二元规则
 * (container/pill),不引入中间值。XD mark 非正方形(158:282),渲染时在 size×size 盒内
 * 垂直居中,保证与正方形 mark 同行对齐。
 */
import { StyleSheet, View } from 'react-native';
import { Text } from '@/components/AppText';
import Svg, { Path } from 'react-native-svg';

import {
  CLAUDE_PATH,
  CODEX_PATH,
  XD_ASPECT,
  XD_SYMBOL_PATHS,
  XD_VIEW_BOX,
} from '@/components/vendorIconPaths';
import { useTheme, useThemedStyles, type ThemeColors } from '@/theme';
import { fontWeight as fontWeightToken, radius, typeScale } from '@/theme/tokens';
import type { AgentKind } from '@lizi/model-providers/types';

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
    case 'xd': {
      const w = glyph + 2; // XD mark 横长,宽给一点补偿才与正方形 mark 视觉等重。
      return (
        <View accessible={false} style={styles.markBox}>
          <Svg width={w} height={w * XD_ASPECT} viewBox={XD_VIEW_BOX}>
            {XD_SYMBOL_PATHS.map((p) => (
              <Path key={p} d={p} fill={fill} />
            ))}
          </Svg>
        </View>
      );
    }
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

export type MobileModelBrandKind = 'claude' | 'codex' | null;

export function resolveMobileModelBrandKind({
  modelId,
  displayName,
  agentKind,
  fallbackProviderId,
}: {
  modelId: string;
  displayName?: string;
  agentKind: AgentKind | null;
  fallbackProviderId?: string | null;
}): MobileModelBrandKind {
  const brandText = `${modelId} ${displayName ?? ''}`.toLowerCase();
  if (
    /(^|[\s/])(?:codex|chatgpt|openai)(?:[\s/-]|$)/.test(brandText) ||
    /(^|[\s/])gpt[-\s]/.test(brandText)
  ) {
    return 'codex';
  }
  if (/(^|[\s/])(?:claude|opus|sonnet|haiku|fable)(?:[\s/-]|$)/.test(brandText)) {
    return 'claude';
  }
  if (fallbackProviderId === 'openai') return 'codex';
  if (fallbackProviderId === 'anthropic') return 'claude';
  if (agentKind === 'codex') return 'codex';
  if (agentKind === 'claude-code') return 'claude';
  return null;
}

export interface MobileModelBrandMarkProps {
  modelId: string;
  displayName?: string;
  agentKind: AgentKind | null;
  fallbackProviderId?: string | null;
  fallbackProviderName?: string;
  color?: string;
}

/** 模型品牌徽标:按 model id/displayName 优先解析 Claude/Codex,否则回落来源徽标。 */
export function MobileModelBrandMark({
  modelId,
  displayName,
  agentKind,
  fallbackProviderId,
  fallbackProviderName,
  color,
}: MobileModelBrandMarkProps) {
  const styles = useThemedStyles(makeStyles);
  const { colors } = useTheme();
  const fill = color ?? colors.textSecondary;
  const glyph = 13;
  const brandKind = resolveMobileModelBrandKind({
    modelId,
    displayName,
    agentKind,
    fallbackProviderId,
  });

  if (brandKind === 'claude') {
    return (
      <View accessible={false} style={styles.markBox}>
        <Svg width={glyph} height={glyph} viewBox="0 0 24 24">
          <Path d={CLAUDE_PATH} fill={fill} />
        </Svg>
      </View>
    );
  }
  if (brandKind === 'codex') {
    return (
      <View accessible={false} style={styles.markBox}>
        <Svg width={glyph} height={glyph} viewBox="0 0 24 24">
          <Path d={CODEX_PATH} fill={fill} />
        </Svg>
      </View>
    );
  }
  if (!fallbackProviderId) return null;
  return (
    <MobileProviderMark
      color={color}
      name={fallbackProviderName ?? fallbackProviderId}
      providerId={fallbackProviderId}
    />
  );
}
