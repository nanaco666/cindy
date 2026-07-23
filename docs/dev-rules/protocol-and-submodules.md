# 协议兼容与 submodule

> **状态**：权威开发规则（authoritative）
> **读取时机**：升级 `cindy-protocol` 或内置插件种子 submodule 指针、修改 device-link
> 协议／relay／隧道 payload／IPC allowlist，或任何改动客户端与服务端之间 wire protocol
> 的地方之前

`cindy-protocol` 是客户端与服务端共享的 wire protocol 权威来源。submodule 指针漂移或
单端改协议会让两端不一致，且这类不一致在本仓的 typecheck／单测里发现不了，只有真实
连接时才暴露。device-link 的运行时约束另见
[`remote-and-mobile-adaptation.md`](remote-and-mobile-adaptation.md)，submodule 初始化命令见
[`environment-setup.md`](environment-setup.md)。

> **增量适用原则**：wire protocol 兼容对所有跨端改动生效，不因是小改而豁免。

## 事实来源

| 内容 | 权威来源 |
|---|---|
| 协议权威源 | 根 submodule `cindy-protocol`（`github.com/xindong/cindy-protocol`） |
| desktop 消费的协议包 | `@cindy/slack-hook-protocol` |
| device-link relay 层定义 | `@cindy/device-link-protocol`；客户端重连、IPC allowlist、隧道 payload 在 `packages/device-link` |
| 内置插件种子 submodule | `apps/desktop/resources/builtin-ghosts/official`（`cindy-official-plugin`）、`.../xd`（`cindy-xd-plugin`） |

## 1. `cindy-protocol` 是协议权威源

- 协议定义以 `cindy-protocol` submodule 为准；desktop 通过 `@cindy/slack-hook-protocol`
  消费，device-link 复用 `@cindy/device-link-protocol` 的 relay 层定义。客户端重连、IPC
  allowlist 与隧道 payload 留在 `packages/device-link`，不在客户端另造一套协议。
- **升级 submodule 指针前必须确认服务端同步升级**，避免两端 wire protocol 漂移。协议是
  跨仓契约，单端先行会让线上连接对不上。

## 2. 内置插件种子 submodule

- 内置插件源码按归属拆为两个种子仓，挂在 `apps/desktop/resources/builtin-ghosts/` 下：
  `official/`（官方插件）与 `xd/`（组织插件），各带一份 provisioning 配置。
- **改内置插件 = 对应子仓提 PR 合入 → 主仓 bump submodule 指针**。种子仓与服务端无 wire
  protocol 漂移问题，bump 时机宽松；dev 下改本地 submodule 文件重启即生效（播种按内容
  指纹收敛）。
- submodule 未初始化时种子根为空：播种层按“半初始化保护”只装不删，不会误删已装插件；
  首次需 `git submodule update --init`（见 [`environment-setup.md`](environment-setup.md)）。

## Review 清单

1. 改动是否触及跨端 wire protocol？是否要同步 `cindy-protocol` 与服务端？
2. 升级 submodule 指针时，是否确认了服务端同步、不会造成协议漂移？
3. 客户端是否在 `packages/device-link` 之外另造了协议或绕过 relay 层定义？
4. 改内置插件是否走“子仓 PR → 主仓 bump 指针”，而不是在主仓直接改种子产物？

协议改动按 [`desktop-development.md`](desktop-development.md) 跑相关测试，并与服务端确认
兼容；submodule 相关操作见 [`environment-setup.md`](environment-setup.md)。
