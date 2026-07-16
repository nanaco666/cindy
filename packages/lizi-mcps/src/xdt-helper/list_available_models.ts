/**
 * xdt-helper/list_available_models.ts —— 列出每个 agent 当前 host 支持的 model。
 * 用于 create_worker 前确认 model 名拼写, Codex 和 Claude Code 模型不可跨用。
 */

import { BRAND_NAME } from '@lizi/maker-shared/branding';
import { z } from 'zod';

import type { XdtHelperToolRegistry } from '../lizi_xdtHelperToolRegistry.js';
import type { ControlResult } from '../lizi_xdtHelperMcpServer.js';
import { okPayload, errorPayload } from './_payload.js';

export interface ModelDescriptor {
  id: string;
  label: string;
}

/** tier: 'budget' = 「骨折版」(gateway 低价路由), 'standard' = 官方原版。仅出现在返回值, 供 agent 精准选型。 */
type ModelTier = 'budget' | 'standard';

interface TaggedModel extends ModelDescriptor {
  tier: ModelTier;
}

/**
 * 给每个 model 打 tier 标记。
 *
 * 「骨折版」(gateway 低价 codex 路由) 的唯一判定依据是 model id 的 `codex/` 前缀 ——
 * 与 renderer ModelSelector.categorize() 的归类规则保持一致 (codex/* → 「骨折GPT」组),
 * 也与 host CODEX_BUDGET_MODELS 的 id 命名约定一致。据此打 tier 后, agent 不必再从
 * label / description 里语义推断, 直接按 tier 精准匹配用户口中的「骨折版 / 骨折」。
 * label (= host displayName, 同时是 UI 下拉展示名) 不受影响, 保持干净。
 */
function tagTier(models: ModelDescriptor[] | undefined): TaggedModel[] | undefined {
  if (!models) return undefined;
  return models.map((m) => ({
    ...m,
    tier: m.id.startsWith('codex/') ? 'budget' : 'standard',
  }));
}

export interface ListAvailableModelsDeps {
  listAvailableModels: (params: {
    agent?: 'claude-code' | 'codex';
  }) => Promise<ControlResult<{
    codex?: ModelDescriptor[];
    claude_code?: ModelDescriptor[];
  }>>;
}

const DESCRIPTION = [
  '列出每个 agent 当前 host 支持的 model id 清单, 用于 create_worker 前确认 model 名拼写。',
  'Codex 和 Claude Code 支持的 model 完全不同, 不可跨用。',
  '',
  '参数:',
  '- agent: 可选, codex 或 claude-code; 不传返两者',
  '',
  '返回值:',
  '- codex: Codex agent 的可用 model 列表 [{id, label, tier}]',
  '- claude_code: Claude Code agent 的可用 model 列表 [{id, label, tier}]',
  '',
  'tier 字段 (用于精准选型, 不要靠 label 推断):',
  "- tier='budget': 「骨折版 / 骨折 / 骨折GPT」—— codex/ 前缀的 gateway 低价路由 (如 codex/gpt-5.5)",
  "- tier='standard': 官方原版 (如 gpt-5.5)",
  '选型规则: 用户说「骨折版 / 骨折」→ 选 tier=budget 的模型; 说「官方 / 原版 / 普通版」→ 选 tier=standard。',
  '默认规则: 用户只报模型名 (如 "gpt-5.5") 而没说「骨折」时, 一律默认 tier=standard (官方原版); 只有明确出现「骨折 / 骨折版」才允许选 tier=budget。',
  '注意 budget 与 standard 可能 label 同名 (都叫 GPT-5.5), 必须用 tier 区分, 不能只看 label。',
  'tier=budget (骨折版) 仅在 Codex「API key 模式」下可用; OAuth 模式下 create_worker 会返 BUDGET_MODEL_REQUIRES_API_MODE。用户要骨折版时, 若被拒就如实告知需切到 API key 模式。',
].join('\n');

export function registerListAvailableModelsTool(
  registry: XdtHelperToolRegistry,
  deps: ListAvailableModelsDeps,
): void {
  registry.register({
    name: 'list_available_models',
    category: 'control',
    description: DESCRIPTION,
    inputShape: {
      agent: z
        .enum(['codex', 'claude-code'])
        .optional()
        .describe('可选, 只查某一 agent 的 model 列表; 不传返两者'),
    },
    handler: async ({ agent }) => {
      const result = await deps.listAvailableModels({ agent });
      if (!result.ok) {
        if (result.errorCode === 'HOST_NOT_READY') {
          return errorPayload('HOST_NOT_READY', `${BRAND_NAME} 主进程协同服务尚未就绪。`);
        }
        return errorPayload('INTERNAL', result.message);
      }
      return okPayload({
        codex: tagTier(result.codex),
        claude_code: tagTier(result.claude_code),
      });
    },
  });
}