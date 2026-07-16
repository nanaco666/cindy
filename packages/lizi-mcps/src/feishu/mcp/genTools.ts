/**
 * genTools.ts
 * ---------------------------------------------------------------------------
 * Full-coverage Feishu OpenAPI tools, sourced from the vendored official
 * definitions (`generated/`, synced from larksuite/lark-openapi-mcp, MIT) and
 * dispatched through OUR auth + progressive-disclosure layer.
 *
 * Each vendored def is self-contained: `{ project, name, path, httpMethod,
 * description, accessTokens, schema }`. The `schema` is a zod raw shape with
 * keys `path` / `params` / `data` / `useUAT`, used directly as a tool's
 * `inputShape`. Dispatch = substitute `:param` in `path` from `args.path`,
 * attach `args.params` as query and `args.data` as body, then call the host's
 * `callOpenApi` (which wraps `client.request` with our user-token auth-retry).
 *
 * Why a self-templating dispatcher: the SDK's generic `client.request` does
 * NOT substitute `:meeting_id` in the URL (that only happens inside the
 * per-resource SDK methods). So we template the path ourselves before calling
 * `callOpenApi`.
 *
 * These register into the same FeishuToolRegistry as the hand-written premium
 * tools, behind the same `list_tools` / `call_tool` entry tools — so the
 * agent's top-level tool list (and the cached prompt prefix) is unchanged.
 */
import type { z } from 'zod';
import type { FeishuApiResult } from '../../types.js';
import type {
  FeishuToolHandler,
  FeishuToolRegistry,
  FeishuToolResult,
} from './toolRegistry.js';
import { GEN_TOOLS } from './generated/index.js';

type HttpMethod = 'GET' | 'PUT' | 'POST' | 'PATCH' | 'DELETE';

/** Shape of one vendored Lark OpenAPI tool definition. */
export interface LarkGenToolDef {
  project: string;
  name: string;
  sdkName: string;
  path: string;
  /** Loose — the vendored literals widen to `string`; cast at dispatch. */
  httpMethod: string;
  description: string;
  accessTokens: string[];
  schema: z.ZodRawShape;
}

/** Host-provided dispatch dependencies (live inside `createFeishuMcpServer`). */
export type CallOpenApi = (
  method: HttpMethod,
  url: string,
  payload?: { params?: Record<string, unknown>; data?: unknown },
) => Promise<FeishuApiResult>;
export type FormatToolResult = (result: FeishuApiResult) => FeishuToolResult;

/** Thrown by {@link fillPath} when a required `:param` is absent from args. */
export class MissingPathParamError extends Error {
  constructor(public readonly param: string) {
    super(`missing path param: ${param}`);
    this.name = 'MissingPathParamError';
  }
}

/**
 * Substitute `:name` segments in an OpenAPI path template from `pathArgs`.
 * URL-encodes each value. Throws {@link MissingPathParamError} if a segment
 * has no corresponding (non-null) value. Templates without `:params` pass
 * through unchanged.
 */
export function fillPath(
  template: string,
  pathArgs: Record<string, unknown> = {},
): string {
  return template.replace(/:([A-Za-z0-9_]+)/g, (_full, key: string) => {
    const v = pathArgs[key];
    if (v === undefined || v === null || v === '') {
      throw new MissingPathParamError(key);
    }
    return encodeURIComponent(String(v));
  });
}

/**
 * On a failed generated-tool call, attach a breadcrumb (endpoint) and a hint
 * that the failure may be a missing OAuth scope (configured outside this repo).
 * No-op on success and on AUTH_EXPIRED (which already carries its own guidance).
 * Phase 3 will narrow this to a dedicated PERMISSION_SCOPE errorCode.
 */
export function decorateScopeHint(
  result: FeishuApiResult,
  def: LarkGenToolDef,
): FeishuApiResult {
  if (result.ok || result.errorCode === 'AUTH_EXPIRED') return result;
  const base =
    result.data && typeof result.data === 'object'
      ? (result.data as Record<string, unknown>)
      : { value: result.data };
  return {
    ...result,
    data: {
      ...base,
      endpoint: `${def.httpMethod} ${def.path}`,
      scope_hint:
        '若为权限 / scope 报错:需在飞书开放平台为该 OAuth 应用添加此接口对应的 scope(代码外配置)。',
    },
  };
}

/**
 * Map a Feishu OpenAPI `project` to a tool category. Defaults to the project
 * name; aliases only fold *synonym* projects into the SAME category bucket as
 * our premium hand-written tools so an agent browsing e.g. `docx` sees both.
 *
 * Note: `drive` is intentionally NOT aliased to `docx`. drive = cloud files
 * (upload/list/meta) is a distinct surface from docx = document content, so it
 * keeps its own `drive` category and is discoverable via
 * `list_tools({ category: "drive" })`.
 */
const PROJECT_ALIASES: Record<string, string> = {
  docx: 'docx',
  docs: 'docx',
  im: 'im',
  contact: 'contact',
  directory: 'contact',
  calendar: 'calendar',
  minutes: 'minutes',
  sheets: 'sheet',
  bitable: 'bitable',
  base: 'bitable',
  wiki: 'wiki',
};
export function projectToCategory(project: string): string {
  return PROJECT_ALIASES[project] ?? project;
}

