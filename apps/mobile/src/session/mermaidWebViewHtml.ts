// ⚠️ 加载结构的硬约束(与 mathWebViewHtml.ts 同一套,改动前先读那边文件头):
// 阻塞式外链 <script src> 在 CDN 请求挂起(弱网,不是快速失败)时会让页面停在
// "Loading Mermaid..." 直到浏览器自身的 TCP 超时(几十秒)。所以本文件必须保持:
// 1. 静态文档零外链资源,图表源码作为首屏内容立即绘制;
// 2. mermaid JS 由内联脚本动态注入,带超时;
// 3. CDN 按顺序 failover(jsdelivr → npmmirror,后者大陆可达性好),
//    全部失败就停留在源码展示,永不长时间空转。
import { repairMermaidSource } from '@lizi/maker-shared/mermaid-autofix';

import { lightColors } from '@/theme/tokens';

export const MOBILE_MERMAID_VERSION = '11.14.0';

/** mermaid CDN 源(按顺序尝试)。 */
export const MOBILE_MERMAID_SCRIPT_URLS: string[] = [
  `https://cdn.jsdelivr.net/npm/mermaid@${MOBILE_MERMAID_VERSION}/dist/mermaid.min.js`,
  `https://registry.npmmirror.com/mermaid/${MOBILE_MERMAID_VERSION}/files/dist/mermaid.min.js`,
];

/** 首选 CDN 源(向后兼容导出;完整降级序列见 MOBILE_MERMAID_SCRIPT_URLS)。 */
export const MOBILE_MERMAID_SCRIPT_URL = MOBILE_MERMAID_SCRIPT_URLS[0];

/** 单个 CDN 源的就绪超时;超时即切下一源,全部失败停留在源码展示(与 KaTeX 同口径)。 */
const MERMAID_CDN_TIMEOUT_MS = 6000;

/** mermaid WebView 主题色(可选,缺省走 light;调用方从 useTheme().colors 注入)。 */
export interface MermaidWebViewColors {
  surfaceChip?: string;
  textPrimary?: string;
  textSecondary?: string;
  textTertiary?: string;
  dark?: boolean;
}

export function buildMermaidWebViewHtml(source: string, theme: MermaidWebViewColors = {}): string {
  const surfaceChip = theme.surfaceChip ?? lightColors.surfaceChip;
  const textPrimary = theme.textPrimary ?? lightColors.textPrimary;
  const textSecondary = theme.textSecondary ?? lightColors.textSecondary;
  const textTertiary = theme.textTertiary ?? lightColors.textTertiary;
  const mermaidTheme = theme.dark ? 'dark' : 'default';
  const trimmed = source.trim();
  const serializedSource = serializeForScript(trimmed);
  // RN 侧预计算确定性修复版(mermaidAutofix):原文 parse 失败时 WebView 内用它
  // 重试一次。无可修项时注入空串,WebView 侧跳过重试直接走源码降级。
  const repaired = repairMermaidSource(trimmed);
  const serializedRepaired = serializeForScript(repaired === trimmed ? '' : repaired);
  const cdnsJson = JSON.stringify(MOBILE_MERMAID_SCRIPT_URLS);
  return `<!doctype html>
<html>
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1, maximum-scale=1" />
  <style>
    html, body {
      margin: 0;
      padding: 0;
      background: ${surfaceChip};
      color: ${textPrimary};
      font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
      overflow: auto;
    }
    #root {
      min-height: 100vh;
      box-sizing: border-box;
      padding: 12px;
      display: flex;
      align-items: center;
      justify-content: center;
    }
    #root > svg {
      max-width: 100%;
      height: auto !important;
    }
    #root.source {
      display: block;
    }
    pre {
      margin: 0;
      white-space: pre-wrap;
      word-break: break-word;
      font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
      font-size: 13px;
      line-height: 1.45;
      color: ${textSecondary};
    }
    .notice {
      margin-bottom: 8px;
      font-size: 12px;
      font-weight: 700;
      color: ${textTertiary};
      text-transform: uppercase;
    }
  </style>
</head>
<body>
  <!-- 首屏立即绘制图表源码(零外链阻塞),mermaid 就绪后原位升级为 SVG。 -->
  <div id="root" class="source"><pre>${escapeHtmlText(trimmed) || '空 Mermaid 图表。'}</pre></div>
  <script>
    const source = ${serializedSource};
    const repairedSource = ${serializedRepaired};
    const root = document.getElementById('root');

    function showSource(label) {
      root.className = 'source';
      const pre = document.createElement('pre');
      pre.textContent = source || '空 Mermaid 图表。';
      root.innerHTML = '';
      if (label) {
        const notice = document.createElement('div');
        notice.className = 'notice';
        notice.textContent = label;
        root.appendChild(notice);
      }
      root.appendChild(pre);
    }

    async function renderMermaid() {
      const trimmed = source.trim();
      if (!trimmed || !window.mermaid) return;
      window.mermaid.initialize({
        startOnLoad: false,
        securityLevel: 'strict',
        theme: '${mermaidTheme}',
        fontFamily: 'inherit',
        flowchart: { useMaxWidth: false },
        sequence: { useMaxWidth: false },
        class: { useMaxWidth: false },
        state: { useMaxWidth: false },
        er: { useMaxWidth: false },
        gantt: { useMaxWidth: false },
        journey: { useMaxWidth: false },
        pie: { useMaxWidth: false }
      });
      try {
        await window.mermaid.parse(trimmed);
        const rendered = await window.mermaid.render('mobile-mermaid-diagram', trimmed);
        root.className = '';
        root.innerHTML = rendered.svg;
      } catch (error) {
        // 原文失败 → 用 RN 侧预算好的修复版重试一次;再失败才降级源码展示。
        if (repairedSource) {
          try {
            await window.mermaid.parse(repairedSource);
            const rendered = await window.mermaid.render('mobile-mermaid-diagram-fixed', repairedSource);
            root.className = '';
            root.innerHTML = rendered.svg;
            return;
          } catch (retryError) {
            // fall through
          }
        }
        showSource('render failed');
      }
    }

    // mermaid JS 动态注入:单源超时 ${MERMAID_CDN_TIMEOUT_MS}ms 即切下一 CDN;
    // 全部失败停留在首屏源码(不改 DOM,不需要额外降级动作)。
    (function () {
      var cdns = ${cdnsJson};
      if (!source.trim()) return;
      function attempt(i) {
        if (i >= cdns.length) return;
        var done = false;
        var timer = setTimeout(fail, ${MERMAID_CDN_TIMEOUT_MS});
        function fail() {
          if (done) return;
          done = true;
          clearTimeout(timer);
          attempt(i + 1);
        }
        var script = document.createElement('script');
        script.src = cdns[i];
        script.onload = function () {
          if (done) return; // 超时后晚到的旧源不串台
          if (!window.mermaid) { fail(); return; }
          done = true;
          clearTimeout(timer);
          renderMermaid();
        };
        script.onerror = fail;
        document.head.appendChild(script);
      }
      attempt(0);
    })();
  </script>
</body>
</html>`;
}

function escapeHtmlText(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

function serializeForScript(value: string): string {
  return JSON.stringify(value)
    .replace(/</g, '\\u003c')
    .replace(/>/g, '\\u003e')
    .replace(/&/g, '\\u0026')
    .replace(/\u2028/g, '\\u2028')
    .replace(/\u2029/g, '\\u2029');
}
