import assert from 'node:assert/strict';
import fs from 'node:fs';
import { test } from 'node:test';

import { resolveEasBuildProfileEnv } from '../check-endpoint-literals.mjs';

test('逐个解析实际 EAS build profile 的端点 env（含 extends）', () => {
  const endpoints = JSON.parse(
    fs.readFileSync(new URL('../../config/production-endpoints.json', import.meta.url), 'utf8'),
  );
  const eas = JSON.parse(
    fs.readFileSync(new URL('../../apps/mobile/eas.json', import.meta.url), 'utf8'),
  );

  for (const profileName of Object.keys(eas.build)) {
    const env = resolveEasBuildProfileEnv(eas.build, profileName);
    assert.equal(env.EXPO_PUBLIC_XDT_API_BASE_URL, endpoints.apiBaseUrl, profileName);
    assert.equal(
      env.EXPO_PUBLIC_XDT_DEVICE_LINK_API_BASE_URL,
      endpoints.deviceLinkApiBaseUrl,
      profileName,
    );
  }
  assert.equal(resolveEasBuildProfileEnv(eas.build, 'beta-dash').EXPO_PUBLIC_BETA_DEV, 'dash');
});

test('EAS extends 解析支持子级覆盖，并拒绝缺失父级与循环', () => {
  assert.deepEqual(
    resolveEasBuildProfileEnv(
      {
        base: { env: { A: 'base', B: 'base' } },
        child: { extends: 'base', env: { B: 'child' } },
      },
      'child',
    ),
    { A: 'base', B: 'child' },
  );
  assert.throws(
    () => resolveEasBuildProfileEnv({ child: { extends: 'missing' } }, 'child'),
    /不存在或格式非法/,
  );
  assert.throws(
    () => resolveEasBuildProfileEnv({ a: { extends: 'b' }, b: { extends: 'a' } }, 'a'),
    /extends 循环/,
  );
});
