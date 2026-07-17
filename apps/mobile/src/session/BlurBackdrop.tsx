/**
 * BlurBackdrop —— 毛玻璃背板(expo-blur BlurView + surfaceTranslucentSidebar tint 叠层)。
 *
 * 用于 sheet/modal 的 backdrop(应用内互透毛玻璃,不追求透出主屏壁纸——iOS 不可能,
 * 用户已知悉)。R1 audit 模式1:blur≈50 等效,dark #120F0F@0.85 / light #F6F6F6@0.90。
 *
 * 设计:
 *   - BlurView 提供实时模糊(iOS vibrancy / Android 原生 fallback);
 *   - 叠一层 surfaceTranslucentSidebar 半透明底色,即便 Android 模糊弱化也能保证玻璃底色;
 *   - pointerEvents="none":触摸穿透到上层 Pressable(背板点按关闭),本组件纯视觉。
 *
 * 范围边界(E4M,lead 裁决):
 *   - 仅用于静态 backdrop(modal scrim / 抽屉背板),不用于滚动 sheet surface(规避 Android 热路径);
 *   - session chrome / composer 刻意不用本件(守护测试 sessionHeaderDesktopFirst /
 *     sessionComposerDesktopFirst 显式禁 BlurView,走 solid surfaceTranslucent)。
 *   - ImageLightbox 保持纯黑背板(媒体查看器惯例),不用本件。
 */
import type { ReactNode } from 'react';
import { BlurView } from 'expo-blur';
import { StyleSheet, View, type StyleProp, type ViewStyle } from 'react-native';
import { useTheme } from '@/theme';

export interface BlurBackdropProps {
  /** iOS BlurView intensity(R1 模式1 ≈ 50;模式3 浮层可传更低)。默认 50。 */
  intensity?: number;
  children?: ReactNode;
  style?: StyleProp<ViewStyle>;
}

export function BlurBackdrop({ intensity = 50, children, style }: BlurBackdropProps) {
  const { mode, colors } = useTheme();
  return (
    <View pointerEvents="none" style={[StyleSheet.absoluteFill, style]}>
      <BlurView intensity={intensity} tint={mode === 'dark' ? 'dark' : 'light'} style={StyleSheet.absoluteFill} />
      <View style={[StyleSheet.absoluteFill, { backgroundColor: colors.surfaceTranslucentSidebar }]} />
      {children}
    </View>
  );
}
