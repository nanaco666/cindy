import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { describe, expect, it } from 'vitest';

const locales = ['zh-CN', 'en', 'ja', 'ko'] as const;

function readLocale(locale: (typeof locales)[number]) {
  return JSON.parse(
    readFileSync(resolve(__dirname, '..', 'i18n', 'locales', locale, 'common.json'), 'utf8'),
  ) as {
    newChat?: {
      collaboration?: {
        startFailed?: unknown;
        startFailedContinue?: unknown;
        errors?: Record<string, unknown>;
      };
    };
  };
}

describe('collaboration error i18n', () => {
  it('keeps collaboration start error keys translated in every supported locale', () => {
    for (const locale of locales) {
      const collaboration = readLocale(locale).newChat?.collaboration;

      expect(collaboration?.startFailed, locale).toEqual(expect.any(String));
      expect(collaboration?.startFailedContinue, locale).toEqual(expect.any(String));
      expect(collaboration?.errors?.BUDGET_MODEL_REQUIRES_API_MODE, locale).toEqual(expect.any(String));
      expect(collaboration?.errors?.BUDGET_MODEL_REQUIRES_API_MODE_CONTINUE, locale).toEqual(expect.any(String));
    }
  });
});
