import { defineConfig } from 'vitest/config';

export default defineConfig({
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
      '@': new URL('./src', import.meta.url).pathname,
    },
  },
  test: {
    environment: 'node',
  },
});
