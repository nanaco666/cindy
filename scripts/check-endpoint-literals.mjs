#!/usr/bin/env node
/**
 * check-endpoint-literals.mjs — 端点收敛门禁(2026-07 引入,配套 config/production-endpoints.json)。
 *
 * 两件事:
 *  1. 域名白名单扫描:受控域名(自家部署域名 + 已收敛的第三方端点)只允许出现在
 *     指定的「端点单点定义」文件里;其它位置出现字面量即报错。目的是防止收敛后的
 *     端点重新散落——新增消费方请 import 对应常量,确需新增定义点则把文件路径加进
 *     下方 MONITORED 的 allow 列表(并在 PR 里说明理由)。
 *  2. 一致性校验:config/production-endpoints.json 是生产域名权威源,但部分消费方
 *     无法在运行/构建期动态读取(eas.json、desktop/mobile 的 TS 常量)。
 *     这里校验它们的值与 JSON 一致,不一致列出待同步位置。
 *
 * 用法:node scripts/check-endpoint-literals.mjs(仓库任意位置执行均可;CI 在
 * typecheck job 中运行)。退出码非 0 = 有违规。
 *
 * 扫描说明:基于 git ls-files(只查已跟踪文件);测试代码**在扫描范围内**(2026-07 起,
 * 测试断言产品默认值时同样必须 import 端点常量,纯 fixture 请用 example.com 系假域名);
 * 文档(docs/ / *.md)、vendored 代码、构建产物副本(release/dist)、生成代码、
 * builtin-ghosts(自包含意识包)不在扫描范围;以 // * # <!-- 开头的注释行跳过。
 */

import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const ENDPOINTS_JSON = 'config/production-endpoints.json';

// ── 受控域名 → 允许出现的文件(精确路径或以 / 结尾的目录前缀) ────────────────
const MONITORED = [
  {
    pattern: 'llm-proxy.tapsvc.com',
    allow: [
      ENDPOINTS_JSON,
      'apps/desktop/src/shared/endpoints.ts',
      'apps/mobile/src/config/env.ts',
      'packages/embedding-client/src/client.ts',
      'packages/model-providers/catalog/providers.json',
    ],
  },
  {
    pattern: 'xdt-api.magiclizi.com',
    allow: [
      ENDPOINTS_JSON,
      'apps/mobile/src/config/env.ts',
      'apps/mobile/eas.json',
      'apps/mobile/app/(auth)/login.tsx', // UI placeholder 示例文案
    ],
  },
  {
    pattern: 'xdmaker-device-link.magiclizi.com',
    allow: [
      ENDPOINTS_JSON,
      'apps/mobile/src/config/env.ts',
      'apps/mobile/eas.json',
    ],
  },
  {
    pattern: 'xdmaker-oauth.magiclizi.com',
    allow: [
      ENDPOINTS_JSON,
    ],
  },
  {
    pattern: 'xdt-heartbreak.magiclizi.com',
    allow: [ENDPOINTS_JSON, 'apps/desktop/src/shared/endpoints.ts'],
  },
  {
    pattern: 'xdmaker-slack-hook.magiclizi.com',
    allow: [
      ENDPOINTS_JSON,
      'apps/desktop/src/shared/hookControlIpc.ts',
      // 测试断言 install URL 推导结果, 字面量是断言期望值
      'apps/desktop/src/shared/__tests__/hookControlIpc.test.ts',
    ],
  },
  {
    pattern: 'dev-cdn.fp.xd.com',
    allow: [
      ENDPOINTS_JSON,
      'apps/desktop/src/shared/endpoints.ts',
    ],
  },
  {
    pattern: 'xdtown-static-maker.xdcdn.cn',
    allow: [ENDPOINTS_JSON, 'apps/desktop/src/shared/endpoints.ts', 'apps/desktop/scripts/ci/lib.mjs'],
  },
  {
    pattern: 'npkg.xindong.com',
    allow: [
      ENDPOINTS_JSON,
      'apps/mobile/scripts/release-android-npkg.sh',
      'apps/desktop/scripts/npkg-sign.sh',
      'apps/desktop/scripts/sign.py',
      'apps/mobile/scripts/release-ios.sh',
    ],
  },
  {
    pattern: 'auth.atlassian.com',
    allow: [],
  },
  {
    // OpenAPI 端点前缀;open.feishu.cn 的文档/控制台外链不受控(不带 /open-apis)
    pattern: 'open.feishu.cn/open-apis',
    allow: [],
  },
  {
    pattern: 'accounts.feishu.cn',
    allow: [
      'apps/desktop/src/main/authManager.ts',
      'apps/mobile/src/auth/AuthContext.tsx',
      'packages/lizi-im/src/feishu/appRegistration.ts',
    ],
  },
  {
    pattern: 'e.tapdb.com',
    allow: ['apps/desktop/src/shared/endpoints.ts', 'apps/desktop/src/main/security/csp.ts'],
  },
  {
    pattern: 'se.tapdb.net',
    allow: [],
  },
  {
    pattern: 'slack.com/api/',
    allow: [
      // 这些测试验证 Slack auth.test 身份展示协议，允许使用固定第三方端点。
      'apps/desktop/src/main/cindy-brain/__tests__/ghostOauthFlow.test.ts',
      'apps/desktop/src/shared/__tests__/ghost.test.ts',
    ],
  },
  { pattern: 'slack.com/openid/', allow: [] },
  {
    // 发布用阿里云 OSS bucket 名:单点在 scripts/shared/oss.mjs(XDT_OSS_BUCKET 可覆盖)
    pattern: 'smash-dev',
    allow: ['scripts/shared/oss.mjs'],
  },
  {
    // 内部 GitLab 域名:desktop 单点在 shared/endpoints.ts;gitlab-client 只收配置不硬编码
    pattern: 'git.xindong.com',
    allow: ['apps/desktop/src/shared/endpoints.ts'],
  },
  {
    // 飞书文档跳转链接 base(bare domain,区别于 open.feishu.cn API):单点在 docLinks.ts
    pattern: 'https://feishu.cn/',
    allow: ['packages/lizi-mcps/src/feishu/docLinks.ts'],
  },
  {
    pattern: 'meetings.feishu.cn',
    allow: ['packages/lizi-mcps/src/feishu/docLinks.ts'],
  },
];

