/**
 * clientEndpointsService.ts
 * ---------------------------------------------------------------------------
 * 客户端远程端点清单(OSS `config/client-endpoints.json`)的 desktop 宿主层。
 *
 * 语义是**清单即唯一事实源 + 阻断式**(2026-07 与 Lizi 定案,两次收紧):
 * app.ready 内、createWindow / 一切更新检查之前拉取清单;拉不到 / 清单非法 /
 * 任一字段缺失 → 弹系统错误框(重试 / 退出),用户不重试成功就不放行启动。
 * **没有缓存回退、没有超时后静默继续、没有逐字段烘焙回退**——packaged 下生效
 * 的端点全部来自清单,CDN 配置错任何一点都在启动时立刻暴露,不被本地值掩盖。
 *
 * 共享逻辑(schema / 全字段必填校验)在 @lizi/maker-shared/client-endpoints;
 * 本文件负责 desktop 侧 IO:
 *  - CDN 拉取:复用 manifestService.ensureBaseUrl()(内外网探测)+ net.request。
 *    **拉清单的 CDN base 是烘焙常量**——自举必需,也防"清单配错把自己锁死";
 *  - renderer 消费:sendSync IPC `client-endpoints:get-sync`(首帧同步可用)。
 *
 * 烘焙值(bakedClientEndpoints)仅服务 dev 路径:dev 模式(app 未打包)跳过
 * 拉取,直接用构建期 .env 值,行为与引入清单前完全一致;packaged 正常流程
 * 永远读清单解析结果。
 *
 * 有意不接入:manifestService / updateService 的更新链继续用烘焙 CDN 常量——
 * 更新基础设施是"逃生舱",清单事故时仍能靠热更修复(且本服务先于更新检查阻断,
 * 更新链拿不到清单值也不需要)。
 */

import { app, dialog, ipcMain, net } from 'electron';

import {
  resolveClientEndpointsStrict,
  type ClientEndpointKey,
  type ClientEndpointMap,
} from '@lizi/maker-shared/client-endpoints';

import { createLogger } from './logger';
import { ensureBaseUrl, isDev } from './manifestService';
import {
  API_BASE_URL_DEV_FALLBACK,
  AUTH_BASE_URL_DEV_FALLBACK,
  DEVICE_LINK_API_BASE_DEV_FALLBACK,
  HEARTBEAT_DEFAULT_ENDPOINT,
  SLACK_HOOK_DEFAULT_URL,
  WEBSITE_URL,
  XD_GATEWAY_BASE_URL,
} from '../shared/endpoints';

const log = createLogger('clientEndpoints');

const MANIFEST_RELATIVE_PATH = '/config/client-endpoints.json';
/** 单次请求的网络超时——只用于触发错误框,不是静默降级。 */
const ATTEMPT_TIMEOUT_MS = 15_000;

export const CLIENT_ENDPOINTS_SYNC_CHANNEL = 'client-endpoints:get-sync';

function trimEndpoint(value: string | undefined): string {
  return value?.trim().replace(/\/+$/, '') ?? '';
}

/**
 * dev 专用:构建期 .env 值组装的端点全集(packaged 正常流程不消费本函数,
 * 生效值全部来自清单)。空值语义与引入清单前一致:该能力在当前 dev 构建
 * 未配置,消费点自己的"空则跳过"分支继续生效(如 oauthBroker 回退主 server
 * 老路由)。
 */
export function bakedClientEndpoints(): ClientEndpointMap {
  return {
    apiBaseUrl: trimEndpoint(import.meta.env.VITE_API_BASE_URL) || API_BASE_URL_DEV_FALLBACK,
    // 构建期已按 region 解析出单一 auth 地址;清单同样是 region 化下发的单一字段。
    authApiBaseUrl:
      trimEndpoint(import.meta.env.VITE_CINDY_AUTH_BASE_URL) || AUTH_BASE_URL_DEV_FALLBACK,
    deviceLinkApiBaseUrl:
      trimEndpoint(import.meta.env.VITE_DEVICE_LINK_API_BASE_URL) ||
      DEVICE_LINK_API_BASE_DEV_FALLBACK,
    oauthBrokerApiBaseUrl: trimEndpoint(import.meta.env.VITE_OAUTH_BROKER_API_BASE_URL),
    heartbeatUrl: HEARTBEAT_DEFAULT_ENDPOINT,
    slackHookWsUrl: SLACK_HOOK_DEFAULT_URL,
    websiteUrl: WEBSITE_URL,
    xdGatewayBaseUrl: XD_GATEWAY_BASE_URL,
  };
}

/** net.request 拉清单原文;任何失败(非 200 / 超时 / 异常)返回 null。 */
function fetchTextViaNet(url: string, timeoutMs: number): Promise<string | null> {
  return new Promise((resolve) => {
    try {
      const request = net.request(url);
      let body = '';
      let settled = false;
      const finish = (value: string | null) => {
        if (settled) return;
        settled = true;
        clearTimeout(timeout);
        resolve(value);
      };
      const timeout = setTimeout(() => {
        request.abort();
        finish(null);
      }, timeoutMs);

      request.on('response', (response) => {
        if (response.statusCode !== 200) {
          log.info('HTTP %d for %s', response.statusCode, url);
          finish(null);
          return;
        }
        response.on('data', (chunk) => {
          body += chunk.toString();
        });
        response.on('end', () => finish(body));
        response.on('error', () => finish(null));
      });
      request.on('error', () => finish(null));
      request.end();
    } catch {
      resolve(null);
    }
  });
}

