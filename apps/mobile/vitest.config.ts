import { defineConfig } from 'vitest/config';
import { fileURLToPath } from 'node:url';

export default defineConfig({
  define: {
    // env.ts 顶层引用 __DEV__(metro 全局);vitest node 环境按 prod 语义跑
    // (端点初值只看显式 env,不 require 仓内 endpoint.json)。
    __DEV__: false,
  },
  plugins: [
    {
      // scripts/*.mjs 带 shebang(#!/usr/bin/env node)。vite-node 内联执行这类
      // 模块时不剥 hashbang,包进函数体后成非法 token,ciFingerprintScript.test.ts /
      // releaseLib.test.ts 在本地(Windows + Node 25 实测)整文件 SyntaxError;
      // CI(ubuntu + Node 22)不复现。与 apps/desktop/vitest.config.ts 同款修复:
      // transform 前把首行 shebang 置空(保留换行,行号不漂移,无需 sourcemap)。
      name: 'strip-hashbang',
      enforce: 'pre' as const,
      transform(code: string) {
        if (code.startsWith('#!')) return { code: code.replace(/^#![^\n]*/, ''), map: null };
        return null;
      },
    },
  ],
  resolve: {
    alias: {
      // 用 fileURLToPath 而非 URL.pathname:后者对非 ASCII 路径(如中文目录)
      // 返回百分号编码字符串,别名会指向不存在的磁盘路径。
      '@': fileURLToPath(new URL('./src', import.meta.url)),
      'expo-constants': fileURLToPath(new URL('./src/__tests__/expo-constants.mock.ts', import.meta.url)),
    },
  },
  test: {
    environment: 'node',
    env: {
      EXPO_PUBLIC_XDT_DEVICE_LINK_API_BASE_URL: 'https://relay.example.invalid',
      EXPO_PUBLIC_XDT_MOBILE_VOICE_LITELLM_BASE_URL: 'https://gateway.example.invalid',
    },
  },
});
