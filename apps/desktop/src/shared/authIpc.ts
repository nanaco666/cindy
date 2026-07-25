/** Typed renderer/main boundary for the auth-server login flow. */
import type { AuthFlowState, VerificationKind } from '@cindy/auth-client';

export type DesktopLoginAction =
  | { type: 'reset' }
  | { type: 'cancel-browser' }
  | { type: 'discover'; email: string }
  | { type: 'discover-sso-org'; org: string }
  | { type: 'request-code'; kind: VerificationKind; identifier: string }
  | { type: 'verify-code'; kind: VerificationKind; identifier: string; code: string }
  | {
      type: 'start-browser';
      kind: 'social' | 'sso';
      providerOrConnectionId: string;
      label: string;
    }
  | { type: 'select-account'; accountId: string }
  | { type: 'request-sso-verification-code' }
  | { type: 'verify-sso-verification'; code: string }
  | { type: 'request-binding-code'; contact: string }
  | { type: 'verify-binding'; contact: string; code: string };

export type DesktopLoginActionResult =
  | { success: true; state: AuthFlowState }
  | { success: false; code: string; state: AuthFlowState | null };

const MAX_IDENTIFIER_LENGTH = 320;
const MAX_OPAQUE_ID_LENGTH = 256;
const MAX_CODE_LENGTH = 32;
// 与 auth-server 的企业 ID / slug / 已验证域名统一上限对齐。
const MAX_ORG_IDENTIFIER_LENGTH = 253;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isBoundedString(value: unknown, maxLength: number): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= maxLength;
}

function isVerificationKind(value: unknown): value is VerificationKind {
  return value === 'email' || value === 'phone';
}

/**
 * Runtime validation for the untrusted renderer-to-main IPC boundary. The
 * returned object only contains fields recognized by the selected action.
 */
export function parseDesktopLoginAction(value: unknown): DesktopLoginAction | null {
  if (!isRecord(value) || typeof value.type !== 'string') return null;

  switch (value.type) {
    case 'reset':
      return { type: 'reset' };
    case 'cancel-browser':
      return { type: 'cancel-browser' };
    case 'discover':
      return isBoundedString(value.email, MAX_IDENTIFIER_LENGTH)
        ? { type: 'discover', email: value.email }
        : null;
    case 'discover-sso-org':
      return isBoundedString(value.org, MAX_ORG_IDENTIFIER_LENGTH)
        ? { type: 'discover-sso-org', org: value.org }
        : null;
    case 'request-code':
      return isVerificationKind(value.kind) &&
        isBoundedString(value.identifier, MAX_IDENTIFIER_LENGTH)
        ? { type: 'request-code', kind: value.kind, identifier: value.identifier }
        : null;
    case 'verify-code':
      return isVerificationKind(value.kind) &&
        isBoundedString(value.identifier, MAX_IDENTIFIER_LENGTH) &&
        isBoundedString(value.code, MAX_CODE_LENGTH)
        ? {
            type: 'verify-code',
            kind: value.kind,
            identifier: value.identifier,
            code: value.code,
          }
        : null;
    case 'start-browser':
      return (value.kind === 'social' || value.kind === 'sso') &&
        isBoundedString(value.providerOrConnectionId, MAX_OPAQUE_ID_LENGTH) &&
        isBoundedString(value.label, MAX_OPAQUE_ID_LENGTH)
        ? {
            type: 'start-browser',
            kind: value.kind,
            providerOrConnectionId: value.providerOrConnectionId,
            label: value.label,
          }
        : null;
    case 'select-account':
      return isBoundedString(value.accountId, MAX_OPAQUE_ID_LENGTH)
        ? { type: 'select-account', accountId: value.accountId }
        : null;
    case 'request-sso-verification-code':
      return { type: 'request-sso-verification-code' };
    case 'verify-sso-verification':
      return isBoundedString(value.code, MAX_CODE_LENGTH)
        ? { type: 'verify-sso-verification', code: value.code }
        : null;
    case 'request-binding-code':
      return isBoundedString(value.contact, MAX_IDENTIFIER_LENGTH)
        ? { type: 'request-binding-code', contact: value.contact }
        : null;
    case 'verify-binding':
      return isBoundedString(value.contact, MAX_IDENTIFIER_LENGTH) &&
        isBoundedString(value.code, MAX_CODE_LENGTH)
        ? { type: 'verify-binding', contact: value.contact, code: value.code }
        : null;
    default:
      return null;
  }
}
