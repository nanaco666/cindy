# 开源建仓 checklist（内部备份，不进对外发布）

> ⚠️ 本目录 `public-check/` 仅用于内部整理开源迁移步骤，**不进对外发布仓**。
> 已在 `.gitattributes` 标 `export-ignore`（`git archive` 自动剔除）。
> 但**「复制工作树 + git init」建仓时 export-ignore 不生效**，必须在复制时手动排除本目录（见 B2）。

把 `cindy-moved` 开源到**新仓库**时照本清单执行。前提结论：走「复制工作树 + `git init`」的全新历史方式，
天然没有旧 commit 的作者 PII；核心业务代码、公开 submodule 和社区健康文件已完成第一轮收口，
内部发布链路、旧归档与第三方合规仍须在公开前完成（见 B/C/D）。

---

## A. 已完成的清理（记录，均已上 main）

- **真名 / 邮箱**：维护者邮箱 → `feedback@cindy.app`；测试身份 `dashhuang` → `octocat`；
  contacts 测试夹具虚构化（心动网络→星澜网络 / 联合创始人→技术负责人 / VeryCD→蓝川 / TapTap→星岛）。
- **内部域名**：`git.xindong.com`、`llm-proxy.tapsvc.com`、`console.tapsvc.com` 全部移除；
  内部代号 `tapsvc` → `cindy_gateway`（codex provider id，仅本地标签，不外发）。
- **Mobile EAS 账号绑定**：`owner` / `extra.eas.projectId` / `updates.url` 改为构建期 env 注入
  （`EAS_OWNER` / `EAS_PROJECT_ID`），仓里不写死。实测：注回原值时 fingerprint 逐字节不变、不冷更。
- **P0 Google client secret**：确认为公开客户端 secret + 仅存在于私有 `cindy-xd`，公开的 `cindy-official` 不含。
- **依赖漏洞**：sharp / fast-uri / @hono 已处理。
- **协议 CI 边界**：父仓只需匿名 checkout 公开的 `makecindy/cindy-protocol` workspace 包，
  不运行协议仓自己的 CI，不再依赖 `CINDY_PROTOCOL_DEPLOY_KEY`。
- **社区入口**：已加入 `CODE_OF_CONDUCT.md`、`SUPPORT.md`、中英文入口和 Bug / Feature /
  Question issue 模板；安全问题继续走 `SECURITY.md`。
- **公开组织与仓库名**：公开入口、Issue 目标、iOS Podspec 和测试夹具已统一为
  `makecindy/cindy`；根 workspace 名已改为 `cindy`。旧组织名只允许存在于 B2
  明确排除的发布链路和内部归档中。
- **内建插件来源**：`official` 与 `xd` 两个内建插件 submodule 已从客户端移除；
  公开客户端不预置插件，改由 SkillHub 或用户手动安装 `.cindy` 包。

---

## B. 建新仓 copy-time 步骤

### B1. 前置：公开子模块须已 public
- `cindy-protocol` 已公开，`.gitmodules` 已切到 `makecindy/cindy-protocol`，
  父仓锁定的 `436a45f` 已由公开 tag `client-baseline-436a45f` 保持可达，并通过匿名
  HTTPS 读取验证。

### B2. Fresh init（丢弃 git 历史 → 无作者 PII）
- 复制工作树到新位置，**排除**以下(export-ignore 对 copy+init 无效，必须手动排除)：
  - `.git/`、`node_modules/`
  - `public-check/`（本目录）
  - `AGENTS-old.md`、`README-old.md`（旧内部手册与旧入口）
  - `docs/login-redesign/`（一次性实施审计，含旧 worktree 与个人绝对路径）
  - `scripts/run-external-server.mjs` 及 `package.json` 的 `dev:server`
  - 所有官方发布、签名、promote、NPKG、内部 OSS/CDN 脚本（见 C）
  - 所有 gitignored 的本地密钥 / 凭据 / `.env` / `scripts/self-host-regions.json`
- 新位置：`git init` → `git add -A` → 单个初始 commit。旧历史（commit 作者 / 邮箱 / 信息）全部不带过去。
- 一行排除参考：`.git node_modules public-check AGENTS-old.md README-old.md docs/login-redesign`
  `scripts/run-external-server.mjs`（外加发布脚本、`.env` 和密钥文件）。

### B3. 内建插件 submodule
- `[submodule "apps/desktop/resources/builtin-ghosts/official"]` 与
  `[submodule "apps/desktop/resources/builtin-ghosts/xd"]` 已从 `.gitmodules` 移除，
  对应 gitlink 目录也已删除。
- Desktop dev／build 不再自动拉取或强制检查内建插件种子；运行时仍支持 SkillHub／手动
  安装的 `.cindy` 插件。

### B4. 复核无内部残留
在新仓根执行，结果应为空：
```
git grep -iE 'tapsvc|xindong|npkg\.xindong\.com|cindy-server|cindy-xd|workers\.xd\.team|dashhuang|magiclizi|praise|jiali@|(^|[^/])git@github\.com:'
```
（内部 review-pr Skill 已迁出本仓；旧归档和发布链路已在 B2 排除，故不会命中；
  合法的公开组织名与公开官网命中时需按最终 allowlist 复核。）

### B5. Mobile EAS
- `app.json` 已不带 `owner` / `projectId` / `updates`。官方 EAS 构建在 **EAS environment** 设
  `EAS_OWNER` / `EAS_PROJECT_ID`（迁新组织则换新账号值）；公开仓不带，fork 者用 `eas init` 填自己的。

---

## C. 公开仓不提供的内部链路

- **Desktop 打包 / 发布 / 签名**：`apps/desktop/scripts/{package-desktop.mjs,
  release-*.mjs, publish-desktop.mjs, promote-*.mjs, npkg-sign.sh, sign.py}`，
  `release-regions.json.example`，以及 `apps/desktop/forge.config.ts` 中的内部签名接线。
- **Mobile 发布 / promote**：`apps/mobile/scripts/release-*.mjs`、`promote-*.mjs`、
  `release-*.sh`，当前 `package.json` 中共 13 个 `mobile:release:*` 命令。
- **服务端启动桥接**：`scripts/run-external-server.mjs` 与 `package.json` 的 `dev:server`。
- 公开仓不提供官方打包、签名、下载、内部 OSS/CDN、NPKG 或服务端发布流程；新仓复制时整体排除，
  同步删除根仓和 `apps/desktop` / `apps/mobile` package.json 中对应的 `package:*`、`release:*`
  和 `promote:*` 命令。

## D. 仍需外部确认的事项

- 🔴 **微信 / TapTap / 语音 / AI provider 隐私披露与 consent**：完成产品、法务和真机复核。
- ⚙️ **`config/endpoint*.json` 生产域名**（`*.cindy.com.cn` / `*.cindy.app`）：运行时端点清单，
  决定是否保留生产地址或改占位。
- ⚙️ **bundleId / package / slug（`com.xd.*` / `xdt-maker-mobile`）**：app 的商店唯一标识，
  是心动 app 身份。fork 者要上架自己版本时改 `app.config.js` 的 `REGION_CONFIG` / self-host 区域配置即可，
  当前不参数化（收益小）。

---

## E. 结论

最终公开组织为 `makecindy`。建新仓前必须完成：
**B2 排除清单、B3 内建插件来源移除、B4 脱敏扫描、CI 匿名协议 checkout、
隐私 consent 与第三方合规复核**；公开仓不包含官方发布链路。社区健康文件已在当前工作树补齐。
