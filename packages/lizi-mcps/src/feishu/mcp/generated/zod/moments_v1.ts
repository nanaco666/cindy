/**
 * VENDORED from larksuite/lark-openapi-mcp @ v0.5.1
 * Source: src/mcp-tool/tools/en/gen-tools/zod/moments_v1.ts
 * License: MIT — Copyright (c) 2025 Lark Technologies Pte. Ltd.
 *          (full text in ../LICENSE.lark-openapi-mcp)
 * DO NOT EDIT BY HAND. Regenerate: node packages/lizi-mcps/scripts/sync-lark-tools.mjs
 */
import { z } from 'zod';
export type momentsV1ToolName = 'moments.v1.post.get';
export const momentsV1PostGet = {
  project: 'moments',
  name: 'moments.v1.post.get',
  sdkName: 'moments.v1.post.get',
  path: '/open-apis/moments/v1/posts/:post_id',
  httpMethod: 'GET',
  description: '[Feishu/Lark]-Moments-Post-Query post information-Query post entity data information by post id',
  accessTokens: ['tenant'],
  schema: {
    params: z
      .object({ user_id_type: z.enum(['open_id', 'union_id', 'user_id']).describe('User ID type').optional() })
      .optional(),
    path: z.object({
      post_id: z
        .string()
        .describe(
          'Post ID, which can be got from the data returned by the "Publish moment" interface or the "Moment posted" event',
        ),
    }),
  },
};
export const momentsV1Tools = [momentsV1PostGet];
