/**
 * main/im/slack/index.ts
 * ---------------------------------------------------------------------------
 * Wire the slack IM channel up to the shared orchestrator(与 feishu/index.ts
 * 对位)— 本文件只组装 slack adapter, 编排逻辑全部在 im/shared/。
 */

import type { SlackIM } from 'lizi-im';

import { createImOrchestrator } from '../shared/orchestrator';
import type { ImOrchestratorConfig } from '../shared/types';
import { buildSlackAdapter } from './adapter';

export { createSlackRelayTransport } from './transport';

export function wireSlackOrchestrator(
  slackIm: SlackIM,
  config: ImOrchestratorConfig,
): void {
  createImOrchestrator(buildSlackAdapter(slackIm, config));
}
