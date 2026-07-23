# Cindy 登录链路 UI 全量替换 · 实施计划（Plan Mode）

GD_STANDARD: Project GD/prompts/gd-review-standard.md
TEMPLATE_KIND: gd-plan

> 作者：Claude (lead)
> 日期：2026-07-20
> 状态：**reviewed**（全文共识 = v6.14 基线 SHA256 8c8aede8…,三位 codex gpt-5.6-sol xhigh reviewer 全部 APPROVE;U-1~U-11 全部已裁决;v6.15 落档 U-11=B 与白底复用 PR #104;**SC 专项复审已收敛 = v6.19 基线 SHA256 1046e0b6b5b82d70ffab91a8433ef22d2b16dadbcc5085cc4f43137b7c6388ab,2026-07-20 codex gpt-5.6-sol xhigh(sc-review)五轮迭代后无保留批准,零 P0/P1——四轮共 19 findings 全部采纳落档(v6.16~v6.19)**;**执行等待用户开工指令,不得自行启动**）
> **执行边界（用户指令 2026-07-20）：本计划仅供评审。计划共识完成后停住等用户指令，不得开始任何实现。**
> **自包含声明**：本文件不引用任何未入仓的历史版本；在全新 checkout 中仅凭本文件 + 文中显式路径的已入仓权威文档即可执行。

---

> **本计划与既有文档的关系（先读）**：
> - 骨架继承 `docs/login-redesign/landing-plan.md`（final v2 · 三方共识版），增量吸收 `design.md` §7 demo 拍板与用户 2026-07-20 新拍板；冲突处置见 §「与 landing-plan 的差异表」。
> - **交付合约 = §「百分百还原验收框架」**。
> - 现网代码事实权威：`login-ui-inventory-f8760bed.md`（main@f8760bed）+ `recheck/*`；实现基线 = 最新 `origin/main`。

## 参数权威链（四层闭环）

任何落码数值必须能溯源到下列四层之一，**demo 不是数值来源**（例外见第 4 条）：

1. **`figma-component-spec.md`**：设计稿实测参数（带 nodeId）。
2. **`design.md`**：用户拍板 / lead 延展决策。
3. **`adaptation-spec.md`**：**仅「已拍板」「lead 细化」「设计稿已定义」条目可落码**；「建议·待拍板」条目一律不落码——需要用时必须先变成 U 清单条目取得用户裁决，不允许先落码事后补批。
4. **demo（`docs/cindy-login-hifi.html`）**：呈现仲裁（状态覆盖、布局构图、动画次序、4 语文案呈现）+ demo 源码内嵌「用户拍板」注释视同拍板记录。demo 的 DOM/CSS 数值不得目测抄写。

**Hard-stop（全 Step 通用）**：四层均查不到、任一层仍标待拍板、或层间冲突 → 记 GAP / 升 U 项交用户，禁止目测取值、禁止自选默认。层间冲突默认流程：先按 demo 复核呈现，再回改文档（design.md 文首规则）。