// ── 一致性校验:JSON 权威值 ↔ 无法动态读取的消费方 ───────────────────────────
// 每条:file + 该文件里必须包含的、由权威值拼出的字符串。
function buildConsistencyChecks(ep) {
  return [
    { file: 'apps/desktop/src/shared/endpoints.ts', mustContain: `'${ep.xdGatewayBaseUrl}'`, what: 'XD_GATEWAY_BASE_URL' },
    { file: 'apps/desktop/src/shared/endpoints.ts', mustContain: `'${ep.heartbeatUrl}'`, what: 'HEARTBEAT_DEFAULT_ENDPOINT' },
    { file: 'apps/desktop/src/shared/endpoints.ts', mustContain: `'${ep.cdnBaseUrl}'`, what: 'CDN_EXTERNAL_BASE_URL' },
    { file: 'apps/desktop/src/shared/endpoints.ts', mustContain: `'${ep.cdnInternalBaseUrl}'`, what: 'CDN_INTERNAL_BASE_URL' },
    { file: 'apps/desktop/src/shared/hookControlIpc.ts', mustContain: `'${ep.slackHookWsUrl}'`, what: 'SLACK_HOOK_DEFAULT_URL' },
    { file: 'apps/mobile/src/config/env.ts', mustContain: `'${ep.apiBaseUrl}'`, what: 'DEFAULT_API_BASE_URL' },
    { file: 'apps/mobile/src/config/env.ts', mustContain: `'${ep.deviceLinkApiBaseUrl}'`, what: 'DEFAULT_DEVICE_LINK_API_BASE_URL' },
    { file: 'apps/mobile/src/config/env.ts', mustContain: `'${ep.xdGatewayBaseUrl}'`, what: 'DEFAULT_MOBILE_VOICE_LITELLM_BASE_URL' },
    {
      file: 'packages/embedding-client/src/client.ts',
      mustContain: `const DEFAULT_BASE_URL = '${ep.xdGatewayBaseUrl}';`,
      what: 'EmbeddingClient DEFAULT_BASE_URL',
    },
    // model-providers 内置 catalog 是路由上游的单点定义;xd 网关值必须与权威源一致
    // (source-registry 测试断言的是 catalog 自身值,内容回归靠这条门禁)
    { file: 'packages/model-providers/catalog/providers.json', mustContain: `"${ep.xdGatewayBaseUrl}"`, what: 'xd provider 网关 upstream' },
    { file: 'packages/model-providers/catalog/providers.json', mustContain: `"${ep.xdGatewayBaseUrl}/v1"`, what: 'xd provider codex 网关 upstream' },
    // shell 脚本无法 import JS 权威源,NPKG_BASE_URL 默认值靠一致性校验兜底
    { file: 'apps/mobile/scripts/release-android-npkg.sh', mustContain: `NPKG_BASE_URL:=${ep.npkgBaseUrl}`, what: 'NPKG_BASE_URL 默认值' },
    { file: 'apps/mobile/scripts/release-ios.sh', mustContain: `NPKG_BASE_URL:=${ep.npkgBaseUrl}`, what: 'NPKG_BASE_URL 默认值' },
  ];
}

