/**
 * gen-feishu-ghost-ops.mts — 把 lizi-mcps vendored 的飞书 OpenAPI 直通面
 * (packages/lizi-mcps/src/feishu/mcp/generated/)烘焙成 xd-feishu 意识
 * main.js 里的静态 GEN_OPS 表。
 *
 * 过滤策略与 genTools.ts 的 registerGeneratedTools 逐条对齐(只读 GET +
 * 协作域 project 白名单 + 排除 task.v1 + 必须支持 user_access_token),
 * 保证意识直通面 = 老 MCP 直通面(name / method / path / 参数记法)。
 *
 * 运行:node_modules/.bin/tsx scripts/gen-feishu-ghost-ops.mts
 * 产物:替换 apps/desktop/resources/builtin-ghosts/xd-feishu/main.js 中
 *       "// <GEN_OPS>" 与 "// </GEN_OPS>" 标记行之间的内容。
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { z } from 'zod';
import { GEN_TOOLS } from '../packages/lizi-mcps/src/feishu/mcp/generated/index.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const MAIN_JS = path.join(
  ROOT,
  'apps/desktop/resources/builtin-ghosts/xd-feishu/main.js',
);

/** 与 genTools.ts DEFAULT_GENERATED_PROJECTS 逐字一致。 */
const DEFAULT_GENERATED_PROJECTS = new Set([
  'docx', 'docs', 'drive', 'sheets', 'bitable', 'base', 'wiki',
  'im', 'contact', 'calendar', 'vc', 'minutes', 'task',
]);

/** 与 genTools.ts PROJECT_ALIASES 逐字一致。 */
const PROJECT_ALIASES: Record<string, string> = {
  docx: 'docx', docs: 'docx', im: 'im', contact: 'contact',
  directory: 'contact', calendar: 'calendar', minutes: 'minutes',
  sheets: 'sheet', bitable: 'bitable', base: 'bitable', wiki: 'wiki',
};
const projectToCategory = (p: string): string => PROJECT_ALIASES[p] ?? p;

interface JsonSchemaObj {
  type?: string;
  properties?: Record<string, JsonSchemaObj>;
  required?: string[];
  items?: JsonSchemaObj;
  enum?: unknown[];
  anyOf?: JsonSchemaObj[];
}

/** 单字段类型后缀::int/:num/:bool/:arr/:obj;string 省略;短枚举内联。 */
function typeSuffix(s: JsonSchemaObj | undefined): string {
  if (!s) return '';
  if (s.enum && s.enum.length > 0) {
    const joined = s.enum.map(String).join('|');
    if (joined.length <= 48) return `:enum(${joined})`;
  }
  if (s.anyOf) return '';
  switch (s.type) {
    case 'integer': return ':int';
    case 'number': return ':num';
    case 'boolean': return ':bool';
    case 'array': {
      const inner = typeSuffix(s.items);
      return inner && !inner.startsWith(':enum') ? `:${inner.slice(1)}[]` : ':arr';
    }
    case 'object': return ':obj';
    default: return '';
  }
}

/** 把一段(path/params/data)对象 schema 压成 "name{a*,b?:int,...}" 记法。 */
function sectionNotation(name: string, schema: JsonSchemaObj, optional: boolean): string {
  if (schema.type !== 'object' || !schema.properties) {
    return `${name}${optional ? '?' : ''}:obj`;
  }
  const required = new Set(schema.required ?? []);
  const fields = Object.entries(schema.properties).map(([k, v]) =>
    `${k}${required.has(k) ? '*' : '?'}${typeSuffix(v)}`,
  );
  return `${name}${optional ? '?' : ''}{${fields.join(',')}}`;
}

interface GenDef {
  project: string;
  name: string;
  path: string;
  httpMethod: string;
  description: string;
  accessTokens: string[];
  schema: Record<string, z.ZodType>;
}

const rows: string[] = [];
let skipped = 0;
for (const raw of GEN_TOOLS as unknown as GenDef[]) {
  if (raw.httpMethod !== 'GET') { skipped++; continue; }
  if (!DEFAULT_GENERATED_PROJECTS.has(raw.project)) { skipped++; continue; }
  if (raw.project === 'task' && raw.name.startsWith('task.v1.')) { skipped++; continue; }
  if (!raw.accessTokens?.includes('user')) { skipped++; continue; }

  const sections: string[] = [];
  for (const key of ['path', 'params', 'data'] as const) {
    const zodSchema = raw.schema[key];
    if (!zodSchema) continue;
    const isOptional = zodSchema.safeParse(undefined).success;
    const json = z.toJSONSchema(zodSchema, { io: 'input' }) as JsonSchemaObj;
    sections.push(sectionNotation(key, json, isOptional));
  }
  const desc = raw.description.replace(/^\[Feishu\/Lark\]-/, '').replace(/'/g, '’');
  const spec = sections.join(' ').replace(/'/g, '’');
  rows.push(
    `gop('${raw.name}', '${projectToCategory(raw.project)}', '${raw.httpMethod}', '${raw.path}', '${desc}', '${spec}');`,
  );
}

const banner =
  `// 由 scripts/gen-feishu-ghost-ops.mts 生成(直通面 ${rows.length} 条,过滤同老 MCP genTools.ts);手改无效,重跑脚本再生成。`;
const block = [banner, ...rows].join('\n');

const src = readFileSync(MAIN_JS, 'utf8');
const re = /(\/\/ <GEN_OPS>)[\s\S]*?(\/\/ <\/GEN_OPS>)/;
if (!re.test(src)) {
  console.error('main.js 缺少 // <GEN_OPS> ... // </GEN_OPS> 标记');
  process.exit(1);
}
// 函数式替换:block 里将来若出现 $& / $' 等序列不得被 replace 特殊解释。
writeFileSync(MAIN_JS, src.replace(re, (_m, open, close) => `${open}\n${block}\n${close}`), 'utf8');
console.log(`GEN_OPS 已写入:${rows.length} 条注册,${skipped} 条按策略跳过。`);
