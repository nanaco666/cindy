// desktop 发布地区渠道配置(scripts/release-regions.json)加载/合并回归测试:
// env 显式值优先、JSON 只补缺、缺文件且 env 不全时 fail closed 并指向 .example。
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import {
  RELEASE_REGION_ENV_NAMES,
  MAC_SIGNING_ENV_NAMES,
  applyReleaseRegionConfigToEnv,
  validateReleaseRegions,
} from "../../apps/desktop/scripts/ci/release-regions.mjs";

const ALL_ENV_NAMES = [
  ...Object.values(RELEASE_REGION_ENV_NAMES).flatMap((names) => Object.values(names)),
  ...Object.values(MAC_SIGNING_ENV_NAMES),
];

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
  // dev 第三渠道(2026-07-20):结构必须存在,叶子允许留空(bucket 未建时
  // 只在真的发 dev 渠道时才 fail closed)。
  dev: {
    oss: { cdnBaseUrl: "", bucket: "", prefix: "", ossRegion: "" },
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

      // dev 渠道:块存在但留空 → 发 dev 时报缺字段与 XDT_DEVCH_* env 名
      assert.throws(
        () => applyReleaseRegionConfigToEnv("dev", { filePath }),
        /dev\.oss\.bucket.*XDT_DEVCH_OSS_BUCKET/,
      );
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

test("macSigning: 按 region 注入 APPLE_*,env 显式值优先,留空回落默认", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "release-regions-"));
  try {
    const config = structuredClone(FULL_CONFIG);
    config.cn.macSigning = { appleId: "", teamId: "TEAMCN0001", signIdentity: "Developer ID Application: CN Corp (TEAMCN0001)" };
    config.global.macSigning = { appleId: "", teamId: "TEAMGL0001", signIdentity: "Developer ID Application: GL Corp (TEAMGL0001)" };
    const filePath = writeRegionsFile(dir, config);
    withCleanEnv(() => {
      applyReleaseRegionConfigToEnv("cn", { filePath });
      assert.equal(process.env.APPLE_TEAM_ID, "TEAMCN0001");
      // appleId 留空 → 不注入(resolveAppleIdentity 无默认值,签名时会 fail closed)
      assert.equal(process.env.APPLE_ID, undefined);
    });
    withCleanEnv(() => {
      process.env.APPLE_TEAM_ID = "TEAM-FROM-CI";
      applyReleaseRegionConfigToEnv("global", { filePath });
      assert.equal(process.env.APPLE_TEAM_ID, "TEAM-FROM-CI");
      assert.equal(process.env.APPLE_SIGN_IDENTITY, "Developer ID Application: GL Corp (TEAMGL0001)");
    });
    // OSS 面走 env(CI 场景)时,JSON 的 macSigning 仍应用
    withCleanEnv(() => {
      process.env.XDT_CDN_BASE_URL = "https://cdn.cn.invalid/cindy";
      process.env.XDT_OSS_BUCKET = "b";
      process.env.XDT_OSS_PREFIX = "p";
      process.env.XDT_OSS_REGION = "r";
      const r = applyReleaseRegionConfigToEnv("cn", { filePath });
      assert.equal(r.source, "env");
      assert.equal(process.env.APPLE_TEAM_ID, "TEAMCN0001");
    });
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("macSigning.appPasswordEnv: 密码指针注入 / 显式 env 优先 / 指针空值 fail closed", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "release-regions-"));
  const saved = { pw: process.env.APPLE_APP_PASSWORD, cnpw: process.env.NOTARY_PW_CN };
  try {
    const config = structuredClone(FULL_CONFIG);
    config.cn.macSigning = { appleId: "a@b.c", teamId: "T1", signIdentity: "S1", appPasswordEnv: "NOTARY_PW_CN" };
    const filePath = writeRegionsFile(dir, config);
    withCleanEnv(() => {
      delete process.env.APPLE_APP_PASSWORD;
      process.env.NOTARY_PW_CN = "pw-from-pointer";
      applyReleaseRegionConfigToEnv("cn", { filePath });
      assert.equal(process.env.APPLE_APP_PASSWORD, "pw-from-pointer");
    });
    withCleanEnv(() => {
      process.env.APPLE_APP_PASSWORD = "explicit-wins";
      process.env.NOTARY_PW_CN = "pw-from-pointer";
      applyReleaseRegionConfigToEnv("cn", { filePath });
      assert.equal(process.env.APPLE_APP_PASSWORD, "explicit-wins");
    });
    withCleanEnv(() => {
      delete process.env.APPLE_APP_PASSWORD;
      delete process.env.NOTARY_PW_CN;
      assert.throws(() => applyReleaseRegionConfigToEnv("cn", { filePath }), /NOTARY_PW_CN/);
    });
    // 非法 env 名拒绝
    const bad = structuredClone(FULL_CONFIG);
    bad.cn.macSigning = { appPasswordEnv: "lower-case" };
    assert.throws(() => validateReleaseRegions(bad), /appPasswordEnv/);
  } finally {
    if (saved.pw === undefined) delete process.env.APPLE_APP_PASSWORD; else process.env.APPLE_APP_PASSWORD = saved.pw;
    if (saved.cnpw === undefined) delete process.env.NOTARY_PW_CN; else process.env.NOTARY_PW_CN = saved.cnpw;
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("resolveAppleIdentity: 零默认值——身份缺失抛错,注入后返回配置值", async () => {
  const { resolveAppleIdentity } = await import("../../apps/desktop/scripts/ci/lib.mjs");
  withCleanEnv(() => {
    assert.throws(() => resolveAppleIdentity(), /APPLE_ID.*APPLE_TEAM_ID.*APPLE_SIGN_IDENTITY/);
    process.env.APPLE_ID = "notary@example.com";
    process.env.APPLE_TEAM_ID = "TEAM000001";
    assert.throws(() => resolveAppleIdentity(), /APPLE_SIGN_IDENTITY/);
    process.env.APPLE_SIGN_IDENTITY = "Developer ID Application: Example (TEAM000001)";
    assert.deepEqual(resolveAppleIdentity(), {
      appleId: "notary@example.com",
      teamId: "TEAM000001",
      signIdentity: "Developer ID Application: Example (TEAM000001)",
    });
  });
});

test("validateReleaseRegions: 结构缺块 / 叶子非字符串一律抛错", () => {
  assert.throws(() => validateReleaseRegions(null), /JSON object/);
  assert.throws(() => validateReleaseRegions({ cn: FULL_CONFIG.cn }), /global/);
  const bad = structuredClone(FULL_CONFIG);
  bad.cn.oss.bucket = 123;
  assert.throws(() => validateReleaseRegions(bad), /cn\.oss\.bucket/);
  const badMac = structuredClone(FULL_CONFIG);
  badMac.cn.macSigning = { teamId: 42 };
  assert.throws(() => validateReleaseRegions(badMac), /cn\.macSigning\.teamId/);
});
