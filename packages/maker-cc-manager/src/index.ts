/**
 * @lizi/maker-cc-manager
 *
 * NDJSON RPC daemon spawned on remote SSH machine. Wraps the Claude Agent SDK
 * Query, exposes session/control RPC to local desktop client.
 *
 * Two consumer entry points:
 *   - Local desktop client (RemoteSdkTransport): `import { RpcClient } from
 *     '@lizi/maker-cc-manager/client'`
 *   - Remote daemon binary (bundled via esbuild from src/bin/cc-mgr.ts):
 *     `import { ManagerServer } from '@lizi/maker-cc-manager'`
 *
 * Phase 1 ships protocol + server skeleton + client. Phase 2+ wires SDK
 * Query dispatch on top.
 */

export {
  CC_MGR_BUNDLE_VERSION,
  PROTOCOL_VERSION,
  METHODS,
  NOTIFICATIONS,
  SERVER_METHODS,
  isRpcMessage,
  isRpcRequest,
  isRpcResponse,
  isRpcNotification,
  makeRpcError,
} from './protocol.js';

export type {
  RpcId,
  RpcError,
  RpcErrorCode,
  RpcRequest,
  RpcResponse,
  RpcNotification,
  RpcMessage,
  MethodName,
  NotificationName,
  ServerMethodName,
  HelloParams,
  HelloResult,
  QueryStartParams,
  QueryStartResult,
  QuerySendParams,
  QuerySetModelParams,
  QuerySetPermissionModeParams,
  QueryApplyFlagSettingsParams,
  QueryGetContextUsageParams,
  QueryInterruptParams,
  QueryCloseParams,
  SessionAttachParams,
  SessionAttachResult,
  SessionListParams,
  SessionListEntry,
  SessionListResult,
  SessionKillParams,
  ApprovalRequestParams,
  ApprovalRequestResult,
  QueryEventNotification,
  SessionClosedNotification,
  ClientReplacedNotification,
  McpServerStdioConfig,
  McpServerSseConfig,
  McpServerHttpConfig,
} from './protocol.js';

export { NDJSONDecoder, encodeMessage } from './codec.js';
export type { NDJSONDecoderOptions } from './codec.js';

export { RpcClient, RpcClientError } from './client.js';
export type { RpcClientOptions, RpcRequestOptions, NotificationSubscriber, ServerRequestHandler } from './client.js';

export { createRemoteQuery } from './remote-query.js';
export type {
  RemoteQuery,
  RemoteQueryOptions,
  CreateRemoteQueryOptions,
} from './remote-query.js';

export { ManagerServer } from './server.js';
export type { ManagerServerOptions, ManagerLogger, MethodHandler, ClientCtx } from './server.js';
