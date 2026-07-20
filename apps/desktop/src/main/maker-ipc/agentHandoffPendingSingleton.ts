/**
 * session-agent-switch:pending 交接注册表的进程级单例。
 *
 * 为什么要单例:交接注入必须覆盖**所有**把消息送进 agent 的入口——renderer 发送
 * 事务(makerSendTransaction)之外,scheduler runner / IM(飞书)turnRunner /
 * goal 循环都是拿 live session 直接 `session.send` 的直发路径(2026-07-20 审计
 * 实锤),它们各自的 deps 注入链互不相通,靠 register.ts 闭包实例无法触达。
 *
 * 独立成小模块(而不是放 agentHandoff.ts):保持 agentHandoff 零依赖纯函数可测,
 * 本模块承担与 localDb 的接线(静态 import,遵守 main 禁运行时动态 import)。
 *
 * 直发路径的用法(见 scheduler-host/runner.ts、im/shared/turnRunner.ts、
 * goal-host/controller.ts 的调用点):
 *   const handoff = await agentHandoffPending.peek(sessionId);
 *   const outgoing = handoff ? prependHandoffToUserMessage(message, handoff) : message;
 *   const result = await session.send(outgoing, ...);
 *   if (handoff && result.accepted) agentHandoffPending.consume(sessionId);
 */

import { findPendingAgentSwitchHandoff } from '../localDb/ipc/messages.js';
import { createAgentHandoffPendingRegistry } from './agentHandoff.js';

// 查询函数包一层 lambda 在**调用期**解析:单测普遍 vi.mock 了 messages.js 且不含
// 本导出,模块求值期直接引用会让所有传递 import 本单例的 suite 崩在 mock 缺口上;
// 调用期访问失败则落进 registry.peek 的 try/catch(按无 pending 处理),两全。
export const agentHandoffPending = createAgentHandoffPendingRegistry((sessionId) =>
  findPendingAgentSwitchHandoff(sessionId),
);
