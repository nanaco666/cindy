// OSS/CDN 配置回归测试：共享模块先 import、desktop .env 后加载时，live binding 也要刷新。
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import {
  CDN_BASE,
  OSS_BUCKET,
  OSS_PREFIX,
  OSS_REGION,
  loadDotenv,
  refreshOssConfig,
} from "../../apps/desktop/scripts/ci/lib.mjs";

const CONFIG_ENV_KEYS = [
  "XDT_CDN_BASE_URL",
  "XDT_OSS_BUCKET",
  "XDT_OSS_PREFIX",
  "XDT_OSS_REGION",
];

test("loadDotenv 刷新在 import 后才注入的 OSS/CDN 配置", () => {
  const saved = Object.fromEntries(
    CONFIG_ENV_KEYS.map((key) => [key, process.env[key]]),
  );
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "xdt-oss-env-"));
  const envFile = path.join(tempDir, ".env");

  try {
    for (const key of CONFIG_ENV_KEYS) delete process.env[key];

    fs.writeFileSync(
      envFile,
      [
        "XDT_CDN_BASE_URL=xdt-test-cdn",
        "XDT_OSS_BUCKET=xdt-test-bucket",
        "XDT_OSS_PREFIX=xdt-test-prefix",
        "XDT_OSS_REGION=xdt-test-region",
        "",
      ].join("\n"),
    );

    loadDotenv(envFile);

    assert.equal(CDN_BASE, "xdt-test-cdn");
    assert.equal(OSS_BUCKET, "xdt-test-bucket");
    assert.equal(OSS_PREFIX, "xdt-test-prefix");
    assert.equal(OSS_REGION, "xdt-test-region");
  } finally {
    for (const key of CONFIG_ENV_KEYS) {
      if (saved[key] === undefined) delete process.env[key];
      else process.env[key] = saved[key];
    }
    const temporaryOverrides = [];
    const restoreValues = {
      XDT_CDN_BASE_URL: 'https://cdn.example.invalid',
      XDT_OSS_BUCKET: 'test-bucket',
      XDT_OSS_PREFIX: 'test-prefix',
      XDT_OSS_REGION: 'oss-test-region',
    };
    for (const [key, value] of Object.entries(restoreValues)) {
      if (!process.env[key]) {
        process.env[key] = value;
        temporaryOverrides.push(key);
      }
    }
    refreshOssConfig();
    for (const key of temporaryOverrides) delete process.env[key];
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

test("build-only loadDotenv 不要求 OSS 发布配置", () => {
  const saved = Object.fromEntries(
    CONFIG_ENV_KEYS.map((key) => [key, process.env[key]]),
  );
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "xdt-build-env-"));
  const envFile = path.join(tempDir, ".env");
  try {
    for (const key of CONFIG_ENV_KEYS) delete process.env[key];
    fs.writeFileSync(envFile, "XDT_CDN_BASE_URL=https://runtime-only.example.invalid\n");
    assert.doesNotThrow(() =>
      loadDotenv(envFile, { refreshReleaseConfig: false }),
    );
  } finally {
    for (const key of CONFIG_ENV_KEYS) {
      if (saved[key] === undefined) delete process.env[key];
      else process.env[key] = saved[key];
    }
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

test("独立 agent binary 发布脚本先加载 desktop .env 再按 region 读取 CDN / OSS 配置", () => {
  for (const scriptName of ["release-claude-code.mjs", "release-codex.mjs", "release-ripgrep.mjs"]) {
    const source = fs.readFileSync(
      new URL(`../../apps/desktop/scripts/${scriptName}`, import.meta.url),
      "utf8",
    );
    if (scriptName === "release-ripgrep.mjs") {
      const loadIndex = source.indexOf("loadDotenv();");
      assert.notEqual(loadIndex, -1, `${scriptName} 必须调用 loadDotenv()`);
      const firstRuntimeConfigUse = source.indexOf("const ossKey = ");
      assert.notEqual(firstRuntimeConfigUse, -1, `${scriptName} 必须使用 OSS_PREFIX`);
      assert.ok(loadIndex < firstRuntimeConfigUse, `${scriptName} 必须在读取 OSS_PREFIX 前加载并刷新 desktop .env`);
    } else {
      const loadIndex = source.indexOf("loadDotenv(undefined, { refreshReleaseConfig: false });");
      const applyIndex = source.indexOf("applyReleaseRegionConfigToEnv(REGION);");
      const refreshIndex = source.indexOf("refreshOssConfig(REGION);");
      const resolveIndex = source.indexOf("const CDN_BASE = resolveReleaseCdnBaseUrl(REGION);");
      assert.notEqual(loadIndex, -1, `${scriptName} 必须只加载 .env、不提前按默认 cn 刷新`);
      assert.notEqual(applyIndex, -1, `${scriptName} 必须应用 release-regions.json 的地区配置`);
      assert.notEqual(refreshIndex, -1, `${scriptName} 必须按 REGION 刷新 OSS live bindings`);
      assert.notEqual(resolveIndex, -1, `${scriptName} 必须按 REGION 解析 CDN_BASE`);
      assert.ok(loadIndex < applyIndex, `${scriptName} 必须先加载 .env 再补地区 JSON 配置`);
      assert.ok(applyIndex < refreshIndex, `${scriptName} 必须先注入地区配置再刷新 OSS`);
      assert.ok(refreshIndex < resolveIndex, `${scriptName} 必须先刷新 OSS 再读取地区 CDN`);
      assert.match(source, /resolveOssCredentials\(REGION\)/, `${scriptName} 必须按 REGION 解析 AK/SK`);
    }
  }
});
