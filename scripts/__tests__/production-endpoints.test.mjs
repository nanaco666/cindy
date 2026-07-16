import assert from "node:assert/strict";
import test from "node:test";

import {
  productionEndpoints,
  productionViteEnv,
} from "../shared/production-endpoints.mjs";

test("productionViteEnv defaults to CN and selects Global explicitly", () => {
  const cn = productionViteEnv({ allowEnvOverride: false, authRegion: "cn" });
  const global = productionViteEnv({
    allowEnvOverride: false,
    authRegion: "global",
  });

  assert.equal(cn.VITE_CINDY_AUTH_REGION, "cn");
  assert.equal(
    cn.VITE_CINDY_AUTH_BASE_URL,
    productionEndpoints.authApiBaseUrlCn,
  );
  assert.equal(global.VITE_CINDY_AUTH_REGION, "global");
  assert.equal(
    global.VITE_CINDY_AUTH_BASE_URL,
    productionEndpoints.authApiBaseUrlGlobal,
  );
});

test("locked production endpoints ignore stale VITE overrides", () => {
  const previousBuildRegion = process.env.CINDY_AUTH_REGION;
  const previousRegion = process.env.VITE_CINDY_AUTH_REGION;
  const previousBaseUrl = process.env.VITE_CINDY_AUTH_BASE_URL;
  try {
    delete process.env.CINDY_AUTH_REGION;
    process.env.VITE_CINDY_AUTH_REGION = "global";
    process.env.VITE_CINDY_AUTH_BASE_URL = "https://stale.invalid";
    const locked = productionViteEnv({ allowEnvOverride: false });
    assert.equal(locked.VITE_CINDY_AUTH_REGION, "cn");
    assert.equal(
      locked.VITE_CINDY_AUTH_BASE_URL,
      productionEndpoints.authApiBaseUrlCn,
    );
  } finally {
    restoreEnv("CINDY_AUTH_REGION", previousBuildRegion);
    restoreEnv("VITE_CINDY_AUTH_REGION", previousRegion);
    restoreEnv("VITE_CINDY_AUTH_BASE_URL", previousBaseUrl);
  }
});

function restoreEnv(key, value) {
  if (value === undefined) delete process.env[key];
  else process.env[key] = value;
}
