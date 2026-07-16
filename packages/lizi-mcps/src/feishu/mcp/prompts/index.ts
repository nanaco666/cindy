/**
 * Auto-loads every `prompts/tools/*.md` and `prompts/rules/*.md` so adding a
 * new prompt only requires creating the file (no second import to maintain).
 *
 * Vite/Vitest evaluates `import.meta.glob(..., { eager: true })` at build time;
 * the markdown bodies are inlined into the bundle.
 */

function loadDir(modules: Record<string, unknown>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [filePath, mod] of Object.entries(modules)) {
    const base = filePath.split(/[\\/]/).pop() ?? filePath;
    const key = base.replace(/\.md$/, '');
    const body = (mod as { default?: unknown })?.default;
    if (typeof body === 'string') out[key] = body.trim();
  }
  return out;
}

/** tool name → description body. */
export const TOOL_DESCRIPTIONS: Record<string, string> = loadDir(
  import.meta.glob('./tools/*.md', { eager: true, query: '?raw' }),
);

/** rule key → markdown body, bundled into `feishu_list_tools` responses. */
export const RULES: Record<string, string> = loadDir(
  import.meta.glob('./rules/*.md', { eager: true, query: '?raw' }),
);
