import { createCindyProxyMediaService } from '../cindy-proxy-media/service.js';
import type { CindyProxyMediaService } from '../cindy-proxy-media/types.js';
import { createSeedanceProvider } from '../cindy-proxy-media/video/providers/seedance.js';
import { createHappyhorseProvider } from '../cindy-proxy-media/video/providers/happyhorse.js';
import { resolveSafe as resolveXdtImage } from '../imageCacheStore.js';
import {
  createBlobImageStorage,
  createBlobVideoStorage,
} from '../cindy-media/generatedMedia.js';
import { createLogger } from '../logger.js';
import { getProviderSecretStore } from '../secrets/providerSecretStore.js';
import { getClientEndpoint } from '../clientEndpointsService.js';

const log = createLogger('art');

let artService: CindyProxyMediaService | null = null;

function readApiKey(): string | null {
  // 本地 only:经统一的 providerSecretStore 读 XD 网关 key。
  return getProviderSecretStore().get('xd');
}

function getXdproxyBaseUrl(): string {
  return getClientEndpoint('xdGatewayBaseUrl');
}

/**
 * xdproxy 图像/视频后端单例。lizi_art MCP 工具层已退役(2026-07-12),
 * 本服务不再对 agent 暴露工具,只作为 host 侧链路的后端:
 * - cindy 槽(意识代办 gen/edit image + video,见 cindy-brain/index.ts)。
 * (mivo 装配已随 lizi_mivo MCP 退役移除,2026-07-13,能力在意识 xd-mivo。)
 */
export function getCindyProxyMediaService(): CindyProxyMediaService {
  if (!artService) {
    // 产物存储走 cindy-media 媒体总仓(规则 25;内容寻址 blob,
    // URL = cindy-media://blobs/<hash>.<ext>)。老 lizi-art-media 目录冻结只读,
    // 历史 xdt-image:// 地址由 resolveLegacyImageRef 继续服务(改历史图场景)。
    const mediaStore = createBlobImageStorage({
      resolveLegacyImageRef: (ref) => resolveXdtImage(ref),
    });
    const videoStore = createBlobVideoStorage();
    // 视频 provider 装配点 — 加新模型(kling/luma/wan)就在这个数组追加一行,
    // cindy 槽 handler / 渲染层 / 协议层零改动。
    //
    // 顺序敏感:数组首个 alias 就是出厂默认(XDPROXY_VIDEO_MODELS 首项同源
    // 守卫锁定),seedance-fast 必须永远排第一个。happyhorse 是 opt-in,
    // 只有用户显式点名才切。
    const videoProviders = [
      createSeedanceProvider({
        baseUrl: getXdproxyBaseUrl(),
        getApiKey: readApiKey,
        logger: log,
      }),
      createHappyhorseProvider({
        baseUrl: getXdproxyBaseUrl(),
        getApiKey: readApiKey,
        logger: log,
      }),
    ];
    artService = createCindyProxyMediaService({
      imageApi: {
        getApiKey: readApiKey,
        proxy: {
          baseUrl: getXdproxyBaseUrl(),
          generatePath: '/v1/images/generations',
          editPath: '/v1/images/edits',
        },
      },
      storage: {
        saveImage: mediaStore.saveImage,
        resolveImageRef: mediaStore.resolveImageRef,
      },
      videoProviders,
      videoStorage: {
        saveVideo: videoStore.saveVideo,
      },
      logger: log,
    });
  }
  return artService;
}
