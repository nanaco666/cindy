import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const commands = [
  ['dev:desktop',        '启动桌面端（本地 API）'],
  ['dev:desktop:remote', '启动桌面端（远程 API）'],
  ['dev:desktop:inspect','启动桌面端 + Chrome DevTools 内存分析'],
  ['build',              '打包桌面端'],
  ['release:mac',              'macOS 发布（arm64 + x64,默认进 canary 通道）'],
  ['release:mac:arm64',        'macOS 发布（仅 Apple Silicon,canary 通道）'],
  ['release:mac:x64',          'macOS 发布（仅 Intel,canary 通道）'],
  ['release:win',              'Windows 发布（默认进 canary 通道）'],
  ['release:promote:win',      'Windows: canary → stable（dry-run，加 --yes 执行）'],
  ['release:promote:mac',      'macOS: canary → stable，arm64 + x64（加 --yes 执行）'],
  ['release:promote:mac:arm64','macOS arm64 单独 promote（加 --yes 执行）'],
  ['release:promote:mac:x64',  'macOS x64 单独 promote（加 --yes 执行）'],
  ['release:claude-code',      'macOS Claude Code binary 发布（arm64 + x64）'],
  ['release:claude-code:arm64','macOS Claude Code binary 发布（仅 Apple Silicon）'],
  ['release:claude-code:x64',  'macOS Claude Code binary 发布（仅 Intel）'],
  ['release:claude-code:win',  'Windows Claude Code binary 发布'],
  ['release:codex',            'macOS Codex binary 发布（arm64 + x64）'],
  ['release:codex:arm64',      'macOS Codex binary 发布（仅 Apple Silicon）'],
  ['release:codex:x64',        'macOS Codex binary 发布（仅 Intel）'],
  ['release:codex:win',        'Windows Codex binary 发布'],
  ['update:claude',            '下载 @anthropic-ai/claude-code 各平台可执行文件'],
  ['update:codex',             '下载 openai/codex GitHub Release 各平台可执行文件'],
  ['update:vendors',           '一键更新 claude + codex（顺序执行）'],
  ['lint',               '全量 lint 检查'],
  ['format',             '全量代码格式化'],
  ['test:runner',        '项目级测试 runner 自测'],
  ['test:unit',          '项目级 unit 测试契约检查'],
  ['test:all',           '项目级全量测试契约检查（只运行 required tier）'],
  ['test:db',            '运行 desktop DB 测试入口'],
  ['test:guard',         '运行 desktop guard 源码结构契约测试'],
];

export function printHelp(log = console.log) {
  log('\n  Cindy 客户端仓可用指令\n');
  for (const [name, desc] of commands) {
    log(`  pnpm ${name.padEnd(28)} ${desc}`);
  }
  log('\n  release 可选参数:');
  log('    --require-relogin    强制用户更新后重新授权飞书 (release:win / release:mac 系列)');
  log('\n  灰度通道 (canary-release V0.1):');
  log('    所有 release:* 默认上传到 manifest-{platform}-canary.json');
  log('    只有 User.isCanary=true 的用户会拉到该 manifest');
  log('    验证 OK 后用 release:promote:* 把 canary 复制为 stable');
  log('    promote 默认 dry-run；加 --yes 才真正覆盖 stable manifest');
  log();
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  printHelp();
}