/**
 * 解析单个 EAS build profile 的最终 env（含 extends 链）。
 * EAS 的子 profile env 覆盖父 profile；缺父级与循环继承都视为门禁配置错误。
 */
export function resolveEasBuildProfileEnv(buildProfiles, profileName, stack = []) {
  const profile = buildProfiles?.[profileName];
  if (!profile || typeof profile !== 'object' || Array.isArray(profile)) {
    throw new Error(`EAS build profile 不存在或格式非法: ${profileName}`);
  }
  if (stack.includes(profileName)) {
    throw new Error(`EAS build profile extends 循环: ${[...stack, profileName].join(' -> ')}`);
  }

  let inheritedEnv = {};
  if (profile.extends != null) {
    if (typeof profile.extends !== 'string' || profile.extends.length === 0) {
      throw new Error(`EAS build profile ${profileName} 的 extends 必须是非空字符串`);
    }
    inheritedEnv = resolveEasBuildProfileEnv(buildProfiles, profile.extends, [...stack, profileName]);
  }

  const ownEnv = profile.env ?? {};
  if (!ownEnv || typeof ownEnv !== 'object' || Array.isArray(ownEnv)) {
    throw new Error(`EAS build profile ${profileName} 的 env 必须是对象`);
  }
  return { ...inheritedEnv, ...ownEnv };
}

/** 结构化消费方校验：不能用“一处包含即可”的字符串检查替代逐项验证。 */
function buildStructuredConsistencyChecks(ep) {
  const inconsistencies = [];

  const easFile = 'apps/mobile/eas.json';
  try {
    const eas = JSON.parse(fs.readFileSync(path.join(REPO_ROOT, easFile), 'utf8'));
    const buildProfiles = eas?.build;
    if (!buildProfiles || typeof buildProfiles !== 'object' || Array.isArray(buildProfiles)) {
      throw new Error('build 必须是对象');
    }
    const expectedEnv = {
      EXPO_PUBLIC_XDT_API_BASE_URL: ep.apiBaseUrl,
      EXPO_PUBLIC_XDT_DEVICE_LINK_API_BASE_URL: ep.deviceLinkApiBaseUrl,
    };
    for (const profileName of Object.keys(buildProfiles)) {
      const env = resolveEasBuildProfileEnv(buildProfiles, profileName);
      for (const [key, expected] of Object.entries(expectedEnv)) {
        if (env[key] !== expected) {
          inconsistencies.push({
            file: easFile,
            what: `build.${profileName}.env.${key}`,
            reason: `期望 ${expected}，实际 ${env[key] ?? '(缺失)'}`,
          });
        }
      }
    }
  } catch (error) {
    inconsistencies.push({
      file: easFile,
      what: 'EAS build profiles 解析',
      reason: error instanceof Error ? error.message : String(error),
    });
  }

  let expectedNpkgOrigin;
  try {
    expectedNpkgOrigin = new URL(ep.npkgBaseUrl).origin;
  } catch {
    inconsistencies.push({
      file: ENDPOINTS_JSON,
      what: 'npkgBaseUrl',
      reason: `不是合法绝对 URL: ${ep.npkgBaseUrl}`,
    });
    return inconsistencies;
  }

  for (const file of ['apps/desktop/scripts/sign.py', 'apps/desktop/scripts/npkg-sign.sh']) {
    try {
      const content = fs.readFileSync(path.join(REPO_ROOT, file), 'utf8');
      const origins = [...content.matchAll(/https?:\/\/[A-Za-z0-9.-]+(?::\d+)?/g)].map((match) => match[0]);
      if (origins.length === 0) {
        inconsistencies.push({ file, what: 'NPKG endpoint', reason: '未找到任何绝对 URL' });
        continue;
      }
      const mismatched = [...new Set(origins.filter((origin) => origin !== expectedNpkgOrigin))];
      if (mismatched.length > 0) {
        inconsistencies.push({
          file,
          what: '所有 NPKG URL origin',
          reason: `期望全部为 ${expectedNpkgOrigin}，发现 ${mismatched.join(', ')}`,
        });
      }
    } catch {
      inconsistencies.push({ file, what: 'NPKG endpoint', reason: '文件不存在或无法读取' });
    }
  }

  return inconsistencies;
}

