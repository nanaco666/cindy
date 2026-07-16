import { requireNativeModule } from 'expo-modules-core';

export interface FeishuAuthOptions {
  appId: string;
  state?: string;
}

export interface FeishuAuthCodeResult {
  code: string;
}

export interface XdtFeishuLoginModule {
  isFeishuAppInstalled(): Promise<boolean>;
  requestFeishuAuthCode(options: FeishuAuthOptions): Promise<FeishuAuthCodeResult>;
}

const nativeModule = requireNativeModule<XdtFeishuLoginModule>('XdtFeishuLogin');

export function isFeishuAppInstalled(): Promise<boolean> {
  return nativeModule.isFeishuAppInstalled();
}

export function requestFeishuAuthCode(options: FeishuAuthOptions): Promise<FeishuAuthCodeResult> {
  return nativeModule.requestFeishuAuthCode(options);
}
