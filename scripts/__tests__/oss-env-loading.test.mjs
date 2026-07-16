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
    refreshOssConfig();

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
    refreshOssConfig();
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

test("独立 agent binary 发布脚本先加载 desktop .env 再读取 CDN / OSS 配置", () => {
  for (const scriptName of ["release-claude-code.mjs", "release-codex.mjs", "release-ripgrep.mjs"]) {
    const source = fs.readFileSync(
      new URL(`../../apps/desktop/scripts/${scriptName}`, import.meta.url),
      "utf8",
    );
    const loadIndex = source.indexOf("loadDotenv();");
    assert.notEqual(loadIndex, -1, `${scriptName} 必须调用 loadDotenv()`);
    if (scriptName === "release-ripgrep.mjs") {
      const firstRuntimeConfigUse = source.indexOf("const ossKey = ");
      assert.notEqual(firstRuntimeConfigUse, -1, `${scriptName} 必须使用 OSS_PREFIX`);
      assert.ok(loadIndex < firstRuntimeConfigUse, `${scriptName} 必须在读取 OSS_PREFIX 前加载并刷新 desktop .env`);
    } else {
      const resolveIndex = source.indexOf("const CDN_BASE = resolveCdnBaseUrl();");
      assert.notEqual(resolveIndex, -1, `${scriptName} 必须解析 CDN_BASE`);
      assert.ok(
        loadIndex < resolveIndex,
        `${scriptName} 必须在 resolveCdnBaseUrl() 前加载并刷新 desktop .env`,
      );
    }
  }
});
