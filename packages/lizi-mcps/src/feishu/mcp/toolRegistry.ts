/**
 * feishuToolRegistry.ts
 * ---------------------------------------------------------------------------
 * In-memory registry for fine-grained Feishu tools.
 *
 * Background:
 * Previously every Feishu tool (20 in total) was registered directly on the
 * MCP server, which forced their full schemas into every Agent's system
 * prompt — ~5-8K tokens permanently resident.
 *
 * Now only two entry tools are exposed on the MCP server:
 *   - feishu_list_tools  — lightweight discovery (~150 tokens per category)
 *   - feishu_call_tool   — schema-validated invocation (full schema only on
 *                          validation error, not at startup)
 *
 * Fine-grained tools register here instead of on the McpServer. The two
 * entry tools route through this registry.
 */
import { z } from 'zod';

// ── Types ───────────────────────────────────────────────────────────────────

/**
 * A tool category. Hand-written ("premium") tools use the curated set in
 * {@link PREMIUM_CATEGORIES}; vendored full-coverage tools (see mcp/genTools.ts)
 * register under their Feishu OpenAPI project name (e.g. 'vc', 'approval',
 * 'corehr'), so the type is an open string rather than a closed union.
 */
export type ToolCategory = string;

/** The curated, hand-written tool categories (preferred / shown first). */
export const PREMIUM_CATEGORIES = [
  'docx',
  'wiki',
  'bitable',
  'im',
  'contact',
  'calendar',
  'minutes',
  'sheet',
  'misc',
] as const;

/**
 * MCP tool result shape returned by every fine-grained handler.
 * Mirrors what server.tool()'s callback was returning before.
 *
 * The index signature is required by the MCP SDK's tool callback type.
 */
export type FeishuToolContentBlock =
  | { type: 'text'; text: string }
  | { type: 'image'; data: string; mimeType: string };

export interface FeishuToolResult {
  content: FeishuToolContentBlock[];
  isError?: boolean;
  [k: string]: unknown;
}

/** Handler signature — receives parsed (zod-validated) arguments. */
export type FeishuToolHandler<T = Record<string, unknown>> = (
  args: T,
) => Promise<FeishuToolResult>;

/** A registered tool definition. */
export interface FeishuToolDef {
  name: string;
  category: ToolCategory;
  description: string;
  /**
   * Keys of shared rule documents that apply to this tool. The registry stores
   * only keys; the actual markdown lives in a parallel rules registry and is
   * bundled into `feishu_list_tools` responses ONCE per category instead of
   * being duplicated in every tool description.
   */
  rules?: string[];
  /** zod raw shape (object of zod schemas), same form previously passed to server.tool(). */
  inputShape: z.ZodRawShape;
  handler: FeishuToolHandler;
  /**
   * True for hand-written "premium" tools (registered via {@link register}),
   * which `list_tools` surfaces first as `recommended`. Vendored full-coverage
   * tools (registered via {@link registerRaw}) leave this falsy and are listed
   * under `more`.
   */
  preferred?: boolean;
}

/** Lightweight summary returned by `list()` — name + description + rule keys. */
export interface FeishuToolSummary {
  name: string;
  category: ToolCategory;
  description: string;
  rules?: string[];
}

// ── Registry ────────────────────────────────────────────────────────────────

export class FeishuToolRegistry {
  private readonly tools = new Map<string, FeishuToolDef>();

  register<T extends z.ZodRawShape>(def: {
    name: string;
    category: ToolCategory;
    description: string;
    rules?: string[];
    inputShape: T;
    handler: FeishuToolHandler<{ [K in keyof T]: z.infer<T[K]> }>;
  }): void {
    if (this.tools.has(def.name)) {
      throw new Error(`[feishuToolRegistry] duplicate tool name: ${def.name}`);
    }
    // Hand-written tools are "preferred" (surfaced first by list_tools).
    this.tools.set(def.name, { ...(def as unknown as FeishuToolDef), preferred: true });
  }

  /**
   * Register a pre-built tool def directly (bypasses the generic inference in
   * `register`). Used by the generated-tools bulk loader (mcp/genTools.ts),
   * whose defs come from vendored data, not literal call sites. Same
   * duplicate-name guard as `register`.
   */
  registerRaw(def: FeishuToolDef): void {
    if (this.tools.has(def.name)) {
      throw new Error(`[feishuToolRegistry] duplicate tool name: ${def.name}`);
    }
    this.tools.set(def.name, def);
  }

  has(name: string): boolean {
    return this.tools.has(name);
  }

  get(name: string): FeishuToolDef | undefined {
    return this.tools.get(name);
  }

