/**
 * githubIssueSubmitService —— submit_github_issue 工具的 main 侧业务体。
 *
 * 流程(规则 9 的代码强制点全部在此):
 *  1. 组环境信息(客户端版本 / OS / 界面语言 fallback)—— agent 不参与;
 *  2. await confirm(确认卡片)—— **唯一**通往 postIssue 的路径,取消/超时直接返回;
 *  3. confirmed 后以用户确认的 title/body/type 为准(用户编辑版优先);
 *  4. body 末尾附 env 块,clamp 到 server 上限后 POST。
 *
 * 模块保持 electron-free,全部依赖注入(规则 14),单测直接调 submitGithubIssueWithConfirm。
 */

import type { IssueConfirmDecision, IssueDraft, IssueEnvInfo } from './issueConfirmBridge';

/** 与 lizi-mcps SubmitGithubIssueDeps['submit'] 的返回契约结构一致(注入点做结构化类型检查)。 */
export type GithubIssueSubmitResult =
  | {
      ok: true;
      issueNumber: number;
      issueUrl: string;
      finalTitle: string;
      editedByUser: boolean;
    }
  | {
      ok: false;
      errorCode:
        | 'USER_CANCELLED'
        | 'CONFIRM_TIMEOUT'
        | 'HOST_NOT_READY'
        | 'AUTH_NOT_READY'
        | 'NETWORK_ERROR'
        | 'SERVER_ERROR';
      message: string;
    };

export interface SubmitIssueRequest {
  sessionId: string;
  title: string;
  body: string;
  type: 'bug' | 'feature';
}

export interface GithubIssueSubmitServiceDeps {
  confirm: (
    sessionId: string,
    draft: IssueDraft,
    env: IssueEnvInfo,
  ) => Promise<IssueConfirmDecision>;
  postIssue: (body: {
    title: string;
    description?: string;
    type: 'bug' | 'feature';
    appVersion: string;
  }) => Promise<{ githubIssue: { number: number; url: string } }>;
  getAppVersion: () => string;
  getOsInfo: () => { platform: string; arch: string; osVersion: string };
  /** main 侧 OS locale,仅当 renderer 未回传 uiLanguage 时兜底。 */
  getFallbackLocale: () => string;
}

// server 侧 github.ts 的上限(TITLE_MAX=200 / DESC_MAX=5000),超限会被 400,这里主动 clamp。
const SERVER_TITLE_MAX = 200;
const SERVER_DESC_MAX = 5000;

export async function submitGithubIssueWithConfirm(
  deps: GithubIssueSubmitServiceDeps,
  req: SubmitIssueRequest,
): Promise<GithubIssueSubmitResult> {
  const env: IssueEnvInfo = {
    appVersion: deps.getAppVersion(),
    ...deps.getOsInfo(),
  };

  const decision = await deps.confirm(
    req.sessionId,
    { title: req.title, body: req.body, type: req.type },
    env,
  );

  if (!decision.confirmed) {
    if (decision.reason === 'timeout') {
      return {
        ok: false,
        errorCode: 'CONFIRM_TIMEOUT',
        message: '确认卡片超时未响应,本次未提交。告知用户可以再说一声重新发起。',
      };
    }
    return {
      ok: false,
      errorCode: 'USER_CANCELLED',
      message: '用户取消了本次 issue 提交。如实告知即可,不要换参数自动重试。',
    };
  }

  // 用户确认版优先 —— agent 传入值在这里被丢弃,代码层保证。
  const finalTitle = decision.title.slice(0, SERVER_TITLE_MAX);
  const editedByUser =
    decision.title !== req.title ||
    decision.body !== req.body ||
    decision.type !== req.type;

  const uiLanguage = decision.uiLanguage ?? deps.getFallbackLocale();
  const envBlock = [
    '',
    '---',
    `**OS**: ${env.platform} ${env.arch} (${env.osVersion})`,
    `**界面语言**: ${uiLanguage}`,
  ].join('\n');
  // env 块必须完整保留,clamp 只裁用户正文部分。
  const bodyBudget = SERVER_DESC_MAX - envBlock.length;
  const description = decision.body.slice(0, Math.max(0, bodyBudget)) + envBlock;

  try {
    const result = await deps.postIssue({
      title: finalTitle,
      description,
      type: decision.type,
      appVersion: env.appVersion,
    });
    return {
      ok: true,
      issueNumber: result.githubIssue.number,
      issueUrl: result.githubIssue.url,
      finalTitle,
      editedByUser,
    };
  } catch (err) {
    return mapPostError(err);
  }
}

/**
 * postIssue 抛错映射。按 ServerApiError 的 statusCode 字段 duck-typing,
 * 避免本模块 import serverApiClient(它依赖 electron net)。
 */
function mapPostError(err: unknown): GithubIssueSubmitResult & { ok: false } {
  const statusCode =
    err && typeof err === 'object' && 'statusCode' in err
      ? (err as { statusCode?: unknown }).statusCode
      : undefined;
  const message = err instanceof Error ? err.message : String(err);
  if (statusCode === 0) {
    return {
      ok: false,
      errorCode: 'NETWORK_ERROR',
      message: `网络不可用,issue 未提交: ${message}`,
    };
  }
  if (statusCode === 401) {
    return {
      ok: false,
      errorCode: 'AUTH_NOT_READY',
      message: `登录态失效,issue 未提交,请用户重新登录后再试: ${message}`,
    };
  }
  return {
    ok: false,
    errorCode: 'SERVER_ERROR',
    message: `服务端拒绝或异常,issue 未提交: ${message}`,
  };
}
