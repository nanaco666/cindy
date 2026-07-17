import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

// Windows checkout(core.autocrlf)下源码是 CRLF;统一归一成 LF,含 \n 的多行片段断言才跨平台成立。
const readTextLf = (...args: Parameters<typeof readFileSync>): string =>
  String(readFileSync(...args)).replace(/\r\n/g, '\n');

/**
 * payload 查看器(fullScreen Modal)内 WebView 延迟挂载的接线断言(源码字符串模式,
 * 同 messageMediaThumbnailWiring):iOS 上 fullScreen Modal 在独立 UIWindow + 呈现动画
 * 期间就挂载 body,此刻 WKWebView 未稳定 attach,页内网络加载(mermaid CDN 注入脚本、
 * 媒体播放器资源)会失败——mermaid 停在首屏源码不渲染。WebView 必须等 Modal onShow
 * (动画完成、已 attach)后再挂载;本测试防止后续重构悄悄拆掉该 gating。
 */
describe('mobile payload modal webview gating', () => {
  const rendererSource = readTextLf(resolve(process.cwd(), 'src/session/MessageRenderer.tsx'), 'utf8');
  const modalSection = rendererSource.slice(
    rendererSource.indexOf('function MessagePayloadModal'),
    rendererSource.indexOf('function MessagePayloadBody'),
  );
  const bodySection = rendererSource.slice(rendererSource.indexOf('function MessagePayloadBody'));

  it('modal 在 onShow 置 contentReady(带迟到竞态守卫)、payload 清空时复位,并透传给 body', () => {
    // onShow 迟到守卫:极快开关时 payload 已清空,迟到的 onShow 不许把 ready 置回 true
    expect(modalSection).toContain('onShow={() => { if (payload) setContentReady(true); }}');
    expect(modalSection).toContain('if (!payload) setContentReady(false);');
    expect(modalSection).toContain('contentReady={contentReady}');
  });

  it('mermaid 与音视频播放器的 WebView 都在 contentReady 后才挂载', () => {
    expect(bodySection).toMatch(/contentReady \? \(\s*<MermaidDiagramWebView/);
    expect(bodySection).toMatch(/contentReady \? \(\s*<RemoteMediaPlayerWebView/);
  });

  it('消息列表内联 mermaid 不受 gating 影响(仅详情 Modal 延迟)', () => {
    // 内联块在 MessagePayloadBody 之前的正文渲染段,保持无条件挂载。
    const inlineSection = rendererSource.slice(0, rendererSource.indexOf('function MessagePayloadModal'));
    expect(inlineSection).toContain('<MermaidDiagramWebView source={block.text}');
    expect(inlineSection).not.toMatch(/contentReady \? \(\s*<MermaidDiagramWebView/);
  });
});
