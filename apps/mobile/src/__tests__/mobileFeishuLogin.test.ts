import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

describe('mobile Feishu login', () => {
  it('prefers native Feishu app login and falls back to browser OAuth', () => {
    const loginSource = readFileSync(resolve(process.cwd(), 'app/(auth)/login.tsx'), 'utf8');
    const authSource = readFileSync(resolve(process.cwd(), 'src/auth/AuthContext.tsx'), 'utf8');
    const nativeSource = readFileSync(resolve(process.cwd(), 'src/auth/feishuNativeLogin.ts'), 'utf8');

    const loginStart = loginSource.indexOf('const login = async () => {');
    const loginEnd = loginSource.indexOf('const localDevLogin', loginStart);
    const primaryLoginSource = loginSource.slice(loginStart, loginEnd);

    expect(primaryLoginSource).toContain('await auth.loginWithFeishu();');
    expect(loginSource).toContain('testID: "login.feishuButton"');
    expect(loginSource).not.toContain('react-native-webview');
    expect(loginSource).not.toContain('<WebView');
    expect(authSource).toContain('NATIVE_FEISHU_LOGIN_ENABLED && await isFeishuAppInstalled()');
    expect(authSource).toContain('isFeishuAppInstalled()');
    expect(authSource).toContain('import { AppState, Linking } from "react-native";');
    expect(authSource).toContain('const NATIVE_FEISHU_LOGIN_FOREGROUND_TIMEOUT_MS = 8 * 1000;');
    expect(authSource).toContain('function createNativeFeishuLoginTimeout()');
    expect(authSource).toContain('AppState.addEventListener("change"');
    expect(authSource).toContain('requestFeishuAuthCodeWithTimeout(FEISHU_APP_ID)');
    expect(authSource).toContain('requestFeishuAuthCode({ appId })');
    expect(authSource).toContain('native-feishu-login-timeout');
    // The server token exchange must be gated outside the native-detection catch so a login
    // failure surfaces instead of silently falling back to a second browser login.
    expect(authSource).toContain('if (nativeCode) {');
    expect(authSource).toContain('finishOAuthLoginWithCode(nativeCode, did, setToken, applyUser)');
    expect(authSource).toContain('`${MOBILE_OAUTH_STATE_PREFIX}${createState()}`');
    expect(authSource).toContain('WebBrowser.openAuthSessionAsync(request.authUrl, MOBILE_REDIRECT_URL)');
    expect(nativeSource).toContain("requireNativeModule<FeishuNativeLoginModule>('XdtFeishuLogin')");
  });

  it('completes OAuth on the lizcn://auth deep link when the app is re-opened', () => {
    const authSource = readFileSync(resolve(process.cwd(), 'src/auth/AuthContext.tsx'), 'utf8');

    // The OAuth page can't return into the WebView; it re-opens the https callback, the
    // server bounces it to lizcn://auth, iOS re-opens the app, and a global Linking handler
    // (warm via addEventListener + cold via getInitialURL) finishes the PKCE exchange.
    expect(authSource).toContain('import { AppState, Linking } from "react-native";');
    expect(authSource).toContain('Linking.addEventListener("url"');
    expect(authSource).toContain('Linking.getInitialURL()');
    expect(authSource).toContain('url.startsWith(MOBILE_REDIRECT_URL)');
    expect(authSource).toContain('completeOAuthCallback(url)');
  });
});
