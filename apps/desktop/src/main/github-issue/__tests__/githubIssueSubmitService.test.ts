/**
 * githubIssueSubmitService 单测 —— 确认门(cancelled/timeout 时 postIssue 零调用)、
 * 用户编辑版优先、env 块拼装与 fallback locale、clamp、错误映射。
 */

import { describe, expect, it, vi } from 'vitest';

import {
  submitGithubIssueWithConfirm,
  type GithubIssueSubmitServiceDeps,
} from '../githubIssueSubmitService';
import type { IssueConfirmDecision } from '../issueConfirmBridge';

const REQ = {
  sessionId: 'sess-1',
  title: 'agent 整理的标题标题标题',
  body: '## 现象\nagent 整理的正文,长度足够覆盖最小要求。',
  type: 'bug' as const,
};

function makeDeps(over: Partial<GithubIssueSubmitServiceDeps> = {}) {
  const confirm = vi.fn(
    async (): Promise<IssueConfirmDecision> => ({
      confirmed: true,
      title: REQ.title,
      body: REQ.body,
      type: REQ.type,
      uiLanguage: 'zh-CN',
    }),
  );
  const postIssue = vi.fn<GithubIssueSubmitServiceDeps['postIssue']>(
    async () => ({
      githubIssue: { number: 80, url: 'https://github.com/xindong/XDMaker/issues/80' },
    }),
  );
  const deps: GithubIssueSubmitServiceDeps = {
    confirm,
    postIssue,
    getAppVersion: () => '0.0.112',
    getOsInfo: () => ({ platform: 'darwin', arch: 'arm64', osVersion: '25.5.0' }),
    getFallbackLocale: () => 'en',
    getSubmitterName: () => 'Dash',
    ...over,
  };
  return { deps, confirm, postIssue };
}

describe('submitGithubIssueWithConfirm', () => {
  it('确认门: cancelled / timeout 时 postIssue 零调用', async () => {
    for (const [reason, errorCode] of [
      ['cancelled', 'USER_CANCELLED'],
      ['timeout', 'CONFIRM_TIMEOUT'],
      ['session_aborted', 'USER_CANCELLED'],
      ['session_closed', 'USER_CANCELLED'],
    ] as const) {
      const { deps, postIssue } = makeDeps({
        confirm: vi.fn(async () => ({ confirmed: false as const, reason })),
      });
      const res = await submitGithubIssueWithConfirm(deps, REQ);
      expect(res).toMatchObject({ ok: false, errorCode });
      expect(postIssue).not.toHaveBeenCalled();
    }
  });

  it('confirm 收到 agent 草稿 + env;confirmed 后 postIssue 收到用户编辑版', async () => {
    const confirm = vi.fn(async (): Promise<IssueConfirmDecision> => ({
      confirmed: true,
      title: '用户改过的标题',
      body: '用户改过的正文',
      type: 'feature',
      uiLanguage: 'ja',
    }));
    const { deps, postIssue } = makeDeps({ confirm });
    const res = await submitGithubIssueWithConfirm(deps, REQ);
    expect(confirm).toHaveBeenCalledWith(
      'sess-1',
      { title: REQ.title, body: REQ.body, type: 'bug' },
      { appVersion: '0.0.112', platform: 'darwin', arch: 'arm64', osVersion: '25.5.0' },
    );
    expect(postIssue).toHaveBeenCalledTimes(1);
    const posted = postIssue.mock.calls[0]![0]();
    expect(posted.title).toBe('用户改过的标题');
    expect(posted.type).toBe('feature');
    expect(posted.appVersion).toBe('0.0.112');
    expect(posted.userName).toBe('Dash');
    expect(posted.description).toContain('用户改过的正文');
    expect(posted.description).toContain('**OS**: darwin arm64 (25.5.0)');
    expect(posted.description).toContain('**界面语言**: ja');
    expect(res).toEqual({
      ok: true,
      issueNumber: 80,
      issueUrl: 'https://github.com/xindong/XDMaker/issues/80',
      finalTitle: '用户改过的标题',
      editedByUser: true,
    });
  });

  it('未编辑时 editedByUser=false;未回传 uiLanguage 时用 fallback locale', async () => {
    const { deps, postIssue } = makeDeps({
      confirm: vi.fn(async () => ({
        confirmed: true as const,
        title: REQ.title,
        body: REQ.body,
        type: REQ.type,
      })),
    });
    const res = await submitGithubIssueWithConfirm(deps, REQ);
    expect(res).toMatchObject({ ok: true, editedByUser: false });
    expect(postIssue.mock.calls[0]![0]().description).toContain('**界面语言**: en');
  });

  it('membership 没有展示名时省略 userName,由 server 回退到 membership id', async () => {
    const { deps, postIssue } = makeDeps({ getSubmitterName: () => undefined });
    const res = await submitGithubIssueWithConfirm(deps, REQ);
    expect(res).toMatchObject({ ok: true });
    expect(postIssue.mock.calls[0]![0]()).not.toHaveProperty('userName');
  });

  it('网络重试重建 body 时重新读取当前 membership 展示名', async () => {
    const getSubmitterName = vi
      .fn<() => string | undefined>()
      .mockReturnValueOnce('Account A')
      .mockReturnValueOnce('Account B');
    const postIssue = vi.fn<GithubIssueSubmitServiceDeps['postIssue']>(async (bodyFactory) => {
      expect(bodyFactory().userName).toBe('Account A');
      expect(bodyFactory().userName).toBe('Account B');
      return { githubIssue: { number: 80, url: 'https://example.com/issues/80' } };
    });
    const { deps } = makeDeps({ getSubmitterName, postIssue });
    const res = await submitGithubIssueWithConfirm(deps, REQ);
    expect(res).toMatchObject({ ok: true });
    expect(getSubmitterName).toHaveBeenCalledTimes(2);
  });

  it('clamp: 超长 body 被裁但 env 块完整保留;超长 title 裁到 200', async () => {
    const longBody = 'x'.repeat(6000);
    const longTitle = 't'.repeat(300);
    const { deps, postIssue } = makeDeps({
      confirm: vi.fn(async () => ({
        confirmed: true as const,
        title: longTitle,
        body: longBody,
        type: 'bug' as const,
        uiLanguage: 'zh-CN',
      })),
    });
    const res = await submitGithubIssueWithConfirm(deps, REQ);
    expect(res).toMatchObject({ ok: true, finalTitle: 't'.repeat(200) });
    const posted = postIssue.mock.calls[0]![0]();
    expect(posted.description!.length).toBeLessThanOrEqual(5000);
    expect(posted.description).toContain('**界面语言**: zh-CN');
  });

  it('postIssue 抛错映射: status 0→NETWORK_ERROR / 401→AUTH_NOT_READY / 500→SERVER_ERROR', async () => {
    for (const [statusCode, errorCode] of [
      [0, 'NETWORK_ERROR'],
      [401, 'AUTH_NOT_READY'],
      [500, 'SERVER_ERROR'],
    ] as const) {
      const err = Object.assign(new Error('boom'), { statusCode });
      const { deps } = makeDeps({ postIssue: vi.fn(async () => Promise.reject(err)) });
      const res = await submitGithubIssueWithConfirm(deps, REQ);
      expect(res).toMatchObject({ ok: false, errorCode });
    }
  });
});
