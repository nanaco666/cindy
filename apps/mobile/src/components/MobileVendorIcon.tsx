import { useEffect, useRef } from 'react';
import { Animated, Easing } from 'react-native';
import Svg, { Path } from 'react-native-svg';
import { useTheme } from '@/theme';

import { BRAND_ARROW_PATH } from './vendorIconPaths';

interface MobileVendorIconProps {
  running?: boolean;
  size?: number;
  vendor: 'cc' | 'codex' | string;
}

export function MobileVendorIcon({ running = false, size = 12, vendor }: MobileVendorIconProps) {
  const { colors } = useTheme();
  const opacity = useRef(new Animated.Value(running ? 0.3 : 1)).current;
  const color = running ? colors.statusAccent : colors.textTertiary;

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

  // Mac D4-1:Claude/Codex 会话行首统一品牌箭头;vendor prop 保留给调用方兼容。
  void vendor;
  const mark = (
    <Svg width={size} height={size} viewBox="0 0 24 24" accessibilityLabel="CINDY">
      <Path d={BRAND_ARROW_PATH} fill={color} />
    </Svg>
  );

  return (
    <Animated.View style={{ alignItems: 'center', height: size, justifyContent: 'center', opacity, width: size }}>
      {mark}
    </Animated.View>
  );
}
