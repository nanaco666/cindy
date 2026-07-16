import { Linking } from 'react-native';
import { requireNativeModule } from 'expo-modules-core';

export interface FeishuNativeAuthOptions {
  appId: string;
  state?: string;
}

export interface FeishuNativeAuthResult {
  code: string;
}

type FeishuNativeLoginModule = {
  isFeishuAppInstalled(): Promise<boolean>;
  requestFeishuAuthCode(options: FeishuNativeAuthOptions): Promise<FeishuNativeAuthResult>;
};

let nativeModule: FeishuNativeLoginModule | null | undefined;

export async function isFeishuAppInstalled(): Promise<boolean> {
  const module = getNativeModule();
  if (module) {
    return module.isFeishuAppInstalled().catch(() => false);
  }
  return Linking.canOpenURL('lark://ssoclient').catch(() => false);
}

export async function requestFeishuAuthCode(options: FeishuNativeAuthOptions): Promise<FeishuNativeAuthResult> {
  const module = getNativeModule();
  if (!module) throw new Error('当前移动包未包含飞书原生登录模块');
  return module.requestFeishuAuthCode(options);
}

export const __testing = {
  resetNativeBindingForTests: () => {
    nativeModule = undefined;
  },
};

function getNativeModule(): FeishuNativeLoginModule | null {
  if (nativeModule !== undefined) return nativeModule;
  try {
    nativeModule = requireNativeModule<FeishuNativeLoginModule>('XdtFeishuLogin');
  } catch {
    nativeModule = null;
  }
  return nativeModule ?? null;
}
