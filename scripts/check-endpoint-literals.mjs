#!/usr/bin/env node
/**
 * 生产端点源码泄漏门禁。
 *
 * 真实地址来自 gitignored production-endpoints.json。本脚本在无私有配置的 PR checkout
 * 中也能验证 example、Git 跟踪状态和关键消费文件；CI 提供真实配置后还会动态提取
 * hostname，确认这些 hostname 没有重新写回受控源码。
 */
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  DEFAULT_PRODUCTION_ENDPOINTS_PATH,
  PRODUCTION_CONFIG_KEYS,
  PRODUCTION_ENDPOINT_KEYS,
  loadProductionEndpoints,
  validateProductionEndpointsExample,
} from './shared/production-endpoints.mjs';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PRIVATE_CONFIG_REPO_PATH = 'config/production-endpoints.json';
const EAS_ENDPOINT_ENV_KEYS = Object.freeze([
  'EXPO_PUBLIC_XDT_API_BASE_URL',
  'EXPO_PUBLIC_XDT_DEVICE_LINK_API_BASE_URL',
  'EXPO_PUBLIC_XDT_MOBILE_VOICE_LITELLM_BASE_URL',
]);
const CONTROLLED_SOURCE_FILES = Object.freeze([
  'apps/desktop/src/shared/endpoints.ts',
  'apps/desktop/src/shared/hookControlIpc.ts',
  'apps/mobile/src/config/env.ts',
  'apps/mobile/eas.json',
  'packages/embedding-client/src/client.ts',
  'packages/embedding-client/src/types.ts',
]);
const ALLOWED_NON_PRODUCTION_ORIGINS = new Set([
  'http://localhost:3333',
  'http://localhost:3335',
  'https://e.tapdb.com',
]);

/** 解析单个 EAS profile 的继承 env，供门禁测试复用。 */
export function resolveEasBuildProfileEnv(buildProfiles, profileName, stack = []) {
  const profile = buildProfiles?.[profileName];
  if (!profile || typeof profile !== 'object' || Array.isArray(profile)) {
    throw new Error(`EAS build profile 不存在或格式非法: ${profileName}`);
  }
  if (stack.includes(profileName)) {
    throw new Error(`EAS build profile extends 循环: ${[...stack, profileName].join(' -> ')}`);
  }
  const inherited = profile.extends
    ? resolveEasBuildProfileEnv(buildProfiles, profile.extends, [...stack, profileName])
    : {};
  const own = profile.env ?? {};
  if (!own || typeof own !== 'object' || Array.isArray(own)) {
    throw new Error(`EAS build profile ${profileName} 的 env 必须是 object`);
  }
  return { ...inherited, ...own };
}

function gitTrackedFiles() {
  return execFileSync('git', ['ls-files'], {
    cwd: REPO_ROOT,
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
  })
    .split(/\r?\n/)
    .map((file) => file.trim().replace(/\\/g, '/'))
    .filter(Boolean);
}

function findAbsoluteOrigins(content) {
  return [
    ...content.matchAll(/(?:https?|wss?):\/\/[A-Za-z0-9.-]+(?::\d+)?/gi),
  ].map((match) => match[0].toLowerCase());
}

function main() {
  const errors = [];
  const tracked = new Set(gitTrackedFiles());

  if (tracked.has(PRIVATE_CONFIG_REPO_PATH)) {
    errors.push(`${PRIVATE_CONFIG_REPO_PATH} 不允许被 Git 跟踪`);
  }

  try {
    const example = validateProductionEndpointsExample();
    for (const key of PRODUCTION_CONFIG_KEYS) {
      if (example[key] !== '') errors.push(`production-endpoints.json.example 的 ${key} 必须为空`);
    }
  } catch (error) {
    errors.push(error instanceof Error ? error.message : String(error));
  }

  for (const file of CONTROLLED_SOURCE_FILES) {
    const content = fs.readFileSync(path.join(REPO_ROOT, file), 'utf8');
    for (const origin of findAbsoluteOrigins(content)) {
      if (!ALLOWED_NON_PRODUCTION_ORIGINS.has(origin)) {
        errors.push(`${file} 不允许包含生产 URL 字面量: ${origin}`);
      }
    }
  }

  try {
    const eas = JSON.parse(fs.readFileSync(path.join(REPO_ROOT, 'apps/mobile/eas.json'), 'utf8'));
    for (const profileName of Object.keys(eas.build ?? {})) {
      const env = resolveEasBuildProfileEnv(eas.build, profileName);
      for (const key of EAS_ENDPOINT_ENV_KEYS) {
        if (Object.hasOwn(env, key)) errors.push(`apps/mobile/eas.json build.${profileName} 不应提交 ${key}`);
      }
    }
  } catch (error) {
    errors.push(error instanceof Error ? error.message : String(error));
  }

  if (fs.existsSync(DEFAULT_PRODUCTION_ENDPOINTS_PATH)) {
    try {
      const endpoints = loadProductionEndpoints();
      const privateHosts = new Set(
        PRODUCTION_ENDPOINT_KEYS.map(
          (key) => new URL(endpoints[key]).hostname.toLowerCase(),
        ),
      );
      for (const file of CONTROLLED_SOURCE_FILES) {
        const content = fs.readFileSync(path.join(REPO_ROOT, file), 'utf8').toLowerCase();
        for (const hostname of privateHosts) {
          if (content.includes(hostname)) errors.push(`${file} 泄漏私有端点 hostname: ${hostname}`);
        }
      }
    } catch (error) {
      errors.push(error instanceof Error ? error.message : String(error));
    }
  }

  if (errors.length) {
    console.error(`生产端点门禁失败 (${errors.length}):`);
    for (const error of errors) console.error(`  - ${error}`);
    process.exit(1);
  }
  console.log('endpoint source guard passed');
}

const isDirectRun =
  process.argv[1] && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url));
if (isDirectRun) main();
