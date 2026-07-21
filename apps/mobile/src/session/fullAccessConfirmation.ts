import { Alert, type AlertButton, type AlertOptions } from 'react-native';
import { requiresFullAccessConfirmation } from '@lizi/maker-shared/permission-mode';

type ShowAlert = (
  title: string,
  message?: string,
  buttons?: AlertButton[],
  options?: AlertOptions,
) => void;

/**
 * 手机端进入 Full access 的一次性确认。
 * 取消、系统 dismiss 或重复回调都保持原权限；不需要升级时直接放行。
 */
export function confirmFullAccessChange(
  currentMode: unknown,
  nextMode: unknown,
  showAlert: ShowAlert = Alert.alert,
): Promise<boolean> {
  if (!requiresFullAccessConfirmation(currentMode, nextMode)) {
    return Promise.resolve(true);
  }

  return new Promise((resolve) => {
    let settled = false;
    const finish = (confirmed: boolean) => {
      if (settled) return;
      settled = true;
      resolve(confirmed);
    };

    showAlert(
      '开启 Full access？',
      'Full access 会关闭工作区沙箱并跳过常规审批。Cindy 可以修改工作区外的文件、执行联网命令且不再询问；内置高风险操作仍会要求确认。',
      [
        { text: '保留当前权限', style: 'cancel', onPress: () => finish(false) },
        { text: '开启 Full access', style: 'destructive', onPress: () => finish(true) },
      ],
      { cancelable: true, onDismiss: () => finish(false) },
    );
  });
}
