// desktop 发布地区渠道配置(scripts/release-regions.json)加载/合并回归测试:
// env 显式值优先、JSON 只补缺、缺文件且 env 不全时 fail closed 并指向 .example。
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import {
  RELEASE_REGION_ENV_NAMES,
  applyReleaseRegionConfigToEnv,
  validateReleaseRegions,
} from "../../apps/desktop/scripts/ci/release-regions.mjs";

const ALL_ENV_NAMES = Object.values(RELEASE_REGION_ENV_NAMES).flatMap((names) =>
  Object.values(names),
);

function withCleanEnv(fn) {
  const saved = Object.fromEntries(ALL_ENV_NAMES.map((key) => [key, process.env[key]]));
  for (const key of ALL_ENV_NAMES) delete process.env[key];
  try {
    fn();
  } finally {
    for (const key of ALL_ENV_NAMES) {
      if (saved[key] === undefined) delete process.env[key];
      else process.env[key] = saved[key];
    }
  }
}

function writeRegionsFile(dir, config) {
  const filePath = path.join(dir, "release-regions.json");
  fs.writeFileSync(filePath, JSON.stringify(config, null, 2));
  return filePath;
}

const FULL_CONFIG = {
  cn: {
    oss: {
      cdnBaseUrl: "https://cdn.cn.invalid/cindy",
      bucket: "bucket-cn",
      prefix: "prefix-cn",
      ossRegion: "oss-cn-beijing",
    },
  },
  global: {
    oss: {
      cdnBaseUrl: "https://cdn.global.invalid/cindy",
      bucket: "bucket-global",
      prefix: "prefix-global",
      ossRegion: "oss-ap-southeast-1",
    },
  },
};

test("JSON 完整时按 region 注入对应 env 变量", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "release-regions-"));
  try {
    const filePath = writeRegionsFile(dir, FULL_CONFIG);
    withCleanEnv(() => {
      const cn = applyReleaseRegionConfigToEnv("cn", { filePath });
      assert.equal(cn.source, "file");
      assert.equal(process.env.XDT_CDN_BASE_URL, "https://cdn.cn.invalid/cindy");
      assert.equal(process.env.XDT_OSS_BUCKET, "bucket-cn");
      // cn 注入不应触碰 global 的 env 面
      assert.equal(process.env.XDT_GLOBAL_OSS_BUCKET, undefined);

      const g = applyReleaseRegionConfigToEnv("global", { filePath });
      assert.equal(g.source, "file");
      assert.equal(process.env.XDT_GLOBAL_OSS_PREFIX, "prefix-global");
      assert.equal(process.env.XDT_GLOBAL_OSS_REGION, "oss-ap-southeast-1");
    });
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("env 显式值优先于 JSON,JSON 只补缺失键", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "release-regions-"));
  try {
    const filePath = writeRegionsFile(dir, FULL_CONFIG);
    withCleanEnv(() => {
      process.env.XDT_OSS_BUCKET = "bucket-from-ci-secret";
      applyReleaseRegionConfigToEnv("cn", { filePath });
      assert.equal(process.env.XDT_OSS_BUCKET, "bucket-from-ci-secret");
      assert.equal(process.env.XDT_OSS_PREFIX, "prefix-cn");
    });
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("env 四件套齐全时不要求 JSON 文件存在(CI 场景)", () => {
  withCleanEnv(() => {
    process.env.XDT_GLOBAL_CDN_BASE_URL = "https://cdn.global.invalid/cindy";
    process.env.XDT_GLOBAL_OSS_BUCKET = "b";
    process.env.XDT_GLOBAL_OSS_PREFIX = "p";
    process.env.XDT_GLOBAL_OSS_REGION = "r";
    const result = applyReleaseRegionConfigToEnv("global", {
      filePath: "/nonexistent/release-regions.json",
    });
    assert.equal(result.source, "env");
  });
});

test("缺文件且 env 不全 → fail closed 并同时给出两种修复途径", () => {
  withCleanEnv(() => {
    assert.throws(
      () => applyReleaseRegionConfigToEnv("cn", { filePath: "/nonexistent/release-regions.json" }),
      /release-regions\.json\.example[\s\S]*XDT_CDN_BASE_URL/,
    );
  });
});

test("JSON 存在但该渠道字段留空 → 报缺失字段与 env 变量名", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "release-regions-"));
  try {
    const config = structuredClone(FULL_CONFIG);
    config.global.oss.bucket = "";
    const filePath = writeRegionsFile(dir, config);
    withCleanEnv(() => {
      assert.throws(
        () => applyReleaseRegionConfigToEnv("global", { filePath }),
        /global\.oss\.bucket.*XDT_GLOBAL_OSS_BUCKET/,
      );
    });
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("validateReleaseRegions: 结构缺块 / 叶子非字符串一律抛错", () => {
  assert.throws(() => validateReleaseRegions(null), /JSON object/);
  assert.throws(() => validateReleaseRegions({ cn: FULL_CONFIG.cn }), /global/);
  const bad = structuredClone(FULL_CONFIG);
  bad.cn.oss.bucket = 123;
  assert.throws(() => validateReleaseRegions(bad), /cn\.oss\.bucket/);
});
