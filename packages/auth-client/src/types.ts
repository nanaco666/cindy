import { z } from "zod";

export const authRegionSchema = z.enum(["cn", "global"]);
export type AuthRegion = z.infer<typeof authRegionSchema>;

export const socialProviderSchema = z.enum(["apple", "google", "wechat"]);
export type SocialProvider = z.infer<typeof socialProviderSchema>;

export const membershipSchema = z.object({
  id: z.string().min(1),
  passportId: z.string().min(1).optional(),
  kind: z.enum(["personal", "org"]),
  role: z.enum(["owner", "admin", "member"]),
  displayName: z.string(),
  // 用户自助设置的头像(auth-server PATCH /api/me/profile);null = 未设置。
  // optional 兼容尚未升级的旧 auth-server 响应(缺字段不整份拒绝)。
  avatarUrl: z.string().nullable().optional(),
  email: z.string().nullable(),
  orgId: z.string().nullable(),
  orgName: z.string().nullable(),
});
export type AuthMembership = z.infer<typeof membershipSchema>;

export const providerConfigSchema = z.object({
  region: authRegionSchema,
  attribution: z.enum(["phone", "email"]),
  email: z.boolean(),
  phone: z.boolean(),
  social: z.array(socialProviderSchema),
});
export type ProviderConfig = z.infer<typeof providerConfigSchema>;

export const loginMethodSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("email_code") }),
  z.object({
    type: z.literal("sso"),
    connectionId: z.string().min(1),
    protocol: z.enum(["oidc", "saml", "cas"]),
    orgName: z.string(),
    connectionName: z.string(),
    ssoRequired: z.boolean(),
  }),
]);
export type LoginMethod = z.infer<typeof loginMethodSchema>;

export const tokenPairSchema = z.object({
  accessToken: z.string().min(1),
  refreshToken: z.string().min(1),
  membership: membershipSchema,
});
export type AuthTokenPair = z.infer<typeof tokenPairSchema>;
const okOutcomeSchema = tokenPairSchema.extend({ status: z.literal("ok") });
const selectAccountOutcomeSchema = z.object({
  status: z.literal("select_account"),
  loginTicket: z.string().min(1),
  accounts: z.array(membershipSchema).min(1),
});
const bindingRequiredOutcomeSchema = z.object({
  status: z.literal("binding_required"),
  bindType: z.enum(["phone", "email"]),
  bindTicket: z.string().min(1),
});
export const loginOutcomeSchema = z.discriminatedUnion("status", [
  okOutcomeSchema,
  selectAccountOutcomeSchema,
  bindingRequiredOutcomeSchema,
]);
export type LoginOutcome = z.infer<typeof loginOutcomeSchema>;
export type AuthSuccess = z.infer<typeof okOutcomeSchema>;

export const meResponseSchema = z.object({
  membership: membershipSchema,
  passportId: z.string().min(1),
  identities: z.array(membershipSchema),
});
export type AuthMe = z.infer<typeof meResponseSchema>;

export type AuthClientType = "desktop" | "mobile" | "web";
export type VerificationKind = "email" | "phone";

export type AuthFlowState =
  | { step: "identifier"; providers: ProviderConfig }
  | { step: "method-choice"; email: string; methods: LoginMethod[] }
  | { step: "verification-code"; kind: VerificationKind; identifier: string }
  | { step: "browser-redirect"; label: string }
  | { step: "account-selection"; accounts: AuthMembership[] }
  | {
      step: "binding";
      bindType: VerificationKind;
      codeRequested: boolean;
      contact?: string;
    }
  | { step: "completed"; membership: AuthMembership }
  | {
      step: "error";
      code: string;
      recoverTo: Exclude<AuthFlowState["step"], "error">;
    };

export type AuthFlowAction =
  | { type: "providers-loaded"; providers: ProviderConfig }
  | { type: "discovery-loaded"; email: string; methods: LoginMethod[] }
  | { type: "code-requested"; kind: VerificationKind; identifier: string }
  | { type: "browser-started"; label: string }
  | { type: "outcome"; outcome: LoginOutcome }
  | {
      type: "binding-code-requested";
      bindType: VerificationKind;
      contact: string;
    }
  | {
      type: "failed";
      code: string;
      recoverTo: Exclude<AuthFlowState["step"], "error">;
    };

/** Pure UI-state projection. Secret login/bind tickets stay in platform controllers. */
export function reduceAuthFlow(
  _state: AuthFlowState | null,
  action: AuthFlowAction,
): AuthFlowState {
  switch (action.type) {
    case "providers-loaded":
      return { step: "identifier", providers: action.providers };
    case "discovery-loaded":
      return {
        step: "method-choice",
        email: action.email,
        methods: action.methods,
      };
    case "code-requested":
      return {
        step: "verification-code",
        kind: action.kind,
        identifier: action.identifier,
      };
    case "browser-started":
      return { step: "browser-redirect", label: action.label };
    case "binding-code-requested":
      return {
        step: "binding",
        bindType: action.bindType,
        codeRequested: true,
        contact: action.contact,
      };
    case "failed":
      return { step: "error", code: action.code, recoverTo: action.recoverTo };
    case "outcome":
      if (action.outcome.status === "ok") {
        return { step: "completed", membership: action.outcome.membership };
      }
      if (action.outcome.status === "select_account") {
        return { step: "account-selection", accounts: action.outcome.accounts };
      }
      return {
        step: "binding",
        bindType: action.outcome.bindType,
        codeRequested: false,
      };
  }
}