  /** Return tool names + descriptions + rule keys, optionally filtered by category. */
  list(category?: ToolCategory): FeishuToolSummary[] {
    const all: FeishuToolSummary[] = [];
    for (const t of this.tools.values()) {
      if (category && t.category !== category) continue;
      all.push({
        name: t.name,
        category: t.category,
        description: t.description,
        ...(t.rules && t.rules.length > 0 ? { rules: t.rules } : {}),
      });
    }
    return all;
  }

  /**
   * Like {@link list} but partitioned into `preferred` (hand-written premium
   * tools) and `generated` (vendored full-coverage tools). Used by
   * `feishu_list_tools` to show premium tools first and collapse/paginate the
   * (potentially hundreds of) generated tools.
   */
  listSplit(category?: ToolCategory): {
    preferred: FeishuToolSummary[];
    generated: FeishuToolSummary[];
  } {
    const preferred: FeishuToolSummary[] = [];
    const generated: FeishuToolSummary[] = [];
    for (const t of this.tools.values()) {
      if (category && t.category !== category) continue;
      const summary: FeishuToolSummary = {
        name: t.name,
        category: t.category,
        description: t.description,
        ...(t.rules && t.rules.length > 0 ? { rules: t.rules } : {}),
      };
      (t.preferred ? preferred : generated).push(summary);
    }
    return { preferred, generated };
  }

  /**
   * Collect the union of rule keys referenced by tools in the given category
   * (or by all tools if category omitted). Used by `feishu_list_tools` to
   * deduplicate shared rule markdown into a single block per response.
   */
  collectRuleKeys(category?: ToolCategory): string[] {
    const set = new Set<string>();
    for (const t of this.tools.values()) {
      if (category && t.category !== category) continue;
      for (const k of t.rules ?? []) set.add(k);
    }
    return Array.from(set);
  }

  /** Return categories that currently have at least one tool registered. */
  listCategories(): ToolCategory[] {
    const set = new Set<ToolCategory>();
    for (const t of this.tools.values()) set.add(t.category);
    return Array.from(set);
  }

  /**
   * Validate args against the tool's zod schema and invoke the handler.
   *
   * On validation failure, returns an MCP error result whose body includes:
   *   - the zod issue list (machine-readable)
   *   - a JSON Schema dump of the expected shape (so the LLM can self-correct)
   *
   * On unknown tool name, returns an UNKNOWN_TOOL error with capped near-match
   * suggestions + a total count (not the full registry dump — see PR #267 P2).
   */
  async call(name: string, rawArgs: unknown): Promise<FeishuToolResult> {
    const def = this.tools.get(name);
    if (!def) {
      // Don't dump the full registry: with the generated full-coverage tools
      // registered, `tools` holds hundreds of entries, and serializing every
      // name on each typo would blow up the turn and defeat the
      // progressive-disclosure model. Surface a few near-matches + a count +
      // a pointer to list_tools instead (see PR #267 review, P2).
      const allNames = Array.from(this.tools.keys());
      const SUGGEST_CAP = 25;
      const needle = name.toLowerCase();
      const near = allNames.filter((n) => {
        const h = n.toLowerCase();
        return h.includes(needle) || needle.includes(h);
      });
      const suggestions = (near.length > 0 ? near : allNames).slice(0, SUGGEST_CAP);
      return {
        content: [
          {
            type: 'text',
            text: JSON.stringify({
              ok: false,
              errorCode: 'UNKNOWN_TOOL',
              data: {
                requested: name,
                available_count: allNames.length,
                suggestions,
                truncated: suggestions.length < allNames.length,
                hint: '工具名不在注册表中。用 list_tools({ category }) 浏览类目,或 list_tools({ category, q }) 按子串搜索;生成的直通工具名形如 project.vN.resource.action。',
              },
            }),
          },
        ],
        isError: true,
      };
    }

    // strict:未知字段直接判失败(而非默默剥掉)。否则 agent 传了拼错 / 不支持的字段会
    // "返回成功、实际忽略",误导其以为生效(典型:camelCase 写成 sessionIds 而非 session_ids)。
    // 失败分支已带 schema + hint,agent 可据此自纠重试。
    const objSchema = z.strictObject(def.inputShape);
    const parsed = objSchema.safeParse(rawArgs ?? {});
    if (!parsed.success) {
      let jsonSchema: unknown;
      try {
        jsonSchema = z.toJSONSchema(objSchema);
      } catch {
        jsonSchema = '<schema serialization failed>';
      }
      return {
        content: [
          {
            type: 'text',
            text: JSON.stringify({
              ok: false,
              errorCode: 'INVALID_ARGS',
              data: {
                tool: name,
                validation_errors: parsed.error.issues,
                schema: jsonSchema,
                hint: '请按 schema 修正参数后重试',
              },
            }),
          },
        ],
        isError: true,
      };
    }

    return def.handler(parsed.data as Record<string, unknown>);
  }
}
