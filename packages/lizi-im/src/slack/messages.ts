/**
 * slack/messages.ts — Slack transport 层占位文案。
 * ---------------------------------------------------------------------------
 * 流式占位(思考中 / 图片冲洗中 / 文件打包中 / 已送达 / 空回复)是渠道无关的
 * 产品文案, 单一来源在 feishu/messages.ts 的 `streaming` 分组 — 这里直接
 * 复用, 避免双渠道文案漂移。
 */

import { messages as feishuTransportMessages } from '../feishu/messages.js';

export const streaming = feishuTransportMessages.streaming;
