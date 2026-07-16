# Slack Bot（共享 App）— 架构与测试清单

> 部署 / Slack App 创建见 `apps/server/SLACK_APP_DEPLOY.md`。本文档面向开发者：
> 代码结构、与飞书渠道的共用边界、E2E 测试剧本、双渠道回归清单。

## 代码结构与共用边界

```
flowchart LR 视角(谁依赖谁):

renderer 设置入口已下线(2026-07:SlackBotSection/useSlackBot 已删,渠道由「IM 机器人 → Cindy → Slack」接替;main 侧链路保留服务存量绑定)
   │ IPC: slackBot:get-status / status-change;apiRequest /api/slack/*
desktop main
   ├─ im/shared/*            渠道无关业务编排(orchestrator/turnRunner/slash/卡片/排队/接管)
   ├─ im/feishu/* (adapter)  uiText + sessionIdFor(feishu_*) + vendorOptions{feishuChatId}
   ├─ im/slack/*  (adapter)  uiText + sessionIdFor(slack_{teamId}_{userId}) + vendorOptions{slackChatId}
   │   └─ transport.ts       SSE(net.fetch) + server 代理调用;bot token 不落本机
packages/lizi-im
   ├─ ChannelIM 接口          FeishuIM / SlackIM 共同实现
   ├─ feishu/*               WS 直连(用户自建 App)
   └─ slack/*                SlackIM + Block Kit 映射 + mrkdwn 转换 + 流式 1.3s 节流
apps/server
   ├─ lib/slackSocket.ts     Socket Mode 1 条长连, ack-first, event 去重
   ├─ services/slackRelay    入站路由(SSE 推送 / 离线回复 / slash 映射)
   ├─ services/slackOAuth    Sign in with Slack(OIDC)一键绑定(state JWT/换码/建链)
   ├─ services/slackConnections  SSE 注册表(latest-connection-wins)
   └─ routes/slack.ts        /events /oauth/* /link /proxy /upload /files
packages/lizi-mcps
   └─ lizi_slack_bot         send_file_to_user;isEnabled: vendorOptions.source==='slack'
```

关键不变量：

- **maker-core 零改动**：`vendorOptions` 对 maker-core 是透传黑盒；渠道门控只在
  `lizi-mcps/src/providers.ts`。
- **`im/shared/` 不允许 import 渠道实现**；渠道差异全部经 `ImChannelAdapter` 注入。
- 飞书行为以 `im/feishu/__tests__` + `im/shared/__tests__` 钉死（characterization tests），
  动 shared 层必须保持它们原样通过。
- 接管模式（`/ctr`）`attached → vendorOptions: undefined` 语义两渠道一致。

## E2E 测试剧本（需要真实 Slack workspace + server 配好 token）

按顺序执行；前置：server `SLACK_ENABLED=1`，desktop 已登录。

1. **绑定**：设置 → Slack Bot → 点「连接 Slack 账号」→ 浏览器 Slack 授权页点 Allow
   → 回调页显示成功,bot DM 欢迎语,设置页实时翻成"已绑定/已连接"（无需切 tab/重启）。
   ⚠️ OAuth 回调强制 HTTPS — 本地 server 联调此步需 ngrok 隧道,或在部署环境验收。
2. **对话**:DM 一句话 → 👀 reaction → 流式回复逐步更新(≥1.3s 间隔)→ 完成后 reaction 消失。
3. **消息排队**:回复进行中连发 2 条 → 不报错,按 FIFO 依次执行。
4. **文件双向**:
   - 发图片/文件给 bot → agent 能读到;>50MB 提示不支持。
   - 让 agent 用 `send_file_to_user` 发文件 → Slack 收到文件消息。
   - 回复里含 `xdt-image://` 图片 → finalize 后图片作为独立消息送达。
5. **slash 命令**:`/xdmaker help|new|model|permission` 全部可用;`/xdmaker model` 卡片按钮可点,
   点击后卡片刷新为选中态。
6. **权限/提问卡片**:让 agent 触发一次权限确认 → Slack 出卡片 → 点按钮 → agent 继续。
7. **接管(/ctr)**:desktop 开一个 session → Slack `/xdmaker ctr` → 选该 session → desktop 出现接管
   mask;Slack 发消息驱动该 session;desktop 同步可见;已接管时再 `/ctr` 可直接换目标;
   `/exctr` 退出;desktop 端"收回"按钮 → Slack 收到通知。
8. **离线路径**:退出 desktop → DM bot → 收到"desktop 不在线"提示;启动 desktop 后重发可用。
9. **多端冲突**:第二台机器登录同账号 → 第一台设置页出现冲突横幅,不再收消息;
   重启第一台 app 可抢回。
10. **解绑**:设置页解绑 → Slack 再 DM → 收到"未绑定"指引;重新一键绑定可用。

## 双渠道并存回归清单（合并前必过）

Slack 改动主要风险是 `im/shared/` 重构波及飞书。回归点：

- [ ] 飞书 DM 对话 + 流式 + emoji ack 正常
- [ ] 飞书 slash 全量(`/help /new /model /permission /ctr /exctr`,Slack 侧为 `/xdmaker <sub>`)正常
- [ ] 飞书消息排队(回复中连发)正常
- [ ] 飞书 `/ctr` 接管 + 直接换对话 + `/exctr` + desktop 收回正常
- [ ] 飞书收发文件、`lizi_feishu_bot` send_file_to_user 正常
- [ ] 同一用户飞书 + Slack 同时绑定:各自 DM 驱动各自 session,互不串线
      (session id 前缀 `feishu_*` / `slack_*`;`im_bindings` PK 含 channel)
- [ ] 飞书接管某 session 时,Slack `/xdmaker ctr` 列表行为正确(同 session 不可被两个渠道同时接管)
- [ ] desktop 侧 TakeoverMask 对两个渠道都正确显示 displayName
- [ ] `SLACK_ENABLED=0` 时:飞书一切照旧,Slack 设置页显示"未开通",日志无错误风暴
      (transport 降为 5 分钟低频探测)

## 自动化测试入口

| 范围 | 命令(在对应目录) |
| --- | --- |
| shared 编排(排队/SESSION_RUNNING/onAccepted) | `apps/desktop`: `pnpm vitest run src/main/im/shared/__tests__` |
| 飞书 characterization | `apps/desktop`: `pnpm vitest run src/main/im/feishu/__tests__` |
| SlackIM 映射/codec/mrkdwn | `packages/lizi-im`: `pnpm test` |
| server 绑定/路由/代理 | `apps/server`: `pnpm vitest run` |
| localDb 迁移回放 | `apps/desktop`: `pnpm test:migration-replay` |
