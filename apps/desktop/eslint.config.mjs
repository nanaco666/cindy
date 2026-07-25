import js from '@eslint/js';
import tseslint from 'typescript-eslint';
import prettierConfig from 'eslint-config-prettier';

export default tseslint.config(
  js.configs.recommended,
  ...tseslint.configs.recommended,
  prettierConfig,
  {
    ignores: ['out/', '.vite/', 'dist/', 'src/main/third_party/', 'src/renderer/vendor/'],
  },
  {
    files: ['src/main/**/*.{ts,tsx}'],
    // watcher-host 是 utilityProcess 宿主(native watcher 崩溃隔离),与 localDb
    // 一样属于"进程边界基建",豁免 utilityProcess/worker_threads 导入限制。
    ignores: [
      'src/main/localDb/**/*.{ts,tsx}',
      'src/main/watcher-host/**/*.{ts,tsx}',
      'src/main/__spike__/**/*.{ts,tsx}',
    ],
    rules: {
      'no-restricted-imports': ['error', {
        paths: [
          {
            name: 'node:worker_threads',
            message: 'Use DbClient instead. Direct worker_threads breaks escape hatch.',
          },
          {
            name: 'worker_threads',
            message: 'Use DbClient instead. Direct worker_threads breaks escape hatch.',
          },
          {
            name: 'electron',
            importNames: ['utilityProcess'],
            message: 'Use DbClient instead. Direct utilityProcess breaks escape hatch.',
          },
        ],
      }],
    },
  },
);