**依此链已定案的收口项**：
- **桌面缩放公式** = demo `desktopScale()`（用户拍板 v3.1，demo:1809-1815）：`scale = min(1, viewportHeight/2098, (viewportWidth-24)/680)`——高度基准 = 整画布高 2098（保留设计稿上下留白比例），宽度不参与缩放（`panelGuard=(w-24)/680` 仅在极端窄高下保护 680 面板）；配合 Slogan 窄窗左移（adaptation §1.1 条 8，用户确认方向）;背景按 wave4 白底体系铺满（原红底外溢裁切规则随 wave4 作废）。adaptation §1.1 条 5/6（fitScale/minScale 0.36）作废，随本计划回写标注。
- **移动长屏立绘 y = 116 双区统一**（adaptation §3.2 条 5〔已拍板 2026-07-19〕，基准帧 `358:434`）。
- **iPad/平板横竖屏纳入本期**（adaptation §3.6〔lead 细化〕参数已齐：竖屏 744×1133 基准 ≈0.794 等比、横屏 1180×820 左右构图缩放 **= demo 实际实现 `max(0.85, min(w/1180, h/820))`（仅下限 0.85、无 1.30 上限）**——adaptation §3.6 条 3 的 clamp[0.85,1.30] 与 demo 冲突,按「demo 呈现仲裁」于本计划评审期收口为 demo 行为（真机档最大 1.1661,上限无实际影响）,随本计划回写 adaptation；断点 landscape∧w≥1000pt∧h≥690pt → 横屏左右构图 / portrait∧w≥700pt → iPad 竖屏 / 其余 → 手机规则）；并入 PR4b 且为 SC-9 前置。
- **白底体系(wave4,2026-07-20 用户拍板,design.md §8 权威)**:登录流程全端从品牌红全屏底改为白底体系——底色=**不透明 `var(--surface)` token(用户指令 2026-07-20 复用 main 已合入 Splash v2 白底,正主 PR #104、#123 为透明度收口;cindy-light 现值 #EDEDED,figma 标注 #F1F0F1 改判为 token 消费、以 token 现值为准)** + 两层 `#F70121` 渐变(径向 α1→α0@0.747 中心右上外(128%,7%) opacity6% + 线性向左下 opacity5%,代码复现非资产)、窗框双描边换色(外层 `#A3A8AD` 2px **r18** + 内层 `#FFFFFF` 2px inside **r16**)、字标黑红版(`368:1381` 位图 423×145,透明底)、SLOGAN `#2A2828` 矢量、全部 UI 面板加 `#D4D4D4` 1px inside 描边、Splash 五态统一面板化(参数全表见 design.md §8.1);**面板内组件几何与配色零变化**。**demo 基准分层**:背景/字标/slogan/面板描边/Splash 呈现五维度以 wave4 新帧(368:1375/379:5xx)截图为验收基准,其余维度(布局坐标/状态覆盖/交互/动画时序/文案/语言)仍以 demo 为准;demo 重制并重新验收后恢复单一基准。移动/iPad 无专属新帧,按「桌面 wave4 视觉参数 + 各自旧帧布局几何」合成(design.md §8.2 延展)。
- **adaptation 全部「建议·待拍板」条目已逐条处置**（附录 C 处置表,v5）：或经 U-1~U-10 用户裁决关闭,或登记为工程定案（lead 决策,随本计划回写权威文档）,不存在留给执行者自选的项。执行中新发现的缺口仍按 Hard-stop 升 GAP/U。

---

## 2. Review 对齐

- REVIEW_DOMAIN: `app_code`
- REVIEW_FOCUS: `像素/动效保真与四层权威链纪律（已裁决项按裁决落码,新增缺口即升 GAP/U）; auth 状态机零回归（真实 client + scenario fetch 注入，schema 路径全真）; 主题/i18n 体系合规（zh-TW 双端 fallback 链与全仓 locale 消费者盘点）; 验收可判定性（矩阵 checker 终态精确定义、state manifest、SC 命令真实可执行）; 跨端回归（handoff 双端契约、移动键盘单源位移、Android 构建路径、深链双 scheme、reduced-motion）`

---

## 目标链（Goal Chain）

```
PROJECT_GOAL: （本仓无 PROJECT_GOAL.md；以用户指令为准）Cindy 全端登录链路换上品牌红新皮肤
CHAIN_GOAL:   设计侧已完成全部拍板并交付验收 demo；不落地实现则设计资产与三轮审计全部沉没
PHASE_GOAL:   fidelity 总矩阵收官为 100% VERIFIED（或用户接受的 ACCEPTED_WITH_WAIVERS，waiver 清单单列）
TASK_GOAL:    每个 PR 合并前 `pnpm test:unit` exit 0 + `node scripts/check-fidelity-matrix.mjs --slice <prN>` 输出 SLICE_OK
```

---

## 百分百还原验收框架（总合约，`〔用户拍板 2026-07-20〕`）

> ⚠️ **验收方式更替声明（2026-07-21 用户拍板，覆盖全文）**：本框架原定的 **`--final` 矩阵终验门（"零 GAP 才能 main / `100% VERIFIED` 才算完成"）已废弃**。验收流程更替为「scenario 采集 + SC 命令（SC-1~SC-8 各机器门）+ e2e 报告 → 沙盒手动测试」。下方终态定义、SC-9 `--final` 门、PHASE_GOAL「收官为 100% VERIFIED」、U-4「终态目标仍为 100% VERIFIED」、PR5「`--final` 按终态二分宣告」等措辞**保留为 checker 机读契约的历史口径,不再作为合入 main 的硬门,亦不据此宣称"必须零 GAP 才算完成"**。
> **据实未覆盖面**：Windows 与 iPad 端视觉验证仍待补（沙盒手测尚未覆盖这两端）;fidelity 矩阵机读块中现存 GAP 为**真实状态,不冒充已验**,沙盒手测补齐前不假填为 PASS。

**交付定义：设计基准的全部静态与动态效果，在 6 端 × 5 语 × cn/global 上 100% 还原。设计基准 = 分层(wave4 拍板)：背景/字标/Slogan/面板描边/Splash 呈现五维度以 wave4 新帧(368:1375/379:5xx)为准;布局、状态覆盖、交互、动画时序、文案、语言以 demo 为准。全文所有「对照 demo」的验收入口均受此分层约束。**

1. **fidelity 总矩阵**（`acceptance/fidelity-matrix.md`，PR0a 交付 schema + 骨架 + checker，随 PR 填格）：
   - **行 = demo 状态选择器逐项枚举的全部呈现单元**（PR0-docs 先冻结独立全集锚 `acceptance/required-state-catalog.json`——逐 rowId 显式枚举+行数;PR0a 据此实现 `acceptance/state-manifest.json`,checker 断言两者 rowId 集合精确相等,v6.16——manifest 不得同时充当「待验全集」与「被验对象」）：桌面 8 态 + preparing + ssoOrgMode 及各子变体、Splash 6 可见态 + 三失败弹窗、衔接动画（竖排/横屏/reduced-motion 终态）、回调三变体 × 深浅色、迁移弹窗三相、移动全链（启动闸门/config-missing/无 loginState 兜底/全登录态/键盘态/横竖屏）、错误码文案表（桌面 19 + 移动 15 + 双端 `error:<endpoint>:UNKNOWN_CODE` fallback 行 + 桌面无专属 key 代表项如 LOGIN_BUSY）。
   - **列 = 端 × 语言 × 区域**；state-manifest 为每行标注允许 N/A 的列范围。
   - **格值五种**：`PASS`（证据文件路径,checker 校验:位于 acceptance/evidence/、非空、扩展名白名单、图片可解码;**证据复用仅限 manifest 顶层 `evidenceReuseGroups` 声明的等价组**——checker 按文件 SHA256 检测重复,组外重复一律 FAIL,复用维度禁止跨 device/region/文案行（合法场景仅纯图形行跨 locale 等）,`allowReason` 降为说明性字段、无授权效力（v6.16）;**每份 PASS 证据配 sidecar 元数据文件** `<evidence>.meta.json`{evidenceSha256,testedCodeCommit,capturedCellRef,reuseGroupId?,applicableCellRefs[],scenario,capturedAt}（v6.17 坐标改以 cellRef 表达,消除「单标量 locale 字段 vs 多 locale 复用」互斥：单格证据 applicableCellRefs=[capturedCellRef];复用证据 applicableCellRefs 必须与 manifest 声明组的 cells **精确相等**,组内各 ref 的 device/region 分量一致、仅 locale 分量变化;引用该证据的每个格必须出现在 applicableCellRefs 内）,review 记录绑定 cellRef+evidenceSha256+baseline ref;**`--for-main` 提交语义（v6.17 拆 C/H 两层,v6.18 改判定模型+收窄产物白名单）**：sidecar/report 记录 `testedCodeCommit = C`（代码冻结 commit,在 C 上构建并完成全部验收）;验收产物随后以 **acceptance-artifact-only commit** 入仓形成终审 HEAD=H。**判定模型 = tree entry tuple 对比（v6.18 立 blob OID 模型免疫 merge 策略,v6.19 升级——blob OID 不含 mode/type,100644→100755 或文件→symlink 复用同一 blob 可绕过）**:checker 对 C 与 H 的 `git ls-tree -r` 结果,过滤四项 artifact allowlist 后比较**规范化 tuple `{path,mode,type,objectId}` 的集合**——两侧路径集合及每项 tuple 必须精确相等,任一新增/删除/mode 变化/type 变化/OID 变化均 exit 非零（C 的全 SHA 记录于 report 且须存在于仓库对象库;不依赖 C 在 H 祖先链上,免疫 squash/rebase）——artifact allowlist 冻结为四项:`docs/login-redesign/acceptance/fidelity-matrix.md`、`docs/login-redesign/acceptance/evidence/**`（含 `*.meta.json` sidecar）、`docs/login-redesign/acceptance/e2e/report.json`、`docs/login-redesign/acceptance/e2e/evidence/**`;**三份冻结锚点（required-state-catalog/oauth-escape-baseline/required-e2e-cases）、`state-manifest.json`、`translation-review.json`、全部 schema/fixture/checker/构建配置均在 allowlist 外**——H 若动它们即 exit 非零（堵「H 同改 catalog+manifest 使错误 ground truth 再次相等」的绕过;锚点经批准的变更必须先以单独 docs PR 合入并入新 C 并全套重跑,不得混入 H）。**artifact 正规文件 + 引用闭包约束（v6.19——Node 读文件跟随 symlink,artifact 做成指向仓外的 symlink 可在验收机上读到内容而 Git 只存链接文本）**:H 中 `fidelity-matrix.md`、`e2e/report.json` 与全部被引用 evidence/sidecar 必须是 Git tree 内 **mode=100644、type=blob 的正规文件**,拒绝 symlink/gitlink;checker 校验内容必须从 H tree object 读取（或先核对工作树文件与 H object 一致）;**两个 evidence 目录在 H 中的路径集合必须与 matrix/report 的引用闭包精确相等**（fidelity 证据+对应 meta sidecar;e2e report 引用的证据）——未被引用的额外文件 exit 非零。**closeout 与 --for-main 分层时序（v6.19 修正——各实现 PR closeout 时最终 C/H 尚不存在）**:各实现 PR closeout 在**该 PR HEAD** 运行本 slice SC + wave4 门等既有三件套,**不运行 `--for-main`**;全部实现与获批锚点变更冻结后,该源码+契约树的 commit 定义为 C（不限定必须是「最后一个实现 commit」——锚点批准 docs PR 晚于末实现 commit 时,C 即含该 docs PR 的合入结果）;基于 C 重跑全套验收并追加仅含四项闭包 artifact 的 commit(s) 形成 H;**仅 integration → main 的最终 closeout 在 H 上运行 SC-9 链式双门 `--for-main`**;像素保真人审字段 reviewer/approvedAt 必填）/ `FAIL` / `GAP`（裁决人/日期/结论三元组；**仅允许作为 slice 中间态**）/ `N/A`（**固定 `reasonCode` 枚举 + 可选 detail**，且必须在 manifest 允许范围内）/ `WAIVER`（仅限缺硬件/缺环境：用户批准记录+补测途径+截止时间）。不允许空格。
2. **终态精确定义（v4 收口）**：
   - `100% VERIFIED`：所有**适用格** = PASS；所有不适用格 = manifest 允许范围内的合法 N/A；`FAIL = GAP = WAIVER = 0`。
   - `ACCEPTED_WITH_WAIVERS`：仅 `WAIVER > 0`，其余适用格全 PASS、N/A 同规则、`FAIL = GAP = 0`；waiver 清单单列。
   - **GAP 在 final 模式一律失败**：裁决改变目标后必须把该格重验为 PASS，或经批准更新 manifest 转为合法 N/A。
   - checker 验收 fixture 四例：纯 PASS+合法 N/A → `:VERIFIED`；含批准 WAIVER → `:WAIVERS`；含任一 GAP → exit 非零；含 manifest 外 N/A → exit 非零。
3. **静态判定 = 逐参数对照**（四层链取值;截图并排 + devtools 抽测;字体族差异记 NOTE）。**基准分层（wave4）**:背景/字标/slogan/面板描边/Splash 呈现五维度对照 wave4 新帧截图（368:1375/379:5xx）;其余维度对照 demo。
4. **动态判定 = 时序表逐项 + 60fps 录屏逐帧**（衔接动画、态过渡、键盘位移、倒计时、reduced-motion 终态）。
5. **语言判定（=U-6）**：demo 的 **desktop/callback 文案四语完整（zh-CN/en/ja/ko）,状态/布局拓扑四语可切**（主链路画布与状态补齐 tab 均随语言选择器渲染,另有四语完整性自检面板）——这些列全程对照 demo。**mobile 文案 demo 仅 zh/en,ja/ko 呈现的是旧拍板英文回退**,故移动 ja/ko 列无 demo 文字基准。仅 **zh-TW 列（全端）与移动 ja/ko 列**无 demo 文字基准（前者晚于 demo 冻结，全文检索 0 命中；后者 demo 呈现的是已被 5 语新拍板取代的英文回退旧拍板）——这两块验收 = demo 布局 + i18n 文件文案（现网 verbatim + 新 key 5 语翻译）。全部语言列逐语截图核换行/溢出；缺 key 静默回退 = FAIL。
6. **每 PR 分片门禁**：checker 对本 PR slice 运行；slice 无 FAIL/空格/未批 WAIVER 方可合并。缺硬件的列在首个相关 slice 即触发 U-4 安排（已裁决：QA 途径）。

---

## 非目标（Non-Goals）

- **不改 auth 状态机语义与协议层**——`packages/auth-client/src/**` 零改动；harness = 真实 `CindyAuthClient` + dev-only scenario fetch（Step 0）；`package.json`/`tsconfig.json` 仅允许追加 `./fixtures` subpath export/include。42s 倒计时为 renderer/RN 本地状态（Step 3a 契约）。
- **不做 provider/ghost/claude/xai/generic 授权页壳的视觉新皮肤**（design.md §7.1）；PR3 三项功能硬门禁保留；generic 裸 `done` 修复**拍板为复用现有 shared builder + legacy visual**，测试断言唯一输出路径。
- **不做登录成功后过渡帧**（LocalDbGate 帧、fatal 白屏既有问题不在本次范围）。
- **不动 xdt-updater 模块**（规则 21）；Splash 只改 renderer 呈现层（useSplash 14-phase 结构下可行，已经 reviewer 核实）。
- **不改 BrowserWindow 原生窗框/最小尺寸/交通灯**——描边走 renderer overlay；min 尺寸 = U-3。
- **不改 Android 全局 soft-input 配置**（v4 键盘方案 B，见 Step 5b；AndroidManifest 的 `windowSoftInputMode` 保持现状，测试断言未被改动）。
- **不跨仓改 cindy-server / auth-server**；移动浏览器终态页承载（landing-plan #30）范围外。
- **不上 WeChat 入口**（服务端 `providers.social` 驱动，出现时按圆钮行规格渲染，design.md §5）。
- **不新增 IPC channel / device-link allowlist 条目**（规则 13/26② N/A；harness 进程内注入。若被迫新增 IPC → hard-stop 重审）。
- **不引入 OpenCC 依赖**（zh-TW 按 U-1 裁决全量接入：译文直接产出，登录域人工精校 + 非登录域抽检，Step 1）。
- **不删除虚构状态**（v4）：桌面 handoff 不存在 `auth-init-failed` 独立分支——现网 AuthContext 无初始化错误态、main 侧冷启异常已归一为未登录（`authManager.ts:1012-1028` 语义），handoff 只有未登录/已登录两分支。
- **不改 system prompt、不动 packages/maker-core**；不修改 `/Users/praise/.claude/**`；不动 `skin/cindy-theme-family` 分支未提交工作；实现分支从最新 `origin/main` 拉出。

---

## 需用户裁决清单（U 清单）

> **状态：U-1~U-11 全部已裁决（2026-07-20）,无开放裁决项。**各行「合并阻塞点」的语义：对应 PR 合并前按本行裁决落码并验收。

| # | 事项 | 候选默认 | 合并阻塞点 | 状态 |
|---|---|---|---|---|
| U-1 | zh-TW 接入方式 | — | PR0b | **已裁决 2026-07-20**「参考 cindy 项目目前的做法」= **按现网 locale 同标准全量接入**：zh-TW 进 `SUPPORTED_LOCALES`，`locales/zh-TW/common.json` **全量 key 翻译**（与现有 ja/ko 同标准，规则 18 翻准；登录域人工精校为 PR0b merge gate，非登录域同标准翻译 + 抽检记录）；`i18nCompleteness` 对 zh-TW 与其他 locale 同口径（**不开域收口例外**）；全部 SUPPORTED_LOCALES 消费者补 zh-TW 分支（main i18n Record、菜单字典、LanguageSection、VoiceInputSection、HelpLocale 族、selection-context-menu——不再折叠简中）；仍保留 fallback 链 renderer `{'zh-TW':['zh-CN','en'],default:['en']}` / main `zh-TW→zh-CN→en→key` 作防漏兜底；`resolveSystemLocale` zh-Hant/HK/MO→zh-TW；不引入 OpenCC 依赖（译文直接产出+校对） |
| U-2 | 回调失败 detail 契约 | — | PR3 | **已裁决 2026-07-20**「参考 cindy 项目目前的做法」= **沿现网行为：detail 只展示标准错误码单行**（inventory §2.3 现网 detail=错误码），不透传上游自由文本；escape + 超长边界测试照 Step 4.3 |
| U-3 | 窗口 min 尺寸 | — | PR2a 合并 | **已裁决 2026-07-20（终裁,用户二次确认）：维持 800×600 不改**,并**显式覆盖/撤销 demo 内〔用户拍板 v3〕「最小窗口 440×568、落地需同步 BrowserWindow min」旧记录**(demo:1164/1722 注释与尺寸芯片)。BrowserWindow 配置保持禁区;极小窗口 scale≈0.286 为已知可接受行为。**前置文档回写**(PR2a 开工前,不等 PR5):demo 该注释标注「已被 2026-07-20 终裁覆盖」+ adaptation §1.2/#13/#14 对应条目关闭,消除层间双拍板冲突 |
| U-4 | 缺硬件/环境列的验收安排 | — | — | **已裁决 2026-07-20**：mac + iPhone = 用户亲测；Windows / Android phone 真机 / **Android pad 真机** / iPad 真机 / global 打包件 = **移交 Lizi 安排 QA 实测**（QA gate 逐字列全 6 端：mac/Windows/iPhone/Android phone/iPad/Android pad）。矩阵语义：这些列在 QA 回报前标 WAIVER（批准记录=本裁决，补测途径=Lizi QA，截止=合入 main 前），QA 证据回报后升级 PASS；QA 实测完成是合入 main 的前置（见执行编排段），终态目标仍为 100% VERIFIED |
| U-5 | Android 模拟器/构建环境 | — | PR4a 开工前打通 app 构建路径 | **部分就绪 2026-07-20**：Android Studio + cmdline-tools + SDK（platform-tools/emulator/Android 35 arm64 镜像）已装；AVD `cindy-phone`(Pixel 8) 已建且 **boot 冒烟通过**、`cindy-tablet`(Pixel Tablet) 已建（冒烟待跑）；`ANDROID_HOME` 已入 shell profile。**未就绪**：Cindy app 的 Android 构建/安装路径——仅 `mobile:sim:rebuild`/`mobile:sim:whoami` 为 iOS-only 脚本（xcrun/simctl）,`mobile:sim:start` 为通用 Metro 双端复用（v6.7 与 Step 5-pre 口径统一），Android 初装用 `pnpm --filter mobile android`(larksso flatDir 旧风险已随模块删除解除)+ Metro 复用 mobile:sim:start，PR4a 开工前打通并把命令写入 checklist（见 Step 5-pre） |
| U-6 | 语言列验收基准 | — | PR0b | **已裁决 2026-07-20**「参考 cindy 项目目前的做法」= **基准拆分成立，文字基准 = 项目现行 i18n 体系**：desktop/callback 的 4 语列（文案完整）全程对照 demo；**zh-TW 列（全端）与移动 ja/ko 列**（demo 移动 catalog 仅 zh/en,ja/ko 为旧英文回退,不作参考文案）= demo 布局 + i18n 文件文案（现网 verbatim + 新 key 按现行翻译标准产出） |
| U-7 | 回调资源承载方式（adaptation #25） | — | PR3 | **已裁决 2026-07-20：data URI 内嵌**（预裁切 280×280@2x webp ≤120KB/张，占位固定尺寸+失败降级）；随本计划回写 adaptation #25 关闭 |
| U-8a | 移动布局插值/两档外策略（adaptation #18/19/20） | — | PR4a 合并 | **已裁决 2026-07-20：照 demo**（demo 已实现并经用户验收的插值与两档外行为落码）；随本计划回写 adaptation 对应条目关闭 |
| U-8b | 键盘弹起可见性硬标准（含悬浮/分离键盘，adaptation §3.6 条 6） | — | PR4b 合并 | **已裁决 2026-07-20（用户原话）「要保证键盘弹起时，登录界面的 ui 输入框和继续/登录按钮完整显示出来」**——落码语义：任何键盘形态弹起时，当前输入框 + 主按钮（继续/登录）必须完整可见,此为硬验收标准（矩阵键盘态行的判定依据）。停靠键盘 = 10px 贴附方案（Step 5b.1）；悬浮/分离键盘 = 与面板发生遮挡时按遮挡量上移、不遮挡不动;**限定(U-11 裁决 2026-07-20):本硬标准适用于除 Android 悬浮键盘外的全部键盘形态;Android 悬浮键盘=系统 adjustResize 保底的显式例外** |
| U-9 | Text_link pressed 态（figma 无节点） | — | PR2a 合并 | **已裁决 2026-07-20**「在默认色值上加深一点即可,你决定」——lead 受托定值：pressed = default `#2A2828` 加深至 **`#1A1818`**（保持 underline、字号字重不变，双端 pressed 通用）；wave3 实测节点落地后以实测替换；**PR2a 开工前回写 design.md §2.2**（原「pressed 暂按 default」句更新为本裁决值,消除层间冲突） |
| U-10 | 回调页跨视口自适应（adaptation #24 原待拍板：top-biased anchor 80/88px + 缩放公式） | — | PR3 合并 | **已裁决 2026-07-20（用户原话）「照 demo；中间 ui 面板和组件大小样式全都不变,适配只改变背后纯色背景」**——落码语义：回调卡为恒定 680×680 组合,内部组件大小/样式/布局零响应式变化（不重排、不改字号控件尺寸）;适配仅：①卡外纯色背景（浅 `#EEEEEE`/深 `#2A2828`）铺满视口;②视口放不下整卡时按 demo 行为整卡等比缩放（组合恒定,非组件级调整）,锚点/缩放按 demo 呈现仲裁;不得裁切 CTA。随本计划回写 adaptation #24 关闭 |
| U-11 | Android 悬浮键盘可见性判定路径（RN Android adjustResize 下 JS 拿不到浮动 IME 真实矩形,U-8b 硬标准与首版可行性冲突;v6.7 由原 GAP-9 升格） | — | ~~PR4b 开工前置阻塞~~（已解除） | **已裁决 2026-07-20(用户原话「b 这种小场景先不管」)= 选项 B:Android 悬浮键盘例外**——该形态不触发自定义上移,系统 adjustResize 保底+用户可拖键盘避让;U-8b 硬标准适用范围同步限定(见该行);矩阵 Android 悬浮键盘行按本例外口径判定(显式合法口径,非 GAP、非 typed N/A);选项 A 的 native helper 不实施。PR4b 开工阻塞解除 |

---

## 成功标准（SC）

- [ ] SC-1：scenario harness 双端落地、schema 路径全真、生产构建强制忽略
  - verify (method: test): `pnpm --filter @cindy/auth-client exec vitest run fixtures && pnpm --filter desktop exec vitest run src/main/__tests__/loginScenarioHarness.test.ts && pnpm --filter mobile exec vitest run src/auth/__tests__/loginScenarioHarness.test.ts && pnpm --filter desktop exec vitest run src/renderer/hooks/__tests__/useSplashFixture.test.ts && node scripts/check-login-production-guard.mjs`
  - expect: 前四条 vitest 全 PASS + 末条输出 `LOGIN_PRODUCTION_GUARD_OK`。用例硬性包含：①Step 0 附录 A 场景表逐行断言（目标 action/state，非仅 code）；②malformed fixture payload → 真实 zod 校验抛 `INVALID_RESPONSE`；③desktop `app.isPackaged` / mobile 非 `__DEV__` / renderer 非 `import.meta.env.DEV` 三处 guard 下 harness 全部失效（含 splash fixture production-mode 断言）。**生产泄漏机器门（v6.16,取代旧「另附一次 bundle 扫描证据」的手工承诺——不可机器判定+grep 符号名可被 minify 改名假阴）**：fixtures 模块内置唯一字符串 sentinel `__CINDY_LOGIN_FIXTURE_SENTINEL__`（字符串字面量,minify 不改名）;生产构建经 bundler 条件把 fixtures 整模块替换为空 stub（desktop Vite `define`/alias、mobile Metro/babel 条件——运行时 guard 不保证 bundler 删模块,必须 build-time 排除）;`check-login-production-guard.mjs` 冻结构建目标与产物路径全集（desktop main+renderer 生产产物、mobile `expo export` 产物）,**先断言 dev 对照构建含 sentinel（证明扫描通道有效,防假阴）**,再断言全部生产产物不含 sentinel,全过才输出 `LOGIN_PRODUCTION_GUARD_OK`,任一断言失败 exit 非零
- [ ] SC-2：桌面全部登录态按独立冻结全集有测试映射,且映射用例全部真实执行通过
  - verify (method: command): `node scripts/check-state-manifest-coverage.mjs --platform desktop --run-mapped`
  - expect: `MANIFEST_COVERAGE_OK`。checker 三重职责（v6.16 重构,堵「manifest 同时充当待验全集与被验对象」的自指漏洞）：①**全集独立锚定**——`state-manifest.json` 的 rowId 集合必须与 PR0-docs 冻结的 `acceptance/required-state-catalog.json` 中本平台行**精确相等**（空 manifest/子集/超集均 exit 非零——删整行/整状态族即失败）,**且逐行断言 manifest 的 ground-truth 字段(rowKind/stateFamily/dimension/source/ref/applicability/naAllowed 约束)与 catalog 精确相等（v6.17——rowId 集合不变但把 wave4 期望改挂 demo/错误 nodeId 同样 exit 非零,baseline 期望的权威在 catalog 不在 manifest）**;catalog 变更只能走带用户批准记录的单独 docs PR,不得与实现 PR 同批自改自证;②每行 tests 映射到 **test file + 唯一 testId**,用 `pnpm --filter desktop exec vitest list --json` 解析收集到的用例逐一对上（本仓 Vitest 3.2.7 无 `--list` 参数,必须用 `list --json` 子命令——已实测）,checker 自测三例:testId 存在/不存在/重名——防全部行指向同一个无关 passing 文件;③**`--run-mapped` 真实执行全部映射用例**（不是固定两个目录）并解析 Vitest JSON 结果,逐项 `status===passed`——skipped/todo/pending/仅被收集未执行一律失败（收集≠通过,v6.16）
- [ ] SC-3：回调链三定向回归零回退
  - verify (method: command): `node scripts/check-oauth-regression-baseline.mjs`（内部执行 `pnpm --filter desktop exec vitest run src/main/__tests__/oauthResultPage.test.ts src/main/__tests__/authLoopbackCallback.test.ts src/main/maker-host/__tests__/genericOAuth.test.ts` 并解析 JSON 结果）
  - expect: `OAUTH_REGRESSION_BASELINE_OK current=N baseline=N0`（N≥N0）。**基线不再取自 PR Description 自报（v6.16——自报值可被写小,不构成防回退门）**：PR0-docs 冻结 `acceptance/oauth-escape-baseline.json`（从 origin/main 三个测试文件提取的 escape/security testId 全清单+计数,记录提取 commit SHA）;checker 断言基线清单内 testId 全部存在、非 skip/todo、本轮全部 passed,且当前 escape 用例总数 ≥ 基线数;PR3 新品牌分支的 providerName/detail/href/htmlLang/超长 Unicode 用例作为**必需 testId** 追加进 baseline 文件（只增不减,变更走与 catalog 同款的批准管制）
- [ ] SC-4：i18n 5 语齐全（zh-TW 全量接入 + 双端 fallback 行为）
  - verify (method: command): `node scripts/check-login-i18n-parity.mjs --scope all && pnpm check:i18n && pnpm --filter desktop exec vitest run src/main/__tests__/i18nFallback.test.ts`（v6.3 补:根级 `pnpm check:i18n`(scripts/check-i18n.mjs)对全部 SUPPORTED_LOCALES 做全 key 并集查缺——U-1 全量接入天然可过,无需改该脚本,列入门禁防漏）（--scope all 在三支 PR0b 全部合入 integration 后执行;各支合并门用对应 --scope,见 Step 1）
  - expect: `I18N_PARITY_OK` + fallback 行为测试 PASS。parity 脚本校验：zh-CN/en/ja/ko 登录域 key 全集一致非空；zh-TW 全量 key 齐且非空（与 i18nCompleteness 双闸）；mobile catalog 5 语 key 全集一致非空；locale-consumer-inventory 清单内每个显式 locale 集合**均真实接受 zh-TW（U-1 全量接入,不允许折叠）**；**⑤消费者双向核对（v6.16,堵「清单漏写即通过」自指）**:脚本对 `apps/desktop/src` + `apps/mobile/src` 做 locale 字面量静态扫描（定位含 locale 字面量集合的 Record/union/switch 文件）,命中文件必须已登记于 locale-consumer-inventory.md,清单项也必须在代码中真实存在（双向集合核对）,未登记命中 → exit 非零;扫描误报经脚本内冻结排除表处理,每项必须带排除理由+登记 reviewer,排除表变更走 review;**⑥翻译评审门（v6.16,「非空」不再是翻译完成判据）**:新增 `acceptance/translation-review.json` 绑定各 locale 文件 SHA256——demo/现网 verbatim 来源的 key 做**逐字符相等断言**;新增翻译 key 每条记录 reviewer/reviewedAt/source;zh-TW 登录域必须含人工精校记录（对应 merge gate 的机器化落点）;缺记录、SHA 不匹配、verbatim 不等 → exit 非零。fallback 测试断言：正常路径下 zh-TW 任意 key（登录/非登录）均取 zh-TW（全量 catalog）；用人为删 key 的隔离负 fixture 验兜底链 zh-CN → en；ja/ko 现行为不变
- [ ] SC-5：每 PR 合并前根目录 `pnpm test:unit` exit 0（AGENTS.md 硬门禁）**+ 本 PR 触及的 workspace typecheck/build exit 0（v6.16 补——Vitest 只转译不做全量类型检查,unit 绿 ≠ 可构建）**：触及 desktop → `pnpm --filter desktop typecheck`;触及 mobile → `pnpm --filter mobile typecheck`;触及 auth-client fixtures → `pnpm --filter @cindy/auth-client exec tsc --noEmit`。integration → main 终审前固定三连全部重跑（无论最后一个 PR 触及哪端）
- [ ] SC-6：桌面 fidelity 分片全绿（每条为独立可复制命令,各输出 `SLICE_OK`;owned 格 **GAP=0**、无 FAIL/空格/未批 WAIVER,预览用 `--preview-slice` 非门禁）：`node scripts/check-fidelity-matrix.mjs --slice pr1` / `node scripts/check-fidelity-matrix.mjs --slice pr2a` / `node scripts/check-fidelity-matrix.mjs --slice pr2b` / `node scripts/check-fidelity-matrix.mjs --slice pr3`
- [ ] SC-7：移动 fidelity 分片全绿 + 移动态映射真实执行：`node scripts/check-state-manifest-coverage.mjs --platform mobile --run-mapped` 输出 `MANIFEST_COVERAGE_OK`（v6.16 补——此前移动侧无 coverage 命令,PR4b 状态表「逐条测试」缺机器闭环;口径与 SC-2 完全一致:catalog 本平台行集合精确相等 + 映射用例真实执行全 passed）;`node scripts/check-fidelity-matrix.mjs --slice pr4a` 与 `node scripts/check-fidelity-matrix.mjs --slice pr4b` 各输出 `SLICE_OK`（owned 格 GAP=0;harness 全态证据与 real-smoke 证据分列；smoke=cn/global 深链冷/热 + 验证码登录录屏）
- [ ] SC-8：旧 `--login-*` token 全族退役：`node scripts/check-login-token-retirement.mjs` → `TOKEN_RETIREMENT_OK`（枚举 colors.ts 全部 9 个旧 token：login-bg/card-bg/card-border/divider/btn-bg/btn-text/btn-hover/help-text/error-text，注册+消费双清零；设置页 McpServerDialog/CustomProviderDialog 消费者迁移到 surface 族；**v6.16 删除 allowlist 机制——「双清零」与白名单保留自相矛盾:9 项任一注册或消费命中即 exit 非零,checker 无例外通道**;确需保留某项时必须先取得用户批准、以修订本 SC 的 docs PR 落档后再改 checker,不得在同一 checker 内加白名单后照常输出 OK）
- [ ] SC-9：矩阵收官 + e2e 报告门：`node scripts/check-fidelity-matrix.mjs --final` → `FIDELITY_MATRIX_OK:VERIFIED` 或 `:WAIVERS`（按§终态精确定义;GAP>0 或 manifest 外 N/A 一律 exit 非零）。⚠️ **本 SC 的 `--final` 矩阵终验门已于 2026-07-21 废弃（改沙盒手测,见 §百分百还原验收框架 验收方式更替声明）**;e2e 报告门(`check-login-e2e-report.mjs`)仍属流程内机器门,但 `--final` 矩阵零 GAP 不再作合入 main 硬门。**integration → main 终审用链式双门（v6.16）**：`node scripts/check-fidelity-matrix.mjs --final --for-main && node scripts/check-login-e2e-report.mjs --for-main`——前者只接受 `:VERIFIED`（`:WAIVERS` 仅表示阶段性接受,QA 回报全部升级 PASS 并重跑后方可过）;后者消费 `acceptance/e2e/report.json`,**required case universe 独立锚定于 PR0-docs 冻结的 `acceptance/required-e2e-cases.json`（v6.17——checker 不得自定义检查范围,防「checker 与 report 同源缩表」）**:校验 report caseId 集合与该 catalog **精确相等**（空/子/超集均败）、全部 case = PASS、证据路径存在+SHA256 记录、**提交语义按§框架第 1 条冻结（v6.19 tree-entry tuple 模型）**——report 记录 `testedCodeCommit=C` 与 `builds:[{buildId,sourceCommit,platform,region}]`,checker 逐 build 校验 `sourceCommit===C`,并按 artifact allowlist 外路径 C/H tree-entry tuple 全等 + allowlist 内正规文件/引用闭包约束判定（buildId 是产物标识、不与 commit 比等,消除 Git 自引用;report 本身必须是 100644 blob 正规文件,内容从 H tree object 读取）,输出 `LOGIN_E2E_OK`——缺 case、非当前 C 的旧报告、任一非 PASS 均 exit 非零（**e2e 由编排承诺升为 main 门的机器判定,v6.16**）

---

## 执行编排（`〔用户拍板 2026-07-20〕`，计划批准后仍须等用户开工指令）

1. **实现 worker**：Orca 多 worker，agent = claude-code，model = **Fable 5 / effort low**，每 worker 用 **goal skill** 驱动对应 PR 执行到 SC 全过；lead 按 DAG 自动安排串并行，**及时 idle/归档闲置 worker 为并行留空位**。
2. **前端效果验收**：全部 PR 执行完 → 派 codex **gpt-5.5 / xhigh** worker，用 goal skill 按本计划 SC 清单验收全部前端效果；**设计还原度（fidelity 矩阵,按分层基准:五维=wave4 帧/其余=demo）是最权威 SC**。⚠️ **本步「demo 终验门」已于 2026-07-21 废弃**（用户拍板取消）,改「采集 + SC + e2e 后沙盒手动测试」;设计还原度分层基准仍为参考口径,但不再要求零 GAP 才算完成（见 §百分百还原验收框架 验收方式更替声明）。
3. **e2e**：验收过 → 派 codex **gpt-5.4 / high** worker 执行**登录链 e2e 清单**（本仓无现成 e2e 框架,该 worker 第一任务=把清单落成可复跑的脚本+手工混合流程,产出报告与证据入 `acceptance/e2e/`;**交付物含 `acceptance/e2e/report.json`（caseId 严格取自 PR0-docs 冻结的 required-e2e-cases.json,逐 case PASS 状态/证据路径+SHA256/testedCodeCommit/builds:[{buildId,sourceCommit,platform,region}],v6.17）与 `scripts/check-login-e2e-report.mjs`——SC-9 的 main 链式双门消费,v6.16:e2e 不再只是编排承诺,缺报告或非当前 testedCodeCommit 报告过不了 main**）：桌面=真实验证码登录（cn 沙箱+global 沙箱）、社交/SSO 浏览器回调成功+取消+error 回调、错误码抽样(每 endpoint ≥1)、迁移弹窗(cn)、Splash 更新链走查;移动=深链冷/热×cn/global、原生社交按钮可用性矩阵、SSO 浏览器会话、键盘态、闸门错误重试。通过标准=清单全 PASS(证据齐);失败归属回执行 worker 修复后复跑。
4. **Git 纪律**：全程只提交到 feature 分支，**不合 main**；分支上全部测完、改完，加上人测（用户 mac/iPhone 亲测 + Lizi QA 完成 Windows/Android/iPad 真机/global 包实测）之后才允许合 main。

---

## 实施步骤

> **分支拓扑（v5 定稿,消除 bootstrap 死锁与依赖断链）**：
> 1. **PR0-docs（bootstrap,最先执行）**：分支 `feat/login-skin-docs` ← 最新 `origin/main`；把 docs/login-redesign 全套 + 两个 demo html + 资产目录入仓,commit message 记录各权威文件 SHA256 基线。**强制前置交付(v6.5)**:①wave4 权威回写在本 PR 内完成——design.md 旧红底段 inline 覆盖标注、adaptation-spec 全部红底/旧描边引用改判、**token-decision-table.md 改判(`login-brand-bg=#DF0C27` 等红底背景 token 语义改为 accent 专用,禁止表达页面背景)**、figma-component-spec 补 wave4 读取记录(含立绘 child 层裁定,见 Step 0 资产硬约束③);②静态扫描门禁（v6.9 冻结可执行合约）:入口 `scripts/check-login-wave4-authority.mjs`(随本 PR 交付,入 allowlist 与交付物清单);扫描全集=**五份文件**:design.md、adaptation-spec.md、token-decision-table.md、figma-component-spec.md、implementation-plan.md;禁词集=「红底铺满/恒红底/#7A0B19/#F26D7E/白字下划线失败态」等旧体系执行句词表(脚本内冻结数组);**历史/作废语境的确定性判定**=命中行自身含 `已作废`/`作废)`/`历史:`/`superseded` 标记,或位于「版本记录」「决策台账」表格行、或行首为引用/删除线——除此之外命中即失败;成功输出 `WAVE4_AUTHORITY_OK` + exit 0;配正负 fixture(未标记旧体系执行句→exit 非零;显式作废标注行→通过)。后续**每 PR closeout 复跑同一命令** `node scripts/check-login-wave4-authority.mjs`。**③冻结验收锚点三件(v6.16 增,v6.17 扩)**:(a)`acceptance/required-state-catalog.json`——**逐行全字段 ground truth（v6.17,只锚 rowId 集合防不住「集合不变、期望被篡改」）**:每行 `{rowId,platform,rowKind,stateFamily,dimension,source,ref,applicability,naAllowed 约束}`;coverage/fidelity checker 除 rowId 集合精确相等外,**逐行断言 manifest 的上述 ground-truth 字段与 catalog 精确相等**(SC-2/SC-7 锚);(b)`acceptance/oauth-escape-baseline.json`(从 origin/main 三个回调测试文件提取的 escape/security testId 全清单+计数+提取 commit SHA,SC-3 基线锚);(c)`acceptance/required-e2e-cases.json`（v6.17）——把执行编排§3 清单展开为**逐个 literal caseId**（platform×region×cold/hot×outcome/provider/endpoint 等必需参数的显式笛卡尔展开,不留自然语言项）,`check-login-e2e-report.mjs` 只做 report caseId 集合与此 catalog 精确相等+证据校验,不得自定义检查范围(SC-9 锚);**变更管制**:三文件入仓后的任何变更只能走带用户批准记录的单独 docs PR(catalog 行增删/escape 基线只增不减),实现 PR 不得同批自改自证。
> 2. **integration 分支**：`feat/login-skin-integration` ← PR0-docs 合入后的节点；**全部后续 PR base = integration、head = `feat/login-skin-<prN>`,合并方向 = 合入 integration**（stacked 依赖由此解决:后序 PR 从最新 integration 分叉即含前序成果）。
> 3. **main 只在最后**：全部 PR 合入 integration + 双 AI 验收 + e2e + 用户/QA 人测完成后,由 integration → main 发一个终审 PR,经用户明确批准合并。
> 4. **push 授权门禁（AGENTS 硬规）**：用户的「开工」指令 = 授权本批次向 `feat/login-skin-*` 分支 push（blanket 授权,记录于此;不含 main）；integration → main 的 push/merge 需用户届时单独确认。
> `skin/cindy-theme-family` 及其脏工作区不动。
> 执行环境：用户终端（非 Cindy 内嵌 agent 会话）；如在 dogfooding worktree 内执行，遵守 AGENTS.md worktree 契约。
> **每 PR closeout 硬门禁**：PR Description 必须含 ①模板三节（改了什么/怎么验证的/风险）；②规则 26 三问逐项结论——SSH 远程（本计划全部 PR：登录先于工作区选择，不涉及远程 workdir 路径，N/A + 一句理由）、device-link IPC（不新增 channel，N/A；有变化即 hard-stop）、手机版（指向 PR4a/4b 或本 PR 自含）；③`pnpm test:unit` 真实执行记录 + 本 PR SC 命令输出 + `node scripts/check-login-wave4-authority.mjs` → `WAVE4_AUTHORITY_OK`（v6.9,旧体系残留门）。全部改动走 PR，不直推 main。

```
DAG（全部 base=integration,合并即入 integration）:
      PR0-docs ──→ [integration 建立] ──→ PR0a ──→ PR0b-desktop / PR0b-callback / PR0b-mobile（三个独立 PR,可并行,各按 U-1/U-6 裁决落码）
      PR0a+PR0b-desktop ──→ PR1 ──→ PR2a（剩余登录态+错误+chrome overlay;按 U-3/U-9 裁决落码）
                                └──→ PR2b（Splash 6 态+三弹窗+handoff 双分支）
      PR0a+PR0b-callback ──→ PR3（回调页+迁移弹窗;按 U-2/U-7/U-10 裁决落码）
      PR0a+PR0b-mobile ──→ PR4-preflight（Android 构建打通,门禁见 Step 5-pre）──→ PR4a（移动 stage/组件/全登录态;按 U-8a 裁决落码）──→ PR4b（键盘/闸门/深链/handoff/横竖屏;按 U-8b 裁决落码）
      PR5（收尾）← PR2a+PR2b+PR3+PR4b 全部合入 integration 后;U-4 QA 途径在各相关 slice 已先行生效
      [integration → main 终审 PR] ← PR5 + 双 AI 验收 + e2e + 用户/QA 人测,经用户单独批准
```
> **slice 门禁强化（v5）**：`--slice` 对本 PR owned 格子强制 **GAP=0**（GAP 只允许存在于尚未到达门禁的格;预览用非门禁 `--preview-slice`）。

### Step 0：PR0a 基建（token / 资产 / scenario harness / 矩阵 checker） `[SC-1, SC-5]`

WHERE: `apps/desktop/src/renderer/themes/colors.ts`、`apps/desktop/src/renderer/assets/login/`（新）、`apps/desktop/src/main/assets/loginCallbackAssets.ts`（U-7 批 data URI 时新建）、`packages/auth-client/fixtures/loginScenarios.ts`（新目录）、`packages/auth-client/package.json` + `tsconfig.json`（仅追加 `./fixtures` export 与 include）、`apps/desktop/src/main/authManager.ts`（仅 client 构造参数注入点）、`apps/mobile/src/auth/AuthContext.tsx`（仅 `authClientFor` 构造参数注入点）、`apps/mobile/src/theme/tokens.ts`（+ token 守护测试）、`apps/mobile/assets/login/`（新）、`scripts/restart-desktop-remote.mjs` + `scripts/__tests__/restart-desktop-remote.test.mjs`、`scripts/check-fidelity-matrix.mjs`（新）、`scripts/check-state-manifest-coverage.mjs`（新）、`scripts/check-login-production-guard.mjs`（新,v6.17）、`scripts/check-oauth-regression-baseline.mjs`（新,v6.17;基线文件由 PR0-docs 冻结,脚本随本 PR 交付）、`apps/desktop/vite.main.config.ts` + `apps/desktop/vite.renderer.config.ts`（仅 fixtures 生产 alias/stub 条件,v6.17）、`apps/mobile/metro.config.js`（仅 fixture 生产 stub 条件,v6.17）、`docs/login-redesign/acceptance/{fidelity-matrix.md,state-manifest.json}`（新）

WHAT:
1. **桌面 token**：注册 `--login-brand-*` 族（色值指向 `figma-component-spec.md` §1 / `token-decision-table.md`）**+ 白底体系 token 组(wave4):`--login-bg-base`(#F1F0F1)、**品牌红 #DF0C27 族 token 语义限定为 accent(Global pill/字标红元素),命名/注释禁止表达页面背景**、`--login-bg-gradient-radial/-linear`(两层 #F70121 渐变参数)、`--login-window-border-outer`(#A3A8AD)/`--login-window-border-inner`(#FFFFFF)、`--login-panel-border`(#D4D4D4)+ `--login-link-pressed`(#1A1818,U-9 裁决值)**，语义 = 跨主题恒定品牌豁免色（规则 16 豁免族），各主题不 override；旧 `--login-*` 9 个 token 本 PR 不动（PR5 统一退役），禁止撞名混义。**移动 token**：`apps/mobile/src/theme/tokens.ts` 新增 login 语义色/尺寸组（跨 light/dark 恒定；错误文字用新 `loginError` token，不得复用 `statusError`——语义违规），同步移动 token 守护测试。
2. **静态资产**（双端打包资源；UI 静态打包资源不是运行时媒体字节，不走 cindy-media 总仓——规则 25 边界判断在 PR Description 写明）。硬约束四条（wave4 更新）：①**字标用黑红新版**（`368:1381`,位图 423×145,**自带透明底——旧红底告警与绿通道抠图过渡方案对字标作废**）;SLOGAN 用 `#2A2828` 矢量新版（`368:1394`,导出透明件或代码渲染）;②字标内层几何按 wave4:容器 680×180 @570,1029、内层 423×145 @(128,17)（绝对≈698,1046）;slogan 453.2×129.1 几何沿旧;移动/iPad 帧无新版,视觉参数继承桌面、布局几何按 wave3.5 旧表,容器框仅定位参考;③立绘几何不变（934×934@443,275）;**立绘资产来源裁定入 PR0-docs（v6.4）**:wave4 读取记录确认新帧立绘 child 是否存在独立新图层——若立绘本体未变则**复用旧 source(347:971/347:2707),背景渐变仅由代码绘制一次**(默认路径,§8.1 已定义渐变为代码复现);若确有新独立资产则以 nodeId 登记进 design §8/figma-component-spec/asset-manifest 后使用;禁止从 wave4 frame 自选导出层;④DPI 策略：桌面 `image-set()` 1x/2x、移动 RN `@2x/@3x`，验收含 macOS Retina 与 Windows 125%/150%;回调 chibi 三表情按 adaptation §5 条 6 预裁切 280/560/840 透明件。清单落 `asset-manifest.md`（文件名/尺寸/nodeId/双端归属/透明底验收/DPI 档）。
3. **字体**（`〔用户拍板 2026-07-20〕`「字体用 cindy 默认自带即可」）：桌面沿用 `--app-font-ui-default` 字体栈、移动用 RN 默认字体配置，不引入 HarmonyOS Sans SC；figma 排版表只取字号/字重/行高。PR0a Description 显式声明。
4. **scenario harness（终态）**：
   - **注入形态 = 真实 `CindyAuthClient` + scenario `AuthFetch`**：fixtures 导出 `createScenarioFetch(scenario): AuthFetch`；双端始终 `new CindyAuthClient({...真实配置, fetch: devScenarioFetch ?? realFetch})`——不替换 client、不 fake 方法，zod schema/错误归一/REGION_MISMATCH 路径全真。
   - `packages/auth-client/package.json` 追加 `"./fixtures": "./fixtures/loginScenarios.ts"`、`tsconfig.json` include 追加 `fixtures/**/*`；package 级 adapter 测试（真实 client + scenario fetch 全 endpoint 走查 + malformed → INVALID_RESPONSE）。
   - **场景 → 拦截 → 预期全表冻结**（附录 A，实现照表生成，adapter 测试逐行断言）。
   - guard 三处写死：desktop `!app.isPackaged && process.env.XDT_LOGIN_SCENARIO`；mobile `__DEV__ && EXPO_PUBLIC_LOGIN_SCENARIO`；splash fixture 读取点 `import.meta.env.DEV && import.meta.env.VITE_SPLASH_PHASE_FIXTURE`（VITE_* 会被生产构建烘焙，必须 DEV 短路；production-mode 测试断言 PROD 忽略）。**生产排除双保险（v6.16）**:运行时 guard 之外,fixtures 模块经 bundler 条件在生产构建整体替换为空 stub（desktop Vite `define`/alias、mobile Metro/babel 条件——main 禁运行时动态 import,故 desktop main 侧走静态 import + build-time alias stub 路径,不靠运行时 guard 删代码）;模块内置字符串 sentinel `__CINDY_LOGIN_FIXTURE_SENTINEL__`,`scripts/check-login-production-guard.mjs`（本 PR 交付,SC-1 消费）按「dev 对照构建含 sentinel → 生产产物全集不含」双断言判定,产物路径与构建命令冻结在脚本内。
   - env 透传：`XDT_LOGIN_SCENARIO`、`VITE_SPLASH_PHASE_FIXTURE` 加入 `restart-desktop-remote.mjs` devEnvPrefix 白名单 + mac/Win 转义与透传测试。
5. **矩阵基建**：`fidelity-matrix.md` schema（格值五枚举、N/A reasonCode enum、WAIVER/GAP 三元组字段）+ `state-manifest.json`（行按 PR0-docs 冻结的 required-state-catalog 实现,含每行允许 N/A 列范围 + 测试映射字段）+ **本 PR 交付四个 checker 脚本（v6.17 归属明确化）**：`check-fidelity-matrix.mjs`（`--slice`/`--final` 模式，终态判定按§框架第 2 条，附验收 fixture）、`check-state-manifest-coverage.mjs`（含 `--run-mapped`）、`check-login-production-guard.mjs`（SC-1 消费）、`check-oauth-regression-baseline.mjs`（SC-3 消费,基线文件在 PR0-docs）;`check-login-e2e-report.mjs` 由 e2e 阶段交付（执行编排§3）,`check-login-i18n-parity.mjs` 归 PR0b、`check-login-token-retirement.mjs` 归 PR5、`check-login-wave4-authority.mjs` 归 PR0-docs。

WHY: harness 是「全状态可遍历」的唯一可达机制且形态已经 reviewer 按 origin/main 类型/导出核实可行；矩阵 checker 前移到每 PR 才能阻止带坏格子合并。

VERIFY: SC-1 全部命令 + `pnpm --filter desktop typecheck` + `pnpm --filter mobile typecheck` → exit 0

**Hard-stop**：`AuthFetch` 构造参数注入点与现网签名不符 → 停，回报实际签名再定，不得改 src；colors.ts 无法表达豁免 token → 停与用户确认落点。

#### 附录 A：scenario → 拦截 endpoint → 预期表（冻结；`XDT_LOGIN_SCENARIO` / `EXPO_PUBLIC_LOGIN_SCENARIO` 的合法值域）

| scenario token | 拦截点 | 默认前置 | 预期 UI/state |
|---|---|---|---|
| `providers:phone-only` / `providers:email-only` / `providers:both` / `providers:cn-social` / `providers:global-social` | `GET /api/auth/providers` | — | identifier 态渲染对应 tabs/社交钮组合；global-social 含 providers.region=global（**仅验 provider 组合，不冒充构建区域**） |
| `sso:single` / `sso:multi` / `sso:required` | providers 正常(email) + `discover` / `sso discovery` 响应 | 输入 email 提交 | method-choice 单/多 connection 行；required 显示「该企业要求通过 SSO 登录」 |
| `outcome:select-account` | `verify-code`（或 callback exchange）返回 `select_account` | providers:both + request-code 正常 | account-selection 态（多身份行） |
| `outcome:binding-phone` / `outcome:binding-email` | 同上返回 `binding_required` | 同上 | binding 两阶段态 |
| `error:<endpoint>:<CODE>` | 仅目标 endpoint 注错，其余按场景所需前置正常返回 | **按 endpoint 的前置动作脚本（v5 冻结）**：`providers`=启动即达;`discover`/`sso-discovery`=输入 email/企业 ID 提交;`request-code`=phone/email 提交;`verify-code`=先正常 request-code 再提交 6 位码;`select-account`=先经 `outcome:select-account` 场景造出 pending login ticket 再点选身份;`request-binding-code`/`verify-binding`=先经 `outcome:binding-*` 场景造出 pending bind ticket;`social-exchange`=**desktop 需 browser-callback bridge fixture**（scenario fetch 同时模拟 loopback 回调到达）/ **mobile 需 native-credential adapter fixture**（绕过真实 SDK 取凭据,仅 dev） | 一般码=停原界面 + 底部横幅对应文案;三票据码（INVALID_LOGIN_TICKET/INVALID_BIND_TICKET/INVALID_AUTH_CODE)→ 桌面 error 全屏态/移动清态;**`providers` 初载失败（桌面）→ 全屏 error 态**（authManager getLoginState 语义,非横幅）。endpoint 值域：`providers` / `discover` / `sso-discovery` / `request-code` / `verify-code` / `social-exchange` / `select-account` / `request-binding-code` / `verify-binding`;CODE 值域 = inventory §1.3 桌面 19 码 + §4.5 移动 15 码;**平台×endpoint 不可达组合在 state-manifest 显式 N/A**,不笼统宣称全覆盖 |
| `error:<endpoint>:UNKNOWN_CODE` | 同上，返回未注册 wire code | 同上 | 双端 fallback 文案（桌面「登录失败，请稍后重试」/ 移动「登录未完成，请重试。」）；另桌面无专属 key 代表项（如 LOGIN_BUSY）单列一行 |
| `splash:checking_update|updating|update_done|checking|downloading|failed|manifest_failed|download_failed|spawn_failed` | `VITE_SPLASH_PHASE_FIXTURE`（useSplash 输入边界，非网络层） | — | 前六值=Splash 可见态（tips/进度条/统计行/failed 重试）;**后三值=三失败弹窗**（splash_manifest_failed/splash_download_failed/splash_spawn_failed,useSplash 真实 phase 名）——DOM+**CTA action 按现网分弹窗断言（v6.14,与 Step 3b spawn 语义同步）:manifest_failed/download_failed 断言各自现网重试动作;spawn_failed 断言「前往下载」并调用现网下载页打开路径、不得触发 retry**+production guard 均入 SC-1/SC-2 断言 |

---

### Step 1：PR0b-desktop / PR0b-callback / PR0b-mobile（三个独立 PR,按 U-1/U-6 裁决落码） `[SC-4, SC-5]`

> 拆分与归属（v6.1 修正:parity 脚本冻结 `--scope desktop|callback|mobile|all` CLI,消除三支并行与全局 checker 的矛盾）：**PR0b-desktop**（分支 `feat/login-skin-pr0b-desktop`;VERIFY=`node scripts/check-login-i18n-parity.mjs --scope desktop` + i18nFallback 测试）;**PR0b-callback**（`-pr0b-callback`;VERIFY=`--scope callback` + oauthResultPage 定向测试）;**PR0b-mobile**（`-pr0b-mobile`;VERIFY=`--scope mobile` + `pnpm --filter mobile typecheck`）。三者可并行、各自以 scoped checker 独立合入 integration;**三支全部合入后在 integration 上跑 `--scope all`（= SC-4 完整口径）作为收敛门**;scoped 模式只校验本 scope 文件,不因其他 scope 缺项误判。

WHERE: `apps/desktop/src/shared/locale.ts`、`apps/desktop/src/main/i18n.ts`（Record 补项 + **fallback 链改造**）、`apps/desktop/src/main/__tests__/i18nFallback.test.ts`（新）、`apps/desktop/src/main/bootstrap-electron.ts`（仅菜单字典 zh-TW 项）、`apps/desktop/src/renderer/i18n/`（fallbackLng 配置 + `locales/zh-TW/common.json` **全量**）、`apps/desktop/src/shared/helpTypes.ts` + `apps/desktop/src/main/maker-ipc/{help,help-feedback}.ts` + `components/settings/HelpThreadView.tsx` + `apps/desktop/src/main/selection-context-menu.ts`（HelpLocale 族与菜单补 zh-TW 分支，U-1 全量接入）、`apps/desktop/src/main/learn-host/promptBuilder.ts`（仅 `REPLY_LANGUAGE_BY_LOCALE` 补 zh-TW 项,v6.8）、`apps/desktop/src/renderer/components/settings/{LanguageSection,VoiceInputSection}.tsx`、`apps/mobile/src/auth/loginMessages.ts`、`apps/desktop/src/main/oauthResultPage.ts`（`pickOAuthResultPageLang` zh-Hant 识别）、`scripts/check-login-i18n-parity.mjs`（新）、`docs/login-redesign/locale-consumer-inventory.md`（新）

WHAT（**U-1 裁决：按现网 locale 同标准全量接入**）:
1. `SUPPORTED_LOCALES` + zh-TW；`locales/zh-TW/common.json` **全量 key 翻译**（与现有 ja/ko 同标准，规则 18 翻准）：登录域（login.*/splash.*/legacyMigration.*）人工精校 = merge gate；非登录域同标准翻译 + 抽检记录（PR Description 附）。`i18nCompleteness` 无需改口径（zh-TW 全量,与其他 locale 同标准通过）。
2. **fallback 双端写死（防漏兜底）**：renderer i18next `fallbackLng: { 'zh-TW': ['zh-CN','en'], default: ['en'] }`（不得回退 ja/ko 现行为）；main `t()` 查找链 zh-TW → zh-CN → en → key（其余 locale 维持 locale → en → key）；`i18nFallback.test.ts` 三例断言（zh-TW 有 key 取繁中 / 人为缺 key 时取简中 / 双缺取英文）。
3. `resolveSystemLocale/resolvePreferredSystemLocale`：`zh-Hant/zh-HK/zh-MO → zh-TW`，其余 zh → zh-CN。
4. **locale-consumer-inventory.md**：盘点全仓显式 locale 集合——main i18n Record、bootstrap 菜单、LanguageSection（繁中 label）、VoiceInputSection（zh-TW 语音语义沿中文配置）、HelpLocale 族、selection-context-menu、**learn-host `promptBuilder.ts` 的 `REPLY_LANGUAGE_BY_LOCALE`（v6.8,review-a 代码实证:非类型化 Record 仅枚举 zh-CN/en/ja/ko、未知值回退 English——漏补则繁中用户执行 /learn 被确定性指令要求用英文回复;zh-TW 项定值 Traditional Chinese (繁體中文),配单测）**——**全部补 zh-TW 真实分支（U-1 全量接入,不折叠简中）**；SC-4 静态扫描每个集合含 zh-TW 分支,learn-host Record 列入 parity 必检消费者。
5. 新增 key（倒计时「{{n}} 秒后可重新发送」、回调中性态、Splash 统计行等，demo 文案 verbatim 源）5 语一次补齐；存量 4 语零改动；mobile `loginMessages.ts` catalog 扩 5 语（系统 locale：zh-Hant*→zh-TW / 其余 zh→zh-CN / ja / ko / 兜底 en）+ **外围硬编码中文清理(v6.3 点名两处)**:endpoint 失败屏文案(app/_layout.tsx:106-113 硬编码)与 config issue 文案(src/config/env.ts:110-124 硬编码)映射为 loginMessages 5 语 key,进 SC-4 parity mobile 段与闸门状态测试；callback copy builder 生产/preview 合一 + `pickOAuthResultPageLang` zh-Hant→繁中。
6. 回写 design.md §7.2 修订块：语言口径按 U-1 终裁更新（全量接入取代「非登录域 fallback」旧表述）。

WHY: 5 语是用户合约；U-1 终裁选择与现有 locale 完全同构的接入方式，消除任何"半覆盖"状态;fallback 链保留为防漏兜底而非覆盖策略。

VERIFY: SC-4 两条命令；`pnpm test:unit`（含 i18nCompleteness 对 zh-TW 全量校验）。

**Hard-stop**：zh-TW 译法没把握的 key → 查证后再写,登录域必须人工精校完成才可合（merge gate）；demo 文案与现网 i18n 冲突且不属已拍板情形 → GAP 上报。

---

### Step 2：PR1 桌面 stage 框架 + identifier 态系 `[SC-2, SC-5, SC-6]`

WHERE: `apps/desktop/src/renderer/components/login/`（LoginPage.tsx 重构 + 新增 stage/组件文件）

WHAT:
1. stage：1819×2098 五要素绝对定位（坐标照 figma §5.1）+ demo v3.1 拍板缩放公式（逐字落码 + 行为单测：断言 (1280,800)→≈0.3813、(800,600)→≈0.2860、宽度拉伸不改 scale）+ Slogan 窄窗左移（溢出量 translateX，只平移不缩放）;**背景 = 白底体系（wave4）**:`#F1F0F1` 全屏铺底 + 两层 `#F70121` 渐变（参数照 design.md §8.1,代码实现,渐变锚定 viewport 非 stage,天然铺满无裁切）;WORD_MARK 用黑红版内层几何(423×145@698,1046)、SLOGAN #2A2828 版。
2. 组件按 figma §4 重建：input 540×80 r40 全态（default/focus/filled/error）、主按钮 5 态（normal/hover/pressed/loading spinner 24×24 @487,27/disabled）、id-tabs、第三方圆钮行（80×80 gap70，服务端 providers.social 驱动显隐）、Global pill、back 60×60、error_text；态叠层参数照 design §2.1/§2.2（hover 仅桌面）；全部 compositor-only + `prefers-reduced-motion: reduce` 直落终态（规则 7）。
3. identifier 主视图 / ssoOrgMode 子视图 / preparing 伪态接入新皮肤；harness 场景驱动渲染单测（附录 A providers/sso 各组合断言关键 DOM）。
4. state-manifest 本 slice 行补测试映射。

WHY: stage + 组件库是后续全部状态的骨架；identifier 是最高频入口态。

VERIFY: SC-2 两条命令；沙盒走查（Step 7）本 slice 填格。Windows 列证据缺 → 本 slice 即按 U-4 QA 途径标 WAIVER。

**Hard-stop**：四层链缺参数 → GAP；按容器框实现字标/Slogan → 打回。

---

### Step 3：PR2a 桌面剩余登录态 + 错误 + 窗口 chrome overlay（合并前置 U-3、U-9） `[SC-2, SC-5, SC-6]`

WHERE: 同 Step 2 目录 + `apps/desktop/src/renderer/components/title-bar/WindowControls.tsx`（视觉对齐）；**不改 `bootstrap-electron.ts`**

WHAT:
1. 剩余态全量：verification-code（倒计时契约见 3a；Text_link hover 用已实测 `358:792`，pressed 按 U-9 裁决,消费 `--login-link-pressed` token（#1A1818,PR0a 注册;wave3 实测落地后改 token 值即可））、method-choice（方式行 540×100 r60；纯个人变体照 design §7.3 双行方式行；多 connection 照 demo）、account-selection、binding 两阶段（阶段二无重发钮，照现网）、browser-redirect（64×64 panel loading）、error 全屏态（暂时无法登录/重试）、completed（保持 null 瞬态）、560↔440 面板锚定切换。
2. 19 错误码 error_text 视觉切换（`#D91F37` 族，文案 verbatim 不动）+ `UNKNOWN_CODE` fallback 行 + 无专属 key 代表项；用 harness `error:<endpoint>:<CODE>` 逐个截图填格。
3. chrome：renderer overlay 双层描边 + **顶部拖拽条 overlay 化**（46px drag region 改 `-webkit-app-region: drag` 独立层,不占文档流——附录 C §1.4 条4 工程定案;双平台验证窗口可拖拽、不遮挡返回钮点击）;描边（**wave4 参数**:外层 2px `--login-window-border-outer`(#A3A8AD) **r18** + 内层 inset 2px `--login-window-border-inner`(#FFFFFF) **r16**,两层 DOM/伪元素分别断言颜色/宽度/radius,nodeId 368:1375/368:1377;组件内禁 raw hex——规则 16;main 生成的浏览器回调 HTML 为独立文档无 renderer token 系统,沿现网内联常量模式,登记于此）盖窗口内容边缘；mac 交通灯/Win 控件只做视觉对齐不动原生配置；窗口阴影沿用系统默认（design §3）；min 尺寸不动（U-3）。双平台自测记录（规则 15）。

**Step 3a 倒计时契约（全文）**：起算 = `request-code` 动作成功返回时刻；模型 = 绝对 deadline（`Date.now()+42_000` 存 state，渲染 derive 剩余秒，interval 只做 tick——系统休眠/挂起恢复自校正）；重发成功 → 重置 deadline，重发失败 → 保持当前 deadline；离开 verification-code / reset / unmount → 清理 interval 与 state；到 0 → 「重新发送验证码」链接。**显示数学（v5 冻结）**：`remaining = max(0, ceil((deadline - now)/1000))`;tick = 1000ms interval（每 tick 重算,非递减计数）;`deadline <= now` 时同步切「重新发送验证码」链接;首帧显示 42。fake timers 用例：42→0 全程、41999/1000/1/0ms 边界、重发成功重置、重发失败保持、离开清理、挂起恢复校正。纯 renderer 状态，不进 auth-client。

WHY: 桌面登录链闭环；overlay 方案消除 main 落点矛盾。

VERIFY: SC-2 + SC-6 slice pr2a。

**Hard-stop**：overlay 无法达成设计描边视觉（如被系统窗框裁切）→ 停，上报 overlay GAP 请示（U-3 min 尺寸已终裁不重开），不得擅改 BrowserWindow。

---

### Step 3b：PR2b 桌面 Splash 6 态 + 三弹窗 + handoff `[SC-1, SC-2, SC-5, SC-6]`

WHERE: `apps/desktop/src/renderer/App.tsx`（handoff host 挂载点）、`components/splash/SplashScreen.tsx`、`hooks/useSplash.ts`（消费侧）、`components/login/LoginBrandStage.tsx`（新）、`contexts/LoginHandoffContext.tsx`（新）

WHAT:
1. **Splash 白底统一面板版（wave4,取代红底 tips 呈现）**:白底体系背景 + 立绘/字标/SLOGAN + 登录同款白面板承载全部状态。**启动加载白底复用 main 已合入实现（用户指令 2026-07-20,用户更正:正主为 PR #104「CINDY 双端 UI 换肤合入」,作者严健;#123 仅为底色透明度收口微调 466a3208）**——**复用范围收窄(用户裁定 2026-07-20:「只参考这个白色背景,其他立绘/字标/slogan/登录所有 UI 仍以设计稿和 demo 为准」)——从 #104 只取两样:①不透明 `var(--surface)` 白底全盖机制**(加载期不透出已挂载主界面,底色消费 token 不另造字面值)**;②3s 地板等已拍板行为**。main 现网 Splash v2 的品牌块(其立绘 illustration.webp/字标 229×78 双版/手写体 script)**不作为素材或几何基准,登录皮肤落地时整体替换为 wave4 品牌五要素**(字标 368:1381 黑红版 423×145/立绘 934×934 旧 source/SLOGAN #2A2828/统一白面板/双红渐变)——分层基准表不变:视觉五维=wave4 帧,其余=demo。工程事实备忘:代码起点是 main 最新 SplashScreen(useSplash 14-phase 零删改,spawn 失败 handler 现名 `onSpawnFailedDownload`,佐证 spawn=下载语义);f8760bed 基线的红底 tips Splash 已被 #104 替换;「最短停留 3s 地板」「热更自动重启守 3s 地板」(#123 系收口 29187b94/05a79669)为已拍板行为,本轮重构**不得回退**并保留其 fake-timer 用例——spinner 64×64 @面板内(308,188) 弧色 #6F6F6F;更新下载态进度条 轨 501×16 r12 #D9D9D9 @(90,346)+填充 #252222+明细行 20px #6F6F6F;失败态=标题「环境初始化失败」+主按钮样式「重试」（540×80@70,300,**取代旧白字下划线交互**）;标题 32 Bold #252222/副文案 20 Regular #6F6F6F;五帧↔状态映射照 design.md §8.1;**downloading(组件下载 x/2)无专属帧——复用更新下载态面板形态+现网 splash.tips 文案**（§8.1 延展）;三失败弹窗（manifest/download/spawn）**仅统一面板视觉形态,各自文案与 action 语义沿现网不变（v6.12,reviewer 代码实证）:manifest_failed/download_failed=重试类动作;`spawn_failed` 的 CTA=「前往下载」打开下载页(useSplash 现网动作映射 useSplash.ts:192-194、SplashScreen CTA 语义不动)——failed 帧(379:655)的「重试」主按钮样式仅提供按钮视觉规格,不得把 spawn 的 CTA 文案/行为改成重试**;splash.* 文案 5 语。不碰 xdt-updater。
2. **handoff 所有权契约（v4 修正所有权边界）**：
   - `LoginBrandStage` = **品牌视觉层（白底体系背景渐变/立绘/Slogan/字标）唯一渲染者**，overlay `pointer-events: none`，仅主窗挂载（与现有 Splash gating 同源，副窗/sidebar 窗不挂）；**内部分层冻结（v6.12）:静态 full-viewport 背景子层（白底+双渐变,viewport 锚定）与可动画内容子层（立绘/字标/Slogan）分离——handoff 的 transform/opacity 只作用于内容子层,背景渐变不参与任何 handoff 变换（挂在变换层会破坏 viewport 锚定并扩大合成层）**；**白色输入面板与第三方圆钮行归 LoginPage 唯一拥有**——两者绝不重复渲染，context 只协调面板层的 opacity/transform 入场。
   - 宿主 = `App.tsx`：`LoginHandoffProvider` 包住 `SplashScreen` 与 `RouterProvider`；`SplashScreen` 退化为 loading/tips/进度层；`LoginPage` 经 context 上报「面板已挂载」并消费入场信号。
   - **两分支（无 auth-init-failed 虚构分支）**：`unauthenticated 冷启动` = 完整播放 settle(0.3s)→shift(650ms cubic-bezier(.33,0,.18,1))→panel(420ms 上滑 20px cubic-bezier(.35,.1,.25,1))→slogan(+100ms, 500ms cubic-bezier(.55,.06,.38,.96)，Slogan 必须最后出现)；`authenticated 冷启动` = 品牌 Splash 淡出直入主界面，不闪登录面板、overlay 平滑卸载。初始化异常归一未登录（v6.3 落定,采纳双 reviewer 建议）:renderer `contexts/AuthContext.tsx` 的 initialize 链补显式 `.catch`（统一 logger 记录 + 清为 unauthenticated snapshot,再 `.finally`,**不新增视觉分支**）——现网该链仅 then/finally,真实 reject 会产生 unhandled rejection;该文件以「仅 initialize 链 catch」范围进 allowlist,配回归测试（mock service.initialize reject → 无 unhandled rejection、落未登录分支）。
   - 推进锚 = 品牌资产 onload ∧ auth 初始化完成；未登录分支另含「面板已挂载」信号后才进 panel 步；done 后品牌元素固定登录位，路由离开 /login 即卸载 overlay；冷启动每次播放（仅未登录分支）、尺寸切换/reset 不重播；横屏走无位移变体（§3.6/`358:833`）；reduced-motion 直落终态。
3. 测试：useSplash phase 表单测、六态/三弹窗 DOM 断言、handoff fake-timer 时序（步骤次序/时长/不重播/清理）、未登录/已登录两条冷启动集成测试(**禁 mock-reject 限定 handoff 视觉集成测试层,v6.8 消歧**:集成测试的异常路径=resolved-unauthenticated snapshot 变体、不得直接 mock-reject;上条 AuthContext initialize 链的 catch 回归**单测必须真实 mock service.initialize reject**——单测验 catch 行为、集成测验视觉汇合,两类分层并存互不取代)（全程单一品牌 DOM、最多一个 panel、无空白帧、done 后输入可点击、overlay 不拦截 hit-test、已登录从未挂载 login panel）。

WHY: Splash 与 handoff 是 demo 拍板增量；单一品牌 owner + 明确所有权边界是消除双立绘/双面板的结构方案。

VERIFY: SC-2（splash 目录纳入）+ SC-6 slice pr2b + 60fps 录屏对照——**时序/位移轨迹逐帧对照 demo `splashHandoff()`,静态画面(背景/字标/Slogan/面板)对照 wave4 帧**。

**Hard-stop**：handoff 与 auth init 竞态产生空白帧/跳变 → 停，重排推进锚，禁止延时 hack。

---

### Step 4：PR3 登录回调页 + LegacyMigrationDialog（按 U-2/U-7/U-10 裁决落码） `[SC-3, SC-5, SC-6]`

WHERE: `apps/desktop/src/main/oauthResultPage.ts`、`apps/desktop/src/main/authLoopbackCallback.ts`（消费点）、`apps/desktop/src/main/assets/loginCallbackAssets.ts`（按 U-7）、`apps/desktop/src/main/maker-host/generic-oauth.ts`（仅裸 done 修复）、`apps/desktop/scripts/preview-oauth-pages.ts`、`apps/desktop/src/renderer/components/auth/LegacyMigrationDialog.tsx`、三个测试文件（SC-3）

WHAT:
1. 共享壳加 `pageKind/copyKind/visualKind` 三层 adapter（optional，旧调用默认 legacy visual——ghost/claude/xai/generic 视觉零变化；preview 显式传 login pageKind）；`desktop-login` source → 新品牌卡（浮 `#EEEEEE`/深色 `#2A2828` 底、680×680 r36 卡、chibi 表情、成功/失败/中性三变体 × 深浅色照 demo 与 figma §6.1；`prefers-color-scheme` 驱动深浅）。
2. chibi 资产按 U-7 裁决落地（data URI：预裁切 280×280@2x webp、单张 ≤120KB、三张总量 PR 内实测记录；图片盒占位固定尺寸 + 加载失败降级文字/CTA 可用——adaptation §5 条 8 方向落定）。
3. 三硬门禁：escape 回归（providerName/detail/href/htmlLang 注入用例保留并扩到新品牌分支）；generic 裸 `done` 消除（复用 shared builder + legacy visual，唯一输出路径断言）；detail 契约按 U-2 裁决落码（含超长 Unicode/换行/escape 边界测试）。
4. LegacyMigrationDialog：回调卡形式 + 表情包（design §7.4 唯一 App 内例外），confirm/running/failed(+done) 相皮肤化，交互不动，仅 cn 构建触发——验收矩阵区分 cn/global。
5. **回调页跨视口自适应（U-10 裁决落码,demo 公式冻结）**：卡内 680 几何零响应式变化;背景纯色铺满;放不下整卡时整卡等比缩放——`topOffset = viewportWidth < 760 ? 88 : 80`;`scale = min(1, (viewportWidth-32)/680, (viewportHeight-topOffset-24)/680)`（demo:2652-2657 呈现仲裁）,transform-origin=top center,水平居中;缩到仍放不下时允许纵向滚动、不裁 CTA。测试:三档视口(桌面/窄窗/移动浏览器)断言卡内几何恒定、仅 scale/背景变化。
6. 浏览器失败卡验证路径（v6.1 改版,废除 live state 日志方案——state 是活跃 anti-CSRF 值不得落盘,且 port/state 持有者在 authManager 业务段、超出其 allowlist 注入范围）:**复用附录 A 的 browser-callback bridge fixture,经显式 dev-only seam 实施（v6.13,reviewer 实证:fixture 无法自行进入 authManager 闭包,须定义注入缝）**——`authManager.ts` 的 `openSystemBrowserAuthorization` 增加 dev-only loopback bridge seam（构造参数注入形态,如 `loopbackBridge?: { onCallbackReady(trigger): void }`,或将 loopback transport 抽为可注入纯 helper 由 authManager 静态注入——二选一在 PR3 定型）;scenario `error:social-exchange:<CODE>` 由 fixture 经该 seam 取得进程内回调入口并触发 error callback 路径,渲染真实 error 页壳供截图;**seam 三硬测**:①渲染出真实 error HTML;②断言无 state/凭证落盘(state 仅进程内内存传递);③packaged 分支 seam 不注入、代码路径不可达;浏览器可视截图经 dev-only「将最近一次渲染的回调 HTML 落盘 acceptance/evidence 临时文件」的 fixture 附属能力获取（仅 HTML,无 state/凭证）。取消/监听失败只走 app 内错误态，与浏览器页矩阵分行验收。语言策略维持现状（登录回调跟 app locale + zh-Hant 识别）。

WHY: 登录链浏览器侧闭环；三硬门禁是三方共识版遗留义务，不随视觉收窄丢弃。

VERIFY: SC-3 三定向测试 + SC-6 slice pr3 + preview 通道对照。

**Hard-stop**：新分支任何未 escape 插值点 → 阻断（P0 历史事故域）。

---

### Step 5-pre：PR4-preflight Android 构建打通（PR4a 的 DAG 入边,不可跳过） `[SC-5]`

WHERE: **只读诊断为默认**;产出 `docs/login-redesign/acceptance/android-build-preflight.md`。若诊断发现须修 gradle/larksso 等构建配置才能通:先只读定位并列出精确文件清单 → hard-stop 报告 → 经确认后把该清单显式扩入 allowlist 再动,不得凭「按需」自由修改

WHAT（v6.3 事实修正:larksso/xdt-feishu-login 已从仓中删除,flatDir 风险过期解除;`mobile:sim:start` 是通用 Metro 非 iOS-only,iOS-only 的是 sim-rebuild/sim-whoami）: 打通 Cindy app 的 Android dev 构建/安装/启动路径并留证:①初装用现成 `pnpm --filter mobile android`（expo run:android 包装）对 `cindy-phone` AVD;②之后热开发复用 `pnpm mobile:sim:start`(Metro);③cn/global 双 region 各跑一次,记录成功命令序列、包名、scheme、Metro 连接证据;④顺带补跑 `cindy-tablet` boot 冒烟。**expect**:两台 AVD 上 app 可启动到登录页 + preflight 文档含全部证据。

**Hard-stop**:两条路径都不通 → 列 blocker 交用户,PR4a 不得开工(U-5 未就绪项即此)。

---

### Step 5：PR4a 移动 stage / 组件 / 全登录态（前置 PR4-preflight;按 U-8a 裁决落码） `[SC-1, SC-5, SC-7]`

WHERE: `apps/mobile/app/(auth)/login.tsx`、`apps/mobile/src/auth/**`、`apps/mobile/src/theme/tokens.ts`（PR0a 已建 token）、`apps/mobile/src/components/CenteredScreen.tsx`、`apps/mobile/src/components/MobileLoginHandoffStage.tsx`（**新,本 PR 仅静态视觉宿主**:白底背景+品牌五要素静态渲染,v6.10）、`apps/mobile/app/_layout.tsx`（仅 RootLayout 挂载该宿主,v6.10）

WHAT:
1. 750 坐标 stage + 两档插值/两档外策略按 U-8a 裁决落码（照 demo 呈现行为）;**背景/字标/slogan/面板描边用 wave4 白底体系参数（design.md §8.2 延展）,并冻结宿主与坐标空间(v6.5)**:①白底背景(底色+双渐变)由 root `MobileLoginHandoffStage` 提供的**唯一 full-viewport host** 渲染,覆盖 safe area 外区域,endpoint/OTA/auth 各闸、config-missing、登录页、iPad 横竖屏全部复用该 host(杜绝 gate 残留红底);**宿主组件与 RootLayout 挂载在本 PR（PR4a）交付——PR4a 独立 checkout 即可在全部闸门屏看到同一 full-viewport 白底,pr4a slice 自证;PR4b 仅在既有宿主上追加 handoff Provider/reporter/动画接线（v6.10,矩阵 owner 同步:移动背景/品牌五要素静态视觉行 owner=pr4a,handoff 动画/键盘行 owner=pr4b）**;②双渐变按 wave4 归一化百分比锚定物理 viewport,**不随 750 stage 缩放、不随键盘 translate**;③内容五要素沿旧移动布局几何;**新字标 423×145 在旧移动字标框(401×137 等)内按 contain 等比适配,禁止非等比拉伸**;立绘 y=116 双区统一;WORD_MARK/SLOGAN 布局几何沿 wave3.5 旧表（长屏 175,814,401×137 / 387,686,321×92;短屏见表),资产换黑红/近黑新版。
2. 组件重建至设计尺度（input/主按钮 540×80 r40、panel 680×440 r36、圆钮 80×80 gap70、方式行 540×100 r60），消费 login token 族，错误文字 `loginError` token（`#D91F37` 族）。
3. 全登录态皮肤化（现有 RN 状态机零改动）：identifier（placeholder/社交按钮/SSO 入口措辞 verbatim 保留双端差异）/ssoOrgMode/method-choice（多 connection 单行「以企业身份登录 · <name>」保留）/verification-code（42s 倒计时同 Step 3a 契约 RN 实现）/browser-redirect（补 panel loading）/account-selection/binding（按钮「登录」保留）/错误条切 loginError；无 loginState 兜底单按钮态。
4. harness 场景驱动全态 + 15 错误码 + UNKNOWN_CODE 遍历截图（SC-7 harness 证据列）；原生社交条件渲染逻辑不动仅视觉；`maxFontSizeMultiplier=1.2` 沿用。
5. **Safe Area（附录 C §3.4 工程定案）**：沿现网 SafeAreaView 机制;白底体系背景 edge-to-edge 铺满,功能区保持 insets 内,bottom inset 计入 Log_in 组底距;iOS 刘海/home indicator 与 Android 三键/手势导航双模式各留截图证据。

WHY: 移动主链皮肤化独立可验证；与键盘/闸门/横屏解耦降低归因难度。

VERIFY: `pnpm --filter mobile typecheck` + SC-1 mobile harness 测试 + SC-7 slice pr4a。

**Hard-stop**：深链/原生社交/状态机行为与基线不一致 → 停（登录不可用 = P0）。

---

### Step 5b：PR4b 移动键盘 / 闸门 / 深链 / handoff / 横竖屏（合并前置 U-8b;U-11 已裁决 B=Android 悬浮键盘例外） `[SC-5, SC-7]`

WHERE: Step 5 目录 + `apps/mobile/app/_layout.tsx`（追加 Provider 挂载;静态宿主挂载已在 PR4a）、`apps/mobile/app/index.tsx`、`apps/mobile/src/session/useMobileKeyboardState.ts`（扩展）、`apps/mobile/src/components/MobileLoginHandoffStage.tsx`（**扩展**:PR4a 已建静态视觉宿主,本 PR 接入 handoff 状态/入场动画,v6.10）、`apps/mobile/src/auth/MobileLoginHandoffContext.tsx`（新，Provider/store/reporter）

WHAT:
1. **键盘契约（v4 方案 B：不动全局 soft-input 配置）**：
   - Android 保持现状系统行为（不改 AndroidManifest `windowSoftInputMode`；测试断言 prebuild 产物该项未被本计划改动）；iOS 移除 KAV 对登录屏干预。
   - 唯一位移源 = 自定义 translate,**测量拓扑（v5 冻结）**:外层「未变换测量 wrapper」持有布局基线（measureInWindow 只在此层,天然不含 translate）,内层「translate 容器」应用位移——杜绝测到已位移值的抖动。
   - **判定升级为二维相交 + 控件可见性（U-8b 硬标准的可执行形式）**:hook 暴露完整 `endCoordinates` 矩形（x/y/width/height）,**iOS 订阅升级（v6.7）:在 `keyboardWillShow/Hide` 基础上增订 `keyboardWillChangeFrame`——悬浮键盘拖动/分离/重停靠等「已显示后改 frame」事件仅经此通道派发,不订阅则浮动键盘仅首开正确、移动后判定失效;组件卸载时全部移除监听**;测量「当前输入框 ∪ 主按钮」union 矩形;停靠键盘（双端,宽≈viewport）→ `shift = max(0, panelBottomY + 10 - keyboardTopY)`;**iOS** 悬浮/分离键盘 → endCoordinates 为真实键盘 frame,按键盘矩形与 union 矩形**二维相交**判定,仅相交时按纵向遮挡量上移;**Android 悬浮键盘（v6.3 限定,reviewer 实证 RN Android adjustResize 下 endCoordinates 的 x/width 是 visible frame 而非浮动 IME 真实矩形）**→ JS 层拿不到真实矩形:PR4b 开工首日 AVD 实测事件样本冻结行为;**该分支落码口径 = U-11 已裁决选项 B(2026-07-20):Android 悬浮键盘例外——不触发自定义上移,adjustResize 系统行为保底+用户可拖键盘避让;矩阵该行按例外口径判定(显式合法口径,非 GAP、非 typed N/A);native WindowInsets helper 不实施**;shift 后断言两控件矩形均完整落在可视区;**shift 设 safe-top 上限**（不得把输入框顶出屏幕顶部安全区）,极端矮视口放不下时回退手机窄窗弹性规则（面板优先,视觉区裁切/淡出,照 demo）而非无限上移。Android resize 生效时以 resize 后 viewport 底为键盘顶,一致性 PR4b 首日 AVD 实测确认;收起回位无跳变。
   - 参数化单测向量（冻结）:停靠键盘 10px 贴附、浮动键盘遮挡输入框、浮动键盘遮挡主按钮、浮动键盘横向不相交不动、分离键盘、320pt 分屏、**浮动键盘已显示后横移/重停靠改 frame（keyboardWillChangeFrame 驱动实时重判定,v6.7）**——每例断言输入框+主按钮完整可见;+ 双平台实测录屏证明位移只计一次（无系统/自定义双算）；**Android 侧回归确认现有输入屏（sessions composer 等）行为未受影响**（本方案不动全局配置，理论零影响，仍录屏抽查一处）。
   - **Hard-stop 升级路径**：若首日实测发现 Android resize 与 stage 布局冻结冲突（面板被系统压缩或双移位不可消除）→ 停，升级为「登录路由 mount/unmount 动态切换 soft-input 的 route-scoped native 方案」提案交用户，不得擅自改全局 Manifest。
   - **键盘可见性硬标准（U-8b 裁决,用户原话）**：任何键盘形态弹起时,当前输入框 + 主按钮（继续/登录）必须完整可见——矩阵键盘态行按此判定。停靠键盘走 10px 贴附;悬浮/分离键盘与面板发生遮挡时按遮挡量上移、不遮挡不动;Android 悬浮键盘分支见 U-11。
2. **移动 handoff owner（reporter 拓扑写死）**：
   - `RootLayout`（`app/_layout.tsx`）常驻 `MobileLoginHandoffProvider`（本 PR 新增）+ `MobileLoginHandoffStage`（PR4a 已建并挂载的唯一品牌渲染者 overlay,本 PR 为其接入 handoff 状态;pointer-events 不拦截内容层）；endpoint gate 在 root 层直接上报；`RootAfterEndpoints` 内上报 OTA；`AuthProvider` 内上报 auth-init；登录页上报「面板已挂载」。**不改变 endpoint→OTA→auth 既有挂载顺序**；各 gate 屏退化为自身 loading/错误内容层（品牌视觉由 Stage 拥有）。
   - readiness：未登录分支推进锚 = `endpoint ∧ OTA ∧ auth-init ∧ assets ∧ login-panel-mounted`（防面板未挂载先播 panel 步）；已登录分支不等 panel 信号，品牌屏直入首页不闪登录。
   - **测试基建前置（v6.3,reviewer 实证:mobile 现仅 node-env Vitest,无 RN renderer）**:apps/mobile devDependencies 允许新增 RN 组件测试库（`react-test-renderer` 或 `@testing-library/react-native`,以与 React 19/RN 0.85 兼容为准,PR4b 开工首日验证版本;此为 package.json 依赖禁令的显式例外,范围仅测试库+vitest setup 文件）;若无兼容版本 → 降级为「handoff store/reducer 纯逻辑单测 + 模拟器录屏 E2E」双门禁并在 PR Description 声明。
   - **移动 initialize 链补 catch（v6.3）**:`src/auth/AuthContext.tsx` 的 `void run()` 外层补 `.catch`（logger+归一未登录）——现网仅内层 refresh 有 catch,`ensureDeviceId`/存储失败会穿出;测试覆盖 device-id/storage reject 与 refresh reject 两类。
   - **状态表冻结并逐条测试**（按上述基建;不用扁平 mock）：endpoint pending→error→retry→ready、config-missing、OTA reload、auth-init 完成（含异常归一未登录）、未登录完整播放、已登录直入、reduced-motion（`AccessibilityInfo.isReduceMotionEnabled` 直落终态）、unmount 清理；每条断言唯一品牌 DOM、错误层可交互、retry 后 readiness 可继续推进、无 login 闪屏。
3. 横竖屏平板：§3.6 参数落码（竖屏 744×1133 ≈0.794 等比 + 档位缩放；横屏 1180×820 左右构图 **`max(0.85, min(w/1180, h/820))`——demo 公式,无上限**（权威链收口项;单测含 raw>1.30 档断言无旧上限残留）；断点 700pt/1000pt/690pt；**阈值按 dp/pt 归一**，demo 物理分辨率档换算说明进 checklist）；Android pad 同规则；横屏 handoff 走无位移变体。
4. **深链/global 序列**：Android 构建路径复用 PR4-preflight 已打通命令（见 Step 5-pre,不在本步重复打通）；iOS global 用 `pnpm mobile:sim:rebuild -- --region=global` → `pnpm mobile:sim:start -- --region=global`（切 bundle id/scheme 必须 rebuild）；深链 cn `cindycn://auth` + global `cindy://auth` 各冷/热启动。

WHY: 键盘/横屏/跨闸 handoff 是移动特有高风险面；方案 B 避免全局 soft-input 副作用波及登录外输入屏。

VERIFY: SC-7 slice pr4b（键盘录屏、横竖屏各档截图、双 scheme 深链录屏、handoff 状态表测试全绿）。

**Hard-stop**：键盘位移双机制叠加不可消除 → 升级 route-scoped 提案；Android 构建路径打不通 → 列 blocker 交用户，不得用 iOS 脚本代称。

---

### Step 6：PR5 收尾 `[SC-5, SC-8, SC-9]`

WHERE: 全仓登录相关路径 + `apps/desktop/src/renderer/components/settings/{McpServerDialog,CustomProviderDialog}.tsx`（旧 token 消费者迁移）

WHAT: 旧 `--login-*` 全 9 token 退役（设置页两处消费者迁到 surface 族）；死引用确认（旧飞书页/旧壳等「已消失」项无引用验证）；fidelity 总矩阵收官（`--final` 按终态二分宣告；QA 回报的 WAIVER 升级 PASS 后方可冲 `:VERIFIED`）；性能自查（stage transform compositor-only、无常驻主线程动画——DevTools Performance 实测，规则 7 以数据为准）；文档回写（adaptation-spec 落码事实标注、design.md 增量拍板、landing-plan 状态更新）。

VERIFY: SC-8 + SC-9 + `pnpm test:unit`。

**Hard-stop**：发现旧 token 计划外消费者 → 停，纳入迁移表再动。

---

### Step 7：本地沙盒测试方案（贯穿每 PR）

**桌面**：
1. **沙箱矩阵**：每 PR × 区域独立命名沙箱（`pnpm restart:desktop:remote --isolated=login-skin-<prN>-cn` / `--isolated=login-skin-<prN>-global --region=global`）；userData 目录 `Cindy-dev-<name>` 持久复用——真实登录 smoke 后 refresh token 留存、下次直进主界面，**验收顺序固定：先 harness 全态走查 → 后真实 smoke**；需回登录页先 app 内登出或换沙箱名。
2. **global 真实沙箱**：`--region=global` 由 restart 脚本按区域选 `endpoint.global.json` 并注入 `VITE_CINDY_AUTH_REGION=global`，Global pill 为构建身份真实呈现；harness 的 `providers:global-social` 只验 provider 组合不冒充构建区域。
3. **状态遍历**：`XDT_LOGIN_SCENARIO=<附录 A token>` 逐场景启动（PR0a env 白名单透传）；错误码经 `error:<endpoint>:<CODE>` 确定性遍历；Splash 经 `VITE_SPLASH_PHASE_FIXTURE`。
4. **对照法（分层基准）**：视觉五维（背景/字标/Slogan/描边/Splash 呈现）对照 wave4 帧截图;其余维度浏览器开 `docs/cindy-login-hifi-standalone.html` 同状态并排;动画时序 60fps 录屏对 demo、静态画面对 wave4;**每个证据格记录 `baseline: {source, ref}` 字段,source ∈ wave4|demo|i18n（语言/文案格用 i18n）**（v6.9/v6.11:checker 与行唯一 baselineRequirement 比对 source+ref,不止校验非空;多维状态拆独立矩阵行,每行单一期望、单一证据）;结论填 fidelity 矩阵（证据入 `acceptance/evidence/`）。
5. **真实链 smoke**：每 PR 至少一次真实验证码登录走通（cn/global 各一次）。

**移动**：
1. iOS 模拟器（就绪：iOS 26.5 runtime + iPhone 17 系 + iPad mini A17 Pro，冒烟通过）按 `apps/mobile/docs/simulator-debugging.md`；Android AVD `cindy-phone`/`cindy-tablet`（构建路径见 Step 5-pre）；`MOBILE_VISUAL_MOCK_ENABLED` 关闭，用 `EXPO_PUBLIC_LOGIN_SCENARIO`。
2. 机型矩阵：iPhone 两档插值、iPad mini 竖/横 + 分屏 320pt、Android phone、Android tablet 竖/横；每档 = 全态 harness 走查 + 键盘态 + 衔接动画 + reduced-motion。
3. 深链：cn/global 双 scheme × 冷/热启动；Apple 登录模拟器恒不可用 → 真机（QA 途径）或 U-4 WAIVER。

---

## 与 landing-plan.md（final v2）的差异表（完整十条）

| # | landing-plan / 旧文档表述 | 本计划处置 | 依据（精确引用） |
|---|---|---|---|
| 1 | PR0b-mobile「zh/en 扩四语」；design.md §7.2 旧口径（桌面四语、移动 zh/en + ja/ko 回英文） | 全端 5 语：zh-TW 按现网 locale 同标准**全量接入**（U-1 终裁 2026-07-20,取代早期「方案 A 域收口」讨论稿）；移动 catalog 扩 5 语 | 用户拍板 2026-07-20（U-1 终裁）;design.md §7.2 修订块随 PR0b 合并前回写为终裁口径 |
| 2 | #29 无稿 surface 待拍板（sso-org/账号选择/绑定/完成态/门控/迁移弹窗/method-choice 变体） | demo 已呈现桌面 8 态全量 + 迁移弹窗三相 + 移动全链 → 按 demo 落地；ssoOrgMode 未在 §7.1 明列，依 demo 总仲裁规则（demo 状态选择器含该态）关闭；完成态维持 null 瞬态 | design.md §7.1「出且已验收」清单 + 文首 demo 验收声明 |
| 3 | #32 倒计时待拍板 | 已拍板：双端 42s，契约见 Step 3a | design.md §7.3 拍板行 |
| 4 | #22 键盘态待拍板 | 已拍板：整体上顶 + 面板距键盘 10px 全设备，实现模型见 Step 5b（方案 B） | design.md §4.5 |
| 5 | PR3 = 共享壳整体替换（覆盖全部 provider） | 收窄至 desktop-login 视觉 + 三功能硬门禁保留（escape/裸 done/detail） | design.md §7.1「不出」清单 |
| 6 | 桌面 Splash 不在 surface 表 | 新增：Splash 6 可见态 + 三失败弹窗 + 衔接动画（PR2b，桌面专属；移动 Splash 保持纯品牌屏） | design.md §7.1 拍板（Lizi 2026-07-20）+ §3.1 |
| 7 | #28-①（provider 排列动态 vs 固定）待拍板 | 实质关闭：按服务端动态返回渲染 | design.md §7.5「与现网 server 驱动模型一致」 |
| 8 | #31 CTA 品牌显示待拍板 | 按 demo CALLBACK 呈现文案落码（demo 呈现仲裁） | design.md 文首 demo 验收声明 |
| 9 | #33 桌面归因展示待拍板 | 保持现状不新增 | design.md §7.1「不出：现网不存在的界面（…归因展示）」 |
| 10 | 桌面缩放 fitScale+minScale0.36；横屏「细化中」PR6 后置；移动立绘 y 116/96 差异待问设计 | 三项改判：缩放 = demo v3.1 拍板公式；横屏并入 PR4b（§3.6 参数已齐，PR6 取消）；y=116 已拍板收口 | demo:1809-1815 拍板注释；adaptation §3.6 wave3 重写节；adaptation §3.2 条 5 |

**决策台账（三层分类）**：

- **已关闭决策**（登记防重复发问）：国际移动帧 placeholder 手机号文案不落码、以现网 i18n 为准（design §7.2）；输入框/圆钮 hover 无节点按 design §2.2 延展/拍板；Text_link hover `358:792` 已实测必须实现；y=116（adaptation §3.2 条 5）；U-4/U-5 状态见 U 清单。
- **已作废(wave4)**:字标/Slogan 红底抠图过渡方案——新版字标(368:1381)自带透明底、SLOGAN 为 #2A2828 矢量,抠图依赖清零;Text_link pressed 已由 U-9 裁决(#1A1818 token)。
- **已裁决** = U-1~U-11（见 U 清单,各带合并阻塞点语义;U-11=选项 B Android 悬浮键盘例外,2026-07-20）。
- **本期明确保留现状（登记防误判漏项）**：landing #11 login/ghost-success 提前渲染语义——文案与时序均保持现状,不动 auth/broker 时序（非目标节「不改 auth 状态机」覆盖）；landing #12 回调页语言来源——维持现状（登录回调跟 app locale + zh-Hant 识别,provider/Ghost 跟浏览器 Accept-Language）,统一化另立项。

---

## 边界约束

### 文件写入范围

**允许写入**（仅限）：
- desktop renderer：`components/login/**`、`components/splash/**`、`components/auth/LegacyMigrationDialog.tsx`、`components/title-bar/WindowControls.tsx`、`components/settings/{LanguageSection,VoiceInputSection,McpServerDialog,CustomProviderDialog}.tsx`（后两者仅 PR5 token 迁移）、`hooks/useSplash.ts`、`App.tsx`（handoff host）、`contexts/LoginHandoffContext.tsx`（新）、`contexts/AuthContext.tsx`（仅 initialize 链补 .catch 归一未登录,v6.3）、`themes/colors.ts`、`assets/login/**`、`i18n/**`（含 zh-TW **全量** common.json 与 fallbackLng 配置）、`i18nCompleteness` 测试文件
- desktop main：`oauthResultPage.ts`、`authLoopbackCallback.ts`、`authManager.ts`（仅 client 构造参数注入 + `openSystemBrowserAuthorization` 的 dev-only loopback bridge seam——范围限 seam 定义与注入,不改授权业务逻辑,v6.13）、`assets/loginCallbackAssets.ts`（新）、`maker-host/generic-oauth.ts`（仅裸 done）、`i18n.ts`（Record 补项 + fallback 链）、`__tests__/i18nFallback.test.ts`（新）、`bootstrap-electron.ts`（仅菜单字典 zh-TW 项；BrowserWindow/窗口配置段禁区）、对应 `__tests__`/`__fixtures__`、`selection-context-menu.ts` + `maker-ipc/{help,help-feedback}.ts`（仅 zh-TW 分支，U-1 全量接入）、`learn-host/promptBuilder.ts`（仅 REPLY_LANGUAGE_BY_LOCALE 补 zh-TW 项,v6.8）
- desktop shared/renderer（U-1 增补）：`shared/helpTypes.ts`（HelpLocale 补 zh-TW）、`components/settings/HelpThreadView.tsx`（现网真实路径;zh 折叠改真实 zh-TW 分支,checker 断言 localeFromI18n('zh-TW')==='zh-TW'）
- desktop shared/scripts：`shared/locale.ts`、`apps/desktop/scripts/preview-oauth-pages.ts`
- mobile：`app/(auth)/**`、`app/_layout.tsx`、`app/index.tsx`、`src/config/env.ts`（仅文案 key 化,v6.3）、`apps/mobile/package.json` devDependencies（仅 RN 测试库,v6.3 例外）、`src/auth/**`（含 MobileLoginHandoffContext 新建）、`src/components/**`（CenteredScreen/MobileLoginHandoffStage）、`src/theme/tokens.ts`（+守护测试）、`src/session/useMobileKeyboardState.ts`（暴露完整 endCoordinates x/y/width/height）、`assets/login/**`
- packages：`packages/auth-client/fixtures/**`（新）、`packages/auth-client/package.json` + `tsconfig.json`（仅 `./fixtures` export/include 追加；`src/**` 禁区）
- 仓根 scripts：`restart-desktop-remote.mjs` + 其测试、`check-fidelity-matrix.mjs`、`check-state-manifest-coverage.mjs`、`check-login-i18n-parity.mjs`、`check-login-token-retirement.mjs`、`check-login-wave4-authority.mjs`（v6.9）、`check-login-production-guard.mjs`、`check-oauth-regression-baseline.mjs`、`check-login-e2e-report.mjs`（v6.17 三新增）+ 各脚本测试/fixtures、资产生成脚本
- 构建配置（v6.17,范围严格限 fixtures 生产排除条件,其余配置段禁动）：`apps/desktop/vite.main.config.ts`、`apps/desktop/vite.renderer.config.ts`（仅 fixtures 生产 alias/stub + sentinel 相关 define）、`apps/mobile/metro.config.js`（仅 fixture 生产 stub 条件）
- docs：`docs/login-redesign/**`（含 acceptance/evidence、locale-consumer-inventory.md）；回写 `adaptation-spec.md`/`design.md`/`landing-plan.md` 拍板落码标注

**绝对禁止写入**：`/Users/praise/.claude/**`；`packages/auth-client/src/**`；`packages/maker-core/**`；xdt-updater 相关模块；`bootstrap-electron.ts` BrowserWindow/窗口配置段；AndroidManifest / `app.json` 的 soft-input 全局配置；`cindy-protocol/**`；drizzle/DB schema（本次无 DB 变更）；系统提示词；`skin/cindy-theme-family` 分支主题族文件；OpenCC 等翻译依赖（package.json 依赖段除 auth-client fixtures export 外不动）。

### 复用 vs 绕开

| 复用 | 不复用 |
|------|--------|
| 真实 `CindyAuthClient`（harness 仅换 fetch 构造参数）、useLogin/AuthContext 数据流、i18n 体系（zh-TW 全量同构接入）、oauthResultPage 壳骨架（optional pageKind）、useMobileKeyboardState（扩展）、`--isolated`/`--region` 沙箱、`mobile:sim:start`（通用 Metro,双端复用）与 `mobile:sim:rebuild`/`whoami`（仅 iOS）、现有测试模式 | 旧 440px 卡与旧 `--login-*` token（PR5 退役）；KAV 对登录屏的键盘干预（iOS 移除，唯一位移=自定义 translate）；不为登录另建颜色/i18n/媒体/IPC 第四套机制 |

---

## 依赖与前置条件

- 实现基线 = 最新 `origin/main`（≥ f8760bed）+ **PR0-docs bootstrap commit**（docs/login-redesign 全套与 demo 当前为 untracked 工作区文件,由 PR0-docs 首先入仓并记录 SHA256 基线——评审期以工作区文件为准,执行期以该 commit 为准）;demo 与用户 2026-07-20 验收版逐字节一致（已核）。
- **U-1~U-10 已全部裁决（2026-07-20）**，各 PR 合并前按对应裁决落码并验收（U-2/U-7/U-10 → PR3;U-3/U-9 → PR2a;U-8a → PR4a;U-8b → PR4b;U-1/U-6 → PR0b*）;U-4 QA 途径在各 slice 生效;U-11 已裁决(选项 B,2026-07-20),PR4b 开工无阻塞。
- 环境：iOS 模拟器就绪（冒烟通过）；Android SDK/AVD 就绪（phone 冒烟通过、tablet 待跑）、app 构建路径待 PR4a 前打通（U-5）。
- wave3 Text_link pressed 实测：本期按 U-9 裁决值 `#1A1818` 落码,实测节点落地后替换。
- 本计划评审共识后**停住等用户开工指令**（用户 2026-07-20 指令）。

---

## 风险与防护

| 风险 | 防护 |
|------|------|
| demo 与 wave4 双基准漂移（红底 demo 未重制） | 基准分层规则写死(五维度=wave4 帧);checklist 每格标注所用基准;demo 重制后恢复单一基准并复核五维度格子 |
| 像素/动效走样、新缺口抢跑落码 | 四层链 + 附录 C 处置表全覆盖 + 每 PR slice checker + GAP 上报纪律（feedback 硬约束） |
| auth 协议层被顺手改动 | src 禁区；真实 client + fetch 注入；package 级 adapter 测试；review 逐 diff 核对 |
| harness/fixture 泄漏生产 | 三处 guard（isPackaged/__DEV__/import.meta.env.DEV）+ build-time stub 排除 + sentinel 双断言机器门（check-login-production-guard.mjs,SC-1,v6.16） |
| 容器框放大/DPI 缺档/资产来源不可溯 | asset-manifest 验收项(nodeId 溯源+透明底+DPI 档);红底抠图依赖已随 wave4 清零 |
| zh-TW 翻译质量 / fallback 断链 | U-1 全量接入同 ja/ko 标准 + 登录域人工精校 merge gate + 非登录域抽检记录 + 双端 fallback 行为测试（SC-4）+ locale-consumer-inventory 静态扫描 + i18nCompleteness 全量闸 |
| escape 回归（历史事故域） | SC-3 三定向测试 + PR0-docs 冻结 escape testId 基线文件 + checker 机器断言（存在/非 skip/passed/计数不减,v6.16——不再依赖 PR Description 自报） |
| handoff 双品牌/双面板/已登录闪登录页/空白帧 | 双端唯一品牌 owner + 面板归 LoginPage 的所有权边界 + 分支契约 + 状态表集成测试 |
| 键盘双机制叠加 / Android resize 冲突 | 方案 B 单源位移 + 首日 AVD 实测 + hard-stop 升级 route-scoped 提案 + 登录外输入屏回归抽查 |
| WAIVER/GAP/N-A 假绿 | 终态精确定义 + checker 负 fixture（十二例,v6.16） + N/A reasonCode enum + GAP final 必败 |
| 矩阵全集/证据被实质空转（删行假全绿、旧图跨格复用、自填审批,v6.16 SC 专项复审 F1/F2） | required-state-catalog 集合相等锚（变更走批准管制）+ evidenceReuseGroups 声明式复用 + SHA256 重复检测 + 证据 sidecar（testedCommit 绑定,--for-main 拒旧证据） |
| 倒计时休眠漂移 | 绝对 deadline 模型 + 挂起恢复校正用例 |
| Android 构建路径不通 | PR4a 前置打通任务 + gradle APK 替代路径 + blocker 上报机制 |
| 误写禁区 | hard-stop + allowlist review [P1] 阻断 |

---

## 交付物清单

| 文件 | 类型 | SC 映射 | 验收状态 |
|------|------|---------|---------|
| 本文件（版本以页首状态行为准） | modified | — | [ ] |
| `acceptance/{fidelity-matrix.md,state-manifest.json,evidence/**}` + 证据 sidecar `*.meta.json` | new | SC-6/7/9 | [ ] |
| **验收锚点三件（PR0-docs 冻结,v6.16 增/v6.17 扩）**：`acceptance/required-state-catalog.json`（逐行全字段 ground truth） + `acceptance/oauth-escape-baseline.json` + `acceptance/required-e2e-cases.json`（literal caseId 展开）（变更走批准管制） | new | SC-2/3/7/9 | [ ] |
| **八个 checker 脚本**（fidelity/manifest-coverage/i18n-parity/token-retirement/wave4-authority/**production-guard/oauth-regression-baseline/e2e-report**,v6.16 后三者新增）+ checker 验收 fixtures | new | SC-1~4/6~9 | [ ] |
| `acceptance/translation-review.json`（翻译评审记录,绑定 locale 文件 SHA） + `acceptance/e2e/report.json`（e2e 阶段产出） | new | SC-4/9 | [ ] |
| `asset-manifest.md` + 双端资产 + data-URI 模块（按 U-7） | new | SC-1/3 | [ ] |
| `packages/auth-client/fixtures/**` + export/include + adapter 测试 + 双端注入点 | new/modified | SC-1 | [ ] |
| `locale-consumer-inventory.md` + PR0b 5 语 i18n + parity 脚本 + i18nFallback 测试 | new/modified | SC-4 | [ ] |
| PR1/2a/2b：桌面全态 + chrome overlay + Splash/handoff（App.tsx host + LoginHandoffContext + LoginBrandStage） | modified | SC-2/6 | [ ] |
| PR3：回调页 + 迁移弹窗 + 三硬门禁 | modified | SC-3/6 | [ ] |
| PR4a/4b：移动全链 + 键盘/横屏/深链 + MobileLoginHandoffStage/Context | modified | SC-7 | [ ] |
| PR5：token 退役 + 矩阵收官 + 文档回写 | modified | SC-8/9 | [ ] |

---

## 附录 B：fidelity 矩阵 / state-manifest schema（冻结,PR0a 照此实现）

```ts
// state-manifest.json 条目
type ManifestRow = {
  rowId: string;                    // 冻结格式 "<platform>.<stateFamily>.<variant>",如 "desktop.verification-code.countdown"
  platform: "desktop" | "mobile";
  rowKind: "desktop" | "all-mobile" | "phone-only" | "pad-only";  // v6.2:入冻结 schema(此前仅 prose)
  stateFamily: string;              // 配对键:phone-only 行必须存在 stateFamily 相同的 pad-only 行(反之亦然),checker 机械配对
  slice: "pr1"|"pr2a"|"pr2b"|"pr3"|"pr4a"|"pr4b"|"pr5"; // 唯一 owner,跨 PR 更新须走 manifest 变更 review
  applicability: {                  // 默认全集=6 端×5 语×2 区;任何缺省必须转 manifest 授权的显式 N/A,不允许静默缩小
    devices: Device[]; locales: Locale[]; regions: ("cn"|"global")[];
  };
  naAllowed?: { cells: CellRef[]; reasonCode: NAReason }[]; // 允许 N/A 的格与理由码
  tests: { file: string; testId: string }[];               // SC-2/SC-7 coverage 用(--run-mapped 真实执行)
  baselineRequirements: {                                  // v6.9 增,v6.11 收紧,v6.16 转必填(全部行,不再限视觉五维;缺字段=schema 拒绝):行级期望基准(机器可读 ground truth)
    dimension: string;                                     // 如 "asset"/"geometry"/"style"/"timing"/"copy"——同时入 rowId 的 <variant> 段
    platform?: "desktop" | "mobile" | "pad";
    source: "wave4" | "demo" | "i18n"; ref: string;        // 期望源+具体 nodeId/demo 状态名/locale key
  }[];                                                     // v6.11:checker 断言 length===1——一行只承载一个期望维度;多维状态(如 mobile 字标的资产+几何)拆独立行(见优先级表),标量 Cell 因此可与唯一期望一一比对
};
// 坐标与证据元数据基础类型(v6.18 冻结——此前 CellRef 仅被引用未定义,执行者无从确定形态)
type Device = "mac" | "windows" | "iphone" | "android-phone" | "ipad" | "android-pad";
type Locale = "zh-CN" | "zh-TW" | "en" | "ja" | "ko";
type Region = "cn" | "global";
type CellRef = { rowId: string; device: Device; locale: Locale; region: Region };
type EvidenceMeta = {                                      // <evidence>.meta.json 的完整 schema
  evidenceSha256: string; testedCodeCommit: string;        // C 全 SHA(--for-main 语义见§框架第 1 条)
  capturedCellRef: CellRef; reuseGroupId?: string;
  applicableCellRefs: CellRef[]; scenario?: string; capturedAt: string;
};
// CellRef 等价规则(v6.18 冻结,checker/fixture 统一实现):规范化 key = `${rowId}|${device}|${locale}|${region}`,
// 集合比较一律无序、按规范化 key 判等;数组内重复 CellRef → schema 拒绝;
// capturedCellRef 必须 ∈ applicableCellRefs;
// 复用态:reuseGroupId 必填且命中 manifest 组,该组 cells 规范化集合与 applicableCellRefs 精确相等;
// 非复用态:reuseGroupId 必须缺省且 applicableCellRefs.length === 1(恰为 capturedCellRef)。
// manifest 顶层(v6.16):证据复用授权的唯一通道
type ManifestTop = {
  rows: ManifestRow[];
  evidenceReuseGroups?: {                                  // 声明式等价组:组内格允许共享同一证据文件(checker 按 SHA256 比对)
    groupId: string; cells: CellRef[];                     // 组外出现重复 SHA → exit 非零
    dimension: "locale";                                   // v6.16 冻结:仅允许纯图形行跨 locale 复用;禁止跨 device/region/文案行(出现即 schema 拒绝)
    rationale: string;                                     // 理由必填(如「纯图形行,语言不参与渲染」)
  }[];
};
type NAReason = "surface-not-on-platform"      // 该呈现单元在此端不存在(如移动无回调页)
  | "region-exclusive"                          // cn/global 独占(如迁移弹窗 cn-only)
  | "platform-exclusive-feature"                // 如 Splash 更新链桌面专属
  ;                                             // (v5.2 删除 language-render-identical——纯图形行用 allowReason 复用证据,不转 N/A)
// 矩阵格值
type Cell = { value: "PASS"; evidence: string; baseline: { source: "wave4"|"demo"|"i18n"; ref: string /* nodeId 或 demo 状态名,禁模糊引用 */ }; reviewer: string; approvedAt: string; allowReason?: string /* v6.16 降级:纯说明字段,无复用授权效力——复用合法性只由 evidenceReuseGroups 判定 */ } // v6.11:checker 将 Cell.baseline 与行唯一 baselineRequirement 比对(source+ref 均须匹配)——仅校验证据自报的枚举/非空 = 假绿,期望值以 manifest 为准;多维状态已拆独立行,标量 Cell 恰好承载单一期望;v6.17:PASS 格必须存在 <evidence>.meta.json sidecar(evidenceSha256/testedCodeCommit/capturedCellRef/reuseGroupId?/applicableCellRefs[]/scenario/capturedAt)——引用格必须 ∈ applicableCellRefs;复用组的 applicableCellRefs 与 manifest 组 cells 精确相等(device/region 分量一致,仅 locale 变化);--for-main **不要求** C 为 H 祖先——按§框架第 1 条比较 C/H 非 allowlist tree-entry tuple({path,mode,type,objectId})精确相等,并按显式四项 artifact allowlist 校验正规文件(100644 blob)+引用闭包(v6.19,取代 v6.17 的 ancestry+acceptance 前缀旧模型)
  | { value: "FAIL"; note: string }
  | { value: "GAP";  decidedBy?: string; decidedAt?: string; conclusion?: string }   // 仅 slice 中间态
  | { value: "N/A";  reasonCode: NAReason; detail?: string }
  | { value: "WAIVER"; approvedBy: string; approvedAt: string; retestVia: string; deadline: string };
