import { useEffect, useState } from 'react';
import { Keyboard, Platform } from 'react-native';

/**
 * 跟踪软键盘的可见性与高度。
 *
 * iOS 用 will 事件在动画开始前拿到目标高度，Android 只有 did 事件。
 * 从会话页提取的共享 hook，供需要按键盘高度计算可用空间的页面复用。
 */
export function useMobileKeyboardState(): { height: number; visible: boolean } {
  const [state, setState] = useState({ height: 0, visible: false });

  useEffect(() => {
    const showEvent = Platform.OS === 'ios' ? 'keyboardWillShow' : 'keyboardDidShow';
    const hideEvent = Platform.OS === 'ios' ? 'keyboardWillHide' : 'keyboardDidHide';
    const showSubscription = Keyboard.addListener(showEvent, (event) => {
      setState({
        height: event.endCoordinates?.height ?? 0,
        visible: true,
      });
    });
    const hideSubscription = Keyboard.addListener(hideEvent, () => {
      setState({ height: 0, visible: false });
    });
    return () => {
      showSubscription.remove();
      hideSubscription.remove();
    };
  }, []);

  return state;
}
