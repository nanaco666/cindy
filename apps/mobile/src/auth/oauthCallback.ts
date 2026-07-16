export interface OAuthCallbackPayload {
  code: string;
  state: string;
}

export function parseOAuthCallbackUrl(rawUrl: string): OAuthCallbackPayload {
  let url: URL;
  try {
    url = new URL(rawUrl.trim());
  } catch {
    throw new Error('请输入完整的飞书 callback URL');
  }

  const error = url.searchParams.get('error');
  if (error) throw new Error(`飞书登录失败: ${error}`);

  const code = url.searchParams.get('code');
  if (!code) throw new Error('callback URL 缺少 code');

  const state = url.searchParams.get('state');
  if (!state) throw new Error('callback URL 缺少 state');

  return { code, state };
}
