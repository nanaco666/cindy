import { useEffect, useRef } from 'react';
import { Animated, Easing } from 'react-native';
import Svg, { Path } from 'react-native-svg';
import { useTheme } from '@/theme';

import { CLAUDE_PATH, CODEX_PATH } from './vendorIconPaths';

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

  const isCodex = vendor === 'codex';
  const mark = isCodex ? (
    <Svg width={size} height={size} viewBox="0 0 24 24" accessibilityLabel="Codex">
      <Path d={CODEX_PATH} fill={color} />
    </Svg>
  ) : (
    <Svg width={size} height={size} viewBox="0 0 24 24" accessibilityLabel="Claude">
      <Path d={CLAUDE_PATH} fill={color} />
    </Svg>
  );

  return (
    <Animated.View style={{ alignItems: 'center', height: size, justifyContent: 'center', opacity, width: size }}>
      {mark}
    </Animated.View>
  );
}
