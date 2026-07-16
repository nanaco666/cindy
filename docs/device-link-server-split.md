# device-link-server 拆分说明

> 给协作开发者的背景文档。说明 device-link(跨设备远程控制)为什么从主 server 拆成独立服务、拆完之后的架构是什么、本地开发怎么跑。

## 为什么拆

device-link 是"同账号多台设备互相远程操控"的后端——WS 长连接中继 + 在线状态(presence)+ 媒体预签名 + 设备管理。它原来跑在主 server(`apps/server`)进程里,带来两个问题:

1. **负载特征不匹配**:device-link 是长连接、高频小帧、对延迟敏感;主 server 是短请求(issue/skillhub/slack)。混在一起无法独立扩容,主 server 重启会断掉所有远程控制连接。
2. **隐私漏洞**:device-link 媒体复用了 skillhub/issue 那个 public-read 的 OSS bucket,上传时没设对象 ACL → 隐私媒体可被裸地址公开访问。

拆分后:
- device-link 变成独立部署的 `device-link-server`(WS + media + devices),可独立重启/扩容,不影响主 server。
- 媒体对象在上传时强制 `x-oss-object-acl: private`,即使在 public bucket 下也逐对象私有。

## 拆完之后的架构

```
client(desktop)
  ├─ WS 控制隧道 ──────────→ device-link-server (wss://xdmaker-device-link.magiclizi.com)
  ├─ REST media/devices ───→ device-link-server
  ├─ 登录(拿 JWT)─────────→ 主 server (https://xdt-api.magiclizi.com)
  └─ 媒体字节 PUT/GET ──────→ OSS (private 对象, 直传直下)

device-link-server
  ├─ 阿里云 Redis(presence / route / 跨实例 pub-sub)
  ├─ 共享主 PostgreSQL(只读写 Device 表, 不 migrate)
  ├─ OSS(RAM 子账号, 限 xdt-maker/device-link/ 前缀)
  └─ 本地验 JWT(共享 JWT_SECRET, 无状态)

主 server
  ├─ 不再连 Redis(device-link 摘除后无 Redis 消费者)
  └─ 仍持有 Device 表的 schema / migration(Prisma)
```

**关键不变量**:
- 被控端 = 唯一真相源,relay = 哑中继(不解析业务 payload),控制端 = 纯镜像。
- 媒体字节走 OSS 旁路,不经 relay(relay 帧上限 2MB)。
- JWT 无状态验签:relay 只验、不签发;和主 server 共享 `JWT_SECRET`。

## 代码位置

| 模块 | 目录 | 职责 |
|------|------|------|
| device-link-server | `apps/device-link-server/` | 独立部署:WS relay + presence + media presign + devices REST |
| 共享协议包 | `packages/device-link/` | Envelope/Client/allowlist/topics(desktop 双端共用) |
| desktop 传输层 | `apps/desktop/src/main/device-link/` | 客户端:WS 连接 + IPC 隧道 + 媒体上传下载 |
| desktop makerTransport | `apps/desktop/src/renderer/lib/makerTransport.ts` | renderer:按 session origin 自动切本地/远程 |
| 主 server | `apps/server/` | 不再包含 device-link 代码;保留 Device 表 schema |

## 本地开发

### 前提

本地跑远程控制功能需要三样东西同时在:

| 服务 | 端口 | 说明 |
|------|------|------|
| 主 server | 3333 | 登录拿 JWT(`pnpm dev:server` 或 `pnpm dev:all`) |
| device-link-server | 3335 | WS + media + devices |
| Redis | 6379 | presence / route / pub-sub |

### 步骤

```bash
# 1. 起本地 Redis(一次性)
docker run -d --name redis-dl -p 6379:6379 redis:7-alpine

# 2. 配 device-link-server 的 .env
cd apps/device-link-server
cp .env.example .env
# 编辑 .env:
#   REDIS_URL=redis://127.0.0.1:6379
#   DATABASE_URL= (填和主 server 一样的本地 PG 连接串)
#   JWT_SECRET=   (填和主 server 一样的 secret)
#   OSS_*=        (填和主 server 一样的 OSS 凭证)

# 3. 起 device-link-server
pnpm -C apps/device-link-server dev

# 4. 起主 server(如果需要本地登录)
pnpm dev:server

# 5. 起桌面端
pnpm restart:desktop:local   # 或 pnpm restart:desktop:remote(连线上登录)
```

桌面端在非 `dev:remote` 模式下默认连 `http://localhost:3335`(device-link),不需要额外配置。

### 如果你不碰远程控制功能

**什么都不用做**。device-link-server 没跑时,远程控制功能不可用(WS 连不上 → 设备列表空),但**不影响其它任何功能**。主 server 和桌面端的其它功能完全独立。

## 客户端怎么决定连哪

`apps/desktop/src/main/device-link/index.ts`:

```typescript
const DEVICE_LINK_API_BASE =
  import.meta.env.VITE_DEVICE_LINK_API_BASE_URL || 'http://localhost:3335';
```

- `dev:remote` / 生产构建:打包脚本注入 `https://xdmaker-device-link.magiclizi.com`
- 本地开发(不设 env):默认 `http://localhost:3335`

WS 地址从这个 base 推导:`http → ws` / `https → wss`。

## 部署(生产)

详见 `apps/device-link-server/DEPLOY.md`(env 清单 / DNS / nginx WS 配置 / docker compose)。

快速命令:
```bash
# 本地产出 release 产物
pnpm release:device-link

# 服务器更新
ssh xdt-server "cd ~/XDMaker/apps/device-link-server/release && ./update.sh"
```

## 注意事项

1. **Device 表 migration 归主 server**(`apps/server/prisma/schema.prisma`):relay 只读写,绝不 migrate。改 Device schema 后照常在主 server 跑 `pnpm db:migrate`。
2. **`JWT_SECRET` 必须一致**:主 server 签发、relay 验签,值不同会导致所有请求 401。
3. **Redis 密码含特殊字符须 URL-encode**:`(` → `%28`,`#` → `%23` 等,否则 ioredis 报 Invalid URL。
4. **OSS 媒体私有化**:device-link 的文件在 public bucket 下靠 per-object `x-oss-object-acl: private` 实现隐私。server 签名时纳入该 header,client PUT 时必须带同名同值 header——**两端必须对齐,否则 OSS 403**。
5. **不要把 `REDIS_URL` / `OSS_ACCESS_KEY_SECRET` / `JWT_SECRET` 这类凭证提交到 git**。
