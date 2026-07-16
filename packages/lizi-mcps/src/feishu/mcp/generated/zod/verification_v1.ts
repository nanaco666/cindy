/**
 * VENDORED from larksuite/lark-openapi-mcp @ v0.5.1
 * Source: src/mcp-tool/tools/en/gen-tools/zod/verification_v1.ts
 * License: MIT — Copyright (c) 2025 Lark Technologies Pte. Ltd.
 *          (full text in ../LICENSE.lark-openapi-mcp)
 * DO NOT EDIT BY HAND. Regenerate: node packages/lizi-mcps/scripts/sync-lark-tools.mjs
 */
import { z } from 'zod';
export type verificationV1ToolName = 'verification.v1.verification.get';
export const verificationV1VerificationGet = {
  project: 'verification',
  name: 'verification.v1.verification.get',
  sdkName: 'verification.v1.verification.get',
  path: '/open-apis/verification/v1/verification',
  httpMethod: 'GET',
  description: '[Feishu/Lark]-Verification Information-Obtain verification information',
  accessTokens: ['tenant'],
  schema: {},
};
export const verificationV1Tools = [verificationV1VerificationGet];