// ── 扫描排除(路径统一为 / 分隔) ─────────────────────────────────────────────
const EXCLUDE_DIR_PARTS = [
  '/__pycache__/',
  '/release/dist/',
  '/_generated/',
  '/generated/',
  '/vendor/',
  'node_modules/',
];
const EXCLUDE_PREFIXES = [
  'docs/',
  'agent-use/',
  '.xdmaker/',
  'packages/browser-control-runtime/',
  'apps/desktop/resources/builtin-ghosts/',
  'scripts/check-endpoint-literals.mjs', // 本脚本自身(pattern 定义)
];
const EXCLUDE_SUFFIXES = ['.md', '.lock', '.png', '.jpg', '.ico', '.icns', '.gz', '.zip', '.pdf', '.svg', '.woff', '.woff2', '.pyc'];
const EXCLUDE_FILES = ['pnpm-lock.yaml', 'THIRD-PARTY-NOTICES.txt'];

function isExcluded(file) {
  if (EXCLUDE_FILES.includes(path.basename(file))) return true;
  if (EXCLUDE_PREFIXES.some((p) => file.startsWith(p))) return true;
  if (EXCLUDE_DIR_PARTS.some((p) => file.includes(p))) return true;
  if (EXCLUDE_SUFFIXES.some((s) => file.endsWith(s))) return true;
  if (file.startsWith('tools/') && file.endsWith('latest.json')) return true;
  return false;
}

function isAllowed(file, allow) {
  return allow.some((a) => (a.endsWith('/') ? file.startsWith(a) : file === a));
}

// 注释行启发式:行首(去缩进)是 //、*、/*、#、<!-- 即视为注释,跳过。
// 覆盖 ts/js/json5 注释、bash/yaml/env 注释、html 注释与 JSDoc 中缝行。
function isCommentLine(line) {
  const t = line.trimStart();
  return (
    t.startsWith('//') || t.startsWith('*') || t.startsWith('/*') || t.startsWith('#') || t.startsWith('<!--')
  );
}

function main() {
  const files = execFileSync('git', ['ls-files'], { cwd: REPO_ROOT, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 })
    .split('\n')
    .map((f) => f.trim())
    .filter(Boolean)
    .map((f) => f.replace(/\\/g, '/'));

  const violations = [];

  for (const file of files) {
    if (isExcluded(file)) continue;
    const abs = path.join(REPO_ROOT, file);
    let content;
    try {
      content = fs.readFileSync(abs, 'utf8');
    } catch {
      continue; // 已删除/无法读取(如 LFS 指针缺失)
    }
    // 快速预筛:整文件不含任何受控子串就跳过逐行
    if (!MONITORED.some((m) => content.includes(m.pattern))) continue;

    const lines = content.split('\n');
    for (const m of MONITORED) {
      if (!content.includes(m.pattern)) continue;
      if (isAllowed(file, m.allow)) continue;
      lines.forEach((line, i) => {
        if (!line.includes(m.pattern)) return;
        if (isCommentLine(line)) return;
        violations.push({ file, line: i + 1, pattern: m.pattern, text: line.trim().slice(0, 160) });
      });
    }
  }

  // ── 一致性校验 ──
  const epPath = path.join(REPO_ROOT, ENDPOINTS_JSON);
  const ep = JSON.parse(fs.readFileSync(epPath, 'utf8'));
  const inconsistencies = [];
  for (const check of buildConsistencyChecks(ep)) {
    const abs = path.join(REPO_ROOT, check.file);
    let content = '';
    try {
      content = fs.readFileSync(abs, 'utf8');
    } catch {
      inconsistencies.push({ ...check, reason: '文件不存在' });
      continue;
    }
    if (!content.includes(check.mustContain)) {
      inconsistencies.push({ ...check, reason: `未找到 ${check.mustContain}` });
    }
  }
  inconsistencies.push(...buildStructuredConsistencyChecks(ep));

  let failed = false;
  if (violations.length > 0) {
    failed = true;
    console.error(`\n✗ 受控域名字面量出现在允许清单之外(${violations.length} 处):\n`);
    for (const v of violations) {
      console.error(`  ${v.file}:${v.line}  [${v.pattern}]`);
      console.error(`    ${v.text}`);
    }
    console.error(
      '\n  处理方式:改为 import 对应端点常量(desktop: src/shared/endpoints.ts;server: src/endpoints.ts;' +
        '\n  脚本: scripts/shared/production-endpoints.mjs);确需新增定义点时把路径加进本脚本 MONITORED 白名单。\n',
    );
  }
  if (inconsistencies.length > 0) {
    failed = true;
    console.error(`\n✗ 与 ${ENDPOINTS_JSON} 权威值不一致(${inconsistencies.length} 处):\n`);
    for (const c of inconsistencies) {
      console.error(`  ${c.file}(${c.what}): ${c.reason}`);
    }
    console.error('\n  生产域名以 config/production-endpoints.json 为准,请同步上述文件。\n');
  }

  if (failed) process.exit(1);
  console.log('✓ endpoint literals check passed(受控域名无散落,权威值一致)');
}

const isDirectRun = process.argv[1]
  && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url));
if (isDirectRun) main();
