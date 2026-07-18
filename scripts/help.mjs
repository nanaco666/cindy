import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const commands = [
  ['mobile:xcode',       '按 --region=cn|global 生成 iOS 工程、打开 Xcode并启动 Metro'],
  ['mobile:sim:rebuild', '重建并安装 Mobile 模拟器开发包'],
  ['mobile:sim:start',   '启动 Mobile Metro（支持 --region=cn|global）'],
  ['mobile:sim:whoami',  '查看 8081-8086 上的 Metro 分支归属'],
  ['mobile:release:check', '检查 EAS 正式服 / staging / Beta 应热更还是冷更'],
  ['mobile:release:beta',  '发布指定开发者的手机 Beta（默认 dry-run）'],
  ['mobile:release:prod',  '从 main 发布 EAS 正式服（默认 dry-run）'],
  ['mobile:release:ios:check', '检查自建 iOS 应热更还是冷更（必须指定 region）'],
  ['mobile:release:ios:local', '自建 iOS 完整冷更：打包、重签、上传并写 release.json'],
  ['mobile:release:ios:ota',   '发布自建 iOS OTA（必须指定 region）'],
  ['mobile:release:ios:npkg',  'iOS NPKG 上传 / 查询 / 下载运维入口'],
  ['mobile:release:android:check', '检查自建 Android 应热更还是冷更（必须指定 region）'],
  ['mobile:release:android:local', '自建 Android 完整冷更：打包、上传并写 release.json'],
  ['mobile:release:android:ota',   '发布自建 Android OTA（必须指定 region）'],
  ['mobile:release:android:npkg',  'Android APK 手动补传 NPKG 入口'],
  ['mobile:beta:add-dev', '新增 per-dev Beta profile / channel / branch'],
  ['dev:desktop',        '启动桌面端（本地 API）'],
  ['dev:desktop:remote', '启动桌面端（远程 API）'],
  ['dev:desktop:inspect','启动桌面端 + Chrome DevTools 内存分析'],
  ['restart:desktop:remote', '重启桌面端远程模式（支持 --region=cn|global）'],
  ['restart:desktop:local',  '重启桌面端本地模式（支持 --region=cn|global）'],
  ['build',              '打包桌面端（electron-forge make 裸调,human-only）'],
  ['package:desktop',          '桌面端打包（当前平台,默认版本无关 + cn + dev,不发布）'],
  ['package:win',              'Windows x64 打包（同上,只打包不发布）'],
  ['package:mac:arm64',        'macOS Apple Silicon 打包（只打包不发布）'],
  ['package:mac:x64',          'macOS Intel 打包（只打包不发布）'],
  ['package:linux',            'Linux x64 打包（只打包不发布）'],
  ['release:mac',              'macOS 发布（arm64 + x64,默认进 canary 通道）'],
  ['release:mac:arm64',        'macOS 发布（仅 Apple Silicon,canary 通道）'],
  ['release:mac:x64',          'macOS 发布（仅 Intel,canary 通道）'],
  ['release:win',              'Windows 发布（默认进 canary 通道）'],
  ['release:linux',            'Linux x64 发布（默认进 canary 通道）'],
  ['release:promote:win',      'Windows: canary → stable（dry-run，加 --yes 执行）'],
  ['release:promote:mac',      'macOS: canary → stable，arm64 + x64（加 --yes 执行）'],
  ['release:promote:mac:arm64','macOS arm64 单独 promote（加 --yes 执行）'],
  ['release:promote:mac:x64',  'macOS x64 单独 promote（加 --yes 执行）'],
  ['release:promote:linux',    'Linux: canary → stable（dry-run，加 --yes 执行）'],
  ['release:claude-code',      'macOS Claude Code binary 发布（arm64 + x64）'],
  ['release:claude-code:arm64','macOS Claude Code binary 发布（仅 Apple Silicon）'],
  ['release:claude-code:x64',  'macOS Claude Code binary 发布（仅 Intel）'],
  ['release:claude-code:win',  'Windows Claude Code binary 发布'],
  ['release:codex',            'macOS Codex binary 发布（arm64 + x64）'],
  ['release:codex:arm64',      'macOS Codex binary 发布（仅 Apple Silicon）'],
  ['release:codex:x64',        'macOS Codex binary 发布（仅 Intel）'],
  ['release:codex:win',        'Windows Codex binary 发布'],
  ['release:ripgrep',          'macOS ripgrep binary 发布（arm64 + x64）'],
  ['release:ripgrep:arm64',    'macOS ripgrep binary 发布（仅 Apple Silicon）'],
  ['release:ripgrep:x64',      'macOS ripgrep binary 发布（仅 Intel）'],
  ['release:ripgrep:win',      'Windows ripgrep binary 发布'],
  ['update:claude',            '下载 @anthropic-ai/claude-code 各平台可执行文件'],
  ['update:codex',             '下载 openai/codex GitHub Release 各平台可执行文件'],
  ['update:ripgrep',           '下载 BurntSushi/ripgrep 各平台可执行文件'],
  ['update:vendors',           '一键更新 claude + codex + ripgrep（顺序执行）'],
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

  log('\n  桌面端启动（以下命令可直接复制）:');
  log('    # 推荐：先清理已有 Cindy dev 进程，再启动远程 API 模式');
  log('    pnpm restart:desktop:remote --region=cn');
  log('      国内版，读取仓内 config/endpoint.json');
  log('    pnpm restart:desktop:remote --region=global');
  log('      海外版，读取仓内 config/endpoint.global.json');
  log('    pnpm restart:desktop:remote --region=global --endpoints-cdn');
  log('      海外版，读取对应区域的线上 CDN 端点清单');
  log('    # Human 可直接启动；不会先清旧进程，Agent 不要使用');
  log('    pnpm dev:desktop:remote --region=cn');
  log('    pnpm dev:desktop:remote --region=global');
  log('    # 连接本地 http://localhost:3333（只起客户端，不起 server）');
  log('    pnpm restart:desktop:local --region=cn');

  log('\n  桌面端只打包、不上传 OSS/CDN（以下命令可直接复制）:');
  log('    pnpm package:desktop -- --region cn --channel dev');
  log('      当前平台，国内版，版本无关开发包');
  log('    pnpm package:desktop -- --region global --channel dev');
  log('      当前平台，海外版，版本无关开发包');
  log('    pnpm package:mac:arm64 -- --region cn --channel dev');
  log('    pnpm package:mac:x64 -- --region cn --channel dev');
  log('    pnpm package:win -- --region cn --channel dev');
  log('    pnpm package:linux -- --region cn --channel dev');
  log('    pnpm package:desktop -- --region cn --channel release --version patch');
  log('      当前平台，国内 release 包；基于 CDN 当前版本自动 bump patch');
  log('    pnpm package:desktop -- --region global --channel release --version patch');
  log('      当前平台，海外 release 包；基于 CDN 当前版本自动 bump patch');
  log('    # 调试时可在末尾追加 --skip-smoke；明确允许无签名时追加 --allow-unsigned');

  log('\n  桌面端旧版打包 + 发布一体流程（直接上传 canary）:');
  log('    pnpm release:mac');
  log('    pnpm release:win');
  log('    pnpm release:linux');
  log('    # 强制用户更新后重新授权飞书');
  log('    pnpm release:mac -- --require-relogin');
  log('    pnpm release:win -- --require-relogin');
  log('    # canary 验证后转 stable：先 dry-run，再正式执行');
  log('    pnpm release:promote:mac');
  log('    pnpm release:promote:mac -- --yes');
  log('    pnpm release:promote:win');
  log('    pnpm release:promote:win -- --yes');
  log('    pnpm release:promote:linux');
  log('    pnpm release:promote:linux -- --yes');

  log('\n  Mobile 本地开发（以下命令可直接复制）:');
  log('    pnpm mobile:xcode');
  log('      国服：生成 iOS 工程、打开 Xcode 并启动 Metro');
  log('    pnpm mobile:xcode --region=global');
  log('      海外版：生成 iOS 工程、打开 Xcode 并启动 Metro');
  log('    pnpm mobile:sim:rebuild');
  log('    pnpm mobile:sim:start');
  log('      国服模拟器：先 rebuild 安装，再 start 启动 Metro');
  log('    pnpm mobile:sim:rebuild -- --region=global');
  log('    pnpm mobile:sim:start -- --region=global');
  log('      海外模拟器：先 rebuild 安装，再 start 启动 Metro');
  log('    pnpm mobile:sim:whoami');
  log('      查看当前 Metro 对应的 checkout / branch');

  log('\n  Mobile EAS / TestFlight（默认 dry-run，--execute 才真正发布）:');
  log('    pnpm mobile:release:check -- --target production');
  log('      检查正式服应走 OTA 还是完整冷更');
  log('    pnpm mobile:release:check -- --target staging');
  log('      检查内部 staging 应走 OTA 还是完整冷更');
  log('    pnpm mobile:release:check -- --target beta --dev dash');
  log('      检查 dash 的手机 Beta 应走 OTA 还是完整冷更');
  log('    pnpm mobile:release:beta -- --dev dash --message "验证本次改动"');
  log('      手机 Beta dry-run');
  log('    pnpm mobile:release:beta -- --dev dash --message "验证本次改动" --execute');
  log('      手机 Beta 正式执行');
  log('    pnpm mobile:release:prod -- --message "发布本次改动"');
  log('      production + staging dry-run（必须在干净且已同步 origin/main 的 main 上）');
  log('    pnpm mobile:release:prod -- --message "发布本次改动" --execute');
  log('      production + staging 正式执行');
  log('    pnpm mobile:beta:add-dev -- alice');
  log('    pnpm mobile:beta:add-dev -- alice --execute');
  log('      新增 alice 的 Beta 配置：先 dry-run，再正式执行');

  log('\n  Mobile 自建 iOS（完整命令；region 必填，无默认值）:');
  log('    pnpm mobile:release:ios:check -- --region cn');
  log('    pnpm mobile:release:ios:local -- --region cn --execute');
  log('    pnpm mobile:release:ios:ota -- --region cn --execute');
  log('      国服：依次对应检查、完整冷更打包发布、JS OTA');
  log('    pnpm mobile:release:ios:check -- --region global');
  log('    pnpm mobile:release:ios:local -- --region global --execute');
  log('    pnpm mobile:release:ios:ota -- --region global --execute');
  log('      海外版：依次对应检查、完整冷更打包发布、JS OTA');
  log('    pnpm mobile:release:ios:npkg -- from-eas');
  log('      手动把最近一次 EAS iOS 产物送 NPKG 重签');

  log('\n  Mobile 自建 Android（完整命令；region 必填，无默认值）:');
  log('    pnpm mobile:release:android:check -- --region cn');
  log('    pnpm mobile:release:android:local -- --region cn --execute');
  log('    pnpm mobile:release:android:ota -- --region cn --execute');
  log('      国服：依次对应检查、完整冷更打包发布、JS OTA');
  log('    pnpm mobile:release:android:check -- --region global');
  log('    pnpm mobile:release:android:local -- --region global --execute');
  log('    pnpm mobile:release:android:ota -- --region global --execute');
  log('      海外版：依次对应检查、完整冷更打包发布、JS OTA');
  log('    pnpm mobile:release:android:npkg -- upload /absolute/path/Cindy.apk');
  log('      仅在需要时手动补传 APK 到 NPKG，不参与正常冷更链路');
  log();
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  printHelp();
}
