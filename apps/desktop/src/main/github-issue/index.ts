/**
 * github-issue/index.ts —— module holder + 真实依赖接线。
 *
 * register.ts 启动时调 initGithubIssueSubmit(bridge);mcp-providers.ts 通过
 * submitGithubIssueForSession 给 cindy_helper 注入 githubIssue 回调
 * (deferred-lookup:holder 未就绪时返回 HOST_NOT_READY,模式同 OrcaCollabService)。
 */

import os from 'node:os';

import { app } from 'electron';

import { getCurrentMembershipDisplayName } from '../authManager';
import { serverApiFetch } from '../serverApiClient';
import { getClientEndpoint } from '../clientEndpointsService';
import type { IssueConfirmBridge } from './issueConfirmBridge';
import {
  submitGithubIssueWithConfirm,
  type GithubIssueSubmitResult,
  type SubmitIssueRequest,
} from './githubIssueSubmitService';

export { IssueConfirmBridge } from './issueConfirmBridge';
export type { IssueConfirmDecision } from './issueConfirmBridge';

let bridgeHolder: IssueConfirmBridge | null = null;

export function initGithubIssueSubmit(bridge: IssueConfirmBridge): void {
  bridgeHolder = bridge;
}

export async function submitGithubIssueForSession(
  req: SubmitIssueRequest,
): Promise<GithubIssueSubmitResult> {
  const bridge = bridgeHolder;
  if (!bridge) {
    return {
      ok: false,
      errorCode: 'HOST_NOT_READY',
      message: 'Cindy 主进程 issue 提交服务尚未就绪,请告知用户稍等几秒后重试。',
    };
  }
  return submitGithubIssueWithConfirm(
    {
      confirm: (sessionId, draft, env) => bridge.request(sessionId, draft, env),
      postIssue: (body) =>
        serverApiFetch<{ githubIssue: { number: number; url: string } }>(
          '/api/github/issues',
          {
            method: 'POST',
            body,
            // 独立部署的 github-server(cindy-server 仓);登录 JWT 验签与
            // auth-server 同侧,serverApiFetch 的 Bearer 注入/401 刷新照常生效。
            baseUrl: getClientEndpoint('githubApiBaseUrl'),
          },
        ),
      getAppVersion: () => app.getVersion(),
      getOsInfo: () => ({
        platform: process.platform,
        arch: process.arch,
        osVersion: os.release(),
      }),
      getFallbackLocale: () => app.getLocale(),
      getSubmitterName: getCurrentMembershipDisplayName,
    },
    req,
  );
}
