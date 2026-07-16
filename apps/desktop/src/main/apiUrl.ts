/**
 * Safe URL construction for the `api:request` IPC proxy.
 *
 * The proxy attaches the user's `Authorization: Bearer <token>` to every
 * request, so the target URL must never leave the API origin. The old code
 * did `API_BASE_URL + params.path` with no validation: a renderer-supplied
 * path like `@evil.com/x` or `//evil.com/x` turned the target into an
 * attacker host, exfiltrating the session token (and enabling SSRF). This
 * helper only accepts a rooted, same-origin relative path and otherwise
 * throws, so the caller can refuse the request.
 */

/**
 * Resolve a renderer-supplied API path against the trusted base, rejecting
 * anything that would escape the base origin.
 *
 * Accepts only a rooted relative path (`/api/...`). Rejects absolute URLs,
 * protocol-relative (`//host`) and backslash-authority (`/\host`) forms, and
 * — as defense in depth — any input whose resolved origin differs from the
 * base. Returns the absolute URL string to fetch.
 */
export function buildApiUrl(base: string, apiPath: unknown): string {
  if (typeof apiPath !== 'string' || apiPath.length === 0 || apiPath[0] !== '/') {
    throw new Error(`api:request rejected non-rooted path: ${String(apiPath)}`);
  }
  // `//host` (protocol-relative) and `/\host` (backslash authority, which the
  // WHATWG URL parser treats like `//` for special schemes) both smuggle an
  // authority past a naive "starts with /" check.
  if (apiPath[1] === '/' || apiPath[1] === '\\') {
    throw new Error(`api:request rejected authority-like path: ${apiPath}`);
  }
  const baseOrigin = new URL(base).origin;
  const resolved = new URL(apiPath, base);
  if (resolved.origin !== baseOrigin) {
    throw new Error(`api:request path escapes base origin: ${apiPath}`);
  }
  return resolved.toString();
}
