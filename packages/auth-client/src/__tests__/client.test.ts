import { describe, expect, it, vi } from "vitest";

import {
  CindyAuthClient,
  reduceAuthFlow,
  type AuthFetchResponse,
} from "../index.js";

function response(status: number, data: unknown): AuthFetchResponse {
  return { ok: status >= 200 && status < 300, status, json: async () => data };
}

function client(fetch = vi.fn(async () => response(200, {}))) {
  return new CindyAuthClient({
    baseUrl: "https://auth.example.com/",
    region: "cn",
    deviceId: "device-1",
    clientType: "desktop",
    locale: "zh-CN",
    fetch,
  });
}

describe("CindyAuthClient", () => {
  it("validates provider region and normalizes the base URL", async () => {
    const fetch = vi.fn(async () =>
      response(200, {
        region: "cn",
        attribution: "phone",
        email: true,
        phone: true,
        social: ["apple"],
      }),
    );
    await expect(client(fetch).getProviders()).resolves.toMatchObject({
      region: "cn",
    });
    expect(fetch).toHaveBeenCalledWith(
      "https://auth.example.com/api/auth/providers",
      expect.anything(),
    );
  });

  it("fails closed on a region mismatch", async () => {
    const fetch = vi.fn(async () =>
      response(200, {
        region: "global",
        attribution: "email",
        email: true,
        phone: false,
        social: ["google"],
      }),
    );
    await expect(client(fetch).getProviders()).rejects.toMatchObject({
      code: "REGION_MISMATCH",
    });
  });

  it("parses all auth-server outcome states", async () => {
    const outcomes = [
      { status: "binding_required", bindType: "phone", bindTicket: "bind-1" },
      {
        status: "select_account",
        loginTicket: "login-1",
        accounts: [
          {
            id: "m1",
            kind: "personal",
            role: "owner",
            displayName: "Cindy",
            email: null,
            orgId: null,
            orgName: null,
          },
        ],
      },
      {
        status: "ok",
        accessToken: "access",
        refreshToken: "refresh",
        membership: {
          id: "m1",
          passportId: "p1",
          kind: "personal",
          role: "owner",
          displayName: "Cindy",
          email: null,
          orgId: null,
          orgName: null,
        },
      },
    ];
    const fetch = vi.fn(async () => response(200, outcomes.shift()));
    await expect(
      client(fetch).verifyCode("email", "a@example.com", "123456"),
    ).resolves.toMatchObject({ status: "binding_required" });
    await expect(
      client(fetch).verifyCode("phone", "+8613800000000", "123456"),
    ).resolves.toMatchObject({ status: "select_account" });
    await expect(
      client(fetch).selectAccount("login-1", "m1"),
    ).resolves.toMatchObject({ status: "ok" });
  });

  it("maps server errors without leaking malformed responses", async () => {
    const fetch = vi.fn(async () =>
      response(401, { error: { code: "INVALID_CODE", message: "bad" } }),
    );
    await expect(
      client(fetch).verifyCode("email", "a@example.com", "000000"),
    ).rejects.toEqual(
      expect.objectContaining({ code: "INVALID_CODE", statusCode: 401 }),
    );
  });

  it("builds PKCE authorize URLs for social and SSO", () => {
    const auth = client();
    const url = new URL(
      auth.buildAuthorizeUrl({
        kind: "sso",
        providerOrConnectionId: "conn/a",
        redirectUri: "http://127.0.0.1:4567/auth",
        codeChallenge: "a".repeat(43),
        state: "state-1",
      }),
    );
    expect(url.pathname).toBe("/api/auth/sso/conn%2Fa/authorize");
    expect(url.searchParams.get("client_state")).toBe("state-1");
    expect(url.searchParams.get("device_id")).toBe("device-1");
  });
});

describe("reduceAuthFlow", () => {
  it("projects secret-bearing outcomes into public states", () => {
    const state = reduceAuthFlow(null, {
      type: "outcome",
      outcome: {
        status: "select_account",
        loginTicket: "secret-ticket",
        accounts: [
          {
            id: "m1",
            kind: "personal",
            role: "owner",
            displayName: "Cindy",
            email: null,
            orgId: null,
            orgName: null,
          },
        ],
      },
    });
    expect(state).toEqual(
      expect.objectContaining({ step: "account-selection" }),
    );
    expect(JSON.stringify(state)).not.toContain("secret-ticket");
  });
});
