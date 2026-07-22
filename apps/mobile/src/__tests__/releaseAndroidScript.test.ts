import { describe, expect, it } from 'vitest';
import { spawnSync } from 'node:child_process';
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import {
  bashCommandWorks,
  resolveBashTestEnvironment,
  withBashTestBin,
} from './bashTestUtils';

const scriptPath = resolve(process.cwd(), 'scripts/release-android-npkg.sh');
const bashEnvironment = resolveBashTestEnvironment();
const itWithBash = bashEnvironment.available ? it : it.skip;
const bashTestTimeoutMs = 35_000;
// Windows 上 `python3` 常是 Microsoft Store 的 App Execution Alias 假可执行
// (静默退出码 49、零输出),脚本内 JSON 解析会全体失败;此时在 binDir 架一个
// 转发到真实 `python` 的 shim(CI ubuntu 的 python3 可用,不会写 shim)。
const python3Works = bashCommandWorks(bashEnvironment, 'python3 -c "print(1)"');

function writePython3ShimIfNeeded(binDir: string) {
  if (python3Works) return;
  const shimPath = join(binDir, 'python3');
  writeFileSync(shimPath, '#!/usr/bin/env bash\nexec python "$@"\n');
  chmodSync(shimPath, 0o755);
}

function runReleaseAndroid(
  args: string[],
  curlScript: string,
  extraEnv: Record<string, string> = {},
) {
  const root = mkdtempSync(join(tmpdir(), 'xdt-release-android-'));
  const configDir = join(root, 'config');
  const binDir = join(root, 'bin');
  const apkPath = join(root, 'app.apk');
  mkdirSync(configDir);
  mkdirSync(binDir);
  writeFileSync(apkPath, 'fake apk');
  writeFileSync(join(configDir, 'credentials.env'), ['NPKG_TOKEN=test-token', 'NPKG_BASE_URL=https://npkg.example.com', ''].join('\n'));
  const curlPath = join(binDir, 'curl');
  writeFileSync(curlPath, `#!/usr/bin/env bash\nset -euo pipefail\n${curlScript}\n`);
  chmodSync(curlPath, 0o755);
  writePython3ShimIfNeeded(binDir);

  const result = spawnSync(bashEnvironment.command, [
    bashEnvironment.toPath(scriptPath),
    ...args.map((arg) => (arg === '<apk>' ? bashEnvironment.toPath(apkPath) : arg)),
  ], {
    cwd: process.cwd(),
    encoding: 'utf8',
    // The helper restores fake tools after Git Bash rewrites PATH during startup.
    env: withBashTestBin(bashEnvironment, binDir, {
      ...process.env,
      NPKG_CONFIG_DIR: bashEnvironment.toPath(configDir),
      ...extraEnv,
    }),
    timeout: 30_000,
  });
  rmSync(root, { recursive: true, force: true });
  return result;
}

describe('NPKG Android distribution script', () => {
  it('from-eas 按 android 平台 + build profile 精确过滤', () => {
    const source = readFileSync(scriptPath, 'utf8');
    expect(source).toContain('build:list --platform android --status finished --build-profile "$profile" --limit 30');
  });

  it('不做企业重签:无企业子包轮询逻辑 / 无签名 Team 校验逻辑', () => {
    const source = readFileSync(scriptPath, 'utf8');
    // 断言"逻辑"而非注释里的词:iOS 脚本的企业签靠 poll_enterprise_child + check_data Team,
    // Android 脚本不应出现这些实际逻辑标记(comment 里为解释差异会提到 enterprise/UE5H8B62F9,不作断言)。
    expect(source).not.toContain('poll_enterprise');
    expect(source).not.toContain('check_data');
    expect(source).not.toMatch(/enterprise[^\n]*python3/); // 不解析 enterprise 子包字段
  });

  itWithBash('upload 后按父包 id 打印 install + 直下链接', () => {
    const result = runReleaseAndroid(['upload', '<apk>'], `
last=""; for arg in "$@"; do last="$arg"; done
case "$last" in
  */api/v1/packages/) echo '{"id":555,"package":"com.xd.cindycn"}' ;;
  */api/v1/packages/555/) echo '{"package":"com.xd.cindycn"}' ;;
  *) echo '{}' ;;
esac
`);
    expect(result.status).toBe(0);
    expect(result.stdout).toContain('/install/555');
    expect(result.stdout).toContain('/api/v1/packages/555/download/');
  }, bashTestTimeoutMs);

  itWithBash('package 不符预期 → 拒绝打印安装链接', () => {
    const result = runReleaseAndroid(['upload', '<apk>'], `
last=""; for arg in "$@"; do last="$arg"; done
case "$last" in
  */api/v1/packages/) echo '{"id":9,"package":"com.example.wrong"}' ;;
  */api/v1/packages/9/) echo '{"package":"com.example.wrong"}' ;;
  *) echo '{}' ;;
esac
`);
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain('com.xd.cindycn');
    expect(result.stdout).not.toContain('/install/');
  }, bashTestTimeoutMs);

  itWithBash('NPKG_EXPECT_PACKAGE 覆盖生效', () => {
    const result = runReleaseAndroid(['upload', '<apk>'], `
last=""; for arg in "$@"; do last="$arg"; done
case "$last" in
  */api/v1/packages/) echo '{"id":9,"package":"com.xd.cindycn"}' ;;
  */api/v1/packages/9/) echo '{"package":"com.xd.cindycn"}' ;;
  *) echo '{}' ;;
esac
`, { NPKG_EXPECT_PACKAGE: 'com.other.pkg' });
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain('com.other.pkg');
  }, bashTestTimeoutMs);
});
