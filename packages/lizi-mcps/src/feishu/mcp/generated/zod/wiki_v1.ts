/**
 * VENDORED from larksuite/lark-openapi-mcp @ v0.5.1
 * Source: src/mcp-tool/tools/en/gen-tools/zod/wiki_v1.ts
 * License: MIT — Copyright (c) 2025 Lark Technologies Pte. Ltd.
 *          (full text in ../LICENSE.lark-openapi-mcp)
 * DO NOT EDIT BY HAND. Regenerate: node packages/lizi-mcps/scripts/sync-lark-tools.mjs
 */
import { z } from 'zod';
export type wikiV1ToolName = 'wiki.v1.node.search';
export const wikiV1NodeSearch = {
  project: 'wiki',
  name: 'wiki.v1.node.search',
  sdkName: 'wiki.v1.node.search',
  path: '/open-apis/wiki/v1/nodes/search',
  httpMethod: 'POST',
  description: '[Feishu/Lark]-Docs-Wiki-Search Wiki',
  accessTokens: ['user'],
  schema: {
    data: z.object({ query: z.string(), space_id: z.string().optional(), node_id: z.string().optional() }),
    params: z.object({ page_token: z.string().optional(), page_size: z.number().optional() }).optional(),
    useUAT: z.boolean().describe('Use user access token, otherwise use tenant access token').optional(),
  },
};
export const wikiV1Tools = [wikiV1NodeSearch];
