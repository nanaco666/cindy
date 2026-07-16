/**
 * github-issue/index.ts —— module holder + 真实依赖接线。
 *
 * register.ts 启动时调 initGithubIssueSubmit(bridge);mcp-providers.ts 通过
 * submitGithubIssueForSession 给 lizi_xdt_helper 注入 githubIssue 回调
 * (deferred-lookup:holder 未就绪时返回 HOST_NOT_READY,模式同 OrcaCollabService)。
 */

import os from 'node:os';

import { app } from 'electron';

import { serverApiFetch } from '../serverApiClient';
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
      message: 'xdt-maker 主进程 issue 提交服务尚未就绪,请告知用户稍等几秒后重试。',
    };
  }
  return submitGithubIssueWithConfirm(
    {
      confirm: (sessionId, draft, env) => bridge.request(sessionId, draft, env),
      postIssue: (body) =>
        serverApiFetch<{ githubIssue: { number: number; url: string } }>(
          '/api/github/issues',
          { method: 'POST', body },
        ),
      getAppVersion: () => app.getVersion(),
      getOsInfo: () => ({
        platform: process.platform,
        arch: process.arch,
        osVersion: os.release(),
      }),
      getFallbackLocale: () => app.getLocale(),
    },
    req,
  );
}
