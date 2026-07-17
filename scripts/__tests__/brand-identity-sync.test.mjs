// brand-identity-sync.test.mjs — 品牌标识符「TS 单点 ↔ .mjs 脚本镜像字面量」一致性断言。
//
// 背景:packages/maker-shared/src/brandIdentity.ts 是标识符层身份的单一事实源,
// 但发布 / CI / smoke / restart 等 .mjs 脚本无法 import TS,只能在各自文件顶部
// 镜像字面量(均带注释指回单点)。本测试用正则读 TS 源码抽出字面量,与各脚本的
// 镜像常量逐一比对——单点翻转后漏改任何一处镜像,这里立刻红灯。
//
// 刻意用「读源码 + 正则」而不 import 被测脚本:避免脚本模块顶层副作用
// (ali-oss / env 加载等),node --test 环境零依赖即可跑。

import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '../..');

function readSource(relPath) {
  return fs.readFileSync(path.join(ROOT, relPath), 'utf8');
}

/** 从源码里抽取形如 `<key>: '<value>'` 或 `const <key> = '<value>'` 的单引号字面量。 */
function extractLiteral(source, regex, label) {
  const match = regex.exec(source);
  assert.ok(match, `pattern not found: ${label} (${regex})`);
  return match[1];
}

const brandIdentitySource = readSource('packages/maker-shared/src/brandIdentity.ts');
const EXECUTABLE_NAME = extractLiteral(
  brandIdentitySource,
  /executableName:\s*'([^']+)'/,
  'brandIdentity.ts executableName',
);
const USER_DATA_DIR_NAME = extractLiteral(
  brandIdentitySource,
  /userDataDirName:\s*'([^']+)'/,
  'brandIdentity.ts userDataDirName',
);
// 区域派生值(2026-07-18 同机双装):从 ByRegion 块里抽 global 值,
// 供 .mjs 镜像(ci/lib.mjs / package-lib.mjs)一致性断言。
const EXECUTABLE_NAME_GLOBAL = extractLiteral(
  brandIdentitySource,
  /executableNameByRegion:\s*Object\.freeze\(\{[^}]*global:\s*'([^']+)'/,
  'brandIdentity.ts executableNameByRegion.global',
);
const CDN_PREFIX_GLOBAL = extractLiteral(
  brandIdentitySource,
  /cdnPrefixByRegion:\s*Object\.freeze\(\{[^}]*global:\s*'([^']+)'/,
  'brandIdentity.ts cdnPrefixByRegion.global',
);

test('ci/lib.mjs PACKAGED_APP_NAME mirrors brandIdentity.executableName', () => {
  const libSource = readSource('apps/desktop/scripts/ci/lib.mjs');
  const value = extractLiteral(
    libSource,
    /export const PACKAGED_APP_NAME = '([^']+)';/,
    'ci/lib.mjs PACKAGED_APP_NAME',
  );
  assert.equal(value, EXECUTABLE_NAME);
});

test('smoke-packaged.mjs PACKAGED_APP_NAME mirrors brandIdentity.executableName', () => {
  const smokeSource = readSource('apps/desktop/scripts/smoke-packaged.mjs');
  const value = extractLiteral(
    smokeSource,
    /const PACKAGED_APP_NAME = '([^']+)';/,
    'smoke-packaged.mjs PACKAGED_APP_NAME',
  );
  assert.equal(value, EXECUTABLE_NAME);
});

test('restart-desktop-remote.mjs BRAND_USER_DATA_DIR_NAME mirrors brandIdentity.userDataDirName', () => {
  const restartSource = readSource('scripts/restart-desktop-remote.mjs');
  const value = extractLiteral(
    restartSource,
    /export const BRAND_USER_DATA_DIR_NAME = '([^']+)';/,
    'restart-desktop-remote.mjs BRAND_USER_DATA_DIR_NAME',
  );
  assert.equal(value, USER_DATA_DIR_NAME);
});

test('ci/lib.mjs PACKAGED_APP_NAME_BY_REGION mirrors brandIdentity.executableNameByRegion', () => {
  const libSource = readSource('apps/desktop/scripts/ci/lib.mjs');
  const cnValue = extractLiteral(
    libSource,
    /PACKAGED_APP_NAME_BY_REGION = Object\.freeze\(\{[^}]*cn:\s*'([^']+)'/,
    'ci/lib.mjs PACKAGED_APP_NAME_BY_REGION.cn',
  );
  const globalValue = extractLiteral(
    libSource,
    /PACKAGED_APP_NAME_BY_REGION = Object\.freeze\(\{[^}]*global:\s*'([^']+)'/,
    'ci/lib.mjs PACKAGED_APP_NAME_BY_REGION.global',
  );
  assert.equal(cnValue, EXECUTABLE_NAME);
  assert.equal(globalValue, EXECUTABLE_NAME_GLOBAL);
});

test('package-lib.mjs ARTIFACT_PREFIX_BY_REGION mirrors brandIdentity.cdnPrefixByRegion', () => {
  const pkgLibSource = readSource('apps/desktop/scripts/ci/package-lib.mjs');
  const globalValue = extractLiteral(
    pkgLibSource,
    /ARTIFACT_PREFIX_BY_REGION = Object\.freeze\(\{[^}]*global:\s*'([^']+)'/,
    'package-lib.mjs ARTIFACT_PREFIX_BY_REGION.global',
  );
  assert.equal(globalValue, CDN_PREFIX_GLOBAL);
});

test('desktop package.json productName mirrors brandIdentity.userDataDirName', () => {
  // Electron userData 目录名默认派生自 productName;brandIdentity.userDataDirName
  // 的注释也声明二者同源——两边漂移会让主进程 <userData>-dev 沙箱与 restart 脚本
  // 的 XDT_USER_DATA_DIR 落在不同目录。
  const pkg = JSON.parse(readSource('apps/desktop/package.json'));
  assert.equal(pkg.productName, USER_DATA_DIR_NAME);
});
