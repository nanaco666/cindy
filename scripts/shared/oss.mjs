// =============================================================================
// 共享 OSS/CDN 发布原语 — 供 desktop 发布脚本(经 apps/desktop/scripts/ci/lib.mjs
// re-export)与 mobile 自托管 OTA 脚本(release-ios-*.mjs)共用。
//
// 这里只放与项目无关的纯原语:sha256 / gzip / ali-oss client / 带分片+重试的上传。
// 不含任何 manifest 业务逻辑(desktop 的 CDN manifest 拼装仍留在 ci/lib.mjs,
// mobile 的 Expo 协议 manifest 由其自身脚本负责)。
//
// ali-oss 已 hoist 到仓库根 node_modules,故本文件(位于仓库根 scripts/shared/)
// 可经 createRequire 直接解析;createOSSClient() 保持无参签名,与原 ci/lib.mjs 一致。
// =============================================================================

import fs from 'node:fs';
import crypto from 'node:crypto';
import { createGzip } from 'node:zlib';
import { pipeline } from 'node:stream/promises';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const OSS = require('ali-oss');

import {
  resolveCdnBaseUrl,
  resolveProductionEndpointsPath,
} from './production-endpoints.mjs';

// CDN / OSS 目标(dev 环境)。四项均可被环境变量覆盖(默认值不变,不影响既有发布线):
// XDT_CDN_BASE_URL / XDT_OSS_BUCKET / XDT_OSS_PREFIX / XDT_OSS_REGION。
//
// 【存储类别】本文件及所有发布脚本只涉及 Public 类(匿名公开读:安装包/热更/
// agent 二进制/公告/模型目录/手机 OTA 与分发),后续拆桶时这里整体指向 public 桶。
// Private 类(skillhub 技能包、device-link 媒体)走 server 预签名,配置在
// apps/server 与 apps/device-link-server 的 OSS_PUBLIC_BUCKET / OSS_PRIVATE_BUCKET。
// 覆盖 bucket 时记得同步覆盖 CDN_BASE(CDN 域名要指向同一个 bucket),否则上传去了
// 新桶、release.json 里的链接却指向旧桶,装机端会 404。
//
// 部分 desktop 发布入口会先静态 import 本模块、再从 apps/desktop/.env 补环境变量。
// ESM 依赖会先于消费模块求值,所以配置不能永久冻结在首次 import 的时刻。
export function resolveOssConfig() {
  return {
    cdnBase: resolveCdnBaseUrl(),
    bucket: process.env.XDT_OSS_BUCKET || 'smash-dev',
    prefix: process.env.XDT_OSS_PREFIX || 'xdt-maker',
    region: process.env.XDT_OSS_REGION || 'oss-cn-shanghai',
  };
}

// 保留既有 named export 面,但改为 live binding；任何晚加载 .env 的入口必须在加载后
// 调 refreshOssConfig()。createOSSClient() 自身仍会在调用时重新解析,避免连错 bucket。
export let CDN_BASE;
export let OSS_BUCKET = process.env.XDT_OSS_BUCKET || 'smash-dev';
export let OSS_PREFIX = process.env.XDT_OSS_PREFIX || 'cindy';
export let OSS_REGION = process.env.XDT_OSS_REGION || 'oss-cn-shanghai';

export function refreshOssConfig() {
  const config = resolveOssConfig();
  CDN_BASE = config.cdnBase;
  OSS_BUCKET = config.bucket;
  OSS_PREFIX = config.prefix;
  OSS_REGION = config.region;
  return config;
}

// 工具库本身会被普通测试和只读脚本 import。没有私有配置时允许完成 import，
// 但任何真正需要 CDN 的入口仍必须调用 refreshOssConfig()/resolveOssConfig()，
// 届时会按 production-endpoints 的 fail-closed 规则明确报错。
if (
  process.env.XDT_CDN_BASE_URL?.trim() ||
  fs.existsSync(resolveProductionEndpointsPath())
) {
  refreshOssConfig();
}

// ── 哈希 / 压缩 ──────────────────────────────────────────────────────────────

export function sha256(filePath) {
  const hash = crypto.createHash('sha256');
  const data = fs.readFileSync(filePath);
  hash.update(data);
  return hash.digest('hex');
}

export async function gzipFile(srcPath, destPath) {
  const src = fs.createReadStream(srcPath);
  const dest = fs.createWriteStream(destPath);
  const gzip = createGzip();
  await pipeline(src, gzip, dest);
}

// ── 阿里云 OSS ─────────────────────────────────────────────────────────────

// 凭证从环境变量读取,不进仓库。缺失时直接终止(release 脚本上下文,快速失败)。
function getAKSK() {
  const accessKeyId = process.env.FP_DEV_OSS_ACCESS_KEY_ID;
  const accessKeySecret = process.env.FP_DEV_OSS_ACCESS_KEY_SECRET;
  if (!accessKeyId || !accessKeySecret) {
    console.error('ERROR: FP_DEV_OSS_ACCESS_KEY_ID and FP_DEV_OSS_ACCESS_KEY_SECRET must be set');
    process.exit(1);
  }
  return { accessKeyId, accessKeySecret };
}

export function createOSSClient() {
  const { accessKeyId, accessKeySecret } = getAKSK();
  const { region, bucket } = resolveOssConfig();
  return new OSS({
    region,
    accessKeyId,
    accessKeySecret,
    bucket,
    timeout: 600_000, // 10 min
  });
}

const MULTIPART_THRESHOLD = 10 * 1024 * 1024; // 10 MB

export async function uploadToOSS(client, ossKey, localPath, options = {}) {
  const MAX_RETRIES = 3;
  const size = fs.statSync(localPath).size;
  if (size > MULTIPART_THRESHOLD) {
    let lastPercent = 0;
    let checkpoint;
    for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
      try {
        await client.multipartUpload(ossKey, localPath, {
          parallel: 4,
          partSize: 5 * 1024 * 1024,
          headers: options.headers,
          meta: options.meta, // 版本化二进制 immutable guard 靠 gz/binary sha256 meta,>10MB 也不能丢
          checkpoint,
          progress(p, _checkpoint) {
            checkpoint = _checkpoint;
            const pct = Math.floor(p * 100);
            if (pct >= lastPercent + 10) {
              lastPercent = pct;
              console.log(`      ${pct}%`);
            }
          },
        });
        break;
      } catch (err) {
        if (attempt === MAX_RETRIES) throw err;
        const delay = attempt * 3;
        console.warn(`      Upload failed (attempt ${attempt}/${MAX_RETRIES}): ${err.message}`);
        console.warn(`      Retrying in ${delay}s (resuming from checkpoint)...`);
        await new Promise((r) => setTimeout(r, delay * 1000));
      }
    }
  } else {
    await client.put(ossKey, localPath, options);
  }
}