```

**硬适用性不变量（checker 内置,manifest 不可豁免,v5.2 强化）**：①**列 universe 冻结 = 6 端 × 5 语 × 2 区**:所有 UI 状态行 `locales` 必须精确覆盖全部 5 语、`regions` 必须覆盖 cn+global（区域独占仅经 `region-exclusive` typed N/A）,不允许静默子集;②schema 的 `rowKind: "desktop" | "all-mobile" | "phone-only" | "pad-only"` 判别字段(v6.6:与上方冻结 TS 类型为**同一组字面量**,manifest/checker/负 fixture 只认这四个值,禁止 phone/pad 等别名)——platform=desktop 行必适用 mac+Windows;rowKind=phone-only 行必适用 iPhone+Android phone、rowKind=pad-only 行必适用 iPad+Android pad、**一般移动行默认 all-mobile 必四端**（phone-only/pad-only 必须显式声明并成对存在）;coverage checker 强制同一状态族 phone-only+pad-only 成对存在（有 phone-only 行必有对应 pad-only 行,除非 pad 侧经 `surface-not-on-platform` 且理由可验证）;③区域例外仅允许 `region-exclusive` 理由码;④**删除 `language-render-identical` 理由码**——纯图形行 5 语格照样 PASS,复用同一证据须经 manifest 顶层 `evidenceReuseGroups` 声明（v6.16,dimension 限 locale;allowReason 无授权效力）,不得转 N/A。**分层基准优先级表（v6.5 冻结,v6.9 混合维度拆分,v6.11 行粒度收紧:一行一期望维度）**：字标按端与维度分列——**desktop 字标一行(资产/尺寸/位置全 wave4,单一期望 ref=368:1381);mobile/pad 字标拆两行——资产行=wave4(368:1381)、几何行=沿旧移动帧(旧字标框内 contain,与 Step 5 冻结一致)**;Slogan 拆两行独立记录——**样式行(颜色+0.5px stroke)=wave4(368:1394)、几何行=沿旧**;背景/窗框描边/面板描边=wave4;**Splash 五帧原型的全部静态布局与样式=wave4(逐帧 nodeId:checking_update→379:581/updating→379:525/update_done→379:607/checking→379:633/failed→379:655/downloading→379:525 复用),demo 对 Splash 仅验六阶段覆盖、文案、动画时序**;其余行=demo。manifest 为背景/字标/Slogan/面板描边/Splash 各建独立行并记录具体 nodeId。**负 fixture 第七例（v6.9 扩三变体,v6.11 调整）**:①给 wave4 基准行挂 demo 证据(source 不匹配)、②source 对但 ref 错(nodeId 不符期望)、③行 baselineRequirements length>1(多维未拆行)→ schema 拒绝——三者均须 exit 非零;**拆行完整性机械核对:同一 stateFamily 下资产行存在而几何行缺失(或反之)→ coverage checker exit 非零(第四变体);正例须覆盖 desktop 字标单行、mobile 字标双行(资产行 wave4+几何行旧帧)、Slogan 样式/几何双行、zh-TW 语言格(source=i18n)**。
**负 fixture 必备（v6.2 扩到六例,v6.5 七例,v6.7 八例）**：把本应适用的格塞进 naAllowed、locales 漏 zh-TW、mobile 状态漏 iPad、漏 Android pad、regions 漏 global、phone-only 行缺 stateFamily 配对的 pad-only 行（或配对键不匹配）→ 六种错误放宽均须 checker exit 非零;**第八例（v6.7）:manifest 使用非法 rowKind 别名值（如 `"phone"`）→ schema 校验拒绝 exit 非零**;**第九~十二例（v6.16,对应 SC 专项复审 F1/F2）:⑨空 manifest 或删除一个完整 stateFamily（与 required-state-catalog 集合不等）→ exit 非零;⑩行缺 `baselineRequirements` 字段（v6.16 已转必填）→ schema 拒绝;⑪同一证据 SHA256 出现在未声明 evidenceReuseGroups 的两格（或声明组 dimension 非 locale/跨 device/region）→ exit 非零;⑫PASS 格缺 sidecar、或引用格 ∉ applicableCellRefs、或复用组 applicableCellRefs 与 manifest 组 cells 规范化集合不等/device/region 分量不一致/数组含重复 CellRef、或非复用态带 reuseGroupId、或 `--for-main` 下 allowlist 外任一路径 C/H tree-entry tuple({path,mode,type,objectId})不等——**专项变体四例（v6.18 一例,v6.19 扩三例）:(a)C..H 只改 acceptance 目录内的 required-state-catalog.json / state-manifest.json / required-e2e-cases.json（旧前缀白名单内、新 artifact allowlist 外）;(b)allowlist 外路径仅 mode 100644→100755（blob OID 不变）;(c)allowlist 外普通文件改 symlink 且复用同一 blob OID;(d)allowlist 内 artifact（matrix/report/evidence）为 symlink,或 evidence 目录含未被 matrix/report 引用闭包覆盖的额外文件——四例均必须 exit 非零** → exit 非零;**⑬（v6.17,对应复审二轮 F3）:rowId 集合与 catalog 相等但某行 ground-truth 字段（rowKind/stateFamily/dimension/source/ref/applicability/naAllowed）与 catalog 不符（如 wave4 基准行被改挂 demo/错误 nodeId）→ exit 非零**;schema 示例本身必须能通过 checker（自洽例）,**且自洽例须覆盖全部四种合法 rowKind：desktop、all-mobile、phone-only+pad-only 配对（v6.7）,并含一个「至少两个 locale 格共享同一 evidenceSha256」的真实复用组及配套 sidecar（v6.17,单格组不满足正例要求）**。

## 附录 C：adaptation-spec「建议·待拍板」逐条处置表（v5 全覆盖,不留执行者自选项）

| adaptation 条目 | 处置 | 依据 |
|---|---|---|
| §1.1 条5/6 fitScale+minScale0.36 | 作废 | demo v3.1 拍板公式取代（权威链收口项） |
| §1.1 条2/3/4 stage 固定尺寸与居中锚点 | 关闭:1819×2098 stage 水平垂直居中锚定,构图属 demo 呈现仲裁;背景改 wave4 白底体系（代码渐变铺满,原红底外溢裁切规则失效作废）,PR1 落码并回写 | demo 呈现仲裁 + design.md §8 |
| §1.4 条4 顶部 46px 拖拽条 | 工程定案:drag region 改 overlay 化（`-webkit-app-region: drag` 独立层,不占文档流、不参与 stage 布局）,PR2a 与交通灯/Win 控件同批处置,双平台验证拖拽可用 | Step 3.3(v5.2 补) |
| §3.4 条2/3/4 Safe Area / Android 导航条 | 工程定案（沿现网机制,非新决策）:沿用现网 SafeAreaView/safe-area-context;白底体系背景（#F1F0F1+双渐变）edge-to-edge 铺满（含安全区外）,功能区（面板/圆钮行/输入控件）保持在 insets 内,bottom inset 计入 Log_in 组底距;Android 三键/手势导航同规则;PR4a 落码,真机/模拟器双导航模式截图验收 | Step 5.6(v5.2 补) |
| §1.2 条2/3(#13/#14) min 尺寸 | 关闭:维持 800×600 | U-3 终裁(覆盖 demo v3 旧拍板 440×568) |
| §1.2 条4/5(#15) 默认尺寸/scale 封顶 | 关闭:默认 1280×800 不动;scale 封顶 1 已含于 demo v3.1 公式 min(1,…) | demo 拍板注释 |
| §1.3 条2/3/4 DPI/image-set/系统缩放 | 工程定案(lead):坐标 CSS px、DPR 只选图、image-set 1x/2x、验收含 Retina+Win125/150% | 资源交付工程范畴,随本计划回写为已定 |
| §1.4/#16 交通灯/Win 控件对齐 | 工程定案:PR2a 仅 renderer 视觉对齐,不动原生 | Step 3.3 |
| §1.5/#17 多语超宽 | 关闭:锁框不动坐标,超宽 ellipsis(demo 行为) | demo 呈现仲裁 |
| §3.2 条1-4 两档插值 | 关闭:照 demo | U-8a 终裁 |
| §3.3(#18/19/20) 两档外 | 关闭:照 demo | U-8a 终裁 |
| §3.5(#22) 键盘避让 | 关闭:design§4.5 拍板 + U-8b 硬标准 | Step 5b.1 |
| §3.6 条3 横屏 clamp 上限 1.30 | 关闭:按 demo(仅下限 0.85) | 权威链收口项(v5) |
| §3.6 条6(悬浮键盘) | 关闭:U-8b(遮挡才上移) | U-8b 终裁 |
| §3.7 fontScale | 关闭:沿现状 maxFontSizeMultiplier=1.2(计划 Step 5.5 已含) | 现网行为保留 |
| §4 条4/5/6(#24 anchor/缩放/滚动) | 关闭:照 demo,卡与组件恒定、只动背景、放不下整卡等比缩、不裁 CTA | U-10 终裁 |
| §4 条7 深浅色 | 关闭:prefers-color-scheme(demo/设计一致) | Step 4.1 |
| §4 条8(#12 语言来源) | 保留现状(台账「本期明确保留」层) | 台账 |
| §5 条4/5/6 资源导出档 | 工程定案(lead):桌面 1x/2x、RN @2x/@3x、chibi 280/560/840 透明件 | 资源交付工程范畴,回写 |
| §5 条7(#25 承载) | 关闭:data URI | U-7 终裁 |
| §5 条8 占位/降级 | 工程定案:占位固定尺寸+失败保文字/CTA | Step 4.2 |
| §7-B #21 锁竖屏 | 已作废(§3.6 条5) | adaptation 自身 |
| §7-B #23 暗色登录面板 | 关闭:登录页恒白底体系+浅色面板(wave4),回调卡跟系统深浅 | design.md §8 + demo 呈现仲裁(非视觉五维) |
| #11 提前成功语义 | 保留现状(台账) | 非目标「不改 auth 语义」 |
| #26 detail 展示 | 关闭:错误码单行 | U-2 终裁 |

> 上表「工程定案/关闭」项随 PR0-docs 或对应 PR 回写 adaptation-spec 标注,消除「待拍板」残留状态。

## 版本记录

| 版本 | 日期 | 变更 |
|------|------|------|
| v1~v1.3 | 2026-07-20 | 初版 → figma 规范吸收（wave3.5 几何/透明底/字体拍板）→ 5 语 6 端动画拍板 → 百分百还原框架 |
| v2 | 2026-07-20 | 吸收首轮审核 27 P1+7 P2（权威链/harness/回调/zh-TW/PR 拆分/SC checker/WAIVER/门禁/三契约） |
| v3~v3.1 | 2026-07-20 | 吸收 v2 复审 18 P1+7 P2（harness 终态/handoff 宿主/方案 A/U-7 U-8/终态二分）+ U-4 裁决 + 执行编排段 + U-6 收窄 |
| v6.19 | 2026-07-20 | **SC 专项复审四轮**(sc-review 对 v6.18 复核:allowlist/锚点排除/类型冻结确认落位,新 2 P0+2 P1 全采纳):①判定模型 blob OID → **tree entry tuple {path,mode,type,objectId} 集合精确相等**(blob OID 不含 mode/type,100644→100755 或文件→symlink 复用同一 blob 可绕过——负 fixture ⑫扩 b/c 两例);②artifact 正规文件+引用闭包约束——matrix/report/被引用 evidence/sidecar 必须 mode=100644 type=blob 正规文件、拒 symlink/gitlink、内容从 H tree object 读取,两个 evidence 目录路径集合与 matrix/report 引用闭包精确相等、未引用文件即败(负 fixture ⑫例 d);③附录 B Cell 尾注废弃 ancestry+acceptance 前缀旧模型残留,改引§框架第 1 条 tuple 模型;④closeout/--for-main 分层时序修正——实现 PR closeout 在该 PR HEAD 跑 slice 三件套不跑 --for-main,C=全部实现+获批锚点变更冻结后的源码+契约树 commit(不限定末实现 commit),仅 integration→main 最终 closeout 在 H 跑 SC-9 双门 |
| v6.18 | 2026-07-20 | **SC 专项复审三轮**(sc-review 对 v6.17 复核:五项修订本体确认落位,新 1 P0+1 P1 全采纳):①`--for-main` 判定模型改「路径级 blob OID 对比」——artifact allowlist 从 `acceptance/**` 前缀收窄为显式四项(fidelity-matrix.md/evidence/**/e2e/report.json/e2e/evidence/**),三份冻结锚点+state-manifest+translation-review+schema/fixture/checker/构建配置全部在 allowlist 外、H 动即败(堵「H 同改 catalog+manifest 再相等」绕过);判定不再依赖 commit ancestry,免疫 squash/rebase merge 策略;锚点批准变更须先合入形成新 C 全套重跑;finalization 与 closeout 相容流程写死(integration 上 C=末实现 commit→验收→追加 artifact commit=H,closeout 在 H 跑);负 fixture ⑫增「只改锚点/manifest 仍败」专项变体;②附录 B 冻结 Device/Locale/Region/CellRef/EvidenceMeta 完整类型+等价规则(规范化 key 无序集合判等/重复拒绝/capturedCellRef∈applicableCellRefs/复用态 reuseGroupId 必填组集合相等/非复用态单元素) |
| v6.17 | 2026-07-20 | **SC 专项复审二轮**(sc-review 对 v6.16 复核:F4/F5/F7/F8 确认闭环,新 3 P0+2 P1 全采纳):①新实现落点补入写 allowlist——vite.main/renderer.config.ts+metro.config.js(仅 fixtures 生产排除条件)+三个新 checker 脚本,Step 0 WHERE 同步,checker 交付归属明确化(PR0a 四个);②消除 --for-main Git 自引用悖论——testedCommit 拆两层语义:sidecar/report 记 `testedCodeCommit=C`(代码冻结 commit),验收产物走 acceptance-artifact-only commit 形成 H,checker 校验 C 为 H 祖先+C..H diff 仅 acceptance/** 路径;buildId 改 builds:[{buildId,sourceCommit:C}] 逐 build 校验 sourceCommit,不与 commit 比等;③required-state-catalog 从「只锚 rowId 集合」扩为逐行全字段 ground truth(rowKind/stateFamily/dimension/source/ref/applicability/naAllowed),checker 逐行断言 manifest 与 catalog 相等(堵「集合不变、期望被篡改」),负 fixture 第⑬例;④sidecar 坐标模型改 cellRef 形态(capturedCellRef+applicableCellRefs[],复用组与 manifest cells 精确相等、仅 locale 分量变化——消除单标量 locale 与多 locale 复用互斥),自洽例须含 ≥2 locale 格真实复用组;⑤新增第三锚点 required-e2e-cases.json(literal caseId 笛卡尔展开),e2e checker 只做集合相等不得自定义范围 |
| v6.16 | 2026-07-20 | **SC 专项复审轮**(用户指令:全部 SC 送 gpt-5.6-sol xhigh 单独复审;8 findings 全采纳):①SC-2/7 全集独立锚定——PR0-docs 冻结 required-state-catalog.json,checker 断言 manifest rowId 集合精确相等(堵删行假全绿)+`--run-mapped` 真实执行全部映射用例逐项 passed(收集≠通过)+移动侧补 coverage 命令;②证据防空转——evidenceReuseGroups 声明式复用(dimension 限 locale,SHA256 重复检测,allowReason 降为无授权效力)+PASS 格 sidecar 元数据(testedCommit 绑定,--for-main 拒旧证据)+负 fixture 扩至十二例+baselineRequirements 转必填;③SC-1 生产泄漏机器门——fixtures build-time stub+字符串 sentinel 双断言脚本 check-login-production-guard.mjs(取代手工 bundle 扫描承诺);④SC-3 escape 基线冻结为 oauth-escape-baseline.json+checker(废 PR Description 自报);⑤SC-9 main 链式双门补 check-login-e2e-report.mjs(e2e 升机器门);⑥SC-4 补消费者双向静态扫描+翻译评审门(verbatim 逐字符相等+新 key review 记录);⑦SC-5 补 touched workspace typecheck+终审三连;⑧SC-8 删 allowlist 机制(双清零无例外通道)。checker 五→八,交付物/风险表/框架条目同步 |
| v6.15 | 2026-07-20 | 用户裁决与增补落档(共识后,不改结构不需重审):①U-11 裁决=选项 B(Android 悬浮键盘例外,PR4b 开工阻塞解除,U-8b 限定语/键盘节/Step5b 标题/台账四处同步);②启动加载白底改判复用 main 已合入 Splash v2(正主 **PR #104** CINDY 双端换肤,严健;#123=透明度收口 466a3208,用户更正 PR 归属):底色消费不透明 var(--surface) token 不另造 #F1F0F1 字面值,PR2b 基线前移至 main 最新 Splash v2(品牌块/14-phase 零删改/onSpawnFailedDownload)之上做 wave4 增量;3s 最短停留与热更重启守地板为不得回退行为 |
| v6.14 | 2026-07-20 | 终审收敛轮(review-c v6.12 直接下游):附录 A 冻结场景表的三失败弹窗断言由统一「DOM+retry」改为按现网分弹窗 CTA action(manifest/download=重试,spawn=「前往下载」调下载页路径禁 retry)——与 Step 3b v6.12 的 spawn 语义消歧同步,消除两份冻结契约互斥 |
| v6.13 | 2026-07-20 | 终审收敛轮(review-a v6.1 基线可实施性实证):bridge fixture 方案补显式 dev-only seam——authManager.openSystemBrowserAuthorization 增 loopback bridge seam(构造注入或抽可注入纯 helper,PR3 定型),fixture 经 seam 取得进程内回调入口(原文「fixture 在闭包内构造回调」在旧 allowlist 下不可实施);seam 三硬测(真实 error HTML/无 state 凭证落盘/packaged 分支不可达);allowlist 的 authManager 条目同步扩至 seam 定义与注入(不改授权业务逻辑) |
| v6.12 | 2026-07-20 | 终审收敛轮(review-a v6 基线代码实证的两处存活细节):①三失败弹窗仅统一面板视觉,各自 action 语义沿现网不变——spawn_failed CTA=「前往下载」打开下载页,failed 帧「重试」样式仅供按钮视觉规格,禁改 spawn 恢复语义;②LoginBrandStage 内部分层冻结:静态 full-viewport 背景子层(viewport 锚定)与可动画内容子层分离,背景渐变不参与 handoff transform/opacity(桌面侧补齐与移动宿主同级的锚定冻结) |
| v6.11 | 2026-07-20 | 终审收敛轮(review-b v6.9 新引入项+P2 收尾):baselineRequirements 行粒度收紧 length===1(一行一期望维度,checker/schema 断言;标量 Cell 与唯一期望一一比对——修复 v6.9 数组期望 vs 标量 Cell 的结构矛盾);mobile 字标拆资产行+几何行(与 Slogan 拆行同法),第七例第三变体改 length>1 schema 拒绝+第四变体拆行完整性机械核对;Step 7 措辞同步;P2 收尾:三处「U-1~U-10 无待批项」过时表述改「U-11 唯一开放项」,Step 5b 标题补开工前置 U-11 |
| v6.10 | 2026-07-20 | 终审收敛轮(review-b v6.5 复核存活增量):移动 full-viewport 白底宿主的交付归属修正——MobileLoginHandoffStage 静态视觉宿主(背景+品牌五要素)与 RootLayout 挂载移入 PR4a(WHERE/WHAT 同步,PR4a 独立 checkout 全闸门可见白底并 pr4a slice 自证),PR4b 仅追加 handoff Provider/reporter/动画接线(Stage 由新建改扩展);矩阵 owner 拆分明写(静态视觉行=pr4a,动画/键盘行=pr4b)——消除 v6.5 宿主冻结句与 PR 边界的结构冲突 |
| v6.9 | 2026-07-20 | 终审收敛轮(review-c v6.5 基线存活增量):附录 B 增 ManifestRow.baselineRequirements 期望基准字段(机器可读 ground truth,checker 将 Cell.baseline 与之逐维比对 source+ref——消除证据自报假绿);字标口径按端分列(desktop 全 wave4/mobile 资产 wave4+几何旧帧)、Slogan 样式与几何拆行;负 fixture 第七例扩三变体+四类正例;Step 7 证据字段升 {source,ref} 且允许 i18n;wave4 静态扫描门禁冻结可执行合约(入口 check-login-wave4-authority.mjs/五份文件全集/作废语境确定性语法/WAVE4_AUTHORITY_OK/正负 fixture),入 closeout 命令+allowlist+交付物(checker 四→五);清理 v5.x 残词 |
| v6.8 | 2026-07-20 | 终审收敛轮(review-a 存活增量):U-1 消费者盘点补 learn-host promptBuilder 的 REPLY_LANGUAGE_BY_LOCALE(非类型化 Record 漏 zh-TW 则 /learn 强制英文回复;Step 1 WHERE/消费者清单/allowlist 三处贯穿+parity 必检);Step 3b 测试分层消歧(禁 mock-reject 限定 handoff 集成层,AuthContext catch 回归单测必须真实 mock reject,两类并存);U-11 选项 A 附前置可行性验证(第三方浮动 IME 的 native ime bounds 可得性实测,不可得则回落 B 或免 bounds 布局策略) |
| v6.7 | 2026-07-20 | 终审收敛轮(review-c 存活增量):Android 悬浮键盘 GAP-9 与 U-8b 硬标准/SC GAP=0 门禁互斥→升格 U-11 待用户裁决(PR4b 开工前置阻塞,选项 A native helper 前置/选项 B 例外裁决,默认推荐 A),GAP-9 概念废除;iOS 键盘订阅补 keyboardWillChangeFrame(浮动键盘已显示后改 frame 的唯一派发通道)+单测向量补 frame 变化例;U-5/复用表 sim 口径与 Step 5-pre 统一(仅 rebuild/whoami 为 iOS-only,sim:start 通用 Metro);负 fixture 第八例(非法 rowKind 别名)+自洽例须覆盖四种合法 rowKind |
| v6.6 | 2026-07-20 | 终审收敛轮单点修复:附录 B 硬适用性不变量②的 rowKind prose 枚举统一为冻结 TS 类型同组字面量(phone-only/pad-only,删除 phone/pad 旧别名——v6.2 入 schema 时的 prose 遗留);页首状态行同步至当前版本 |
| v6.5 | 2026-07-20 | 吸收 v6.1 基线终审存活增量:token-decision-table 改判入 PR0-docs 前置(brand-bg 语义限 accent 禁页面背景,Step 0 token 句同步);附录 B Cell 增 baseline{source,ref} 冻结字段+分层基准优先级表(字标全 wave4/Slogan 色 wave4 几何沿旧/Splash 静态逐帧 nodeId 映射,demo 只验阶段-文案-时序)+负 fixture 第七例(基准错挂);移动白底宿主冻结(MobileLoginHandoffStage 唯一 full-viewport host 盖 safe area 外+全闸复用/渐变锚 viewport 不随 stage-键盘/字标 contain 等比);摘要行 r18-外 r16-内对应关系明写 |
| v6.4 | 2026-07-20 | wave4 贯穿收口(v6 终审 4P1):六处红底残留执行句改白底体系(收口项/BrandStage/SafeArea×2/附录C#23/台账与风险表抠图依赖清零);wave4 权威回写+旧词静态扫描升为 PR0-docs 强制前置交付;分层基准贯穿四个验收入口(交付定义/执行编排验收句/Step3b VERIFY 时序-静态拆分/Step7 对照法+evidence baseline 字段);窗描边 r18/r16 分层明写;立绘来源裁定入 PR0-docs(默认复用旧 source+渐变只画一次) |
| v6.3 | 2026-07-20 | 吸收 v4 基线深查的存活增量:desktop/mobile 两端 initialize 链补 .catch 归一未登录(AuthContext 两文件限定范围进 allowlist+回归测试);SC-4 补根级 pnpm check:i18n 门;mobile RN 测试库 devDeps 显式例外(+不兼容降级路径);Android 悬浮键盘 JS 矩形不可得→首版不触发自定义上移记 GAP-9+native 升级路径;Step 5-pre 事实修正(larksso 风险过期/初装 pnpm --filter mobile android/sim:start 通用);endpoint/config 硬编码文案点名 key 化(env.ts 限定进 allowlist) |
| v6.2 | 2026-07-20 | 附录 B 冻结 schema 补 rowKind 与 stateFamily 字段(phone/pad 机械配对键+rowId 冻结格式)、applicability 默认全集注释、负 fixture 第六例(配对缺失)+schema 自洽例要求;页首元数据更新 |
| v6.1 | 2026-07-20 | 吸收 v5.1 基线终审 5 P1:SC-2 改 `vitest list --json`(实测 --list 不存在)+checker 自测三例;parity 冻结 --scope desktop/callback/mobile/all,三支 PR0b scoped 合并+integration 收敛门;Step 3b 测试句禁 mock-reject(与契约统一为 resolved-unauthenticated);附录 B 列 universe 冻结 6端×5语×2区+一般移动行必四端+负 fixture 第五例(漏 region);Step 4 失败卡验证废除 live state 日志(anti-CSRF 不落盘),改 bridge fixture 进程内触发+HTML 落盘附属能力;overlay hard-stop 不重开 U-3;Step 5-pre 只读诊断默认+改配置须先冻结清单扩 allowlist |
| v6 | 2026-07-20 | **白底体系变更(wave4,用户拍板+设计稿 6 新帧 368:1375/379:5xx)**:背景 #F1F0F1+双 #F70121 渐变(代码复现)、窗框描边 #A3A8AD/#FFFFFF、字标黑红透明底版(423×145)、SLOGAN #2A2828、全面板 +#D4D4D4 1px 描边、Splash 五态统一面板化(downloading 复用延展);面板内组件几何零变化;移动/iPad 视觉继承桌面+布局沿旧帧;demo 基准分层(五维度=wave4 帧,其余=demo);token 组重定义;字标红底告警/抠图过渡方案作废;design.md 新增 §8 权威节;回调页维持现有稿不在本轮变更 |
| v5.2 | 2026-07-20 | 终审第二份反馈:附录 B 适用性铁律强化(5 语全覆盖必填/rowKind phone-pad 成对/删 language-render-identical/负 fixture 扩四例);附录 C 补三组(§1.1 stage 居中锚=demo 仲裁、§1.4 拖拽条 overlay 工程定案→Step 3.3、§3.4 Safe Area 沿现网机制工程定案→Step 5.6);残词清理(v4.1/U-1~U-9/本文件 v4/Step 5b.4 引用/候选字样/keyboardScreenY 措辞/差异表#1 依据) |
| v5.1 | 2026-07-20 | 吸收终审轮首份反馈的 5 条真增量:HelpThreadView 修正为 components/settings/ 真实路径+checker 断言;U-10 贯穿 Step4 标题/依赖节并冻结 demo 公式(topOffset=w<760?88:80,scale=min(1,(w-32)/680,(h-topOffset-24)/680))+滚动策略;键盘 shift 加 safe-top 上限与矮视口回退;--login-link-pressed token 注册(U-9 值 token 化);SC-6/7 改逐条可复制命令;依赖节改 PR0-docs bootstrap 表述。其余 12 条经核对为 reviewer 读中间态快照(17df606c,466 行)所致,v5(890c4ab4)已修 |
| v5 | 2026-07-20 | 吸收第四轮(共识轮)3 份冷读审核 23 P1+12 P2:分支拓扑定稿(PR0-docs bootstrap+integration 分支+stacked 合并+push 授权门禁);PR0b 拆三独立 PR;PR4-preflight(Android 构建打通为 PR4a 入边);附录 A 修正(error 前置动作脚本/bridge・credential fixture/providers 失败全屏语义/splash 补三弹窗 token);附录 B 矩阵 schema 冻结(reasonCode enum/适用性铁律/负 fixture/evidence 校验/test id 解析);附录 C adaptation 待拍板全量处置表;slice 门禁 GAP=0+--for-main 严格模式;U-8b 二维相交+控件可见性算法;倒计时显示数学;窗框描边 token 化;handoff mock-reject 改 resolved-unauthenticated 语义;横屏 clamp 按 demo 收口;e2e 清单具体化;U-3 终裁(覆盖 demo 440×568 旧拍板)+U-10(回调自适应照 demo)落档;全文旧口径残词清理 |
| v4.1 | 2026-07-20 | U-1~U-9 全部裁决落档：U-1 zh-TW 按现网 locale 同标准全量接入（Step 1 重写,i18nCompleteness 不开例外,HelpLocale 族/菜单补真实分支）；U-2 detail=现网行为（错误码单行）；U-3 min 尺寸不改；U-6 基准拆分成立（文字=现行 i18n 体系）；U-7 data URI；U-8a 照 demo；U-8b 键盘可见性硬标准（输入框+主按钮完整可见,悬浮键盘遮挡才上移）；U-9 pressed=#1A1818（lead 受托定值）。计划无待批项 |
| v4 | 2026-07-20 | **自包含全文版**（消除全部「同 v2」引用，本文件单独可执行）+ 吸收 v3 复审 15 P1+6 P2：checker 终态精确定义（GAP final 必败、N/A reasonCode enum、四例 fixture）；LoginBrandStage 所有权边界修正（品牌视觉层≠五要素，面板/圆钮行归 LoginPage）；删除 auth-init-failed 虚构分支（补 mock-reject 测试）；移动 handoff reporter 拓扑 + login-panel-mounted 锚 + 错误/重试状态表；zh-TW 双端 fallback 链（main t() zh-TW→zh-CN→en + i18nFallback 测试）+ 规则 18 例外声明；键盘改方案 B（不动全局 soft-input,单源位移+实测升级路径）；Android 构建路径事实修正（mobile:sim 为 iOS-only,U-5 改部分就绪）；U-8 拆 a/b、U-9 新增（Text_link pressed）；附录 A scenario→endpoint→预期全表冻结；主窗 gating、panelBottomY 稳定基线、登录外输入屏回归 |
