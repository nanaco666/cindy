/**
 * VENDORED from larksuite/lark-openapi-mcp @ v0.5.1
 * Source: src/mcp-tool/tools/en/gen-tools/zod/board_v1.ts
 * License: MIT — Copyright (c) 2025 Lark Technologies Pte. Ltd.
 *          (full text in ../LICENSE.lark-openapi-mcp)
 * DO NOT EDIT BY HAND. Regenerate: node packages/lizi-mcps/scripts/sync-lark-tools.mjs
 */
import { z } from 'zod';
export type boardV1ToolName = 'board.v1.whiteboardNode.list';
export const boardV1WhiteboardNodeList = {
  project: 'board',
  name: 'board.v1.whiteboardNode.list',
  sdkName: 'board.v1.whiteboardNode.list',
  path: '/open-apis/board/v1/whiteboards/:whiteboard_id/nodes',
  httpMethod: 'GET',
  description: '[Feishu/Lark]-Docs-Board-nodes-list nodes-Obtain all nodes of a board',
  accessTokens: ['tenant', 'user'],
  schema: {
    path: z.object({ whiteboard_id: z.string().describe('The unique identification of the board') }),
    useUAT: z.boolean().describe('Use user access token, otherwise use tenant access token').optional(),
  },
};
export const boardV1Tools = [boardV1WhiteboardNodeList];