/** Build a registry handler that dispatches a vendored def via `callOpenApi`. */
export function makeGenHandler(
  def: LarkGenToolDef,
  callOpenApi: CallOpenApi,
  formatToolResult: FormatToolResult,
): FeishuToolHandler {
  return async (args: Record<string, unknown>) => {
    const pathArgs = (args.path as Record<string, unknown> | undefined) ?? {};
    let url: string;
    try {
      url = fillPath(def.path, pathArgs);
    } catch (e) {
      if (e instanceof MissingPathParamError) {
        return formatToolResult({
          ok: false,
          errorCode: 'INVALID_ARGS',
          data: {
            tool: def.name,
            missing_path_param: e.param,
            hint: `路径参数 ${e.param} 必填,请放在 args.path.${e.param}`,
          },
        });
      }
      throw e;
    }
    const result = await callOpenApi(def.httpMethod as HttpMethod, url, {
      params: args.params as Record<string, unknown> | undefined,
      data: args.data,
    });
    return formatToolResult(decorateScopeHint(result, def));
  };
}

export interface RegisterGeneratedOptions {
  /** Optional predicate to limit which defs register (e.g. by project). */
  include?: (def: LarkGenToolDef) => boolean;
  /** Override the source defs (defaults to the full vendored GEN_TOOLS). For tests. */
  defs?: LarkGenToolDef[];
}

/**
 * Default-exposed collaboration / content domains, matched on the RAW Feishu
 * `project` (NOT `projectToCategory`, so e.g. `directory` stays excluded even
 * though it aliases into the `contact` category).
 *
 * Everything else — org-admin / HR / finance / physical-access domains such as
 * `directory`, `corehr`, `payroll`, `compensation`, `attendance`, `acs`,
 * `approval`, `hire`, `performance`, `okr`, `mail`, … — is intentionally NOT
 * exposed by default: reading or writing them is high-blast-radius and outside
 * the "access my own collaboration content" scope this MCP targets. They can be
 * opted into deliberately later if a concrete need appears.
 */
const DEFAULT_GENERATED_PROJECTS = new Set<string>([
  'docx',
  'docs',
  'drive',
  'sheets',
  'bitable',
  'base',
  'wiki',
  'im',
  'contact',
  'calendar',
  'vc',
  'minutes',
  'task',
]);

/**
 * Register vendored generated tools into the registry. Default exposure policy
 * is deliberately conservative — only **read-only** endpoints in **collaboration
 * domains** are registered. Skips:
 *   - non-GET (mutating: POST/PUT/PATCH/DELETE) defs — generated write/delete
 *     tools bypass the tailored confirm flows the premium write tools carry, so
 *     they are not exposed by default (premium tools still cover curated writes);
 *   - defs whose raw `project` is not in {@link DEFAULT_GENERATED_PROJECTS}
 *     (sensitive org-admin / HR / finance domains);
 *   - defs not callable with a user_access_token (we only hold a user token);
 *   - names already taken by a hand-written premium tool (never shadow it);
 *   - defs filtered out by `opts.include`.
 * Returns counts for a startup log line.
 */
export function registerGeneratedTools(
  registry: FeishuToolRegistry,
  callOpenApi: CallOpenApi,
  formatToolResult: FormatToolResult,
  opts: RegisterGeneratedOptions = {},
): { registered: number; skipped: number } {
  let registered = 0;
  let skipped = 0;
  const source = opts.defs ?? (GEN_TOOLS as unknown as LarkGenToolDef[]);
  for (const raw of source) {
    if (opts.include && !opts.include(raw)) {
      skipped++;
      continue;
    }
    // Default policy: read-only + collaboration domains only.
    if (raw.httpMethod !== 'GET') {
      skipped++;
      continue;
    }
    if (!DEFAULT_GENERATED_PROJECTS.has(raw.project)) {
      skipped++;
      continue;
    }
    // Skip legacy v1 task endpoints. The `task` project vendors BOTH v1 and v2,
    // but Feishu's v1 Task APIs require separate "historical" OAuth scopes we do
    // not request — v2 is the official successor and embeds v1's collaborator /
    // follower / reminder lists into the task object (read via `task.v2.task.*`).
    // Registering v1 task tools would only advertise endpoints that always fail
    // with permission errors. v2 task reads are covered by the task:* read scopes
    // requested in authManager (PR #267 follow-up).
    if (raw.project === 'task' && raw.name.startsWith('task.v1.')) {
      skipped++;
      continue;
    }
    if (!raw.accessTokens?.includes('user')) {
      skipped++;
      continue;
    }
    if (registry.has(raw.name)) {
      skipped++;
      continue;
    }
    // Strip the upstream `useUAT` selector from the exposed schema. It lets the
    // caller choose tenant- (false) vs user-token (true), but this dispatcher
    // ALWAYS routes through `callOpenApi` (user-token only). Leaving it in would
    // let the model send `useUAT:false` expecting a tenant-token read and have
    // the flag silently ignored — producing confusing scope/data failures. With
    // it dropped, the registry's strict-object validation rejects a stray
    // `useUAT` with a clear INVALID_ARGS instead (PR #267 P2).
    const inputShape: z.ZodRawShape = Object.fromEntries(
      Object.entries(raw.schema).filter(([k]) => k !== 'useUAT'),
    );
    registry.registerRaw({
      name: raw.name,
      category: projectToCategory(raw.project),
      description: raw.description,
      inputShape,
      handler: makeGenHandler(raw, callOpenApi, formatToolResult),
      rules: ['generated-tools'],
    });
    registered++;
  }
  return { registered, skipped };
}
