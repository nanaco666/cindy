# Cindy 登录换肤 · fidelity 总矩阵（schema 文档 + 机读骨架）

> 合约来源：`docs/login-redesign/implementation-plan.md` §「百分百还原验收框架」（矩阵五枚举/终态定义/--for-main 提交语义）+ 附录 B（ManifestRow/CellRef/EvidenceMeta/Cell 冻结 schema,v6.19）+ SC-6/SC-7/SC-9。
> 本文件由 PR0a 交付 schema 与空骨架；各实现 PR（pr1/pr2a/pr2b/pr3/pr4a/pr4b）随 slice 填格；机器校验入口 `scripts/check-fidelity-matrix.mjs`。
> 行全集锚点 = `acceptance/required-state-catalog.json`（冻结,只读）；实现镜像 = `acceptance/state-manifest.json`；两者 rowId 集合与逐行 ground-truth 字段必须精确相等（checker 断言）。

## 1. 机读块格式约定（checker 按此解析,勿改动约定本身）

- 本文档**有且只有一个**以 ```json 开头的 fenced code block（见文末），checker 解析该块为矩阵数据；出现第二个 ```json 块即校验失败。
- 块内 JSON 顶层结构：

```text
{
  "cells": { "<cellKey>": <Cell>, ... },
  "forMain": { "testedCodeCommit": "<C 全 SHA>" }   // 仅 --for-main 终审阶段写入,平时缺省
}
```

- **cellKey 格式**：`"<rowId>|<device>|<locale>|<region>"`（四段以 `|` 连接,即附录 B CellRef 的规范化 key）。
  - `rowId` 必须存在于 state-manifest.json；
  - `device` ∈ `mac|windows|iphone|android-phone|ipad|android-pad`；
  - `locale` ∈ `zh-CN|zh-TW|en|ja|ko`；
  - `region` ∈ `cn|global`；
  - 三个分量必须落在该行 `applicability` 声明的范围内。

## 2. 格值五枚举（附录 B Cell union,字段逐项照抄）

| value | 必填字段 | 可选字段 | 语义 |
|---|---|---|---|
| `PASS` | `evidence`（相对 evidence 根的证据文件路径）、`baseline{source,ref}`（必须与该行 manifest 唯一 baselineRequirement 的 source+ref 精确一致,禁模糊引用）、`reviewer`、`approvedAt` | `allowReason`（**纯说明字段,无复用授权效力**——复用合法性只由 manifest `evidenceReuseGroups` 判定,v6.16） | 该格已按行基准逐参数对照通过,证据入库且带 sidecar |
| `FAIL` | `note` | — | 对照不通过,必须修复后重验 |
| `GAP` | — | `decidedBy` / `decidedAt` / `conclusion`（裁决三元组） | **仅允许作为 slice 中间态**;`--final` 下一律失败 |
| `N/A` | `reasonCode` ∈ `surface-not-on-platform` \| `region-exclusive` \| `platform-exclusive-feature` | `detail` | 不适用格;必须命中该行 manifest `naAllowed` 约束（match 子集判定）,manifest 外 N/A 一律失败 |
| `WAIVER` | `approvedBy`、`approvedAt`、`retestVia`、`deadline` | — | 仅限缺硬件/缺环境(U-4 口径);`--final` 输出 `:WAIVERS`,`--for-main` 不接受 |

不允许空格：slice 门禁下本 slice 全部适用格必须有值；`--final` 下全矩阵适用格必须有值。

## 3. 终态精确定义（计划 §框架第 2 条,checker `--final` 判定）

> ⚠️ **验收方式更替声明（2026-07-21 用户拍板）**：本节对应的 **`--final` 矩阵终验门（"零 GAP 才能 main / `100% VERIFIED` 才算完成"）已废弃**;验收流程更替为「scenario 采集 + SC 命令 + e2e 报告 → 沙盒手动测试」。下方终态定义文字（`100% VERIFIED` / `ACCEPTED_WITH_WAIVERS` / "GAP 在 final 一律失败"）保留为 checker `--final` 机读契约的历史口径,但**不再作为合入 main 的硬门,亦不据此宣称"必须零 GAP 才算完成"**。
> **据实未覆盖面**：Windows 与 iPad 端视觉验证仍待补（沙盒手测尚未覆盖这两端）;§7 机读块中现存 GAP 为**真实状态,不冒充已验**——沙盒手测补齐前不假填为 PASS。

- `FIDELITY_MATRIX_OK:VERIFIED`（= `100% VERIFIED`）：所有**适用格** = `PASS`；所有不适用格 = manifest 允许范围内的合法 `N/A`；`FAIL = GAP = WAIVER = 0`。
- `FIDELITY_MATRIX_OK:WAIVERS`（= `ACCEPTED_WITH_WAIVERS`）：仅 `WAIVER > 0`，其余适用格全 `PASS`、`N/A` 同规则、`FAIL = GAP = 0`；waiver 清单单列。
- 含任一 `GAP`、或 manifest 外 `N/A` → exit 非零（GAP 在 final 模式一律失败;裁决改变目标后必须把该格重验为 PASS,或经批准更新 manifest 转为合法 N/A）。
- `--final --for-main`（integration → main 终审）只接受 `:VERIFIED`,并附加 Git tree-entry tuple 校验（见 §6）。

## 4. 证据目录与 sidecar 元数据

- **证据目录**：`docs/login-redesign/acceptance/evidence/`。PASS 格 `evidence` 字段填相对该目录的路径；checker 校验：文件存在、非空、扩展名白名单（`png/jpg/jpeg/webp/mp4/mov/json/txt/md`）、png/jpg 头部魔数可解码。
- **sidecar**：每份 PASS 证据必须配 `<evidence>.meta.json`（与证据同目录同名加后缀），schema = 附录 B `EvidenceMeta`：

```text
{
  "evidenceSha256": "<证据文件 SHA256,checker 实测比对>",
  "testedCodeCommit": "<C 全 SHA(代码冻结 commit,--for-main 语义见计划§框架第 1 条)>",
  "capturedCellRef": { "rowId": "...", "device": "...", "locale": "...", "region": "..." },
  "reuseGroupId": "<可选;复用态必填,须命中 manifest evidenceReuseGroups>",
  "applicableCellRefs": [ <CellRef>, ... ],
  "scenario": "<可选,采集场景说明>",
  "capturedAt": "<ISO 时间戳>"
}
```

## 5. CellRef 等价规则与证据复用（附录 B v6.18 冻结）

- 规范化 key = `${rowId}|${device}|${locale}|${region}`；集合比较一律无序、按规范化 key 判等；数组内重复 CellRef → schema 拒绝。
- `capturedCellRef` 必须 ∈ `applicableCellRefs`；引用该证据的每个矩阵格必须 ∈ `applicableCellRefs`。
- **非复用态**：`reuseGroupId` 必须缺省，且 `applicableCellRefs.length === 1`（恰为 capturedCellRef）。
- **复用态**：`reuseGroupId` 必填且命中 manifest 顶层 `evidenceReuseGroups` 的组；该组 `cells` 规范化集合与 `applicableCellRefs` **精确相等**；组内各 ref 的 rowId/device/region 分量一致、**仅 locale 分量变化**（`dimension` 冻结为 `"locale"`,禁止跨 device/region/文案行）。
- **SHA256 重复检测**：checker 对全部 PASS 证据实测 SHA256；同一 SHA 出现在两格而无声明组（或组不合法）→ exit 非零。组外重复一律 FAIL。

## 6. `--for-main` 提交语义（计划 §框架第 1 条,v6.18/v6.19 模型）

- 机读块顶层写入 `"forMain": {"testedCodeCommit": "<C 全 SHA>"}`；C = 全部实现与获批锚点变更冻结后的源码+契约树 commit；验收产物以 acceptance-artifact-only commit(s) 入仓形成终审 HEAD = H。
- checker 对 C 与 H 各跑 `git ls-tree -r`，过滤 **artifact allowlist 四项**（`docs/login-redesign/acceptance/fidelity-matrix.md`、`docs/login-redesign/acceptance/evidence/**`、`docs/login-redesign/acceptance/e2e/report.json`、`docs/login-redesign/acceptance/e2e/evidence/**`）后，两侧 `{path,mode,type,objectId}` tuple 集合必须**精确相等**；三份冻结锚点、state-manifest、translation-review、schema/fixture/checker/构建配置全在 allowlist 外，H 动即败。
- artifact 正规文件约束：H 中 fidelity-matrix.md、e2e/report.json 与全部被引用 evidence/sidecar 必须 mode=100644 type=blob（拒 symlink/gitlink）；校验内容与 H tree object 一致；两个 evidence 目录在 H 中的路径集合与 matrix/report 引用闭包精确相等（未被引用的额外文件 → 败）。

## 7. 矩阵机读块（唯一 ```json block;PR0a 交付空骨架,随各 slice PR 填格）

```json
{
  "cells": {
    "desktop.brand-background.style|mac|zh-CN|cn": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "待集中批捕:lead 裁决③降级预案(2026-07-20)——全部实现 PR 合入后由 lead 统一安排 live-app 阶段补齐视觉证据并补跑 --slice 全量。本次一次尝试实况:restart 自检通过(宿主为 packaged 非 dev 树,非 refusal),pr1-verify 沙箱已创建、dev 已 spawn,但屏幕锁定+显示器休眠(22:33 起,用户离机)致 120s 就绪超时且截图/交互物理不可行(截屏全黑)。"
    },
    "desktop.brand-background.style|mac|zh-CN|global": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "待集中批捕:lead 裁决③降级预案(2026-07-20)——全部实现 PR 合入后由 lead 统一安排 live-app 阶段补齐视觉证据并补跑 --slice 全量。本次一次尝试实况:restart 自检通过(宿主为 packaged 非 dev 树,非 refusal),pr1-verify 沙箱已创建、dev 已 spawn,但屏幕锁定+显示器休眠(22:33 起,用户离机)致 120s 就绪超时且截图/交互物理不可行(截屏全黑)。"
    },
    "desktop.brand-background.style|mac|zh-TW|cn": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "待集中批捕:lead 裁决③降级预案(2026-07-20)——全部实现 PR 合入后由 lead 统一安排 live-app 阶段补齐视觉证据并补跑 --slice 全量。本次一次尝试实况:restart 自检通过(宿主为 packaged 非 dev 树,非 refusal),pr1-verify 沙箱已创建、dev 已 spawn,但屏幕锁定+显示器休眠(22:33 起,用户离机)致 120s 就绪超时且截图/交互物理不可行(截屏全黑)。"
    },
    "desktop.brand-background.style|mac|zh-TW|global": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "待集中批捕:lead 裁决③降级预案(2026-07-20)——全部实现 PR 合入后由 lead 统一安排 live-app 阶段补齐视觉证据并补跑 --slice 全量。本次一次尝试实况:restart 自检通过(宿主为 packaged 非 dev 树,非 refusal),pr1-verify 沙箱已创建、dev 已 spawn,但屏幕锁定+显示器休眠(22:33 起,用户离机)致 120s 就绪超时且截图/交互物理不可行(截屏全黑)。"
    },
    "desktop.brand-background.style|mac|en|cn": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "待集中批捕:lead 裁决③降级预案(2026-07-20)——全部实现 PR 合入后由 lead 统一安排 live-app 阶段补齐视觉证据并补跑 --slice 全量。本次一次尝试实况:restart 自检通过(宿主为 packaged 非 dev 树,非 refusal),pr1-verify 沙箱已创建、dev 已 spawn,但屏幕锁定+显示器休眠(22:33 起,用户离机)致 120s 就绪超时且截图/交互物理不可行(截屏全黑)。"
    },
    "desktop.brand-background.style|mac|en|global": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "待集中批捕:lead 裁决③降级预案(2026-07-20)——全部实现 PR 合入后由 lead 统一安排 live-app 阶段补齐视觉证据并补跑 --slice 全量。本次一次尝试实况:restart 自检通过(宿主为 packaged 非 dev 树,非 refusal),pr1-verify 沙箱已创建、dev 已 spawn,但屏幕锁定+显示器休眠(22:33 起,用户离机)致 120s 就绪超时且截图/交互物理不可行(截屏全黑)。"
    },
    "desktop.brand-background.style|mac|ja|cn": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "待集中批捕:lead 裁决③降级预案(2026-07-20)——全部实现 PR 合入后由 lead 统一安排 live-app 阶段补齐视觉证据并补跑 --slice 全量。本次一次尝试实况:restart 自检通过(宿主为 packaged 非 dev 树,非 refusal),pr1-verify 沙箱已创建、dev 已 spawn,但屏幕锁定+显示器休眠(22:33 起,用户离机)致 120s 就绪超时且截图/交互物理不可行(截屏全黑)。"
    },
    "desktop.brand-background.style|mac|ja|global": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "待集中批捕:lead 裁决③降级预案(2026-07-20)——全部实现 PR 合入后由 lead 统一安排 live-app 阶段补齐视觉证据并补跑 --slice 全量。本次一次尝试实况:restart 自检通过(宿主为 packaged 非 dev 树,非 refusal),pr1-verify 沙箱已创建、dev 已 spawn,但屏幕锁定+显示器休眠(22:33 起,用户离机)致 120s 就绪超时且截图/交互物理不可行(截屏全黑)。"
    },
    "desktop.brand-background.style|mac|ko|cn": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "待集中批捕:lead 裁决③降级预案(2026-07-20)——全部实现 PR 合入后由 lead 统一安排 live-app 阶段补齐视觉证据并补跑 --slice 全量。本次一次尝试实况:restart 自检通过(宿主为 packaged 非 dev 树,非 refusal),pr1-verify 沙箱已创建、dev 已 spawn,但屏幕锁定+显示器休眠(22:33 起,用户离机)致 120s 就绪超时且截图/交互物理不可行(截屏全黑)。"
    },
    "desktop.brand-background.style|mac|ko|global": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "待集中批捕:lead 裁决③降级预案(2026-07-20)——全部实现 PR 合入后由 lead 统一安排 live-app 阶段补齐视觉证据并补跑 --slice 全量。本次一次尝试实况:restart 自检通过(宿主为 packaged 非 dev 树,非 refusal),pr1-verify 沙箱已创建、dev 已 spawn,但屏幕锁定+显示器休眠(22:33 起,用户离机)致 120s 就绪超时且截图/交互物理不可行(截屏全黑)。"
    },
    "desktop.brand-background.style|windows|zh-CN|cn": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "待集中批捕:lead 裁决③降级预案(2026-07-20)——全部实现 PR 合入后由 lead 统一安排 live-app 阶段补齐视觉证据并补跑 --slice 全量。本次一次尝试实况:restart 自检通过(宿主为 packaged 非 dev 树,非 refusal),pr1-verify 沙箱已创建、dev 已 spawn,但屏幕锁定+显示器休眠(22:33 起,用户离机)致 120s 就绪超时且截图/交互物理不可行(截屏全黑)。"
    },
    "desktop.brand-background.style|windows|zh-CN|global": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "待集中批捕:lead 裁决③降级预案(2026-07-20)——全部实现 PR 合入后由 lead 统一安排 live-app 阶段补齐视觉证据并补跑 --slice 全量。本次一次尝试实况:restart 自检通过(宿主为 packaged 非 dev 树,非 refusal),pr1-verify 沙箱已创建、dev 已 spawn,但屏幕锁定+显示器休眠(22:33 起,用户离机)致 120s 就绪超时且截图/交互物理不可行(截屏全黑)。"
    },
    "desktop.brand-background.style|windows|zh-TW|cn": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "待集中批捕:lead 裁决③降级预案(2026-07-20)——全部实现 PR 合入后由 lead 统一安排 live-app 阶段补齐视觉证据并补跑 --slice 全量。本次一次尝试实况:restart 自检通过(宿主为 packaged 非 dev 树,非 refusal),pr1-verify 沙箱已创建、dev 已 spawn,但屏幕锁定+显示器休眠(22:33 起,用户离机)致 120s 就绪超时且截图/交互物理不可行(截屏全黑)。"
    },
    "desktop.brand-background.style|windows|zh-TW|global": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "待集中批捕:lead 裁决③降级预案(2026-07-20)——全部实现 PR 合入后由 lead 统一安排 live-app 阶段补齐视觉证据并补跑 --slice 全量。本次一次尝试实况:restart 自检通过(宿主为 packaged 非 dev 树,非 refusal),pr1-verify 沙箱已创建、dev 已 spawn,但屏幕锁定+显示器休眠(22:33 起,用户离机)致 120s 就绪超时且截图/交互物理不可行(截屏全黑)。"
    },
    "desktop.brand-background.style|windows|en|cn": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "待集中批捕:lead 裁决③降级预案(2026-07-20)——全部实现 PR 合入后由 lead 统一安排 live-app 阶段补齐视觉证据并补跑 --slice 全量。本次一次尝试实况:restart 自检通过(宿主为 packaged 非 dev 树,非 refusal),pr1-verify 沙箱已创建、dev 已 spawn,但屏幕锁定+显示器休眠(22:33 起,用户离机)致 120s 就绪超时且截图/交互物理不可行(截屏全黑)。"
    },
    "desktop.brand-background.style|windows|en|global": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "待集中批捕:lead 裁决③降级预案(2026-07-20)——全部实现 PR 合入后由 lead 统一安排 live-app 阶段补齐视觉证据并补跑 --slice 全量。本次一次尝试实况:restart 自检通过(宿主为 packaged 非 dev 树,非 refusal),pr1-verify 沙箱已创建、dev 已 spawn,但屏幕锁定+显示器休眠(22:33 起,用户离机)致 120s 就绪超时且截图/交互物理不可行(截屏全黑)。"
    },
    "desktop.brand-background.style|windows|ja|cn": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "待集中批捕:lead 裁决③降级预案(2026-07-20)——全部实现 PR 合入后由 lead 统一安排 live-app 阶段补齐视觉证据并补跑 --slice 全量。本次一次尝试实况:restart 自检通过(宿主为 packaged 非 dev 树,非 refusal),pr1-verify 沙箱已创建、dev 已 spawn,但屏幕锁定+显示器休眠(22:33 起,用户离机)致 120s 就绪超时且截图/交互物理不可行(截屏全黑)。"
    },
    "desktop.brand-background.style|windows|ja|global": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "待集中批捕:lead 裁决③降级预案(2026-07-20)——全部实现 PR 合入后由 lead 统一安排 live-app 阶段补齐视觉证据并补跑 --slice 全量。本次一次尝试实况:restart 自检通过(宿主为 packaged 非 dev 树,非 refusal),pr1-verify 沙箱已创建、dev 已 spawn,但屏幕锁定+显示器休眠(22:33 起,用户离机)致 120s 就绪超时且截图/交互物理不可行(截屏全黑)。"
    },
    "desktop.brand-background.style|windows|ko|cn": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "待集中批捕:lead 裁决③降级预案(2026-07-20)——全部实现 PR 合入后由 lead 统一安排 live-app 阶段补齐视觉证据并补跑 --slice 全量。本次一次尝试实况:restart 自检通过(宿主为 packaged 非 dev 树,非 refusal),pr1-verify 沙箱已创建、dev 已 spawn,但屏幕锁定+显示器休眠(22:33 起,用户离机)致 120s 就绪超时且截图/交互物理不可行(截屏全黑)。"
    },
    "desktop.brand-background.style|windows|ko|global": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "待集中批捕:lead 裁决③降级预案(2026-07-20)——全部实现 PR 合入后由 lead 统一安排 live-app 阶段补齐视觉证据并补跑 --slice 全量。本次一次尝试实况:restart 自检通过(宿主为 packaged 非 dev 树,非 refusal),pr1-verify 沙箱已创建、dev 已 spawn,但屏幕锁定+显示器休眠(22:33 起,用户离机)致 120s 就绪超时且截图/交互物理不可行(截屏全黑)。"
    },
    "desktop.login-panel-border.style|mac|zh-CN|cn": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "待集中批捕:lead 裁决③降级预案(2026-07-20)——全部实现 PR 合入后由 lead 统一安排 live-app 阶段补齐视觉证据并补跑 --slice 全量。本次一次尝试实况:restart 自检通过(宿主为 packaged 非 dev 树,非 refusal),pr1-verify 沙箱已创建、dev 已 spawn,但屏幕锁定+显示器休眠(22:33 起,用户离机)致 120s 就绪超时且截图/交互物理不可行(截屏全黑)。"
    },
    "desktop.login-panel-border.style|mac|zh-CN|global": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "待集中批捕:lead 裁决③降级预案(2026-07-20)——全部实现 PR 合入后由 lead 统一安排 live-app 阶段补齐视觉证据并补跑 --slice 全量。本次一次尝试实况:restart 自检通过(宿主为 packaged 非 dev 树,非 refusal),pr1-verify 沙箱已创建、dev 已 spawn,但屏幕锁定+显示器休眠(22:33 起,用户离机)致 120s 就绪超时且截图/交互物理不可行(截屏全黑)。"
    },
    "desktop.login-panel-border.style|mac|zh-TW|cn": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "待集中批捕:lead 裁决③降级预案(2026-07-20)——全部实现 PR 合入后由 lead 统一安排 live-app 阶段补齐视觉证据并补跑 --slice 全量。本次一次尝试实况:restart 自检通过(宿主为 packaged 非 dev 树,非 refusal),pr1-verify 沙箱已创建、dev 已 spawn,但屏幕锁定+显示器休眠(22:33 起,用户离机)致 120s 就绪超时且截图/交互物理不可行(截屏全黑)。"
    },
    "desktop.login-panel-border.style|mac|zh-TW|global": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "待集中批捕:lead 裁决③降级预案(2026-07-20)——全部实现 PR 合入后由 lead 统一安排 live-app 阶段补齐视觉证据并补跑 --slice 全量。本次一次尝试实况:restart 自检通过(宿主为 packaged 非 dev 树,非 refusal),pr1-verify 沙箱已创建、dev 已 spawn,但屏幕锁定+显示器休眠(22:33 起,用户离机)致 120s 就绪超时且截图/交互物理不可行(截屏全黑)。"
    },
    "desktop.login-panel-border.style|mac|en|cn": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "待集中批捕:lead 裁决③降级预案(2026-07-20)——全部实现 PR 合入后由 lead 统一安排 live-app 阶段补齐视觉证据并补跑 --slice 全量。本次一次尝试实况:restart 自检通过(宿主为 packaged 非 dev 树,非 refusal),pr1-verify 沙箱已创建、dev 已 spawn,但屏幕锁定+显示器休眠(22:33 起,用户离机)致 120s 就绪超时且截图/交互物理不可行(截屏全黑)。"
    },
    "desktop.login-panel-border.style|mac|en|global": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "待集中批捕:lead 裁决③降级预案(2026-07-20)——全部实现 PR 合入后由 lead 统一安排 live-app 阶段补齐视觉证据并补跑 --slice 全量。本次一次尝试实况:restart 自检通过(宿主为 packaged 非 dev 树,非 refusal),pr1-verify 沙箱已创建、dev 已 spawn,但屏幕锁定+显示器休眠(22:33 起,用户离机)致 120s 就绪超时且截图/交互物理不可行(截屏全黑)。"
    },
    "desktop.login-panel-border.style|mac|ja|cn": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "待集中批捕:lead 裁决③降级预案(2026-07-20)——全部实现 PR 合入后由 lead 统一安排 live-app 阶段补齐视觉证据并补跑 --slice 全量。本次一次尝试实况:restart 自检通过(宿主为 packaged 非 dev 树,非 refusal),pr1-verify 沙箱已创建、dev 已 spawn,但屏幕锁定+显示器休眠(22:33 起,用户离机)致 120s 就绪超时且截图/交互物理不可行(截屏全黑)。"
    },
    "desktop.login-panel-border.style|mac|ja|global": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "待集中批捕:lead 裁决③降级预案(2026-07-20)——全部实现 PR 合入后由 lead 统一安排 live-app 阶段补齐视觉证据并补跑 --slice 全量。本次一次尝试实况:restart 自检通过(宿主为 packaged 非 dev 树,非 refusal),pr1-verify 沙箱已创建、dev 已 spawn,但屏幕锁定+显示器休眠(22:33 起,用户离机)致 120s 就绪超时且截图/交互物理不可行(截屏全黑)。"
    },
    "desktop.login-panel-border.style|mac|ko|cn": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "待集中批捕:lead 裁决③降级预案(2026-07-20)——全部实现 PR 合入后由 lead 统一安排 live-app 阶段补齐视觉证据并补跑 --slice 全量。本次一次尝试实况:restart 自检通过(宿主为 packaged 非 dev 树,非 refusal),pr1-verify 沙箱已创建、dev 已 spawn,但屏幕锁定+显示器休眠(22:33 起,用户离机)致 120s 就绪超时且截图/交互物理不可行(截屏全黑)。"
    },
    "desktop.login-panel-border.style|mac|ko|global": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "待集中批捕:lead 裁决③降级预案(2026-07-20)——全部实现 PR 合入后由 lead 统一安排 live-app 阶段补齐视觉证据并补跑 --slice 全量。本次一次尝试实况:restart 自检通过(宿主为 packaged 非 dev 树,非 refusal),pr1-verify 沙箱已创建、dev 已 spawn,但屏幕锁定+显示器休眠(22:33 起,用户离机)致 120s 就绪超时且截图/交互物理不可行(截屏全黑)。"
    },
    "desktop.login-panel-border.style|windows|zh-CN|cn": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "待集中批捕:lead 裁决③降级预案(2026-07-20)——全部实现 PR 合入后由 lead 统一安排 live-app 阶段补齐视觉证据并补跑 --slice 全量。本次一次尝试实况:restart 自检通过(宿主为 packaged 非 dev 树,非 refusal),pr1-verify 沙箱已创建、dev 已 spawn,但屏幕锁定+显示器休眠(22:33 起,用户离机)致 120s 就绪超时且截图/交互物理不可行(截屏全黑)。"
    },
    "desktop.login-panel-border.style|windows|zh-CN|global": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "待集中批捕:lead 裁决③降级预案(2026-07-20)——全部实现 PR 合入后由 lead 统一安排 live-app 阶段补齐视觉证据并补跑 --slice 全量。本次一次尝试实况:restart 自检通过(宿主为 packaged 非 dev 树,非 refusal),pr1-verify 沙箱已创建、dev 已 spawn,但屏幕锁定+显示器休眠(22:33 起,用户离机)致 120s 就绪超时且截图/交互物理不可行(截屏全黑)。"
    },
    "desktop.login-panel-border.style|windows|zh-TW|cn": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "待集中批捕:lead 裁决③降级预案(2026-07-20)——全部实现 PR 合入后由 lead 统一安排 live-app 阶段补齐视觉证据并补跑 --slice 全量。本次一次尝试实况:restart 自检通过(宿主为 packaged 非 dev 树,非 refusal),pr1-verify 沙箱已创建、dev 已 spawn,但屏幕锁定+显示器休眠(22:33 起,用户离机)致 120s 就绪超时且截图/交互物理不可行(截屏全黑)。"
    },
    "desktop.login-panel-border.style|windows|zh-TW|global": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "待集中批捕:lead 裁决③降级预案(2026-07-20)——全部实现 PR 合入后由 lead 统一安排 live-app 阶段补齐视觉证据并补跑 --slice 全量。本次一次尝试实况:restart 自检通过(宿主为 packaged 非 dev 树,非 refusal),pr1-verify 沙箱已创建、dev 已 spawn,但屏幕锁定+显示器休眠(22:33 起,用户离机)致 120s 就绪超时且截图/交互物理不可行(截屏全黑)。"
    },
    "desktop.login-panel-border.style|windows|en|cn": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "待集中批捕:lead 裁决③降级预案(2026-07-20)——全部实现 PR 合入后由 lead 统一安排 live-app 阶段补齐视觉证据并补跑 --slice 全量。本次一次尝试实况:restart 自检通过(宿主为 packaged 非 dev 树,非 refusal),pr1-verify 沙箱已创建、dev 已 spawn,但屏幕锁定+显示器休眠(22:33 起,用户离机)致 120s 就绪超时且截图/交互物理不可行(截屏全黑)。"
    },
    "desktop.login-panel-border.style|windows|en|global": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "待集中批捕:lead 裁决③降级预案(2026-07-20)——全部实现 PR 合入后由 lead 统一安排 live-app 阶段补齐视觉证据并补跑 --slice 全量。本次一次尝试实况:restart 自检通过(宿主为 packaged 非 dev 树,非 refusal),pr1-verify 沙箱已创建、dev 已 spawn,但屏幕锁定+显示器休眠(22:33 起,用户离机)致 120s 就绪超时且截图/交互物理不可行(截屏全黑)。"
    },
    "desktop.login-panel-border.style|windows|ja|cn": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "待集中批捕:lead 裁决③降级预案(2026-07-20)——全部实现 PR 合入后由 lead 统一安排 live-app 阶段补齐视觉证据并补跑 --slice 全量。本次一次尝试实况:restart 自检通过(宿主为 packaged 非 dev 树,非 refusal),pr1-verify 沙箱已创建、dev 已 spawn,但屏幕锁定+显示器休眠(22:33 起,用户离机)致 120s 就绪超时且截图/交互物理不可行(截屏全黑)。"
    },
    "desktop.login-panel-border.style|windows|ja|global": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "待集中批捕:lead 裁决③降级预案(2026-07-20)——全部实现 PR 合入后由 lead 统一安排 live-app 阶段补齐视觉证据并补跑 --slice 全量。本次一次尝试实况:restart 自检通过(宿主为 packaged 非 dev 树,非 refusal),pr1-verify 沙箱已创建、dev 已 spawn,但屏幕锁定+显示器休眠(22:33 起,用户离机)致 120s 就绪超时且截图/交互物理不可行(截屏全黑)。"
    },
    "desktop.login-panel-border.style|windows|ko|cn": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "待集中批捕:lead 裁决③降级预案(2026-07-20)——全部实现 PR 合入后由 lead 统一安排 live-app 阶段补齐视觉证据并补跑 --slice 全量。本次一次尝试实况:restart 自检通过(宿主为 packaged 非 dev 树,非 refusal),pr1-verify 沙箱已创建、dev 已 spawn,但屏幕锁定+显示器休眠(22:33 起,用户离机)致 120s 就绪超时且截图/交互物理不可行(截屏全黑)。"
    },
    "desktop.login-panel-border.style|windows|ko|global": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "待集中批捕:lead 裁决③降级预案(2026-07-20)——全部实现 PR 合入后由 lead 统一安排 live-app 阶段补齐视觉证据并补跑 --slice 全量。本次一次尝试实况:restart 自检通过(宿主为 packaged 非 dev 树,非 refusal),pr1-verify 沙箱已创建、dev 已 spawn,但屏幕锁定+显示器休眠(22:33 起,用户离机)致 120s 就绪超时且截图/交互物理不可行(截屏全黑)。"
    },
    "desktop.wordmark.asset|mac|zh-CN|cn": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "待集中批捕:lead 裁决③降级预案(2026-07-20)——全部实现 PR 合入后由 lead 统一安排 live-app 阶段补齐视觉证据并补跑 --slice 全量。本次一次尝试实况:restart 自检通过(宿主为 packaged 非 dev 树,非 refusal),pr1-verify 沙箱已创建、dev 已 spawn,但屏幕锁定+显示器休眠(22:33 起,用户离机)致 120s 就绪超时且截图/交互物理不可行(截屏全黑)。"
    },
    "desktop.wordmark.asset|mac|zh-CN|global": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "待集中批捕:lead 裁决③降级预案(2026-07-20)——全部实现 PR 合入后由 lead 统一安排 live-app 阶段补齐视觉证据并补跑 --slice 全量。本次一次尝试实况:restart 自检通过(宿主为 packaged 非 dev 树,非 refusal),pr1-verify 沙箱已创建、dev 已 spawn,但屏幕锁定+显示器休眠(22:33 起,用户离机)致 120s 就绪超时且截图/交互物理不可行(截屏全黑)。"
    },
    "desktop.wordmark.asset|mac|zh-TW|cn": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "待集中批捕:lead 裁决③降级预案(2026-07-20)——全部实现 PR 合入后由 lead 统一安排 live-app 阶段补齐视觉证据并补跑 --slice 全量。本次一次尝试实况:restart 自检通过(宿主为 packaged 非 dev 树,非 refusal),pr1-verify 沙箱已创建、dev 已 spawn,但屏幕锁定+显示器休眠(22:33 起,用户离机)致 120s 就绪超时且截图/交互物理不可行(截屏全黑)。"
    },
    "desktop.wordmark.asset|mac|zh-TW|global": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "待集中批捕:lead 裁决③降级预案(2026-07-20)——全部实现 PR 合入后由 lead 统一安排 live-app 阶段补齐视觉证据并补跑 --slice 全量。本次一次尝试实况:restart 自检通过(宿主为 packaged 非 dev 树,非 refusal),pr1-verify 沙箱已创建、dev 已 spawn,但屏幕锁定+显示器休眠(22:33 起,用户离机)致 120s 就绪超时且截图/交互物理不可行(截屏全黑)。"
    },
    "desktop.wordmark.asset|mac|en|cn": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "待集中批捕:lead 裁决③降级预案(2026-07-20)——全部实现 PR 合入后由 lead 统一安排 live-app 阶段补齐视觉证据并补跑 --slice 全量。本次一次尝试实况:restart 自检通过(宿主为 packaged 非 dev 树,非 refusal),pr1-verify 沙箱已创建、dev 已 spawn,但屏幕锁定+显示器休眠(22:33 起,用户离机)致 120s 就绪超时且截图/交互物理不可行(截屏全黑)。"
    },
    "desktop.wordmark.asset|mac|en|global": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "待集中批捕:lead 裁决③降级预案(2026-07-20)——全部实现 PR 合入后由 lead 统一安排 live-app 阶段补齐视觉证据并补跑 --slice 全量。本次一次尝试实况:restart 自检通过(宿主为 packaged 非 dev 树,非 refusal),pr1-verify 沙箱已创建、dev 已 spawn,但屏幕锁定+显示器休眠(22:33 起,用户离机)致 120s 就绪超时且截图/交互物理不可行(截屏全黑)。"
    },
    "desktop.wordmark.asset|mac|ja|cn": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "待集中批捕:lead 裁决③降级预案(2026-07-20)——全部实现 PR 合入后由 lead 统一安排 live-app 阶段补齐视觉证据并补跑 --slice 全量。本次一次尝试实况:restart 自检通过(宿主为 packaged 非 dev 树,非 refusal),pr1-verify 沙箱已创建、dev 已 spawn,但屏幕锁定+显示器休眠(22:33 起,用户离机)致 120s 就绪超时且截图/交互物理不可行(截屏全黑)。"
    },
    "desktop.wordmark.asset|mac|ja|global": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "待集中批捕:lead 裁决③降级预案(2026-07-20)——全部实现 PR 合入后由 lead 统一安排 live-app 阶段补齐视觉证据并补跑 --slice 全量。本次一次尝试实况:restart 自检通过(宿主为 packaged 非 dev 树,非 refusal),pr1-verify 沙箱已创建、dev 已 spawn,但屏幕锁定+显示器休眠(22:33 起,用户离机)致 120s 就绪超时且截图/交互物理不可行(截屏全黑)。"
    },
    "desktop.wordmark.asset|mac|ko|cn": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "待集中批捕:lead 裁决③降级预案(2026-07-20)——全部实现 PR 合入后由 lead 统一安排 live-app 阶段补齐视觉证据并补跑 --slice 全量。本次一次尝试实况:restart 自检通过(宿主为 packaged 非 dev 树,非 refusal),pr1-verify 沙箱已创建、dev 已 spawn,但屏幕锁定+显示器休眠(22:33 起,用户离机)致 120s 就绪超时且截图/交互物理不可行(截屏全黑)。"
    },
    "desktop.wordmark.asset|mac|ko|global": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "待集中批捕:lead 裁决③降级预案(2026-07-20)——全部实现 PR 合入后由 lead 统一安排 live-app 阶段补齐视觉证据并补跑 --slice 全量。本次一次尝试实况:restart 自检通过(宿主为 packaged 非 dev 树,非 refusal),pr1-verify 沙箱已创建、dev 已 spawn,但屏幕锁定+显示器休眠(22:33 起,用户离机)致 120s 就绪超时且截图/交互物理不可行(截屏全黑)。"
    },
    "desktop.wordmark.asset|windows|zh-CN|cn": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "待集中批捕:lead 裁决③降级预案(2026-07-20)——全部实现 PR 合入后由 lead 统一安排 live-app 阶段补齐视觉证据并补跑 --slice 全量。本次一次尝试实况:restart 自检通过(宿主为 packaged 非 dev 树,非 refusal),pr1-verify 沙箱已创建、dev 已 spawn,但屏幕锁定+显示器休眠(22:33 起,用户离机)致 120s 就绪超时且截图/交互物理不可行(截屏全黑)。"
    },
    "desktop.wordmark.asset|windows|zh-CN|global": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "待集中批捕:lead 裁决③降级预案(2026-07-20)——全部实现 PR 合入后由 lead 统一安排 live-app 阶段补齐视觉证据并补跑 --slice 全量。本次一次尝试实况:restart 自检通过(宿主为 packaged 非 dev 树,非 refusal),pr1-verify 沙箱已创建、dev 已 spawn,但屏幕锁定+显示器休眠(22:33 起,用户离机)致 120s 就绪超时且截图/交互物理不可行(截屏全黑)。"
    },
    "desktop.wordmark.asset|windows|zh-TW|cn": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "待集中批捕:lead 裁决③降级预案(2026-07-20)——全部实现 PR 合入后由 lead 统一安排 live-app 阶段补齐视觉证据并补跑 --slice 全量。本次一次尝试实况:restart 自检通过(宿主为 packaged 非 dev 树,非 refusal),pr1-verify 沙箱已创建、dev 已 spawn,但屏幕锁定+显示器休眠(22:33 起,用户离机)致 120s 就绪超时且截图/交互物理不可行(截屏全黑)。"
    },
    "desktop.wordmark.asset|windows|zh-TW|global": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "待集中批捕:lead 裁决③降级预案(2026-07-20)——全部实现 PR 合入后由 lead 统一安排 live-app 阶段补齐视觉证据并补跑 --slice 全量。本次一次尝试实况:restart 自检通过(宿主为 packaged 非 dev 树,非 refusal),pr1-verify 沙箱已创建、dev 已 spawn,但屏幕锁定+显示器休眠(22:33 起,用户离机)致 120s 就绪超时且截图/交互物理不可行(截屏全黑)。"
    },
    "desktop.wordmark.asset|windows|en|cn": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "待集中批捕:lead 裁决③降级预案(2026-07-20)——全部实现 PR 合入后由 lead 统一安排 live-app 阶段补齐视觉证据并补跑 --slice 全量。本次一次尝试实况:restart 自检通过(宿主为 packaged 非 dev 树,非 refusal),pr1-verify 沙箱已创建、dev 已 spawn,但屏幕锁定+显示器休眠(22:33 起,用户离机)致 120s 就绪超时且截图/交互物理不可行(截屏全黑)。"
    },
    "desktop.wordmark.asset|windows|en|global": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "待集中批捕:lead 裁决③降级预案(2026-07-20)——全部实现 PR 合入后由 lead 统一安排 live-app 阶段补齐视觉证据并补跑 --slice 全量。本次一次尝试实况:restart 自检通过(宿主为 packaged 非 dev 树,非 refusal),pr1-verify 沙箱已创建、dev 已 spawn,但屏幕锁定+显示器休眠(22:33 起,用户离机)致 120s 就绪超时且截图/交互物理不可行(截屏全黑)。"
    },
    "desktop.wordmark.asset|windows|ja|cn": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "待集中批捕:lead 裁决③降级预案(2026-07-20)——全部实现 PR 合入后由 lead 统一安排 live-app 阶段补齐视觉证据并补跑 --slice 全量。本次一次尝试实况:restart 自检通过(宿主为 packaged 非 dev 树,非 refusal),pr1-verify 沙箱已创建、dev 已 spawn,但屏幕锁定+显示器休眠(22:33 起,用户离机)致 120s 就绪超时且截图/交互物理不可行(截屏全黑)。"
    },
    "desktop.wordmark.asset|windows|ja|global": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "待集中批捕:lead 裁决③降级预案(2026-07-20)——全部实现 PR 合入后由 lead 统一安排 live-app 阶段补齐视觉证据并补跑 --slice 全量。本次一次尝试实况:restart 自检通过(宿主为 packaged 非 dev 树,非 refusal),pr1-verify 沙箱已创建、dev 已 spawn,但屏幕锁定+显示器休眠(22:33 起,用户离机)致 120s 就绪超时且截图/交互物理不可行(截屏全黑)。"
    },
    "desktop.wordmark.asset|windows|ko|cn": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "待集中批捕:lead 裁决③降级预案(2026-07-20)——全部实现 PR 合入后由 lead 统一安排 live-app 阶段补齐视觉证据并补跑 --slice 全量。本次一次尝试实况:restart 自检通过(宿主为 packaged 非 dev 树,非 refusal),pr1-verify 沙箱已创建、dev 已 spawn,但屏幕锁定+显示器休眠(22:33 起,用户离机)致 120s 就绪超时且截图/交互物理不可行(截屏全黑)。"
    },
    "desktop.wordmark.asset|windows|ko|global": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "待集中批捕:lead 裁决③降级预案(2026-07-20)——全部实现 PR 合入后由 lead 统一安排 live-app 阶段补齐视觉证据并补跑 --slice 全量。本次一次尝试实况:restart 自检通过(宿主为 packaged 非 dev 树,非 refusal),pr1-verify 沙箱已创建、dev 已 spawn,但屏幕锁定+显示器休眠(22:33 起,用户离机)致 120s 就绪超时且截图/交互物理不可行(截屏全黑)。"
    },
    "desktop.slogan.style|mac|zh-CN|cn": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "待集中批捕:lead 裁决③降级预案(2026-07-20)——全部实现 PR 合入后由 lead 统一安排 live-app 阶段补齐视觉证据并补跑 --slice 全量。本次一次尝试实况:restart 自检通过(宿主为 packaged 非 dev 树,非 refusal),pr1-verify 沙箱已创建、dev 已 spawn,但屏幕锁定+显示器休眠(22:33 起,用户离机)致 120s 就绪超时且截图/交互物理不可行(截屏全黑)。"
    },
    "desktop.slogan.style|mac|zh-CN|global": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "待集中批捕:lead 裁决③降级预案(2026-07-20)——全部实现 PR 合入后由 lead 统一安排 live-app 阶段补齐视觉证据并补跑 --slice 全量。本次一次尝试实况:restart 自检通过(宿主为 packaged 非 dev 树,非 refusal),pr1-verify 沙箱已创建、dev 已 spawn,但屏幕锁定+显示器休眠(22:33 起,用户离机)致 120s 就绪超时且截图/交互物理不可行(截屏全黑)。"
    },
    "desktop.slogan.style|mac|zh-TW|cn": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "待集中批捕:lead 裁决③降级预案(2026-07-20)——全部实现 PR 合入后由 lead 统一安排 live-app 阶段补齐视觉证据并补跑 --slice 全量。本次一次尝试实况:restart 自检通过(宿主为 packaged 非 dev 树,非 refusal),pr1-verify 沙箱已创建、dev 已 spawn,但屏幕锁定+显示器休眠(22:33 起,用户离机)致 120s 就绪超时且截图/交互物理不可行(截屏全黑)。"
    },
    "desktop.slogan.style|mac|zh-TW|global": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "待集中批捕:lead 裁决③降级预案(2026-07-20)——全部实现 PR 合入后由 lead 统一安排 live-app 阶段补齐视觉证据并补跑 --slice 全量。本次一次尝试实况:restart 自检通过(宿主为 packaged 非 dev 树,非 refusal),pr1-verify 沙箱已创建、dev 已 spawn,但屏幕锁定+显示器休眠(22:33 起,用户离机)致 120s 就绪超时且截图/交互物理不可行(截屏全黑)。"
    },
    "desktop.slogan.style|mac|en|cn": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "待集中批捕:lead 裁决③降级预案(2026-07-20)——全部实现 PR 合入后由 lead 统一安排 live-app 阶段补齐视觉证据并补跑 --slice 全量。本次一次尝试实况:restart 自检通过(宿主为 packaged 非 dev 树,非 refusal),pr1-verify 沙箱已创建、dev 已 spawn,但屏幕锁定+显示器休眠(22:33 起,用户离机)致 120s 就绪超时且截图/交互物理不可行(截屏全黑)。"
    },
    "desktop.slogan.style|mac|en|global": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "待集中批捕:lead 裁决③降级预案(2026-07-20)——全部实现 PR 合入后由 lead 统一安排 live-app 阶段补齐视觉证据并补跑 --slice 全量。本次一次尝试实况:restart 自检通过(宿主为 packaged 非 dev 树,非 refusal),pr1-verify 沙箱已创建、dev 已 spawn,但屏幕锁定+显示器休眠(22:33 起,用户离机)致 120s 就绪超时且截图/交互物理不可行(截屏全黑)。"
    },
    "desktop.slogan.style|mac|ja|cn": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "待集中批捕:lead 裁决③降级预案(2026-07-20)——全部实现 PR 合入后由 lead 统一安排 live-app 阶段补齐视觉证据并补跑 --slice 全量。本次一次尝试实况:restart 自检通过(宿主为 packaged 非 dev 树,非 refusal),pr1-verify 沙箱已创建、dev 已 spawn,但屏幕锁定+显示器休眠(22:33 起,用户离机)致 120s 就绪超时且截图/交互物理不可行(截屏全黑)。"
    },
    "desktop.slogan.style|mac|ja|global": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "待集中批捕:lead 裁决③降级预案(2026-07-20)——全部实现 PR 合入后由 lead 统一安排 live-app 阶段补齐视觉证据并补跑 --slice 全量。本次一次尝试实况:restart 自检通过(宿主为 packaged 非 dev 树,非 refusal),pr1-verify 沙箱已创建、dev 已 spawn,但屏幕锁定+显示器休眠(22:33 起,用户离机)致 120s 就绪超时且截图/交互物理不可行(截屏全黑)。"
    },
    "desktop.slogan.style|mac|ko|cn": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "待集中批捕:lead 裁决③降级预案(2026-07-20)——全部实现 PR 合入后由 lead 统一安排 live-app 阶段补齐视觉证据并补跑 --slice 全量。本次一次尝试实况:restart 自检通过(宿主为 packaged 非 dev 树,非 refusal),pr1-verify 沙箱已创建、dev 已 spawn,但屏幕锁定+显示器休眠(22:33 起,用户离机)致 120s 就绪超时且截图/交互物理不可行(截屏全黑)。"
    },
    "desktop.slogan.style|mac|ko|global": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "待集中批捕:lead 裁决③降级预案(2026-07-20)——全部实现 PR 合入后由 lead 统一安排 live-app 阶段补齐视觉证据并补跑 --slice 全量。本次一次尝试实况:restart 自检通过(宿主为 packaged 非 dev 树,非 refusal),pr1-verify 沙箱已创建、dev 已 spawn,但屏幕锁定+显示器休眠(22:33 起,用户离机)致 120s 就绪超时且截图/交互物理不可行(截屏全黑)。"
    },
    "desktop.slogan.style|windows|zh-CN|cn": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "待集中批捕:lead 裁决③降级预案(2026-07-20)——全部实现 PR 合入后由 lead 统一安排 live-app 阶段补齐视觉证据并补跑 --slice 全量。本次一次尝试实况:restart 自检通过(宿主为 packaged 非 dev 树,非 refusal),pr1-verify 沙箱已创建、dev 已 spawn,但屏幕锁定+显示器休眠(22:33 起,用户离机)致 120s 就绪超时且截图/交互物理不可行(截屏全黑)。"
    },
    "desktop.slogan.style|windows|zh-CN|global": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "待集中批捕:lead 裁决③降级预案(2026-07-20)——全部实现 PR 合入后由 lead 统一安排 live-app 阶段补齐视觉证据并补跑 --slice 全量。本次一次尝试实况:restart 自检通过(宿主为 packaged 非 dev 树,非 refusal),pr1-verify 沙箱已创建、dev 已 spawn,但屏幕锁定+显示器休眠(22:33 起,用户离机)致 120s 就绪超时且截图/交互物理不可行(截屏全黑)。"
    },
    "desktop.slogan.style|windows|zh-TW|cn": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "待集中批捕:lead 裁决③降级预案(2026-07-20)——全部实现 PR 合入后由 lead 统一安排 live-app 阶段补齐视觉证据并补跑 --slice 全量。本次一次尝试实况:restart 自检通过(宿主为 packaged 非 dev 树,非 refusal),pr1-verify 沙箱已创建、dev 已 spawn,但屏幕锁定+显示器休眠(22:33 起,用户离机)致 120s 就绪超时且截图/交互物理不可行(截屏全黑)。"
    },
    "desktop.slogan.style|windows|zh-TW|global": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "待集中批捕:lead 裁决③降级预案(2026-07-20)——全部实现 PR 合入后由 lead 统一安排 live-app 阶段补齐视觉证据并补跑 --slice 全量。本次一次尝试实况:restart 自检通过(宿主为 packaged 非 dev 树,非 refusal),pr1-verify 沙箱已创建、dev 已 spawn,但屏幕锁定+显示器休眠(22:33 起,用户离机)致 120s 就绪超时且截图/交互物理不可行(截屏全黑)。"
    },
    "desktop.slogan.style|windows|en|cn": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "待集中批捕:lead 裁决③降级预案(2026-07-20)——全部实现 PR 合入后由 lead 统一安排 live-app 阶段补齐视觉证据并补跑 --slice 全量。本次一次尝试实况:restart 自检通过(宿主为 packaged 非 dev 树,非 refusal),pr1-verify 沙箱已创建、dev 已 spawn,但屏幕锁定+显示器休眠(22:33 起,用户离机)致 120s 就绪超时且截图/交互物理不可行(截屏全黑)。"
    },
    "desktop.slogan.style|windows|en|global": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "待集中批捕:lead 裁决③降级预案(2026-07-20)——全部实现 PR 合入后由 lead 统一安排 live-app 阶段补齐视觉证据并补跑 --slice 全量。本次一次尝试实况:restart 自检通过(宿主为 packaged 非 dev 树,非 refusal),pr1-verify 沙箱已创建、dev 已 spawn,但屏幕锁定+显示器休眠(22:33 起,用户离机)致 120s 就绪超时且截图/交互物理不可行(截屏全黑)。"
    },
    "desktop.slogan.style|windows|ja|cn": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "待集中批捕:lead 裁决③降级预案(2026-07-20)——全部实现 PR 合入后由 lead 统一安排 live-app 阶段补齐视觉证据并补跑 --slice 全量。本次一次尝试实况:restart 自检通过(宿主为 packaged 非 dev 树,非 refusal),pr1-verify 沙箱已创建、dev 已 spawn,但屏幕锁定+显示器休眠(22:33 起,用户离机)致 120s 就绪超时且截图/交互物理不可行(截屏全黑)。"
    },
    "desktop.slogan.style|windows|ja|global": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "待集中批捕:lead 裁决③降级预案(2026-07-20)——全部实现 PR 合入后由 lead 统一安排 live-app 阶段补齐视觉证据并补跑 --slice 全量。本次一次尝试实况:restart 自检通过(宿主为 packaged 非 dev 树,非 refusal),pr1-verify 沙箱已创建、dev 已 spawn,但屏幕锁定+显示器休眠(22:33 起,用户离机)致 120s 就绪超时且截图/交互物理不可行(截屏全黑)。"
    },
    "desktop.slogan.style|windows|ko|cn": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "待集中批捕:lead 裁决③降级预案(2026-07-20)——全部实现 PR 合入后由 lead 统一安排 live-app 阶段补齐视觉证据并补跑 --slice 全量。本次一次尝试实况:restart 自检通过(宿主为 packaged 非 dev 树,非 refusal),pr1-verify 沙箱已创建、dev 已 spawn,但屏幕锁定+显示器休眠(22:33 起,用户离机)致 120s 就绪超时且截图/交互物理不可行(截屏全黑)。"
    },
    "desktop.slogan.style|windows|ko|global": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "待集中批捕:lead 裁决③降级预案(2026-07-20)——全部实现 PR 合入后由 lead 统一安排 live-app 阶段补齐视觉证据并补跑 --slice 全量。本次一次尝试实况:restart 自检通过(宿主为 packaged 非 dev 树,非 refusal),pr1-verify 沙箱已创建、dev 已 spawn,但屏幕锁定+显示器休眠(22:33 起,用户离机)致 120s 就绪超时且截图/交互物理不可行(截屏全黑)。"
    },
    "desktop.slogan.geometry|mac|zh-CN|cn": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "待集中批捕:lead 裁决③降级预案(2026-07-20)——全部实现 PR 合入后由 lead 统一安排 live-app 阶段补齐视觉证据并补跑 --slice 全量。本次一次尝试实况:restart 自检通过(宿主为 packaged 非 dev 树,非 refusal),pr1-verify 沙箱已创建、dev 已 spawn,但屏幕锁定+显示器休眠(22:33 起,用户离机)致 120s 就绪超时且截图/交互物理不可行(截屏全黑)。"
    },
    "desktop.slogan.geometry|mac|zh-CN|global": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "待集中批捕:lead 裁决③降级预案(2026-07-20)——全部实现 PR 合入后由 lead 统一安排 live-app 阶段补齐视觉证据并补跑 --slice 全量。本次一次尝试实况:restart 自检通过(宿主为 packaged 非 dev 树,非 refusal),pr1-verify 沙箱已创建、dev 已 spawn,但屏幕锁定+显示器休眠(22:33 起,用户离机)致 120s 就绪超时且截图/交互物理不可行(截屏全黑)。"
    },
    "desktop.slogan.geometry|mac|zh-TW|cn": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "待集中批捕:lead 裁决③降级预案(2026-07-20)——全部实现 PR 合入后由 lead 统一安排 live-app 阶段补齐视觉证据并补跑 --slice 全量。本次一次尝试实况:restart 自检通过(宿主为 packaged 非 dev 树,非 refusal),pr1-verify 沙箱已创建、dev 已 spawn,但屏幕锁定+显示器休眠(22:33 起,用户离机)致 120s 就绪超时且截图/交互物理不可行(截屏全黑)。"
    },
    "desktop.slogan.geometry|mac|zh-TW|global": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "待集中批捕:lead 裁决③降级预案(2026-07-20)——全部实现 PR 合入后由 lead 统一安排 live-app 阶段补齐视觉证据并补跑 --slice 全量。本次一次尝试实况:restart 自检通过(宿主为 packaged 非 dev 树,非 refusal),pr1-verify 沙箱已创建、dev 已 spawn,但屏幕锁定+显示器休眠(22:33 起,用户离机)致 120s 就绪超时且截图/交互物理不可行(截屏全黑)。"
    },
    "desktop.slogan.geometry|mac|en|cn": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "待集中批捕:lead 裁决③降级预案(2026-07-20)——全部实现 PR 合入后由 lead 统一安排 live-app 阶段补齐视觉证据并补跑 --slice 全量。本次一次尝试实况:restart 自检通过(宿主为 packaged 非 dev 树,非 refusal),pr1-verify 沙箱已创建、dev 已 spawn,但屏幕锁定+显示器休眠(22:33 起,用户离机)致 120s 就绪超时且截图/交互物理不可行(截屏全黑)。"
    },
    "desktop.slogan.geometry|mac|en|global": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "待集中批捕:lead 裁决③降级预案(2026-07-20)——全部实现 PR 合入后由 lead 统一安排 live-app 阶段补齐视觉证据并补跑 --slice 全量。本次一次尝试实况:restart 自检通过(宿主为 packaged 非 dev 树,非 refusal),pr1-verify 沙箱已创建、dev 已 spawn,但屏幕锁定+显示器休眠(22:33 起,用户离机)致 120s 就绪超时且截图/交互物理不可行(截屏全黑)。"
    },
    "desktop.slogan.geometry|mac|ja|cn": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "待集中批捕:lead 裁决③降级预案(2026-07-20)——全部实现 PR 合入后由 lead 统一安排 live-app 阶段补齐视觉证据并补跑 --slice 全量。本次一次尝试实况:restart 自检通过(宿主为 packaged 非 dev 树,非 refusal),pr1-verify 沙箱已创建、dev 已 spawn,但屏幕锁定+显示器休眠(22:33 起,用户离机)致 120s 就绪超时且截图/交互物理不可行(截屏全黑)。"
    },
    "desktop.slogan.geometry|mac|ja|global": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "待集中批捕:lead 裁决③降级预案(2026-07-20)——全部实现 PR 合入后由 lead 统一安排 live-app 阶段补齐视觉证据并补跑 --slice 全量。本次一次尝试实况:restart 自检通过(宿主为 packaged 非 dev 树,非 refusal),pr1-verify 沙箱已创建、dev 已 spawn,但屏幕锁定+显示器休眠(22:33 起,用户离机)致 120s 就绪超时且截图/交互物理不可行(截屏全黑)。"
    },
    "desktop.slogan.geometry|mac|ko|cn": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "待集中批捕:lead 裁决③降级预案(2026-07-20)——全部实现 PR 合入后由 lead 统一安排 live-app 阶段补齐视觉证据并补跑 --slice 全量。本次一次尝试实况:restart 自检通过(宿主为 packaged 非 dev 树,非 refusal),pr1-verify 沙箱已创建、dev 已 spawn,但屏幕锁定+显示器休眠(22:33 起,用户离机)致 120s 就绪超时且截图/交互物理不可行(截屏全黑)。"
    },
    "desktop.slogan.geometry|mac|ko|global": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "待集中批捕:lead 裁决③降级预案(2026-07-20)——全部实现 PR 合入后由 lead 统一安排 live-app 阶段补齐视觉证据并补跑 --slice 全量。本次一次尝试实况:restart 自检通过(宿主为 packaged 非 dev 树,非 refusal),pr1-verify 沙箱已创建、dev 已 spawn,但屏幕锁定+显示器休眠(22:33 起,用户离机)致 120s 就绪超时且截图/交互物理不可行(截屏全黑)。"
    },
    "desktop.slogan.geometry|windows|zh-CN|cn": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "待集中批捕:lead 裁决③降级预案(2026-07-20)——全部实现 PR 合入后由 lead 统一安排 live-app 阶段补齐视觉证据并补跑 --slice 全量。本次一次尝试实况:restart 自检通过(宿主为 packaged 非 dev 树,非 refusal),pr1-verify 沙箱已创建、dev 已 spawn,但屏幕锁定+显示器休眠(22:33 起,用户离机)致 120s 就绪超时且截图/交互物理不可行(截屏全黑)。"
    },
    "desktop.slogan.geometry|windows|zh-CN|global": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "待集中批捕:lead 裁决③降级预案(2026-07-20)——全部实现 PR 合入后由 lead 统一安排 live-app 阶段补齐视觉证据并补跑 --slice 全量。本次一次尝试实况:restart 自检通过(宿主为 packaged 非 dev 树,非 refusal),pr1-verify 沙箱已创建、dev 已 spawn,但屏幕锁定+显示器休眠(22:33 起,用户离机)致 120s 就绪超时且截图/交互物理不可行(截屏全黑)。"
    },
    "desktop.slogan.geometry|windows|zh-TW|cn": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "待集中批捕:lead 裁决③降级预案(2026-07-20)——全部实现 PR 合入后由 lead 统一安排 live-app 阶段补齐视觉证据并补跑 --slice 全量。本次一次尝试实况:restart 自检通过(宿主为 packaged 非 dev 树,非 refusal),pr1-verify 沙箱已创建、dev 已 spawn,但屏幕锁定+显示器休眠(22:33 起,用户离机)致 120s 就绪超时且截图/交互物理不可行(截屏全黑)。"
    },
    "desktop.slogan.geometry|windows|zh-TW|global": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "待集中批捕:lead 裁决③降级预案(2026-07-20)——全部实现 PR 合入后由 lead 统一安排 live-app 阶段补齐视觉证据并补跑 --slice 全量。本次一次尝试实况:restart 自检通过(宿主为 packaged 非 dev 树,非 refusal),pr1-verify 沙箱已创建、dev 已 spawn,但屏幕锁定+显示器休眠(22:33 起,用户离机)致 120s 就绪超时且截图/交互物理不可行(截屏全黑)。"
    },
    "desktop.slogan.geometry|windows|en|cn": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "待集中批捕:lead 裁决③降级预案(2026-07-20)——全部实现 PR 合入后由 lead 统一安排 live-app 阶段补齐视觉证据并补跑 --slice 全量。本次一次尝试实况:restart 自检通过(宿主为 packaged 非 dev 树,非 refusal),pr1-verify 沙箱已创建、dev 已 spawn,但屏幕锁定+显示器休眠(22:33 起,用户离机)致 120s 就绪超时且截图/交互物理不可行(截屏全黑)。"
    },
    "desktop.slogan.geometry|windows|en|global": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "待集中批捕:lead 裁决③降级预案(2026-07-20)——全部实现 PR 合入后由 lead 统一安排 live-app 阶段补齐视觉证据并补跑 --slice 全量。本次一次尝试实况:restart 自检通过(宿主为 packaged 非 dev 树,非 refusal),pr1-verify 沙箱已创建、dev 已 spawn,但屏幕锁定+显示器休眠(22:33 起,用户离机)致 120s 就绪超时且截图/交互物理不可行(截屏全黑)。"
    },
    "desktop.slogan.geometry|windows|ja|cn": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "待集中批捕:lead 裁决③降级预案(2026-07-20)——全部实现 PR 合入后由 lead 统一安排 live-app 阶段补齐视觉证据并补跑 --slice 全量。本次一次尝试实况:restart 自检通过(宿主为 packaged 非 dev 树,非 refusal),pr1-verify 沙箱已创建、dev 已 spawn,但屏幕锁定+显示器休眠(22:33 起,用户离机)致 120s 就绪超时且截图/交互物理不可行(截屏全黑)。"
    },
    "desktop.slogan.geometry|windows|ja|global": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "待集中批捕:lead 裁决③降级预案(2026-07-20)——全部实现 PR 合入后由 lead 统一安排 live-app 阶段补齐视觉证据并补跑 --slice 全量。本次一次尝试实况:restart 自检通过(宿主为 packaged 非 dev 树,非 refusal),pr1-verify 沙箱已创建、dev 已 spawn,但屏幕锁定+显示器休眠(22:33 起,用户离机)致 120s 就绪超时且截图/交互物理不可行(截屏全黑)。"
    },
    "desktop.slogan.geometry|windows|ko|cn": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "待集中批捕:lead 裁决③降级预案(2026-07-20)——全部实现 PR 合入后由 lead 统一安排 live-app 阶段补齐视觉证据并补跑 --slice 全量。本次一次尝试实况:restart 自检通过(宿主为 packaged 非 dev 树,非 refusal),pr1-verify 沙箱已创建、dev 已 spawn,但屏幕锁定+显示器休眠(22:33 起,用户离机)致 120s 就绪超时且截图/交互物理不可行(截屏全黑)。"
    },
    "desktop.slogan.geometry|windows|ko|global": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "待集中批捕:lead 裁决③降级预案(2026-07-20)——全部实现 PR 合入后由 lead 统一安排 live-app 阶段补齐视觉证据并补跑 --slice 全量。本次一次尝试实况:restart 自检通过(宿主为 packaged 非 dev 树,非 refusal),pr1-verify 沙箱已创建、dev 已 spawn,但屏幕锁定+显示器休眠(22:33 起,用户离机)致 120s 就绪超时且截图/交互物理不可行(截屏全黑)。"
    },
    "desktop.identifier.state|mac|zh-CN|cn": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "待集中批捕:lead 裁决③降级预案(2026-07-20)——全部实现 PR 合入后由 lead 统一安排 live-app 阶段补齐视觉证据并补跑 --slice 全量。本次一次尝试实况:restart 自检通过(宿主为 packaged 非 dev 树,非 refusal),pr1-verify 沙箱已创建、dev 已 spawn,但屏幕锁定+显示器休眠(22:33 起,用户离机)致 120s 就绪超时且截图/交互物理不可行(截屏全黑)。"
    },
    "desktop.identifier.state|mac|zh-CN|global": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "待集中批捕:lead 裁决③降级预案(2026-07-20)——全部实现 PR 合入后由 lead 统一安排 live-app 阶段补齐视觉证据并补跑 --slice 全量。本次一次尝试实况:restart 自检通过(宿主为 packaged 非 dev 树,非 refusal),pr1-verify 沙箱已创建、dev 已 spawn,但屏幕锁定+显示器休眠(22:33 起,用户离机)致 120s 就绪超时且截图/交互物理不可行(截屏全黑)。"
    },
    "desktop.identifier.state|mac|zh-TW|cn": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "待集中批捕:lead 裁决③降级预案(2026-07-20)——全部实现 PR 合入后由 lead 统一安排 live-app 阶段补齐视觉证据并补跑 --slice 全量。本次一次尝试实况:restart 自检通过(宿主为 packaged 非 dev 树,非 refusal),pr1-verify 沙箱已创建、dev 已 spawn,但屏幕锁定+显示器休眠(22:33 起,用户离机)致 120s 就绪超时且截图/交互物理不可行(截屏全黑)。"
    },
    "desktop.identifier.state|mac|zh-TW|global": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "待集中批捕:lead 裁决③降级预案(2026-07-20)——全部实现 PR 合入后由 lead 统一安排 live-app 阶段补齐视觉证据并补跑 --slice 全量。本次一次尝试实况:restart 自检通过(宿主为 packaged 非 dev 树,非 refusal),pr1-verify 沙箱已创建、dev 已 spawn,但屏幕锁定+显示器休眠(22:33 起,用户离机)致 120s 就绪超时且截图/交互物理不可行(截屏全黑)。"
    },
    "desktop.identifier.state|mac|en|cn": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "待集中批捕:lead 裁决③降级预案(2026-07-20)——全部实现 PR 合入后由 lead 统一安排 live-app 阶段补齐视觉证据并补跑 --slice 全量。本次一次尝试实况:restart 自检通过(宿主为 packaged 非 dev 树,非 refusal),pr1-verify 沙箱已创建、dev 已 spawn,但屏幕锁定+显示器休眠(22:33 起,用户离机)致 120s 就绪超时且截图/交互物理不可行(截屏全黑)。"
    },
    "desktop.identifier.state|mac|en|global": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "待集中批捕:lead 裁决③降级预案(2026-07-20)——全部实现 PR 合入后由 lead 统一安排 live-app 阶段补齐视觉证据并补跑 --slice 全量。本次一次尝试实况:restart 自检通过(宿主为 packaged 非 dev 树,非 refusal),pr1-verify 沙箱已创建、dev 已 spawn,但屏幕锁定+显示器休眠(22:33 起,用户离机)致 120s 就绪超时且截图/交互物理不可行(截屏全黑)。"
    },
    "desktop.identifier.state|mac|ja|cn": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "待集中批捕:lead 裁决③降级预案(2026-07-20)——全部实现 PR 合入后由 lead 统一安排 live-app 阶段补齐视觉证据并补跑 --slice 全量。本次一次尝试实况:restart 自检通过(宿主为 packaged 非 dev 树,非 refusal),pr1-verify 沙箱已创建、dev 已 spawn,但屏幕锁定+显示器休眠(22:33 起,用户离机)致 120s 就绪超时且截图/交互物理不可行(截屏全黑)。"
    },
    "desktop.identifier.state|mac|ja|global": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "待集中批捕:lead 裁决③降级预案(2026-07-20)——全部实现 PR 合入后由 lead 统一安排 live-app 阶段补齐视觉证据并补跑 --slice 全量。本次一次尝试实况:restart 自检通过(宿主为 packaged 非 dev 树,非 refusal),pr1-verify 沙箱已创建、dev 已 spawn,但屏幕锁定+显示器休眠(22:33 起,用户离机)致 120s 就绪超时且截图/交互物理不可行(截屏全黑)。"
    },
    "desktop.identifier.state|mac|ko|cn": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "待集中批捕:lead 裁决③降级预案(2026-07-20)——全部实现 PR 合入后由 lead 统一安排 live-app 阶段补齐视觉证据并补跑 --slice 全量。本次一次尝试实况:restart 自检通过(宿主为 packaged 非 dev 树,非 refusal),pr1-verify 沙箱已创建、dev 已 spawn,但屏幕锁定+显示器休眠(22:33 起,用户离机)致 120s 就绪超时且截图/交互物理不可行(截屏全黑)。"
    },
    "desktop.identifier.state|mac|ko|global": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "待集中批捕:lead 裁决③降级预案(2026-07-20)——全部实现 PR 合入后由 lead 统一安排 live-app 阶段补齐视觉证据并补跑 --slice 全量。本次一次尝试实况:restart 自检通过(宿主为 packaged 非 dev 树,非 refusal),pr1-verify 沙箱已创建、dev 已 spawn,但屏幕锁定+显示器休眠(22:33 起,用户离机)致 120s 就绪超时且截图/交互物理不可行(截屏全黑)。"
    },
    "desktop.identifier.state|windows|zh-CN|cn": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "待集中批捕:lead 裁决③降级预案(2026-07-20)——全部实现 PR 合入后由 lead 统一安排 live-app 阶段补齐视觉证据并补跑 --slice 全量。本次一次尝试实况:restart 自检通过(宿主为 packaged 非 dev 树,非 refusal),pr1-verify 沙箱已创建、dev 已 spawn,但屏幕锁定+显示器休眠(22:33 起,用户离机)致 120s 就绪超时且截图/交互物理不可行(截屏全黑)。"
    },
    "desktop.identifier.state|windows|zh-CN|global": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "待集中批捕:lead 裁决③降级预案(2026-07-20)——全部实现 PR 合入后由 lead 统一安排 live-app 阶段补齐视觉证据并补跑 --slice 全量。本次一次尝试实况:restart 自检通过(宿主为 packaged 非 dev 树,非 refusal),pr1-verify 沙箱已创建、dev 已 spawn,但屏幕锁定+显示器休眠(22:33 起,用户离机)致 120s 就绪超时且截图/交互物理不可行(截屏全黑)。"
    },
    "desktop.identifier.state|windows|zh-TW|cn": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "待集中批捕:lead 裁决③降级预案(2026-07-20)——全部实现 PR 合入后由 lead 统一安排 live-app 阶段补齐视觉证据并补跑 --slice 全量。本次一次尝试实况:restart 自检通过(宿主为 packaged 非 dev 树,非 refusal),pr1-verify 沙箱已创建、dev 已 spawn,但屏幕锁定+显示器休眠(22:33 起,用户离机)致 120s 就绪超时且截图/交互物理不可行(截屏全黑)。"
    },
    "desktop.identifier.state|windows|zh-TW|global": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "待集中批捕:lead 裁决③降级预案(2026-07-20)——全部实现 PR 合入后由 lead 统一安排 live-app 阶段补齐视觉证据并补跑 --slice 全量。本次一次尝试实况:restart 自检通过(宿主为 packaged 非 dev 树,非 refusal),pr1-verify 沙箱已创建、dev 已 spawn,但屏幕锁定+显示器休眠(22:33 起,用户离机)致 120s 就绪超时且截图/交互物理不可行(截屏全黑)。"
    },
    "desktop.identifier.state|windows|en|cn": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "待集中批捕:lead 裁决③降级预案(2026-07-20)——全部实现 PR 合入后由 lead 统一安排 live-app 阶段补齐视觉证据并补跑 --slice 全量。本次一次尝试实况:restart 自检通过(宿主为 packaged 非 dev 树,非 refusal),pr1-verify 沙箱已创建、dev 已 spawn,但屏幕锁定+显示器休眠(22:33 起,用户离机)致 120s 就绪超时且截图/交互物理不可行(截屏全黑)。"
    },
    "desktop.identifier.state|windows|en|global": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "待集中批捕:lead 裁决③降级预案(2026-07-20)——全部实现 PR 合入后由 lead 统一安排 live-app 阶段补齐视觉证据并补跑 --slice 全量。本次一次尝试实况:restart 自检通过(宿主为 packaged 非 dev 树,非 refusal),pr1-verify 沙箱已创建、dev 已 spawn,但屏幕锁定+显示器休眠(22:33 起,用户离机)致 120s 就绪超时且截图/交互物理不可行(截屏全黑)。"
    },
    "desktop.identifier.state|windows|ja|cn": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "待集中批捕:lead 裁决③降级预案(2026-07-20)——全部实现 PR 合入后由 lead 统一安排 live-app 阶段补齐视觉证据并补跑 --slice 全量。本次一次尝试实况:restart 自检通过(宿主为 packaged 非 dev 树,非 refusal),pr1-verify 沙箱已创建、dev 已 spawn,但屏幕锁定+显示器休眠(22:33 起,用户离机)致 120s 就绪超时且截图/交互物理不可行(截屏全黑)。"
    },
    "desktop.identifier.state|windows|ja|global": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "待集中批捕:lead 裁决③降级预案(2026-07-20)——全部实现 PR 合入后由 lead 统一安排 live-app 阶段补齐视觉证据并补跑 --slice 全量。本次一次尝试实况:restart 自检通过(宿主为 packaged 非 dev 树,非 refusal),pr1-verify 沙箱已创建、dev 已 spawn,但屏幕锁定+显示器休眠(22:33 起,用户离机)致 120s 就绪超时且截图/交互物理不可行(截屏全黑)。"
    },
    "desktop.identifier.state|windows|ko|cn": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "待集中批捕:lead 裁决③降级预案(2026-07-20)——全部实现 PR 合入后由 lead 统一安排 live-app 阶段补齐视觉证据并补跑 --slice 全量。本次一次尝试实况:restart 自检通过(宿主为 packaged 非 dev 树,非 refusal),pr1-verify 沙箱已创建、dev 已 spawn,但屏幕锁定+显示器休眠(22:33 起,用户离机)致 120s 就绪超时且截图/交互物理不可行(截屏全黑)。"
    },
    "desktop.identifier.state|windows|ko|global": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "待集中批捕:lead 裁决③降级预案(2026-07-20)——全部实现 PR 合入后由 lead 统一安排 live-app 阶段补齐视觉证据并补跑 --slice 全量。本次一次尝试实况:restart 自检通过(宿主为 packaged 非 dev 树,非 refusal),pr1-verify 沙箱已创建、dev 已 spawn,但屏幕锁定+显示器休眠(22:33 起,用户离机)致 120s 就绪超时且截图/交互物理不可行(截屏全黑)。"
    },
    "desktop.identifier.input-state|mac|zh-CN|cn": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "待集中批捕:lead 裁决③降级预案(2026-07-20)——全部实现 PR 合入后由 lead 统一安排 live-app 阶段补齐视觉证据并补跑 --slice 全量。本次一次尝试实况:restart 自检通过(宿主为 packaged 非 dev 树,非 refusal),pr1-verify 沙箱已创建、dev 已 spawn,但屏幕锁定+显示器休眠(22:33 起,用户离机)致 120s 就绪超时且截图/交互物理不可行(截屏全黑)。"
    },
    "desktop.identifier.input-state|mac|zh-CN|global": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "待集中批捕:lead 裁决③降级预案(2026-07-20)——全部实现 PR 合入后由 lead 统一安排 live-app 阶段补齐视觉证据并补跑 --slice 全量。本次一次尝试实况:restart 自检通过(宿主为 packaged 非 dev 树,非 refusal),pr1-verify 沙箱已创建、dev 已 spawn,但屏幕锁定+显示器休眠(22:33 起,用户离机)致 120s 就绪超时且截图/交互物理不可行(截屏全黑)。"
    },
    "desktop.identifier.input-state|mac|zh-TW|cn": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "待集中批捕:lead 裁决③降级预案(2026-07-20)——全部实现 PR 合入后由 lead 统一安排 live-app 阶段补齐视觉证据并补跑 --slice 全量。本次一次尝试实况:restart 自检通过(宿主为 packaged 非 dev 树,非 refusal),pr1-verify 沙箱已创建、dev 已 spawn,但屏幕锁定+显示器休眠(22:33 起,用户离机)致 120s 就绪超时且截图/交互物理不可行(截屏全黑)。"
    },
    "desktop.identifier.input-state|mac|zh-TW|global": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "待集中批捕:lead 裁决③降级预案(2026-07-20)——全部实现 PR 合入后由 lead 统一安排 live-app 阶段补齐视觉证据并补跑 --slice 全量。本次一次尝试实况:restart 自检通过(宿主为 packaged 非 dev 树,非 refusal),pr1-verify 沙箱已创建、dev 已 spawn,但屏幕锁定+显示器休眠(22:33 起,用户离机)致 120s 就绪超时且截图/交互物理不可行(截屏全黑)。"
    },
    "desktop.identifier.input-state|mac|en|cn": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "待集中批捕:lead 裁决③降级预案(2026-07-20)——全部实现 PR 合入后由 lead 统一安排 live-app 阶段补齐视觉证据并补跑 --slice 全量。本次一次尝试实况:restart 自检通过(宿主为 packaged 非 dev 树,非 refusal),pr1-verify 沙箱已创建、dev 已 spawn,但屏幕锁定+显示器休眠(22:33 起,用户离机)致 120s 就绪超时且截图/交互物理不可行(截屏全黑)。"
    },
    "desktop.identifier.input-state|mac|en|global": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "待集中批捕:lead 裁决③降级预案(2026-07-20)——全部实现 PR 合入后由 lead 统一安排 live-app 阶段补齐视觉证据并补跑 --slice 全量。本次一次尝试实况:restart 自检通过(宿主为 packaged 非 dev 树,非 refusal),pr1-verify 沙箱已创建、dev 已 spawn,但屏幕锁定+显示器休眠(22:33 起,用户离机)致 120s 就绪超时且截图/交互物理不可行(截屏全黑)。"
    },
    "desktop.identifier.input-state|mac|ja|cn": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "待集中批捕:lead 裁决③降级预案(2026-07-20)——全部实现 PR 合入后由 lead 统一安排 live-app 阶段补齐视觉证据并补跑 --slice 全量。本次一次尝试实况:restart 自检通过(宿主为 packaged 非 dev 树,非 refusal),pr1-verify 沙箱已创建、dev 已 spawn,但屏幕锁定+显示器休眠(22:33 起,用户离机)致 120s 就绪超时且截图/交互物理不可行(截屏全黑)。"
    },
    "desktop.identifier.input-state|mac|ja|global": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "待集中批捕:lead 裁决③降级预案(2026-07-20)——全部实现 PR 合入后由 lead 统一安排 live-app 阶段补齐视觉证据并补跑 --slice 全量。本次一次尝试实况:restart 自检通过(宿主为 packaged 非 dev 树,非 refusal),pr1-verify 沙箱已创建、dev 已 spawn,但屏幕锁定+显示器休眠(22:33 起,用户离机)致 120s 就绪超时且截图/交互物理不可行(截屏全黑)。"
    },
    "desktop.identifier.input-state|mac|ko|cn": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "待集中批捕:lead 裁决③降级预案(2026-07-20)——全部实现 PR 合入后由 lead 统一安排 live-app 阶段补齐视觉证据并补跑 --slice 全量。本次一次尝试实况:restart 自检通过(宿主为 packaged 非 dev 树,非 refusal),pr1-verify 沙箱已创建、dev 已 spawn,但屏幕锁定+显示器休眠(22:33 起,用户离机)致 120s 就绪超时且截图/交互物理不可行(截屏全黑)。"
    },
    "desktop.identifier.input-state|mac|ko|global": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "待集中批捕:lead 裁决③降级预案(2026-07-20)——全部实现 PR 合入后由 lead 统一安排 live-app 阶段补齐视觉证据并补跑 --slice 全量。本次一次尝试实况:restart 自检通过(宿主为 packaged 非 dev 树,非 refusal),pr1-verify 沙箱已创建、dev 已 spawn,但屏幕锁定+显示器休眠(22:33 起,用户离机)致 120s 就绪超时且截图/交互物理不可行(截屏全黑)。"
    },
    "desktop.identifier.input-state|windows|zh-CN|cn": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "待集中批捕:lead 裁决③降级预案(2026-07-20)——全部实现 PR 合入后由 lead 统一安排 live-app 阶段补齐视觉证据并补跑 --slice 全量。本次一次尝试实况:restart 自检通过(宿主为 packaged 非 dev 树,非 refusal),pr1-verify 沙箱已创建、dev 已 spawn,但屏幕锁定+显示器休眠(22:33 起,用户离机)致 120s 就绪超时且截图/交互物理不可行(截屏全黑)。"
    },
    "desktop.identifier.input-state|windows|zh-CN|global": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "待集中批捕:lead 裁决③降级预案(2026-07-20)——全部实现 PR 合入后由 lead 统一安排 live-app 阶段补齐视觉证据并补跑 --slice 全量。本次一次尝试实况:restart 自检通过(宿主为 packaged 非 dev 树,非 refusal),pr1-verify 沙箱已创建、dev 已 spawn,但屏幕锁定+显示器休眠(22:33 起,用户离机)致 120s 就绪超时且截图/交互物理不可行(截屏全黑)。"
    },
    "desktop.identifier.input-state|windows|zh-TW|cn": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "待集中批捕:lead 裁决③降级预案(2026-07-20)——全部实现 PR 合入后由 lead 统一安排 live-app 阶段补齐视觉证据并补跑 --slice 全量。本次一次尝试实况:restart 自检通过(宿主为 packaged 非 dev 树,非 refusal),pr1-verify 沙箱已创建、dev 已 spawn,但屏幕锁定+显示器休眠(22:33 起,用户离机)致 120s 就绪超时且截图/交互物理不可行(截屏全黑)。"
    },
    "desktop.identifier.input-state|windows|zh-TW|global": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "待集中批捕:lead 裁决③降级预案(2026-07-20)——全部实现 PR 合入后由 lead 统一安排 live-app 阶段补齐视觉证据并补跑 --slice 全量。本次一次尝试实况:restart 自检通过(宿主为 packaged 非 dev 树,非 refusal),pr1-verify 沙箱已创建、dev 已 spawn,但屏幕锁定+显示器休眠(22:33 起,用户离机)致 120s 就绪超时且截图/交互物理不可行(截屏全黑)。"
    },
    "desktop.identifier.input-state|windows|en|cn": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "待集中批捕:lead 裁决③降级预案(2026-07-20)——全部实现 PR 合入后由 lead 统一安排 live-app 阶段补齐视觉证据并补跑 --slice 全量。本次一次尝试实况:restart 自检通过(宿主为 packaged 非 dev 树,非 refusal),pr1-verify 沙箱已创建、dev 已 spawn,但屏幕锁定+显示器休眠(22:33 起,用户离机)致 120s 就绪超时且截图/交互物理不可行(截屏全黑)。"
    },
    "desktop.identifier.input-state|windows|en|global": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "待集中批捕:lead 裁决③降级预案(2026-07-20)——全部实现 PR 合入后由 lead 统一安排 live-app 阶段补齐视觉证据并补跑 --slice 全量。本次一次尝试实况:restart 自检通过(宿主为 packaged 非 dev 树,非 refusal),pr1-verify 沙箱已创建、dev 已 spawn,但屏幕锁定+显示器休眠(22:33 起,用户离机)致 120s 就绪超时且截图/交互物理不可行(截屏全黑)。"
    },
    "desktop.identifier.input-state|windows|ja|cn": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "待集中批捕:lead 裁决③降级预案(2026-07-20)——全部实现 PR 合入后由 lead 统一安排 live-app 阶段补齐视觉证据并补跑 --slice 全量。本次一次尝试实况:restart 自检通过(宿主为 packaged 非 dev 树,非 refusal),pr1-verify 沙箱已创建、dev 已 spawn,但屏幕锁定+显示器休眠(22:33 起,用户离机)致 120s 就绪超时且截图/交互物理不可行(截屏全黑)。"
    },
    "desktop.identifier.input-state|windows|ja|global": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "待集中批捕:lead 裁决③降级预案(2026-07-20)——全部实现 PR 合入后由 lead 统一安排 live-app 阶段补齐视觉证据并补跑 --slice 全量。本次一次尝试实况:restart 自检通过(宿主为 packaged 非 dev 树,非 refusal),pr1-verify 沙箱已创建、dev 已 spawn,但屏幕锁定+显示器休眠(22:33 起,用户离机)致 120s 就绪超时且截图/交互物理不可行(截屏全黑)。"
    },
    "desktop.identifier.input-state|windows|ko|cn": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "待集中批捕:lead 裁决③降级预案(2026-07-20)——全部实现 PR 合入后由 lead 统一安排 live-app 阶段补齐视觉证据并补跑 --slice 全量。本次一次尝试实况:restart 自检通过(宿主为 packaged 非 dev 树,非 refusal),pr1-verify 沙箱已创建、dev 已 spawn,但屏幕锁定+显示器休眠(22:33 起,用户离机)致 120s 就绪超时且截图/交互物理不可行(截屏全黑)。"
    },
    "desktop.identifier.input-state|windows|ko|global": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "待集中批捕:lead 裁决③降级预案(2026-07-20)——全部实现 PR 合入后由 lead 统一安排 live-app 阶段补齐视觉证据并补跑 --slice 全量。本次一次尝试实况:restart 自检通过(宿主为 packaged 非 dev 树,非 refusal),pr1-verify 沙箱已创建、dev 已 spawn,但屏幕锁定+显示器休眠(22:33 起,用户离机)致 120s 就绪超时且截图/交互物理不可行(截屏全黑)。"
    },
    "desktop.sso-org.empty-state|mac|zh-CN|cn": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "待集中批捕:lead 裁决③降级预案(2026-07-20)——全部实现 PR 合入后由 lead 统一安排 live-app 阶段补齐视觉证据并补跑 --slice 全量。本次一次尝试实况:restart 自检通过(宿主为 packaged 非 dev 树,非 refusal),pr1-verify 沙箱已创建、dev 已 spawn,但屏幕锁定+显示器休眠(22:33 起,用户离机)致 120s 就绪超时且截图/交互物理不可行(截屏全黑)。"
    },
    "desktop.sso-org.empty-state|mac|zh-CN|global": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "待集中批捕:lead 裁决③降级预案(2026-07-20)——全部实现 PR 合入后由 lead 统一安排 live-app 阶段补齐视觉证据并补跑 --slice 全量。本次一次尝试实况:restart 自检通过(宿主为 packaged 非 dev 树,非 refusal),pr1-verify 沙箱已创建、dev 已 spawn,但屏幕锁定+显示器休眠(22:33 起,用户离机)致 120s 就绪超时且截图/交互物理不可行(截屏全黑)。"
    },
    "desktop.sso-org.empty-state|mac|zh-TW|cn": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "待集中批捕:lead 裁决③降级预案(2026-07-20)——全部实现 PR 合入后由 lead 统一安排 live-app 阶段补齐视觉证据并补跑 --slice 全量。本次一次尝试实况:restart 自检通过(宿主为 packaged 非 dev 树,非 refusal),pr1-verify 沙箱已创建、dev 已 spawn,但屏幕锁定+显示器休眠(22:33 起,用户离机)致 120s 就绪超时且截图/交互物理不可行(截屏全黑)。"
    },
    "desktop.sso-org.empty-state|mac|zh-TW|global": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "待集中批捕:lead 裁决③降级预案(2026-07-20)——全部实现 PR 合入后由 lead 统一安排 live-app 阶段补齐视觉证据并补跑 --slice 全量。本次一次尝试实况:restart 自检通过(宿主为 packaged 非 dev 树,非 refusal),pr1-verify 沙箱已创建、dev 已 spawn,但屏幕锁定+显示器休眠(22:33 起,用户离机)致 120s 就绪超时且截图/交互物理不可行(截屏全黑)。"
    },
    "desktop.sso-org.empty-state|mac|en|cn": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "待集中批捕:lead 裁决③降级预案(2026-07-20)——全部实现 PR 合入后由 lead 统一安排 live-app 阶段补齐视觉证据并补跑 --slice 全量。本次一次尝试实况:restart 自检通过(宿主为 packaged 非 dev 树,非 refusal),pr1-verify 沙箱已创建、dev 已 spawn,但屏幕锁定+显示器休眠(22:33 起,用户离机)致 120s 就绪超时且截图/交互物理不可行(截屏全黑)。"
    },
    "desktop.sso-org.empty-state|mac|en|global": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "待集中批捕:lead 裁决③降级预案(2026-07-20)——全部实现 PR 合入后由 lead 统一安排 live-app 阶段补齐视觉证据并补跑 --slice 全量。本次一次尝试实况:restart 自检通过(宿主为 packaged 非 dev 树,非 refusal),pr1-verify 沙箱已创建、dev 已 spawn,但屏幕锁定+显示器休眠(22:33 起,用户离机)致 120s 就绪超时且截图/交互物理不可行(截屏全黑)。"
    },
    "desktop.sso-org.empty-state|mac|ja|cn": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "待集中批捕:lead 裁决③降级预案(2026-07-20)——全部实现 PR 合入后由 lead 统一安排 live-app 阶段补齐视觉证据并补跑 --slice 全量。本次一次尝试实况:restart 自检通过(宿主为 packaged 非 dev 树,非 refusal),pr1-verify 沙箱已创建、dev 已 spawn,但屏幕锁定+显示器休眠(22:33 起,用户离机)致 120s 就绪超时且截图/交互物理不可行(截屏全黑)。"
    },
    "desktop.sso-org.empty-state|mac|ja|global": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "待集中批捕:lead 裁决③降级预案(2026-07-20)——全部实现 PR 合入后由 lead 统一安排 live-app 阶段补齐视觉证据并补跑 --slice 全量。本次一次尝试实况:restart 自检通过(宿主为 packaged 非 dev 树,非 refusal),pr1-verify 沙箱已创建、dev 已 spawn,但屏幕锁定+显示器休眠(22:33 起,用户离机)致 120s 就绪超时且截图/交互物理不可行(截屏全黑)。"
    },
    "desktop.sso-org.empty-state|mac|ko|cn": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "待集中批捕:lead 裁决③降级预案(2026-07-20)——全部实现 PR 合入后由 lead 统一安排 live-app 阶段补齐视觉证据并补跑 --slice 全量。本次一次尝试实况:restart 自检通过(宿主为 packaged 非 dev 树,非 refusal),pr1-verify 沙箱已创建、dev 已 spawn,但屏幕锁定+显示器休眠(22:33 起,用户离机)致 120s 就绪超时且截图/交互物理不可行(截屏全黑)。"
    },
    "desktop.sso-org.empty-state|mac|ko|global": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "待集中批捕:lead 裁决③降级预案(2026-07-20)——全部实现 PR 合入后由 lead 统一安排 live-app 阶段补齐视觉证据并补跑 --slice 全量。本次一次尝试实况:restart 自检通过(宿主为 packaged 非 dev 树,非 refusal),pr1-verify 沙箱已创建、dev 已 spawn,但屏幕锁定+显示器休眠(22:33 起,用户离机)致 120s 就绪超时且截图/交互物理不可行(截屏全黑)。"
    },
    "desktop.sso-org.empty-state|windows|zh-CN|cn": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "待集中批捕:lead 裁决③降级预案(2026-07-20)——全部实现 PR 合入后由 lead 统一安排 live-app 阶段补齐视觉证据并补跑 --slice 全量。本次一次尝试实况:restart 自检通过(宿主为 packaged 非 dev 树,非 refusal),pr1-verify 沙箱已创建、dev 已 spawn,但屏幕锁定+显示器休眠(22:33 起,用户离机)致 120s 就绪超时且截图/交互物理不可行(截屏全黑)。"
    },
    "desktop.sso-org.empty-state|windows|zh-CN|global": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "待集中批捕:lead 裁决③降级预案(2026-07-20)——全部实现 PR 合入后由 lead 统一安排 live-app 阶段补齐视觉证据并补跑 --slice 全量。本次一次尝试实况:restart 自检通过(宿主为 packaged 非 dev 树,非 refusal),pr1-verify 沙箱已创建、dev 已 spawn,但屏幕锁定+显示器休眠(22:33 起,用户离机)致 120s 就绪超时且截图/交互物理不可行(截屏全黑)。"
    },
    "desktop.sso-org.empty-state|windows|zh-TW|cn": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "待集中批捕:lead 裁决③降级预案(2026-07-20)——全部实现 PR 合入后由 lead 统一安排 live-app 阶段补齐视觉证据并补跑 --slice 全量。本次一次尝试实况:restart 自检通过(宿主为 packaged 非 dev 树,非 refusal),pr1-verify 沙箱已创建、dev 已 spawn,但屏幕锁定+显示器休眠(22:33 起,用户离机)致 120s 就绪超时且截图/交互物理不可行(截屏全黑)。"
    },
    "desktop.sso-org.empty-state|windows|zh-TW|global": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "待集中批捕:lead 裁决③降级预案(2026-07-20)——全部实现 PR 合入后由 lead 统一安排 live-app 阶段补齐视觉证据并补跑 --slice 全量。本次一次尝试实况:restart 自检通过(宿主为 packaged 非 dev 树,非 refusal),pr1-verify 沙箱已创建、dev 已 spawn,但屏幕锁定+显示器休眠(22:33 起,用户离机)致 120s 就绪超时且截图/交互物理不可行(截屏全黑)。"
    },
    "desktop.sso-org.empty-state|windows|en|cn": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "待集中批捕:lead 裁决③降级预案(2026-07-20)——全部实现 PR 合入后由 lead 统一安排 live-app 阶段补齐视觉证据并补跑 --slice 全量。本次一次尝试实况:restart 自检通过(宿主为 packaged 非 dev 树,非 refusal),pr1-verify 沙箱已创建、dev 已 spawn,但屏幕锁定+显示器休眠(22:33 起,用户离机)致 120s 就绪超时且截图/交互物理不可行(截屏全黑)。"
    },
    "desktop.sso-org.empty-state|windows|en|global": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "待集中批捕:lead 裁决③降级预案(2026-07-20)——全部实现 PR 合入后由 lead 统一安排 live-app 阶段补齐视觉证据并补跑 --slice 全量。本次一次尝试实况:restart 自检通过(宿主为 packaged 非 dev 树,非 refusal),pr1-verify 沙箱已创建、dev 已 spawn,但屏幕锁定+显示器休眠(22:33 起,用户离机)致 120s 就绪超时且截图/交互物理不可行(截屏全黑)。"
    },
    "desktop.sso-org.empty-state|windows|ja|cn": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "待集中批捕:lead 裁决③降级预案(2026-07-20)——全部实现 PR 合入后由 lead 统一安排 live-app 阶段补齐视觉证据并补跑 --slice 全量。本次一次尝试实况:restart 自检通过(宿主为 packaged 非 dev 树,非 refusal),pr1-verify 沙箱已创建、dev 已 spawn,但屏幕锁定+显示器休眠(22:33 起,用户离机)致 120s 就绪超时且截图/交互物理不可行(截屏全黑)。"
    },
    "desktop.sso-org.empty-state|windows|ja|global": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "待集中批捕:lead 裁决③降级预案(2026-07-20)——全部实现 PR 合入后由 lead 统一安排 live-app 阶段补齐视觉证据并补跑 --slice 全量。本次一次尝试实况:restart 自检通过(宿主为 packaged 非 dev 树,非 refusal),pr1-verify 沙箱已创建、dev 已 spawn,但屏幕锁定+显示器休眠(22:33 起,用户离机)致 120s 就绪超时且截图/交互物理不可行(截屏全黑)。"
    },
    "desktop.sso-org.empty-state|windows|ko|cn": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "待集中批捕:lead 裁决③降级预案(2026-07-20)——全部实现 PR 合入后由 lead 统一安排 live-app 阶段补齐视觉证据并补跑 --slice 全量。本次一次尝试实况:restart 自检通过(宿主为 packaged 非 dev 树,非 refusal),pr1-verify 沙箱已创建、dev 已 spawn,但屏幕锁定+显示器休眠(22:33 起,用户离机)致 120s 就绪超时且截图/交互物理不可行(截屏全黑)。"
    },
    "desktop.sso-org.empty-state|windows|ko|global": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "待集中批捕:lead 裁决③降级预案(2026-07-20)——全部实现 PR 合入后由 lead 统一安排 live-app 阶段补齐视觉证据并补跑 --slice 全量。本次一次尝试实况:restart 自检通过(宿主为 packaged 非 dev 树,非 refusal),pr1-verify 沙箱已创建、dev 已 spawn,但屏幕锁定+显示器休眠(22:33 起,用户离机)致 120s 就绪超时且截图/交互物理不可行(截屏全黑)。"
    },
    "desktop.sso-org.filled-state|mac|zh-CN|cn": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "待集中批捕:lead 裁决③降级预案(2026-07-20)——全部实现 PR 合入后由 lead 统一安排 live-app 阶段补齐视觉证据并补跑 --slice 全量。本次一次尝试实况:restart 自检通过(宿主为 packaged 非 dev 树,非 refusal),pr1-verify 沙箱已创建、dev 已 spawn,但屏幕锁定+显示器休眠(22:33 起,用户离机)致 120s 就绪超时且截图/交互物理不可行(截屏全黑)。"
    },
    "desktop.sso-org.filled-state|mac|zh-CN|global": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "待集中批捕:lead 裁决③降级预案(2026-07-20)——全部实现 PR 合入后由 lead 统一安排 live-app 阶段补齐视觉证据并补跑 --slice 全量。本次一次尝试实况:restart 自检通过(宿主为 packaged 非 dev 树,非 refusal),pr1-verify 沙箱已创建、dev 已 spawn,但屏幕锁定+显示器休眠(22:33 起,用户离机)致 120s 就绪超时且截图/交互物理不可行(截屏全黑)。"
    },
    "desktop.sso-org.filled-state|mac|zh-TW|cn": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "待集中批捕:lead 裁决③降级预案(2026-07-20)——全部实现 PR 合入后由 lead 统一安排 live-app 阶段补齐视觉证据并补跑 --slice 全量。本次一次尝试实况:restart 自检通过(宿主为 packaged 非 dev 树,非 refusal),pr1-verify 沙箱已创建、dev 已 spawn,但屏幕锁定+显示器休眠(22:33 起,用户离机)致 120s 就绪超时且截图/交互物理不可行(截屏全黑)。"
    },
    "desktop.sso-org.filled-state|mac|zh-TW|global": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "待集中批捕:lead 裁决③降级预案(2026-07-20)——全部实现 PR 合入后由 lead 统一安排 live-app 阶段补齐视觉证据并补跑 --slice 全量。本次一次尝试实况:restart 自检通过(宿主为 packaged 非 dev 树,非 refusal),pr1-verify 沙箱已创建、dev 已 spawn,但屏幕锁定+显示器休眠(22:33 起,用户离机)致 120s 就绪超时且截图/交互物理不可行(截屏全黑)。"
    },
    "desktop.sso-org.filled-state|mac|en|cn": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "待集中批捕:lead 裁决③降级预案(2026-07-20)——全部实现 PR 合入后由 lead 统一安排 live-app 阶段补齐视觉证据并补跑 --slice 全量。本次一次尝试实况:restart 自检通过(宿主为 packaged 非 dev 树,非 refusal),pr1-verify 沙箱已创建、dev 已 spawn,但屏幕锁定+显示器休眠(22:33 起,用户离机)致 120s 就绪超时且截图/交互物理不可行(截屏全黑)。"
    },
    "desktop.sso-org.filled-state|mac|en|global": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "待集中批捕:lead 裁决③降级预案(2026-07-20)——全部实现 PR 合入后由 lead 统一安排 live-app 阶段补齐视觉证据并补跑 --slice 全量。本次一次尝试实况:restart 自检通过(宿主为 packaged 非 dev 树,非 refusal),pr1-verify 沙箱已创建、dev 已 spawn,但屏幕锁定+显示器休眠(22:33 起,用户离机)致 120s 就绪超时且截图/交互物理不可行(截屏全黑)。"
    },
    "desktop.sso-org.filled-state|mac|ja|cn": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "待集中批捕:lead 裁决③降级预案(2026-07-20)——全部实现 PR 合入后由 lead 统一安排 live-app 阶段补齐视觉证据并补跑 --slice 全量。本次一次尝试实况:restart 自检通过(宿主为 packaged 非 dev 树,非 refusal),pr1-verify 沙箱已创建、dev 已 spawn,但屏幕锁定+显示器休眠(22:33 起,用户离机)致 120s 就绪超时且截图/交互物理不可行(截屏全黑)。"
    },
    "desktop.sso-org.filled-state|mac|ja|global": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "待集中批捕:lead 裁决③降级预案(2026-07-20)——全部实现 PR 合入后由 lead 统一安排 live-app 阶段补齐视觉证据并补跑 --slice 全量。本次一次尝试实况:restart 自检通过(宿主为 packaged 非 dev 树,非 refusal),pr1-verify 沙箱已创建、dev 已 spawn,但屏幕锁定+显示器休眠(22:33 起,用户离机)致 120s 就绪超时且截图/交互物理不可行(截屏全黑)。"
    },
    "desktop.sso-org.filled-state|mac|ko|cn": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "待集中批捕:lead 裁决③降级预案(2026-07-20)——全部实现 PR 合入后由 lead 统一安排 live-app 阶段补齐视觉证据并补跑 --slice 全量。本次一次尝试实况:restart 自检通过(宿主为 packaged 非 dev 树,非 refusal),pr1-verify 沙箱已创建、dev 已 spawn,但屏幕锁定+显示器休眠(22:33 起,用户离机)致 120s 就绪超时且截图/交互物理不可行(截屏全黑)。"
    },
    "desktop.sso-org.filled-state|mac|ko|global": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "待集中批捕:lead 裁决③降级预案(2026-07-20)——全部实现 PR 合入后由 lead 统一安排 live-app 阶段补齐视觉证据并补跑 --slice 全量。本次一次尝试实况:restart 自检通过(宿主为 packaged 非 dev 树,非 refusal),pr1-verify 沙箱已创建、dev 已 spawn,但屏幕锁定+显示器休眠(22:33 起,用户离机)致 120s 就绪超时且截图/交互物理不可行(截屏全黑)。"
    },
    "desktop.sso-org.filled-state|windows|zh-CN|cn": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "待集中批捕:lead 裁决③降级预案(2026-07-20)——全部实现 PR 合入后由 lead 统一安排 live-app 阶段补齐视觉证据并补跑 --slice 全量。本次一次尝试实况:restart 自检通过(宿主为 packaged 非 dev 树,非 refusal),pr1-verify 沙箱已创建、dev 已 spawn,但屏幕锁定+显示器休眠(22:33 起,用户离机)致 120s 就绪超时且截图/交互物理不可行(截屏全黑)。"
    },
    "desktop.sso-org.filled-state|windows|zh-CN|global": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "待集中批捕:lead 裁决③降级预案(2026-07-20)——全部实现 PR 合入后由 lead 统一安排 live-app 阶段补齐视觉证据并补跑 --slice 全量。本次一次尝试实况:restart 自检通过(宿主为 packaged 非 dev 树,非 refusal),pr1-verify 沙箱已创建、dev 已 spawn,但屏幕锁定+显示器休眠(22:33 起,用户离机)致 120s 就绪超时且截图/交互物理不可行(截屏全黑)。"
    },
    "desktop.sso-org.filled-state|windows|zh-TW|cn": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "待集中批捕:lead 裁决③降级预案(2026-07-20)——全部实现 PR 合入后由 lead 统一安排 live-app 阶段补齐视觉证据并补跑 --slice 全量。本次一次尝试实况:restart 自检通过(宿主为 packaged 非 dev 树,非 refusal),pr1-verify 沙箱已创建、dev 已 spawn,但屏幕锁定+显示器休眠(22:33 起,用户离机)致 120s 就绪超时且截图/交互物理不可行(截屏全黑)。"
    },
    "desktop.sso-org.filled-state|windows|zh-TW|global": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "待集中批捕:lead 裁决③降级预案(2026-07-20)——全部实现 PR 合入后由 lead 统一安排 live-app 阶段补齐视觉证据并补跑 --slice 全量。本次一次尝试实况:restart 自检通过(宿主为 packaged 非 dev 树,非 refusal),pr1-verify 沙箱已创建、dev 已 spawn,但屏幕锁定+显示器休眠(22:33 起,用户离机)致 120s 就绪超时且截图/交互物理不可行(截屏全黑)。"
    },
    "desktop.sso-org.filled-state|windows|en|cn": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "待集中批捕:lead 裁决③降级预案(2026-07-20)——全部实现 PR 合入后由 lead 统一安排 live-app 阶段补齐视觉证据并补跑 --slice 全量。本次一次尝试实况:restart 自检通过(宿主为 packaged 非 dev 树,非 refusal),pr1-verify 沙箱已创建、dev 已 spawn,但屏幕锁定+显示器休眠(22:33 起,用户离机)致 120s 就绪超时且截图/交互物理不可行(截屏全黑)。"
    },
    "desktop.sso-org.filled-state|windows|en|global": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "待集中批捕:lead 裁决③降级预案(2026-07-20)——全部实现 PR 合入后由 lead 统一安排 live-app 阶段补齐视觉证据并补跑 --slice 全量。本次一次尝试实况:restart 自检通过(宿主为 packaged 非 dev 树,非 refusal),pr1-verify 沙箱已创建、dev 已 spawn,但屏幕锁定+显示器休眠(22:33 起,用户离机)致 120s 就绪超时且截图/交互物理不可行(截屏全黑)。"
    },
    "desktop.sso-org.filled-state|windows|ja|cn": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "待集中批捕:lead 裁决③降级预案(2026-07-20)——全部实现 PR 合入后由 lead 统一安排 live-app 阶段补齐视觉证据并补跑 --slice 全量。本次一次尝试实况:restart 自检通过(宿主为 packaged 非 dev 树,非 refusal),pr1-verify 沙箱已创建、dev 已 spawn,但屏幕锁定+显示器休眠(22:33 起,用户离机)致 120s 就绪超时且截图/交互物理不可行(截屏全黑)。"
    },
    "desktop.sso-org.filled-state|windows|ja|global": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "待集中批捕:lead 裁决③降级预案(2026-07-20)——全部实现 PR 合入后由 lead 统一安排 live-app 阶段补齐视觉证据并补跑 --slice 全量。本次一次尝试实况:restart 自检通过(宿主为 packaged 非 dev 树,非 refusal),pr1-verify 沙箱已创建、dev 已 spawn,但屏幕锁定+显示器休眠(22:33 起,用户离机)致 120s 就绪超时且截图/交互物理不可行(截屏全黑)。"
    },
    "desktop.sso-org.filled-state|windows|ko|cn": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "待集中批捕:lead 裁决③降级预案(2026-07-20)——全部实现 PR 合入后由 lead 统一安排 live-app 阶段补齐视觉证据并补跑 --slice 全量。本次一次尝试实况:restart 自检通过(宿主为 packaged 非 dev 树,非 refusal),pr1-verify 沙箱已创建、dev 已 spawn,但屏幕锁定+显示器休眠(22:33 起,用户离机)致 120s 就绪超时且截图/交互物理不可行(截屏全黑)。"
    },
    "desktop.sso-org.filled-state|windows|ko|global": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "待集中批捕:lead 裁决③降级预案(2026-07-20)——全部实现 PR 合入后由 lead 统一安排 live-app 阶段补齐视觉证据并补跑 --slice 全量。本次一次尝试实况:restart 自检通过(宿主为 packaged 非 dev 树,非 refusal),pr1-verify 沙箱已创建、dev 已 spawn,但屏幕锁定+显示器休眠(22:33 起,用户离机)致 120s 就绪超时且截图/交互物理不可行(截屏全黑)。"
    },
    "desktop.sso-org.list-state|mac|zh-CN|cn": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "待集中批捕:lead 裁决③降级预案(2026-07-20)——全部实现 PR 合入后由 lead 统一安排 live-app 阶段补齐视觉证据并补跑 --slice 全量。本次一次尝试实况:restart 自检通过(宿主为 packaged 非 dev 树,非 refusal),pr1-verify 沙箱已创建、dev 已 spawn,但屏幕锁定+显示器休眠(22:33 起,用户离机)致 120s 就绪超时且截图/交互物理不可行(截屏全黑)。"
    },
    "desktop.sso-org.list-state|mac|zh-CN|global": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "待集中批捕:lead 裁决③降级预案(2026-07-20)——全部实现 PR 合入后由 lead 统一安排 live-app 阶段补齐视觉证据并补跑 --slice 全量。本次一次尝试实况:restart 自检通过(宿主为 packaged 非 dev 树,非 refusal),pr1-verify 沙箱已创建、dev 已 spawn,但屏幕锁定+显示器休眠(22:33 起,用户离机)致 120s 就绪超时且截图/交互物理不可行(截屏全黑)。"
    },
    "desktop.sso-org.list-state|mac|zh-TW|cn": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "待集中批捕:lead 裁决③降级预案(2026-07-20)——全部实现 PR 合入后由 lead 统一安排 live-app 阶段补齐视觉证据并补跑 --slice 全量。本次一次尝试实况:restart 自检通过(宿主为 packaged 非 dev 树,非 refusal),pr1-verify 沙箱已创建、dev 已 spawn,但屏幕锁定+显示器休眠(22:33 起,用户离机)致 120s 就绪超时且截图/交互物理不可行(截屏全黑)。"
    },
    "desktop.sso-org.list-state|mac|zh-TW|global": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "待集中批捕:lead 裁决③降级预案(2026-07-20)——全部实现 PR 合入后由 lead 统一安排 live-app 阶段补齐视觉证据并补跑 --slice 全量。本次一次尝试实况:restart 自检通过(宿主为 packaged 非 dev 树,非 refusal),pr1-verify 沙箱已创建、dev 已 spawn,但屏幕锁定+显示器休眠(22:33 起,用户离机)致 120s 就绪超时且截图/交互物理不可行(截屏全黑)。"
    },
    "desktop.sso-org.list-state|mac|en|cn": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "待集中批捕:lead 裁决③降级预案(2026-07-20)——全部实现 PR 合入后由 lead 统一安排 live-app 阶段补齐视觉证据并补跑 --slice 全量。本次一次尝试实况:restart 自检通过(宿主为 packaged 非 dev 树,非 refusal),pr1-verify 沙箱已创建、dev 已 spawn,但屏幕锁定+显示器休眠(22:33 起,用户离机)致 120s 就绪超时且截图/交互物理不可行(截屏全黑)。"
    },
    "desktop.sso-org.list-state|mac|en|global": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "待集中批捕:lead 裁决③降级预案(2026-07-20)——全部实现 PR 合入后由 lead 统一安排 live-app 阶段补齐视觉证据并补跑 --slice 全量。本次一次尝试实况:restart 自检通过(宿主为 packaged 非 dev 树,非 refusal),pr1-verify 沙箱已创建、dev 已 spawn,但屏幕锁定+显示器休眠(22:33 起,用户离机)致 120s 就绪超时且截图/交互物理不可行(截屏全黑)。"
    },
    "desktop.sso-org.list-state|mac|ja|cn": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "待集中批捕:lead 裁决③降级预案(2026-07-20)——全部实现 PR 合入后由 lead 统一安排 live-app 阶段补齐视觉证据并补跑 --slice 全量。本次一次尝试实况:restart 自检通过(宿主为 packaged 非 dev 树,非 refusal),pr1-verify 沙箱已创建、dev 已 spawn,但屏幕锁定+显示器休眠(22:33 起,用户离机)致 120s 就绪超时且截图/交互物理不可行(截屏全黑)。"
    },
    "desktop.sso-org.list-state|mac|ja|global": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "待集中批捕:lead 裁决③降级预案(2026-07-20)——全部实现 PR 合入后由 lead 统一安排 live-app 阶段补齐视觉证据并补跑 --slice 全量。本次一次尝试实况:restart 自检通过(宿主为 packaged 非 dev 树,非 refusal),pr1-verify 沙箱已创建、dev 已 spawn,但屏幕锁定+显示器休眠(22:33 起,用户离机)致 120s 就绪超时且截图/交互物理不可行(截屏全黑)。"
    },
    "desktop.sso-org.list-state|mac|ko|cn": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "待集中批捕:lead 裁决③降级预案(2026-07-20)——全部实现 PR 合入后由 lead 统一安排 live-app 阶段补齐视觉证据并补跑 --slice 全量。本次一次尝试实况:restart 自检通过(宿主为 packaged 非 dev 树,非 refusal),pr1-verify 沙箱已创建、dev 已 spawn,但屏幕锁定+显示器休眠(22:33 起,用户离机)致 120s 就绪超时且截图/交互物理不可行(截屏全黑)。"
    },
    "desktop.sso-org.list-state|mac|ko|global": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "待集中批捕:lead 裁决③降级预案(2026-07-20)——全部实现 PR 合入后由 lead 统一安排 live-app 阶段补齐视觉证据并补跑 --slice 全量。本次一次尝试实况:restart 自检通过(宿主为 packaged 非 dev 树,非 refusal),pr1-verify 沙箱已创建、dev 已 spawn,但屏幕锁定+显示器休眠(22:33 起,用户离机)致 120s 就绪超时且截图/交互物理不可行(截屏全黑)。"
    },
    "desktop.sso-org.list-state|windows|zh-CN|cn": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "待集中批捕:lead 裁决③降级预案(2026-07-20)——全部实现 PR 合入后由 lead 统一安排 live-app 阶段补齐视觉证据并补跑 --slice 全量。本次一次尝试实况:restart 自检通过(宿主为 packaged 非 dev 树,非 refusal),pr1-verify 沙箱已创建、dev 已 spawn,但屏幕锁定+显示器休眠(22:33 起,用户离机)致 120s 就绪超时且截图/交互物理不可行(截屏全黑)。"
    },
    "desktop.sso-org.list-state|windows|zh-CN|global": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "待集中批捕:lead 裁决③降级预案(2026-07-20)——全部实现 PR 合入后由 lead 统一安排 live-app 阶段补齐视觉证据并补跑 --slice 全量。本次一次尝试实况:restart 自检通过(宿主为 packaged 非 dev 树,非 refusal),pr1-verify 沙箱已创建、dev 已 spawn,但屏幕锁定+显示器休眠(22:33 起,用户离机)致 120s 就绪超时且截图/交互物理不可行(截屏全黑)。"
    },
    "desktop.sso-org.list-state|windows|zh-TW|cn": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "待集中批捕:lead 裁决③降级预案(2026-07-20)——全部实现 PR 合入后由 lead 统一安排 live-app 阶段补齐视觉证据并补跑 --slice 全量。本次一次尝试实况:restart 自检通过(宿主为 packaged 非 dev 树,非 refusal),pr1-verify 沙箱已创建、dev 已 spawn,但屏幕锁定+显示器休眠(22:33 起,用户离机)致 120s 就绪超时且截图/交互物理不可行(截屏全黑)。"
    },
    "desktop.sso-org.list-state|windows|zh-TW|global": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "待集中批捕:lead 裁决③降级预案(2026-07-20)——全部实现 PR 合入后由 lead 统一安排 live-app 阶段补齐视觉证据并补跑 --slice 全量。本次一次尝试实况:restart 自检通过(宿主为 packaged 非 dev 树,非 refusal),pr1-verify 沙箱已创建、dev 已 spawn,但屏幕锁定+显示器休眠(22:33 起,用户离机)致 120s 就绪超时且截图/交互物理不可行(截屏全黑)。"
    },
    "desktop.sso-org.list-state|windows|en|cn": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "待集中批捕:lead 裁决③降级预案(2026-07-20)——全部实现 PR 合入后由 lead 统一安排 live-app 阶段补齐视觉证据并补跑 --slice 全量。本次一次尝试实况:restart 自检通过(宿主为 packaged 非 dev 树,非 refusal),pr1-verify 沙箱已创建、dev 已 spawn,但屏幕锁定+显示器休眠(22:33 起,用户离机)致 120s 就绪超时且截图/交互物理不可行(截屏全黑)。"
    },
    "desktop.sso-org.list-state|windows|en|global": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "待集中批捕:lead 裁决③降级预案(2026-07-20)——全部实现 PR 合入后由 lead 统一安排 live-app 阶段补齐视觉证据并补跑 --slice 全量。本次一次尝试实况:restart 自检通过(宿主为 packaged 非 dev 树,非 refusal),pr1-verify 沙箱已创建、dev 已 spawn,但屏幕锁定+显示器休眠(22:33 起,用户离机)致 120s 就绪超时且截图/交互物理不可行(截屏全黑)。"
    },
    "desktop.sso-org.list-state|windows|ja|cn": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "待集中批捕:lead 裁决③降级预案(2026-07-20)——全部实现 PR 合入后由 lead 统一安排 live-app 阶段补齐视觉证据并补跑 --slice 全量。本次一次尝试实况:restart 自检通过(宿主为 packaged 非 dev 树,非 refusal),pr1-verify 沙箱已创建、dev 已 spawn,但屏幕锁定+显示器休眠(22:33 起,用户离机)致 120s 就绪超时且截图/交互物理不可行(截屏全黑)。"
    },
    "desktop.sso-org.list-state|windows|ja|global": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "待集中批捕:lead 裁决③降级预案(2026-07-20)——全部实现 PR 合入后由 lead 统一安排 live-app 阶段补齐视觉证据并补跑 --slice 全量。本次一次尝试实况:restart 自检通过(宿主为 packaged 非 dev 树,非 refusal),pr1-verify 沙箱已创建、dev 已 spawn,但屏幕锁定+显示器休眠(22:33 起,用户离机)致 120s 就绪超时且截图/交互物理不可行(截屏全黑)。"
    },
    "desktop.sso-org.list-state|windows|ko|cn": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "待集中批捕:lead 裁决③降级预案(2026-07-20)——全部实现 PR 合入后由 lead 统一安排 live-app 阶段补齐视觉证据并补跑 --slice 全量。本次一次尝试实况:restart 自检通过(宿主为 packaged 非 dev 树,非 refusal),pr1-verify 沙箱已创建、dev 已 spawn,但屏幕锁定+显示器休眠(22:33 起,用户离机)致 120s 就绪超时且截图/交互物理不可行(截屏全黑)。"
    },
    "desktop.sso-org.list-state|windows|ko|global": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "待集中批捕:lead 裁决③降级预案(2026-07-20)——全部实现 PR 合入后由 lead 统一安排 live-app 阶段补齐视觉证据并补跑 --slice 全量。本次一次尝试实况:restart 自检通过(宿主为 packaged 非 dev 树,非 refusal),pr1-verify 沙箱已创建、dev 已 spawn,但屏幕锁定+显示器休眠(22:33 起,用户离机)致 120s 就绪超时且截图/交互物理不可行(截屏全黑)。"
    },
    "desktop.preparing.state|mac|zh-CN|cn": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "待集中批捕:lead 裁决③降级预案(2026-07-20)——全部实现 PR 合入后由 lead 统一安排 live-app 阶段补齐视觉证据并补跑 --slice 全量。本次一次尝试实况:restart 自检通过(宿主为 packaged 非 dev 树,非 refusal),pr1-verify 沙箱已创建、dev 已 spawn,但屏幕锁定+显示器休眠(22:33 起,用户离机)致 120s 就绪超时且截图/交互物理不可行(截屏全黑)。"
    },
    "desktop.preparing.state|mac|zh-CN|global": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "待集中批捕:lead 裁决③降级预案(2026-07-20)——全部实现 PR 合入后由 lead 统一安排 live-app 阶段补齐视觉证据并补跑 --slice 全量。本次一次尝试实况:restart 自检通过(宿主为 packaged 非 dev 树,非 refusal),pr1-verify 沙箱已创建、dev 已 spawn,但屏幕锁定+显示器休眠(22:33 起,用户离机)致 120s 就绪超时且截图/交互物理不可行(截屏全黑)。"
    },
    "desktop.preparing.state|mac|zh-TW|cn": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "待集中批捕:lead 裁决③降级预案(2026-07-20)——全部实现 PR 合入后由 lead 统一安排 live-app 阶段补齐视觉证据并补跑 --slice 全量。本次一次尝试实况:restart 自检通过(宿主为 packaged 非 dev 树,非 refusal),pr1-verify 沙箱已创建、dev 已 spawn,但屏幕锁定+显示器休眠(22:33 起,用户离机)致 120s 就绪超时且截图/交互物理不可行(截屏全黑)。"
    },
    "desktop.preparing.state|mac|zh-TW|global": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "待集中批捕:lead 裁决③降级预案(2026-07-20)——全部实现 PR 合入后由 lead 统一安排 live-app 阶段补齐视觉证据并补跑 --slice 全量。本次一次尝试实况:restart 自检通过(宿主为 packaged 非 dev 树,非 refusal),pr1-verify 沙箱已创建、dev 已 spawn,但屏幕锁定+显示器休眠(22:33 起,用户离机)致 120s 就绪超时且截图/交互物理不可行(截屏全黑)。"
    },
    "desktop.preparing.state|mac|en|cn": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "待集中批捕:lead 裁决③降级预案(2026-07-20)——全部实现 PR 合入后由 lead 统一安排 live-app 阶段补齐视觉证据并补跑 --slice 全量。本次一次尝试实况:restart 自检通过(宿主为 packaged 非 dev 树,非 refusal),pr1-verify 沙箱已创建、dev 已 spawn,但屏幕锁定+显示器休眠(22:33 起,用户离机)致 120s 就绪超时且截图/交互物理不可行(截屏全黑)。"
    },
    "desktop.preparing.state|mac|en|global": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "待集中批捕:lead 裁决③降级预案(2026-07-20)——全部实现 PR 合入后由 lead 统一安排 live-app 阶段补齐视觉证据并补跑 --slice 全量。本次一次尝试实况:restart 自检通过(宿主为 packaged 非 dev 树,非 refusal),pr1-verify 沙箱已创建、dev 已 spawn,但屏幕锁定+显示器休眠(22:33 起,用户离机)致 120s 就绪超时且截图/交互物理不可行(截屏全黑)。"
    },
    "desktop.preparing.state|mac|ja|cn": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "待集中批捕:lead 裁决③降级预案(2026-07-20)——全部实现 PR 合入后由 lead 统一安排 live-app 阶段补齐视觉证据并补跑 --slice 全量。本次一次尝试实况:restart 自检通过(宿主为 packaged 非 dev 树,非 refusal),pr1-verify 沙箱已创建、dev 已 spawn,但屏幕锁定+显示器休眠(22:33 起,用户离机)致 120s 就绪超时且截图/交互物理不可行(截屏全黑)。"
    },
    "desktop.preparing.state|mac|ja|global": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "待集中批捕:lead 裁决③降级预案(2026-07-20)——全部实现 PR 合入后由 lead 统一安排 live-app 阶段补齐视觉证据并补跑 --slice 全量。本次一次尝试实况:restart 自检通过(宿主为 packaged 非 dev 树,非 refusal),pr1-verify 沙箱已创建、dev 已 spawn,但屏幕锁定+显示器休眠(22:33 起,用户离机)致 120s 就绪超时且截图/交互物理不可行(截屏全黑)。"
    },
    "desktop.preparing.state|mac|ko|cn": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "待集中批捕:lead 裁决③降级预案(2026-07-20)——全部实现 PR 合入后由 lead 统一安排 live-app 阶段补齐视觉证据并补跑 --slice 全量。本次一次尝试实况:restart 自检通过(宿主为 packaged 非 dev 树,非 refusal),pr1-verify 沙箱已创建、dev 已 spawn,但屏幕锁定+显示器休眠(22:33 起,用户离机)致 120s 就绪超时且截图/交互物理不可行(截屏全黑)。"
    },
    "desktop.preparing.state|mac|ko|global": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "待集中批捕:lead 裁决③降级预案(2026-07-20)——全部实现 PR 合入后由 lead 统一安排 live-app 阶段补齐视觉证据并补跑 --slice 全量。本次一次尝试实况:restart 自检通过(宿主为 packaged 非 dev 树,非 refusal),pr1-verify 沙箱已创建、dev 已 spawn,但屏幕锁定+显示器休眠(22:33 起,用户离机)致 120s 就绪超时且截图/交互物理不可行(截屏全黑)。"
    },
    "desktop.preparing.state|windows|zh-CN|cn": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "待集中批捕:lead 裁决③降级预案(2026-07-20)——全部实现 PR 合入后由 lead 统一安排 live-app 阶段补齐视觉证据并补跑 --slice 全量。本次一次尝试实况:restart 自检通过(宿主为 packaged 非 dev 树,非 refusal),pr1-verify 沙箱已创建、dev 已 spawn,但屏幕锁定+显示器休眠(22:33 起,用户离机)致 120s 就绪超时且截图/交互物理不可行(截屏全黑)。"
    },
    "desktop.preparing.state|windows|zh-CN|global": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "待集中批捕:lead 裁决③降级预案(2026-07-20)——全部实现 PR 合入后由 lead 统一安排 live-app 阶段补齐视觉证据并补跑 --slice 全量。本次一次尝试实况:restart 自检通过(宿主为 packaged 非 dev 树,非 refusal),pr1-verify 沙箱已创建、dev 已 spawn,但屏幕锁定+显示器休眠(22:33 起,用户离机)致 120s 就绪超时且截图/交互物理不可行(截屏全黑)。"
    },
    "desktop.preparing.state|windows|zh-TW|cn": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "待集中批捕:lead 裁决③降级预案(2026-07-20)——全部实现 PR 合入后由 lead 统一安排 live-app 阶段补齐视觉证据并补跑 --slice 全量。本次一次尝试实况:restart 自检通过(宿主为 packaged 非 dev 树,非 refusal),pr1-verify 沙箱已创建、dev 已 spawn,但屏幕锁定+显示器休眠(22:33 起,用户离机)致 120s 就绪超时且截图/交互物理不可行(截屏全黑)。"
    },
    "desktop.preparing.state|windows|zh-TW|global": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "待集中批捕:lead 裁决③降级预案(2026-07-20)——全部实现 PR 合入后由 lead 统一安排 live-app 阶段补齐视觉证据并补跑 --slice 全量。本次一次尝试实况:restart 自检通过(宿主为 packaged 非 dev 树,非 refusal),pr1-verify 沙箱已创建、dev 已 spawn,但屏幕锁定+显示器休眠(22:33 起,用户离机)致 120s 就绪超时且截图/交互物理不可行(截屏全黑)。"
    },
    "desktop.preparing.state|windows|en|cn": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "待集中批捕:lead 裁决③降级预案(2026-07-20)——全部实现 PR 合入后由 lead 统一安排 live-app 阶段补齐视觉证据并补跑 --slice 全量。本次一次尝试实况:restart 自检通过(宿主为 packaged 非 dev 树,非 refusal),pr1-verify 沙箱已创建、dev 已 spawn,但屏幕锁定+显示器休眠(22:33 起,用户离机)致 120s 就绪超时且截图/交互物理不可行(截屏全黑)。"
    },
    "desktop.preparing.state|windows|en|global": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "待集中批捕:lead 裁决③降级预案(2026-07-20)——全部实现 PR 合入后由 lead 统一安排 live-app 阶段补齐视觉证据并补跑 --slice 全量。本次一次尝试实况:restart 自检通过(宿主为 packaged 非 dev 树,非 refusal),pr1-verify 沙箱已创建、dev 已 spawn,但屏幕锁定+显示器休眠(22:33 起,用户离机)致 120s 就绪超时且截图/交互物理不可行(截屏全黑)。"
    },
    "desktop.preparing.state|windows|ja|cn": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "待集中批捕:lead 裁决③降级预案(2026-07-20)——全部实现 PR 合入后由 lead 统一安排 live-app 阶段补齐视觉证据并补跑 --slice 全量。本次一次尝试实况:restart 自检通过(宿主为 packaged 非 dev 树,非 refusal),pr1-verify 沙箱已创建、dev 已 spawn,但屏幕锁定+显示器休眠(22:33 起,用户离机)致 120s 就绪超时且截图/交互物理不可行(截屏全黑)。"
    },
    "desktop.preparing.state|windows|ja|global": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "待集中批捕:lead 裁决③降级预案(2026-07-20)——全部实现 PR 合入后由 lead 统一安排 live-app 阶段补齐视觉证据并补跑 --slice 全量。本次一次尝试实况:restart 自检通过(宿主为 packaged 非 dev 树,非 refusal),pr1-verify 沙箱已创建、dev 已 spawn,但屏幕锁定+显示器休眠(22:33 起,用户离机)致 120s 就绪超时且截图/交互物理不可行(截屏全黑)。"
    },
    "desktop.preparing.state|windows|ko|cn": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "待集中批捕:lead 裁决③降级预案(2026-07-20)——全部实现 PR 合入后由 lead 统一安排 live-app 阶段补齐视觉证据并补跑 --slice 全量。本次一次尝试实况:restart 自检通过(宿主为 packaged 非 dev 树,非 refusal),pr1-verify 沙箱已创建、dev 已 spawn,但屏幕锁定+显示器休眠(22:33 起,用户离机)致 120s 就绪超时且截图/交互物理不可行(截屏全黑)。"
    },
    "desktop.preparing.state|windows|ko|global": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "待集中批捕:lead 裁决③降级预案(2026-07-20)——全部实现 PR 合入后由 lead 统一安排 live-app 阶段补齐视觉证据并补跑 --slice 全量。本次一次尝试实况:restart 自检通过(宿主为 packaged 非 dev 树,非 refusal),pr1-verify 沙箱已创建、dev 已 spawn,但屏幕锁定+显示器休眠(22:33 起,用户离机)致 120s 就绪超时且截图/交互物理不可行(截屏全黑)。"
    },
    "desktop.window-chrome.style|mac|zh-CN|cn": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "待集中批捕:lead 裁决(PR2a 派工包第 3 条,2026-07-20)——桌面取证受锁屏环境限制,不再做 restart 尝试;全部实现 PR 合入后由 lead 统一安排 live-app 阶段补齐视觉证据并补跑 --slice 全量。"
    },
    "desktop.window-chrome.style|mac|zh-CN|global": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "待集中批捕:lead 裁决(PR2a 派工包第 3 条,2026-07-20)——桌面取证受锁屏环境限制,不再做 restart 尝试;全部实现 PR 合入后由 lead 统一安排 live-app 阶段补齐视觉证据并补跑 --slice 全量。"
    },
    "desktop.window-chrome.style|mac|zh-TW|cn": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "待集中批捕:lead 裁决(PR2a 派工包第 3 条,2026-07-20)——桌面取证受锁屏环境限制,不再做 restart 尝试;全部实现 PR 合入后由 lead 统一安排 live-app 阶段补齐视觉证据并补跑 --slice 全量。"
    },
    "desktop.window-chrome.style|mac|zh-TW|global": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "待集中批捕:lead 裁决(PR2a 派工包第 3 条,2026-07-20)——桌面取证受锁屏环境限制,不再做 restart 尝试;全部实现 PR 合入后由 lead 统一安排 live-app 阶段补齐视觉证据并补跑 --slice 全量。"
    },
    "desktop.window-chrome.style|mac|en|cn": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "待集中批捕:lead 裁决(PR2a 派工包第 3 条,2026-07-20)——桌面取证受锁屏环境限制,不再做 restart 尝试;全部实现 PR 合入后由 lead 统一安排 live-app 阶段补齐视觉证据并补跑 --slice 全量。"
    },
    "desktop.window-chrome.style|mac|en|global": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "待集中批捕:lead 裁决(PR2a 派工包第 3 条,2026-07-20)——桌面取证受锁屏环境限制,不再做 restart 尝试;全部实现 PR 合入后由 lead 统一安排 live-app 阶段补齐视觉证据并补跑 --slice 全量。"
    },
    "desktop.window-chrome.style|mac|ja|cn": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "待集中批捕:lead 裁决(PR2a 派工包第 3 条,2026-07-20)——桌面取证受锁屏环境限制,不再做 restart 尝试;全部实现 PR 合入后由 lead 统一安排 live-app 阶段补齐视觉证据并补跑 --slice 全量。"
    },
    "desktop.window-chrome.style|mac|ja|global": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "待集中批捕:lead 裁决(PR2a 派工包第 3 条,2026-07-20)——桌面取证受锁屏环境限制,不再做 restart 尝试;全部实现 PR 合入后由 lead 统一安排 live-app 阶段补齐视觉证据并补跑 --slice 全量。"
    },
    "desktop.window-chrome.style|mac|ko|cn": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "待集中批捕:lead 裁决(PR2a 派工包第 3 条,2026-07-20)——桌面取证受锁屏环境限制,不再做 restart 尝试;全部实现 PR 合入后由 lead 统一安排 live-app 阶段补齐视觉证据并补跑 --slice 全量。"
    },
    "desktop.window-chrome.style|mac|ko|global": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "待集中批捕:lead 裁决(PR2a 派工包第 3 条,2026-07-20)——桌面取证受锁屏环境限制,不再做 restart 尝试;全部实现 PR 合入后由 lead 统一安排 live-app 阶段补齐视觉证据并补跑 --slice 全量。"
    },
    "desktop.window-chrome.style|windows|zh-CN|cn": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "待集中批捕:lead 裁决(PR2a 派工包第 3 条,2026-07-20)——桌面取证受锁屏环境限制,不再做 restart 尝试;全部实现 PR 合入后由 lead 统一安排 live-app 阶段补齐视觉证据并补跑 --slice 全量。"
    },
    "desktop.window-chrome.style|windows|zh-CN|global": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "待集中批捕:lead 裁决(PR2a 派工包第 3 条,2026-07-20)——桌面取证受锁屏环境限制,不再做 restart 尝试;全部实现 PR 合入后由 lead 统一安排 live-app 阶段补齐视觉证据并补跑 --slice 全量。"
    },
    "desktop.window-chrome.style|windows|zh-TW|cn": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "待集中批捕:lead 裁决(PR2a 派工包第 3 条,2026-07-20)——桌面取证受锁屏环境限制,不再做 restart 尝试;全部实现 PR 合入后由 lead 统一安排 live-app 阶段补齐视觉证据并补跑 --slice 全量。"
    },
    "desktop.window-chrome.style|windows|zh-TW|global": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "待集中批捕:lead 裁决(PR2a 派工包第 3 条,2026-07-20)——桌面取证受锁屏环境限制,不再做 restart 尝试;全部实现 PR 合入后由 lead 统一安排 live-app 阶段补齐视觉证据并补跑 --slice 全量。"
    },
    "desktop.window-chrome.style|windows|en|cn": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "待集中批捕:lead 裁决(PR2a 派工包第 3 条,2026-07-20)——桌面取证受锁屏环境限制,不再做 restart 尝试;全部实现 PR 合入后由 lead 统一安排 live-app 阶段补齐视觉证据并补跑 --slice 全量。"
    },
    "desktop.window-chrome.style|windows|en|global": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "待集中批捕:lead 裁决(PR2a 派工包第 3 条,2026-07-20)——桌面取证受锁屏环境限制,不再做 restart 尝试;全部实现 PR 合入后由 lead 统一安排 live-app 阶段补齐视觉证据并补跑 --slice 全量。"
    },
    "desktop.window-chrome.style|windows|ja|cn": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "待集中批捕:lead 裁决(PR2a 派工包第 3 条,2026-07-20)——桌面取证受锁屏环境限制,不再做 restart 尝试;全部实现 PR 合入后由 lead 统一安排 live-app 阶段补齐视觉证据并补跑 --slice 全量。"
    },
    "desktop.window-chrome.style|windows|ja|global": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "待集中批捕:lead 裁决(PR2a 派工包第 3 条,2026-07-20)——桌面取证受锁屏环境限制,不再做 restart 尝试;全部实现 PR 合入后由 lead 统一安排 live-app 阶段补齐视觉证据并补跑 --slice 全量。"
    },
    "desktop.window-chrome.style|windows|ko|cn": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "待集中批捕:lead 裁决(PR2a 派工包第 3 条,2026-07-20)——桌面取证受锁屏环境限制,不再做 restart 尝试;全部实现 PR 合入后由 lead 统一安排 live-app 阶段补齐视觉证据并补跑 --slice 全量。"
    },
    "desktop.window-chrome.style|windows|ko|global": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "待集中批捕:lead 裁决(PR2a 派工包第 3 条,2026-07-20)——桌面取证受锁屏环境限制,不再做 restart 尝试;全部实现 PR 合入后由 lead 统一安排 live-app 阶段补齐视觉证据并补跑 --slice 全量。"
    },
    "desktop.method-choice.state|mac|zh-CN|cn": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "待集中批捕:lead 裁决(PR2a 派工包第 3 条,2026-07-20)——桌面取证受锁屏环境限制,不再做 restart 尝试;全部实现 PR 合入后由 lead 统一安排 live-app 阶段补齐视觉证据并补跑 --slice 全量。"
    },
    "desktop.method-choice.state|mac|zh-CN|global": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "待集中批捕:lead 裁决(PR2a 派工包第 3 条,2026-07-20)——桌面取证受锁屏环境限制,不再做 restart 尝试;全部实现 PR 合入后由 lead 统一安排 live-app 阶段补齐视觉证据并补跑 --slice 全量。"
    },
    "desktop.method-choice.state|mac|zh-TW|cn": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "待集中批捕:lead 裁决(PR2a 派工包第 3 条,2026-07-20)——桌面取证受锁屏环境限制,不再做 restart 尝试;全部实现 PR 合入后由 lead 统一安排 live-app 阶段补齐视觉证据并补跑 --slice 全量。"
    },
    "desktop.method-choice.state|mac|zh-TW|global": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "待集中批捕:lead 裁决(PR2a 派工包第 3 条,2026-07-20)——桌面取证受锁屏环境限制,不再做 restart 尝试;全部实现 PR 合入后由 lead 统一安排 live-app 阶段补齐视觉证据并补跑 --slice 全量。"
    },
    "desktop.method-choice.state|mac|en|cn": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "待集中批捕:lead 裁决(PR2a 派工包第 3 条,2026-07-20)——桌面取证受锁屏环境限制,不再做 restart 尝试;全部实现 PR 合入后由 lead 统一安排 live-app 阶段补齐视觉证据并补跑 --slice 全量。"
    },
    "desktop.method-choice.state|mac|en|global": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "待集中批捕:lead 裁决(PR2a 派工包第 3 条,2026-07-20)——桌面取证受锁屏环境限制,不再做 restart 尝试;全部实现 PR 合入后由 lead 统一安排 live-app 阶段补齐视觉证据并补跑 --slice 全量。"
    },
    "desktop.method-choice.state|mac|ja|cn": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "待集中批捕:lead 裁决(PR2a 派工包第 3 条,2026-07-20)——桌面取证受锁屏环境限制,不再做 restart 尝试;全部实现 PR 合入后由 lead 统一安排 live-app 阶段补齐视觉证据并补跑 --slice 全量。"
    },
    "desktop.method-choice.state|mac|ja|global": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "待集中批捕:lead 裁决(PR2a 派工包第 3 条,2026-07-20)——桌面取证受锁屏环境限制,不再做 restart 尝试;全部实现 PR 合入后由 lead 统一安排 live-app 阶段补齐视觉证据并补跑 --slice 全量。"
    },
    "desktop.method-choice.state|mac|ko|cn": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "待集中批捕:lead 裁决(PR2a 派工包第 3 条,2026-07-20)——桌面取证受锁屏环境限制,不再做 restart 尝试;全部实现 PR 合入后由 lead 统一安排 live-app 阶段补齐视觉证据并补跑 --slice 全量。"
    },
    "desktop.method-choice.state|mac|ko|global": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "待集中批捕:lead 裁决(PR2a 派工包第 3 条,2026-07-20)——桌面取证受锁屏环境限制,不再做 restart 尝试;全部实现 PR 合入后由 lead 统一安排 live-app 阶段补齐视觉证据并补跑 --slice 全量。"
    },
    "desktop.method-choice.state|windows|zh-CN|cn": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "待集中批捕:lead 裁决(PR2a 派工包第 3 条,2026-07-20)——桌面取证受锁屏环境限制,不再做 restart 尝试;全部实现 PR 合入后由 lead 统一安排 live-app 阶段补齐视觉证据并补跑 --slice 全量。"
    },
    "desktop.method-choice.state|windows|zh-CN|global": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "待集中批捕:lead 裁决(PR2a 派工包第 3 条,2026-07-20)——桌面取证受锁屏环境限制,不再做 restart 尝试;全部实现 PR 合入后由 lead 统一安排 live-app 阶段补齐视觉证据并补跑 --slice 全量。"
    },
    "desktop.method-choice.state|windows|zh-TW|cn": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "待集中批捕:lead 裁决(PR2a 派工包第 3 条,2026-07-20)——桌面取证受锁屏环境限制,不再做 restart 尝试;全部实现 PR 合入后由 lead 统一安排 live-app 阶段补齐视觉证据并补跑 --slice 全量。"
    },
    "desktop.method-choice.state|windows|zh-TW|global": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "待集中批捕:lead 裁决(PR2a 派工包第 3 条,2026-07-20)——桌面取证受锁屏环境限制,不再做 restart 尝试;全部实现 PR 合入后由 lead 统一安排 live-app 阶段补齐视觉证据并补跑 --slice 全量。"
    },
    "desktop.method-choice.state|windows|en|cn": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "待集中批捕:lead 裁决(PR2a 派工包第 3 条,2026-07-20)——桌面取证受锁屏环境限制,不再做 restart 尝试;全部实现 PR 合入后由 lead 统一安排 live-app 阶段补齐视觉证据并补跑 --slice 全量。"
    },
    "desktop.method-choice.state|windows|en|global": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "待集中批捕:lead 裁决(PR2a 派工包第 3 条,2026-07-20)——桌面取证受锁屏环境限制,不再做 restart 尝试;全部实现 PR 合入后由 lead 统一安排 live-app 阶段补齐视觉证据并补跑 --slice 全量。"
    },
    "desktop.method-choice.state|windows|ja|cn": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "待集中批捕:lead 裁决(PR2a 派工包第 3 条,2026-07-20)——桌面取证受锁屏环境限制,不再做 restart 尝试;全部实现 PR 合入后由 lead 统一安排 live-app 阶段补齐视觉证据并补跑 --slice 全量。"
    },
    "desktop.method-choice.state|windows|ja|global": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "待集中批捕:lead 裁决(PR2a 派工包第 3 条,2026-07-20)——桌面取证受锁屏环境限制,不再做 restart 尝试;全部实现 PR 合入后由 lead 统一安排 live-app 阶段补齐视觉证据并补跑 --slice 全量。"
    },
    "desktop.method-choice.state|windows|ko|cn": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "待集中批捕:lead 裁决(PR2a 派工包第 3 条,2026-07-20)——桌面取证受锁屏环境限制,不再做 restart 尝试;全部实现 PR 合入后由 lead 统一安排 live-app 阶段补齐视觉证据并补跑 --slice 全量。"
    },
    "desktop.method-choice.state|windows|ko|global": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "待集中批捕:lead 裁决(PR2a 派工包第 3 条,2026-07-20)——桌面取证受锁屏环境限制,不再做 restart 尝试;全部实现 PR 合入后由 lead 统一安排 live-app 阶段补齐视觉证据并补跑 --slice 全量。"
    },
    "desktop.method-choice.multi-state|mac|zh-CN|cn": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "待集中批捕:lead 裁决(PR2a 派工包第 3 条,2026-07-20)——桌面取证受锁屏环境限制,不再做 restart 尝试;全部实现 PR 合入后由 lead 统一安排 live-app 阶段补齐视觉证据并补跑 --slice 全量。"
    },
    "desktop.method-choice.multi-state|mac|zh-CN|global": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "待集中批捕:lead 裁决(PR2a 派工包第 3 条,2026-07-20)——桌面取证受锁屏环境限制,不再做 restart 尝试;全部实现 PR 合入后由 lead 统一安排 live-app 阶段补齐视觉证据并补跑 --slice 全量。"
    },
    "desktop.method-choice.multi-state|mac|zh-TW|cn": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "待集中批捕:lead 裁决(PR2a 派工包第 3 条,2026-07-20)——桌面取证受锁屏环境限制,不再做 restart 尝试;全部实现 PR 合入后由 lead 统一安排 live-app 阶段补齐视觉证据并补跑 --slice 全量。"
    },
    "desktop.method-choice.multi-state|mac|zh-TW|global": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "待集中批捕:lead 裁决(PR2a 派工包第 3 条,2026-07-20)——桌面取证受锁屏环境限制,不再做 restart 尝试;全部实现 PR 合入后由 lead 统一安排 live-app 阶段补齐视觉证据并补跑 --slice 全量。"
    },
    "desktop.method-choice.multi-state|mac|en|cn": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "待集中批捕:lead 裁决(PR2a 派工包第 3 条,2026-07-20)——桌面取证受锁屏环境限制,不再做 restart 尝试;全部实现 PR 合入后由 lead 统一安排 live-app 阶段补齐视觉证据并补跑 --slice 全量。"
    },
    "desktop.method-choice.multi-state|mac|en|global": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "待集中批捕:lead 裁决(PR2a 派工包第 3 条,2026-07-20)——桌面取证受锁屏环境限制,不再做 restart 尝试;全部实现 PR 合入后由 lead 统一安排 live-app 阶段补齐视觉证据并补跑 --slice 全量。"
    },
    "desktop.method-choice.multi-state|mac|ja|cn": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "待集中批捕:lead 裁决(PR2a 派工包第 3 条,2026-07-20)——桌面取证受锁屏环境限制,不再做 restart 尝试;全部实现 PR 合入后由 lead 统一安排 live-app 阶段补齐视觉证据并补跑 --slice 全量。"
    },
    "desktop.method-choice.multi-state|mac|ja|global": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "待集中批捕:lead 裁决(PR2a 派工包第 3 条,2026-07-20)——桌面取证受锁屏环境限制,不再做 restart 尝试;全部实现 PR 合入后由 lead 统一安排 live-app 阶段补齐视觉证据并补跑 --slice 全量。"
    },
    "desktop.method-choice.multi-state|mac|ko|cn": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "待集中批捕:lead 裁决(PR2a 派工包第 3 条,2026-07-20)——桌面取证受锁屏环境限制,不再做 restart 尝试;全部实现 PR 合入后由 lead 统一安排 live-app 阶段补齐视觉证据并补跑 --slice 全量。"
    },
    "desktop.method-choice.multi-state|mac|ko|global": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "待集中批捕:lead 裁决(PR2a 派工包第 3 条,2026-07-20)——桌面取证受锁屏环境限制,不再做 restart 尝试;全部实现 PR 合入后由 lead 统一安排 live-app 阶段补齐视觉证据并补跑 --slice 全量。"
    },
    "desktop.method-choice.multi-state|windows|zh-CN|cn": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "待集中批捕:lead 裁决(PR2a 派工包第 3 条,2026-07-20)——桌面取证受锁屏环境限制,不再做 restart 尝试;全部实现 PR 合入后由 lead 统一安排 live-app 阶段补齐视觉证据并补跑 --slice 全量。"
    },
    "desktop.method-choice.multi-state|windows|zh-CN|global": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "待集中批捕:lead 裁决(PR2a 派工包第 3 条,2026-07-20)——桌面取证受锁屏环境限制,不再做 restart 尝试;全部实现 PR 合入后由 lead 统一安排 live-app 阶段补齐视觉证据并补跑 --slice 全量。"
    },
    "desktop.method-choice.multi-state|windows|zh-TW|cn": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "待集中批捕:lead 裁决(PR2a 派工包第 3 条,2026-07-20)——桌面取证受锁屏环境限制,不再做 restart 尝试;全部实现 PR 合入后由 lead 统一安排 live-app 阶段补齐视觉证据并补跑 --slice 全量。"
    },
    "desktop.method-choice.multi-state|windows|zh-TW|global": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "待集中批捕:lead 裁决(PR2a 派工包第 3 条,2026-07-20)——桌面取证受锁屏环境限制,不再做 restart 尝试;全部实现 PR 合入后由 lead 统一安排 live-app 阶段补齐视觉证据并补跑 --slice 全量。"
    },
    "desktop.method-choice.multi-state|windows|en|cn": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "待集中批捕:lead 裁决(PR2a 派工包第 3 条,2026-07-20)——桌面取证受锁屏环境限制,不再做 restart 尝试;全部实现 PR 合入后由 lead 统一安排 live-app 阶段补齐视觉证据并补跑 --slice 全量。"
    },
    "desktop.method-choice.multi-state|windows|en|global": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "待集中批捕:lead 裁决(PR2a 派工包第 3 条,2026-07-20)——桌面取证受锁屏环境限制,不再做 restart 尝试;全部实现 PR 合入后由 lead 统一安排 live-app 阶段补齐视觉证据并补跑 --slice 全量。"
    },
    "desktop.method-choice.multi-state|windows|ja|cn": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "待集中批捕:lead 裁决(PR2a 派工包第 3 条,2026-07-20)——桌面取证受锁屏环境限制,不再做 restart 尝试;全部实现 PR 合入后由 lead 统一安排 live-app 阶段补齐视觉证据并补跑 --slice 全量。"
    },
    "desktop.method-choice.multi-state|windows|ja|global": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "待集中批捕:lead 裁决(PR2a 派工包第 3 条,2026-07-20)——桌面取证受锁屏环境限制,不再做 restart 尝试;全部实现 PR 合入后由 lead 统一安排 live-app 阶段补齐视觉证据并补跑 --slice 全量。"
    },
    "desktop.method-choice.multi-state|windows|ko|cn": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "待集中批捕:lead 裁决(PR2a 派工包第 3 条,2026-07-20)——桌面取证受锁屏环境限制,不再做 restart 尝试;全部实现 PR 合入后由 lead 统一安排 live-app 阶段补齐视觉证据并补跑 --slice 全量。"
    },
    "desktop.method-choice.multi-state|windows|ko|global": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "待集中批捕:lead 裁决(PR2a 派工包第 3 条,2026-07-20)——桌面取证受锁屏环境限制,不再做 restart 尝试;全部实现 PR 合入后由 lead 统一安排 live-app 阶段补齐视觉证据并补跑 --slice 全量。"
    },
    "desktop.method-choice.personal-state|mac|zh-CN|cn": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "待集中批捕:lead 裁决(PR2a 派工包第 3 条,2026-07-20)——桌面取证受锁屏环境限制,不再做 restart 尝试;全部实现 PR 合入后由 lead 统一安排 live-app 阶段补齐视觉证据并补跑 --slice 全量。"
    },
    "desktop.method-choice.personal-state|mac|zh-CN|global": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "待集中批捕:lead 裁决(PR2a 派工包第 3 条,2026-07-20)——桌面取证受锁屏环境限制,不再做 restart 尝试;全部实现 PR 合入后由 lead 统一安排 live-app 阶段补齐视觉证据并补跑 --slice 全量。"
    },
    "desktop.method-choice.personal-state|mac|zh-TW|cn": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "待集中批捕:lead 裁决(PR2a 派工包第 3 条,2026-07-20)——桌面取证受锁屏环境限制,不再做 restart 尝试;全部实现 PR 合入后由 lead 统一安排 live-app 阶段补齐视觉证据并补跑 --slice 全量。"
    },
    "desktop.method-choice.personal-state|mac|zh-TW|global": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "待集中批捕:lead 裁决(PR2a 派工包第 3 条,2026-07-20)——桌面取证受锁屏环境限制,不再做 restart 尝试;全部实现 PR 合入后由 lead 统一安排 live-app 阶段补齐视觉证据并补跑 --slice 全量。"
    },
    "desktop.method-choice.personal-state|mac|en|cn": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "待集中批捕:lead 裁决(PR2a 派工包第 3 条,2026-07-20)——桌面取证受锁屏环境限制,不再做 restart 尝试;全部实现 PR 合入后由 lead 统一安排 live-app 阶段补齐视觉证据并补跑 --slice 全量。"
    },
    "desktop.method-choice.personal-state|mac|en|global": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "待集中批捕:lead 裁决(PR2a 派工包第 3 条,2026-07-20)——桌面取证受锁屏环境限制,不再做 restart 尝试;全部实现 PR 合入后由 lead 统一安排 live-app 阶段补齐视觉证据并补跑 --slice 全量。"
    },
    "desktop.method-choice.personal-state|mac|ja|cn": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "待集中批捕:lead 裁决(PR2a 派工包第 3 条,2026-07-20)——桌面取证受锁屏环境限制,不再做 restart 尝试;全部实现 PR 合入后由 lead 统一安排 live-app 阶段补齐视觉证据并补跑 --slice 全量。"
    },
    "desktop.method-choice.personal-state|mac|ja|global": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "待集中批捕:lead 裁决(PR2a 派工包第 3 条,2026-07-20)——桌面取证受锁屏环境限制,不再做 restart 尝试;全部实现 PR 合入后由 lead 统一安排 live-app 阶段补齐视觉证据并补跑 --slice 全量。"
    },
    "desktop.method-choice.personal-state|mac|ko|cn": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "待集中批捕:lead 裁决(PR2a 派工包第 3 条,2026-07-20)——桌面取证受锁屏环境限制,不再做 restart 尝试;全部实现 PR 合入后由 lead 统一安排 live-app 阶段补齐视觉证据并补跑 --slice 全量。"
    },
    "desktop.method-choice.personal-state|mac|ko|global": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "待集中批捕:lead 裁决(PR2a 派工包第 3 条,2026-07-20)——桌面取证受锁屏环境限制,不再做 restart 尝试;全部实现 PR 合入后由 lead 统一安排 live-app 阶段补齐视觉证据并补跑 --slice 全量。"
    },
    "desktop.method-choice.personal-state|windows|zh-CN|cn": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "待集中批捕:lead 裁决(PR2a 派工包第 3 条,2026-07-20)——桌面取证受锁屏环境限制,不再做 restart 尝试;全部实现 PR 合入后由 lead 统一安排 live-app 阶段补齐视觉证据并补跑 --slice 全量。"
    },
    "desktop.method-choice.personal-state|windows|zh-CN|global": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "待集中批捕:lead 裁决(PR2a 派工包第 3 条,2026-07-20)——桌面取证受锁屏环境限制,不再做 restart 尝试;全部实现 PR 合入后由 lead 统一安排 live-app 阶段补齐视觉证据并补跑 --slice 全量。"
    },
    "desktop.method-choice.personal-state|windows|zh-TW|cn": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "待集中批捕:lead 裁决(PR2a 派工包第 3 条,2026-07-20)——桌面取证受锁屏环境限制,不再做 restart 尝试;全部实现 PR 合入后由 lead 统一安排 live-app 阶段补齐视觉证据并补跑 --slice 全量。"
    },
    "desktop.method-choice.personal-state|windows|zh-TW|global": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "待集中批捕:lead 裁决(PR2a 派工包第 3 条,2026-07-20)——桌面取证受锁屏环境限制,不再做 restart 尝试;全部实现 PR 合入后由 lead 统一安排 live-app 阶段补齐视觉证据并补跑 --slice 全量。"
    },
    "desktop.method-choice.personal-state|windows|en|cn": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "待集中批捕:lead 裁决(PR2a 派工包第 3 条,2026-07-20)——桌面取证受锁屏环境限制,不再做 restart 尝试;全部实现 PR 合入后由 lead 统一安排 live-app 阶段补齐视觉证据并补跑 --slice 全量。"
    },
    "desktop.method-choice.personal-state|windows|en|global": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "待集中批捕:lead 裁决(PR2a 派工包第 3 条,2026-07-20)——桌面取证受锁屏环境限制,不再做 restart 尝试;全部实现 PR 合入后由 lead 统一安排 live-app 阶段补齐视觉证据并补跑 --slice 全量。"
    },
    "desktop.method-choice.personal-state|windows|ja|cn": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "待集中批捕:lead 裁决(PR2a 派工包第 3 条,2026-07-20)——桌面取证受锁屏环境限制,不再做 restart 尝试;全部实现 PR 合入后由 lead 统一安排 live-app 阶段补齐视觉证据并补跑 --slice 全量。"
    },
    "desktop.method-choice.personal-state|windows|ja|global": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "待集中批捕:lead 裁决(PR2a 派工包第 3 条,2026-07-20)——桌面取证受锁屏环境限制,不再做 restart 尝试;全部实现 PR 合入后由 lead 统一安排 live-app 阶段补齐视觉证据并补跑 --slice 全量。"
    },
    "desktop.method-choice.personal-state|windows|ko|cn": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "待集中批捕:lead 裁决(PR2a 派工包第 3 条,2026-07-20)——桌面取证受锁屏环境限制,不再做 restart 尝试;全部实现 PR 合入后由 lead 统一安排 live-app 阶段补齐视觉证据并补跑 --slice 全量。"
    },
    "desktop.method-choice.personal-state|windows|ko|global": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "待集中批捕:lead 裁决(PR2a 派工包第 3 条,2026-07-20)——桌面取证受锁屏环境限制,不再做 restart 尝试;全部实现 PR 合入后由 lead 统一安排 live-app 阶段补齐视觉证据并补跑 --slice 全量。"
    },
    "desktop.verification-code.empty-state|mac|zh-CN|cn": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "待集中批捕:lead 裁决(PR2a 派工包第 3 条,2026-07-20)——桌面取证受锁屏环境限制,不再做 restart 尝试;全部实现 PR 合入后由 lead 统一安排 live-app 阶段补齐视觉证据并补跑 --slice 全量。"
    },
    "desktop.verification-code.empty-state|mac|zh-CN|global": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "待集中批捕:lead 裁决(PR2a 派工包第 3 条,2026-07-20)——桌面取证受锁屏环境限制,不再做 restart 尝试;全部实现 PR 合入后由 lead 统一安排 live-app 阶段补齐视觉证据并补跑 --slice 全量。"
    },
    "desktop.verification-code.empty-state|mac|zh-TW|cn": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "待集中批捕:lead 裁决(PR2a 派工包第 3 条,2026-07-20)——桌面取证受锁屏环境限制,不再做 restart 尝试;全部实现 PR 合入后由 lead 统一安排 live-app 阶段补齐视觉证据并补跑 --slice 全量。"
    },
    "desktop.verification-code.empty-state|mac|zh-TW|global": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "待集中批捕:lead 裁决(PR2a 派工包第 3 条,2026-07-20)——桌面取证受锁屏环境限制,不再做 restart 尝试;全部实现 PR 合入后由 lead 统一安排 live-app 阶段补齐视觉证据并补跑 --slice 全量。"
    },
    "desktop.verification-code.empty-state|mac|en|cn": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "待集中批捕:lead 裁决(PR2a 派工包第 3 条,2026-07-20)——桌面取证受锁屏环境限制,不再做 restart 尝试;全部实现 PR 合入后由 lead 统一安排 live-app 阶段补齐视觉证据并补跑 --slice 全量。"
    },
    "desktop.verification-code.empty-state|mac|en|global": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "待集中批捕:lead 裁决(PR2a 派工包第 3 条,2026-07-20)——桌面取证受锁屏环境限制,不再做 restart 尝试;全部实现 PR 合入后由 lead 统一安排 live-app 阶段补齐视觉证据并补跑 --slice 全量。"
    },
    "desktop.verification-code.empty-state|mac|ja|cn": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "待集中批捕:lead 裁决(PR2a 派工包第 3 条,2026-07-20)——桌面取证受锁屏环境限制,不再做 restart 尝试;全部实现 PR 合入后由 lead 统一安排 live-app 阶段补齐视觉证据并补跑 --slice 全量。"
    },
    "desktop.verification-code.empty-state|mac|ja|global": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "待集中批捕:lead 裁决(PR2a 派工包第 3 条,2026-07-20)——桌面取证受锁屏环境限制,不再做 restart 尝试;全部实现 PR 合入后由 lead 统一安排 live-app 阶段补齐视觉证据并补跑 --slice 全量。"
    },
    "desktop.verification-code.empty-state|mac|ko|cn": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "待集中批捕:lead 裁决(PR2a 派工包第 3 条,2026-07-20)——桌面取证受锁屏环境限制,不再做 restart 尝试;全部实现 PR 合入后由 lead 统一安排 live-app 阶段补齐视觉证据并补跑 --slice 全量。"
    },
    "desktop.verification-code.empty-state|mac|ko|global": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "待集中批捕:lead 裁决(PR2a 派工包第 3 条,2026-07-20)——桌面取证受锁屏环境限制,不再做 restart 尝试;全部实现 PR 合入后由 lead 统一安排 live-app 阶段补齐视觉证据并补跑 --slice 全量。"
    },
    "desktop.verification-code.empty-state|windows|zh-CN|cn": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "待集中批捕:lead 裁决(PR2a 派工包第 3 条,2026-07-20)——桌面取证受锁屏环境限制,不再做 restart 尝试;全部实现 PR 合入后由 lead 统一安排 live-app 阶段补齐视觉证据并补跑 --slice 全量。"
    },
    "desktop.verification-code.empty-state|windows|zh-CN|global": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "待集中批捕:lead 裁决(PR2a 派工包第 3 条,2026-07-20)——桌面取证受锁屏环境限制,不再做 restart 尝试;全部实现 PR 合入后由 lead 统一安排 live-app 阶段补齐视觉证据并补跑 --slice 全量。"
    },
    "desktop.verification-code.empty-state|windows|zh-TW|cn": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "待集中批捕:lead 裁决(PR2a 派工包第 3 条,2026-07-20)——桌面取证受锁屏环境限制,不再做 restart 尝试;全部实现 PR 合入后由 lead 统一安排 live-app 阶段补齐视觉证据并补跑 --slice 全量。"
    },
    "desktop.verification-code.empty-state|windows|zh-TW|global": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "待集中批捕:lead 裁决(PR2a 派工包第 3 条,2026-07-20)——桌面取证受锁屏环境限制,不再做 restart 尝试;全部实现 PR 合入后由 lead 统一安排 live-app 阶段补齐视觉证据并补跑 --slice 全量。"
    },
    "desktop.verification-code.empty-state|windows|en|cn": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "待集中批捕:lead 裁决(PR2a 派工包第 3 条,2026-07-20)——桌面取证受锁屏环境限制,不再做 restart 尝试;全部实现 PR 合入后由 lead 统一安排 live-app 阶段补齐视觉证据并补跑 --slice 全量。"
    },
    "desktop.verification-code.empty-state|windows|en|global": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "待集中批捕:lead 裁决(PR2a 派工包第 3 条,2026-07-20)——桌面取证受锁屏环境限制,不再做 restart 尝试;全部实现 PR 合入后由 lead 统一安排 live-app 阶段补齐视觉证据并补跑 --slice 全量。"
    },
    "desktop.verification-code.empty-state|windows|ja|cn": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "待集中批捕:lead 裁决(PR2a 派工包第 3 条,2026-07-20)——桌面取证受锁屏环境限制,不再做 restart 尝试;全部实现 PR 合入后由 lead 统一安排 live-app 阶段补齐视觉证据并补跑 --slice 全量。"
    },
    "desktop.verification-code.empty-state|windows|ja|global": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "待集中批捕:lead 裁决(PR2a 派工包第 3 条,2026-07-20)——桌面取证受锁屏环境限制,不再做 restart 尝试;全部实现 PR 合入后由 lead 统一安排 live-app 阶段补齐视觉证据并补跑 --slice 全量。"
    },
    "desktop.verification-code.empty-state|windows|ko|cn": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "待集中批捕:lead 裁决(PR2a 派工包第 3 条,2026-07-20)——桌面取证受锁屏环境限制,不再做 restart 尝试;全部实现 PR 合入后由 lead 统一安排 live-app 阶段补齐视觉证据并补跑 --slice 全量。"
    },
    "desktop.verification-code.empty-state|windows|ko|global": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "待集中批捕:lead 裁决(PR2a 派工包第 3 条,2026-07-20)——桌面取证受锁屏环境限制,不再做 restart 尝试;全部实现 PR 合入后由 lead 统一安排 live-app 阶段补齐视觉证据并补跑 --slice 全量。"
    },
    "desktop.verification-code.filled-state|mac|zh-CN|cn": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "待集中批捕:lead 裁决(PR2a 派工包第 3 条,2026-07-20)——桌面取证受锁屏环境限制,不再做 restart 尝试;全部实现 PR 合入后由 lead 统一安排 live-app 阶段补齐视觉证据并补跑 --slice 全量。"
    },
    "desktop.verification-code.filled-state|mac|zh-CN|global": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "待集中批捕:lead 裁决(PR2a 派工包第 3 条,2026-07-20)——桌面取证受锁屏环境限制,不再做 restart 尝试;全部实现 PR 合入后由 lead 统一安排 live-app 阶段补齐视觉证据并补跑 --slice 全量。"
    },
    "desktop.verification-code.filled-state|mac|zh-TW|cn": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "待集中批捕:lead 裁决(PR2a 派工包第 3 条,2026-07-20)——桌面取证受锁屏环境限制,不再做 restart 尝试;全部实现 PR 合入后由 lead 统一安排 live-app 阶段补齐视觉证据并补跑 --slice 全量。"
    },
    "desktop.verification-code.filled-state|mac|zh-TW|global": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "待集中批捕:lead 裁决(PR2a 派工包第 3 条,2026-07-20)——桌面取证受锁屏环境限制,不再做 restart 尝试;全部实现 PR 合入后由 lead 统一安排 live-app 阶段补齐视觉证据并补跑 --slice 全量。"
    },
    "desktop.verification-code.filled-state|mac|en|cn": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "待集中批捕:lead 裁决(PR2a 派工包第 3 条,2026-07-20)——桌面取证受锁屏环境限制,不再做 restart 尝试;全部实现 PR 合入后由 lead 统一安排 live-app 阶段补齐视觉证据并补跑 --slice 全量。"
    },
    "desktop.verification-code.filled-state|mac|en|global": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "待集中批捕:lead 裁决(PR2a 派工包第 3 条,2026-07-20)——桌面取证受锁屏环境限制,不再做 restart 尝试;全部实现 PR 合入后由 lead 统一安排 live-app 阶段补齐视觉证据并补跑 --slice 全量。"
    },
    "desktop.verification-code.filled-state|mac|ja|cn": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "待集中批捕:lead 裁决(PR2a 派工包第 3 条,2026-07-20)——桌面取证受锁屏环境限制,不再做 restart 尝试;全部实现 PR 合入后由 lead 统一安排 live-app 阶段补齐视觉证据并补跑 --slice 全量。"
    },
    "desktop.verification-code.filled-state|mac|ja|global": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "待集中批捕:lead 裁决(PR2a 派工包第 3 条,2026-07-20)——桌面取证受锁屏环境限制,不再做 restart 尝试;全部实现 PR 合入后由 lead 统一安排 live-app 阶段补齐视觉证据并补跑 --slice 全量。"
    },
    "desktop.verification-code.filled-state|mac|ko|cn": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "待集中批捕:lead 裁决(PR2a 派工包第 3 条,2026-07-20)——桌面取证受锁屏环境限制,不再做 restart 尝试;全部实现 PR 合入后由 lead 统一安排 live-app 阶段补齐视觉证据并补跑 --slice 全量。"
    },
    "desktop.verification-code.filled-state|mac|ko|global": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "待集中批捕:lead 裁决(PR2a 派工包第 3 条,2026-07-20)——桌面取证受锁屏环境限制,不再做 restart 尝试;全部实现 PR 合入后由 lead 统一安排 live-app 阶段补齐视觉证据并补跑 --slice 全量。"
    },
    "desktop.verification-code.filled-state|windows|zh-CN|cn": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "待集中批捕:lead 裁决(PR2a 派工包第 3 条,2026-07-20)——桌面取证受锁屏环境限制,不再做 restart 尝试;全部实现 PR 合入后由 lead 统一安排 live-app 阶段补齐视觉证据并补跑 --slice 全量。"
    },
    "desktop.verification-code.filled-state|windows|zh-CN|global": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "待集中批捕:lead 裁决(PR2a 派工包第 3 条,2026-07-20)——桌面取证受锁屏环境限制,不再做 restart 尝试;全部实现 PR 合入后由 lead 统一安排 live-app 阶段补齐视觉证据并补跑 --slice 全量。"
    },
    "desktop.verification-code.filled-state|windows|zh-TW|cn": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "待集中批捕:lead 裁决(PR2a 派工包第 3 条,2026-07-20)——桌面取证受锁屏环境限制,不再做 restart 尝试;全部实现 PR 合入后由 lead 统一安排 live-app 阶段补齐视觉证据并补跑 --slice 全量。"
    },
    "desktop.verification-code.filled-state|windows|zh-TW|global": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "待集中批捕:lead 裁决(PR2a 派工包第 3 条,2026-07-20)——桌面取证受锁屏环境限制,不再做 restart 尝试;全部实现 PR 合入后由 lead 统一安排 live-app 阶段补齐视觉证据并补跑 --slice 全量。"
    },
    "desktop.verification-code.filled-state|windows|en|cn": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "待集中批捕:lead 裁决(PR2a 派工包第 3 条,2026-07-20)——桌面取证受锁屏环境限制,不再做 restart 尝试;全部实现 PR 合入后由 lead 统一安排 live-app 阶段补齐视觉证据并补跑 --slice 全量。"
    },
    "desktop.verification-code.filled-state|windows|en|global": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "待集中批捕:lead 裁决(PR2a 派工包第 3 条,2026-07-20)——桌面取证受锁屏环境限制,不再做 restart 尝试;全部实现 PR 合入后由 lead 统一安排 live-app 阶段补齐视觉证据并补跑 --slice 全量。"
    },
    "desktop.verification-code.filled-state|windows|ja|cn": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "待集中批捕:lead 裁决(PR2a 派工包第 3 条,2026-07-20)——桌面取证受锁屏环境限制,不再做 restart 尝试;全部实现 PR 合入后由 lead 统一安排 live-app 阶段补齐视觉证据并补跑 --slice 全量。"
    },
    "desktop.verification-code.filled-state|windows|ja|global": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "待集中批捕:lead 裁决(PR2a 派工包第 3 条,2026-07-20)——桌面取证受锁屏环境限制,不再做 restart 尝试;全部实现 PR 合入后由 lead 统一安排 live-app 阶段补齐视觉证据并补跑 --slice 全量。"
    },
    "desktop.verification-code.filled-state|windows|ko|cn": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "待集中批捕:lead 裁决(PR2a 派工包第 3 条,2026-07-20)——桌面取证受锁屏环境限制,不再做 restart 尝试;全部实现 PR 合入后由 lead 统一安排 live-app 阶段补齐视觉证据并补跑 --slice 全量。"
    },
    "desktop.verification-code.filled-state|windows|ko|global": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "待集中批捕:lead 裁决(PR2a 派工包第 3 条,2026-07-20)——桌面取证受锁屏环境限制,不再做 restart 尝试;全部实现 PR 合入后由 lead 统一安排 live-app 阶段补齐视觉证据并补跑 --slice 全量。"
    },
    "desktop.verification-code.loading-state|mac|zh-CN|cn": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "待集中批捕:lead 裁决(PR2a 派工包第 3 条,2026-07-20)——桌面取证受锁屏环境限制,不再做 restart 尝试;全部实现 PR 合入后由 lead 统一安排 live-app 阶段补齐视觉证据并补跑 --slice 全量。"
    },
    "desktop.verification-code.loading-state|mac|zh-CN|global": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "待集中批捕:lead 裁决(PR2a 派工包第 3 条,2026-07-20)——桌面取证受锁屏环境限制,不再做 restart 尝试;全部实现 PR 合入后由 lead 统一安排 live-app 阶段补齐视觉证据并补跑 --slice 全量。"
    },
    "desktop.verification-code.loading-state|mac|zh-TW|cn": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "待集中批捕:lead 裁决(PR2a 派工包第 3 条,2026-07-20)——桌面取证受锁屏环境限制,不再做 restart 尝试;全部实现 PR 合入后由 lead 统一安排 live-app 阶段补齐视觉证据并补跑 --slice 全量。"
    },
    "desktop.verification-code.loading-state|mac|zh-TW|global": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "待集中批捕:lead 裁决(PR2a 派工包第 3 条,2026-07-20)——桌面取证受锁屏环境限制,不再做 restart 尝试;全部实现 PR 合入后由 lead 统一安排 live-app 阶段补齐视觉证据并补跑 --slice 全量。"
    },
    "desktop.verification-code.loading-state|mac|en|cn": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "待集中批捕:lead 裁决(PR2a 派工包第 3 条,2026-07-20)——桌面取证受锁屏环境限制,不再做 restart 尝试;全部实现 PR 合入后由 lead 统一安排 live-app 阶段补齐视觉证据并补跑 --slice 全量。"
    },
    "desktop.verification-code.loading-state|mac|en|global": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "待集中批捕:lead 裁决(PR2a 派工包第 3 条,2026-07-20)——桌面取证受锁屏环境限制,不再做 restart 尝试;全部实现 PR 合入后由 lead 统一安排 live-app 阶段补齐视觉证据并补跑 --slice 全量。"
    },
    "desktop.verification-code.loading-state|mac|ja|cn": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "待集中批捕:lead 裁决(PR2a 派工包第 3 条,2026-07-20)——桌面取证受锁屏环境限制,不再做 restart 尝试;全部实现 PR 合入后由 lead 统一安排 live-app 阶段补齐视觉证据并补跑 --slice 全量。"
    },
    "desktop.verification-code.loading-state|mac|ja|global": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "待集中批捕:lead 裁决(PR2a 派工包第 3 条,2026-07-20)——桌面取证受锁屏环境限制,不再做 restart 尝试;全部实现 PR 合入后由 lead 统一安排 live-app 阶段补齐视觉证据并补跑 --slice 全量。"
    },
    "desktop.verification-code.loading-state|mac|ko|cn": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "待集中批捕:lead 裁决(PR2a 派工包第 3 条,2026-07-20)——桌面取证受锁屏环境限制,不再做 restart 尝试;全部实现 PR 合入后由 lead 统一安排 live-app 阶段补齐视觉证据并补跑 --slice 全量。"
    },
    "desktop.verification-code.loading-state|mac|ko|global": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "待集中批捕:lead 裁决(PR2a 派工包第 3 条,2026-07-20)——桌面取证受锁屏环境限制,不再做 restart 尝试;全部实现 PR 合入后由 lead 统一安排 live-app 阶段补齐视觉证据并补跑 --slice 全量。"
    },
    "desktop.verification-code.loading-state|windows|zh-CN|cn": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "待集中批捕:lead 裁决(PR2a 派工包第 3 条,2026-07-20)——桌面取证受锁屏环境限制,不再做 restart 尝试;全部实现 PR 合入后由 lead 统一安排 live-app 阶段补齐视觉证据并补跑 --slice 全量。"
    },
    "desktop.verification-code.loading-state|windows|zh-CN|global": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "待集中批捕:lead 裁决(PR2a 派工包第 3 条,2026-07-20)——桌面取证受锁屏环境限制,不再做 restart 尝试;全部实现 PR 合入后由 lead 统一安排 live-app 阶段补齐视觉证据并补跑 --slice 全量。"
    },
    "desktop.verification-code.loading-state|windows|zh-TW|cn": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "待集中批捕:lead 裁决(PR2a 派工包第 3 条,2026-07-20)——桌面取证受锁屏环境限制,不再做 restart 尝试;全部实现 PR 合入后由 lead 统一安排 live-app 阶段补齐视觉证据并补跑 --slice 全量。"
    },
    "desktop.verification-code.loading-state|windows|zh-TW|global": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "待集中批捕:lead 裁决(PR2a 派工包第 3 条,2026-07-20)——桌面取证受锁屏环境限制,不再做 restart 尝试;全部实现 PR 合入后由 lead 统一安排 live-app 阶段补齐视觉证据并补跑 --slice 全量。"
    },
    "desktop.verification-code.loading-state|windows|en|cn": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "待集中批捕:lead 裁决(PR2a 派工包第 3 条,2026-07-20)——桌面取证受锁屏环境限制,不再做 restart 尝试;全部实现 PR 合入后由 lead 统一安排 live-app 阶段补齐视觉证据并补跑 --slice 全量。"
    },
    "desktop.verification-code.loading-state|windows|en|global": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "待集中批捕:lead 裁决(PR2a 派工包第 3 条,2026-07-20)——桌面取证受锁屏环境限制,不再做 restart 尝试;全部实现 PR 合入后由 lead 统一安排 live-app 阶段补齐视觉证据并补跑 --slice 全量。"
    },
    "desktop.verification-code.loading-state|windows|ja|cn": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "待集中批捕:lead 裁决(PR2a 派工包第 3 条,2026-07-20)——桌面取证受锁屏环境限制,不再做 restart 尝试;全部实现 PR 合入后由 lead 统一安排 live-app 阶段补齐视觉证据并补跑 --slice 全量。"
    },
    "desktop.verification-code.loading-state|windows|ja|global": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "待集中批捕:lead 裁决(PR2a 派工包第 3 条,2026-07-20)——桌面取证受锁屏环境限制,不再做 restart 尝试;全部实现 PR 合入后由 lead 统一安排 live-app 阶段补齐视觉证据并补跑 --slice 全量。"
    },
    "desktop.verification-code.loading-state|windows|ko|cn": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "待集中批捕:lead 裁决(PR2a 派工包第 3 条,2026-07-20)——桌面取证受锁屏环境限制,不再做 restart 尝试;全部实现 PR 合入后由 lead 统一安排 live-app 阶段补齐视觉证据并补跑 --slice 全量。"
    },
    "desktop.verification-code.loading-state|windows|ko|global": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "待集中批捕:lead 裁决(PR2a 派工包第 3 条,2026-07-20)——桌面取证受锁屏环境限制,不再做 restart 尝试;全部实现 PR 合入后由 lead 统一安排 live-app 阶段补齐视觉证据并补跑 --slice 全量。"
    },
    "desktop.account-selection.state|mac|zh-CN|cn": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "待集中批捕:lead 裁决(PR2a 派工包第 3 条,2026-07-20)——桌面取证受锁屏环境限制,不再做 restart 尝试;全部实现 PR 合入后由 lead 统一安排 live-app 阶段补齐视觉证据并补跑 --slice 全量。"
    },
    "desktop.account-selection.state|mac|zh-CN|global": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "待集中批捕:lead 裁决(PR2a 派工包第 3 条,2026-07-20)——桌面取证受锁屏环境限制,不再做 restart 尝试;全部实现 PR 合入后由 lead 统一安排 live-app 阶段补齐视觉证据并补跑 --slice 全量。"
    },
    "desktop.account-selection.state|mac|zh-TW|cn": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "待集中批捕:lead 裁决(PR2a 派工包第 3 条,2026-07-20)——桌面取证受锁屏环境限制,不再做 restart 尝试;全部实现 PR 合入后由 lead 统一安排 live-app 阶段补齐视觉证据并补跑 --slice 全量。"
    },
    "desktop.account-selection.state|mac|zh-TW|global": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "待集中批捕:lead 裁决(PR2a 派工包第 3 条,2026-07-20)——桌面取证受锁屏环境限制,不再做 restart 尝试;全部实现 PR 合入后由 lead 统一安排 live-app 阶段补齐视觉证据并补跑 --slice 全量。"
    },
    "desktop.account-selection.state|mac|en|cn": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "待集中批捕:lead 裁决(PR2a 派工包第 3 条,2026-07-20)——桌面取证受锁屏环境限制,不再做 restart 尝试;全部实现 PR 合入后由 lead 统一安排 live-app 阶段补齐视觉证据并补跑 --slice 全量。"
    },
    "desktop.account-selection.state|mac|en|global": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "待集中批捕:lead 裁决(PR2a 派工包第 3 条,2026-07-20)——桌面取证受锁屏环境限制,不再做 restart 尝试;全部实现 PR 合入后由 lead 统一安排 live-app 阶段补齐视觉证据并补跑 --slice 全量。"
    },
    "desktop.account-selection.state|mac|ja|cn": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "待集中批捕:lead 裁决(PR2a 派工包第 3 条,2026-07-20)——桌面取证受锁屏环境限制,不再做 restart 尝试;全部实现 PR 合入后由 lead 统一安排 live-app 阶段补齐视觉证据并补跑 --slice 全量。"
    },
    "desktop.account-selection.state|mac|ja|global": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "待集中批捕:lead 裁决(PR2a 派工包第 3 条,2026-07-20)——桌面取证受锁屏环境限制,不再做 restart 尝试;全部实现 PR 合入后由 lead 统一安排 live-app 阶段补齐视觉证据并补跑 --slice 全量。"
    },
    "desktop.account-selection.state|mac|ko|cn": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "待集中批捕:lead 裁决(PR2a 派工包第 3 条,2026-07-20)——桌面取证受锁屏环境限制,不再做 restart 尝试;全部实现 PR 合入后由 lead 统一安排 live-app 阶段补齐视觉证据并补跑 --slice 全量。"
    },
    "desktop.account-selection.state|mac|ko|global": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "待集中批捕:lead 裁决(PR2a 派工包第 3 条,2026-07-20)——桌面取证受锁屏环境限制,不再做 restart 尝试;全部实现 PR 合入后由 lead 统一安排 live-app 阶段补齐视觉证据并补跑 --slice 全量。"
    },
    "desktop.account-selection.state|windows|zh-CN|cn": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "待集中批捕:lead 裁决(PR2a 派工包第 3 条,2026-07-20)——桌面取证受锁屏环境限制,不再做 restart 尝试;全部实现 PR 合入后由 lead 统一安排 live-app 阶段补齐视觉证据并补跑 --slice 全量。"
    },
    "desktop.account-selection.state|windows|zh-CN|global": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "待集中批捕:lead 裁决(PR2a 派工包第 3 条,2026-07-20)——桌面取证受锁屏环境限制,不再做 restart 尝试;全部实现 PR 合入后由 lead 统一安排 live-app 阶段补齐视觉证据并补跑 --slice 全量。"
    },
    "desktop.account-selection.state|windows|zh-TW|cn": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "待集中批捕:lead 裁决(PR2a 派工包第 3 条,2026-07-20)——桌面取证受锁屏环境限制,不再做 restart 尝试;全部实现 PR 合入后由 lead 统一安排 live-app 阶段补齐视觉证据并补跑 --slice 全量。"
    },
    "desktop.account-selection.state|windows|zh-TW|global": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "待集中批捕:lead 裁决(PR2a 派工包第 3 条,2026-07-20)——桌面取证受锁屏环境限制,不再做 restart 尝试;全部实现 PR 合入后由 lead 统一安排 live-app 阶段补齐视觉证据并补跑 --slice 全量。"
    },
    "desktop.account-selection.state|windows|en|cn": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "待集中批捕:lead 裁决(PR2a 派工包第 3 条,2026-07-20)——桌面取证受锁屏环境限制,不再做 restart 尝试;全部实现 PR 合入后由 lead 统一安排 live-app 阶段补齐视觉证据并补跑 --slice 全量。"
    },
    "desktop.account-selection.state|windows|en|global": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "待集中批捕:lead 裁决(PR2a 派工包第 3 条,2026-07-20)——桌面取证受锁屏环境限制,不再做 restart 尝试;全部实现 PR 合入后由 lead 统一安排 live-app 阶段补齐视觉证据并补跑 --slice 全量。"
    },
    "desktop.account-selection.state|windows|ja|cn": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "待集中批捕:lead 裁决(PR2a 派工包第 3 条,2026-07-20)——桌面取证受锁屏环境限制,不再做 restart 尝试;全部实现 PR 合入后由 lead 统一安排 live-app 阶段补齐视觉证据并补跑 --slice 全量。"
    },
    "desktop.account-selection.state|windows|ja|global": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "待集中批捕:lead 裁决(PR2a 派工包第 3 条,2026-07-20)——桌面取证受锁屏环境限制,不再做 restart 尝试;全部实现 PR 合入后由 lead 统一安排 live-app 阶段补齐视觉证据并补跑 --slice 全量。"
    },
    "desktop.account-selection.state|windows|ko|cn": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "待集中批捕:lead 裁决(PR2a 派工包第 3 条,2026-07-20)——桌面取证受锁屏环境限制,不再做 restart 尝试;全部实现 PR 合入后由 lead 统一安排 live-app 阶段补齐视觉证据并补跑 --slice 全量。"
    },
    "desktop.account-selection.state|windows|ko|global": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "待集中批捕:lead 裁决(PR2a 派工包第 3 条,2026-07-20)——桌面取证受锁屏环境限制,不再做 restart 尝试;全部实现 PR 合入后由 lead 统一安排 live-app 阶段补齐视觉证据并补跑 --slice 全量。"
    },
    "desktop.binding.contact-state|mac|zh-CN|cn": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "待集中批捕:lead 裁决(PR2a 派工包第 3 条,2026-07-20)——桌面取证受锁屏环境限制,不再做 restart 尝试;全部实现 PR 合入后由 lead 统一安排 live-app 阶段补齐视觉证据并补跑 --slice 全量。"
    },
    "desktop.binding.contact-state|mac|zh-CN|global": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "待集中批捕:lead 裁决(PR2a 派工包第 3 条,2026-07-20)——桌面取证受锁屏环境限制,不再做 restart 尝试;全部实现 PR 合入后由 lead 统一安排 live-app 阶段补齐视觉证据并补跑 --slice 全量。"
    },
    "desktop.binding.contact-state|mac|zh-TW|cn": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "待集中批捕:lead 裁决(PR2a 派工包第 3 条,2026-07-20)——桌面取证受锁屏环境限制,不再做 restart 尝试;全部实现 PR 合入后由 lead 统一安排 live-app 阶段补齐视觉证据并补跑 --slice 全量。"
    },
    "desktop.binding.contact-state|mac|zh-TW|global": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "待集中批捕:lead 裁决(PR2a 派工包第 3 条,2026-07-20)——桌面取证受锁屏环境限制,不再做 restart 尝试;全部实现 PR 合入后由 lead 统一安排 live-app 阶段补齐视觉证据并补跑 --slice 全量。"
    },
    "desktop.binding.contact-state|mac|en|cn": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "待集中批捕:lead 裁决(PR2a 派工包第 3 条,2026-07-20)——桌面取证受锁屏环境限制,不再做 restart 尝试;全部实现 PR 合入后由 lead 统一安排 live-app 阶段补齐视觉证据并补跑 --slice 全量。"
    },
    "desktop.binding.contact-state|mac|en|global": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "待集中批捕:lead 裁决(PR2a 派工包第 3 条,2026-07-20)——桌面取证受锁屏环境限制,不再做 restart 尝试;全部实现 PR 合入后由 lead 统一安排 live-app 阶段补齐视觉证据并补跑 --slice 全量。"
    },
    "desktop.binding.contact-state|mac|ja|cn": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "待集中批捕:lead 裁决(PR2a 派工包第 3 条,2026-07-20)——桌面取证受锁屏环境限制,不再做 restart 尝试;全部实现 PR 合入后由 lead 统一安排 live-app 阶段补齐视觉证据并补跑 --slice 全量。"
    },
    "desktop.binding.contact-state|mac|ja|global": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "待集中批捕:lead 裁决(PR2a 派工包第 3 条,2026-07-20)——桌面取证受锁屏环境限制,不再做 restart 尝试;全部实现 PR 合入后由 lead 统一安排 live-app 阶段补齐视觉证据并补跑 --slice 全量。"
    },
    "desktop.binding.contact-state|mac|ko|cn": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "待集中批捕:lead 裁决(PR2a 派工包第 3 条,2026-07-20)——桌面取证受锁屏环境限制,不再做 restart 尝试;全部实现 PR 合入后由 lead 统一安排 live-app 阶段补齐视觉证据并补跑 --slice 全量。"
    },
    "desktop.binding.contact-state|mac|ko|global": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "待集中批捕:lead 裁决(PR2a 派工包第 3 条,2026-07-20)——桌面取证受锁屏环境限制,不再做 restart 尝试;全部实现 PR 合入后由 lead 统一安排 live-app 阶段补齐视觉证据并补跑 --slice 全量。"
    },
    "desktop.binding.contact-state|windows|zh-CN|cn": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "待集中批捕:lead 裁决(PR2a 派工包第 3 条,2026-07-20)——桌面取证受锁屏环境限制,不再做 restart 尝试;全部实现 PR 合入后由 lead 统一安排 live-app 阶段补齐视觉证据并补跑 --slice 全量。"
    },
    "desktop.binding.contact-state|windows|zh-CN|global": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "待集中批捕:lead 裁决(PR2a 派工包第 3 条,2026-07-20)——桌面取证受锁屏环境限制,不再做 restart 尝试;全部实现 PR 合入后由 lead 统一安排 live-app 阶段补齐视觉证据并补跑 --slice 全量。"
    },
    "desktop.binding.contact-state|windows|zh-TW|cn": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "待集中批捕:lead 裁决(PR2a 派工包第 3 条,2026-07-20)——桌面取证受锁屏环境限制,不再做 restart 尝试;全部实现 PR 合入后由 lead 统一安排 live-app 阶段补齐视觉证据并补跑 --slice 全量。"
    },
    "desktop.binding.contact-state|windows|zh-TW|global": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "待集中批捕:lead 裁决(PR2a 派工包第 3 条,2026-07-20)——桌面取证受锁屏环境限制,不再做 restart 尝试;全部实现 PR 合入后由 lead 统一安排 live-app 阶段补齐视觉证据并补跑 --slice 全量。"
    },
    "desktop.binding.contact-state|windows|en|cn": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "待集中批捕:lead 裁决(PR2a 派工包第 3 条,2026-07-20)——桌面取证受锁屏环境限制,不再做 restart 尝试;全部实现 PR 合入后由 lead 统一安排 live-app 阶段补齐视觉证据并补跑 --slice 全量。"
    },
    "desktop.binding.contact-state|windows|en|global": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "待集中批捕:lead 裁决(PR2a 派工包第 3 条,2026-07-20)——桌面取证受锁屏环境限制,不再做 restart 尝试;全部实现 PR 合入后由 lead 统一安排 live-app 阶段补齐视觉证据并补跑 --slice 全量。"
    },
    "desktop.binding.contact-state|windows|ja|cn": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "待集中批捕:lead 裁决(PR2a 派工包第 3 条,2026-07-20)——桌面取证受锁屏环境限制,不再做 restart 尝试;全部实现 PR 合入后由 lead 统一安排 live-app 阶段补齐视觉证据并补跑 --slice 全量。"
    },
    "desktop.binding.contact-state|windows|ja|global": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "待集中批捕:lead 裁决(PR2a 派工包第 3 条,2026-07-20)——桌面取证受锁屏环境限制,不再做 restart 尝试;全部实现 PR 合入后由 lead 统一安排 live-app 阶段补齐视觉证据并补跑 --slice 全量。"
    },
    "desktop.binding.contact-state|windows|ko|cn": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "待集中批捕:lead 裁决(PR2a 派工包第 3 条,2026-07-20)——桌面取证受锁屏环境限制,不再做 restart 尝试;全部实现 PR 合入后由 lead 统一安排 live-app 阶段补齐视觉证据并补跑 --slice 全量。"
    },
    "desktop.binding.contact-state|windows|ko|global": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "待集中批捕:lead 裁决(PR2a 派工包第 3 条,2026-07-20)——桌面取证受锁屏环境限制,不再做 restart 尝试;全部实现 PR 合入后由 lead 统一安排 live-app 阶段补齐视觉证据并补跑 --slice 全量。"
    },
    "desktop.binding.code-state|mac|zh-CN|cn": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "待集中批捕:lead 裁决(PR2a 派工包第 3 条,2026-07-20)——桌面取证受锁屏环境限制,不再做 restart 尝试;全部实现 PR 合入后由 lead 统一安排 live-app 阶段补齐视觉证据并补跑 --slice 全量。"
    },
    "desktop.binding.code-state|mac|zh-CN|global": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "待集中批捕:lead 裁决(PR2a 派工包第 3 条,2026-07-20)——桌面取证受锁屏环境限制,不再做 restart 尝试;全部实现 PR 合入后由 lead 统一安排 live-app 阶段补齐视觉证据并补跑 --slice 全量。"
    },
    "desktop.binding.code-state|mac|zh-TW|cn": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "待集中批捕:lead 裁决(PR2a 派工包第 3 条,2026-07-20)——桌面取证受锁屏环境限制,不再做 restart 尝试;全部实现 PR 合入后由 lead 统一安排 live-app 阶段补齐视觉证据并补跑 --slice 全量。"
    },
    "desktop.binding.code-state|mac|zh-TW|global": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "待集中批捕:lead 裁决(PR2a 派工包第 3 条,2026-07-20)——桌面取证受锁屏环境限制,不再做 restart 尝试;全部实现 PR 合入后由 lead 统一安排 live-app 阶段补齐视觉证据并补跑 --slice 全量。"
    },
    "desktop.binding.code-state|mac|en|cn": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "待集中批捕:lead 裁决(PR2a 派工包第 3 条,2026-07-20)——桌面取证受锁屏环境限制,不再做 restart 尝试;全部实现 PR 合入后由 lead 统一安排 live-app 阶段补齐视觉证据并补跑 --slice 全量。"
    },
    "desktop.binding.code-state|mac|en|global": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "待集中批捕:lead 裁决(PR2a 派工包第 3 条,2026-07-20)——桌面取证受锁屏环境限制,不再做 restart 尝试;全部实现 PR 合入后由 lead 统一安排 live-app 阶段补齐视觉证据并补跑 --slice 全量。"
    },
    "desktop.binding.code-state|mac|ja|cn": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "待集中批捕:lead 裁决(PR2a 派工包第 3 条,2026-07-20)——桌面取证受锁屏环境限制,不再做 restart 尝试;全部实现 PR 合入后由 lead 统一安排 live-app 阶段补齐视觉证据并补跑 --slice 全量。"
    },
    "desktop.binding.code-state|mac|ja|global": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "待集中批捕:lead 裁决(PR2a 派工包第 3 条,2026-07-20)——桌面取证受锁屏环境限制,不再做 restart 尝试;全部实现 PR 合入后由 lead 统一安排 live-app 阶段补齐视觉证据并补跑 --slice 全量。"
    },
    "desktop.binding.code-state|mac|ko|cn": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "待集中批捕:lead 裁决(PR2a 派工包第 3 条,2026-07-20)——桌面取证受锁屏环境限制,不再做 restart 尝试;全部实现 PR 合入后由 lead 统一安排 live-app 阶段补齐视觉证据并补跑 --slice 全量。"
    },
    "desktop.binding.code-state|mac|ko|global": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "待集中批捕:lead 裁决(PR2a 派工包第 3 条,2026-07-20)——桌面取证受锁屏环境限制,不再做 restart 尝试;全部实现 PR 合入后由 lead 统一安排 live-app 阶段补齐视觉证据并补跑 --slice 全量。"
    },
    "desktop.binding.code-state|windows|zh-CN|cn": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "待集中批捕:lead 裁决(PR2a 派工包第 3 条,2026-07-20)——桌面取证受锁屏环境限制,不再做 restart 尝试;全部实现 PR 合入后由 lead 统一安排 live-app 阶段补齐视觉证据并补跑 --slice 全量。"
    },
    "desktop.binding.code-state|windows|zh-CN|global": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "待集中批捕:lead 裁决(PR2a 派工包第 3 条,2026-07-20)——桌面取证受锁屏环境限制,不再做 restart 尝试;全部实现 PR 合入后由 lead 统一安排 live-app 阶段补齐视觉证据并补跑 --slice 全量。"
    },
    "desktop.binding.code-state|windows|zh-TW|cn": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "待集中批捕:lead 裁决(PR2a 派工包第 3 条,2026-07-20)——桌面取证受锁屏环境限制,不再做 restart 尝试;全部实现 PR 合入后由 lead 统一安排 live-app 阶段补齐视觉证据并补跑 --slice 全量。"
    },
    "desktop.binding.code-state|windows|zh-TW|global": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "待集中批捕:lead 裁决(PR2a 派工包第 3 条,2026-07-20)——桌面取证受锁屏环境限制,不再做 restart 尝试;全部实现 PR 合入后由 lead 统一安排 live-app 阶段补齐视觉证据并补跑 --slice 全量。"
    },
    "desktop.binding.code-state|windows|en|cn": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "待集中批捕:lead 裁决(PR2a 派工包第 3 条,2026-07-20)——桌面取证受锁屏环境限制,不再做 restart 尝试;全部实现 PR 合入后由 lead 统一安排 live-app 阶段补齐视觉证据并补跑 --slice 全量。"
    },
    "desktop.binding.code-state|windows|en|global": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "待集中批捕:lead 裁决(PR2a 派工包第 3 条,2026-07-20)——桌面取证受锁屏环境限制,不再做 restart 尝试;全部实现 PR 合入后由 lead 统一安排 live-app 阶段补齐视觉证据并补跑 --slice 全量。"
    },
    "desktop.binding.code-state|windows|ja|cn": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "待集中批捕:lead 裁决(PR2a 派工包第 3 条,2026-07-20)——桌面取证受锁屏环境限制,不再做 restart 尝试;全部实现 PR 合入后由 lead 统一安排 live-app 阶段补齐视觉证据并补跑 --slice 全量。"
    },
    "desktop.binding.code-state|windows|ja|global": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "待集中批捕:lead 裁决(PR2a 派工包第 3 条,2026-07-20)——桌面取证受锁屏环境限制,不再做 restart 尝试;全部实现 PR 合入后由 lead 统一安排 live-app 阶段补齐视觉证据并补跑 --slice 全量。"
    },
    "desktop.binding.code-state|windows|ko|cn": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "待集中批捕:lead 裁决(PR2a 派工包第 3 条,2026-07-20)——桌面取证受锁屏环境限制,不再做 restart 尝试;全部实现 PR 合入后由 lead 统一安排 live-app 阶段补齐视觉证据并补跑 --slice 全量。"
    },
    "desktop.binding.code-state|windows|ko|global": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "待集中批捕:lead 裁决(PR2a 派工包第 3 条,2026-07-20)——桌面取证受锁屏环境限制,不再做 restart 尝试;全部实现 PR 合入后由 lead 统一安排 live-app 阶段补齐视觉证据并补跑 --slice 全量。"
    },
    "desktop.browser-redirect.state|mac|zh-CN|cn": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "待集中批捕:lead 裁决(PR2a 派工包第 3 条,2026-07-20)——桌面取证受锁屏环境限制,不再做 restart 尝试;全部实现 PR 合入后由 lead 统一安排 live-app 阶段补齐视觉证据并补跑 --slice 全量。"
    },
    "desktop.browser-redirect.state|mac|zh-CN|global": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "待集中批捕:lead 裁决(PR2a 派工包第 3 条,2026-07-20)——桌面取证受锁屏环境限制,不再做 restart 尝试;全部实现 PR 合入后由 lead 统一安排 live-app 阶段补齐视觉证据并补跑 --slice 全量。"
    },
    "desktop.browser-redirect.state|mac|zh-TW|cn": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "待集中批捕:lead 裁决(PR2a 派工包第 3 条,2026-07-20)——桌面取证受锁屏环境限制,不再做 restart 尝试;全部实现 PR 合入后由 lead 统一安排 live-app 阶段补齐视觉证据并补跑 --slice 全量。"
    },
    "desktop.browser-redirect.state|mac|zh-TW|global": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "待集中批捕:lead 裁决(PR2a 派工包第 3 条,2026-07-20)——桌面取证受锁屏环境限制,不再做 restart 尝试;全部实现 PR 合入后由 lead 统一安排 live-app 阶段补齐视觉证据并补跑 --slice 全量。"
    },
    "desktop.browser-redirect.state|mac|en|cn": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "待集中批捕:lead 裁决(PR2a 派工包第 3 条,2026-07-20)——桌面取证受锁屏环境限制,不再做 restart 尝试;全部实现 PR 合入后由 lead 统一安排 live-app 阶段补齐视觉证据并补跑 --slice 全量。"
    },
    "desktop.browser-redirect.state|mac|en|global": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "待集中批捕:lead 裁决(PR2a 派工包第 3 条,2026-07-20)——桌面取证受锁屏环境限制,不再做 restart 尝试;全部实现 PR 合入后由 lead 统一安排 live-app 阶段补齐视觉证据并补跑 --slice 全量。"
    },
    "desktop.browser-redirect.state|mac|ja|cn": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "待集中批捕:lead 裁决(PR2a 派工包第 3 条,2026-07-20)——桌面取证受锁屏环境限制,不再做 restart 尝试;全部实现 PR 合入后由 lead 统一安排 live-app 阶段补齐视觉证据并补跑 --slice 全量。"
    },
    "desktop.browser-redirect.state|mac|ja|global": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "待集中批捕:lead 裁决(PR2a 派工包第 3 条,2026-07-20)——桌面取证受锁屏环境限制,不再做 restart 尝试;全部实现 PR 合入后由 lead 统一安排 live-app 阶段补齐视觉证据并补跑 --slice 全量。"
    },
    "desktop.browser-redirect.state|mac|ko|cn": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "待集中批捕:lead 裁决(PR2a 派工包第 3 条,2026-07-20)——桌面取证受锁屏环境限制,不再做 restart 尝试;全部实现 PR 合入后由 lead 统一安排 live-app 阶段补齐视觉证据并补跑 --slice 全量。"
    },
    "desktop.browser-redirect.state|mac|ko|global": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "待集中批捕:lead 裁决(PR2a 派工包第 3 条,2026-07-20)——桌面取证受锁屏环境限制,不再做 restart 尝试;全部实现 PR 合入后由 lead 统一安排 live-app 阶段补齐视觉证据并补跑 --slice 全量。"
    },
    "desktop.browser-redirect.state|windows|zh-CN|cn": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "待集中批捕:lead 裁决(PR2a 派工包第 3 条,2026-07-20)——桌面取证受锁屏环境限制,不再做 restart 尝试;全部实现 PR 合入后由 lead 统一安排 live-app 阶段补齐视觉证据并补跑 --slice 全量。"
    },
    "desktop.browser-redirect.state|windows|zh-CN|global": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "待集中批捕:lead 裁决(PR2a 派工包第 3 条,2026-07-20)——桌面取证受锁屏环境限制,不再做 restart 尝试;全部实现 PR 合入后由 lead 统一安排 live-app 阶段补齐视觉证据并补跑 --slice 全量。"
    },
    "desktop.browser-redirect.state|windows|zh-TW|cn": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "待集中批捕:lead 裁决(PR2a 派工包第 3 条,2026-07-20)——桌面取证受锁屏环境限制,不再做 restart 尝试;全部实现 PR 合入后由 lead 统一安排 live-app 阶段补齐视觉证据并补跑 --slice 全量。"
    },
    "desktop.browser-redirect.state|windows|zh-TW|global": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "待集中批捕:lead 裁决(PR2a 派工包第 3 条,2026-07-20)——桌面取证受锁屏环境限制,不再做 restart 尝试;全部实现 PR 合入后由 lead 统一安排 live-app 阶段补齐视觉证据并补跑 --slice 全量。"
    },
    "desktop.browser-redirect.state|windows|en|cn": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "待集中批捕:lead 裁决(PR2a 派工包第 3 条,2026-07-20)——桌面取证受锁屏环境限制,不再做 restart 尝试;全部实现 PR 合入后由 lead 统一安排 live-app 阶段补齐视觉证据并补跑 --slice 全量。"
    },
    "desktop.browser-redirect.state|windows|en|global": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "待集中批捕:lead 裁决(PR2a 派工包第 3 条,2026-07-20)——桌面取证受锁屏环境限制,不再做 restart 尝试;全部实现 PR 合入后由 lead 统一安排 live-app 阶段补齐视觉证据并补跑 --slice 全量。"
    },
    "desktop.browser-redirect.state|windows|ja|cn": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "待集中批捕:lead 裁决(PR2a 派工包第 3 条,2026-07-20)——桌面取证受锁屏环境限制,不再做 restart 尝试;全部实现 PR 合入后由 lead 统一安排 live-app 阶段补齐视觉证据并补跑 --slice 全量。"
    },
    "desktop.browser-redirect.state|windows|ja|global": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "待集中批捕:lead 裁决(PR2a 派工包第 3 条,2026-07-20)——桌面取证受锁屏环境限制,不再做 restart 尝试;全部实现 PR 合入后由 lead 统一安排 live-app 阶段补齐视觉证据并补跑 --slice 全量。"
    },
    "desktop.browser-redirect.state|windows|ko|cn": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "待集中批捕:lead 裁决(PR2a 派工包第 3 条,2026-07-20)——桌面取证受锁屏环境限制,不再做 restart 尝试;全部实现 PR 合入后由 lead 统一安排 live-app 阶段补齐视觉证据并补跑 --slice 全量。"
    },
    "desktop.browser-redirect.state|windows|ko|global": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "待集中批捕:lead 裁决(PR2a 派工包第 3 条,2026-07-20)——桌面取证受锁屏环境限制,不再做 restart 尝试;全部实现 PR 合入后由 lead 统一安排 live-app 阶段补齐视觉证据并补跑 --slice 全量。"
    },
    "desktop.error.state|mac|zh-CN|cn": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "待集中批捕:lead 裁决(PR2a 派工包第 3 条,2026-07-20)——桌面取证受锁屏环境限制,不再做 restart 尝试;全部实现 PR 合入后由 lead 统一安排 live-app 阶段补齐视觉证据并补跑 --slice 全量。"
    },
    "desktop.error.state|mac|zh-CN|global": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "待集中批捕:lead 裁决(PR2a 派工包第 3 条,2026-07-20)——桌面取证受锁屏环境限制,不再做 restart 尝试;全部实现 PR 合入后由 lead 统一安排 live-app 阶段补齐视觉证据并补跑 --slice 全量。"
    },
    "desktop.error.state|mac|zh-TW|cn": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "待集中批捕:lead 裁决(PR2a 派工包第 3 条,2026-07-20)——桌面取证受锁屏环境限制,不再做 restart 尝试;全部实现 PR 合入后由 lead 统一安排 live-app 阶段补齐视觉证据并补跑 --slice 全量。"
    },
    "desktop.error.state|mac|zh-TW|global": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "待集中批捕:lead 裁决(PR2a 派工包第 3 条,2026-07-20)——桌面取证受锁屏环境限制,不再做 restart 尝试;全部实现 PR 合入后由 lead 统一安排 live-app 阶段补齐视觉证据并补跑 --slice 全量。"
    },
    "desktop.error.state|mac|en|cn": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "待集中批捕:lead 裁决(PR2a 派工包第 3 条,2026-07-20)——桌面取证受锁屏环境限制,不再做 restart 尝试;全部实现 PR 合入后由 lead 统一安排 live-app 阶段补齐视觉证据并补跑 --slice 全量。"
    },
    "desktop.error.state|mac|en|global": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "待集中批捕:lead 裁决(PR2a 派工包第 3 条,2026-07-20)——桌面取证受锁屏环境限制,不再做 restart 尝试;全部实现 PR 合入后由 lead 统一安排 live-app 阶段补齐视觉证据并补跑 --slice 全量。"
    },
    "desktop.error.state|mac|ja|cn": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "待集中批捕:lead 裁决(PR2a 派工包第 3 条,2026-07-20)——桌面取证受锁屏环境限制,不再做 restart 尝试;全部实现 PR 合入后由 lead 统一安排 live-app 阶段补齐视觉证据并补跑 --slice 全量。"
    },
    "desktop.error.state|mac|ja|global": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "待集中批捕:lead 裁决(PR2a 派工包第 3 条,2026-07-20)——桌面取证受锁屏环境限制,不再做 restart 尝试;全部实现 PR 合入后由 lead 统一安排 live-app 阶段补齐视觉证据并补跑 --slice 全量。"
    },
    "desktop.error.state|mac|ko|cn": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "待集中批捕:lead 裁决(PR2a 派工包第 3 条,2026-07-20)——桌面取证受锁屏环境限制,不再做 restart 尝试;全部实现 PR 合入后由 lead 统一安排 live-app 阶段补齐视觉证据并补跑 --slice 全量。"
    },
    "desktop.error.state|mac|ko|global": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "待集中批捕:lead 裁决(PR2a 派工包第 3 条,2026-07-20)——桌面取证受锁屏环境限制,不再做 restart 尝试;全部实现 PR 合入后由 lead 统一安排 live-app 阶段补齐视觉证据并补跑 --slice 全量。"
    },
    "desktop.error.state|windows|zh-CN|cn": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "待集中批捕:lead 裁决(PR2a 派工包第 3 条,2026-07-20)——桌面取证受锁屏环境限制,不再做 restart 尝试;全部实现 PR 合入后由 lead 统一安排 live-app 阶段补齐视觉证据并补跑 --slice 全量。"
    },
    "desktop.error.state|windows|zh-CN|global": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "待集中批捕:lead 裁决(PR2a 派工包第 3 条,2026-07-20)——桌面取证受锁屏环境限制,不再做 restart 尝试;全部实现 PR 合入后由 lead 统一安排 live-app 阶段补齐视觉证据并补跑 --slice 全量。"
    },
    "desktop.error.state|windows|zh-TW|cn": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "待集中批捕:lead 裁决(PR2a 派工包第 3 条,2026-07-20)——桌面取证受锁屏环境限制,不再做 restart 尝试;全部实现 PR 合入后由 lead 统一安排 live-app 阶段补齐视觉证据并补跑 --slice 全量。"
    },
    "desktop.error.state|windows|zh-TW|global": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "待集中批捕:lead 裁决(PR2a 派工包第 3 条,2026-07-20)——桌面取证受锁屏环境限制,不再做 restart 尝试;全部实现 PR 合入后由 lead 统一安排 live-app 阶段补齐视觉证据并补跑 --slice 全量。"
    },
    "desktop.error.state|windows|en|cn": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "待集中批捕:lead 裁决(PR2a 派工包第 3 条,2026-07-20)——桌面取证受锁屏环境限制,不再做 restart 尝试;全部实现 PR 合入后由 lead 统一安排 live-app 阶段补齐视觉证据并补跑 --slice 全量。"
    },
    "desktop.error.state|windows|en|global": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "待集中批捕:lead 裁决(PR2a 派工包第 3 条,2026-07-20)——桌面取证受锁屏环境限制,不再做 restart 尝试;全部实现 PR 合入后由 lead 统一安排 live-app 阶段补齐视觉证据并补跑 --slice 全量。"
    },
    "desktop.error.state|windows|ja|cn": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "待集中批捕:lead 裁决(PR2a 派工包第 3 条,2026-07-20)——桌面取证受锁屏环境限制,不再做 restart 尝试;全部实现 PR 合入后由 lead 统一安排 live-app 阶段补齐视觉证据并补跑 --slice 全量。"
    },
    "desktop.error.state|windows|ja|global": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "待集中批捕:lead 裁决(PR2a 派工包第 3 条,2026-07-20)——桌面取证受锁屏环境限制,不再做 restart 尝试;全部实现 PR 合入后由 lead 统一安排 live-app 阶段补齐视觉证据并补跑 --slice 全量。"
    },
    "desktop.error.state|windows|ko|cn": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "待集中批捕:lead 裁决(PR2a 派工包第 3 条,2026-07-20)——桌面取证受锁屏环境限制,不再做 restart 尝试;全部实现 PR 合入后由 lead 统一安排 live-app 阶段补齐视觉证据并补跑 --slice 全量。"
    },
    "desktop.error.state|windows|ko|global": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "待集中批捕:lead 裁决(PR2a 派工包第 3 条,2026-07-20)——桌面取证受锁屏环境限制,不再做 restart 尝试;全部实现 PR 合入后由 lead 统一安排 live-app 阶段补齐视觉证据并补跑 --slice 全量。"
    },
    "desktop.completed.state|mac|zh-CN|cn": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "待集中批捕:lead 裁决(PR2a 派工包第 3 条,2026-07-20)——桌面取证受锁屏环境限制,不再做 restart 尝试;全部实现 PR 合入后由 lead 统一安排 live-app 阶段补齐视觉证据并补跑 --slice 全量。"
    },
    "desktop.completed.state|mac|zh-CN|global": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "待集中批捕:lead 裁决(PR2a 派工包第 3 条,2026-07-20)——桌面取证受锁屏环境限制,不再做 restart 尝试;全部实现 PR 合入后由 lead 统一安排 live-app 阶段补齐视觉证据并补跑 --slice 全量。"
    },
    "desktop.completed.state|mac|zh-TW|cn": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "待集中批捕:lead 裁决(PR2a 派工包第 3 条,2026-07-20)——桌面取证受锁屏环境限制,不再做 restart 尝试;全部实现 PR 合入后由 lead 统一安排 live-app 阶段补齐视觉证据并补跑 --slice 全量。"
    },
    "desktop.completed.state|mac|zh-TW|global": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "待集中批捕:lead 裁决(PR2a 派工包第 3 条,2026-07-20)——桌面取证受锁屏环境限制,不再做 restart 尝试;全部实现 PR 合入后由 lead 统一安排 live-app 阶段补齐视觉证据并补跑 --slice 全量。"
    },
    "desktop.completed.state|mac|en|cn": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "待集中批捕:lead 裁决(PR2a 派工包第 3 条,2026-07-20)——桌面取证受锁屏环境限制,不再做 restart 尝试;全部实现 PR 合入后由 lead 统一安排 live-app 阶段补齐视觉证据并补跑 --slice 全量。"
    },
    "desktop.completed.state|mac|en|global": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "待集中批捕:lead 裁决(PR2a 派工包第 3 条,2026-07-20)——桌面取证受锁屏环境限制,不再做 restart 尝试;全部实现 PR 合入后由 lead 统一安排 live-app 阶段补齐视觉证据并补跑 --slice 全量。"
    },
    "desktop.completed.state|mac|ja|cn": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "待集中批捕:lead 裁决(PR2a 派工包第 3 条,2026-07-20)——桌面取证受锁屏环境限制,不再做 restart 尝试;全部实现 PR 合入后由 lead 统一安排 live-app 阶段补齐视觉证据并补跑 --slice 全量。"
    },
    "desktop.completed.state|mac|ja|global": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "待集中批捕:lead 裁决(PR2a 派工包第 3 条,2026-07-20)——桌面取证受锁屏环境限制,不再做 restart 尝试;全部实现 PR 合入后由 lead 统一安排 live-app 阶段补齐视觉证据并补跑 --slice 全量。"
    },
    "desktop.completed.state|mac|ko|cn": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "待集中批捕:lead 裁决(PR2a 派工包第 3 条,2026-07-20)——桌面取证受锁屏环境限制,不再做 restart 尝试;全部实现 PR 合入后由 lead 统一安排 live-app 阶段补齐视觉证据并补跑 --slice 全量。"
    },
    "desktop.completed.state|mac|ko|global": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "待集中批捕:lead 裁决(PR2a 派工包第 3 条,2026-07-20)——桌面取证受锁屏环境限制,不再做 restart 尝试;全部实现 PR 合入后由 lead 统一安排 live-app 阶段补齐视觉证据并补跑 --slice 全量。"
    },
    "desktop.completed.state|windows|zh-CN|cn": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "待集中批捕:lead 裁决(PR2a 派工包第 3 条,2026-07-20)——桌面取证受锁屏环境限制,不再做 restart 尝试;全部实现 PR 合入后由 lead 统一安排 live-app 阶段补齐视觉证据并补跑 --slice 全量。"
    },
    "desktop.completed.state|windows|zh-CN|global": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "待集中批捕:lead 裁决(PR2a 派工包第 3 条,2026-07-20)——桌面取证受锁屏环境限制,不再做 restart 尝试;全部实现 PR 合入后由 lead 统一安排 live-app 阶段补齐视觉证据并补跑 --slice 全量。"
    },
    "desktop.completed.state|windows|zh-TW|cn": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "待集中批捕:lead 裁决(PR2a 派工包第 3 条,2026-07-20)——桌面取证受锁屏环境限制,不再做 restart 尝试;全部实现 PR 合入后由 lead 统一安排 live-app 阶段补齐视觉证据并补跑 --slice 全量。"
    },
    "desktop.completed.state|windows|zh-TW|global": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "待集中批捕:lead 裁决(PR2a 派工包第 3 条,2026-07-20)——桌面取证受锁屏环境限制,不再做 restart 尝试;全部实现 PR 合入后由 lead 统一安排 live-app 阶段补齐视觉证据并补跑 --slice 全量。"
    },
    "desktop.completed.state|windows|en|cn": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "待集中批捕:lead 裁决(PR2a 派工包第 3 条,2026-07-20)——桌面取证受锁屏环境限制,不再做 restart 尝试;全部实现 PR 合入后由 lead 统一安排 live-app 阶段补齐视觉证据并补跑 --slice 全量。"
    },
    "desktop.completed.state|windows|en|global": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "待集中批捕:lead 裁决(PR2a 派工包第 3 条,2026-07-20)——桌面取证受锁屏环境限制,不再做 restart 尝试;全部实现 PR 合入后由 lead 统一安排 live-app 阶段补齐视觉证据并补跑 --slice 全量。"
    },
    "desktop.completed.state|windows|ja|cn": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "待集中批捕:lead 裁决(PR2a 派工包第 3 条,2026-07-20)——桌面取证受锁屏环境限制,不再做 restart 尝试;全部实现 PR 合入后由 lead 统一安排 live-app 阶段补齐视觉证据并补跑 --slice 全量。"
    },
    "desktop.completed.state|windows|ja|global": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "待集中批捕:lead 裁决(PR2a 派工包第 3 条,2026-07-20)——桌面取证受锁屏环境限制,不再做 restart 尝试;全部实现 PR 合入后由 lead 统一安排 live-app 阶段补齐视觉证据并补跑 --slice 全量。"
    },
    "desktop.completed.state|windows|ko|cn": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "待集中批捕:lead 裁决(PR2a 派工包第 3 条,2026-07-20)——桌面取证受锁屏环境限制,不再做 restart 尝试;全部实现 PR 合入后由 lead 统一安排 live-app 阶段补齐视觉证据并补跑 --slice 全量。"
    },
    "desktop.completed.state|windows|ko|global": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "待集中批捕:lead 裁决(PR2a 派工包第 3 条,2026-07-20)——桌面取证受锁屏环境限制,不再做 restart 尝试;全部实现 PR 合入后由 lead 统一安排 live-app 阶段补齐视觉证据并补跑 --slice 全量。"
    },
    "desktop.verification-code.countdown|mac|zh-CN|cn": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "待集中批捕:lead 裁决(PR2a 派工包第 3 条,2026-07-20)——桌面取证受锁屏环境限制,不再做 restart 尝试;全部实现 PR 合入后由 lead 统一安排 live-app 阶段补齐视觉证据并补跑 --slice 全量。"
    },
    "desktop.verification-code.countdown|mac|zh-CN|global": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "待集中批捕:lead 裁决(PR2a 派工包第 3 条,2026-07-20)——桌面取证受锁屏环境限制,不再做 restart 尝试;全部实现 PR 合入后由 lead 统一安排 live-app 阶段补齐视觉证据并补跑 --slice 全量。"
    },
    "desktop.verification-code.countdown|mac|zh-TW|cn": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "待集中批捕:lead 裁决(PR2a 派工包第 3 条,2026-07-20)——桌面取证受锁屏环境限制,不再做 restart 尝试;全部实现 PR 合入后由 lead 统一安排 live-app 阶段补齐视觉证据并补跑 --slice 全量。"
    },
    "desktop.verification-code.countdown|mac|zh-TW|global": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "待集中批捕:lead 裁决(PR2a 派工包第 3 条,2026-07-20)——桌面取证受锁屏环境限制,不再做 restart 尝试;全部实现 PR 合入后由 lead 统一安排 live-app 阶段补齐视觉证据并补跑 --slice 全量。"
    },
    "desktop.verification-code.countdown|mac|en|cn": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "待集中批捕:lead 裁决(PR2a 派工包第 3 条,2026-07-20)——桌面取证受锁屏环境限制,不再做 restart 尝试;全部实现 PR 合入后由 lead 统一安排 live-app 阶段补齐视觉证据并补跑 --slice 全量。"
    },
    "desktop.verification-code.countdown|mac|en|global": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "待集中批捕:lead 裁决(PR2a 派工包第 3 条,2026-07-20)——桌面取证受锁屏环境限制,不再做 restart 尝试;全部实现 PR 合入后由 lead 统一安排 live-app 阶段补齐视觉证据并补跑 --slice 全量。"
    },
    "desktop.verification-code.countdown|mac|ja|cn": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "待集中批捕:lead 裁决(PR2a 派工包第 3 条,2026-07-20)——桌面取证受锁屏环境限制,不再做 restart 尝试;全部实现 PR 合入后由 lead 统一安排 live-app 阶段补齐视觉证据并补跑 --slice 全量。"
    },
    "desktop.verification-code.countdown|mac|ja|global": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "待集中批捕:lead 裁决(PR2a 派工包第 3 条,2026-07-20)——桌面取证受锁屏环境限制,不再做 restart 尝试;全部实现 PR 合入后由 lead 统一安排 live-app 阶段补齐视觉证据并补跑 --slice 全量。"
    },
    "desktop.verification-code.countdown|mac|ko|cn": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "待集中批捕:lead 裁决(PR2a 派工包第 3 条,2026-07-20)——桌面取证受锁屏环境限制,不再做 restart 尝试;全部实现 PR 合入后由 lead 统一安排 live-app 阶段补齐视觉证据并补跑 --slice 全量。"
    },
    "desktop.verification-code.countdown|mac|ko|global": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "待集中批捕:lead 裁决(PR2a 派工包第 3 条,2026-07-20)——桌面取证受锁屏环境限制,不再做 restart 尝试;全部实现 PR 合入后由 lead 统一安排 live-app 阶段补齐视觉证据并补跑 --slice 全量。"
    },
    "desktop.verification-code.countdown|windows|zh-CN|cn": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "待集中批捕:lead 裁决(PR2a 派工包第 3 条,2026-07-20)——桌面取证受锁屏环境限制,不再做 restart 尝试;全部实现 PR 合入后由 lead 统一安排 live-app 阶段补齐视觉证据并补跑 --slice 全量。"
    },
    "desktop.verification-code.countdown|windows|zh-CN|global": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "待集中批捕:lead 裁决(PR2a 派工包第 3 条,2026-07-20)——桌面取证受锁屏环境限制,不再做 restart 尝试;全部实现 PR 合入后由 lead 统一安排 live-app 阶段补齐视觉证据并补跑 --slice 全量。"
    },
    "desktop.verification-code.countdown|windows|zh-TW|cn": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "待集中批捕:lead 裁决(PR2a 派工包第 3 条,2026-07-20)——桌面取证受锁屏环境限制,不再做 restart 尝试;全部实现 PR 合入后由 lead 统一安排 live-app 阶段补齐视觉证据并补跑 --slice 全量。"
    },
    "desktop.verification-code.countdown|windows|zh-TW|global": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "待集中批捕:lead 裁决(PR2a 派工包第 3 条,2026-07-20)——桌面取证受锁屏环境限制,不再做 restart 尝试;全部实现 PR 合入后由 lead 统一安排 live-app 阶段补齐视觉证据并补跑 --slice 全量。"
    },
    "desktop.verification-code.countdown|windows|en|cn": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "待集中批捕:lead 裁决(PR2a 派工包第 3 条,2026-07-20)——桌面取证受锁屏环境限制,不再做 restart 尝试;全部实现 PR 合入后由 lead 统一安排 live-app 阶段补齐视觉证据并补跑 --slice 全量。"
    },
    "desktop.verification-code.countdown|windows|en|global": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "待集中批捕:lead 裁决(PR2a 派工包第 3 条,2026-07-20)——桌面取证受锁屏环境限制,不再做 restart 尝试;全部实现 PR 合入后由 lead 统一安排 live-app 阶段补齐视觉证据并补跑 --slice 全量。"
    },
    "desktop.verification-code.countdown|windows|ja|cn": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "待集中批捕:lead 裁决(PR2a 派工包第 3 条,2026-07-20)——桌面取证受锁屏环境限制,不再做 restart 尝试;全部实现 PR 合入后由 lead 统一安排 live-app 阶段补齐视觉证据并补跑 --slice 全量。"
    },
    "desktop.verification-code.countdown|windows|ja|global": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "待集中批捕:lead 裁决(PR2a 派工包第 3 条,2026-07-20)——桌面取证受锁屏环境限制,不再做 restart 尝试;全部实现 PR 合入后由 lead 统一安排 live-app 阶段补齐视觉证据并补跑 --slice 全量。"
    },
    "desktop.verification-code.countdown|windows|ko|cn": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "待集中批捕:lead 裁决(PR2a 派工包第 3 条,2026-07-20)——桌面取证受锁屏环境限制,不再做 restart 尝试;全部实现 PR 合入后由 lead 统一安排 live-app 阶段补齐视觉证据并补跑 --slice 全量。"
    },
    "desktop.verification-code.countdown|windows|ko|global": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "待集中批捕:lead 裁决(PR2a 派工包第 3 条,2026-07-20)——桌面取证受锁屏环境限制,不再做 restart 尝试;全部实现 PR 合入后由 lead 统一安排 live-app 阶段补齐视觉证据并补跑 --slice 全量。"
    },
    "desktop.error-copy.AUTH_SERVICE_UNAVAILABLE|mac|zh-CN|cn": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "待集中批捕:lead 裁决(PR2a 派工包第 3 条,2026-07-20)——桌面取证受锁屏环境限制,不再做 restart 尝试;全部实现 PR 合入后由 lead 统一安排 live-app 阶段补齐视觉证据并补跑 --slice 全量。"
    },
    "desktop.error-copy.AUTH_SERVICE_UNAVAILABLE|mac|zh-CN|global": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "待集中批捕:lead 裁决(PR2a 派工包第 3 条,2026-07-20)——桌面取证受锁屏环境限制,不再做 restart 尝试;全部实现 PR 合入后由 lead 统一安排 live-app 阶段补齐视觉证据并补跑 --slice 全量。"
    },
    "desktop.error-copy.AUTH_SERVICE_UNAVAILABLE|mac|zh-TW|cn": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "待集中批捕:lead 裁决(PR2a 派工包第 3 条,2026-07-20)——桌面取证受锁屏环境限制,不再做 restart 尝试;全部实现 PR 合入后由 lead 统一安排 live-app 阶段补齐视觉证据并补跑 --slice 全量。"
    },
    "desktop.error-copy.AUTH_SERVICE_UNAVAILABLE|mac|zh-TW|global": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "待集中批捕:lead 裁决(PR2a 派工包第 3 条,2026-07-20)——桌面取证受锁屏环境限制,不再做 restart 尝试;全部实现 PR 合入后由 lead 统一安排 live-app 阶段补齐视觉证据并补跑 --slice 全量。"
    },
    "desktop.error-copy.AUTH_SERVICE_UNAVAILABLE|mac|en|cn": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "待集中批捕:lead 裁决(PR2a 派工包第 3 条,2026-07-20)——桌面取证受锁屏环境限制,不再做 restart 尝试;全部实现 PR 合入后由 lead 统一安排 live-app 阶段补齐视觉证据并补跑 --slice 全量。"
    },
    "desktop.error-copy.AUTH_SERVICE_UNAVAILABLE|mac|en|global": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "待集中批捕:lead 裁决(PR2a 派工包第 3 条,2026-07-20)——桌面取证受锁屏环境限制,不再做 restart 尝试;全部实现 PR 合入后由 lead 统一安排 live-app 阶段补齐视觉证据并补跑 --slice 全量。"
    },
    "desktop.error-copy.AUTH_SERVICE_UNAVAILABLE|mac|ja|cn": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "待集中批捕:lead 裁决(PR2a 派工包第 3 条,2026-07-20)——桌面取证受锁屏环境限制,不再做 restart 尝试;全部实现 PR 合入后由 lead 统一安排 live-app 阶段补齐视觉证据并补跑 --slice 全量。"
    },
    "desktop.error-copy.AUTH_SERVICE_UNAVAILABLE|mac|ja|global": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "待集中批捕:lead 裁决(PR2a 派工包第 3 条,2026-07-20)——桌面取证受锁屏环境限制,不再做 restart 尝试;全部实现 PR 合入后由 lead 统一安排 live-app 阶段补齐视觉证据并补跑 --slice 全量。"
    },
    "desktop.error-copy.AUTH_SERVICE_UNAVAILABLE|mac|ko|cn": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "待集中批捕:lead 裁决(PR2a 派工包第 3 条,2026-07-20)——桌面取证受锁屏环境限制,不再做 restart 尝试;全部实现 PR 合入后由 lead 统一安排 live-app 阶段补齐视觉证据并补跑 --slice 全量。"
    },
    "desktop.error-copy.AUTH_SERVICE_UNAVAILABLE|mac|ko|global": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "待集中批捕:lead 裁决(PR2a 派工包第 3 条,2026-07-20)——桌面取证受锁屏环境限制,不再做 restart 尝试;全部实现 PR 合入后由 lead 统一安排 live-app 阶段补齐视觉证据并补跑 --slice 全量。"
    },
    "desktop.error-copy.AUTH_SERVICE_UNAVAILABLE|windows|zh-CN|cn": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "待集中批捕:lead 裁决(PR2a 派工包第 3 条,2026-07-20)——桌面取证受锁屏环境限制,不再做 restart 尝试;全部实现 PR 合入后由 lead 统一安排 live-app 阶段补齐视觉证据并补跑 --slice 全量。"
    },
    "desktop.error-copy.AUTH_SERVICE_UNAVAILABLE|windows|zh-CN|global": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "待集中批捕:lead 裁决(PR2a 派工包第 3 条,2026-07-20)——桌面取证受锁屏环境限制,不再做 restart 尝试;全部实现 PR 合入后由 lead 统一安排 live-app 阶段补齐视觉证据并补跑 --slice 全量。"
    },
    "desktop.error-copy.AUTH_SERVICE_UNAVAILABLE|windows|zh-TW|cn": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "待集中批捕:lead 裁决(PR2a 派工包第 3 条,2026-07-20)——桌面取证受锁屏环境限制,不再做 restart 尝试;全部实现 PR 合入后由 lead 统一安排 live-app 阶段补齐视觉证据并补跑 --slice 全量。"
    },
    "desktop.error-copy.AUTH_SERVICE_UNAVAILABLE|windows|zh-TW|global": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "待集中批捕:lead 裁决(PR2a 派工包第 3 条,2026-07-20)——桌面取证受锁屏环境限制,不再做 restart 尝试;全部实现 PR 合入后由 lead 统一安排 live-app 阶段补齐视觉证据并补跑 --slice 全量。"
    },
    "desktop.error-copy.AUTH_SERVICE_UNAVAILABLE|windows|en|cn": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "待集中批捕:lead 裁决(PR2a 派工包第 3 条,2026-07-20)——桌面取证受锁屏环境限制,不再做 restart 尝试;全部实现 PR 合入后由 lead 统一安排 live-app 阶段补齐视觉证据并补跑 --slice 全量。"
    },
    "desktop.error-copy.AUTH_SERVICE_UNAVAILABLE|windows|en|global": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "待集中批捕:lead 裁决(PR2a 派工包第 3 条,2026-07-20)——桌面取证受锁屏环境限制,不再做 restart 尝试;全部实现 PR 合入后由 lead 统一安排 live-app 阶段补齐视觉证据并补跑 --slice 全量。"
    },
    "desktop.error-copy.AUTH_SERVICE_UNAVAILABLE|windows|ja|cn": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "待集中批捕:lead 裁决(PR2a 派工包第 3 条,2026-07-20)——桌面取证受锁屏环境限制,不再做 restart 尝试;全部实现 PR 合入后由 lead 统一安排 live-app 阶段补齐视觉证据并补跑 --slice 全量。"
    },
    "desktop.error-copy.AUTH_SERVICE_UNAVAILABLE|windows|ja|global": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "待集中批捕:lead 裁决(PR2a 派工包第 3 条,2026-07-20)——桌面取证受锁屏环境限制,不再做 restart 尝试;全部实现 PR 合入后由 lead 统一安排 live-app 阶段补齐视觉证据并补跑 --slice 全量。"
    },
    "desktop.error-copy.AUTH_SERVICE_UNAVAILABLE|windows|ko|cn": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "待集中批捕:lead 裁决(PR2a 派工包第 3 条,2026-07-20)——桌面取证受锁屏环境限制,不再做 restart 尝试;全部实现 PR 合入后由 lead 统一安排 live-app 阶段补齐视觉证据并补跑 --slice 全量。"
    },
    "desktop.error-copy.AUTH_SERVICE_UNAVAILABLE|windows|ko|global": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "待集中批捕:lead 裁决(PR2a 派工包第 3 条,2026-07-20)——桌面取证受锁屏环境限制,不再做 restart 尝试;全部实现 PR 合入后由 lead 统一安排 live-app 阶段补齐视觉证据并补跑 --slice 全量。"
    },
    "desktop.error-copy.AUTH_REQUEST_FAILED|mac|zh-CN|cn": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "待集中批捕:lead 裁决(PR2a 派工包第 3 条,2026-07-20)——桌面取证受锁屏环境限制,不再做 restart 尝试;全部实现 PR 合入后由 lead 统一安排 live-app 阶段补齐视觉证据并补跑 --slice 全量。"
    },
    "desktop.error-copy.AUTH_REQUEST_FAILED|mac|zh-CN|global": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "待集中批捕:lead 裁决(PR2a 派工包第 3 条,2026-07-20)——桌面取证受锁屏环境限制,不再做 restart 尝试;全部实现 PR 合入后由 lead 统一安排 live-app 阶段补齐视觉证据并补跑 --slice 全量。"
    },
    "desktop.error-copy.AUTH_REQUEST_FAILED|mac|zh-TW|cn": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "待集中批捕:lead 裁决(PR2a 派工包第 3 条,2026-07-20)——桌面取证受锁屏环境限制,不再做 restart 尝试;全部实现 PR 合入后由 lead 统一安排 live-app 阶段补齐视觉证据并补跑 --slice 全量。"
    },
    "desktop.error-copy.AUTH_REQUEST_FAILED|mac|zh-TW|global": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "待集中批捕:lead 裁决(PR2a 派工包第 3 条,2026-07-20)——桌面取证受锁屏环境限制,不再做 restart 尝试;全部实现 PR 合入后由 lead 统一安排 live-app 阶段补齐视觉证据并补跑 --slice 全量。"
    },
    "desktop.error-copy.AUTH_REQUEST_FAILED|mac|en|cn": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "待集中批捕:lead 裁决(PR2a 派工包第 3 条,2026-07-20)——桌面取证受锁屏环境限制,不再做 restart 尝试;全部实现 PR 合入后由 lead 统一安排 live-app 阶段补齐视觉证据并补跑 --slice 全量。"
    },
    "desktop.error-copy.AUTH_REQUEST_FAILED|mac|en|global": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "待集中批捕:lead 裁决(PR2a 派工包第 3 条,2026-07-20)——桌面取证受锁屏环境限制,不再做 restart 尝试;全部实现 PR 合入后由 lead 统一安排 live-app 阶段补齐视觉证据并补跑 --slice 全量。"
    },
    "desktop.error-copy.AUTH_REQUEST_FAILED|mac|ja|cn": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "待集中批捕:lead 裁决(PR2a 派工包第 3 条,2026-07-20)——桌面取证受锁屏环境限制,不再做 restart 尝试;全部实现 PR 合入后由 lead 统一安排 live-app 阶段补齐视觉证据并补跑 --slice 全量。"
    },
    "desktop.error-copy.AUTH_REQUEST_FAILED|mac|ja|global": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "待集中批捕:lead 裁决(PR2a 派工包第 3 条,2026-07-20)——桌面取证受锁屏环境限制,不再做 restart 尝试;全部实现 PR 合入后由 lead 统一安排 live-app 阶段补齐视觉证据并补跑 --slice 全量。"
    },
    "desktop.error-copy.AUTH_REQUEST_FAILED|mac|ko|cn": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "待集中批捕:lead 裁决(PR2a 派工包第 3 条,2026-07-20)——桌面取证受锁屏环境限制,不再做 restart 尝试;全部实现 PR 合入后由 lead 统一安排 live-app 阶段补齐视觉证据并补跑 --slice 全量。"
    },
    "desktop.error-copy.AUTH_REQUEST_FAILED|mac|ko|global": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "待集中批捕:lead 裁决(PR2a 派工包第 3 条,2026-07-20)——桌面取证受锁屏环境限制,不再做 restart 尝试;全部实现 PR 合入后由 lead 统一安排 live-app 阶段补齐视觉证据并补跑 --slice 全量。"
    },
    "desktop.error-copy.AUTH_REQUEST_FAILED|windows|zh-CN|cn": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "待集中批捕:lead 裁决(PR2a 派工包第 3 条,2026-07-20)——桌面取证受锁屏环境限制,不再做 restart 尝试;全部实现 PR 合入后由 lead 统一安排 live-app 阶段补齐视觉证据并补跑 --slice 全量。"
    },
    "desktop.error-copy.AUTH_REQUEST_FAILED|windows|zh-CN|global": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "待集中批捕:lead 裁决(PR2a 派工包第 3 条,2026-07-20)——桌面取证受锁屏环境限制,不再做 restart 尝试;全部实现 PR 合入后由 lead 统一安排 live-app 阶段补齐视觉证据并补跑 --slice 全量。"
    },
    "desktop.error-copy.AUTH_REQUEST_FAILED|windows|zh-TW|cn": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "待集中批捕:lead 裁决(PR2a 派工包第 3 条,2026-07-20)——桌面取证受锁屏环境限制,不再做 restart 尝试;全部实现 PR 合入后由 lead 统一安排 live-app 阶段补齐视觉证据并补跑 --slice 全量。"
    },
    "desktop.error-copy.AUTH_REQUEST_FAILED|windows|zh-TW|global": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "待集中批捕:lead 裁决(PR2a 派工包第 3 条,2026-07-20)——桌面取证受锁屏环境限制,不再做 restart 尝试;全部实现 PR 合入后由 lead 统一安排 live-app 阶段补齐视觉证据并补跑 --slice 全量。"
    },
    "desktop.error-copy.AUTH_REQUEST_FAILED|windows|en|cn": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "待集中批捕:lead 裁决(PR2a 派工包第 3 条,2026-07-20)——桌面取证受锁屏环境限制,不再做 restart 尝试;全部实现 PR 合入后由 lead 统一安排 live-app 阶段补齐视觉证据并补跑 --slice 全量。"
    },
    "desktop.error-copy.AUTH_REQUEST_FAILED|windows|en|global": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "待集中批捕:lead 裁决(PR2a 派工包第 3 条,2026-07-20)——桌面取证受锁屏环境限制,不再做 restart 尝试;全部实现 PR 合入后由 lead 统一安排 live-app 阶段补齐视觉证据并补跑 --slice 全量。"
    },
    "desktop.error-copy.AUTH_REQUEST_FAILED|windows|ja|cn": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "待集中批捕:lead 裁决(PR2a 派工包第 3 条,2026-07-20)——桌面取证受锁屏环境限制,不再做 restart 尝试;全部实现 PR 合入后由 lead 统一安排 live-app 阶段补齐视觉证据并补跑 --slice 全量。"
    },
    "desktop.error-copy.AUTH_REQUEST_FAILED|windows|ja|global": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "待集中批捕:lead 裁决(PR2a 派工包第 3 条,2026-07-20)——桌面取证受锁屏环境限制,不再做 restart 尝试;全部实现 PR 合入后由 lead 统一安排 live-app 阶段补齐视觉证据并补跑 --slice 全量。"
    },
    "desktop.error-copy.AUTH_REQUEST_FAILED|windows|ko|cn": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "待集中批捕:lead 裁决(PR2a 派工包第 3 条,2026-07-20)——桌面取证受锁屏环境限制,不再做 restart 尝试;全部实现 PR 合入后由 lead 统一安排 live-app 阶段补齐视觉证据并补跑 --slice 全量。"
    },
    "desktop.error-copy.AUTH_REQUEST_FAILED|windows|ko|global": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "待集中批捕:lead 裁决(PR2a 派工包第 3 条,2026-07-20)——桌面取证受锁屏环境限制,不再做 restart 尝试;全部实现 PR 合入后由 lead 统一安排 live-app 阶段补齐视觉证据并补跑 --slice 全量。"
    },
    "desktop.error-copy.NETWORK_ERROR|mac|zh-CN|cn": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "待集中批捕:lead 裁决(PR2a 派工包第 3 条,2026-07-20)——桌面取证受锁屏环境限制,不再做 restart 尝试;全部实现 PR 合入后由 lead 统一安排 live-app 阶段补齐视觉证据并补跑 --slice 全量。"
    },
    "desktop.error-copy.NETWORK_ERROR|mac|zh-CN|global": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "待集中批捕:lead 裁决(PR2a 派工包第 3 条,2026-07-20)——桌面取证受锁屏环境限制,不再做 restart 尝试;全部实现 PR 合入后由 lead 统一安排 live-app 阶段补齐视觉证据并补跑 --slice 全量。"
    },
    "desktop.error-copy.NETWORK_ERROR|mac|zh-TW|cn": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "待集中批捕:lead 裁决(PR2a 派工包第 3 条,2026-07-20)——桌面取证受锁屏环境限制,不再做 restart 尝试;全部实现 PR 合入后由 lead 统一安排 live-app 阶段补齐视觉证据并补跑 --slice 全量。"
    },
    "desktop.error-copy.NETWORK_ERROR|mac|zh-TW|global": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "待集中批捕:lead 裁决(PR2a 派工包第 3 条,2026-07-20)——桌面取证受锁屏环境限制,不再做 restart 尝试;全部实现 PR 合入后由 lead 统一安排 live-app 阶段补齐视觉证据并补跑 --slice 全量。"
    },
    "desktop.error-copy.NETWORK_ERROR|mac|en|cn": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "待集中批捕:lead 裁决(PR2a 派工包第 3 条,2026-07-20)——桌面取证受锁屏环境限制,不再做 restart 尝试;全部实现 PR 合入后由 lead 统一安排 live-app 阶段补齐视觉证据并补跑 --slice 全量。"
    },
    "desktop.error-copy.NETWORK_ERROR|mac|en|global": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "待集中批捕:lead 裁决(PR2a 派工包第 3 条,2026-07-20)——桌面取证受锁屏环境限制,不再做 restart 尝试;全部实现 PR 合入后由 lead 统一安排 live-app 阶段补齐视觉证据并补跑 --slice 全量。"
    },
    "desktop.error-copy.NETWORK_ERROR|mac|ja|cn": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "待集中批捕:lead 裁决(PR2a 派工包第 3 条,2026-07-20)——桌面取证受锁屏环境限制,不再做 restart 尝试;全部实现 PR 合入后由 lead 统一安排 live-app 阶段补齐视觉证据并补跑 --slice 全量。"
    },
    "desktop.error-copy.NETWORK_ERROR|mac|ja|global": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "待集中批捕:lead 裁决(PR2a 派工包第 3 条,2026-07-20)——桌面取证受锁屏环境限制,不再做 restart 尝试;全部实现 PR 合入后由 lead 统一安排 live-app 阶段补齐视觉证据并补跑 --slice 全量。"
    },
    "desktop.error-copy.NETWORK_ERROR|mac|ko|cn": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "待集中批捕:lead 裁决(PR2a 派工包第 3 条,2026-07-20)——桌面取证受锁屏环境限制,不再做 restart 尝试;全部实现 PR 合入后由 lead 统一安排 live-app 阶段补齐视觉证据并补跑 --slice 全量。"
    },
    "desktop.error-copy.NETWORK_ERROR|mac|ko|global": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "待集中批捕:lead 裁决(PR2a 派工包第 3 条,2026-07-20)——桌面取证受锁屏环境限制,不再做 restart 尝试;全部实现 PR 合入后由 lead 统一安排 live-app 阶段补齐视觉证据并补跑 --slice 全量。"
    },
    "desktop.error-copy.NETWORK_ERROR|windows|zh-CN|cn": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "待集中批捕:lead 裁决(PR2a 派工包第 3 条,2026-07-20)——桌面取证受锁屏环境限制,不再做 restart 尝试;全部实现 PR 合入后由 lead 统一安排 live-app 阶段补齐视觉证据并补跑 --slice 全量。"
    },
    "desktop.error-copy.NETWORK_ERROR|windows|zh-CN|global": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "待集中批捕:lead 裁决(PR2a 派工包第 3 条,2026-07-20)——桌面取证受锁屏环境限制,不再做 restart 尝试;全部实现 PR 合入后由 lead 统一安排 live-app 阶段补齐视觉证据并补跑 --slice 全量。"
    },
    "desktop.error-copy.NETWORK_ERROR|windows|zh-TW|cn": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "待集中批捕:lead 裁决(PR2a 派工包第 3 条,2026-07-20)——桌面取证受锁屏环境限制,不再做 restart 尝试;全部实现 PR 合入后由 lead 统一安排 live-app 阶段补齐视觉证据并补跑 --slice 全量。"
    },
    "desktop.error-copy.NETWORK_ERROR|windows|zh-TW|global": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "待集中批捕:lead 裁决(PR2a 派工包第 3 条,2026-07-20)——桌面取证受锁屏环境限制,不再做 restart 尝试;全部实现 PR 合入后由 lead 统一安排 live-app 阶段补齐视觉证据并补跑 --slice 全量。"
    },
    "desktop.error-copy.NETWORK_ERROR|windows|en|cn": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "待集中批捕:lead 裁决(PR2a 派工包第 3 条,2026-07-20)——桌面取证受锁屏环境限制,不再做 restart 尝试;全部实现 PR 合入后由 lead 统一安排 live-app 阶段补齐视觉证据并补跑 --slice 全量。"
    },
    "desktop.error-copy.NETWORK_ERROR|windows|en|global": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "待集中批捕:lead 裁决(PR2a 派工包第 3 条,2026-07-20)——桌面取证受锁屏环境限制,不再做 restart 尝试;全部实现 PR 合入后由 lead 统一安排 live-app 阶段补齐视觉证据并补跑 --slice 全量。"
    },
    "desktop.error-copy.NETWORK_ERROR|windows|ja|cn": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "待集中批捕:lead 裁决(PR2a 派工包第 3 条,2026-07-20)——桌面取证受锁屏环境限制,不再做 restart 尝试;全部实现 PR 合入后由 lead 统一安排 live-app 阶段补齐视觉证据并补跑 --slice 全量。"
    },
    "desktop.error-copy.NETWORK_ERROR|windows|ja|global": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "待集中批捕:lead 裁决(PR2a 派工包第 3 条,2026-07-20)——桌面取证受锁屏环境限制,不再做 restart 尝试;全部实现 PR 合入后由 lead 统一安排 live-app 阶段补齐视觉证据并补跑 --slice 全量。"
    },
    "desktop.error-copy.NETWORK_ERROR|windows|ko|cn": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "待集中批捕:lead 裁决(PR2a 派工包第 3 条,2026-07-20)——桌面取证受锁屏环境限制,不再做 restart 尝试;全部实现 PR 合入后由 lead 统一安排 live-app 阶段补齐视觉证据并补跑 --slice 全量。"
    },
    "desktop.error-copy.NETWORK_ERROR|windows|ko|global": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "待集中批捕:lead 裁决(PR2a 派工包第 3 条,2026-07-20)——桌面取证受锁屏环境限制,不再做 restart 尝试;全部实现 PR 合入后由 lead 统一安排 live-app 阶段补齐视觉证据并补跑 --slice 全量。"
    },
    "desktop.error-copy.REQUEST_TIMEOUT|mac|zh-CN|cn": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "待集中批捕:lead 裁决(PR2a 派工包第 3 条,2026-07-20)——桌面取证受锁屏环境限制,不再做 restart 尝试;全部实现 PR 合入后由 lead 统一安排 live-app 阶段补齐视觉证据并补跑 --slice 全量。"
    },
    "desktop.error-copy.REQUEST_TIMEOUT|mac|zh-CN|global": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "待集中批捕:lead 裁决(PR2a 派工包第 3 条,2026-07-20)——桌面取证受锁屏环境限制,不再做 restart 尝试;全部实现 PR 合入后由 lead 统一安排 live-app 阶段补齐视觉证据并补跑 --slice 全量。"
    },
    "desktop.error-copy.REQUEST_TIMEOUT|mac|zh-TW|cn": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "待集中批捕:lead 裁决(PR2a 派工包第 3 条,2026-07-20)——桌面取证受锁屏环境限制,不再做 restart 尝试;全部实现 PR 合入后由 lead 统一安排 live-app 阶段补齐视觉证据并补跑 --slice 全量。"
    },
    "desktop.error-copy.REQUEST_TIMEOUT|mac|zh-TW|global": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "待集中批捕:lead 裁决(PR2a 派工包第 3 条,2026-07-20)——桌面取证受锁屏环境限制,不再做 restart 尝试;全部实现 PR 合入后由 lead 统一安排 live-app 阶段补齐视觉证据并补跑 --slice 全量。"
    },
    "desktop.error-copy.REQUEST_TIMEOUT|mac|en|cn": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "待集中批捕:lead 裁决(PR2a 派工包第 3 条,2026-07-20)——桌面取证受锁屏环境限制,不再做 restart 尝试;全部实现 PR 合入后由 lead 统一安排 live-app 阶段补齐视觉证据并补跑 --slice 全量。"
    },
    "desktop.error-copy.REQUEST_TIMEOUT|mac|en|global": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "待集中批捕:lead 裁决(PR2a 派工包第 3 条,2026-07-20)——桌面取证受锁屏环境限制,不再做 restart 尝试;全部实现 PR 合入后由 lead 统一安排 live-app 阶段补齐视觉证据并补跑 --slice 全量。"
    },
    "desktop.error-copy.REQUEST_TIMEOUT|mac|ja|cn": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "待集中批捕:lead 裁决(PR2a 派工包第 3 条,2026-07-20)——桌面取证受锁屏环境限制,不再做 restart 尝试;全部实现 PR 合入后由 lead 统一安排 live-app 阶段补齐视觉证据并补跑 --slice 全量。"
    },
    "desktop.error-copy.REQUEST_TIMEOUT|mac|ja|global": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "待集中批捕:lead 裁决(PR2a 派工包第 3 条,2026-07-20)——桌面取证受锁屏环境限制,不再做 restart 尝试;全部实现 PR 合入后由 lead 统一安排 live-app 阶段补齐视觉证据并补跑 --slice 全量。"
    },
    "desktop.error-copy.REQUEST_TIMEOUT|mac|ko|cn": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "待集中批捕:lead 裁决(PR2a 派工包第 3 条,2026-07-20)——桌面取证受锁屏环境限制,不再做 restart 尝试;全部实现 PR 合入后由 lead 统一安排 live-app 阶段补齐视觉证据并补跑 --slice 全量。"
    },
    "desktop.error-copy.REQUEST_TIMEOUT|mac|ko|global": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "待集中批捕:lead 裁决(PR2a 派工包第 3 条,2026-07-20)——桌面取证受锁屏环境限制,不再做 restart 尝试;全部实现 PR 合入后由 lead 统一安排 live-app 阶段补齐视觉证据并补跑 --slice 全量。"
    },
    "desktop.error-copy.REQUEST_TIMEOUT|windows|zh-CN|cn": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "待集中批捕:lead 裁决(PR2a 派工包第 3 条,2026-07-20)——桌面取证受锁屏环境限制,不再做 restart 尝试;全部实现 PR 合入后由 lead 统一安排 live-app 阶段补齐视觉证据并补跑 --slice 全量。"
    },
    "desktop.error-copy.REQUEST_TIMEOUT|windows|zh-CN|global": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "待集中批捕:lead 裁决(PR2a 派工包第 3 条,2026-07-20)——桌面取证受锁屏环境限制,不再做 restart 尝试;全部实现 PR 合入后由 lead 统一安排 live-app 阶段补齐视觉证据并补跑 --slice 全量。"
    },
    "desktop.error-copy.REQUEST_TIMEOUT|windows|zh-TW|cn": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "待集中批捕:lead 裁决(PR2a 派工包第 3 条,2026-07-20)——桌面取证受锁屏环境限制,不再做 restart 尝试;全部实现 PR 合入后由 lead 统一安排 live-app 阶段补齐视觉证据并补跑 --slice 全量。"
    },
    "desktop.error-copy.REQUEST_TIMEOUT|windows|zh-TW|global": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "待集中批捕:lead 裁决(PR2a 派工包第 3 条,2026-07-20)——桌面取证受锁屏环境限制,不再做 restart 尝试;全部实现 PR 合入后由 lead 统一安排 live-app 阶段补齐视觉证据并补跑 --slice 全量。"
    },
    "desktop.error-copy.REQUEST_TIMEOUT|windows|en|cn": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "待集中批捕:lead 裁决(PR2a 派工包第 3 条,2026-07-20)——桌面取证受锁屏环境限制,不再做 restart 尝试;全部实现 PR 合入后由 lead 统一安排 live-app 阶段补齐视觉证据并补跑 --slice 全量。"
    },
    "desktop.error-copy.REQUEST_TIMEOUT|windows|en|global": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "待集中批捕:lead 裁决(PR2a 派工包第 3 条,2026-07-20)——桌面取证受锁屏环境限制,不再做 restart 尝试;全部实现 PR 合入后由 lead 统一安排 live-app 阶段补齐视觉证据并补跑 --slice 全量。"
    },
    "desktop.error-copy.REQUEST_TIMEOUT|windows|ja|cn": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "待集中批捕:lead 裁决(PR2a 派工包第 3 条,2026-07-20)——桌面取证受锁屏环境限制,不再做 restart 尝试;全部实现 PR 合入后由 lead 统一安排 live-app 阶段补齐视觉证据并补跑 --slice 全量。"
    },
    "desktop.error-copy.REQUEST_TIMEOUT|windows|ja|global": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "待集中批捕:lead 裁决(PR2a 派工包第 3 条,2026-07-20)——桌面取证受锁屏环境限制,不再做 restart 尝试;全部实现 PR 合入后由 lead 统一安排 live-app 阶段补齐视觉证据并补跑 --slice 全量。"
    },
    "desktop.error-copy.REQUEST_TIMEOUT|windows|ko|cn": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "待集中批捕:lead 裁决(PR2a 派工包第 3 条,2026-07-20)——桌面取证受锁屏环境限制,不再做 restart 尝试;全部实现 PR 合入后由 lead 统一安排 live-app 阶段补齐视觉证据并补跑 --slice 全量。"
    },
    "desktop.error-copy.REQUEST_TIMEOUT|windows|ko|global": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "待集中批捕:lead 裁决(PR2a 派工包第 3 条,2026-07-20)——桌面取证受锁屏环境限制,不再做 restart 尝试;全部实现 PR 合入后由 lead 统一安排 live-app 阶段补齐视觉证据并补跑 --slice 全量。"
    },
    "desktop.error-copy.INVALID_PARAMS|mac|zh-CN|cn": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "待集中批捕:lead 裁决(PR2a 派工包第 3 条,2026-07-20)——桌面取证受锁屏环境限制,不再做 restart 尝试;全部实现 PR 合入后由 lead 统一安排 live-app 阶段补齐视觉证据并补跑 --slice 全量。"
    },
    "desktop.error-copy.INVALID_PARAMS|mac|zh-CN|global": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "待集中批捕:lead 裁决(PR2a 派工包第 3 条,2026-07-20)——桌面取证受锁屏环境限制,不再做 restart 尝试;全部实现 PR 合入后由 lead 统一安排 live-app 阶段补齐视觉证据并补跑 --slice 全量。"
    },
    "desktop.error-copy.INVALID_PARAMS|mac|zh-TW|cn": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "待集中批捕:lead 裁决(PR2a 派工包第 3 条,2026-07-20)——桌面取证受锁屏环境限制,不再做 restart 尝试;全部实现 PR 合入后由 lead 统一安排 live-app 阶段补齐视觉证据并补跑 --slice 全量。"
    },
    "desktop.error-copy.INVALID_PARAMS|mac|zh-TW|global": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "待集中批捕:lead 裁决(PR2a 派工包第 3 条,2026-07-20)——桌面取证受锁屏环境限制,不再做 restart 尝试;全部实现 PR 合入后由 lead 统一安排 live-app 阶段补齐视觉证据并补跑 --slice 全量。"
    },
    "desktop.error-copy.INVALID_PARAMS|mac|en|cn": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "待集中批捕:lead 裁决(PR2a 派工包第 3 条,2026-07-20)——桌面取证受锁屏环境限制,不再做 restart 尝试;全部实现 PR 合入后由 lead 统一安排 live-app 阶段补齐视觉证据并补跑 --slice 全量。"
    },
    "desktop.error-copy.INVALID_PARAMS|mac|en|global": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "待集中批捕:lead 裁决(PR2a 派工包第 3 条,2026-07-20)——桌面取证受锁屏环境限制,不再做 restart 尝试;全部实现 PR 合入后由 lead 统一安排 live-app 阶段补齐视觉证据并补跑 --slice 全量。"
    },
    "desktop.error-copy.INVALID_PARAMS|mac|ja|cn": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "待集中批捕:lead 裁决(PR2a 派工包第 3 条,2026-07-20)——桌面取证受锁屏环境限制,不再做 restart 尝试;全部实现 PR 合入后由 lead 统一安排 live-app 阶段补齐视觉证据并补跑 --slice 全量。"
    },
    "desktop.error-copy.INVALID_PARAMS|mac|ja|global": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "待集中批捕:lead 裁决(PR2a 派工包第 3 条,2026-07-20)——桌面取证受锁屏环境限制,不再做 restart 尝试;全部实现 PR 合入后由 lead 统一安排 live-app 阶段补齐视觉证据并补跑 --slice 全量。"
    },
    "desktop.error-copy.INVALID_PARAMS|mac|ko|cn": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "待集中批捕:lead 裁决(PR2a 派工包第 3 条,2026-07-20)——桌面取证受锁屏环境限制,不再做 restart 尝试;全部实现 PR 合入后由 lead 统一安排 live-app 阶段补齐视觉证据并补跑 --slice 全量。"
    },
    "desktop.error-copy.INVALID_PARAMS|mac|ko|global": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "待集中批捕:lead 裁决(PR2a 派工包第 3 条,2026-07-20)——桌面取证受锁屏环境限制,不再做 restart 尝试;全部实现 PR 合入后由 lead 统一安排 live-app 阶段补齐视觉证据并补跑 --slice 全量。"
    },
    "desktop.error-copy.INVALID_PARAMS|windows|zh-CN|cn": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "待集中批捕:lead 裁决(PR2a 派工包第 3 条,2026-07-20)——桌面取证受锁屏环境限制,不再做 restart 尝试;全部实现 PR 合入后由 lead 统一安排 live-app 阶段补齐视觉证据并补跑 --slice 全量。"
    },
    "desktop.error-copy.INVALID_PARAMS|windows|zh-CN|global": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "待集中批捕:lead 裁决(PR2a 派工包第 3 条,2026-07-20)——桌面取证受锁屏环境限制,不再做 restart 尝试;全部实现 PR 合入后由 lead 统一安排 live-app 阶段补齐视觉证据并补跑 --slice 全量。"
    },
    "desktop.error-copy.INVALID_PARAMS|windows|zh-TW|cn": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "待集中批捕:lead 裁决(PR2a 派工包第 3 条,2026-07-20)——桌面取证受锁屏环境限制,不再做 restart 尝试;全部实现 PR 合入后由 lead 统一安排 live-app 阶段补齐视觉证据并补跑 --slice 全量。"
    },
    "desktop.error-copy.INVALID_PARAMS|windows|zh-TW|global": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "待集中批捕:lead 裁决(PR2a 派工包第 3 条,2026-07-20)——桌面取证受锁屏环境限制,不再做 restart 尝试;全部实现 PR 合入后由 lead 统一安排 live-app 阶段补齐视觉证据并补跑 --slice 全量。"
    },
    "desktop.error-copy.INVALID_PARAMS|windows|en|cn": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "待集中批捕:lead 裁决(PR2a 派工包第 3 条,2026-07-20)——桌面取证受锁屏环境限制,不再做 restart 尝试;全部实现 PR 合入后由 lead 统一安排 live-app 阶段补齐视觉证据并补跑 --slice 全量。"
    },
    "desktop.error-copy.INVALID_PARAMS|windows|en|global": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "待集中批捕:lead 裁决(PR2a 派工包第 3 条,2026-07-20)——桌面取证受锁屏环境限制,不再做 restart 尝试;全部实现 PR 合入后由 lead 统一安排 live-app 阶段补齐视觉证据并补跑 --slice 全量。"
    },
    "desktop.error-copy.INVALID_PARAMS|windows|ja|cn": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "待集中批捕:lead 裁决(PR2a 派工包第 3 条,2026-07-20)——桌面取证受锁屏环境限制,不再做 restart 尝试;全部实现 PR 合入后由 lead 统一安排 live-app 阶段补齐视觉证据并补跑 --slice 全量。"
    },
    "desktop.error-copy.INVALID_PARAMS|windows|ja|global": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "待集中批捕:lead 裁决(PR2a 派工包第 3 条,2026-07-20)——桌面取证受锁屏环境限制,不再做 restart 尝试;全部实现 PR 合入后由 lead 统一安排 live-app 阶段补齐视觉证据并补跑 --slice 全量。"
    },
    "desktop.error-copy.INVALID_PARAMS|windows|ko|cn": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "待集中批捕:lead 裁决(PR2a 派工包第 3 条,2026-07-20)——桌面取证受锁屏环境限制,不再做 restart 尝试;全部实现 PR 合入后由 lead 统一安排 live-app 阶段补齐视觉证据并补跑 --slice 全量。"
    },
    "desktop.error-copy.INVALID_PARAMS|windows|ko|global": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "待集中批捕:lead 裁决(PR2a 派工包第 3 条,2026-07-20)——桌面取证受锁屏环境限制,不再做 restart 尝试;全部实现 PR 合入后由 lead 统一安排 live-app 阶段补齐视觉证据并补跑 --slice 全量。"
    },
    "desktop.error-copy.INVALID_CODE|mac|zh-CN|cn": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "待集中批捕:lead 裁决(PR2a 派工包第 3 条,2026-07-20)——桌面取证受锁屏环境限制,不再做 restart 尝试;全部实现 PR 合入后由 lead 统一安排 live-app 阶段补齐视觉证据并补跑 --slice 全量。"
    },
    "desktop.error-copy.INVALID_CODE|mac|zh-CN|global": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "待集中批捕:lead 裁决(PR2a 派工包第 3 条,2026-07-20)——桌面取证受锁屏环境限制,不再做 restart 尝试;全部实现 PR 合入后由 lead 统一安排 live-app 阶段补齐视觉证据并补跑 --slice 全量。"
    },
    "desktop.error-copy.INVALID_CODE|mac|zh-TW|cn": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "待集中批捕:lead 裁决(PR2a 派工包第 3 条,2026-07-20)——桌面取证受锁屏环境限制,不再做 restart 尝试;全部实现 PR 合入后由 lead 统一安排 live-app 阶段补齐视觉证据并补跑 --slice 全量。"
    },
    "desktop.error-copy.INVALID_CODE|mac|zh-TW|global": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "待集中批捕:lead 裁决(PR2a 派工包第 3 条,2026-07-20)——桌面取证受锁屏环境限制,不再做 restart 尝试;全部实现 PR 合入后由 lead 统一安排 live-app 阶段补齐视觉证据并补跑 --slice 全量。"
    },
    "desktop.error-copy.INVALID_CODE|mac|en|cn": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "待集中批捕:lead 裁决(PR2a 派工包第 3 条,2026-07-20)——桌面取证受锁屏环境限制,不再做 restart 尝试;全部实现 PR 合入后由 lead 统一安排 live-app 阶段补齐视觉证据并补跑 --slice 全量。"
    },
    "desktop.error-copy.INVALID_CODE|mac|en|global": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "待集中批捕:lead 裁决(PR2a 派工包第 3 条,2026-07-20)——桌面取证受锁屏环境限制,不再做 restart 尝试;全部实现 PR 合入后由 lead 统一安排 live-app 阶段补齐视觉证据并补跑 --slice 全量。"
    },
    "desktop.error-copy.INVALID_CODE|mac|ja|cn": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "待集中批捕:lead 裁决(PR2a 派工包第 3 条,2026-07-20)——桌面取证受锁屏环境限制,不再做 restart 尝试;全部实现 PR 合入后由 lead 统一安排 live-app 阶段补齐视觉证据并补跑 --slice 全量。"
    },
    "desktop.error-copy.INVALID_CODE|mac|ja|global": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "待集中批捕:lead 裁决(PR2a 派工包第 3 条,2026-07-20)——桌面取证受锁屏环境限制,不再做 restart 尝试;全部实现 PR 合入后由 lead 统一安排 live-app 阶段补齐视觉证据并补跑 --slice 全量。"
    },
    "desktop.error-copy.INVALID_CODE|mac|ko|cn": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "待集中批捕:lead 裁决(PR2a 派工包第 3 条,2026-07-20)——桌面取证受锁屏环境限制,不再做 restart 尝试;全部实现 PR 合入后由 lead 统一安排 live-app 阶段补齐视觉证据并补跑 --slice 全量。"
    },
    "desktop.error-copy.INVALID_CODE|mac|ko|global": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "待集中批捕:lead 裁决(PR2a 派工包第 3 条,2026-07-20)——桌面取证受锁屏环境限制,不再做 restart 尝试;全部实现 PR 合入后由 lead 统一安排 live-app 阶段补齐视觉证据并补跑 --slice 全量。"
    },
    "desktop.error-copy.INVALID_CODE|windows|zh-CN|cn": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "待集中批捕:lead 裁决(PR2a 派工包第 3 条,2026-07-20)——桌面取证受锁屏环境限制,不再做 restart 尝试;全部实现 PR 合入后由 lead 统一安排 live-app 阶段补齐视觉证据并补跑 --slice 全量。"
    },
    "desktop.error-copy.INVALID_CODE|windows|zh-CN|global": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "待集中批捕:lead 裁决(PR2a 派工包第 3 条,2026-07-20)——桌面取证受锁屏环境限制,不再做 restart 尝试;全部实现 PR 合入后由 lead 统一安排 live-app 阶段补齐视觉证据并补跑 --slice 全量。"
    },
    "desktop.error-copy.INVALID_CODE|windows|zh-TW|cn": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "待集中批捕:lead 裁决(PR2a 派工包第 3 条,2026-07-20)——桌面取证受锁屏环境限制,不再做 restart 尝试;全部实现 PR 合入后由 lead 统一安排 live-app 阶段补齐视觉证据并补跑 --slice 全量。"
    },
    "desktop.error-copy.INVALID_CODE|windows|zh-TW|global": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "待集中批捕:lead 裁决(PR2a 派工包第 3 条,2026-07-20)——桌面取证受锁屏环境限制,不再做 restart 尝试;全部实现 PR 合入后由 lead 统一安排 live-app 阶段补齐视觉证据并补跑 --slice 全量。"
    },
    "desktop.error-copy.INVALID_CODE|windows|en|cn": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "待集中批捕:lead 裁决(PR2a 派工包第 3 条,2026-07-20)——桌面取证受锁屏环境限制,不再做 restart 尝试;全部实现 PR 合入后由 lead 统一安排 live-app 阶段补齐视觉证据并补跑 --slice 全量。"
    },
    "desktop.error-copy.INVALID_CODE|windows|en|global": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "待集中批捕:lead 裁决(PR2a 派工包第 3 条,2026-07-20)——桌面取证受锁屏环境限制,不再做 restart 尝试;全部实现 PR 合入后由 lead 统一安排 live-app 阶段补齐视觉证据并补跑 --slice 全量。"
    },
    "desktop.error-copy.INVALID_CODE|windows|ja|cn": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "待集中批捕:lead 裁决(PR2a 派工包第 3 条,2026-07-20)——桌面取证受锁屏环境限制,不再做 restart 尝试;全部实现 PR 合入后由 lead 统一安排 live-app 阶段补齐视觉证据并补跑 --slice 全量。"
    },
    "desktop.error-copy.INVALID_CODE|windows|ja|global": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "待集中批捕:lead 裁决(PR2a 派工包第 3 条,2026-07-20)——桌面取证受锁屏环境限制,不再做 restart 尝试;全部实现 PR 合入后由 lead 统一安排 live-app 阶段补齐视觉证据并补跑 --slice 全量。"
    },
    "desktop.error-copy.INVALID_CODE|windows|ko|cn": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "待集中批捕:lead 裁决(PR2a 派工包第 3 条,2026-07-20)——桌面取证受锁屏环境限制,不再做 restart 尝试;全部实现 PR 合入后由 lead 统一安排 live-app 阶段补齐视觉证据并补跑 --slice 全量。"
    },
    "desktop.error-copy.INVALID_CODE|windows|ko|global": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "待集中批捕:lead 裁决(PR2a 派工包第 3 条,2026-07-20)——桌面取证受锁屏环境限制,不再做 restart 尝试;全部实现 PR 合入后由 lead 统一安排 live-app 阶段补齐视觉证据并补跑 --slice 全量。"
    },
    "desktop.error-copy.CODE_ATTEMPTS_EXCEEDED|mac|zh-CN|cn": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "待集中批捕:lead 裁决(PR2a 派工包第 3 条,2026-07-20)——桌面取证受锁屏环境限制,不再做 restart 尝试;全部实现 PR 合入后由 lead 统一安排 live-app 阶段补齐视觉证据并补跑 --slice 全量。"
    },
    "desktop.error-copy.CODE_ATTEMPTS_EXCEEDED|mac|zh-CN|global": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "待集中批捕:lead 裁决(PR2a 派工包第 3 条,2026-07-20)——桌面取证受锁屏环境限制,不再做 restart 尝试;全部实现 PR 合入后由 lead 统一安排 live-app 阶段补齐视觉证据并补跑 --slice 全量。"
    },
    "desktop.error-copy.CODE_ATTEMPTS_EXCEEDED|mac|zh-TW|cn": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "待集中批捕:lead 裁决(PR2a 派工包第 3 条,2026-07-20)——桌面取证受锁屏环境限制,不再做 restart 尝试;全部实现 PR 合入后由 lead 统一安排 live-app 阶段补齐视觉证据并补跑 --slice 全量。"
    },
    "desktop.error-copy.CODE_ATTEMPTS_EXCEEDED|mac|zh-TW|global": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "待集中批捕:lead 裁决(PR2a 派工包第 3 条,2026-07-20)——桌面取证受锁屏环境限制,不再做 restart 尝试;全部实现 PR 合入后由 lead 统一安排 live-app 阶段补齐视觉证据并补跑 --slice 全量。"
    },
    "desktop.error-copy.CODE_ATTEMPTS_EXCEEDED|mac|en|cn": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "待集中批捕:lead 裁决(PR2a 派工包第 3 条,2026-07-20)——桌面取证受锁屏环境限制,不再做 restart 尝试;全部实现 PR 合入后由 lead 统一安排 live-app 阶段补齐视觉证据并补跑 --slice 全量。"
    },
    "desktop.error-copy.CODE_ATTEMPTS_EXCEEDED|mac|en|global": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "待集中批捕:lead 裁决(PR2a 派工包第 3 条,2026-07-20)——桌面取证受锁屏环境限制,不再做 restart 尝试;全部实现 PR 合入后由 lead 统一安排 live-app 阶段补齐视觉证据并补跑 --slice 全量。"
    },
    "desktop.error-copy.CODE_ATTEMPTS_EXCEEDED|mac|ja|cn": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "待集中批捕:lead 裁决(PR2a 派工包第 3 条,2026-07-20)——桌面取证受锁屏环境限制,不再做 restart 尝试;全部实现 PR 合入后由 lead 统一安排 live-app 阶段补齐视觉证据并补跑 --slice 全量。"
    },
    "desktop.error-copy.CODE_ATTEMPTS_EXCEEDED|mac|ja|global": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "待集中批捕:lead 裁决(PR2a 派工包第 3 条,2026-07-20)——桌面取证受锁屏环境限制,不再做 restart 尝试;全部实现 PR 合入后由 lead 统一安排 live-app 阶段补齐视觉证据并补跑 --slice 全量。"
    },
    "desktop.error-copy.CODE_ATTEMPTS_EXCEEDED|mac|ko|cn": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "待集中批捕:lead 裁决(PR2a 派工包第 3 条,2026-07-20)——桌面取证受锁屏环境限制,不再做 restart 尝试;全部实现 PR 合入后由 lead 统一安排 live-app 阶段补齐视觉证据并补跑 --slice 全量。"
    },
    "desktop.error-copy.CODE_ATTEMPTS_EXCEEDED|mac|ko|global": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "待集中批捕:lead 裁决(PR2a 派工包第 3 条,2026-07-20)——桌面取证受锁屏环境限制,不再做 restart 尝试;全部实现 PR 合入后由 lead 统一安排 live-app 阶段补齐视觉证据并补跑 --slice 全量。"
    },
    "desktop.error-copy.CODE_ATTEMPTS_EXCEEDED|windows|zh-CN|cn": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "待集中批捕:lead 裁决(PR2a 派工包第 3 条,2026-07-20)——桌面取证受锁屏环境限制,不再做 restart 尝试;全部实现 PR 合入后由 lead 统一安排 live-app 阶段补齐视觉证据并补跑 --slice 全量。"
    },
    "desktop.error-copy.CODE_ATTEMPTS_EXCEEDED|windows|zh-CN|global": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "待集中批捕:lead 裁决(PR2a 派工包第 3 条,2026-07-20)——桌面取证受锁屏环境限制,不再做 restart 尝试;全部实现 PR 合入后由 lead 统一安排 live-app 阶段补齐视觉证据并补跑 --slice 全量。"
    },
    "desktop.error-copy.CODE_ATTEMPTS_EXCEEDED|windows|zh-TW|cn": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "待集中批捕:lead 裁决(PR2a 派工包第 3 条,2026-07-20)——桌面取证受锁屏环境限制,不再做 restart 尝试;全部实现 PR 合入后由 lead 统一安排 live-app 阶段补齐视觉证据并补跑 --slice 全量。"
    },
    "desktop.error-copy.CODE_ATTEMPTS_EXCEEDED|windows|zh-TW|global": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "待集中批捕:lead 裁决(PR2a 派工包第 3 条,2026-07-20)——桌面取证受锁屏环境限制,不再做 restart 尝试;全部实现 PR 合入后由 lead 统一安排 live-app 阶段补齐视觉证据并补跑 --slice 全量。"
    },
    "desktop.error-copy.CODE_ATTEMPTS_EXCEEDED|windows|en|cn": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "待集中批捕:lead 裁决(PR2a 派工包第 3 条,2026-07-20)——桌面取证受锁屏环境限制,不再做 restart 尝试;全部实现 PR 合入后由 lead 统一安排 live-app 阶段补齐视觉证据并补跑 --slice 全量。"
    },
    "desktop.error-copy.CODE_ATTEMPTS_EXCEEDED|windows|en|global": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "待集中批捕:lead 裁决(PR2a 派工包第 3 条,2026-07-20)——桌面取证受锁屏环境限制,不再做 restart 尝试;全部实现 PR 合入后由 lead 统一安排 live-app 阶段补齐视觉证据并补跑 --slice 全量。"
    },
    "desktop.error-copy.CODE_ATTEMPTS_EXCEEDED|windows|ja|cn": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "待集中批捕:lead 裁决(PR2a 派工包第 3 条,2026-07-20)——桌面取证受锁屏环境限制,不再做 restart 尝试;全部实现 PR 合入后由 lead 统一安排 live-app 阶段补齐视觉证据并补跑 --slice 全量。"
    },
    "desktop.error-copy.CODE_ATTEMPTS_EXCEEDED|windows|ja|global": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "待集中批捕:lead 裁决(PR2a 派工包第 3 条,2026-07-20)——桌面取证受锁屏环境限制,不再做 restart 尝试;全部实现 PR 合入后由 lead 统一安排 live-app 阶段补齐视觉证据并补跑 --slice 全量。"
    },
    "desktop.error-copy.CODE_ATTEMPTS_EXCEEDED|windows|ko|cn": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "待集中批捕:lead 裁决(PR2a 派工包第 3 条,2026-07-20)——桌面取证受锁屏环境限制,不再做 restart 尝试;全部实现 PR 合入后由 lead 统一安排 live-app 阶段补齐视觉证据并补跑 --slice 全量。"
    },
    "desktop.error-copy.CODE_ATTEMPTS_EXCEEDED|windows|ko|global": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "待集中批捕:lead 裁决(PR2a 派工包第 3 条,2026-07-20)——桌面取证受锁屏环境限制,不再做 restart 尝试;全部实现 PR 合入后由 lead 统一安排 live-app 阶段补齐视觉证据并补跑 --slice 全量。"
    },
    "desktop.error-copy.RATE_LIMITED|mac|zh-CN|cn": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "待集中批捕:lead 裁决(PR2a 派工包第 3 条,2026-07-20)——桌面取证受锁屏环境限制,不再做 restart 尝试;全部实现 PR 合入后由 lead 统一安排 live-app 阶段补齐视觉证据并补跑 --slice 全量。"
    },
    "desktop.error-copy.RATE_LIMITED|mac|zh-CN|global": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "待集中批捕:lead 裁决(PR2a 派工包第 3 条,2026-07-20)——桌面取证受锁屏环境限制,不再做 restart 尝试;全部实现 PR 合入后由 lead 统一安排 live-app 阶段补齐视觉证据并补跑 --slice 全量。"
    },
    "desktop.error-copy.RATE_LIMITED|mac|zh-TW|cn": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "待集中批捕:lead 裁决(PR2a 派工包第 3 条,2026-07-20)——桌面取证受锁屏环境限制,不再做 restart 尝试;全部实现 PR 合入后由 lead 统一安排 live-app 阶段补齐视觉证据并补跑 --slice 全量。"
    },
    "desktop.error-copy.RATE_LIMITED|mac|zh-TW|global": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "待集中批捕:lead 裁决(PR2a 派工包第 3 条,2026-07-20)——桌面取证受锁屏环境限制,不再做 restart 尝试;全部实现 PR 合入后由 lead 统一安排 live-app 阶段补齐视觉证据并补跑 --slice 全量。"
    },
    "desktop.error-copy.RATE_LIMITED|mac|en|cn": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "待集中批捕:lead 裁决(PR2a 派工包第 3 条,2026-07-20)——桌面取证受锁屏环境限制,不再做 restart 尝试;全部实现 PR 合入后由 lead 统一安排 live-app 阶段补齐视觉证据并补跑 --slice 全量。"
    },
    "desktop.error-copy.RATE_LIMITED|mac|en|global": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "待集中批捕:lead 裁决(PR2a 派工包第 3 条,2026-07-20)——桌面取证受锁屏环境限制,不再做 restart 尝试;全部实现 PR 合入后由 lead 统一安排 live-app 阶段补齐视觉证据并补跑 --slice 全量。"
    },
    "desktop.error-copy.RATE_LIMITED|mac|ja|cn": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "待集中批捕:lead 裁决(PR2a 派工包第 3 条,2026-07-20)——桌面取证受锁屏环境限制,不再做 restart 尝试;全部实现 PR 合入后由 lead 统一安排 live-app 阶段补齐视觉证据并补跑 --slice 全量。"
    },
    "desktop.error-copy.RATE_LIMITED|mac|ja|global": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "待集中批捕:lead 裁决(PR2a 派工包第 3 条,2026-07-20)——桌面取证受锁屏环境限制,不再做 restart 尝试;全部实现 PR 合入后由 lead 统一安排 live-app 阶段补齐视觉证据并补跑 --slice 全量。"
    },
    "desktop.error-copy.RATE_LIMITED|mac|ko|cn": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "待集中批捕:lead 裁决(PR2a 派工包第 3 条,2026-07-20)——桌面取证受锁屏环境限制,不再做 restart 尝试;全部实现 PR 合入后由 lead 统一安排 live-app 阶段补齐视觉证据并补跑 --slice 全量。"
    },
    "desktop.error-copy.RATE_LIMITED|mac|ko|global": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "待集中批捕:lead 裁决(PR2a 派工包第 3 条,2026-07-20)——桌面取证受锁屏环境限制,不再做 restart 尝试;全部实现 PR 合入后由 lead 统一安排 live-app 阶段补齐视觉证据并补跑 --slice 全量。"
    },
    "desktop.error-copy.RATE_LIMITED|windows|zh-CN|cn": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "待集中批捕:lead 裁决(PR2a 派工包第 3 条,2026-07-20)——桌面取证受锁屏环境限制,不再做 restart 尝试;全部实现 PR 合入后由 lead 统一安排 live-app 阶段补齐视觉证据并补跑 --slice 全量。"
    },
    "desktop.error-copy.RATE_LIMITED|windows|zh-CN|global": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "待集中批捕:lead 裁决(PR2a 派工包第 3 条,2026-07-20)——桌面取证受锁屏环境限制,不再做 restart 尝试;全部实现 PR 合入后由 lead 统一安排 live-app 阶段补齐视觉证据并补跑 --slice 全量。"
    },
    "desktop.error-copy.RATE_LIMITED|windows|zh-TW|cn": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "待集中批捕:lead 裁决(PR2a 派工包第 3 条,2026-07-20)——桌面取证受锁屏环境限制,不再做 restart 尝试;全部实现 PR 合入后由 lead 统一安排 live-app 阶段补齐视觉证据并补跑 --slice 全量。"
    },
    "desktop.error-copy.RATE_LIMITED|windows|zh-TW|global": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "待集中批捕:lead 裁决(PR2a 派工包第 3 条,2026-07-20)——桌面取证受锁屏环境限制,不再做 restart 尝试;全部实现 PR 合入后由 lead 统一安排 live-app 阶段补齐视觉证据并补跑 --slice 全量。"
    },
    "desktop.error-copy.RATE_LIMITED|windows|en|cn": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "待集中批捕:lead 裁决(PR2a 派工包第 3 条,2026-07-20)——桌面取证受锁屏环境限制,不再做 restart 尝试;全部实现 PR 合入后由 lead 统一安排 live-app 阶段补齐视觉证据并补跑 --slice 全量。"
    },
    "desktop.error-copy.RATE_LIMITED|windows|en|global": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "待集中批捕:lead 裁决(PR2a 派工包第 3 条,2026-07-20)——桌面取证受锁屏环境限制,不再做 restart 尝试;全部实现 PR 合入后由 lead 统一安排 live-app 阶段补齐视觉证据并补跑 --slice 全量。"
    },
    "desktop.error-copy.RATE_LIMITED|windows|ja|cn": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "待集中批捕:lead 裁决(PR2a 派工包第 3 条,2026-07-20)——桌面取证受锁屏环境限制,不再做 restart 尝试;全部实现 PR 合入后由 lead 统一安排 live-app 阶段补齐视觉证据并补跑 --slice 全量。"
    },
    "desktop.error-copy.RATE_LIMITED|windows|ja|global": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "待集中批捕:lead 裁决(PR2a 派工包第 3 条,2026-07-20)——桌面取证受锁屏环境限制,不再做 restart 尝试;全部实现 PR 合入后由 lead 统一安排 live-app 阶段补齐视觉证据并补跑 --slice 全量。"
    },
    "desktop.error-copy.RATE_LIMITED|windows|ko|cn": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "待集中批捕:lead 裁决(PR2a 派工包第 3 条,2026-07-20)——桌面取证受锁屏环境限制,不再做 restart 尝试;全部实现 PR 合入后由 lead 统一安排 live-app 阶段补齐视觉证据并补跑 --slice 全量。"
    },
    "desktop.error-copy.RATE_LIMITED|windows|ko|global": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "待集中批捕:lead 裁决(PR2a 派工包第 3 条,2026-07-20)——桌面取证受锁屏环境限制,不再做 restart 尝试;全部实现 PR 合入后由 lead 统一安排 live-app 阶段补齐视觉证据并补跑 --slice 全量。"
    },
    "desktop.error-copy.SSO_LOGIN_REQUIRED|mac|zh-CN|cn": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "待集中批捕:lead 裁决(PR2a 派工包第 3 条,2026-07-20)——桌面取证受锁屏环境限制,不再做 restart 尝试;全部实现 PR 合入后由 lead 统一安排 live-app 阶段补齐视觉证据并补跑 --slice 全量。"
    },
    "desktop.error-copy.SSO_LOGIN_REQUIRED|mac|zh-CN|global": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "待集中批捕:lead 裁决(PR2a 派工包第 3 条,2026-07-20)——桌面取证受锁屏环境限制,不再做 restart 尝试;全部实现 PR 合入后由 lead 统一安排 live-app 阶段补齐视觉证据并补跑 --slice 全量。"
    },
    "desktop.error-copy.SSO_LOGIN_REQUIRED|mac|zh-TW|cn": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "待集中批捕:lead 裁决(PR2a 派工包第 3 条,2026-07-20)——桌面取证受锁屏环境限制,不再做 restart 尝试;全部实现 PR 合入后由 lead 统一安排 live-app 阶段补齐视觉证据并补跑 --slice 全量。"
    },
    "desktop.error-copy.SSO_LOGIN_REQUIRED|mac|zh-TW|global": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "待集中批捕:lead 裁决(PR2a 派工包第 3 条,2026-07-20)——桌面取证受锁屏环境限制,不再做 restart 尝试;全部实现 PR 合入后由 lead 统一安排 live-app 阶段补齐视觉证据并补跑 --slice 全量。"
    },
    "desktop.error-copy.SSO_LOGIN_REQUIRED|mac|en|cn": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "待集中批捕:lead 裁决(PR2a 派工包第 3 条,2026-07-20)——桌面取证受锁屏环境限制,不再做 restart 尝试;全部实现 PR 合入后由 lead 统一安排 live-app 阶段补齐视觉证据并补跑 --slice 全量。"
    },
    "desktop.error-copy.SSO_LOGIN_REQUIRED|mac|en|global": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "待集中批捕:lead 裁决(PR2a 派工包第 3 条,2026-07-20)——桌面取证受锁屏环境限制,不再做 restart 尝试;全部实现 PR 合入后由 lead 统一安排 live-app 阶段补齐视觉证据并补跑 --slice 全量。"
    },
    "desktop.error-copy.SSO_LOGIN_REQUIRED|mac|ja|cn": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "待集中批捕:lead 裁决(PR2a 派工包第 3 条,2026-07-20)——桌面取证受锁屏环境限制,不再做 restart 尝试;全部实现 PR 合入后由 lead 统一安排 live-app 阶段补齐视觉证据并补跑 --slice 全量。"
    },
    "desktop.error-copy.SSO_LOGIN_REQUIRED|mac|ja|global": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "待集中批捕:lead 裁决(PR2a 派工包第 3 条,2026-07-20)——桌面取证受锁屏环境限制,不再做 restart 尝试;全部实现 PR 合入后由 lead 统一安排 live-app 阶段补齐视觉证据并补跑 --slice 全量。"
    },
    "desktop.error-copy.SSO_LOGIN_REQUIRED|mac|ko|cn": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "待集中批捕:lead 裁决(PR2a 派工包第 3 条,2026-07-20)——桌面取证受锁屏环境限制,不再做 restart 尝试;全部实现 PR 合入后由 lead 统一安排 live-app 阶段补齐视觉证据并补跑 --slice 全量。"
    },
    "desktop.error-copy.SSO_LOGIN_REQUIRED|mac|ko|global": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "待集中批捕:lead 裁决(PR2a 派工包第 3 条,2026-07-20)——桌面取证受锁屏环境限制,不再做 restart 尝试;全部实现 PR 合入后由 lead 统一安排 live-app 阶段补齐视觉证据并补跑 --slice 全量。"
    },
    "desktop.error-copy.SSO_LOGIN_REQUIRED|windows|zh-CN|cn": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "待集中批捕:lead 裁决(PR2a 派工包第 3 条,2026-07-20)——桌面取证受锁屏环境限制,不再做 restart 尝试;全部实现 PR 合入后由 lead 统一安排 live-app 阶段补齐视觉证据并补跑 --slice 全量。"
    },
    "desktop.error-copy.SSO_LOGIN_REQUIRED|windows|zh-CN|global": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "待集中批捕:lead 裁决(PR2a 派工包第 3 条,2026-07-20)——桌面取证受锁屏环境限制,不再做 restart 尝试;全部实现 PR 合入后由 lead 统一安排 live-app 阶段补齐视觉证据并补跑 --slice 全量。"
    },
    "desktop.error-copy.SSO_LOGIN_REQUIRED|windows|zh-TW|cn": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "待集中批捕:lead 裁决(PR2a 派工包第 3 条,2026-07-20)——桌面取证受锁屏环境限制,不再做 restart 尝试;全部实现 PR 合入后由 lead 统一安排 live-app 阶段补齐视觉证据并补跑 --slice 全量。"
    },
    "desktop.error-copy.SSO_LOGIN_REQUIRED|windows|zh-TW|global": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "待集中批捕:lead 裁决(PR2a 派工包第 3 条,2026-07-20)——桌面取证受锁屏环境限制,不再做 restart 尝试;全部实现 PR 合入后由 lead 统一安排 live-app 阶段补齐视觉证据并补跑 --slice 全量。"
    },
    "desktop.error-copy.SSO_LOGIN_REQUIRED|windows|en|cn": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "待集中批捕:lead 裁决(PR2a 派工包第 3 条,2026-07-20)——桌面取证受锁屏环境限制,不再做 restart 尝试;全部实现 PR 合入后由 lead 统一安排 live-app 阶段补齐视觉证据并补跑 --slice 全量。"
    },
    "desktop.error-copy.SSO_LOGIN_REQUIRED|windows|en|global": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "待集中批捕:lead 裁决(PR2a 派工包第 3 条,2026-07-20)——桌面取证受锁屏环境限制,不再做 restart 尝试;全部实现 PR 合入后由 lead 统一安排 live-app 阶段补齐视觉证据并补跑 --slice 全量。"
    },
    "desktop.error-copy.SSO_LOGIN_REQUIRED|windows|ja|cn": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "待集中批捕:lead 裁决(PR2a 派工包第 3 条,2026-07-20)——桌面取证受锁屏环境限制,不再做 restart 尝试;全部实现 PR 合入后由 lead 统一安排 live-app 阶段补齐视觉证据并补跑 --slice 全量。"
    },
    "desktop.error-copy.SSO_LOGIN_REQUIRED|windows|ja|global": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "待集中批捕:lead 裁决(PR2a 派工包第 3 条,2026-07-20)——桌面取证受锁屏环境限制,不再做 restart 尝试;全部实现 PR 合入后由 lead 统一安排 live-app 阶段补齐视觉证据并补跑 --slice 全量。"
    },
    "desktop.error-copy.SSO_LOGIN_REQUIRED|windows|ko|cn": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "待集中批捕:lead 裁决(PR2a 派工包第 3 条,2026-07-20)——桌面取证受锁屏环境限制,不再做 restart 尝试;全部实现 PR 合入后由 lead 统一安排 live-app 阶段补齐视觉证据并补跑 --slice 全量。"
    },
    "desktop.error-copy.SSO_LOGIN_REQUIRED|windows|ko|global": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "待集中批捕:lead 裁决(PR2a 派工包第 3 条,2026-07-20)——桌面取证受锁屏环境限制,不再做 restart 尝试;全部实现 PR 合入后由 lead 统一安排 live-app 阶段补齐视觉证据并补跑 --slice 全量。"
    },
    "desktop.error-copy.ORG_SSO_NOT_FOUND|mac|zh-CN|cn": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "待集中批捕:lead 裁决(PR2a 派工包第 3 条,2026-07-20)——桌面取证受锁屏环境限制,不再做 restart 尝试;全部实现 PR 合入后由 lead 统一安排 live-app 阶段补齐视觉证据并补跑 --slice 全量。"
    },
    "desktop.error-copy.ORG_SSO_NOT_FOUND|mac|zh-CN|global": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "待集中批捕:lead 裁决(PR2a 派工包第 3 条,2026-07-20)——桌面取证受锁屏环境限制,不再做 restart 尝试;全部实现 PR 合入后由 lead 统一安排 live-app 阶段补齐视觉证据并补跑 --slice 全量。"
    },
    "desktop.error-copy.ORG_SSO_NOT_FOUND|mac|zh-TW|cn": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "待集中批捕:lead 裁决(PR2a 派工包第 3 条,2026-07-20)——桌面取证受锁屏环境限制,不再做 restart 尝试;全部实现 PR 合入后由 lead 统一安排 live-app 阶段补齐视觉证据并补跑 --slice 全量。"
    },
    "desktop.error-copy.ORG_SSO_NOT_FOUND|mac|zh-TW|global": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "待集中批捕:lead 裁决(PR2a 派工包第 3 条,2026-07-20)——桌面取证受锁屏环境限制,不再做 restart 尝试;全部实现 PR 合入后由 lead 统一安排 live-app 阶段补齐视觉证据并补跑 --slice 全量。"
    },
    "desktop.error-copy.ORG_SSO_NOT_FOUND|mac|en|cn": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "待集中批捕:lead 裁决(PR2a 派工包第 3 条,2026-07-20)——桌面取证受锁屏环境限制,不再做 restart 尝试;全部实现 PR 合入后由 lead 统一安排 live-app 阶段补齐视觉证据并补跑 --slice 全量。"
    },
    "desktop.error-copy.ORG_SSO_NOT_FOUND|mac|en|global": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "待集中批捕:lead 裁决(PR2a 派工包第 3 条,2026-07-20)——桌面取证受锁屏环境限制,不再做 restart 尝试;全部实现 PR 合入后由 lead 统一安排 live-app 阶段补齐视觉证据并补跑 --slice 全量。"
    },
    "desktop.error-copy.ORG_SSO_NOT_FOUND|mac|ja|cn": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "待集中批捕:lead 裁决(PR2a 派工包第 3 条,2026-07-20)——桌面取证受锁屏环境限制,不再做 restart 尝试;全部实现 PR 合入后由 lead 统一安排 live-app 阶段补齐视觉证据并补跑 --slice 全量。"
    },
    "desktop.error-copy.ORG_SSO_NOT_FOUND|mac|ja|global": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "待集中批捕:lead 裁决(PR2a 派工包第 3 条,2026-07-20)——桌面取证受锁屏环境限制,不再做 restart 尝试;全部实现 PR 合入后由 lead 统一安排 live-app 阶段补齐视觉证据并补跑 --slice 全量。"
    },
    "desktop.error-copy.ORG_SSO_NOT_FOUND|mac|ko|cn": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "待集中批捕:lead 裁决(PR2a 派工包第 3 条,2026-07-20)——桌面取证受锁屏环境限制,不再做 restart 尝试;全部实现 PR 合入后由 lead 统一安排 live-app 阶段补齐视觉证据并补跑 --slice 全量。"
    },
    "desktop.error-copy.ORG_SSO_NOT_FOUND|mac|ko|global": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "待集中批捕:lead 裁决(PR2a 派工包第 3 条,2026-07-20)——桌面取证受锁屏环境限制,不再做 restart 尝试;全部实现 PR 合入后由 lead 统一安排 live-app 阶段补齐视觉证据并补跑 --slice 全量。"
    },
    "desktop.error-copy.ORG_SSO_NOT_FOUND|windows|zh-CN|cn": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "待集中批捕:lead 裁决(PR2a 派工包第 3 条,2026-07-20)——桌面取证受锁屏环境限制,不再做 restart 尝试;全部实现 PR 合入后由 lead 统一安排 live-app 阶段补齐视觉证据并补跑 --slice 全量。"
    },
    "desktop.error-copy.ORG_SSO_NOT_FOUND|windows|zh-CN|global": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "待集中批捕:lead 裁决(PR2a 派工包第 3 条,2026-07-20)——桌面取证受锁屏环境限制,不再做 restart 尝试;全部实现 PR 合入后由 lead 统一安排 live-app 阶段补齐视觉证据并补跑 --slice 全量。"
    },
    "desktop.error-copy.ORG_SSO_NOT_FOUND|windows|zh-TW|cn": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "待集中批捕:lead 裁决(PR2a 派工包第 3 条,2026-07-20)——桌面取证受锁屏环境限制,不再做 restart 尝试;全部实现 PR 合入后由 lead 统一安排 live-app 阶段补齐视觉证据并补跑 --slice 全量。"
    },
    "desktop.error-copy.ORG_SSO_NOT_FOUND|windows|zh-TW|global": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "待集中批捕:lead 裁决(PR2a 派工包第 3 条,2026-07-20)——桌面取证受锁屏环境限制,不再做 restart 尝试;全部实现 PR 合入后由 lead 统一安排 live-app 阶段补齐视觉证据并补跑 --slice 全量。"
    },
    "desktop.error-copy.ORG_SSO_NOT_FOUND|windows|en|cn": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "待集中批捕:lead 裁决(PR2a 派工包第 3 条,2026-07-20)——桌面取证受锁屏环境限制,不再做 restart 尝试;全部实现 PR 合入后由 lead 统一安排 live-app 阶段补齐视觉证据并补跑 --slice 全量。"
    },
    "desktop.error-copy.ORG_SSO_NOT_FOUND|windows|en|global": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "待集中批捕:lead 裁决(PR2a 派工包第 3 条,2026-07-20)——桌面取证受锁屏环境限制,不再做 restart 尝试;全部实现 PR 合入后由 lead 统一安排 live-app 阶段补齐视觉证据并补跑 --slice 全量。"
    },
    "desktop.error-copy.ORG_SSO_NOT_FOUND|windows|ja|cn": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "待集中批捕:lead 裁决(PR2a 派工包第 3 条,2026-07-20)——桌面取证受锁屏环境限制,不再做 restart 尝试;全部实现 PR 合入后由 lead 统一安排 live-app 阶段补齐视觉证据并补跑 --slice 全量。"
    },
    "desktop.error-copy.ORG_SSO_NOT_FOUND|windows|ja|global": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "待集中批捕:lead 裁决(PR2a 派工包第 3 条,2026-07-20)——桌面取证受锁屏环境限制,不再做 restart 尝试;全部实现 PR 合入后由 lead 统一安排 live-app 阶段补齐视觉证据并补跑 --slice 全量。"
    },
    "desktop.error-copy.ORG_SSO_NOT_FOUND|windows|ko|cn": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "待集中批捕:lead 裁决(PR2a 派工包第 3 条,2026-07-20)——桌面取证受锁屏环境限制,不再做 restart 尝试;全部实现 PR 合入后由 lead 统一安排 live-app 阶段补齐视觉证据并补跑 --slice 全量。"
    },
    "desktop.error-copy.ORG_SSO_NOT_FOUND|windows|ko|global": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "待集中批捕:lead 裁决(PR2a 派工包第 3 条,2026-07-20)——桌面取证受锁屏环境限制,不再做 restart 尝试;全部实现 PR 合入后由 lead 统一安排 live-app 阶段补齐视觉证据并补跑 --slice 全量。"
    },
    "desktop.error-copy.SOCIAL_TOKEN_INVALID|mac|zh-CN|cn": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "待集中批捕:lead 裁决(PR2a 派工包第 3 条,2026-07-20)——桌面取证受锁屏环境限制,不再做 restart 尝试;全部实现 PR 合入后由 lead 统一安排 live-app 阶段补齐视觉证据并补跑 --slice 全量。"
    },
    "desktop.error-copy.SOCIAL_TOKEN_INVALID|mac|zh-CN|global": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "待集中批捕:lead 裁决(PR2a 派工包第 3 条,2026-07-20)——桌面取证受锁屏环境限制,不再做 restart 尝试;全部实现 PR 合入后由 lead 统一安排 live-app 阶段补齐视觉证据并补跑 --slice 全量。"
    },
    "desktop.error-copy.SOCIAL_TOKEN_INVALID|mac|zh-TW|cn": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "待集中批捕:lead 裁决(PR2a 派工包第 3 条,2026-07-20)——桌面取证受锁屏环境限制,不再做 restart 尝试;全部实现 PR 合入后由 lead 统一安排 live-app 阶段补齐视觉证据并补跑 --slice 全量。"
    },
    "desktop.error-copy.SOCIAL_TOKEN_INVALID|mac|zh-TW|global": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "待集中批捕:lead 裁决(PR2a 派工包第 3 条,2026-07-20)——桌面取证受锁屏环境限制,不再做 restart 尝试;全部实现 PR 合入后由 lead 统一安排 live-app 阶段补齐视觉证据并补跑 --slice 全量。"
    },
    "desktop.error-copy.SOCIAL_TOKEN_INVALID|mac|en|cn": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "待集中批捕:lead 裁决(PR2a 派工包第 3 条,2026-07-20)——桌面取证受锁屏环境限制,不再做 restart 尝试;全部实现 PR 合入后由 lead 统一安排 live-app 阶段补齐视觉证据并补跑 --slice 全量。"
    },
    "desktop.error-copy.SOCIAL_TOKEN_INVALID|mac|en|global": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "待集中批捕:lead 裁决(PR2a 派工包第 3 条,2026-07-20)——桌面取证受锁屏环境限制,不再做 restart 尝试;全部实现 PR 合入后由 lead 统一安排 live-app 阶段补齐视觉证据并补跑 --slice 全量。"
    },
    "desktop.error-copy.SOCIAL_TOKEN_INVALID|mac|ja|cn": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "待集中批捕:lead 裁决(PR2a 派工包第 3 条,2026-07-20)——桌面取证受锁屏环境限制,不再做 restart 尝试;全部实现 PR 合入后由 lead 统一安排 live-app 阶段补齐视觉证据并补跑 --slice 全量。"
    },
    "desktop.error-copy.SOCIAL_TOKEN_INVALID|mac|ja|global": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "待集中批捕:lead 裁决(PR2a 派工包第 3 条,2026-07-20)——桌面取证受锁屏环境限制,不再做 restart 尝试;全部实现 PR 合入后由 lead 统一安排 live-app 阶段补齐视觉证据并补跑 --slice 全量。"
    },
    "desktop.error-copy.SOCIAL_TOKEN_INVALID|mac|ko|cn": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "待集中批捕:lead 裁决(PR2a 派工包第 3 条,2026-07-20)——桌面取证受锁屏环境限制,不再做 restart 尝试;全部实现 PR 合入后由 lead 统一安排 live-app 阶段补齐视觉证据并补跑 --slice 全量。"
    },
    "desktop.error-copy.SOCIAL_TOKEN_INVALID|mac|ko|global": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "待集中批捕:lead 裁决(PR2a 派工包第 3 条,2026-07-20)——桌面取证受锁屏环境限制,不再做 restart 尝试;全部实现 PR 合入后由 lead 统一安排 live-app 阶段补齐视觉证据并补跑 --slice 全量。"
    },
    "desktop.error-copy.SOCIAL_TOKEN_INVALID|windows|zh-CN|cn": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "待集中批捕:lead 裁决(PR2a 派工包第 3 条,2026-07-20)——桌面取证受锁屏环境限制,不再做 restart 尝试;全部实现 PR 合入后由 lead 统一安排 live-app 阶段补齐视觉证据并补跑 --slice 全量。"
    },
    "desktop.error-copy.SOCIAL_TOKEN_INVALID|windows|zh-CN|global": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "待集中批捕:lead 裁决(PR2a 派工包第 3 条,2026-07-20)——桌面取证受锁屏环境限制,不再做 restart 尝试;全部实现 PR 合入后由 lead 统一安排 live-app 阶段补齐视觉证据并补跑 --slice 全量。"
    },
    "desktop.error-copy.SOCIAL_TOKEN_INVALID|windows|zh-TW|cn": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "待集中批捕:lead 裁决(PR2a 派工包第 3 条,2026-07-20)——桌面取证受锁屏环境限制,不再做 restart 尝试;全部实现 PR 合入后由 lead 统一安排 live-app 阶段补齐视觉证据并补跑 --slice 全量。"
    },
    "desktop.error-copy.SOCIAL_TOKEN_INVALID|windows|zh-TW|global": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "待集中批捕:lead 裁决(PR2a 派工包第 3 条,2026-07-20)——桌面取证受锁屏环境限制,不再做 restart 尝试;全部实现 PR 合入后由 lead 统一安排 live-app 阶段补齐视觉证据并补跑 --slice 全量。"
    },
    "desktop.error-copy.SOCIAL_TOKEN_INVALID|windows|en|cn": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "待集中批捕:lead 裁决(PR2a 派工包第 3 条,2026-07-20)——桌面取证受锁屏环境限制,不再做 restart 尝试;全部实现 PR 合入后由 lead 统一安排 live-app 阶段补齐视觉证据并补跑 --slice 全量。"
    },
    "desktop.error-copy.SOCIAL_TOKEN_INVALID|windows|en|global": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "待集中批捕:lead 裁决(PR2a 派工包第 3 条,2026-07-20)——桌面取证受锁屏环境限制,不再做 restart 尝试;全部实现 PR 合入后由 lead 统一安排 live-app 阶段补齐视觉证据并补跑 --slice 全量。"
    },
    "desktop.error-copy.SOCIAL_TOKEN_INVALID|windows|ja|cn": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "待集中批捕:lead 裁决(PR2a 派工包第 3 条,2026-07-20)——桌面取证受锁屏环境限制,不再做 restart 尝试;全部实现 PR 合入后由 lead 统一安排 live-app 阶段补齐视觉证据并补跑 --slice 全量。"
    },
    "desktop.error-copy.SOCIAL_TOKEN_INVALID|windows|ja|global": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "待集中批捕:lead 裁决(PR2a 派工包第 3 条,2026-07-20)——桌面取证受锁屏环境限制,不再做 restart 尝试;全部实现 PR 合入后由 lead 统一安排 live-app 阶段补齐视觉证据并补跑 --slice 全量。"
    },
    "desktop.error-copy.SOCIAL_TOKEN_INVALID|windows|ko|cn": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "待集中批捕:lead 裁决(PR2a 派工包第 3 条,2026-07-20)——桌面取证受锁屏环境限制,不再做 restart 尝试;全部实现 PR 合入后由 lead 统一安排 live-app 阶段补齐视觉证据并补跑 --slice 全量。"
    },
    "desktop.error-copy.SOCIAL_TOKEN_INVALID|windows|ko|global": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "待集中批捕:lead 裁决(PR2a 派工包第 3 条,2026-07-20)——桌面取证受锁屏环境限制,不再做 restart 尝试;全部实现 PR 合入后由 lead 统一安排 live-app 阶段补齐视觉证据并补跑 --slice 全量。"
    },
    "desktop.error-copy.SOCIAL_PROVIDER_DISABLED|mac|zh-CN|cn": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "待集中批捕:lead 裁决(PR2a 派工包第 3 条,2026-07-20)——桌面取证受锁屏环境限制,不再做 restart 尝试;全部实现 PR 合入后由 lead 统一安排 live-app 阶段补齐视觉证据并补跑 --slice 全量。"
    },
    "desktop.error-copy.SOCIAL_PROVIDER_DISABLED|mac|zh-CN|global": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "待集中批捕:lead 裁决(PR2a 派工包第 3 条,2026-07-20)——桌面取证受锁屏环境限制,不再做 restart 尝试;全部实现 PR 合入后由 lead 统一安排 live-app 阶段补齐视觉证据并补跑 --slice 全量。"
    },
    "desktop.error-copy.SOCIAL_PROVIDER_DISABLED|mac|zh-TW|cn": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "待集中批捕:lead 裁决(PR2a 派工包第 3 条,2026-07-20)——桌面取证受锁屏环境限制,不再做 restart 尝试;全部实现 PR 合入后由 lead 统一安排 live-app 阶段补齐视觉证据并补跑 --slice 全量。"
    },
    "desktop.error-copy.SOCIAL_PROVIDER_DISABLED|mac|zh-TW|global": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "待集中批捕:lead 裁决(PR2a 派工包第 3 条,2026-07-20)——桌面取证受锁屏环境限制,不再做 restart 尝试;全部实现 PR 合入后由 lead 统一安排 live-app 阶段补齐视觉证据并补跑 --slice 全量。"
    },
    "desktop.error-copy.SOCIAL_PROVIDER_DISABLED|mac|en|cn": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "待集中批捕:lead 裁决(PR2a 派工包第 3 条,2026-07-20)——桌面取证受锁屏环境限制,不再做 restart 尝试;全部实现 PR 合入后由 lead 统一安排 live-app 阶段补齐视觉证据并补跑 --slice 全量。"
    },
    "desktop.error-copy.SOCIAL_PROVIDER_DISABLED|mac|en|global": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "待集中批捕:lead 裁决(PR2a 派工包第 3 条,2026-07-20)——桌面取证受锁屏环境限制,不再做 restart 尝试;全部实现 PR 合入后由 lead 统一安排 live-app 阶段补齐视觉证据并补跑 --slice 全量。"
    },
    "desktop.error-copy.SOCIAL_PROVIDER_DISABLED|mac|ja|cn": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "待集中批捕:lead 裁决(PR2a 派工包第 3 条,2026-07-20)——桌面取证受锁屏环境限制,不再做 restart 尝试;全部实现 PR 合入后由 lead 统一安排 live-app 阶段补齐视觉证据并补跑 --slice 全量。"
    },
    "desktop.error-copy.SOCIAL_PROVIDER_DISABLED|mac|ja|global": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "待集中批捕:lead 裁决(PR2a 派工包第 3 条,2026-07-20)——桌面取证受锁屏环境限制,不再做 restart 尝试;全部实现 PR 合入后由 lead 统一安排 live-app 阶段补齐视觉证据并补跑 --slice 全量。"
    },
    "desktop.error-copy.SOCIAL_PROVIDER_DISABLED|mac|ko|cn": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "待集中批捕:lead 裁决(PR2a 派工包第 3 条,2026-07-20)——桌面取证受锁屏环境限制,不再做 restart 尝试;全部实现 PR 合入后由 lead 统一安排 live-app 阶段补齐视觉证据并补跑 --slice 全量。"
    },
    "desktop.error-copy.SOCIAL_PROVIDER_DISABLED|mac|ko|global": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "待集中批捕:lead 裁决(PR2a 派工包第 3 条,2026-07-20)——桌面取证受锁屏环境限制,不再做 restart 尝试;全部实现 PR 合入后由 lead 统一安排 live-app 阶段补齐视觉证据并补跑 --slice 全量。"
    },
    "desktop.error-copy.SOCIAL_PROVIDER_DISABLED|windows|zh-CN|cn": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "待集中批捕:lead 裁决(PR2a 派工包第 3 条,2026-07-20)——桌面取证受锁屏环境限制,不再做 restart 尝试;全部实现 PR 合入后由 lead 统一安排 live-app 阶段补齐视觉证据并补跑 --slice 全量。"
    },
    "desktop.error-copy.SOCIAL_PROVIDER_DISABLED|windows|zh-CN|global": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "待集中批捕:lead 裁决(PR2a 派工包第 3 条,2026-07-20)——桌面取证受锁屏环境限制,不再做 restart 尝试;全部实现 PR 合入后由 lead 统一安排 live-app 阶段补齐视觉证据并补跑 --slice 全量。"
    },
    "desktop.error-copy.SOCIAL_PROVIDER_DISABLED|windows|zh-TW|cn": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "待集中批捕:lead 裁决(PR2a 派工包第 3 条,2026-07-20)——桌面取证受锁屏环境限制,不再做 restart 尝试;全部实现 PR 合入后由 lead 统一安排 live-app 阶段补齐视觉证据并补跑 --slice 全量。"
    },
    "desktop.error-copy.SOCIAL_PROVIDER_DISABLED|windows|zh-TW|global": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "待集中批捕:lead 裁决(PR2a 派工包第 3 条,2026-07-20)——桌面取证受锁屏环境限制,不再做 restart 尝试;全部实现 PR 合入后由 lead 统一安排 live-app 阶段补齐视觉证据并补跑 --slice 全量。"
    },
    "desktop.error-copy.SOCIAL_PROVIDER_DISABLED|windows|en|cn": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "待集中批捕:lead 裁决(PR2a 派工包第 3 条,2026-07-20)——桌面取证受锁屏环境限制,不再做 restart 尝试;全部实现 PR 合入后由 lead 统一安排 live-app 阶段补齐视觉证据并补跑 --slice 全量。"
    },
    "desktop.error-copy.SOCIAL_PROVIDER_DISABLED|windows|en|global": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "待集中批捕:lead 裁决(PR2a 派工包第 3 条,2026-07-20)——桌面取证受锁屏环境限制,不再做 restart 尝试;全部实现 PR 合入后由 lead 统一安排 live-app 阶段补齐视觉证据并补跑 --slice 全量。"
    },
    "desktop.error-copy.SOCIAL_PROVIDER_DISABLED|windows|ja|cn": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "待集中批捕:lead 裁决(PR2a 派工包第 3 条,2026-07-20)——桌面取证受锁屏环境限制,不再做 restart 尝试;全部实现 PR 合入后由 lead 统一安排 live-app 阶段补齐视觉证据并补跑 --slice 全量。"
    },
    "desktop.error-copy.SOCIAL_PROVIDER_DISABLED|windows|ja|global": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "待集中批捕:lead 裁决(PR2a 派工包第 3 条,2026-07-20)——桌面取证受锁屏环境限制,不再做 restart 尝试;全部实现 PR 合入后由 lead 统一安排 live-app 阶段补齐视觉证据并补跑 --slice 全量。"
    },
    "desktop.error-copy.SOCIAL_PROVIDER_DISABLED|windows|ko|cn": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "待集中批捕:lead 裁决(PR2a 派工包第 3 条,2026-07-20)——桌面取证受锁屏环境限制,不再做 restart 尝试;全部实现 PR 合入后由 lead 统一安排 live-app 阶段补齐视觉证据并补跑 --slice 全量。"
    },
    "desktop.error-copy.SOCIAL_PROVIDER_DISABLED|windows|ko|global": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "待集中批捕:lead 裁决(PR2a 派工包第 3 条,2026-07-20)——桌面取证受锁屏环境限制,不再做 restart 尝试;全部实现 PR 合入后由 lead 统一安排 live-app 阶段补齐视觉证据并补跑 --slice 全量。"
    },
    "desktop.error-copy.USER_CANCELLED|mac|zh-CN|cn": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "待集中批捕:lead 裁决(PR2a 派工包第 3 条,2026-07-20)——桌面取证受锁屏环境限制,不再做 restart 尝试;全部实现 PR 合入后由 lead 统一安排 live-app 阶段补齐视觉证据并补跑 --slice 全量。"
    },
    "desktop.error-copy.USER_CANCELLED|mac|zh-CN|global": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "待集中批捕:lead 裁决(PR2a 派工包第 3 条,2026-07-20)——桌面取证受锁屏环境限制,不再做 restart 尝试;全部实现 PR 合入后由 lead 统一安排 live-app 阶段补齐视觉证据并补跑 --slice 全量。"
    },
    "desktop.error-copy.USER_CANCELLED|mac|zh-TW|cn": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "待集中批捕:lead 裁决(PR2a 派工包第 3 条,2026-07-20)——桌面取证受锁屏环境限制,不再做 restart 尝试;全部实现 PR 合入后由 lead 统一安排 live-app 阶段补齐视觉证据并补跑 --slice 全量。"
    },
    "desktop.error-copy.USER_CANCELLED|mac|zh-TW|global": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "待集中批捕:lead 裁决(PR2a 派工包第 3 条,2026-07-20)——桌面取证受锁屏环境限制,不再做 restart 尝试;全部实现 PR 合入后由 lead 统一安排 live-app 阶段补齐视觉证据并补跑 --slice 全量。"
    },
    "desktop.error-copy.USER_CANCELLED|mac|en|cn": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "待集中批捕:lead 裁决(PR2a 派工包第 3 条,2026-07-20)——桌面取证受锁屏环境限制,不再做 restart 尝试;全部实现 PR 合入后由 lead 统一安排 live-app 阶段补齐视觉证据并补跑 --slice 全量。"
    },
    "desktop.error-copy.USER_CANCELLED|mac|en|global": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "待集中批捕:lead 裁决(PR2a 派工包第 3 条,2026-07-20)——桌面取证受锁屏环境限制,不再做 restart 尝试;全部实现 PR 合入后由 lead 统一安排 live-app 阶段补齐视觉证据并补跑 --slice 全量。"
    },
    "desktop.error-copy.USER_CANCELLED|mac|ja|cn": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "待集中批捕:lead 裁决(PR2a 派工包第 3 条,2026-07-20)——桌面取证受锁屏环境限制,不再做 restart 尝试;全部实现 PR 合入后由 lead 统一安排 live-app 阶段补齐视觉证据并补跑 --slice 全量。"
    },
    "desktop.error-copy.USER_CANCELLED|mac|ja|global": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "待集中批捕:lead 裁决(PR2a 派工包第 3 条,2026-07-20)——桌面取证受锁屏环境限制,不再做 restart 尝试;全部实现 PR 合入后由 lead 统一安排 live-app 阶段补齐视觉证据并补跑 --slice 全量。"
    },
    "desktop.error-copy.USER_CANCELLED|mac|ko|cn": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "待集中批捕:lead 裁决(PR2a 派工包第 3 条,2026-07-20)——桌面取证受锁屏环境限制,不再做 restart 尝试;全部实现 PR 合入后由 lead 统一安排 live-app 阶段补齐视觉证据并补跑 --slice 全量。"
    },
    "desktop.error-copy.USER_CANCELLED|mac|ko|global": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "待集中批捕:lead 裁决(PR2a 派工包第 3 条,2026-07-20)——桌面取证受锁屏环境限制,不再做 restart 尝试;全部实现 PR 合入后由 lead 统一安排 live-app 阶段补齐视觉证据并补跑 --slice 全量。"
    },
    "desktop.error-copy.USER_CANCELLED|windows|zh-CN|cn": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "待集中批捕:lead 裁决(PR2a 派工包第 3 条,2026-07-20)——桌面取证受锁屏环境限制,不再做 restart 尝试;全部实现 PR 合入后由 lead 统一安排 live-app 阶段补齐视觉证据并补跑 --slice 全量。"
    },
    "desktop.error-copy.USER_CANCELLED|windows|zh-CN|global": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "待集中批捕:lead 裁决(PR2a 派工包第 3 条,2026-07-20)——桌面取证受锁屏环境限制,不再做 restart 尝试;全部实现 PR 合入后由 lead 统一安排 live-app 阶段补齐视觉证据并补跑 --slice 全量。"
    },
    "desktop.error-copy.USER_CANCELLED|windows|zh-TW|cn": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "待集中批捕:lead 裁决(PR2a 派工包第 3 条,2026-07-20)——桌面取证受锁屏环境限制,不再做 restart 尝试;全部实现 PR 合入后由 lead 统一安排 live-app 阶段补齐视觉证据并补跑 --slice 全量。"
    },
    "desktop.error-copy.USER_CANCELLED|windows|zh-TW|global": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "待集中批捕:lead 裁决(PR2a 派工包第 3 条,2026-07-20)——桌面取证受锁屏环境限制,不再做 restart 尝试;全部实现 PR 合入后由 lead 统一安排 live-app 阶段补齐视觉证据并补跑 --slice 全量。"
    },
    "desktop.error-copy.USER_CANCELLED|windows|en|cn": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "待集中批捕:lead 裁决(PR2a 派工包第 3 条,2026-07-20)——桌面取证受锁屏环境限制,不再做 restart 尝试;全部实现 PR 合入后由 lead 统一安排 live-app 阶段补齐视觉证据并补跑 --slice 全量。"
    },
    "desktop.error-copy.USER_CANCELLED|windows|en|global": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "待集中批捕:lead 裁决(PR2a 派工包第 3 条,2026-07-20)——桌面取证受锁屏环境限制,不再做 restart 尝试;全部实现 PR 合入后由 lead 统一安排 live-app 阶段补齐视觉证据并补跑 --slice 全量。"
    },
    "desktop.error-copy.USER_CANCELLED|windows|ja|cn": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "待集中批捕:lead 裁决(PR2a 派工包第 3 条,2026-07-20)——桌面取证受锁屏环境限制,不再做 restart 尝试;全部实现 PR 合入后由 lead 统一安排 live-app 阶段补齐视觉证据并补跑 --slice 全量。"
    },
    "desktop.error-copy.USER_CANCELLED|windows|ja|global": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "待集中批捕:lead 裁决(PR2a 派工包第 3 条,2026-07-20)——桌面取证受锁屏环境限制,不再做 restart 尝试;全部实现 PR 合入后由 lead 统一安排 live-app 阶段补齐视觉证据并补跑 --slice 全量。"
    },
    "desktop.error-copy.USER_CANCELLED|windows|ko|cn": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "待集中批捕:lead 裁决(PR2a 派工包第 3 条,2026-07-20)——桌面取证受锁屏环境限制,不再做 restart 尝试;全部实现 PR 合入后由 lead 统一安排 live-app 阶段补齐视觉证据并补跑 --slice 全量。"
    },
    "desktop.error-copy.USER_CANCELLED|windows|ko|global": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "待集中批捕:lead 裁决(PR2a 派工包第 3 条,2026-07-20)——桌面取证受锁屏环境限制,不再做 restart 尝试;全部实现 PR 合入后由 lead 统一安排 live-app 阶段补齐视觉证据并补跑 --slice 全量。"
    },
    "desktop.error-copy.STATE_MISMATCH|mac|zh-CN|cn": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "待集中批捕:lead 裁决(PR2a 派工包第 3 条,2026-07-20)——桌面取证受锁屏环境限制,不再做 restart 尝试;全部实现 PR 合入后由 lead 统一安排 live-app 阶段补齐视觉证据并补跑 --slice 全量。"
    },
    "desktop.error-copy.STATE_MISMATCH|mac|zh-CN|global": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "待集中批捕:lead 裁决(PR2a 派工包第 3 条,2026-07-20)——桌面取证受锁屏环境限制,不再做 restart 尝试;全部实现 PR 合入后由 lead 统一安排 live-app 阶段补齐视觉证据并补跑 --slice 全量。"
    },
    "desktop.error-copy.STATE_MISMATCH|mac|zh-TW|cn": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "待集中批捕:lead 裁决(PR2a 派工包第 3 条,2026-07-20)——桌面取证受锁屏环境限制,不再做 restart 尝试;全部实现 PR 合入后由 lead 统一安排 live-app 阶段补齐视觉证据并补跑 --slice 全量。"
    },
    "desktop.error-copy.STATE_MISMATCH|mac|zh-TW|global": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "待集中批捕:lead 裁决(PR2a 派工包第 3 条,2026-07-20)——桌面取证受锁屏环境限制,不再做 restart 尝试;全部实现 PR 合入后由 lead 统一安排 live-app 阶段补齐视觉证据并补跑 --slice 全量。"
    },
    "desktop.error-copy.STATE_MISMATCH|mac|en|cn": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "待集中批捕:lead 裁决(PR2a 派工包第 3 条,2026-07-20)——桌面取证受锁屏环境限制,不再做 restart 尝试;全部实现 PR 合入后由 lead 统一安排 live-app 阶段补齐视觉证据并补跑 --slice 全量。"
    },
    "desktop.error-copy.STATE_MISMATCH|mac|en|global": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "待集中批捕:lead 裁决(PR2a 派工包第 3 条,2026-07-20)——桌面取证受锁屏环境限制,不再做 restart 尝试;全部实现 PR 合入后由 lead 统一安排 live-app 阶段补齐视觉证据并补跑 --slice 全量。"
    },
    "desktop.error-copy.STATE_MISMATCH|mac|ja|cn": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "待集中批捕:lead 裁决(PR2a 派工包第 3 条,2026-07-20)——桌面取证受锁屏环境限制,不再做 restart 尝试;全部实现 PR 合入后由 lead 统一安排 live-app 阶段补齐视觉证据并补跑 --slice 全量。"
    },
    "desktop.error-copy.STATE_MISMATCH|mac|ja|global": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "待集中批捕:lead 裁决(PR2a 派工包第 3 条,2026-07-20)——桌面取证受锁屏环境限制,不再做 restart 尝试;全部实现 PR 合入后由 lead 统一安排 live-app 阶段补齐视觉证据并补跑 --slice 全量。"
    },
    "desktop.error-copy.STATE_MISMATCH|mac|ko|cn": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "待集中批捕:lead 裁决(PR2a 派工包第 3 条,2026-07-20)——桌面取证受锁屏环境限制,不再做 restart 尝试;全部实现 PR 合入后由 lead 统一安排 live-app 阶段补齐视觉证据并补跑 --slice 全量。"
    },
    "desktop.error-copy.STATE_MISMATCH|mac|ko|global": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "待集中批捕:lead 裁决(PR2a 派工包第 3 条,2026-07-20)——桌面取证受锁屏环境限制,不再做 restart 尝试;全部实现 PR 合入后由 lead 统一安排 live-app 阶段补齐视觉证据并补跑 --slice 全量。"
    },
    "desktop.error-copy.STATE_MISMATCH|windows|zh-CN|cn": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "待集中批捕:lead 裁决(PR2a 派工包第 3 条,2026-07-20)——桌面取证受锁屏环境限制,不再做 restart 尝试;全部实现 PR 合入后由 lead 统一安排 live-app 阶段补齐视觉证据并补跑 --slice 全量。"
    },
    "desktop.error-copy.STATE_MISMATCH|windows|zh-CN|global": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "待集中批捕:lead 裁决(PR2a 派工包第 3 条,2026-07-20)——桌面取证受锁屏环境限制,不再做 restart 尝试;全部实现 PR 合入后由 lead 统一安排 live-app 阶段补齐视觉证据并补跑 --slice 全量。"
    },
    "desktop.error-copy.STATE_MISMATCH|windows|zh-TW|cn": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "待集中批捕:lead 裁决(PR2a 派工包第 3 条,2026-07-20)——桌面取证受锁屏环境限制,不再做 restart 尝试;全部实现 PR 合入后由 lead 统一安排 live-app 阶段补齐视觉证据并补跑 --slice 全量。"
    },
    "desktop.error-copy.STATE_MISMATCH|windows|zh-TW|global": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "待集中批捕:lead 裁决(PR2a 派工包第 3 条,2026-07-20)——桌面取证受锁屏环境限制,不再做 restart 尝试;全部实现 PR 合入后由 lead 统一安排 live-app 阶段补齐视觉证据并补跑 --slice 全量。"
    },
    "desktop.error-copy.STATE_MISMATCH|windows|en|cn": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "待集中批捕:lead 裁决(PR2a 派工包第 3 条,2026-07-20)——桌面取证受锁屏环境限制,不再做 restart 尝试;全部实现 PR 合入后由 lead 统一安排 live-app 阶段补齐视觉证据并补跑 --slice 全量。"
    },
    "desktop.error-copy.STATE_MISMATCH|windows|en|global": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "待集中批捕:lead 裁决(PR2a 派工包第 3 条,2026-07-20)——桌面取证受锁屏环境限制,不再做 restart 尝试;全部实现 PR 合入后由 lead 统一安排 live-app 阶段补齐视觉证据并补跑 --slice 全量。"
    },
    "desktop.error-copy.STATE_MISMATCH|windows|ja|cn": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "待集中批捕:lead 裁决(PR2a 派工包第 3 条,2026-07-20)——桌面取证受锁屏环境限制,不再做 restart 尝试;全部实现 PR 合入后由 lead 统一安排 live-app 阶段补齐视觉证据并补跑 --slice 全量。"
    },
    "desktop.error-copy.STATE_MISMATCH|windows|ja|global": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "待集中批捕:lead 裁决(PR2a 派工包第 3 条,2026-07-20)——桌面取证受锁屏环境限制,不再做 restart 尝试;全部实现 PR 合入后由 lead 统一安排 live-app 阶段补齐视觉证据并补跑 --slice 全量。"
    },
    "desktop.error-copy.STATE_MISMATCH|windows|ko|cn": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "待集中批捕:lead 裁决(PR2a 派工包第 3 条,2026-07-20)——桌面取证受锁屏环境限制,不再做 restart 尝试;全部实现 PR 合入后由 lead 统一安排 live-app 阶段补齐视觉证据并补跑 --slice 全量。"
    },
    "desktop.error-copy.STATE_MISMATCH|windows|ko|global": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "待集中批捕:lead 裁决(PR2a 派工包第 3 条,2026-07-20)——桌面取证受锁屏环境限制,不再做 restart 尝试;全部实现 PR 合入后由 lead 统一安排 live-app 阶段补齐视觉证据并补跑 --slice 全量。"
    },
    "desktop.error-copy.INVALID_AUTH_CODE|mac|zh-CN|cn": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "待集中批捕:lead 裁决(PR2a 派工包第 3 条,2026-07-20)——桌面取证受锁屏环境限制,不再做 restart 尝试;全部实现 PR 合入后由 lead 统一安排 live-app 阶段补齐视觉证据并补跑 --slice 全量。"
    },
    "desktop.error-copy.INVALID_AUTH_CODE|mac|zh-CN|global": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "待集中批捕:lead 裁决(PR2a 派工包第 3 条,2026-07-20)——桌面取证受锁屏环境限制,不再做 restart 尝试;全部实现 PR 合入后由 lead 统一安排 live-app 阶段补齐视觉证据并补跑 --slice 全量。"
    },
    "desktop.error-copy.INVALID_AUTH_CODE|mac|zh-TW|cn": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "待集中批捕:lead 裁决(PR2a 派工包第 3 条,2026-07-20)——桌面取证受锁屏环境限制,不再做 restart 尝试;全部实现 PR 合入后由 lead 统一安排 live-app 阶段补齐视觉证据并补跑 --slice 全量。"
    },
    "desktop.error-copy.INVALID_AUTH_CODE|mac|zh-TW|global": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "待集中批捕:lead 裁决(PR2a 派工包第 3 条,2026-07-20)——桌面取证受锁屏环境限制,不再做 restart 尝试;全部实现 PR 合入后由 lead 统一安排 live-app 阶段补齐视觉证据并补跑 --slice 全量。"
    },
    "desktop.error-copy.INVALID_AUTH_CODE|mac|en|cn": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "待集中批捕:lead 裁决(PR2a 派工包第 3 条,2026-07-20)——桌面取证受锁屏环境限制,不再做 restart 尝试;全部实现 PR 合入后由 lead 统一安排 live-app 阶段补齐视觉证据并补跑 --slice 全量。"
    },
    "desktop.error-copy.INVALID_AUTH_CODE|mac|en|global": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "待集中批捕:lead 裁决(PR2a 派工包第 3 条,2026-07-20)——桌面取证受锁屏环境限制,不再做 restart 尝试;全部实现 PR 合入后由 lead 统一安排 live-app 阶段补齐视觉证据并补跑 --slice 全量。"
    },
    "desktop.error-copy.INVALID_AUTH_CODE|mac|ja|cn": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "待集中批捕:lead 裁决(PR2a 派工包第 3 条,2026-07-20)——桌面取证受锁屏环境限制,不再做 restart 尝试;全部实现 PR 合入后由 lead 统一安排 live-app 阶段补齐视觉证据并补跑 --slice 全量。"
    },
    "desktop.error-copy.INVALID_AUTH_CODE|mac|ja|global": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "待集中批捕:lead 裁决(PR2a 派工包第 3 条,2026-07-20)——桌面取证受锁屏环境限制,不再做 restart 尝试;全部实现 PR 合入后由 lead 统一安排 live-app 阶段补齐视觉证据并补跑 --slice 全量。"
    },
    "desktop.error-copy.INVALID_AUTH_CODE|mac|ko|cn": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "待集中批捕:lead 裁决(PR2a 派工包第 3 条,2026-07-20)——桌面取证受锁屏环境限制,不再做 restart 尝试;全部实现 PR 合入后由 lead 统一安排 live-app 阶段补齐视觉证据并补跑 --slice 全量。"
    },
    "desktop.error-copy.INVALID_AUTH_CODE|mac|ko|global": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "待集中批捕:lead 裁决(PR2a 派工包第 3 条,2026-07-20)——桌面取证受锁屏环境限制,不再做 restart 尝试;全部实现 PR 合入后由 lead 统一安排 live-app 阶段补齐视觉证据并补跑 --slice 全量。"
    },
    "desktop.error-copy.INVALID_AUTH_CODE|windows|zh-CN|cn": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "待集中批捕:lead 裁决(PR2a 派工包第 3 条,2026-07-20)——桌面取证受锁屏环境限制,不再做 restart 尝试;全部实现 PR 合入后由 lead 统一安排 live-app 阶段补齐视觉证据并补跑 --slice 全量。"
    },
    "desktop.error-copy.INVALID_AUTH_CODE|windows|zh-CN|global": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "待集中批捕:lead 裁决(PR2a 派工包第 3 条,2026-07-20)——桌面取证受锁屏环境限制,不再做 restart 尝试;全部实现 PR 合入后由 lead 统一安排 live-app 阶段补齐视觉证据并补跑 --slice 全量。"
    },
    "desktop.error-copy.INVALID_AUTH_CODE|windows|zh-TW|cn": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "待集中批捕:lead 裁决(PR2a 派工包第 3 条,2026-07-20)——桌面取证受锁屏环境限制,不再做 restart 尝试;全部实现 PR 合入后由 lead 统一安排 live-app 阶段补齐视觉证据并补跑 --slice 全量。"
    },
    "desktop.error-copy.INVALID_AUTH_CODE|windows|zh-TW|global": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "待集中批捕:lead 裁决(PR2a 派工包第 3 条,2026-07-20)——桌面取证受锁屏环境限制,不再做 restart 尝试;全部实现 PR 合入后由 lead 统一安排 live-app 阶段补齐视觉证据并补跑 --slice 全量。"
    },
    "desktop.error-copy.INVALID_AUTH_CODE|windows|en|cn": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "待集中批捕:lead 裁决(PR2a 派工包第 3 条,2026-07-20)——桌面取证受锁屏环境限制,不再做 restart 尝试;全部实现 PR 合入后由 lead 统一安排 live-app 阶段补齐视觉证据并补跑 --slice 全量。"
    },
    "desktop.error-copy.INVALID_AUTH_CODE|windows|en|global": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "待集中批捕:lead 裁决(PR2a 派工包第 3 条,2026-07-20)——桌面取证受锁屏环境限制,不再做 restart 尝试;全部实现 PR 合入后由 lead 统一安排 live-app 阶段补齐视觉证据并补跑 --slice 全量。"
    },
    "desktop.error-copy.INVALID_AUTH_CODE|windows|ja|cn": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "待集中批捕:lead 裁决(PR2a 派工包第 3 条,2026-07-20)——桌面取证受锁屏环境限制,不再做 restart 尝试;全部实现 PR 合入后由 lead 统一安排 live-app 阶段补齐视觉证据并补跑 --slice 全量。"
    },
    "desktop.error-copy.INVALID_AUTH_CODE|windows|ja|global": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "待集中批捕:lead 裁决(PR2a 派工包第 3 条,2026-07-20)——桌面取证受锁屏环境限制,不再做 restart 尝试;全部实现 PR 合入后由 lead 统一安排 live-app 阶段补齐视觉证据并补跑 --slice 全量。"
    },
    "desktop.error-copy.INVALID_AUTH_CODE|windows|ko|cn": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "待集中批捕:lead 裁决(PR2a 派工包第 3 条,2026-07-20)——桌面取证受锁屏环境限制,不再做 restart 尝试;全部实现 PR 合入后由 lead 统一安排 live-app 阶段补齐视觉证据并补跑 --slice 全量。"
    },
    "desktop.error-copy.INVALID_AUTH_CODE|windows|ko|global": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "待集中批捕:lead 裁决(PR2a 派工包第 3 条,2026-07-20)——桌面取证受锁屏环境限制,不再做 restart 尝试;全部实现 PR 合入后由 lead 统一安排 live-app 阶段补齐视觉证据并补跑 --slice 全量。"
    },
    "desktop.error-copy.INVALID_LOGIN_TICKET|mac|zh-CN|cn": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "待集中批捕:lead 裁决(PR2a 派工包第 3 条,2026-07-20)——桌面取证受锁屏环境限制,不再做 restart 尝试;全部实现 PR 合入后由 lead 统一安排 live-app 阶段补齐视觉证据并补跑 --slice 全量。"
    },
    "desktop.error-copy.INVALID_LOGIN_TICKET|mac|zh-CN|global": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "待集中批捕:lead 裁决(PR2a 派工包第 3 条,2026-07-20)——桌面取证受锁屏环境限制,不再做 restart 尝试;全部实现 PR 合入后由 lead 统一安排 live-app 阶段补齐视觉证据并补跑 --slice 全量。"
    },
    "desktop.error-copy.INVALID_LOGIN_TICKET|mac|zh-TW|cn": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "待集中批捕:lead 裁决(PR2a 派工包第 3 条,2026-07-20)——桌面取证受锁屏环境限制,不再做 restart 尝试;全部实现 PR 合入后由 lead 统一安排 live-app 阶段补齐视觉证据并补跑 --slice 全量。"
    },
    "desktop.error-copy.INVALID_LOGIN_TICKET|mac|zh-TW|global": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "待集中批捕:lead 裁决(PR2a 派工包第 3 条,2026-07-20)——桌面取证受锁屏环境限制,不再做 restart 尝试;全部实现 PR 合入后由 lead 统一安排 live-app 阶段补齐视觉证据并补跑 --slice 全量。"
    },
    "desktop.error-copy.INVALID_LOGIN_TICKET|mac|en|cn": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "待集中批捕:lead 裁决(PR2a 派工包第 3 条,2026-07-20)——桌面取证受锁屏环境限制,不再做 restart 尝试;全部实现 PR 合入后由 lead 统一安排 live-app 阶段补齐视觉证据并补跑 --slice 全量。"
    },
    "desktop.error-copy.INVALID_LOGIN_TICKET|mac|en|global": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "待集中批捕:lead 裁决(PR2a 派工包第 3 条,2026-07-20)——桌面取证受锁屏环境限制,不再做 restart 尝试;全部实现 PR 合入后由 lead 统一安排 live-app 阶段补齐视觉证据并补跑 --slice 全量。"
    },
    "desktop.error-copy.INVALID_LOGIN_TICKET|mac|ja|cn": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "待集中批捕:lead 裁决(PR2a 派工包第 3 条,2026-07-20)——桌面取证受锁屏环境限制,不再做 restart 尝试;全部实现 PR 合入后由 lead 统一安排 live-app 阶段补齐视觉证据并补跑 --slice 全量。"
    },
    "desktop.error-copy.INVALID_LOGIN_TICKET|mac|ja|global": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "待集中批捕:lead 裁决(PR2a 派工包第 3 条,2026-07-20)——桌面取证受锁屏环境限制,不再做 restart 尝试;全部实现 PR 合入后由 lead 统一安排 live-app 阶段补齐视觉证据并补跑 --slice 全量。"
    },
    "desktop.error-copy.INVALID_LOGIN_TICKET|mac|ko|cn": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "待集中批捕:lead 裁决(PR2a 派工包第 3 条,2026-07-20)——桌面取证受锁屏环境限制,不再做 restart 尝试;全部实现 PR 合入后由 lead 统一安排 live-app 阶段补齐视觉证据并补跑 --slice 全量。"
    },
    "desktop.error-copy.INVALID_LOGIN_TICKET|mac|ko|global": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "待集中批捕:lead 裁决(PR2a 派工包第 3 条,2026-07-20)——桌面取证受锁屏环境限制,不再做 restart 尝试;全部实现 PR 合入后由 lead 统一安排 live-app 阶段补齐视觉证据并补跑 --slice 全量。"
    },
    "desktop.error-copy.INVALID_LOGIN_TICKET|windows|zh-CN|cn": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "待集中批捕:lead 裁决(PR2a 派工包第 3 条,2026-07-20)——桌面取证受锁屏环境限制,不再做 restart 尝试;全部实现 PR 合入后由 lead 统一安排 live-app 阶段补齐视觉证据并补跑 --slice 全量。"
    },
    "desktop.error-copy.INVALID_LOGIN_TICKET|windows|zh-CN|global": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "待集中批捕:lead 裁决(PR2a 派工包第 3 条,2026-07-20)——桌面取证受锁屏环境限制,不再做 restart 尝试;全部实现 PR 合入后由 lead 统一安排 live-app 阶段补齐视觉证据并补跑 --slice 全量。"
    },
    "desktop.error-copy.INVALID_LOGIN_TICKET|windows|zh-TW|cn": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "待集中批捕:lead 裁决(PR2a 派工包第 3 条,2026-07-20)——桌面取证受锁屏环境限制,不再做 restart 尝试;全部实现 PR 合入后由 lead 统一安排 live-app 阶段补齐视觉证据并补跑 --slice 全量。"
    },
    "desktop.error-copy.INVALID_LOGIN_TICKET|windows|zh-TW|global": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "待集中批捕:lead 裁决(PR2a 派工包第 3 条,2026-07-20)——桌面取证受锁屏环境限制,不再做 restart 尝试;全部实现 PR 合入后由 lead 统一安排 live-app 阶段补齐视觉证据并补跑 --slice 全量。"
    },
    "desktop.error-copy.INVALID_LOGIN_TICKET|windows|en|cn": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "待集中批捕:lead 裁决(PR2a 派工包第 3 条,2026-07-20)——桌面取证受锁屏环境限制,不再做 restart 尝试;全部实现 PR 合入后由 lead 统一安排 live-app 阶段补齐视觉证据并补跑 --slice 全量。"
    },
    "desktop.error-copy.INVALID_LOGIN_TICKET|windows|en|global": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "待集中批捕:lead 裁决(PR2a 派工包第 3 条,2026-07-20)——桌面取证受锁屏环境限制,不再做 restart 尝试;全部实现 PR 合入后由 lead 统一安排 live-app 阶段补齐视觉证据并补跑 --slice 全量。"
    },
    "desktop.error-copy.INVALID_LOGIN_TICKET|windows|ja|cn": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "待集中批捕:lead 裁决(PR2a 派工包第 3 条,2026-07-20)——桌面取证受锁屏环境限制,不再做 restart 尝试;全部实现 PR 合入后由 lead 统一安排 live-app 阶段补齐视觉证据并补跑 --slice 全量。"
    },
    "desktop.error-copy.INVALID_LOGIN_TICKET|windows|ja|global": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "待集中批捕:lead 裁决(PR2a 派工包第 3 条,2026-07-20)——桌面取证受锁屏环境限制,不再做 restart 尝试;全部实现 PR 合入后由 lead 统一安排 live-app 阶段补齐视觉证据并补跑 --slice 全量。"
    },
    "desktop.error-copy.INVALID_LOGIN_TICKET|windows|ko|cn": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "待集中批捕:lead 裁决(PR2a 派工包第 3 条,2026-07-20)——桌面取证受锁屏环境限制,不再做 restart 尝试;全部实现 PR 合入后由 lead 统一安排 live-app 阶段补齐视觉证据并补跑 --slice 全量。"
    },
    "desktop.error-copy.INVALID_LOGIN_TICKET|windows|ko|global": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "待集中批捕:lead 裁决(PR2a 派工包第 3 条,2026-07-20)——桌面取证受锁屏环境限制,不再做 restart 尝试;全部实现 PR 合入后由 lead 统一安排 live-app 阶段补齐视觉证据并补跑 --slice 全量。"
    },
    "desktop.error-copy.INVALID_BIND_TICKET|mac|zh-CN|cn": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "待集中批捕:lead 裁决(PR2a 派工包第 3 条,2026-07-20)——桌面取证受锁屏环境限制,不再做 restart 尝试;全部实现 PR 合入后由 lead 统一安排 live-app 阶段补齐视觉证据并补跑 --slice 全量。"
    },
    "desktop.error-copy.INVALID_BIND_TICKET|mac|zh-CN|global": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "待集中批捕:lead 裁决(PR2a 派工包第 3 条,2026-07-20)——桌面取证受锁屏环境限制,不再做 restart 尝试;全部实现 PR 合入后由 lead 统一安排 live-app 阶段补齐视觉证据并补跑 --slice 全量。"
    },
    "desktop.error-copy.INVALID_BIND_TICKET|mac|zh-TW|cn": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "待集中批捕:lead 裁决(PR2a 派工包第 3 条,2026-07-20)——桌面取证受锁屏环境限制,不再做 restart 尝试;全部实现 PR 合入后由 lead 统一安排 live-app 阶段补齐视觉证据并补跑 --slice 全量。"
    },
    "desktop.error-copy.INVALID_BIND_TICKET|mac|zh-TW|global": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "待集中批捕:lead 裁决(PR2a 派工包第 3 条,2026-07-20)——桌面取证受锁屏环境限制,不再做 restart 尝试;全部实现 PR 合入后由 lead 统一安排 live-app 阶段补齐视觉证据并补跑 --slice 全量。"
    },
    "desktop.error-copy.INVALID_BIND_TICKET|mac|en|cn": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "待集中批捕:lead 裁决(PR2a 派工包第 3 条,2026-07-20)——桌面取证受锁屏环境限制,不再做 restart 尝试;全部实现 PR 合入后由 lead 统一安排 live-app 阶段补齐视觉证据并补跑 --slice 全量。"
    },
    "desktop.error-copy.INVALID_BIND_TICKET|mac|en|global": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "待集中批捕:lead 裁决(PR2a 派工包第 3 条,2026-07-20)——桌面取证受锁屏环境限制,不再做 restart 尝试;全部实现 PR 合入后由 lead 统一安排 live-app 阶段补齐视觉证据并补跑 --slice 全量。"
    },
    "desktop.error-copy.INVALID_BIND_TICKET|mac|ja|cn": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "待集中批捕:lead 裁决(PR2a 派工包第 3 条,2026-07-20)——桌面取证受锁屏环境限制,不再做 restart 尝试;全部实现 PR 合入后由 lead 统一安排 live-app 阶段补齐视觉证据并补跑 --slice 全量。"
    },
    "desktop.error-copy.INVALID_BIND_TICKET|mac|ja|global": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "待集中批捕:lead 裁决(PR2a 派工包第 3 条,2026-07-20)——桌面取证受锁屏环境限制,不再做 restart 尝试;全部实现 PR 合入后由 lead 统一安排 live-app 阶段补齐视觉证据并补跑 --slice 全量。"
    },
    "desktop.error-copy.INVALID_BIND_TICKET|mac|ko|cn": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "待集中批捕:lead 裁决(PR2a 派工包第 3 条,2026-07-20)——桌面取证受锁屏环境限制,不再做 restart 尝试;全部实现 PR 合入后由 lead 统一安排 live-app 阶段补齐视觉证据并补跑 --slice 全量。"
    },
    "desktop.error-copy.INVALID_BIND_TICKET|mac|ko|global": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "待集中批捕:lead 裁决(PR2a 派工包第 3 条,2026-07-20)——桌面取证受锁屏环境限制,不再做 restart 尝试;全部实现 PR 合入后由 lead 统一安排 live-app 阶段补齐视觉证据并补跑 --slice 全量。"
    },
    "desktop.error-copy.INVALID_BIND_TICKET|windows|zh-CN|cn": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "待集中批捕:lead 裁决(PR2a 派工包第 3 条,2026-07-20)——桌面取证受锁屏环境限制,不再做 restart 尝试;全部实现 PR 合入后由 lead 统一安排 live-app 阶段补齐视觉证据并补跑 --slice 全量。"
    },
    "desktop.error-copy.INVALID_BIND_TICKET|windows|zh-CN|global": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "待集中批捕:lead 裁决(PR2a 派工包第 3 条,2026-07-20)——桌面取证受锁屏环境限制,不再做 restart 尝试;全部实现 PR 合入后由 lead 统一安排 live-app 阶段补齐视觉证据并补跑 --slice 全量。"
    },
    "desktop.error-copy.INVALID_BIND_TICKET|windows|zh-TW|cn": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "待集中批捕:lead 裁决(PR2a 派工包第 3 条,2026-07-20)——桌面取证受锁屏环境限制,不再做 restart 尝试;全部实现 PR 合入后由 lead 统一安排 live-app 阶段补齐视觉证据并补跑 --slice 全量。"
    },
    "desktop.error-copy.INVALID_BIND_TICKET|windows|zh-TW|global": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "待集中批捕:lead 裁决(PR2a 派工包第 3 条,2026-07-20)——桌面取证受锁屏环境限制,不再做 restart 尝试;全部实现 PR 合入后由 lead 统一安排 live-app 阶段补齐视觉证据并补跑 --slice 全量。"
    },
    "desktop.error-copy.INVALID_BIND_TICKET|windows|en|cn": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "待集中批捕:lead 裁决(PR2a 派工包第 3 条,2026-07-20)——桌面取证受锁屏环境限制,不再做 restart 尝试;全部实现 PR 合入后由 lead 统一安排 live-app 阶段补齐视觉证据并补跑 --slice 全量。"
    },
    "desktop.error-copy.INVALID_BIND_TICKET|windows|en|global": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "待集中批捕:lead 裁决(PR2a 派工包第 3 条,2026-07-20)——桌面取证受锁屏环境限制,不再做 restart 尝试;全部实现 PR 合入后由 lead 统一安排 live-app 阶段补齐视觉证据并补跑 --slice 全量。"
    },
    "desktop.error-copy.INVALID_BIND_TICKET|windows|ja|cn": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "待集中批捕:lead 裁决(PR2a 派工包第 3 条,2026-07-20)——桌面取证受锁屏环境限制,不再做 restart 尝试;全部实现 PR 合入后由 lead 统一安排 live-app 阶段补齐视觉证据并补跑 --slice 全量。"
    },
    "desktop.error-copy.INVALID_BIND_TICKET|windows|ja|global": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "待集中批捕:lead 裁决(PR2a 派工包第 3 条,2026-07-20)——桌面取证受锁屏环境限制,不再做 restart 尝试;全部实现 PR 合入后由 lead 统一安排 live-app 阶段补齐视觉证据并补跑 --slice 全量。"
    },
    "desktop.error-copy.INVALID_BIND_TICKET|windows|ko|cn": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "待集中批捕:lead 裁决(PR2a 派工包第 3 条,2026-07-20)——桌面取证受锁屏环境限制,不再做 restart 尝试;全部实现 PR 合入后由 lead 统一安排 live-app 阶段补齐视觉证据并补跑 --slice 全量。"
    },
    "desktop.error-copy.INVALID_BIND_TICKET|windows|ko|global": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "待集中批捕:lead 裁决(PR2a 派工包第 3 条,2026-07-20)——桌面取证受锁屏环境限制,不再做 restart 尝试;全部实现 PR 合入后由 lead 统一安排 live-app 阶段补齐视觉证据并补跑 --slice 全量。"
    },
    "desktop.error-copy.REGION_MISMATCH|mac|zh-CN|cn": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "待集中批捕:lead 裁决(PR2a 派工包第 3 条,2026-07-20)——桌面取证受锁屏环境限制,不再做 restart 尝试;全部实现 PR 合入后由 lead 统一安排 live-app 阶段补齐视觉证据并补跑 --slice 全量。"
    },
    "desktop.error-copy.REGION_MISMATCH|mac|zh-CN|global": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "待集中批捕:lead 裁决(PR2a 派工包第 3 条,2026-07-20)——桌面取证受锁屏环境限制,不再做 restart 尝试;全部实现 PR 合入后由 lead 统一安排 live-app 阶段补齐视觉证据并补跑 --slice 全量。"
    },
    "desktop.error-copy.REGION_MISMATCH|mac|zh-TW|cn": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "待集中批捕:lead 裁决(PR2a 派工包第 3 条,2026-07-20)——桌面取证受锁屏环境限制,不再做 restart 尝试;全部实现 PR 合入后由 lead 统一安排 live-app 阶段补齐视觉证据并补跑 --slice 全量。"
    },
    "desktop.error-copy.REGION_MISMATCH|mac|zh-TW|global": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "待集中批捕:lead 裁决(PR2a 派工包第 3 条,2026-07-20)——桌面取证受锁屏环境限制,不再做 restart 尝试;全部实现 PR 合入后由 lead 统一安排 live-app 阶段补齐视觉证据并补跑 --slice 全量。"
    },
    "desktop.error-copy.REGION_MISMATCH|mac|en|cn": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "待集中批捕:lead 裁决(PR2a 派工包第 3 条,2026-07-20)——桌面取证受锁屏环境限制,不再做 restart 尝试;全部实现 PR 合入后由 lead 统一安排 live-app 阶段补齐视觉证据并补跑 --slice 全量。"
    },
    "desktop.error-copy.REGION_MISMATCH|mac|en|global": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "待集中批捕:lead 裁决(PR2a 派工包第 3 条,2026-07-20)——桌面取证受锁屏环境限制,不再做 restart 尝试;全部实现 PR 合入后由 lead 统一安排 live-app 阶段补齐视觉证据并补跑 --slice 全量。"
    },
    "desktop.error-copy.REGION_MISMATCH|mac|ja|cn": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "待集中批捕:lead 裁决(PR2a 派工包第 3 条,2026-07-20)——桌面取证受锁屏环境限制,不再做 restart 尝试;全部实现 PR 合入后由 lead 统一安排 live-app 阶段补齐视觉证据并补跑 --slice 全量。"
    },
    "desktop.error-copy.REGION_MISMATCH|mac|ja|global": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "待集中批捕:lead 裁决(PR2a 派工包第 3 条,2026-07-20)——桌面取证受锁屏环境限制,不再做 restart 尝试;全部实现 PR 合入后由 lead 统一安排 live-app 阶段补齐视觉证据并补跑 --slice 全量。"
    },
    "desktop.error-copy.REGION_MISMATCH|mac|ko|cn": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "待集中批捕:lead 裁决(PR2a 派工包第 3 条,2026-07-20)——桌面取证受锁屏环境限制,不再做 restart 尝试;全部实现 PR 合入后由 lead 统一安排 live-app 阶段补齐视觉证据并补跑 --slice 全量。"
    },
    "desktop.error-copy.REGION_MISMATCH|mac|ko|global": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "待集中批捕:lead 裁决(PR2a 派工包第 3 条,2026-07-20)——桌面取证受锁屏环境限制,不再做 restart 尝试;全部实现 PR 合入后由 lead 统一安排 live-app 阶段补齐视觉证据并补跑 --slice 全量。"
    },
    "desktop.error-copy.REGION_MISMATCH|windows|zh-CN|cn": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "待集中批捕:lead 裁决(PR2a 派工包第 3 条,2026-07-20)——桌面取证受锁屏环境限制,不再做 restart 尝试;全部实现 PR 合入后由 lead 统一安排 live-app 阶段补齐视觉证据并补跑 --slice 全量。"
    },
    "desktop.error-copy.REGION_MISMATCH|windows|zh-CN|global": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "待集中批捕:lead 裁决(PR2a 派工包第 3 条,2026-07-20)——桌面取证受锁屏环境限制,不再做 restart 尝试;全部实现 PR 合入后由 lead 统一安排 live-app 阶段补齐视觉证据并补跑 --slice 全量。"
    },
    "desktop.error-copy.REGION_MISMATCH|windows|zh-TW|cn": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "待集中批捕:lead 裁决(PR2a 派工包第 3 条,2026-07-20)——桌面取证受锁屏环境限制,不再做 restart 尝试;全部实现 PR 合入后由 lead 统一安排 live-app 阶段补齐视觉证据并补跑 --slice 全量。"
    },
    "desktop.error-copy.REGION_MISMATCH|windows|zh-TW|global": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "待集中批捕:lead 裁决(PR2a 派工包第 3 条,2026-07-20)——桌面取证受锁屏环境限制,不再做 restart 尝试;全部实现 PR 合入后由 lead 统一安排 live-app 阶段补齐视觉证据并补跑 --slice 全量。"
    },
    "desktop.error-copy.REGION_MISMATCH|windows|en|cn": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "待集中批捕:lead 裁决(PR2a 派工包第 3 条,2026-07-20)——桌面取证受锁屏环境限制,不再做 restart 尝试;全部实现 PR 合入后由 lead 统一安排 live-app 阶段补齐视觉证据并补跑 --slice 全量。"
    },
    "desktop.error-copy.REGION_MISMATCH|windows|en|global": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "待集中批捕:lead 裁决(PR2a 派工包第 3 条,2026-07-20)——桌面取证受锁屏环境限制,不再做 restart 尝试;全部实现 PR 合入后由 lead 统一安排 live-app 阶段补齐视觉证据并补跑 --slice 全量。"
    },
    "desktop.error-copy.REGION_MISMATCH|windows|ja|cn": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "待集中批捕:lead 裁决(PR2a 派工包第 3 条,2026-07-20)——桌面取证受锁屏环境限制,不再做 restart 尝试;全部实现 PR 合入后由 lead 统一安排 live-app 阶段补齐视觉证据并补跑 --slice 全量。"
    },
    "desktop.error-copy.REGION_MISMATCH|windows|ja|global": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "待集中批捕:lead 裁决(PR2a 派工包第 3 条,2026-07-20)——桌面取证受锁屏环境限制,不再做 restart 尝试;全部实现 PR 合入后由 lead 统一安排 live-app 阶段补齐视觉证据并补跑 --slice 全量。"
    },
    "desktop.error-copy.REGION_MISMATCH|windows|ko|cn": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "待集中批捕:lead 裁决(PR2a 派工包第 3 条,2026-07-20)——桌面取证受锁屏环境限制,不再做 restart 尝试;全部实现 PR 合入后由 lead 统一安排 live-app 阶段补齐视觉证据并补跑 --slice 全量。"
    },
    "desktop.error-copy.REGION_MISMATCH|windows|ko|global": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "待集中批捕:lead 裁决(PR2a 派工包第 3 条,2026-07-20)——桌面取证受锁屏环境限制,不再做 restart 尝试;全部实现 PR 合入后由 lead 统一安排 live-app 阶段补齐视觉证据并补跑 --slice 全量。"
    },
    "desktop.error-copy.UNKNOWN_CODE|mac|zh-CN|cn": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "待集中批捕:lead 裁决(PR2a 派工包第 3 条,2026-07-20)——桌面取证受锁屏环境限制,不再做 restart 尝试;全部实现 PR 合入后由 lead 统一安排 live-app 阶段补齐视觉证据并补跑 --slice 全量。"
    },
    "desktop.error-copy.UNKNOWN_CODE|mac|zh-CN|global": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "待集中批捕:lead 裁决(PR2a 派工包第 3 条,2026-07-20)——桌面取证受锁屏环境限制,不再做 restart 尝试;全部实现 PR 合入后由 lead 统一安排 live-app 阶段补齐视觉证据并补跑 --slice 全量。"
    },
    "desktop.error-copy.UNKNOWN_CODE|mac|zh-TW|cn": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "待集中批捕:lead 裁决(PR2a 派工包第 3 条,2026-07-20)——桌面取证受锁屏环境限制,不再做 restart 尝试;全部实现 PR 合入后由 lead 统一安排 live-app 阶段补齐视觉证据并补跑 --slice 全量。"
    },
    "desktop.error-copy.UNKNOWN_CODE|mac|zh-TW|global": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "待集中批捕:lead 裁决(PR2a 派工包第 3 条,2026-07-20)——桌面取证受锁屏环境限制,不再做 restart 尝试;全部实现 PR 合入后由 lead 统一安排 live-app 阶段补齐视觉证据并补跑 --slice 全量。"
    },
    "desktop.error-copy.UNKNOWN_CODE|mac|en|cn": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "待集中批捕:lead 裁决(PR2a 派工包第 3 条,2026-07-20)——桌面取证受锁屏环境限制,不再做 restart 尝试;全部实现 PR 合入后由 lead 统一安排 live-app 阶段补齐视觉证据并补跑 --slice 全量。"
    },
    "desktop.error-copy.UNKNOWN_CODE|mac|en|global": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "待集中批捕:lead 裁决(PR2a 派工包第 3 条,2026-07-20)——桌面取证受锁屏环境限制,不再做 restart 尝试;全部实现 PR 合入后由 lead 统一安排 live-app 阶段补齐视觉证据并补跑 --slice 全量。"
    },
    "desktop.error-copy.UNKNOWN_CODE|mac|ja|cn": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "待集中批捕:lead 裁决(PR2a 派工包第 3 条,2026-07-20)——桌面取证受锁屏环境限制,不再做 restart 尝试;全部实现 PR 合入后由 lead 统一安排 live-app 阶段补齐视觉证据并补跑 --slice 全量。"
    },
    "desktop.error-copy.UNKNOWN_CODE|mac|ja|global": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "待集中批捕:lead 裁决(PR2a 派工包第 3 条,2026-07-20)——桌面取证受锁屏环境限制,不再做 restart 尝试;全部实现 PR 合入后由 lead 统一安排 live-app 阶段补齐视觉证据并补跑 --slice 全量。"
    },
    "desktop.error-copy.UNKNOWN_CODE|mac|ko|cn": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "待集中批捕:lead 裁决(PR2a 派工包第 3 条,2026-07-20)——桌面取证受锁屏环境限制,不再做 restart 尝试;全部实现 PR 合入后由 lead 统一安排 live-app 阶段补齐视觉证据并补跑 --slice 全量。"
    },
    "desktop.error-copy.UNKNOWN_CODE|mac|ko|global": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "待集中批捕:lead 裁决(PR2a 派工包第 3 条,2026-07-20)——桌面取证受锁屏环境限制,不再做 restart 尝试;全部实现 PR 合入后由 lead 统一安排 live-app 阶段补齐视觉证据并补跑 --slice 全量。"
    },
    "desktop.error-copy.UNKNOWN_CODE|windows|zh-CN|cn": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "待集中批捕:lead 裁决(PR2a 派工包第 3 条,2026-07-20)——桌面取证受锁屏环境限制,不再做 restart 尝试;全部实现 PR 合入后由 lead 统一安排 live-app 阶段补齐视觉证据并补跑 --slice 全量。"
    },
    "desktop.error-copy.UNKNOWN_CODE|windows|zh-CN|global": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "待集中批捕:lead 裁决(PR2a 派工包第 3 条,2026-07-20)——桌面取证受锁屏环境限制,不再做 restart 尝试;全部实现 PR 合入后由 lead 统一安排 live-app 阶段补齐视觉证据并补跑 --slice 全量。"
    },
    "desktop.error-copy.UNKNOWN_CODE|windows|zh-TW|cn": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "待集中批捕:lead 裁决(PR2a 派工包第 3 条,2026-07-20)——桌面取证受锁屏环境限制,不再做 restart 尝试;全部实现 PR 合入后由 lead 统一安排 live-app 阶段补齐视觉证据并补跑 --slice 全量。"
    },
    "desktop.error-copy.UNKNOWN_CODE|windows|zh-TW|global": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "待集中批捕:lead 裁决(PR2a 派工包第 3 条,2026-07-20)——桌面取证受锁屏环境限制,不再做 restart 尝试;全部实现 PR 合入后由 lead 统一安排 live-app 阶段补齐视觉证据并补跑 --slice 全量。"
    },
    "desktop.error-copy.UNKNOWN_CODE|windows|en|cn": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "待集中批捕:lead 裁决(PR2a 派工包第 3 条,2026-07-20)——桌面取证受锁屏环境限制,不再做 restart 尝试;全部实现 PR 合入后由 lead 统一安排 live-app 阶段补齐视觉证据并补跑 --slice 全量。"
    },
    "desktop.error-copy.UNKNOWN_CODE|windows|en|global": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "待集中批捕:lead 裁决(PR2a 派工包第 3 条,2026-07-20)——桌面取证受锁屏环境限制,不再做 restart 尝试;全部实现 PR 合入后由 lead 统一安排 live-app 阶段补齐视觉证据并补跑 --slice 全量。"
    },
    "desktop.error-copy.UNKNOWN_CODE|windows|ja|cn": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "待集中批捕:lead 裁决(PR2a 派工包第 3 条,2026-07-20)——桌面取证受锁屏环境限制,不再做 restart 尝试;全部实现 PR 合入后由 lead 统一安排 live-app 阶段补齐视觉证据并补跑 --slice 全量。"
    },
    "desktop.error-copy.UNKNOWN_CODE|windows|ja|global": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "待集中批捕:lead 裁决(PR2a 派工包第 3 条,2026-07-20)——桌面取证受锁屏环境限制,不再做 restart 尝试;全部实现 PR 合入后由 lead 统一安排 live-app 阶段补齐视觉证据并补跑 --slice 全量。"
    },
    "desktop.error-copy.UNKNOWN_CODE|windows|ko|cn": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "待集中批捕:lead 裁决(PR2a 派工包第 3 条,2026-07-20)——桌面取证受锁屏环境限制,不再做 restart 尝试;全部实现 PR 合入后由 lead 统一安排 live-app 阶段补齐视觉证据并补跑 --slice 全量。"
    },
    "desktop.error-copy.UNKNOWN_CODE|windows|ko|global": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "待集中批捕:lead 裁决(PR2a 派工包第 3 条,2026-07-20)——桌面取证受锁屏环境限制,不再做 restart 尝试;全部实现 PR 合入后由 lead 统一安排 live-app 阶段补齐视觉证据并补跑 --slice 全量。"
    },
    "desktop.error-copy.LOGIN_BUSY|mac|zh-CN|cn": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "待集中批捕:lead 裁决(PR2a 派工包第 3 条,2026-07-20)——桌面取证受锁屏环境限制,不再做 restart 尝试;全部实现 PR 合入后由 lead 统一安排 live-app 阶段补齐视觉证据并补跑 --slice 全量。"
    },
    "desktop.error-copy.LOGIN_BUSY|mac|zh-CN|global": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "待集中批捕:lead 裁决(PR2a 派工包第 3 条,2026-07-20)——桌面取证受锁屏环境限制,不再做 restart 尝试;全部实现 PR 合入后由 lead 统一安排 live-app 阶段补齐视觉证据并补跑 --slice 全量。"
    },
    "desktop.error-copy.LOGIN_BUSY|mac|zh-TW|cn": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "待集中批捕:lead 裁决(PR2a 派工包第 3 条,2026-07-20)——桌面取证受锁屏环境限制,不再做 restart 尝试;全部实现 PR 合入后由 lead 统一安排 live-app 阶段补齐视觉证据并补跑 --slice 全量。"
    },
    "desktop.error-copy.LOGIN_BUSY|mac|zh-TW|global": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "待集中批捕:lead 裁决(PR2a 派工包第 3 条,2026-07-20)——桌面取证受锁屏环境限制,不再做 restart 尝试;全部实现 PR 合入后由 lead 统一安排 live-app 阶段补齐视觉证据并补跑 --slice 全量。"
    },
    "desktop.error-copy.LOGIN_BUSY|mac|en|cn": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "待集中批捕:lead 裁决(PR2a 派工包第 3 条,2026-07-20)——桌面取证受锁屏环境限制,不再做 restart 尝试;全部实现 PR 合入后由 lead 统一安排 live-app 阶段补齐视觉证据并补跑 --slice 全量。"
    },
    "desktop.error-copy.LOGIN_BUSY|mac|en|global": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "待集中批捕:lead 裁决(PR2a 派工包第 3 条,2026-07-20)——桌面取证受锁屏环境限制,不再做 restart 尝试;全部实现 PR 合入后由 lead 统一安排 live-app 阶段补齐视觉证据并补跑 --slice 全量。"
    },
    "desktop.error-copy.LOGIN_BUSY|mac|ja|cn": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "待集中批捕:lead 裁决(PR2a 派工包第 3 条,2026-07-20)——桌面取证受锁屏环境限制,不再做 restart 尝试;全部实现 PR 合入后由 lead 统一安排 live-app 阶段补齐视觉证据并补跑 --slice 全量。"
    },
    "desktop.error-copy.LOGIN_BUSY|mac|ja|global": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "待集中批捕:lead 裁决(PR2a 派工包第 3 条,2026-07-20)——桌面取证受锁屏环境限制,不再做 restart 尝试;全部实现 PR 合入后由 lead 统一安排 live-app 阶段补齐视觉证据并补跑 --slice 全量。"
    },
    "desktop.error-copy.LOGIN_BUSY|mac|ko|cn": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "待集中批捕:lead 裁决(PR2a 派工包第 3 条,2026-07-20)——桌面取证受锁屏环境限制,不再做 restart 尝试;全部实现 PR 合入后由 lead 统一安排 live-app 阶段补齐视觉证据并补跑 --slice 全量。"
    },
    "desktop.error-copy.LOGIN_BUSY|mac|ko|global": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "待集中批捕:lead 裁决(PR2a 派工包第 3 条,2026-07-20)——桌面取证受锁屏环境限制,不再做 restart 尝试;全部实现 PR 合入后由 lead 统一安排 live-app 阶段补齐视觉证据并补跑 --slice 全量。"
    },
    "desktop.error-copy.LOGIN_BUSY|windows|zh-CN|cn": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "待集中批捕:lead 裁决(PR2a 派工包第 3 条,2026-07-20)——桌面取证受锁屏环境限制,不再做 restart 尝试;全部实现 PR 合入后由 lead 统一安排 live-app 阶段补齐视觉证据并补跑 --slice 全量。"
    },
    "desktop.error-copy.LOGIN_BUSY|windows|zh-CN|global": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "待集中批捕:lead 裁决(PR2a 派工包第 3 条,2026-07-20)——桌面取证受锁屏环境限制,不再做 restart 尝试;全部实现 PR 合入后由 lead 统一安排 live-app 阶段补齐视觉证据并补跑 --slice 全量。"
    },
    "desktop.error-copy.LOGIN_BUSY|windows|zh-TW|cn": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "待集中批捕:lead 裁决(PR2a 派工包第 3 条,2026-07-20)——桌面取证受锁屏环境限制,不再做 restart 尝试;全部实现 PR 合入后由 lead 统一安排 live-app 阶段补齐视觉证据并补跑 --slice 全量。"
    },
    "desktop.error-copy.LOGIN_BUSY|windows|zh-TW|global": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "待集中批捕:lead 裁决(PR2a 派工包第 3 条,2026-07-20)——桌面取证受锁屏环境限制,不再做 restart 尝试;全部实现 PR 合入后由 lead 统一安排 live-app 阶段补齐视觉证据并补跑 --slice 全量。"
    },
    "desktop.error-copy.LOGIN_BUSY|windows|en|cn": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "待集中批捕:lead 裁决(PR2a 派工包第 3 条,2026-07-20)——桌面取证受锁屏环境限制,不再做 restart 尝试;全部实现 PR 合入后由 lead 统一安排 live-app 阶段补齐视觉证据并补跑 --slice 全量。"
    },
    "desktop.error-copy.LOGIN_BUSY|windows|en|global": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "待集中批捕:lead 裁决(PR2a 派工包第 3 条,2026-07-20)——桌面取证受锁屏环境限制,不再做 restart 尝试;全部实现 PR 合入后由 lead 统一安排 live-app 阶段补齐视觉证据并补跑 --slice 全量。"
    },
    "desktop.error-copy.LOGIN_BUSY|windows|ja|cn": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "待集中批捕:lead 裁决(PR2a 派工包第 3 条,2026-07-20)——桌面取证受锁屏环境限制,不再做 restart 尝试;全部实现 PR 合入后由 lead 统一安排 live-app 阶段补齐视觉证据并补跑 --slice 全量。"
    },
    "desktop.error-copy.LOGIN_BUSY|windows|ja|global": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "待集中批捕:lead 裁决(PR2a 派工包第 3 条,2026-07-20)——桌面取证受锁屏环境限制,不再做 restart 尝试;全部实现 PR 合入后由 lead 统一安排 live-app 阶段补齐视觉证据并补跑 --slice 全量。"
    },
    "desktop.error-copy.LOGIN_BUSY|windows|ko|cn": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "待集中批捕:lead 裁决(PR2a 派工包第 3 条,2026-07-20)——桌面取证受锁屏环境限制,不再做 restart 尝试;全部实现 PR 合入后由 lead 统一安排 live-app 阶段补齐视觉证据并补跑 --slice 全量。"
    },
    "desktop.error-copy.LOGIN_BUSY|windows|ko|global": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "待集中批捕:lead 裁决(PR2a 派工包第 3 条,2026-07-20)——桌面取证受锁屏环境限制,不再做 restart 尝试;全部实现 PR 合入后由 lead 统一安排 live-app 阶段补齐视觉证据并补跑 --slice 全量。"
    },
    "mobile.brand-background.style|iphone|zh-CN|cn": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "PR4a 派工包集中批捕预案:合并门=--preview-slice 无 schema 错误;全格实拍证据由后续验收批次(双 AI 验收/QA)补录,--final 前必须清零"
    },
    "mobile.brand-background.style|iphone|zh-CN|global": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "PR4a 派工包集中批捕预案:合并门=--preview-slice 无 schema 错误;全格实拍证据由后续验收批次(双 AI 验收/QA)补录,--final 前必须清零"
    },
    "mobile.brand-background.style|iphone|zh-TW|cn": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "PR4a 派工包集中批捕预案:合并门=--preview-slice 无 schema 错误;全格实拍证据由后续验收批次(双 AI 验收/QA)补录,--final 前必须清零"
    },
    "mobile.brand-background.style|iphone|zh-TW|global": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "PR4a 派工包集中批捕预案:合并门=--preview-slice 无 schema 错误;全格实拍证据由后续验收批次(双 AI 验收/QA)补录,--final 前必须清零"
    },
    "mobile.brand-background.style|iphone|en|cn": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "PR4a 派工包集中批捕预案:合并门=--preview-slice 无 schema 错误;全格实拍证据由后续验收批次(双 AI 验收/QA)补录,--final 前必须清零"
    },
    "mobile.brand-background.style|iphone|en|global": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "PR4a 派工包集中批捕预案:合并门=--preview-slice 无 schema 错误;全格实拍证据由后续验收批次(双 AI 验收/QA)补录,--final 前必须清零"
    },
    "mobile.brand-background.style|iphone|ja|cn": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "PR4a 派工包集中批捕预案:合并门=--preview-slice 无 schema 错误;全格实拍证据由后续验收批次(双 AI 验收/QA)补录,--final 前必须清零"
    },
    "mobile.brand-background.style|iphone|ja|global": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "PR4a 派工包集中批捕预案:合并门=--preview-slice 无 schema 错误;全格实拍证据由后续验收批次(双 AI 验收/QA)补录,--final 前必须清零"
    },
    "mobile.brand-background.style|iphone|ko|cn": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "PR4a 派工包集中批捕预案:合并门=--preview-slice 无 schema 错误;全格实拍证据由后续验收批次(双 AI 验收/QA)补录,--final 前必须清零"
    },
    "mobile.brand-background.style|iphone|ko|global": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "PR4a 派工包集中批捕预案:合并门=--preview-slice 无 schema 错误;全格实拍证据由后续验收批次(双 AI 验收/QA)补录,--final 前必须清零"
    },
    "mobile.brand-background.style|android-phone|zh-CN|cn": {
      "value": "PASS",
      "evidence": "pr4a/android-phone-cn-zhCN-identifier.png",
      "baseline": {
        "source": "wave4",
        "ref": "368:1375(视觉参数继承桌面:var(--surface) 底色+双 #F70121 渐变归一化百分比锚定物理 viewport;design.md §8.2 延展,移动无专属新帧)"
      },
      "reviewer": "exec-c/PR4a",
      "approvedAt": "2026-07-20"
    },
    "mobile.brand-background.style|android-phone|zh-CN|global": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "PR4a 派工包集中批捕预案:合并门=--preview-slice 无 schema 错误;全格实拍证据由后续验收批次(双 AI 验收/QA)补录,--final 前必须清零"
    },
    "mobile.brand-background.style|android-phone|zh-TW|cn": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "PR4a 派工包集中批捕预案:合并门=--preview-slice 无 schema 错误;全格实拍证据由后续验收批次(双 AI 验收/QA)补录,--final 前必须清零"
    },
    "mobile.brand-background.style|android-phone|zh-TW|global": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "PR4a 派工包集中批捕预案:合并门=--preview-slice 无 schema 错误;全格实拍证据由后续验收批次(双 AI 验收/QA)补录,--final 前必须清零"
    },
    "mobile.brand-background.style|android-phone|en|cn": {
      "value": "PASS",
      "evidence": "capture-mobile/android-phone-cn-en-identifier-default.png",
      "baseline": {
        "source": "capture-mobile",
        "ref": "android-phone cn en default login screenshot"
      },
      "reviewer": "exec-d/capture",
      "approvedAt": "2026-07-21"
    },
    "mobile.brand-background.style|android-phone|en|global": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "PR4a 派工包集中批捕预案:合并门=--preview-slice 无 schema 错误;全格实拍证据由后续验收批次(双 AI 验收/QA)补录,--final 前必须清零"
    },
    "mobile.brand-background.style|android-phone|ja|cn": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "PR4a 派工包集中批捕预案:合并门=--preview-slice 无 schema 错误;全格实拍证据由后续验收批次(双 AI 验收/QA)补录,--final 前必须清零"
    },
    "mobile.brand-background.style|android-phone|ja|global": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "PR4a 派工包集中批捕预案:合并门=--preview-slice 无 schema 错误;全格实拍证据由后续验收批次(双 AI 验收/QA)补录,--final 前必须清零"
    },
    "mobile.brand-background.style|android-phone|ko|cn": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "PR4a 派工包集中批捕预案:合并门=--preview-slice 无 schema 错误;全格实拍证据由后续验收批次(双 AI 验收/QA)补录,--final 前必须清零"
    },
    "mobile.brand-background.style|android-phone|ko|global": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "PR4a 派工包集中批捕预案:合并门=--preview-slice 无 schema 错误;全格实拍证据由后续验收批次(双 AI 验收/QA)补录,--final 前必须清零"
    },
    "mobile.brand-background.style|ipad|zh-CN|cn": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "PR4a 派工包集中批捕预案:合并门=--preview-slice 无 schema 错误;全格实拍证据由后续验收批次(双 AI 验收/QA)补录,--final 前必须清零"
    },
    "mobile.brand-background.style|ipad|zh-CN|global": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "PR4a 派工包集中批捕预案:合并门=--preview-slice 无 schema 错误;全格实拍证据由后续验收批次(双 AI 验收/QA)补录,--final 前必须清零"
    },
    "mobile.brand-background.style|ipad|zh-TW|cn": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "PR4a 派工包集中批捕预案:合并门=--preview-slice 无 schema 错误;全格实拍证据由后续验收批次(双 AI 验收/QA)补录,--final 前必须清零"
    },
    "mobile.brand-background.style|ipad|zh-TW|global": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "PR4a 派工包集中批捕预案:合并门=--preview-slice 无 schema 错误;全格实拍证据由后续验收批次(双 AI 验收/QA)补录,--final 前必须清零"
    },
    "mobile.brand-background.style|ipad|en|cn": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "PR4a 派工包集中批捕预案:合并门=--preview-slice 无 schema 错误;全格实拍证据由后续验收批次(双 AI 验收/QA)补录,--final 前必须清零"
    },
    "mobile.brand-background.style|ipad|en|global": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "PR4a 派工包集中批捕预案:合并门=--preview-slice 无 schema 错误;全格实拍证据由后续验收批次(双 AI 验收/QA)补录,--final 前必须清零"
    },
    "mobile.brand-background.style|ipad|ja|cn": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "PR4a 派工包集中批捕预案:合并门=--preview-slice 无 schema 错误;全格实拍证据由后续验收批次(双 AI 验收/QA)补录,--final 前必须清零"
    },
    "mobile.brand-background.style|ipad|ja|global": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "PR4a 派工包集中批捕预案:合并门=--preview-slice 无 schema 错误;全格实拍证据由后续验收批次(双 AI 验收/QA)补录,--final 前必须清零"
    },
    "mobile.brand-background.style|ipad|ko|cn": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "PR4a 派工包集中批捕预案:合并门=--preview-slice 无 schema 错误;全格实拍证据由后续验收批次(双 AI 验收/QA)补录,--final 前必须清零"
    },
    "mobile.brand-background.style|ipad|ko|global": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "PR4a 派工包集中批捕预案:合并门=--preview-slice 无 schema 错误;全格实拍证据由后续验收批次(双 AI 验收/QA)补录,--final 前必须清零"
    },
    "mobile.brand-background.style|android-pad|zh-CN|cn": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "PR4a 派工包集中批捕预案:合并门=--preview-slice 无 schema 错误;全格实拍证据由后续验收批次(双 AI 验收/QA)补录,--final 前必须清零"
    },
    "mobile.brand-background.style|android-pad|zh-CN|global": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "PR4a 派工包集中批捕预案:合并门=--preview-slice 无 schema 错误;全格实拍证据由后续验收批次(双 AI 验收/QA)补录,--final 前必须清零"
    },
    "mobile.brand-background.style|android-pad|zh-TW|cn": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "PR4a 派工包集中批捕预案:合并门=--preview-slice 无 schema 错误;全格实拍证据由后续验收批次(双 AI 验收/QA)补录,--final 前必须清零"
    },
    "mobile.brand-background.style|android-pad|zh-TW|global": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "PR4a 派工包集中批捕预案:合并门=--preview-slice 无 schema 错误;全格实拍证据由后续验收批次(双 AI 验收/QA)补录,--final 前必须清零"
    },
    "mobile.brand-background.style|android-pad|en|cn": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "PR4a 派工包集中批捕预案:合并门=--preview-slice 无 schema 错误;全格实拍证据由后续验收批次(双 AI 验收/QA)补录,--final 前必须清零"
    },
    "mobile.brand-background.style|android-pad|en|global": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "PR4a 派工包集中批捕预案:合并门=--preview-slice 无 schema 错误;全格实拍证据由后续验收批次(双 AI 验收/QA)补录,--final 前必须清零"
    },
    "mobile.brand-background.style|android-pad|ja|cn": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "PR4a 派工包集中批捕预案:合并门=--preview-slice 无 schema 错误;全格实拍证据由后续验收批次(双 AI 验收/QA)补录,--final 前必须清零"
    },
    "mobile.brand-background.style|android-pad|ja|global": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "PR4a 派工包集中批捕预案:合并门=--preview-slice 无 schema 错误;全格实拍证据由后续验收批次(双 AI 验收/QA)补录,--final 前必须清零"
    },
    "mobile.brand-background.style|android-pad|ko|cn": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "PR4a 派工包集中批捕预案:合并门=--preview-slice 无 schema 错误;全格实拍证据由后续验收批次(双 AI 验收/QA)补录,--final 前必须清零"
    },
    "mobile.brand-background.style|android-pad|ko|global": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "PR4a 派工包集中批捕预案:合并门=--preview-slice 无 schema 错误;全格实拍证据由后续验收批次(双 AI 验收/QA)补录,--final 前必须清零"
    },
    "mobile.login-panel-border.style|iphone|zh-CN|cn": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "PR4a 派工包集中批捕预案:合并门=--preview-slice 无 schema 错误;全格实拍证据由后续验收批次(双 AI 验收/QA)补录,--final 前必须清零"
    },
    "mobile.login-panel-border.style|iphone|zh-CN|global": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "PR4a 派工包集中批捕预案:合并门=--preview-slice 无 schema 错误;全格实拍证据由后续验收批次(双 AI 验收/QA)补录,--final 前必须清零"
    },
    "mobile.login-panel-border.style|iphone|zh-TW|cn": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "PR4a 派工包集中批捕预案:合并门=--preview-slice 无 schema 错误;全格实拍证据由后续验收批次(双 AI 验收/QA)补录,--final 前必须清零"
    },
    "mobile.login-panel-border.style|iphone|zh-TW|global": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "PR4a 派工包集中批捕预案:合并门=--preview-slice 无 schema 错误;全格实拍证据由后续验收批次(双 AI 验收/QA)补录,--final 前必须清零"
    },
    "mobile.login-panel-border.style|iphone|en|cn": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "PR4a 派工包集中批捕预案:合并门=--preview-slice 无 schema 错误;全格实拍证据由后续验收批次(双 AI 验收/QA)补录,--final 前必须清零"
    },
    "mobile.login-panel-border.style|iphone|en|global": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "PR4a 派工包集中批捕预案:合并门=--preview-slice 无 schema 错误;全格实拍证据由后续验收批次(双 AI 验收/QA)补录,--final 前必须清零"
    },
    "mobile.login-panel-border.style|iphone|ja|cn": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "PR4a 派工包集中批捕预案:合并门=--preview-slice 无 schema 错误;全格实拍证据由后续验收批次(双 AI 验收/QA)补录,--final 前必须清零"
    },
    "mobile.login-panel-border.style|iphone|ja|global": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "PR4a 派工包集中批捕预案:合并门=--preview-slice 无 schema 错误;全格实拍证据由后续验收批次(双 AI 验收/QA)补录,--final 前必须清零"
    },
    "mobile.login-panel-border.style|iphone|ko|cn": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "PR4a 派工包集中批捕预案:合并门=--preview-slice 无 schema 错误;全格实拍证据由后续验收批次(双 AI 验收/QA)补录,--final 前必须清零"
    },
    "mobile.login-panel-border.style|iphone|ko|global": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "PR4a 派工包集中批捕预案:合并门=--preview-slice 无 schema 错误;全格实拍证据由后续验收批次(双 AI 验收/QA)补录,--final 前必须清零"
    },
    "mobile.login-panel-border.style|android-phone|zh-CN|cn": {
      "value": "PASS",
      "evidence": "pr4a/android-phone-cn-zhCN-identifier.png",
      "baseline": {
        "source": "wave4",
        "ref": "368:1383(#D4D4D4 1px inside,§8.2 延展至移动全部 UI 面板)"
      },
      "reviewer": "exec-c/PR4a",
      "approvedAt": "2026-07-20"
    },
    "mobile.login-panel-border.style|android-phone|zh-CN|global": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "PR4a 派工包集中批捕预案:合并门=--preview-slice 无 schema 错误;全格实拍证据由后续验收批次(双 AI 验收/QA)补录,--final 前必须清零"
    },
    "mobile.login-panel-border.style|android-phone|zh-TW|cn": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "PR4a 派工包集中批捕预案:合并门=--preview-slice 无 schema 错误;全格实拍证据由后续验收批次(双 AI 验收/QA)补录,--final 前必须清零"
    },
    "mobile.login-panel-border.style|android-phone|zh-TW|global": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "PR4a 派工包集中批捕预案:合并门=--preview-slice 无 schema 错误;全格实拍证据由后续验收批次(双 AI 验收/QA)补录,--final 前必须清零"
    },
    "mobile.login-panel-border.style|android-phone|en|cn": {
      "value": "PASS",
      "evidence": "capture-mobile/android-phone-cn-en-identifier-default.png",
      "baseline": {
        "source": "capture-mobile",
        "ref": "android-phone cn en default login screenshot"
      },
      "reviewer": "exec-d/capture",
      "approvedAt": "2026-07-21"
    },
    "mobile.login-panel-border.style|android-phone|en|global": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "PR4a 派工包集中批捕预案:合并门=--preview-slice 无 schema 错误;全格实拍证据由后续验收批次(双 AI 验收/QA)补录,--final 前必须清零"
    },
    "mobile.login-panel-border.style|android-phone|ja|cn": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "PR4a 派工包集中批捕预案:合并门=--preview-slice 无 schema 错误;全格实拍证据由后续验收批次(双 AI 验收/QA)补录,--final 前必须清零"
    },
    "mobile.login-panel-border.style|android-phone|ja|global": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "PR4a 派工包集中批捕预案:合并门=--preview-slice 无 schema 错误;全格实拍证据由后续验收批次(双 AI 验收/QA)补录,--final 前必须清零"
    },
    "mobile.login-panel-border.style|android-phone|ko|cn": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "PR4a 派工包集中批捕预案:合并门=--preview-slice 无 schema 错误;全格实拍证据由后续验收批次(双 AI 验收/QA)补录,--final 前必须清零"
    },
    "mobile.login-panel-border.style|android-phone|ko|global": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "PR4a 派工包集中批捕预案:合并门=--preview-slice 无 schema 错误;全格实拍证据由后续验收批次(双 AI 验收/QA)补录,--final 前必须清零"
    },
    "mobile.login-panel-border.style|ipad|zh-CN|cn": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "PR4a 派工包集中批捕预案:合并门=--preview-slice 无 schema 错误;全格实拍证据由后续验收批次(双 AI 验收/QA)补录,--final 前必须清零"
    },
    "mobile.login-panel-border.style|ipad|zh-CN|global": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "PR4a 派工包集中批捕预案:合并门=--preview-slice 无 schema 错误;全格实拍证据由后续验收批次(双 AI 验收/QA)补录,--final 前必须清零"
    },
    "mobile.login-panel-border.style|ipad|zh-TW|cn": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "PR4a 派工包集中批捕预案:合并门=--preview-slice 无 schema 错误;全格实拍证据由后续验收批次(双 AI 验收/QA)补录,--final 前必须清零"
    },
    "mobile.login-panel-border.style|ipad|zh-TW|global": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "PR4a 派工包集中批捕预案:合并门=--preview-slice 无 schema 错误;全格实拍证据由后续验收批次(双 AI 验收/QA)补录,--final 前必须清零"
    },
    "mobile.login-panel-border.style|ipad|en|cn": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "PR4a 派工包集中批捕预案:合并门=--preview-slice 无 schema 错误;全格实拍证据由后续验收批次(双 AI 验收/QA)补录,--final 前必须清零"
    },
    "mobile.login-panel-border.style|ipad|en|global": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "PR4a 派工包集中批捕预案:合并门=--preview-slice 无 schema 错误;全格实拍证据由后续验收批次(双 AI 验收/QA)补录,--final 前必须清零"
    },
    "mobile.login-panel-border.style|ipad|ja|cn": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "PR4a 派工包集中批捕预案:合并门=--preview-slice 无 schema 错误;全格实拍证据由后续验收批次(双 AI 验收/QA)补录,--final 前必须清零"
    },
    "mobile.login-panel-border.style|ipad|ja|global": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "PR4a 派工包集中批捕预案:合并门=--preview-slice 无 schema 错误;全格实拍证据由后续验收批次(双 AI 验收/QA)补录,--final 前必须清零"
    },
    "mobile.login-panel-border.style|ipad|ko|cn": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "PR4a 派工包集中批捕预案:合并门=--preview-slice 无 schema 错误;全格实拍证据由后续验收批次(双 AI 验收/QA)补录,--final 前必须清零"
    },
    "mobile.login-panel-border.style|ipad|ko|global": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "PR4a 派工包集中批捕预案:合并门=--preview-slice 无 schema 错误;全格实拍证据由后续验收批次(双 AI 验收/QA)补录,--final 前必须清零"
    },
    "mobile.login-panel-border.style|android-pad|zh-CN|cn": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "PR4a 派工包集中批捕预案:合并门=--preview-slice 无 schema 错误;全格实拍证据由后续验收批次(双 AI 验收/QA)补录,--final 前必须清零"
    },
    "mobile.login-panel-border.style|android-pad|zh-CN|global": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "PR4a 派工包集中批捕预案:合并门=--preview-slice 无 schema 错误;全格实拍证据由后续验收批次(双 AI 验收/QA)补录,--final 前必须清零"
    },
    "mobile.login-panel-border.style|android-pad|zh-TW|cn": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "PR4a 派工包集中批捕预案:合并门=--preview-slice 无 schema 错误;全格实拍证据由后续验收批次(双 AI 验收/QA)补录,--final 前必须清零"
    },
    "mobile.login-panel-border.style|android-pad|zh-TW|global": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "PR4a 派工包集中批捕预案:合并门=--preview-slice 无 schema 错误;全格实拍证据由后续验收批次(双 AI 验收/QA)补录,--final 前必须清零"
    },
    "mobile.login-panel-border.style|android-pad|en|cn": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "PR4a 派工包集中批捕预案:合并门=--preview-slice 无 schema 错误;全格实拍证据由后续验收批次(双 AI 验收/QA)补录,--final 前必须清零"
    },
    "mobile.login-panel-border.style|android-pad|en|global": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "PR4a 派工包集中批捕预案:合并门=--preview-slice 无 schema 错误;全格实拍证据由后续验收批次(双 AI 验收/QA)补录,--final 前必须清零"
    },
    "mobile.login-panel-border.style|android-pad|ja|cn": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "PR4a 派工包集中批捕预案:合并门=--preview-slice 无 schema 错误;全格实拍证据由后续验收批次(双 AI 验收/QA)补录,--final 前必须清零"
    },
    "mobile.login-panel-border.style|android-pad|ja|global": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "PR4a 派工包集中批捕预案:合并门=--preview-slice 无 schema 错误;全格实拍证据由后续验收批次(双 AI 验收/QA)补录,--final 前必须清零"
    },
    "mobile.login-panel-border.style|android-pad|ko|cn": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "PR4a 派工包集中批捕预案:合并门=--preview-slice 无 schema 错误;全格实拍证据由后续验收批次(双 AI 验收/QA)补录,--final 前必须清零"
    },
    "mobile.login-panel-border.style|android-pad|ko|global": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "PR4a 派工包集中批捕预案:合并门=--preview-slice 无 schema 错误;全格实拍证据由后续验收批次(双 AI 验收/QA)补录,--final 前必须清零"
    },
    "mobile.wordmark.asset|iphone|zh-CN|cn": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "PR4a 派工包集中批捕预案:合并门=--preview-slice 无 schema 错误;全格实拍证据由后续验收批次(双 AI 验收/QA)补录,--final 前必须清零"
    },
    "mobile.wordmark.asset|iphone|zh-CN|global": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "PR4a 派工包集中批捕预案:合并门=--preview-slice 无 schema 错误;全格实拍证据由后续验收批次(双 AI 验收/QA)补录,--final 前必须清零"
    },
    "mobile.wordmark.asset|iphone|zh-TW|cn": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "PR4a 派工包集中批捕预案:合并门=--preview-slice 无 schema 错误;全格实拍证据由后续验收批次(双 AI 验收/QA)补录,--final 前必须清零"
    },
    "mobile.wordmark.asset|iphone|zh-TW|global": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "PR4a 派工包集中批捕预案:合并门=--preview-slice 无 schema 错误;全格实拍证据由后续验收批次(双 AI 验收/QA)补录,--final 前必须清零"
    },
    "mobile.wordmark.asset|iphone|en|cn": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "PR4a 派工包集中批捕预案:合并门=--preview-slice 无 schema 错误;全格实拍证据由后续验收批次(双 AI 验收/QA)补录,--final 前必须清零"
    },
    "mobile.wordmark.asset|iphone|en|global": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "PR4a 派工包集中批捕预案:合并门=--preview-slice 无 schema 错误;全格实拍证据由后续验收批次(双 AI 验收/QA)补录,--final 前必须清零"
    },
    "mobile.wordmark.asset|iphone|ja|cn": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "PR4a 派工包集中批捕预案:合并门=--preview-slice 无 schema 错误;全格实拍证据由后续验收批次(双 AI 验收/QA)补录,--final 前必须清零"
    },
    "mobile.wordmark.asset|iphone|ja|global": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "PR4a 派工包集中批捕预案:合并门=--preview-slice 无 schema 错误;全格实拍证据由后续验收批次(双 AI 验收/QA)补录,--final 前必须清零"
    },
    "mobile.wordmark.asset|iphone|ko|cn": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "PR4a 派工包集中批捕预案:合并门=--preview-slice 无 schema 错误;全格实拍证据由后续验收批次(双 AI 验收/QA)补录,--final 前必须清零"
    },
    "mobile.wordmark.asset|iphone|ko|global": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "PR4a 派工包集中批捕预案:合并门=--preview-slice 无 schema 错误;全格实拍证据由后续验收批次(双 AI 验收/QA)补录,--final 前必须清零"
    },
    "mobile.wordmark.asset|android-phone|zh-CN|cn": {
      "value": "PASS",
      "evidence": "pr4a/android-phone-cn-zhCN-identifier.png",
      "baseline": {
        "source": "wave4",
        "ref": "368:1381(黑红版资产;资产行=wave4)"
      },
      "reviewer": "exec-c/PR4a",
      "approvedAt": "2026-07-20"
    },
    "mobile.wordmark.asset|android-phone|zh-CN|global": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "PR4a 派工包集中批捕预案:合并门=--preview-slice 无 schema 错误;全格实拍证据由后续验收批次(双 AI 验收/QA)补录,--final 前必须清零"
    },
    "mobile.wordmark.asset|android-phone|zh-TW|cn": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "PR4a 派工包集中批捕预案:合并门=--preview-slice 无 schema 错误;全格实拍证据由后续验收批次(双 AI 验收/QA)补录,--final 前必须清零"
    },
    "mobile.wordmark.asset|android-phone|zh-TW|global": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "PR4a 派工包集中批捕预案:合并门=--preview-slice 无 schema 错误;全格实拍证据由后续验收批次(双 AI 验收/QA)补录,--final 前必须清零"
    },
    "mobile.wordmark.asset|android-phone|en|cn": {
      "value": "PASS",
      "evidence": "capture-mobile/android-phone-cn-en-identifier-default.png",
      "baseline": {
        "source": "capture-mobile",
        "ref": "android-phone cn en default login screenshot"
      },
      "reviewer": "exec-d/capture",
      "approvedAt": "2026-07-21"
    },
    "mobile.wordmark.asset|android-phone|en|global": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "PR4a 派工包集中批捕预案:合并门=--preview-slice 无 schema 错误;全格实拍证据由后续验收批次(双 AI 验收/QA)补录,--final 前必须清零"
    },
    "mobile.wordmark.asset|android-phone|ja|cn": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "PR4a 派工包集中批捕预案:合并门=--preview-slice 无 schema 错误;全格实拍证据由后续验收批次(双 AI 验收/QA)补录,--final 前必须清零"
    },
    "mobile.wordmark.asset|android-phone|ja|global": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "PR4a 派工包集中批捕预案:合并门=--preview-slice 无 schema 错误;全格实拍证据由后续验收批次(双 AI 验收/QA)补录,--final 前必须清零"
    },
    "mobile.wordmark.asset|android-phone|ko|cn": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "PR4a 派工包集中批捕预案:合并门=--preview-slice 无 schema 错误;全格实拍证据由后续验收批次(双 AI 验收/QA)补录,--final 前必须清零"
    },
    "mobile.wordmark.asset|android-phone|ko|global": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "PR4a 派工包集中批捕预案:合并门=--preview-slice 无 schema 错误;全格实拍证据由后续验收批次(双 AI 验收/QA)补录,--final 前必须清零"
    },
    "mobile.wordmark.asset|ipad|zh-CN|cn": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "PR4a 派工包集中批捕预案:合并门=--preview-slice 无 schema 错误;全格实拍证据由后续验收批次(双 AI 验收/QA)补录,--final 前必须清零"
    },
    "mobile.wordmark.asset|ipad|zh-CN|global": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "PR4a 派工包集中批捕预案:合并门=--preview-slice 无 schema 错误;全格实拍证据由后续验收批次(双 AI 验收/QA)补录,--final 前必须清零"
    },
    "mobile.wordmark.asset|ipad|zh-TW|cn": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "PR4a 派工包集中批捕预案:合并门=--preview-slice 无 schema 错误;全格实拍证据由后续验收批次(双 AI 验收/QA)补录,--final 前必须清零"
    },
    "mobile.wordmark.asset|ipad|zh-TW|global": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "PR4a 派工包集中批捕预案:合并门=--preview-slice 无 schema 错误;全格实拍证据由后续验收批次(双 AI 验收/QA)补录,--final 前必须清零"
    },
    "mobile.wordmark.asset|ipad|en|cn": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "PR4a 派工包集中批捕预案:合并门=--preview-slice 无 schema 错误;全格实拍证据由后续验收批次(双 AI 验收/QA)补录,--final 前必须清零"
    },
    "mobile.wordmark.asset|ipad|en|global": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "PR4a 派工包集中批捕预案:合并门=--preview-slice 无 schema 错误;全格实拍证据由后续验收批次(双 AI 验收/QA)补录,--final 前必须清零"
    },
    "mobile.wordmark.asset|ipad|ja|cn": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "PR4a 派工包集中批捕预案:合并门=--preview-slice 无 schema 错误;全格实拍证据由后续验收批次(双 AI 验收/QA)补录,--final 前必须清零"
    },
    "mobile.wordmark.asset|ipad|ja|global": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "PR4a 派工包集中批捕预案:合并门=--preview-slice 无 schema 错误;全格实拍证据由后续验收批次(双 AI 验收/QA)补录,--final 前必须清零"
    },
    "mobile.wordmark.asset|ipad|ko|cn": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "PR4a 派工包集中批捕预案:合并门=--preview-slice 无 schema 错误;全格实拍证据由后续验收批次(双 AI 验收/QA)补录,--final 前必须清零"
    },
    "mobile.wordmark.asset|ipad|ko|global": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "PR4a 派工包集中批捕预案:合并门=--preview-slice 无 schema 错误;全格实拍证据由后续验收批次(双 AI 验收/QA)补录,--final 前必须清零"
    },
    "mobile.wordmark.asset|android-pad|zh-CN|cn": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "PR4a 派工包集中批捕预案:合并门=--preview-slice 无 schema 错误;全格实拍证据由后续验收批次(双 AI 验收/QA)补录,--final 前必须清零"
    },
    "mobile.wordmark.asset|android-pad|zh-CN|global": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "PR4a 派工包集中批捕预案:合并门=--preview-slice 无 schema 错误;全格实拍证据由后续验收批次(双 AI 验收/QA)补录,--final 前必须清零"
    },
    "mobile.wordmark.asset|android-pad|zh-TW|cn": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "PR4a 派工包集中批捕预案:合并门=--preview-slice 无 schema 错误;全格实拍证据由后续验收批次(双 AI 验收/QA)补录,--final 前必须清零"
    },
    "mobile.wordmark.asset|android-pad|zh-TW|global": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "PR4a 派工包集中批捕预案:合并门=--preview-slice 无 schema 错误;全格实拍证据由后续验收批次(双 AI 验收/QA)补录,--final 前必须清零"
    },
    "mobile.wordmark.asset|android-pad|en|cn": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "PR4a 派工包集中批捕预案:合并门=--preview-slice 无 schema 错误;全格实拍证据由后续验收批次(双 AI 验收/QA)补录,--final 前必须清零"
    },
    "mobile.wordmark.asset|android-pad|en|global": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "PR4a 派工包集中批捕预案:合并门=--preview-slice 无 schema 错误;全格实拍证据由后续验收批次(双 AI 验收/QA)补录,--final 前必须清零"
    },
    "mobile.wordmark.asset|android-pad|ja|cn": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "PR4a 派工包集中批捕预案:合并门=--preview-slice 无 schema 错误;全格实拍证据由后续验收批次(双 AI 验收/QA)补录,--final 前必须清零"
    },
    "mobile.wordmark.asset|android-pad|ja|global": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "PR4a 派工包集中批捕预案:合并门=--preview-slice 无 schema 错误;全格实拍证据由后续验收批次(双 AI 验收/QA)补录,--final 前必须清零"
    },
    "mobile.wordmark.asset|android-pad|ko|cn": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "PR4a 派工包集中批捕预案:合并门=--preview-slice 无 schema 错误;全格实拍证据由后续验收批次(双 AI 验收/QA)补录,--final 前必须清零"
    },
    "mobile.wordmark.asset|android-pad|ko|global": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "PR4a 派工包集中批捕预案:合并门=--preview-slice 无 schema 错误;全格实拍证据由后续验收批次(双 AI 验收/QA)补录,--final 前必须清零"
    },
    "mobile.wordmark.geometry|iphone|zh-CN|cn": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "PR4a 派工包集中批捕预案:合并门=--preview-slice 无 schema 错误;全格实拍证据由后续验收批次(双 AI 验收/QA)补录,--final 前必须清零"
    },
    "mobile.wordmark.geometry|iphone|zh-CN|global": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "PR4a 派工包集中批捕预案:合并门=--preview-slice 无 schema 错误;全格实拍证据由后续验收批次(双 AI 验收/QA)补录,--final 前必须清零"
    },
    "mobile.wordmark.geometry|iphone|zh-TW|cn": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "PR4a 派工包集中批捕预案:合并门=--preview-slice 无 schema 错误;全格实拍证据由后续验收批次(双 AI 验收/QA)补录,--final 前必须清零"
    },
    "mobile.wordmark.geometry|iphone|zh-TW|global": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "PR4a 派工包集中批捕预案:合并门=--preview-slice 无 schema 错误;全格实拍证据由后续验收批次(双 AI 验收/QA)补录,--final 前必须清零"
    },
    "mobile.wordmark.geometry|iphone|en|cn": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "PR4a 派工包集中批捕预案:合并门=--preview-slice 无 schema 错误;全格实拍证据由后续验收批次(双 AI 验收/QA)补录,--final 前必须清零"
    },
    "mobile.wordmark.geometry|iphone|en|global": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "PR4a 派工包集中批捕预案:合并门=--preview-slice 无 schema 错误;全格实拍证据由后续验收批次(双 AI 验收/QA)补录,--final 前必须清零"
    },
    "mobile.wordmark.geometry|iphone|ja|cn": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "PR4a 派工包集中批捕预案:合并门=--preview-slice 无 schema 错误;全格实拍证据由后续验收批次(双 AI 验收/QA)补录,--final 前必须清零"
    },
    "mobile.wordmark.geometry|iphone|ja|global": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "PR4a 派工包集中批捕预案:合并门=--preview-slice 无 schema 错误;全格实拍证据由后续验收批次(双 AI 验收/QA)补录,--final 前必须清零"
    },
    "mobile.wordmark.geometry|iphone|ko|cn": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "PR4a 派工包集中批捕预案:合并门=--preview-slice 无 schema 错误;全格实拍证据由后续验收批次(双 AI 验收/QA)补录,--final 前必须清零"
    },
    "mobile.wordmark.geometry|iphone|ko|global": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "PR4a 派工包集中批捕预案:合并门=--preview-slice 无 schema 错误;全格实拍证据由后续验收批次(双 AI 验收/QA)补录,--final 前必须清零"
    },
    "mobile.wordmark.geometry|android-phone|zh-CN|cn": {
      "value": "PASS",
      "evidence": "pr4a/android-phone-cn-zhCN-identifier.png",
      "baseline": {
        "source": "demo",
        "ref": "旧移动字标框内 contain 等比适配(长屏 175,814,401×137/短屏 660×158.4 框沿 wave3.5 旧表;禁止非等比拉伸)"
      },
      "reviewer": "exec-c/PR4a",
      "approvedAt": "2026-07-20"
    },
    "mobile.wordmark.geometry|android-phone|zh-CN|global": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "PR4a 派工包集中批捕预案:合并门=--preview-slice 无 schema 错误;全格实拍证据由后续验收批次(双 AI 验收/QA)补录,--final 前必须清零"
    },
    "mobile.wordmark.geometry|android-phone|zh-TW|cn": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "PR4a 派工包集中批捕预案:合并门=--preview-slice 无 schema 错误;全格实拍证据由后续验收批次(双 AI 验收/QA)补录,--final 前必须清零"
    },
    "mobile.wordmark.geometry|android-phone|zh-TW|global": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "PR4a 派工包集中批捕预案:合并门=--preview-slice 无 schema 错误;全格实拍证据由后续验收批次(双 AI 验收/QA)补录,--final 前必须清零"
    },
    "mobile.wordmark.geometry|android-phone|en|cn": {
      "value": "PASS",
      "evidence": "capture-mobile/android-phone-cn-en-identifier-default.png",
      "baseline": {
        "source": "capture-mobile",
        "ref": "android-phone cn en default login screenshot"
      },
      "reviewer": "exec-d/capture",
      "approvedAt": "2026-07-21"
    },
    "mobile.wordmark.geometry|android-phone|en|global": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "PR4a 派工包集中批捕预案:合并门=--preview-slice 无 schema 错误;全格实拍证据由后续验收批次(双 AI 验收/QA)补录,--final 前必须清零"
    },
    "mobile.wordmark.geometry|android-phone|ja|cn": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "PR4a 派工包集中批捕预案:合并门=--preview-slice 无 schema 错误;全格实拍证据由后续验收批次(双 AI 验收/QA)补录,--final 前必须清零"
    },
    "mobile.wordmark.geometry|android-phone|ja|global": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "PR4a 派工包集中批捕预案:合并门=--preview-slice 无 schema 错误;全格实拍证据由后续验收批次(双 AI 验收/QA)补录,--final 前必须清零"
    },
    "mobile.wordmark.geometry|android-phone|ko|cn": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "PR4a 派工包集中批捕预案:合并门=--preview-slice 无 schema 错误;全格实拍证据由后续验收批次(双 AI 验收/QA)补录,--final 前必须清零"
    },
    "mobile.wordmark.geometry|android-phone|ko|global": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "PR4a 派工包集中批捕预案:合并门=--preview-slice 无 schema 错误;全格实拍证据由后续验收批次(双 AI 验收/QA)补录,--final 前必须清零"
    },
    "mobile.wordmark.geometry|ipad|zh-CN|cn": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "PR4a 派工包集中批捕预案:合并门=--preview-slice 无 schema 错误;全格实拍证据由后续验收批次(双 AI 验收/QA)补录,--final 前必须清零"
    },
    "mobile.wordmark.geometry|ipad|zh-CN|global": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "PR4a 派工包集中批捕预案:合并门=--preview-slice 无 schema 错误;全格实拍证据由后续验收批次(双 AI 验收/QA)补录,--final 前必须清零"
    },
    "mobile.wordmark.geometry|ipad|zh-TW|cn": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "PR4a 派工包集中批捕预案:合并门=--preview-slice 无 schema 错误;全格实拍证据由后续验收批次(双 AI 验收/QA)补录,--final 前必须清零"
    },
    "mobile.wordmark.geometry|ipad|zh-TW|global": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "PR4a 派工包集中批捕预案:合并门=--preview-slice 无 schema 错误;全格实拍证据由后续验收批次(双 AI 验收/QA)补录,--final 前必须清零"
    },
    "mobile.wordmark.geometry|ipad|en|cn": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "PR4a 派工包集中批捕预案:合并门=--preview-slice 无 schema 错误;全格实拍证据由后续验收批次(双 AI 验收/QA)补录,--final 前必须清零"
    },
    "mobile.wordmark.geometry|ipad|en|global": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "PR4a 派工包集中批捕预案:合并门=--preview-slice 无 schema 错误;全格实拍证据由后续验收批次(双 AI 验收/QA)补录,--final 前必须清零"
    },
    "mobile.wordmark.geometry|ipad|ja|cn": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "PR4a 派工包集中批捕预案:合并门=--preview-slice 无 schema 错误;全格实拍证据由后续验收批次(双 AI 验收/QA)补录,--final 前必须清零"
    },
    "mobile.wordmark.geometry|ipad|ja|global": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "PR4a 派工包集中批捕预案:合并门=--preview-slice 无 schema 错误;全格实拍证据由后续验收批次(双 AI 验收/QA)补录,--final 前必须清零"
    },
    "mobile.wordmark.geometry|ipad|ko|cn": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "PR4a 派工包集中批捕预案:合并门=--preview-slice 无 schema 错误;全格实拍证据由后续验收批次(双 AI 验收/QA)补录,--final 前必须清零"
    },
    "mobile.wordmark.geometry|ipad|ko|global": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "PR4a 派工包集中批捕预案:合并门=--preview-slice 无 schema 错误;全格实拍证据由后续验收批次(双 AI 验收/QA)补录,--final 前必须清零"
    },
    "mobile.wordmark.geometry|android-pad|zh-CN|cn": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "PR4a 派工包集中批捕预案:合并门=--preview-slice 无 schema 错误;全格实拍证据由后续验收批次(双 AI 验收/QA)补录,--final 前必须清零"
    },
    "mobile.wordmark.geometry|android-pad|zh-CN|global": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "PR4a 派工包集中批捕预案:合并门=--preview-slice 无 schema 错误;全格实拍证据由后续验收批次(双 AI 验收/QA)补录,--final 前必须清零"
    },
    "mobile.wordmark.geometry|android-pad|zh-TW|cn": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "PR4a 派工包集中批捕预案:合并门=--preview-slice 无 schema 错误;全格实拍证据由后续验收批次(双 AI 验收/QA)补录,--final 前必须清零"
    },
    "mobile.wordmark.geometry|android-pad|zh-TW|global": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "PR4a 派工包集中批捕预案:合并门=--preview-slice 无 schema 错误;全格实拍证据由后续验收批次(双 AI 验收/QA)补录,--final 前必须清零"
    },
    "mobile.wordmark.geometry|android-pad|en|cn": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "PR4a 派工包集中批捕预案:合并门=--preview-slice 无 schema 错误;全格实拍证据由后续验收批次(双 AI 验收/QA)补录,--final 前必须清零"
    },
    "mobile.wordmark.geometry|android-pad|en|global": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "PR4a 派工包集中批捕预案:合并门=--preview-slice 无 schema 错误;全格实拍证据由后续验收批次(双 AI 验收/QA)补录,--final 前必须清零"
    },
    "mobile.wordmark.geometry|android-pad|ja|cn": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "PR4a 派工包集中批捕预案:合并门=--preview-slice 无 schema 错误;全格实拍证据由后续验收批次(双 AI 验收/QA)补录,--final 前必须清零"
    },
    "mobile.wordmark.geometry|android-pad|ja|global": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "PR4a 派工包集中批捕预案:合并门=--preview-slice 无 schema 错误;全格实拍证据由后续验收批次(双 AI 验收/QA)补录,--final 前必须清零"
    },
    "mobile.wordmark.geometry|android-pad|ko|cn": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "PR4a 派工包集中批捕预案:合并门=--preview-slice 无 schema 错误;全格实拍证据由后续验收批次(双 AI 验收/QA)补录,--final 前必须清零"
    },
    "mobile.wordmark.geometry|android-pad|ko|global": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "PR4a 派工包集中批捕预案:合并门=--preview-slice 无 schema 错误;全格实拍证据由后续验收批次(双 AI 验收/QA)补录,--final 前必须清零"
    },
    "mobile.slogan.style|iphone|zh-CN|cn": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "PR4a 派工包集中批捕预案:合并门=--preview-slice 无 schema 错误;全格实拍证据由后续验收批次(双 AI 验收/QA)补录,--final 前必须清零"
    },
    "mobile.slogan.style|iphone|zh-CN|global": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "PR4a 派工包集中批捕预案:合并门=--preview-slice 无 schema 错误;全格实拍证据由后续验收批次(双 AI 验收/QA)补录,--final 前必须清零"
    },
    "mobile.slogan.style|iphone|zh-TW|cn": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "PR4a 派工包集中批捕预案:合并门=--preview-slice 无 schema 错误;全格实拍证据由后续验收批次(双 AI 验收/QA)补录,--final 前必须清零"
    },
    "mobile.slogan.style|iphone|zh-TW|global": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "PR4a 派工包集中批捕预案:合并门=--preview-slice 无 schema 错误;全格实拍证据由后续验收批次(双 AI 验收/QA)补录,--final 前必须清零"
    },
    "mobile.slogan.style|iphone|en|cn": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "PR4a 派工包集中批捕预案:合并门=--preview-slice 无 schema 错误;全格实拍证据由后续验收批次(双 AI 验收/QA)补录,--final 前必须清零"
    },
    "mobile.slogan.style|iphone|en|global": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "PR4a 派工包集中批捕预案:合并门=--preview-slice 无 schema 错误;全格实拍证据由后续验收批次(双 AI 验收/QA)补录,--final 前必须清零"
    },
    "mobile.slogan.style|iphone|ja|cn": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "PR4a 派工包集中批捕预案:合并门=--preview-slice 无 schema 错误;全格实拍证据由后续验收批次(双 AI 验收/QA)补录,--final 前必须清零"
    },
    "mobile.slogan.style|iphone|ja|global": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "PR4a 派工包集中批捕预案:合并门=--preview-slice 无 schema 错误;全格实拍证据由后续验收批次(双 AI 验收/QA)补录,--final 前必须清零"
    },
    "mobile.slogan.style|iphone|ko|cn": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "PR4a 派工包集中批捕预案:合并门=--preview-slice 无 schema 错误;全格实拍证据由后续验收批次(双 AI 验收/QA)补录,--final 前必须清零"
    },
    "mobile.slogan.style|iphone|ko|global": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "PR4a 派工包集中批捕预案:合并门=--preview-slice 无 schema 错误;全格实拍证据由后续验收批次(双 AI 验收/QA)补录,--final 前必须清零"
    },
    "mobile.slogan.style|android-phone|zh-CN|cn": {
      "value": "PASS",
      "evidence": "pr4a/android-phone-cn-zhCN-identifier.png",
      "baseline": {
        "source": "wave4",
        "ref": "368:1394(#2A2828 版;样式行=wave4)"
      },
      "reviewer": "exec-c/PR4a",
      "approvedAt": "2026-07-20"
    },
    "mobile.slogan.style|android-phone|zh-CN|global": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "PR4a 派工包集中批捕预案:合并门=--preview-slice 无 schema 错误;全格实拍证据由后续验收批次(双 AI 验收/QA)补录,--final 前必须清零"
    },
    "mobile.slogan.style|android-phone|zh-TW|cn": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "PR4a 派工包集中批捕预案:合并门=--preview-slice 无 schema 错误;全格实拍证据由后续验收批次(双 AI 验收/QA)补录,--final 前必须清零"
    },
    "mobile.slogan.style|android-phone|zh-TW|global": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "PR4a 派工包集中批捕预案:合并门=--preview-slice 无 schema 错误;全格实拍证据由后续验收批次(双 AI 验收/QA)补录,--final 前必须清零"
    },
    "mobile.slogan.style|android-phone|en|cn": {
      "value": "PASS",
      "evidence": "capture-mobile/android-phone-cn-en-identifier-default.png",
      "baseline": {
        "source": "capture-mobile",
        "ref": "android-phone cn en default login screenshot"
      },
      "reviewer": "exec-d/capture",
      "approvedAt": "2026-07-21"
    },
    "mobile.slogan.style|android-phone|en|global": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "PR4a 派工包集中批捕预案:合并门=--preview-slice 无 schema 错误;全格实拍证据由后续验收批次(双 AI 验收/QA)补录,--final 前必须清零"
    },
    "mobile.slogan.style|android-phone|ja|cn": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "PR4a 派工包集中批捕预案:合并门=--preview-slice 无 schema 错误;全格实拍证据由后续验收批次(双 AI 验收/QA)补录,--final 前必须清零"
    },
    "mobile.slogan.style|android-phone|ja|global": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "PR4a 派工包集中批捕预案:合并门=--preview-slice 无 schema 错误;全格实拍证据由后续验收批次(双 AI 验收/QA)补录,--final 前必须清零"
    },
    "mobile.slogan.style|android-phone|ko|cn": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "PR4a 派工包集中批捕预案:合并门=--preview-slice 无 schema 错误;全格实拍证据由后续验收批次(双 AI 验收/QA)补录,--final 前必须清零"
    },
    "mobile.slogan.style|android-phone|ko|global": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "PR4a 派工包集中批捕预案:合并门=--preview-slice 无 schema 错误;全格实拍证据由后续验收批次(双 AI 验收/QA)补录,--final 前必须清零"
    },
    "mobile.slogan.style|ipad|zh-CN|cn": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "PR4a 派工包集中批捕预案:合并门=--preview-slice 无 schema 错误;全格实拍证据由后续验收批次(双 AI 验收/QA)补录,--final 前必须清零"
    },
    "mobile.slogan.style|ipad|zh-CN|global": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "PR4a 派工包集中批捕预案:合并门=--preview-slice 无 schema 错误;全格实拍证据由后续验收批次(双 AI 验收/QA)补录,--final 前必须清零"
    },
    "mobile.slogan.style|ipad|zh-TW|cn": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "PR4a 派工包集中批捕预案:合并门=--preview-slice 无 schema 错误;全格实拍证据由后续验收批次(双 AI 验收/QA)补录,--final 前必须清零"
    },
    "mobile.slogan.style|ipad|zh-TW|global": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "PR4a 派工包集中批捕预案:合并门=--preview-slice 无 schema 错误;全格实拍证据由后续验收批次(双 AI 验收/QA)补录,--final 前必须清零"
    },
    "mobile.slogan.style|ipad|en|cn": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "PR4a 派工包集中批捕预案:合并门=--preview-slice 无 schema 错误;全格实拍证据由后续验收批次(双 AI 验收/QA)补录,--final 前必须清零"
    },
    "mobile.slogan.style|ipad|en|global": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "PR4a 派工包集中批捕预案:合并门=--preview-slice 无 schema 错误;全格实拍证据由后续验收批次(双 AI 验收/QA)补录,--final 前必须清零"
    },
    "mobile.slogan.style|ipad|ja|cn": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "PR4a 派工包集中批捕预案:合并门=--preview-slice 无 schema 错误;全格实拍证据由后续验收批次(双 AI 验收/QA)补录,--final 前必须清零"
    },
    "mobile.slogan.style|ipad|ja|global": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "PR4a 派工包集中批捕预案:合并门=--preview-slice 无 schema 错误;全格实拍证据由后续验收批次(双 AI 验收/QA)补录,--final 前必须清零"
    },
    "mobile.slogan.style|ipad|ko|cn": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "PR4a 派工包集中批捕预案:合并门=--preview-slice 无 schema 错误;全格实拍证据由后续验收批次(双 AI 验收/QA)补录,--final 前必须清零"
    },
    "mobile.slogan.style|ipad|ko|global": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "PR4a 派工包集中批捕预案:合并门=--preview-slice 无 schema 错误;全格实拍证据由后续验收批次(双 AI 验收/QA)补录,--final 前必须清零"
    },
    "mobile.slogan.style|android-pad|zh-CN|cn": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "PR4a 派工包集中批捕预案:合并门=--preview-slice 无 schema 错误;全格实拍证据由后续验收批次(双 AI 验收/QA)补录,--final 前必须清零"
    },
    "mobile.slogan.style|android-pad|zh-CN|global": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "PR4a 派工包集中批捕预案:合并门=--preview-slice 无 schema 错误;全格实拍证据由后续验收批次(双 AI 验收/QA)补录,--final 前必须清零"
    },
    "mobile.slogan.style|android-pad|zh-TW|cn": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "PR4a 派工包集中批捕预案:合并门=--preview-slice 无 schema 错误;全格实拍证据由后续验收批次(双 AI 验收/QA)补录,--final 前必须清零"
    },
    "mobile.slogan.style|android-pad|zh-TW|global": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "PR4a 派工包集中批捕预案:合并门=--preview-slice 无 schema 错误;全格实拍证据由后续验收批次(双 AI 验收/QA)补录,--final 前必须清零"
    },
    "mobile.slogan.style|android-pad|en|cn": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "PR4a 派工包集中批捕预案:合并门=--preview-slice 无 schema 错误;全格实拍证据由后续验收批次(双 AI 验收/QA)补录,--final 前必须清零"
    },
    "mobile.slogan.style|android-pad|en|global": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "PR4a 派工包集中批捕预案:合并门=--preview-slice 无 schema 错误;全格实拍证据由后续验收批次(双 AI 验收/QA)补录,--final 前必须清零"
    },
    "mobile.slogan.style|android-pad|ja|cn": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "PR4a 派工包集中批捕预案:合并门=--preview-slice 无 schema 错误;全格实拍证据由后续验收批次(双 AI 验收/QA)补录,--final 前必须清零"
    },
    "mobile.slogan.style|android-pad|ja|global": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "PR4a 派工包集中批捕预案:合并门=--preview-slice 无 schema 错误;全格实拍证据由后续验收批次(双 AI 验收/QA)补录,--final 前必须清零"
    },
    "mobile.slogan.style|android-pad|ko|cn": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "PR4a 派工包集中批捕预案:合并门=--preview-slice 无 schema 错误;全格实拍证据由后续验收批次(双 AI 验收/QA)补录,--final 前必须清零"
    },
    "mobile.slogan.style|android-pad|ko|global": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "PR4a 派工包集中批捕预案:合并门=--preview-slice 无 schema 错误;全格实拍证据由后续验收批次(双 AI 验收/QA)补录,--final 前必须清零"
    },
    "mobile.slogan.geometry|iphone|zh-CN|cn": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "PR4a 派工包集中批捕预案:合并门=--preview-slice 无 schema 错误;全格实拍证据由后续验收批次(双 AI 验收/QA)补录,--final 前必须清零"
    },
    "mobile.slogan.geometry|iphone|zh-CN|global": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "PR4a 派工包集中批捕预案:合并门=--preview-slice 无 schema 错误;全格实拍证据由后续验收批次(双 AI 验收/QA)补录,--final 前必须清零"
    },
    "mobile.slogan.geometry|iphone|zh-TW|cn": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "PR4a 派工包集中批捕预案:合并门=--preview-slice 无 schema 错误;全格实拍证据由后续验收批次(双 AI 验收/QA)补录,--final 前必须清零"
    },
    "mobile.slogan.geometry|iphone|zh-TW|global": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "PR4a 派工包集中批捕预案:合并门=--preview-slice 无 schema 错误;全格实拍证据由后续验收批次(双 AI 验收/QA)补录,--final 前必须清零"
    },
    "mobile.slogan.geometry|iphone|en|cn": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "PR4a 派工包集中批捕预案:合并门=--preview-slice 无 schema 错误;全格实拍证据由后续验收批次(双 AI 验收/QA)补录,--final 前必须清零"
    },
    "mobile.slogan.geometry|iphone|en|global": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "PR4a 派工包集中批捕预案:合并门=--preview-slice 无 schema 错误;全格实拍证据由后续验收批次(双 AI 验收/QA)补录,--final 前必须清零"
    },
    "mobile.slogan.geometry|iphone|ja|cn": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "PR4a 派工包集中批捕预案:合并门=--preview-slice 无 schema 错误;全格实拍证据由后续验收批次(双 AI 验收/QA)补录,--final 前必须清零"
    },
    "mobile.slogan.geometry|iphone|ja|global": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "PR4a 派工包集中批捕预案:合并门=--preview-slice 无 schema 错误;全格实拍证据由后续验收批次(双 AI 验收/QA)补录,--final 前必须清零"
    },
    "mobile.slogan.geometry|iphone|ko|cn": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "PR4a 派工包集中批捕预案:合并门=--preview-slice 无 schema 错误;全格实拍证据由后续验收批次(双 AI 验收/QA)补录,--final 前必须清零"
    },
    "mobile.slogan.geometry|iphone|ko|global": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "PR4a 派工包集中批捕预案:合并门=--preview-slice 无 schema 错误;全格实拍证据由后续验收批次(双 AI 验收/QA)补录,--final 前必须清零"
    },
    "mobile.slogan.geometry|android-phone|zh-CN|cn": {
      "value": "PASS",
      "evidence": "pr4a/android-phone-cn-zhCN-identifier.png",
      "baseline": {
        "source": "demo",
        "ref": "旧移动帧 SLOGAN 几何沿旧(长屏 387,686,321×92 等,几何行=沿旧)"
      },
      "reviewer": "exec-c/PR4a",
      "approvedAt": "2026-07-20"
    },
    "mobile.slogan.geometry|android-phone|zh-CN|global": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "PR4a 派工包集中批捕预案:合并门=--preview-slice 无 schema 错误;全格实拍证据由后续验收批次(双 AI 验收/QA)补录,--final 前必须清零"
    },
    "mobile.slogan.geometry|android-phone|zh-TW|cn": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "PR4a 派工包集中批捕预案:合并门=--preview-slice 无 schema 错误;全格实拍证据由后续验收批次(双 AI 验收/QA)补录,--final 前必须清零"
    },
    "mobile.slogan.geometry|android-phone|zh-TW|global": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "PR4a 派工包集中批捕预案:合并门=--preview-slice 无 schema 错误;全格实拍证据由后续验收批次(双 AI 验收/QA)补录,--final 前必须清零"
    },
    "mobile.slogan.geometry|android-phone|en|cn": {
      "value": "PASS",
      "evidence": "capture-mobile/android-phone-cn-en-identifier-default.png",
      "baseline": {
        "source": "capture-mobile",
        "ref": "android-phone cn en default login screenshot"
      },
      "reviewer": "exec-d/capture",
      "approvedAt": "2026-07-21"
    },
    "mobile.slogan.geometry|android-phone|en|global": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "PR4a 派工包集中批捕预案:合并门=--preview-slice 无 schema 错误;全格实拍证据由后续验收批次(双 AI 验收/QA)补录,--final 前必须清零"
    },
    "mobile.slogan.geometry|android-phone|ja|cn": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "PR4a 派工包集中批捕预案:合并门=--preview-slice 无 schema 错误;全格实拍证据由后续验收批次(双 AI 验收/QA)补录,--final 前必须清零"
    },
    "mobile.slogan.geometry|android-phone|ja|global": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "PR4a 派工包集中批捕预案:合并门=--preview-slice 无 schema 错误;全格实拍证据由后续验收批次(双 AI 验收/QA)补录,--final 前必须清零"
    },
    "mobile.slogan.geometry|android-phone|ko|cn": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "PR4a 派工包集中批捕预案:合并门=--preview-slice 无 schema 错误;全格实拍证据由后续验收批次(双 AI 验收/QA)补录,--final 前必须清零"
    },
    "mobile.slogan.geometry|android-phone|ko|global": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "PR4a 派工包集中批捕预案:合并门=--preview-slice 无 schema 错误;全格实拍证据由后续验收批次(双 AI 验收/QA)补录,--final 前必须清零"
    },
    "mobile.slogan.geometry|ipad|zh-CN|cn": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "PR4a 派工包集中批捕预案:合并门=--preview-slice 无 schema 错误;全格实拍证据由后续验收批次(双 AI 验收/QA)补录,--final 前必须清零"
    },
    "mobile.slogan.geometry|ipad|zh-CN|global": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "PR4a 派工包集中批捕预案:合并门=--preview-slice 无 schema 错误;全格实拍证据由后续验收批次(双 AI 验收/QA)补录,--final 前必须清零"
    },
    "mobile.slogan.geometry|ipad|zh-TW|cn": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "PR4a 派工包集中批捕预案:合并门=--preview-slice 无 schema 错误;全格实拍证据由后续验收批次(双 AI 验收/QA)补录,--final 前必须清零"
    },
    "mobile.slogan.geometry|ipad|zh-TW|global": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "PR4a 派工包集中批捕预案:合并门=--preview-slice 无 schema 错误;全格实拍证据由后续验收批次(双 AI 验收/QA)补录,--final 前必须清零"
    },
    "mobile.slogan.geometry|ipad|en|cn": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "PR4a 派工包集中批捕预案:合并门=--preview-slice 无 schema 错误;全格实拍证据由后续验收批次(双 AI 验收/QA)补录,--final 前必须清零"
    },
    "mobile.slogan.geometry|ipad|en|global": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "PR4a 派工包集中批捕预案:合并门=--preview-slice 无 schema 错误;全格实拍证据由后续验收批次(双 AI 验收/QA)补录,--final 前必须清零"
    },
    "mobile.slogan.geometry|ipad|ja|cn": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "PR4a 派工包集中批捕预案:合并门=--preview-slice 无 schema 错误;全格实拍证据由后续验收批次(双 AI 验收/QA)补录,--final 前必须清零"
    },
    "mobile.slogan.geometry|ipad|ja|global": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "PR4a 派工包集中批捕预案:合并门=--preview-slice 无 schema 错误;全格实拍证据由后续验收批次(双 AI 验收/QA)补录,--final 前必须清零"
    },
    "mobile.slogan.geometry|ipad|ko|cn": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "PR4a 派工包集中批捕预案:合并门=--preview-slice 无 schema 错误;全格实拍证据由后续验收批次(双 AI 验收/QA)补录,--final 前必须清零"
    },
    "mobile.slogan.geometry|ipad|ko|global": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "PR4a 派工包集中批捕预案:合并门=--preview-slice 无 schema 错误;全格实拍证据由后续验收批次(双 AI 验收/QA)补录,--final 前必须清零"
    },
    "mobile.slogan.geometry|android-pad|zh-CN|cn": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "PR4a 派工包集中批捕预案:合并门=--preview-slice 无 schema 错误;全格实拍证据由后续验收批次(双 AI 验收/QA)补录,--final 前必须清零"
    },
    "mobile.slogan.geometry|android-pad|zh-CN|global": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "PR4a 派工包集中批捕预案:合并门=--preview-slice 无 schema 错误;全格实拍证据由后续验收批次(双 AI 验收/QA)补录,--final 前必须清零"
    },
    "mobile.slogan.geometry|android-pad|zh-TW|cn": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "PR4a 派工包集中批捕预案:合并门=--preview-slice 无 schema 错误;全格实拍证据由后续验收批次(双 AI 验收/QA)补录,--final 前必须清零"
    },
    "mobile.slogan.geometry|android-pad|zh-TW|global": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "PR4a 派工包集中批捕预案:合并门=--preview-slice 无 schema 错误;全格实拍证据由后续验收批次(双 AI 验收/QA)补录,--final 前必须清零"
    },
    "mobile.slogan.geometry|android-pad|en|cn": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "PR4a 派工包集中批捕预案:合并门=--preview-slice 无 schema 错误;全格实拍证据由后续验收批次(双 AI 验收/QA)补录,--final 前必须清零"
    },
    "mobile.slogan.geometry|android-pad|en|global": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "PR4a 派工包集中批捕预案:合并门=--preview-slice 无 schema 错误;全格实拍证据由后续验收批次(双 AI 验收/QA)补录,--final 前必须清零"
    },
    "mobile.slogan.geometry|android-pad|ja|cn": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "PR4a 派工包集中批捕预案:合并门=--preview-slice 无 schema 错误;全格实拍证据由后续验收批次(双 AI 验收/QA)补录,--final 前必须清零"
    },
    "mobile.slogan.geometry|android-pad|ja|global": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "PR4a 派工包集中批捕预案:合并门=--preview-slice 无 schema 错误;全格实拍证据由后续验收批次(双 AI 验收/QA)补录,--final 前必须清零"
    },
    "mobile.slogan.geometry|android-pad|ko|cn": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "PR4a 派工包集中批捕预案:合并门=--preview-slice 无 schema 错误;全格实拍证据由后续验收批次(双 AI 验收/QA)补录,--final 前必须清零"
    },
    "mobile.slogan.geometry|android-pad|ko|global": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "PR4a 派工包集中批捕预案:合并门=--preview-slice 无 schema 错误;全格实拍证据由后续验收批次(双 AI 验收/QA)补录,--final 前必须清零"
    },
    "mobile.identifier.state|iphone|zh-CN|cn": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "PR4a 派工包集中批捕预案:合并门=--preview-slice 无 schema 错误;全格实拍证据由后续验收批次(双 AI 验收/QA)补录,--final 前必须清零"
    },
    "mobile.identifier.state|iphone|zh-CN|global": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "PR4a 派工包集中批捕预案:合并门=--preview-slice 无 schema 错误;全格实拍证据由后续验收批次(双 AI 验收/QA)补录,--final 前必须清零"
    },
    "mobile.identifier.state|iphone|zh-TW|cn": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "PR4a 派工包集中批捕预案:合并门=--preview-slice 无 schema 错误;全格实拍证据由后续验收批次(双 AI 验收/QA)补录,--final 前必须清零"
    },
    "mobile.identifier.state|iphone|zh-TW|global": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "PR4a 派工包集中批捕预案:合并门=--preview-slice 无 schema 错误;全格实拍证据由后续验收批次(双 AI 验收/QA)补录,--final 前必须清零"
    },
    "mobile.identifier.state|iphone|en|cn": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "PR4a 派工包集中批捕预案:合并门=--preview-slice 无 schema 错误;全格实拍证据由后续验收批次(双 AI 验收/QA)补录,--final 前必须清零"
    },
    "mobile.identifier.state|iphone|en|global": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "PR4a 派工包集中批捕预案:合并门=--preview-slice 无 schema 错误;全格实拍证据由后续验收批次(双 AI 验收/QA)补录,--final 前必须清零"
    },
    "mobile.identifier.state|iphone|ja|cn": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "PR4a 派工包集中批捕预案:合并门=--preview-slice 无 schema 错误;全格实拍证据由后续验收批次(双 AI 验收/QA)补录,--final 前必须清零"
    },
    "mobile.identifier.state|iphone|ja|global": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "PR4a 派工包集中批捕预案:合并门=--preview-slice 无 schema 错误;全格实拍证据由后续验收批次(双 AI 验收/QA)补录,--final 前必须清零"
    },
    "mobile.identifier.state|iphone|ko|cn": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "PR4a 派工包集中批捕预案:合并门=--preview-slice 无 schema 错误;全格实拍证据由后续验收批次(双 AI 验收/QA)补录,--final 前必须清零"
    },
    "mobile.identifier.state|iphone|ko|global": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "PR4a 派工包集中批捕预案:合并门=--preview-slice 无 schema 错误;全格实拍证据由后续验收批次(双 AI 验收/QA)补录,--final 前必须清零"
    },
    "mobile.identifier.state|android-phone|zh-CN|cn": {
      "value": "PASS",
      "evidence": "pr4a/android-phone-cn-zhCN-identifier.png",
      "baseline": {
        "source": "demo",
        "ref": "demo 状态「identifier」(mobile surface)"
      },
      "reviewer": "exec-c/PR4a",
      "approvedAt": "2026-07-20"
    },
    "mobile.identifier.state|android-phone|zh-CN|global": {
      "value": "PASS",
      "evidence": "pr4a/android-phone-global-zhCN-identifier.png",
      "baseline": {
        "source": "demo",
        "ref": "demo 状态「identifier」(mobile surface)"
      },
      "reviewer": "exec-c/PR4a",
      "approvedAt": "2026-07-20"
    },
    "mobile.identifier.state|android-phone|zh-TW|cn": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "PR4a 派工包集中批捕预案:合并门=--preview-slice 无 schema 错误;全格实拍证据由后续验收批次(双 AI 验收/QA)补录,--final 前必须清零"
    },
    "mobile.identifier.state|android-phone|zh-TW|global": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "PR4a 派工包集中批捕预案:合并门=--preview-slice 无 schema 错误;全格实拍证据由后续验收批次(双 AI 验收/QA)补录,--final 前必须清零"
    },
    "mobile.identifier.state|android-phone|en|cn": {
      "value": "PASS",
      "evidence": "pr4a/android-phone-cn-en-identifier.png",
      "baseline": {
        "source": "demo",
        "ref": "demo 状态「identifier」(mobile surface)"
      },
      "reviewer": "exec-c/PR4a",
      "approvedAt": "2026-07-20"
    },
    "mobile.identifier.state|android-phone|en|global": {
      "value": "PASS",
      "evidence": "pr4a/android-phone-global-en-identifier.png",
      "baseline": {
        "source": "demo",
        "ref": "demo 状态「identifier」(mobile surface)"
      },
      "reviewer": "exec-c/PR4a",
      "approvedAt": "2026-07-20"
    },
    "mobile.identifier.state|android-phone|ja|cn": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "PR4a 派工包集中批捕预案:合并门=--preview-slice 无 schema 错误;全格实拍证据由后续验收批次(双 AI 验收/QA)补录,--final 前必须清零"
    },
    "mobile.identifier.state|android-phone|ja|global": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "PR4a 派工包集中批捕预案:合并门=--preview-slice 无 schema 错误;全格实拍证据由后续验收批次(双 AI 验收/QA)补录,--final 前必须清零"
    },
    "mobile.identifier.state|android-phone|ko|cn": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "PR4a 派工包集中批捕预案:合并门=--preview-slice 无 schema 错误;全格实拍证据由后续验收批次(双 AI 验收/QA)补录,--final 前必须清零"
    },
    "mobile.identifier.state|android-phone|ko|global": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "PR4a 派工包集中批捕预案:合并门=--preview-slice 无 schema 错误;全格实拍证据由后续验收批次(双 AI 验收/QA)补录,--final 前必须清零"
    },
    "mobile.identifier.state|ipad|zh-CN|cn": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "PR4a 派工包集中批捕预案:合并门=--preview-slice 无 schema 错误;全格实拍证据由后续验收批次(双 AI 验收/QA)补录,--final 前必须清零"
    },
    "mobile.identifier.state|ipad|zh-CN|global": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "PR4a 派工包集中批捕预案:合并门=--preview-slice 无 schema 错误;全格实拍证据由后续验收批次(双 AI 验收/QA)补录,--final 前必须清零"
    },
    "mobile.identifier.state|ipad|zh-TW|cn": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "PR4a 派工包集中批捕预案:合并门=--preview-slice 无 schema 错误;全格实拍证据由后续验收批次(双 AI 验收/QA)补录,--final 前必须清零"
    },
    "mobile.identifier.state|ipad|zh-TW|global": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "PR4a 派工包集中批捕预案:合并门=--preview-slice 无 schema 错误;全格实拍证据由后续验收批次(双 AI 验收/QA)补录,--final 前必须清零"
    },
    "mobile.identifier.state|ipad|en|cn": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "PR4a 派工包集中批捕预案:合并门=--preview-slice 无 schema 错误;全格实拍证据由后续验收批次(双 AI 验收/QA)补录,--final 前必须清零"
    },
    "mobile.identifier.state|ipad|en|global": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "PR4a 派工包集中批捕预案:合并门=--preview-slice 无 schema 错误;全格实拍证据由后续验收批次(双 AI 验收/QA)补录,--final 前必须清零"
    },
    "mobile.identifier.state|ipad|ja|cn": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "PR4a 派工包集中批捕预案:合并门=--preview-slice 无 schema 错误;全格实拍证据由后续验收批次(双 AI 验收/QA)补录,--final 前必须清零"
    },
    "mobile.identifier.state|ipad|ja|global": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "PR4a 派工包集中批捕预案:合并门=--preview-slice 无 schema 错误;全格实拍证据由后续验收批次(双 AI 验收/QA)补录,--final 前必须清零"
    },
    "mobile.identifier.state|ipad|ko|cn": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "PR4a 派工包集中批捕预案:合并门=--preview-slice 无 schema 错误;全格实拍证据由后续验收批次(双 AI 验收/QA)补录,--final 前必须清零"
    },
    "mobile.identifier.state|ipad|ko|global": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "PR4a 派工包集中批捕预案:合并门=--preview-slice 无 schema 错误;全格实拍证据由后续验收批次(双 AI 验收/QA)补录,--final 前必须清零"
    },
    "mobile.identifier.state|android-pad|zh-CN|cn": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "PR4a 派工包集中批捕预案:合并门=--preview-slice 无 schema 错误;全格实拍证据由后续验收批次(双 AI 验收/QA)补录,--final 前必须清零"
    },
    "mobile.identifier.state|android-pad|zh-CN|global": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "PR4a 派工包集中批捕预案:合并门=--preview-slice 无 schema 错误;全格实拍证据由后续验收批次(双 AI 验收/QA)补录,--final 前必须清零"
    },
    "mobile.identifier.state|android-pad|zh-TW|cn": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "PR4a 派工包集中批捕预案:合并门=--preview-slice 无 schema 错误;全格实拍证据由后续验收批次(双 AI 验收/QA)补录,--final 前必须清零"
    },
    "mobile.identifier.state|android-pad|zh-TW|global": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "PR4a 派工包集中批捕预案:合并门=--preview-slice 无 schema 错误;全格实拍证据由后续验收批次(双 AI 验收/QA)补录,--final 前必须清零"
    },
    "mobile.identifier.state|android-pad|en|cn": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "PR4a 派工包集中批捕预案:合并门=--preview-slice 无 schema 错误;全格实拍证据由后续验收批次(双 AI 验收/QA)补录,--final 前必须清零"
    },
    "mobile.identifier.state|android-pad|en|global": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "PR4a 派工包集中批捕预案:合并门=--preview-slice 无 schema 错误;全格实拍证据由后续验收批次(双 AI 验收/QA)补录,--final 前必须清零"
    },
    "mobile.identifier.state|android-pad|ja|cn": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "PR4a 派工包集中批捕预案:合并门=--preview-slice 无 schema 错误;全格实拍证据由后续验收批次(双 AI 验收/QA)补录,--final 前必须清零"
    },
    "mobile.identifier.state|android-pad|ja|global": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "PR4a 派工包集中批捕预案:合并门=--preview-slice 无 schema 错误;全格实拍证据由后续验收批次(双 AI 验收/QA)补录,--final 前必须清零"
    },
    "mobile.identifier.state|android-pad|ko|cn": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "PR4a 派工包集中批捕预案:合并门=--preview-slice 无 schema 错误;全格实拍证据由后续验收批次(双 AI 验收/QA)补录,--final 前必须清零"
    },
    "mobile.identifier.state|android-pad|ko|global": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "PR4a 派工包集中批捕预案:合并门=--preview-slice 无 schema 错误;全格实拍证据由后续验收批次(双 AI 验收/QA)补录,--final 前必须清零"
    },
    "mobile.identifier.input-state|iphone|zh-CN|cn": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "PR4a 派工包集中批捕预案:合并门=--preview-slice 无 schema 错误;全格实拍证据由后续验收批次(双 AI 验收/QA)补录,--final 前必须清零"
    },
    "mobile.identifier.input-state|iphone|zh-CN|global": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "PR4a 派工包集中批捕预案:合并门=--preview-slice 无 schema 错误;全格实拍证据由后续验收批次(双 AI 验收/QA)补录,--final 前必须清零"
    },
    "mobile.identifier.input-state|iphone|zh-TW|cn": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "PR4a 派工包集中批捕预案:合并门=--preview-slice 无 schema 错误;全格实拍证据由后续验收批次(双 AI 验收/QA)补录,--final 前必须清零"
    },
    "mobile.identifier.input-state|iphone|zh-TW|global": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "PR4a 派工包集中批捕预案:合并门=--preview-slice 无 schema 错误;全格实拍证据由后续验收批次(双 AI 验收/QA)补录,--final 前必须清零"
    },
    "mobile.identifier.input-state|iphone|en|cn": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "PR4a 派工包集中批捕预案:合并门=--preview-slice 无 schema 错误;全格实拍证据由后续验收批次(双 AI 验收/QA)补录,--final 前必须清零"
    },
    "mobile.identifier.input-state|iphone|en|global": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "PR4a 派工包集中批捕预案:合并门=--preview-slice 无 schema 错误;全格实拍证据由后续验收批次(双 AI 验收/QA)补录,--final 前必须清零"
    },
    "mobile.identifier.input-state|iphone|ja|cn": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "PR4a 派工包集中批捕预案:合并门=--preview-slice 无 schema 错误;全格实拍证据由后续验收批次(双 AI 验收/QA)补录,--final 前必须清零"
    },
    "mobile.identifier.input-state|iphone|ja|global": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "PR4a 派工包集中批捕预案:合并门=--preview-slice 无 schema 错误;全格实拍证据由后续验收批次(双 AI 验收/QA)补录,--final 前必须清零"
    },
    "mobile.identifier.input-state|iphone|ko|cn": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "PR4a 派工包集中批捕预案:合并门=--preview-slice 无 schema 错误;全格实拍证据由后续验收批次(双 AI 验收/QA)补录,--final 前必须清零"
    },
    "mobile.identifier.input-state|iphone|ko|global": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "PR4a 派工包集中批捕预案:合并门=--preview-slice 无 schema 错误;全格实拍证据由后续验收批次(双 AI 验收/QA)补录,--final 前必须清零"
    },
    "mobile.identifier.input-state|android-phone|zh-CN|cn": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "PR4a 派工包集中批捕预案:合并门=--preview-slice 无 schema 错误;全格实拍证据由后续验收批次(双 AI 验收/QA)补录,--final 前必须清零"
    },
    "mobile.identifier.input-state|android-phone|zh-CN|global": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "PR4a 派工包集中批捕预案:合并门=--preview-slice 无 schema 错误;全格实拍证据由后续验收批次(双 AI 验收/QA)补录,--final 前必须清零"
    },
    "mobile.identifier.input-state|android-phone|zh-TW|cn": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "PR4a 派工包集中批捕预案:合并门=--preview-slice 无 schema 错误;全格实拍证据由后续验收批次(双 AI 验收/QA)补录,--final 前必须清零"
    },
    "mobile.identifier.input-state|android-phone|zh-TW|global": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "PR4a 派工包集中批捕预案:合并门=--preview-slice 无 schema 错误;全格实拍证据由后续验收批次(双 AI 验收/QA)补录,--final 前必须清零"
    },
    "mobile.identifier.input-state|android-phone|en|cn": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "PR4a 派工包集中批捕预案:合并门=--preview-slice 无 schema 错误;全格实拍证据由后续验收批次(双 AI 验收/QA)补录,--final 前必须清零"
    },
    "mobile.identifier.input-state|android-phone|en|global": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "PR4a 派工包集中批捕预案:合并门=--preview-slice 无 schema 错误;全格实拍证据由后续验收批次(双 AI 验收/QA)补录,--final 前必须清零"
    },
    "mobile.identifier.input-state|android-phone|ja|cn": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "PR4a 派工包集中批捕预案:合并门=--preview-slice 无 schema 错误;全格实拍证据由后续验收批次(双 AI 验收/QA)补录,--final 前必须清零"
    },
    "mobile.identifier.input-state|android-phone|ja|global": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "PR4a 派工包集中批捕预案:合并门=--preview-slice 无 schema 错误;全格实拍证据由后续验收批次(双 AI 验收/QA)补录,--final 前必须清零"
    },
    "mobile.identifier.input-state|android-phone|ko|cn": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "PR4a 派工包集中批捕预案:合并门=--preview-slice 无 schema 错误;全格实拍证据由后续验收批次(双 AI 验收/QA)补录,--final 前必须清零"
    },
    "mobile.identifier.input-state|android-phone|ko|global": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "PR4a 派工包集中批捕预案:合并门=--preview-slice 无 schema 错误;全格实拍证据由后续验收批次(双 AI 验收/QA)补录,--final 前必须清零"
    },
    "mobile.identifier.input-state|ipad|zh-CN|cn": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "PR4a 派工包集中批捕预案:合并门=--preview-slice 无 schema 错误;全格实拍证据由后续验收批次(双 AI 验收/QA)补录,--final 前必须清零"
    },
    "mobile.identifier.input-state|ipad|zh-CN|global": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "PR4a 派工包集中批捕预案:合并门=--preview-slice 无 schema 错误;全格实拍证据由后续验收批次(双 AI 验收/QA)补录,--final 前必须清零"
    },
    "mobile.identifier.input-state|ipad|zh-TW|cn": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "PR4a 派工包集中批捕预案:合并门=--preview-slice 无 schema 错误;全格实拍证据由后续验收批次(双 AI 验收/QA)补录,--final 前必须清零"
    },
    "mobile.identifier.input-state|ipad|zh-TW|global": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "PR4a 派工包集中批捕预案:合并门=--preview-slice 无 schema 错误;全格实拍证据由后续验收批次(双 AI 验收/QA)补录,--final 前必须清零"
    },
    "mobile.identifier.input-state|ipad|en|cn": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "PR4a 派工包集中批捕预案:合并门=--preview-slice 无 schema 错误;全格实拍证据由后续验收批次(双 AI 验收/QA)补录,--final 前必须清零"
    },
    "mobile.identifier.input-state|ipad|en|global": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "PR4a 派工包集中批捕预案:合并门=--preview-slice 无 schema 错误;全格实拍证据由后续验收批次(双 AI 验收/QA)补录,--final 前必须清零"
    },
    "mobile.identifier.input-state|ipad|ja|cn": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "PR4a 派工包集中批捕预案:合并门=--preview-slice 无 schema 错误;全格实拍证据由后续验收批次(双 AI 验收/QA)补录,--final 前必须清零"
    },
    "mobile.identifier.input-state|ipad|ja|global": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "PR4a 派工包集中批捕预案:合并门=--preview-slice 无 schema 错误;全格实拍证据由后续验收批次(双 AI 验收/QA)补录,--final 前必须清零"
    },
    "mobile.identifier.input-state|ipad|ko|cn": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "PR4a 派工包集中批捕预案:合并门=--preview-slice 无 schema 错误;全格实拍证据由后续验收批次(双 AI 验收/QA)补录,--final 前必须清零"
    },
    "mobile.identifier.input-state|ipad|ko|global": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "PR4a 派工包集中批捕预案:合并门=--preview-slice 无 schema 错误;全格实拍证据由后续验收批次(双 AI 验收/QA)补录,--final 前必须清零"
    },
    "mobile.identifier.input-state|android-pad|zh-CN|cn": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "PR4a 派工包集中批捕预案:合并门=--preview-slice 无 schema 错误;全格实拍证据由后续验收批次(双 AI 验收/QA)补录,--final 前必须清零"
    },
    "mobile.identifier.input-state|android-pad|zh-CN|global": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "PR4a 派工包集中批捕预案:合并门=--preview-slice 无 schema 错误;全格实拍证据由后续验收批次(双 AI 验收/QA)补录,--final 前必须清零"
    },
    "mobile.identifier.input-state|android-pad|zh-TW|cn": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "PR4a 派工包集中批捕预案:合并门=--preview-slice 无 schema 错误;全格实拍证据由后续验收批次(双 AI 验收/QA)补录,--final 前必须清零"
    },
    "mobile.identifier.input-state|android-pad|zh-TW|global": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "PR4a 派工包集中批捕预案:合并门=--preview-slice 无 schema 错误;全格实拍证据由后续验收批次(双 AI 验收/QA)补录,--final 前必须清零"
    },
    "mobile.identifier.input-state|android-pad|en|cn": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "PR4a 派工包集中批捕预案:合并门=--preview-slice 无 schema 错误;全格实拍证据由后续验收批次(双 AI 验收/QA)补录,--final 前必须清零"
    },
    "mobile.identifier.input-state|android-pad|en|global": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "PR4a 派工包集中批捕预案:合并门=--preview-slice 无 schema 错误;全格实拍证据由后续验收批次(双 AI 验收/QA)补录,--final 前必须清零"
    },
    "mobile.identifier.input-state|android-pad|ja|cn": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "PR4a 派工包集中批捕预案:合并门=--preview-slice 无 schema 错误;全格实拍证据由后续验收批次(双 AI 验收/QA)补录,--final 前必须清零"
    },
    "mobile.identifier.input-state|android-pad|ja|global": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "PR4a 派工包集中批捕预案:合并门=--preview-slice 无 schema 错误;全格实拍证据由后续验收批次(双 AI 验收/QA)补录,--final 前必须清零"
    },
    "mobile.identifier.input-state|android-pad|ko|cn": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "PR4a 派工包集中批捕预案:合并门=--preview-slice 无 schema 错误;全格实拍证据由后续验收批次(双 AI 验收/QA)补录,--final 前必须清零"
    },
    "mobile.identifier.input-state|android-pad|ko|global": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "PR4a 派工包集中批捕预案:合并门=--preview-slice 无 schema 错误;全格实拍证据由后续验收批次(双 AI 验收/QA)补录,--final 前必须清零"
    },
    "mobile.method-choice.state|iphone|zh-CN|cn": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "PR4a 派工包集中批捕预案:合并门=--preview-slice 无 schema 错误;全格实拍证据由后续验收批次(双 AI 验收/QA)补录,--final 前必须清零"
    },
    "mobile.method-choice.state|iphone|zh-CN|global": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "PR4a 派工包集中批捕预案:合并门=--preview-slice 无 schema 错误;全格实拍证据由后续验收批次(双 AI 验收/QA)补录,--final 前必须清零"
    },
    "mobile.method-choice.state|iphone|zh-TW|cn": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "PR4a 派工包集中批捕预案:合并门=--preview-slice 无 schema 错误;全格实拍证据由后续验收批次(双 AI 验收/QA)补录,--final 前必须清零"
    },
    "mobile.method-choice.state|iphone|zh-TW|global": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "PR4a 派工包集中批捕预案:合并门=--preview-slice 无 schema 错误;全格实拍证据由后续验收批次(双 AI 验收/QA)补录,--final 前必须清零"
    },
    "mobile.method-choice.state|iphone|en|cn": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "PR4a 派工包集中批捕预案:合并门=--preview-slice 无 schema 错误;全格实拍证据由后续验收批次(双 AI 验收/QA)补录,--final 前必须清零"
    },
    "mobile.method-choice.state|iphone|en|global": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "PR4a 派工包集中批捕预案:合并门=--preview-slice 无 schema 错误;全格实拍证据由后续验收批次(双 AI 验收/QA)补录,--final 前必须清零"
    },
    "mobile.method-choice.state|iphone|ja|cn": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "PR4a 派工包集中批捕预案:合并门=--preview-slice 无 schema 错误;全格实拍证据由后续验收批次(双 AI 验收/QA)补录,--final 前必须清零"
    },
    "mobile.method-choice.state|iphone|ja|global": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "PR4a 派工包集中批捕预案:合并门=--preview-slice 无 schema 错误;全格实拍证据由后续验收批次(双 AI 验收/QA)补录,--final 前必须清零"
    },
    "mobile.method-choice.state|iphone|ko|cn": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "PR4a 派工包集中批捕预案:合并门=--preview-slice 无 schema 错误;全格实拍证据由后续验收批次(双 AI 验收/QA)补录,--final 前必须清零"
    },
    "mobile.method-choice.state|iphone|ko|global": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "PR4a 派工包集中批捕预案:合并门=--preview-slice 无 schema 错误;全格实拍证据由后续验收批次(双 AI 验收/QA)补录,--final 前必须清零"
    },
    "mobile.method-choice.state|android-phone|zh-CN|cn": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "PR4a 派工包集中批捕预案:合并门=--preview-slice 无 schema 错误;全格实拍证据由后续验收批次(双 AI 验收/QA)补录,--final 前必须清零"
    },
    "mobile.method-choice.state|android-phone|zh-CN|global": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "PR4a 派工包集中批捕预案:合并门=--preview-slice 无 schema 错误;全格实拍证据由后续验收批次(双 AI 验收/QA)补录,--final 前必须清零"
    },
    "mobile.method-choice.state|android-phone|zh-TW|cn": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "PR4a 派工包集中批捕预案:合并门=--preview-slice 无 schema 错误;全格实拍证据由后续验收批次(双 AI 验收/QA)补录,--final 前必须清零"
    },
    "mobile.method-choice.state|android-phone|zh-TW|global": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "PR4a 派工包集中批捕预案:合并门=--preview-slice 无 schema 错误;全格实拍证据由后续验收批次(双 AI 验收/QA)补录,--final 前必须清零"
    },
    "mobile.method-choice.state|android-phone|en|cn": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "PR4a 派工包集中批捕预案:合并门=--preview-slice 无 schema 错误;全格实拍证据由后续验收批次(双 AI 验收/QA)补录,--final 前必须清零"
    },
    "mobile.method-choice.state|android-phone|en|global": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "PR4a 派工包集中批捕预案:合并门=--preview-slice 无 schema 错误;全格实拍证据由后续验收批次(双 AI 验收/QA)补录,--final 前必须清零"
    },
    "mobile.method-choice.state|android-phone|ja|cn": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "PR4a 派工包集中批捕预案:合并门=--preview-slice 无 schema 错误;全格实拍证据由后续验收批次(双 AI 验收/QA)补录,--final 前必须清零"
    },
    "mobile.method-choice.state|android-phone|ja|global": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "PR4a 派工包集中批捕预案:合并门=--preview-slice 无 schema 错误;全格实拍证据由后续验收批次(双 AI 验收/QA)补录,--final 前必须清零"
    },
    "mobile.method-choice.state|android-phone|ko|cn": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "PR4a 派工包集中批捕预案:合并门=--preview-slice 无 schema 错误;全格实拍证据由后续验收批次(双 AI 验收/QA)补录,--final 前必须清零"
    },
    "mobile.method-choice.state|android-phone|ko|global": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "PR4a 派工包集中批捕预案:合并门=--preview-slice 无 schema 错误;全格实拍证据由后续验收批次(双 AI 验收/QA)补录,--final 前必须清零"
    },
    "mobile.method-choice.state|ipad|zh-CN|cn": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "PR4a 派工包集中批捕预案:合并门=--preview-slice 无 schema 错误;全格实拍证据由后续验收批次(双 AI 验收/QA)补录,--final 前必须清零"
    },
    "mobile.method-choice.state|ipad|zh-CN|global": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "PR4a 派工包集中批捕预案:合并门=--preview-slice 无 schema 错误;全格实拍证据由后续验收批次(双 AI 验收/QA)补录,--final 前必须清零"
    },
    "mobile.method-choice.state|ipad|zh-TW|cn": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "PR4a 派工包集中批捕预案:合并门=--preview-slice 无 schema 错误;全格实拍证据由后续验收批次(双 AI 验收/QA)补录,--final 前必须清零"
    },
    "mobile.method-choice.state|ipad|zh-TW|global": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "PR4a 派工包集中批捕预案:合并门=--preview-slice 无 schema 错误;全格实拍证据由后续验收批次(双 AI 验收/QA)补录,--final 前必须清零"
    },
    "mobile.method-choice.state|ipad|en|cn": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "PR4a 派工包集中批捕预案:合并门=--preview-slice 无 schema 错误;全格实拍证据由后续验收批次(双 AI 验收/QA)补录,--final 前必须清零"
    },
    "mobile.method-choice.state|ipad|en|global": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "PR4a 派工包集中批捕预案:合并门=--preview-slice 无 schema 错误;全格实拍证据由后续验收批次(双 AI 验收/QA)补录,--final 前必须清零"
    },
    "mobile.method-choice.state|ipad|ja|cn": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "PR4a 派工包集中批捕预案:合并门=--preview-slice 无 schema 错误;全格实拍证据由后续验收批次(双 AI 验收/QA)补录,--final 前必须清零"
    },
    "mobile.method-choice.state|ipad|ja|global": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "PR4a 派工包集中批捕预案:合并门=--preview-slice 无 schema 错误;全格实拍证据由后续验收批次(双 AI 验收/QA)补录,--final 前必须清零"
    },
    "mobile.method-choice.state|ipad|ko|cn": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "PR4a 派工包集中批捕预案:合并门=--preview-slice 无 schema 错误;全格实拍证据由后续验收批次(双 AI 验收/QA)补录,--final 前必须清零"
    },
    "mobile.method-choice.state|ipad|ko|global": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "PR4a 派工包集中批捕预案:合并门=--preview-slice 无 schema 错误;全格实拍证据由后续验收批次(双 AI 验收/QA)补录,--final 前必须清零"
    },
    "mobile.method-choice.state|android-pad|zh-CN|cn": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "PR4a 派工包集中批捕预案:合并门=--preview-slice 无 schema 错误;全格实拍证据由后续验收批次(双 AI 验收/QA)补录,--final 前必须清零"
    },
    "mobile.method-choice.state|android-pad|zh-CN|global": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "PR4a 派工包集中批捕预案:合并门=--preview-slice 无 schema 错误;全格实拍证据由后续验收批次(双 AI 验收/QA)补录,--final 前必须清零"
    },
    "mobile.method-choice.state|android-pad|zh-TW|cn": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "PR4a 派工包集中批捕预案:合并门=--preview-slice 无 schema 错误;全格实拍证据由后续验收批次(双 AI 验收/QA)补录,--final 前必须清零"
    },
    "mobile.method-choice.state|android-pad|zh-TW|global": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "PR4a 派工包集中批捕预案:合并门=--preview-slice 无 schema 错误;全格实拍证据由后续验收批次(双 AI 验收/QA)补录,--final 前必须清零"
    },
    "mobile.method-choice.state|android-pad|en|cn": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "PR4a 派工包集中批捕预案:合并门=--preview-slice 无 schema 错误;全格实拍证据由后续验收批次(双 AI 验收/QA)补录,--final 前必须清零"
    },
    "mobile.method-choice.state|android-pad|en|global": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "PR4a 派工包集中批捕预案:合并门=--preview-slice 无 schema 错误;全格实拍证据由后续验收批次(双 AI 验收/QA)补录,--final 前必须清零"
    },
    "mobile.method-choice.state|android-pad|ja|cn": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "PR4a 派工包集中批捕预案:合并门=--preview-slice 无 schema 错误;全格实拍证据由后续验收批次(双 AI 验收/QA)补录,--final 前必须清零"
    },
    "mobile.method-choice.state|android-pad|ja|global": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "PR4a 派工包集中批捕预案:合并门=--preview-slice 无 schema 错误;全格实拍证据由后续验收批次(双 AI 验收/QA)补录,--final 前必须清零"
    },
    "mobile.method-choice.state|android-pad|ko|cn": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "PR4a 派工包集中批捕预案:合并门=--preview-slice 无 schema 错误;全格实拍证据由后续验收批次(双 AI 验收/QA)补录,--final 前必须清零"
    },
    "mobile.method-choice.state|android-pad|ko|global": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "PR4a 派工包集中批捕预案:合并门=--preview-slice 无 schema 错误;全格实拍证据由后续验收批次(双 AI 验收/QA)补录,--final 前必须清零"
    },
    "mobile.method-choice.multi-state|iphone|zh-CN|cn": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "PR4a 派工包集中批捕预案:合并门=--preview-slice 无 schema 错误;全格实拍证据由后续验收批次(双 AI 验收/QA)补录,--final 前必须清零"
    },
    "mobile.method-choice.multi-state|iphone|zh-CN|global": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "PR4a 派工包集中批捕预案:合并门=--preview-slice 无 schema 错误;全格实拍证据由后续验收批次(双 AI 验收/QA)补录,--final 前必须清零"
    },
    "mobile.method-choice.multi-state|iphone|zh-TW|cn": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "PR4a 派工包集中批捕预案:合并门=--preview-slice 无 schema 错误;全格实拍证据由后续验收批次(双 AI 验收/QA)补录,--final 前必须清零"
    },
    "mobile.method-choice.multi-state|iphone|zh-TW|global": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "PR4a 派工包集中批捕预案:合并门=--preview-slice 无 schema 错误;全格实拍证据由后续验收批次(双 AI 验收/QA)补录,--final 前必须清零"
    },
    "mobile.method-choice.multi-state|iphone|en|cn": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "PR4a 派工包集中批捕预案:合并门=--preview-slice 无 schema 错误;全格实拍证据由后续验收批次(双 AI 验收/QA)补录,--final 前必须清零"
    },
    "mobile.method-choice.multi-state|iphone|en|global": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "PR4a 派工包集中批捕预案:合并门=--preview-slice 无 schema 错误;全格实拍证据由后续验收批次(双 AI 验收/QA)补录,--final 前必须清零"
    },
    "mobile.method-choice.multi-state|iphone|ja|cn": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "PR4a 派工包集中批捕预案:合并门=--preview-slice 无 schema 错误;全格实拍证据由后续验收批次(双 AI 验收/QA)补录,--final 前必须清零"
    },
    "mobile.method-choice.multi-state|iphone|ja|global": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "PR4a 派工包集中批捕预案:合并门=--preview-slice 无 schema 错误;全格实拍证据由后续验收批次(双 AI 验收/QA)补录,--final 前必须清零"
    },
    "mobile.method-choice.multi-state|iphone|ko|cn": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "PR4a 派工包集中批捕预案:合并门=--preview-slice 无 schema 错误;全格实拍证据由后续验收批次(双 AI 验收/QA)补录,--final 前必须清零"
    },
    "mobile.method-choice.multi-state|iphone|ko|global": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "PR4a 派工包集中批捕预案:合并门=--preview-slice 无 schema 错误;全格实拍证据由后续验收批次(双 AI 验收/QA)补录,--final 前必须清零"
    },
    "mobile.method-choice.multi-state|android-phone|zh-CN|cn": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "PR4a 派工包集中批捕预案:合并门=--preview-slice 无 schema 错误;全格实拍证据由后续验收批次(双 AI 验收/QA)补录,--final 前必须清零"
    },
    "mobile.method-choice.multi-state|android-phone|zh-CN|global": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "PR4a 派工包集中批捕预案:合并门=--preview-slice 无 schema 错误;全格实拍证据由后续验收批次(双 AI 验收/QA)补录,--final 前必须清零"
    },
    "mobile.method-choice.multi-state|android-phone|zh-TW|cn": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "PR4a 派工包集中批捕预案:合并门=--preview-slice 无 schema 错误;全格实拍证据由后续验收批次(双 AI 验收/QA)补录,--final 前必须清零"
    },
    "mobile.method-choice.multi-state|android-phone|zh-TW|global": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "PR4a 派工包集中批捕预案:合并门=--preview-slice 无 schema 错误;全格实拍证据由后续验收批次(双 AI 验收/QA)补录,--final 前必须清零"
    },
    "mobile.method-choice.multi-state|android-phone|en|cn": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "PR4a 派工包集中批捕预案:合并门=--preview-slice 无 schema 错误;全格实拍证据由后续验收批次(双 AI 验收/QA)补录,--final 前必须清零"
    },
    "mobile.method-choice.multi-state|android-phone|en|global": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "PR4a 派工包集中批捕预案:合并门=--preview-slice 无 schema 错误;全格实拍证据由后续验收批次(双 AI 验收/QA)补录,--final 前必须清零"
    },
    "mobile.method-choice.multi-state|android-phone|ja|cn": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "PR4a 派工包集中批捕预案:合并门=--preview-slice 无 schema 错误;全格实拍证据由后续验收批次(双 AI 验收/QA)补录,--final 前必须清零"
    },
    "mobile.method-choice.multi-state|android-phone|ja|global": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "PR4a 派工包集中批捕预案:合并门=--preview-slice 无 schema 错误;全格实拍证据由后续验收批次(双 AI 验收/QA)补录,--final 前必须清零"
    },
    "mobile.method-choice.multi-state|android-phone|ko|cn": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "PR4a 派工包集中批捕预案:合并门=--preview-slice 无 schema 错误;全格实拍证据由后续验收批次(双 AI 验收/QA)补录,--final 前必须清零"
    },
    "mobile.method-choice.multi-state|android-phone|ko|global": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "PR4a 派工包集中批捕预案:合并门=--preview-slice 无 schema 错误;全格实拍证据由后续验收批次(双 AI 验收/QA)补录,--final 前必须清零"
    },
    "mobile.method-choice.multi-state|ipad|zh-CN|cn": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "PR4a 派工包集中批捕预案:合并门=--preview-slice 无 schema 错误;全格实拍证据由后续验收批次(双 AI 验收/QA)补录,--final 前必须清零"
    },
    "mobile.method-choice.multi-state|ipad|zh-CN|global": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "PR4a 派工包集中批捕预案:合并门=--preview-slice 无 schema 错误;全格实拍证据由后续验收批次(双 AI 验收/QA)补录,--final 前必须清零"
    },
    "mobile.method-choice.multi-state|ipad|zh-TW|cn": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "PR4a 派工包集中批捕预案:合并门=--preview-slice 无 schema 错误;全格实拍证据由后续验收批次(双 AI 验收/QA)补录,--final 前必须清零"
    },
    "mobile.method-choice.multi-state|ipad|zh-TW|global": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "PR4a 派工包集中批捕预案:合并门=--preview-slice 无 schema 错误;全格实拍证据由后续验收批次(双 AI 验收/QA)补录,--final 前必须清零"
    },
    "mobile.method-choice.multi-state|ipad|en|cn": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "PR4a 派工包集中批捕预案:合并门=--preview-slice 无 schema 错误;全格实拍证据由后续验收批次(双 AI 验收/QA)补录,--final 前必须清零"
    },
    "mobile.method-choice.multi-state|ipad|en|global": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "PR4a 派工包集中批捕预案:合并门=--preview-slice 无 schema 错误;全格实拍证据由后续验收批次(双 AI 验收/QA)补录,--final 前必须清零"
    },
    "mobile.method-choice.multi-state|ipad|ja|cn": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "PR4a 派工包集中批捕预案:合并门=--preview-slice 无 schema 错误;全格实拍证据由后续验收批次(双 AI 验收/QA)补录,--final 前必须清零"
    },
    "mobile.method-choice.multi-state|ipad|ja|global": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "PR4a 派工包集中批捕预案:合并门=--preview-slice 无 schema 错误;全格实拍证据由后续验收批次(双 AI 验收/QA)补录,--final 前必须清零"
    },
    "mobile.method-choice.multi-state|ipad|ko|cn": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "PR4a 派工包集中批捕预案:合并门=--preview-slice 无 schema 错误;全格实拍证据由后续验收批次(双 AI 验收/QA)补录,--final 前必须清零"
    },
    "mobile.method-choice.multi-state|ipad|ko|global": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "PR4a 派工包集中批捕预案:合并门=--preview-slice 无 schema 错误;全格实拍证据由后续验收批次(双 AI 验收/QA)补录,--final 前必须清零"
    },
    "mobile.method-choice.multi-state|android-pad|zh-CN|cn": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "PR4a 派工包集中批捕预案:合并门=--preview-slice 无 schema 错误;全格实拍证据由后续验收批次(双 AI 验收/QA)补录,--final 前必须清零"
    },
    "mobile.method-choice.multi-state|android-pad|zh-CN|global": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "PR4a 派工包集中批捕预案:合并门=--preview-slice 无 schema 错误;全格实拍证据由后续验收批次(双 AI 验收/QA)补录,--final 前必须清零"
    },
    "mobile.method-choice.multi-state|android-pad|zh-TW|cn": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "PR4a 派工包集中批捕预案:合并门=--preview-slice 无 schema 错误;全格实拍证据由后续验收批次(双 AI 验收/QA)补录,--final 前必须清零"
    },
    "mobile.method-choice.multi-state|android-pad|zh-TW|global": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "PR4a 派工包集中批捕预案:合并门=--preview-slice 无 schema 错误;全格实拍证据由后续验收批次(双 AI 验收/QA)补录,--final 前必须清零"
    },
    "mobile.method-choice.multi-state|android-pad|en|cn": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "PR4a 派工包集中批捕预案:合并门=--preview-slice 无 schema 错误;全格实拍证据由后续验收批次(双 AI 验收/QA)补录,--final 前必须清零"
    },
    "mobile.method-choice.multi-state|android-pad|en|global": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "PR4a 派工包集中批捕预案:合并门=--preview-slice 无 schema 错误;全格实拍证据由后续验收批次(双 AI 验收/QA)补录,--final 前必须清零"
    },
    "mobile.method-choice.multi-state|android-pad|ja|cn": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "PR4a 派工包集中批捕预案:合并门=--preview-slice 无 schema 错误;全格实拍证据由后续验收批次(双 AI 验收/QA)补录,--final 前必须清零"
    },
    "mobile.method-choice.multi-state|android-pad|ja|global": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "PR4a 派工包集中批捕预案:合并门=--preview-slice 无 schema 错误;全格实拍证据由后续验收批次(双 AI 验收/QA)补录,--final 前必须清零"
    },
    "mobile.method-choice.multi-state|android-pad|ko|cn": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "PR4a 派工包集中批捕预案:合并门=--preview-slice 无 schema 错误;全格实拍证据由后续验收批次(双 AI 验收/QA)补录,--final 前必须清零"
    },
    "mobile.method-choice.multi-state|android-pad|ko|global": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "PR4a 派工包集中批捕预案:合并门=--preview-slice 无 schema 错误;全格实拍证据由后续验收批次(双 AI 验收/QA)补录,--final 前必须清零"
    },
    "mobile.method-choice.personal-state|iphone|zh-CN|cn": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "PR4a 派工包集中批捕预案:合并门=--preview-slice 无 schema 错误;全格实拍证据由后续验收批次(双 AI 验收/QA)补录,--final 前必须清零"
    },
    "mobile.method-choice.personal-state|iphone|zh-CN|global": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "PR4a 派工包集中批捕预案:合并门=--preview-slice 无 schema 错误;全格实拍证据由后续验收批次(双 AI 验收/QA)补录,--final 前必须清零"
    },
    "mobile.method-choice.personal-state|iphone|zh-TW|cn": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "PR4a 派工包集中批捕预案:合并门=--preview-slice 无 schema 错误;全格实拍证据由后续验收批次(双 AI 验收/QA)补录,--final 前必须清零"
    },
    "mobile.method-choice.personal-state|iphone|zh-TW|global": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "PR4a 派工包集中批捕预案:合并门=--preview-slice 无 schema 错误;全格实拍证据由后续验收批次(双 AI 验收/QA)补录,--final 前必须清零"
    },
    "mobile.method-choice.personal-state|iphone|en|cn": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "PR4a 派工包集中批捕预案:合并门=--preview-slice 无 schema 错误;全格实拍证据由后续验收批次(双 AI 验收/QA)补录,--final 前必须清零"
    },
    "mobile.method-choice.personal-state|iphone|en|global": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "PR4a 派工包集中批捕预案:合并门=--preview-slice 无 schema 错误;全格实拍证据由后续验收批次(双 AI 验收/QA)补录,--final 前必须清零"
    },
    "mobile.method-choice.personal-state|iphone|ja|cn": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "PR4a 派工包集中批捕预案:合并门=--preview-slice 无 schema 错误;全格实拍证据由后续验收批次(双 AI 验收/QA)补录,--final 前必须清零"
    },
    "mobile.method-choice.personal-state|iphone|ja|global": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "PR4a 派工包集中批捕预案:合并门=--preview-slice 无 schema 错误;全格实拍证据由后续验收批次(双 AI 验收/QA)补录,--final 前必须清零"
    },
    "mobile.method-choice.personal-state|iphone|ko|cn": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "PR4a 派工包集中批捕预案:合并门=--preview-slice 无 schema 错误;全格实拍证据由后续验收批次(双 AI 验收/QA)补录,--final 前必须清零"
    },
    "mobile.method-choice.personal-state|iphone|ko|global": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "PR4a 派工包集中批捕预案:合并门=--preview-slice 无 schema 错误;全格实拍证据由后续验收批次(双 AI 验收/QA)补录,--final 前必须清零"
    },
    "mobile.method-choice.personal-state|android-phone|zh-CN|cn": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "PR4a 派工包集中批捕预案:合并门=--preview-slice 无 schema 错误;全格实拍证据由后续验收批次(双 AI 验收/QA)补录,--final 前必须清零"
    },
    "mobile.method-choice.personal-state|android-phone|zh-CN|global": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "PR4a 派工包集中批捕预案:合并门=--preview-slice 无 schema 错误;全格实拍证据由后续验收批次(双 AI 验收/QA)补录,--final 前必须清零"
    },
    "mobile.method-choice.personal-state|android-phone|zh-TW|cn": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "PR4a 派工包集中批捕预案:合并门=--preview-slice 无 schema 错误;全格实拍证据由后续验收批次(双 AI 验收/QA)补录,--final 前必须清零"
    },
    "mobile.method-choice.personal-state|android-phone|zh-TW|global": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "PR4a 派工包集中批捕预案:合并门=--preview-slice 无 schema 错误;全格实拍证据由后续验收批次(双 AI 验收/QA)补录,--final 前必须清零"
    },
    "mobile.method-choice.personal-state|android-phone|en|cn": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "PR4a 派工包集中批捕预案:合并门=--preview-slice 无 schema 错误;全格实拍证据由后续验收批次(双 AI 验收/QA)补录,--final 前必须清零"
    },
    "mobile.method-choice.personal-state|android-phone|en|global": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "PR4a 派工包集中批捕预案:合并门=--preview-slice 无 schema 错误;全格实拍证据由后续验收批次(双 AI 验收/QA)补录,--final 前必须清零"
    },
    "mobile.method-choice.personal-state|android-phone|ja|cn": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "PR4a 派工包集中批捕预案:合并门=--preview-slice 无 schema 错误;全格实拍证据由后续验收批次(双 AI 验收/QA)补录,--final 前必须清零"
    },
    "mobile.method-choice.personal-state|android-phone|ja|global": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "PR4a 派工包集中批捕预案:合并门=--preview-slice 无 schema 错误;全格实拍证据由后续验收批次(双 AI 验收/QA)补录,--final 前必须清零"
    },
    "mobile.method-choice.personal-state|android-phone|ko|cn": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "PR4a 派工包集中批捕预案:合并门=--preview-slice 无 schema 错误;全格实拍证据由后续验收批次(双 AI 验收/QA)补录,--final 前必须清零"
    },
    "mobile.method-choice.personal-state|android-phone|ko|global": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "PR4a 派工包集中批捕预案:合并门=--preview-slice 无 schema 错误;全格实拍证据由后续验收批次(双 AI 验收/QA)补录,--final 前必须清零"
    },
    "mobile.method-choice.personal-state|ipad|zh-CN|cn": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "PR4a 派工包集中批捕预案:合并门=--preview-slice 无 schema 错误;全格实拍证据由后续验收批次(双 AI 验收/QA)补录,--final 前必须清零"
    },
    "mobile.method-choice.personal-state|ipad|zh-CN|global": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "PR4a 派工包集中批捕预案:合并门=--preview-slice 无 schema 错误;全格实拍证据由后续验收批次(双 AI 验收/QA)补录,--final 前必须清零"
    },
    "mobile.method-choice.personal-state|ipad|zh-TW|cn": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "PR4a 派工包集中批捕预案:合并门=--preview-slice 无 schema 错误;全格实拍证据由后续验收批次(双 AI 验收/QA)补录,--final 前必须清零"
    },
    "mobile.method-choice.personal-state|ipad|zh-TW|global": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "PR4a 派工包集中批捕预案:合并门=--preview-slice 无 schema 错误;全格实拍证据由后续验收批次(双 AI 验收/QA)补录,--final 前必须清零"
    },
    "mobile.method-choice.personal-state|ipad|en|cn": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "PR4a 派工包集中批捕预案:合并门=--preview-slice 无 schema 错误;全格实拍证据由后续验收批次(双 AI 验收/QA)补录,--final 前必须清零"
    },
    "mobile.method-choice.personal-state|ipad|en|global": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "PR4a 派工包集中批捕预案:合并门=--preview-slice 无 schema 错误;全格实拍证据由后续验收批次(双 AI 验收/QA)补录,--final 前必须清零"
    },
    "mobile.method-choice.personal-state|ipad|ja|cn": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "PR4a 派工包集中批捕预案:合并门=--preview-slice 无 schema 错误;全格实拍证据由后续验收批次(双 AI 验收/QA)补录,--final 前必须清零"
    },
    "mobile.method-choice.personal-state|ipad|ja|global": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "PR4a 派工包集中批捕预案:合并门=--preview-slice 无 schema 错误;全格实拍证据由后续验收批次(双 AI 验收/QA)补录,--final 前必须清零"
    },
    "mobile.method-choice.personal-state|ipad|ko|cn": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "PR4a 派工包集中批捕预案:合并门=--preview-slice 无 schema 错误;全格实拍证据由后续验收批次(双 AI 验收/QA)补录,--final 前必须清零"
    },
    "mobile.method-choice.personal-state|ipad|ko|global": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "PR4a 派工包集中批捕预案:合并门=--preview-slice 无 schema 错误;全格实拍证据由后续验收批次(双 AI 验收/QA)补录,--final 前必须清零"
    },
    "mobile.method-choice.personal-state|android-pad|zh-CN|cn": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "PR4a 派工包集中批捕预案:合并门=--preview-slice 无 schema 错误;全格实拍证据由后续验收批次(双 AI 验收/QA)补录,--final 前必须清零"
    },
    "mobile.method-choice.personal-state|android-pad|zh-CN|global": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "PR4a 派工包集中批捕预案:合并门=--preview-slice 无 schema 错误;全格实拍证据由后续验收批次(双 AI 验收/QA)补录,--final 前必须清零"
    },
    "mobile.method-choice.personal-state|android-pad|zh-TW|cn": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "PR4a 派工包集中批捕预案:合并门=--preview-slice 无 schema 错误;全格实拍证据由后续验收批次(双 AI 验收/QA)补录,--final 前必须清零"
    },
    "mobile.method-choice.personal-state|android-pad|zh-TW|global": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "PR4a 派工包集中批捕预案:合并门=--preview-slice 无 schema 错误;全格实拍证据由后续验收批次(双 AI 验收/QA)补录,--final 前必须清零"
    },
    "mobile.method-choice.personal-state|android-pad|en|cn": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "PR4a 派工包集中批捕预案:合并门=--preview-slice 无 schema 错误;全格实拍证据由后续验收批次(双 AI 验收/QA)补录,--final 前必须清零"
    },
    "mobile.method-choice.personal-state|android-pad|en|global": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "PR4a 派工包集中批捕预案:合并门=--preview-slice 无 schema 错误;全格实拍证据由后续验收批次(双 AI 验收/QA)补录,--final 前必须清零"
    },
    "mobile.method-choice.personal-state|android-pad|ja|cn": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "PR4a 派工包集中批捕预案:合并门=--preview-slice 无 schema 错误;全格实拍证据由后续验收批次(双 AI 验收/QA)补录,--final 前必须清零"
    },
    "mobile.method-choice.personal-state|android-pad|ja|global": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "PR4a 派工包集中批捕预案:合并门=--preview-slice 无 schema 错误;全格实拍证据由后续验收批次(双 AI 验收/QA)补录,--final 前必须清零"
    },
    "mobile.method-choice.personal-state|android-pad|ko|cn": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "PR4a 派工包集中批捕预案:合并门=--preview-slice 无 schema 错误;全格实拍证据由后续验收批次(双 AI 验收/QA)补录,--final 前必须清零"
    },
    "mobile.method-choice.personal-state|android-pad|ko|global": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "PR4a 派工包集中批捕预案:合并门=--preview-slice 无 schema 错误;全格实拍证据由后续验收批次(双 AI 验收/QA)补录,--final 前必须清零"
    },
    "mobile.verification-code.empty-state|iphone|zh-CN|cn": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "PR4a 派工包集中批捕预案:合并门=--preview-slice 无 schema 错误;全格实拍证据由后续验收批次(双 AI 验收/QA)补录,--final 前必须清零"
    },
    "mobile.verification-code.empty-state|iphone|zh-CN|global": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "PR4a 派工包集中批捕预案:合并门=--preview-slice 无 schema 错误;全格实拍证据由后续验收批次(双 AI 验收/QA)补录,--final 前必须清零"
    },
    "mobile.verification-code.empty-state|iphone|zh-TW|cn": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "PR4a 派工包集中批捕预案:合并门=--preview-slice 无 schema 错误;全格实拍证据由后续验收批次(双 AI 验收/QA)补录,--final 前必须清零"
    },
    "mobile.verification-code.empty-state|iphone|zh-TW|global": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "PR4a 派工包集中批捕预案:合并门=--preview-slice 无 schema 错误;全格实拍证据由后续验收批次(双 AI 验收/QA)补录,--final 前必须清零"
    },
    "mobile.verification-code.empty-state|iphone|en|cn": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "PR4a 派工包集中批捕预案:合并门=--preview-slice 无 schema 错误;全格实拍证据由后续验收批次(双 AI 验收/QA)补录,--final 前必须清零"
    },
    "mobile.verification-code.empty-state|iphone|en|global": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "PR4a 派工包集中批捕预案:合并门=--preview-slice 无 schema 错误;全格实拍证据由后续验收批次(双 AI 验收/QA)补录,--final 前必须清零"
    },
    "mobile.verification-code.empty-state|iphone|ja|cn": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "PR4a 派工包集中批捕预案:合并门=--preview-slice 无 schema 错误;全格实拍证据由后续验收批次(双 AI 验收/QA)补录,--final 前必须清零"
    },
    "mobile.verification-code.empty-state|iphone|ja|global": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "PR4a 派工包集中批捕预案:合并门=--preview-slice 无 schema 错误;全格实拍证据由后续验收批次(双 AI 验收/QA)补录,--final 前必须清零"
    },
    "mobile.verification-code.empty-state|iphone|ko|cn": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "PR4a 派工包集中批捕预案:合并门=--preview-slice 无 schema 错误;全格实拍证据由后续验收批次(双 AI 验收/QA)补录,--final 前必须清零"
    },
    "mobile.verification-code.empty-state|iphone|ko|global": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "PR4a 派工包集中批捕预案:合并门=--preview-slice 无 schema 错误;全格实拍证据由后续验收批次(双 AI 验收/QA)补录,--final 前必须清零"
    },
    "mobile.verification-code.empty-state|android-phone|zh-CN|cn": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "PR4a 派工包集中批捕预案:合并门=--preview-slice 无 schema 错误;全格实拍证据由后续验收批次(双 AI 验收/QA)补录,--final 前必须清零"
    },
    "mobile.verification-code.empty-state|android-phone|zh-CN|global": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "PR4a 派工包集中批捕预案:合并门=--preview-slice 无 schema 错误;全格实拍证据由后续验收批次(双 AI 验收/QA)补录,--final 前必须清零"
    },
    "mobile.verification-code.empty-state|android-phone|zh-TW|cn": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "PR4a 派工包集中批捕预案:合并门=--preview-slice 无 schema 错误;全格实拍证据由后续验收批次(双 AI 验收/QA)补录,--final 前必须清零"
    },
    "mobile.verification-code.empty-state|android-phone|zh-TW|global": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "PR4a 派工包集中批捕预案:合并门=--preview-slice 无 schema 错误;全格实拍证据由后续验收批次(双 AI 验收/QA)补录,--final 前必须清零"
    },
    "mobile.verification-code.empty-state|android-phone|en|cn": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "PR4a 派工包集中批捕预案:合并门=--preview-slice 无 schema 错误;全格实拍证据由后续验收批次(双 AI 验收/QA)补录,--final 前必须清零"
    },
    "mobile.verification-code.empty-state|android-phone|en|global": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "PR4a 派工包集中批捕预案:合并门=--preview-slice 无 schema 错误;全格实拍证据由后续验收批次(双 AI 验收/QA)补录,--final 前必须清零"
    },
    "mobile.verification-code.empty-state|android-phone|ja|cn": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "PR4a 派工包集中批捕预案:合并门=--preview-slice 无 schema 错误;全格实拍证据由后续验收批次(双 AI 验收/QA)补录,--final 前必须清零"
    },
    "mobile.verification-code.empty-state|android-phone|ja|global": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "PR4a 派工包集中批捕预案:合并门=--preview-slice 无 schema 错误;全格实拍证据由后续验收批次(双 AI 验收/QA)补录,--final 前必须清零"
    },
    "mobile.verification-code.empty-state|android-phone|ko|cn": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "PR4a 派工包集中批捕预案:合并门=--preview-slice 无 schema 错误;全格实拍证据由后续验收批次(双 AI 验收/QA)补录,--final 前必须清零"
    },
    "mobile.verification-code.empty-state|android-phone|ko|global": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "PR4a 派工包集中批捕预案:合并门=--preview-slice 无 schema 错误;全格实拍证据由后续验收批次(双 AI 验收/QA)补录,--final 前必须清零"
    },
    "mobile.verification-code.empty-state|ipad|zh-CN|cn": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "PR4a 派工包集中批捕预案:合并门=--preview-slice 无 schema 错误;全格实拍证据由后续验收批次(双 AI 验收/QA)补录,--final 前必须清零"
    },
    "mobile.verification-code.empty-state|ipad|zh-CN|global": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "PR4a 派工包集中批捕预案:合并门=--preview-slice 无 schema 错误;全格实拍证据由后续验收批次(双 AI 验收/QA)补录,--final 前必须清零"
    },
    "mobile.verification-code.empty-state|ipad|zh-TW|cn": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "PR4a 派工包集中批捕预案:合并门=--preview-slice 无 schema 错误;全格实拍证据由后续验收批次(双 AI 验收/QA)补录,--final 前必须清零"
    },
    "mobile.verification-code.empty-state|ipad|zh-TW|global": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "PR4a 派工包集中批捕预案:合并门=--preview-slice 无 schema 错误;全格实拍证据由后续验收批次(双 AI 验收/QA)补录,--final 前必须清零"
    },
    "mobile.verification-code.empty-state|ipad|en|cn": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "PR4a 派工包集中批捕预案:合并门=--preview-slice 无 schema 错误;全格实拍证据由后续验收批次(双 AI 验收/QA)补录,--final 前必须清零"
    },
    "mobile.verification-code.empty-state|ipad|en|global": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "PR4a 派工包集中批捕预案:合并门=--preview-slice 无 schema 错误;全格实拍证据由后续验收批次(双 AI 验收/QA)补录,--final 前必须清零"
    },
    "mobile.verification-code.empty-state|ipad|ja|cn": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "PR4a 派工包集中批捕预案:合并门=--preview-slice 无 schema 错误;全格实拍证据由后续验收批次(双 AI 验收/QA)补录,--final 前必须清零"
    },
    "mobile.verification-code.empty-state|ipad|ja|global": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "PR4a 派工包集中批捕预案:合并门=--preview-slice 无 schema 错误;全格实拍证据由后续验收批次(双 AI 验收/QA)补录,--final 前必须清零"
    },
    "mobile.verification-code.empty-state|ipad|ko|cn": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "PR4a 派工包集中批捕预案:合并门=--preview-slice 无 schema 错误;全格实拍证据由后续验收批次(双 AI 验收/QA)补录,--final 前必须清零"
    },
    "mobile.verification-code.empty-state|ipad|ko|global": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "PR4a 派工包集中批捕预案:合并门=--preview-slice 无 schema 错误;全格实拍证据由后续验收批次(双 AI 验收/QA)补录,--final 前必须清零"
    },
    "mobile.verification-code.empty-state|android-pad|zh-CN|cn": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "PR4a 派工包集中批捕预案:合并门=--preview-slice 无 schema 错误;全格实拍证据由后续验收批次(双 AI 验收/QA)补录,--final 前必须清零"
    },
    "mobile.verification-code.empty-state|android-pad|zh-CN|global": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "PR4a 派工包集中批捕预案:合并门=--preview-slice 无 schema 错误;全格实拍证据由后续验收批次(双 AI 验收/QA)补录,--final 前必须清零"
    },
    "mobile.verification-code.empty-state|android-pad|zh-TW|cn": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "PR4a 派工包集中批捕预案:合并门=--preview-slice 无 schema 错误;全格实拍证据由后续验收批次(双 AI 验收/QA)补录,--final 前必须清零"
    },
    "mobile.verification-code.empty-state|android-pad|zh-TW|global": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "PR4a 派工包集中批捕预案:合并门=--preview-slice 无 schema 错误;全格实拍证据由后续验收批次(双 AI 验收/QA)补录,--final 前必须清零"
    },
    "mobile.verification-code.empty-state|android-pad|en|cn": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "PR4a 派工包集中批捕预案:合并门=--preview-slice 无 schema 错误;全格实拍证据由后续验收批次(双 AI 验收/QA)补录,--final 前必须清零"
    },
    "mobile.verification-code.empty-state|android-pad|en|global": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "PR4a 派工包集中批捕预案:合并门=--preview-slice 无 schema 错误;全格实拍证据由后续验收批次(双 AI 验收/QA)补录,--final 前必须清零"
    },
    "mobile.verification-code.empty-state|android-pad|ja|cn": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "PR4a 派工包集中批捕预案:合并门=--preview-slice 无 schema 错误;全格实拍证据由后续验收批次(双 AI 验收/QA)补录,--final 前必须清零"
    },
    "mobile.verification-code.empty-state|android-pad|ja|global": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "PR4a 派工包集中批捕预案:合并门=--preview-slice 无 schema 错误;全格实拍证据由后续验收批次(双 AI 验收/QA)补录,--final 前必须清零"
    },
    "mobile.verification-code.empty-state|android-pad|ko|cn": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "PR4a 派工包集中批捕预案:合并门=--preview-slice 无 schema 错误;全格实拍证据由后续验收批次(双 AI 验收/QA)补录,--final 前必须清零"
    },
    "mobile.verification-code.empty-state|android-pad|ko|global": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "PR4a 派工包集中批捕预案:合并门=--preview-slice 无 schema 错误;全格实拍证据由后续验收批次(双 AI 验收/QA)补录,--final 前必须清零"
    },
    "mobile.verification-code.filled-state|iphone|zh-CN|cn": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "PR4a 派工包集中批捕预案:合并门=--preview-slice 无 schema 错误;全格实拍证据由后续验收批次(双 AI 验收/QA)补录,--final 前必须清零"
    },
    "mobile.verification-code.filled-state|iphone|zh-CN|global": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "PR4a 派工包集中批捕预案:合并门=--preview-slice 无 schema 错误;全格实拍证据由后续验收批次(双 AI 验收/QA)补录,--final 前必须清零"
    },
    "mobile.verification-code.filled-state|iphone|zh-TW|cn": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "PR4a 派工包集中批捕预案:合并门=--preview-slice 无 schema 错误;全格实拍证据由后续验收批次(双 AI 验收/QA)补录,--final 前必须清零"
    },
    "mobile.verification-code.filled-state|iphone|zh-TW|global": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "PR4a 派工包集中批捕预案:合并门=--preview-slice 无 schema 错误;全格实拍证据由后续验收批次(双 AI 验收/QA)补录,--final 前必须清零"
    },
    "mobile.verification-code.filled-state|iphone|en|cn": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "PR4a 派工包集中批捕预案:合并门=--preview-slice 无 schema 错误;全格实拍证据由后续验收批次(双 AI 验收/QA)补录,--final 前必须清零"
    },
    "mobile.verification-code.filled-state|iphone|en|global": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "PR4a 派工包集中批捕预案:合并门=--preview-slice 无 schema 错误;全格实拍证据由后续验收批次(双 AI 验收/QA)补录,--final 前必须清零"
    },
    "mobile.verification-code.filled-state|iphone|ja|cn": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "PR4a 派工包集中批捕预案:合并门=--preview-slice 无 schema 错误;全格实拍证据由后续验收批次(双 AI 验收/QA)补录,--final 前必须清零"
    },
    "mobile.verification-code.filled-state|iphone|ja|global": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "PR4a 派工包集中批捕预案:合并门=--preview-slice 无 schema 错误;全格实拍证据由后续验收批次(双 AI 验收/QA)补录,--final 前必须清零"
    },
    "mobile.verification-code.filled-state|iphone|ko|cn": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "PR4a 派工包集中批捕预案:合并门=--preview-slice 无 schema 错误;全格实拍证据由后续验收批次(双 AI 验收/QA)补录,--final 前必须清零"
    },
    "mobile.verification-code.filled-state|iphone|ko|global": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "PR4a 派工包集中批捕预案:合并门=--preview-slice 无 schema 错误;全格实拍证据由后续验收批次(双 AI 验收/QA)补录,--final 前必须清零"
    },
    "mobile.verification-code.filled-state|android-phone|zh-CN|cn": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "PR4a 派工包集中批捕预案:合并门=--preview-slice 无 schema 错误;全格实拍证据由后续验收批次(双 AI 验收/QA)补录,--final 前必须清零"
    },
    "mobile.verification-code.filled-state|android-phone|zh-CN|global": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "PR4a 派工包集中批捕预案:合并门=--preview-slice 无 schema 错误;全格实拍证据由后续验收批次(双 AI 验收/QA)补录,--final 前必须清零"
    },
    "mobile.verification-code.filled-state|android-phone|zh-TW|cn": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "PR4a 派工包集中批捕预案:合并门=--preview-slice 无 schema 错误;全格实拍证据由后续验收批次(双 AI 验收/QA)补录,--final 前必须清零"
    },
    "mobile.verification-code.filled-state|android-phone|zh-TW|global": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "PR4a 派工包集中批捕预案:合并门=--preview-slice 无 schema 错误;全格实拍证据由后续验收批次(双 AI 验收/QA)补录,--final 前必须清零"
    },
    "mobile.verification-code.filled-state|android-phone|en|cn": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "PR4a 派工包集中批捕预案:合并门=--preview-slice 无 schema 错误;全格实拍证据由后续验收批次(双 AI 验收/QA)补录,--final 前必须清零"
    },
    "mobile.verification-code.filled-state|android-phone|en|global": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "PR4a 派工包集中批捕预案:合并门=--preview-slice 无 schema 错误;全格实拍证据由后续验收批次(双 AI 验收/QA)补录,--final 前必须清零"
    },
    "mobile.verification-code.filled-state|android-phone|ja|cn": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "PR4a 派工包集中批捕预案:合并门=--preview-slice 无 schema 错误;全格实拍证据由后续验收批次(双 AI 验收/QA)补录,--final 前必须清零"
    },
    "mobile.verification-code.filled-state|android-phone|ja|global": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "PR4a 派工包集中批捕预案:合并门=--preview-slice 无 schema 错误;全格实拍证据由后续验收批次(双 AI 验收/QA)补录,--final 前必须清零"
    },
    "mobile.verification-code.filled-state|android-phone|ko|cn": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "PR4a 派工包集中批捕预案:合并门=--preview-slice 无 schema 错误;全格实拍证据由后续验收批次(双 AI 验收/QA)补录,--final 前必须清零"
    },
    "mobile.verification-code.filled-state|android-phone|ko|global": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "PR4a 派工包集中批捕预案:合并门=--preview-slice 无 schema 错误;全格实拍证据由后续验收批次(双 AI 验收/QA)补录,--final 前必须清零"
    },
    "mobile.verification-code.filled-state|ipad|zh-CN|cn": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "PR4a 派工包集中批捕预案:合并门=--preview-slice 无 schema 错误;全格实拍证据由后续验收批次(双 AI 验收/QA)补录,--final 前必须清零"
    },
    "mobile.verification-code.filled-state|ipad|zh-CN|global": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "PR4a 派工包集中批捕预案:合并门=--preview-slice 无 schema 错误;全格实拍证据由后续验收批次(双 AI 验收/QA)补录,--final 前必须清零"
    },
    "mobile.verification-code.filled-state|ipad|zh-TW|cn": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "PR4a 派工包集中批捕预案:合并门=--preview-slice 无 schema 错误;全格实拍证据由后续验收批次(双 AI 验收/QA)补录,--final 前必须清零"
    },
    "mobile.verification-code.filled-state|ipad|zh-TW|global": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "PR4a 派工包集中批捕预案:合并门=--preview-slice 无 schema 错误;全格实拍证据由后续验收批次(双 AI 验收/QA)补录,--final 前必须清零"
    },
    "mobile.verification-code.filled-state|ipad|en|cn": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "PR4a 派工包集中批捕预案:合并门=--preview-slice 无 schema 错误;全格实拍证据由后续验收批次(双 AI 验收/QA)补录,--final 前必须清零"
    },
    "mobile.verification-code.filled-state|ipad|en|global": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "PR4a 派工包集中批捕预案:合并门=--preview-slice 无 schema 错误;全格实拍证据由后续验收批次(双 AI 验收/QA)补录,--final 前必须清零"
    },
    "mobile.verification-code.filled-state|ipad|ja|cn": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "PR4a 派工包集中批捕预案:合并门=--preview-slice 无 schema 错误;全格实拍证据由后续验收批次(双 AI 验收/QA)补录,--final 前必须清零"
    },
    "mobile.verification-code.filled-state|ipad|ja|global": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "PR4a 派工包集中批捕预案:合并门=--preview-slice 无 schema 错误;全格实拍证据由后续验收批次(双 AI 验收/QA)补录,--final 前必须清零"
    },
    "mobile.verification-code.filled-state|ipad|ko|cn": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "PR4a 派工包集中批捕预案:合并门=--preview-slice 无 schema 错误;全格实拍证据由后续验收批次(双 AI 验收/QA)补录,--final 前必须清零"
    },
    "mobile.verification-code.filled-state|ipad|ko|global": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "PR4a 派工包集中批捕预案:合并门=--preview-slice 无 schema 错误;全格实拍证据由后续验收批次(双 AI 验收/QA)补录,--final 前必须清零"
    },
    "mobile.verification-code.filled-state|android-pad|zh-CN|cn": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "PR4a 派工包集中批捕预案:合并门=--preview-slice 无 schema 错误;全格实拍证据由后续验收批次(双 AI 验收/QA)补录,--final 前必须清零"
    },
    "mobile.verification-code.filled-state|android-pad|zh-CN|global": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "PR4a 派工包集中批捕预案:合并门=--preview-slice 无 schema 错误;全格实拍证据由后续验收批次(双 AI 验收/QA)补录,--final 前必须清零"
    },
    "mobile.verification-code.filled-state|android-pad|zh-TW|cn": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "PR4a 派工包集中批捕预案:合并门=--preview-slice 无 schema 错误;全格实拍证据由后续验收批次(双 AI 验收/QA)补录,--final 前必须清零"
    },
    "mobile.verification-code.filled-state|android-pad|zh-TW|global": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "PR4a 派工包集中批捕预案:合并门=--preview-slice 无 schema 错误;全格实拍证据由后续验收批次(双 AI 验收/QA)补录,--final 前必须清零"
    },
    "mobile.verification-code.filled-state|android-pad|en|cn": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "PR4a 派工包集中批捕预案:合并门=--preview-slice 无 schema 错误;全格实拍证据由后续验收批次(双 AI 验收/QA)补录,--final 前必须清零"
    },
    "mobile.verification-code.filled-state|android-pad|en|global": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "PR4a 派工包集中批捕预案:合并门=--preview-slice 无 schema 错误;全格实拍证据由后续验收批次(双 AI 验收/QA)补录,--final 前必须清零"
    },
    "mobile.verification-code.filled-state|android-pad|ja|cn": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "PR4a 派工包集中批捕预案:合并门=--preview-slice 无 schema 错误;全格实拍证据由后续验收批次(双 AI 验收/QA)补录,--final 前必须清零"
    },
    "mobile.verification-code.filled-state|android-pad|ja|global": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "PR4a 派工包集中批捕预案:合并门=--preview-slice 无 schema 错误;全格实拍证据由后续验收批次(双 AI 验收/QA)补录,--final 前必须清零"
    },
    "mobile.verification-code.filled-state|android-pad|ko|cn": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "PR4a 派工包集中批捕预案:合并门=--preview-slice 无 schema 错误;全格实拍证据由后续验收批次(双 AI 验收/QA)补录,--final 前必须清零"
    },
    "mobile.verification-code.filled-state|android-pad|ko|global": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "PR4a 派工包集中批捕预案:合并门=--preview-slice 无 schema 错误;全格实拍证据由后续验收批次(双 AI 验收/QA)补录,--final 前必须清零"
    },
    "mobile.verification-code.loading-state|iphone|zh-CN|cn": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "PR4a 派工包集中批捕预案:合并门=--preview-slice 无 schema 错误;全格实拍证据由后续验收批次(双 AI 验收/QA)补录,--final 前必须清零"
    },
    "mobile.verification-code.loading-state|iphone|zh-CN|global": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "PR4a 派工包集中批捕预案:合并门=--preview-slice 无 schema 错误;全格实拍证据由后续验收批次(双 AI 验收/QA)补录,--final 前必须清零"
    },
    "mobile.verification-code.loading-state|iphone|zh-TW|cn": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "PR4a 派工包集中批捕预案:合并门=--preview-slice 无 schema 错误;全格实拍证据由后续验收批次(双 AI 验收/QA)补录,--final 前必须清零"
    },
    "mobile.verification-code.loading-state|iphone|zh-TW|global": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "PR4a 派工包集中批捕预案:合并门=--preview-slice 无 schema 错误;全格实拍证据由后续验收批次(双 AI 验收/QA)补录,--final 前必须清零"
    },
    "mobile.verification-code.loading-state|iphone|en|cn": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "PR4a 派工包集中批捕预案:合并门=--preview-slice 无 schema 错误;全格实拍证据由后续验收批次(双 AI 验收/QA)补录,--final 前必须清零"
    },
    "mobile.verification-code.loading-state|iphone|en|global": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "PR4a 派工包集中批捕预案:合并门=--preview-slice 无 schema 错误;全格实拍证据由后续验收批次(双 AI 验收/QA)补录,--final 前必须清零"
    },
    "mobile.verification-code.loading-state|iphone|ja|cn": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "PR4a 派工包集中批捕预案:合并门=--preview-slice 无 schema 错误;全格实拍证据由后续验收批次(双 AI 验收/QA)补录,--final 前必须清零"
    },
    "mobile.verification-code.loading-state|iphone|ja|global": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "PR4a 派工包集中批捕预案:合并门=--preview-slice 无 schema 错误;全格实拍证据由后续验收批次(双 AI 验收/QA)补录,--final 前必须清零"
    },
    "mobile.verification-code.loading-state|iphone|ko|cn": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "PR4a 派工包集中批捕预案:合并门=--preview-slice 无 schema 错误;全格实拍证据由后续验收批次(双 AI 验收/QA)补录,--final 前必须清零"
    },
    "mobile.verification-code.loading-state|iphone|ko|global": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "PR4a 派工包集中批捕预案:合并门=--preview-slice 无 schema 错误;全格实拍证据由后续验收批次(双 AI 验收/QA)补录,--final 前必须清零"
    },
    "mobile.verification-code.loading-state|android-phone|zh-CN|cn": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "PR4a 派工包集中批捕预案:合并门=--preview-slice 无 schema 错误;全格实拍证据由后续验收批次(双 AI 验收/QA)补录,--final 前必须清零"
    },
    "mobile.verification-code.loading-state|android-phone|zh-CN|global": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "PR4a 派工包集中批捕预案:合并门=--preview-slice 无 schema 错误;全格实拍证据由后续验收批次(双 AI 验收/QA)补录,--final 前必须清零"
    },
    "mobile.verification-code.loading-state|android-phone|zh-TW|cn": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "PR4a 派工包集中批捕预案:合并门=--preview-slice 无 schema 错误;全格实拍证据由后续验收批次(双 AI 验收/QA)补录,--final 前必须清零"
    },
    "mobile.verification-code.loading-state|android-phone|zh-TW|global": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "PR4a 派工包集中批捕预案:合并门=--preview-slice 无 schema 错误;全格实拍证据由后续验收批次(双 AI 验收/QA)补录,--final 前必须清零"
    },
    "mobile.verification-code.loading-state|android-phone|en|cn": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "PR4a 派工包集中批捕预案:合并门=--preview-slice 无 schema 错误;全格实拍证据由后续验收批次(双 AI 验收/QA)补录,--final 前必须清零"
    },
    "mobile.verification-code.loading-state|android-phone|en|global": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "PR4a 派工包集中批捕预案:合并门=--preview-slice 无 schema 错误;全格实拍证据由后续验收批次(双 AI 验收/QA)补录,--final 前必须清零"
    },
    "mobile.verification-code.loading-state|android-phone|ja|cn": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "PR4a 派工包集中批捕预案:合并门=--preview-slice 无 schema 错误;全格实拍证据由后续验收批次(双 AI 验收/QA)补录,--final 前必须清零"
    },
    "mobile.verification-code.loading-state|android-phone|ja|global": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "PR4a 派工包集中批捕预案:合并门=--preview-slice 无 schema 错误;全格实拍证据由后续验收批次(双 AI 验收/QA)补录,--final 前必须清零"
    },
    "mobile.verification-code.loading-state|android-phone|ko|cn": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "PR4a 派工包集中批捕预案:合并门=--preview-slice 无 schema 错误;全格实拍证据由后续验收批次(双 AI 验收/QA)补录,--final 前必须清零"
    },
    "mobile.verification-code.loading-state|android-phone|ko|global": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "PR4a 派工包集中批捕预案:合并门=--preview-slice 无 schema 错误;全格实拍证据由后续验收批次(双 AI 验收/QA)补录,--final 前必须清零"
    },
    "mobile.verification-code.loading-state|ipad|zh-CN|cn": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "PR4a 派工包集中批捕预案:合并门=--preview-slice 无 schema 错误;全格实拍证据由后续验收批次(双 AI 验收/QA)补录,--final 前必须清零"
    },
    "mobile.verification-code.loading-state|ipad|zh-CN|global": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "PR4a 派工包集中批捕预案:合并门=--preview-slice 无 schema 错误;全格实拍证据由后续验收批次(双 AI 验收/QA)补录,--final 前必须清零"
    },
    "mobile.verification-code.loading-state|ipad|zh-TW|cn": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "PR4a 派工包集中批捕预案:合并门=--preview-slice 无 schema 错误;全格实拍证据由后续验收批次(双 AI 验收/QA)补录,--final 前必须清零"
    },
    "mobile.verification-code.loading-state|ipad|zh-TW|global": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "PR4a 派工包集中批捕预案:合并门=--preview-slice 无 schema 错误;全格实拍证据由后续验收批次(双 AI 验收/QA)补录,--final 前必须清零"
    },
    "mobile.verification-code.loading-state|ipad|en|cn": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "PR4a 派工包集中批捕预案:合并门=--preview-slice 无 schema 错误;全格实拍证据由后续验收批次(双 AI 验收/QA)补录,--final 前必须清零"
    },
    "mobile.verification-code.loading-state|ipad|en|global": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "PR4a 派工包集中批捕预案:合并门=--preview-slice 无 schema 错误;全格实拍证据由后续验收批次(双 AI 验收/QA)补录,--final 前必须清零"
    },
    "mobile.verification-code.loading-state|ipad|ja|cn": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "PR4a 派工包集中批捕预案:合并门=--preview-slice 无 schema 错误;全格实拍证据由后续验收批次(双 AI 验收/QA)补录,--final 前必须清零"
    },
    "mobile.verification-code.loading-state|ipad|ja|global": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "PR4a 派工包集中批捕预案:合并门=--preview-slice 无 schema 错误;全格实拍证据由后续验收批次(双 AI 验收/QA)补录,--final 前必须清零"
    },
    "mobile.verification-code.loading-state|ipad|ko|cn": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "PR4a 派工包集中批捕预案:合并门=--preview-slice 无 schema 错误;全格实拍证据由后续验收批次(双 AI 验收/QA)补录,--final 前必须清零"
    },
    "mobile.verification-code.loading-state|ipad|ko|global": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "PR4a 派工包集中批捕预案:合并门=--preview-slice 无 schema 错误;全格实拍证据由后续验收批次(双 AI 验收/QA)补录,--final 前必须清零"
    },
    "mobile.verification-code.loading-state|android-pad|zh-CN|cn": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "PR4a 派工包集中批捕预案:合并门=--preview-slice 无 schema 错误;全格实拍证据由后续验收批次(双 AI 验收/QA)补录,--final 前必须清零"
    },
    "mobile.verification-code.loading-state|android-pad|zh-CN|global": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "PR4a 派工包集中批捕预案:合并门=--preview-slice 无 schema 错误;全格实拍证据由后续验收批次(双 AI 验收/QA)补录,--final 前必须清零"
    },
    "mobile.verification-code.loading-state|android-pad|zh-TW|cn": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "PR4a 派工包集中批捕预案:合并门=--preview-slice 无 schema 错误;全格实拍证据由后续验收批次(双 AI 验收/QA)补录,--final 前必须清零"
    },
    "mobile.verification-code.loading-state|android-pad|zh-TW|global": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "PR4a 派工包集中批捕预案:合并门=--preview-slice 无 schema 错误;全格实拍证据由后续验收批次(双 AI 验收/QA)补录,--final 前必须清零"
    },
    "mobile.verification-code.loading-state|android-pad|en|cn": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "PR4a 派工包集中批捕预案:合并门=--preview-slice 无 schema 错误;全格实拍证据由后续验收批次(双 AI 验收/QA)补录,--final 前必须清零"
    },
    "mobile.verification-code.loading-state|android-pad|en|global": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "PR4a 派工包集中批捕预案:合并门=--preview-slice 无 schema 错误;全格实拍证据由后续验收批次(双 AI 验收/QA)补录,--final 前必须清零"
    },
    "mobile.verification-code.loading-state|android-pad|ja|cn": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "PR4a 派工包集中批捕预案:合并门=--preview-slice 无 schema 错误;全格实拍证据由后续验收批次(双 AI 验收/QA)补录,--final 前必须清零"
    },
    "mobile.verification-code.loading-state|android-pad|ja|global": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "PR4a 派工包集中批捕预案:合并门=--preview-slice 无 schema 错误;全格实拍证据由后续验收批次(双 AI 验收/QA)补录,--final 前必须清零"
    },
    "mobile.verification-code.loading-state|android-pad|ko|cn": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "PR4a 派工包集中批捕预案:合并门=--preview-slice 无 schema 错误;全格实拍证据由后续验收批次(双 AI 验收/QA)补录,--final 前必须清零"
    },
    "mobile.verification-code.loading-state|android-pad|ko|global": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "PR4a 派工包集中批捕预案:合并门=--preview-slice 无 schema 错误;全格实拍证据由后续验收批次(双 AI 验收/QA)补录,--final 前必须清零"
    },
    "mobile.sso-org.empty-state|iphone|zh-CN|cn": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "PR4a 派工包集中批捕预案:合并门=--preview-slice 无 schema 错误;全格实拍证据由后续验收批次(双 AI 验收/QA)补录,--final 前必须清零"
    },
    "mobile.sso-org.empty-state|iphone|zh-CN|global": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "PR4a 派工包集中批捕预案:合并门=--preview-slice 无 schema 错误;全格实拍证据由后续验收批次(双 AI 验收/QA)补录,--final 前必须清零"
    },
    "mobile.sso-org.empty-state|iphone|zh-TW|cn": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "PR4a 派工包集中批捕预案:合并门=--preview-slice 无 schema 错误;全格实拍证据由后续验收批次(双 AI 验收/QA)补录,--final 前必须清零"
    },
    "mobile.sso-org.empty-state|iphone|zh-TW|global": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "PR4a 派工包集中批捕预案:合并门=--preview-slice 无 schema 错误;全格实拍证据由后续验收批次(双 AI 验收/QA)补录,--final 前必须清零"
    },
    "mobile.sso-org.empty-state|iphone|en|cn": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "PR4a 派工包集中批捕预案:合并门=--preview-slice 无 schema 错误;全格实拍证据由后续验收批次(双 AI 验收/QA)补录,--final 前必须清零"
    },
    "mobile.sso-org.empty-state|iphone|en|global": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "PR4a 派工包集中批捕预案:合并门=--preview-slice 无 schema 错误;全格实拍证据由后续验收批次(双 AI 验收/QA)补录,--final 前必须清零"
    },
    "mobile.sso-org.empty-state|iphone|ja|cn": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "PR4a 派工包集中批捕预案:合并门=--preview-slice 无 schema 错误;全格实拍证据由后续验收批次(双 AI 验收/QA)补录,--final 前必须清零"
    },
    "mobile.sso-org.empty-state|iphone|ja|global": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "PR4a 派工包集中批捕预案:合并门=--preview-slice 无 schema 错误;全格实拍证据由后续验收批次(双 AI 验收/QA)补录,--final 前必须清零"
    },
    "mobile.sso-org.empty-state|iphone|ko|cn": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "PR4a 派工包集中批捕预案:合并门=--preview-slice 无 schema 错误;全格实拍证据由后续验收批次(双 AI 验收/QA)补录,--final 前必须清零"
    },
    "mobile.sso-org.empty-state|iphone|ko|global": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "PR4a 派工包集中批捕预案:合并门=--preview-slice 无 schema 错误;全格实拍证据由后续验收批次(双 AI 验收/QA)补录,--final 前必须清零"
    },
    "mobile.sso-org.empty-state|android-phone|zh-CN|cn": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "PR4a 派工包集中批捕预案:合并门=--preview-slice 无 schema 错误;全格实拍证据由后续验收批次(双 AI 验收/QA)补录,--final 前必须清零"
    },
    "mobile.sso-org.empty-state|android-phone|zh-CN|global": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "PR4a 派工包集中批捕预案:合并门=--preview-slice 无 schema 错误;全格实拍证据由后续验收批次(双 AI 验收/QA)补录,--final 前必须清零"
    },
    "mobile.sso-org.empty-state|android-phone|zh-TW|cn": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "PR4a 派工包集中批捕预案:合并门=--preview-slice 无 schema 错误;全格实拍证据由后续验收批次(双 AI 验收/QA)补录,--final 前必须清零"
    },
    "mobile.sso-org.empty-state|android-phone|zh-TW|global": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "PR4a 派工包集中批捕预案:合并门=--preview-slice 无 schema 错误;全格实拍证据由后续验收批次(双 AI 验收/QA)补录,--final 前必须清零"
    },
    "mobile.sso-org.empty-state|android-phone|en|cn": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "PR4a 派工包集中批捕预案:合并门=--preview-slice 无 schema 错误;全格实拍证据由后续验收批次(双 AI 验收/QA)补录,--final 前必须清零"
    },
    "mobile.sso-org.empty-state|android-phone|en|global": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "PR4a 派工包集中批捕预案:合并门=--preview-slice 无 schema 错误;全格实拍证据由后续验收批次(双 AI 验收/QA)补录,--final 前必须清零"
    },
    "mobile.sso-org.empty-state|android-phone|ja|cn": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "PR4a 派工包集中批捕预案:合并门=--preview-slice 无 schema 错误;全格实拍证据由后续验收批次(双 AI 验收/QA)补录,--final 前必须清零"
    },
    "mobile.sso-org.empty-state|android-phone|ja|global": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "PR4a 派工包集中批捕预案:合并门=--preview-slice 无 schema 错误;全格实拍证据由后续验收批次(双 AI 验收/QA)补录,--final 前必须清零"
    },
    "mobile.sso-org.empty-state|android-phone|ko|cn": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "PR4a 派工包集中批捕预案:合并门=--preview-slice 无 schema 错误;全格实拍证据由后续验收批次(双 AI 验收/QA)补录,--final 前必须清零"
    },
    "mobile.sso-org.empty-state|android-phone|ko|global": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "PR4a 派工包集中批捕预案:合并门=--preview-slice 无 schema 错误;全格实拍证据由后续验收批次(双 AI 验收/QA)补录,--final 前必须清零"
    },
    "mobile.sso-org.empty-state|ipad|zh-CN|cn": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "PR4a 派工包集中批捕预案:合并门=--preview-slice 无 schema 错误;全格实拍证据由后续验收批次(双 AI 验收/QA)补录,--final 前必须清零"
    },
    "mobile.sso-org.empty-state|ipad|zh-CN|global": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "PR4a 派工包集中批捕预案:合并门=--preview-slice 无 schema 错误;全格实拍证据由后续验收批次(双 AI 验收/QA)补录,--final 前必须清零"
    },
    "mobile.sso-org.empty-state|ipad|zh-TW|cn": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "PR4a 派工包集中批捕预案:合并门=--preview-slice 无 schema 错误;全格实拍证据由后续验收批次(双 AI 验收/QA)补录,--final 前必须清零"
    },
    "mobile.sso-org.empty-state|ipad|zh-TW|global": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "PR4a 派工包集中批捕预案:合并门=--preview-slice 无 schema 错误;全格实拍证据由后续验收批次(双 AI 验收/QA)补录,--final 前必须清零"
    },
    "mobile.sso-org.empty-state|ipad|en|cn": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "PR4a 派工包集中批捕预案:合并门=--preview-slice 无 schema 错误;全格实拍证据由后续验收批次(双 AI 验收/QA)补录,--final 前必须清零"
    },
    "mobile.sso-org.empty-state|ipad|en|global": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "PR4a 派工包集中批捕预案:合并门=--preview-slice 无 schema 错误;全格实拍证据由后续验收批次(双 AI 验收/QA)补录,--final 前必须清零"
    },
    "mobile.sso-org.empty-state|ipad|ja|cn": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "PR4a 派工包集中批捕预案:合并门=--preview-slice 无 schema 错误;全格实拍证据由后续验收批次(双 AI 验收/QA)补录,--final 前必须清零"
    },
    "mobile.sso-org.empty-state|ipad|ja|global": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "PR4a 派工包集中批捕预案:合并门=--preview-slice 无 schema 错误;全格实拍证据由后续验收批次(双 AI 验收/QA)补录,--final 前必须清零"
    },
    "mobile.sso-org.empty-state|ipad|ko|cn": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "PR4a 派工包集中批捕预案:合并门=--preview-slice 无 schema 错误;全格实拍证据由后续验收批次(双 AI 验收/QA)补录,--final 前必须清零"
    },
    "mobile.sso-org.empty-state|ipad|ko|global": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "PR4a 派工包集中批捕预案:合并门=--preview-slice 无 schema 错误;全格实拍证据由后续验收批次(双 AI 验收/QA)补录,--final 前必须清零"
    },
    "mobile.sso-org.empty-state|android-pad|zh-CN|cn": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "PR4a 派工包集中批捕预案:合并门=--preview-slice 无 schema 错误;全格实拍证据由后续验收批次(双 AI 验收/QA)补录,--final 前必须清零"
    },
    "mobile.sso-org.empty-state|android-pad|zh-CN|global": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "PR4a 派工包集中批捕预案:合并门=--preview-slice 无 schema 错误;全格实拍证据由后续验收批次(双 AI 验收/QA)补录,--final 前必须清零"
    },
    "mobile.sso-org.empty-state|android-pad|zh-TW|cn": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "PR4a 派工包集中批捕预案:合并门=--preview-slice 无 schema 错误;全格实拍证据由后续验收批次(双 AI 验收/QA)补录,--final 前必须清零"
    },
    "mobile.sso-org.empty-state|android-pad|zh-TW|global": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "PR4a 派工包集中批捕预案:合并门=--preview-slice 无 schema 错误;全格实拍证据由后续验收批次(双 AI 验收/QA)补录,--final 前必须清零"
    },
    "mobile.sso-org.empty-state|android-pad|en|cn": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "PR4a 派工包集中批捕预案:合并门=--preview-slice 无 schema 错误;全格实拍证据由后续验收批次(双 AI 验收/QA)补录,--final 前必须清零"
    },
    "mobile.sso-org.empty-state|android-pad|en|global": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "PR4a 派工包集中批捕预案:合并门=--preview-slice 无 schema 错误;全格实拍证据由后续验收批次(双 AI 验收/QA)补录,--final 前必须清零"
    },
    "mobile.sso-org.empty-state|android-pad|ja|cn": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "PR4a 派工包集中批捕预案:合并门=--preview-slice 无 schema 错误;全格实拍证据由后续验收批次(双 AI 验收/QA)补录,--final 前必须清零"
    },
    "mobile.sso-org.empty-state|android-pad|ja|global": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "PR4a 派工包集中批捕预案:合并门=--preview-slice 无 schema 错误;全格实拍证据由后续验收批次(双 AI 验收/QA)补录,--final 前必须清零"
    },
    "mobile.sso-org.empty-state|android-pad|ko|cn": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "PR4a 派工包集中批捕预案:合并门=--preview-slice 无 schema 错误;全格实拍证据由后续验收批次(双 AI 验收/QA)补录,--final 前必须清零"
    },
    "mobile.sso-org.empty-state|android-pad|ko|global": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "PR4a 派工包集中批捕预案:合并门=--preview-slice 无 schema 错误;全格实拍证据由后续验收批次(双 AI 验收/QA)补录,--final 前必须清零"
    },
    "mobile.sso-org.filled-state|iphone|zh-CN|cn": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "PR4a 派工包集中批捕预案:合并门=--preview-slice 无 schema 错误;全格实拍证据由后续验收批次(双 AI 验收/QA)补录,--final 前必须清零"
    },
    "mobile.sso-org.filled-state|iphone|zh-CN|global": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "PR4a 派工包集中批捕预案:合并门=--preview-slice 无 schema 错误;全格实拍证据由后续验收批次(双 AI 验收/QA)补录,--final 前必须清零"
    },
    "mobile.sso-org.filled-state|iphone|zh-TW|cn": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "PR4a 派工包集中批捕预案:合并门=--preview-slice 无 schema 错误;全格实拍证据由后续验收批次(双 AI 验收/QA)补录,--final 前必须清零"
    },
    "mobile.sso-org.filled-state|iphone|zh-TW|global": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "PR4a 派工包集中批捕预案:合并门=--preview-slice 无 schema 错误;全格实拍证据由后续验收批次(双 AI 验收/QA)补录,--final 前必须清零"
    },
    "mobile.sso-org.filled-state|iphone|en|cn": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "PR4a 派工包集中批捕预案:合并门=--preview-slice 无 schema 错误;全格实拍证据由后续验收批次(双 AI 验收/QA)补录,--final 前必须清零"
    },
    "mobile.sso-org.filled-state|iphone|en|global": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "PR4a 派工包集中批捕预案:合并门=--preview-slice 无 schema 错误;全格实拍证据由后续验收批次(双 AI 验收/QA)补录,--final 前必须清零"
    },
    "mobile.sso-org.filled-state|iphone|ja|cn": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "PR4a 派工包集中批捕预案:合并门=--preview-slice 无 schema 错误;全格实拍证据由后续验收批次(双 AI 验收/QA)补录,--final 前必须清零"
    },
    "mobile.sso-org.filled-state|iphone|ja|global": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "PR4a 派工包集中批捕预案:合并门=--preview-slice 无 schema 错误;全格实拍证据由后续验收批次(双 AI 验收/QA)补录,--final 前必须清零"
    },
    "mobile.sso-org.filled-state|iphone|ko|cn": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "PR4a 派工包集中批捕预案:合并门=--preview-slice 无 schema 错误;全格实拍证据由后续验收批次(双 AI 验收/QA)补录,--final 前必须清零"
    },
    "mobile.sso-org.filled-state|iphone|ko|global": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "PR4a 派工包集中批捕预案:合并门=--preview-slice 无 schema 错误;全格实拍证据由后续验收批次(双 AI 验收/QA)补录,--final 前必须清零"
    },
    "mobile.sso-org.filled-state|android-phone|zh-CN|cn": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "PR4a 派工包集中批捕预案:合并门=--preview-slice 无 schema 错误;全格实拍证据由后续验收批次(双 AI 验收/QA)补录,--final 前必须清零"
    },
    "mobile.sso-org.filled-state|android-phone|zh-CN|global": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "PR4a 派工包集中批捕预案:合并门=--preview-slice 无 schema 错误;全格实拍证据由后续验收批次(双 AI 验收/QA)补录,--final 前必须清零"
    },
    "mobile.sso-org.filled-state|android-phone|zh-TW|cn": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "PR4a 派工包集中批捕预案:合并门=--preview-slice 无 schema 错误;全格实拍证据由后续验收批次(双 AI 验收/QA)补录,--final 前必须清零"
    },
    "mobile.sso-org.filled-state|android-phone|zh-TW|global": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "PR4a 派工包集中批捕预案:合并门=--preview-slice 无 schema 错误;全格实拍证据由后续验收批次(双 AI 验收/QA)补录,--final 前必须清零"
    },
    "mobile.sso-org.filled-state|android-phone|en|cn": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "PR4a 派工包集中批捕预案:合并门=--preview-slice 无 schema 错误;全格实拍证据由后续验收批次(双 AI 验收/QA)补录,--final 前必须清零"
    },
    "mobile.sso-org.filled-state|android-phone|en|global": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "PR4a 派工包集中批捕预案:合并门=--preview-slice 无 schema 错误;全格实拍证据由后续验收批次(双 AI 验收/QA)补录,--final 前必须清零"
    },
    "mobile.sso-org.filled-state|android-phone|ja|cn": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "PR4a 派工包集中批捕预案:合并门=--preview-slice 无 schema 错误;全格实拍证据由后续验收批次(双 AI 验收/QA)补录,--final 前必须清零"
    },
    "mobile.sso-org.filled-state|android-phone|ja|global": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "PR4a 派工包集中批捕预案:合并门=--preview-slice 无 schema 错误;全格实拍证据由后续验收批次(双 AI 验收/QA)补录,--final 前必须清零"
    },
    "mobile.sso-org.filled-state|android-phone|ko|cn": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "PR4a 派工包集中批捕预案:合并门=--preview-slice 无 schema 错误;全格实拍证据由后续验收批次(双 AI 验收/QA)补录,--final 前必须清零"
    },
    "mobile.sso-org.filled-state|android-phone|ko|global": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "PR4a 派工包集中批捕预案:合并门=--preview-slice 无 schema 错误;全格实拍证据由后续验收批次(双 AI 验收/QA)补录,--final 前必须清零"
    },
    "mobile.sso-org.filled-state|ipad|zh-CN|cn": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "PR4a 派工包集中批捕预案:合并门=--preview-slice 无 schema 错误;全格实拍证据由后续验收批次(双 AI 验收/QA)补录,--final 前必须清零"
    },
    "mobile.sso-org.filled-state|ipad|zh-CN|global": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "PR4a 派工包集中批捕预案:合并门=--preview-slice 无 schema 错误;全格实拍证据由后续验收批次(双 AI 验收/QA)补录,--final 前必须清零"
    },
    "mobile.sso-org.filled-state|ipad|zh-TW|cn": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "PR4a 派工包集中批捕预案:合并门=--preview-slice 无 schema 错误;全格实拍证据由后续验收批次(双 AI 验收/QA)补录,--final 前必须清零"
    },
    "mobile.sso-org.filled-state|ipad|zh-TW|global": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "PR4a 派工包集中批捕预案:合并门=--preview-slice 无 schema 错误;全格实拍证据由后续验收批次(双 AI 验收/QA)补录,--final 前必须清零"
    },
    "mobile.sso-org.filled-state|ipad|en|cn": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "PR4a 派工包集中批捕预案:合并门=--preview-slice 无 schema 错误;全格实拍证据由后续验收批次(双 AI 验收/QA)补录,--final 前必须清零"
    },
    "mobile.sso-org.filled-state|ipad|en|global": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "PR4a 派工包集中批捕预案:合并门=--preview-slice 无 schema 错误;全格实拍证据由后续验收批次(双 AI 验收/QA)补录,--final 前必须清零"
    },
    "mobile.sso-org.filled-state|ipad|ja|cn": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "PR4a 派工包集中批捕预案:合并门=--preview-slice 无 schema 错误;全格实拍证据由后续验收批次(双 AI 验收/QA)补录,--final 前必须清零"
    },
    "mobile.sso-org.filled-state|ipad|ja|global": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "PR4a 派工包集中批捕预案:合并门=--preview-slice 无 schema 错误;全格实拍证据由后续验收批次(双 AI 验收/QA)补录,--final 前必须清零"
    },
    "mobile.sso-org.filled-state|ipad|ko|cn": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "PR4a 派工包集中批捕预案:合并门=--preview-slice 无 schema 错误;全格实拍证据由后续验收批次(双 AI 验收/QA)补录,--final 前必须清零"
    },
    "mobile.sso-org.filled-state|ipad|ko|global": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "PR4a 派工包集中批捕预案:合并门=--preview-slice 无 schema 错误;全格实拍证据由后续验收批次(双 AI 验收/QA)补录,--final 前必须清零"
    },
    "mobile.sso-org.filled-state|android-pad|zh-CN|cn": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "PR4a 派工包集中批捕预案:合并门=--preview-slice 无 schema 错误;全格实拍证据由后续验收批次(双 AI 验收/QA)补录,--final 前必须清零"
    },
    "mobile.sso-org.filled-state|android-pad|zh-CN|global": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "PR4a 派工包集中批捕预案:合并门=--preview-slice 无 schema 错误;全格实拍证据由后续验收批次(双 AI 验收/QA)补录,--final 前必须清零"
    },
    "mobile.sso-org.filled-state|android-pad|zh-TW|cn": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "PR4a 派工包集中批捕预案:合并门=--preview-slice 无 schema 错误;全格实拍证据由后续验收批次(双 AI 验收/QA)补录,--final 前必须清零"
    },
    "mobile.sso-org.filled-state|android-pad|zh-TW|global": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "PR4a 派工包集中批捕预案:合并门=--preview-slice 无 schema 错误;全格实拍证据由后续验收批次(双 AI 验收/QA)补录,--final 前必须清零"
    },
    "mobile.sso-org.filled-state|android-pad|en|cn": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "PR4a 派工包集中批捕预案:合并门=--preview-slice 无 schema 错误;全格实拍证据由后续验收批次(双 AI 验收/QA)补录,--final 前必须清零"
    },
    "mobile.sso-org.filled-state|android-pad|en|global": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "PR4a 派工包集中批捕预案:合并门=--preview-slice 无 schema 错误;全格实拍证据由后续验收批次(双 AI 验收/QA)补录,--final 前必须清零"
    },
    "mobile.sso-org.filled-state|android-pad|ja|cn": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "PR4a 派工包集中批捕预案:合并门=--preview-slice 无 schema 错误;全格实拍证据由后续验收批次(双 AI 验收/QA)补录,--final 前必须清零"
    },
    "mobile.sso-org.filled-state|android-pad|ja|global": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "PR4a 派工包集中批捕预案:合并门=--preview-slice 无 schema 错误;全格实拍证据由后续验收批次(双 AI 验收/QA)补录,--final 前必须清零"
    },
    "mobile.sso-org.filled-state|android-pad|ko|cn": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "PR4a 派工包集中批捕预案:合并门=--preview-slice 无 schema 错误;全格实拍证据由后续验收批次(双 AI 验收/QA)补录,--final 前必须清零"
    },
    "mobile.sso-org.filled-state|android-pad|ko|global": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "PR4a 派工包集中批捕预案:合并门=--preview-slice 无 schema 错误;全格实拍证据由后续验收批次(双 AI 验收/QA)补录,--final 前必须清零"
    },
    "mobile.sso-org.list-state|iphone|zh-CN|cn": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "PR4a 派工包集中批捕预案:合并门=--preview-slice 无 schema 错误;全格实拍证据由后续验收批次(双 AI 验收/QA)补录,--final 前必须清零"
    },
    "mobile.sso-org.list-state|iphone|zh-CN|global": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "PR4a 派工包集中批捕预案:合并门=--preview-slice 无 schema 错误;全格实拍证据由后续验收批次(双 AI 验收/QA)补录,--final 前必须清零"
    },
    "mobile.sso-org.list-state|iphone|zh-TW|cn": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "PR4a 派工包集中批捕预案:合并门=--preview-slice 无 schema 错误;全格实拍证据由后续验收批次(双 AI 验收/QA)补录,--final 前必须清零"
    },
    "mobile.sso-org.list-state|iphone|zh-TW|global": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "PR4a 派工包集中批捕预案:合并门=--preview-slice 无 schema 错误;全格实拍证据由后续验收批次(双 AI 验收/QA)补录,--final 前必须清零"
    },
    "mobile.sso-org.list-state|iphone|en|cn": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "PR4a 派工包集中批捕预案:合并门=--preview-slice 无 schema 错误;全格实拍证据由后续验收批次(双 AI 验收/QA)补录,--final 前必须清零"
    },
    "mobile.sso-org.list-state|iphone|en|global": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "PR4a 派工包集中批捕预案:合并门=--preview-slice 无 schema 错误;全格实拍证据由后续验收批次(双 AI 验收/QA)补录,--final 前必须清零"
    },
    "mobile.sso-org.list-state|iphone|ja|cn": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "PR4a 派工包集中批捕预案:合并门=--preview-slice 无 schema 错误;全格实拍证据由后续验收批次(双 AI 验收/QA)补录,--final 前必须清零"
    },
    "mobile.sso-org.list-state|iphone|ja|global": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "PR4a 派工包集中批捕预案:合并门=--preview-slice 无 schema 错误;全格实拍证据由后续验收批次(双 AI 验收/QA)补录,--final 前必须清零"
    },
    "mobile.sso-org.list-state|iphone|ko|cn": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "PR4a 派工包集中批捕预案:合并门=--preview-slice 无 schema 错误;全格实拍证据由后续验收批次(双 AI 验收/QA)补录,--final 前必须清零"
    },
    "mobile.sso-org.list-state|iphone|ko|global": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "PR4a 派工包集中批捕预案:合并门=--preview-slice 无 schema 错误;全格实拍证据由后续验收批次(双 AI 验收/QA)补录,--final 前必须清零"
    },
    "mobile.sso-org.list-state|android-phone|zh-CN|cn": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "PR4a 派工包集中批捕预案:合并门=--preview-slice 无 schema 错误;全格实拍证据由后续验收批次(双 AI 验收/QA)补录,--final 前必须清零"
    },
    "mobile.sso-org.list-state|android-phone|zh-CN|global": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "PR4a 派工包集中批捕预案:合并门=--preview-slice 无 schema 错误;全格实拍证据由后续验收批次(双 AI 验收/QA)补录,--final 前必须清零"
    },
    "mobile.sso-org.list-state|android-phone|zh-TW|cn": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "PR4a 派工包集中批捕预案:合并门=--preview-slice 无 schema 错误;全格实拍证据由后续验收批次(双 AI 验收/QA)补录,--final 前必须清零"
    },
    "mobile.sso-org.list-state|android-phone|zh-TW|global": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "PR4a 派工包集中批捕预案:合并门=--preview-slice 无 schema 错误;全格实拍证据由后续验收批次(双 AI 验收/QA)补录,--final 前必须清零"
    },
    "mobile.sso-org.list-state|android-phone|en|cn": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "PR4a 派工包集中批捕预案:合并门=--preview-slice 无 schema 错误;全格实拍证据由后续验收批次(双 AI 验收/QA)补录,--final 前必须清零"
    },
    "mobile.sso-org.list-state|android-phone|en|global": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "PR4a 派工包集中批捕预案:合并门=--preview-slice 无 schema 错误;全格实拍证据由后续验收批次(双 AI 验收/QA)补录,--final 前必须清零"
    },
    "mobile.sso-org.list-state|android-phone|ja|cn": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "PR4a 派工包集中批捕预案:合并门=--preview-slice 无 schema 错误;全格实拍证据由后续验收批次(双 AI 验收/QA)补录,--final 前必须清零"
    },
    "mobile.sso-org.list-state|android-phone|ja|global": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "PR4a 派工包集中批捕预案:合并门=--preview-slice 无 schema 错误;全格实拍证据由后续验收批次(双 AI 验收/QA)补录,--final 前必须清零"
    },
    "mobile.sso-org.list-state|android-phone|ko|cn": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "PR4a 派工包集中批捕预案:合并门=--preview-slice 无 schema 错误;全格实拍证据由后续验收批次(双 AI 验收/QA)补录,--final 前必须清零"
    },
    "mobile.sso-org.list-state|android-phone|ko|global": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "PR4a 派工包集中批捕预案:合并门=--preview-slice 无 schema 错误;全格实拍证据由后续验收批次(双 AI 验收/QA)补录,--final 前必须清零"
    },
    "mobile.sso-org.list-state|ipad|zh-CN|cn": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "PR4a 派工包集中批捕预案:合并门=--preview-slice 无 schema 错误;全格实拍证据由后续验收批次(双 AI 验收/QA)补录,--final 前必须清零"
    },
    "mobile.sso-org.list-state|ipad|zh-CN|global": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "PR4a 派工包集中批捕预案:合并门=--preview-slice 无 schema 错误;全格实拍证据由后续验收批次(双 AI 验收/QA)补录,--final 前必须清零"
    },
    "mobile.sso-org.list-state|ipad|zh-TW|cn": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "PR4a 派工包集中批捕预案:合并门=--preview-slice 无 schema 错误;全格实拍证据由后续验收批次(双 AI 验收/QA)补录,--final 前必须清零"
    },
    "mobile.sso-org.list-state|ipad|zh-TW|global": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "PR4a 派工包集中批捕预案:合并门=--preview-slice 无 schema 错误;全格实拍证据由后续验收批次(双 AI 验收/QA)补录,--final 前必须清零"
    },
    "mobile.sso-org.list-state|ipad|en|cn": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "PR4a 派工包集中批捕预案:合并门=--preview-slice 无 schema 错误;全格实拍证据由后续验收批次(双 AI 验收/QA)补录,--final 前必须清零"
    },
    "mobile.sso-org.list-state|ipad|en|global": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "PR4a 派工包集中批捕预案:合并门=--preview-slice 无 schema 错误;全格实拍证据由后续验收批次(双 AI 验收/QA)补录,--final 前必须清零"
    },
    "mobile.sso-org.list-state|ipad|ja|cn": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "PR4a 派工包集中批捕预案:合并门=--preview-slice 无 schema 错误;全格实拍证据由后续验收批次(双 AI 验收/QA)补录,--final 前必须清零"
    },
    "mobile.sso-org.list-state|ipad|ja|global": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "PR4a 派工包集中批捕预案:合并门=--preview-slice 无 schema 错误;全格实拍证据由后续验收批次(双 AI 验收/QA)补录,--final 前必须清零"
    },
    "mobile.sso-org.list-state|ipad|ko|cn": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "PR4a 派工包集中批捕预案:合并门=--preview-slice 无 schema 错误;全格实拍证据由后续验收批次(双 AI 验收/QA)补录,--final 前必须清零"
    },
    "mobile.sso-org.list-state|ipad|ko|global": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "PR4a 派工包集中批捕预案:合并门=--preview-slice 无 schema 错误;全格实拍证据由后续验收批次(双 AI 验收/QA)补录,--final 前必须清零"
    },
    "mobile.sso-org.list-state|android-pad|zh-CN|cn": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "PR4a 派工包集中批捕预案:合并门=--preview-slice 无 schema 错误;全格实拍证据由后续验收批次(双 AI 验收/QA)补录,--final 前必须清零"
    },
    "mobile.sso-org.list-state|android-pad|zh-CN|global": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "PR4a 派工包集中批捕预案:合并门=--preview-slice 无 schema 错误;全格实拍证据由后续验收批次(双 AI 验收/QA)补录,--final 前必须清零"
    },
    "mobile.sso-org.list-state|android-pad|zh-TW|cn": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "PR4a 派工包集中批捕预案:合并门=--preview-slice 无 schema 错误;全格实拍证据由后续验收批次(双 AI 验收/QA)补录,--final 前必须清零"
    },
    "mobile.sso-org.list-state|android-pad|zh-TW|global": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "PR4a 派工包集中批捕预案:合并门=--preview-slice 无 schema 错误;全格实拍证据由后续验收批次(双 AI 验收/QA)补录,--final 前必须清零"
    },
    "mobile.sso-org.list-state|android-pad|en|cn": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "PR4a 派工包集中批捕预案:合并门=--preview-slice 无 schema 错误;全格实拍证据由后续验收批次(双 AI 验收/QA)补录,--final 前必须清零"
    },
    "mobile.sso-org.list-state|android-pad|en|global": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "PR4a 派工包集中批捕预案:合并门=--preview-slice 无 schema 错误;全格实拍证据由后续验收批次(双 AI 验收/QA)补录,--final 前必须清零"
    },
    "mobile.sso-org.list-state|android-pad|ja|cn": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "PR4a 派工包集中批捕预案:合并门=--preview-slice 无 schema 错误;全格实拍证据由后续验收批次(双 AI 验收/QA)补录,--final 前必须清零"
    },
    "mobile.sso-org.list-state|android-pad|ja|global": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "PR4a 派工包集中批捕预案:合并门=--preview-slice 无 schema 错误;全格实拍证据由后续验收批次(双 AI 验收/QA)补录,--final 前必须清零"
    },
    "mobile.sso-org.list-state|android-pad|ko|cn": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "PR4a 派工包集中批捕预案:合并门=--preview-slice 无 schema 错误;全格实拍证据由后续验收批次(双 AI 验收/QA)补录,--final 前必须清零"
    },
    "mobile.sso-org.list-state|android-pad|ko|global": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "PR4a 派工包集中批捕预案:合并门=--preview-slice 无 schema 错误;全格实拍证据由后续验收批次(双 AI 验收/QA)补录,--final 前必须清零"
    },
    "mobile.account-selection.state|iphone|zh-CN|cn": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "PR4a 派工包集中批捕预案:合并门=--preview-slice 无 schema 错误;全格实拍证据由后续验收批次(双 AI 验收/QA)补录,--final 前必须清零"
    },
    "mobile.account-selection.state|iphone|zh-CN|global": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "PR4a 派工包集中批捕预案:合并门=--preview-slice 无 schema 错误;全格实拍证据由后续验收批次(双 AI 验收/QA)补录,--final 前必须清零"
    },
    "mobile.account-selection.state|iphone|zh-TW|cn": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "PR4a 派工包集中批捕预案:合并门=--preview-slice 无 schema 错误;全格实拍证据由后续验收批次(双 AI 验收/QA)补录,--final 前必须清零"
    },
    "mobile.account-selection.state|iphone|zh-TW|global": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "PR4a 派工包集中批捕预案:合并门=--preview-slice 无 schema 错误;全格实拍证据由后续验收批次(双 AI 验收/QA)补录,--final 前必须清零"
    },
    "mobile.account-selection.state|iphone|en|cn": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "PR4a 派工包集中批捕预案:合并门=--preview-slice 无 schema 错误;全格实拍证据由后续验收批次(双 AI 验收/QA)补录,--final 前必须清零"
    },
    "mobile.account-selection.state|iphone|en|global": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "PR4a 派工包集中批捕预案:合并门=--preview-slice 无 schema 错误;全格实拍证据由后续验收批次(双 AI 验收/QA)补录,--final 前必须清零"
    },
    "mobile.account-selection.state|iphone|ja|cn": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "PR4a 派工包集中批捕预案:合并门=--preview-slice 无 schema 错误;全格实拍证据由后续验收批次(双 AI 验收/QA)补录,--final 前必须清零"
    },
    "mobile.account-selection.state|iphone|ja|global": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "PR4a 派工包集中批捕预案:合并门=--preview-slice 无 schema 错误;全格实拍证据由后续验收批次(双 AI 验收/QA)补录,--final 前必须清零"
    },
    "mobile.account-selection.state|iphone|ko|cn": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "PR4a 派工包集中批捕预案:合并门=--preview-slice 无 schema 错误;全格实拍证据由后续验收批次(双 AI 验收/QA)补录,--final 前必须清零"
    },
    "mobile.account-selection.state|iphone|ko|global": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "PR4a 派工包集中批捕预案:合并门=--preview-slice 无 schema 错误;全格实拍证据由后续验收批次(双 AI 验收/QA)补录,--final 前必须清零"
    },
    "mobile.account-selection.state|android-phone|zh-CN|cn": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "PR4a 派工包集中批捕预案:合并门=--preview-slice 无 schema 错误;全格实拍证据由后续验收批次(双 AI 验收/QA)补录,--final 前必须清零"
    },
    "mobile.account-selection.state|android-phone|zh-CN|global": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "PR4a 派工包集中批捕预案:合并门=--preview-slice 无 schema 错误;全格实拍证据由后续验收批次(双 AI 验收/QA)补录,--final 前必须清零"
    },
    "mobile.account-selection.state|android-phone|zh-TW|cn": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "PR4a 派工包集中批捕预案:合并门=--preview-slice 无 schema 错误;全格实拍证据由后续验收批次(双 AI 验收/QA)补录,--final 前必须清零"
    },
    "mobile.account-selection.state|android-phone|zh-TW|global": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "PR4a 派工包集中批捕预案:合并门=--preview-slice 无 schema 错误;全格实拍证据由后续验收批次(双 AI 验收/QA)补录,--final 前必须清零"
    },
    "mobile.account-selection.state|android-phone|en|cn": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "PR4a 派工包集中批捕预案:合并门=--preview-slice 无 schema 错误;全格实拍证据由后续验收批次(双 AI 验收/QA)补录,--final 前必须清零"
    },
    "mobile.account-selection.state|android-phone|en|global": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "PR4a 派工包集中批捕预案:合并门=--preview-slice 无 schema 错误;全格实拍证据由后续验收批次(双 AI 验收/QA)补录,--final 前必须清零"
    },
    "mobile.account-selection.state|android-phone|ja|cn": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "PR4a 派工包集中批捕预案:合并门=--preview-slice 无 schema 错误;全格实拍证据由后续验收批次(双 AI 验收/QA)补录,--final 前必须清零"
    },
    "mobile.account-selection.state|android-phone|ja|global": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "PR4a 派工包集中批捕预案:合并门=--preview-slice 无 schema 错误;全格实拍证据由后续验收批次(双 AI 验收/QA)补录,--final 前必须清零"
    },
    "mobile.account-selection.state|android-phone|ko|cn": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "PR4a 派工包集中批捕预案:合并门=--preview-slice 无 schema 错误;全格实拍证据由后续验收批次(双 AI 验收/QA)补录,--final 前必须清零"
    },
    "mobile.account-selection.state|android-phone|ko|global": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "PR4a 派工包集中批捕预案:合并门=--preview-slice 无 schema 错误;全格实拍证据由后续验收批次(双 AI 验收/QA)补录,--final 前必须清零"
    },
    "mobile.account-selection.state|ipad|zh-CN|cn": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "PR4a 派工包集中批捕预案:合并门=--preview-slice 无 schema 错误;全格实拍证据由后续验收批次(双 AI 验收/QA)补录,--final 前必须清零"
    },
    "mobile.account-selection.state|ipad|zh-CN|global": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "PR4a 派工包集中批捕预案:合并门=--preview-slice 无 schema 错误;全格实拍证据由后续验收批次(双 AI 验收/QA)补录,--final 前必须清零"
    },
    "mobile.account-selection.state|ipad|zh-TW|cn": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "PR4a 派工包集中批捕预案:合并门=--preview-slice 无 schema 错误;全格实拍证据由后续验收批次(双 AI 验收/QA)补录,--final 前必须清零"
    },
    "mobile.account-selection.state|ipad|zh-TW|global": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "PR4a 派工包集中批捕预案:合并门=--preview-slice 无 schema 错误;全格实拍证据由后续验收批次(双 AI 验收/QA)补录,--final 前必须清零"
    },
    "mobile.account-selection.state|ipad|en|cn": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "PR4a 派工包集中批捕预案:合并门=--preview-slice 无 schema 错误;全格实拍证据由后续验收批次(双 AI 验收/QA)补录,--final 前必须清零"
    },
    "mobile.account-selection.state|ipad|en|global": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "PR4a 派工包集中批捕预案:合并门=--preview-slice 无 schema 错误;全格实拍证据由后续验收批次(双 AI 验收/QA)补录,--final 前必须清零"
    },
    "mobile.account-selection.state|ipad|ja|cn": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "PR4a 派工包集中批捕预案:合并门=--preview-slice 无 schema 错误;全格实拍证据由后续验收批次(双 AI 验收/QA)补录,--final 前必须清零"
    },
    "mobile.account-selection.state|ipad|ja|global": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "PR4a 派工包集中批捕预案:合并门=--preview-slice 无 schema 错误;全格实拍证据由后续验收批次(双 AI 验收/QA)补录,--final 前必须清零"
    },
    "mobile.account-selection.state|ipad|ko|cn": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "PR4a 派工包集中批捕预案:合并门=--preview-slice 无 schema 错误;全格实拍证据由后续验收批次(双 AI 验收/QA)补录,--final 前必须清零"
    },
    "mobile.account-selection.state|ipad|ko|global": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "PR4a 派工包集中批捕预案:合并门=--preview-slice 无 schema 错误;全格实拍证据由后续验收批次(双 AI 验收/QA)补录,--final 前必须清零"
    },
    "mobile.account-selection.state|android-pad|zh-CN|cn": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "PR4a 派工包集中批捕预案:合并门=--preview-slice 无 schema 错误;全格实拍证据由后续验收批次(双 AI 验收/QA)补录,--final 前必须清零"
    },
    "mobile.account-selection.state|android-pad|zh-CN|global": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "PR4a 派工包集中批捕预案:合并门=--preview-slice 无 schema 错误;全格实拍证据由后续验收批次(双 AI 验收/QA)补录,--final 前必须清零"
    },
    "mobile.account-selection.state|android-pad|zh-TW|cn": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "PR4a 派工包集中批捕预案:合并门=--preview-slice 无 schema 错误;全格实拍证据由后续验收批次(双 AI 验收/QA)补录,--final 前必须清零"
    },
    "mobile.account-selection.state|android-pad|zh-TW|global": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "PR4a 派工包集中批捕预案:合并门=--preview-slice 无 schema 错误;全格实拍证据由后续验收批次(双 AI 验收/QA)补录,--final 前必须清零"
    },
    "mobile.account-selection.state|android-pad|en|cn": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "PR4a 派工包集中批捕预案:合并门=--preview-slice 无 schema 错误;全格实拍证据由后续验收批次(双 AI 验收/QA)补录,--final 前必须清零"
    },
    "mobile.account-selection.state|android-pad|en|global": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "PR4a 派工包集中批捕预案:合并门=--preview-slice 无 schema 错误;全格实拍证据由后续验收批次(双 AI 验收/QA)补录,--final 前必须清零"
    },
    "mobile.account-selection.state|android-pad|ja|cn": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "PR4a 派工包集中批捕预案:合并门=--preview-slice 无 schema 错误;全格实拍证据由后续验收批次(双 AI 验收/QA)补录,--final 前必须清零"
    },
    "mobile.account-selection.state|android-pad|ja|global": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "PR4a 派工包集中批捕预案:合并门=--preview-slice 无 schema 错误;全格实拍证据由后续验收批次(双 AI 验收/QA)补录,--final 前必须清零"
    },
    "mobile.account-selection.state|android-pad|ko|cn": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "PR4a 派工包集中批捕预案:合并门=--preview-slice 无 schema 错误;全格实拍证据由后续验收批次(双 AI 验收/QA)补录,--final 前必须清零"
    },
    "mobile.account-selection.state|android-pad|ko|global": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "PR4a 派工包集中批捕预案:合并门=--preview-slice 无 schema 错误;全格实拍证据由后续验收批次(双 AI 验收/QA)补录,--final 前必须清零"
    },
    "mobile.binding.contact-state|iphone|zh-CN|cn": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "PR4a 派工包集中批捕预案:合并门=--preview-slice 无 schema 错误;全格实拍证据由后续验收批次(双 AI 验收/QA)补录,--final 前必须清零"
    },
    "mobile.binding.contact-state|iphone|zh-CN|global": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "PR4a 派工包集中批捕预案:合并门=--preview-slice 无 schema 错误;全格实拍证据由后续验收批次(双 AI 验收/QA)补录,--final 前必须清零"
    },
    "mobile.binding.contact-state|iphone|zh-TW|cn": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "PR4a 派工包集中批捕预案:合并门=--preview-slice 无 schema 错误;全格实拍证据由后续验收批次(双 AI 验收/QA)补录,--final 前必须清零"
    },
    "mobile.binding.contact-state|iphone|zh-TW|global": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "PR4a 派工包集中批捕预案:合并门=--preview-slice 无 schema 错误;全格实拍证据由后续验收批次(双 AI 验收/QA)补录,--final 前必须清零"
    },
    "mobile.binding.contact-state|iphone|en|cn": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "PR4a 派工包集中批捕预案:合并门=--preview-slice 无 schema 错误;全格实拍证据由后续验收批次(双 AI 验收/QA)补录,--final 前必须清零"
    },
    "mobile.binding.contact-state|iphone|en|global": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "PR4a 派工包集中批捕预案:合并门=--preview-slice 无 schema 错误;全格实拍证据由后续验收批次(双 AI 验收/QA)补录,--final 前必须清零"
    },
    "mobile.binding.contact-state|iphone|ja|cn": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "PR4a 派工包集中批捕预案:合并门=--preview-slice 无 schema 错误;全格实拍证据由后续验收批次(双 AI 验收/QA)补录,--final 前必须清零"
    },
    "mobile.binding.contact-state|iphone|ja|global": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "PR4a 派工包集中批捕预案:合并门=--preview-slice 无 schema 错误;全格实拍证据由后续验收批次(双 AI 验收/QA)补录,--final 前必须清零"
    },
    "mobile.binding.contact-state|iphone|ko|cn": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "PR4a 派工包集中批捕预案:合并门=--preview-slice 无 schema 错误;全格实拍证据由后续验收批次(双 AI 验收/QA)补录,--final 前必须清零"
    },
    "mobile.binding.contact-state|iphone|ko|global": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "PR4a 派工包集中批捕预案:合并门=--preview-slice 无 schema 错误;全格实拍证据由后续验收批次(双 AI 验收/QA)补录,--final 前必须清零"
    },
    "mobile.binding.contact-state|android-phone|zh-CN|cn": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "PR4a 派工包集中批捕预案:合并门=--preview-slice 无 schema 错误;全格实拍证据由后续验收批次(双 AI 验收/QA)补录,--final 前必须清零"
    },
    "mobile.binding.contact-state|android-phone|zh-CN|global": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "PR4a 派工包集中批捕预案:合并门=--preview-slice 无 schema 错误;全格实拍证据由后续验收批次(双 AI 验收/QA)补录,--final 前必须清零"
    },
    "mobile.binding.contact-state|android-phone|zh-TW|cn": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "PR4a 派工包集中批捕预案:合并门=--preview-slice 无 schema 错误;全格实拍证据由后续验收批次(双 AI 验收/QA)补录,--final 前必须清零"
    },
    "mobile.binding.contact-state|android-phone|zh-TW|global": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "PR4a 派工包集中批捕预案:合并门=--preview-slice 无 schema 错误;全格实拍证据由后续验收批次(双 AI 验收/QA)补录,--final 前必须清零"
    },
    "mobile.binding.contact-state|android-phone|en|cn": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "PR4a 派工包集中批捕预案:合并门=--preview-slice 无 schema 错误;全格实拍证据由后续验收批次(双 AI 验收/QA)补录,--final 前必须清零"
    },
    "mobile.binding.contact-state|android-phone|en|global": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "PR4a 派工包集中批捕预案:合并门=--preview-slice 无 schema 错误;全格实拍证据由后续验收批次(双 AI 验收/QA)补录,--final 前必须清零"
    },
    "mobile.binding.contact-state|android-phone|ja|cn": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "PR4a 派工包集中批捕预案:合并门=--preview-slice 无 schema 错误;全格实拍证据由后续验收批次(双 AI 验收/QA)补录,--final 前必须清零"
    },
    "mobile.binding.contact-state|android-phone|ja|global": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "PR4a 派工包集中批捕预案:合并门=--preview-slice 无 schema 错误;全格实拍证据由后续验收批次(双 AI 验收/QA)补录,--final 前必须清零"
    },
    "mobile.binding.contact-state|android-phone|ko|cn": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "PR4a 派工包集中批捕预案:合并门=--preview-slice 无 schema 错误;全格实拍证据由后续验收批次(双 AI 验收/QA)补录,--final 前必须清零"
    },
    "mobile.binding.contact-state|android-phone|ko|global": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "PR4a 派工包集中批捕预案:合并门=--preview-slice 无 schema 错误;全格实拍证据由后续验收批次(双 AI 验收/QA)补录,--final 前必须清零"
    },
    "mobile.binding.contact-state|ipad|zh-CN|cn": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "PR4a 派工包集中批捕预案:合并门=--preview-slice 无 schema 错误;全格实拍证据由后续验收批次(双 AI 验收/QA)补录,--final 前必须清零"
    },
    "mobile.binding.contact-state|ipad|zh-CN|global": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "PR4a 派工包集中批捕预案:合并门=--preview-slice 无 schema 错误;全格实拍证据由后续验收批次(双 AI 验收/QA)补录,--final 前必须清零"
    },
    "mobile.binding.contact-state|ipad|zh-TW|cn": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "PR4a 派工包集中批捕预案:合并门=--preview-slice 无 schema 错误;全格实拍证据由后续验收批次(双 AI 验收/QA)补录,--final 前必须清零"
    },
    "mobile.binding.contact-state|ipad|zh-TW|global": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "PR4a 派工包集中批捕预案:合并门=--preview-slice 无 schema 错误;全格实拍证据由后续验收批次(双 AI 验收/QA)补录,--final 前必须清零"
    },
    "mobile.binding.contact-state|ipad|en|cn": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "PR4a 派工包集中批捕预案:合并门=--preview-slice 无 schema 错误;全格实拍证据由后续验收批次(双 AI 验收/QA)补录,--final 前必须清零"
    },
    "mobile.binding.contact-state|ipad|en|global": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "PR4a 派工包集中批捕预案:合并门=--preview-slice 无 schema 错误;全格实拍证据由后续验收批次(双 AI 验收/QA)补录,--final 前必须清零"
    },
    "mobile.binding.contact-state|ipad|ja|cn": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "PR4a 派工包集中批捕预案:合并门=--preview-slice 无 schema 错误;全格实拍证据由后续验收批次(双 AI 验收/QA)补录,--final 前必须清零"
    },
    "mobile.binding.contact-state|ipad|ja|global": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "PR4a 派工包集中批捕预案:合并门=--preview-slice 无 schema 错误;全格实拍证据由后续验收批次(双 AI 验收/QA)补录,--final 前必须清零"
    },
    "mobile.binding.contact-state|ipad|ko|cn": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "PR4a 派工包集中批捕预案:合并门=--preview-slice 无 schema 错误;全格实拍证据由后续验收批次(双 AI 验收/QA)补录,--final 前必须清零"
    },
    "mobile.binding.contact-state|ipad|ko|global": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "PR4a 派工包集中批捕预案:合并门=--preview-slice 无 schema 错误;全格实拍证据由后续验收批次(双 AI 验收/QA)补录,--final 前必须清零"
    },
    "mobile.binding.contact-state|android-pad|zh-CN|cn": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "PR4a 派工包集中批捕预案:合并门=--preview-slice 无 schema 错误;全格实拍证据由后续验收批次(双 AI 验收/QA)补录,--final 前必须清零"
    },
    "mobile.binding.contact-state|android-pad|zh-CN|global": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "PR4a 派工包集中批捕预案:合并门=--preview-slice 无 schema 错误;全格实拍证据由后续验收批次(双 AI 验收/QA)补录,--final 前必须清零"
    },
    "mobile.binding.contact-state|android-pad|zh-TW|cn": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "PR4a 派工包集中批捕预案:合并门=--preview-slice 无 schema 错误;全格实拍证据由后续验收批次(双 AI 验收/QA)补录,--final 前必须清零"
    },
    "mobile.binding.contact-state|android-pad|zh-TW|global": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "PR4a 派工包集中批捕预案:合并门=--preview-slice 无 schema 错误;全格实拍证据由后续验收批次(双 AI 验收/QA)补录,--final 前必须清零"
    },
    "mobile.binding.contact-state|android-pad|en|cn": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "PR4a 派工包集中批捕预案:合并门=--preview-slice 无 schema 错误;全格实拍证据由后续验收批次(双 AI 验收/QA)补录,--final 前必须清零"
    },
    "mobile.binding.contact-state|android-pad|en|global": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "PR4a 派工包集中批捕预案:合并门=--preview-slice 无 schema 错误;全格实拍证据由后续验收批次(双 AI 验收/QA)补录,--final 前必须清零"
    },
    "mobile.binding.contact-state|android-pad|ja|cn": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "PR4a 派工包集中批捕预案:合并门=--preview-slice 无 schema 错误;全格实拍证据由后续验收批次(双 AI 验收/QA)补录,--final 前必须清零"
    },
    "mobile.binding.contact-state|android-pad|ja|global": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "PR4a 派工包集中批捕预案:合并门=--preview-slice 无 schema 错误;全格实拍证据由后续验收批次(双 AI 验收/QA)补录,--final 前必须清零"
    },
    "mobile.binding.contact-state|android-pad|ko|cn": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "PR4a 派工包集中批捕预案:合并门=--preview-slice 无 schema 错误;全格实拍证据由后续验收批次(双 AI 验收/QA)补录,--final 前必须清零"
    },
    "mobile.binding.contact-state|android-pad|ko|global": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "PR4a 派工包集中批捕预案:合并门=--preview-slice 无 schema 错误;全格实拍证据由后续验收批次(双 AI 验收/QA)补录,--final 前必须清零"
    },
    "mobile.binding.code-state|iphone|zh-CN|cn": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "PR4a 派工包集中批捕预案:合并门=--preview-slice 无 schema 错误;全格实拍证据由后续验收批次(双 AI 验收/QA)补录,--final 前必须清零"
    },
    "mobile.binding.code-state|iphone|zh-CN|global": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "PR4a 派工包集中批捕预案:合并门=--preview-slice 无 schema 错误;全格实拍证据由后续验收批次(双 AI 验收/QA)补录,--final 前必须清零"
    },
    "mobile.binding.code-state|iphone|zh-TW|cn": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "PR4a 派工包集中批捕预案:合并门=--preview-slice 无 schema 错误;全格实拍证据由后续验收批次(双 AI 验收/QA)补录,--final 前必须清零"
    },
    "mobile.binding.code-state|iphone|zh-TW|global": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "PR4a 派工包集中批捕预案:合并门=--preview-slice 无 schema 错误;全格实拍证据由后续验收批次(双 AI 验收/QA)补录,--final 前必须清零"
    },
    "mobile.binding.code-state|iphone|en|cn": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "PR4a 派工包集中批捕预案:合并门=--preview-slice 无 schema 错误;全格实拍证据由后续验收批次(双 AI 验收/QA)补录,--final 前必须清零"
    },
    "mobile.binding.code-state|iphone|en|global": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "PR4a 派工包集中批捕预案:合并门=--preview-slice 无 schema 错误;全格实拍证据由后续验收批次(双 AI 验收/QA)补录,--final 前必须清零"
    },
    "mobile.binding.code-state|iphone|ja|cn": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "PR4a 派工包集中批捕预案:合并门=--preview-slice 无 schema 错误;全格实拍证据由后续验收批次(双 AI 验收/QA)补录,--final 前必须清零"
    },
    "mobile.binding.code-state|iphone|ja|global": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "PR4a 派工包集中批捕预案:合并门=--preview-slice 无 schema 错误;全格实拍证据由后续验收批次(双 AI 验收/QA)补录,--final 前必须清零"
    },
    "mobile.binding.code-state|iphone|ko|cn": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "PR4a 派工包集中批捕预案:合并门=--preview-slice 无 schema 错误;全格实拍证据由后续验收批次(双 AI 验收/QA)补录,--final 前必须清零"
    },
    "mobile.binding.code-state|iphone|ko|global": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "PR4a 派工包集中批捕预案:合并门=--preview-slice 无 schema 错误;全格实拍证据由后续验收批次(双 AI 验收/QA)补录,--final 前必须清零"
    },
    "mobile.binding.code-state|android-phone|zh-CN|cn": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "PR4a 派工包集中批捕预案:合并门=--preview-slice 无 schema 错误;全格实拍证据由后续验收批次(双 AI 验收/QA)补录,--final 前必须清零"
    },
    "mobile.binding.code-state|android-phone|zh-CN|global": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "PR4a 派工包集中批捕预案:合并门=--preview-slice 无 schema 错误;全格实拍证据由后续验收批次(双 AI 验收/QA)补录,--final 前必须清零"
    },
    "mobile.binding.code-state|android-phone|zh-TW|cn": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "PR4a 派工包集中批捕预案:合并门=--preview-slice 无 schema 错误;全格实拍证据由后续验收批次(双 AI 验收/QA)补录,--final 前必须清零"
    },
    "mobile.binding.code-state|android-phone|zh-TW|global": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "PR4a 派工包集中批捕预案:合并门=--preview-slice 无 schema 错误;全格实拍证据由后续验收批次(双 AI 验收/QA)补录,--final 前必须清零"
    },
    "mobile.binding.code-state|android-phone|en|cn": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "PR4a 派工包集中批捕预案:合并门=--preview-slice 无 schema 错误;全格实拍证据由后续验收批次(双 AI 验收/QA)补录,--final 前必须清零"
    },
    "mobile.binding.code-state|android-phone|en|global": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "PR4a 派工包集中批捕预案:合并门=--preview-slice 无 schema 错误;全格实拍证据由后续验收批次(双 AI 验收/QA)补录,--final 前必须清零"
    },
    "mobile.binding.code-state|android-phone|ja|cn": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "PR4a 派工包集中批捕预案:合并门=--preview-slice 无 schema 错误;全格实拍证据由后续验收批次(双 AI 验收/QA)补录,--final 前必须清零"
    },
    "mobile.binding.code-state|android-phone|ja|global": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "PR4a 派工包集中批捕预案:合并门=--preview-slice 无 schema 错误;全格实拍证据由后续验收批次(双 AI 验收/QA)补录,--final 前必须清零"
    },
    "mobile.binding.code-state|android-phone|ko|cn": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "PR4a 派工包集中批捕预案:合并门=--preview-slice 无 schema 错误;全格实拍证据由后续验收批次(双 AI 验收/QA)补录,--final 前必须清零"
    },
    "mobile.binding.code-state|android-phone|ko|global": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "PR4a 派工包集中批捕预案:合并门=--preview-slice 无 schema 错误;全格实拍证据由后续验收批次(双 AI 验收/QA)补录,--final 前必须清零"
    },
    "mobile.binding.code-state|ipad|zh-CN|cn": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "PR4a 派工包集中批捕预案:合并门=--preview-slice 无 schema 错误;全格实拍证据由后续验收批次(双 AI 验收/QA)补录,--final 前必须清零"
    },
    "mobile.binding.code-state|ipad|zh-CN|global": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "PR4a 派工包集中批捕预案:合并门=--preview-slice 无 schema 错误;全格实拍证据由后续验收批次(双 AI 验收/QA)补录,--final 前必须清零"
    },
    "mobile.binding.code-state|ipad|zh-TW|cn": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "PR4a 派工包集中批捕预案:合并门=--preview-slice 无 schema 错误;全格实拍证据由后续验收批次(双 AI 验收/QA)补录,--final 前必须清零"
    },
    "mobile.binding.code-state|ipad|zh-TW|global": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "PR4a 派工包集中批捕预案:合并门=--preview-slice 无 schema 错误;全格实拍证据由后续验收批次(双 AI 验收/QA)补录,--final 前必须清零"
    },
    "mobile.binding.code-state|ipad|en|cn": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "PR4a 派工包集中批捕预案:合并门=--preview-slice 无 schema 错误;全格实拍证据由后续验收批次(双 AI 验收/QA)补录,--final 前必须清零"
    },
    "mobile.binding.code-state|ipad|en|global": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "PR4a 派工包集中批捕预案:合并门=--preview-slice 无 schema 错误;全格实拍证据由后续验收批次(双 AI 验收/QA)补录,--final 前必须清零"
    },
    "mobile.binding.code-state|ipad|ja|cn": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "PR4a 派工包集中批捕预案:合并门=--preview-slice 无 schema 错误;全格实拍证据由后续验收批次(双 AI 验收/QA)补录,--final 前必须清零"
    },
    "mobile.binding.code-state|ipad|ja|global": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "PR4a 派工包集中批捕预案:合并门=--preview-slice 无 schema 错误;全格实拍证据由后续验收批次(双 AI 验收/QA)补录,--final 前必须清零"
    },
    "mobile.binding.code-state|ipad|ko|cn": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "PR4a 派工包集中批捕预案:合并门=--preview-slice 无 schema 错误;全格实拍证据由后续验收批次(双 AI 验收/QA)补录,--final 前必须清零"
    },
    "mobile.binding.code-state|ipad|ko|global": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "PR4a 派工包集中批捕预案:合并门=--preview-slice 无 schema 错误;全格实拍证据由后续验收批次(双 AI 验收/QA)补录,--final 前必须清零"
    },
    "mobile.binding.code-state|android-pad|zh-CN|cn": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "PR4a 派工包集中批捕预案:合并门=--preview-slice 无 schema 错误;全格实拍证据由后续验收批次(双 AI 验收/QA)补录,--final 前必须清零"
    },
    "mobile.binding.code-state|android-pad|zh-CN|global": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "PR4a 派工包集中批捕预案:合并门=--preview-slice 无 schema 错误;全格实拍证据由后续验收批次(双 AI 验收/QA)补录,--final 前必须清零"
    },
    "mobile.binding.code-state|android-pad|zh-TW|cn": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "PR4a 派工包集中批捕预案:合并门=--preview-slice 无 schema 错误;全格实拍证据由后续验收批次(双 AI 验收/QA)补录,--final 前必须清零"
    },
    "mobile.binding.code-state|android-pad|zh-TW|global": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "PR4a 派工包集中批捕预案:合并门=--preview-slice 无 schema 错误;全格实拍证据由后续验收批次(双 AI 验收/QA)补录,--final 前必须清零"
    },
    "mobile.binding.code-state|android-pad|en|cn": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "PR4a 派工包集中批捕预案:合并门=--preview-slice 无 schema 错误;全格实拍证据由后续验收批次(双 AI 验收/QA)补录,--final 前必须清零"
    },
    "mobile.binding.code-state|android-pad|en|global": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "PR4a 派工包集中批捕预案:合并门=--preview-slice 无 schema 错误;全格实拍证据由后续验收批次(双 AI 验收/QA)补录,--final 前必须清零"
    },
    "mobile.binding.code-state|android-pad|ja|cn": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "PR4a 派工包集中批捕预案:合并门=--preview-slice 无 schema 错误;全格实拍证据由后续验收批次(双 AI 验收/QA)补录,--final 前必须清零"
    },
    "mobile.binding.code-state|android-pad|ja|global": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "PR4a 派工包集中批捕预案:合并门=--preview-slice 无 schema 错误;全格实拍证据由后续验收批次(双 AI 验收/QA)补录,--final 前必须清零"
    },
    "mobile.binding.code-state|android-pad|ko|cn": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "PR4a 派工包集中批捕预案:合并门=--preview-slice 无 schema 错误;全格实拍证据由后续验收批次(双 AI 验收/QA)补录,--final 前必须清零"
    },
    "mobile.binding.code-state|android-pad|ko|global": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "PR4a 派工包集中批捕预案:合并门=--preview-slice 无 schema 错误;全格实拍证据由后续验收批次(双 AI 验收/QA)补录,--final 前必须清零"
    },
    "mobile.browser-redirect.state|iphone|zh-CN|cn": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "PR4a 派工包集中批捕预案:合并门=--preview-slice 无 schema 错误;全格实拍证据由后续验收批次(双 AI 验收/QA)补录,--final 前必须清零"
    },
    "mobile.browser-redirect.state|iphone|zh-CN|global": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "PR4a 派工包集中批捕预案:合并门=--preview-slice 无 schema 错误;全格实拍证据由后续验收批次(双 AI 验收/QA)补录,--final 前必须清零"
    },
    "mobile.browser-redirect.state|iphone|zh-TW|cn": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "PR4a 派工包集中批捕预案:合并门=--preview-slice 无 schema 错误;全格实拍证据由后续验收批次(双 AI 验收/QA)补录,--final 前必须清零"
    },
    "mobile.browser-redirect.state|iphone|zh-TW|global": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "PR4a 派工包集中批捕预案:合并门=--preview-slice 无 schema 错误;全格实拍证据由后续验收批次(双 AI 验收/QA)补录,--final 前必须清零"
    },
    "mobile.browser-redirect.state|iphone|en|cn": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "PR4a 派工包集中批捕预案:合并门=--preview-slice 无 schema 错误;全格实拍证据由后续验收批次(双 AI 验收/QA)补录,--final 前必须清零"
    },
    "mobile.browser-redirect.state|iphone|en|global": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "PR4a 派工包集中批捕预案:合并门=--preview-slice 无 schema 错误;全格实拍证据由后续验收批次(双 AI 验收/QA)补录,--final 前必须清零"
    },
    "mobile.browser-redirect.state|iphone|ja|cn": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "PR4a 派工包集中批捕预案:合并门=--preview-slice 无 schema 错误;全格实拍证据由后续验收批次(双 AI 验收/QA)补录,--final 前必须清零"
    },
    "mobile.browser-redirect.state|iphone|ja|global": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "PR4a 派工包集中批捕预案:合并门=--preview-slice 无 schema 错误;全格实拍证据由后续验收批次(双 AI 验收/QA)补录,--final 前必须清零"
    },
    "mobile.browser-redirect.state|iphone|ko|cn": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "PR4a 派工包集中批捕预案:合并门=--preview-slice 无 schema 错误;全格实拍证据由后续验收批次(双 AI 验收/QA)补录,--final 前必须清零"
    },
    "mobile.browser-redirect.state|iphone|ko|global": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "PR4a 派工包集中批捕预案:合并门=--preview-slice 无 schema 错误;全格实拍证据由后续验收批次(双 AI 验收/QA)补录,--final 前必须清零"
    },
    "mobile.browser-redirect.state|android-phone|zh-CN|cn": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "PR4a 派工包集中批捕预案:合并门=--preview-slice 无 schema 错误;全格实拍证据由后续验收批次(双 AI 验收/QA)补录,--final 前必须清零"
    },
    "mobile.browser-redirect.state|android-phone|zh-CN|global": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "PR4a 派工包集中批捕预案:合并门=--preview-slice 无 schema 错误;全格实拍证据由后续验收批次(双 AI 验收/QA)补录,--final 前必须清零"
    },
    "mobile.browser-redirect.state|android-phone|zh-TW|cn": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "PR4a 派工包集中批捕预案:合并门=--preview-slice 无 schema 错误;全格实拍证据由后续验收批次(双 AI 验收/QA)补录,--final 前必须清零"
    },
    "mobile.browser-redirect.state|android-phone|zh-TW|global": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "PR4a 派工包集中批捕预案:合并门=--preview-slice 无 schema 错误;全格实拍证据由后续验收批次(双 AI 验收/QA)补录,--final 前必须清零"
    },
    "mobile.browser-redirect.state|android-phone|en|cn": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "PR4a 派工包集中批捕预案:合并门=--preview-slice 无 schema 错误;全格实拍证据由后续验收批次(双 AI 验收/QA)补录,--final 前必须清零"
    },
    "mobile.browser-redirect.state|android-phone|en|global": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "PR4a 派工包集中批捕预案:合并门=--preview-slice 无 schema 错误;全格实拍证据由后续验收批次(双 AI 验收/QA)补录,--final 前必须清零"
    },
    "mobile.browser-redirect.state|android-phone|ja|cn": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "PR4a 派工包集中批捕预案:合并门=--preview-slice 无 schema 错误;全格实拍证据由后续验收批次(双 AI 验收/QA)补录,--final 前必须清零"
    },
    "mobile.browser-redirect.state|android-phone|ja|global": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "PR4a 派工包集中批捕预案:合并门=--preview-slice 无 schema 错误;全格实拍证据由后续验收批次(双 AI 验收/QA)补录,--final 前必须清零"
    },
    "mobile.browser-redirect.state|android-phone|ko|cn": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "PR4a 派工包集中批捕预案:合并门=--preview-slice 无 schema 错误;全格实拍证据由后续验收批次(双 AI 验收/QA)补录,--final 前必须清零"
    },
    "mobile.browser-redirect.state|android-phone|ko|global": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "PR4a 派工包集中批捕预案:合并门=--preview-slice 无 schema 错误;全格实拍证据由后续验收批次(双 AI 验收/QA)补录,--final 前必须清零"
    },
    "mobile.browser-redirect.state|ipad|zh-CN|cn": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "PR4a 派工包集中批捕预案:合并门=--preview-slice 无 schema 错误;全格实拍证据由后续验收批次(双 AI 验收/QA)补录,--final 前必须清零"
    },
    "mobile.browser-redirect.state|ipad|zh-CN|global": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "PR4a 派工包集中批捕预案:合并门=--preview-slice 无 schema 错误;全格实拍证据由后续验收批次(双 AI 验收/QA)补录,--final 前必须清零"
    },
    "mobile.browser-redirect.state|ipad|zh-TW|cn": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "PR4a 派工包集中批捕预案:合并门=--preview-slice 无 schema 错误;全格实拍证据由后续验收批次(双 AI 验收/QA)补录,--final 前必须清零"
    },
    "mobile.browser-redirect.state|ipad|zh-TW|global": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "PR4a 派工包集中批捕预案:合并门=--preview-slice 无 schema 错误;全格实拍证据由后续验收批次(双 AI 验收/QA)补录,--final 前必须清零"
    },
    "mobile.browser-redirect.state|ipad|en|cn": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "PR4a 派工包集中批捕预案:合并门=--preview-slice 无 schema 错误;全格实拍证据由后续验收批次(双 AI 验收/QA)补录,--final 前必须清零"
    },
    "mobile.browser-redirect.state|ipad|en|global": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "PR4a 派工包集中批捕预案:合并门=--preview-slice 无 schema 错误;全格实拍证据由后续验收批次(双 AI 验收/QA)补录,--final 前必须清零"
    },
    "mobile.browser-redirect.state|ipad|ja|cn": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "PR4a 派工包集中批捕预案:合并门=--preview-slice 无 schema 错误;全格实拍证据由后续验收批次(双 AI 验收/QA)补录,--final 前必须清零"
    },
    "mobile.browser-redirect.state|ipad|ja|global": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "PR4a 派工包集中批捕预案:合并门=--preview-slice 无 schema 错误;全格实拍证据由后续验收批次(双 AI 验收/QA)补录,--final 前必须清零"
    },
    "mobile.browser-redirect.state|ipad|ko|cn": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "PR4a 派工包集中批捕预案:合并门=--preview-slice 无 schema 错误;全格实拍证据由后续验收批次(双 AI 验收/QA)补录,--final 前必须清零"
    },
    "mobile.browser-redirect.state|ipad|ko|global": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "PR4a 派工包集中批捕预案:合并门=--preview-slice 无 schema 错误;全格实拍证据由后续验收批次(双 AI 验收/QA)补录,--final 前必须清零"
    },
    "mobile.browser-redirect.state|android-pad|zh-CN|cn": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "PR4a 派工包集中批捕预案:合并门=--preview-slice 无 schema 错误;全格实拍证据由后续验收批次(双 AI 验收/QA)补录,--final 前必须清零"
    },
    "mobile.browser-redirect.state|android-pad|zh-CN|global": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "PR4a 派工包集中批捕预案:合并门=--preview-slice 无 schema 错误;全格实拍证据由后续验收批次(双 AI 验收/QA)补录,--final 前必须清零"
    },
    "mobile.browser-redirect.state|android-pad|zh-TW|cn": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "PR4a 派工包集中批捕预案:合并门=--preview-slice 无 schema 错误;全格实拍证据由后续验收批次(双 AI 验收/QA)补录,--final 前必须清零"
    },
    "mobile.browser-redirect.state|android-pad|zh-TW|global": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "PR4a 派工包集中批捕预案:合并门=--preview-slice 无 schema 错误;全格实拍证据由后续验收批次(双 AI 验收/QA)补录,--final 前必须清零"
    },
    "mobile.browser-redirect.state|android-pad|en|cn": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "PR4a 派工包集中批捕预案:合并门=--preview-slice 无 schema 错误;全格实拍证据由后续验收批次(双 AI 验收/QA)补录,--final 前必须清零"
    },
    "mobile.browser-redirect.state|android-pad|en|global": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "PR4a 派工包集中批捕预案:合并门=--preview-slice 无 schema 错误;全格实拍证据由后续验收批次(双 AI 验收/QA)补录,--final 前必须清零"
    },
    "mobile.browser-redirect.state|android-pad|ja|cn": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "PR4a 派工包集中批捕预案:合并门=--preview-slice 无 schema 错误;全格实拍证据由后续验收批次(双 AI 验收/QA)补录,--final 前必须清零"
    },
    "mobile.browser-redirect.state|android-pad|ja|global": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "PR4a 派工包集中批捕预案:合并门=--preview-slice 无 schema 错误;全格实拍证据由后续验收批次(双 AI 验收/QA)补录,--final 前必须清零"
    },
    "mobile.browser-redirect.state|android-pad|ko|cn": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "PR4a 派工包集中批捕预案:合并门=--preview-slice 无 schema 错误;全格实拍证据由后续验收批次(双 AI 验收/QA)补录,--final 前必须清零"
    },
    "mobile.browser-redirect.state|android-pad|ko|global": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "PR4a 派工包集中批捕预案:合并门=--preview-slice 无 schema 错误;全格实拍证据由后续验收批次(双 AI 验收/QA)补录,--final 前必须清零"
    },
    "mobile.preparing.state|iphone|zh-CN|cn": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "PR4a 派工包集中批捕预案:合并门=--preview-slice 无 schema 错误;全格实拍证据由后续验收批次(双 AI 验收/QA)补录,--final 前必须清零"
    },
    "mobile.preparing.state|iphone|zh-CN|global": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "PR4a 派工包集中批捕预案:合并门=--preview-slice 无 schema 错误;全格实拍证据由后续验收批次(双 AI 验收/QA)补录,--final 前必须清零"
    },
    "mobile.preparing.state|iphone|zh-TW|cn": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "PR4a 派工包集中批捕预案:合并门=--preview-slice 无 schema 错误;全格实拍证据由后续验收批次(双 AI 验收/QA)补录,--final 前必须清零"
    },
    "mobile.preparing.state|iphone|zh-TW|global": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "PR4a 派工包集中批捕预案:合并门=--preview-slice 无 schema 错误;全格实拍证据由后续验收批次(双 AI 验收/QA)补录,--final 前必须清零"
    },
    "mobile.preparing.state|iphone|en|cn": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "PR4a 派工包集中批捕预案:合并门=--preview-slice 无 schema 错误;全格实拍证据由后续验收批次(双 AI 验收/QA)补录,--final 前必须清零"
    },
    "mobile.preparing.state|iphone|en|global": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "PR4a 派工包集中批捕预案:合并门=--preview-slice 无 schema 错误;全格实拍证据由后续验收批次(双 AI 验收/QA)补录,--final 前必须清零"
    },
    "mobile.preparing.state|iphone|ja|cn": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "PR4a 派工包集中批捕预案:合并门=--preview-slice 无 schema 错误;全格实拍证据由后续验收批次(双 AI 验收/QA)补录,--final 前必须清零"
    },
    "mobile.preparing.state|iphone|ja|global": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "PR4a 派工包集中批捕预案:合并门=--preview-slice 无 schema 错误;全格实拍证据由后续验收批次(双 AI 验收/QA)补录,--final 前必须清零"
    },
    "mobile.preparing.state|iphone|ko|cn": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "PR4a 派工包集中批捕预案:合并门=--preview-slice 无 schema 错误;全格实拍证据由后续验收批次(双 AI 验收/QA)补录,--final 前必须清零"
    },
    "mobile.preparing.state|iphone|ko|global": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "PR4a 派工包集中批捕预案:合并门=--preview-slice 无 schema 错误;全格实拍证据由后续验收批次(双 AI 验收/QA)补录,--final 前必须清零"
    },
    "mobile.preparing.state|android-phone|zh-CN|cn": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "PR4a 派工包集中批捕预案:合并门=--preview-slice 无 schema 错误;全格实拍证据由后续验收批次(双 AI 验收/QA)补录,--final 前必须清零"
    },
    "mobile.preparing.state|android-phone|zh-CN|global": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "PR4a 派工包集中批捕预案:合并门=--preview-slice 无 schema 错误;全格实拍证据由后续验收批次(双 AI 验收/QA)补录,--final 前必须清零"
    },
    "mobile.preparing.state|android-phone|zh-TW|cn": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "PR4a 派工包集中批捕预案:合并门=--preview-slice 无 schema 错误;全格实拍证据由后续验收批次(双 AI 验收/QA)补录,--final 前必须清零"
    },
    "mobile.preparing.state|android-phone|zh-TW|global": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "PR4a 派工包集中批捕预案:合并门=--preview-slice 无 schema 错误;全格实拍证据由后续验收批次(双 AI 验收/QA)补录,--final 前必须清零"
    },
    "mobile.preparing.state|android-phone|en|cn": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "PR4a 派工包集中批捕预案:合并门=--preview-slice 无 schema 错误;全格实拍证据由后续验收批次(双 AI 验收/QA)补录,--final 前必须清零"
    },
    "mobile.preparing.state|android-phone|en|global": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "PR4a 派工包集中批捕预案:合并门=--preview-slice 无 schema 错误;全格实拍证据由后续验收批次(双 AI 验收/QA)补录,--final 前必须清零"
    },
    "mobile.preparing.state|android-phone|ja|cn": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "PR4a 派工包集中批捕预案:合并门=--preview-slice 无 schema 错误;全格实拍证据由后续验收批次(双 AI 验收/QA)补录,--final 前必须清零"
    },
    "mobile.preparing.state|android-phone|ja|global": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "PR4a 派工包集中批捕预案:合并门=--preview-slice 无 schema 错误;全格实拍证据由后续验收批次(双 AI 验收/QA)补录,--final 前必须清零"
    },
    "mobile.preparing.state|android-phone|ko|cn": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "PR4a 派工包集中批捕预案:合并门=--preview-slice 无 schema 错误;全格实拍证据由后续验收批次(双 AI 验收/QA)补录,--final 前必须清零"
    },
    "mobile.preparing.state|android-phone|ko|global": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "PR4a 派工包集中批捕预案:合并门=--preview-slice 无 schema 错误;全格实拍证据由后续验收批次(双 AI 验收/QA)补录,--final 前必须清零"
    },
    "mobile.preparing.state|ipad|zh-CN|cn": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "PR4a 派工包集中批捕预案:合并门=--preview-slice 无 schema 错误;全格实拍证据由后续验收批次(双 AI 验收/QA)补录,--final 前必须清零"
    },
    "mobile.preparing.state|ipad|zh-CN|global": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "PR4a 派工包集中批捕预案:合并门=--preview-slice 无 schema 错误;全格实拍证据由后续验收批次(双 AI 验收/QA)补录,--final 前必须清零"
    },
    "mobile.preparing.state|ipad|zh-TW|cn": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "PR4a 派工包集中批捕预案:合并门=--preview-slice 无 schema 错误;全格实拍证据由后续验收批次(双 AI 验收/QA)补录,--final 前必须清零"
    },
    "mobile.preparing.state|ipad|zh-TW|global": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "PR4a 派工包集中批捕预案:合并门=--preview-slice 无 schema 错误;全格实拍证据由后续验收批次(双 AI 验收/QA)补录,--final 前必须清零"
    },
    "mobile.preparing.state|ipad|en|cn": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "PR4a 派工包集中批捕预案:合并门=--preview-slice 无 schema 错误;全格实拍证据由后续验收批次(双 AI 验收/QA)补录,--final 前必须清零"
    },
    "mobile.preparing.state|ipad|en|global": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "PR4a 派工包集中批捕预案:合并门=--preview-slice 无 schema 错误;全格实拍证据由后续验收批次(双 AI 验收/QA)补录,--final 前必须清零"
    },
    "mobile.preparing.state|ipad|ja|cn": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "PR4a 派工包集中批捕预案:合并门=--preview-slice 无 schema 错误;全格实拍证据由后续验收批次(双 AI 验收/QA)补录,--final 前必须清零"
    },
    "mobile.preparing.state|ipad|ja|global": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "PR4a 派工包集中批捕预案:合并门=--preview-slice 无 schema 错误;全格实拍证据由后续验收批次(双 AI 验收/QA)补录,--final 前必须清零"
    },
    "mobile.preparing.state|ipad|ko|cn": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "PR4a 派工包集中批捕预案:合并门=--preview-slice 无 schema 错误;全格实拍证据由后续验收批次(双 AI 验收/QA)补录,--final 前必须清零"
    },
    "mobile.preparing.state|ipad|ko|global": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "PR4a 派工包集中批捕预案:合并门=--preview-slice 无 schema 错误;全格实拍证据由后续验收批次(双 AI 验收/QA)补录,--final 前必须清零"
    },
    "mobile.preparing.state|android-pad|zh-CN|cn": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "PR4a 派工包集中批捕预案:合并门=--preview-slice 无 schema 错误;全格实拍证据由后续验收批次(双 AI 验收/QA)补录,--final 前必须清零"
    },
    "mobile.preparing.state|android-pad|zh-CN|global": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "PR4a 派工包集中批捕预案:合并门=--preview-slice 无 schema 错误;全格实拍证据由后续验收批次(双 AI 验收/QA)补录,--final 前必须清零"
    },
    "mobile.preparing.state|android-pad|zh-TW|cn": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "PR4a 派工包集中批捕预案:合并门=--preview-slice 无 schema 错误;全格实拍证据由后续验收批次(双 AI 验收/QA)补录,--final 前必须清零"
    },
    "mobile.preparing.state|android-pad|zh-TW|global": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "PR4a 派工包集中批捕预案:合并门=--preview-slice 无 schema 错误;全格实拍证据由后续验收批次(双 AI 验收/QA)补录,--final 前必须清零"
    },
    "mobile.preparing.state|android-pad|en|cn": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "PR4a 派工包集中批捕预案:合并门=--preview-slice 无 schema 错误;全格实拍证据由后续验收批次(双 AI 验收/QA)补录,--final 前必须清零"
    },
    "mobile.preparing.state|android-pad|en|global": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "PR4a 派工包集中批捕预案:合并门=--preview-slice 无 schema 错误;全格实拍证据由后续验收批次(双 AI 验收/QA)补录,--final 前必须清零"
    },
    "mobile.preparing.state|android-pad|ja|cn": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "PR4a 派工包集中批捕预案:合并门=--preview-slice 无 schema 错误;全格实拍证据由后续验收批次(双 AI 验收/QA)补录,--final 前必须清零"
    },
    "mobile.preparing.state|android-pad|ja|global": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "PR4a 派工包集中批捕预案:合并门=--preview-slice 无 schema 错误;全格实拍证据由后续验收批次(双 AI 验收/QA)补录,--final 前必须清零"
    },
    "mobile.preparing.state|android-pad|ko|cn": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "PR4a 派工包集中批捕预案:合并门=--preview-slice 无 schema 错误;全格实拍证据由后续验收批次(双 AI 验收/QA)补录,--final 前必须清零"
    },
    "mobile.preparing.state|android-pad|ko|global": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "PR4a 派工包集中批捕预案:合并门=--preview-slice 无 schema 错误;全格实拍证据由后续验收批次(双 AI 验收/QA)补录,--final 前必须清零"
    },
    "mobile.error.state|iphone|zh-CN|cn": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "PR4a 派工包集中批捕预案:合并门=--preview-slice 无 schema 错误;全格实拍证据由后续验收批次(双 AI 验收/QA)补录,--final 前必须清零"
    },
    "mobile.error.state|iphone|zh-CN|global": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "PR4a 派工包集中批捕预案:合并门=--preview-slice 无 schema 错误;全格实拍证据由后续验收批次(双 AI 验收/QA)补录,--final 前必须清零"
    },
    "mobile.error.state|iphone|zh-TW|cn": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "PR4a 派工包集中批捕预案:合并门=--preview-slice 无 schema 错误;全格实拍证据由后续验收批次(双 AI 验收/QA)补录,--final 前必须清零"
    },
    "mobile.error.state|iphone|zh-TW|global": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "PR4a 派工包集中批捕预案:合并门=--preview-slice 无 schema 错误;全格实拍证据由后续验收批次(双 AI 验收/QA)补录,--final 前必须清零"
    },
    "mobile.error.state|iphone|en|cn": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "PR4a 派工包集中批捕预案:合并门=--preview-slice 无 schema 错误;全格实拍证据由后续验收批次(双 AI 验收/QA)补录,--final 前必须清零"
    },
    "mobile.error.state|iphone|en|global": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "PR4a 派工包集中批捕预案:合并门=--preview-slice 无 schema 错误;全格实拍证据由后续验收批次(双 AI 验收/QA)补录,--final 前必须清零"
    },
    "mobile.error.state|iphone|ja|cn": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "PR4a 派工包集中批捕预案:合并门=--preview-slice 无 schema 错误;全格实拍证据由后续验收批次(双 AI 验收/QA)补录,--final 前必须清零"
    },
    "mobile.error.state|iphone|ja|global": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "PR4a 派工包集中批捕预案:合并门=--preview-slice 无 schema 错误;全格实拍证据由后续验收批次(双 AI 验收/QA)补录,--final 前必须清零"
    },
    "mobile.error.state|iphone|ko|cn": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "PR4a 派工包集中批捕预案:合并门=--preview-slice 无 schema 错误;全格实拍证据由后续验收批次(双 AI 验收/QA)补录,--final 前必须清零"
    },
    "mobile.error.state|iphone|ko|global": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "PR4a 派工包集中批捕预案:合并门=--preview-slice 无 schema 错误;全格实拍证据由后续验收批次(双 AI 验收/QA)补录,--final 前必须清零"
    },
    "mobile.error.state|android-phone|zh-CN|cn": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "PR4a 派工包集中批捕预案:合并门=--preview-slice 无 schema 错误;全格实拍证据由后续验收批次(双 AI 验收/QA)补录,--final 前必须清零"
    },
    "mobile.error.state|android-phone|zh-CN|global": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "PR4a 派工包集中批捕预案:合并门=--preview-slice 无 schema 错误;全格实拍证据由后续验收批次(双 AI 验收/QA)补录,--final 前必须清零"
    },
    "mobile.error.state|android-phone|zh-TW|cn": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "PR4a 派工包集中批捕预案:合并门=--preview-slice 无 schema 错误;全格实拍证据由后续验收批次(双 AI 验收/QA)补录,--final 前必须清零"
    },
    "mobile.error.state|android-phone|zh-TW|global": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "PR4a 派工包集中批捕预案:合并门=--preview-slice 无 schema 错误;全格实拍证据由后续验收批次(双 AI 验收/QA)补录,--final 前必须清零"
    },
    "mobile.error.state|android-phone|en|cn": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "PR4a 派工包集中批捕预案:合并门=--preview-slice 无 schema 错误;全格实拍证据由后续验收批次(双 AI 验收/QA)补录,--final 前必须清零"
    },
    "mobile.error.state|android-phone|en|global": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "PR4a 派工包集中批捕预案:合并门=--preview-slice 无 schema 错误;全格实拍证据由后续验收批次(双 AI 验收/QA)补录,--final 前必须清零"
    },
    "mobile.error.state|android-phone|ja|cn": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "PR4a 派工包集中批捕预案:合并门=--preview-slice 无 schema 错误;全格实拍证据由后续验收批次(双 AI 验收/QA)补录,--final 前必须清零"
    },
    "mobile.error.state|android-phone|ja|global": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "PR4a 派工包集中批捕预案:合并门=--preview-slice 无 schema 错误;全格实拍证据由后续验收批次(双 AI 验收/QA)补录,--final 前必须清零"
    },
    "mobile.error.state|android-phone|ko|cn": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "PR4a 派工包集中批捕预案:合并门=--preview-slice 无 schema 错误;全格实拍证据由后续验收批次(双 AI 验收/QA)补录,--final 前必须清零"
    },
    "mobile.error.state|android-phone|ko|global": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "PR4a 派工包集中批捕预案:合并门=--preview-slice 无 schema 错误;全格实拍证据由后续验收批次(双 AI 验收/QA)补录,--final 前必须清零"
    },
    "mobile.error.state|ipad|zh-CN|cn": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "PR4a 派工包集中批捕预案:合并门=--preview-slice 无 schema 错误;全格实拍证据由后续验收批次(双 AI 验收/QA)补录,--final 前必须清零"
    },
    "mobile.error.state|ipad|zh-CN|global": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "PR4a 派工包集中批捕预案:合并门=--preview-slice 无 schema 错误;全格实拍证据由后续验收批次(双 AI 验收/QA)补录,--final 前必须清零"
    },
    "mobile.error.state|ipad|zh-TW|cn": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "PR4a 派工包集中批捕预案:合并门=--preview-slice 无 schema 错误;全格实拍证据由后续验收批次(双 AI 验收/QA)补录,--final 前必须清零"
    },
    "mobile.error.state|ipad|zh-TW|global": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "PR4a 派工包集中批捕预案:合并门=--preview-slice 无 schema 错误;全格实拍证据由后续验收批次(双 AI 验收/QA)补录,--final 前必须清零"
    },
    "mobile.error.state|ipad|en|cn": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "PR4a 派工包集中批捕预案:合并门=--preview-slice 无 schema 错误;全格实拍证据由后续验收批次(双 AI 验收/QA)补录,--final 前必须清零"
    },
    "mobile.error.state|ipad|en|global": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "PR4a 派工包集中批捕预案:合并门=--preview-slice 无 schema 错误;全格实拍证据由后续验收批次(双 AI 验收/QA)补录,--final 前必须清零"
    },
    "mobile.error.state|ipad|ja|cn": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "PR4a 派工包集中批捕预案:合并门=--preview-slice 无 schema 错误;全格实拍证据由后续验收批次(双 AI 验收/QA)补录,--final 前必须清零"
    },
    "mobile.error.state|ipad|ja|global": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "PR4a 派工包集中批捕预案:合并门=--preview-slice 无 schema 错误;全格实拍证据由后续验收批次(双 AI 验收/QA)补录,--final 前必须清零"
    },
    "mobile.error.state|ipad|ko|cn": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "PR4a 派工包集中批捕预案:合并门=--preview-slice 无 schema 错误;全格实拍证据由后续验收批次(双 AI 验收/QA)补录,--final 前必须清零"
    },
    "mobile.error.state|ipad|ko|global": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "PR4a 派工包集中批捕预案:合并门=--preview-slice 无 schema 错误;全格实拍证据由后续验收批次(双 AI 验收/QA)补录,--final 前必须清零"
    },
    "mobile.error.state|android-pad|zh-CN|cn": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "PR4a 派工包集中批捕预案:合并门=--preview-slice 无 schema 错误;全格实拍证据由后续验收批次(双 AI 验收/QA)补录,--final 前必须清零"
    },
    "mobile.error.state|android-pad|zh-CN|global": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "PR4a 派工包集中批捕预案:合并门=--preview-slice 无 schema 错误;全格实拍证据由后续验收批次(双 AI 验收/QA)补录,--final 前必须清零"
    },
    "mobile.error.state|android-pad|zh-TW|cn": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "PR4a 派工包集中批捕预案:合并门=--preview-slice 无 schema 错误;全格实拍证据由后续验收批次(双 AI 验收/QA)补录,--final 前必须清零"
    },
    "mobile.error.state|android-pad|zh-TW|global": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "PR4a 派工包集中批捕预案:合并门=--preview-slice 无 schema 错误;全格实拍证据由后续验收批次(双 AI 验收/QA)补录,--final 前必须清零"
    },
    "mobile.error.state|android-pad|en|cn": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "PR4a 派工包集中批捕预案:合并门=--preview-slice 无 schema 错误;全格实拍证据由后续验收批次(双 AI 验收/QA)补录,--final 前必须清零"
    },
    "mobile.error.state|android-pad|en|global": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "PR4a 派工包集中批捕预案:合并门=--preview-slice 无 schema 错误;全格实拍证据由后续验收批次(双 AI 验收/QA)补录,--final 前必须清零"
    },
    "mobile.error.state|android-pad|ja|cn": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "PR4a 派工包集中批捕预案:合并门=--preview-slice 无 schema 错误;全格实拍证据由后续验收批次(双 AI 验收/QA)补录,--final 前必须清零"
    },
    "mobile.error.state|android-pad|ja|global": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "PR4a 派工包集中批捕预案:合并门=--preview-slice 无 schema 错误;全格实拍证据由后续验收批次(双 AI 验收/QA)补录,--final 前必须清零"
    },
    "mobile.error.state|android-pad|ko|cn": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "PR4a 派工包集中批捕预案:合并门=--preview-slice 无 schema 错误;全格实拍证据由后续验收批次(双 AI 验收/QA)补录,--final 前必须清零"
    },
    "mobile.error.state|android-pad|ko|global": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "PR4a 派工包集中批捕预案:合并门=--preview-slice 无 schema 错误;全格实拍证据由后续验收批次(双 AI 验收/QA)补录,--final 前必须清零"
    },
    "mobile.completed.state|iphone|zh-CN|cn": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "PR4a 派工包集中批捕预案:合并门=--preview-slice 无 schema 错误;全格实拍证据由后续验收批次(双 AI 验收/QA)补录,--final 前必须清零"
    },
    "mobile.completed.state|iphone|zh-CN|global": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "PR4a 派工包集中批捕预案:合并门=--preview-slice 无 schema 错误;全格实拍证据由后续验收批次(双 AI 验收/QA)补录,--final 前必须清零"
    },
    "mobile.completed.state|iphone|zh-TW|cn": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "PR4a 派工包集中批捕预案:合并门=--preview-slice 无 schema 错误;全格实拍证据由后续验收批次(双 AI 验收/QA)补录,--final 前必须清零"
    },
    "mobile.completed.state|iphone|zh-TW|global": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "PR4a 派工包集中批捕预案:合并门=--preview-slice 无 schema 错误;全格实拍证据由后续验收批次(双 AI 验收/QA)补录,--final 前必须清零"
    },
    "mobile.completed.state|iphone|en|cn": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "PR4a 派工包集中批捕预案:合并门=--preview-slice 无 schema 错误;全格实拍证据由后续验收批次(双 AI 验收/QA)补录,--final 前必须清零"
    },
    "mobile.completed.state|iphone|en|global": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "PR4a 派工包集中批捕预案:合并门=--preview-slice 无 schema 错误;全格实拍证据由后续验收批次(双 AI 验收/QA)补录,--final 前必须清零"
    },
    "mobile.completed.state|iphone|ja|cn": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "PR4a 派工包集中批捕预案:合并门=--preview-slice 无 schema 错误;全格实拍证据由后续验收批次(双 AI 验收/QA)补录,--final 前必须清零"
    },
    "mobile.completed.state|iphone|ja|global": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "PR4a 派工包集中批捕预案:合并门=--preview-slice 无 schema 错误;全格实拍证据由后续验收批次(双 AI 验收/QA)补录,--final 前必须清零"
    },
    "mobile.completed.state|iphone|ko|cn": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "PR4a 派工包集中批捕预案:合并门=--preview-slice 无 schema 错误;全格实拍证据由后续验收批次(双 AI 验收/QA)补录,--final 前必须清零"
    },
    "mobile.completed.state|iphone|ko|global": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "PR4a 派工包集中批捕预案:合并门=--preview-slice 无 schema 错误;全格实拍证据由后续验收批次(双 AI 验收/QA)补录,--final 前必须清零"
    },
    "mobile.completed.state|android-phone|zh-CN|cn": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "PR4a 派工包集中批捕预案:合并门=--preview-slice 无 schema 错误;全格实拍证据由后续验收批次(双 AI 验收/QA)补录,--final 前必须清零"
    },
    "mobile.completed.state|android-phone|zh-CN|global": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "PR4a 派工包集中批捕预案:合并门=--preview-slice 无 schema 错误;全格实拍证据由后续验收批次(双 AI 验收/QA)补录,--final 前必须清零"
    },
    "mobile.completed.state|android-phone|zh-TW|cn": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "PR4a 派工包集中批捕预案:合并门=--preview-slice 无 schema 错误;全格实拍证据由后续验收批次(双 AI 验收/QA)补录,--final 前必须清零"
    },
    "mobile.completed.state|android-phone|zh-TW|global": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "PR4a 派工包集中批捕预案:合并门=--preview-slice 无 schema 错误;全格实拍证据由后续验收批次(双 AI 验收/QA)补录,--final 前必须清零"
    },
    "mobile.completed.state|android-phone|en|cn": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "PR4a 派工包集中批捕预案:合并门=--preview-slice 无 schema 错误;全格实拍证据由后续验收批次(双 AI 验收/QA)补录,--final 前必须清零"
    },
    "mobile.completed.state|android-phone|en|global": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "PR4a 派工包集中批捕预案:合并门=--preview-slice 无 schema 错误;全格实拍证据由后续验收批次(双 AI 验收/QA)补录,--final 前必须清零"
    },
    "mobile.completed.state|android-phone|ja|cn": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "PR4a 派工包集中批捕预案:合并门=--preview-slice 无 schema 错误;全格实拍证据由后续验收批次(双 AI 验收/QA)补录,--final 前必须清零"
    },
    "mobile.completed.state|android-phone|ja|global": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "PR4a 派工包集中批捕预案:合并门=--preview-slice 无 schema 错误;全格实拍证据由后续验收批次(双 AI 验收/QA)补录,--final 前必须清零"
    },
    "mobile.completed.state|android-phone|ko|cn": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "PR4a 派工包集中批捕预案:合并门=--preview-slice 无 schema 错误;全格实拍证据由后续验收批次(双 AI 验收/QA)补录,--final 前必须清零"
    },
    "mobile.completed.state|android-phone|ko|global": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "PR4a 派工包集中批捕预案:合并门=--preview-slice 无 schema 错误;全格实拍证据由后续验收批次(双 AI 验收/QA)补录,--final 前必须清零"
    },
    "mobile.completed.state|ipad|zh-CN|cn": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "PR4a 派工包集中批捕预案:合并门=--preview-slice 无 schema 错误;全格实拍证据由后续验收批次(双 AI 验收/QA)补录,--final 前必须清零"
    },
    "mobile.completed.state|ipad|zh-CN|global": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "PR4a 派工包集中批捕预案:合并门=--preview-slice 无 schema 错误;全格实拍证据由后续验收批次(双 AI 验收/QA)补录,--final 前必须清零"
    },
    "mobile.completed.state|ipad|zh-TW|cn": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "PR4a 派工包集中批捕预案:合并门=--preview-slice 无 schema 错误;全格实拍证据由后续验收批次(双 AI 验收/QA)补录,--final 前必须清零"
    },
    "mobile.completed.state|ipad|zh-TW|global": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "PR4a 派工包集中批捕预案:合并门=--preview-slice 无 schema 错误;全格实拍证据由后续验收批次(双 AI 验收/QA)补录,--final 前必须清零"
    },
    "mobile.completed.state|ipad|en|cn": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "PR4a 派工包集中批捕预案:合并门=--preview-slice 无 schema 错误;全格实拍证据由后续验收批次(双 AI 验收/QA)补录,--final 前必须清零"
    },
    "mobile.completed.state|ipad|en|global": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "PR4a 派工包集中批捕预案:合并门=--preview-slice 无 schema 错误;全格实拍证据由后续验收批次(双 AI 验收/QA)补录,--final 前必须清零"
    },
    "mobile.completed.state|ipad|ja|cn": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "PR4a 派工包集中批捕预案:合并门=--preview-slice 无 schema 错误;全格实拍证据由后续验收批次(双 AI 验收/QA)补录,--final 前必须清零"
    },
    "mobile.completed.state|ipad|ja|global": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "PR4a 派工包集中批捕预案:合并门=--preview-slice 无 schema 错误;全格实拍证据由后续验收批次(双 AI 验收/QA)补录,--final 前必须清零"
    },
    "mobile.completed.state|ipad|ko|cn": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "PR4a 派工包集中批捕预案:合并门=--preview-slice 无 schema 错误;全格实拍证据由后续验收批次(双 AI 验收/QA)补录,--final 前必须清零"
    },
    "mobile.completed.state|ipad|ko|global": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "PR4a 派工包集中批捕预案:合并门=--preview-slice 无 schema 错误;全格实拍证据由后续验收批次(双 AI 验收/QA)补录,--final 前必须清零"
    },
    "mobile.completed.state|android-pad|zh-CN|cn": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "PR4a 派工包集中批捕预案:合并门=--preview-slice 无 schema 错误;全格实拍证据由后续验收批次(双 AI 验收/QA)补录,--final 前必须清零"
    },
    "mobile.completed.state|android-pad|zh-CN|global": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "PR4a 派工包集中批捕预案:合并门=--preview-slice 无 schema 错误;全格实拍证据由后续验收批次(双 AI 验收/QA)补录,--final 前必须清零"
    },
    "mobile.completed.state|android-pad|zh-TW|cn": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "PR4a 派工包集中批捕预案:合并门=--preview-slice 无 schema 错误;全格实拍证据由后续验收批次(双 AI 验收/QA)补录,--final 前必须清零"
    },
    "mobile.completed.state|android-pad|zh-TW|global": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "PR4a 派工包集中批捕预案:合并门=--preview-slice 无 schema 错误;全格实拍证据由后续验收批次(双 AI 验收/QA)补录,--final 前必须清零"
    },
    "mobile.completed.state|android-pad|en|cn": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "PR4a 派工包集中批捕预案:合并门=--preview-slice 无 schema 错误;全格实拍证据由后续验收批次(双 AI 验收/QA)补录,--final 前必须清零"
    },
    "mobile.completed.state|android-pad|en|global": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "PR4a 派工包集中批捕预案:合并门=--preview-slice 无 schema 错误;全格实拍证据由后续验收批次(双 AI 验收/QA)补录,--final 前必须清零"
    },
    "mobile.completed.state|android-pad|ja|cn": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "PR4a 派工包集中批捕预案:合并门=--preview-slice 无 schema 错误;全格实拍证据由后续验收批次(双 AI 验收/QA)补录,--final 前必须清零"
    },
    "mobile.completed.state|android-pad|ja|global": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "PR4a 派工包集中批捕预案:合并门=--preview-slice 无 schema 错误;全格实拍证据由后续验收批次(双 AI 验收/QA)补录,--final 前必须清零"
    },
    "mobile.completed.state|android-pad|ko|cn": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "PR4a 派工包集中批捕预案:合并门=--preview-slice 无 schema 错误;全格实拍证据由后续验收批次(双 AI 验收/QA)补录,--final 前必须清零"
    },
    "mobile.completed.state|android-pad|ko|global": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "PR4a 派工包集中批捕预案:合并门=--preview-slice 无 schema 错误;全格实拍证据由后续验收批次(双 AI 验收/QA)补录,--final 前必须清零"
    },
    "mobile.verification-code.countdown|iphone|zh-CN|cn": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "PR4a 派工包集中批捕预案:合并门=--preview-slice 无 schema 错误;全格实拍证据由后续验收批次(双 AI 验收/QA)补录,--final 前必须清零"
    },
    "mobile.verification-code.countdown|iphone|zh-CN|global": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "PR4a 派工包集中批捕预案:合并门=--preview-slice 无 schema 错误;全格实拍证据由后续验收批次(双 AI 验收/QA)补录,--final 前必须清零"
    },
    "mobile.verification-code.countdown|iphone|zh-TW|cn": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "PR4a 派工包集中批捕预案:合并门=--preview-slice 无 schema 错误;全格实拍证据由后续验收批次(双 AI 验收/QA)补录,--final 前必须清零"
    },
    "mobile.verification-code.countdown|iphone|zh-TW|global": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "PR4a 派工包集中批捕预案:合并门=--preview-slice 无 schema 错误;全格实拍证据由后续验收批次(双 AI 验收/QA)补录,--final 前必须清零"
    },
    "mobile.verification-code.countdown|iphone|en|cn": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "PR4a 派工包集中批捕预案:合并门=--preview-slice 无 schema 错误;全格实拍证据由后续验收批次(双 AI 验收/QA)补录,--final 前必须清零"
    },
    "mobile.verification-code.countdown|iphone|en|global": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "PR4a 派工包集中批捕预案:合并门=--preview-slice 无 schema 错误;全格实拍证据由后续验收批次(双 AI 验收/QA)补录,--final 前必须清零"
    },
    "mobile.verification-code.countdown|iphone|ja|cn": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "PR4a 派工包集中批捕预案:合并门=--preview-slice 无 schema 错误;全格实拍证据由后续验收批次(双 AI 验收/QA)补录,--final 前必须清零"
    },
    "mobile.verification-code.countdown|iphone|ja|global": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "PR4a 派工包集中批捕预案:合并门=--preview-slice 无 schema 错误;全格实拍证据由后续验收批次(双 AI 验收/QA)补录,--final 前必须清零"
    },
    "mobile.verification-code.countdown|iphone|ko|cn": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "PR4a 派工包集中批捕预案:合并门=--preview-slice 无 schema 错误;全格实拍证据由后续验收批次(双 AI 验收/QA)补录,--final 前必须清零"
    },
    "mobile.verification-code.countdown|iphone|ko|global": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "PR4a 派工包集中批捕预案:合并门=--preview-slice 无 schema 错误;全格实拍证据由后续验收批次(双 AI 验收/QA)补录,--final 前必须清零"
    },
    "mobile.verification-code.countdown|android-phone|zh-CN|cn": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "PR4a 派工包集中批捕预案:合并门=--preview-slice 无 schema 错误;全格实拍证据由后续验收批次(双 AI 验收/QA)补录,--final 前必须清零"
    },
    "mobile.verification-code.countdown|android-phone|zh-CN|global": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "PR4a 派工包集中批捕预案:合并门=--preview-slice 无 schema 错误;全格实拍证据由后续验收批次(双 AI 验收/QA)补录,--final 前必须清零"
    },
    "mobile.verification-code.countdown|android-phone|zh-TW|cn": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "PR4a 派工包集中批捕预案:合并门=--preview-slice 无 schema 错误;全格实拍证据由后续验收批次(双 AI 验收/QA)补录,--final 前必须清零"
    },
    "mobile.verification-code.countdown|android-phone|zh-TW|global": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "PR4a 派工包集中批捕预案:合并门=--preview-slice 无 schema 错误;全格实拍证据由后续验收批次(双 AI 验收/QA)补录,--final 前必须清零"
    },
    "mobile.verification-code.countdown|android-phone|en|cn": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "PR4a 派工包集中批捕预案:合并门=--preview-slice 无 schema 错误;全格实拍证据由后续验收批次(双 AI 验收/QA)补录,--final 前必须清零"
    },
    "mobile.verification-code.countdown|android-phone|en|global": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "PR4a 派工包集中批捕预案:合并门=--preview-slice 无 schema 错误;全格实拍证据由后续验收批次(双 AI 验收/QA)补录,--final 前必须清零"
    },
    "mobile.verification-code.countdown|android-phone|ja|cn": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "PR4a 派工包集中批捕预案:合并门=--preview-slice 无 schema 错误;全格实拍证据由后续验收批次(双 AI 验收/QA)补录,--final 前必须清零"
    },
    "mobile.verification-code.countdown|android-phone|ja|global": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "PR4a 派工包集中批捕预案:合并门=--preview-slice 无 schema 错误;全格实拍证据由后续验收批次(双 AI 验收/QA)补录,--final 前必须清零"
    },
    "mobile.verification-code.countdown|android-phone|ko|cn": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "PR4a 派工包集中批捕预案:合并门=--preview-slice 无 schema 错误;全格实拍证据由后续验收批次(双 AI 验收/QA)补录,--final 前必须清零"
    },
    "mobile.verification-code.countdown|android-phone|ko|global": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "PR4a 派工包集中批捕预案:合并门=--preview-slice 无 schema 错误;全格实拍证据由后续验收批次(双 AI 验收/QA)补录,--final 前必须清零"
    },
    "mobile.verification-code.countdown|ipad|zh-CN|cn": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "PR4a 派工包集中批捕预案:合并门=--preview-slice 无 schema 错误;全格实拍证据由后续验收批次(双 AI 验收/QA)补录,--final 前必须清零"
    },
    "mobile.verification-code.countdown|ipad|zh-CN|global": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "PR4a 派工包集中批捕预案:合并门=--preview-slice 无 schema 错误;全格实拍证据由后续验收批次(双 AI 验收/QA)补录,--final 前必须清零"
    },
    "mobile.verification-code.countdown|ipad|zh-TW|cn": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "PR4a 派工包集中批捕预案:合并门=--preview-slice 无 schema 错误;全格实拍证据由后续验收批次(双 AI 验收/QA)补录,--final 前必须清零"
    },
    "mobile.verification-code.countdown|ipad|zh-TW|global": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "PR4a 派工包集中批捕预案:合并门=--preview-slice 无 schema 错误;全格实拍证据由后续验收批次(双 AI 验收/QA)补录,--final 前必须清零"
    },
    "mobile.verification-code.countdown|ipad|en|cn": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "PR4a 派工包集中批捕预案:合并门=--preview-slice 无 schema 错误;全格实拍证据由后续验收批次(双 AI 验收/QA)补录,--final 前必须清零"
    },
    "mobile.verification-code.countdown|ipad|en|global": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "PR4a 派工包集中批捕预案:合并门=--preview-slice 无 schema 错误;全格实拍证据由后续验收批次(双 AI 验收/QA)补录,--final 前必须清零"
    },
    "mobile.verification-code.countdown|ipad|ja|cn": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "PR4a 派工包集中批捕预案:合并门=--preview-slice 无 schema 错误;全格实拍证据由后续验收批次(双 AI 验收/QA)补录,--final 前必须清零"
    },
    "mobile.verification-code.countdown|ipad|ja|global": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "PR4a 派工包集中批捕预案:合并门=--preview-slice 无 schema 错误;全格实拍证据由后续验收批次(双 AI 验收/QA)补录,--final 前必须清零"
    },
    "mobile.verification-code.countdown|ipad|ko|cn": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "PR4a 派工包集中批捕预案:合并门=--preview-slice 无 schema 错误;全格实拍证据由后续验收批次(双 AI 验收/QA)补录,--final 前必须清零"
    },
    "mobile.verification-code.countdown|ipad|ko|global": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "PR4a 派工包集中批捕预案:合并门=--preview-slice 无 schema 错误;全格实拍证据由后续验收批次(双 AI 验收/QA)补录,--final 前必须清零"
    },
    "mobile.verification-code.countdown|android-pad|zh-CN|cn": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "PR4a 派工包集中批捕预案:合并门=--preview-slice 无 schema 错误;全格实拍证据由后续验收批次(双 AI 验收/QA)补录,--final 前必须清零"
    },
    "mobile.verification-code.countdown|android-pad|zh-CN|global": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "PR4a 派工包集中批捕预案:合并门=--preview-slice 无 schema 错误;全格实拍证据由后续验收批次(双 AI 验收/QA)补录,--final 前必须清零"
    },
    "mobile.verification-code.countdown|android-pad|zh-TW|cn": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "PR4a 派工包集中批捕预案:合并门=--preview-slice 无 schema 错误;全格实拍证据由后续验收批次(双 AI 验收/QA)补录,--final 前必须清零"
    },
    "mobile.verification-code.countdown|android-pad|zh-TW|global": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "PR4a 派工包集中批捕预案:合并门=--preview-slice 无 schema 错误;全格实拍证据由后续验收批次(双 AI 验收/QA)补录,--final 前必须清零"
    },
    "mobile.verification-code.countdown|android-pad|en|cn": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "PR4a 派工包集中批捕预案:合并门=--preview-slice 无 schema 错误;全格实拍证据由后续验收批次(双 AI 验收/QA)补录,--final 前必须清零"
    },
    "mobile.verification-code.countdown|android-pad|en|global": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "PR4a 派工包集中批捕预案:合并门=--preview-slice 无 schema 错误;全格实拍证据由后续验收批次(双 AI 验收/QA)补录,--final 前必须清零"
    },
    "mobile.verification-code.countdown|android-pad|ja|cn": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "PR4a 派工包集中批捕预案:合并门=--preview-slice 无 schema 错误;全格实拍证据由后续验收批次(双 AI 验收/QA)补录,--final 前必须清零"
    },
    "mobile.verification-code.countdown|android-pad|ja|global": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "PR4a 派工包集中批捕预案:合并门=--preview-slice 无 schema 错误;全格实拍证据由后续验收批次(双 AI 验收/QA)补录,--final 前必须清零"
    },
    "mobile.verification-code.countdown|android-pad|ko|cn": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "PR4a 派工包集中批捕预案:合并门=--preview-slice 无 schema 错误;全格实拍证据由后续验收批次(双 AI 验收/QA)补录,--final 前必须清零"
    },
    "mobile.verification-code.countdown|android-pad|ko|global": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "PR4a 派工包集中批捕预案:合并门=--preview-slice 无 schema 错误;全格实拍证据由后续验收批次(双 AI 验收/QA)补录,--final 前必须清零"
    },
    "mobile.splash-brand.state|iphone|zh-CN|cn": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "PR4a 派工包集中批捕预案:合并门=--preview-slice 无 schema 错误;全格实拍证据由后续验收批次(双 AI 验收/QA)补录,--final 前必须清零"
    },
    "mobile.splash-brand.state|iphone|zh-CN|global": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "PR4a 派工包集中批捕预案:合并门=--preview-slice 无 schema 错误;全格实拍证据由后续验收批次(双 AI 验收/QA)补录,--final 前必须清零"
    },
    "mobile.splash-brand.state|iphone|zh-TW|cn": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "PR4a 派工包集中批捕预案:合并门=--preview-slice 无 schema 错误;全格实拍证据由后续验收批次(双 AI 验收/QA)补录,--final 前必须清零"
    },
    "mobile.splash-brand.state|iphone|zh-TW|global": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "PR4a 派工包集中批捕预案:合并门=--preview-slice 无 schema 错误;全格实拍证据由后续验收批次(双 AI 验收/QA)补录,--final 前必须清零"
    },
    "mobile.splash-brand.state|iphone|en|cn": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "PR4a 派工包集中批捕预案:合并门=--preview-slice 无 schema 错误;全格实拍证据由后续验收批次(双 AI 验收/QA)补录,--final 前必须清零"
    },
    "mobile.splash-brand.state|iphone|en|global": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "PR4a 派工包集中批捕预案:合并门=--preview-slice 无 schema 错误;全格实拍证据由后续验收批次(双 AI 验收/QA)补录,--final 前必须清零"
    },
    "mobile.splash-brand.state|iphone|ja|cn": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "PR4a 派工包集中批捕预案:合并门=--preview-slice 无 schema 错误;全格实拍证据由后续验收批次(双 AI 验收/QA)补录,--final 前必须清零"
    },
    "mobile.splash-brand.state|iphone|ja|global": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "PR4a 派工包集中批捕预案:合并门=--preview-slice 无 schema 错误;全格实拍证据由后续验收批次(双 AI 验收/QA)补录,--final 前必须清零"
    },
    "mobile.splash-brand.state|iphone|ko|cn": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "PR4a 派工包集中批捕预案:合并门=--preview-slice 无 schema 错误;全格实拍证据由后续验收批次(双 AI 验收/QA)补录,--final 前必须清零"
    },
    "mobile.splash-brand.state|iphone|ko|global": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "PR4a 派工包集中批捕预案:合并门=--preview-slice 无 schema 错误;全格实拍证据由后续验收批次(双 AI 验收/QA)补录,--final 前必须清零"
    },
    "mobile.splash-brand.state|android-phone|zh-CN|cn": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "PR4a 派工包集中批捕预案:合并门=--preview-slice 无 schema 错误;全格实拍证据由后续验收批次(双 AI 验收/QA)补录,--final 前必须清零"
    },
    "mobile.splash-brand.state|android-phone|zh-CN|global": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "PR4a 派工包集中批捕预案:合并门=--preview-slice 无 schema 错误;全格实拍证据由后续验收批次(双 AI 验收/QA)补录,--final 前必须清零"
    },
    "mobile.splash-brand.state|android-phone|zh-TW|cn": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "PR4a 派工包集中批捕预案:合并门=--preview-slice 无 schema 错误;全格实拍证据由后续验收批次(双 AI 验收/QA)补录,--final 前必须清零"
    },
    "mobile.splash-brand.state|android-phone|zh-TW|global": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "PR4a 派工包集中批捕预案:合并门=--preview-slice 无 schema 错误;全格实拍证据由后续验收批次(双 AI 验收/QA)补录,--final 前必须清零"
    },
    "mobile.splash-brand.state|android-phone|en|cn": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "PR4a 派工包集中批捕预案:合并门=--preview-slice 无 schema 错误;全格实拍证据由后续验收批次(双 AI 验收/QA)补录,--final 前必须清零"
    },
    "mobile.splash-brand.state|android-phone|en|global": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "PR4a 派工包集中批捕预案:合并门=--preview-slice 无 schema 错误;全格实拍证据由后续验收批次(双 AI 验收/QA)补录,--final 前必须清零"
    },
    "mobile.splash-brand.state|android-phone|ja|cn": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "PR4a 派工包集中批捕预案:合并门=--preview-slice 无 schema 错误;全格实拍证据由后续验收批次(双 AI 验收/QA)补录,--final 前必须清零"
    },
    "mobile.splash-brand.state|android-phone|ja|global": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "PR4a 派工包集中批捕预案:合并门=--preview-slice 无 schema 错误;全格实拍证据由后续验收批次(双 AI 验收/QA)补录,--final 前必须清零"
    },
    "mobile.splash-brand.state|android-phone|ko|cn": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "PR4a 派工包集中批捕预案:合并门=--preview-slice 无 schema 错误;全格实拍证据由后续验收批次(双 AI 验收/QA)补录,--final 前必须清零"
    },
    "mobile.splash-brand.state|android-phone|ko|global": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "PR4a 派工包集中批捕预案:合并门=--preview-slice 无 schema 错误;全格实拍证据由后续验收批次(双 AI 验收/QA)补录,--final 前必须清零"
    },
    "mobile.splash-brand.state|ipad|zh-CN|cn": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "PR4a 派工包集中批捕预案:合并门=--preview-slice 无 schema 错误;全格实拍证据由后续验收批次(双 AI 验收/QA)补录,--final 前必须清零"
    },
    "mobile.splash-brand.state|ipad|zh-CN|global": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "PR4a 派工包集中批捕预案:合并门=--preview-slice 无 schema 错误;全格实拍证据由后续验收批次(双 AI 验收/QA)补录,--final 前必须清零"
    },
    "mobile.splash-brand.state|ipad|zh-TW|cn": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "PR4a 派工包集中批捕预案:合并门=--preview-slice 无 schema 错误;全格实拍证据由后续验收批次(双 AI 验收/QA)补录,--final 前必须清零"
    },
    "mobile.splash-brand.state|ipad|zh-TW|global": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "PR4a 派工包集中批捕预案:合并门=--preview-slice 无 schema 错误;全格实拍证据由后续验收批次(双 AI 验收/QA)补录,--final 前必须清零"
    },
    "mobile.splash-brand.state|ipad|en|cn": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "PR4a 派工包集中批捕预案:合并门=--preview-slice 无 schema 错误;全格实拍证据由后续验收批次(双 AI 验收/QA)补录,--final 前必须清零"
    },
    "mobile.splash-brand.state|ipad|en|global": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "PR4a 派工包集中批捕预案:合并门=--preview-slice 无 schema 错误;全格实拍证据由后续验收批次(双 AI 验收/QA)补录,--final 前必须清零"
    },
    "mobile.splash-brand.state|ipad|ja|cn": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "PR4a 派工包集中批捕预案:合并门=--preview-slice 无 schema 错误;全格实拍证据由后续验收批次(双 AI 验收/QA)补录,--final 前必须清零"
    },
    "mobile.splash-brand.state|ipad|ja|global": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "PR4a 派工包集中批捕预案:合并门=--preview-slice 无 schema 错误;全格实拍证据由后续验收批次(双 AI 验收/QA)补录,--final 前必须清零"
    },
    "mobile.splash-brand.state|ipad|ko|cn": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "PR4a 派工包集中批捕预案:合并门=--preview-slice 无 schema 错误;全格实拍证据由后续验收批次(双 AI 验收/QA)补录,--final 前必须清零"
    },
    "mobile.splash-brand.state|ipad|ko|global": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "PR4a 派工包集中批捕预案:合并门=--preview-slice 无 schema 错误;全格实拍证据由后续验收批次(双 AI 验收/QA)补录,--final 前必须清零"
    },
    "mobile.splash-brand.state|android-pad|zh-CN|cn": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "PR4a 派工包集中批捕预案:合并门=--preview-slice 无 schema 错误;全格实拍证据由后续验收批次(双 AI 验收/QA)补录,--final 前必须清零"
    },
    "mobile.splash-brand.state|android-pad|zh-CN|global": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "PR4a 派工包集中批捕预案:合并门=--preview-slice 无 schema 错误;全格实拍证据由后续验收批次(双 AI 验收/QA)补录,--final 前必须清零"
    },
    "mobile.splash-brand.state|android-pad|zh-TW|cn": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "PR4a 派工包集中批捕预案:合并门=--preview-slice 无 schema 错误;全格实拍证据由后续验收批次(双 AI 验收/QA)补录,--final 前必须清零"
    },
    "mobile.splash-brand.state|android-pad|zh-TW|global": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "PR4a 派工包集中批捕预案:合并门=--preview-slice 无 schema 错误;全格实拍证据由后续验收批次(双 AI 验收/QA)补录,--final 前必须清零"
    },
    "mobile.splash-brand.state|android-pad|en|cn": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "PR4a 派工包集中批捕预案:合并门=--preview-slice 无 schema 错误;全格实拍证据由后续验收批次(双 AI 验收/QA)补录,--final 前必须清零"
    },
    "mobile.splash-brand.state|android-pad|en|global": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "PR4a 派工包集中批捕预案:合并门=--preview-slice 无 schema 错误;全格实拍证据由后续验收批次(双 AI 验收/QA)补录,--final 前必须清零"
    },
    "mobile.splash-brand.state|android-pad|ja|cn": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "PR4a 派工包集中批捕预案:合并门=--preview-slice 无 schema 错误;全格实拍证据由后续验收批次(双 AI 验收/QA)补录,--final 前必须清零"
    },
    "mobile.splash-brand.state|android-pad|ja|global": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "PR4a 派工包集中批捕预案:合并门=--preview-slice 无 schema 错误;全格实拍证据由后续验收批次(双 AI 验收/QA)补录,--final 前必须清零"
    },
    "mobile.splash-brand.state|android-pad|ko|cn": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "PR4a 派工包集中批捕预案:合并门=--preview-slice 无 schema 错误;全格实拍证据由后续验收批次(双 AI 验收/QA)补录,--final 前必须清零"
    },
    "mobile.splash-brand.state|android-pad|ko|global": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "PR4a 派工包集中批捕预案:合并门=--preview-slice 无 schema 错误;全格实拍证据由后续验收批次(双 AI 验收/QA)补录,--final 前必须清零"
    },
    "mobile.no-loginstate.state|iphone|zh-CN|cn": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "PR4a 派工包集中批捕预案:合并门=--preview-slice 无 schema 错误;全格实拍证据由后续验收批次(双 AI 验收/QA)补录,--final 前必须清零"
    },
    "mobile.no-loginstate.state|iphone|zh-CN|global": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "PR4a 派工包集中批捕预案:合并门=--preview-slice 无 schema 错误;全格实拍证据由后续验收批次(双 AI 验收/QA)补录,--final 前必须清零"
    },
    "mobile.no-loginstate.state|iphone|zh-TW|cn": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "PR4a 派工包集中批捕预案:合并门=--preview-slice 无 schema 错误;全格实拍证据由后续验收批次(双 AI 验收/QA)补录,--final 前必须清零"
    },
    "mobile.no-loginstate.state|iphone|zh-TW|global": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "PR4a 派工包集中批捕预案:合并门=--preview-slice 无 schema 错误;全格实拍证据由后续验收批次(双 AI 验收/QA)补录,--final 前必须清零"
    },
    "mobile.no-loginstate.state|iphone|en|cn": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "PR4a 派工包集中批捕预案:合并门=--preview-slice 无 schema 错误;全格实拍证据由后续验收批次(双 AI 验收/QA)补录,--final 前必须清零"
    },
    "mobile.no-loginstate.state|iphone|en|global": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "PR4a 派工包集中批捕预案:合并门=--preview-slice 无 schema 错误;全格实拍证据由后续验收批次(双 AI 验收/QA)补录,--final 前必须清零"
    },
    "mobile.no-loginstate.state|iphone|ja|cn": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "PR4a 派工包集中批捕预案:合并门=--preview-slice 无 schema 错误;全格实拍证据由后续验收批次(双 AI 验收/QA)补录,--final 前必须清零"
    },
    "mobile.no-loginstate.state|iphone|ja|global": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "PR4a 派工包集中批捕预案:合并门=--preview-slice 无 schema 错误;全格实拍证据由后续验收批次(双 AI 验收/QA)补录,--final 前必须清零"
    },
    "mobile.no-loginstate.state|iphone|ko|cn": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "PR4a 派工包集中批捕预案:合并门=--preview-slice 无 schema 错误;全格实拍证据由后续验收批次(双 AI 验收/QA)补录,--final 前必须清零"
    },
    "mobile.no-loginstate.state|iphone|ko|global": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "PR4a 派工包集中批捕预案:合并门=--preview-slice 无 schema 错误;全格实拍证据由后续验收批次(双 AI 验收/QA)补录,--final 前必须清零"
    },
    "mobile.no-loginstate.state|android-phone|zh-CN|cn": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "PR4a 派工包集中批捕预案:合并门=--preview-slice 无 schema 错误;全格实拍证据由后续验收批次(双 AI 验收/QA)补录,--final 前必须清零"
    },
    "mobile.no-loginstate.state|android-phone|zh-CN|global": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "PR4a 派工包集中批捕预案:合并门=--preview-slice 无 schema 错误;全格实拍证据由后续验收批次(双 AI 验收/QA)补录,--final 前必须清零"
    },
    "mobile.no-loginstate.state|android-phone|zh-TW|cn": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "PR4a 派工包集中批捕预案:合并门=--preview-slice 无 schema 错误;全格实拍证据由后续验收批次(双 AI 验收/QA)补录,--final 前必须清零"
    },
    "mobile.no-loginstate.state|android-phone|zh-TW|global": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "PR4a 派工包集中批捕预案:合并门=--preview-slice 无 schema 错误;全格实拍证据由后续验收批次(双 AI 验收/QA)补录,--final 前必须清零"
    },
    "mobile.no-loginstate.state|android-phone|en|cn": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "PR4a 派工包集中批捕预案:合并门=--preview-slice 无 schema 错误;全格实拍证据由后续验收批次(双 AI 验收/QA)补录,--final 前必须清零"
    },
    "mobile.no-loginstate.state|android-phone|en|global": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "PR4a 派工包集中批捕预案:合并门=--preview-slice 无 schema 错误;全格实拍证据由后续验收批次(双 AI 验收/QA)补录,--final 前必须清零"
    },
    "mobile.no-loginstate.state|android-phone|ja|cn": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "PR4a 派工包集中批捕预案:合并门=--preview-slice 无 schema 错误;全格实拍证据由后续验收批次(双 AI 验收/QA)补录,--final 前必须清零"
    },
    "mobile.no-loginstate.state|android-phone|ja|global": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "PR4a 派工包集中批捕预案:合并门=--preview-slice 无 schema 错误;全格实拍证据由后续验收批次(双 AI 验收/QA)补录,--final 前必须清零"
    },
    "mobile.no-loginstate.state|android-phone|ko|cn": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "PR4a 派工包集中批捕预案:合并门=--preview-slice 无 schema 错误;全格实拍证据由后续验收批次(双 AI 验收/QA)补录,--final 前必须清零"
    },
    "mobile.no-loginstate.state|android-phone|ko|global": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "PR4a 派工包集中批捕预案:合并门=--preview-slice 无 schema 错误;全格实拍证据由后续验收批次(双 AI 验收/QA)补录,--final 前必须清零"
    },
    "mobile.no-loginstate.state|ipad|zh-CN|cn": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "PR4a 派工包集中批捕预案:合并门=--preview-slice 无 schema 错误;全格实拍证据由后续验收批次(双 AI 验收/QA)补录,--final 前必须清零"
    },
    "mobile.no-loginstate.state|ipad|zh-CN|global": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "PR4a 派工包集中批捕预案:合并门=--preview-slice 无 schema 错误;全格实拍证据由后续验收批次(双 AI 验收/QA)补录,--final 前必须清零"
    },
    "mobile.no-loginstate.state|ipad|zh-TW|cn": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "PR4a 派工包集中批捕预案:合并门=--preview-slice 无 schema 错误;全格实拍证据由后续验收批次(双 AI 验收/QA)补录,--final 前必须清零"
    },
    "mobile.no-loginstate.state|ipad|zh-TW|global": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "PR4a 派工包集中批捕预案:合并门=--preview-slice 无 schema 错误;全格实拍证据由后续验收批次(双 AI 验收/QA)补录,--final 前必须清零"
    },
    "mobile.no-loginstate.state|ipad|en|cn": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "PR4a 派工包集中批捕预案:合并门=--preview-slice 无 schema 错误;全格实拍证据由后续验收批次(双 AI 验收/QA)补录,--final 前必须清零"
    },
    "mobile.no-loginstate.state|ipad|en|global": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "PR4a 派工包集中批捕预案:合并门=--preview-slice 无 schema 错误;全格实拍证据由后续验收批次(双 AI 验收/QA)补录,--final 前必须清零"
    },
    "mobile.no-loginstate.state|ipad|ja|cn": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "PR4a 派工包集中批捕预案:合并门=--preview-slice 无 schema 错误;全格实拍证据由后续验收批次(双 AI 验收/QA)补录,--final 前必须清零"
    },
    "mobile.no-loginstate.state|ipad|ja|global": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "PR4a 派工包集中批捕预案:合并门=--preview-slice 无 schema 错误;全格实拍证据由后续验收批次(双 AI 验收/QA)补录,--final 前必须清零"
    },
    "mobile.no-loginstate.state|ipad|ko|cn": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "PR4a 派工包集中批捕预案:合并门=--preview-slice 无 schema 错误;全格实拍证据由后续验收批次(双 AI 验收/QA)补录,--final 前必须清零"
    },
    "mobile.no-loginstate.state|ipad|ko|global": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "PR4a 派工包集中批捕预案:合并门=--preview-slice 无 schema 错误;全格实拍证据由后续验收批次(双 AI 验收/QA)补录,--final 前必须清零"
    },
    "mobile.no-loginstate.state|android-pad|zh-CN|cn": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "PR4a 派工包集中批捕预案:合并门=--preview-slice 无 schema 错误;全格实拍证据由后续验收批次(双 AI 验收/QA)补录,--final 前必须清零"
    },
    "mobile.no-loginstate.state|android-pad|zh-CN|global": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "PR4a 派工包集中批捕预案:合并门=--preview-slice 无 schema 错误;全格实拍证据由后续验收批次(双 AI 验收/QA)补录,--final 前必须清零"
    },
    "mobile.no-loginstate.state|android-pad|zh-TW|cn": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "PR4a 派工包集中批捕预案:合并门=--preview-slice 无 schema 错误;全格实拍证据由后续验收批次(双 AI 验收/QA)补录,--final 前必须清零"
    },
    "mobile.no-loginstate.state|android-pad|zh-TW|global": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "PR4a 派工包集中批捕预案:合并门=--preview-slice 无 schema 错误;全格实拍证据由后续验收批次(双 AI 验收/QA)补录,--final 前必须清零"
    },
    "mobile.no-loginstate.state|android-pad|en|cn": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "PR4a 派工包集中批捕预案:合并门=--preview-slice 无 schema 错误;全格实拍证据由后续验收批次(双 AI 验收/QA)补录,--final 前必须清零"
    },
    "mobile.no-loginstate.state|android-pad|en|global": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "PR4a 派工包集中批捕预案:合并门=--preview-slice 无 schema 错误;全格实拍证据由后续验收批次(双 AI 验收/QA)补录,--final 前必须清零"
    },
    "mobile.no-loginstate.state|android-pad|ja|cn": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "PR4a 派工包集中批捕预案:合并门=--preview-slice 无 schema 错误;全格实拍证据由后续验收批次(双 AI 验收/QA)补录,--final 前必须清零"
    },
    "mobile.no-loginstate.state|android-pad|ja|global": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "PR4a 派工包集中批捕预案:合并门=--preview-slice 无 schema 错误;全格实拍证据由后续验收批次(双 AI 验收/QA)补录,--final 前必须清零"
    },
    "mobile.no-loginstate.state|android-pad|ko|cn": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "PR4a 派工包集中批捕预案:合并门=--preview-slice 无 schema 错误;全格实拍证据由后续验收批次(双 AI 验收/QA)补录,--final 前必须清零"
    },
    "mobile.no-loginstate.state|android-pad|ko|global": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "PR4a 派工包集中批捕预案:合并门=--preview-slice 无 schema 错误;全格实拍证据由后续验收批次(双 AI 验收/QA)补录,--final 前必须清零"
    },
    "mobile.error-copy.INVALID_CODE|iphone|zh-CN|cn": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "PR4a 派工包集中批捕预案:合并门=--preview-slice 无 schema 错误;全格实拍证据由后续验收批次(双 AI 验收/QA)补录,--final 前必须清零"
    },
    "mobile.error-copy.INVALID_CODE|iphone|zh-CN|global": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "PR4a 派工包集中批捕预案:合并门=--preview-slice 无 schema 错误;全格实拍证据由后续验收批次(双 AI 验收/QA)补录,--final 前必须清零"
    },
    "mobile.error-copy.INVALID_CODE|iphone|zh-TW|cn": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "PR4a 派工包集中批捕预案:合并门=--preview-slice 无 schema 错误;全格实拍证据由后续验收批次(双 AI 验收/QA)补录,--final 前必须清零"
    },
    "mobile.error-copy.INVALID_CODE|iphone|zh-TW|global": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "PR4a 派工包集中批捕预案:合并门=--preview-slice 无 schema 错误;全格实拍证据由后续验收批次(双 AI 验收/QA)补录,--final 前必须清零"
    },
    "mobile.error-copy.INVALID_CODE|iphone|en|cn": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "PR4a 派工包集中批捕预案:合并门=--preview-slice 无 schema 错误;全格实拍证据由后续验收批次(双 AI 验收/QA)补录,--final 前必须清零"
    },
    "mobile.error-copy.INVALID_CODE|iphone|en|global": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "PR4a 派工包集中批捕预案:合并门=--preview-slice 无 schema 错误;全格实拍证据由后续验收批次(双 AI 验收/QA)补录,--final 前必须清零"
    },
    "mobile.error-copy.INVALID_CODE|iphone|ja|cn": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "PR4a 派工包集中批捕预案:合并门=--preview-slice 无 schema 错误;全格实拍证据由后续验收批次(双 AI 验收/QA)补录,--final 前必须清零"
    },
    "mobile.error-copy.INVALID_CODE|iphone|ja|global": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "PR4a 派工包集中批捕预案:合并门=--preview-slice 无 schema 错误;全格实拍证据由后续验收批次(双 AI 验收/QA)补录,--final 前必须清零"
    },
    "mobile.error-copy.INVALID_CODE|iphone|ko|cn": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "PR4a 派工包集中批捕预案:合并门=--preview-slice 无 schema 错误;全格实拍证据由后续验收批次(双 AI 验收/QA)补录,--final 前必须清零"
    },
    "mobile.error-copy.INVALID_CODE|iphone|ko|global": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "PR4a 派工包集中批捕预案:合并门=--preview-slice 无 schema 错误;全格实拍证据由后续验收批次(双 AI 验收/QA)补录,--final 前必须清零"
    },
    "mobile.error-copy.INVALID_CODE|android-phone|zh-CN|cn": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "PR4a 派工包集中批捕预案:合并门=--preview-slice 无 schema 错误;全格实拍证据由后续验收批次(双 AI 验收/QA)补录,--final 前必须清零"
    },
    "mobile.error-copy.INVALID_CODE|android-phone|zh-CN|global": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "PR4a 派工包集中批捕预案:合并门=--preview-slice 无 schema 错误;全格实拍证据由后续验收批次(双 AI 验收/QA)补录,--final 前必须清零"
    },
    "mobile.error-copy.INVALID_CODE|android-phone|zh-TW|cn": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "PR4a 派工包集中批捕预案:合并门=--preview-slice 无 schema 错误;全格实拍证据由后续验收批次(双 AI 验收/QA)补录,--final 前必须清零"
    },
    "mobile.error-copy.INVALID_CODE|android-phone|zh-TW|global": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "PR4a 派工包集中批捕预案:合并门=--preview-slice 无 schema 错误;全格实拍证据由后续验收批次(双 AI 验收/QA)补录,--final 前必须清零"
    },
    "mobile.error-copy.INVALID_CODE|android-phone|en|cn": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "PR4a 派工包集中批捕预案:合并门=--preview-slice 无 schema 错误;全格实拍证据由后续验收批次(双 AI 验收/QA)补录,--final 前必须清零"
    },
    "mobile.error-copy.INVALID_CODE|android-phone|en|global": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "PR4a 派工包集中批捕预案:合并门=--preview-slice 无 schema 错误;全格实拍证据由后续验收批次(双 AI 验收/QA)补录,--final 前必须清零"
    },
    "mobile.error-copy.INVALID_CODE|android-phone|ja|cn": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "PR4a 派工包集中批捕预案:合并门=--preview-slice 无 schema 错误;全格实拍证据由后续验收批次(双 AI 验收/QA)补录,--final 前必须清零"
    },
    "mobile.error-copy.INVALID_CODE|android-phone|ja|global": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "PR4a 派工包集中批捕预案:合并门=--preview-slice 无 schema 错误;全格实拍证据由后续验收批次(双 AI 验收/QA)补录,--final 前必须清零"
    },
    "mobile.error-copy.INVALID_CODE|android-phone|ko|cn": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "PR4a 派工包集中批捕预案:合并门=--preview-slice 无 schema 错误;全格实拍证据由后续验收批次(双 AI 验收/QA)补录,--final 前必须清零"
    },
    "mobile.error-copy.INVALID_CODE|android-phone|ko|global": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "PR4a 派工包集中批捕预案:合并门=--preview-slice 无 schema 错误;全格实拍证据由后续验收批次(双 AI 验收/QA)补录,--final 前必须清零"
    },
    "mobile.error-copy.INVALID_CODE|ipad|zh-CN|cn": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "PR4a 派工包集中批捕预案:合并门=--preview-slice 无 schema 错误;全格实拍证据由后续验收批次(双 AI 验收/QA)补录,--final 前必须清零"
    },
    "mobile.error-copy.INVALID_CODE|ipad|zh-CN|global": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "PR4a 派工包集中批捕预案:合并门=--preview-slice 无 schema 错误;全格实拍证据由后续验收批次(双 AI 验收/QA)补录,--final 前必须清零"
    },
    "mobile.error-copy.INVALID_CODE|ipad|zh-TW|cn": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "PR4a 派工包集中批捕预案:合并门=--preview-slice 无 schema 错误;全格实拍证据由后续验收批次(双 AI 验收/QA)补录,--final 前必须清零"
    },
    "mobile.error-copy.INVALID_CODE|ipad|zh-TW|global": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "PR4a 派工包集中批捕预案:合并门=--preview-slice 无 schema 错误;全格实拍证据由后续验收批次(双 AI 验收/QA)补录,--final 前必须清零"
    },
    "mobile.error-copy.INVALID_CODE|ipad|en|cn": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "PR4a 派工包集中批捕预案:合并门=--preview-slice 无 schema 错误;全格实拍证据由后续验收批次(双 AI 验收/QA)补录,--final 前必须清零"
    },
    "mobile.error-copy.INVALID_CODE|ipad|en|global": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "PR4a 派工包集中批捕预案:合并门=--preview-slice 无 schema 错误;全格实拍证据由后续验收批次(双 AI 验收/QA)补录,--final 前必须清零"
    },
    "mobile.error-copy.INVALID_CODE|ipad|ja|cn": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "PR4a 派工包集中批捕预案:合并门=--preview-slice 无 schema 错误;全格实拍证据由后续验收批次(双 AI 验收/QA)补录,--final 前必须清零"
    },
    "mobile.error-copy.INVALID_CODE|ipad|ja|global": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "PR4a 派工包集中批捕预案:合并门=--preview-slice 无 schema 错误;全格实拍证据由后续验收批次(双 AI 验收/QA)补录,--final 前必须清零"
    },
    "mobile.error-copy.INVALID_CODE|ipad|ko|cn": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "PR4a 派工包集中批捕预案:合并门=--preview-slice 无 schema 错误;全格实拍证据由后续验收批次(双 AI 验收/QA)补录,--final 前必须清零"
    },
    "mobile.error-copy.INVALID_CODE|ipad|ko|global": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "PR4a 派工包集中批捕预案:合并门=--preview-slice 无 schema 错误;全格实拍证据由后续验收批次(双 AI 验收/QA)补录,--final 前必须清零"
    },
    "mobile.error-copy.INVALID_CODE|android-pad|zh-CN|cn": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "PR4a 派工包集中批捕预案:合并门=--preview-slice 无 schema 错误;全格实拍证据由后续验收批次(双 AI 验收/QA)补录,--final 前必须清零"
    },
    "mobile.error-copy.INVALID_CODE|android-pad|zh-CN|global": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "PR4a 派工包集中批捕预案:合并门=--preview-slice 无 schema 错误;全格实拍证据由后续验收批次(双 AI 验收/QA)补录,--final 前必须清零"
    },
    "mobile.error-copy.INVALID_CODE|android-pad|zh-TW|cn": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "PR4a 派工包集中批捕预案:合并门=--preview-slice 无 schema 错误;全格实拍证据由后续验收批次(双 AI 验收/QA)补录,--final 前必须清零"
    },
    "mobile.error-copy.INVALID_CODE|android-pad|zh-TW|global": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "PR4a 派工包集中批捕预案:合并门=--preview-slice 无 schema 错误;全格实拍证据由后续验收批次(双 AI 验收/QA)补录,--final 前必须清零"
    },
    "mobile.error-copy.INVALID_CODE|android-pad|en|cn": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "PR4a 派工包集中批捕预案:合并门=--preview-slice 无 schema 错误;全格实拍证据由后续验收批次(双 AI 验收/QA)补录,--final 前必须清零"
    },
    "mobile.error-copy.INVALID_CODE|android-pad|en|global": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "PR4a 派工包集中批捕预案:合并门=--preview-slice 无 schema 错误;全格实拍证据由后续验收批次(双 AI 验收/QA)补录,--final 前必须清零"
    },
    "mobile.error-copy.INVALID_CODE|android-pad|ja|cn": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "PR4a 派工包集中批捕预案:合并门=--preview-slice 无 schema 错误;全格实拍证据由后续验收批次(双 AI 验收/QA)补录,--final 前必须清零"
    },
    "mobile.error-copy.INVALID_CODE|android-pad|ja|global": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "PR4a 派工包集中批捕预案:合并门=--preview-slice 无 schema 错误;全格实拍证据由后续验收批次(双 AI 验收/QA)补录,--final 前必须清零"
    },
    "mobile.error-copy.INVALID_CODE|android-pad|ko|cn": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "PR4a 派工包集中批捕预案:合并门=--preview-slice 无 schema 错误;全格实拍证据由后续验收批次(双 AI 验收/QA)补录,--final 前必须清零"
    },
    "mobile.error-copy.INVALID_CODE|android-pad|ko|global": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "PR4a 派工包集中批捕预案:合并门=--preview-slice 无 schema 错误;全格实拍证据由后续验收批次(双 AI 验收/QA)补录,--final 前必须清零"
    },
    "mobile.error-copy.INVALID_PARAMS|iphone|zh-CN|cn": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "PR4a 派工包集中批捕预案:合并门=--preview-slice 无 schema 错误;全格实拍证据由后续验收批次(双 AI 验收/QA)补录,--final 前必须清零"
    },
    "mobile.error-copy.INVALID_PARAMS|iphone|zh-CN|global": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "PR4a 派工包集中批捕预案:合并门=--preview-slice 无 schema 错误;全格实拍证据由后续验收批次(双 AI 验收/QA)补录,--final 前必须清零"
    },
    "mobile.error-copy.INVALID_PARAMS|iphone|zh-TW|cn": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "PR4a 派工包集中批捕预案:合并门=--preview-slice 无 schema 错误;全格实拍证据由后续验收批次(双 AI 验收/QA)补录,--final 前必须清零"
    },
    "mobile.error-copy.INVALID_PARAMS|iphone|zh-TW|global": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "PR4a 派工包集中批捕预案:合并门=--preview-slice 无 schema 错误;全格实拍证据由后续验收批次(双 AI 验收/QA)补录,--final 前必须清零"
    },
    "mobile.error-copy.INVALID_PARAMS|iphone|en|cn": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "PR4a 派工包集中批捕预案:合并门=--preview-slice 无 schema 错误;全格实拍证据由后续验收批次(双 AI 验收/QA)补录,--final 前必须清零"
    },
    "mobile.error-copy.INVALID_PARAMS|iphone|en|global": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "PR4a 派工包集中批捕预案:合并门=--preview-slice 无 schema 错误;全格实拍证据由后续验收批次(双 AI 验收/QA)补录,--final 前必须清零"
    },
    "mobile.error-copy.INVALID_PARAMS|iphone|ja|cn": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "PR4a 派工包集中批捕预案:合并门=--preview-slice 无 schema 错误;全格实拍证据由后续验收批次(双 AI 验收/QA)补录,--final 前必须清零"
    },
    "mobile.error-copy.INVALID_PARAMS|iphone|ja|global": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "PR4a 派工包集中批捕预案:合并门=--preview-slice 无 schema 错误;全格实拍证据由后续验收批次(双 AI 验收/QA)补录,--final 前必须清零"
    },
    "mobile.error-copy.INVALID_PARAMS|iphone|ko|cn": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "PR4a 派工包集中批捕预案:合并门=--preview-slice 无 schema 错误;全格实拍证据由后续验收批次(双 AI 验收/QA)补录,--final 前必须清零"
    },
    "mobile.error-copy.INVALID_PARAMS|iphone|ko|global": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "PR4a 派工包集中批捕预案:合并门=--preview-slice 无 schema 错误;全格实拍证据由后续验收批次(双 AI 验收/QA)补录,--final 前必须清零"
    },
    "mobile.error-copy.INVALID_PARAMS|android-phone|zh-CN|cn": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "PR4a 派工包集中批捕预案:合并门=--preview-slice 无 schema 错误;全格实拍证据由后续验收批次(双 AI 验收/QA)补录,--final 前必须清零"
    },
    "mobile.error-copy.INVALID_PARAMS|android-phone|zh-CN|global": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "PR4a 派工包集中批捕预案:合并门=--preview-slice 无 schema 错误;全格实拍证据由后续验收批次(双 AI 验收/QA)补录,--final 前必须清零"
    },
    "mobile.error-copy.INVALID_PARAMS|android-phone|zh-TW|cn": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "PR4a 派工包集中批捕预案:合并门=--preview-slice 无 schema 错误;全格实拍证据由后续验收批次(双 AI 验收/QA)补录,--final 前必须清零"
    },
    "mobile.error-copy.INVALID_PARAMS|android-phone|zh-TW|global": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "PR4a 派工包集中批捕预案:合并门=--preview-slice 无 schema 错误;全格实拍证据由后续验收批次(双 AI 验收/QA)补录,--final 前必须清零"
    },
    "mobile.error-copy.INVALID_PARAMS|android-phone|en|cn": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "PR4a 派工包集中批捕预案:合并门=--preview-slice 无 schema 错误;全格实拍证据由后续验收批次(双 AI 验收/QA)补录,--final 前必须清零"
    },
    "mobile.error-copy.INVALID_PARAMS|android-phone|en|global": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "PR4a 派工包集中批捕预案:合并门=--preview-slice 无 schema 错误;全格实拍证据由后续验收批次(双 AI 验收/QA)补录,--final 前必须清零"
    },
    "mobile.error-copy.INVALID_PARAMS|android-phone|ja|cn": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "PR4a 派工包集中批捕预案:合并门=--preview-slice 无 schema 错误;全格实拍证据由后续验收批次(双 AI 验收/QA)补录,--final 前必须清零"
    },
    "mobile.error-copy.INVALID_PARAMS|android-phone|ja|global": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "PR4a 派工包集中批捕预案:合并门=--preview-slice 无 schema 错误;全格实拍证据由后续验收批次(双 AI 验收/QA)补录,--final 前必须清零"
    },
    "mobile.error-copy.INVALID_PARAMS|android-phone|ko|cn": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "PR4a 派工包集中批捕预案:合并门=--preview-slice 无 schema 错误;全格实拍证据由后续验收批次(双 AI 验收/QA)补录,--final 前必须清零"
    },
    "mobile.error-copy.INVALID_PARAMS|android-phone|ko|global": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "PR4a 派工包集中批捕预案:合并门=--preview-slice 无 schema 错误;全格实拍证据由后续验收批次(双 AI 验收/QA)补录,--final 前必须清零"
    },
    "mobile.error-copy.INVALID_PARAMS|ipad|zh-CN|cn": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "PR4a 派工包集中批捕预案:合并门=--preview-slice 无 schema 错误;全格实拍证据由后续验收批次(双 AI 验收/QA)补录,--final 前必须清零"
    },
    "mobile.error-copy.INVALID_PARAMS|ipad|zh-CN|global": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "PR4a 派工包集中批捕预案:合并门=--preview-slice 无 schema 错误;全格实拍证据由后续验收批次(双 AI 验收/QA)补录,--final 前必须清零"
    },
    "mobile.error-copy.INVALID_PARAMS|ipad|zh-TW|cn": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "PR4a 派工包集中批捕预案:合并门=--preview-slice 无 schema 错误;全格实拍证据由后续验收批次(双 AI 验收/QA)补录,--final 前必须清零"
    },
    "mobile.error-copy.INVALID_PARAMS|ipad|zh-TW|global": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "PR4a 派工包集中批捕预案:合并门=--preview-slice 无 schema 错误;全格实拍证据由后续验收批次(双 AI 验收/QA)补录,--final 前必须清零"
    },
    "mobile.error-copy.INVALID_PARAMS|ipad|en|cn": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "PR4a 派工包集中批捕预案:合并门=--preview-slice 无 schema 错误;全格实拍证据由后续验收批次(双 AI 验收/QA)补录,--final 前必须清零"
    },
    "mobile.error-copy.INVALID_PARAMS|ipad|en|global": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "PR4a 派工包集中批捕预案:合并门=--preview-slice 无 schema 错误;全格实拍证据由后续验收批次(双 AI 验收/QA)补录,--final 前必须清零"
    },
    "mobile.error-copy.INVALID_PARAMS|ipad|ja|cn": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "PR4a 派工包集中批捕预案:合并门=--preview-slice 无 schema 错误;全格实拍证据由后续验收批次(双 AI 验收/QA)补录,--final 前必须清零"
    },
    "mobile.error-copy.INVALID_PARAMS|ipad|ja|global": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "PR4a 派工包集中批捕预案:合并门=--preview-slice 无 schema 错误;全格实拍证据由后续验收批次(双 AI 验收/QA)补录,--final 前必须清零"
    },
    "mobile.error-copy.INVALID_PARAMS|ipad|ko|cn": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "PR4a 派工包集中批捕预案:合并门=--preview-slice 无 schema 错误;全格实拍证据由后续验收批次(双 AI 验收/QA)补录,--final 前必须清零"
    },
    "mobile.error-copy.INVALID_PARAMS|ipad|ko|global": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "PR4a 派工包集中批捕预案:合并门=--preview-slice 无 schema 错误;全格实拍证据由后续验收批次(双 AI 验收/QA)补录,--final 前必须清零"
    },
    "mobile.error-copy.INVALID_PARAMS|android-pad|zh-CN|cn": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "PR4a 派工包集中批捕预案:合并门=--preview-slice 无 schema 错误;全格实拍证据由后续验收批次(双 AI 验收/QA)补录,--final 前必须清零"
    },
    "mobile.error-copy.INVALID_PARAMS|android-pad|zh-CN|global": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "PR4a 派工包集中批捕预案:合并门=--preview-slice 无 schema 错误;全格实拍证据由后续验收批次(双 AI 验收/QA)补录,--final 前必须清零"
    },
    "mobile.error-copy.INVALID_PARAMS|android-pad|zh-TW|cn": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "PR4a 派工包集中批捕预案:合并门=--preview-slice 无 schema 错误;全格实拍证据由后续验收批次(双 AI 验收/QA)补录,--final 前必须清零"
    },
    "mobile.error-copy.INVALID_PARAMS|android-pad|zh-TW|global": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "PR4a 派工包集中批捕预案:合并门=--preview-slice 无 schema 错误;全格实拍证据由后续验收批次(双 AI 验收/QA)补录,--final 前必须清零"
    },
    "mobile.error-copy.INVALID_PARAMS|android-pad|en|cn": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "PR4a 派工包集中批捕预案:合并门=--preview-slice 无 schema 错误;全格实拍证据由后续验收批次(双 AI 验收/QA)补录,--final 前必须清零"
    },
    "mobile.error-copy.INVALID_PARAMS|android-pad|en|global": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "PR4a 派工包集中批捕预案:合并门=--preview-slice 无 schema 错误;全格实拍证据由后续验收批次(双 AI 验收/QA)补录,--final 前必须清零"
    },
    "mobile.error-copy.INVALID_PARAMS|android-pad|ja|cn": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "PR4a 派工包集中批捕预案:合并门=--preview-slice 无 schema 错误;全格实拍证据由后续验收批次(双 AI 验收/QA)补录,--final 前必须清零"
    },
    "mobile.error-copy.INVALID_PARAMS|android-pad|ja|global": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "PR4a 派工包集中批捕预案:合并门=--preview-slice 无 schema 错误;全格实拍证据由后续验收批次(双 AI 验收/QA)补录,--final 前必须清零"
    },
    "mobile.error-copy.INVALID_PARAMS|android-pad|ko|cn": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "PR4a 派工包集中批捕预案:合并门=--preview-slice 无 schema 错误;全格实拍证据由后续验收批次(双 AI 验收/QA)补录,--final 前必须清零"
    },
    "mobile.error-copy.INVALID_PARAMS|android-pad|ko|global": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "PR4a 派工包集中批捕预案:合并门=--preview-slice 无 schema 错误;全格实拍证据由后续验收批次(双 AI 验收/QA)补录,--final 前必须清零"
    },
    "mobile.error-copy.INVALID_AUTH_CODE|iphone|zh-CN|cn": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "PR4a 派工包集中批捕预案:合并门=--preview-slice 无 schema 错误;全格实拍证据由后续验收批次(双 AI 验收/QA)补录,--final 前必须清零"
    },
    "mobile.error-copy.INVALID_AUTH_CODE|iphone|zh-CN|global": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "PR4a 派工包集中批捕预案:合并门=--preview-slice 无 schema 错误;全格实拍证据由后续验收批次(双 AI 验收/QA)补录,--final 前必须清零"
    },
    "mobile.error-copy.INVALID_AUTH_CODE|iphone|zh-TW|cn": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "PR4a 派工包集中批捕预案:合并门=--preview-slice 无 schema 错误;全格实拍证据由后续验收批次(双 AI 验收/QA)补录,--final 前必须清零"
    },
    "mobile.error-copy.INVALID_AUTH_CODE|iphone|zh-TW|global": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "PR4a 派工包集中批捕预案:合并门=--preview-slice 无 schema 错误;全格实拍证据由后续验收批次(双 AI 验收/QA)补录,--final 前必须清零"
    },
    "mobile.error-copy.INVALID_AUTH_CODE|iphone|en|cn": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "PR4a 派工包集中批捕预案:合并门=--preview-slice 无 schema 错误;全格实拍证据由后续验收批次(双 AI 验收/QA)补录,--final 前必须清零"
    },
    "mobile.error-copy.INVALID_AUTH_CODE|iphone|en|global": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "PR4a 派工包集中批捕预案:合并门=--preview-slice 无 schema 错误;全格实拍证据由后续验收批次(双 AI 验收/QA)补录,--final 前必须清零"
    },
    "mobile.error-copy.INVALID_AUTH_CODE|iphone|ja|cn": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "PR4a 派工包集中批捕预案:合并门=--preview-slice 无 schema 错误;全格实拍证据由后续验收批次(双 AI 验收/QA)补录,--final 前必须清零"
    },
    "mobile.error-copy.INVALID_AUTH_CODE|iphone|ja|global": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "PR4a 派工包集中批捕预案:合并门=--preview-slice 无 schema 错误;全格实拍证据由后续验收批次(双 AI 验收/QA)补录,--final 前必须清零"
    },
    "mobile.error-copy.INVALID_AUTH_CODE|iphone|ko|cn": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "PR4a 派工包集中批捕预案:合并门=--preview-slice 无 schema 错误;全格实拍证据由后续验收批次(双 AI 验收/QA)补录,--final 前必须清零"
    },
    "mobile.error-copy.INVALID_AUTH_CODE|iphone|ko|global": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "PR4a 派工包集中批捕预案:合并门=--preview-slice 无 schema 错误;全格实拍证据由后续验收批次(双 AI 验收/QA)补录,--final 前必须清零"
    },
    "mobile.error-copy.INVALID_AUTH_CODE|android-phone|zh-CN|cn": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "PR4a 派工包集中批捕预案:合并门=--preview-slice 无 schema 错误;全格实拍证据由后续验收批次(双 AI 验收/QA)补录,--final 前必须清零"
    },
    "mobile.error-copy.INVALID_AUTH_CODE|android-phone|zh-CN|global": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "PR4a 派工包集中批捕预案:合并门=--preview-slice 无 schema 错误;全格实拍证据由后续验收批次(双 AI 验收/QA)补录,--final 前必须清零"
    },
    "mobile.error-copy.INVALID_AUTH_CODE|android-phone|zh-TW|cn": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "PR4a 派工包集中批捕预案:合并门=--preview-slice 无 schema 错误;全格实拍证据由后续验收批次(双 AI 验收/QA)补录,--final 前必须清零"
    },
    "mobile.error-copy.INVALID_AUTH_CODE|android-phone|zh-TW|global": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "PR4a 派工包集中批捕预案:合并门=--preview-slice 无 schema 错误;全格实拍证据由后续验收批次(双 AI 验收/QA)补录,--final 前必须清零"
    },
    "mobile.error-copy.INVALID_AUTH_CODE|android-phone|en|cn": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "PR4a 派工包集中批捕预案:合并门=--preview-slice 无 schema 错误;全格实拍证据由后续验收批次(双 AI 验收/QA)补录,--final 前必须清零"
    },
    "mobile.error-copy.INVALID_AUTH_CODE|android-phone|en|global": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "PR4a 派工包集中批捕预案:合并门=--preview-slice 无 schema 错误;全格实拍证据由后续验收批次(双 AI 验收/QA)补录,--final 前必须清零"
    },
    "mobile.error-copy.INVALID_AUTH_CODE|android-phone|ja|cn": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "PR4a 派工包集中批捕预案:合并门=--preview-slice 无 schema 错误;全格实拍证据由后续验收批次(双 AI 验收/QA)补录,--final 前必须清零"
    },
    "mobile.error-copy.INVALID_AUTH_CODE|android-phone|ja|global": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "PR4a 派工包集中批捕预案:合并门=--preview-slice 无 schema 错误;全格实拍证据由后续验收批次(双 AI 验收/QA)补录,--final 前必须清零"
    },
    "mobile.error-copy.INVALID_AUTH_CODE|android-phone|ko|cn": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "PR4a 派工包集中批捕预案:合并门=--preview-slice 无 schema 错误;全格实拍证据由后续验收批次(双 AI 验收/QA)补录,--final 前必须清零"
    },
    "mobile.error-copy.INVALID_AUTH_CODE|android-phone|ko|global": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "PR4a 派工包集中批捕预案:合并门=--preview-slice 无 schema 错误;全格实拍证据由后续验收批次(双 AI 验收/QA)补录,--final 前必须清零"
    },
    "mobile.error-copy.INVALID_AUTH_CODE|ipad|zh-CN|cn": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "PR4a 派工包集中批捕预案:合并门=--preview-slice 无 schema 错误;全格实拍证据由后续验收批次(双 AI 验收/QA)补录,--final 前必须清零"
    },
    "mobile.error-copy.INVALID_AUTH_CODE|ipad|zh-CN|global": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "PR4a 派工包集中批捕预案:合并门=--preview-slice 无 schema 错误;全格实拍证据由后续验收批次(双 AI 验收/QA)补录,--final 前必须清零"
    },
    "mobile.error-copy.INVALID_AUTH_CODE|ipad|zh-TW|cn": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "PR4a 派工包集中批捕预案:合并门=--preview-slice 无 schema 错误;全格实拍证据由后续验收批次(双 AI 验收/QA)补录,--final 前必须清零"
    },
    "mobile.error-copy.INVALID_AUTH_CODE|ipad|zh-TW|global": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "PR4a 派工包集中批捕预案:合并门=--preview-slice 无 schema 错误;全格实拍证据由后续验收批次(双 AI 验收/QA)补录,--final 前必须清零"
    },
    "mobile.error-copy.INVALID_AUTH_CODE|ipad|en|cn": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "PR4a 派工包集中批捕预案:合并门=--preview-slice 无 schema 错误;全格实拍证据由后续验收批次(双 AI 验收/QA)补录,--final 前必须清零"
    },
    "mobile.error-copy.INVALID_AUTH_CODE|ipad|en|global": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "PR4a 派工包集中批捕预案:合并门=--preview-slice 无 schema 错误;全格实拍证据由后续验收批次(双 AI 验收/QA)补录,--final 前必须清零"
    },
    "mobile.error-copy.INVALID_AUTH_CODE|ipad|ja|cn": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "PR4a 派工包集中批捕预案:合并门=--preview-slice 无 schema 错误;全格实拍证据由后续验收批次(双 AI 验收/QA)补录,--final 前必须清零"
    },
    "mobile.error-copy.INVALID_AUTH_CODE|ipad|ja|global": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "PR4a 派工包集中批捕预案:合并门=--preview-slice 无 schema 错误;全格实拍证据由后续验收批次(双 AI 验收/QA)补录,--final 前必须清零"
    },
    "mobile.error-copy.INVALID_AUTH_CODE|ipad|ko|cn": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "PR4a 派工包集中批捕预案:合并门=--preview-slice 无 schema 错误;全格实拍证据由后续验收批次(双 AI 验收/QA)补录,--final 前必须清零"
    },
    "mobile.error-copy.INVALID_AUTH_CODE|ipad|ko|global": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "PR4a 派工包集中批捕预案:合并门=--preview-slice 无 schema 错误;全格实拍证据由后续验收批次(双 AI 验收/QA)补录,--final 前必须清零"
    },
    "mobile.error-copy.INVALID_AUTH_CODE|android-pad|zh-CN|cn": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "PR4a 派工包集中批捕预案:合并门=--preview-slice 无 schema 错误;全格实拍证据由后续验收批次(双 AI 验收/QA)补录,--final 前必须清零"
    },
    "mobile.error-copy.INVALID_AUTH_CODE|android-pad|zh-CN|global": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "PR4a 派工包集中批捕预案:合并门=--preview-slice 无 schema 错误;全格实拍证据由后续验收批次(双 AI 验收/QA)补录,--final 前必须清零"
    },
    "mobile.error-copy.INVALID_AUTH_CODE|android-pad|zh-TW|cn": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "PR4a 派工包集中批捕预案:合并门=--preview-slice 无 schema 错误;全格实拍证据由后续验收批次(双 AI 验收/QA)补录,--final 前必须清零"
    },
    "mobile.error-copy.INVALID_AUTH_CODE|android-pad|zh-TW|global": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "PR4a 派工包集中批捕预案:合并门=--preview-slice 无 schema 错误;全格实拍证据由后续验收批次(双 AI 验收/QA)补录,--final 前必须清零"
    },
    "mobile.error-copy.INVALID_AUTH_CODE|android-pad|en|cn": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "PR4a 派工包集中批捕预案:合并门=--preview-slice 无 schema 错误;全格实拍证据由后续验收批次(双 AI 验收/QA)补录,--final 前必须清零"
    },
    "mobile.error-copy.INVALID_AUTH_CODE|android-pad|en|global": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "PR4a 派工包集中批捕预案:合并门=--preview-slice 无 schema 错误;全格实拍证据由后续验收批次(双 AI 验收/QA)补录,--final 前必须清零"
    },
    "mobile.error-copy.INVALID_AUTH_CODE|android-pad|ja|cn": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "PR4a 派工包集中批捕预案:合并门=--preview-slice 无 schema 错误;全格实拍证据由后续验收批次(双 AI 验收/QA)补录,--final 前必须清零"
    },
    "mobile.error-copy.INVALID_AUTH_CODE|android-pad|ja|global": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "PR4a 派工包集中批捕预案:合并门=--preview-slice 无 schema 错误;全格实拍证据由后续验收批次(双 AI 验收/QA)补录,--final 前必须清零"
    },
    "mobile.error-copy.INVALID_AUTH_CODE|android-pad|ko|cn": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "PR4a 派工包集中批捕预案:合并门=--preview-slice 无 schema 错误;全格实拍证据由后续验收批次(双 AI 验收/QA)补录,--final 前必须清零"
    },
    "mobile.error-copy.INVALID_AUTH_CODE|android-pad|ko|global": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "PR4a 派工包集中批捕预案:合并门=--preview-slice 无 schema 错误;全格实拍证据由后续验收批次(双 AI 验收/QA)补录,--final 前必须清零"
    },
    "mobile.error-copy.INVALID_LOGIN_TICKET|iphone|zh-CN|cn": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "PR4a 派工包集中批捕预案:合并门=--preview-slice 无 schema 错误;全格实拍证据由后续验收批次(双 AI 验收/QA)补录,--final 前必须清零"
    },
    "mobile.error-copy.INVALID_LOGIN_TICKET|iphone|zh-CN|global": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "PR4a 派工包集中批捕预案:合并门=--preview-slice 无 schema 错误;全格实拍证据由后续验收批次(双 AI 验收/QA)补录,--final 前必须清零"
    },
    "mobile.error-copy.INVALID_LOGIN_TICKET|iphone|zh-TW|cn": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "PR4a 派工包集中批捕预案:合并门=--preview-slice 无 schema 错误;全格实拍证据由后续验收批次(双 AI 验收/QA)补录,--final 前必须清零"
    },
    "mobile.error-copy.INVALID_LOGIN_TICKET|iphone|zh-TW|global": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "PR4a 派工包集中批捕预案:合并门=--preview-slice 无 schema 错误;全格实拍证据由后续验收批次(双 AI 验收/QA)补录,--final 前必须清零"
    },
    "mobile.error-copy.INVALID_LOGIN_TICKET|iphone|en|cn": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "PR4a 派工包集中批捕预案:合并门=--preview-slice 无 schema 错误;全格实拍证据由后续验收批次(双 AI 验收/QA)补录,--final 前必须清零"
    },
    "mobile.error-copy.INVALID_LOGIN_TICKET|iphone|en|global": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "PR4a 派工包集中批捕预案:合并门=--preview-slice 无 schema 错误;全格实拍证据由后续验收批次(双 AI 验收/QA)补录,--final 前必须清零"
    },
    "mobile.error-copy.INVALID_LOGIN_TICKET|iphone|ja|cn": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "PR4a 派工包集中批捕预案:合并门=--preview-slice 无 schema 错误;全格实拍证据由后续验收批次(双 AI 验收/QA)补录,--final 前必须清零"
    },
    "mobile.error-copy.INVALID_LOGIN_TICKET|iphone|ja|global": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "PR4a 派工包集中批捕预案:合并门=--preview-slice 无 schema 错误;全格实拍证据由后续验收批次(双 AI 验收/QA)补录,--final 前必须清零"
    },
    "mobile.error-copy.INVALID_LOGIN_TICKET|iphone|ko|cn": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "PR4a 派工包集中批捕预案:合并门=--preview-slice 无 schema 错误;全格实拍证据由后续验收批次(双 AI 验收/QA)补录,--final 前必须清零"
    },
    "mobile.error-copy.INVALID_LOGIN_TICKET|iphone|ko|global": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "PR4a 派工包集中批捕预案:合并门=--preview-slice 无 schema 错误;全格实拍证据由后续验收批次(双 AI 验收/QA)补录,--final 前必须清零"
    },
    "mobile.error-copy.INVALID_LOGIN_TICKET|android-phone|zh-CN|cn": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "PR4a 派工包集中批捕预案:合并门=--preview-slice 无 schema 错误;全格实拍证据由后续验收批次(双 AI 验收/QA)补录,--final 前必须清零"
    },
    "mobile.error-copy.INVALID_LOGIN_TICKET|android-phone|zh-CN|global": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "PR4a 派工包集中批捕预案:合并门=--preview-slice 无 schema 错误;全格实拍证据由后续验收批次(双 AI 验收/QA)补录,--final 前必须清零"
    },
    "mobile.error-copy.INVALID_LOGIN_TICKET|android-phone|zh-TW|cn": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "PR4a 派工包集中批捕预案:合并门=--preview-slice 无 schema 错误;全格实拍证据由后续验收批次(双 AI 验收/QA)补录,--final 前必须清零"
    },
    "mobile.error-copy.INVALID_LOGIN_TICKET|android-phone|zh-TW|global": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "PR4a 派工包集中批捕预案:合并门=--preview-slice 无 schema 错误;全格实拍证据由后续验收批次(双 AI 验收/QA)补录,--final 前必须清零"
    },
    "mobile.error-copy.INVALID_LOGIN_TICKET|android-phone|en|cn": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "PR4a 派工包集中批捕预案:合并门=--preview-slice 无 schema 错误;全格实拍证据由后续验收批次(双 AI 验收/QA)补录,--final 前必须清零"
    },
    "mobile.error-copy.INVALID_LOGIN_TICKET|android-phone|en|global": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "PR4a 派工包集中批捕预案:合并门=--preview-slice 无 schema 错误;全格实拍证据由后续验收批次(双 AI 验收/QA)补录,--final 前必须清零"
    },
    "mobile.error-copy.INVALID_LOGIN_TICKET|android-phone|ja|cn": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "PR4a 派工包集中批捕预案:合并门=--preview-slice 无 schema 错误;全格实拍证据由后续验收批次(双 AI 验收/QA)补录,--final 前必须清零"
    },
    "mobile.error-copy.INVALID_LOGIN_TICKET|android-phone|ja|global": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "PR4a 派工包集中批捕预案:合并门=--preview-slice 无 schema 错误;全格实拍证据由后续验收批次(双 AI 验收/QA)补录,--final 前必须清零"
    },
    "mobile.error-copy.INVALID_LOGIN_TICKET|android-phone|ko|cn": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "PR4a 派工包集中批捕预案:合并门=--preview-slice 无 schema 错误;全格实拍证据由后续验收批次(双 AI 验收/QA)补录,--final 前必须清零"
    },
    "mobile.error-copy.INVALID_LOGIN_TICKET|android-phone|ko|global": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "PR4a 派工包集中批捕预案:合并门=--preview-slice 无 schema 错误;全格实拍证据由后续验收批次(双 AI 验收/QA)补录,--final 前必须清零"
    },
    "mobile.error-copy.INVALID_LOGIN_TICKET|ipad|zh-CN|cn": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "PR4a 派工包集中批捕预案:合并门=--preview-slice 无 schema 错误;全格实拍证据由后续验收批次(双 AI 验收/QA)补录,--final 前必须清零"
    },
    "mobile.error-copy.INVALID_LOGIN_TICKET|ipad|zh-CN|global": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "PR4a 派工包集中批捕预案:合并门=--preview-slice 无 schema 错误;全格实拍证据由后续验收批次(双 AI 验收/QA)补录,--final 前必须清零"
    },
    "mobile.error-copy.INVALID_LOGIN_TICKET|ipad|zh-TW|cn": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "PR4a 派工包集中批捕预案:合并门=--preview-slice 无 schema 错误;全格实拍证据由后续验收批次(双 AI 验收/QA)补录,--final 前必须清零"
    },
    "mobile.error-copy.INVALID_LOGIN_TICKET|ipad|zh-TW|global": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "PR4a 派工包集中批捕预案:合并门=--preview-slice 无 schema 错误;全格实拍证据由后续验收批次(双 AI 验收/QA)补录,--final 前必须清零"
    },
    "mobile.error-copy.INVALID_LOGIN_TICKET|ipad|en|cn": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "PR4a 派工包集中批捕预案:合并门=--preview-slice 无 schema 错误;全格实拍证据由后续验收批次(双 AI 验收/QA)补录,--final 前必须清零"
    },
    "mobile.error-copy.INVALID_LOGIN_TICKET|ipad|en|global": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "PR4a 派工包集中批捕预案:合并门=--preview-slice 无 schema 错误;全格实拍证据由后续验收批次(双 AI 验收/QA)补录,--final 前必须清零"
    },
    "mobile.error-copy.INVALID_LOGIN_TICKET|ipad|ja|cn": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "PR4a 派工包集中批捕预案:合并门=--preview-slice 无 schema 错误;全格实拍证据由后续验收批次(双 AI 验收/QA)补录,--final 前必须清零"
    },
    "mobile.error-copy.INVALID_LOGIN_TICKET|ipad|ja|global": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "PR4a 派工包集中批捕预案:合并门=--preview-slice 无 schema 错误;全格实拍证据由后续验收批次(双 AI 验收/QA)补录,--final 前必须清零"
    },
    "mobile.error-copy.INVALID_LOGIN_TICKET|ipad|ko|cn": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "PR4a 派工包集中批捕预案:合并门=--preview-slice 无 schema 错误;全格实拍证据由后续验收批次(双 AI 验收/QA)补录,--final 前必须清零"
    },
    "mobile.error-copy.INVALID_LOGIN_TICKET|ipad|ko|global": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "PR4a 派工包集中批捕预案:合并门=--preview-slice 无 schema 错误;全格实拍证据由后续验收批次(双 AI 验收/QA)补录,--final 前必须清零"
    },
    "mobile.error-copy.INVALID_LOGIN_TICKET|android-pad|zh-CN|cn": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "PR4a 派工包集中批捕预案:合并门=--preview-slice 无 schema 错误;全格实拍证据由后续验收批次(双 AI 验收/QA)补录,--final 前必须清零"
    },
    "mobile.error-copy.INVALID_LOGIN_TICKET|android-pad|zh-CN|global": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "PR4a 派工包集中批捕预案:合并门=--preview-slice 无 schema 错误;全格实拍证据由后续验收批次(双 AI 验收/QA)补录,--final 前必须清零"
    },
    "mobile.error-copy.INVALID_LOGIN_TICKET|android-pad|zh-TW|cn": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "PR4a 派工包集中批捕预案:合并门=--preview-slice 无 schema 错误;全格实拍证据由后续验收批次(双 AI 验收/QA)补录,--final 前必须清零"
    },
    "mobile.error-copy.INVALID_LOGIN_TICKET|android-pad|zh-TW|global": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "PR4a 派工包集中批捕预案:合并门=--preview-slice 无 schema 错误;全格实拍证据由后续验收批次(双 AI 验收/QA)补录,--final 前必须清零"
    },
    "mobile.error-copy.INVALID_LOGIN_TICKET|android-pad|en|cn": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "PR4a 派工包集中批捕预案:合并门=--preview-slice 无 schema 错误;全格实拍证据由后续验收批次(双 AI 验收/QA)补录,--final 前必须清零"
    },
    "mobile.error-copy.INVALID_LOGIN_TICKET|android-pad|en|global": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "PR4a 派工包集中批捕预案:合并门=--preview-slice 无 schema 错误;全格实拍证据由后续验收批次(双 AI 验收/QA)补录,--final 前必须清零"
    },
    "mobile.error-copy.INVALID_LOGIN_TICKET|android-pad|ja|cn": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "PR4a 派工包集中批捕预案:合并门=--preview-slice 无 schema 错误;全格实拍证据由后续验收批次(双 AI 验收/QA)补录,--final 前必须清零"
    },
    "mobile.error-copy.INVALID_LOGIN_TICKET|android-pad|ja|global": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "PR4a 派工包集中批捕预案:合并门=--preview-slice 无 schema 错误;全格实拍证据由后续验收批次(双 AI 验收/QA)补录,--final 前必须清零"
    },
    "mobile.error-copy.INVALID_LOGIN_TICKET|android-pad|ko|cn": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "PR4a 派工包集中批捕预案:合并门=--preview-slice 无 schema 错误;全格实拍证据由后续验收批次(双 AI 验收/QA)补录,--final 前必须清零"
    },
    "mobile.error-copy.INVALID_LOGIN_TICKET|android-pad|ko|global": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "PR4a 派工包集中批捕预案:合并门=--preview-slice 无 schema 错误;全格实拍证据由后续验收批次(双 AI 验收/QA)补录,--final 前必须清零"
    },
    "mobile.error-copy.INVALID_BIND_TICKET|iphone|zh-CN|cn": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "PR4a 派工包集中批捕预案:合并门=--preview-slice 无 schema 错误;全格实拍证据由后续验收批次(双 AI 验收/QA)补录,--final 前必须清零"
    },
    "mobile.error-copy.INVALID_BIND_TICKET|iphone|zh-CN|global": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "PR4a 派工包集中批捕预案:合并门=--preview-slice 无 schema 错误;全格实拍证据由后续验收批次(双 AI 验收/QA)补录,--final 前必须清零"
    },
    "mobile.error-copy.INVALID_BIND_TICKET|iphone|zh-TW|cn": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "PR4a 派工包集中批捕预案:合并门=--preview-slice 无 schema 错误;全格实拍证据由后续验收批次(双 AI 验收/QA)补录,--final 前必须清零"
    },
    "mobile.error-copy.INVALID_BIND_TICKET|iphone|zh-TW|global": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "PR4a 派工包集中批捕预案:合并门=--preview-slice 无 schema 错误;全格实拍证据由后续验收批次(双 AI 验收/QA)补录,--final 前必须清零"
    },
    "mobile.error-copy.INVALID_BIND_TICKET|iphone|en|cn": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "PR4a 派工包集中批捕预案:合并门=--preview-slice 无 schema 错误;全格实拍证据由后续验收批次(双 AI 验收/QA)补录,--final 前必须清零"
    },
    "mobile.error-copy.INVALID_BIND_TICKET|iphone|en|global": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "PR4a 派工包集中批捕预案:合并门=--preview-slice 无 schema 错误;全格实拍证据由后续验收批次(双 AI 验收/QA)补录,--final 前必须清零"
    },
    "mobile.error-copy.INVALID_BIND_TICKET|iphone|ja|cn": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "PR4a 派工包集中批捕预案:合并门=--preview-slice 无 schema 错误;全格实拍证据由后续验收批次(双 AI 验收/QA)补录,--final 前必须清零"
    },
    "mobile.error-copy.INVALID_BIND_TICKET|iphone|ja|global": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "PR4a 派工包集中批捕预案:合并门=--preview-slice 无 schema 错误;全格实拍证据由后续验收批次(双 AI 验收/QA)补录,--final 前必须清零"
    },
    "mobile.error-copy.INVALID_BIND_TICKET|iphone|ko|cn": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "PR4a 派工包集中批捕预案:合并门=--preview-slice 无 schema 错误;全格实拍证据由后续验收批次(双 AI 验收/QA)补录,--final 前必须清零"
    },
    "mobile.error-copy.INVALID_BIND_TICKET|iphone|ko|global": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "PR4a 派工包集中批捕预案:合并门=--preview-slice 无 schema 错误;全格实拍证据由后续验收批次(双 AI 验收/QA)补录,--final 前必须清零"
    },
    "mobile.error-copy.INVALID_BIND_TICKET|android-phone|zh-CN|cn": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "PR4a 派工包集中批捕预案:合并门=--preview-slice 无 schema 错误;全格实拍证据由后续验收批次(双 AI 验收/QA)补录,--final 前必须清零"
    },
    "mobile.error-copy.INVALID_BIND_TICKET|android-phone|zh-CN|global": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "PR4a 派工包集中批捕预案:合并门=--preview-slice 无 schema 错误;全格实拍证据由后续验收批次(双 AI 验收/QA)补录,--final 前必须清零"
    },
    "mobile.error-copy.INVALID_BIND_TICKET|android-phone|zh-TW|cn": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "PR4a 派工包集中批捕预案:合并门=--preview-slice 无 schema 错误;全格实拍证据由后续验收批次(双 AI 验收/QA)补录,--final 前必须清零"
    },
    "mobile.error-copy.INVALID_BIND_TICKET|android-phone|zh-TW|global": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "PR4a 派工包集中批捕预案:合并门=--preview-slice 无 schema 错误;全格实拍证据由后续验收批次(双 AI 验收/QA)补录,--final 前必须清零"
    },
    "mobile.error-copy.INVALID_BIND_TICKET|android-phone|en|cn": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "PR4a 派工包集中批捕预案:合并门=--preview-slice 无 schema 错误;全格实拍证据由后续验收批次(双 AI 验收/QA)补录,--final 前必须清零"
    },
    "mobile.error-copy.INVALID_BIND_TICKET|android-phone|en|global": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "PR4a 派工包集中批捕预案:合并门=--preview-slice 无 schema 错误;全格实拍证据由后续验收批次(双 AI 验收/QA)补录,--final 前必须清零"
    },
    "mobile.error-copy.INVALID_BIND_TICKET|android-phone|ja|cn": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "PR4a 派工包集中批捕预案:合并门=--preview-slice 无 schema 错误;全格实拍证据由后续验收批次(双 AI 验收/QA)补录,--final 前必须清零"
    },
    "mobile.error-copy.INVALID_BIND_TICKET|android-phone|ja|global": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "PR4a 派工包集中批捕预案:合并门=--preview-slice 无 schema 错误;全格实拍证据由后续验收批次(双 AI 验收/QA)补录,--final 前必须清零"
    },
    "mobile.error-copy.INVALID_BIND_TICKET|android-phone|ko|cn": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "PR4a 派工包集中批捕预案:合并门=--preview-slice 无 schema 错误;全格实拍证据由后续验收批次(双 AI 验收/QA)补录,--final 前必须清零"
    },
    "mobile.error-copy.INVALID_BIND_TICKET|android-phone|ko|global": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "PR4a 派工包集中批捕预案:合并门=--preview-slice 无 schema 错误;全格实拍证据由后续验收批次(双 AI 验收/QA)补录,--final 前必须清零"
    },
    "mobile.error-copy.INVALID_BIND_TICKET|ipad|zh-CN|cn": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "PR4a 派工包集中批捕预案:合并门=--preview-slice 无 schema 错误;全格实拍证据由后续验收批次(双 AI 验收/QA)补录,--final 前必须清零"
    },
    "mobile.error-copy.INVALID_BIND_TICKET|ipad|zh-CN|global": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "PR4a 派工包集中批捕预案:合并门=--preview-slice 无 schema 错误;全格实拍证据由后续验收批次(双 AI 验收/QA)补录,--final 前必须清零"
    },
    "mobile.error-copy.INVALID_BIND_TICKET|ipad|zh-TW|cn": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "PR4a 派工包集中批捕预案:合并门=--preview-slice 无 schema 错误;全格实拍证据由后续验收批次(双 AI 验收/QA)补录,--final 前必须清零"
    },
    "mobile.error-copy.INVALID_BIND_TICKET|ipad|zh-TW|global": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "PR4a 派工包集中批捕预案:合并门=--preview-slice 无 schema 错误;全格实拍证据由后续验收批次(双 AI 验收/QA)补录,--final 前必须清零"
    },
    "mobile.error-copy.INVALID_BIND_TICKET|ipad|en|cn": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "PR4a 派工包集中批捕预案:合并门=--preview-slice 无 schema 错误;全格实拍证据由后续验收批次(双 AI 验收/QA)补录,--final 前必须清零"
    },
    "mobile.error-copy.INVALID_BIND_TICKET|ipad|en|global": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "PR4a 派工包集中批捕预案:合并门=--preview-slice 无 schema 错误;全格实拍证据由后续验收批次(双 AI 验收/QA)补录,--final 前必须清零"
    },
    "mobile.error-copy.INVALID_BIND_TICKET|ipad|ja|cn": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "PR4a 派工包集中批捕预案:合并门=--preview-slice 无 schema 错误;全格实拍证据由后续验收批次(双 AI 验收/QA)补录,--final 前必须清零"
    },
    "mobile.error-copy.INVALID_BIND_TICKET|ipad|ja|global": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "PR4a 派工包集中批捕预案:合并门=--preview-slice 无 schema 错误;全格实拍证据由后续验收批次(双 AI 验收/QA)补录,--final 前必须清零"
    },
    "mobile.error-copy.INVALID_BIND_TICKET|ipad|ko|cn": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "PR4a 派工包集中批捕预案:合并门=--preview-slice 无 schema 错误;全格实拍证据由后续验收批次(双 AI 验收/QA)补录,--final 前必须清零"
    },
    "mobile.error-copy.INVALID_BIND_TICKET|ipad|ko|global": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "PR4a 派工包集中批捕预案:合并门=--preview-slice 无 schema 错误;全格实拍证据由后续验收批次(双 AI 验收/QA)补录,--final 前必须清零"
    },
    "mobile.error-copy.INVALID_BIND_TICKET|android-pad|zh-CN|cn": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "PR4a 派工包集中批捕预案:合并门=--preview-slice 无 schema 错误;全格实拍证据由后续验收批次(双 AI 验收/QA)补录,--final 前必须清零"
    },
    "mobile.error-copy.INVALID_BIND_TICKET|android-pad|zh-CN|global": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "PR4a 派工包集中批捕预案:合并门=--preview-slice 无 schema 错误;全格实拍证据由后续验收批次(双 AI 验收/QA)补录,--final 前必须清零"
    },
    "mobile.error-copy.INVALID_BIND_TICKET|android-pad|zh-TW|cn": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "PR4a 派工包集中批捕预案:合并门=--preview-slice 无 schema 错误;全格实拍证据由后续验收批次(双 AI 验收/QA)补录,--final 前必须清零"
    },
    "mobile.error-copy.INVALID_BIND_TICKET|android-pad|zh-TW|global": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "PR4a 派工包集中批捕预案:合并门=--preview-slice 无 schema 错误;全格实拍证据由后续验收批次(双 AI 验收/QA)补录,--final 前必须清零"
    },
    "mobile.error-copy.INVALID_BIND_TICKET|android-pad|en|cn": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "PR4a 派工包集中批捕预案:合并门=--preview-slice 无 schema 错误;全格实拍证据由后续验收批次(双 AI 验收/QA)补录,--final 前必须清零"
    },
    "mobile.error-copy.INVALID_BIND_TICKET|android-pad|en|global": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "PR4a 派工包集中批捕预案:合并门=--preview-slice 无 schema 错误;全格实拍证据由后续验收批次(双 AI 验收/QA)补录,--final 前必须清零"
    },
    "mobile.error-copy.INVALID_BIND_TICKET|android-pad|ja|cn": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "PR4a 派工包集中批捕预案:合并门=--preview-slice 无 schema 错误;全格实拍证据由后续验收批次(双 AI 验收/QA)补录,--final 前必须清零"
    },
    "mobile.error-copy.INVALID_BIND_TICKET|android-pad|ja|global": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "PR4a 派工包集中批捕预案:合并门=--preview-slice 无 schema 错误;全格实拍证据由后续验收批次(双 AI 验收/QA)补录,--final 前必须清零"
    },
    "mobile.error-copy.INVALID_BIND_TICKET|android-pad|ko|cn": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "PR4a 派工包集中批捕预案:合并门=--preview-slice 无 schema 错误;全格实拍证据由后续验收批次(双 AI 验收/QA)补录,--final 前必须清零"
    },
    "mobile.error-copy.INVALID_BIND_TICKET|android-pad|ko|global": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "PR4a 派工包集中批捕预案:合并门=--preview-slice 无 schema 错误;全格实拍证据由后续验收批次(双 AI 验收/QA)补录,--final 前必须清零"
    },
    "mobile.error-copy.STATE_MISMATCH|iphone|zh-CN|cn": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "PR4a 派工包集中批捕预案:合并门=--preview-slice 无 schema 错误;全格实拍证据由后续验收批次(双 AI 验收/QA)补录,--final 前必须清零"
    },
    "mobile.error-copy.STATE_MISMATCH|iphone|zh-CN|global": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "PR4a 派工包集中批捕预案:合并门=--preview-slice 无 schema 错误;全格实拍证据由后续验收批次(双 AI 验收/QA)补录,--final 前必须清零"
    },
    "mobile.error-copy.STATE_MISMATCH|iphone|zh-TW|cn": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "PR4a 派工包集中批捕预案:合并门=--preview-slice 无 schema 错误;全格实拍证据由后续验收批次(双 AI 验收/QA)补录,--final 前必须清零"
    },
    "mobile.error-copy.STATE_MISMATCH|iphone|zh-TW|global": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "PR4a 派工包集中批捕预案:合并门=--preview-slice 无 schema 错误;全格实拍证据由后续验收批次(双 AI 验收/QA)补录,--final 前必须清零"
    },
    "mobile.error-copy.STATE_MISMATCH|iphone|en|cn": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "PR4a 派工包集中批捕预案:合并门=--preview-slice 无 schema 错误;全格实拍证据由后续验收批次(双 AI 验收/QA)补录,--final 前必须清零"
    },
    "mobile.error-copy.STATE_MISMATCH|iphone|en|global": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "PR4a 派工包集中批捕预案:合并门=--preview-slice 无 schema 错误;全格实拍证据由后续验收批次(双 AI 验收/QA)补录,--final 前必须清零"
    },
    "mobile.error-copy.STATE_MISMATCH|iphone|ja|cn": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "PR4a 派工包集中批捕预案:合并门=--preview-slice 无 schema 错误;全格实拍证据由后续验收批次(双 AI 验收/QA)补录,--final 前必须清零"
    },
    "mobile.error-copy.STATE_MISMATCH|iphone|ja|global": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "PR4a 派工包集中批捕预案:合并门=--preview-slice 无 schema 错误;全格实拍证据由后续验收批次(双 AI 验收/QA)补录,--final 前必须清零"
    },
    "mobile.error-copy.STATE_MISMATCH|iphone|ko|cn": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "PR4a 派工包集中批捕预案:合并门=--preview-slice 无 schema 错误;全格实拍证据由后续验收批次(双 AI 验收/QA)补录,--final 前必须清零"
    },
    "mobile.error-copy.STATE_MISMATCH|iphone|ko|global": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "PR4a 派工包集中批捕预案:合并门=--preview-slice 无 schema 错误;全格实拍证据由后续验收批次(双 AI 验收/QA)补录,--final 前必须清零"
    },
    "mobile.error-copy.STATE_MISMATCH|android-phone|zh-CN|cn": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "PR4a 派工包集中批捕预案:合并门=--preview-slice 无 schema 错误;全格实拍证据由后续验收批次(双 AI 验收/QA)补录,--final 前必须清零"
    },
    "mobile.error-copy.STATE_MISMATCH|android-phone|zh-CN|global": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "PR4a 派工包集中批捕预案:合并门=--preview-slice 无 schema 错误;全格实拍证据由后续验收批次(双 AI 验收/QA)补录,--final 前必须清零"
    },
    "mobile.error-copy.STATE_MISMATCH|android-phone|zh-TW|cn": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "PR4a 派工包集中批捕预案:合并门=--preview-slice 无 schema 错误;全格实拍证据由后续验收批次(双 AI 验收/QA)补录,--final 前必须清零"
    },
    "mobile.error-copy.STATE_MISMATCH|android-phone|zh-TW|global": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "PR4a 派工包集中批捕预案:合并门=--preview-slice 无 schema 错误;全格实拍证据由后续验收批次(双 AI 验收/QA)补录,--final 前必须清零"
    },
    "mobile.error-copy.STATE_MISMATCH|android-phone|en|cn": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "PR4a 派工包集中批捕预案:合并门=--preview-slice 无 schema 错误;全格实拍证据由后续验收批次(双 AI 验收/QA)补录,--final 前必须清零"
    },
    "mobile.error-copy.STATE_MISMATCH|android-phone|en|global": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "PR4a 派工包集中批捕预案:合并门=--preview-slice 无 schema 错误;全格实拍证据由后续验收批次(双 AI 验收/QA)补录,--final 前必须清零"
    },
    "mobile.error-copy.STATE_MISMATCH|android-phone|ja|cn": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "PR4a 派工包集中批捕预案:合并门=--preview-slice 无 schema 错误;全格实拍证据由后续验收批次(双 AI 验收/QA)补录,--final 前必须清零"
    },
    "mobile.error-copy.STATE_MISMATCH|android-phone|ja|global": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "PR4a 派工包集中批捕预案:合并门=--preview-slice 无 schema 错误;全格实拍证据由后续验收批次(双 AI 验收/QA)补录,--final 前必须清零"
    },
    "mobile.error-copy.STATE_MISMATCH|android-phone|ko|cn": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "PR4a 派工包集中批捕预案:合并门=--preview-slice 无 schema 错误;全格实拍证据由后续验收批次(双 AI 验收/QA)补录,--final 前必须清零"
    },
    "mobile.error-copy.STATE_MISMATCH|android-phone|ko|global": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "PR4a 派工包集中批捕预案:合并门=--preview-slice 无 schema 错误;全格实拍证据由后续验收批次(双 AI 验收/QA)补录,--final 前必须清零"
    },
    "mobile.error-copy.STATE_MISMATCH|ipad|zh-CN|cn": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "PR4a 派工包集中批捕预案:合并门=--preview-slice 无 schema 错误;全格实拍证据由后续验收批次(双 AI 验收/QA)补录,--final 前必须清零"
    },
    "mobile.error-copy.STATE_MISMATCH|ipad|zh-CN|global": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "PR4a 派工包集中批捕预案:合并门=--preview-slice 无 schema 错误;全格实拍证据由后续验收批次(双 AI 验收/QA)补录,--final 前必须清零"
    },
    "mobile.error-copy.STATE_MISMATCH|ipad|zh-TW|cn": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "PR4a 派工包集中批捕预案:合并门=--preview-slice 无 schema 错误;全格实拍证据由后续验收批次(双 AI 验收/QA)补录,--final 前必须清零"
    },
    "mobile.error-copy.STATE_MISMATCH|ipad|zh-TW|global": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "PR4a 派工包集中批捕预案:合并门=--preview-slice 无 schema 错误;全格实拍证据由后续验收批次(双 AI 验收/QA)补录,--final 前必须清零"
    },
    "mobile.error-copy.STATE_MISMATCH|ipad|en|cn": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "PR4a 派工包集中批捕预案:合并门=--preview-slice 无 schema 错误;全格实拍证据由后续验收批次(双 AI 验收/QA)补录,--final 前必须清零"
    },
    "mobile.error-copy.STATE_MISMATCH|ipad|en|global": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "PR4a 派工包集中批捕预案:合并门=--preview-slice 无 schema 错误;全格实拍证据由后续验收批次(双 AI 验收/QA)补录,--final 前必须清零"
    },
    "mobile.error-copy.STATE_MISMATCH|ipad|ja|cn": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "PR4a 派工包集中批捕预案:合并门=--preview-slice 无 schema 错误;全格实拍证据由后续验收批次(双 AI 验收/QA)补录,--final 前必须清零"
    },
    "mobile.error-copy.STATE_MISMATCH|ipad|ja|global": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "PR4a 派工包集中批捕预案:合并门=--preview-slice 无 schema 错误;全格实拍证据由后续验收批次(双 AI 验收/QA)补录,--final 前必须清零"
    },
    "mobile.error-copy.STATE_MISMATCH|ipad|ko|cn": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "PR4a 派工包集中批捕预案:合并门=--preview-slice 无 schema 错误;全格实拍证据由后续验收批次(双 AI 验收/QA)补录,--final 前必须清零"
    },
    "mobile.error-copy.STATE_MISMATCH|ipad|ko|global": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "PR4a 派工包集中批捕预案:合并门=--preview-slice 无 schema 错误;全格实拍证据由后续验收批次(双 AI 验收/QA)补录,--final 前必须清零"
    },
    "mobile.error-copy.STATE_MISMATCH|android-pad|zh-CN|cn": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "PR4a 派工包集中批捕预案:合并门=--preview-slice 无 schema 错误;全格实拍证据由后续验收批次(双 AI 验收/QA)补录,--final 前必须清零"
    },
    "mobile.error-copy.STATE_MISMATCH|android-pad|zh-CN|global": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "PR4a 派工包集中批捕预案:合并门=--preview-slice 无 schema 错误;全格实拍证据由后续验收批次(双 AI 验收/QA)补录,--final 前必须清零"
    },
    "mobile.error-copy.STATE_MISMATCH|android-pad|zh-TW|cn": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "PR4a 派工包集中批捕预案:合并门=--preview-slice 无 schema 错误;全格实拍证据由后续验收批次(双 AI 验收/QA)补录,--final 前必须清零"
    },
    "mobile.error-copy.STATE_MISMATCH|android-pad|zh-TW|global": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "PR4a 派工包集中批捕预案:合并门=--preview-slice 无 schema 错误;全格实拍证据由后续验收批次(双 AI 验收/QA)补录,--final 前必须清零"
    },
    "mobile.error-copy.STATE_MISMATCH|android-pad|en|cn": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "PR4a 派工包集中批捕预案:合并门=--preview-slice 无 schema 错误;全格实拍证据由后续验收批次(双 AI 验收/QA)补录,--final 前必须清零"
    },
    "mobile.error-copy.STATE_MISMATCH|android-pad|en|global": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "PR4a 派工包集中批捕预案:合并门=--preview-slice 无 schema 错误;全格实拍证据由后续验收批次(双 AI 验收/QA)补录,--final 前必须清零"
    },
    "mobile.error-copy.STATE_MISMATCH|android-pad|ja|cn": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "PR4a 派工包集中批捕预案:合并门=--preview-slice 无 schema 错误;全格实拍证据由后续验收批次(双 AI 验收/QA)补录,--final 前必须清零"
    },
    "mobile.error-copy.STATE_MISMATCH|android-pad|ja|global": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "PR4a 派工包集中批捕预案:合并门=--preview-slice 无 schema 错误;全格实拍证据由后续验收批次(双 AI 验收/QA)补录,--final 前必须清零"
    },
    "mobile.error-copy.STATE_MISMATCH|android-pad|ko|cn": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "PR4a 派工包集中批捕预案:合并门=--preview-slice 无 schema 错误;全格实拍证据由后续验收批次(双 AI 验收/QA)补录,--final 前必须清零"
    },
    "mobile.error-copy.STATE_MISMATCH|android-pad|ko|global": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "PR4a 派工包集中批捕预案:合并门=--preview-slice 无 schema 错误;全格实拍证据由后续验收批次(双 AI 验收/QA)补录,--final 前必须清零"
    },
    "mobile.error-copy.REGION_MISMATCH|iphone|zh-CN|cn": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "PR4a 派工包集中批捕预案:合并门=--preview-slice 无 schema 错误;全格实拍证据由后续验收批次(双 AI 验收/QA)补录,--final 前必须清零"
    },
    "mobile.error-copy.REGION_MISMATCH|iphone|zh-CN|global": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "PR4a 派工包集中批捕预案:合并门=--preview-slice 无 schema 错误;全格实拍证据由后续验收批次(双 AI 验收/QA)补录,--final 前必须清零"
    },
    "mobile.error-copy.REGION_MISMATCH|iphone|zh-TW|cn": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "PR4a 派工包集中批捕预案:合并门=--preview-slice 无 schema 错误;全格实拍证据由后续验收批次(双 AI 验收/QA)补录,--final 前必须清零"
    },
    "mobile.error-copy.REGION_MISMATCH|iphone|zh-TW|global": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "PR4a 派工包集中批捕预案:合并门=--preview-slice 无 schema 错误;全格实拍证据由后续验收批次(双 AI 验收/QA)补录,--final 前必须清零"
    },
    "mobile.error-copy.REGION_MISMATCH|iphone|en|cn": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "PR4a 派工包集中批捕预案:合并门=--preview-slice 无 schema 错误;全格实拍证据由后续验收批次(双 AI 验收/QA)补录,--final 前必须清零"
    },
    "mobile.error-copy.REGION_MISMATCH|iphone|en|global": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "PR4a 派工包集中批捕预案:合并门=--preview-slice 无 schema 错误;全格实拍证据由后续验收批次(双 AI 验收/QA)补录,--final 前必须清零"
    },
    "mobile.error-copy.REGION_MISMATCH|iphone|ja|cn": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "PR4a 派工包集中批捕预案:合并门=--preview-slice 无 schema 错误;全格实拍证据由后续验收批次(双 AI 验收/QA)补录,--final 前必须清零"
    },
    "mobile.error-copy.REGION_MISMATCH|iphone|ja|global": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "PR4a 派工包集中批捕预案:合并门=--preview-slice 无 schema 错误;全格实拍证据由后续验收批次(双 AI 验收/QA)补录,--final 前必须清零"
    },
    "mobile.error-copy.REGION_MISMATCH|iphone|ko|cn": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "PR4a 派工包集中批捕预案:合并门=--preview-slice 无 schema 错误;全格实拍证据由后续验收批次(双 AI 验收/QA)补录,--final 前必须清零"
    },
    "mobile.error-copy.REGION_MISMATCH|iphone|ko|global": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "PR4a 派工包集中批捕预案:合并门=--preview-slice 无 schema 错误;全格实拍证据由后续验收批次(双 AI 验收/QA)补录,--final 前必须清零"
    },
    "mobile.error-copy.REGION_MISMATCH|android-phone|zh-CN|cn": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "PR4a 派工包集中批捕预案:合并门=--preview-slice 无 schema 错误;全格实拍证据由后续验收批次(双 AI 验收/QA)补录,--final 前必须清零"
    },
    "mobile.error-copy.REGION_MISMATCH|android-phone|zh-CN|global": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "PR4a 派工包集中批捕预案:合并门=--preview-slice 无 schema 错误;全格实拍证据由后续验收批次(双 AI 验收/QA)补录,--final 前必须清零"
    },
    "mobile.error-copy.REGION_MISMATCH|android-phone|zh-TW|cn": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "PR4a 派工包集中批捕预案:合并门=--preview-slice 无 schema 错误;全格实拍证据由后续验收批次(双 AI 验收/QA)补录,--final 前必须清零"
    },
    "mobile.error-copy.REGION_MISMATCH|android-phone|zh-TW|global": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "PR4a 派工包集中批捕预案:合并门=--preview-slice 无 schema 错误;全格实拍证据由后续验收批次(双 AI 验收/QA)补录,--final 前必须清零"
    },
    "mobile.error-copy.REGION_MISMATCH|android-phone|en|cn": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "PR4a 派工包集中批捕预案:合并门=--preview-slice 无 schema 错误;全格实拍证据由后续验收批次(双 AI 验收/QA)补录,--final 前必须清零"
    },
    "mobile.error-copy.REGION_MISMATCH|android-phone|en|global": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "PR4a 派工包集中批捕预案:合并门=--preview-slice 无 schema 错误;全格实拍证据由后续验收批次(双 AI 验收/QA)补录,--final 前必须清零"
    },
    "mobile.error-copy.REGION_MISMATCH|android-phone|ja|cn": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "PR4a 派工包集中批捕预案:合并门=--preview-slice 无 schema 错误;全格实拍证据由后续验收批次(双 AI 验收/QA)补录,--final 前必须清零"
    },
    "mobile.error-copy.REGION_MISMATCH|android-phone|ja|global": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "PR4a 派工包集中批捕预案:合并门=--preview-slice 无 schema 错误;全格实拍证据由后续验收批次(双 AI 验收/QA)补录,--final 前必须清零"
    },
    "mobile.error-copy.REGION_MISMATCH|android-phone|ko|cn": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "PR4a 派工包集中批捕预案:合并门=--preview-slice 无 schema 错误;全格实拍证据由后续验收批次(双 AI 验收/QA)补录,--final 前必须清零"
    },
    "mobile.error-copy.REGION_MISMATCH|android-phone|ko|global": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "PR4a 派工包集中批捕预案:合并门=--preview-slice 无 schema 错误;全格实拍证据由后续验收批次(双 AI 验收/QA)补录,--final 前必须清零"
    },
    "mobile.error-copy.REGION_MISMATCH|ipad|zh-CN|cn": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "PR4a 派工包集中批捕预案:合并门=--preview-slice 无 schema 错误;全格实拍证据由后续验收批次(双 AI 验收/QA)补录,--final 前必须清零"
    },
    "mobile.error-copy.REGION_MISMATCH|ipad|zh-CN|global": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "PR4a 派工包集中批捕预案:合并门=--preview-slice 无 schema 错误;全格实拍证据由后续验收批次(双 AI 验收/QA)补录,--final 前必须清零"
    },
    "mobile.error-copy.REGION_MISMATCH|ipad|zh-TW|cn": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "PR4a 派工包集中批捕预案:合并门=--preview-slice 无 schema 错误;全格实拍证据由后续验收批次(双 AI 验收/QA)补录,--final 前必须清零"
    },
    "mobile.error-copy.REGION_MISMATCH|ipad|zh-TW|global": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "PR4a 派工包集中批捕预案:合并门=--preview-slice 无 schema 错误;全格实拍证据由后续验收批次(双 AI 验收/QA)补录,--final 前必须清零"
    },
    "mobile.error-copy.REGION_MISMATCH|ipad|en|cn": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "PR4a 派工包集中批捕预案:合并门=--preview-slice 无 schema 错误;全格实拍证据由后续验收批次(双 AI 验收/QA)补录,--final 前必须清零"
    },
    "mobile.error-copy.REGION_MISMATCH|ipad|en|global": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "PR4a 派工包集中批捕预案:合并门=--preview-slice 无 schema 错误;全格实拍证据由后续验收批次(双 AI 验收/QA)补录,--final 前必须清零"
    },
    "mobile.error-copy.REGION_MISMATCH|ipad|ja|cn": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "PR4a 派工包集中批捕预案:合并门=--preview-slice 无 schema 错误;全格实拍证据由后续验收批次(双 AI 验收/QA)补录,--final 前必须清零"
    },
    "mobile.error-copy.REGION_MISMATCH|ipad|ja|global": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "PR4a 派工包集中批捕预案:合并门=--preview-slice 无 schema 错误;全格实拍证据由后续验收批次(双 AI 验收/QA)补录,--final 前必须清零"
    },
    "mobile.error-copy.REGION_MISMATCH|ipad|ko|cn": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "PR4a 派工包集中批捕预案:合并门=--preview-slice 无 schema 错误;全格实拍证据由后续验收批次(双 AI 验收/QA)补录,--final 前必须清零"
    },
    "mobile.error-copy.REGION_MISMATCH|ipad|ko|global": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "PR4a 派工包集中批捕预案:合并门=--preview-slice 无 schema 错误;全格实拍证据由后续验收批次(双 AI 验收/QA)补录,--final 前必须清零"
    },
    "mobile.error-copy.REGION_MISMATCH|android-pad|zh-CN|cn": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "PR4a 派工包集中批捕预案:合并门=--preview-slice 无 schema 错误;全格实拍证据由后续验收批次(双 AI 验收/QA)补录,--final 前必须清零"
    },
    "mobile.error-copy.REGION_MISMATCH|android-pad|zh-CN|global": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "PR4a 派工包集中批捕预案:合并门=--preview-slice 无 schema 错误;全格实拍证据由后续验收批次(双 AI 验收/QA)补录,--final 前必须清零"
    },
    "mobile.error-copy.REGION_MISMATCH|android-pad|zh-TW|cn": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "PR4a 派工包集中批捕预案:合并门=--preview-slice 无 schema 错误;全格实拍证据由后续验收批次(双 AI 验收/QA)补录,--final 前必须清零"
    },
    "mobile.error-copy.REGION_MISMATCH|android-pad|zh-TW|global": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "PR4a 派工包集中批捕预案:合并门=--preview-slice 无 schema 错误;全格实拍证据由后续验收批次(双 AI 验收/QA)补录,--final 前必须清零"
    },
    "mobile.error-copy.REGION_MISMATCH|android-pad|en|cn": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "PR4a 派工包集中批捕预案:合并门=--preview-slice 无 schema 错误;全格实拍证据由后续验收批次(双 AI 验收/QA)补录,--final 前必须清零"
    },
    "mobile.error-copy.REGION_MISMATCH|android-pad|en|global": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "PR4a 派工包集中批捕预案:合并门=--preview-slice 无 schema 错误;全格实拍证据由后续验收批次(双 AI 验收/QA)补录,--final 前必须清零"
    },
    "mobile.error-copy.REGION_MISMATCH|android-pad|ja|cn": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "PR4a 派工包集中批捕预案:合并门=--preview-slice 无 schema 错误;全格实拍证据由后续验收批次(双 AI 验收/QA)补录,--final 前必须清零"
    },
    "mobile.error-copy.REGION_MISMATCH|android-pad|ja|global": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "PR4a 派工包集中批捕预案:合并门=--preview-slice 无 schema 错误;全格实拍证据由后续验收批次(双 AI 验收/QA)补录,--final 前必须清零"
    },
    "mobile.error-copy.REGION_MISMATCH|android-pad|ko|cn": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "PR4a 派工包集中批捕预案:合并门=--preview-slice 无 schema 错误;全格实拍证据由后续验收批次(双 AI 验收/QA)补录,--final 前必须清零"
    },
    "mobile.error-copy.REGION_MISMATCH|android-pad|ko|global": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "PR4a 派工包集中批捕预案:合并门=--preview-slice 无 schema 错误;全格实拍证据由后续验收批次(双 AI 验收/QA)补录,--final 前必须清零"
    },
    "mobile.error-copy.NETWORK_ERROR|iphone|zh-CN|cn": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "PR4a 派工包集中批捕预案:合并门=--preview-slice 无 schema 错误;全格实拍证据由后续验收批次(双 AI 验收/QA)补录,--final 前必须清零"
    },
    "mobile.error-copy.NETWORK_ERROR|iphone|zh-CN|global": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "PR4a 派工包集中批捕预案:合并门=--preview-slice 无 schema 错误;全格实拍证据由后续验收批次(双 AI 验收/QA)补录,--final 前必须清零"
    },
    "mobile.error-copy.NETWORK_ERROR|iphone|zh-TW|cn": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "PR4a 派工包集中批捕预案:合并门=--preview-slice 无 schema 错误;全格实拍证据由后续验收批次(双 AI 验收/QA)补录,--final 前必须清零"
    },
    "mobile.error-copy.NETWORK_ERROR|iphone|zh-TW|global": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "PR4a 派工包集中批捕预案:合并门=--preview-slice 无 schema 错误;全格实拍证据由后续验收批次(双 AI 验收/QA)补录,--final 前必须清零"
    },
    "mobile.error-copy.NETWORK_ERROR|iphone|en|cn": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "PR4a 派工包集中批捕预案:合并门=--preview-slice 无 schema 错误;全格实拍证据由后续验收批次(双 AI 验收/QA)补录,--final 前必须清零"
    },
    "mobile.error-copy.NETWORK_ERROR|iphone|en|global": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "PR4a 派工包集中批捕预案:合并门=--preview-slice 无 schema 错误;全格实拍证据由后续验收批次(双 AI 验收/QA)补录,--final 前必须清零"
    },
    "mobile.error-copy.NETWORK_ERROR|iphone|ja|cn": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "PR4a 派工包集中批捕预案:合并门=--preview-slice 无 schema 错误;全格实拍证据由后续验收批次(双 AI 验收/QA)补录,--final 前必须清零"
    },
    "mobile.error-copy.NETWORK_ERROR|iphone|ja|global": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "PR4a 派工包集中批捕预案:合并门=--preview-slice 无 schema 错误;全格实拍证据由后续验收批次(双 AI 验收/QA)补录,--final 前必须清零"
    },
    "mobile.error-copy.NETWORK_ERROR|iphone|ko|cn": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "PR4a 派工包集中批捕预案:合并门=--preview-slice 无 schema 错误;全格实拍证据由后续验收批次(双 AI 验收/QA)补录,--final 前必须清零"
    },
    "mobile.error-copy.NETWORK_ERROR|iphone|ko|global": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "PR4a 派工包集中批捕预案:合并门=--preview-slice 无 schema 错误;全格实拍证据由后续验收批次(双 AI 验收/QA)补录,--final 前必须清零"
    },
    "mobile.error-copy.NETWORK_ERROR|android-phone|zh-CN|cn": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "PR4a 派工包集中批捕预案:合并门=--preview-slice 无 schema 错误;全格实拍证据由后续验收批次(双 AI 验收/QA)补录,--final 前必须清零"
    },
    "mobile.error-copy.NETWORK_ERROR|android-phone|zh-CN|global": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "PR4a 派工包集中批捕预案:合并门=--preview-slice 无 schema 错误;全格实拍证据由后续验收批次(双 AI 验收/QA)补录,--final 前必须清零"
    },
    "mobile.error-copy.NETWORK_ERROR|android-phone|zh-TW|cn": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "PR4a 派工包集中批捕预案:合并门=--preview-slice 无 schema 错误;全格实拍证据由后续验收批次(双 AI 验收/QA)补录,--final 前必须清零"
    },
    "mobile.error-copy.NETWORK_ERROR|android-phone|zh-TW|global": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "PR4a 派工包集中批捕预案:合并门=--preview-slice 无 schema 错误;全格实拍证据由后续验收批次(双 AI 验收/QA)补录,--final 前必须清零"
    },
    "mobile.error-copy.NETWORK_ERROR|android-phone|en|cn": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "PR4a 派工包集中批捕预案:合并门=--preview-slice 无 schema 错误;全格实拍证据由后续验收批次(双 AI 验收/QA)补录,--final 前必须清零"
    },
    "mobile.error-copy.NETWORK_ERROR|android-phone|en|global": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "PR4a 派工包集中批捕预案:合并门=--preview-slice 无 schema 错误;全格实拍证据由后续验收批次(双 AI 验收/QA)补录,--final 前必须清零"
    },
    "mobile.error-copy.NETWORK_ERROR|android-phone|ja|cn": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "PR4a 派工包集中批捕预案:合并门=--preview-slice 无 schema 错误;全格实拍证据由后续验收批次(双 AI 验收/QA)补录,--final 前必须清零"
    },
    "mobile.error-copy.NETWORK_ERROR|android-phone|ja|global": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "PR4a 派工包集中批捕预案:合并门=--preview-slice 无 schema 错误;全格实拍证据由后续验收批次(双 AI 验收/QA)补录,--final 前必须清零"
    },
    "mobile.error-copy.NETWORK_ERROR|android-phone|ko|cn": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "PR4a 派工包集中批捕预案:合并门=--preview-slice 无 schema 错误;全格实拍证据由后续验收批次(双 AI 验收/QA)补录,--final 前必须清零"
    },
    "mobile.error-copy.NETWORK_ERROR|android-phone|ko|global": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "PR4a 派工包集中批捕预案:合并门=--preview-slice 无 schema 错误;全格实拍证据由后续验收批次(双 AI 验收/QA)补录,--final 前必须清零"
    },
    "mobile.error-copy.NETWORK_ERROR|ipad|zh-CN|cn": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "PR4a 派工包集中批捕预案:合并门=--preview-slice 无 schema 错误;全格实拍证据由后续验收批次(双 AI 验收/QA)补录,--final 前必须清零"
    },
    "mobile.error-copy.NETWORK_ERROR|ipad|zh-CN|global": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "PR4a 派工包集中批捕预案:合并门=--preview-slice 无 schema 错误;全格实拍证据由后续验收批次(双 AI 验收/QA)补录,--final 前必须清零"
    },
    "mobile.error-copy.NETWORK_ERROR|ipad|zh-TW|cn": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "PR4a 派工包集中批捕预案:合并门=--preview-slice 无 schema 错误;全格实拍证据由后续验收批次(双 AI 验收/QA)补录,--final 前必须清零"
    },
    "mobile.error-copy.NETWORK_ERROR|ipad|zh-TW|global": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "PR4a 派工包集中批捕预案:合并门=--preview-slice 无 schema 错误;全格实拍证据由后续验收批次(双 AI 验收/QA)补录,--final 前必须清零"
    },
    "mobile.error-copy.NETWORK_ERROR|ipad|en|cn": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "PR4a 派工包集中批捕预案:合并门=--preview-slice 无 schema 错误;全格实拍证据由后续验收批次(双 AI 验收/QA)补录,--final 前必须清零"
    },
    "mobile.error-copy.NETWORK_ERROR|ipad|en|global": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "PR4a 派工包集中批捕预案:合并门=--preview-slice 无 schema 错误;全格实拍证据由后续验收批次(双 AI 验收/QA)补录,--final 前必须清零"
    },
    "mobile.error-copy.NETWORK_ERROR|ipad|ja|cn": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "PR4a 派工包集中批捕预案:合并门=--preview-slice 无 schema 错误;全格实拍证据由后续验收批次(双 AI 验收/QA)补录,--final 前必须清零"
    },
    "mobile.error-copy.NETWORK_ERROR|ipad|ja|global": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "PR4a 派工包集中批捕预案:合并门=--preview-slice 无 schema 错误;全格实拍证据由后续验收批次(双 AI 验收/QA)补录,--final 前必须清零"
    },
    "mobile.error-copy.NETWORK_ERROR|ipad|ko|cn": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "PR4a 派工包集中批捕预案:合并门=--preview-slice 无 schema 错误;全格实拍证据由后续验收批次(双 AI 验收/QA)补录,--final 前必须清零"
    },
    "mobile.error-copy.NETWORK_ERROR|ipad|ko|global": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "PR4a 派工包集中批捕预案:合并门=--preview-slice 无 schema 错误;全格实拍证据由后续验收批次(双 AI 验收/QA)补录,--final 前必须清零"
    },
    "mobile.error-copy.NETWORK_ERROR|android-pad|zh-CN|cn": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "PR4a 派工包集中批捕预案:合并门=--preview-slice 无 schema 错误;全格实拍证据由后续验收批次(双 AI 验收/QA)补录,--final 前必须清零"
    },
    "mobile.error-copy.NETWORK_ERROR|android-pad|zh-CN|global": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "PR4a 派工包集中批捕预案:合并门=--preview-slice 无 schema 错误;全格实拍证据由后续验收批次(双 AI 验收/QA)补录,--final 前必须清零"
    },
    "mobile.error-copy.NETWORK_ERROR|android-pad|zh-TW|cn": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "PR4a 派工包集中批捕预案:合并门=--preview-slice 无 schema 错误;全格实拍证据由后续验收批次(双 AI 验收/QA)补录,--final 前必须清零"
    },
    "mobile.error-copy.NETWORK_ERROR|android-pad|zh-TW|global": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "PR4a 派工包集中批捕预案:合并门=--preview-slice 无 schema 错误;全格实拍证据由后续验收批次(双 AI 验收/QA)补录,--final 前必须清零"
    },
    "mobile.error-copy.NETWORK_ERROR|android-pad|en|cn": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "PR4a 派工包集中批捕预案:合并门=--preview-slice 无 schema 错误;全格实拍证据由后续验收批次(双 AI 验收/QA)补录,--final 前必须清零"
    },
    "mobile.error-copy.NETWORK_ERROR|android-pad|en|global": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "PR4a 派工包集中批捕预案:合并门=--preview-slice 无 schema 错误;全格实拍证据由后续验收批次(双 AI 验收/QA)补录,--final 前必须清零"
    },
    "mobile.error-copy.NETWORK_ERROR|android-pad|ja|cn": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "PR4a 派工包集中批捕预案:合并门=--preview-slice 无 schema 错误;全格实拍证据由后续验收批次(双 AI 验收/QA)补录,--final 前必须清零"
    },
    "mobile.error-copy.NETWORK_ERROR|android-pad|ja|global": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "PR4a 派工包集中批捕预案:合并门=--preview-slice 无 schema 错误;全格实拍证据由后续验收批次(双 AI 验收/QA)补录,--final 前必须清零"
    },
    "mobile.error-copy.NETWORK_ERROR|android-pad|ko|cn": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "PR4a 派工包集中批捕预案:合并门=--preview-slice 无 schema 错误;全格实拍证据由后续验收批次(双 AI 验收/QA)补录,--final 前必须清零"
    },
    "mobile.error-copy.NETWORK_ERROR|android-pad|ko|global": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "PR4a 派工包集中批捕预案:合并门=--preview-slice 无 schema 错误;全格实拍证据由后续验收批次(双 AI 验收/QA)补录,--final 前必须清零"
    },
    "mobile.error-copy.REQUEST_TIMEOUT|iphone|zh-CN|cn": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "PR4a 派工包集中批捕预案:合并门=--preview-slice 无 schema 错误;全格实拍证据由后续验收批次(双 AI 验收/QA)补录,--final 前必须清零"
    },
    "mobile.error-copy.REQUEST_TIMEOUT|iphone|zh-CN|global": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "PR4a 派工包集中批捕预案:合并门=--preview-slice 无 schema 错误;全格实拍证据由后续验收批次(双 AI 验收/QA)补录,--final 前必须清零"
    },
    "mobile.error-copy.REQUEST_TIMEOUT|iphone|zh-TW|cn": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "PR4a 派工包集中批捕预案:合并门=--preview-slice 无 schema 错误;全格实拍证据由后续验收批次(双 AI 验收/QA)补录,--final 前必须清零"
    },
    "mobile.error-copy.REQUEST_TIMEOUT|iphone|zh-TW|global": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "PR4a 派工包集中批捕预案:合并门=--preview-slice 无 schema 错误;全格实拍证据由后续验收批次(双 AI 验收/QA)补录,--final 前必须清零"
    },
    "mobile.error-copy.REQUEST_TIMEOUT|iphone|en|cn": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "PR4a 派工包集中批捕预案:合并门=--preview-slice 无 schema 错误;全格实拍证据由后续验收批次(双 AI 验收/QA)补录,--final 前必须清零"
    },
    "mobile.error-copy.REQUEST_TIMEOUT|iphone|en|global": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "PR4a 派工包集中批捕预案:合并门=--preview-slice 无 schema 错误;全格实拍证据由后续验收批次(双 AI 验收/QA)补录,--final 前必须清零"
    },
    "mobile.error-copy.REQUEST_TIMEOUT|iphone|ja|cn": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "PR4a 派工包集中批捕预案:合并门=--preview-slice 无 schema 错误;全格实拍证据由后续验收批次(双 AI 验收/QA)补录,--final 前必须清零"
    },
    "mobile.error-copy.REQUEST_TIMEOUT|iphone|ja|global": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "PR4a 派工包集中批捕预案:合并门=--preview-slice 无 schema 错误;全格实拍证据由后续验收批次(双 AI 验收/QA)补录,--final 前必须清零"
    },
    "mobile.error-copy.REQUEST_TIMEOUT|iphone|ko|cn": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "PR4a 派工包集中批捕预案:合并门=--preview-slice 无 schema 错误;全格实拍证据由后续验收批次(双 AI 验收/QA)补录,--final 前必须清零"
    },
    "mobile.error-copy.REQUEST_TIMEOUT|iphone|ko|global": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "PR4a 派工包集中批捕预案:合并门=--preview-slice 无 schema 错误;全格实拍证据由后续验收批次(双 AI 验收/QA)补录,--final 前必须清零"
    },
    "mobile.error-copy.REQUEST_TIMEOUT|android-phone|zh-CN|cn": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "PR4a 派工包集中批捕预案:合并门=--preview-slice 无 schema 错误;全格实拍证据由后续验收批次(双 AI 验收/QA)补录,--final 前必须清零"
    },
    "mobile.error-copy.REQUEST_TIMEOUT|android-phone|zh-CN|global": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "PR4a 派工包集中批捕预案:合并门=--preview-slice 无 schema 错误;全格实拍证据由后续验收批次(双 AI 验收/QA)补录,--final 前必须清零"
    },
    "mobile.error-copy.REQUEST_TIMEOUT|android-phone|zh-TW|cn": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "PR4a 派工包集中批捕预案:合并门=--preview-slice 无 schema 错误;全格实拍证据由后续验收批次(双 AI 验收/QA)补录,--final 前必须清零"
    },
    "mobile.error-copy.REQUEST_TIMEOUT|android-phone|zh-TW|global": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "PR4a 派工包集中批捕预案:合并门=--preview-slice 无 schema 错误;全格实拍证据由后续验收批次(双 AI 验收/QA)补录,--final 前必须清零"
    },
    "mobile.error-copy.REQUEST_TIMEOUT|android-phone|en|cn": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "PR4a 派工包集中批捕预案:合并门=--preview-slice 无 schema 错误;全格实拍证据由后续验收批次(双 AI 验收/QA)补录,--final 前必须清零"
    },
    "mobile.error-copy.REQUEST_TIMEOUT|android-phone|en|global": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "PR4a 派工包集中批捕预案:合并门=--preview-slice 无 schema 错误;全格实拍证据由后续验收批次(双 AI 验收/QA)补录,--final 前必须清零"
    },
    "mobile.error-copy.REQUEST_TIMEOUT|android-phone|ja|cn": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "PR4a 派工包集中批捕预案:合并门=--preview-slice 无 schema 错误;全格实拍证据由后续验收批次(双 AI 验收/QA)补录,--final 前必须清零"
    },
    "mobile.error-copy.REQUEST_TIMEOUT|android-phone|ja|global": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "PR4a 派工包集中批捕预案:合并门=--preview-slice 无 schema 错误;全格实拍证据由后续验收批次(双 AI 验收/QA)补录,--final 前必须清零"
    },
    "mobile.error-copy.REQUEST_TIMEOUT|android-phone|ko|cn": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "PR4a 派工包集中批捕预案:合并门=--preview-slice 无 schema 错误;全格实拍证据由后续验收批次(双 AI 验收/QA)补录,--final 前必须清零"
    },
    "mobile.error-copy.REQUEST_TIMEOUT|android-phone|ko|global": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "PR4a 派工包集中批捕预案:合并门=--preview-slice 无 schema 错误;全格实拍证据由后续验收批次(双 AI 验收/QA)补录,--final 前必须清零"
    },
    "mobile.error-copy.REQUEST_TIMEOUT|ipad|zh-CN|cn": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "PR4a 派工包集中批捕预案:合并门=--preview-slice 无 schema 错误;全格实拍证据由后续验收批次(双 AI 验收/QA)补录,--final 前必须清零"
    },
    "mobile.error-copy.REQUEST_TIMEOUT|ipad|zh-CN|global": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "PR4a 派工包集中批捕预案:合并门=--preview-slice 无 schema 错误;全格实拍证据由后续验收批次(双 AI 验收/QA)补录,--final 前必须清零"
    },
    "mobile.error-copy.REQUEST_TIMEOUT|ipad|zh-TW|cn": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "PR4a 派工包集中批捕预案:合并门=--preview-slice 无 schema 错误;全格实拍证据由后续验收批次(双 AI 验收/QA)补录,--final 前必须清零"
    },
    "mobile.error-copy.REQUEST_TIMEOUT|ipad|zh-TW|global": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "PR4a 派工包集中批捕预案:合并门=--preview-slice 无 schema 错误;全格实拍证据由后续验收批次(双 AI 验收/QA)补录,--final 前必须清零"
    },
    "mobile.error-copy.REQUEST_TIMEOUT|ipad|en|cn": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "PR4a 派工包集中批捕预案:合并门=--preview-slice 无 schema 错误;全格实拍证据由后续验收批次(双 AI 验收/QA)补录,--final 前必须清零"
    },
    "mobile.error-copy.REQUEST_TIMEOUT|ipad|en|global": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "PR4a 派工包集中批捕预案:合并门=--preview-slice 无 schema 错误;全格实拍证据由后续验收批次(双 AI 验收/QA)补录,--final 前必须清零"
    },
    "mobile.error-copy.REQUEST_TIMEOUT|ipad|ja|cn": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "PR4a 派工包集中批捕预案:合并门=--preview-slice 无 schema 错误;全格实拍证据由后续验收批次(双 AI 验收/QA)补录,--final 前必须清零"
    },
    "mobile.error-copy.REQUEST_TIMEOUT|ipad|ja|global": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "PR4a 派工包集中批捕预案:合并门=--preview-slice 无 schema 错误;全格实拍证据由后续验收批次(双 AI 验收/QA)补录,--final 前必须清零"
    },
    "mobile.error-copy.REQUEST_TIMEOUT|ipad|ko|cn": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "PR4a 派工包集中批捕预案:合并门=--preview-slice 无 schema 错误;全格实拍证据由后续验收批次(双 AI 验收/QA)补录,--final 前必须清零"
    },
    "mobile.error-copy.REQUEST_TIMEOUT|ipad|ko|global": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "PR4a 派工包集中批捕预案:合并门=--preview-slice 无 schema 错误;全格实拍证据由后续验收批次(双 AI 验收/QA)补录,--final 前必须清零"
    },
    "mobile.error-copy.REQUEST_TIMEOUT|android-pad|zh-CN|cn": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "PR4a 派工包集中批捕预案:合并门=--preview-slice 无 schema 错误;全格实拍证据由后续验收批次(双 AI 验收/QA)补录,--final 前必须清零"
    },
    "mobile.error-copy.REQUEST_TIMEOUT|android-pad|zh-CN|global": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "PR4a 派工包集中批捕预案:合并门=--preview-slice 无 schema 错误;全格实拍证据由后续验收批次(双 AI 验收/QA)补录,--final 前必须清零"
    },
    "mobile.error-copy.REQUEST_TIMEOUT|android-pad|zh-TW|cn": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "PR4a 派工包集中批捕预案:合并门=--preview-slice 无 schema 错误;全格实拍证据由后续验收批次(双 AI 验收/QA)补录,--final 前必须清零"
    },
    "mobile.error-copy.REQUEST_TIMEOUT|android-pad|zh-TW|global": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "PR4a 派工包集中批捕预案:合并门=--preview-slice 无 schema 错误;全格实拍证据由后续验收批次(双 AI 验收/QA)补录,--final 前必须清零"
    },
    "mobile.error-copy.REQUEST_TIMEOUT|android-pad|en|cn": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "PR4a 派工包集中批捕预案:合并门=--preview-slice 无 schema 错误;全格实拍证据由后续验收批次(双 AI 验收/QA)补录,--final 前必须清零"
    },
    "mobile.error-copy.REQUEST_TIMEOUT|android-pad|en|global": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "PR4a 派工包集中批捕预案:合并门=--preview-slice 无 schema 错误;全格实拍证据由后续验收批次(双 AI 验收/QA)补录,--final 前必须清零"
    },
    "mobile.error-copy.REQUEST_TIMEOUT|android-pad|ja|cn": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "PR4a 派工包集中批捕预案:合并门=--preview-slice 无 schema 错误;全格实拍证据由后续验收批次(双 AI 验收/QA)补录,--final 前必须清零"
    },
    "mobile.error-copy.REQUEST_TIMEOUT|android-pad|ja|global": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "PR4a 派工包集中批捕预案:合并门=--preview-slice 无 schema 错误;全格实拍证据由后续验收批次(双 AI 验收/QA)补录,--final 前必须清零"
    },
    "mobile.error-copy.REQUEST_TIMEOUT|android-pad|ko|cn": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "PR4a 派工包集中批捕预案:合并门=--preview-slice 无 schema 错误;全格实拍证据由后续验收批次(双 AI 验收/QA)补录,--final 前必须清零"
    },
    "mobile.error-copy.REQUEST_TIMEOUT|android-pad|ko|global": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "PR4a 派工包集中批捕预案:合并门=--preview-slice 无 schema 错误;全格实拍证据由后续验收批次(双 AI 验收/QA)补录,--final 前必须清零"
    },
    "mobile.error-copy.USER_CANCELLED|iphone|zh-CN|cn": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "PR4a 派工包集中批捕预案:合并门=--preview-slice 无 schema 错误;全格实拍证据由后续验收批次(双 AI 验收/QA)补录,--final 前必须清零"
    },
    "mobile.error-copy.USER_CANCELLED|iphone|zh-CN|global": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "PR4a 派工包集中批捕预案:合并门=--preview-slice 无 schema 错误;全格实拍证据由后续验收批次(双 AI 验收/QA)补录,--final 前必须清零"
    },
    "mobile.error-copy.USER_CANCELLED|iphone|zh-TW|cn": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "PR4a 派工包集中批捕预案:合并门=--preview-slice 无 schema 错误;全格实拍证据由后续验收批次(双 AI 验收/QA)补录,--final 前必须清零"
    },
    "mobile.error-copy.USER_CANCELLED|iphone|zh-TW|global": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "PR4a 派工包集中批捕预案:合并门=--preview-slice 无 schema 错误;全格实拍证据由后续验收批次(双 AI 验收/QA)补录,--final 前必须清零"
    },
    "mobile.error-copy.USER_CANCELLED|iphone|en|cn": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "PR4a 派工包集中批捕预案:合并门=--preview-slice 无 schema 错误;全格实拍证据由后续验收批次(双 AI 验收/QA)补录,--final 前必须清零"
    },
    "mobile.error-copy.USER_CANCELLED|iphone|en|global": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "PR4a 派工包集中批捕预案:合并门=--preview-slice 无 schema 错误;全格实拍证据由后续验收批次(双 AI 验收/QA)补录,--final 前必须清零"
    },
    "mobile.error-copy.USER_CANCELLED|iphone|ja|cn": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "PR4a 派工包集中批捕预案:合并门=--preview-slice 无 schema 错误;全格实拍证据由后续验收批次(双 AI 验收/QA)补录,--final 前必须清零"
    },
    "mobile.error-copy.USER_CANCELLED|iphone|ja|global": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "PR4a 派工包集中批捕预案:合并门=--preview-slice 无 schema 错误;全格实拍证据由后续验收批次(双 AI 验收/QA)补录,--final 前必须清零"
    },
    "mobile.error-copy.USER_CANCELLED|iphone|ko|cn": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "PR4a 派工包集中批捕预案:合并门=--preview-slice 无 schema 错误;全格实拍证据由后续验收批次(双 AI 验收/QA)补录,--final 前必须清零"
    },
    "mobile.error-copy.USER_CANCELLED|iphone|ko|global": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "PR4a 派工包集中批捕预案:合并门=--preview-slice 无 schema 错误;全格实拍证据由后续验收批次(双 AI 验收/QA)补录,--final 前必须清零"
    },
    "mobile.error-copy.USER_CANCELLED|android-phone|zh-CN|cn": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "PR4a 派工包集中批捕预案:合并门=--preview-slice 无 schema 错误;全格实拍证据由后续验收批次(双 AI 验收/QA)补录,--final 前必须清零"
    },
    "mobile.error-copy.USER_CANCELLED|android-phone|zh-CN|global": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "PR4a 派工包集中批捕预案:合并门=--preview-slice 无 schema 错误;全格实拍证据由后续验收批次(双 AI 验收/QA)补录,--final 前必须清零"
    },
    "mobile.error-copy.USER_CANCELLED|android-phone|zh-TW|cn": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "PR4a 派工包集中批捕预案:合并门=--preview-slice 无 schema 错误;全格实拍证据由后续验收批次(双 AI 验收/QA)补录,--final 前必须清零"
    },
    "mobile.error-copy.USER_CANCELLED|android-phone|zh-TW|global": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "PR4a 派工包集中批捕预案:合并门=--preview-slice 无 schema 错误;全格实拍证据由后续验收批次(双 AI 验收/QA)补录,--final 前必须清零"
    },
    "mobile.error-copy.USER_CANCELLED|android-phone|en|cn": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "PR4a 派工包集中批捕预案:合并门=--preview-slice 无 schema 错误;全格实拍证据由后续验收批次(双 AI 验收/QA)补录,--final 前必须清零"
    },
    "mobile.error-copy.USER_CANCELLED|android-phone|en|global": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "PR4a 派工包集中批捕预案:合并门=--preview-slice 无 schema 错误;全格实拍证据由后续验收批次(双 AI 验收/QA)补录,--final 前必须清零"
    },
    "mobile.error-copy.USER_CANCELLED|android-phone|ja|cn": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "PR4a 派工包集中批捕预案:合并门=--preview-slice 无 schema 错误;全格实拍证据由后续验收批次(双 AI 验收/QA)补录,--final 前必须清零"
    },
    "mobile.error-copy.USER_CANCELLED|android-phone|ja|global": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "PR4a 派工包集中批捕预案:合并门=--preview-slice 无 schema 错误;全格实拍证据由后续验收批次(双 AI 验收/QA)补录,--final 前必须清零"
    },
    "mobile.error-copy.USER_CANCELLED|android-phone|ko|cn": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "PR4a 派工包集中批捕预案:合并门=--preview-slice 无 schema 错误;全格实拍证据由后续验收批次(双 AI 验收/QA)补录,--final 前必须清零"
    },
    "mobile.error-copy.USER_CANCELLED|android-phone|ko|global": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "PR4a 派工包集中批捕预案:合并门=--preview-slice 无 schema 错误;全格实拍证据由后续验收批次(双 AI 验收/QA)补录,--final 前必须清零"
    },
    "mobile.error-copy.USER_CANCELLED|ipad|zh-CN|cn": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "PR4a 派工包集中批捕预案:合并门=--preview-slice 无 schema 错误;全格实拍证据由后续验收批次(双 AI 验收/QA)补录,--final 前必须清零"
    },
    "mobile.error-copy.USER_CANCELLED|ipad|zh-CN|global": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "PR4a 派工包集中批捕预案:合并门=--preview-slice 无 schema 错误;全格实拍证据由后续验收批次(双 AI 验收/QA)补录,--final 前必须清零"
    },
    "mobile.error-copy.USER_CANCELLED|ipad|zh-TW|cn": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "PR4a 派工包集中批捕预案:合并门=--preview-slice 无 schema 错误;全格实拍证据由后续验收批次(双 AI 验收/QA)补录,--final 前必须清零"
    },
    "mobile.error-copy.USER_CANCELLED|ipad|zh-TW|global": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "PR4a 派工包集中批捕预案:合并门=--preview-slice 无 schema 错误;全格实拍证据由后续验收批次(双 AI 验收/QA)补录,--final 前必须清零"
    },
    "mobile.error-copy.USER_CANCELLED|ipad|en|cn": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "PR4a 派工包集中批捕预案:合并门=--preview-slice 无 schema 错误;全格实拍证据由后续验收批次(双 AI 验收/QA)补录,--final 前必须清零"
    },
    "mobile.error-copy.USER_CANCELLED|ipad|en|global": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "PR4a 派工包集中批捕预案:合并门=--preview-slice 无 schema 错误;全格实拍证据由后续验收批次(双 AI 验收/QA)补录,--final 前必须清零"
    },
    "mobile.error-copy.USER_CANCELLED|ipad|ja|cn": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "PR4a 派工包集中批捕预案:合并门=--preview-slice 无 schema 错误;全格实拍证据由后续验收批次(双 AI 验收/QA)补录,--final 前必须清零"
    },
    "mobile.error-copy.USER_CANCELLED|ipad|ja|global": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "PR4a 派工包集中批捕预案:合并门=--preview-slice 无 schema 错误;全格实拍证据由后续验收批次(双 AI 验收/QA)补录,--final 前必须清零"
    },
    "mobile.error-copy.USER_CANCELLED|ipad|ko|cn": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "PR4a 派工包集中批捕预案:合并门=--preview-slice 无 schema 错误;全格实拍证据由后续验收批次(双 AI 验收/QA)补录,--final 前必须清零"
    },
    "mobile.error-copy.USER_CANCELLED|ipad|ko|global": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "PR4a 派工包集中批捕预案:合并门=--preview-slice 无 schema 错误;全格实拍证据由后续验收批次(双 AI 验收/QA)补录,--final 前必须清零"
    },
    "mobile.error-copy.USER_CANCELLED|android-pad|zh-CN|cn": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "PR4a 派工包集中批捕预案:合并门=--preview-slice 无 schema 错误;全格实拍证据由后续验收批次(双 AI 验收/QA)补录,--final 前必须清零"
    },
    "mobile.error-copy.USER_CANCELLED|android-pad|zh-CN|global": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "PR4a 派工包集中批捕预案:合并门=--preview-slice 无 schema 错误;全格实拍证据由后续验收批次(双 AI 验收/QA)补录,--final 前必须清零"
    },
    "mobile.error-copy.USER_CANCELLED|android-pad|zh-TW|cn": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "PR4a 派工包集中批捕预案:合并门=--preview-slice 无 schema 错误;全格实拍证据由后续验收批次(双 AI 验收/QA)补录,--final 前必须清零"
    },
    "mobile.error-copy.USER_CANCELLED|android-pad|zh-TW|global": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "PR4a 派工包集中批捕预案:合并门=--preview-slice 无 schema 错误;全格实拍证据由后续验收批次(双 AI 验收/QA)补录,--final 前必须清零"
    },
    "mobile.error-copy.USER_CANCELLED|android-pad|en|cn": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "PR4a 派工包集中批捕预案:合并门=--preview-slice 无 schema 错误;全格实拍证据由后续验收批次(双 AI 验收/QA)补录,--final 前必须清零"
    },
    "mobile.error-copy.USER_CANCELLED|android-pad|en|global": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "PR4a 派工包集中批捕预案:合并门=--preview-slice 无 schema 错误;全格实拍证据由后续验收批次(双 AI 验收/QA)补录,--final 前必须清零"
    },
    "mobile.error-copy.USER_CANCELLED|android-pad|ja|cn": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "PR4a 派工包集中批捕预案:合并门=--preview-slice 无 schema 错误;全格实拍证据由后续验收批次(双 AI 验收/QA)补录,--final 前必须清零"
    },
    "mobile.error-copy.USER_CANCELLED|android-pad|ja|global": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "PR4a 派工包集中批捕预案:合并门=--preview-slice 无 schema 错误;全格实拍证据由后续验收批次(双 AI 验收/QA)补录,--final 前必须清零"
    },
    "mobile.error-copy.USER_CANCELLED|android-pad|ko|cn": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "PR4a 派工包集中批捕预案:合并门=--preview-slice 无 schema 错误;全格实拍证据由后续验收批次(双 AI 验收/QA)补录,--final 前必须清零"
    },
    "mobile.error-copy.USER_CANCELLED|android-pad|ko|global": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "PR4a 派工包集中批捕预案:合并门=--preview-slice 无 schema 错误;全格实拍证据由后续验收批次(双 AI 验收/QA)补录,--final 前必须清零"
    },
    "mobile.error-copy.SOCIAL_PROVIDER_NOT_CONFIGURED|iphone|zh-CN|cn": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "PR4a 派工包集中批捕预案:合并门=--preview-slice 无 schema 错误;全格实拍证据由后续验收批次(双 AI 验收/QA)补录,--final 前必须清零"
    },
    "mobile.error-copy.SOCIAL_PROVIDER_NOT_CONFIGURED|iphone|zh-CN|global": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "PR4a 派工包集中批捕预案:合并门=--preview-slice 无 schema 错误;全格实拍证据由后续验收批次(双 AI 验收/QA)补录,--final 前必须清零"
    },
    "mobile.error-copy.SOCIAL_PROVIDER_NOT_CONFIGURED|iphone|zh-TW|cn": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "PR4a 派工包集中批捕预案:合并门=--preview-slice 无 schema 错误;全格实拍证据由后续验收批次(双 AI 验收/QA)补录,--final 前必须清零"
    },
    "mobile.error-copy.SOCIAL_PROVIDER_NOT_CONFIGURED|iphone|zh-TW|global": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "PR4a 派工包集中批捕预案:合并门=--preview-slice 无 schema 错误;全格实拍证据由后续验收批次(双 AI 验收/QA)补录,--final 前必须清零"
    },
    "mobile.error-copy.SOCIAL_PROVIDER_NOT_CONFIGURED|iphone|en|cn": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "PR4a 派工包集中批捕预案:合并门=--preview-slice 无 schema 错误;全格实拍证据由后续验收批次(双 AI 验收/QA)补录,--final 前必须清零"
    },
    "mobile.error-copy.SOCIAL_PROVIDER_NOT_CONFIGURED|iphone|en|global": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "PR4a 派工包集中批捕预案:合并门=--preview-slice 无 schema 错误;全格实拍证据由后续验收批次(双 AI 验收/QA)补录,--final 前必须清零"
    },
    "mobile.error-copy.SOCIAL_PROVIDER_NOT_CONFIGURED|iphone|ja|cn": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "PR4a 派工包集中批捕预案:合并门=--preview-slice 无 schema 错误;全格实拍证据由后续验收批次(双 AI 验收/QA)补录,--final 前必须清零"
    },
    "mobile.error-copy.SOCIAL_PROVIDER_NOT_CONFIGURED|iphone|ja|global": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "PR4a 派工包集中批捕预案:合并门=--preview-slice 无 schema 错误;全格实拍证据由后续验收批次(双 AI 验收/QA)补录,--final 前必须清零"
    },
    "mobile.error-copy.SOCIAL_PROVIDER_NOT_CONFIGURED|iphone|ko|cn": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "PR4a 派工包集中批捕预案:合并门=--preview-slice 无 schema 错误;全格实拍证据由后续验收批次(双 AI 验收/QA)补录,--final 前必须清零"
    },
    "mobile.error-copy.SOCIAL_PROVIDER_NOT_CONFIGURED|iphone|ko|global": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "PR4a 派工包集中批捕预案:合并门=--preview-slice 无 schema 错误;全格实拍证据由后续验收批次(双 AI 验收/QA)补录,--final 前必须清零"
    },
    "mobile.error-copy.SOCIAL_PROVIDER_NOT_CONFIGURED|android-phone|zh-CN|cn": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "PR4a 派工包集中批捕预案:合并门=--preview-slice 无 schema 错误;全格实拍证据由后续验收批次(双 AI 验收/QA)补录,--final 前必须清零"
    },
    "mobile.error-copy.SOCIAL_PROVIDER_NOT_CONFIGURED|android-phone|zh-CN|global": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "PR4a 派工包集中批捕预案:合并门=--preview-slice 无 schema 错误;全格实拍证据由后续验收批次(双 AI 验收/QA)补录,--final 前必须清零"
    },
    "mobile.error-copy.SOCIAL_PROVIDER_NOT_CONFIGURED|android-phone|zh-TW|cn": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "PR4a 派工包集中批捕预案:合并门=--preview-slice 无 schema 错误;全格实拍证据由后续验收批次(双 AI 验收/QA)补录,--final 前必须清零"
    },
    "mobile.error-copy.SOCIAL_PROVIDER_NOT_CONFIGURED|android-phone|zh-TW|global": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "PR4a 派工包集中批捕预案:合并门=--preview-slice 无 schema 错误;全格实拍证据由后续验收批次(双 AI 验收/QA)补录,--final 前必须清零"
    },
    "mobile.error-copy.SOCIAL_PROVIDER_NOT_CONFIGURED|android-phone|en|cn": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "PR4a 派工包集中批捕预案:合并门=--preview-slice 无 schema 错误;全格实拍证据由后续验收批次(双 AI 验收/QA)补录,--final 前必须清零"
    },
    "mobile.error-copy.SOCIAL_PROVIDER_NOT_CONFIGURED|android-phone|en|global": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "PR4a 派工包集中批捕预案:合并门=--preview-slice 无 schema 错误;全格实拍证据由后续验收批次(双 AI 验收/QA)补录,--final 前必须清零"
    },
    "mobile.error-copy.SOCIAL_PROVIDER_NOT_CONFIGURED|android-phone|ja|cn": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "PR4a 派工包集中批捕预案:合并门=--preview-slice 无 schema 错误;全格实拍证据由后续验收批次(双 AI 验收/QA)补录,--final 前必须清零"
    },
    "mobile.error-copy.SOCIAL_PROVIDER_NOT_CONFIGURED|android-phone|ja|global": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "PR4a 派工包集中批捕预案:合并门=--preview-slice 无 schema 错误;全格实拍证据由后续验收批次(双 AI 验收/QA)补录,--final 前必须清零"
    },
    "mobile.error-copy.SOCIAL_PROVIDER_NOT_CONFIGURED|android-phone|ko|cn": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "PR4a 派工包集中批捕预案:合并门=--preview-slice 无 schema 错误;全格实拍证据由后续验收批次(双 AI 验收/QA)补录,--final 前必须清零"
    },
    "mobile.error-copy.SOCIAL_PROVIDER_NOT_CONFIGURED|android-phone|ko|global": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "PR4a 派工包集中批捕预案:合并门=--preview-slice 无 schema 错误;全格实拍证据由后续验收批次(双 AI 验收/QA)补录,--final 前必须清零"
    },
    "mobile.error-copy.SOCIAL_PROVIDER_NOT_CONFIGURED|ipad|zh-CN|cn": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "PR4a 派工包集中批捕预案:合并门=--preview-slice 无 schema 错误;全格实拍证据由后续验收批次(双 AI 验收/QA)补录,--final 前必须清零"
    },
    "mobile.error-copy.SOCIAL_PROVIDER_NOT_CONFIGURED|ipad|zh-CN|global": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "PR4a 派工包集中批捕预案:合并门=--preview-slice 无 schema 错误;全格实拍证据由后续验收批次(双 AI 验收/QA)补录,--final 前必须清零"
    },
    "mobile.error-copy.SOCIAL_PROVIDER_NOT_CONFIGURED|ipad|zh-TW|cn": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "PR4a 派工包集中批捕预案:合并门=--preview-slice 无 schema 错误;全格实拍证据由后续验收批次(双 AI 验收/QA)补录,--final 前必须清零"
    },
    "mobile.error-copy.SOCIAL_PROVIDER_NOT_CONFIGURED|ipad|zh-TW|global": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "PR4a 派工包集中批捕预案:合并门=--preview-slice 无 schema 错误;全格实拍证据由后续验收批次(双 AI 验收/QA)补录,--final 前必须清零"
    },
    "mobile.error-copy.SOCIAL_PROVIDER_NOT_CONFIGURED|ipad|en|cn": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "PR4a 派工包集中批捕预案:合并门=--preview-slice 无 schema 错误;全格实拍证据由后续验收批次(双 AI 验收/QA)补录,--final 前必须清零"
    },
    "mobile.error-copy.SOCIAL_PROVIDER_NOT_CONFIGURED|ipad|en|global": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "PR4a 派工包集中批捕预案:合并门=--preview-slice 无 schema 错误;全格实拍证据由后续验收批次(双 AI 验收/QA)补录,--final 前必须清零"
    },
    "mobile.error-copy.SOCIAL_PROVIDER_NOT_CONFIGURED|ipad|ja|cn": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "PR4a 派工包集中批捕预案:合并门=--preview-slice 无 schema 错误;全格实拍证据由后续验收批次(双 AI 验收/QA)补录,--final 前必须清零"
    },
    "mobile.error-copy.SOCIAL_PROVIDER_NOT_CONFIGURED|ipad|ja|global": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "PR4a 派工包集中批捕预案:合并门=--preview-slice 无 schema 错误;全格实拍证据由后续验收批次(双 AI 验收/QA)补录,--final 前必须清零"
    },
    "mobile.error-copy.SOCIAL_PROVIDER_NOT_CONFIGURED|ipad|ko|cn": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "PR4a 派工包集中批捕预案:合并门=--preview-slice 无 schema 错误;全格实拍证据由后续验收批次(双 AI 验收/QA)补录,--final 前必须清零"
    },
    "mobile.error-copy.SOCIAL_PROVIDER_NOT_CONFIGURED|ipad|ko|global": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "PR4a 派工包集中批捕预案:合并门=--preview-slice 无 schema 错误;全格实拍证据由后续验收批次(双 AI 验收/QA)补录,--final 前必须清零"
    },
    "mobile.error-copy.SOCIAL_PROVIDER_NOT_CONFIGURED|android-pad|zh-CN|cn": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "PR4a 派工包集中批捕预案:合并门=--preview-slice 无 schema 错误;全格实拍证据由后续验收批次(双 AI 验收/QA)补录,--final 前必须清零"
    },
    "mobile.error-copy.SOCIAL_PROVIDER_NOT_CONFIGURED|android-pad|zh-CN|global": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "PR4a 派工包集中批捕预案:合并门=--preview-slice 无 schema 错误;全格实拍证据由后续验收批次(双 AI 验收/QA)补录,--final 前必须清零"
    },
    "mobile.error-copy.SOCIAL_PROVIDER_NOT_CONFIGURED|android-pad|zh-TW|cn": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "PR4a 派工包集中批捕预案:合并门=--preview-slice 无 schema 错误;全格实拍证据由后续验收批次(双 AI 验收/QA)补录,--final 前必须清零"
    },
    "mobile.error-copy.SOCIAL_PROVIDER_NOT_CONFIGURED|android-pad|zh-TW|global": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "PR4a 派工包集中批捕预案:合并门=--preview-slice 无 schema 错误;全格实拍证据由后续验收批次(双 AI 验收/QA)补录,--final 前必须清零"
    },
    "mobile.error-copy.SOCIAL_PROVIDER_NOT_CONFIGURED|android-pad|en|cn": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "PR4a 派工包集中批捕预案:合并门=--preview-slice 无 schema 错误;全格实拍证据由后续验收批次(双 AI 验收/QA)补录,--final 前必须清零"
    },
    "mobile.error-copy.SOCIAL_PROVIDER_NOT_CONFIGURED|android-pad|en|global": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "PR4a 派工包集中批捕预案:合并门=--preview-slice 无 schema 错误;全格实拍证据由后续验收批次(双 AI 验收/QA)补录,--final 前必须清零"
    },
    "mobile.error-copy.SOCIAL_PROVIDER_NOT_CONFIGURED|android-pad|ja|cn": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "PR4a 派工包集中批捕预案:合并门=--preview-slice 无 schema 错误;全格实拍证据由后续验收批次(双 AI 验收/QA)补录,--final 前必须清零"
    },
    "mobile.error-copy.SOCIAL_PROVIDER_NOT_CONFIGURED|android-pad|ja|global": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "PR4a 派工包集中批捕预案:合并门=--preview-slice 无 schema 错误;全格实拍证据由后续验收批次(双 AI 验收/QA)补录,--final 前必须清零"
    },
    "mobile.error-copy.SOCIAL_PROVIDER_NOT_CONFIGURED|android-pad|ko|cn": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "PR4a 派工包集中批捕预案:合并门=--preview-slice 无 schema 错误;全格实拍证据由后续验收批次(双 AI 验收/QA)补录,--final 前必须清零"
    },
    "mobile.error-copy.SOCIAL_PROVIDER_NOT_CONFIGURED|android-pad|ko|global": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "PR4a 派工包集中批捕预案:合并门=--preview-slice 无 schema 错误;全格实拍证据由后续验收批次(双 AI 验收/QA)补录,--final 前必须清零"
    },
    "mobile.error-copy.SOCIAL_PROVIDER_UNAVAILABLE|iphone|zh-CN|cn": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "PR4a 派工包集中批捕预案:合并门=--preview-slice 无 schema 错误;全格实拍证据由后续验收批次(双 AI 验收/QA)补录,--final 前必须清零"
    },
    "mobile.error-copy.SOCIAL_PROVIDER_UNAVAILABLE|iphone|zh-CN|global": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "PR4a 派工包集中批捕预案:合并门=--preview-slice 无 schema 错误;全格实拍证据由后续验收批次(双 AI 验收/QA)补录,--final 前必须清零"
    },
    "mobile.error-copy.SOCIAL_PROVIDER_UNAVAILABLE|iphone|zh-TW|cn": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "PR4a 派工包集中批捕预案:合并门=--preview-slice 无 schema 错误;全格实拍证据由后续验收批次(双 AI 验收/QA)补录,--final 前必须清零"
    },
    "mobile.error-copy.SOCIAL_PROVIDER_UNAVAILABLE|iphone|zh-TW|global": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "PR4a 派工包集中批捕预案:合并门=--preview-slice 无 schema 错误;全格实拍证据由后续验收批次(双 AI 验收/QA)补录,--final 前必须清零"
    },
    "mobile.error-copy.SOCIAL_PROVIDER_UNAVAILABLE|iphone|en|cn": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "PR4a 派工包集中批捕预案:合并门=--preview-slice 无 schema 错误;全格实拍证据由后续验收批次(双 AI 验收/QA)补录,--final 前必须清零"
    },
    "mobile.error-copy.SOCIAL_PROVIDER_UNAVAILABLE|iphone|en|global": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "PR4a 派工包集中批捕预案:合并门=--preview-slice 无 schema 错误;全格实拍证据由后续验收批次(双 AI 验收/QA)补录,--final 前必须清零"
    },
    "mobile.error-copy.SOCIAL_PROVIDER_UNAVAILABLE|iphone|ja|cn": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "PR4a 派工包集中批捕预案:合并门=--preview-slice 无 schema 错误;全格实拍证据由后续验收批次(双 AI 验收/QA)补录,--final 前必须清零"
    },
    "mobile.error-copy.SOCIAL_PROVIDER_UNAVAILABLE|iphone|ja|global": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "PR4a 派工包集中批捕预案:合并门=--preview-slice 无 schema 错误;全格实拍证据由后续验收批次(双 AI 验收/QA)补录,--final 前必须清零"
    },
    "mobile.error-copy.SOCIAL_PROVIDER_UNAVAILABLE|iphone|ko|cn": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "PR4a 派工包集中批捕预案:合并门=--preview-slice 无 schema 错误;全格实拍证据由后续验收批次(双 AI 验收/QA)补录,--final 前必须清零"
    },
    "mobile.error-copy.SOCIAL_PROVIDER_UNAVAILABLE|iphone|ko|global": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "PR4a 派工包集中批捕预案:合并门=--preview-slice 无 schema 错误;全格实拍证据由后续验收批次(双 AI 验收/QA)补录,--final 前必须清零"
    },
    "mobile.error-copy.SOCIAL_PROVIDER_UNAVAILABLE|android-phone|zh-CN|cn": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "PR4a 派工包集中批捕预案:合并门=--preview-slice 无 schema 错误;全格实拍证据由后续验收批次(双 AI 验收/QA)补录,--final 前必须清零"
    },
    "mobile.error-copy.SOCIAL_PROVIDER_UNAVAILABLE|android-phone|zh-CN|global": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "PR4a 派工包集中批捕预案:合并门=--preview-slice 无 schema 错误;全格实拍证据由后续验收批次(双 AI 验收/QA)补录,--final 前必须清零"
    },
    "mobile.error-copy.SOCIAL_PROVIDER_UNAVAILABLE|android-phone|zh-TW|cn": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "PR4a 派工包集中批捕预案:合并门=--preview-slice 无 schema 错误;全格实拍证据由后续验收批次(双 AI 验收/QA)补录,--final 前必须清零"
    },
    "mobile.error-copy.SOCIAL_PROVIDER_UNAVAILABLE|android-phone|zh-TW|global": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "PR4a 派工包集中批捕预案:合并门=--preview-slice 无 schema 错误;全格实拍证据由后续验收批次(双 AI 验收/QA)补录,--final 前必须清零"
    },
    "mobile.error-copy.SOCIAL_PROVIDER_UNAVAILABLE|android-phone|en|cn": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "PR4a 派工包集中批捕预案:合并门=--preview-slice 无 schema 错误;全格实拍证据由后续验收批次(双 AI 验收/QA)补录,--final 前必须清零"
    },
    "mobile.error-copy.SOCIAL_PROVIDER_UNAVAILABLE|android-phone|en|global": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "PR4a 派工包集中批捕预案:合并门=--preview-slice 无 schema 错误;全格实拍证据由后续验收批次(双 AI 验收/QA)补录,--final 前必须清零"
    },
    "mobile.error-copy.SOCIAL_PROVIDER_UNAVAILABLE|android-phone|ja|cn": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "PR4a 派工包集中批捕预案:合并门=--preview-slice 无 schema 错误;全格实拍证据由后续验收批次(双 AI 验收/QA)补录,--final 前必须清零"
    },
    "mobile.error-copy.SOCIAL_PROVIDER_UNAVAILABLE|android-phone|ja|global": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "PR4a 派工包集中批捕预案:合并门=--preview-slice 无 schema 错误;全格实拍证据由后续验收批次(双 AI 验收/QA)补录,--final 前必须清零"
    },
    "mobile.error-copy.SOCIAL_PROVIDER_UNAVAILABLE|android-phone|ko|cn": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "PR4a 派工包集中批捕预案:合并门=--preview-slice 无 schema 错误;全格实拍证据由后续验收批次(双 AI 验收/QA)补录,--final 前必须清零"
    },
    "mobile.error-copy.SOCIAL_PROVIDER_UNAVAILABLE|android-phone|ko|global": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "PR4a 派工包集中批捕预案:合并门=--preview-slice 无 schema 错误;全格实拍证据由后续验收批次(双 AI 验收/QA)补录,--final 前必须清零"
    },
    "mobile.error-copy.SOCIAL_PROVIDER_UNAVAILABLE|ipad|zh-CN|cn": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "PR4a 派工包集中批捕预案:合并门=--preview-slice 无 schema 错误;全格实拍证据由后续验收批次(双 AI 验收/QA)补录,--final 前必须清零"
    },
    "mobile.error-copy.SOCIAL_PROVIDER_UNAVAILABLE|ipad|zh-CN|global": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "PR4a 派工包集中批捕预案:合并门=--preview-slice 无 schema 错误;全格实拍证据由后续验收批次(双 AI 验收/QA)补录,--final 前必须清零"
    },
    "mobile.error-copy.SOCIAL_PROVIDER_UNAVAILABLE|ipad|zh-TW|cn": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "PR4a 派工包集中批捕预案:合并门=--preview-slice 无 schema 错误;全格实拍证据由后续验收批次(双 AI 验收/QA)补录,--final 前必须清零"
    },
    "mobile.error-copy.SOCIAL_PROVIDER_UNAVAILABLE|ipad|zh-TW|global": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "PR4a 派工包集中批捕预案:合并门=--preview-slice 无 schema 错误;全格实拍证据由后续验收批次(双 AI 验收/QA)补录,--final 前必须清零"
    },
    "mobile.error-copy.SOCIAL_PROVIDER_UNAVAILABLE|ipad|en|cn": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "PR4a 派工包集中批捕预案:合并门=--preview-slice 无 schema 错误;全格实拍证据由后续验收批次(双 AI 验收/QA)补录,--final 前必须清零"
    },
    "mobile.error-copy.SOCIAL_PROVIDER_UNAVAILABLE|ipad|en|global": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "PR4a 派工包集中批捕预案:合并门=--preview-slice 无 schema 错误;全格实拍证据由后续验收批次(双 AI 验收/QA)补录,--final 前必须清零"
    },
    "mobile.error-copy.SOCIAL_PROVIDER_UNAVAILABLE|ipad|ja|cn": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "PR4a 派工包集中批捕预案:合并门=--preview-slice 无 schema 错误;全格实拍证据由后续验收批次(双 AI 验收/QA)补录,--final 前必须清零"
    },
    "mobile.error-copy.SOCIAL_PROVIDER_UNAVAILABLE|ipad|ja|global": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "PR4a 派工包集中批捕预案:合并门=--preview-slice 无 schema 错误;全格实拍证据由后续验收批次(双 AI 验收/QA)补录,--final 前必须清零"
    },
    "mobile.error-copy.SOCIAL_PROVIDER_UNAVAILABLE|ipad|ko|cn": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "PR4a 派工包集中批捕预案:合并门=--preview-slice 无 schema 错误;全格实拍证据由后续验收批次(双 AI 验收/QA)补录,--final 前必须清零"
    },
    "mobile.error-copy.SOCIAL_PROVIDER_UNAVAILABLE|ipad|ko|global": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "PR4a 派工包集中批捕预案:合并门=--preview-slice 无 schema 错误;全格实拍证据由后续验收批次(双 AI 验收/QA)补录,--final 前必须清零"
    },
    "mobile.error-copy.SOCIAL_PROVIDER_UNAVAILABLE|android-pad|zh-CN|cn": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "PR4a 派工包集中批捕预案:合并门=--preview-slice 无 schema 错误;全格实拍证据由后续验收批次(双 AI 验收/QA)补录,--final 前必须清零"
    },
    "mobile.error-copy.SOCIAL_PROVIDER_UNAVAILABLE|android-pad|zh-CN|global": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "PR4a 派工包集中批捕预案:合并门=--preview-slice 无 schema 错误;全格实拍证据由后续验收批次(双 AI 验收/QA)补录,--final 前必须清零"
    },
    "mobile.error-copy.SOCIAL_PROVIDER_UNAVAILABLE|android-pad|zh-TW|cn": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "PR4a 派工包集中批捕预案:合并门=--preview-slice 无 schema 错误;全格实拍证据由后续验收批次(双 AI 验收/QA)补录,--final 前必须清零"
    },
    "mobile.error-copy.SOCIAL_PROVIDER_UNAVAILABLE|android-pad|zh-TW|global": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "PR4a 派工包集中批捕预案:合并门=--preview-slice 无 schema 错误;全格实拍证据由后续验收批次(双 AI 验收/QA)补录,--final 前必须清零"
    },
    "mobile.error-copy.SOCIAL_PROVIDER_UNAVAILABLE|android-pad|en|cn": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "PR4a 派工包集中批捕预案:合并门=--preview-slice 无 schema 错误;全格实拍证据由后续验收批次(双 AI 验收/QA)补录,--final 前必须清零"
    },
    "mobile.error-copy.SOCIAL_PROVIDER_UNAVAILABLE|android-pad|en|global": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "PR4a 派工包集中批捕预案:合并门=--preview-slice 无 schema 错误;全格实拍证据由后续验收批次(双 AI 验收/QA)补录,--final 前必须清零"
    },
    "mobile.error-copy.SOCIAL_PROVIDER_UNAVAILABLE|android-pad|ja|cn": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "PR4a 派工包集中批捕预案:合并门=--preview-slice 无 schema 错误;全格实拍证据由后续验收批次(双 AI 验收/QA)补录,--final 前必须清零"
    },
    "mobile.error-copy.SOCIAL_PROVIDER_UNAVAILABLE|android-pad|ja|global": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "PR4a 派工包集中批捕预案:合并门=--preview-slice 无 schema 错误;全格实拍证据由后续验收批次(双 AI 验收/QA)补录,--final 前必须清零"
    },
    "mobile.error-copy.SOCIAL_PROVIDER_UNAVAILABLE|android-pad|ko|cn": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "PR4a 派工包集中批捕预案:合并门=--preview-slice 无 schema 错误;全格实拍证据由后续验收批次(双 AI 验收/QA)补录,--final 前必须清零"
    },
    "mobile.error-copy.SOCIAL_PROVIDER_UNAVAILABLE|android-pad|ko|global": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "PR4a 派工包集中批捕预案:合并门=--preview-slice 无 schema 错误;全格实拍证据由后续验收批次(双 AI 验收/QA)补录,--final 前必须清零"
    },
    "mobile.error-copy.AUTH_REQUEST_FAILED|iphone|zh-CN|cn": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "PR4a 派工包集中批捕预案:合并门=--preview-slice 无 schema 错误;全格实拍证据由后续验收批次(双 AI 验收/QA)补录,--final 前必须清零"
    },
    "mobile.error-copy.AUTH_REQUEST_FAILED|iphone|zh-CN|global": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "PR4a 派工包集中批捕预案:合并门=--preview-slice 无 schema 错误;全格实拍证据由后续验收批次(双 AI 验收/QA)补录,--final 前必须清零"
    },
    "mobile.error-copy.AUTH_REQUEST_FAILED|iphone|zh-TW|cn": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "PR4a 派工包集中批捕预案:合并门=--preview-slice 无 schema 错误;全格实拍证据由后续验收批次(双 AI 验收/QA)补录,--final 前必须清零"
    },
    "mobile.error-copy.AUTH_REQUEST_FAILED|iphone|zh-TW|global": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "PR4a 派工包集中批捕预案:合并门=--preview-slice 无 schema 错误;全格实拍证据由后续验收批次(双 AI 验收/QA)补录,--final 前必须清零"
    },
    "mobile.error-copy.AUTH_REQUEST_FAILED|iphone|en|cn": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "PR4a 派工包集中批捕预案:合并门=--preview-slice 无 schema 错误;全格实拍证据由后续验收批次(双 AI 验收/QA)补录,--final 前必须清零"
    },
    "mobile.error-copy.AUTH_REQUEST_FAILED|iphone|en|global": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "PR4a 派工包集中批捕预案:合并门=--preview-slice 无 schema 错误;全格实拍证据由后续验收批次(双 AI 验收/QA)补录,--final 前必须清零"
    },
    "mobile.error-copy.AUTH_REQUEST_FAILED|iphone|ja|cn": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "PR4a 派工包集中批捕预案:合并门=--preview-slice 无 schema 错误;全格实拍证据由后续验收批次(双 AI 验收/QA)补录,--final 前必须清零"
    },
    "mobile.error-copy.AUTH_REQUEST_FAILED|iphone|ja|global": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "PR4a 派工包集中批捕预案:合并门=--preview-slice 无 schema 错误;全格实拍证据由后续验收批次(双 AI 验收/QA)补录,--final 前必须清零"
    },
    "mobile.error-copy.AUTH_REQUEST_FAILED|iphone|ko|cn": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "PR4a 派工包集中批捕预案:合并门=--preview-slice 无 schema 错误;全格实拍证据由后续验收批次(双 AI 验收/QA)补录,--final 前必须清零"
    },
    "mobile.error-copy.AUTH_REQUEST_FAILED|iphone|ko|global": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "PR4a 派工包集中批捕预案:合并门=--preview-slice 无 schema 错误;全格实拍证据由后续验收批次(双 AI 验收/QA)补录,--final 前必须清零"
    },
    "mobile.error-copy.AUTH_REQUEST_FAILED|android-phone|zh-CN|cn": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "PR4a 派工包集中批捕预案:合并门=--preview-slice 无 schema 错误;全格实拍证据由后续验收批次(双 AI 验收/QA)补录,--final 前必须清零"
    },
    "mobile.error-copy.AUTH_REQUEST_FAILED|android-phone|zh-CN|global": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "PR4a 派工包集中批捕预案:合并门=--preview-slice 无 schema 错误;全格实拍证据由后续验收批次(双 AI 验收/QA)补录,--final 前必须清零"
    },
    "mobile.error-copy.AUTH_REQUEST_FAILED|android-phone|zh-TW|cn": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "PR4a 派工包集中批捕预案:合并门=--preview-slice 无 schema 错误;全格实拍证据由后续验收批次(双 AI 验收/QA)补录,--final 前必须清零"
    },
    "mobile.error-copy.AUTH_REQUEST_FAILED|android-phone|zh-TW|global": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "PR4a 派工包集中批捕预案:合并门=--preview-slice 无 schema 错误;全格实拍证据由后续验收批次(双 AI 验收/QA)补录,--final 前必须清零"
    },
    "mobile.error-copy.AUTH_REQUEST_FAILED|android-phone|en|cn": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "PR4a 派工包集中批捕预案:合并门=--preview-slice 无 schema 错误;全格实拍证据由后续验收批次(双 AI 验收/QA)补录,--final 前必须清零"
    },
    "mobile.error-copy.AUTH_REQUEST_FAILED|android-phone|en|global": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "PR4a 派工包集中批捕预案:合并门=--preview-slice 无 schema 错误;全格实拍证据由后续验收批次(双 AI 验收/QA)补录,--final 前必须清零"
    },
    "mobile.error-copy.AUTH_REQUEST_FAILED|android-phone|ja|cn": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "PR4a 派工包集中批捕预案:合并门=--preview-slice 无 schema 错误;全格实拍证据由后续验收批次(双 AI 验收/QA)补录,--final 前必须清零"
    },
    "mobile.error-copy.AUTH_REQUEST_FAILED|android-phone|ja|global": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "PR4a 派工包集中批捕预案:合并门=--preview-slice 无 schema 错误;全格实拍证据由后续验收批次(双 AI 验收/QA)补录,--final 前必须清零"
    },
    "mobile.error-copy.AUTH_REQUEST_FAILED|android-phone|ko|cn": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "PR4a 派工包集中批捕预案:合并门=--preview-slice 无 schema 错误;全格实拍证据由后续验收批次(双 AI 验收/QA)补录,--final 前必须清零"
    },
    "mobile.error-copy.AUTH_REQUEST_FAILED|android-phone|ko|global": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "PR4a 派工包集中批捕预案:合并门=--preview-slice 无 schema 错误;全格实拍证据由后续验收批次(双 AI 验收/QA)补录,--final 前必须清零"
    },
    "mobile.error-copy.AUTH_REQUEST_FAILED|ipad|zh-CN|cn": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "PR4a 派工包集中批捕预案:合并门=--preview-slice 无 schema 错误;全格实拍证据由后续验收批次(双 AI 验收/QA)补录,--final 前必须清零"
    },
    "mobile.error-copy.AUTH_REQUEST_FAILED|ipad|zh-CN|global": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "PR4a 派工包集中批捕预案:合并门=--preview-slice 无 schema 错误;全格实拍证据由后续验收批次(双 AI 验收/QA)补录,--final 前必须清零"
    },
    "mobile.error-copy.AUTH_REQUEST_FAILED|ipad|zh-TW|cn": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "PR4a 派工包集中批捕预案:合并门=--preview-slice 无 schema 错误;全格实拍证据由后续验收批次(双 AI 验收/QA)补录,--final 前必须清零"
    },
    "mobile.error-copy.AUTH_REQUEST_FAILED|ipad|zh-TW|global": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "PR4a 派工包集中批捕预案:合并门=--preview-slice 无 schema 错误;全格实拍证据由后续验收批次(双 AI 验收/QA)补录,--final 前必须清零"
    },
    "mobile.error-copy.AUTH_REQUEST_FAILED|ipad|en|cn": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "PR4a 派工包集中批捕预案:合并门=--preview-slice 无 schema 错误;全格实拍证据由后续验收批次(双 AI 验收/QA)补录,--final 前必须清零"
    },
    "mobile.error-copy.AUTH_REQUEST_FAILED|ipad|en|global": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "PR4a 派工包集中批捕预案:合并门=--preview-slice 无 schema 错误;全格实拍证据由后续验收批次(双 AI 验收/QA)补录,--final 前必须清零"
    },
    "mobile.error-copy.AUTH_REQUEST_FAILED|ipad|ja|cn": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "PR4a 派工包集中批捕预案:合并门=--preview-slice 无 schema 错误;全格实拍证据由后续验收批次(双 AI 验收/QA)补录,--final 前必须清零"
    },
    "mobile.error-copy.AUTH_REQUEST_FAILED|ipad|ja|global": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "PR4a 派工包集中批捕预案:合并门=--preview-slice 无 schema 错误;全格实拍证据由后续验收批次(双 AI 验收/QA)补录,--final 前必须清零"
    },
    "mobile.error-copy.AUTH_REQUEST_FAILED|ipad|ko|cn": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "PR4a 派工包集中批捕预案:合并门=--preview-slice 无 schema 错误;全格实拍证据由后续验收批次(双 AI 验收/QA)补录,--final 前必须清零"
    },
    "mobile.error-copy.AUTH_REQUEST_FAILED|ipad|ko|global": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "PR4a 派工包集中批捕预案:合并门=--preview-slice 无 schema 错误;全格实拍证据由后续验收批次(双 AI 验收/QA)补录,--final 前必须清零"
    },
    "mobile.error-copy.AUTH_REQUEST_FAILED|android-pad|zh-CN|cn": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "PR4a 派工包集中批捕预案:合并门=--preview-slice 无 schema 错误;全格实拍证据由后续验收批次(双 AI 验收/QA)补录,--final 前必须清零"
    },
    "mobile.error-copy.AUTH_REQUEST_FAILED|android-pad|zh-CN|global": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "PR4a 派工包集中批捕预案:合并门=--preview-slice 无 schema 错误;全格实拍证据由后续验收批次(双 AI 验收/QA)补录,--final 前必须清零"
    },
    "mobile.error-copy.AUTH_REQUEST_FAILED|android-pad|zh-TW|cn": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "PR4a 派工包集中批捕预案:合并门=--preview-slice 无 schema 错误;全格实拍证据由后续验收批次(双 AI 验收/QA)补录,--final 前必须清零"
    },
    "mobile.error-copy.AUTH_REQUEST_FAILED|android-pad|zh-TW|global": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "PR4a 派工包集中批捕预案:合并门=--preview-slice 无 schema 错误;全格实拍证据由后续验收批次(双 AI 验收/QA)补录,--final 前必须清零"
    },
    "mobile.error-copy.AUTH_REQUEST_FAILED|android-pad|en|cn": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "PR4a 派工包集中批捕预案:合并门=--preview-slice 无 schema 错误;全格实拍证据由后续验收批次(双 AI 验收/QA)补录,--final 前必须清零"
    },
    "mobile.error-copy.AUTH_REQUEST_FAILED|android-pad|en|global": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "PR4a 派工包集中批捕预案:合并门=--preview-slice 无 schema 错误;全格实拍证据由后续验收批次(双 AI 验收/QA)补录,--final 前必须清零"
    },
    "mobile.error-copy.AUTH_REQUEST_FAILED|android-pad|ja|cn": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "PR4a 派工包集中批捕预案:合并门=--preview-slice 无 schema 错误;全格实拍证据由后续验收批次(双 AI 验收/QA)补录,--final 前必须清零"
    },
    "mobile.error-copy.AUTH_REQUEST_FAILED|android-pad|ja|global": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "PR4a 派工包集中批捕预案:合并门=--preview-slice 无 schema 错误;全格实拍证据由后续验收批次(双 AI 验收/QA)补录,--final 前必须清零"
    },
    "mobile.error-copy.AUTH_REQUEST_FAILED|android-pad|ko|cn": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "PR4a 派工包集中批捕预案:合并门=--preview-slice 无 schema 错误;全格实拍证据由后续验收批次(双 AI 验收/QA)补录,--final 前必须清零"
    },
    "mobile.error-copy.AUTH_REQUEST_FAILED|android-pad|ko|global": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "PR4a 派工包集中批捕预案:合并门=--preview-slice 无 schema 错误;全格实拍证据由后续验收批次(双 AI 验收/QA)补录,--final 前必须清零"
    },
    "mobile.error-copy.ORG_SSO_NOT_FOUND|iphone|zh-CN|cn": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "PR4a 派工包集中批捕预案:合并门=--preview-slice 无 schema 错误;全格实拍证据由后续验收批次(双 AI 验收/QA)补录,--final 前必须清零"
    },
    "mobile.error-copy.ORG_SSO_NOT_FOUND|iphone|zh-CN|global": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "PR4a 派工包集中批捕预案:合并门=--preview-slice 无 schema 错误;全格实拍证据由后续验收批次(双 AI 验收/QA)补录,--final 前必须清零"
    },
    "mobile.error-copy.ORG_SSO_NOT_FOUND|iphone|zh-TW|cn": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "PR4a 派工包集中批捕预案:合并门=--preview-slice 无 schema 错误;全格实拍证据由后续验收批次(双 AI 验收/QA)补录,--final 前必须清零"
    },
    "mobile.error-copy.ORG_SSO_NOT_FOUND|iphone|zh-TW|global": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "PR4a 派工包集中批捕预案:合并门=--preview-slice 无 schema 错误;全格实拍证据由后续验收批次(双 AI 验收/QA)补录,--final 前必须清零"
    },
    "mobile.error-copy.ORG_SSO_NOT_FOUND|iphone|en|cn": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "PR4a 派工包集中批捕预案:合并门=--preview-slice 无 schema 错误;全格实拍证据由后续验收批次(双 AI 验收/QA)补录,--final 前必须清零"
    },
    "mobile.error-copy.ORG_SSO_NOT_FOUND|iphone|en|global": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "PR4a 派工包集中批捕预案:合并门=--preview-slice 无 schema 错误;全格实拍证据由后续验收批次(双 AI 验收/QA)补录,--final 前必须清零"
    },
    "mobile.error-copy.ORG_SSO_NOT_FOUND|iphone|ja|cn": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "PR4a 派工包集中批捕预案:合并门=--preview-slice 无 schema 错误;全格实拍证据由后续验收批次(双 AI 验收/QA)补录,--final 前必须清零"
    },
    "mobile.error-copy.ORG_SSO_NOT_FOUND|iphone|ja|global": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "PR4a 派工包集中批捕预案:合并门=--preview-slice 无 schema 错误;全格实拍证据由后续验收批次(双 AI 验收/QA)补录,--final 前必须清零"
    },
    "mobile.error-copy.ORG_SSO_NOT_FOUND|iphone|ko|cn": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "PR4a 派工包集中批捕预案:合并门=--preview-slice 无 schema 错误;全格实拍证据由后续验收批次(双 AI 验收/QA)补录,--final 前必须清零"
    },
    "mobile.error-copy.ORG_SSO_NOT_FOUND|iphone|ko|global": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "PR4a 派工包集中批捕预案:合并门=--preview-slice 无 schema 错误;全格实拍证据由后续验收批次(双 AI 验收/QA)补录,--final 前必须清零"
    },
    "mobile.error-copy.ORG_SSO_NOT_FOUND|android-phone|zh-CN|cn": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "PR4a 派工包集中批捕预案:合并门=--preview-slice 无 schema 错误;全格实拍证据由后续验收批次(双 AI 验收/QA)补录,--final 前必须清零"
    },
    "mobile.error-copy.ORG_SSO_NOT_FOUND|android-phone|zh-CN|global": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "PR4a 派工包集中批捕预案:合并门=--preview-slice 无 schema 错误;全格实拍证据由后续验收批次(双 AI 验收/QA)补录,--final 前必须清零"
    },
    "mobile.error-copy.ORG_SSO_NOT_FOUND|android-phone|zh-TW|cn": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "PR4a 派工包集中批捕预案:合并门=--preview-slice 无 schema 错误;全格实拍证据由后续验收批次(双 AI 验收/QA)补录,--final 前必须清零"
    },
    "mobile.error-copy.ORG_SSO_NOT_FOUND|android-phone|zh-TW|global": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "PR4a 派工包集中批捕预案:合并门=--preview-slice 无 schema 错误;全格实拍证据由后续验收批次(双 AI 验收/QA)补录,--final 前必须清零"
    },
    "mobile.error-copy.ORG_SSO_NOT_FOUND|android-phone|en|cn": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "PR4a 派工包集中批捕预案:合并门=--preview-slice 无 schema 错误;全格实拍证据由后续验收批次(双 AI 验收/QA)补录,--final 前必须清零"
    },
    "mobile.error-copy.ORG_SSO_NOT_FOUND|android-phone|en|global": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "PR4a 派工包集中批捕预案:合并门=--preview-slice 无 schema 错误;全格实拍证据由后续验收批次(双 AI 验收/QA)补录,--final 前必须清零"
    },
    "mobile.error-copy.ORG_SSO_NOT_FOUND|android-phone|ja|cn": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "PR4a 派工包集中批捕预案:合并门=--preview-slice 无 schema 错误;全格实拍证据由后续验收批次(双 AI 验收/QA)补录,--final 前必须清零"
    },
    "mobile.error-copy.ORG_SSO_NOT_FOUND|android-phone|ja|global": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "PR4a 派工包集中批捕预案:合并门=--preview-slice 无 schema 错误;全格实拍证据由后续验收批次(双 AI 验收/QA)补录,--final 前必须清零"
    },
    "mobile.error-copy.ORG_SSO_NOT_FOUND|android-phone|ko|cn": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "PR4a 派工包集中批捕预案:合并门=--preview-slice 无 schema 错误;全格实拍证据由后续验收批次(双 AI 验收/QA)补录,--final 前必须清零"
    },
    "mobile.error-copy.ORG_SSO_NOT_FOUND|android-phone|ko|global": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "PR4a 派工包集中批捕预案:合并门=--preview-slice 无 schema 错误;全格实拍证据由后续验收批次(双 AI 验收/QA)补录,--final 前必须清零"
    },
    "mobile.error-copy.ORG_SSO_NOT_FOUND|ipad|zh-CN|cn": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "PR4a 派工包集中批捕预案:合并门=--preview-slice 无 schema 错误;全格实拍证据由后续验收批次(双 AI 验收/QA)补录,--final 前必须清零"
    },
    "mobile.error-copy.ORG_SSO_NOT_FOUND|ipad|zh-CN|global": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "PR4a 派工包集中批捕预案:合并门=--preview-slice 无 schema 错误;全格实拍证据由后续验收批次(双 AI 验收/QA)补录,--final 前必须清零"
    },
    "mobile.error-copy.ORG_SSO_NOT_FOUND|ipad|zh-TW|cn": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "PR4a 派工包集中批捕预案:合并门=--preview-slice 无 schema 错误;全格实拍证据由后续验收批次(双 AI 验收/QA)补录,--final 前必须清零"
    },
    "mobile.error-copy.ORG_SSO_NOT_FOUND|ipad|zh-TW|global": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "PR4a 派工包集中批捕预案:合并门=--preview-slice 无 schema 错误;全格实拍证据由后续验收批次(双 AI 验收/QA)补录,--final 前必须清零"
    },
    "mobile.error-copy.ORG_SSO_NOT_FOUND|ipad|en|cn": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "PR4a 派工包集中批捕预案:合并门=--preview-slice 无 schema 错误;全格实拍证据由后续验收批次(双 AI 验收/QA)补录,--final 前必须清零"
    },
    "mobile.error-copy.ORG_SSO_NOT_FOUND|ipad|en|global": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "PR4a 派工包集中批捕预案:合并门=--preview-slice 无 schema 错误;全格实拍证据由后续验收批次(双 AI 验收/QA)补录,--final 前必须清零"
    },
    "mobile.error-copy.ORG_SSO_NOT_FOUND|ipad|ja|cn": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "PR4a 派工包集中批捕预案:合并门=--preview-slice 无 schema 错误;全格实拍证据由后续验收批次(双 AI 验收/QA)补录,--final 前必须清零"
    },
    "mobile.error-copy.ORG_SSO_NOT_FOUND|ipad|ja|global": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "PR4a 派工包集中批捕预案:合并门=--preview-slice 无 schema 错误;全格实拍证据由后续验收批次(双 AI 验收/QA)补录,--final 前必须清零"
    },
    "mobile.error-copy.ORG_SSO_NOT_FOUND|ipad|ko|cn": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "PR4a 派工包集中批捕预案:合并门=--preview-slice 无 schema 错误;全格实拍证据由后续验收批次(双 AI 验收/QA)补录,--final 前必须清零"
    },
    "mobile.error-copy.ORG_SSO_NOT_FOUND|ipad|ko|global": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "PR4a 派工包集中批捕预案:合并门=--preview-slice 无 schema 错误;全格实拍证据由后续验收批次(双 AI 验收/QA)补录,--final 前必须清零"
    },
    "mobile.error-copy.ORG_SSO_NOT_FOUND|android-pad|zh-CN|cn": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "PR4a 派工包集中批捕预案:合并门=--preview-slice 无 schema 错误;全格实拍证据由后续验收批次(双 AI 验收/QA)补录,--final 前必须清零"
    },
    "mobile.error-copy.ORG_SSO_NOT_FOUND|android-pad|zh-CN|global": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "PR4a 派工包集中批捕预案:合并门=--preview-slice 无 schema 错误;全格实拍证据由后续验收批次(双 AI 验收/QA)补录,--final 前必须清零"
    },
    "mobile.error-copy.ORG_SSO_NOT_FOUND|android-pad|zh-TW|cn": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "PR4a 派工包集中批捕预案:合并门=--preview-slice 无 schema 错误;全格实拍证据由后续验收批次(双 AI 验收/QA)补录,--final 前必须清零"
    },
    "mobile.error-copy.ORG_SSO_NOT_FOUND|android-pad|zh-TW|global": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "PR4a 派工包集中批捕预案:合并门=--preview-slice 无 schema 错误;全格实拍证据由后续验收批次(双 AI 验收/QA)补录,--final 前必须清零"
    },
    "mobile.error-copy.ORG_SSO_NOT_FOUND|android-pad|en|cn": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "PR4a 派工包集中批捕预案:合并门=--preview-slice 无 schema 错误;全格实拍证据由后续验收批次(双 AI 验收/QA)补录,--final 前必须清零"
    },
    "mobile.error-copy.ORG_SSO_NOT_FOUND|android-pad|en|global": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "PR4a 派工包集中批捕预案:合并门=--preview-slice 无 schema 错误;全格实拍证据由后续验收批次(双 AI 验收/QA)补录,--final 前必须清零"
    },
    "mobile.error-copy.ORG_SSO_NOT_FOUND|android-pad|ja|cn": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "PR4a 派工包集中批捕预案:合并门=--preview-slice 无 schema 错误;全格实拍证据由后续验收批次(双 AI 验收/QA)补录,--final 前必须清零"
    },
    "mobile.error-copy.ORG_SSO_NOT_FOUND|android-pad|ja|global": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "PR4a 派工包集中批捕预案:合并门=--preview-slice 无 schema 错误;全格实拍证据由后续验收批次(双 AI 验收/QA)补录,--final 前必须清零"
    },
    "mobile.error-copy.ORG_SSO_NOT_FOUND|android-pad|ko|cn": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "PR4a 派工包集中批捕预案:合并门=--preview-slice 无 schema 错误;全格实拍证据由后续验收批次(双 AI 验收/QA)补录,--final 前必须清零"
    },
    "mobile.error-copy.ORG_SSO_NOT_FOUND|android-pad|ko|global": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "PR4a 派工包集中批捕预案:合并门=--preview-slice 无 schema 错误;全格实拍证据由后续验收批次(双 AI 验收/QA)补录,--final 前必须清零"
    },
    "mobile.error-copy.UNKNOWN_CODE|iphone|zh-CN|cn": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "PR4a 派工包集中批捕预案:合并门=--preview-slice 无 schema 错误;全格实拍证据由后续验收批次(双 AI 验收/QA)补录,--final 前必须清零"
    },
    "mobile.error-copy.UNKNOWN_CODE|iphone|zh-CN|global": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "PR4a 派工包集中批捕预案:合并门=--preview-slice 无 schema 错误;全格实拍证据由后续验收批次(双 AI 验收/QA)补录,--final 前必须清零"
    },
    "mobile.error-copy.UNKNOWN_CODE|iphone|zh-TW|cn": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "PR4a 派工包集中批捕预案:合并门=--preview-slice 无 schema 错误;全格实拍证据由后续验收批次(双 AI 验收/QA)补录,--final 前必须清零"
    },
    "mobile.error-copy.UNKNOWN_CODE|iphone|zh-TW|global": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "PR4a 派工包集中批捕预案:合并门=--preview-slice 无 schema 错误;全格实拍证据由后续验收批次(双 AI 验收/QA)补录,--final 前必须清零"
    },
    "mobile.error-copy.UNKNOWN_CODE|iphone|en|cn": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "PR4a 派工包集中批捕预案:合并门=--preview-slice 无 schema 错误;全格实拍证据由后续验收批次(双 AI 验收/QA)补录,--final 前必须清零"
    },
    "mobile.error-copy.UNKNOWN_CODE|iphone|en|global": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "PR4a 派工包集中批捕预案:合并门=--preview-slice 无 schema 错误;全格实拍证据由后续验收批次(双 AI 验收/QA)补录,--final 前必须清零"
    },
    "mobile.error-copy.UNKNOWN_CODE|iphone|ja|cn": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "PR4a 派工包集中批捕预案:合并门=--preview-slice 无 schema 错误;全格实拍证据由后续验收批次(双 AI 验收/QA)补录,--final 前必须清零"
    },
    "mobile.error-copy.UNKNOWN_CODE|iphone|ja|global": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "PR4a 派工包集中批捕预案:合并门=--preview-slice 无 schema 错误;全格实拍证据由后续验收批次(双 AI 验收/QA)补录,--final 前必须清零"
    },
    "mobile.error-copy.UNKNOWN_CODE|iphone|ko|cn": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "PR4a 派工包集中批捕预案:合并门=--preview-slice 无 schema 错误;全格实拍证据由后续验收批次(双 AI 验收/QA)补录,--final 前必须清零"
    },
    "mobile.error-copy.UNKNOWN_CODE|iphone|ko|global": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "PR4a 派工包集中批捕预案:合并门=--preview-slice 无 schema 错误;全格实拍证据由后续验收批次(双 AI 验收/QA)补录,--final 前必须清零"
    },
    "mobile.error-copy.UNKNOWN_CODE|android-phone|zh-CN|cn": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "PR4a 派工包集中批捕预案:合并门=--preview-slice 无 schema 错误;全格实拍证据由后续验收批次(双 AI 验收/QA)补录,--final 前必须清零"
    },
    "mobile.error-copy.UNKNOWN_CODE|android-phone|zh-CN|global": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "PR4a 派工包集中批捕预案:合并门=--preview-slice 无 schema 错误;全格实拍证据由后续验收批次(双 AI 验收/QA)补录,--final 前必须清零"
    },
    "mobile.error-copy.UNKNOWN_CODE|android-phone|zh-TW|cn": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "PR4a 派工包集中批捕预案:合并门=--preview-slice 无 schema 错误;全格实拍证据由后续验收批次(双 AI 验收/QA)补录,--final 前必须清零"
    },
    "mobile.error-copy.UNKNOWN_CODE|android-phone|zh-TW|global": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "PR4a 派工包集中批捕预案:合并门=--preview-slice 无 schema 错误;全格实拍证据由后续验收批次(双 AI 验收/QA)补录,--final 前必须清零"
    },
    "mobile.error-copy.UNKNOWN_CODE|android-phone|en|cn": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "PR4a 派工包集中批捕预案:合并门=--preview-slice 无 schema 错误;全格实拍证据由后续验收批次(双 AI 验收/QA)补录,--final 前必须清零"
    },
    "mobile.error-copy.UNKNOWN_CODE|android-phone|en|global": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "PR4a 派工包集中批捕预案:合并门=--preview-slice 无 schema 错误;全格实拍证据由后续验收批次(双 AI 验收/QA)补录,--final 前必须清零"
    },
    "mobile.error-copy.UNKNOWN_CODE|android-phone|ja|cn": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "PR4a 派工包集中批捕预案:合并门=--preview-slice 无 schema 错误;全格实拍证据由后续验收批次(双 AI 验收/QA)补录,--final 前必须清零"
    },
    "mobile.error-copy.UNKNOWN_CODE|android-phone|ja|global": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "PR4a 派工包集中批捕预案:合并门=--preview-slice 无 schema 错误;全格实拍证据由后续验收批次(双 AI 验收/QA)补录,--final 前必须清零"
    },
    "mobile.error-copy.UNKNOWN_CODE|android-phone|ko|cn": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "PR4a 派工包集中批捕预案:合并门=--preview-slice 无 schema 错误;全格实拍证据由后续验收批次(双 AI 验收/QA)补录,--final 前必须清零"
    },
    "mobile.error-copy.UNKNOWN_CODE|android-phone|ko|global": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "PR4a 派工包集中批捕预案:合并门=--preview-slice 无 schema 错误;全格实拍证据由后续验收批次(双 AI 验收/QA)补录,--final 前必须清零"
    },
    "mobile.error-copy.UNKNOWN_CODE|ipad|zh-CN|cn": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "PR4a 派工包集中批捕预案:合并门=--preview-slice 无 schema 错误;全格实拍证据由后续验收批次(双 AI 验收/QA)补录,--final 前必须清零"
    },
    "mobile.error-copy.UNKNOWN_CODE|ipad|zh-CN|global": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "PR4a 派工包集中批捕预案:合并门=--preview-slice 无 schema 错误;全格实拍证据由后续验收批次(双 AI 验收/QA)补录,--final 前必须清零"
    },
    "mobile.error-copy.UNKNOWN_CODE|ipad|zh-TW|cn": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "PR4a 派工包集中批捕预案:合并门=--preview-slice 无 schema 错误;全格实拍证据由后续验收批次(双 AI 验收/QA)补录,--final 前必须清零"
    },
    "mobile.error-copy.UNKNOWN_CODE|ipad|zh-TW|global": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "PR4a 派工包集中批捕预案:合并门=--preview-slice 无 schema 错误;全格实拍证据由后续验收批次(双 AI 验收/QA)补录,--final 前必须清零"
    },
    "mobile.error-copy.UNKNOWN_CODE|ipad|en|cn": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "PR4a 派工包集中批捕预案:合并门=--preview-slice 无 schema 错误;全格实拍证据由后续验收批次(双 AI 验收/QA)补录,--final 前必须清零"
    },
    "mobile.error-copy.UNKNOWN_CODE|ipad|en|global": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "PR4a 派工包集中批捕预案:合并门=--preview-slice 无 schema 错误;全格实拍证据由后续验收批次(双 AI 验收/QA)补录,--final 前必须清零"
    },
    "mobile.error-copy.UNKNOWN_CODE|ipad|ja|cn": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "PR4a 派工包集中批捕预案:合并门=--preview-slice 无 schema 错误;全格实拍证据由后续验收批次(双 AI 验收/QA)补录,--final 前必须清零"
    },
    "mobile.error-copy.UNKNOWN_CODE|ipad|ja|global": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "PR4a 派工包集中批捕预案:合并门=--preview-slice 无 schema 错误;全格实拍证据由后续验收批次(双 AI 验收/QA)补录,--final 前必须清零"
    },
    "mobile.error-copy.UNKNOWN_CODE|ipad|ko|cn": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "PR4a 派工包集中批捕预案:合并门=--preview-slice 无 schema 错误;全格实拍证据由后续验收批次(双 AI 验收/QA)补录,--final 前必须清零"
    },
    "mobile.error-copy.UNKNOWN_CODE|ipad|ko|global": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "PR4a 派工包集中批捕预案:合并门=--preview-slice 无 schema 错误;全格实拍证据由后续验收批次(双 AI 验收/QA)补录,--final 前必须清零"
    },
    "mobile.error-copy.UNKNOWN_CODE|android-pad|zh-CN|cn": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "PR4a 派工包集中批捕预案:合并门=--preview-slice 无 schema 错误;全格实拍证据由后续验收批次(双 AI 验收/QA)补录,--final 前必须清零"
    },
    "mobile.error-copy.UNKNOWN_CODE|android-pad|zh-CN|global": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "PR4a 派工包集中批捕预案:合并门=--preview-slice 无 schema 错误;全格实拍证据由后续验收批次(双 AI 验收/QA)补录,--final 前必须清零"
    },
    "mobile.error-copy.UNKNOWN_CODE|android-pad|zh-TW|cn": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "PR4a 派工包集中批捕预案:合并门=--preview-slice 无 schema 错误;全格实拍证据由后续验收批次(双 AI 验收/QA)补录,--final 前必须清零"
    },
    "mobile.error-copy.UNKNOWN_CODE|android-pad|zh-TW|global": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "PR4a 派工包集中批捕预案:合并门=--preview-slice 无 schema 错误;全格实拍证据由后续验收批次(双 AI 验收/QA)补录,--final 前必须清零"
    },
    "mobile.error-copy.UNKNOWN_CODE|android-pad|en|cn": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "PR4a 派工包集中批捕预案:合并门=--preview-slice 无 schema 错误;全格实拍证据由后续验收批次(双 AI 验收/QA)补录,--final 前必须清零"
    },
    "mobile.error-copy.UNKNOWN_CODE|android-pad|en|global": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "PR4a 派工包集中批捕预案:合并门=--preview-slice 无 schema 错误;全格实拍证据由后续验收批次(双 AI 验收/QA)补录,--final 前必须清零"
    },
    "mobile.error-copy.UNKNOWN_CODE|android-pad|ja|cn": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "PR4a 派工包集中批捕预案:合并门=--preview-slice 无 schema 错误;全格实拍证据由后续验收批次(双 AI 验收/QA)补录,--final 前必须清零"
    },
    "mobile.error-copy.UNKNOWN_CODE|android-pad|ja|global": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "PR4a 派工包集中批捕预案:合并门=--preview-slice 无 schema 错误;全格实拍证据由后续验收批次(双 AI 验收/QA)补录,--final 前必须清零"
    },
    "mobile.error-copy.UNKNOWN_CODE|android-pad|ko|cn": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "PR4a 派工包集中批捕预案:合并门=--preview-slice 无 schema 错误;全格实拍证据由后续验收批次(双 AI 验收/QA)补录,--final 前必须清零"
    },
    "mobile.error-copy.UNKNOWN_CODE|android-pad|ko|global": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "PR4a 派工包集中批捕预案:合并门=--preview-slice 无 schema 错误;全格实拍证据由后续验收批次(双 AI 验收/QA)补录,--final 前必须清零"
    },
    "desktop.splash-checking-update.style|mac|zh-CN|cn": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "桌面视觉/动态录屏取证受锁屏限制,按 lead 集中批捕预案(2026-07-20)延后;本支合并条件=机器门禁全绿(coverage/typecheck/test:unit/wave4/parity)"
    },
    "desktop.splash-checking-update.style|mac|zh-CN|global": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "桌面视觉/动态录屏取证受锁屏限制,按 lead 集中批捕预案(2026-07-20)延后;本支合并条件=机器门禁全绿(coverage/typecheck/test:unit/wave4/parity)"
    },
    "desktop.splash-checking-update.style|mac|zh-TW|cn": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "桌面视觉/动态录屏取证受锁屏限制,按 lead 集中批捕预案(2026-07-20)延后;本支合并条件=机器门禁全绿(coverage/typecheck/test:unit/wave4/parity)"
    },
    "desktop.splash-checking-update.style|mac|zh-TW|global": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "桌面视觉/动态录屏取证受锁屏限制,按 lead 集中批捕预案(2026-07-20)延后;本支合并条件=机器门禁全绿(coverage/typecheck/test:unit/wave4/parity)"
    },
    "desktop.splash-checking-update.style|mac|en|cn": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "桌面视觉/动态录屏取证受锁屏限制,按 lead 集中批捕预案(2026-07-20)延后;本支合并条件=机器门禁全绿(coverage/typecheck/test:unit/wave4/parity)"
    },
    "desktop.splash-checking-update.style|mac|en|global": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "桌面视觉/动态录屏取证受锁屏限制,按 lead 集中批捕预案(2026-07-20)延后;本支合并条件=机器门禁全绿(coverage/typecheck/test:unit/wave4/parity)"
    },
    "desktop.splash-checking-update.style|mac|ja|cn": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "桌面视觉/动态录屏取证受锁屏限制,按 lead 集中批捕预案(2026-07-20)延后;本支合并条件=机器门禁全绿(coverage/typecheck/test:unit/wave4/parity)"
    },
    "desktop.splash-checking-update.style|mac|ja|global": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "桌面视觉/动态录屏取证受锁屏限制,按 lead 集中批捕预案(2026-07-20)延后;本支合并条件=机器门禁全绿(coverage/typecheck/test:unit/wave4/parity)"
    },
    "desktop.splash-checking-update.style|mac|ko|cn": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "桌面视觉/动态录屏取证受锁屏限制,按 lead 集中批捕预案(2026-07-20)延后;本支合并条件=机器门禁全绿(coverage/typecheck/test:unit/wave4/parity)"
    },
    "desktop.splash-checking-update.style|mac|ko|global": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "桌面视觉/动态录屏取证受锁屏限制,按 lead 集中批捕预案(2026-07-20)延后;本支合并条件=机器门禁全绿(coverage/typecheck/test:unit/wave4/parity)"
    },
    "desktop.splash-checking-update.style|windows|zh-CN|cn": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "桌面视觉/动态录屏取证受锁屏限制,按 lead 集中批捕预案(2026-07-20)延后;本支合并条件=机器门禁全绿(coverage/typecheck/test:unit/wave4/parity)"
    },
    "desktop.splash-checking-update.style|windows|zh-CN|global": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "桌面视觉/动态录屏取证受锁屏限制,按 lead 集中批捕预案(2026-07-20)延后;本支合并条件=机器门禁全绿(coverage/typecheck/test:unit/wave4/parity)"
    },
    "desktop.splash-checking-update.style|windows|zh-TW|cn": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "桌面视觉/动态录屏取证受锁屏限制,按 lead 集中批捕预案(2026-07-20)延后;本支合并条件=机器门禁全绿(coverage/typecheck/test:unit/wave4/parity)"
    },
    "desktop.splash-checking-update.style|windows|zh-TW|global": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "桌面视觉/动态录屏取证受锁屏限制,按 lead 集中批捕预案(2026-07-20)延后;本支合并条件=机器门禁全绿(coverage/typecheck/test:unit/wave4/parity)"
    },
    "desktop.splash-checking-update.style|windows|en|cn": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "桌面视觉/动态录屏取证受锁屏限制,按 lead 集中批捕预案(2026-07-20)延后;本支合并条件=机器门禁全绿(coverage/typecheck/test:unit/wave4/parity)"
    },
    "desktop.splash-checking-update.style|windows|en|global": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "桌面视觉/动态录屏取证受锁屏限制,按 lead 集中批捕预案(2026-07-20)延后;本支合并条件=机器门禁全绿(coverage/typecheck/test:unit/wave4/parity)"
    },
    "desktop.splash-checking-update.style|windows|ja|cn": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "桌面视觉/动态录屏取证受锁屏限制,按 lead 集中批捕预案(2026-07-20)延后;本支合并条件=机器门禁全绿(coverage/typecheck/test:unit/wave4/parity)"
    },
    "desktop.splash-checking-update.style|windows|ja|global": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "桌面视觉/动态录屏取证受锁屏限制,按 lead 集中批捕预案(2026-07-20)延后;本支合并条件=机器门禁全绿(coverage/typecheck/test:unit/wave4/parity)"
    },
    "desktop.splash-checking-update.style|windows|ko|cn": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "桌面视觉/动态录屏取证受锁屏限制,按 lead 集中批捕预案(2026-07-20)延后;本支合并条件=机器门禁全绿(coverage/typecheck/test:unit/wave4/parity)"
    },
    "desktop.splash-checking-update.style|windows|ko|global": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "桌面视觉/动态录屏取证受锁屏限制,按 lead 集中批捕预案(2026-07-20)延后;本支合并条件=机器门禁全绿(coverage/typecheck/test:unit/wave4/parity)"
    },
    "desktop.splash-updating.style|mac|zh-CN|cn": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "桌面视觉/动态录屏取证受锁屏限制,按 lead 集中批捕预案(2026-07-20)延后;本支合并条件=机器门禁全绿(coverage/typecheck/test:unit/wave4/parity)"
    },
    "desktop.splash-updating.style|mac|zh-CN|global": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "桌面视觉/动态录屏取证受锁屏限制,按 lead 集中批捕预案(2026-07-20)延后;本支合并条件=机器门禁全绿(coverage/typecheck/test:unit/wave4/parity)"
    },
    "desktop.splash-updating.style|mac|zh-TW|cn": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "桌面视觉/动态录屏取证受锁屏限制,按 lead 集中批捕预案(2026-07-20)延后;本支合并条件=机器门禁全绿(coverage/typecheck/test:unit/wave4/parity)"
    },
    "desktop.splash-updating.style|mac|zh-TW|global": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "桌面视觉/动态录屏取证受锁屏限制,按 lead 集中批捕预案(2026-07-20)延后;本支合并条件=机器门禁全绿(coverage/typecheck/test:unit/wave4/parity)"
    },
    "desktop.splash-updating.style|mac|en|cn": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "桌面视觉/动态录屏取证受锁屏限制,按 lead 集中批捕预案(2026-07-20)延后;本支合并条件=机器门禁全绿(coverage/typecheck/test:unit/wave4/parity)"
    },
    "desktop.splash-updating.style|mac|en|global": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "桌面视觉/动态录屏取证受锁屏限制,按 lead 集中批捕预案(2026-07-20)延后;本支合并条件=机器门禁全绿(coverage/typecheck/test:unit/wave4/parity)"
    },
    "desktop.splash-updating.style|mac|ja|cn": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "桌面视觉/动态录屏取证受锁屏限制,按 lead 集中批捕预案(2026-07-20)延后;本支合并条件=机器门禁全绿(coverage/typecheck/test:unit/wave4/parity)"
    },
    "desktop.splash-updating.style|mac|ja|global": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "桌面视觉/动态录屏取证受锁屏限制,按 lead 集中批捕预案(2026-07-20)延后;本支合并条件=机器门禁全绿(coverage/typecheck/test:unit/wave4/parity)"
    },
    "desktop.splash-updating.style|mac|ko|cn": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "桌面视觉/动态录屏取证受锁屏限制,按 lead 集中批捕预案(2026-07-20)延后;本支合并条件=机器门禁全绿(coverage/typecheck/test:unit/wave4/parity)"
    },
    "desktop.splash-updating.style|mac|ko|global": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "桌面视觉/动态录屏取证受锁屏限制,按 lead 集中批捕预案(2026-07-20)延后;本支合并条件=机器门禁全绿(coverage/typecheck/test:unit/wave4/parity)"
    },
    "desktop.splash-updating.style|windows|zh-CN|cn": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "桌面视觉/动态录屏取证受锁屏限制,按 lead 集中批捕预案(2026-07-20)延后;本支合并条件=机器门禁全绿(coverage/typecheck/test:unit/wave4/parity)"
    },
    "desktop.splash-updating.style|windows|zh-CN|global": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "桌面视觉/动态录屏取证受锁屏限制,按 lead 集中批捕预案(2026-07-20)延后;本支合并条件=机器门禁全绿(coverage/typecheck/test:unit/wave4/parity)"
    },
    "desktop.splash-updating.style|windows|zh-TW|cn": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "桌面视觉/动态录屏取证受锁屏限制,按 lead 集中批捕预案(2026-07-20)延后;本支合并条件=机器门禁全绿(coverage/typecheck/test:unit/wave4/parity)"
    },
    "desktop.splash-updating.style|windows|zh-TW|global": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "桌面视觉/动态录屏取证受锁屏限制,按 lead 集中批捕预案(2026-07-20)延后;本支合并条件=机器门禁全绿(coverage/typecheck/test:unit/wave4/parity)"
    },
    "desktop.splash-updating.style|windows|en|cn": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "桌面视觉/动态录屏取证受锁屏限制,按 lead 集中批捕预案(2026-07-20)延后;本支合并条件=机器门禁全绿(coverage/typecheck/test:unit/wave4/parity)"
    },
    "desktop.splash-updating.style|windows|en|global": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "桌面视觉/动态录屏取证受锁屏限制,按 lead 集中批捕预案(2026-07-20)延后;本支合并条件=机器门禁全绿(coverage/typecheck/test:unit/wave4/parity)"
    },
    "desktop.splash-updating.style|windows|ja|cn": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "桌面视觉/动态录屏取证受锁屏限制,按 lead 集中批捕预案(2026-07-20)延后;本支合并条件=机器门禁全绿(coverage/typecheck/test:unit/wave4/parity)"
    },
    "desktop.splash-updating.style|windows|ja|global": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "桌面视觉/动态录屏取证受锁屏限制,按 lead 集中批捕预案(2026-07-20)延后;本支合并条件=机器门禁全绿(coverage/typecheck/test:unit/wave4/parity)"
    },
    "desktop.splash-updating.style|windows|ko|cn": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "桌面视觉/动态录屏取证受锁屏限制,按 lead 集中批捕预案(2026-07-20)延后;本支合并条件=机器门禁全绿(coverage/typecheck/test:unit/wave4/parity)"
    },
    "desktop.splash-updating.style|windows|ko|global": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "桌面视觉/动态录屏取证受锁屏限制,按 lead 集中批捕预案(2026-07-20)延后;本支合并条件=机器门禁全绿(coverage/typecheck/test:unit/wave4/parity)"
    },
    "desktop.splash-update-done.style|mac|zh-CN|cn": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "桌面视觉/动态录屏取证受锁屏限制,按 lead 集中批捕预案(2026-07-20)延后;本支合并条件=机器门禁全绿(coverage/typecheck/test:unit/wave4/parity)"
    },
    "desktop.splash-update-done.style|mac|zh-CN|global": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "桌面视觉/动态录屏取证受锁屏限制,按 lead 集中批捕预案(2026-07-20)延后;本支合并条件=机器门禁全绿(coverage/typecheck/test:unit/wave4/parity)"
    },
    "desktop.splash-update-done.style|mac|zh-TW|cn": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "桌面视觉/动态录屏取证受锁屏限制,按 lead 集中批捕预案(2026-07-20)延后;本支合并条件=机器门禁全绿(coverage/typecheck/test:unit/wave4/parity)"
    },
    "desktop.splash-update-done.style|mac|zh-TW|global": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "桌面视觉/动态录屏取证受锁屏限制,按 lead 集中批捕预案(2026-07-20)延后;本支合并条件=机器门禁全绿(coverage/typecheck/test:unit/wave4/parity)"
    },
    "desktop.splash-update-done.style|mac|en|cn": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "桌面视觉/动态录屏取证受锁屏限制,按 lead 集中批捕预案(2026-07-20)延后;本支合并条件=机器门禁全绿(coverage/typecheck/test:unit/wave4/parity)"
    },
    "desktop.splash-update-done.style|mac|en|global": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "桌面视觉/动态录屏取证受锁屏限制,按 lead 集中批捕预案(2026-07-20)延后;本支合并条件=机器门禁全绿(coverage/typecheck/test:unit/wave4/parity)"
    },
    "desktop.splash-update-done.style|mac|ja|cn": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "桌面视觉/动态录屏取证受锁屏限制,按 lead 集中批捕预案(2026-07-20)延后;本支合并条件=机器门禁全绿(coverage/typecheck/test:unit/wave4/parity)"
    },
    "desktop.splash-update-done.style|mac|ja|global": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "桌面视觉/动态录屏取证受锁屏限制,按 lead 集中批捕预案(2026-07-20)延后;本支合并条件=机器门禁全绿(coverage/typecheck/test:unit/wave4/parity)"
    },
    "desktop.splash-update-done.style|mac|ko|cn": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "桌面视觉/动态录屏取证受锁屏限制,按 lead 集中批捕预案(2026-07-20)延后;本支合并条件=机器门禁全绿(coverage/typecheck/test:unit/wave4/parity)"
    },
    "desktop.splash-update-done.style|mac|ko|global": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "桌面视觉/动态录屏取证受锁屏限制,按 lead 集中批捕预案(2026-07-20)延后;本支合并条件=机器门禁全绿(coverage/typecheck/test:unit/wave4/parity)"
    },
    "desktop.splash-update-done.style|windows|zh-CN|cn": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "桌面视觉/动态录屏取证受锁屏限制,按 lead 集中批捕预案(2026-07-20)延后;本支合并条件=机器门禁全绿(coverage/typecheck/test:unit/wave4/parity)"
    },
    "desktop.splash-update-done.style|windows|zh-CN|global": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "桌面视觉/动态录屏取证受锁屏限制,按 lead 集中批捕预案(2026-07-20)延后;本支合并条件=机器门禁全绿(coverage/typecheck/test:unit/wave4/parity)"
    },
    "desktop.splash-update-done.style|windows|zh-TW|cn": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "桌面视觉/动态录屏取证受锁屏限制,按 lead 集中批捕预案(2026-07-20)延后;本支合并条件=机器门禁全绿(coverage/typecheck/test:unit/wave4/parity)"
    },
    "desktop.splash-update-done.style|windows|zh-TW|global": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "桌面视觉/动态录屏取证受锁屏限制,按 lead 集中批捕预案(2026-07-20)延后;本支合并条件=机器门禁全绿(coverage/typecheck/test:unit/wave4/parity)"
    },
    "desktop.splash-update-done.style|windows|en|cn": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "桌面视觉/动态录屏取证受锁屏限制,按 lead 集中批捕预案(2026-07-20)延后;本支合并条件=机器门禁全绿(coverage/typecheck/test:unit/wave4/parity)"
    },
    "desktop.splash-update-done.style|windows|en|global": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "桌面视觉/动态录屏取证受锁屏限制,按 lead 集中批捕预案(2026-07-20)延后;本支合并条件=机器门禁全绿(coverage/typecheck/test:unit/wave4/parity)"
    },
    "desktop.splash-update-done.style|windows|ja|cn": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "桌面视觉/动态录屏取证受锁屏限制,按 lead 集中批捕预案(2026-07-20)延后;本支合并条件=机器门禁全绿(coverage/typecheck/test:unit/wave4/parity)"
    },
    "desktop.splash-update-done.style|windows|ja|global": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "桌面视觉/动态录屏取证受锁屏限制,按 lead 集中批捕预案(2026-07-20)延后;本支合并条件=机器门禁全绿(coverage/typecheck/test:unit/wave4/parity)"
    },
    "desktop.splash-update-done.style|windows|ko|cn": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "桌面视觉/动态录屏取证受锁屏限制,按 lead 集中批捕预案(2026-07-20)延后;本支合并条件=机器门禁全绿(coverage/typecheck/test:unit/wave4/parity)"
    },
    "desktop.splash-update-done.style|windows|ko|global": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "桌面视觉/动态录屏取证受锁屏限制,按 lead 集中批捕预案(2026-07-20)延后;本支合并条件=机器门禁全绿(coverage/typecheck/test:unit/wave4/parity)"
    },
    "desktop.splash-checking.style|mac|zh-CN|cn": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "桌面视觉/动态录屏取证受锁屏限制,按 lead 集中批捕预案(2026-07-20)延后;本支合并条件=机器门禁全绿(coverage/typecheck/test:unit/wave4/parity)"
    },
    "desktop.splash-checking.style|mac|zh-CN|global": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "桌面视觉/动态录屏取证受锁屏限制,按 lead 集中批捕预案(2026-07-20)延后;本支合并条件=机器门禁全绿(coverage/typecheck/test:unit/wave4/parity)"
    },
    "desktop.splash-checking.style|mac|zh-TW|cn": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "桌面视觉/动态录屏取证受锁屏限制,按 lead 集中批捕预案(2026-07-20)延后;本支合并条件=机器门禁全绿(coverage/typecheck/test:unit/wave4/parity)"
    },
    "desktop.splash-checking.style|mac|zh-TW|global": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "桌面视觉/动态录屏取证受锁屏限制,按 lead 集中批捕预案(2026-07-20)延后;本支合并条件=机器门禁全绿(coverage/typecheck/test:unit/wave4/parity)"
    },
    "desktop.splash-checking.style|mac|en|cn": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "桌面视觉/动态录屏取证受锁屏限制,按 lead 集中批捕预案(2026-07-20)延后;本支合并条件=机器门禁全绿(coverage/typecheck/test:unit/wave4/parity)"
    },
    "desktop.splash-checking.style|mac|en|global": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "桌面视觉/动态录屏取证受锁屏限制,按 lead 集中批捕预案(2026-07-20)延后;本支合并条件=机器门禁全绿(coverage/typecheck/test:unit/wave4/parity)"
    },
    "desktop.splash-checking.style|mac|ja|cn": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "桌面视觉/动态录屏取证受锁屏限制,按 lead 集中批捕预案(2026-07-20)延后;本支合并条件=机器门禁全绿(coverage/typecheck/test:unit/wave4/parity)"
    },
    "desktop.splash-checking.style|mac|ja|global": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "桌面视觉/动态录屏取证受锁屏限制,按 lead 集中批捕预案(2026-07-20)延后;本支合并条件=机器门禁全绿(coverage/typecheck/test:unit/wave4/parity)"
    },
    "desktop.splash-checking.style|mac|ko|cn": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "桌面视觉/动态录屏取证受锁屏限制,按 lead 集中批捕预案(2026-07-20)延后;本支合并条件=机器门禁全绿(coverage/typecheck/test:unit/wave4/parity)"
    },
    "desktop.splash-checking.style|mac|ko|global": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "桌面视觉/动态录屏取证受锁屏限制,按 lead 集中批捕预案(2026-07-20)延后;本支合并条件=机器门禁全绿(coverage/typecheck/test:unit/wave4/parity)"
    },
    "desktop.splash-checking.style|windows|zh-CN|cn": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "桌面视觉/动态录屏取证受锁屏限制,按 lead 集中批捕预案(2026-07-20)延后;本支合并条件=机器门禁全绿(coverage/typecheck/test:unit/wave4/parity)"
    },
    "desktop.splash-checking.style|windows|zh-CN|global": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "桌面视觉/动态录屏取证受锁屏限制,按 lead 集中批捕预案(2026-07-20)延后;本支合并条件=机器门禁全绿(coverage/typecheck/test:unit/wave4/parity)"
    },
    "desktop.splash-checking.style|windows|zh-TW|cn": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "桌面视觉/动态录屏取证受锁屏限制,按 lead 集中批捕预案(2026-07-20)延后;本支合并条件=机器门禁全绿(coverage/typecheck/test:unit/wave4/parity)"
    },
    "desktop.splash-checking.style|windows|zh-TW|global": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "桌面视觉/动态录屏取证受锁屏限制,按 lead 集中批捕预案(2026-07-20)延后;本支合并条件=机器门禁全绿(coverage/typecheck/test:unit/wave4/parity)"
    },
    "desktop.splash-checking.style|windows|en|cn": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "桌面视觉/动态录屏取证受锁屏限制,按 lead 集中批捕预案(2026-07-20)延后;本支合并条件=机器门禁全绿(coverage/typecheck/test:unit/wave4/parity)"
    },
    "desktop.splash-checking.style|windows|en|global": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "桌面视觉/动态录屏取证受锁屏限制,按 lead 集中批捕预案(2026-07-20)延后;本支合并条件=机器门禁全绿(coverage/typecheck/test:unit/wave4/parity)"
    },
    "desktop.splash-checking.style|windows|ja|cn": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "桌面视觉/动态录屏取证受锁屏限制,按 lead 集中批捕预案(2026-07-20)延后;本支合并条件=机器门禁全绿(coverage/typecheck/test:unit/wave4/parity)"
    },
    "desktop.splash-checking.style|windows|ja|global": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "桌面视觉/动态录屏取证受锁屏限制,按 lead 集中批捕预案(2026-07-20)延后;本支合并条件=机器门禁全绿(coverage/typecheck/test:unit/wave4/parity)"
    },
    "desktop.splash-checking.style|windows|ko|cn": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "桌面视觉/动态录屏取证受锁屏限制,按 lead 集中批捕预案(2026-07-20)延后;本支合并条件=机器门禁全绿(coverage/typecheck/test:unit/wave4/parity)"
    },
    "desktop.splash-checking.style|windows|ko|global": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "桌面视觉/动态录屏取证受锁屏限制,按 lead 集中批捕预案(2026-07-20)延后;本支合并条件=机器门禁全绿(coverage/typecheck/test:unit/wave4/parity)"
    },
    "desktop.splash-downloading.style|mac|zh-CN|cn": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "桌面视觉/动态录屏取证受锁屏限制,按 lead 集中批捕预案(2026-07-20)延后;本支合并条件=机器门禁全绿(coverage/typecheck/test:unit/wave4/parity)"
    },
    "desktop.splash-downloading.style|mac|zh-CN|global": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "桌面视觉/动态录屏取证受锁屏限制,按 lead 集中批捕预案(2026-07-20)延后;本支合并条件=机器门禁全绿(coverage/typecheck/test:unit/wave4/parity)"
    },
    "desktop.splash-downloading.style|mac|zh-TW|cn": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "桌面视觉/动态录屏取证受锁屏限制,按 lead 集中批捕预案(2026-07-20)延后;本支合并条件=机器门禁全绿(coverage/typecheck/test:unit/wave4/parity)"
    },
    "desktop.splash-downloading.style|mac|zh-TW|global": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "桌面视觉/动态录屏取证受锁屏限制,按 lead 集中批捕预案(2026-07-20)延后;本支合并条件=机器门禁全绿(coverage/typecheck/test:unit/wave4/parity)"
    },
    "desktop.splash-downloading.style|mac|en|cn": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "桌面视觉/动态录屏取证受锁屏限制,按 lead 集中批捕预案(2026-07-20)延后;本支合并条件=机器门禁全绿(coverage/typecheck/test:unit/wave4/parity)"
    },
    "desktop.splash-downloading.style|mac|en|global": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "桌面视觉/动态录屏取证受锁屏限制,按 lead 集中批捕预案(2026-07-20)延后;本支合并条件=机器门禁全绿(coverage/typecheck/test:unit/wave4/parity)"
    },
    "desktop.splash-downloading.style|mac|ja|cn": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "桌面视觉/动态录屏取证受锁屏限制,按 lead 集中批捕预案(2026-07-20)延后;本支合并条件=机器门禁全绿(coverage/typecheck/test:unit/wave4/parity)"
    },
    "desktop.splash-downloading.style|mac|ja|global": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "桌面视觉/动态录屏取证受锁屏限制,按 lead 集中批捕预案(2026-07-20)延后;本支合并条件=机器门禁全绿(coverage/typecheck/test:unit/wave4/parity)"
    },
    "desktop.splash-downloading.style|mac|ko|cn": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "桌面视觉/动态录屏取证受锁屏限制,按 lead 集中批捕预案(2026-07-20)延后;本支合并条件=机器门禁全绿(coverage/typecheck/test:unit/wave4/parity)"
    },
    "desktop.splash-downloading.style|mac|ko|global": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "桌面视觉/动态录屏取证受锁屏限制,按 lead 集中批捕预案(2026-07-20)延后;本支合并条件=机器门禁全绿(coverage/typecheck/test:unit/wave4/parity)"
    },
    "desktop.splash-downloading.style|windows|zh-CN|cn": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "桌面视觉/动态录屏取证受锁屏限制,按 lead 集中批捕预案(2026-07-20)延后;本支合并条件=机器门禁全绿(coverage/typecheck/test:unit/wave4/parity)"
    },
    "desktop.splash-downloading.style|windows|zh-CN|global": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "桌面视觉/动态录屏取证受锁屏限制,按 lead 集中批捕预案(2026-07-20)延后;本支合并条件=机器门禁全绿(coverage/typecheck/test:unit/wave4/parity)"
    },
    "desktop.splash-downloading.style|windows|zh-TW|cn": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "桌面视觉/动态录屏取证受锁屏限制,按 lead 集中批捕预案(2026-07-20)延后;本支合并条件=机器门禁全绿(coverage/typecheck/test:unit/wave4/parity)"
    },
    "desktop.splash-downloading.style|windows|zh-TW|global": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "桌面视觉/动态录屏取证受锁屏限制,按 lead 集中批捕预案(2026-07-20)延后;本支合并条件=机器门禁全绿(coverage/typecheck/test:unit/wave4/parity)"
    },
    "desktop.splash-downloading.style|windows|en|cn": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "桌面视觉/动态录屏取证受锁屏限制,按 lead 集中批捕预案(2026-07-20)延后;本支合并条件=机器门禁全绿(coverage/typecheck/test:unit/wave4/parity)"
    },
    "desktop.splash-downloading.style|windows|en|global": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "桌面视觉/动态录屏取证受锁屏限制,按 lead 集中批捕预案(2026-07-20)延后;本支合并条件=机器门禁全绿(coverage/typecheck/test:unit/wave4/parity)"
    },
    "desktop.splash-downloading.style|windows|ja|cn": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "桌面视觉/动态录屏取证受锁屏限制,按 lead 集中批捕预案(2026-07-20)延后;本支合并条件=机器门禁全绿(coverage/typecheck/test:unit/wave4/parity)"
    },
    "desktop.splash-downloading.style|windows|ja|global": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "桌面视觉/动态录屏取证受锁屏限制,按 lead 集中批捕预案(2026-07-20)延后;本支合并条件=机器门禁全绿(coverage/typecheck/test:unit/wave4/parity)"
    },
    "desktop.splash-downloading.style|windows|ko|cn": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "桌面视觉/动态录屏取证受锁屏限制,按 lead 集中批捕预案(2026-07-20)延后;本支合并条件=机器门禁全绿(coverage/typecheck/test:unit/wave4/parity)"
    },
    "desktop.splash-downloading.style|windows|ko|global": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "桌面视觉/动态录屏取证受锁屏限制,按 lead 集中批捕预案(2026-07-20)延后;本支合并条件=机器门禁全绿(coverage/typecheck/test:unit/wave4/parity)"
    },
    "desktop.splash-failed.style|mac|zh-CN|cn": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "桌面视觉/动态录屏取证受锁屏限制,按 lead 集中批捕预案(2026-07-20)延后;本支合并条件=机器门禁全绿(coverage/typecheck/test:unit/wave4/parity)"
    },
    "desktop.splash-failed.style|mac|zh-CN|global": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "桌面视觉/动态录屏取证受锁屏限制,按 lead 集中批捕预案(2026-07-20)延后;本支合并条件=机器门禁全绿(coverage/typecheck/test:unit/wave4/parity)"
    },
    "desktop.splash-failed.style|mac|zh-TW|cn": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "桌面视觉/动态录屏取证受锁屏限制,按 lead 集中批捕预案(2026-07-20)延后;本支合并条件=机器门禁全绿(coverage/typecheck/test:unit/wave4/parity)"
    },
    "desktop.splash-failed.style|mac|zh-TW|global": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "桌面视觉/动态录屏取证受锁屏限制,按 lead 集中批捕预案(2026-07-20)延后;本支合并条件=机器门禁全绿(coverage/typecheck/test:unit/wave4/parity)"
    },
    "desktop.splash-failed.style|mac|en|cn": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "桌面视觉/动态录屏取证受锁屏限制,按 lead 集中批捕预案(2026-07-20)延后;本支合并条件=机器门禁全绿(coverage/typecheck/test:unit/wave4/parity)"
    },
    "desktop.splash-failed.style|mac|en|global": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "桌面视觉/动态录屏取证受锁屏限制,按 lead 集中批捕预案(2026-07-20)延后;本支合并条件=机器门禁全绿(coverage/typecheck/test:unit/wave4/parity)"
    },
    "desktop.splash-failed.style|mac|ja|cn": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "桌面视觉/动态录屏取证受锁屏限制,按 lead 集中批捕预案(2026-07-20)延后;本支合并条件=机器门禁全绿(coverage/typecheck/test:unit/wave4/parity)"
    },
    "desktop.splash-failed.style|mac|ja|global": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "桌面视觉/动态录屏取证受锁屏限制,按 lead 集中批捕预案(2026-07-20)延后;本支合并条件=机器门禁全绿(coverage/typecheck/test:unit/wave4/parity)"
    },
    "desktop.splash-failed.style|mac|ko|cn": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "桌面视觉/动态录屏取证受锁屏限制,按 lead 集中批捕预案(2026-07-20)延后;本支合并条件=机器门禁全绿(coverage/typecheck/test:unit/wave4/parity)"
    },
    "desktop.splash-failed.style|mac|ko|global": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "桌面视觉/动态录屏取证受锁屏限制,按 lead 集中批捕预案(2026-07-20)延后;本支合并条件=机器门禁全绿(coverage/typecheck/test:unit/wave4/parity)"
    },
    "desktop.splash-failed.style|windows|zh-CN|cn": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "桌面视觉/动态录屏取证受锁屏限制,按 lead 集中批捕预案(2026-07-20)延后;本支合并条件=机器门禁全绿(coverage/typecheck/test:unit/wave4/parity)"
    },
    "desktop.splash-failed.style|windows|zh-CN|global": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "桌面视觉/动态录屏取证受锁屏限制,按 lead 集中批捕预案(2026-07-20)延后;本支合并条件=机器门禁全绿(coverage/typecheck/test:unit/wave4/parity)"
    },
    "desktop.splash-failed.style|windows|zh-TW|cn": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "桌面视觉/动态录屏取证受锁屏限制,按 lead 集中批捕预案(2026-07-20)延后;本支合并条件=机器门禁全绿(coverage/typecheck/test:unit/wave4/parity)"
    },
    "desktop.splash-failed.style|windows|zh-TW|global": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "桌面视觉/动态录屏取证受锁屏限制,按 lead 集中批捕预案(2026-07-20)延后;本支合并条件=机器门禁全绿(coverage/typecheck/test:unit/wave4/parity)"
    },
    "desktop.splash-failed.style|windows|en|cn": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "桌面视觉/动态录屏取证受锁屏限制,按 lead 集中批捕预案(2026-07-20)延后;本支合并条件=机器门禁全绿(coverage/typecheck/test:unit/wave4/parity)"
    },
    "desktop.splash-failed.style|windows|en|global": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "桌面视觉/动态录屏取证受锁屏限制,按 lead 集中批捕预案(2026-07-20)延后;本支合并条件=机器门禁全绿(coverage/typecheck/test:unit/wave4/parity)"
    },
    "desktop.splash-failed.style|windows|ja|cn": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "桌面视觉/动态录屏取证受锁屏限制,按 lead 集中批捕预案(2026-07-20)延后;本支合并条件=机器门禁全绿(coverage/typecheck/test:unit/wave4/parity)"
    },
    "desktop.splash-failed.style|windows|ja|global": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "桌面视觉/动态录屏取证受锁屏限制,按 lead 集中批捕预案(2026-07-20)延后;本支合并条件=机器门禁全绿(coverage/typecheck/test:unit/wave4/parity)"
    },
    "desktop.splash-failed.style|windows|ko|cn": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "桌面视觉/动态录屏取证受锁屏限制,按 lead 集中批捕预案(2026-07-20)延后;本支合并条件=机器门禁全绿(coverage/typecheck/test:unit/wave4/parity)"
    },
    "desktop.splash-failed.style|windows|ko|global": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "桌面视觉/动态录屏取证受锁屏限制,按 lead 集中批捕预案(2026-07-20)延后;本支合并条件=机器门禁全绿(coverage/typecheck/test:unit/wave4/parity)"
    },
    "desktop.splash-brand.state|mac|zh-CN|cn": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "桌面视觉/动态录屏取证受锁屏限制,按 lead 集中批捕预案(2026-07-20)延后;本支合并条件=机器门禁全绿(coverage/typecheck/test:unit/wave4/parity)"
    },
    "desktop.splash-brand.state|mac|zh-CN|global": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "桌面视觉/动态录屏取证受锁屏限制,按 lead 集中批捕预案(2026-07-20)延后;本支合并条件=机器门禁全绿(coverage/typecheck/test:unit/wave4/parity)"
    },
    "desktop.splash-brand.state|mac|zh-TW|cn": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "桌面视觉/动态录屏取证受锁屏限制,按 lead 集中批捕预案(2026-07-20)延后;本支合并条件=机器门禁全绿(coverage/typecheck/test:unit/wave4/parity)"
    },
    "desktop.splash-brand.state|mac|zh-TW|global": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "桌面视觉/动态录屏取证受锁屏限制,按 lead 集中批捕预案(2026-07-20)延后;本支合并条件=机器门禁全绿(coverage/typecheck/test:unit/wave4/parity)"
    },
    "desktop.splash-brand.state|mac|en|cn": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "桌面视觉/动态录屏取证受锁屏限制,按 lead 集中批捕预案(2026-07-20)延后;本支合并条件=机器门禁全绿(coverage/typecheck/test:unit/wave4/parity)"
    },
    "desktop.splash-brand.state|mac|en|global": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "桌面视觉/动态录屏取证受锁屏限制,按 lead 集中批捕预案(2026-07-20)延后;本支合并条件=机器门禁全绿(coverage/typecheck/test:unit/wave4/parity)"
    },
    "desktop.splash-brand.state|mac|ja|cn": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "桌面视觉/动态录屏取证受锁屏限制,按 lead 集中批捕预案(2026-07-20)延后;本支合并条件=机器门禁全绿(coverage/typecheck/test:unit/wave4/parity)"
    },
    "desktop.splash-brand.state|mac|ja|global": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "桌面视觉/动态录屏取证受锁屏限制,按 lead 集中批捕预案(2026-07-20)延后;本支合并条件=机器门禁全绿(coverage/typecheck/test:unit/wave4/parity)"
    },
    "desktop.splash-brand.state|mac|ko|cn": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "桌面视觉/动态录屏取证受锁屏限制,按 lead 集中批捕预案(2026-07-20)延后;本支合并条件=机器门禁全绿(coverage/typecheck/test:unit/wave4/parity)"
    },
    "desktop.splash-brand.state|mac|ko|global": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "桌面视觉/动态录屏取证受锁屏限制,按 lead 集中批捕预案(2026-07-20)延后;本支合并条件=机器门禁全绿(coverage/typecheck/test:unit/wave4/parity)"
    },
    "desktop.splash-brand.state|windows|zh-CN|cn": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "桌面视觉/动态录屏取证受锁屏限制,按 lead 集中批捕预案(2026-07-20)延后;本支合并条件=机器门禁全绿(coverage/typecheck/test:unit/wave4/parity)"
    },
    "desktop.splash-brand.state|windows|zh-CN|global": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "桌面视觉/动态录屏取证受锁屏限制,按 lead 集中批捕预案(2026-07-20)延后;本支合并条件=机器门禁全绿(coverage/typecheck/test:unit/wave4/parity)"
    },
    "desktop.splash-brand.state|windows|zh-TW|cn": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "桌面视觉/动态录屏取证受锁屏限制,按 lead 集中批捕预案(2026-07-20)延后;本支合并条件=机器门禁全绿(coverage/typecheck/test:unit/wave4/parity)"
    },
    "desktop.splash-brand.state|windows|zh-TW|global": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "桌面视觉/动态录屏取证受锁屏限制,按 lead 集中批捕预案(2026-07-20)延后;本支合并条件=机器门禁全绿(coverage/typecheck/test:unit/wave4/parity)"
    },
    "desktop.splash-brand.state|windows|en|cn": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "桌面视觉/动态录屏取证受锁屏限制,按 lead 集中批捕预案(2026-07-20)延后;本支合并条件=机器门禁全绿(coverage/typecheck/test:unit/wave4/parity)"
    },
    "desktop.splash-brand.state|windows|en|global": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "桌面视觉/动态录屏取证受锁屏限制,按 lead 集中批捕预案(2026-07-20)延后;本支合并条件=机器门禁全绿(coverage/typecheck/test:unit/wave4/parity)"
    },
    "desktop.splash-brand.state|windows|ja|cn": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "桌面视觉/动态录屏取证受锁屏限制,按 lead 集中批捕预案(2026-07-20)延后;本支合并条件=机器门禁全绿(coverage/typecheck/test:unit/wave4/parity)"
    },
    "desktop.splash-brand.state|windows|ja|global": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "桌面视觉/动态录屏取证受锁屏限制,按 lead 集中批捕预案(2026-07-20)延后;本支合并条件=机器门禁全绿(coverage/typecheck/test:unit/wave4/parity)"
    },
    "desktop.splash-brand.state|windows|ko|cn": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "桌面视觉/动态录屏取证受锁屏限制,按 lead 集中批捕预案(2026-07-20)延后;本支合并条件=机器门禁全绿(coverage/typecheck/test:unit/wave4/parity)"
    },
    "desktop.splash-brand.state|windows|ko|global": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "桌面视觉/动态录屏取证受锁屏限制,按 lead 集中批捕预案(2026-07-20)延后;本支合并条件=机器门禁全绿(coverage/typecheck/test:unit/wave4/parity)"
    },
    "desktop.handoff.timing|mac|zh-CN|cn": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "桌面视觉/动态录屏取证受锁屏限制,按 lead 集中批捕预案(2026-07-20)延后;本支合并条件=机器门禁全绿(coverage/typecheck/test:unit/wave4/parity)"
    },
    "desktop.handoff.timing|mac|zh-CN|global": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "桌面视觉/动态录屏取证受锁屏限制,按 lead 集中批捕预案(2026-07-20)延后;本支合并条件=机器门禁全绿(coverage/typecheck/test:unit/wave4/parity)"
    },
    "desktop.handoff.timing|mac|zh-TW|cn": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "桌面视觉/动态录屏取证受锁屏限制,按 lead 集中批捕预案(2026-07-20)延后;本支合并条件=机器门禁全绿(coverage/typecheck/test:unit/wave4/parity)"
    },
    "desktop.handoff.timing|mac|zh-TW|global": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "桌面视觉/动态录屏取证受锁屏限制,按 lead 集中批捕预案(2026-07-20)延后;本支合并条件=机器门禁全绿(coverage/typecheck/test:unit/wave4/parity)"
    },
    "desktop.handoff.timing|mac|en|cn": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "桌面视觉/动态录屏取证受锁屏限制,按 lead 集中批捕预案(2026-07-20)延后;本支合并条件=机器门禁全绿(coverage/typecheck/test:unit/wave4/parity)"
    },
    "desktop.handoff.timing|mac|en|global": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "桌面视觉/动态录屏取证受锁屏限制,按 lead 集中批捕预案(2026-07-20)延后;本支合并条件=机器门禁全绿(coverage/typecheck/test:unit/wave4/parity)"
    },
    "desktop.handoff.timing|mac|ja|cn": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "桌面视觉/动态录屏取证受锁屏限制,按 lead 集中批捕预案(2026-07-20)延后;本支合并条件=机器门禁全绿(coverage/typecheck/test:unit/wave4/parity)"
    },
    "desktop.handoff.timing|mac|ja|global": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "桌面视觉/动态录屏取证受锁屏限制,按 lead 集中批捕预案(2026-07-20)延后;本支合并条件=机器门禁全绿(coverage/typecheck/test:unit/wave4/parity)"
    },
    "desktop.handoff.timing|mac|ko|cn": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "桌面视觉/动态录屏取证受锁屏限制,按 lead 集中批捕预案(2026-07-20)延后;本支合并条件=机器门禁全绿(coverage/typecheck/test:unit/wave4/parity)"
    },
    "desktop.handoff.timing|mac|ko|global": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "桌面视觉/动态录屏取证受锁屏限制,按 lead 集中批捕预案(2026-07-20)延后;本支合并条件=机器门禁全绿(coverage/typecheck/test:unit/wave4/parity)"
    },
    "desktop.handoff.timing|windows|zh-CN|cn": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "桌面视觉/动态录屏取证受锁屏限制,按 lead 集中批捕预案(2026-07-20)延后;本支合并条件=机器门禁全绿(coverage/typecheck/test:unit/wave4/parity)"
    },
    "desktop.handoff.timing|windows|zh-CN|global": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "桌面视觉/动态录屏取证受锁屏限制,按 lead 集中批捕预案(2026-07-20)延后;本支合并条件=机器门禁全绿(coverage/typecheck/test:unit/wave4/parity)"
    },
    "desktop.handoff.timing|windows|zh-TW|cn": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "桌面视觉/动态录屏取证受锁屏限制,按 lead 集中批捕预案(2026-07-20)延后;本支合并条件=机器门禁全绿(coverage/typecheck/test:unit/wave4/parity)"
    },
    "desktop.handoff.timing|windows|zh-TW|global": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "桌面视觉/动态录屏取证受锁屏限制,按 lead 集中批捕预案(2026-07-20)延后;本支合并条件=机器门禁全绿(coverage/typecheck/test:unit/wave4/parity)"
    },
    "desktop.handoff.timing|windows|en|cn": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "桌面视觉/动态录屏取证受锁屏限制,按 lead 集中批捕预案(2026-07-20)延后;本支合并条件=机器门禁全绿(coverage/typecheck/test:unit/wave4/parity)"
    },
    "desktop.handoff.timing|windows|en|global": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "桌面视觉/动态录屏取证受锁屏限制,按 lead 集中批捕预案(2026-07-20)延后;本支合并条件=机器门禁全绿(coverage/typecheck/test:unit/wave4/parity)"
    },
    "desktop.handoff.timing|windows|ja|cn": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "桌面视觉/动态录屏取证受锁屏限制,按 lead 集中批捕预案(2026-07-20)延后;本支合并条件=机器门禁全绿(coverage/typecheck/test:unit/wave4/parity)"
    },
    "desktop.handoff.timing|windows|ja|global": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "桌面视觉/动态录屏取证受锁屏限制,按 lead 集中批捕预案(2026-07-20)延后;本支合并条件=机器门禁全绿(coverage/typecheck/test:unit/wave4/parity)"
    },
    "desktop.handoff.timing|windows|ko|cn": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "桌面视觉/动态录屏取证受锁屏限制,按 lead 集中批捕预案(2026-07-20)延后;本支合并条件=机器门禁全绿(coverage/typecheck/test:unit/wave4/parity)"
    },
    "desktop.handoff.timing|windows|ko|global": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "桌面视觉/动态录屏取证受锁屏限制,按 lead 集中批捕预案(2026-07-20)延后;本支合并条件=机器门禁全绿(coverage/typecheck/test:unit/wave4/parity)"
    },
    "desktop.handoff-reduced-motion.state|mac|zh-CN|cn": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "桌面视觉/动态录屏取证受锁屏限制,按 lead 集中批捕预案(2026-07-20)延后;本支合并条件=机器门禁全绿(coverage/typecheck/test:unit/wave4/parity)"
    },
    "desktop.handoff-reduced-motion.state|mac|zh-CN|global": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "桌面视觉/动态录屏取证受锁屏限制,按 lead 集中批捕预案(2026-07-20)延后;本支合并条件=机器门禁全绿(coverage/typecheck/test:unit/wave4/parity)"
    },
    "desktop.handoff-reduced-motion.state|mac|zh-TW|cn": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "桌面视觉/动态录屏取证受锁屏限制,按 lead 集中批捕预案(2026-07-20)延后;本支合并条件=机器门禁全绿(coverage/typecheck/test:unit/wave4/parity)"
    },
    "desktop.handoff-reduced-motion.state|mac|zh-TW|global": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "桌面视觉/动态录屏取证受锁屏限制,按 lead 集中批捕预案(2026-07-20)延后;本支合并条件=机器门禁全绿(coverage/typecheck/test:unit/wave4/parity)"
    },
    "desktop.handoff-reduced-motion.state|mac|en|cn": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "桌面视觉/动态录屏取证受锁屏限制,按 lead 集中批捕预案(2026-07-20)延后;本支合并条件=机器门禁全绿(coverage/typecheck/test:unit/wave4/parity)"
    },
    "desktop.handoff-reduced-motion.state|mac|en|global": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "桌面视觉/动态录屏取证受锁屏限制,按 lead 集中批捕预案(2026-07-20)延后;本支合并条件=机器门禁全绿(coverage/typecheck/test:unit/wave4/parity)"
    },
    "desktop.handoff-reduced-motion.state|mac|ja|cn": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "桌面视觉/动态录屏取证受锁屏限制,按 lead 集中批捕预案(2026-07-20)延后;本支合并条件=机器门禁全绿(coverage/typecheck/test:unit/wave4/parity)"
    },
    "desktop.handoff-reduced-motion.state|mac|ja|global": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "桌面视觉/动态录屏取证受锁屏限制,按 lead 集中批捕预案(2026-07-20)延后;本支合并条件=机器门禁全绿(coverage/typecheck/test:unit/wave4/parity)"
    },
    "desktop.handoff-reduced-motion.state|mac|ko|cn": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "桌面视觉/动态录屏取证受锁屏限制,按 lead 集中批捕预案(2026-07-20)延后;本支合并条件=机器门禁全绿(coverage/typecheck/test:unit/wave4/parity)"
    },
    "desktop.handoff-reduced-motion.state|mac|ko|global": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "桌面视觉/动态录屏取证受锁屏限制,按 lead 集中批捕预案(2026-07-20)延后;本支合并条件=机器门禁全绿(coverage/typecheck/test:unit/wave4/parity)"
    },
    "desktop.handoff-reduced-motion.state|windows|zh-CN|cn": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "桌面视觉/动态录屏取证受锁屏限制,按 lead 集中批捕预案(2026-07-20)延后;本支合并条件=机器门禁全绿(coverage/typecheck/test:unit/wave4/parity)"
    },
    "desktop.handoff-reduced-motion.state|windows|zh-CN|global": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "桌面视觉/动态录屏取证受锁屏限制,按 lead 集中批捕预案(2026-07-20)延后;本支合并条件=机器门禁全绿(coverage/typecheck/test:unit/wave4/parity)"
    },
    "desktop.handoff-reduced-motion.state|windows|zh-TW|cn": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "桌面视觉/动态录屏取证受锁屏限制,按 lead 集中批捕预案(2026-07-20)延后;本支合并条件=机器门禁全绿(coverage/typecheck/test:unit/wave4/parity)"
    },
    "desktop.handoff-reduced-motion.state|windows|zh-TW|global": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "桌面视觉/动态录屏取证受锁屏限制,按 lead 集中批捕预案(2026-07-20)延后;本支合并条件=机器门禁全绿(coverage/typecheck/test:unit/wave4/parity)"
    },
    "desktop.handoff-reduced-motion.state|windows|en|cn": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "桌面视觉/动态录屏取证受锁屏限制,按 lead 集中批捕预案(2026-07-20)延后;本支合并条件=机器门禁全绿(coverage/typecheck/test:unit/wave4/parity)"
    },
    "desktop.handoff-reduced-motion.state|windows|en|global": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "桌面视觉/动态录屏取证受锁屏限制,按 lead 集中批捕预案(2026-07-20)延后;本支合并条件=机器门禁全绿(coverage/typecheck/test:unit/wave4/parity)"
    },
    "desktop.handoff-reduced-motion.state|windows|ja|cn": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "桌面视觉/动态录屏取证受锁屏限制,按 lead 集中批捕预案(2026-07-20)延后;本支合并条件=机器门禁全绿(coverage/typecheck/test:unit/wave4/parity)"
    },
    "desktop.handoff-reduced-motion.state|windows|ja|global": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "桌面视觉/动态录屏取证受锁屏限制,按 lead 集中批捕预案(2026-07-20)延后;本支合并条件=机器门禁全绿(coverage/typecheck/test:unit/wave4/parity)"
    },
    "desktop.handoff-reduced-motion.state|windows|ko|cn": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "桌面视觉/动态录屏取证受锁屏限制,按 lead 集中批捕预案(2026-07-20)延后;本支合并条件=机器门禁全绿(coverage/typecheck/test:unit/wave4/parity)"
    },
    "desktop.handoff-reduced-motion.state|windows|ko|global": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "桌面视觉/动态录屏取证受锁屏限制,按 lead 集中批捕预案(2026-07-20)延后;本支合并条件=机器门禁全绿(coverage/typecheck/test:unit/wave4/parity)"
    },
    "desktop.splash-chain.state|mac|zh-CN|cn": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "桌面视觉/动态录屏取证受锁屏限制,按 lead 集中批捕预案(2026-07-20)延后;本支合并条件=机器门禁全绿(coverage/typecheck/test:unit/wave4/parity)"
    },
    "desktop.splash-chain.state|mac|zh-CN|global": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "桌面视觉/动态录屏取证受锁屏限制,按 lead 集中批捕预案(2026-07-20)延后;本支合并条件=机器门禁全绿(coverage/typecheck/test:unit/wave4/parity)"
    },
    "desktop.splash-chain.state|mac|zh-TW|cn": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "桌面视觉/动态录屏取证受锁屏限制,按 lead 集中批捕预案(2026-07-20)延后;本支合并条件=机器门禁全绿(coverage/typecheck/test:unit/wave4/parity)"
    },
    "desktop.splash-chain.state|mac|zh-TW|global": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "桌面视觉/动态录屏取证受锁屏限制,按 lead 集中批捕预案(2026-07-20)延后;本支合并条件=机器门禁全绿(coverage/typecheck/test:unit/wave4/parity)"
    },
    "desktop.splash-chain.state|mac|en|cn": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "桌面视觉/动态录屏取证受锁屏限制,按 lead 集中批捕预案(2026-07-20)延后;本支合并条件=机器门禁全绿(coverage/typecheck/test:unit/wave4/parity)"
    },
    "desktop.splash-chain.state|mac|en|global": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "桌面视觉/动态录屏取证受锁屏限制,按 lead 集中批捕预案(2026-07-20)延后;本支合并条件=机器门禁全绿(coverage/typecheck/test:unit/wave4/parity)"
    },
    "desktop.splash-chain.state|mac|ja|cn": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "桌面视觉/动态录屏取证受锁屏限制,按 lead 集中批捕预案(2026-07-20)延后;本支合并条件=机器门禁全绿(coverage/typecheck/test:unit/wave4/parity)"
    },
    "desktop.splash-chain.state|mac|ja|global": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "桌面视觉/动态录屏取证受锁屏限制,按 lead 集中批捕预案(2026-07-20)延后;本支合并条件=机器门禁全绿(coverage/typecheck/test:unit/wave4/parity)"
    },
    "desktop.splash-chain.state|mac|ko|cn": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "桌面视觉/动态录屏取证受锁屏限制,按 lead 集中批捕预案(2026-07-20)延后;本支合并条件=机器门禁全绿(coverage/typecheck/test:unit/wave4/parity)"
    },
    "desktop.splash-chain.state|mac|ko|global": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "桌面视觉/动态录屏取证受锁屏限制,按 lead 集中批捕预案(2026-07-20)延后;本支合并条件=机器门禁全绿(coverage/typecheck/test:unit/wave4/parity)"
    },
    "desktop.splash-chain.state|windows|zh-CN|cn": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "桌面视觉/动态录屏取证受锁屏限制,按 lead 集中批捕预案(2026-07-20)延后;本支合并条件=机器门禁全绿(coverage/typecheck/test:unit/wave4/parity)"
    },
    "desktop.splash-chain.state|windows|zh-CN|global": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "桌面视觉/动态录屏取证受锁屏限制,按 lead 集中批捕预案(2026-07-20)延后;本支合并条件=机器门禁全绿(coverage/typecheck/test:unit/wave4/parity)"
    },
    "desktop.splash-chain.state|windows|zh-TW|cn": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "桌面视觉/动态录屏取证受锁屏限制,按 lead 集中批捕预案(2026-07-20)延后;本支合并条件=机器门禁全绿(coverage/typecheck/test:unit/wave4/parity)"
    },
    "desktop.splash-chain.state|windows|zh-TW|global": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "桌面视觉/动态录屏取证受锁屏限制,按 lead 集中批捕预案(2026-07-20)延后;本支合并条件=机器门禁全绿(coverage/typecheck/test:unit/wave4/parity)"
    },
    "desktop.splash-chain.state|windows|en|cn": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "桌面视觉/动态录屏取证受锁屏限制,按 lead 集中批捕预案(2026-07-20)延后;本支合并条件=机器门禁全绿(coverage/typecheck/test:unit/wave4/parity)"
    },
    "desktop.splash-chain.state|windows|en|global": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "桌面视觉/动态录屏取证受锁屏限制,按 lead 集中批捕预案(2026-07-20)延后;本支合并条件=机器门禁全绿(coverage/typecheck/test:unit/wave4/parity)"
    },
    "desktop.splash-chain.state|windows|ja|cn": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "桌面视觉/动态录屏取证受锁屏限制,按 lead 集中批捕预案(2026-07-20)延后;本支合并条件=机器门禁全绿(coverage/typecheck/test:unit/wave4/parity)"
    },
    "desktop.splash-chain.state|windows|ja|global": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "桌面视觉/动态录屏取证受锁屏限制,按 lead 集中批捕预案(2026-07-20)延后;本支合并条件=机器门禁全绿(coverage/typecheck/test:unit/wave4/parity)"
    },
    "desktop.splash-chain.state|windows|ko|cn": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "桌面视觉/动态录屏取证受锁屏限制,按 lead 集中批捕预案(2026-07-20)延后;本支合并条件=机器门禁全绿(coverage/typecheck/test:unit/wave4/parity)"
    },
    "desktop.splash-chain.state|windows|ko|global": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "桌面视觉/动态录屏取证受锁屏限制,按 lead 集中批捕预案(2026-07-20)延后;本支合并条件=机器门禁全绿(coverage/typecheck/test:unit/wave4/parity)"
    },
    "desktop.splash-chain.copy|mac|zh-CN|cn": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "桌面视觉/动态录屏取证受锁屏限制,按 lead 集中批捕预案(2026-07-20)延后;本支合并条件=机器门禁全绿(coverage/typecheck/test:unit/wave4/parity)"
    },
    "desktop.splash-chain.copy|mac|zh-CN|global": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "桌面视觉/动态录屏取证受锁屏限制,按 lead 集中批捕预案(2026-07-20)延后;本支合并条件=机器门禁全绿(coverage/typecheck/test:unit/wave4/parity)"
    },
    "desktop.splash-chain.copy|mac|zh-TW|cn": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "桌面视觉/动态录屏取证受锁屏限制,按 lead 集中批捕预案(2026-07-20)延后;本支合并条件=机器门禁全绿(coverage/typecheck/test:unit/wave4/parity)"
    },
    "desktop.splash-chain.copy|mac|zh-TW|global": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "桌面视觉/动态录屏取证受锁屏限制,按 lead 集中批捕预案(2026-07-20)延后;本支合并条件=机器门禁全绿(coverage/typecheck/test:unit/wave4/parity)"
    },
    "desktop.splash-chain.copy|mac|en|cn": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "桌面视觉/动态录屏取证受锁屏限制,按 lead 集中批捕预案(2026-07-20)延后;本支合并条件=机器门禁全绿(coverage/typecheck/test:unit/wave4/parity)"
    },
    "desktop.splash-chain.copy|mac|en|global": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "桌面视觉/动态录屏取证受锁屏限制,按 lead 集中批捕预案(2026-07-20)延后;本支合并条件=机器门禁全绿(coverage/typecheck/test:unit/wave4/parity)"
    },
    "desktop.splash-chain.copy|mac|ja|cn": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "桌面视觉/动态录屏取证受锁屏限制,按 lead 集中批捕预案(2026-07-20)延后;本支合并条件=机器门禁全绿(coverage/typecheck/test:unit/wave4/parity)"
    },
    "desktop.splash-chain.copy|mac|ja|global": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "桌面视觉/动态录屏取证受锁屏限制,按 lead 集中批捕预案(2026-07-20)延后;本支合并条件=机器门禁全绿(coverage/typecheck/test:unit/wave4/parity)"
    },
    "desktop.splash-chain.copy|mac|ko|cn": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "桌面视觉/动态录屏取证受锁屏限制,按 lead 集中批捕预案(2026-07-20)延后;本支合并条件=机器门禁全绿(coverage/typecheck/test:unit/wave4/parity)"
    },
    "desktop.splash-chain.copy|mac|ko|global": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "桌面视觉/动态录屏取证受锁屏限制,按 lead 集中批捕预案(2026-07-20)延后;本支合并条件=机器门禁全绿(coverage/typecheck/test:unit/wave4/parity)"
    },
    "desktop.splash-chain.copy|windows|zh-CN|cn": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "桌面视觉/动态录屏取证受锁屏限制,按 lead 集中批捕预案(2026-07-20)延后;本支合并条件=机器门禁全绿(coverage/typecheck/test:unit/wave4/parity)"
    },
    "desktop.splash-chain.copy|windows|zh-CN|global": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "桌面视觉/动态录屏取证受锁屏限制,按 lead 集中批捕预案(2026-07-20)延后;本支合并条件=机器门禁全绿(coverage/typecheck/test:unit/wave4/parity)"
    },
    "desktop.splash-chain.copy|windows|zh-TW|cn": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "桌面视觉/动态录屏取证受锁屏限制,按 lead 集中批捕预案(2026-07-20)延后;本支合并条件=机器门禁全绿(coverage/typecheck/test:unit/wave4/parity)"
    },
    "desktop.splash-chain.copy|windows|zh-TW|global": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "桌面视觉/动态录屏取证受锁屏限制,按 lead 集中批捕预案(2026-07-20)延后;本支合并条件=机器门禁全绿(coverage/typecheck/test:unit/wave4/parity)"
    },
    "desktop.splash-chain.copy|windows|en|cn": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "桌面视觉/动态录屏取证受锁屏限制,按 lead 集中批捕预案(2026-07-20)延后;本支合并条件=机器门禁全绿(coverage/typecheck/test:unit/wave4/parity)"
    },
    "desktop.splash-chain.copy|windows|en|global": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "桌面视觉/动态录屏取证受锁屏限制,按 lead 集中批捕预案(2026-07-20)延后;本支合并条件=机器门禁全绿(coverage/typecheck/test:unit/wave4/parity)"
    },
    "desktop.splash-chain.copy|windows|ja|cn": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "桌面视觉/动态录屏取证受锁屏限制,按 lead 集中批捕预案(2026-07-20)延后;本支合并条件=机器门禁全绿(coverage/typecheck/test:unit/wave4/parity)"
    },
    "desktop.splash-chain.copy|windows|ja|global": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "桌面视觉/动态录屏取证受锁屏限制,按 lead 集中批捕预案(2026-07-20)延后;本支合并条件=机器门禁全绿(coverage/typecheck/test:unit/wave4/parity)"
    },
    "desktop.splash-chain.copy|windows|ko|cn": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "桌面视觉/动态录屏取证受锁屏限制,按 lead 集中批捕预案(2026-07-20)延后;本支合并条件=机器门禁全绿(coverage/typecheck/test:unit/wave4/parity)"
    },
    "desktop.splash-chain.copy|windows|ko|global": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "桌面视觉/动态录屏取证受锁屏限制,按 lead 集中批捕预案(2026-07-20)延后;本支合并条件=机器门禁全绿(coverage/typecheck/test:unit/wave4/parity)"
    },
    "desktop.splash-manifest-failed.state|mac|zh-CN|cn": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "桌面视觉/动态录屏取证受锁屏限制,按 lead 集中批捕预案(2026-07-20)延后;本支合并条件=机器门禁全绿(coverage/typecheck/test:unit/wave4/parity)"
    },
    "desktop.splash-manifest-failed.state|mac|zh-CN|global": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "桌面视觉/动态录屏取证受锁屏限制,按 lead 集中批捕预案(2026-07-20)延后;本支合并条件=机器门禁全绿(coverage/typecheck/test:unit/wave4/parity)"
    },
    "desktop.splash-manifest-failed.state|mac|zh-TW|cn": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "桌面视觉/动态录屏取证受锁屏限制,按 lead 集中批捕预案(2026-07-20)延后;本支合并条件=机器门禁全绿(coverage/typecheck/test:unit/wave4/parity)"
    },
    "desktop.splash-manifest-failed.state|mac|zh-TW|global": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "桌面视觉/动态录屏取证受锁屏限制,按 lead 集中批捕预案(2026-07-20)延后;本支合并条件=机器门禁全绿(coverage/typecheck/test:unit/wave4/parity)"
    },
    "desktop.splash-manifest-failed.state|mac|en|cn": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "桌面视觉/动态录屏取证受锁屏限制,按 lead 集中批捕预案(2026-07-20)延后;本支合并条件=机器门禁全绿(coverage/typecheck/test:unit/wave4/parity)"
    },
    "desktop.splash-manifest-failed.state|mac|en|global": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "桌面视觉/动态录屏取证受锁屏限制,按 lead 集中批捕预案(2026-07-20)延后;本支合并条件=机器门禁全绿(coverage/typecheck/test:unit/wave4/parity)"
    },
    "desktop.splash-manifest-failed.state|mac|ja|cn": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "桌面视觉/动态录屏取证受锁屏限制,按 lead 集中批捕预案(2026-07-20)延后;本支合并条件=机器门禁全绿(coverage/typecheck/test:unit/wave4/parity)"
    },
    "desktop.splash-manifest-failed.state|mac|ja|global": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "桌面视觉/动态录屏取证受锁屏限制,按 lead 集中批捕预案(2026-07-20)延后;本支合并条件=机器门禁全绿(coverage/typecheck/test:unit/wave4/parity)"
    },
    "desktop.splash-manifest-failed.state|mac|ko|cn": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "桌面视觉/动态录屏取证受锁屏限制,按 lead 集中批捕预案(2026-07-20)延后;本支合并条件=机器门禁全绿(coverage/typecheck/test:unit/wave4/parity)"
    },
    "desktop.splash-manifest-failed.state|mac|ko|global": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "桌面视觉/动态录屏取证受锁屏限制,按 lead 集中批捕预案(2026-07-20)延后;本支合并条件=机器门禁全绿(coverage/typecheck/test:unit/wave4/parity)"
    },
    "desktop.splash-manifest-failed.state|windows|zh-CN|cn": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "桌面视觉/动态录屏取证受锁屏限制,按 lead 集中批捕预案(2026-07-20)延后;本支合并条件=机器门禁全绿(coverage/typecheck/test:unit/wave4/parity)"
    },
    "desktop.splash-manifest-failed.state|windows|zh-CN|global": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "桌面视觉/动态录屏取证受锁屏限制,按 lead 集中批捕预案(2026-07-20)延后;本支合并条件=机器门禁全绿(coverage/typecheck/test:unit/wave4/parity)"
    },
    "desktop.splash-manifest-failed.state|windows|zh-TW|cn": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "桌面视觉/动态录屏取证受锁屏限制,按 lead 集中批捕预案(2026-07-20)延后;本支合并条件=机器门禁全绿(coverage/typecheck/test:unit/wave4/parity)"
    },
    "desktop.splash-manifest-failed.state|windows|zh-TW|global": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "桌面视觉/动态录屏取证受锁屏限制,按 lead 集中批捕预案(2026-07-20)延后;本支合并条件=机器门禁全绿(coverage/typecheck/test:unit/wave4/parity)"
    },
    "desktop.splash-manifest-failed.state|windows|en|cn": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "桌面视觉/动态录屏取证受锁屏限制,按 lead 集中批捕预案(2026-07-20)延后;本支合并条件=机器门禁全绿(coverage/typecheck/test:unit/wave4/parity)"
    },
    "desktop.splash-manifest-failed.state|windows|en|global": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "桌面视觉/动态录屏取证受锁屏限制,按 lead 集中批捕预案(2026-07-20)延后;本支合并条件=机器门禁全绿(coverage/typecheck/test:unit/wave4/parity)"
    },
    "desktop.splash-manifest-failed.state|windows|ja|cn": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "桌面视觉/动态录屏取证受锁屏限制,按 lead 集中批捕预案(2026-07-20)延后;本支合并条件=机器门禁全绿(coverage/typecheck/test:unit/wave4/parity)"
    },
    "desktop.splash-manifest-failed.state|windows|ja|global": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "桌面视觉/动态录屏取证受锁屏限制,按 lead 集中批捕预案(2026-07-20)延后;本支合并条件=机器门禁全绿(coverage/typecheck/test:unit/wave4/parity)"
    },
    "desktop.splash-manifest-failed.state|windows|ko|cn": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "桌面视觉/动态录屏取证受锁屏限制,按 lead 集中批捕预案(2026-07-20)延后;本支合并条件=机器门禁全绿(coverage/typecheck/test:unit/wave4/parity)"
    },
    "desktop.splash-manifest-failed.state|windows|ko|global": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "桌面视觉/动态录屏取证受锁屏限制,按 lead 集中批捕预案(2026-07-20)延后;本支合并条件=机器门禁全绿(coverage/typecheck/test:unit/wave4/parity)"
    },
    "desktop.splash-download-failed.state|mac|zh-CN|cn": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "桌面视觉/动态录屏取证受锁屏限制,按 lead 集中批捕预案(2026-07-20)延后;本支合并条件=机器门禁全绿(coverage/typecheck/test:unit/wave4/parity)"
    },
    "desktop.splash-download-failed.state|mac|zh-CN|global": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "桌面视觉/动态录屏取证受锁屏限制,按 lead 集中批捕预案(2026-07-20)延后;本支合并条件=机器门禁全绿(coverage/typecheck/test:unit/wave4/parity)"
    },
    "desktop.splash-download-failed.state|mac|zh-TW|cn": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "桌面视觉/动态录屏取证受锁屏限制,按 lead 集中批捕预案(2026-07-20)延后;本支合并条件=机器门禁全绿(coverage/typecheck/test:unit/wave4/parity)"
    },
    "desktop.splash-download-failed.state|mac|zh-TW|global": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "桌面视觉/动态录屏取证受锁屏限制,按 lead 集中批捕预案(2026-07-20)延后;本支合并条件=机器门禁全绿(coverage/typecheck/test:unit/wave4/parity)"
    },
    "desktop.splash-download-failed.state|mac|en|cn": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "桌面视觉/动态录屏取证受锁屏限制,按 lead 集中批捕预案(2026-07-20)延后;本支合并条件=机器门禁全绿(coverage/typecheck/test:unit/wave4/parity)"
    },
    "desktop.splash-download-failed.state|mac|en|global": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "桌面视觉/动态录屏取证受锁屏限制,按 lead 集中批捕预案(2026-07-20)延后;本支合并条件=机器门禁全绿(coverage/typecheck/test:unit/wave4/parity)"
    },
    "desktop.splash-download-failed.state|mac|ja|cn": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "桌面视觉/动态录屏取证受锁屏限制,按 lead 集中批捕预案(2026-07-20)延后;本支合并条件=机器门禁全绿(coverage/typecheck/test:unit/wave4/parity)"
    },
    "desktop.splash-download-failed.state|mac|ja|global": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "桌面视觉/动态录屏取证受锁屏限制,按 lead 集中批捕预案(2026-07-20)延后;本支合并条件=机器门禁全绿(coverage/typecheck/test:unit/wave4/parity)"
    },
    "desktop.splash-download-failed.state|mac|ko|cn": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "桌面视觉/动态录屏取证受锁屏限制,按 lead 集中批捕预案(2026-07-20)延后;本支合并条件=机器门禁全绿(coverage/typecheck/test:unit/wave4/parity)"
    },
    "desktop.splash-download-failed.state|mac|ko|global": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "桌面视觉/动态录屏取证受锁屏限制,按 lead 集中批捕预案(2026-07-20)延后;本支合并条件=机器门禁全绿(coverage/typecheck/test:unit/wave4/parity)"
    },
    "desktop.splash-download-failed.state|windows|zh-CN|cn": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "桌面视觉/动态录屏取证受锁屏限制,按 lead 集中批捕预案(2026-07-20)延后;本支合并条件=机器门禁全绿(coverage/typecheck/test:unit/wave4/parity)"
    },
    "desktop.splash-download-failed.state|windows|zh-CN|global": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "桌面视觉/动态录屏取证受锁屏限制,按 lead 集中批捕预案(2026-07-20)延后;本支合并条件=机器门禁全绿(coverage/typecheck/test:unit/wave4/parity)"
    },
    "desktop.splash-download-failed.state|windows|zh-TW|cn": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "桌面视觉/动态录屏取证受锁屏限制,按 lead 集中批捕预案(2026-07-20)延后;本支合并条件=机器门禁全绿(coverage/typecheck/test:unit/wave4/parity)"
    },
    "desktop.splash-download-failed.state|windows|zh-TW|global": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "桌面视觉/动态录屏取证受锁屏限制,按 lead 集中批捕预案(2026-07-20)延后;本支合并条件=机器门禁全绿(coverage/typecheck/test:unit/wave4/parity)"
    },
    "desktop.splash-download-failed.state|windows|en|cn": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "桌面视觉/动态录屏取证受锁屏限制,按 lead 集中批捕预案(2026-07-20)延后;本支合并条件=机器门禁全绿(coverage/typecheck/test:unit/wave4/parity)"
    },
    "desktop.splash-download-failed.state|windows|en|global": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "桌面视觉/动态录屏取证受锁屏限制,按 lead 集中批捕预案(2026-07-20)延后;本支合并条件=机器门禁全绿(coverage/typecheck/test:unit/wave4/parity)"
    },
    "desktop.splash-download-failed.state|windows|ja|cn": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "桌面视觉/动态录屏取证受锁屏限制,按 lead 集中批捕预案(2026-07-20)延后;本支合并条件=机器门禁全绿(coverage/typecheck/test:unit/wave4/parity)"
    },
    "desktop.splash-download-failed.state|windows|ja|global": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "桌面视觉/动态录屏取证受锁屏限制,按 lead 集中批捕预案(2026-07-20)延后;本支合并条件=机器门禁全绿(coverage/typecheck/test:unit/wave4/parity)"
    },
    "desktop.splash-download-failed.state|windows|ko|cn": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "桌面视觉/动态录屏取证受锁屏限制,按 lead 集中批捕预案(2026-07-20)延后;本支合并条件=机器门禁全绿(coverage/typecheck/test:unit/wave4/parity)"
    },
    "desktop.splash-download-failed.state|windows|ko|global": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "桌面视觉/动态录屏取证受锁屏限制,按 lead 集中批捕预案(2026-07-20)延后;本支合并条件=机器门禁全绿(coverage/typecheck/test:unit/wave4/parity)"
    },
    "desktop.splash-spawn-failed.state|mac|zh-CN|cn": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "桌面视觉/动态录屏取证受锁屏限制,按 lead 集中批捕预案(2026-07-20)延后;本支合并条件=机器门禁全绿(coverage/typecheck/test:unit/wave4/parity)"
    },
    "desktop.splash-spawn-failed.state|mac|zh-CN|global": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "桌面视觉/动态录屏取证受锁屏限制,按 lead 集中批捕预案(2026-07-20)延后;本支合并条件=机器门禁全绿(coverage/typecheck/test:unit/wave4/parity)"
    },
    "desktop.splash-spawn-failed.state|mac|zh-TW|cn": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "桌面视觉/动态录屏取证受锁屏限制,按 lead 集中批捕预案(2026-07-20)延后;本支合并条件=机器门禁全绿(coverage/typecheck/test:unit/wave4/parity)"
    },
    "desktop.splash-spawn-failed.state|mac|zh-TW|global": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "桌面视觉/动态录屏取证受锁屏限制,按 lead 集中批捕预案(2026-07-20)延后;本支合并条件=机器门禁全绿(coverage/typecheck/test:unit/wave4/parity)"
    },
    "desktop.splash-spawn-failed.state|mac|en|cn": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "桌面视觉/动态录屏取证受锁屏限制,按 lead 集中批捕预案(2026-07-20)延后;本支合并条件=机器门禁全绿(coverage/typecheck/test:unit/wave4/parity)"
    },
    "desktop.splash-spawn-failed.state|mac|en|global": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "桌面视觉/动态录屏取证受锁屏限制,按 lead 集中批捕预案(2026-07-20)延后;本支合并条件=机器门禁全绿(coverage/typecheck/test:unit/wave4/parity)"
    },
    "desktop.splash-spawn-failed.state|mac|ja|cn": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "桌面视觉/动态录屏取证受锁屏限制,按 lead 集中批捕预案(2026-07-20)延后;本支合并条件=机器门禁全绿(coverage/typecheck/test:unit/wave4/parity)"
    },
    "desktop.splash-spawn-failed.state|mac|ja|global": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "桌面视觉/动态录屏取证受锁屏限制,按 lead 集中批捕预案(2026-07-20)延后;本支合并条件=机器门禁全绿(coverage/typecheck/test:unit/wave4/parity)"
    },
    "desktop.splash-spawn-failed.state|mac|ko|cn": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "桌面视觉/动态录屏取证受锁屏限制,按 lead 集中批捕预案(2026-07-20)延后;本支合并条件=机器门禁全绿(coverage/typecheck/test:unit/wave4/parity)"
    },
    "desktop.splash-spawn-failed.state|mac|ko|global": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "桌面视觉/动态录屏取证受锁屏限制,按 lead 集中批捕预案(2026-07-20)延后;本支合并条件=机器门禁全绿(coverage/typecheck/test:unit/wave4/parity)"
    },
    "desktop.splash-spawn-failed.state|windows|zh-CN|cn": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "桌面视觉/动态录屏取证受锁屏限制,按 lead 集中批捕预案(2026-07-20)延后;本支合并条件=机器门禁全绿(coverage/typecheck/test:unit/wave4/parity)"
    },
    "desktop.splash-spawn-failed.state|windows|zh-CN|global": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "桌面视觉/动态录屏取证受锁屏限制,按 lead 集中批捕预案(2026-07-20)延后;本支合并条件=机器门禁全绿(coverage/typecheck/test:unit/wave4/parity)"
    },
    "desktop.splash-spawn-failed.state|windows|zh-TW|cn": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "桌面视觉/动态录屏取证受锁屏限制,按 lead 集中批捕预案(2026-07-20)延后;本支合并条件=机器门禁全绿(coverage/typecheck/test:unit/wave4/parity)"
    },
    "desktop.splash-spawn-failed.state|windows|zh-TW|global": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "桌面视觉/动态录屏取证受锁屏限制,按 lead 集中批捕预案(2026-07-20)延后;本支合并条件=机器门禁全绿(coverage/typecheck/test:unit/wave4/parity)"
    },
    "desktop.splash-spawn-failed.state|windows|en|cn": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "桌面视觉/动态录屏取证受锁屏限制,按 lead 集中批捕预案(2026-07-20)延后;本支合并条件=机器门禁全绿(coverage/typecheck/test:unit/wave4/parity)"
    },
    "desktop.splash-spawn-failed.state|windows|en|global": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "桌面视觉/动态录屏取证受锁屏限制,按 lead 集中批捕预案(2026-07-20)延后;本支合并条件=机器门禁全绿(coverage/typecheck/test:unit/wave4/parity)"
    },
    "desktop.splash-spawn-failed.state|windows|ja|cn": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "桌面视觉/动态录屏取证受锁屏限制,按 lead 集中批捕预案(2026-07-20)延后;本支合并条件=机器门禁全绿(coverage/typecheck/test:unit/wave4/parity)"
    },
    "desktop.splash-spawn-failed.state|windows|ja|global": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "桌面视觉/动态录屏取证受锁屏限制,按 lead 集中批捕预案(2026-07-20)延后;本支合并条件=机器门禁全绿(coverage/typecheck/test:unit/wave4/parity)"
    },
    "desktop.splash-spawn-failed.state|windows|ko|cn": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "桌面视觉/动态录屏取证受锁屏限制,按 lead 集中批捕预案(2026-07-20)延后;本支合并条件=机器门禁全绿(coverage/typecheck/test:unit/wave4/parity)"
    },
    "desktop.splash-spawn-failed.state|windows|ko|global": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "桌面视觉/动态录屏取证受锁屏限制,按 lead 集中批捕预案(2026-07-20)延后;本支合并条件=机器门禁全绿(coverage/typecheck/test:unit/wave4/parity)"
    },
    "mobile.gate-endpoint-error.state|iphone|zh-CN|cn": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "PR4b 派工包集中批捕预案:合并门=--preview-slice 无 schema 错误;iOS sim preflight 未打通(worker 环境无代码签名证书 + CocoaPods Podfile 异常),全格实拍证据由后续验收批次(双 AI 验收/QA)补录,--final 前必须清零"
    },
    "mobile.gate-endpoint-error.state|iphone|zh-CN|global": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "PR4b 派工包集中批捕预案:合并门=--preview-slice 无 schema 错误;iOS sim preflight 未打通(worker 环境无代码签名证书 + CocoaPods Podfile 异常),全格实拍证据由后续验收批次(双 AI 验收/QA)补录,--final 前必须清零"
    },
    "mobile.gate-endpoint-error.state|iphone|zh-TW|cn": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "PR4b 派工包集中批捕预案:合并门=--preview-slice 无 schema 错误;iOS sim preflight 未打通(worker 环境无代码签名证书 + CocoaPods Podfile 异常),全格实拍证据由后续验收批次(双 AI 验收/QA)补录,--final 前必须清零"
    },
    "mobile.gate-endpoint-error.state|iphone|zh-TW|global": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "PR4b 派工包集中批捕预案:合并门=--preview-slice 无 schema 错误;iOS sim preflight 未打通(worker 环境无代码签名证书 + CocoaPods Podfile 异常),全格实拍证据由后续验收批次(双 AI 验收/QA)补录,--final 前必须清零"
    },
    "mobile.gate-endpoint-error.state|iphone|en|cn": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "PR4b 派工包集中批捕预案:合并门=--preview-slice 无 schema 错误;iOS sim preflight 未打通(worker 环境无代码签名证书 + CocoaPods Podfile 异常),全格实拍证据由后续验收批次(双 AI 验收/QA)补录,--final 前必须清零"
    },
    "mobile.gate-endpoint-error.state|iphone|en|global": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "PR4b 派工包集中批捕预案:合并门=--preview-slice 无 schema 错误;iOS sim preflight 未打通(worker 环境无代码签名证书 + CocoaPods Podfile 异常),全格实拍证据由后续验收批次(双 AI 验收/QA)补录,--final 前必须清零"
    },
    "mobile.gate-endpoint-error.state|iphone|ja|cn": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "PR4b 派工包集中批捕预案:合并门=--preview-slice 无 schema 错误;iOS sim preflight 未打通(worker 环境无代码签名证书 + CocoaPods Podfile 异常),全格实拍证据由后续验收批次(双 AI 验收/QA)补录,--final 前必须清零"
    },
    "mobile.gate-endpoint-error.state|iphone|ja|global": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "PR4b 派工包集中批捕预案:合并门=--preview-slice 无 schema 错误;iOS sim preflight 未打通(worker 环境无代码签名证书 + CocoaPods Podfile 异常),全格实拍证据由后续验收批次(双 AI 验收/QA)补录,--final 前必须清零"
    },
    "mobile.gate-endpoint-error.state|iphone|ko|cn": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "PR4b 派工包集中批捕预案:合并门=--preview-slice 无 schema 错误;iOS sim preflight 未打通(worker 环境无代码签名证书 + CocoaPods Podfile 异常),全格实拍证据由后续验收批次(双 AI 验收/QA)补录,--final 前必须清零"
    },
    "mobile.gate-endpoint-error.state|iphone|ko|global": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "PR4b 派工包集中批捕预案:合并门=--preview-slice 无 schema 错误;iOS sim preflight 未打通(worker 环境无代码签名证书 + CocoaPods Podfile 异常),全格实拍证据由后续验收批次(双 AI 验收/QA)补录,--final 前必须清零"
    },
    "mobile.gate-endpoint-error.state|android-phone|zh-CN|cn": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "PR4b 派工包集中批捕预案:合并门=--preview-slice 无 schema 错误;iOS sim preflight 未打通(worker 环境无代码签名证书 + CocoaPods Podfile 异常),全格实拍证据由后续验收批次(双 AI 验收/QA)补录,--final 前必须清零"
    },
    "mobile.gate-endpoint-error.state|android-phone|zh-CN|global": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "PR4b 派工包集中批捕预案:合并门=--preview-slice 无 schema 错误;iOS sim preflight 未打通(worker 环境无代码签名证书 + CocoaPods Podfile 异常),全格实拍证据由后续验收批次(双 AI 验收/QA)补录,--final 前必须清零"
    },
    "mobile.gate-endpoint-error.state|android-phone|zh-TW|cn": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "PR4b 派工包集中批捕预案:合并门=--preview-slice 无 schema 错误;iOS sim preflight 未打通(worker 环境无代码签名证书 + CocoaPods Podfile 异常),全格实拍证据由后续验收批次(双 AI 验收/QA)补录,--final 前必须清零"
    },
    "mobile.gate-endpoint-error.state|android-phone|zh-TW|global": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "PR4b 派工包集中批捕预案:合并门=--preview-slice 无 schema 错误;iOS sim preflight 未打通(worker 环境无代码签名证书 + CocoaPods Podfile 异常),全格实拍证据由后续验收批次(双 AI 验收/QA)补录,--final 前必须清零"
    },
    "mobile.gate-endpoint-error.state|android-phone|en|cn": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "PR4b 派工包集中批捕预案:合并门=--preview-slice 无 schema 错误;iOS sim preflight 未打通(worker 环境无代码签名证书 + CocoaPods Podfile 异常),全格实拍证据由后续验收批次(双 AI 验收/QA)补录,--final 前必须清零"
    },
    "mobile.gate-endpoint-error.state|android-phone|en|global": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "PR4b 派工包集中批捕预案:合并门=--preview-slice 无 schema 错误;iOS sim preflight 未打通(worker 环境无代码签名证书 + CocoaPods Podfile 异常),全格实拍证据由后续验收批次(双 AI 验收/QA)补录,--final 前必须清零"
    },
    "mobile.gate-endpoint-error.state|android-phone|ja|cn": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "PR4b 派工包集中批捕预案:合并门=--preview-slice 无 schema 错误;iOS sim preflight 未打通(worker 环境无代码签名证书 + CocoaPods Podfile 异常),全格实拍证据由后续验收批次(双 AI 验收/QA)补录,--final 前必须清零"
    },
    "mobile.gate-endpoint-error.state|android-phone|ja|global": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "PR4b 派工包集中批捕预案:合并门=--preview-slice 无 schema 错误;iOS sim preflight 未打通(worker 环境无代码签名证书 + CocoaPods Podfile 异常),全格实拍证据由后续验收批次(双 AI 验收/QA)补录,--final 前必须清零"
    },
    "mobile.gate-endpoint-error.state|android-phone|ko|cn": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "PR4b 派工包集中批捕预案:合并门=--preview-slice 无 schema 错误;iOS sim preflight 未打通(worker 环境无代码签名证书 + CocoaPods Podfile 异常),全格实拍证据由后续验收批次(双 AI 验收/QA)补录,--final 前必须清零"
    },
    "mobile.gate-endpoint-error.state|android-phone|ko|global": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "PR4b 派工包集中批捕预案:合并门=--preview-slice 无 schema 错误;iOS sim preflight 未打通(worker 环境无代码签名证书 + CocoaPods Podfile 异常),全格实拍证据由后续验收批次(双 AI 验收/QA)补录,--final 前必须清零"
    },
    "mobile.gate-endpoint-error.state|ipad|zh-CN|cn": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "PR4b 派工包集中批捕预案:合并门=--preview-slice 无 schema 错误;iOS sim preflight 未打通(worker 环境无代码签名证书 + CocoaPods Podfile 异常),全格实拍证据由后续验收批次(双 AI 验收/QA)补录,--final 前必须清零"
    },
    "mobile.gate-endpoint-error.state|ipad|zh-CN|global": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "PR4b 派工包集中批捕预案:合并门=--preview-slice 无 schema 错误;iOS sim preflight 未打通(worker 环境无代码签名证书 + CocoaPods Podfile 异常),全格实拍证据由后续验收批次(双 AI 验收/QA)补录,--final 前必须清零"
    },
    "mobile.gate-endpoint-error.state|ipad|zh-TW|cn": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "PR4b 派工包集中批捕预案:合并门=--preview-slice 无 schema 错误;iOS sim preflight 未打通(worker 环境无代码签名证书 + CocoaPods Podfile 异常),全格实拍证据由后续验收批次(双 AI 验收/QA)补录,--final 前必须清零"
    },
    "mobile.gate-endpoint-error.state|ipad|zh-TW|global": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "PR4b 派工包集中批捕预案:合并门=--preview-slice 无 schema 错误;iOS sim preflight 未打通(worker 环境无代码签名证书 + CocoaPods Podfile 异常),全格实拍证据由后续验收批次(双 AI 验收/QA)补录,--final 前必须清零"
    },
    "mobile.gate-endpoint-error.state|ipad|en|cn": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "PR4b 派工包集中批捕预案:合并门=--preview-slice 无 schema 错误;iOS sim preflight 未打通(worker 环境无代码签名证书 + CocoaPods Podfile 异常),全格实拍证据由后续验收批次(双 AI 验收/QA)补录,--final 前必须清零"
    },
    "mobile.gate-endpoint-error.state|ipad|en|global": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "PR4b 派工包集中批捕预案:合并门=--preview-slice 无 schema 错误;iOS sim preflight 未打通(worker 环境无代码签名证书 + CocoaPods Podfile 异常),全格实拍证据由后续验收批次(双 AI 验收/QA)补录,--final 前必须清零"
    },
    "mobile.gate-endpoint-error.state|ipad|ja|cn": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "PR4b 派工包集中批捕预案:合并门=--preview-slice 无 schema 错误;iOS sim preflight 未打通(worker 环境无代码签名证书 + CocoaPods Podfile 异常),全格实拍证据由后续验收批次(双 AI 验收/QA)补录,--final 前必须清零"
    },
    "mobile.gate-endpoint-error.state|ipad|ja|global": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "PR4b 派工包集中批捕预案:合并门=--preview-slice 无 schema 错误;iOS sim preflight 未打通(worker 环境无代码签名证书 + CocoaPods Podfile 异常),全格实拍证据由后续验收批次(双 AI 验收/QA)补录,--final 前必须清零"
    },
    "mobile.gate-endpoint-error.state|ipad|ko|cn": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "PR4b 派工包集中批捕预案:合并门=--preview-slice 无 schema 错误;iOS sim preflight 未打通(worker 环境无代码签名证书 + CocoaPods Podfile 异常),全格实拍证据由后续验收批次(双 AI 验收/QA)补录,--final 前必须清零"
    },
    "mobile.gate-endpoint-error.state|ipad|ko|global": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "PR4b 派工包集中批捕预案:合并门=--preview-slice 无 schema 错误;iOS sim preflight 未打通(worker 环境无代码签名证书 + CocoaPods Podfile 异常),全格实拍证据由后续验收批次(双 AI 验收/QA)补录,--final 前必须清零"
    },
    "mobile.gate-endpoint-error.state|android-pad|zh-CN|cn": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "PR4b 派工包集中批捕预案:合并门=--preview-slice 无 schema 错误;iOS sim preflight 未打通(worker 环境无代码签名证书 + CocoaPods Podfile 异常),全格实拍证据由后续验收批次(双 AI 验收/QA)补录,--final 前必须清零"
    },
    "mobile.gate-endpoint-error.state|android-pad|zh-CN|global": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "PR4b 派工包集中批捕预案:合并门=--preview-slice 无 schema 错误;iOS sim preflight 未打通(worker 环境无代码签名证书 + CocoaPods Podfile 异常),全格实拍证据由后续验收批次(双 AI 验收/QA)补录,--final 前必须清零"
    },
    "mobile.gate-endpoint-error.state|android-pad|zh-TW|cn": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "PR4b 派工包集中批捕预案:合并门=--preview-slice 无 schema 错误;iOS sim preflight 未打通(worker 环境无代码签名证书 + CocoaPods Podfile 异常),全格实拍证据由后续验收批次(双 AI 验收/QA)补录,--final 前必须清零"
    },
    "mobile.gate-endpoint-error.state|android-pad|zh-TW|global": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "PR4b 派工包集中批捕预案:合并门=--preview-slice 无 schema 错误;iOS sim preflight 未打通(worker 环境无代码签名证书 + CocoaPods Podfile 异常),全格实拍证据由后续验收批次(双 AI 验收/QA)补录,--final 前必须清零"
    },
    "mobile.gate-endpoint-error.state|android-pad|en|cn": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "PR4b 派工包集中批捕预案:合并门=--preview-slice 无 schema 错误;iOS sim preflight 未打通(worker 环境无代码签名证书 + CocoaPods Podfile 异常),全格实拍证据由后续验收批次(双 AI 验收/QA)补录,--final 前必须清零"
    },
    "mobile.gate-endpoint-error.state|android-pad|en|global": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "PR4b 派工包集中批捕预案:合并门=--preview-slice 无 schema 错误;iOS sim preflight 未打通(worker 环境无代码签名证书 + CocoaPods Podfile 异常),全格实拍证据由后续验收批次(双 AI 验收/QA)补录,--final 前必须清零"
    },
    "mobile.gate-endpoint-error.state|android-pad|ja|cn": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "PR4b 派工包集中批捕预案:合并门=--preview-slice 无 schema 错误;iOS sim preflight 未打通(worker 环境无代码签名证书 + CocoaPods Podfile 异常),全格实拍证据由后续验收批次(双 AI 验收/QA)补录,--final 前必须清零"
    },
    "mobile.gate-endpoint-error.state|android-pad|ja|global": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "PR4b 派工包集中批捕预案:合并门=--preview-slice 无 schema 错误;iOS sim preflight 未打通(worker 环境无代码签名证书 + CocoaPods Podfile 异常),全格实拍证据由后续验收批次(双 AI 验收/QA)补录,--final 前必须清零"
    },
    "mobile.gate-endpoint-error.state|android-pad|ko|cn": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "PR4b 派工包集中批捕预案:合并门=--preview-slice 无 schema 错误;iOS sim preflight 未打通(worker 环境无代码签名证书 + CocoaPods Podfile 异常),全格实拍证据由后续验收批次(双 AI 验收/QA)补录,--final 前必须清零"
    },
    "mobile.gate-endpoint-error.state|android-pad|ko|global": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "PR4b 派工包集中批捕预案:合并门=--preview-slice 无 schema 错误;iOS sim preflight 未打通(worker 环境无代码签名证书 + CocoaPods Podfile 异常),全格实拍证据由后续验收批次(双 AI 验收/QA)补录,--final 前必须清零"
    },
    "mobile.config-missing.state|iphone|zh-CN|cn": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "PR4b 派工包集中批捕预案:合并门=--preview-slice 无 schema 错误;iOS sim preflight 未打通(worker 环境无代码签名证书 + CocoaPods Podfile 异常),全格实拍证据由后续验收批次(双 AI 验收/QA)补录,--final 前必须清零"
    },
    "mobile.config-missing.state|iphone|zh-CN|global": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "PR4b 派工包集中批捕预案:合并门=--preview-slice 无 schema 错误;iOS sim preflight 未打通(worker 环境无代码签名证书 + CocoaPods Podfile 异常),全格实拍证据由后续验收批次(双 AI 验收/QA)补录,--final 前必须清零"
    },
    "mobile.config-missing.state|iphone|zh-TW|cn": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "PR4b 派工包集中批捕预案:合并门=--preview-slice 无 schema 错误;iOS sim preflight 未打通(worker 环境无代码签名证书 + CocoaPods Podfile 异常),全格实拍证据由后续验收批次(双 AI 验收/QA)补录,--final 前必须清零"
    },
    "mobile.config-missing.state|iphone|zh-TW|global": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "PR4b 派工包集中批捕预案:合并门=--preview-slice 无 schema 错误;iOS sim preflight 未打通(worker 环境无代码签名证书 + CocoaPods Podfile 异常),全格实拍证据由后续验收批次(双 AI 验收/QA)补录,--final 前必须清零"
    },
    "mobile.config-missing.state|iphone|en|cn": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "PR4b 派工包集中批捕预案:合并门=--preview-slice 无 schema 错误;iOS sim preflight 未打通(worker 环境无代码签名证书 + CocoaPods Podfile 异常),全格实拍证据由后续验收批次(双 AI 验收/QA)补录,--final 前必须清零"
    },
    "mobile.config-missing.state|iphone|en|global": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "PR4b 派工包集中批捕预案:合并门=--preview-slice 无 schema 错误;iOS sim preflight 未打通(worker 环境无代码签名证书 + CocoaPods Podfile 异常),全格实拍证据由后续验收批次(双 AI 验收/QA)补录,--final 前必须清零"
    },
    "mobile.config-missing.state|iphone|ja|cn": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "PR4b 派工包集中批捕预案:合并门=--preview-slice 无 schema 错误;iOS sim preflight 未打通(worker 环境无代码签名证书 + CocoaPods Podfile 异常),全格实拍证据由后续验收批次(双 AI 验收/QA)补录,--final 前必须清零"
    },
    "mobile.config-missing.state|iphone|ja|global": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "PR4b 派工包集中批捕预案:合并门=--preview-slice 无 schema 错误;iOS sim preflight 未打通(worker 环境无代码签名证书 + CocoaPods Podfile 异常),全格实拍证据由后续验收批次(双 AI 验收/QA)补录,--final 前必须清零"
    },
    "mobile.config-missing.state|iphone|ko|cn": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "PR4b 派工包集中批捕预案:合并门=--preview-slice 无 schema 错误;iOS sim preflight 未打通(worker 环境无代码签名证书 + CocoaPods Podfile 异常),全格实拍证据由后续验收批次(双 AI 验收/QA)补录,--final 前必须清零"
    },
    "mobile.config-missing.state|iphone|ko|global": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "PR4b 派工包集中批捕预案:合并门=--preview-slice 无 schema 错误;iOS sim preflight 未打通(worker 环境无代码签名证书 + CocoaPods Podfile 异常),全格实拍证据由后续验收批次(双 AI 验收/QA)补录,--final 前必须清零"
    },
    "mobile.config-missing.state|android-phone|zh-CN|cn": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "PR4b 派工包集中批捕预案:合并门=--preview-slice 无 schema 错误;iOS sim preflight 未打通(worker 环境无代码签名证书 + CocoaPods Podfile 异常),全格实拍证据由后续验收批次(双 AI 验收/QA)补录,--final 前必须清零"
    },
    "mobile.config-missing.state|android-phone|zh-CN|global": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "PR4b 派工包集中批捕预案:合并门=--preview-slice 无 schema 错误;iOS sim preflight 未打通(worker 环境无代码签名证书 + CocoaPods Podfile 异常),全格实拍证据由后续验收批次(双 AI 验收/QA)补录,--final 前必须清零"
    },
    "mobile.config-missing.state|android-phone|zh-TW|cn": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "PR4b 派工包集中批捕预案:合并门=--preview-slice 无 schema 错误;iOS sim preflight 未打通(worker 环境无代码签名证书 + CocoaPods Podfile 异常),全格实拍证据由后续验收批次(双 AI 验收/QA)补录,--final 前必须清零"
    },
    "mobile.config-missing.state|android-phone|zh-TW|global": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "PR4b 派工包集中批捕预案:合并门=--preview-slice 无 schema 错误;iOS sim preflight 未打通(worker 环境无代码签名证书 + CocoaPods Podfile 异常),全格实拍证据由后续验收批次(双 AI 验收/QA)补录,--final 前必须清零"
    },
    "mobile.config-missing.state|android-phone|en|cn": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "PR4b 派工包集中批捕预案:合并门=--preview-slice 无 schema 错误;iOS sim preflight 未打通(worker 环境无代码签名证书 + CocoaPods Podfile 异常),全格实拍证据由后续验收批次(双 AI 验收/QA)补录,--final 前必须清零"
    },
    "mobile.config-missing.state|android-phone|en|global": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "PR4b 派工包集中批捕预案:合并门=--preview-slice 无 schema 错误;iOS sim preflight 未打通(worker 环境无代码签名证书 + CocoaPods Podfile 异常),全格实拍证据由后续验收批次(双 AI 验收/QA)补录,--final 前必须清零"
    },
    "mobile.config-missing.state|android-phone|ja|cn": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "PR4b 派工包集中批捕预案:合并门=--preview-slice 无 schema 错误;iOS sim preflight 未打通(worker 环境无代码签名证书 + CocoaPods Podfile 异常),全格实拍证据由后续验收批次(双 AI 验收/QA)补录,--final 前必须清零"
    },
    "mobile.config-missing.state|android-phone|ja|global": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "PR4b 派工包集中批捕预案:合并门=--preview-slice 无 schema 错误;iOS sim preflight 未打通(worker 环境无代码签名证书 + CocoaPods Podfile 异常),全格实拍证据由后续验收批次(双 AI 验收/QA)补录,--final 前必须清零"
    },
    "mobile.config-missing.state|android-phone|ko|cn": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "PR4b 派工包集中批捕预案:合并门=--preview-slice 无 schema 错误;iOS sim preflight 未打通(worker 环境无代码签名证书 + CocoaPods Podfile 异常),全格实拍证据由后续验收批次(双 AI 验收/QA)补录,--final 前必须清零"
    },
    "mobile.config-missing.state|android-phone|ko|global": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "PR4b 派工包集中批捕预案:合并门=--preview-slice 无 schema 错误;iOS sim preflight 未打通(worker 环境无代码签名证书 + CocoaPods Podfile 异常),全格实拍证据由后续验收批次(双 AI 验收/QA)补录,--final 前必须清零"
    },
    "mobile.config-missing.state|ipad|zh-CN|cn": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "PR4b 派工包集中批捕预案:合并门=--preview-slice 无 schema 错误;iOS sim preflight 未打通(worker 环境无代码签名证书 + CocoaPods Podfile 异常),全格实拍证据由后续验收批次(双 AI 验收/QA)补录,--final 前必须清零"
    },
    "mobile.config-missing.state|ipad|zh-CN|global": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "PR4b 派工包集中批捕预案:合并门=--preview-slice 无 schema 错误;iOS sim preflight 未打通(worker 环境无代码签名证书 + CocoaPods Podfile 异常),全格实拍证据由后续验收批次(双 AI 验收/QA)补录,--final 前必须清零"
    },
    "mobile.config-missing.state|ipad|zh-TW|cn": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "PR4b 派工包集中批捕预案:合并门=--preview-slice 无 schema 错误;iOS sim preflight 未打通(worker 环境无代码签名证书 + CocoaPods Podfile 异常),全格实拍证据由后续验收批次(双 AI 验收/QA)补录,--final 前必须清零"
    },
    "mobile.config-missing.state|ipad|zh-TW|global": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "PR4b 派工包集中批捕预案:合并门=--preview-slice 无 schema 错误;iOS sim preflight 未打通(worker 环境无代码签名证书 + CocoaPods Podfile 异常),全格实拍证据由后续验收批次(双 AI 验收/QA)补录,--final 前必须清零"
    },
    "mobile.config-missing.state|ipad|en|cn": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "PR4b 派工包集中批捕预案:合并门=--preview-slice 无 schema 错误;iOS sim preflight 未打通(worker 环境无代码签名证书 + CocoaPods Podfile 异常),全格实拍证据由后续验收批次(双 AI 验收/QA)补录,--final 前必须清零"
    },
    "mobile.config-missing.state|ipad|en|global": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "PR4b 派工包集中批捕预案:合并门=--preview-slice 无 schema 错误;iOS sim preflight 未打通(worker 环境无代码签名证书 + CocoaPods Podfile 异常),全格实拍证据由后续验收批次(双 AI 验收/QA)补录,--final 前必须清零"
    },
    "mobile.config-missing.state|ipad|ja|cn": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "PR4b 派工包集中批捕预案:合并门=--preview-slice 无 schema 错误;iOS sim preflight 未打通(worker 环境无代码签名证书 + CocoaPods Podfile 异常),全格实拍证据由后续验收批次(双 AI 验收/QA)补录,--final 前必须清零"
    },
    "mobile.config-missing.state|ipad|ja|global": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "PR4b 派工包集中批捕预案:合并门=--preview-slice 无 schema 错误;iOS sim preflight 未打通(worker 环境无代码签名证书 + CocoaPods Podfile 异常),全格实拍证据由后续验收批次(双 AI 验收/QA)补录,--final 前必须清零"
    },
    "mobile.config-missing.state|ipad|ko|cn": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "PR4b 派工包集中批捕预案:合并门=--preview-slice 无 schema 错误;iOS sim preflight 未打通(worker 环境无代码签名证书 + CocoaPods Podfile 异常),全格实拍证据由后续验收批次(双 AI 验收/QA)补录,--final 前必须清零"
    },
    "mobile.config-missing.state|ipad|ko|global": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "PR4b 派工包集中批捕预案:合并门=--preview-slice 无 schema 错误;iOS sim preflight 未打通(worker 环境无代码签名证书 + CocoaPods Podfile 异常),全格实拍证据由后续验收批次(双 AI 验收/QA)补录,--final 前必须清零"
    },
    "mobile.config-missing.state|android-pad|zh-CN|cn": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "PR4b 派工包集中批捕预案:合并门=--preview-slice 无 schema 错误;iOS sim preflight 未打通(worker 环境无代码签名证书 + CocoaPods Podfile 异常),全格实拍证据由后续验收批次(双 AI 验收/QA)补录,--final 前必须清零"
    },
    "mobile.config-missing.state|android-pad|zh-CN|global": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "PR4b 派工包集中批捕预案:合并门=--preview-slice 无 schema 错误;iOS sim preflight 未打通(worker 环境无代码签名证书 + CocoaPods Podfile 异常),全格实拍证据由后续验收批次(双 AI 验收/QA)补录,--final 前必须清零"
    },
    "mobile.config-missing.state|android-pad|zh-TW|cn": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "PR4b 派工包集中批捕预案:合并门=--preview-slice 无 schema 错误;iOS sim preflight 未打通(worker 环境无代码签名证书 + CocoaPods Podfile 异常),全格实拍证据由后续验收批次(双 AI 验收/QA)补录,--final 前必须清零"
    },
    "mobile.config-missing.state|android-pad|zh-TW|global": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "PR4b 派工包集中批捕预案:合并门=--preview-slice 无 schema 错误;iOS sim preflight 未打通(worker 环境无代码签名证书 + CocoaPods Podfile 异常),全格实拍证据由后续验收批次(双 AI 验收/QA)补录,--final 前必须清零"
    },
    "mobile.config-missing.state|android-pad|en|cn": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "PR4b 派工包集中批捕预案:合并门=--preview-slice 无 schema 错误;iOS sim preflight 未打通(worker 环境无代码签名证书 + CocoaPods Podfile 异常),全格实拍证据由后续验收批次(双 AI 验收/QA)补录,--final 前必须清零"
    },
    "mobile.config-missing.state|android-pad|en|global": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "PR4b 派工包集中批捕预案:合并门=--preview-slice 无 schema 错误;iOS sim preflight 未打通(worker 环境无代码签名证书 + CocoaPods Podfile 异常),全格实拍证据由后续验收批次(双 AI 验收/QA)补录,--final 前必须清零"
    },
    "mobile.config-missing.state|android-pad|ja|cn": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "PR4b 派工包集中批捕预案:合并门=--preview-slice 无 schema 错误;iOS sim preflight 未打通(worker 环境无代码签名证书 + CocoaPods Podfile 异常),全格实拍证据由后续验收批次(双 AI 验收/QA)补录,--final 前必须清零"
    },
    "mobile.config-missing.state|android-pad|ja|global": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "PR4b 派工包集中批捕预案:合并门=--preview-slice 无 schema 错误;iOS sim preflight 未打通(worker 环境无代码签名证书 + CocoaPods Podfile 异常),全格实拍证据由后续验收批次(双 AI 验收/QA)补录,--final 前必须清零"
    },
    "mobile.config-missing.state|android-pad|ko|cn": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "PR4b 派工包集中批捕预案:合并门=--preview-slice 无 schema 错误;iOS sim preflight 未打通(worker 环境无代码签名证书 + CocoaPods Podfile 异常),全格实拍证据由后续验收批次(双 AI 验收/QA)补录,--final 前必须清零"
    },
    "mobile.config-missing.state|android-pad|ko|global": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "PR4b 派工包集中批捕预案:合并门=--preview-slice 无 schema 错误;iOS sim preflight 未打通(worker 环境无代码签名证书 + CocoaPods Podfile 异常),全格实拍证据由后续验收批次(双 AI 验收/QA)补录,--final 前必须清零"
    },
    "mobile.keyboard.geometry|iphone|zh-CN|cn": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "PR4b 派工包集中批捕预案:合并门=--preview-slice 无 schema 错误;iOS sim preflight 未打通(worker 环境无代码签名证书 + CocoaPods Podfile 异常),全格实拍证据由后续验收批次(双 AI 验收/QA)补录,--final 前必须清零"
    },
    "mobile.keyboard.geometry|iphone|zh-CN|global": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "PR4b 派工包集中批捕预案:合并门=--preview-slice 无 schema 错误;iOS sim preflight 未打通(worker 环境无代码签名证书 + CocoaPods Podfile 异常),全格实拍证据由后续验收批次(双 AI 验收/QA)补录,--final 前必须清零"
    },
    "mobile.keyboard.geometry|iphone|zh-TW|cn": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "PR4b 派工包集中批捕预案:合并门=--preview-slice 无 schema 错误;iOS sim preflight 未打通(worker 环境无代码签名证书 + CocoaPods Podfile 异常),全格实拍证据由后续验收批次(双 AI 验收/QA)补录,--final 前必须清零"
    },
    "mobile.keyboard.geometry|iphone|zh-TW|global": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "PR4b 派工包集中批捕预案:合并门=--preview-slice 无 schema 错误;iOS sim preflight 未打通(worker 环境无代码签名证书 + CocoaPods Podfile 异常),全格实拍证据由后续验收批次(双 AI 验收/QA)补录,--final 前必须清零"
    },
    "mobile.keyboard.geometry|iphone|en|cn": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "PR4b 派工包集中批捕预案:合并门=--preview-slice 无 schema 错误;iOS sim preflight 未打通(worker 环境无代码签名证书 + CocoaPods Podfile 异常),全格实拍证据由后续验收批次(双 AI 验收/QA)补录,--final 前必须清零"
    },
    "mobile.keyboard.geometry|iphone|en|global": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "PR4b 派工包集中批捕预案:合并门=--preview-slice 无 schema 错误;iOS sim preflight 未打通(worker 环境无代码签名证书 + CocoaPods Podfile 异常),全格实拍证据由后续验收批次(双 AI 验收/QA)补录,--final 前必须清零"
    },
    "mobile.keyboard.geometry|iphone|ja|cn": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "PR4b 派工包集中批捕预案:合并门=--preview-slice 无 schema 错误;iOS sim preflight 未打通(worker 环境无代码签名证书 + CocoaPods Podfile 异常),全格实拍证据由后续验收批次(双 AI 验收/QA)补录,--final 前必须清零"
    },
    "mobile.keyboard.geometry|iphone|ja|global": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "PR4b 派工包集中批捕预案:合并门=--preview-slice 无 schema 错误;iOS sim preflight 未打通(worker 环境无代码签名证书 + CocoaPods Podfile 异常),全格实拍证据由后续验收批次(双 AI 验收/QA)补录,--final 前必须清零"
    },
    "mobile.keyboard.geometry|iphone|ko|cn": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "PR4b 派工包集中批捕预案:合并门=--preview-slice 无 schema 错误;iOS sim preflight 未打通(worker 环境无代码签名证书 + CocoaPods Podfile 异常),全格实拍证据由后续验收批次(双 AI 验收/QA)补录,--final 前必须清零"
    },
    "mobile.keyboard.geometry|iphone|ko|global": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "PR4b 派工包集中批捕预案:合并门=--preview-slice 无 schema 错误;iOS sim preflight 未打通(worker 环境无代码签名证书 + CocoaPods Podfile 异常),全格实拍证据由后续验收批次(双 AI 验收/QA)补录,--final 前必须清零"
    },
    "mobile.keyboard.geometry|android-phone|zh-CN|cn": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "PR4b 派工包集中批捕预案:合并门=--preview-slice 无 schema 错误;iOS sim preflight 未打通(worker 环境无代码签名证书 + CocoaPods Podfile 异常),全格实拍证据由后续验收批次(双 AI 验收/QA)补录,--final 前必须清零"
    },
    "mobile.keyboard.geometry|android-phone|zh-CN|global": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "PR4b 派工包集中批捕预案:合并门=--preview-slice 无 schema 错误;iOS sim preflight 未打通(worker 环境无代码签名证书 + CocoaPods Podfile 异常),全格实拍证据由后续验收批次(双 AI 验收/QA)补录,--final 前必须清零"
    },
    "mobile.keyboard.geometry|android-phone|zh-TW|cn": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "PR4b 派工包集中批捕预案:合并门=--preview-slice 无 schema 错误;iOS sim preflight 未打通(worker 环境无代码签名证书 + CocoaPods Podfile 异常),全格实拍证据由后续验收批次(双 AI 验收/QA)补录,--final 前必须清零"
    },
    "mobile.keyboard.geometry|android-phone|zh-TW|global": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "PR4b 派工包集中批捕预案:合并门=--preview-slice 无 schema 错误;iOS sim preflight 未打通(worker 环境无代码签名证书 + CocoaPods Podfile 异常),全格实拍证据由后续验收批次(双 AI 验收/QA)补录,--final 前必须清零"
    },
    "mobile.keyboard.geometry|android-phone|en|cn": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "PR4b 派工包集中批捕预案:合并门=--preview-slice 无 schema 错误;iOS sim preflight 未打通(worker 环境无代码签名证书 + CocoaPods Podfile 异常),全格实拍证据由后续验收批次(双 AI 验收/QA)补录,--final 前必须清零"
    },
    "mobile.keyboard.geometry|android-phone|en|global": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "PR4b 派工包集中批捕预案:合并门=--preview-slice 无 schema 错误;iOS sim preflight 未打通(worker 环境无代码签名证书 + CocoaPods Podfile 异常),全格实拍证据由后续验收批次(双 AI 验收/QA)补录,--final 前必须清零"
    },
    "mobile.keyboard.geometry|android-phone|ja|cn": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "PR4b 派工包集中批捕预案:合并门=--preview-slice 无 schema 错误;iOS sim preflight 未打通(worker 环境无代码签名证书 + CocoaPods Podfile 异常),全格实拍证据由后续验收批次(双 AI 验收/QA)补录,--final 前必须清零"
    },
    "mobile.keyboard.geometry|android-phone|ja|global": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "PR4b 派工包集中批捕预案:合并门=--preview-slice 无 schema 错误;iOS sim preflight 未打通(worker 环境无代码签名证书 + CocoaPods Podfile 异常),全格实拍证据由后续验收批次(双 AI 验收/QA)补录,--final 前必须清零"
    },
    "mobile.keyboard.geometry|android-phone|ko|cn": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "PR4b 派工包集中批捕预案:合并门=--preview-slice 无 schema 错误;iOS sim preflight 未打通(worker 环境无代码签名证书 + CocoaPods Podfile 异常),全格实拍证据由后续验收批次(双 AI 验收/QA)补录,--final 前必须清零"
    },
    "mobile.keyboard.geometry|android-phone|ko|global": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "PR4b 派工包集中批捕预案:合并门=--preview-slice 无 schema 错误;iOS sim preflight 未打通(worker 环境无代码签名证书 + CocoaPods Podfile 异常),全格实拍证据由后续验收批次(双 AI 验收/QA)补录,--final 前必须清零"
    },
    "mobile.keyboard.geometry|ipad|zh-CN|cn": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "PR4b 派工包集中批捕预案:合并门=--preview-slice 无 schema 错误;iOS sim preflight 未打通(worker 环境无代码签名证书 + CocoaPods Podfile 异常),全格实拍证据由后续验收批次(双 AI 验收/QA)补录,--final 前必须清零"
    },
    "mobile.keyboard.geometry|ipad|zh-CN|global": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "PR4b 派工包集中批捕预案:合并门=--preview-slice 无 schema 错误;iOS sim preflight 未打通(worker 环境无代码签名证书 + CocoaPods Podfile 异常),全格实拍证据由后续验收批次(双 AI 验收/QA)补录,--final 前必须清零"
    },
    "mobile.keyboard.geometry|ipad|zh-TW|cn": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "PR4b 派工包集中批捕预案:合并门=--preview-slice 无 schema 错误;iOS sim preflight 未打通(worker 环境无代码签名证书 + CocoaPods Podfile 异常),全格实拍证据由后续验收批次(双 AI 验收/QA)补录,--final 前必须清零"
    },
    "mobile.keyboard.geometry|ipad|zh-TW|global": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "PR4b 派工包集中批捕预案:合并门=--preview-slice 无 schema 错误;iOS sim preflight 未打通(worker 环境无代码签名证书 + CocoaPods Podfile 异常),全格实拍证据由后续验收批次(双 AI 验收/QA)补录,--final 前必须清零"
    },
    "mobile.keyboard.geometry|ipad|en|cn": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "PR4b 派工包集中批捕预案:合并门=--preview-slice 无 schema 错误;iOS sim preflight 未打通(worker 环境无代码签名证书 + CocoaPods Podfile 异常),全格实拍证据由后续验收批次(双 AI 验收/QA)补录,--final 前必须清零"
    },
    "mobile.keyboard.geometry|ipad|en|global": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "PR4b 派工包集中批捕预案:合并门=--preview-slice 无 schema 错误;iOS sim preflight 未打通(worker 环境无代码签名证书 + CocoaPods Podfile 异常),全格实拍证据由后续验收批次(双 AI 验收/QA)补录,--final 前必须清零"
    },
    "mobile.keyboard.geometry|ipad|ja|cn": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "PR4b 派工包集中批捕预案:合并门=--preview-slice 无 schema 错误;iOS sim preflight 未打通(worker 环境无代码签名证书 + CocoaPods Podfile 异常),全格实拍证据由后续验收批次(双 AI 验收/QA)补录,--final 前必须清零"
    },
    "mobile.keyboard.geometry|ipad|ja|global": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "PR4b 派工包集中批捕预案:合并门=--preview-slice 无 schema 错误;iOS sim preflight 未打通(worker 环境无代码签名证书 + CocoaPods Podfile 异常),全格实拍证据由后续验收批次(双 AI 验收/QA)补录,--final 前必须清零"
    },
    "mobile.keyboard.geometry|ipad|ko|cn": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "PR4b 派工包集中批捕预案:合并门=--preview-slice 无 schema 错误;iOS sim preflight 未打通(worker 环境无代码签名证书 + CocoaPods Podfile 异常),全格实拍证据由后续验收批次(双 AI 验收/QA)补录,--final 前必须清零"
    },
    "mobile.keyboard.geometry|ipad|ko|global": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "PR4b 派工包集中批捕预案:合并门=--preview-slice 无 schema 错误;iOS sim preflight 未打通(worker 环境无代码签名证书 + CocoaPods Podfile 异常),全格实拍证据由后续验收批次(双 AI 验收/QA)补录,--final 前必须清零"
    },
    "mobile.keyboard.geometry|android-pad|zh-CN|cn": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "PR4b 派工包集中批捕预案:合并门=--preview-slice 无 schema 错误;iOS sim preflight 未打通(worker 环境无代码签名证书 + CocoaPods Podfile 异常),全格实拍证据由后续验收批次(双 AI 验收/QA)补录,--final 前必须清零"
    },
    "mobile.keyboard.geometry|android-pad|zh-CN|global": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "PR4b 派工包集中批捕预案:合并门=--preview-slice 无 schema 错误;iOS sim preflight 未打通(worker 环境无代码签名证书 + CocoaPods Podfile 异常),全格实拍证据由后续验收批次(双 AI 验收/QA)补录,--final 前必须清零"
    },
    "mobile.keyboard.geometry|android-pad|zh-TW|cn": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "PR4b 派工包集中批捕预案:合并门=--preview-slice 无 schema 错误;iOS sim preflight 未打通(worker 环境无代码签名证书 + CocoaPods Podfile 异常),全格实拍证据由后续验收批次(双 AI 验收/QA)补录,--final 前必须清零"
    },
    "mobile.keyboard.geometry|android-pad|zh-TW|global": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "PR4b 派工包集中批捕预案:合并门=--preview-slice 无 schema 错误;iOS sim preflight 未打通(worker 环境无代码签名证书 + CocoaPods Podfile 异常),全格实拍证据由后续验收批次(双 AI 验收/QA)补录,--final 前必须清零"
    },
    "mobile.keyboard.geometry|android-pad|en|cn": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "PR4b 派工包集中批捕预案:合并门=--preview-slice 无 schema 错误;iOS sim preflight 未打通(worker 环境无代码签名证书 + CocoaPods Podfile 异常),全格实拍证据由后续验收批次(双 AI 验收/QA)补录,--final 前必须清零"
    },
    "mobile.keyboard.geometry|android-pad|en|global": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "PR4b 派工包集中批捕预案:合并门=--preview-slice 无 schema 错误;iOS sim preflight 未打通(worker 环境无代码签名证书 + CocoaPods Podfile 异常),全格实拍证据由后续验收批次(双 AI 验收/QA)补录,--final 前必须清零"
    },
    "mobile.keyboard.geometry|android-pad|ja|cn": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "PR4b 派工包集中批捕预案:合并门=--preview-slice 无 schema 错误;iOS sim preflight 未打通(worker 环境无代码签名证书 + CocoaPods Podfile 异常),全格实拍证据由后续验收批次(双 AI 验收/QA)补录,--final 前必须清零"
    },
    "mobile.keyboard.geometry|android-pad|ja|global": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "PR4b 派工包集中批捕预案:合并门=--preview-slice 无 schema 错误;iOS sim preflight 未打通(worker 环境无代码签名证书 + CocoaPods Podfile 异常),全格实拍证据由后续验收批次(双 AI 验收/QA)补录,--final 前必须清零"
    },
    "mobile.keyboard.geometry|android-pad|ko|cn": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "PR4b 派工包集中批捕预案:合并门=--preview-slice 无 schema 错误;iOS sim preflight 未打通(worker 环境无代码签名证书 + CocoaPods Podfile 异常),全格实拍证据由后续验收批次(双 AI 验收/QA)补录,--final 前必须清零"
    },
    "mobile.keyboard.geometry|android-pad|ko|global": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "PR4b 派工包集中批捕预案:合并门=--preview-slice 无 schema 错误;iOS sim preflight 未打通(worker 环境无代码签名证书 + CocoaPods Podfile 异常),全格实拍证据由后续验收批次(双 AI 验收/QA)补录,--final 前必须清零"
    },
    "mobile.orientation-layout.phone-fallback-geometry|iphone|zh-CN|cn": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "PR4b 派工包集中批捕预案:合并门=--preview-slice 无 schema 错误;iOS sim preflight 未打通(worker 环境无代码签名证书 + CocoaPods Podfile 异常),全格实拍证据由后续验收批次(双 AI 验收/QA)补录,--final 前必须清零"
    },
    "mobile.orientation-layout.phone-fallback-geometry|iphone|zh-CN|global": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "PR4b 派工包集中批捕预案:合并门=--preview-slice 无 schema 错误;iOS sim preflight 未打通(worker 环境无代码签名证书 + CocoaPods Podfile 异常),全格实拍证据由后续验收批次(双 AI 验收/QA)补录,--final 前必须清零"
    },
    "mobile.orientation-layout.phone-fallback-geometry|iphone|zh-TW|cn": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "PR4b 派工包集中批捕预案:合并门=--preview-slice 无 schema 错误;iOS sim preflight 未打通(worker 环境无代码签名证书 + CocoaPods Podfile 异常),全格实拍证据由后续验收批次(双 AI 验收/QA)补录,--final 前必须清零"
    },
    "mobile.orientation-layout.phone-fallback-geometry|iphone|zh-TW|global": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "PR4b 派工包集中批捕预案:合并门=--preview-slice 无 schema 错误;iOS sim preflight 未打通(worker 环境无代码签名证书 + CocoaPods Podfile 异常),全格实拍证据由后续验收批次(双 AI 验收/QA)补录,--final 前必须清零"
    },
    "mobile.orientation-layout.phone-fallback-geometry|iphone|en|cn": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "PR4b 派工包集中批捕预案:合并门=--preview-slice 无 schema 错误;iOS sim preflight 未打通(worker 环境无代码签名证书 + CocoaPods Podfile 异常),全格实拍证据由后续验收批次(双 AI 验收/QA)补录,--final 前必须清零"
    },
    "mobile.orientation-layout.phone-fallback-geometry|iphone|en|global": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "PR4b 派工包集中批捕预案:合并门=--preview-slice 无 schema 错误;iOS sim preflight 未打通(worker 环境无代码签名证书 + CocoaPods Podfile 异常),全格实拍证据由后续验收批次(双 AI 验收/QA)补录,--final 前必须清零"
    },
    "mobile.orientation-layout.phone-fallback-geometry|iphone|ja|cn": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "PR4b 派工包集中批捕预案:合并门=--preview-slice 无 schema 错误;iOS sim preflight 未打通(worker 环境无代码签名证书 + CocoaPods Podfile 异常),全格实拍证据由后续验收批次(双 AI 验收/QA)补录,--final 前必须清零"
    },
    "mobile.orientation-layout.phone-fallback-geometry|iphone|ja|global": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "PR4b 派工包集中批捕预案:合并门=--preview-slice 无 schema 错误;iOS sim preflight 未打通(worker 环境无代码签名证书 + CocoaPods Podfile 异常),全格实拍证据由后续验收批次(双 AI 验收/QA)补录,--final 前必须清零"
    },
    "mobile.orientation-layout.phone-fallback-geometry|iphone|ko|cn": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "PR4b 派工包集中批捕预案:合并门=--preview-slice 无 schema 错误;iOS sim preflight 未打通(worker 环境无代码签名证书 + CocoaPods Podfile 异常),全格实拍证据由后续验收批次(双 AI 验收/QA)补录,--final 前必须清零"
    },
    "mobile.orientation-layout.phone-fallback-geometry|iphone|ko|global": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "PR4b 派工包集中批捕预案:合并门=--preview-slice 无 schema 错误;iOS sim preflight 未打通(worker 环境无代码签名证书 + CocoaPods Podfile 异常),全格实拍证据由后续验收批次(双 AI 验收/QA)补录,--final 前必须清零"
    },
    "mobile.orientation-layout.phone-fallback-geometry|android-phone|zh-CN|cn": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "PR4b 派工包集中批捕预案:合并门=--preview-slice 无 schema 错误;iOS sim preflight 未打通(worker 环境无代码签名证书 + CocoaPods Podfile 异常),全格实拍证据由后续验收批次(双 AI 验收/QA)补录,--final 前必须清零"
    },
    "mobile.orientation-layout.phone-fallback-geometry|android-phone|zh-CN|global": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "PR4b 派工包集中批捕预案:合并门=--preview-slice 无 schema 错误;iOS sim preflight 未打通(worker 环境无代码签名证书 + CocoaPods Podfile 异常),全格实拍证据由后续验收批次(双 AI 验收/QA)补录,--final 前必须清零"
    },
    "mobile.orientation-layout.phone-fallback-geometry|android-phone|zh-TW|cn": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "PR4b 派工包集中批捕预案:合并门=--preview-slice 无 schema 错误;iOS sim preflight 未打通(worker 环境无代码签名证书 + CocoaPods Podfile 异常),全格实拍证据由后续验收批次(双 AI 验收/QA)补录,--final 前必须清零"
    },
    "mobile.orientation-layout.phone-fallback-geometry|android-phone|zh-TW|global": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "PR4b 派工包集中批捕预案:合并门=--preview-slice 无 schema 错误;iOS sim preflight 未打通(worker 环境无代码签名证书 + CocoaPods Podfile 异常),全格实拍证据由后续验收批次(双 AI 验收/QA)补录,--final 前必须清零"
    },
    "mobile.orientation-layout.phone-fallback-geometry|android-phone|en|cn": {
      "value": "PASS",
      "evidence": "capture-mobile/android-phone-cn-en-identifier-default.png",
      "baseline": {
        "source": "capture-mobile",
        "ref": "android-phone cn en default login screenshot"
      },
      "reviewer": "exec-d/capture",
      "approvedAt": "2026-07-21"
    },
    "mobile.orientation-layout.phone-fallback-geometry|android-phone|en|global": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "PR4b 派工包集中批捕预案:合并门=--preview-slice 无 schema 错误;iOS sim preflight 未打通(worker 环境无代码签名证书 + CocoaPods Podfile 异常),全格实拍证据由后续验收批次(双 AI 验收/QA)补录,--final 前必须清零"
    },
    "mobile.orientation-layout.phone-fallback-geometry|android-phone|ja|cn": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "PR4b 派工包集中批捕预案:合并门=--preview-slice 无 schema 错误;iOS sim preflight 未打通(worker 环境无代码签名证书 + CocoaPods Podfile 异常),全格实拍证据由后续验收批次(双 AI 验收/QA)补录,--final 前必须清零"
    },
    "mobile.orientation-layout.phone-fallback-geometry|android-phone|ja|global": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "PR4b 派工包集中批捕预案:合并门=--preview-slice 无 schema 错误;iOS sim preflight 未打通(worker 环境无代码签名证书 + CocoaPods Podfile 异常),全格实拍证据由后续验收批次(双 AI 验收/QA)补录,--final 前必须清零"
    },
    "mobile.orientation-layout.phone-fallback-geometry|android-phone|ko|cn": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "PR4b 派工包集中批捕预案:合并门=--preview-slice 无 schema 错误;iOS sim preflight 未打通(worker 环境无代码签名证书 + CocoaPods Podfile 异常),全格实拍证据由后续验收批次(双 AI 验收/QA)补录,--final 前必须清零"
    },
    "mobile.orientation-layout.phone-fallback-geometry|android-phone|ko|global": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "PR4b 派工包集中批捕预案:合并门=--preview-slice 无 schema 错误;iOS sim preflight 未打通(worker 环境无代码签名证书 + CocoaPods Podfile 异常),全格实拍证据由后续验收批次(双 AI 验收/QA)补录,--final 前必须清零"
    },
    "mobile.orientation-layout.pad-landscape-geometry|ipad|zh-CN|cn": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "PR4b 派工包集中批捕预案:合并门=--preview-slice 无 schema 错误;iOS sim preflight 未打通(worker 环境无代码签名证书 + CocoaPods Podfile 异常),全格实拍证据由后续验收批次(双 AI 验收/QA)补录,--final 前必须清零"
    },
    "mobile.orientation-layout.pad-landscape-geometry|ipad|zh-CN|global": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "PR4b 派工包集中批捕预案:合并门=--preview-slice 无 schema 错误;iOS sim preflight 未打通(worker 环境无代码签名证书 + CocoaPods Podfile 异常),全格实拍证据由后续验收批次(双 AI 验收/QA)补录,--final 前必须清零"
    },
    "mobile.orientation-layout.pad-landscape-geometry|ipad|zh-TW|cn": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "PR4b 派工包集中批捕预案:合并门=--preview-slice 无 schema 错误;iOS sim preflight 未打通(worker 环境无代码签名证书 + CocoaPods Podfile 异常),全格实拍证据由后续验收批次(双 AI 验收/QA)补录,--final 前必须清零"
    },
    "mobile.orientation-layout.pad-landscape-geometry|ipad|zh-TW|global": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "PR4b 派工包集中批捕预案:合并门=--preview-slice 无 schema 错误;iOS sim preflight 未打通(worker 环境无代码签名证书 + CocoaPods Podfile 异常),全格实拍证据由后续验收批次(双 AI 验收/QA)补录,--final 前必须清零"
    },
    "mobile.orientation-layout.pad-landscape-geometry|ipad|en|cn": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "PR4b 派工包集中批捕预案:合并门=--preview-slice 无 schema 错误;iOS sim preflight 未打通(worker 环境无代码签名证书 + CocoaPods Podfile 异常),全格实拍证据由后续验收批次(双 AI 验收/QA)补录,--final 前必须清零"
    },
    "mobile.orientation-layout.pad-landscape-geometry|ipad|en|global": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "PR4b 派工包集中批捕预案:合并门=--preview-slice 无 schema 错误;iOS sim preflight 未打通(worker 环境无代码签名证书 + CocoaPods Podfile 异常),全格实拍证据由后续验收批次(双 AI 验收/QA)补录,--final 前必须清零"
    },
    "mobile.orientation-layout.pad-landscape-geometry|ipad|ja|cn": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "PR4b 派工包集中批捕预案:合并门=--preview-slice 无 schema 错误;iOS sim preflight 未打通(worker 环境无代码签名证书 + CocoaPods Podfile 异常),全格实拍证据由后续验收批次(双 AI 验收/QA)补录,--final 前必须清零"
    },
    "mobile.orientation-layout.pad-landscape-geometry|ipad|ja|global": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "PR4b 派工包集中批捕预案:合并门=--preview-slice 无 schema 错误;iOS sim preflight 未打通(worker 环境无代码签名证书 + CocoaPods Podfile 异常),全格实拍证据由后续验收批次(双 AI 验收/QA)补录,--final 前必须清零"
    },
    "mobile.orientation-layout.pad-landscape-geometry|ipad|ko|cn": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "PR4b 派工包集中批捕预案:合并门=--preview-slice 无 schema 错误;iOS sim preflight 未打通(worker 环境无代码签名证书 + CocoaPods Podfile 异常),全格实拍证据由后续验收批次(双 AI 验收/QA)补录,--final 前必须清零"
    },
    "mobile.orientation-layout.pad-landscape-geometry|ipad|ko|global": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "PR4b 派工包集中批捕预案:合并门=--preview-slice 无 schema 错误;iOS sim preflight 未打通(worker 环境无代码签名证书 + CocoaPods Podfile 异常),全格实拍证据由后续验收批次(双 AI 验收/QA)补录,--final 前必须清零"
    },
    "mobile.orientation-layout.pad-landscape-geometry|android-pad|zh-CN|cn": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "PR4b 派工包集中批捕预案:合并门=--preview-slice 无 schema 错误;iOS sim preflight 未打通(worker 环境无代码签名证书 + CocoaPods Podfile 异常),全格实拍证据由后续验收批次(双 AI 验收/QA)补录,--final 前必须清零"
    },
    "mobile.orientation-layout.pad-landscape-geometry|android-pad|zh-CN|global": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "PR4b 派工包集中批捕预案:合并门=--preview-slice 无 schema 错误;iOS sim preflight 未打通(worker 环境无代码签名证书 + CocoaPods Podfile 异常),全格实拍证据由后续验收批次(双 AI 验收/QA)补录,--final 前必须清零"
    },
    "mobile.orientation-layout.pad-landscape-geometry|android-pad|zh-TW|cn": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "PR4b 派工包集中批捕预案:合并门=--preview-slice 无 schema 错误;iOS sim preflight 未打通(worker 环境无代码签名证书 + CocoaPods Podfile 异常),全格实拍证据由后续验收批次(双 AI 验收/QA)补录,--final 前必须清零"
    },
    "mobile.orientation-layout.pad-landscape-geometry|android-pad|zh-TW|global": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "PR4b 派工包集中批捕预案:合并门=--preview-slice 无 schema 错误;iOS sim preflight 未打通(worker 环境无代码签名证书 + CocoaPods Podfile 异常),全格实拍证据由后续验收批次(双 AI 验收/QA)补录,--final 前必须清零"
    },
    "mobile.orientation-layout.pad-landscape-geometry|android-pad|en|cn": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "PR4b 派工包集中批捕预案:合并门=--preview-slice 无 schema 错误;iOS sim preflight 未打通(worker 环境无代码签名证书 + CocoaPods Podfile 异常),全格实拍证据由后续验收批次(双 AI 验收/QA)补录,--final 前必须清零"
    },
    "mobile.orientation-layout.pad-landscape-geometry|android-pad|en|global": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "PR4b 派工包集中批捕预案:合并门=--preview-slice 无 schema 错误;iOS sim preflight 未打通(worker 环境无代码签名证书 + CocoaPods Podfile 异常),全格实拍证据由后续验收批次(双 AI 验收/QA)补录,--final 前必须清零"
    },
    "mobile.orientation-layout.pad-landscape-geometry|android-pad|ja|cn": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "PR4b 派工包集中批捕预案:合并门=--preview-slice 无 schema 错误;iOS sim preflight 未打通(worker 环境无代码签名证书 + CocoaPods Podfile 异常),全格实拍证据由后续验收批次(双 AI 验收/QA)补录,--final 前必须清零"
    },
    "mobile.orientation-layout.pad-landscape-geometry|android-pad|ja|global": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "PR4b 派工包集中批捕预案:合并门=--preview-slice 无 schema 错误;iOS sim preflight 未打通(worker 环境无代码签名证书 + CocoaPods Podfile 异常),全格实拍证据由后续验收批次(双 AI 验收/QA)补录,--final 前必须清零"
    },
    "mobile.orientation-layout.pad-landscape-geometry|android-pad|ko|cn": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "PR4b 派工包集中批捕预案:合并门=--preview-slice 无 schema 错误;iOS sim preflight 未打通(worker 环境无代码签名证书 + CocoaPods Podfile 异常),全格实拍证据由后续验收批次(双 AI 验收/QA)补录,--final 前必须清零"
    },
    "mobile.orientation-layout.pad-landscape-geometry|android-pad|ko|global": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "PR4b 派工包集中批捕预案:合并门=--preview-slice 无 schema 错误;iOS sim preflight 未打通(worker 环境无代码签名证书 + CocoaPods Podfile 异常),全格实拍证据由后续验收批次(双 AI 验收/QA)补录,--final 前必须清零"
    },
    "mobile.handoff.timing|iphone|zh-CN|cn": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "PR4b 派工包集中批捕预案:合并门=--preview-slice 无 schema 错误;iOS sim preflight 未打通(worker 环境无代码签名证书 + CocoaPods Podfile 异常),全格实拍证据由后续验收批次(双 AI 验收/QA)补录,--final 前必须清零"
    },
    "mobile.handoff.timing|iphone|zh-CN|global": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "PR4b 派工包集中批捕预案:合并门=--preview-slice 无 schema 错误;iOS sim preflight 未打通(worker 环境无代码签名证书 + CocoaPods Podfile 异常),全格实拍证据由后续验收批次(双 AI 验收/QA)补录,--final 前必须清零"
    },
    "mobile.handoff.timing|iphone|zh-TW|cn": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "PR4b 派工包集中批捕预案:合并门=--preview-slice 无 schema 错误;iOS sim preflight 未打通(worker 环境无代码签名证书 + CocoaPods Podfile 异常),全格实拍证据由后续验收批次(双 AI 验收/QA)补录,--final 前必须清零"
    },
    "mobile.handoff.timing|iphone|zh-TW|global": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "PR4b 派工包集中批捕预案:合并门=--preview-slice 无 schema 错误;iOS sim preflight 未打通(worker 环境无代码签名证书 + CocoaPods Podfile 异常),全格实拍证据由后续验收批次(双 AI 验收/QA)补录,--final 前必须清零"
    },
    "mobile.handoff.timing|iphone|en|cn": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "PR4b 派工包集中批捕预案:合并门=--preview-slice 无 schema 错误;iOS sim preflight 未打通(worker 环境无代码签名证书 + CocoaPods Podfile 异常),全格实拍证据由后续验收批次(双 AI 验收/QA)补录,--final 前必须清零"
    },
    "mobile.handoff.timing|iphone|en|global": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "PR4b 派工包集中批捕预案:合并门=--preview-slice 无 schema 错误;iOS sim preflight 未打通(worker 环境无代码签名证书 + CocoaPods Podfile 异常),全格实拍证据由后续验收批次(双 AI 验收/QA)补录,--final 前必须清零"
    },
    "mobile.handoff.timing|iphone|ja|cn": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "PR4b 派工包集中批捕预案:合并门=--preview-slice 无 schema 错误;iOS sim preflight 未打通(worker 环境无代码签名证书 + CocoaPods Podfile 异常),全格实拍证据由后续验收批次(双 AI 验收/QA)补录,--final 前必须清零"
    },
    "mobile.handoff.timing|iphone|ja|global": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "PR4b 派工包集中批捕预案:合并门=--preview-slice 无 schema 错误;iOS sim preflight 未打通(worker 环境无代码签名证书 + CocoaPods Podfile 异常),全格实拍证据由后续验收批次(双 AI 验收/QA)补录,--final 前必须清零"
    },
    "mobile.handoff.timing|iphone|ko|cn": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "PR4b 派工包集中批捕预案:合并门=--preview-slice 无 schema 错误;iOS sim preflight 未打通(worker 环境无代码签名证书 + CocoaPods Podfile 异常),全格实拍证据由后续验收批次(双 AI 验收/QA)补录,--final 前必须清零"
    },
    "mobile.handoff.timing|iphone|ko|global": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "PR4b 派工包集中批捕预案:合并门=--preview-slice 无 schema 错误;iOS sim preflight 未打通(worker 环境无代码签名证书 + CocoaPods Podfile 异常),全格实拍证据由后续验收批次(双 AI 验收/QA)补录,--final 前必须清零"
    },
    "mobile.handoff.timing|android-phone|zh-CN|cn": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "PR4b 派工包集中批捕预案:合并门=--preview-slice 无 schema 错误;iOS sim preflight 未打通(worker 环境无代码签名证书 + CocoaPods Podfile 异常),全格实拍证据由后续验收批次(双 AI 验收/QA)补录,--final 前必须清零"
    },
    "mobile.handoff.timing|android-phone|zh-CN|global": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "PR4b 派工包集中批捕预案:合并门=--preview-slice 无 schema 错误;iOS sim preflight 未打通(worker 环境无代码签名证书 + CocoaPods Podfile 异常),全格实拍证据由后续验收批次(双 AI 验收/QA)补录,--final 前必须清零"
    },
    "mobile.handoff.timing|android-phone|zh-TW|cn": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "PR4b 派工包集中批捕预案:合并门=--preview-slice 无 schema 错误;iOS sim preflight 未打通(worker 环境无代码签名证书 + CocoaPods Podfile 异常),全格实拍证据由后续验收批次(双 AI 验收/QA)补录,--final 前必须清零"
    },
    "mobile.handoff.timing|android-phone|zh-TW|global": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "PR4b 派工包集中批捕预案:合并门=--preview-slice 无 schema 错误;iOS sim preflight 未打通(worker 环境无代码签名证书 + CocoaPods Podfile 异常),全格实拍证据由后续验收批次(双 AI 验收/QA)补录,--final 前必须清零"
    },
    "mobile.handoff.timing|android-phone|en|cn": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "PR4b 派工包集中批捕预案:合并门=--preview-slice 无 schema 错误;iOS sim preflight 未打通(worker 环境无代码签名证书 + CocoaPods Podfile 异常),全格实拍证据由后续验收批次(双 AI 验收/QA)补录,--final 前必须清零"
    },
    "mobile.handoff.timing|android-phone|en|global": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "PR4b 派工包集中批捕预案:合并门=--preview-slice 无 schema 错误;iOS sim preflight 未打通(worker 环境无代码签名证书 + CocoaPods Podfile 异常),全格实拍证据由后续验收批次(双 AI 验收/QA)补录,--final 前必须清零"
    },
    "mobile.handoff.timing|android-phone|ja|cn": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "PR4b 派工包集中批捕预案:合并门=--preview-slice 无 schema 错误;iOS sim preflight 未打通(worker 环境无代码签名证书 + CocoaPods Podfile 异常),全格实拍证据由后续验收批次(双 AI 验收/QA)补录,--final 前必须清零"
    },
    "mobile.handoff.timing|android-phone|ja|global": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "PR4b 派工包集中批捕预案:合并门=--preview-slice 无 schema 错误;iOS sim preflight 未打通(worker 环境无代码签名证书 + CocoaPods Podfile 异常),全格实拍证据由后续验收批次(双 AI 验收/QA)补录,--final 前必须清零"
    },
    "mobile.handoff.timing|android-phone|ko|cn": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "PR4b 派工包集中批捕预案:合并门=--preview-slice 无 schema 错误;iOS sim preflight 未打通(worker 环境无代码签名证书 + CocoaPods Podfile 异常),全格实拍证据由后续验收批次(双 AI 验收/QA)补录,--final 前必须清零"
    },
    "mobile.handoff.timing|android-phone|ko|global": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "PR4b 派工包集中批捕预案:合并门=--preview-slice 无 schema 错误;iOS sim preflight 未打通(worker 环境无代码签名证书 + CocoaPods Podfile 异常),全格实拍证据由后续验收批次(双 AI 验收/QA)补录,--final 前必须清零"
    },
    "mobile.handoff.timing|ipad|zh-CN|cn": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "PR4b 派工包集中批捕预案:合并门=--preview-slice 无 schema 错误;iOS sim preflight 未打通(worker 环境无代码签名证书 + CocoaPods Podfile 异常),全格实拍证据由后续验收批次(双 AI 验收/QA)补录,--final 前必须清零"
    },
    "mobile.handoff.timing|ipad|zh-CN|global": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "PR4b 派工包集中批捕预案:合并门=--preview-slice 无 schema 错误;iOS sim preflight 未打通(worker 环境无代码签名证书 + CocoaPods Podfile 异常),全格实拍证据由后续验收批次(双 AI 验收/QA)补录,--final 前必须清零"
    },
    "mobile.handoff.timing|ipad|zh-TW|cn": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "PR4b 派工包集中批捕预案:合并门=--preview-slice 无 schema 错误;iOS sim preflight 未打通(worker 环境无代码签名证书 + CocoaPods Podfile 异常),全格实拍证据由后续验收批次(双 AI 验收/QA)补录,--final 前必须清零"
    },
    "mobile.handoff.timing|ipad|zh-TW|global": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "PR4b 派工包集中批捕预案:合并门=--preview-slice 无 schema 错误;iOS sim preflight 未打通(worker 环境无代码签名证书 + CocoaPods Podfile 异常),全格实拍证据由后续验收批次(双 AI 验收/QA)补录,--final 前必须清零"
    },
    "mobile.handoff.timing|ipad|en|cn": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "PR4b 派工包集中批捕预案:合并门=--preview-slice 无 schema 错误;iOS sim preflight 未打通(worker 环境无代码签名证书 + CocoaPods Podfile 异常),全格实拍证据由后续验收批次(双 AI 验收/QA)补录,--final 前必须清零"
    },
    "mobile.handoff.timing|ipad|en|global": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "PR4b 派工包集中批捕预案:合并门=--preview-slice 无 schema 错误;iOS sim preflight 未打通(worker 环境无代码签名证书 + CocoaPods Podfile 异常),全格实拍证据由后续验收批次(双 AI 验收/QA)补录,--final 前必须清零"
    },
    "mobile.handoff.timing|ipad|ja|cn": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "PR4b 派工包集中批捕预案:合并门=--preview-slice 无 schema 错误;iOS sim preflight 未打通(worker 环境无代码签名证书 + CocoaPods Podfile 异常),全格实拍证据由后续验收批次(双 AI 验收/QA)补录,--final 前必须清零"
    },
    "mobile.handoff.timing|ipad|ja|global": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "PR4b 派工包集中批捕预案:合并门=--preview-slice 无 schema 错误;iOS sim preflight 未打通(worker 环境无代码签名证书 + CocoaPods Podfile 异常),全格实拍证据由后续验收批次(双 AI 验收/QA)补录,--final 前必须清零"
    },
    "mobile.handoff.timing|ipad|ko|cn": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "PR4b 派工包集中批捕预案:合并门=--preview-slice 无 schema 错误;iOS sim preflight 未打通(worker 环境无代码签名证书 + CocoaPods Podfile 异常),全格实拍证据由后续验收批次(双 AI 验收/QA)补录,--final 前必须清零"
    },
    "mobile.handoff.timing|ipad|ko|global": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "PR4b 派工包集中批捕预案:合并门=--preview-slice 无 schema 错误;iOS sim preflight 未打通(worker 环境无代码签名证书 + CocoaPods Podfile 异常),全格实拍证据由后续验收批次(双 AI 验收/QA)补录,--final 前必须清零"
    },
    "mobile.handoff.timing|android-pad|zh-CN|cn": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "PR4b 派工包集中批捕预案:合并门=--preview-slice 无 schema 错误;iOS sim preflight 未打通(worker 环境无代码签名证书 + CocoaPods Podfile 异常),全格实拍证据由后续验收批次(双 AI 验收/QA)补录,--final 前必须清零"
    },
    "mobile.handoff.timing|android-pad|zh-CN|global": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "PR4b 派工包集中批捕预案:合并门=--preview-slice 无 schema 错误;iOS sim preflight 未打通(worker 环境无代码签名证书 + CocoaPods Podfile 异常),全格实拍证据由后续验收批次(双 AI 验收/QA)补录,--final 前必须清零"
    },
    "mobile.handoff.timing|android-pad|zh-TW|cn": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "PR4b 派工包集中批捕预案:合并门=--preview-slice 无 schema 错误;iOS sim preflight 未打通(worker 环境无代码签名证书 + CocoaPods Podfile 异常),全格实拍证据由后续验收批次(双 AI 验收/QA)补录,--final 前必须清零"
    },
    "mobile.handoff.timing|android-pad|zh-TW|global": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "PR4b 派工包集中批捕预案:合并门=--preview-slice 无 schema 错误;iOS sim preflight 未打通(worker 环境无代码签名证书 + CocoaPods Podfile 异常),全格实拍证据由后续验收批次(双 AI 验收/QA)补录,--final 前必须清零"
    },
    "mobile.handoff.timing|android-pad|en|cn": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "PR4b 派工包集中批捕预案:合并门=--preview-slice 无 schema 错误;iOS sim preflight 未打通(worker 环境无代码签名证书 + CocoaPods Podfile 异常),全格实拍证据由后续验收批次(双 AI 验收/QA)补录,--final 前必须清零"
    },
    "mobile.handoff.timing|android-pad|en|global": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "PR4b 派工包集中批捕预案:合并门=--preview-slice 无 schema 错误;iOS sim preflight 未打通(worker 环境无代码签名证书 + CocoaPods Podfile 异常),全格实拍证据由后续验收批次(双 AI 验收/QA)补录,--final 前必须清零"
    },
    "mobile.handoff.timing|android-pad|ja|cn": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "PR4b 派工包集中批捕预案:合并门=--preview-slice 无 schema 错误;iOS sim preflight 未打通(worker 环境无代码签名证书 + CocoaPods Podfile 异常),全格实拍证据由后续验收批次(双 AI 验收/QA)补录,--final 前必须清零"
    },
    "mobile.handoff.timing|android-pad|ja|global": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "PR4b 派工包集中批捕预案:合并门=--preview-slice 无 schema 错误;iOS sim preflight 未打通(worker 环境无代码签名证书 + CocoaPods Podfile 异常),全格实拍证据由后续验收批次(双 AI 验收/QA)补录,--final 前必须清零"
    },
    "mobile.handoff.timing|android-pad|ko|cn": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "PR4b 派工包集中批捕预案:合并门=--preview-slice 无 schema 错误;iOS sim preflight 未打通(worker 环境无代码签名证书 + CocoaPods Podfile 异常),全格实拍证据由后续验收批次(双 AI 验收/QA)补录,--final 前必须清零"
    },
    "mobile.handoff.timing|android-pad|ko|global": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "PR4b 派工包集中批捕预案:合并门=--preview-slice 无 schema 错误;iOS sim preflight 未打通(worker 环境无代码签名证书 + CocoaPods Podfile 异常),全格实拍证据由后续验收批次(双 AI 验收/QA)补录,--final 前必须清零"
    },
    "mobile.handoff-reduced-motion.state|iphone|zh-CN|cn": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "PR4b 派工包集中批捕预案:合并门=--preview-slice 无 schema 错误;iOS sim preflight 未打通(worker 环境无代码签名证书 + CocoaPods Podfile 异常),全格实拍证据由后续验收批次(双 AI 验收/QA)补录,--final 前必须清零"
    },
    "mobile.handoff-reduced-motion.state|iphone|zh-CN|global": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "PR4b 派工包集中批捕预案:合并门=--preview-slice 无 schema 错误;iOS sim preflight 未打通(worker 环境无代码签名证书 + CocoaPods Podfile 异常),全格实拍证据由后续验收批次(双 AI 验收/QA)补录,--final 前必须清零"
    },
    "mobile.handoff-reduced-motion.state|iphone|zh-TW|cn": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "PR4b 派工包集中批捕预案:合并门=--preview-slice 无 schema 错误;iOS sim preflight 未打通(worker 环境无代码签名证书 + CocoaPods Podfile 异常),全格实拍证据由后续验收批次(双 AI 验收/QA)补录,--final 前必须清零"
    },
    "mobile.handoff-reduced-motion.state|iphone|zh-TW|global": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "PR4b 派工包集中批捕预案:合并门=--preview-slice 无 schema 错误;iOS sim preflight 未打通(worker 环境无代码签名证书 + CocoaPods Podfile 异常),全格实拍证据由后续验收批次(双 AI 验收/QA)补录,--final 前必须清零"
    },
    "mobile.handoff-reduced-motion.state|iphone|en|cn": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "PR4b 派工包集中批捕预案:合并门=--preview-slice 无 schema 错误;iOS sim preflight 未打通(worker 环境无代码签名证书 + CocoaPods Podfile 异常),全格实拍证据由后续验收批次(双 AI 验收/QA)补录,--final 前必须清零"
    },
    "mobile.handoff-reduced-motion.state|iphone|en|global": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "PR4b 派工包集中批捕预案:合并门=--preview-slice 无 schema 错误;iOS sim preflight 未打通(worker 环境无代码签名证书 + CocoaPods Podfile 异常),全格实拍证据由后续验收批次(双 AI 验收/QA)补录,--final 前必须清零"
    },
    "mobile.handoff-reduced-motion.state|iphone|ja|cn": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "PR4b 派工包集中批捕预案:合并门=--preview-slice 无 schema 错误;iOS sim preflight 未打通(worker 环境无代码签名证书 + CocoaPods Podfile 异常),全格实拍证据由后续验收批次(双 AI 验收/QA)补录,--final 前必须清零"
    },
    "mobile.handoff-reduced-motion.state|iphone|ja|global": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "PR4b 派工包集中批捕预案:合并门=--preview-slice 无 schema 错误;iOS sim preflight 未打通(worker 环境无代码签名证书 + CocoaPods Podfile 异常),全格实拍证据由后续验收批次(双 AI 验收/QA)补录,--final 前必须清零"
    },
    "mobile.handoff-reduced-motion.state|iphone|ko|cn": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "PR4b 派工包集中批捕预案:合并门=--preview-slice 无 schema 错误;iOS sim preflight 未打通(worker 环境无代码签名证书 + CocoaPods Podfile 异常),全格实拍证据由后续验收批次(双 AI 验收/QA)补录,--final 前必须清零"
    },
    "mobile.handoff-reduced-motion.state|iphone|ko|global": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "PR4b 派工包集中批捕预案:合并门=--preview-slice 无 schema 错误;iOS sim preflight 未打通(worker 环境无代码签名证书 + CocoaPods Podfile 异常),全格实拍证据由后续验收批次(双 AI 验收/QA)补录,--final 前必须清零"
    },
    "mobile.handoff-reduced-motion.state|android-phone|zh-CN|cn": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "PR4b 派工包集中批捕预案:合并门=--preview-slice 无 schema 错误;iOS sim preflight 未打通(worker 环境无代码签名证书 + CocoaPods Podfile 异常),全格实拍证据由后续验收批次(双 AI 验收/QA)补录,--final 前必须清零"
    },
    "mobile.handoff-reduced-motion.state|android-phone|zh-CN|global": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "PR4b 派工包集中批捕预案:合并门=--preview-slice 无 schema 错误;iOS sim preflight 未打通(worker 环境无代码签名证书 + CocoaPods Podfile 异常),全格实拍证据由后续验收批次(双 AI 验收/QA)补录,--final 前必须清零"
    },
    "mobile.handoff-reduced-motion.state|android-phone|zh-TW|cn": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "PR4b 派工包集中批捕预案:合并门=--preview-slice 无 schema 错误;iOS sim preflight 未打通(worker 环境无代码签名证书 + CocoaPods Podfile 异常),全格实拍证据由后续验收批次(双 AI 验收/QA)补录,--final 前必须清零"
    },
    "mobile.handoff-reduced-motion.state|android-phone|zh-TW|global": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "PR4b 派工包集中批捕预案:合并门=--preview-slice 无 schema 错误;iOS sim preflight 未打通(worker 环境无代码签名证书 + CocoaPods Podfile 异常),全格实拍证据由后续验收批次(双 AI 验收/QA)补录,--final 前必须清零"
    },
    "mobile.handoff-reduced-motion.state|android-phone|en|cn": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "PR4b 派工包集中批捕预案:合并门=--preview-slice 无 schema 错误;iOS sim preflight 未打通(worker 环境无代码签名证书 + CocoaPods Podfile 异常),全格实拍证据由后续验收批次(双 AI 验收/QA)补录,--final 前必须清零"
    },
    "mobile.handoff-reduced-motion.state|android-phone|en|global": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "PR4b 派工包集中批捕预案:合并门=--preview-slice 无 schema 错误;iOS sim preflight 未打通(worker 环境无代码签名证书 + CocoaPods Podfile 异常),全格实拍证据由后续验收批次(双 AI 验收/QA)补录,--final 前必须清零"
    },
    "mobile.handoff-reduced-motion.state|android-phone|ja|cn": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "PR4b 派工包集中批捕预案:合并门=--preview-slice 无 schema 错误;iOS sim preflight 未打通(worker 环境无代码签名证书 + CocoaPods Podfile 异常),全格实拍证据由后续验收批次(双 AI 验收/QA)补录,--final 前必须清零"
    },
    "mobile.handoff-reduced-motion.state|android-phone|ja|global": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "PR4b 派工包集中批捕预案:合并门=--preview-slice 无 schema 错误;iOS sim preflight 未打通(worker 环境无代码签名证书 + CocoaPods Podfile 异常),全格实拍证据由后续验收批次(双 AI 验收/QA)补录,--final 前必须清零"
    },
    "mobile.handoff-reduced-motion.state|android-phone|ko|cn": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "PR4b 派工包集中批捕预案:合并门=--preview-slice 无 schema 错误;iOS sim preflight 未打通(worker 环境无代码签名证书 + CocoaPods Podfile 异常),全格实拍证据由后续验收批次(双 AI 验收/QA)补录,--final 前必须清零"
    },
    "mobile.handoff-reduced-motion.state|android-phone|ko|global": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "PR4b 派工包集中批捕预案:合并门=--preview-slice 无 schema 错误;iOS sim preflight 未打通(worker 环境无代码签名证书 + CocoaPods Podfile 异常),全格实拍证据由后续验收批次(双 AI 验收/QA)补录,--final 前必须清零"
    },
    "mobile.handoff-reduced-motion.state|ipad|zh-CN|cn": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "PR4b 派工包集中批捕预案:合并门=--preview-slice 无 schema 错误;iOS sim preflight 未打通(worker 环境无代码签名证书 + CocoaPods Podfile 异常),全格实拍证据由后续验收批次(双 AI 验收/QA)补录,--final 前必须清零"
    },
    "mobile.handoff-reduced-motion.state|ipad|zh-CN|global": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "PR4b 派工包集中批捕预案:合并门=--preview-slice 无 schema 错误;iOS sim preflight 未打通(worker 环境无代码签名证书 + CocoaPods Podfile 异常),全格实拍证据由后续验收批次(双 AI 验收/QA)补录,--final 前必须清零"
    },
    "mobile.handoff-reduced-motion.state|ipad|zh-TW|cn": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "PR4b 派工包集中批捕预案:合并门=--preview-slice 无 schema 错误;iOS sim preflight 未打通(worker 环境无代码签名证书 + CocoaPods Podfile 异常),全格实拍证据由后续验收批次(双 AI 验收/QA)补录,--final 前必须清零"
    },
    "mobile.handoff-reduced-motion.state|ipad|zh-TW|global": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "PR4b 派工包集中批捕预案:合并门=--preview-slice 无 schema 错误;iOS sim preflight 未打通(worker 环境无代码签名证书 + CocoaPods Podfile 异常),全格实拍证据由后续验收批次(双 AI 验收/QA)补录,--final 前必须清零"
    },
    "mobile.handoff-reduced-motion.state|ipad|en|cn": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "PR4b 派工包集中批捕预案:合并门=--preview-slice 无 schema 错误;iOS sim preflight 未打通(worker 环境无代码签名证书 + CocoaPods Podfile 异常),全格实拍证据由后续验收批次(双 AI 验收/QA)补录,--final 前必须清零"
    },
    "mobile.handoff-reduced-motion.state|ipad|en|global": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "PR4b 派工包集中批捕预案:合并门=--preview-slice 无 schema 错误;iOS sim preflight 未打通(worker 环境无代码签名证书 + CocoaPods Podfile 异常),全格实拍证据由后续验收批次(双 AI 验收/QA)补录,--final 前必须清零"
    },
    "mobile.handoff-reduced-motion.state|ipad|ja|cn": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "PR4b 派工包集中批捕预案:合并门=--preview-slice 无 schema 错误;iOS sim preflight 未打通(worker 环境无代码签名证书 + CocoaPods Podfile 异常),全格实拍证据由后续验收批次(双 AI 验收/QA)补录,--final 前必须清零"
    },
    "mobile.handoff-reduced-motion.state|ipad|ja|global": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "PR4b 派工包集中批捕预案:合并门=--preview-slice 无 schema 错误;iOS sim preflight 未打通(worker 环境无代码签名证书 + CocoaPods Podfile 异常),全格实拍证据由后续验收批次(双 AI 验收/QA)补录,--final 前必须清零"
    },
    "mobile.handoff-reduced-motion.state|ipad|ko|cn": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "PR4b 派工包集中批捕预案:合并门=--preview-slice 无 schema 错误;iOS sim preflight 未打通(worker 环境无代码签名证书 + CocoaPods Podfile 异常),全格实拍证据由后续验收批次(双 AI 验收/QA)补录,--final 前必须清零"
    },
    "mobile.handoff-reduced-motion.state|ipad|ko|global": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "PR4b 派工包集中批捕预案:合并门=--preview-slice 无 schema 错误;iOS sim preflight 未打通(worker 环境无代码签名证书 + CocoaPods Podfile 异常),全格实拍证据由后续验收批次(双 AI 验收/QA)补录,--final 前必须清零"
    },
    "mobile.handoff-reduced-motion.state|android-pad|zh-CN|cn": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "PR4b 派工包集中批捕预案:合并门=--preview-slice 无 schema 错误;iOS sim preflight 未打通(worker 环境无代码签名证书 + CocoaPods Podfile 异常),全格实拍证据由后续验收批次(双 AI 验收/QA)补录,--final 前必须清零"
    },
    "mobile.handoff-reduced-motion.state|android-pad|zh-CN|global": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "PR4b 派工包集中批捕预案:合并门=--preview-slice 无 schema 错误;iOS sim preflight 未打通(worker 环境无代码签名证书 + CocoaPods Podfile 异常),全格实拍证据由后续验收批次(双 AI 验收/QA)补录,--final 前必须清零"
    },
    "mobile.handoff-reduced-motion.state|android-pad|zh-TW|cn": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "PR4b 派工包集中批捕预案:合并门=--preview-slice 无 schema 错误;iOS sim preflight 未打通(worker 环境无代码签名证书 + CocoaPods Podfile 异常),全格实拍证据由后续验收批次(双 AI 验收/QA)补录,--final 前必须清零"
    },
    "mobile.handoff-reduced-motion.state|android-pad|zh-TW|global": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "PR4b 派工包集中批捕预案:合并门=--preview-slice 无 schema 错误;iOS sim preflight 未打通(worker 环境无代码签名证书 + CocoaPods Podfile 异常),全格实拍证据由后续验收批次(双 AI 验收/QA)补录,--final 前必须清零"
    },
    "mobile.handoff-reduced-motion.state|android-pad|en|cn": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "PR4b 派工包集中批捕预案:合并门=--preview-slice 无 schema 错误;iOS sim preflight 未打通(worker 环境无代码签名证书 + CocoaPods Podfile 异常),全格实拍证据由后续验收批次(双 AI 验收/QA)补录,--final 前必须清零"
    },
    "mobile.handoff-reduced-motion.state|android-pad|en|global": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "PR4b 派工包集中批捕预案:合并门=--preview-slice 无 schema 错误;iOS sim preflight 未打通(worker 环境无代码签名证书 + CocoaPods Podfile 异常),全格实拍证据由后续验收批次(双 AI 验收/QA)补录,--final 前必须清零"
    },
    "mobile.handoff-reduced-motion.state|android-pad|ja|cn": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "PR4b 派工包集中批捕预案:合并门=--preview-slice 无 schema 错误;iOS sim preflight 未打通(worker 环境无代码签名证书 + CocoaPods Podfile 异常),全格实拍证据由后续验收批次(双 AI 验收/QA)补录,--final 前必须清零"
    },
    "mobile.handoff-reduced-motion.state|android-pad|ja|global": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "PR4b 派工包集中批捕预案:合并门=--preview-slice 无 schema 错误;iOS sim preflight 未打通(worker 环境无代码签名证书 + CocoaPods Podfile 异常),全格实拍证据由后续验收批次(双 AI 验收/QA)补录,--final 前必须清零"
    },
    "mobile.handoff-reduced-motion.state|android-pad|ko|cn": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "PR4b 派工包集中批捕预案:合并门=--preview-slice 无 schema 错误;iOS sim preflight 未打通(worker 环境无代码签名证书 + CocoaPods Podfile 异常),全格实拍证据由后续验收批次(双 AI 验收/QA)补录,--final 前必须清零"
    },
    "mobile.handoff-reduced-motion.state|android-pad|ko|global": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "PR4b 派工包集中批捕预案:合并门=--preview-slice 无 schema 错误;iOS sim preflight 未打通(worker 环境无代码签名证书 + CocoaPods Podfile 异常),全格实拍证据由后续验收批次(双 AI 验收/QA)补录,--final 前必须清零"
    },
    "mobile.handoff-orientation.phone-timing|iphone|zh-CN|cn": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "PR4b 派工包集中批捕预案:合并门=--preview-slice 无 schema 错误;iOS sim preflight 未打通(worker 环境无代码签名证书 + CocoaPods Podfile 异常),全格实拍证据由后续验收批次(双 AI 验收/QA)补录,--final 前必须清零"
    },
    "mobile.handoff-orientation.phone-timing|iphone|zh-CN|global": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "PR4b 派工包集中批捕预案:合并门=--preview-slice 无 schema 错误;iOS sim preflight 未打通(worker 环境无代码签名证书 + CocoaPods Podfile 异常),全格实拍证据由后续验收批次(双 AI 验收/QA)补录,--final 前必须清零"
    },
    "mobile.handoff-orientation.phone-timing|iphone|zh-TW|cn": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "PR4b 派工包集中批捕预案:合并门=--preview-slice 无 schema 错误;iOS sim preflight 未打通(worker 环境无代码签名证书 + CocoaPods Podfile 异常),全格实拍证据由后续验收批次(双 AI 验收/QA)补录,--final 前必须清零"
    },
    "mobile.handoff-orientation.phone-timing|iphone|zh-TW|global": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "PR4b 派工包集中批捕预案:合并门=--preview-slice 无 schema 错误;iOS sim preflight 未打通(worker 环境无代码签名证书 + CocoaPods Podfile 异常),全格实拍证据由后续验收批次(双 AI 验收/QA)补录,--final 前必须清零"
    },
    "mobile.handoff-orientation.phone-timing|iphone|en|cn": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "PR4b 派工包集中批捕预案:合并门=--preview-slice 无 schema 错误;iOS sim preflight 未打通(worker 环境无代码签名证书 + CocoaPods Podfile 异常),全格实拍证据由后续验收批次(双 AI 验收/QA)补录,--final 前必须清零"
    },
    "mobile.handoff-orientation.phone-timing|iphone|en|global": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "PR4b 派工包集中批捕预案:合并门=--preview-slice 无 schema 错误;iOS sim preflight 未打通(worker 环境无代码签名证书 + CocoaPods Podfile 异常),全格实拍证据由后续验收批次(双 AI 验收/QA)补录,--final 前必须清零"
    },
    "mobile.handoff-orientation.phone-timing|iphone|ja|cn": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "PR4b 派工包集中批捕预案:合并门=--preview-slice 无 schema 错误;iOS sim preflight 未打通(worker 环境无代码签名证书 + CocoaPods Podfile 异常),全格实拍证据由后续验收批次(双 AI 验收/QA)补录,--final 前必须清零"
    },
    "mobile.handoff-orientation.phone-timing|iphone|ja|global": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "PR4b 派工包集中批捕预案:合并门=--preview-slice 无 schema 错误;iOS sim preflight 未打通(worker 环境无代码签名证书 + CocoaPods Podfile 异常),全格实拍证据由后续验收批次(双 AI 验收/QA)补录,--final 前必须清零"
    },
    "mobile.handoff-orientation.phone-timing|iphone|ko|cn": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "PR4b 派工包集中批捕预案:合并门=--preview-slice 无 schema 错误;iOS sim preflight 未打通(worker 环境无代码签名证书 + CocoaPods Podfile 异常),全格实拍证据由后续验收批次(双 AI 验收/QA)补录,--final 前必须清零"
    },
    "mobile.handoff-orientation.phone-timing|iphone|ko|global": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "PR4b 派工包集中批捕预案:合并门=--preview-slice 无 schema 错误;iOS sim preflight 未打通(worker 环境无代码签名证书 + CocoaPods Podfile 异常),全格实拍证据由后续验收批次(双 AI 验收/QA)补录,--final 前必须清零"
    },
    "mobile.handoff-orientation.phone-timing|android-phone|zh-CN|cn": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "PR4b 派工包集中批捕预案:合并门=--preview-slice 无 schema 错误;iOS sim preflight 未打通(worker 环境无代码签名证书 + CocoaPods Podfile 异常),全格实拍证据由后续验收批次(双 AI 验收/QA)补录,--final 前必须清零"
    },
    "mobile.handoff-orientation.phone-timing|android-phone|zh-CN|global": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "PR4b 派工包集中批捕预案:合并门=--preview-slice 无 schema 错误;iOS sim preflight 未打通(worker 环境无代码签名证书 + CocoaPods Podfile 异常),全格实拍证据由后续验收批次(双 AI 验收/QA)补录,--final 前必须清零"
    },
    "mobile.handoff-orientation.phone-timing|android-phone|zh-TW|cn": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "PR4b 派工包集中批捕预案:合并门=--preview-slice 无 schema 错误;iOS sim preflight 未打通(worker 环境无代码签名证书 + CocoaPods Podfile 异常),全格实拍证据由后续验收批次(双 AI 验收/QA)补录,--final 前必须清零"
    },
    "mobile.handoff-orientation.phone-timing|android-phone|zh-TW|global": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "PR4b 派工包集中批捕预案:合并门=--preview-slice 无 schema 错误;iOS sim preflight 未打通(worker 环境无代码签名证书 + CocoaPods Podfile 异常),全格实拍证据由后续验收批次(双 AI 验收/QA)补录,--final 前必须清零"
    },
    "mobile.handoff-orientation.phone-timing|android-phone|en|cn": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "PR4b 派工包集中批捕预案:合并门=--preview-slice 无 schema 错误;iOS sim preflight 未打通(worker 环境无代码签名证书 + CocoaPods Podfile 异常),全格实拍证据由后续验收批次(双 AI 验收/QA)补录,--final 前必须清零"
    },
    "mobile.handoff-orientation.phone-timing|android-phone|en|global": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "PR4b 派工包集中批捕预案:合并门=--preview-slice 无 schema 错误;iOS sim preflight 未打通(worker 环境无代码签名证书 + CocoaPods Podfile 异常),全格实拍证据由后续验收批次(双 AI 验收/QA)补录,--final 前必须清零"
    },
    "mobile.handoff-orientation.phone-timing|android-phone|ja|cn": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "PR4b 派工包集中批捕预案:合并门=--preview-slice 无 schema 错误;iOS sim preflight 未打通(worker 环境无代码签名证书 + CocoaPods Podfile 异常),全格实拍证据由后续验收批次(双 AI 验收/QA)补录,--final 前必须清零"
    },
    "mobile.handoff-orientation.phone-timing|android-phone|ja|global": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "PR4b 派工包集中批捕预案:合并门=--preview-slice 无 schema 错误;iOS sim preflight 未打通(worker 环境无代码签名证书 + CocoaPods Podfile 异常),全格实拍证据由后续验收批次(双 AI 验收/QA)补录,--final 前必须清零"
    },
    "mobile.handoff-orientation.phone-timing|android-phone|ko|cn": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "PR4b 派工包集中批捕预案:合并门=--preview-slice 无 schema 错误;iOS sim preflight 未打通(worker 环境无代码签名证书 + CocoaPods Podfile 异常),全格实拍证据由后续验收批次(双 AI 验收/QA)补录,--final 前必须清零"
    },
    "mobile.handoff-orientation.phone-timing|android-phone|ko|global": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "PR4b 派工包集中批捕预案:合并门=--preview-slice 无 schema 错误;iOS sim preflight 未打通(worker 环境无代码签名证书 + CocoaPods Podfile 异常),全格实拍证据由后续验收批次(双 AI 验收/QA)补录,--final 前必须清零"
    },
    "mobile.handoff-orientation.pad-landscape-timing|ipad|zh-CN|cn": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "PR4b 派工包集中批捕预案:合并门=--preview-slice 无 schema 错误;iOS sim preflight 未打通(worker 环境无代码签名证书 + CocoaPods Podfile 异常),全格实拍证据由后续验收批次(双 AI 验收/QA)补录,--final 前必须清零"
    },
    "mobile.handoff-orientation.pad-landscape-timing|ipad|zh-CN|global": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "PR4b 派工包集中批捕预案:合并门=--preview-slice 无 schema 错误;iOS sim preflight 未打通(worker 环境无代码签名证书 + CocoaPods Podfile 异常),全格实拍证据由后续验收批次(双 AI 验收/QA)补录,--final 前必须清零"
    },
    "mobile.handoff-orientation.pad-landscape-timing|ipad|zh-TW|cn": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "PR4b 派工包集中批捕预案:合并门=--preview-slice 无 schema 错误;iOS sim preflight 未打通(worker 环境无代码签名证书 + CocoaPods Podfile 异常),全格实拍证据由后续验收批次(双 AI 验收/QA)补录,--final 前必须清零"
    },
    "mobile.handoff-orientation.pad-landscape-timing|ipad|zh-TW|global": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "PR4b 派工包集中批捕预案:合并门=--preview-slice 无 schema 错误;iOS sim preflight 未打通(worker 环境无代码签名证书 + CocoaPods Podfile 异常),全格实拍证据由后续验收批次(双 AI 验收/QA)补录,--final 前必须清零"
    },
    "mobile.handoff-orientation.pad-landscape-timing|ipad|en|cn": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "PR4b 派工包集中批捕预案:合并门=--preview-slice 无 schema 错误;iOS sim preflight 未打通(worker 环境无代码签名证书 + CocoaPods Podfile 异常),全格实拍证据由后续验收批次(双 AI 验收/QA)补录,--final 前必须清零"
    },
    "mobile.handoff-orientation.pad-landscape-timing|ipad|en|global": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "PR4b 派工包集中批捕预案:合并门=--preview-slice 无 schema 错误;iOS sim preflight 未打通(worker 环境无代码签名证书 + CocoaPods Podfile 异常),全格实拍证据由后续验收批次(双 AI 验收/QA)补录,--final 前必须清零"
    },
    "mobile.handoff-orientation.pad-landscape-timing|ipad|ja|cn": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "PR4b 派工包集中批捕预案:合并门=--preview-slice 无 schema 错误;iOS sim preflight 未打通(worker 环境无代码签名证书 + CocoaPods Podfile 异常),全格实拍证据由后续验收批次(双 AI 验收/QA)补录,--final 前必须清零"
    },
    "mobile.handoff-orientation.pad-landscape-timing|ipad|ja|global": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "PR4b 派工包集中批捕预案:合并门=--preview-slice 无 schema 错误;iOS sim preflight 未打通(worker 环境无代码签名证书 + CocoaPods Podfile 异常),全格实拍证据由后续验收批次(双 AI 验收/QA)补录,--final 前必须清零"
    },
    "mobile.handoff-orientation.pad-landscape-timing|ipad|ko|cn": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "PR4b 派工包集中批捕预案:合并门=--preview-slice 无 schema 错误;iOS sim preflight 未打通(worker 环境无代码签名证书 + CocoaPods Podfile 异常),全格实拍证据由后续验收批次(双 AI 验收/QA)补录,--final 前必须清零"
    },
    "mobile.handoff-orientation.pad-landscape-timing|ipad|ko|global": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "PR4b 派工包集中批捕预案:合并门=--preview-slice 无 schema 错误;iOS sim preflight 未打通(worker 环境无代码签名证书 + CocoaPods Podfile 异常),全格实拍证据由后续验收批次(双 AI 验收/QA)补录,--final 前必须清零"
    },
    "mobile.handoff-orientation.pad-landscape-timing|android-pad|zh-CN|cn": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "PR4b 派工包集中批捕预案:合并门=--preview-slice 无 schema 错误;iOS sim preflight 未打通(worker 环境无代码签名证书 + CocoaPods Podfile 异常),全格实拍证据由后续验收批次(双 AI 验收/QA)补录,--final 前必须清零"
    },
    "mobile.handoff-orientation.pad-landscape-timing|android-pad|zh-CN|global": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "PR4b 派工包集中批捕预案:合并门=--preview-slice 无 schema 错误;iOS sim preflight 未打通(worker 环境无代码签名证书 + CocoaPods Podfile 异常),全格实拍证据由后续验收批次(双 AI 验收/QA)补录,--final 前必须清零"
    },
    "mobile.handoff-orientation.pad-landscape-timing|android-pad|zh-TW|cn": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "PR4b 派工包集中批捕预案:合并门=--preview-slice 无 schema 错误;iOS sim preflight 未打通(worker 环境无代码签名证书 + CocoaPods Podfile 异常),全格实拍证据由后续验收批次(双 AI 验收/QA)补录,--final 前必须清零"
    },
    "mobile.handoff-orientation.pad-landscape-timing|android-pad|zh-TW|global": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "PR4b 派工包集中批捕预案:合并门=--preview-slice 无 schema 错误;iOS sim preflight 未打通(worker 环境无代码签名证书 + CocoaPods Podfile 异常),全格实拍证据由后续验收批次(双 AI 验收/QA)补录,--final 前必须清零"
    },
    "mobile.handoff-orientation.pad-landscape-timing|android-pad|en|cn": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "PR4b 派工包集中批捕预案:合并门=--preview-slice 无 schema 错误;iOS sim preflight 未打通(worker 环境无代码签名证书 + CocoaPods Podfile 异常),全格实拍证据由后续验收批次(双 AI 验收/QA)补录,--final 前必须清零"
    },
    "mobile.handoff-orientation.pad-landscape-timing|android-pad|en|global": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "PR4b 派工包集中批捕预案:合并门=--preview-slice 无 schema 错误;iOS sim preflight 未打通(worker 环境无代码签名证书 + CocoaPods Podfile 异常),全格实拍证据由后续验收批次(双 AI 验收/QA)补录,--final 前必须清零"
    },
    "mobile.handoff-orientation.pad-landscape-timing|android-pad|ja|cn": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "PR4b 派工包集中批捕预案:合并门=--preview-slice 无 schema 错误;iOS sim preflight 未打通(worker 环境无代码签名证书 + CocoaPods Podfile 异常),全格实拍证据由后续验收批次(双 AI 验收/QA)补录,--final 前必须清零"
    },
    "mobile.handoff-orientation.pad-landscape-timing|android-pad|ja|global": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "PR4b 派工包集中批捕预案:合并门=--preview-slice 无 schema 错误;iOS sim preflight 未打通(worker 环境无代码签名证书 + CocoaPods Podfile 异常),全格实拍证据由后续验收批次(双 AI 验收/QA)补录,--final 前必须清零"
    },
    "mobile.handoff-orientation.pad-landscape-timing|android-pad|ko|cn": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "PR4b 派工包集中批捕预案:合并门=--preview-slice 无 schema 错误;iOS sim preflight 未打通(worker 环境无代码签名证书 + CocoaPods Podfile 异常),全格实拍证据由后续验收批次(双 AI 验收/QA)补录,--final 前必须清零"
    },
    "mobile.handoff-orientation.pad-landscape-timing|android-pad|ko|global": {
      "value": "GAP",
      "decidedBy": "lead",
      "decidedAt": "2026-07-20",
      "conclusion": "PR4b 派工包集中批捕预案:合并门=--preview-slice 无 schema 错误;iOS sim preflight 未打通(worker 环境无代码签名证书 + CocoaPods Podfile 异常),全格实拍证据由后续验收批次(双 AI 验收/QA)补录,--final 前必须清零"
    }
  }
}
```
