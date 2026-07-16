import { describe, expect, it } from 'vitest';
import { spawnSync } from 'node:child_process';
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { delimiter, join, resolve } from 'node:path';

const scriptPath = resolve(process.cwd(), 'scripts/release-ios.sh');
const bashAvailable = spawnSync('bash', ['--version'], { encoding: 'utf8' }).status === 0;
const itWithBash = bashAvailable ? it : it.skip;
// Windows 上 `python3` 常是 Microsoft Store 的 App Execution Alias 假可执行
// (静默退出码 49、零输出),脚本内 JSON 解析会全体失败;此时在 binDir 架一个
// 转发到真实 `python` 的 shim(CI ubuntu 的 python3 可用,不会写 shim)。
const python3Works = spawnSync('python3', ['-c', 'print(1)'], { encoding: 'utf8' }).status === 0;

function writePython3ShimIfNeeded(binDir: string) {
  if (python3Works) return;
  const shimPath = join(binDir, 'python3');
  writeFileSync(shimPath, '#!/usr/bin/env bash\nexec python "$@"\n');
  chmodSync(shimPath, 0o755);
}

function runReleaseIos(
  args: string[],
  curlScript: string,
  extraEnv: Record<string, string> = {},
  { withCredentialsFile = true }: { withCredentialsFile?: boolean } = {},
) {
  const root = mkdtempSync(join(tmpdir(), 'xdt-release-ios-'));
  const configDir = join(root, 'config');
  const binDir = join(root, 'bin');
  const ipaPath = join(root, 'app.ipa');
  mkdirSync(configDir);
  mkdirSync(binDir);
  writeFileSync(ipaPath, 'fake ipa');
  if (withCredentialsFile) {
    writeFileSync(join(configDir, 'credentials.env'), [
      'NPKG_TOKEN=test-token',
      'NPKG_BASE_URL=https://npkg.example.com',
      '',
    ].join('\n'));
  }
  const curlPath = join(binDir, 'curl');
  writeFileSync(curlPath, `#!/usr/bin/env bash\nset -euo pipefail\n${curlScript}\n`);
  chmodSync(curlPath, 0o755);
  writePython3ShimIfNeeded(binDir);

  const result = spawnSync('bash', [scriptPath, ...args.map((arg) => (arg === '<ipa>' ? ipaPath : arg))], {
    cwd: process.cwd(),
    encoding: 'utf8',
    env: {
      ...process.env,
      NPKG_CONFIG_DIR: configDir,
      // PATH 分隔符必须按平台取(Windows 是 ';' 且路径自带 'C:'),硬编码 ':' 会
      // 让 Git Bash 解析不到 fake curl,直接漏到真实 curl / 轮询超时。
      PATH: `${binDir}${delimiter}${process.env.PATH ?? ''}`,
      ...extraEnv,
    },
  });
  rmSync(root, { recursive: true, force: true });
  return result;
}

describe('NPKG iOS distribution script safety gates', () => {
  it('filters from-eas build lookup by build profile before applying the result limit', () => {
    const source = readFileSync(scriptPath, 'utf8');
    expect(source).toContain('build:list --platform ios --status finished --build-profile "$profile" --limit 30');
  });

  it('from-eas 未显式设 NPKG_EXPECT_BUNDLE 时按 EAS 线身份(com.xd.lizcn)校验,不被自建线默认值误拒', () => {
    const source = readFileSync(scriptPath, 'utf8');
    expect(source).toContain('EAS_LINE_BUNDLE="com.xd.lizcn"');
    // fallback 必须发生在 cmd_from_eas 内部、且以"未显式设 NPKG_EXPECT_BUNDLE"为前提。
    expect(source).toMatch(/cmd_from_eas\(\)\{[\s\S]{0,600}?\[ -z "\$\{NPKG_EXPECT_BUNDLE:-\}" \][\s\S]{0,200}?EXPECT_BUNDLE="\$EAS_LINE_BUNDLE"/);
  });

  itWithBash('fails upload before emitting install links when bundle id is unexpected', () => {
    const result = runReleaseIos(['upload', '<ipa>'], `
echo '{"id":123,"package":"com.example.wrong"}'
`);

    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain('bundle id');
    expect(result.stderr).toContain('com.xd.cindycn');
    expect(result.stdout).not.toContain('/install/');
  });

  itWithBash('honors NPKG_EXPECT_BUNDLE override', () => {
    // 覆盖为历史 bundleId 后,上传默认 com.xd.cindycn 反而应被拒,且错误提示新期望值。
    const result = runReleaseIos(['upload', '<ipa>'], `
echo '{"id":123,"package":"com.xd.cindycn"}'
`, { NPKG_EXPECT_BUNDLE: 'com.xdtmaker.mobile' });

    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain('com.xdtmaker.mobile');
    expect(result.stdout).not.toContain('/install/');
  });

  itWithBash('accepts NPKG token via env without a credentials.env file', () => {
    // 无 credentials.env,仅靠环境变量传入 token/base:应过凭证加载、走到 bundle 校验(而非"缺 token"退出)。
    const result = runReleaseIos(['upload', '<ipa>'], `
echo '{"id":1,"package":"com.example.wrong"}'
`, { NPKG_TOKEN: 'env-token', NPKG_BASE_URL: 'https://npkg.example.com' }, { withCredentialsFile: false });

    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain('bundle id');
    expect(result.stdout).not.toContain('/install/');
  });

  itWithBash('fails resolve before emitting install links when enterprise signing team is unexpected', () => {
    const result = runReleaseIos(['resolve', '1'], `
last=""
for arg in "$@"; do last="$arg"; done
case "$last" in
  */api/v1/packages/1/) echo '{"enterprise":2}' ;;
  */api/v1/packages/2/) echo '{"package":"com.xd.cindycn","check_data":[{"name":"Team","result":"BADTEAM"}]}' ;;
  *) echo '{}' ;;
esac
`);

    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain('签名 Team');
    expect(result.stderr).toContain('UE5H8B62F9');
    expect(result.stdout).not.toContain('/install/');
  });
});
