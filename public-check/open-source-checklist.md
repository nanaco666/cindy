# 开源建仓 checklist（内部备份，不进对外发布）

> ⚠️ 本目录 `public-check/` 仅用于内部整理开源迁移步骤，**不进对外发布仓**。
> 已在 `.gitattributes` 标 `export-ignore`（`git archive` 自动剔除）。
> 但**「复制工作树 + git init」建仓时 export-ignore 不生效**，必须在复制时手动排除本目录（见 B2）。

把 `cindy-moved` 开源到**新仓库**时照本清单执行。前提结论：走「复制工作树 + `git init`」的全新历史方式，
天然没有旧 commit 的作者 PII；当前工作树内容已完成脱敏（见 A）。

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
- **Submodule dev**：`cindy-xd` 缺失时 dev / debug / 打包 dev 路径不阻断（`scripts/ensure-deps.mjs`、
  `scripts/ensure-dev-runtime-assets.mjs` 已做成 xd 可选）。

---

## B. 建新仓 copy-time 步骤

### B1. 前置：公开子模块须已 public
- `cindy-protocol`、`cindy-official-plugin` 需在 github.com 已 **public**（`.gitmodules` 已是 HTTPS）。
  否则外部匿名 `git submodule update --init` / `clone --recursive` 拉子模块会失败。

### B2. Fresh init（丢弃 git 历史 → 无作者 PII）
- 复制工作树到新位置，**排除**以下(export-ignore 对 copy+init 无效，必须手动排除)：
  - `.git/`、`node_modules/`
  - `public-check/`（本目录）
  - `agent-use/`、`scripts/review-pr/`（内部 PR 自动化，绑定公司 Feishu/Slack/名册）
  - 所有 gitignored 的本地密钥 / 凭据 / `.env` / `scripts/self-host-regions.json`
- 新位置：`git init` → `git add -A` → 单个初始 commit。旧历史（commit 作者 / 邮箱 / 信息）全部不带过去。
- 一行排除参考：`.git node_modules public-check agent-use scripts/review-pr`（外加各 `.env` / 密钥文件）。

### B3. `.gitmodules`：删私有 `cindy-xd`
- 删掉 `[submodule "apps/desktop/resources/builtin-ghosts/xd"]` 整段（SSH + 私有仓）。
- 移除 gitlink 目录 `apps/desktop/resources/builtin-ghosts/xd`。
- 保留 `cindy-protocol` + `cindy-official`（已是 HTTPS github.com URL）。
- 验证：`git submodule update --init` 匿名可拉（只拉 2 个公开子模块）；`clone --recursive` 不撞私有仓。

### B4. 复核无内部残留
在新仓根执行，结果应为空：
```
git grep -iE 'tapsvc|git\.xindong\.com|dashhuang|magiclizi|jiali@'
```
（`agent-use/`、`scripts/review-pr/` 已在 B2 排除，故不会命中。）

### B5. Mobile EAS
- `app.json` 已不带 `owner` / `projectId` / `updates`。官方 EAS 构建在 **EAS environment** 设
  `EAS_OWNER` / `EAS_PROJECT_ID`（迁新组织则换新账号值）；公开仓不带，fork 者用 `eas init` 填自己的。

---

## C. 本次主动搁置（建仓时按需再决定，不属"必须清"）

- 🔴 **打包 / 发布脚本**：`apps/desktop/scripts/{npkg-sign.sh, sign.py}`、
  `apps/mobile/scripts/{release-ios.sh, release-android-npkg.sh}`、self-host / npkg 文档、
  `docs/desktop-release-cn-global.md`；连带 `package.json` 的 5 个 `mobile:release:*` script。
  若不对外提供官方发布链路可整体删；保留则需一起脱敏。
- 🔴 **`config/endpoint*.json` 生产域名**（`*.cindy.com.cn` / `*.cindy.app`）：运行时端点清单，
  决定是否保留生产地址或改占位。
- ⚙️ **bundleId / package / slug（`com.xd.*` / `xdt-maker-mobile`）**：app 的商店唯一标识，
  是心动 app 身份。fork 者要上架自己版本时改 `app.config.js` 的 `REGION_CONFIG` / self-host 区域配置即可，
  当前不参数化（收益小）。

---

## D. 结论

隐私 / 真人可识别 / 内部域名 / 账号绑定的清理已全部完成并上 main。建新仓实质只剩：
**B2 fresh init 排除清单 + B3 删 cindy-xd + B4 复核**。C 类按你对"是否对外提供发布链路"的决定处理。
