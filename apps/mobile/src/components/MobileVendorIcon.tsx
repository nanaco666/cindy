import { useEffect, useRef } from 'react';
import { Animated, Easing } from 'react-native';
import Svg, { Path } from 'react-native-svg';
import { useTheme } from '@/theme';

import { CLAUDE_PATH, CODEX_PATH } from './vendorIconPaths';

interface MobileVendorIconProps {
  color?: string;
  running?: boolean;
  size?: number;
  vendor: 'cc' | 'codex' | string;
}

export function MobileVendorIcon({ color: colorOverride, running = false, size = 12, vendor }: MobileVendorIconProps) {
  const { colors } = useTheme();
  const opacity = useRef(new Animated.Value(running ? 0.3 : 1)).current;
  const color = colorOverride ?? (running ? colors.statusAccent : colors.textTertiary);

  useEffect(() => {
    opacity.stopAnimation();
    if (!running) {
      opacity.setValue(1);
      return;
    }
    opacity.setValue(0.3);
    const loop = Animated.loop(
      Animated.sequence([
        Animated.timing(opacity, {
          duration: 750,
          easing: Easing.inOut(Easing.ease),
          toValue: 1,
          useNativeDriver: true,
        }),
        Animated.timing(opacity, {
          duration: 750,
          easing: Easing.inOut(Easing.ease),
          toValue: 0.3,
          useNativeDriver: true,
        }),
      ]),
    );
    loop.start();
    return () => {
      loop.stop();
    };
  }, [opacity, running]);

  // 2026-07-19 撤销 D4-1:恢复厂商 glyph(与 Mac 端 VendorIcon 同步)——
  // 箭头统一后依赖图标区分 agent 类型的场景全部失效。
  // 无障碍标签随厂商走:glyph 恢复区分后,读屏也要念对 agent 类型(review 收口)。
  const mark = (
    <Svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      accessibilityLabel={vendor === 'codex' ? 'Codex' : 'Claude'}
    >
      <Path d={vendor === 'codex' ? CODEX_PATH : CLAUDE_PATH} fill={color} />
    </Svg>
  );

  return (
    <Animated.View style={{ alignItems: 'center', height: size, justifyContent: 'center', opacity, width: size }}>
      {mark}
    </Animated.View>
  );
}
