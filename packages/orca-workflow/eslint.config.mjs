import js from '@eslint/js';
import tseslint from 'typescript-eslint';

export default tseslint.config(
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    ignores: ['dist/'],
  },
  {
    rules: {
      'no-restricted-imports': [
        'error',
        {
          patterns: [
            {
              group: ['electron', 'electron/*', 'electron-*'],
              message: '@fmfsaisai/orca-workflow must not depend on Electron. Host capabilities should be injected by apps/desktop.',
            },
            {
              group: ['apps/*', '../apps/*', '../../apps/*', '../../../apps/*'],
              message: '@fmfsaisai/orca-workflow must not import desktop app modules directly. Use dependency injection at registration points.',
            },
          ],
        },
      ],
    },
  },
);