async function fetchManifestTextViaCdn(timeoutMs: number): Promise<string | null> {
  // ensureBaseUrl 只读 shared/endpoints 烘焙常量(内网探测 1500ms 上限)。
  const base = await ensureBaseUrl();
  return fetchTextViaNet(`${base}${MANIFEST_RELATIVE_PATH}?t=${Date.now()}`, timeoutMs);
}

/** 阻断循环的依赖注入面(规则 14:测试用内存 harness 驱动,不起 Electron)。 */
export interface BlockingResolveDeps {
  fetchManifestText(timeoutMs: number): Promise<string | null>;
  /** 拉取/校验失败时问用户;生产实现是系统模态错误框。 */
  promptRetry(reason: string): 'retry' | 'exit';
  exitApp(): void;
  timeoutMs?: number;
}

/**
 * 阻断式解析循环:成功返回完整端点 map;用户选择退出返回 null(调用方不再继续启动)。
 * 失败 → promptRetry → 'retry' 无限重试;没有任何静默降级路径。
 */
export async function resolveClientEndpointsBlocking(
  deps: BlockingResolveDeps,
): Promise<ClientEndpointMap | null> {
  const timeoutMs = deps.timeoutMs ?? ATTEMPT_TIMEOUT_MS;
  for (;;) {
    let rawText: string | null = null;
    try {
      rawText = await deps.fetchManifestText(timeoutMs);
    } catch {
      rawText = null;
    }
    const result = resolveClientEndpointsStrict(rawText);
    if (result.ok) return result.endpoints;
    log.warn(`client endpoints manifest unavailable (${result.reason}), prompting user`);
    if (deps.promptRetry(result.reason) === 'exit') {
      deps.exitApp();
      return null;
    }
  }
}

function promptRetryDialog(reason: string): 'retry' | 'exit' {
  // createWindow 之前无父窗口,showMessageBoxSync 直接系统模态。
  const choice = dialog.showMessageBoxSync({
    type: 'error',
    title: 'Cindy',
    message: '无法获取服务器配置',
    detail:
      `启动所需的服务器端点清单获取失败(${reason})。\n` +
      '请检查网络连接后重试;无法联网时应用不能继续启动。\n\n' +
      `Failed to load the server endpoint manifest (${reason}). ` +
      'Please check your network connection and retry.',
    buttons: ['重试 Retry', '退出 Quit'],
    defaultId: 0,
    cancelId: 1,
    noLink: true,
  });
  return choice === 0 ? 'retry' : 'exit';
}

let resolvedEndpoints: ClientEndpointMap | null = null;
let bakedCache: ClientEndpointMap | null = null;

function baked(): ClientEndpointMap {
  bakedCache ??= bakedClientEndpoints();
  return bakedCache;
}

/**
 * 启动第一步(先于一切更新检查):阻断式解析远程清单。
 * 返回 true = 可以继续启动(dev 跳过或清单已拿到);false = 用户在错误框
 * 选择退出(app.exit 已调用,调用方必须立即 return,不再继续启动流程)。
 */
export async function initClientEndpoints(): Promise<boolean> {
  if (isDev()) {
    log.info('dev mode: using baked endpoints (remote manifest skipped)');
    return true;
  }
  const endpoints = await resolveClientEndpointsBlocking({
    fetchManifestText: fetchManifestTextViaCdn,
    promptRetry: promptRetryDialog,
    exitApp: () => app.exit(1),
  });
  if (endpoints === null) return false; // 用户选择退出,app.exit 已调用
  resolvedEndpoints = endpoints;
  log.info(
    'resolved from remote manifest: api=%s gateway=%s',
    endpoints.apiBaseUrl,
    endpoints.xdGatewayBaseUrl,
  );
  return true;
}

/**
 * 运行期端点读取入口(main 进程)。packaged 下 init 成功后为清单解析值;
 * dev / init 前(smoke-test 等旁路)为烘焙值。
 */
export function getClientEndpoint(key: ClientEndpointKey): string {
  return (resolvedEndpoints ?? baked())[key];
}

export function getResolvedClientEndpoints(): ClientEndpointMap {
  return { ...(resolvedEndpoints ?? baked()) };
}

/** renderer 首帧同步读取(preload 模块级 sendSync);必须在 createWindow() 前注册。 */
export function registerClientEndpointsIpc(): void {
  ipcMain.on(CLIENT_ENDPOINTS_SYNC_CHANNEL, (event) => {
    event.returnValue = getResolvedClientEndpoints();
  });
}

/** 仅测试:重置/注入模块状态。 */
export function resetClientEndpointsForTest(resolved?: ClientEndpointMap): void {
  resolvedEndpoints = resolved ?? null;
  bakedCache = null;
}
