---
name: review-pr
description: >
  从 github.com 拉取指定 PR 编号(形如 #123)到本地,先和用户确认功能必要性与重复性,
  再做严谨的代码审查,通过后调用 GitHub API 合并并发评论给作者,最后清理本地分支并同步主干。
  支持 --auto 无人值守模式(scheduler 定时触发,自动选 PR / 审查 / 合并或打回 / 飞书通知 owner)。
  selfFixAuthors(lizi/magiclizi)本人的 PR 卡住时不打回,自动开跟进会话修复直到能合并(fix-handoff)。
  触发关键词:review-pr、合并 PR、merge PR、审查 PR、#数字、xindong PR、GitHub PR。
argument-hint: "[PR 编号,如 #123 或 123;不传会自动选最早的 open PR] [--auto 无人值守模式]"
allowed-tools:
  - Bash
  - Read
  - Grep
  - Glob
  - AskUserQuestion
  - mcp__lizi_feishu__list_tools
  - mcp__lizi_feishu__call_tool
  - mcp__lizi_xdt_helper__list_tools
  - mcp__lizi_xdt_helper__call_tool
---

# review-pr — github.com PR 审查与合并

把一个 PR 从"拉下来"走到"合并 + 评论 + 清理本地"的完整流程。

## 自动模式(`--auto`)

当参数(`$ARGUMENTS`)包含 `--auto` 时,进入**无人值守自动模式**:跳过所有 `AskUserQuestion`,按确定性规则自动决策,完成后飞书通知 owner。**以下规则只在 auto 模式下生效**;不含 `--auto` 时,仍然走下面全文描述的交互式流程,**所有关键决策让用户拍板**,不要自作主张合并或回复。

### 自动模式决策规则

| 决策点 | 交互模式 | 自动模式行为 |
|---|---|---|
| 输入解析(无 PR 号) | `pick.mjs` 自动选 | 同(auto 模式一定不带 PR 号) |
| 环境准备:锁被占 | 告诉用户 | **静默结束,不通知,不释放锁**(锁不是你的)——下一轮 scheduler 会重试 |
| 环境准备:gh 未登录 | 提示 `gh auth login` | 输出异常汇总(scheduler 的 feishu 通知会自动发给 owner)→ **若已拿到过锁先调 `release-lock.mjs`** → 结束 |
| 环境准备:working tree 脏 | 提示用户处理 | 输出异常汇总 → **若已拿到过锁先调 `release-lock.mjs`** → 结束 |
| 产品/UI 门命中(`auto.action=product-gate`:疑似产品/UI 变更、作者非白名单且无白名单放行信号) | 1.1.5 报告 + 用户拍板 | **主 agent 语义定性**(见「产品 / UI 变更门」):确属产品/UI → 自动开好讨论 issue + 鼓励语气评论告知作者(带 issue 链接)+ 转 draft(`product-hold.mjs`),issue 新开成功再飞书通知产品讨论群(`feishuNotify.groupName`,当前 `Cindy`)+ 私聊提交者(锚定 `issueCreated`,不重发);属 bugfix / 已有功能补充 → 按 `auto.fallback` 继续原走向 |
| 技术架构门命中(`auto.action=arch-gate`:触发器命中(核心路径大改 / refactor 大 diff / 超大 diff)、作者非技术白名单且无放行信号;产品门优先,两门不同时出现) | 报告 + 用户拍板(见「技术架构变更门」交互模式) | **主 agent 语义定性**(见「技术架构变更门」):确属较大架构调整 → `product-hold.mjs --kind arch`(开技术讨论 issue + 评论告知作者 + 转 draft),issue 新开成功再飞书私聊技术把关人(`feishuNotify.archRecipientName`,当前刘佳黎;消息用【架构讨论】前缀,**替代群通知,架构门不发群**)+ 私聊提交者(锚定 `issueCreated`,不重发);属局部实现 / 普通改动 / 机械性大 diff → 按 `auto.fallback` 继续原走向 |
| 被 hold 的 draft PR 等到 issue 白名单同意(`--scan-all` 的 `heldDraftResults` 条目:`held` 非空 + `discussionIssue.whitelistComments` 判出明确同意,或 `exempt=true`) | 判出同意后先跑 `product-release.mjs` 标回 Ready 再继续正常流程 | **自动放行**:`product-release.mjs <PR> --payload-file -`(标回 Ready + 评论告知作者是谁同意的,自带去重;**作者无需任何操作**)→ 该 PR 按 `auto.fallback` 重新归类进本轮流程;未同意 → 保持 draft,什么都不做(不重复评论、不再 hold) |
| 1.7 "是否继续审查" | AskUserQuestion | **自动选"继续审查"** |
| 1.7 前置门未通过 | AskUserQuestion(默认暂停) | **`context.mjs` 给 `auto.action=skip-gate`,跳过当前 PR 试下一个**(见下方「候选批处理」) |
| 结构性 BLOCKED + 可 bypass(`auto.action=bypass-structural-block`:review + 已跑 CI 都过,卡在永不上报的必需检查门,且当前账号有 bypass 权限) | 报告 + 用户可选 admin bypass 合 | **自动 `gh pr merge --admin` bypass 合并**(安全前提:reviewDecision=APPROVED + 已跑 CI 无失败 + 0 未 resolve thread + canBypass 确认);合并后正常发评论、飞书汇总列入「已合并」组 |
| 结构性 BLOCKED + 无 bypass 权限(`auto.action=skip-structural-block`) | 同上 | **跳过 + 飞书点名让 owner 去 admin bypass 或修门** |
| Workflow 待批准(fork PR,`auto.action=approve-workflows`) | 报告 + AskUserQuestion 确认后 approve | **自动 approve 放行 CI**(仅当 PR **未改** `.github/workflows` 等 CI 配置)——见「Workflow 待批准门」 |
| Workflow 待批准但 PR 改了 CI 配置(`auto.action=skip-workflow-ci-change`) | 强警告 + 用户确认 | **不自动批,跳过 + 飞书点名让 owner 手动 approve**(approve 会执行被改过的 CI,auto 不冒险) |
| 3A "合并并评论?" | AskUserQuestion | **自动合并 + 自动发评论** |
| 3B "提交 review?" | AskUserQuestion | **自动提交 REQUEST_CHANGES** |
| 3B "飞书通知作者?" | AskUserQuestion | **不发**(auto 模式打回当下不骚扰作者飞书;停滞超阈值另有下面一条兜底) |
| 作者侧停滞超 1 天(打回没改 / 评审意见没处理 / 冲突没解) | 不自动发(用户在场,3B 第 5 步自行拍板) | **飞书私聊提醒作者**:`remind-stale-author.mjs` 判停滞 + 去重,`shouldRemind=true` 才发(见「停滞飞书催办」) |
| Server 发布通知 gate(`format.hitsServer=true` 且作者未声明已通知 Lizi) | 打回草稿照旧用户拍板 | **自动走 3B 打回**(要求作者飞书通知 Lizi 后回复并 resolve;算「完整处理」,见「Server 发布通知 gate」节) |
| 代码修改 | 用户同意后可改 | **绝不修改 PR 代码**(auto 模式只读不写;`selfFix` PR 的修复也不在本 session 做,而是投递给独立的跟进会话,见下一行) |
| PR 作者 ∈ `selfFixAuthors`(`auto.selfFix=true`,当前 magiclizi)且卡在作者侧问题(格式不合规 / 审查不通过 / 冲突 / CI 失败 / 未 resolve thread / 打回后停滞) | 报告 + AskUserQuestion 由用户决定是否开跟进会话 | **不打回、不催办**(这是自动化账号自己的 PR,GitHub 不允许对自己的 PR 提 REQUEST_CHANGES;打回给 owner = 打回给自己,没有别人会来修),走「自动跟进修复(fix-handoff)」:为该 PR 开 / 复用一个专属跟进会话,把卡点投递过去让它修到能合并 |

### 候选批处理(auto 模式 only)

`pick.mjs` 返回的 `candidates` 是按 `createdAt` 升序排列的全部可处理 PR 列表。Auto 模式**先全量扫描分类,再批量并行处理**——单轮实质处理上限 **6 个**(下称 BATCH_MAX),不是只处理一个就结束,也不是无上限全做(锁 TTL 60 分钟,一轮必须在其内收尾)。**名额要努力用满**:第一波处理清单不足 6 个、或落地后名额有剩余时,按阶段 3 末尾的「补位波次」继续从排队 / 重叠延后候选里补,直到名额用满或确实再无可处理候选——"扫到几个做几个就收工"不算完成本节。

**每个候选的走向由 `context.mjs` 的 `auto.action` 字段决定(SKILL 旧版本的"跳过 vs 处理"判定已下沉成代码,你不要再自己推,直接读字段):**

| `auto.action` | `auto.isSkip` | 含义 | 该走的路径 |
|---|---|---|---|
| `review` | false | 格式门 + 前置门都过(含 `needsSelfApproval=true` 的自解死锁场景,见表下说明) | 进步骤 2 代码审查(审查后 3A 合并 / 3B 打回,都算「完整处理」) |
| `pushback-format` | false | 格式门没过,但没被打回过(或打回后已有新 commit) | 走 3B 提交 REQUEST_CHANGES(算「完整处理」) |
| `product-gate` | false | 疑似产品/UI 变更(feat 类型或命中 UI 路径),作者非白名单、且无白名单 review / 标回 ready 的放行信号 | 主 agent 单独拉该 PR 的 body(`gh pr view <N> --json body`,**不拉全量 context**)做语义定性(口径见「产品 / UI 变更门」):**确属产品/UI** → 拟 issue 标题 / 正文 + PR 评论,跑 `product-hold.mjs`(自动开讨论 issue + 评论告知作者 + 转 draft,算「完整处理」);**属 bugfix / 已有功能补充** → 按 `auto.fallback` 重新归类(`fallback.isSkip=true` 转跳过类;`fallback.action=review` 与其它 review 型一起进处理清单) |
| `arch-gate` | false | 疑似较大技术架构调整(`archGate.triggers` 命中:核心路径改动 ≥ 阈值 / refactor 大 diff / 任意类型超大 diff),作者非技术白名单(`archGate.whitelist`)、且无技术白名单 Approve / 标回 ready 的放行信号;**产品门优先**,`needsProductCheck=true` 时本行不会出现 | 处理方式与 `product-gate` 完全同构(见「技术架构变更门」):先判 `archGate.discussionIssue` 里技术白名单是否已同意 → 同意按 `auto.fallback` 归类;未同意 / 无 issue → 补拉 body 语义定性——**确属较大架构调整** → 拟技术视角的 issue / 评论文案,跑 `product-hold.mjs <PR> --payload-file - --kind arch`(算「完整处理」);**属局部实现 / 普通改动 / 机械性大 diff** → 按 `auto.fallback` 重新归类 |
| `approve-workflows` | false | 前置门唯一未过原因是 fork workflow 待批准、且 PR **未改** CI 配置 | 跑 `approve-workflows.mjs <PR>` 自动 approve 放行 CI(算「完整处理」,占本轮实质名额;下一轮 CI 跑完再审/合)——见「Workflow 待批准门」 |
| `bypass-structural-block` | false | `gate.blockClass=structural-check` + `structuralBlock.canBypass` 为 `always`/`pull_requests`:review + 已跑 CI 都过,只卡在永不上报结果的必需检查门,且当前账号有 bypass 权限 | **直接 `gh pr merge <PR> --merge --admin` bypass 合并**(算「完整处理」);合并后正常走 3A 的评论 + 飞书汇总列入「已合并」组 |
| `skip-gate` | true | 前置门未通过(未 resolve thread / 合并阻塞 `BLOCKED`·`DIRTY`;**且不属于下面的 workflow 待批准 / 结构性门**) | **跳过**(扫描阶段不 checkout,无需清理),继续扫下一候选 |
| `skip-structural-block` | true | `gate.blockClass=structural-check` 但当前账号**无** bypass 权限 | **跳过**,飞书汇总点名让 owner 去 admin bypass 合或修门(见「结构性 BLOCKED 门」) |
| `skip-workflow-ci-change` | true | workflow 待批准、但 PR 改了 CI 配置(`.github/workflows` 等),不自动批 | **跳过**,飞书汇总点名让 owner 手动 approve(见「Workflow 待批准门」) |
| `skip-stale-pushback` | true | 格式门没过,且上次已打回、作者还没提新 commit(再打回没意义) | **跳过**,继续扫下一候选 |

**self-approve 解死锁(`auto.action=review` + `auto.needsSelfApproval=true`)**:当某 PR 的 `mergeStateStatus=BLOCKED` 唯一根因是**本流程账号(viewer)自己之前 3B 打回挂的 `CHANGES_REQUESTED`**、且所有 conversation 已 resolve 时——典型死锁:作者改完、thread 都点了 Resolve,但那条旧 CR review 没撤,GitHub 的 `reviewDecision` 永远停在 `CHANGES_REQUESTED` → 永远 `BLOCKED` → 永远 `skip-gate` → 没人去撤 CR → 回到开头——`context.mjs` 已把这条 CR 从 `gate.blockers` 摘掉(`gate.selfBlockedResolvable=true`),判 `auto.action=review` 并打 `auto.needsSelfApproval=true`。这种 PR **照常进步骤 2 重审,不是直接放行**:靠审查子 agent 的「历史承接」逐条核实你当初提的问题在最新代码里**真被改了**(thread 标 resolved 但代码没改 = 红旗),而不是只看 resolve 标记。然后:
- 重审**通过**(零 `[阻断]`/`[必改]`)→ 进 3A,**合并前先 `gh pr review --approve` 撤掉自己的 CR 再合**(见 3A 第 0 步)。
- 重审**不通过**(有 `[阻断]`/`[必改]`,说明问题没真解决)→ **不走 3B 重复打回、也不 approve**:你自己那条 CR 还挂着、无需重复打回;保持现状,把「重审发现 N 项未真正解决(thread 标 resolved 但代码未改)」写进飞书汇总让 owner 人工介入。
- ⚠️ 只要这条 BLOCKED 掺了**别人**的 CR(`selfBlockedResolvable=false`),仍是 `skip-gate`——**绝不替别人撤 review**。

**selfFix 跟进修复(`auto.selfFix=true`,与 `auto.action` 正交的修饰位)**:作者在 `pr-rules.json` 的 `selfFixAuthors` 名单(当前 magiclizi = owner 本人 = 本流程自动化账号)时,一切「等作者动手」的走向都改道「自动跟进修复(fix-handoff)」(完整机制见同名章节),因为打回 / 催办对这类 PR 全部无效(GitHub 禁止对自己的 PR 提 REQUEST_CHANGES / APPROVE,且催 owner = 催自己)。各 action 的改道规则:
- `pushback-format` + selfFix → **不走 3B**(会 422),转 fix-handoff 投递(把格式问题清单投给跟进会话,让它把 title / description 一并修好);仍按轻操作占实质名额。
- `review` + selfFix → 照常进步骤 2 审查;**审查不通过时阶段 3 落地不走 3B**,改 fix-handoff 投递审查问题清单([阻断] / [必改] 条目全文);审查通过照常 3A 合并。
- `skip-gate`(冲突 / 未 resolve thread / CI 失败)与 `skip-stale-pushback` + selfFix → 仍记跳过类进汇总,但**额外**走 fix-handoff 投递卡点(与催办动作同位:全量候选都做、不占实质名额);且**不**走「催作者 resolve」和「停滞飞书催办」(不用在 PR 上 @ 自己、也不用飞书提醒自己)。`skip-gate` 因 ci-pending(CI 还在跑)的**不投**——没有东西可修,等 CI 出结果。
- 其余 action 与作者侧无关(product-gate / arch-gate 对 magiclizi 不会触发——他本就在两个白名单里;approve-workflows / structural 系列卡的是仓库设置),照常处理,不改道。

批处理分三个阶段:

**阶段 1:全量扫描分类(主 agent 执行,只读,不 checkout)**。跑**一次** `node scripts/review-pr/context.mjs --scan-all`(批量模式:脚本内部拉全部 open 非 draft 候选、并行跑单 PR `--scan` 判定,输出 `results` 数组——单次调用拿到全部分类,替代旧的逐候选调用;判定与单 PR `--scan` 是同一份代码,输出逐字段一致;**同时输出 `heldDraftResults`**——被产品/架构门 hold 转 draft 的 PR 的扫描结果,消费规则见下面「被 hold 的 draft:自动放行判定」)。`results` 里 `ok:false` 的候选(单个失败不炸整批)对其单独重跑一次 `context.mjs <PR> --scan` 兜底,仍失败按跳过类记入汇总(原因写「扫描失败,下轮再试」)。`--scan` 精简输出的纪律不变:不含 description 与讨论历史全文——几十个候选的全文进同一个主 session 会撑爆上下文并造成跨 PR 串扰,全文只允许进对应 PR 的审查子 agent 隔离上下文。`--scan-all` 还会自动落盘空转指纹(`scripts/review-pr/.last-scan.json`,供 scheduler 预检判「上轮全跳过且无变化 → 不起会话」,见「空转预检」节;skill 流程无需消费该文件,但**阶段 1 必须用 `--scan-all` 而不是自己循环逐候选 `--scan`**——后者不落盘指纹,预检的省钱判据会退化为永放行)。对每个候选读 `results` 里的 `auto`,分进三类:
1. `auto.isSkip=true` → **跳过类**:记下跳过原因(进汇总);`skip-gate` 且 `gate.unresolvedThreadCount > 0` 的,照旧按下方「催作者 resolve」调 `notify-author-resolve.mjs`(全量候选都催,不因名额满而漏催)。**例外:`auto.selfFix=true` 的跳过类候选不催 resolve、不停滞催办**,凡卡点在作者侧的(`skip-gate` 因冲突 / 未 resolve thread / CI 失败,或 `skip-stale-pushback`)改走「自动跟进修复(fix-handoff)」投递(同样全量都做、不占实质名额)。
2. `auto.isSkip=false` 且本轮实质名额未满(< BATCH_MAX)→ 先过**文件重叠守卫**再进**本轮处理清单**:会动主干的候选(`review` / `bypass-structural-block`)把 `--scan` 输出的 `filePaths` 与清单中已有的同类成员逐一比对,**存在任一相同路径 → 不进清单、转排队类**(汇总行写「与 #X 改动重叠,等它先落地」),名额让给下一个不重叠的候选。**为什么**:两个改同一文件的 PR 并行审时,各自的审查结论都没见过对方的改动,文本冲突合并时拦得住、语义冲突拦不住;串行处理(等重叠对象先落地,再基于新 main 重扫重审——同轮补位波次或下轮)天然消除该风险。
3. `auto.isSkip=false` 但名额已满(或被重叠守卫挡下)→ **排队类**:本波不碰;后续补位波次名额空出时会被重新扫描补进(见阶段 3 末尾),到收尾仍没轮到的才在汇总里记「排队下轮」。

**`product-gate` 候选先判 issue 同意、再定性归类**:① `--scan` 输出的 `productGate.discussionIssue.whitelistComments` 非空时,先逐条读白名单留言判「是否明确同意推进」(口径见「产品 / UI 变更门」)——已同意 → 拿 `auto.fallback` 的 `action`/`isSkip` 重新归类,视同放行(汇总行带一句「讨论 issue 已获 <谁> 同意,恢复审查」);`whitelistComments=null`(issue 读取失败)→ 既不 hold 也不放行,跳过该候选并在汇总「未合并」组如实说明让 owner 看一眼。② 未同意 / 无讨论 issue → 做产品/UI 语义定性(只补拉 `gh pr view <N> --repo <slug> --json body --jq .body`,**不拉全量 context**;口径见「产品 / UI 变更门」)——定性为**产品/UI** → 按 `isSkip=false` 进处理清单(阶段 2 轻操作执行 product-hold);定性为 **bugfix / 已有功能补充** → 拿 `auto.fallback` 的 `action`/`isSkip` 当作该候选的真实走向重新归类(汇总行也按 fallback 走向写,无需单独提产品门)。

**`arch-gate` 候选完全同构**(读 `archGate.discussionIssue`、同意判定按技术白名单、语义定性口径见「技术架构变更门」):同意 / 定性为普通改动 → 按 `auto.fallback` 归类;定性为**较大架构调整** → 进处理清单(阶段 2 轻操作执行 `product-hold.mjs --kind arch`)。

**被 hold 的 draft:自动放行判定(消费 `heldDraftResults`,每轮必做)**:`--scan-all` 会把被 product-hold 转 draft 的 PR(`held` 非空)单独扫出来——白名单同意发生在讨论 issue 上,作者不需要做任何事,**放行责任在流程这边**。对每条 `heldDraftResults`:
1. `held.kind=product` 读 `productGate`、`held.kind=arch` 读 `archGate`,先看 `exempt=true`(白名单已在 PR 上 Approve 等确定性信号)→ 直接放行;否则按对应门的口径判 `discussionIssue.whitelistComments` 是否**明确同意推进**(口径与 `product-gate` 候选完全一致,含 slack-sync 归属条目同等采信、unattributed 不采信、`whitelistComments=null` 不得当「无同意」)。
2. **判出放行** → 拟一句告知评论(写明是谁在 issue 里同意的,如「issue 里 <谁> 已同意推进，PR 已自动恢复 Ready，进入正常审查」),跑 `node scripts/review-pr/product-release.mjs <PR> --payload-file -`(stdin 传 `{"commentBody":"..."}`;脚本只放行带 hold 标记的 PR、自带幂等与评论去重,**作者自己转的 draft 会被拒绝,绝不误放**)。放行后按该条目 `auto.fallback` 的 `action`/`isSkip` 重新归类进本轮流程(占名额规则同普通候选;放行动作本身算轻操作)。汇总行写「讨论 issue 已获 <谁> 同意,已自动恢复 Ready 并 <实际走向>」。
3. **未同意** → 什么都不做(保持 draft;不重复评论、不再 hold、不催任何人),汇总也无需逐条列(仍在等讨论的 held PR 聚合一行即可,或省略)。`whitelistComments=null`(issue 读取失败)→ 如实进汇总「未合并」组让 owner 看一眼。

**主 session 上下文纪律(硬性)**:阶段 1 全程只消费 `--scan` 摘要;例外仅两处——进入处理清单的 `pushback-format` 候选(要写打回文案,需要 body 与格式详情)允许对该 PR 跑一次全量 `context.mjs`;`product-gate` 候选允许单独补拉 body(如上,仍不拉全量)。`review` 型的全量数据(description / 历史 / diff)由各审查子 agent 在自己 worktree 里自取,主 agent **不代拉**——主 session 里只应流动摘要、报告和落地动作。
(Codex 串行批处理例外:主 agent 要为**当前正在处理**的那一个 `review` 型 PR 跑全量 `context.mjs` 来拼审查 prompt——但任何时刻只拉"处理中"这一个的全文,其余候选仍只碰 `--scan` 摘要。)

**阶段 2:处理清单执行**。按 `auto.action` 分两种执行方式:
- **轻操作(不需要本地代码,主 agent 就地串行做)**:`pushback-format` → 直接进 3B 提交 REQUEST_CHANGES;`product-gate`(已定性为产品/UI)→ 按「产品 / UI 变更门」拟 issue 标题 / 正文 + PR 评论(鼓励语气,评论用 `{{ISSUE_URL}}` 占位),跑 `node scripts/review-pr/product-hold.mjs <PR> --payload-file -`(stdin 传 JSON 文案;脚本自动开 issue + 评论 + 转 draft,自带去重);`arch-gate`(已定性为较大架构调整)→ 同款流程但文案按「技术架构变更门」的技术视角拟,命令加 `--kind arch`;`approve-workflows` → 跑 `approve-workflows.mjs <PR>` 放行 CI(不 checkout、不审查、不合并——CI 才刚开始跑,下轮 CI 完了再审);`bypass-structural-block` → 直接 `gh pr merge <PR> --merge --admin` bypass 合并 + 发 3A 评论 + 跑 `close-product-issue.mjs <PR>`(有产品门 / 架构门讨论 issue 就自动关闭,无则 no-op);`pushback-format` + `auto.selfFix=true` → 不打回,按「自动跟进修复(fix-handoff)」投递格式问题清单。
- **`review` 型 → 并行审查**:
  Codex 没有 worktree 隔离的并行子 agent 能力,**降级为串行批处理**:逐个走原有单 PR 流程(1.4 主树 checkout → 审查子 agent → 按阶段 3 落地 → `cleanup.mjs --original <分支> --pr <N>` 删本地分支),做完一个再做下一个,直到处理清单清空;仍受 BATCH_MAX 约束。

**阶段 3:审查结果串行落地(主 agent,按创建序一个一个来,绝不并行合并)**:
1. 对每份审查报告,先机械核对首行 `审查对象:PR #<编号>` 与当前落地目标一致(串位即作废、重起该 PR 的审查子 agent,见「拿到子 agent 报告后」第 0 步),再过确定性 gate(数 `[阻断]` / `[必改]`)。
2. 通过 → 走 3A:self-approve(如需)→ `pre-merge-check.mjs` → 合并 → 发评论。**每个合并前必须实时重跑 `pre-merge-check.mjs`**——前面刚合并的 PR 会推进 main,可能让当前 PR 变冲突(DIRTY)或触发 mergeable 重算;`canMerge=false` 时**不硬合**,转「未合并」组,原因如实写(例:「和刚合并的 #X 冲突,需要作者更新分支,下轮再看」)。
3. 不通过 → 走 3B 提交 REQUEST_CHANGES;**`auto.selfFix=true` 的不走 3B**(对自己的 PR 提 REQUEST_CHANGES 会 422),改按「自动跟进修复(fix-handoff)」把审查问题清单投递给跟进会话。
4. 全部落地后,只要本轮合并成功过 ≥1 个,清理章节带 `--sync-main` 同步主干。
5. **(仅本轮合并成功 ≥2 个)合并后 main 健康检查**:清理章节 `cleanup.mjs --sync-main` 跑完(主树已在最新默认分支、锁已释放)后、输出飞书汇总前,跑 `node scripts/review-pr/typecheck-merged.mjs --current`(不动 git,直接对当前工作树 `tsc --noEmit`)。**为什么**:文件重叠守卫只挡「同路径」,跨文件的语义冲突(A 改了函数签名、B 在别的文件新增调用点,两个 PR 各自审查都过)挡不住,这里是合并后 15 分钟内发现 main 编译坏掉的兜底。读结果:`pass=false` → 按「自动模式结束输出」加警告行;`pass=true` 或 `ok:false`(脚本自身失败,如依赖未装)→ 不提、不阻断。只合并 1 个时跳过本步——单 PR 无跨 PR 语义冲突窗口,其分支 CI 已验证过。

**补位波次(名额没用满时必须做,不是可选)**:阶段 3 落地完成后,若本轮累计实质处理数 < BATCH_MAX 且还存在排队类候选(含被文件重叠守卫挡下的),**不要直接收尾**——前一波落地可能已推进 main,重叠对象落了、部分候选的卡门状态也可能变了。做法:对这些候选**重跑一次 `context.mjs <PR> --scan`**(旧摘要作废,必须重扫,不许拿第一波的分类结果直接用),把 `auto.isSkip=false` 且通过重叠守卫(与本波清单成员比对)的候选补进新一波处理清单,名额 = BATCH_MAX − 已累计实质处理数,然后按阶段 2 / 3 再走一遍。如此重复,直到:名额用满、或候选耗尽、或剩余时间明显不够再做一波(锁 TTL 60 分钟硬约束,宁可少做一波也不要超时挂锁)。停下时没轮到的照旧记「排队下轮」;补位波次里合并 / 打回 / 跳过的,汇总和尾行统计与第一波合并计数,不单列。

**催作者 resolve(skip-gate 因未 resolve thread 时,去重已代码化)**:某候选 `auto.action=skip-gate` 且 `gate.unresolvedThreads` 非空(卡门原因含「有 conversation 没 resolve」)时,**对该 PR 跑 `node scripts/review-pr/notify-author-resolve.mjs <PR>`**(命中多个候选时一次传全部:`notify-author-resolve.mjs <PR1> <PR2> …`,返回 `{batch:true, results:[…]}` 逐条消费——判定与去重逻辑不变,只是省工具往返)——它在 PR 上发一条评论 `@作者` 催其去点 Resolve。去重(同一批未 resolve thread 只评一次、集合变了才再评、全 resolve 后重置)按指纹在脚本里做完,你只管"命中条件就调脚本",**不要**自己判断"评论过没有"、也不要手敲 `gh pr comment`。读返回的 `posted`:`true`=本轮新发了评论;`false`+`reason=already-commented`=这批已催过(静默);`false`+`reason=comment-failed`=发失败(下轮自动重试)。结果带进飞书汇总(见下)。**auto 模式允许的「合并 / review 之外」的对外写操作只有五类**:本节的"催 resolve"评论、产品门 / 技术架构门的 `product-hold.mjs`(开讨论 issue + 评论 + 转 draft,见「产品 / UI 变更门」「技术架构变更门」;架构门加 `--kind arch`)、其镜像的自动放行 `product-release.mjs`(issue 白名单同意后标回 Ready + 评论告知,见「被 hold 的 draft:自动放行判定」)、讨论 issue 的自动收尾 `close-product-issue.mjs`(合并后定向关 + 每轮 sweep 兜底,两种门通用,见下面「产品门讨论 issue 收尾 sweep」)、和下面「停滞飞书催办」的飞书私聊——都走脚本判定、自带去重,不改代码、不发别的。(「自动跟进修复(fix-handoff)」的跟进会话投递是**本机会话操作**,不碰 GitHub、不属对外写操作,不占用此清单。)

**停滞飞书催办(作者超过 1 天没动时飞书私聊提醒;判定与去重已代码化)**:`auto.selfFix=true` 的候选**不走本节**(脚本对 own-pr 本就豁免;这类 PR 的停滞由 fix-handoff 的跟进会话闭环处理)。扫描中凡是「等作者动手」的候选——`auto.action=skip-stale-pushback`(打回没改),或 `skip-gate` 且 `gate.unresolvedThreadCount > 0`(评审意见没处理)或 `gate.blockClass=conflict`(和主干冲突)——**对该 PR 跑 `node scripts/review-pr/remind-stale-author.mjs <PR>`**(与「催作者 resolve」同位:全量候选都查,不因名额满而漏;同样支持一次传多个 PR 号的批量模式,返回 `{batch:true, results:[…]}`)。「停滞多久算卡住」(默认作者 ≥24h 无动作)、「同一 PR 多久最多提醒一次」(默认 24h)、own-pr / draft 豁免全在脚本里,阈值配置在 `pr-rules.json` 的 `staleAuthorReminder`;你只管读 `shouldRemind`:
- `shouldRemind=false` → 什么都不做(`reason` 会说明:还没到停滞阈值 / 刚提醒过 / 不卡作者侧 / own-pr)。
- `shouldRemind=true` → 先跑 `resolve-author-feishu.mjs <PR>` 查作者飞书身份(消费规则与产品门私聊完全一致:`matched[].parsed` 的 `email` 非空直接发,发失败按 `name` 搜、唯一命中才发,搜不到当没找到):
  - 找到 → 按下面模板发飞书私聊。**auto 模式直接发**——这是 owner 明确要的停滞升级提醒,不适用 3B 那条「打回当下不骚扰作者飞书」(那是即时负反馈原则,本节是超时兜底);
  - `found=false` → 不发,把「没能飞书触达」带进汇总行(`fetchErrors` 非空 = 名录读不到;否则 = 名录里没找到他)。

  私聊模板(按 PR 实际停滞原因改写;**语气硬性要求:这是温暖的提醒,不是要求或催促**——不用"请尽快""已经 N 天了"这类施压措辞,给足"不着急、可以关、可以转 Draft"的台阶;卡点从 `kinds` / `unresolvedCount` 翻译成人话):
  ```
  👋 你在 Cindy 提的 PR #<编号>（<标题>）好像停了一阵子——<一句话说清现在卡在哪，例：上次 review 提的几条意见还没动 / 有 N 条 conversation 还没 resolve / 分支和主干有了冲突>。
  不着急，就是来轻轻提醒一声，有空的时候看看就好；处理完也不用知会谁，下一轮 auto-review 会自动重新检查。
  另外如果你觉得这个 PR 不再需要了，直接关掉（Close）就行；还没做完想再放放的话，也可以先转成 Draft，之后就不会再收到这种提醒啦。
  PR：<url>
  ```
- 发送结果(发成 / 名录没找到 / 发失败)记下来,并入飞书汇总对应 PR 的行(措辞见「自动模式结束输出」)。发失败**不立即重试**——脚本按 `repeatHours` 的重复间隔天然兜底,下轮仍停滞会再次 `shouldRemind=true`。
- **仅 auto 模式做本节**;交互模式用户在场,要不要催人由用户在 3B 第 5 步自行拍板,不自动发。

**产品门讨论 issue 收尾 sweep(判定与去重已代码化)**:批处理收尾、发飞书汇总前,**跑一次 `node scripts/review-pr/close-product-issue.mjs --sweep`**——它扫描仓库里仍 open、由产品门流程自动创建的讨论 issue(按 issue footer 签名识别),其关联 PR 已经合并的(典型:白名单放行后有人直接在 GitHub 网页手动合并,没经过 3A)自动发一条「已随 PR 落地」的说明评论并关闭 issue。幂等由代码保证(issue 已关不再碰、说明评论只随真正关闭那次发),你只管每轮调一次、读 `results`:有 `closed=true` 的写进飞书汇总(见「自动模式结束输出」);`action=skip` 且 `prState=CLOSED`(PR 没合并就被关了)的,issue 去留由人定,汇总里提一句让 owner 看。**仅 auto 模式做本节**;交互模式合并时 3A 已定向关过,无需 sweep。

**跟进会话绑定收尾 sweep**:同一时机(批处理收尾、发飞书汇总前),跑一次 `node scripts/review-pr/fix-session-state.mjs sweep --open <本轮全部 open 候选号,逗号分隔>`——把绑定表里已不在 open 列表的 PR(已合并 / 已关闭)的跟进会话绑定清掉,防止残留绑定把新消息投进过期会话。返回的 `cleared` 非空时不用进汇总(纯内部状态清理)。⚠️ 前提:open 列表必须是全量——`--scan-all` 内部 `gh pr list --limit 100`,本轮 open 候选数(含 draft 前的原始列表)达到 100 时列表可能被截断,**跳过本轮 sweep**(误清会导致下轮对同一 PR 重复开新会话)。**仅 auto 模式做本节**。

**飞书通知汇总**:批处理结束后统一发一条飞书通知汇总所有处理结果——**格式与措辞规则以「自动模式结束输出」节为准**(「已合并」/「未合并」两组、每条一行带链接、原因用人话)。跳过原因的**判定依据**仍是 `context.json` 的 `auto.reason` / `gate` 字段(它已把 `gate.blockers` 拼成具体清单),但落到汇总行时必须按「自动模式结束输出」的对照表翻译成人话,不要把 `auto.reason` 原文直接抄进汇总。

### 自动模式结束输出(= 飞书通知内容)

Scheduler 配置了 `notify.feishu=true`,session 结束时 **最后一条 assistant 消息会自动通过飞书 bot 发给 owner**——skill 不需要手动调 feishu MCP。因此 auto 模式的**最后一条输出必须是下面格式的汇总文本**,这段文本就是 owner 在飞书里看到的内容。

**汇总格式(硬性)**:按结果分两组,**「已合并」在前、「未合并」在后**;某组为空则整组(含组标题)省略,不留空标题。组内每条一行、带序号;链接文本 = `PR #编号:标题`,链接指向 PR 页面(url 来自 `meta.url` / `pick.mjs` candidates 的 `url`)。**组标题下一行直接跟第一条,不空行**;**条目之间不空行**(飞书 markdown 每个 `N. ` 开头的列表项自成块,无需额外空行分隔)。

**未合并组的三种条目**(候选多时靠聚合控长度,不要一个 PR 一行刷几十行):
- **本轮实质处理过但没合上的**(审查打回 / 格式打回 / 合并时冲突等)→ **一 PR 一行**,链接文本 = `PR #编号:标题`,原因按下方对照表写。
- **跳过类 → 同原因+同作者聚合成一行**:一行 = 原因(含作者 GitHub 用户名)+ 该作者在该原因下的所有 PR 链接(链接文本短写成 `#编号`,顿号分隔)。同一原因下不同作者各占一行。
- **排队类(实质名额已满没轮到)→ 聚合成一行**:`本轮处理名额已满,排队下轮:[#N](url)、[#M](url)`。

**尾行统计(必加)**:两组之后空一行,加一行全局账目:`本轮扫描 <candidateCount> 个候选:合并 X · 打回 Y · 跳过 Z · 排队 W`(为 0 的项省略)。owner 靠这行知道积压还剩多少。

样例:

```markdown
**已合并**
1. [PR #518:修复远程会话侧栏浏览器打开链接卡死](https://github.com/xindong/cindy-moved/pull/518)
2. [PR #521:清理 lint 基线](https://github.com/xindong/cindy-moved/pull/521)

**未合并**
1. [PR #519:稳定 maker turn](https://github.com/xindong/cindy-moved/pull/519) — 审查发现问题,已打回给 yuhaobo 修改(问题:xxx;修好后下轮自动重审)
2. [PR #520:Linux 首版打包](https://github.com/xindong/cindy-moved/pull/520) — 代码没问题,但被仓库的必需检查设置卡住,合不进去。**需要你**去 PR 页面点 "Merge without waiting for requirements" 强制合并
3. 上次打回后 zhangsan 还没改,继续等:[#493](https://github.com/xindong/cindy-moved/pull/493)、[#498](https://github.com/xindong/cindy-moved/pull/498)
4. 上次打回后 lisi 还没改,继续等:[#499](https://github.com/xindong/cindy-moved/pull/499)
5. 等 wangwu 处理评审意见(已在 PR 上留言催了):[#522](https://github.com/xindong/cindy-moved/pull/522)、[#525](https://github.com/xindong/cindy-moved/pull/525)
6. 和主干有代码冲突,需要 zhangsan 解决后重新提交:[#523](https://github.com/xindong/cindy-moved/pull/523)
7. 本轮处理名额已满,排队下轮:[#526](https://github.com/xindong/cindy-moved/pull/526)、[#527](https://github.com/xindong/cindy-moved/pull/527)

本轮扫描 12 个候选:合并 2 · 打回 1 · 跳过 5 · 排队 2
```

**未合并组的原因措辞(硬性)**:一句话讲清「卡在哪 + 接下来谁动」。**禁用流程行话**——`mergeStateStatus` / `BLOCKED` / `DIRTY` / thread / resolve / 前置门 / `REQUEST_CHANGES` / `auto.reason` 原文这类词一律不得出现在汇总里;判定依据仍是 `auto.reason` / `gate` 字段,落笔时按下表翻译成人话。**需要 owner 动手的,用加粗「需要你」开头点明具体动作**;等别人的写清在等谁:

| 内部状态(判定依据) | 汇总行写法 |
|---|---|
| 审查未通过,已提交打回 review | 审查发现问题,已打回给 `<author>` 修改(括号带 1 句最关键的问题) |
| `pushback-format` 格式打回 | PR 标题 / 描述不合规(缺必填段落等,括号带最关键一条),已打回给 `<author>` 补 |
| `product-gate` 已执行 product-hold(首次) | 产品/UI 改动需先对齐,已开好讨论 [issue](issue 链接) 并告知 `<author>`,PR 转为草稿,飞书群里也发了通知(私聊 `<author>`:已发 / 没发成+原因)。**需要你**去 issue 里聊两句,同意推进就在 issue 里回一句(或在 PR 上点 Approve / 标回 ready),之后流程会自动把 PR 恢复 Ready 并继续审查 |
| `product-gate` 再次拦截(`alreadyHeld=true` 仍转了 draft) | `<author>` 把 PR 标回了 ready,但讨论 issue 里还没有白名单成员的明确同意,已再次转草稿(没重复评论)。**需要你**看下 [issue](issue 链接) 的讨论是不是卡住了——同意推进就去 issue 里回一句(或 Approve / 标回 ready),之后自动恢复 |
| `product-gate` issue 同意放行(含 `heldDraftResults` 自动放行) | 讨论 [issue](issue 链接) 已获 `<白名单成员>` 同意,已自动把 PR 恢复 Ready 并 <实际走向:进入审查 / 合并 / …>(该行并入实际走向的措辞,不单列也行) |
| `product-gate` issue 读取失败 | PR 之前因产品讨论转过草稿,这轮读不到讨论 [issue](issue 链接) 的评论(原因),没敢动它。**需要你**看一眼 issue 状态 |
| `product-gate` Slack 消息归属不了(`unattributedSlackComments` 内容像同意) | 讨论 [issue](issue 链接) 里有条 Slack 同步消息(发送者「<名字>」)看着像同意,但没能在名录里确认身份,没敢放行。**需要你**确认下这人是不是白名单,是就去 issue 里回一句或 Approve |
| `arch-gate` 已执行 product-hold --kind arch(首次) | 架构调整需先对齐技术方案,已开好讨论 [issue](issue 链接) 并告知 `<author>`,PR 转为草稿,已飞书私聊刘佳黎(架构门不发群;私聊 `<author>`:已发 / 没发成+原因)。**需要你**去 issue 里看下方案,同意推进就在 issue 里回一句(或 Approve / 标回 ready),之后流程会自动把 PR 恢复 Ready 并继续审查 |
| `arch-gate` 其它情形(再次拦截 / issue 同意放行 / issue 读取失败 / Slack 归属不了) | 措辞同上方 `product-gate` 对应行,把「产品/UI 改动」换成「架构调整」、把关人按技术白名单写 |
| `skip-gate`(有未 resolve thread) | 有 N 条评审意见 `<author>` 还没处理 + 催办情况(见下) |
| `skip-gate`(DIRTY 冲突) | 和主干有代码冲突,需要 `<author>` 解决后重新提交 |
| `skip-stale-pushback` | 上次打回后 `<author>` 还没改,继续等 + 停滞催办情况(见下) |
| `ci-pending` | CI 还在跑,下轮再看 |
| `ci-failed` | CI 没通过,需要 `<author>` 修 |
| `approve-workflows` 已放行 | 外部贡献 PR,已放行 CI,等 CI 跑完下轮再审 |
| `skip-workflow-ci-change` | 外部 PR 自己改了 CI 配置,不能自动放行。**需要你**看过 diff 后去 PR 页面手动 approve |
| `skip-structural-block` | 代码没问题,但被仓库的必需检查设置卡住。**需要你**去 PR 页面强制合并(Merge without waiting for requirements)或调整该检查设置 |
| self-approve 重审未过 | 上次打回的问题没有真正改掉(标了已解决但代码没动)。**需要你**人工看一下 |
| Server 发布通知 gate 打回 | 含 server 改动但 `<author>` 还没飞书通知你发布事项,已打回要求先通知(有新增环境变量时点名列出) |
| selfFix PR 首次投递(新开跟进会话) | 你的 PR 卡在 <卡点人话,例:审查发现 N 个问题 / 和主干冲突 / CI 没过>,已开了一个跟进会话自动修复,修完 push 后下轮自动重审 |
| selfFix PR 再次投递(jump 到已有会话) | 你的 PR 又有新卡点(<卡点人话>),已转给之前那个跟进会话继续修 |
| selfFix PR 指纹未变、本轮没投 | 你的 PR 还卡着(<卡点人话>),跟进会话应该还在修,本轮没重复打扰 |
| selfFix PR 投递失败(handoff 不可用 / 会话拉不起来) | 你的 PR 卡在 <卡点人话>,想让跟进会话去修但没投出去(<原因一句话>),**需要你**自己看下或等下轮重试 |

表中 `<author>` 替换为该 PR 的实际作者 GitHub 用户名(来自 `pick.mjs` candidates 的 `author` 字段),例如"已打回给 yuhaobo 补"。

催办情况的措辞按 `notify-author-resolve.mjs` 返回值:`posted=true` → 「已在 PR 上留言催了,等 `<author>` 回应」;`already-commented` → 「之前催过,还在等 `<author>`」;`comment-failed` → 「催办留言没发出去,下轮会重试」。

停滞催办情况的措辞按 `remind-stale-author.mjs` + 飞书发送结果,追加到对应 PR 所在的汇总行末尾(适用打回未改 / 意见未处理 / 冲突三类):发成了 → 「已停 N 天,飞书提醒过 `<author>` 了」;名录没找到 → 「停了 N 天想飞书提醒,但名录里没找到他」;名录读不到 → 「停了 N 天想飞书提醒,但名录读不到」;发失败 → 「飞书提醒没发出去,下轮会再试」;`shouldRemind=false` → 不追加。

self-approve 解死锁的 PR 重审通过并合并时,「已合并」行末尾括号注明「(重审通过,已撤回之前的打回)」。

产品门讨论 issue 的收尾情况(来自 3A 定向关闭 + 收尾 sweep 的 `close-product-issue.mjs` 返回值):本轮定向关掉的,在「已合并」对应 PR 行末带一句「产品讨论 issue 已自动关闭」;sweep 补关到的(PR 是别人在网页上合的、不在本轮两组里),在尾行统计前单独加一行「顺手关闭了 N 个已落地的产品讨论 issue:[#a](issue url)、[#b](issue url)」;sweep 发现 `prState=CLOSED`(PR 没合并就被关了)的,加一行让 owner 决定对应 issue 去留;都没有就不提。

合并后 main 健康检查(阶段 3 第 5 步,仅本轮合并 ≥2 个时跑)`pass=false` 的,在尾行统计前加一行:`⚠️ 本轮合并后 main 的 TypeScript 检查未通过(<errors 里最关键的一条,人话转述>)——可能是本轮多个 PR 之间的语义冲突,**需要你**尽快看一眼`。`pass=true` / 脚本自身失败 / 没跑到本步的,都不提。

**特殊轮次(不走两组格式)**:
- **candidates 为空** → 一行:`当前没有待处理的 open PR`
- **异常(gh 未登录 / working tree 脏 / 脚本失败)** → 一行:`⚠️ 自动 review 执行异常:<一句话原因>,请检查`
- **有候选但全部跳过** → 照常输出「未合并」组(按聚合规则列,owner 要知道每类卡在哪)+ 尾行统计,只是没有「已合并」组

输出汇总后再进最终清理章节(清理章节会调 `cleanup.mjs`,锁随之释放;若本轮主工作树根本没 checkout 过且没合并任何 PR、cleanup 不需要 git 操作,**仍要至少调一次 `release-lock.mjs`** 把锁释放掉;合并过 ≥1 个则跑 `cleanup.mjs --original <分支> --sync-main` 同步主干顺带释放锁)。

### 互斥锁

`prepare.mjs` 输出 `lock` 字段:
- `lock.acquired=true` → 成功拿到锁,正常继续
- `lock.acquired=false` → 另一个实例可能还在跑(锁获取至今 < 60 分钟),**直接结束**(auto 模式静默退出;交互模式告诉用户"另一个 review-pr 正在执行,请稍后再试")。**这种情况不要调 `release-lock.mjs`**——锁不是你的,不能释放别人的。
- 锁文件内容:`{startedAt}` JSON。stale 判定:**纯 60 分钟 TTL**(不做 PID 存活判定——锁的真实持有者是上层 agent 进程,脚本拿不到它的 PID,写脚本自身 PID 只会让锁形同虚设);超时或内容损坏解析不出时间的,下次运行自动清。

**释放锁的两条路径(任选其一,不能两条都不走)**:
- **正常清理路径**:走 `cleanup.mjs`,它会在末尾自动释放锁(已含逻辑)。
- **早退 / 异常路径**:`pick.mjs` 没 PR、auto 模式 prepare-fail(gh 未登录 / 脏 working tree)、候选全跳后异常、模型主动放弃任务等——只要**已经成功拿到过锁**(`lock.acquired=true` 那次),结束前都必须显式调一次 `node scripts/review-pr/release-lock.mjs`(脚本幂等,不存在锁文件也安全)。

**硬性约束**:auto 模式在最终输出汇总文本之前 / 交互模式给用户最后一句话之前,**必须**先释放锁(走 cleanup 或 release-lock 二选一)。漏调 = 下一轮 scheduler 触发会被你自己卡住、等满 60 分钟 TTL 才能跑。

### 空转预检(scheduler pre-run hook,skill 外围)

scheduler 每轮触发前先跑 `scripts/review-pr/pre-check.mjs`(preRunHook 协议:exit 2 = 本轮不创建会话、零 token;exit 0 = 放行;其它退出码 / 超时 → fail-open 放行)。它只在「确定没活」时 skip,共三条判据:① 互斥锁被占;② 仓库一个 open PR 都没有(**只剩 draft 不算没活**——被产品/架构门 hold 的 PR 就是 draft,得靠判据 ③ 决定);③ **空转指纹一致**——上轮 auto 扫描结论是「全 skip」,且当前 open PR 集合的状态(head commit / CI 聚合态 / 未 resolve 数 / 冲突态 / draft 态 / reviewDecision)与上轮 `--scan-all` 落盘的 `.last-scan.json` 指纹逐字节一致,**且落盘的 heldIssues(被 hold PR 的讨论 issue)逐条 updatedAt 未变**(白名单同意留言只动 issue、不动 PR 状态,不显式比对会把「同意 → 自动放行」饿死);另有 **6 小时强制心跳**(state 超龄一律放行),保证停滞催办(≥24h 阈值)、产品 issue sweep 这些**时间驱动**的动作不会因「PR 状态一直没变」而饿死,同时兜底「会话在扫描落盘后、放行动作前挂掉」的极端窗口。预检**只比对指纹、绝不重演 auto 分流判定**——判定逻辑单一来源在 `context.mjs`,双份维护漂移会导致「该审的被 hook 永久拦掉」;指纹误敏感的最坏结果只是多跑一轮 session(方向安全)。

对 skill 流程的影响:**零**——会话真被创建时 pick / prepare / scan 照旧执行,预检只省掉「起一个会话才发现没活」的空转成本;skill 侧唯一的配合点是阶段 1 用 `--scan-all`(指纹由它落盘)。建议 schedule 的 preRunHook 配置显式 `timeoutMs`(如 60000)——宿主协议「未配置 = 不限时」,超时兜底可防 hook 意外挂死阻塞该轮触发(超时 = 放行,不会漏审)。

### 自动模式检测

从 `$ARGUMENTS` 里检测 `--auto`:
- 含 `--auto` → 进入自动模式,不解析 PR 号(一定走 `pick.mjs`),全程按上表行为
- 不含 `--auto` → 正常交互模式,PR 号从参数提取(没有时仍走 `pick.mjs` 但后续会有用户确认 gate)

## 工具与鉴权(全流程通用)

- **GitHub 调用一律 `gh` CLI 为主、`curl` 兜底**:gh 自动处理鉴权 / 分页 / API 版本;只有 gh 不可用时才用 curl。
- **鉴权统一走 gh**:开工前 `gh auth status` 必须已登录;curl 兜底时用 `$(gh auth token)` 动态取 token,**不要依赖 `GITHUB_TOKEN` 环境变量**(本项目登录态由 gh 管理、token 存系统凭据)。
- curl 统一三个 header:`-H "Authorization: Bearer $(gh auth token)" -H "Accept: application/vnd.github+json" -H "X-GitHub-Api-Version: 2022-11-28"`。
- GitHub REST 路径直接 `/repos/<OWNER>/<REPO>/...`,**不需要 URL-encode**(与 GitLab 的 `%2F` 不同)。
- **绝不把 token echo 到任何输出 / 日志**;`gh auth token` 只在管道里用,不打印。

## 确定性步骤一律走脚本(scripts/review-pr/)

> **为什么**:本 skill 里"采集数据 + 客观判定 + 无脑 git 动作"这些确定性的事(对应 agent 约束「优先用代码保证确定性」)已抽成 Node 脚本,跑出结构化 JSON。**这些步骤一律调脚本拿结果,不要再自己手敲 gh / grep / git 重复做**——脚本保证判定确定、可复现。脚本没覆盖的(完整 diff、语义判断、代码审查、给作者的文字、合并 / 提交 review / 发评论 / 飞书这些破坏性写操作)才由你 / 子 agent / 原命令处理。

所有脚本在**仓库根**跑,输出 JSON 到 stdout(失败输出 `{ok:false,error}` 并 exit 1),鉴权走 gh、无需传 token。

| 脚本 | 命令 | 覆盖步骤 | 关键输出字段 |
|---|---|---|---|
| `pick.mjs` | `node scripts/review-pr/pick.mjs` | 输入解析(未传 PR 时自动选取) | `picked`(最早创建的可处理 PR,null=无活)/ `candidateCount` / `draftSkipped` / `candidates`(升序全量) |
| `prepare.mjs` | `node scripts/review-pr/prepare.mjs` | 环境准备 | `repo` / `ghAuth` / `worktreeClean` / `dirtyFiles` / `currentBranch` / `defaultBranch` |
| `context.mjs` | `node scripts/review-pr/context.mjs <PR> [--scan]`;批量 `--scan-all` | 1.1 / 1.1.5 / 1.2 / 1.3 / 1.5 / 1.6.5;`--scan-all` 覆盖 auto 阶段 1 整段扫描 | 全量:`meta`(含 body)/ `files` / `totalDiffLines` / `format`(格式硬判定)/ `productGate`(产品/UI 门确定性判定:白名单·放行信号·UI 路径命中·讨论 issue 白名单留言 `discussionIssue`)/ `archGate`(技术架构门确定性判定:技术白名单·触发器 `triggers`·`coreFilePaths`·`discussionIssue`,消费规则与 productGate 同构,`null`=未启用)/ `history`(comments·reviewThreads·commits)/ `gate`(前置门判定,含 `blockClass`·`structuralBlock`·`ciRuns`·`workflowsAwaitingApproval`·`prTouchesCiFiles`)/ `auto`(auto 模式分流:`action`·`isSkip`·`fallback`)。**`--scan`(单 PR 精简)**:判定照算但只输出决策最小集(meta 短字段 / `filePaths` / `format.formatPass`·`formatIssues` / `gate.gatePass`·`blockClass`·`blockers`·`unresolvedThreadCount` / `productGate` / `archGate` / `auto`),无 body / 历史全文。**`--scan-all`(批量,auto 阶段 1 用)**:不传 PR 号,内部并行对全部 open 非 draft 候选跑 `--scan`(同一份判定代码),输出 `candidates` / `results[]`(每条 = 单 PR `--scan` 输出,失败条 `ok:false`)/ `heldDraftResults[]`(被 product-hold 转 draft 的 PR 的 `--scan` 输出,`held` 字段非空,供「被 hold 的 draft:自动放行判定」消费)/ `scanFailures` / `scanState`,并落盘空转指纹 `.last-scan.json`(含 heldIssues 的 issue updatedAt,供 scheduler 预检,见「空转预检」) |
| `checkout.mjs` | `node scripts/review-pr/checkout.mjs <PR>` | 1.4 | `branch`(=`pr-<PR>`)/ `matched` |
| `approve-workflows.mjs` | `node scripts/review-pr/approve-workflows.mjs <PR> [--dry-run] [--allow-ci-changes]` | 「Workflow 待批准门」:放行 fork PR 等待批准才能跑的 GitHub Actions | `awaitingRuns`(待批 run 清单)/ `count` / `touchesCiFiles`·`ciFiles` / `approved` / `failed` / `refused`(改了 CI 配置且没加 `--allow-ci-changes` 时拒批;exit 2)/ `probeError` |
| `notify-author-resolve.mjs` | `node scripts/review-pr/notify-author-resolve.mjs <PR...> [--dry-run]` | 候选批处理:skip-gate 因未 resolve thread 时催作者 | `posted`(是否本轮新发评论)/ `reason`(`already-commented`·`comment-failed`·`no-unresolved-threads`·`dry-run`)/ `author`(auto only;按指纹去重,只对未 resolve thread 集合变化时发)。多个 PR 号 = 批量模式(内部串行跑单 PR 逻辑),输出 `{batch:true, results:[…]}` |
| `remind-stale-author.mjs` | `node scripts/review-pr/remind-stale-author.mjs <PR...> [--dry-run]` | 「停滞飞书催办」判定:PR 卡作者侧(打回没改 / thread 没 resolve / 冲突)且作者 ≥24h 无动作时提示发飞书提醒 | `shouldRemind` / `reason`(`stale`·`not-stale-yet`·`recently-reminded`·`not-blocked-on-author`·`own-pr`·`draft`·`pr-not-open`)/ `kinds`(`changes-requested`·`unresolved-threads`·`conflict`)/ `unresolvedCount` / `idleHours`·`idleDays` / `author`·`title`·`url`(阈值与重复间隔读 `pr-rules.json` `staleAuthorReminder`;`shouldRemind=true` 当场记状态去重,飞书身份映射与发送由主 agent 走 `resolve-author-feishu.mjs` + 飞书工具)。多个 PR 号 = 批量模式(内部串行跑单 PR 逻辑),输出 `{batch:true, results:[…]}` |
| `product-hold.mjs` | `node scripts/review-pr/product-hold.mjs <PR> [--payload-file <path\|->] [--kind arch] [--dry-run]` | 「产品 / UI 变更门」与「技术架构变更门」共用的拦截动作:自动开讨论 issue + 评论告知作者(带 issue 链接)+ 转 draft;`--kind arch` = 架构门(marker 带 kind=arch、footer 换技术措辞,机制与去重同款) | `kind` / `held` / `issueUrl`·`issueCreated`·`issueError`(issue 开失败则本轮不评论,下轮自动重试;`issueCreated=true` 同时是「飞书通知」的去重锚点)/ `commented` / `alreadyHeld`(按隐藏标记去重,已拦截过绝不重复开 issue / 重发评论,标记里存着当时的 issue 链接)/ `drafted` / `wasDraft` / `commentError`·`draftError` / `reason`(`pr-not-open`·`missing-payload`);文案由主 agent 拟好、经 `--payload-file -` 从 stdin 传 JSON `{issueTitle, issueBody, commentBody}`(commentBody 用 `{{ISSUE_URL}}` 占位;issue 回链 PR 的 footer 由脚本自动追加) |
| `product-release.mjs` | `node scripts/review-pr/product-release.mjs <PR> [--payload-file <path\|->] [--dry-run]` | 「产品 / UI 变更门」「技术架构变更门」的自动放行动作(与 product-hold 互为镜像):issue 里白名单同意后把被 hold 的 draft PR 标回 Ready + 评论告知(**作者无需任何操作**);只放行带 hold 标记的 PR,作者自己转的 draft 一律拒绝 | `released` / `readied`·`alreadyReady`·`readyError` / `commented`·`alreadyCommented`(按放行标记 + issue 链接去重,重跑不刷屏)·`commentError` / `kind`·`issueUrl` / `reason`(`pr-not-open`·`not-held-by-flow`);文案经 `--payload-file -` 传 `{commentBody}`(`{{ISSUE_URL}}` 占位),缺文案照样放行、只是不评论 |
| `close-product-issue.mjs` | `node scripts/review-pr/close-product-issue.mjs <PR> [--dry-run]`;兜底 `--sweep [--dry-run]` | 「产品 / UI 变更门」收尾:PR 真正合并后自动关闭当初 product-hold 开的讨论 issue(定向:3A / bypass 合并成功后调;`--sweep`:auto 每轮收尾扫一次,补关"网页手动合并没走 3A"的场景) | 定向:`closed` / `alreadyClosed` / `reason`(`pr-not-merged`·`no-product-gate-marker`·`issue-url-unparsable`)/ `issueUrl`·`issueNumber` / `closeError`;sweep:`scannedOpenIssues` / `matched` / `closedCount` / `results[]`(每条 `action`=`close`·`skip`·`error` + `prState`)——幂等,issue 已关不重复动作,关闭评论只随真正关闭那次发 |
| `resolve-author-feishu.mjs` | `node scripts/review-pr/resolve-author-feishu.mjs <PR>` | 「产品 / UI 变更门」飞书私聊前置:用 PR 作者 GitHub 账号(主键)/ commits git 邮箱(辅助)在 org 名录 README(`pr-rules.json` `feishuNotify.orgMappingRepos`)里查飞书映射;名录=本地 clone(`~/.cindy/org-rosters/`,自动 pull / 首次 SSH clone / 30s 超时 / 拉失败用现存副本,gh api 兜底) | `found` / `authorLogin` / `matched[]`(`{matchedBy, email, repo, parsed, line}`——`parsed` 是脚本按名录表格式解析的 `{githubLogin, name, email}`,优先消费;`parsed=null` 才读 `line` 原文;`matchedBy=github-login` 优先采信)/ `emails` / `rostersFetched[].source` / `fetchErrors`(名录读不到——群消息措辞与「名录里没这人」要区分) |
| `pre-merge-check.mjs` | `node scripts/review-pr/pre-merge-check.mjs <PR>` | 3A 合并前复核 | `state` / `mergeable` / `mergeStateStatus` / `reviewDecision` / `unresolvedThreads` / `blockers` / `blockClass` / `structuralBlock` / `structuralBypassAvailable`(结构性门 + 可 bypass → 3A 可经用户确认走 admin bypass)/ `canMerge`(exit 0=可合 / 2=有阻碍)|
| `typecheck-merged.mjs` | `node scripts/review-pr/typecheck-merged.mjs [<PR>] [--current]` | 语义合并冲突拦截:默认 trial merge(`merge origin/main --no-commit` 后对合并结果 `tsc --noEmit`,自动还原工作树)——交互模式 3A 合并前用;`--current` 不动 git、直接对当前工作树 typecheck——auto 批处理收尾「合并后 main 健康检查」用(阶段 3 第 5 步) | `mode`(`trial-merge`·`current`)/ `pass` / `mergeConflict` / `errors[]`(≤30 条)/ `totalErrors`;`ok:false` = 脚本自身跑不了(如 node_modules 未装),消费方按 fail-open 跳过 |
| `self-approve.mjs` | `node scripts/review-pr/self-approve.mjs <PR> [--dry-run]` | 3A 第 0 步:auto 自解死锁,同身份覆盖自己的 CR 解锁 | `approved`(是否真提交 APPROVE)/ `reason`(拒绝原因)/ `viewer`(exit 0=已 approve / 2=前置不满足拒绝);**脚本自带安全核验**(BLOCKED + reviewDecision=CHANGES_REQUESTED + 所有 CR 都是 viewer 自己的 + 0 未 resolve thread),掺别人的 CR / 有未 resolve thread 一律拒绝 |
| `cleanup.mjs` | `node scripts/review-pr/cleanup.mjs --original <分支> [--pr <PR>] [--sync-main]` | 清理 + 3A 同步主干 | `currentBranch` / `clean` / `deletedBranch` / `mainSynced` / `lockReleased` |
| `release-lock.mjs` | `node scripts/review-pr/release-lock.mjs` | 早退 / 异常路径释放锁(幂等) | `released` / `alreadyAbsent` |

**`context.mjs` 是主力**:1.1~1.6.5 的确定数据全在它一次输出的 JSON 里——**交互模式(单 PR)整个流程只跑一次全量、后续各步从同一份 JSON(下称 `context.json`)读字段**,不要重复跑。auto 批处理另有分工:主 agent 对每个候选跑一次 `--scan` 精简版(阶段 1),全量版只在两处出现——审查子 agent 在自己 worktree 里对自己的 PR 跑一次、主 agent 对要写打回文案的 `pushback-format` 候选跑一次;主 session 不拉其它 PR 的全量 JSON。两个判定布尔最关键:
- `format.formatPass=false` → 一定不合规(走 3B);`true` 仍需你判**段落是否实质**、**title 语言(关 3)**(脚本只做硬判定,这两项是语义活)。
- `gate.gatePass=false` → 前置门未过(1.7 卡 gate);`gate.softFlags` 里的 **bot 评论 / 疑似打回**由你读 `gate.botComments` / `gate.reviewerPushbacks` 内容定性,别无脑放行。
- `gate.blockClass`(BLOCKED 成因分档,**用 `meta.reviewDecision` 权威信号 + workflow run 分类判,不再凭历史 CR 是否出现过**):`conflict` / `workflow-awaiting`(fork 待批 CI)/ `review-changes-requested`(reviewDecision=CHANGES_REQUESTED,真要作者改)/ `self-resolvable`(仅 viewer 自己挂的 CR、thread 全 resolve)/ `awaiting-approval`(缺 approve,审查通过后提交 APPROVE 即解)/ `threads-unresolved` / `ci-failed`(workflow 真失败)/ `ci-pending`(还在跑)/ `structural-check`(见下)。
- `gate.structuralBlock`(**仅 `blockClass=structural-check` 时非空**):review + 已跑 CI 都过、仍 BLOCKED——卡在**永不上报结果的必需检查门**(典型 org ruleset 的 `code_scanning`(CodeQL)/`code_quality`,本仓库根本没产出对应结果;或被 job 级 `if` 跳过的必需 check)。结构是 `{requiredCheckRules, canBypass, rulesetIds}`,`canBypass=always`/`pull_requests` 表示当前账号可 admin bypass。这类**不是作者要改**——owner 用 admin bypass 合,或修该门让它能上报结果(详见「结构性 BLOCKED 门」节)。`gate.ciRuns`(仅 BLOCKED 时查,`null`=未知):`{failed,pending,awaiting,all}`,workflow run 分类的原始数据。
- `gate.workflowsAwaitingApproval`(=`gate.ciRuns.awaiting`,**仅 BLOCKED 时查**,`null`=未知/查不到、`[]`=无、非空=有待批 workflow):fork PR 等待批准才能跑的 GitHub Actions(详见「Workflow 待批准门」节)。非空说明 BLOCKED 的根因是 CI 没跑、需 approve 放行——这与 `gate.blockedAwaitingApproval`(缺 reviewer approval)是两个不同的 BLOCKED 来源,别混。`gate.prTouchesCiFiles=true` 时不可随手 approve(会执行被改过的 CI)。
- `productGate`:产品/UI 门的确定性部分——`exempt`(作者在白名单 / 白名单成员在 PR 上点过 Approve(`whitelistApprovals`)/ 白名单成员把 PR 标回 ready,任一即豁免)、`needsProductCheck`(未豁免且 feat 类型或命中 `uiPaths`,= 需要语义判断)、`discussionIssue`(被 hold 过的 PR 才有:当初开的讨论 issue 及其中白名单成员留言原文 `whitelistComments`——含本人直接评论与 Slack 同步 bot 代发经名录归属的条目(`via: 'slack-sync'`,同等采信);`unattributedSlackComments` = 归属不了发送者的同步消息,不得当白名单同意;`whitelistComments=null` 带 `error` = issue 读不到,**不得当「无同意」处理**)、`uiFiles` / `whitelistReviews`(全量信息位,含非 APPROVED)/ `latestReadyBy`。**两项语义活由你按「产品 / UI 变更门」的口径判:① `discussionIssue` 白名单留言是否明确同意推进(同意=视同放行);② 是否真属产品/UI 修改**,脚本只给触发器、豁免信号与留言原料。顶层 `held` 字段(非空 = 该 PR 被 hold 过,含 `kind` / `issueUrl` / `heldDraft`):`heldDraft=true` 且判出同意(或 `exempt=true`)→ 先跑 `product-release.mjs` 把 PR 自动标回 Ready 再继续,作者无需操作。
- `archGate`(`null`=未启用):技术架构门的确定性部分——结构与消费规则和 `productGate` 完全同构(`exempt` / `needsArchCheck` / `discussionIssue` 按技术白名单过滤),差异只有触发器(`triggers`:核心路径改动量 / refactor 大 diff / 超大 diff,附 `coreFilePaths` / `coreDiffLines`)与语义定性口径(「是否真属较大架构调整」),详见「技术架构变更门」。产品门优先,两门不会同时进 `auto.action`。
- `auto.action` / `auto.isSkip` / `auto.fallback`(**仅 auto 模式**):候选批处理的「跳过 vs 处理」走向已代码化,直接读字段、不要自己推(见「候选批处理」节);`fallback` 仅 `action=product-gate` 时非空,存被产品门包裹前的原走向。交互模式忽略本字段、仍走用户拍板。
- 完整 diff 脚本不输出(太大),需要时仍 `gh pr diff <PR> --repo <owner>/<repo>`。

下面各步骤里标「→ ...」的指向行就是讲该步走哪个脚本 / 读哪些字段;原命令块降级为**脚本内部等价逻辑 / 兜底**(脚本不可用时才手敲)。

## 输入解析

- 用户传入参数(`$ARGUMENTS`)可能形如 `#123`、`123`、`PR #456`、纯文本带数字。提取其中的纯数字作为 PR_NUMBER。
- **没拿到数字时,不要问用户、也不要瞎猜——自动选取「最早创建且可处理」的 PR**:
  > → 跑 `node scripts/review-pr/pick.mjs`,读 `picked`。确定性选取在脚本里做:「可处理」= `state=open` 且非 draft(脚本拉全量 open PR、过滤 draft、按 `createdAt` 升序取最早);**不**在选取阶段滤掉格式不合规 / 有冲突 / 有未 resolve thread 的 PR——那些正是本流程要处理的对象(交给后续 1.2 格式门 / 1.6.5 前置门处理)。
  - `picked` 非空 → 取 `picked.number` 作为 PR_NUMBER,并先用一句话告诉用户:**"未指定 PR,自动选了最早提交的可处理 PR #<number>(<title>,作者 <author>,创建于 <createdAt>);当前共 <candidateCount> 个待处理 open PR。"** 然后**直接进入下面的正常流程**——无需额外确认,步骤 1.7 还有"是否继续审查"的用户拍板 gate,在那之前全是只读操作,不会有任何破坏性动作。
  - `picked` 为空(`candidateCount=0`)→ **必须明确告诉用户**:交互模式说"当前没有可处理的 open PR(已跳过 <draftSkipped> 个 draft)";auto 模式输出 `当前没有待处理的 open PR(已跳过 <draftSkipped> 个 draft)`(scheduler 飞书会自动发给 owner)。`pick.mjs` 在 `prepare.mjs` 之前跑、本路径**没拿过锁**,无需调 release-lock,直接**结束本次任务**,不要硬找。
  - 脚本返回 `ok:false`(典型:gh 未登录)→ 按「环境与上下文准备」一节处理 gh 登录(`gh auth login`)后重试,不要绕开。
- 把 PR_NUMBER 暂存为本次任务的核心变量。

## 环境与上下文准备(全部在仓库根执行)

> → 跑 `node scripts/review-pr/prepare.mjs`,读 `lock` / `repo` / `ghAuth` / `worktreeClean`(脏看 `dirtyFiles`)/ `currentBranch` / `defaultBranch`,按字段决策:
> - **`lock.acquired=false`** → 另一个实例在跑。交互模式:告诉用户"另一个 review-pr 正在执行(锁获取于 <lock.holder>),请稍后再试"→ 结束。Auto 模式:静默结束。**都不进清理章节**(没拿到锁就不能释放别人的锁)。
> - 未登录 → 让用户 `gh auth login`(auto 模式:输出异常汇总后结束,scheduler 自动飞书通知 owner)
> - 脏 working tree → 提示用户处理,不自动 stash(auto 模式:同上)
> - `currentBranch` 记下来,清理章节要回到这里
>
> 下面 4 条是脚本内部等价逻辑(兜底)。

1. 读 `git remote get-url origin` 解析出 GitHub 项目坐标,例如 `git@github.com:xindong/cindy-moved.git` → `OWNER=xindong`、`REPO=cindy-moved`(去掉域名前缀和 `.git` 后缀,按 `/` 拆)。
2. 校验 gh 已登录:`gh auth status`。未登录直接告诉用户:"gh 未登录,请先 `gh auth login`(没装 gh 先 `winget install GitHub.cli`)",然后终止。
3. 确认当前 working tree 干净(`git status --porcelain` 为空),脏就先提示用户处理,不要自动 stash。
4. 记下当前分支名(`git rev-parse --abbrev-ref HEAD`),完成后要回到这里。

## 步骤 1:拉取 PR 并理解功能

### 1.1 拉 PR 元数据

> → 元数据来自 `context.json` 的 `meta`:跑一次 `node scripts/review-pr/context.mjs <PR_NUMBER>`,**整个流程只跑这一次**,1.2 / 1.3 / 1.5 / 1.6.5 都复用同一份 JSON。先看 `meta.state` / `meta.mergedAt` 校验(下面)。下面命令块是脚本内部等价逻辑(兜底)。

```bash
# 主:gh
gh pr view <PR_NUMBER> --repo <OWNER>/<REPO> \
  --json number,title,body,state,headRefName,baseRefName,author,url,mergeable,mergeStateStatus,isDraft,mergedAt,labels
# 兜底:curl
curl -sS -H "Authorization: Bearer $(gh auth token)" -H "Accept: application/vnd.github+json" -H "X-GitHub-Api-Version: 2022-11-28" \
  "https://api.github.com/repos/<OWNER>/<REPO>/pulls/<PR_NUMBER>"
```

从返回拿(括号内为 curl REST 对应字段):`title`、`body`(= description)、`state`(`open`/`closed`)、`mergedAt`(非 null = 已合并)、`headRefName`(`head.ref`,源分支)、`baseRefName`(`base.ref`,目标分支)、`author.login`(`user.login`,作者)、`url`(`html_url`,PR 链接)、`mergeable`(**可能为 `null` = GitHub 还在算冲突,要容错**)、`mergeStateStatus`(`CLEAN`/`BLOCKED`/`DIRTY`/`UNKNOWN`,REST 对应 `mergeable_state`)、`isDraft`(`draft`)。

**先校验 state**:GitHub PR 的 state 只有 `open`/`closed`;若 `state=closed` 或 `mergedAt` 非空(已合并 / 已关闭),告诉用户并询问是否继续(通常没必要继续)。

### 1.1.5 产品 / UI 变更门(第零道门,先于格式门)

> **产品门通过后再看技术架构门**:读 `context.json` 的 `archGate`(`null`=功能未启用)。`needsArchCheck=true` → 按「技术架构变更门」章节处理(判定与处置和产品门同构,交互模式同样用户拍板);`exempt=true` 或未触发 → 一句话带过,继续 1.2。产品门命中时架构门自动让位(`auto.action` 只会给 `product-gate`),无需两道一起走。
>
> → 读 `context.json` 的 `productGate`。`exempt=true` 或 `needsProductCheck=false` → 本门通过,一句话带过("作者在白名单" / "白名单已在 PR 上 Approve" / "白名单已标回 ready" / "非产品/UI 类改动"),继续 1.2。`needsProductCheck=true` → 按「产品 / UI 变更门」章节做语义判断与处置,顺序:① `discussionIssue.whitelistComments` 非空时先判白名单留言是否已**明确同意推进**——同意 → 视同放行,报告一句(谁在 issue 里同意的)后回 1.2 继续;`whitelistComments=null`(issue 读取失败)→ 如实报告让用户看,不 hold 不放行;② 未同意 / 无讨论 issue → 语义定性:定性为 **bugfix / 已有功能补充** → 回到 1.2 正常继续;定性为**产品/UI 修改** → 交互模式向用户报告并 AskUserQuestion 拍板(拦截 / 仍继续审 / 放弃),auto 模式直接执行 product-hold。**这道门在格式门之前**——要先对齐产品方向的 PR,没必要先纠格式。

### 1.2 PR 格式合规性检测(第一道门,不通过直接走打回流程)

> → 格式硬判定来自 `context.json` 的 `format`(`titleTypeOk` / `titleVague` / `missingSections` / `checklist` / `redlinePaths` / `formatPass` / `formatIssues`)。**`formatPass=false` 直接判不合规、走 3B**(`formatIssues` 就是问题清单来源);`formatPass=true` 你再判**段落是否实质**(不是「无」/「见代码」/ 只堆名词)和 **title 语言(关 3,整句英文不合规)**——这两项脚本不判。下面 1.2.1~1.2.4 是判定口径说明(脚本已实现,命令块仅兜底)。

> **目的**:在拉 diff / 拉分支 / 拉历史这些重型动作之前,先校验 title 和 description 是否合规。**校验基准是仓库根 `.github/PULL_REQUEST_TEMPLATE.md`(本仓统一三节制:这次改了什么 / 怎么验证的 / 风险)——以该文件现行内容为准,本 skill 不内嵌规范副本**。格式不合规直接判不能合,跳过下面所有步骤,进入 **步骤 3B 起草打回评论**。
>
> **执行原则(对应 agent 约束「优先用代码保证确定性」:能用代码确定的判断就用代码)**:下面 1.2.1~1.2.4 的"硬判定"用 shell 命令跑出确定结果(type 前缀是否命中白名单、必填段落标题在不在、updater/migration 路径命中),**不靠"感觉"判断**;只有"段落内容是否实质"这类语义判断才由你读。

执行前先把 1.1 拿到的值放进环境变量,后续命令直接用:

```bash
TITLE=$(gh pr view <PR_NUMBER> --repo <OWNER>/<REPO> --json title --jq .title)
BODY=$(gh pr view <PR_NUMBER> --repo <OWNER>/<REPO> --json body --jq .body)
FILES=$(gh pr view <PR_NUMBER> --repo <OWNER>/<REPO> --json files --jq '.files[].path')
```

#### 1.2.1 Title 校验(硬判定)

- **关 1:type 前缀在白名单内** — 走 `context.json` 的 `format.titleTypeOk`(脚本读 `pr-rules.json` 的 `titleTypes` 构造正则,type 白名单只此一处)。脚本不可用时,直接读 `agent-use/docs/pr-rules.json` 的 `titleTypes` 现行白名单人工核,**不要在本 skill 里另存一份白名单**。
- **关 2:含糊词黑名单**(本 skill 执行细则,非 `.github/PULL_REQUEST_TEMPLATE.md` 原文):走 `format.titleVague`。脚本不可用时的兜底命令:

```bash
echo "$TITLE" | grep -qiE ': *(bug|update|improve|fix issue|优化|调整|更新|misc|若干|一些) *$' \
  && echo "FAIL 含糊词" || echo "PASS 含糊词"
```

- **关 3(语言,语义判断)**:除技术术语 / 专有名词 / type / scope 外应为中文;整句英文(纯技术 commit 如 `chore: bump deps` 例外)算不合规——这条你读 title 判断。

任一关 FAIL 即判 **不合规**。

#### 1.2.2 Description 校验

**先按 type 分档**(type 来自 1.2.1,走脚本 `format.template`):轻档 type(`light`)只要求 1-2 句实质动机(不可为空 / `见 commit` / `略` / `TODO`);重档(`feature` / `bugfix`)必须按 `.github/PULL_REQUEST_TEMPLATE.md` 模板填全(本仓 feature / bugfix 共用同一套三节)。轻档 type 清单由 `pr-rules.json` 的 `lightTypes` 决定,不在本 skill 另存。

**段落存在性(硬判定)**:走 `context.json` 的 `format.missingSections`(脚本按 `pr-rules.json` 的 `featureSections` / `bugfixSections` 判,必填段落清单只此一处)。脚本不可用时,`Read` `.github/PULL_REQUEST_TEMPLATE.md` 拿现行段落标题清单逐个 grep `$BODY`,**不要在本 skill 里另存一份段落清单**。

- 段落**存在性**由脚本判;段落**内容是否实质**(不是 "无" / "见代码" / 只堆技术名词 / "测试路径"只写"已测试")由你读 `$BODY` 判断——这是该交给 LLM 的语义活。

#### 1.2.3 Self-review checklist 校验(硬判定,仅作者自带 checklist 时生效)

**本仓 PR 模板不含 Self-review Checklist 段——没有 checklist 不算不合规**。但作者**自发**写了 `## Self-review …` 段时,勾选率仍要校验(勾不满说明自检没做完就提了)。判定范围**只限 self-review 标题到下一个标题之间的段内复选框**——description 别处的普通 TODO 清单(如「后续拆 issue」)不计入,避免误伤:

```bash
# 取 self-review 段(无该标题则本节直接跳过),只在段内数复选框
SECTION=$(echo "$BODY" | awk 'tolower($0) ~ /^#+ *self-review/{f=1;next} f && /^#/{exit} f')
TOTAL=$(echo "$SECTION" | grep -cE '^\s*- \[[ xX]\]')
DONE=$(echo "$SECTION"  | grep -cE '^\s*- \[[xX]\]')
echo "checklist: $DONE/$TOTAL"
```

- 没有 self-review 标题、或段内 `TOTAL=0` → 本节直接跳过,不判(与 `context.mjs` 的 `format.checklist` 同口径)。
- `TOTAL>0` 时 `DONE/TOTAL` ≥ 80% 算合格;空 `- [ ]`(啥也没写)一律视作"糊弄"不算数。带 `N/A(<原因>)` 的 `[x]` 抽查是否给了原因即可,给了就算"有态度"。

#### 1.2.4 xdt-updater / DB migration 红线(硬判定)

红线路径命中走 `context.json` 的 `format.redlinePaths` / `format.hitsUpdater`(脚本按 `pr-rules.json` 的 `redlinePaths` 判,路径清单只此一处)。脚本不可用时,对照 `AGENTS.md`「设计实现规范」的 xdt-updater 条(规则 21)与 DB migration 条(规则 17)自行识别红线路径,**不要在本 skill 里另存一份路径清单**。

- 命中 `updater` 路径 → `$BODY` 必须有"已和 owner 确认"或语义等同字样(对应 agent 约束「xdt-updater」),缺失即 **不合规**、等级 `[阻断]`。
- 命中 migration 路径(`localDb/schema.ts` / `drizzle/`)→ 此处只标记,转到步骤 2 第 5 条按 agent 约束「DB migration」重点审(不在 1.2 拦)。

#### 1.2.5 检测结果汇总与分支

- **全部通过** → 汇报里写一句"PR 格式合规检测通过",**继续进入 1.3**。
- **存在不通过项** → **跳过 1.3 / 1.4 / 1.5 / 1.6 / 1.7,直接进入步骤 3B 起草打回评论**。打回评论的「问题清单」按:
  - 每条用 `[阻断]` 等级(格式不过本身就是阻断)
  - 命中条款写明(如"Title 缺少 type 前缀,不符合 Title 白名单(`agent-use/docs/pr-rules.json` 的 `titleTypes`,格式 `<type>(<scope>): <描述>`)")
  - 给一个具体可复制的改法或示例(如"建议改为 `feat(desktop): 在草稿面板新增自动保存`")
  - 引用 `.github/PULL_REQUEST_TEMPLATE.md` 让作者去查完整规范
- 打回前**不要拉分支、不要拉历史**——这部分流量和时间在格式过关前是浪费。但要向用户(当前 reviewer)如实汇报"格式检测不通过,起草了打回评论,确认发送?",仍然走步骤 3B 的用户拍板流程。

### 1.3 拉 PR 的文件列表 / diff

> → `files` / `totalDiffLines` 来自 `context.json`;**完整 diff 脚本不输出(太大)**,需要时仍用下面的 `gh pr diff`。

```bash
# 文件列表 + 增删行数(1.2.4 已拉过路径,复用 $FILES;要体量时):
gh pr view <PR_NUMBER> --repo <OWNER>/<REPO> --json files \
  --jq '.files[] | "\(.path)  +\(.additions) -\(.deletions)"'
# 完整 diff:
gh pr diff <PR_NUMBER> --repo <OWNER>/<REPO>
# 兜底 curl(翻页,每页 100):
curl -sS -H "Authorization: Bearer $(gh auth token)" -H "Accept: application/vnd.github+json" -H "X-GitHub-Api-Version: 2022-11-28" \
  "https://api.github.com/repos/<OWNER>/<REPO>/pulls/<PR_NUMBER>/files?per_page=100"
```

记录改了哪些文件、每个文件的 diff 大致体量。**单 PR diff 行数**可 `gh pr diff <PR_NUMBER> --repo <OWNER>/<REPO> | wc -l`,>500 行时 description 里要有"为什么必须一起提交"的说明(本 skill 执行细则),没说明在审查里记一笔。

### 1.4 把 PR 分支拉到本地


> **统一本地分支名(别踩坑)**:`gh pr checkout <N>` 默认切到 PR 的 head 分支(`headRefName`),和兜底 `git fetch` 用的 `pr-<PR_NUMBER>` 不一致,会让清理章节删错 / 删不掉分支。这里**用 `--branch` 强制统一命名为 `pr-<PR_NUMBER>`**,并在 checkout 成功后立刻把实际分支名记进 `PR_BRANCH`,后续(含清理章节)一律用 `PR_BRANCH` 指代,不再硬编码。

> → 跑 `node scripts/review-pr/checkout.mjs <PR_NUMBER>`,读 `branch`(脚本已用 `--branch` 强制 = `pr-<PR_NUMBER>`,并自带 `git fetch refs/pull/<N>/head` 兜底)。下面命令块是脚本内部等价逻辑(兜底)。

```bash
gh pr checkout <PR_NUMBER> --repo <OWNER>/<REPO> --branch "pr-<PR_NUMBER>"   # 推荐;--branch 强制本地分支名
# 兜底(gh 不可用):
git fetch origin "refs/pull/<PR_NUMBER>/head:pr-<PR_NUMBER>" && git checkout "pr-<PR_NUMBER>"
# checkout 成功后立刻记录实际分支名(清理章节要用):
PR_BRANCH=$(git rev-parse --abbrev-ref HEAD)
```

任一失败都要把错误如实告诉用户,**不要静默吞掉**。

### 1.5 拉取 PR 全部讨论历史与提交时间线(必做,从新到老)

> **核心前提**:PR 通常不是一次性提交,而是一个**持续过程**——作者可能已经根据上一轮评审改过几轮、评审者之间可能已经达成一致或还在分歧中。**在你开始审查之前,必须先读完所有历史**,否则极易:重复提别人已讨论过的问题、忽略之前 raise 但未解决的悬念、误判作者意图。

> → 三类历史来自 `context.json` 的 `history.{comments, reviewThreads, commits}`(reviewThreads 含 `isResolved`,commits 含 `latestCommitDate`)。1.5.4 的"历史脉络速记"仍由你综合。下面三个子节是各数据的口径说明 / 兜底命令(脚本已实现)。

拉三类数据:

#### 1.5.1 普通评论(issue comments)

```bash
gh pr view <PR_NUMBER> --repo <OWNER>/<REPO> --json comments \
  --jq '.comments[] | "[\(.author.login)] \(.createdAt)\n\(.body)\n---"'
# 兜底 curl(翻页 page=2,3...,看 Link header 的 rel="next"):
curl -sS -H "Authorization: Bearer $(gh auth token)" -H "Accept: application/vnd.github+json" -H "X-GitHub-Api-Version: 2022-11-28" \
  "https://api.github.com/repos/<OWNER>/<REPO>/issues/<PR_NUMBER>/comments?per_page=100"
```

- 翻页拉完(curl 看 `Link` header;gh `--json comments` 直接给全量)。
- GitHub 的 issue comments 端点**只返回真人评论**,没有 GitLab 那种 `system:true` 系统消息,不用过滤。
- 每条记:作者 `author.login`、`createdAt`、正文。

#### 1.5.2 代码行级评论与解决状态(review threads)

GitHub 行级评论的"已解决 / 未解决"状态 **REST 拿不到,必须走 GraphQL `reviewThreads`**:

```bash
gh api graphql -f query='
  query($owner:String!,$repo:String!,$num:Int!){
    repository(owner:$owner,name:$repo){
      pullRequest(number:$num){
        reviewThreads(first:100){
          nodes{
            isResolved
            isOutdated
            path
            comments(first:50){ nodes{ author{login} body createdAt } }
          }
        }
      }
    }
  }' -F owner=<OWNER> -F repo=<REPO> -F num=<PR_NUMBER>
```

- **分桶整理**:
  - **未解决 thread(`isResolved=false`)** → 评审历史里**还挂着的问题**,你这次审查必须显式回应(要么确认被新 commit 修了、要么继续标记为 blocker)。
  - **已解决 thread(`isResolved=true`)** → 已达成共识的**不要重复 raise**;但看一眼解决方式,确认 diff 里真有对应改动(标 resolved 但代码没改是**红旗**)。
  - `isOutdated=true` 的 thread → 对应代码已被后续 commit 覆盖,当上下文参考。

#### 1.5.3 提交时间线(commits)

```bash
gh pr view <PR_NUMBER> --repo <OWNER>/<REPO> --json commits \
  --jq '.commits[] | "\(.oid[0:8]) \(.committedDate) \(.messageHeadline)"'
# 兜底:curl GET /repos/<OWNER>/<REPO>/pulls/<PR_NUMBER>/commits?per_page=100
```

- 关注:首次 / 最近一次 push 时间、commit 数量、message 里有没有 "fix review comment / address xxx" 之类回应痕迹。
- 把 commit 时间线和 1.5.1 / 1.5.2 的评论时间线**交叉对齐**:某条评论之后有没有新 commit?新 commit 是不是在回应那条评论?

#### 1.5.4 输出一份"历史脉络速记"(自用,不发给用户)

整理出:这个 PR 经历了**几轮**;**上一轮评审的关键意见**是什么、作者**有没有回应**、回应的 commit 是哪个;当前**还挂着哪些未解决 thread**(文件/行、谁提的、最后一条谁说了啥);是否有**评审者之间未收敛的分歧**;是否有**作者主动留下的说明 / TODO**。

### 1.6 看懂功能 + 查重复实现

读 PR 的 title、body、diff 关键文件,**以代码实际改动为准**,不要被 body 带跑。结合 1.5 的历史一起看(最新 commit 可能是为响应某条评论才加的,别当成"主功能"评)。然后:

- 在仓库里 Grep / Glob 找是否已存在做同样事情的代码、Bugfix 或近期 commit(`git log --oneline -50` 也看一下)。
- 关注潜在重复点:同名函数、同 schema、同 IPC channel、同配置项、同 UI 入口。

### 1.6.5 前置门检查(所有 conversation / 意见解决 + 无合并阻塞)——先判定,1.7 让用户拍板

> **前置门通过的标准(理论硬线,记死)**:要往下走(进代码审查、乃至最终合并),必须**同时**满足——
> 1. **PR 上所有 review thread / conversation 都已 resolve**(`isResolved=true`),**不分作者**(真人 / bot / codex 等 connector 一视同仁);
> 2. **reviewer(你)提过的所有意见都已被解决**——行级评论本身就是 thread,已含在第 1 条;整体打回评论(issue comment,无 Resolve 按钮)靠"作者新 commit 回应 + 审查逐条核实 + 用户拍板"算解决;
> 3. **GitHub 没有把 PR 标为合并阻塞**(`meta.mergeStateStatus` 不是 `BLOCKED` / `DIRTY`)。
>
> 三条**任一不满足就不算通过**,不能无脑继续。本节负责"查 + 判定",结论交给 1.7 由用户拍板;**合并前(3A)还会再复核一次第 1 条 thread 状态(双保险——GitHub 分支保护不一定开了 require-conversation-resolution,不复核就会漏)**。
>
> **CI 不逐 check 读,但 BLOCKED 时按 workflow run 粒度分类**:`statusCheckRollup` / `gh pr checks` / `check-runs` / `code-scanning/analyses` / `branches/*/protection` 需要 token 有 Checks / commit-status / 安全设置读权限,本项目 fine-grained PAT 常 403、读不到。**但 `actions/runs` 和 `rulesets` 读得到** —— BLOCKED 时 `context.mjs`(经 `lib.classifyHeadChecks`)用 `actions/runs` 把 workflow run 分成 awaiting / failed / pending,再用 `meta.reviewDecision`(权威聚合)区分 review 维度,据此给出 `gate.blockClass`:`ci-failed`(真失败,不合)/ `ci-pending`(还在跑,等)/ `workflow-awaiting`(fork 待批)/ `review-changes-requested`(要作者改)/ `structural-check`(review+已跑 CI 都过、仍 BLOCKED——永不上报结果的必需检查门)。`meta.mergeStateStatus` 仍是兜底综合信号(GitHub 把"必需检查全过 + 分支保护"折进它),`BLOCKED`/`DIRTY` 都进前置门「未通过」,合并前 `pre-merge-check.mjs` 把 `BLOCKED` 当 blocker 兜住(只有 `structural-check` + 可 bypass 时,3A 才经用户确认走 admin bypass),**不会因为不逐 check 读就把红 CI 漏合**。需要逐 check 细节仍由用户去 GitHub 看。
>
> **执行原则(对应 agent 约束「优先用代码保证确定性」:能用代码确定的就用代码)**:thread 的 `isResolved`、`mergeStateStatus`、打回评论与新 commit 的时间先后,都用命令跑出确定结果;只有"bot / reviewer 评论里说的到底是不是个要处理的问题"这种语义活才由你读。
>
> → 前置门判定来自 `context.json` 的 `gate`:`unresolvedThreads`(所有 `isResolved=false`,不分作者)、`reviewerPushbacks`(issue-comment 形式打回,带 `signal` 强/弱 + `hasNewerCommit`)、`botComments`、`blockers`、`softFlags`、`gatePass`;合并阻塞看同份 JSON 的 `meta.mergeStateStatus`。**`gatePass=false` → 前置门未过**(`blockers` 是硬未解决项);`softFlags` 里的项需要你读内容定性(bot 评论 / 疑似打回读 `gate.botComments` / `gate.reviewerPushbacks`)。下面 1.6.5.1~1.6.5.4 是判定口径说明(脚本已实现)。

#### 1.6.5.1 合并阻塞状态(替代逐项读 CI)

- 看 `context.json` 的 `meta.mergeStateStatus`:`CLEAN` = 无阻塞(必需检查全过、无冲突、无分支保护拦截)→ 本条通过;`BLOCKED` = 被必需检查未过 / 分支保护挡住 → 未通过;`DIRTY` = 有冲突 → 未通过;`UNKNOWN` = GitHub 还在算,等几秒重跑 `context.mjs` 或在 3A 合并前复核时再看。
- 这一条是 CI 的**兜底**:不逐 check 读,但 GitHub 已把"必需检查是否全过"折进 `mergeStateStatus`。`BLOCKED` / `DIRTY` 都进前置门「未通过」清单。
- **`BLOCKED` 的成因别一刀切——读 `gate.blockClass` 分档处理**(`context.mjs` 用 `reviewDecision` 权威信号 + `actions/runs` 的 workflow run 分类判定):
  - `review-changes-requested` → 真有 reviewer 要求改动,作者要改;
  - `ci-failed` → workflow run 真失败(`gate.ciRuns.failed` 列名字),不能合;
  - `ci-pending` → workflow 还在跑,等跑完(auto 下轮重试,别打回作者);
  - `workflow-awaiting` → fork workflow 待批准才能跑 CI,解法是 approve 放行(详见「Workflow 待批准门」,与缺 reviewer approval 的 `blockedAwaitingApproval` 是两回事);
  - **`structural-check`** → **review 都过、已跑 CI 也没失败,却仍 BLOCKED**:卡在**永不上报结果的必需检查门**(org ruleset 的 `code_scanning`(CodeQL)/`code_quality` 等,本仓库根本没产出对应结果;或被 job 级 `if` 跳过的必需 check)。这**不是作者要改**——owner 用 admin bypass 合、或修该门让它能上报。`gate.structuralBlock.canBypass=always/pull_requests` 表示当前账号可 bypass。详见「结构性 BLOCKED 门」节。
- 想看具体哪个 check 红 / 还在跑,让用户自己去 PR 页面看(本流程不替用户逐项拉)。

#### 1.6.5.2 未解决的 conversation(review threads)——全部要 resolve,不看作者身份

> **判据是 thread 的 `isResolved`,不是"谁发的"。** 像 `chatgpt-codex-connector (Bot)` 发的、带 `P2` 标签、底部有 "Resolve conversation" 按钮的,本质就是一条 review thread——它是不是 bot 不重要,**只要没点 Resolve 就算未解决**。真人、工具账号、codex / 各类 connector 一视同仁。

1.5.2 已用 GraphQL `reviewThreads` 拉过并按 `isResolved` 分桶,这里直接取结论(纯布尔判定,代码可判,不需要你读内容来"决定算不算"):
- **所有 `isResolved=false` 的 thread = 未解决项**,逐条列出(谁发的、`文件:行`、最后一条说了啥),**不管作者是真人还是 bot / 工具账号**。
- ⚠️ **绝不能用"这是 bot 发的,可以忽略"来跳过**——理论上所有 conversation 都要被 resolve 掉才能继续。bot / 工具账号发的 thread 同样:要么作者处理后 resolve、要么由人确认无效后 resolve,没 resolve 就是挂着。
- `isResolved=true` 的不计入本 gate(它"代码是否真改"是步骤 2 的审查内容,不在这拦)。

#### 1.6.5.3 评论类未解决问题(非 thread:bot 总结评论 + reviewer 历史打回)

这一类是**普通 issue comment**(PR 时间线上的评论,**没有** "Resolve conversation" 按钮、没有 `isResolved` 状态),判定靠读内容 + 对时间线,不像 1.6.5.2 那样纯布尔。

- **bot / 工具账号的总结评论**(如 codecov 在时间线发的覆盖率总结、各类 lint·security bot):报覆盖率下降 / lint 失败 / 安全告警 / 依赖风险 = 未解决项;纯 FYI / 部署预览链接 / "all checks passed" 类 = 忽略。拿不准就**当未解决项列出来让用户判断**,别替用户消化掉。
- **reviewer 历史打回**(**注意**:本 skill 步骤 3B 现在用 `REQUEST_CHANGES` review 发打回,行级意见都是 review thread、已归 1.6.5.2;落在这一类的只剩 ① 历史遗留的旧 issue-comment 打回、② 本次 review `body` 里锚不到代码行的少数意见,如格式门 title / description):
  - 识别信号——**强**:评论含 `[阻断]` / `[必改]` 标签(3B 固定格式);**弱(疑似)**:语义明确表达"不能合 / 这次先没合 / 需要改后再合 / 先别合"。
  - 用 **commit 时间线(1.5.3)** 交叉对齐:**打回之后零新 commit** → 作者根本没动 → **确定未解决**,硬列;**打回之后有新 commit** → 作者可能在回应,但"具体那几点改没改"留给步骤 2 第 0 条逐条核,本节先列为"作者有迭代,待审查中逐条确认",**不直接放行**。

#### 1.6.5.4 汇总「前置门结论」(交给 1.7)

三类未解决项汇成一份清单,每条记:`类型(合并阻塞 mergeStateStatus / 未解决 conversation / 评论类问题)+ 一句话 + 链接或 文件:行`。
- **三类全空** → 结论 = `前置门通过`。
- **任一非空** → 结论 = `前置门未通过` + 清单。其中"未解决 conversation"(1.6.5.2)是最硬的一档——**只要有一条 thread 没 resolve,前置门就不算通过**,不因作者是 bot 而放宽。

**本节只判定,不发评论、不问用户、不起代码审查**——结论带到 1.7。

### 1.7 向用户汇报(必须用人话)

输出一段总结,**不要堆技术细节**,用产品视角讲清楚:

- **这个 PR 想做什么**(一两句话,讲清楚用户/开发者会感知到的变化)
- **改了哪些地方**(按"前端 / 后端 / 配置 / 文档"等粗粒度归类)
- **可能影响的场景**(谁会受影响、什么时候会触发、出问题会怎样)
- **是否和现有功能重复**(明确说"已存在 X 在做类似的事" 或 "未发现重复实现")
- **历史脉络**(基于 1.5):第一版还是已改过几轮?上一轮有无遗留意见?当前**还挂着几个未解决 thread**(分别是什么)?评审者之间是否有未收敛分歧?全新 PR / 无历史就明确说"首次提交,无历史评审记录"。
- **是否牵扯 Server 代码**(看 `format.hitsServer` / `format.serverFiles`):命中要明说"含 server 改动,合并前必须作者已飞书通知 Lizi(发布服务器代码 + 新增环境变量私聊),未声明通知会被打回"(见「Server 发布通知 gate」),并顺带说明当前作者是否已声明通知过。
- **产品/UI 门状态**(基于 `productGate`,1.1.5 已过的一句话即可):豁免的说明豁免来源(作者白名单 / 白名单在 PR 上 Approve 过 / 白名单标回 ready);经 issue 白名单同意放行的,写明是谁、哪条留言(带时间)同意的;若 1.1.5 用户选了「明知是产品/UI 修改仍继续审」,这里要再提醒一句"产品方向还没经白名单对齐,合并前建议先让 dash / Lizi 看一眼"。
- **作者、源分支(headRefName)、目标分支(baseRefName)、当前是否有冲突**(看 `mergeable` / `mergeStateStatus`;`mergeable=null` 说明 GitHub 还在算,如实说"冲突状态计算中")
- **前置门状态(基于 1.6.5,必报)**:`mergeStateStatus` 是否有合并阻塞(`BLOCKED` / `DIRTY`;CI 必需检查未过会体现成 `BLOCKED`)、**有没有未 resolve 的 conversation / review thread(不分作者,bot 发的也算)**、bot 总结评论或之前 reviewer 的打回作者处理了没。前置门通过就说"无合并阻塞、所有 conversation 已 resolve";未通过就把未解决清单**逐条列出来**。(本流程不逐项读 CI,要看具体哪个 check 红让用户去 GitHub 看。)
- **Workflow 待批准(若 `gate.workflowsAwaitingApproval` 非空,必报)**:明说"这是 fork PR,有 N 个 workflow(列名字)在等批准才能跑 CI,所以现在被卡成 BLOCKED;我可以帮你点 approve 放行 CI",并提示 CI 跑完才会变可合。**若 `gate.prTouchesCiFiles=true`**(PR 改了 `.github/workflows` 等 CI 配置),额外强警告:"⚠️ 这个 PR 自己改了 CI 配置(列文件),approve 等于直接执行被改过的 CI,建议先看过那段 diff 再决定批不批"。
- **结构性 BLOCKED(若 `gate.blockClass=structural-check`,必报)**:明说"review 都过了、跑过的 CI 也没失败,卡住它的是分支保护里**永不上报结果的必需检查门**(`gate.structuralBlock.requiredCheckRules`,如 `code_scanning`/`code_quality`——本仓库没产出对应结果),所以会**永久 BLOCKED**;这不是作者要改"。若 `gate.structuralBlock.canBypass` 为 `always`/`pull_requests`,补一句"你这个账号有 bypass 权限,审查通过后我可以帮你走 admin bypass 合(等于 GitHub 上的 'Merge without waiting for requirements');根治则是启用对应扫描或调整该 ruleset"。

然后**按 1.6.5 的前置门结论分情况问法**(AskUserQuestion):

- **前置门通过** → 问:**"这个功能是否有必要合入?是否要继续做代码审查?"**,选项 `继续审查` / `放弃并清理本地` / `让我先看看(暂停)`。
- **前置门未通过、且唯一原因是 workflow 待批准**(`gate.workflowsAwaitingApproval` 非空,且除它之外没有别的 blocker)→ 走「Workflow 待批准门」节:问用户要不要 approve 放行 CI。**不要**当成普通"前置门未过"让用户去催作者——作者没问题,卡的是 CI 准入。
- **前置门未通过、且成因是结构性门**(`gate.blockClass=structural-check`)→ 这是「永久 BLOCKED、靠 admin bypass 合」的情况,不是作者要改、也别去催作者。**仍可以正常做代码审查**(读代码不依赖那两个门);审查这步照常问 `继续审查` / `放弃并清理本地` / `让我先看看(暂停)`,并预告"审查通过后合并要走 admin bypass(见 3A),根治建议你顺带看下「结构性 BLOCKED 门」"。
- **前置门未通过(mergeStateStatus 有阻塞 / 有 conversation 没 resolve / bot 或 reviewer 的问题没处理)** → **这是硬 gate,绝不能自己决定往下走**。把未解决清单作为问题核心,问:**"前置检查还没过(上面列的那些),要怎么处理?"**,选项 `暂停,我去催作者解决`(推荐——前置没解决不该继续 review)/ `明知未解决,仍继续做代码审查` / `放弃并清理本地`。**默认倾向暂停,不要诱导用户选继续**;只有用户明确选"仍继续"才进步骤 2,并把这份未解决清单一并带进步骤 2 的审查上下文(reviewer 打回项交给第 0 条历史承接逐条核)。

如果用户选放弃,跳到末尾的 **清理章节**。

## 步骤 2:严格代码审查(只在用户同意后做)

### 执行方式(硬性要求)

**本步骤的全部审查工作(下面 12 项框架 0 / 0.5 / 0.6 / 1-9)必须通过 Codex 的子 agent(子任务派发)能力起一个独立的审查子 agent 完成,主 agent 不直接审。** 理由:

- **隔离上下文**:审查要把大量 diff、相关源码、历史评论读进上下文。主 agent 自己审会被这些噪音污染,后续合并 / 评论 / 清理流程容易跑偏。
- **聚焦**:审查子 agent 跑在独立上下文里,只拿到下面这段自包含的审查 prompt,反馈更聚焦、更可执行、不掺无关意见。
- **可重试**:主 agent 不持有审查中间态。子 agent 输出不符合格式 / 漏项时可以直接重起一次,主流程不受影响。

> **平台说明(Codex)**:Codex 没有 Claude Code 那种预置的 `Code Reviewer` 角色(那是 `.claude/agents/` 注册项),所以这里起的是一个**通用子 agent**,靠下面那段自包含 prompt(已含完整审查框架)把它"变成" reviewer。如果当前运行环境确实拿不到子 agent 派发能力,**降级为主 agent 亲自按下面「审查框架明细」逐项审**,但要刻意控制读进上下文的 diff 体量,审完同样按「总体判断」进入 3A / 3B。

#### 调用模板

起一个 Codex 子 agent,把下面这段自包含 prompt 整段传给它(`<...>` 占位符替换成主 agent 已收集到的实际值):

````markdown
你正在帮 review-pr skill 完成一个 PR 的严格代码审查。**只输出审查报告,不要修改任何代码,不要发任何评论,不要试图合并**——这些动作都由主 agent 在拿到你的报告并经用户确认后才做。

# 任务上下文

- 仓库根:<repo_root>
- PR 编号:#<PR_NUMBER>
- PR Title:<title>
- 代码检出:<checkout_state>
- 目标分支:`<baseRefName>`(diff 用 `git diff origin/<baseRefName>...HEAD`)
- PR Description / 改动文件列表 / 讨论历史:<pr_context>

# 审查框架(12 项,逐项过,以源码为准)

按以下顺序检查,**每项必须用 Read / Grep / Glob(TS 符号优先用 LSP 引用工具,见第 4 条)实际查代码再下结论,不要凭印象**。

⚠️ **审查视野硬约束:不要只看 diff 文件。** diff 只是改动的"出发点",你的职责是判断这些改动放回**整个仓库**后会不会波及 diff 之外的关联功能和代码。每碰到一处共享逻辑,都要主动顺着引用 / 数据流 / 契约走出去,把受影响的关联方都读一遍再下结论。**只盯着 diff 局部、不查关联方,等于没做这次审查**——这是第 4 条的核心,贯穿全程。

**项目规范基准**:第 1 / 5 条要对照仓库根 `AGENTS.md` 与 `.github/PULL_REQUEST_TEMPLATE.md`——**直接 `Read` `AGENTS.md` 的「设计实现规范」节与 `.github/PULL_REQUEST_TEMPLATE.md`(按标题定位,不要用记忆里的旧条款 / 旧编号,规范条数会增改),逐条核对**。其中**红线条必查**(按小标题语义定位,不靠编号):xdt-updater 改动声明、跨平台双端兼容、优先用代码保证确定性、throwIpcError、主题 token、maker-core 指标(缓存率/性能/准确性)、系统提示词改动须 Lizi 确认、DB migration、凭证不入仓。

0. 历史讨论的承接(最优先)
0.5. 代码与描述一致性 + PR 目的单一性(对账 + 搭便车拆分判定)
0.6. 重构他人历史功能的前置沟通门(git blame 定权属 + 6 项澄清,命中且无对齐证据即 `[阻断]`)
1. 是否符合项目规范(对照 `AGENTS.md`「设计实现规范」与 `.github/PULL_REQUEST_TEMPLATE.md` 全部条款,红线条逐条核)
2. 真实可用性(diff 是否能跑通,有无空壳 / TODO 占位)
3. 跨平台(macOS / Windows)
4. **全局关联影响分析(本条最重,必查,不准只看 diff)**:顺着每个被改的共享符号 / 契约 / 数据 / 状态走出 diff,在整仓找出所有关联调用方和关联功能,逐一确认其在新行为下是否仍正确;方法见下方「第 4 条展开」,产出「影响面清单」
5. 副作用 / 破坏性(含 DB migration 红线 + 系统提示词红线 + maker-core 指标红线)
6. 错误处理(注意不要为不可能的场景加 handling)
7. 重复 / 抽象
8. 日志(无 console.log 漏网)
9. 测试 / 验证

# 第 4 条展开:全局关联影响分析方法(必读,不准跳)

这是本次审查的重心,分四步做,每步都要有实际查证动作,不能凭印象:

1. **抽取"改动面"(对外可见点)**:逐文件过 diff,列出所有被新增 / 修改 / 删除 / 改签名的对外可见点——
   - 代码符号:导出的函数 / 类 / 方法 / 常量 / type / interface / enum
   - 跨进程契约:IPC channel 名、IPC payload 字段、preload 暴露面、event 名
   - 数据契约:DB schema / 列、SQLite 表、持久化文件格式、缓存 key
   - UI / 主题契约:CSS 变量名、主题 token、全局样式类
   - 配置契约:env 变量名、配置 key、`package.json` script、构建配置项
   - 共享运行时:全局单例、事件总线、共享缓存 / 状态
2. **反查全部关联方(走出 diff,这步最容易被偷懒)**:对每个改动面在**整个仓库**里找引用 / 消费方——
   - **TS 代码符号**:优先用 LSP 引用工具(若环境可用:`mcp__lizi_lsp__lsp_find_references` / `lsp_incoming_calls` / `lsp_goto_definition`),比 grep 准(能穿透 re-export、别名 import,误报少);拿不到 LSP 就用 Grep 兜底,并留意 re-export / 别名造成的漏网。
   - **非符号契约**(IPC channel 字符串、env 名、CSS 变量名、配置 key、文件路径):不是 TS 符号,直接 Grep 全仓搜字符串。
   - 找到的每个引用点都要 Read 真实代码,别只看文件名猜。
3. **找"功能级"关联(不止直接调用方)**:除直接引用外,想清楚哪些**功能**和被改逻辑耦合——
   - 共享同一份状态 / 数据 / 缓存的其它功能(改了写入,所有读取方都要核)
   - 依赖同一不变式 / 时序假设的功能(改了时序,依赖方可能踩空)
   - 监听 / 触发同一事件的功能
   - **本该同步改却没改的"兄弟实现"**:同类逻辑在别处还有一份(同名函数、同套 schema、平台分支的另一端),只改一处就要标出
   - 数据流上下游:这段逻辑产出的数据被谁用、消费的数据由谁产
4. **逐个下结论(不是只列引用)**:对每个关联方 / 关联功能,明确判断"仍正确 / 需同步改但 diff 没改 / 会被破坏"。只要存在"会破坏"或"需同步改但 diff 没动"的项,直接判 `[阻断]` 或 `[必改]` 走打回。

**影响面清单为空**只有在改动确实纯内部、零对外可见点时才允许,且必须写一句"已确认无跨文件关联点"——不准因为没查就留空。

# 输出格式(严格,主 agent 会按此结构解析)

报告**第一行固定写**:`审查对象:PR #<PR_NUMBER> <title>`——主 agent 落地前会拿这一行机械核对编号与标题,对不上整份报告作废。然后按下面结构输出:

```markdown
审查对象:PR #<PR_NUMBER> <title>

## 0. 历史承接
<未解决 thread 处理情况;已解决 thread 是否真改;评审者分歧;作者 TODO>

## 0.5. 代码与描述对账 + 目的单一性
PR 单一主目的:<从 Title + Fixes #N 提炼的一句话>

| 事项 | 来源 | 对应 diff 位置 | 对账状态 | 主目的归属 |
|---|---|---|---|---|
| ... | description / diff | path:line | 一致 / 仅承诺未实现 / 仅实现未声明 | 服务主目的 / 必需连带 / 搭便车 |

分桶汇总:A(承诺未实现)X 项 / B(实现未声明)Y 项及严重程度 / C(对得上且服务主目的)Z 项 / D(已声明但与主目的无关·搭便车)W 项(逐项注明有无成立的"必须一起提交"硬理由)

## 0.6. 重构他人历史功能沟通门
<是否构成"重构他人代码"(git blame 在 base 上定权属:被重写的既有行原作者 vs PR 作者);有无"已与原作者对齐"证据;命中且无证据 → `[阻断]` + 原作者 @谁 + 需澄清的 6 点;不触发就写一句"非重构 / 仅自我重构 / 已与原作者对齐,本门通过">

## 1-9. 维度逐项结果
<每项一段或几段,命中问题用 `[阻断] / [必改] / [建议]` 等级标签开头,后跟"位置 + 影响 + 建议改法">

## 影响面清单(第 4 条产出,必填,不准空着糊弄)
| 被改的共享点 | 类型 | 如何查证 | 关联方 / 关联功能(文件:行) | 新行为下是否仍正确 | 是否已在 diff 同步 | 风险 |
|---|---|---|---|---|---|---|
<每个改动面至少一行;"类型"写 符号/IPC/数据/配置/状态等;"如何查证"写 LSP / grep;"新行为下是否仍正确"写 仍正确 / 需同步改 / 会破坏;"风险"写 低 / 中 / 高。确属零关联点时写一行"已确认无跨文件关联点">

## 总体判断
- 结论:`可以合` / `需要改后再合` / `不应合`
- 关键理由(1-3 条)
- 如果是后两种,列出所有 `[阻断]` 和 `[必改]` 条目作为打回清单(主 agent 会拿这个清单去填步骤 3B 的打回评论)
```

# 硬性约束

- **只读不写**:用 Read / Grep / Glob / Bash(只用 git log / git show / git diff / git blame 等只读命令),**不要修改任何文件,不要执行 git push / git commit / gh / curl 写操作**。
- 引用源码位置必须精确到 `文件:行号` 或 `文件:函数名`,reviewer 要能跳过去看。
- 输出必须严格按上面 markdown 结构,主 agent 会按结构提取打回清单。
- **不要复述 diff**(主 agent 已经知道改了什么),报告里只写"发现什么 + 在哪 + 影响 + 建议"。
- 全报告控制在合理篇幅(典型 PR 30-80 行 markdown 即可),信息密度优先于详尽。
````

**`<checkout_state>` 怎么填(按模式二选一)**:
- **主 agent 已做 1.4 主树 checkout 的**(交互模式 / Codex 串行批处理)→ 填:`本地分支已 checkout:pr-<PR_NUMBER>,直接开始审查`。

**`<pr_context>` 怎么填(与 `<checkout_state>` 同步二选一)**:
- **主 agent 已跑全量 `context.mjs` 的**(交互模式 / Codex 串行批处理)→ 依次贴入:Description 原文(``` 包裹)、改动文件列表(每行 `path  +N -M`)、1.5 历史脉络速记(主 agent 整理,从新到老)。

#### 拿到子 agent 报告后

**第 0 步:机械核对报告归属**——报告第一行必须是 `审查对象:PR #<编号> <title>`,且编号与你当前要处理的 PR 完全一致。不一致(或缺这一行)= 报告串位 / 格式破损,**整份作废、对该 PR 重起审查子 agent**,绝不能拿 A 的报告去落地 B(并行批处理时这是唯一防张冠李戴的硬校验)。

核对通过后,主 agent 直接把子 agent 返回的报告**原样转给用户**(可以前面加一行"以下是审查子 agent 的报告:",不要二次加工不要总结)。然后**先做一道确定性 gate(优先级高于「总体判断」结论)**:扫一遍报告全文,数有没有带 `[阻断]` 或 `[必改]` 标签的条目。

- **存在 ≥1 条 `[阻断]` 或 `[必改]`** → 一律按 3B 处理,**无论「总体判断」结论字段写的是什么**。若结论写了 `可以合` 却仍挂着 `[阻断]` / `[必改]`,说明报告自相矛盾——以"有未清的必改项"为准、**不采信 `可以合`**,并在转给用户的汇报里点明这处矛盾。
  - **例外(auto 模式 + `auto.needsSelfApproval=true` 的 self-blocked PR)**:这种 PR 你自己那条 `CHANGES_REQUESTED` 还挂着,重审本就是去核实「问题改没改」。重审若仍有 `[阻断]`/`[必改]`(= 问题没真解决,典型:thread 标了 resolved 但代码没改)→ **不要再走 3B 提交新 REQUEST_CHANGES**(旧 CR 已在,重复打回无意义、且会骚扰作者),**也不要 self-approve**;保持 CR 原样不动,把「重审发现 N 项未真正解决(列出哪几条)」写进飞书汇总让 owner 人工介入,然后清理本地、按 isSkip 那样轮转到下一候选。
- **零 `[阻断]` 且零 `[必改]`** → 才允许进入 3A。`[建议]` 不阻断合并,带进 3A 评论的 ④ 后续建议块作为 follow-up。(`needsSelfApproval=true` 的 PR 到这里即「重审通过」,进 3A 时会先执行第 0 步 self-approve 撤 CR。)

gate 通过后,再根据"总体判断"分流:

- `可以合` → **先过「Server 发布通知 gate」**(`format.hitsServer=true` 且作者未声明已飞书通知 Lizi → 转 3B,把该节的 server 通知确认条目作为打回清单);gate 通过才进入步骤 3A,用 AskUserQuestion 让用户最终拍板合并
- `需要改后再合` / `不应合` → 进入步骤 3B,把报告里的打回清单(`[阻断]` + `[必改]` 条目)直接作为打回评论的「问题清单」来源,**不要重新审查、不要自己重写问题清单**(若「Server 发布通知 gate」也未过,按该节要求把 server 通知确认条目一并加进 `comments[]`)。**例外:作者命中 `selfFixAuthors`(`auto.selfFix=true`)时不走 3B**(对自己的 PR 提 REQUEST_CHANGES 会 422),改走「自动跟进修复(fix-handoff)」把问题清单投递给跟进会话(交互模式先按该节 AskUserQuestion 征得用户同意)

如果子 agent 报告格式破损 / 漏项 / 明显敷衍,**重起一次子 agent**,在 prompt 里指出上次哪里不够(例:"上次漏了影响面清单,这次必须输出");重起 2 次仍不行,告诉用户并请示是否手工接管。

### 审查框架明细(供子 agent prompt 引用,主 agent 不直接执行)

下面 12 项规则是上面子 agent prompt 引用的"审查框架"明细,**主 agent 不直接按这些规则审代码**,只在拼子 agent prompt / 解读报告时回头查看。以源码为准,注释和 PR 文本只做参考:

0. **历史讨论的承接(本条最优先,先做完再做下面 1-9)**:把 1.5 整理出的"历史脉络"逐条过一遍——
   - **未解决 thread**:对每一个 `isResolved=false` 的 thread,回到对应文件/行,看最新 diff 有没有真的处理。**处理了** → 在审查报告里写明"原 thread X 已被 commit Y 解决";**没处理** → 直接进入步骤 3B 标记为 `[阻断]` 或 `[必改]`(等级取决于原 thread 严重性),不要绕开。
   - **已解决 thread**:确认 diff 里真的体现了对应改动,如果标记 resolved 但代码没改,这是**红旗**,要在报告里点出。
   - **重复问题去重**:你要 raise 的问题,**先和历史讨论比对**,之前已讨论且达成共识的(无论结论是改还是不改)不要再以新问题姿态重新 raise;可以引用("延续 thread X 的讨论:...")或直接跳过。
   - **评审者分歧**:历史里 A 说要改、B 说不用改且当前 diff 没收敛,不要装看不见——在报告里明确指出,让用户(当前 reviewer)拍板。
   - **作者主动说的话**:作者解释的设计权衡 / 留下的 TODO / 说"这块还没处理"的部分,纳入审查上下文。作者明说"下版本再做"的内容本次不当 blocker,但要在报告里告诉用户作者承诺了什么。

0.5. **代码与描述一致性 + PR 目的单一性(本条紧跟 0,通过才能进入 1-9)**:在仔细审 diff 之前先做两道关联检查——① "description 承诺 vs 代码实现"的对账;② "已实现的每件事是否都服务于这个 PR 声明的单一主目的"的拆分判定。**两边货不对板、或一个 PR 里塞了多件互不相关的事,都是打回理由**——不要被作者写得头头是道的 description 蒙过去,也不要因为"作者把夹带改动在描述里坦白了"就放行(**声明 ≠ 该一起提交**)。
   - **第 0 步:先确立 PR 的「单一主目的」**:从 Title 的 `<type>(<scope>): 描述` + `Fixes #N` 关联的 issue 提炼出这个 PR 要解决的**那一件事**,后面每件改动都拿它当标尺。
   - **对账方法**:
     - 从 description 的"这次改了什么 / 怎么验证的 / 风险"等段落抽出**作者明示或暗示的 N 件事**(例:"加了 X 入口" / "把 Y 改成 Z" / "修了 W 路径在 Windows 上的 bug" / "新增 IPC channel Q")。
     - 从 diff 里逐文件核对**这 N 件事是否真的实现**;同时反向问"diff 里还做了哪些 description 没提的事"。
   - **分桶(每件事先判对账状态,再判与主目的的关系)**:
     - **A. description 承诺但 diff 未实现**:**最严重的货不对板**,**直接判 `[阻断]`**,跳到步骤 3B。哪怕只有 1 件也要打回。
     - **B. diff 实现但 description 未声明**:看影响面分级——涉及共享层 / 跨模块 / 配置 / 数据 schema / IPC 契约 / 主题 token / xdt-updater → **`[阻断]`**,要求作者补说明;仅是被改文件内部的小重构 / 命名调整 / 顺手清理 → **`[必改]`**,按 surgical changes 原则要求拆出去或补 description。
     - **C. 对得上且服务于主目的** → 合规,继续进入 1-9。**为实现主目的「必需的连带改动」也归 C、不算夹带**:被改函数签名传播到的调用点、配套的测试 / 类型 / i18n key、为支撑主功能而做的局部重构、主功能拆成的多层改动(只要每层都落在这一个目的的实现路径上,如 maker-core 结构化 → IPC → 持久化 → renderer 渲染)。
     - **D. 对得上、但与主目的无因果关系(搭便车改动)**:即「描述里坦白了、但本就不该和主目的塞进同一个 PR」的独立改动——典型:与主功能无关的另一个 bugfix、顺手做的另一块重构 / 优化、夹带的第二个功能、与本功能无关的静态检查清理。**即使 description 已声明(哪怕单列了「顺手 / 同时修复的既有问题」小节),仍判 `[必改]`**(违反"一个 PR 一个目的"——本 skill 执行细则),打回要求**拆成独立 PR**。
       - ⚠️ **声明不能豁免拆分**:0.5 的对账防的是"说一套做一套",**这道目的单一性判定防的是"做了不该一起做的事"**——把夹带改动写进描述,只让它**不进 B 桶**,**不等于满足目的单一性**,该进 D 桶。
       - **唯一逃生阀**:description 顶部给出了"为什么必须和主目的一起提交"的**硬技术理由且该理由成立**(典型:与主目的共享同一改动面、拆开会留下中间不可编译 / 不可运行的状态)。理由成立 → 该项降级为 C。**但论证只能覆盖它真正解释到的改动**:若那段"必须一起提交"的论证只讲清了主功能那几层、却没解释某件搭便车改动为何拆不开,这件仍判 `[必改]`;"顺路就一起改了" / "都在这块附近" / "反正要发版" 一律不成立。判定落到"拆开在技术上是否真的做不到",不是"作者有没有写一段话"。
   - **输出格式**:列一份"对账 + 归属清单",每条形如 `<事项> → 对应 diff 位置 → 对账状态[一致 / 仅承诺未实现 / 仅实现未声明] → 主目的归属[服务主目的 / 必需连带 / 搭便车]`。
   - **特别提醒**:1.2 已做过 description 格式校验,**这里不再校验格式,只校验语义对账 + 目的单一性**。格式漂亮、对账也对得上、但"一个 PR 干了几件不相关的事"的 PR,在这一关的 D 桶被拦下。

0.6. **重构他人历史功能的前置沟通门(本条紧跟 0.5;命中且无对齐证据即 `[阻断]` 走 3B,先做完再进 1-9)**:本 PR 若**实质性重构 / 重写了一段并非自己当初实现的既有功能**,而作者拿不出"已与原功能作者对齐"的证据,**直接判 `[阻断]`**,要求作者先去和原作者澄清后再提。理由:重构他人功能风险高——容易改坏只有原作者才清楚的隐含约束、与原作者正在做的事撞车、或纯为"更优雅"而推倒重来;这次重构"该不该做、是否现在做、怎么分阶段、测试够不够",必须由**原功能作者**参与判断,不能由提交者单方面决定。
   - **第 1 步:判定是否构成"重构他人代码"(两个条件同时满足才触发)**——
     - (a) **构成重构 / 重写**(语义判断):不是新增功能、也不是定点小修,而是对一段既有逻辑做**结构性改写**——大段删除并重写、函数 / 类 / 模块的拆分合并、调换实现方式、为"更清晰 / 更统一 / 更优雅"而改动本应行为不变的既有代码。`type=refactor` / `perf` 是强信号但**不限于此**——藏在 `feat` / `fix` 里的顺手重构同样算。
     - (b) **原作者不是 PR 作者**(确定性,用 git 查权属,别凭印象):对被大幅删改的既有代码段,在 base 上 blame 出原作者,与 PR 作者比对——
       ```bash
       git diff origin/<base>...HEAD -- <file>          # 看哪些既有行被删 / 重写
       git blame origin/<base> -L <起>,<止> -- <file>   # 这些被删 / 重写的行原来是谁写的
       # 粗粒度兜底:git log --format='%an <%ae>' --no-merges -- <file> | sort | uniq -c | sort -rn
       ```
       被重写的行**主要由他人**(git author 明显不是 PR 作者本人;注意 git 姓名/邮箱 与 GitHub handle 的对应)所写 → 命中。作者只是重构**自己**当初写的代码 → **不触发**(自我重构无需此门)。
   - **第 2 步:看有没有"已与原作者对齐"的证据(有则本门通过,不打回)**:在 description / PR 评论 / review thread 里找作者**明确声明**已与原作者沟通过这次重构(如"已和原作者 @X 确认重构方案 / 节奏 / 测试");或**原作者本人已 approve 本 PR / 列为 co-author**。证据成立 → 本门通过,重构本身仍按 1-9 正常审。
   - **第 3 步:命中且无证据 → `[阻断]`,finding 写清"找谁 + 澄清什么"**:锚到一处有代表性的重构行,内容必须含——
     - **原作者是谁**(blame 查到的,@ 出来):"这段是 @<原作者> 当初实现的功能";
     - **要求**:先和原作者澄清下面 6 点并在 PR 里留证据(或直接拉原作者来 review),再继续——
       1. 这次重构**为了解决什么实际问题**(具体问题,不是"看着不顺手 / 想更优雅");
       2. **是不是一定要重构**才能解决(有没有更小的、非重构的改法);
       3. **是不是一定要现在**重构(能不能延后 / 排进后续计划);
       4. 重构的**节奏与阶段**怎么分(一次性大改 vs 分阶段小步,以降低风险);
       5. 覆盖哪些**测试用例**(重点:原功能的既有行为不被破坏);
       6. 这些测试**是否都已跑过**并通过。
   - **scope 守则(避免误伤)**:为实现本 PR 主目的而对他人共享代码做的**必需连带改动**(函数签名传播、调用点适配、0.5-C 那类围绕单一目的的局部改动)**不算**本条意义上的"重构他人功能"——命中门槛是"对他人既有功能做了**结构性重写**",不要拿这条拦正常连带改动。若 blame 显示原作者已离职 / 该段为无主 legacy、确实找不到对齐对象,降级为 `[必改]` 并在 finding 写明"原作者不可达,建议改与当前模块 owner / Lizi 对齐",交用户 / owner 定夺,**不要静默放行**。

1. **是否符合项目规范**:**`Read` 仓库根 `AGENTS.md` 的「设计实现规范」节与 `.github/PULL_REQUEST_TEMPLATE.md`,以现行内容逐条核对**(不要用本 skill 或记忆里的旧编号——规范条数会增改)。尤其 render/main 解耦、统一 logger、跨平台、UI 不跳变、主题 token,以及红线条(xdt-updater / 跨平台 / 优先用代码保证确定性 / throwIpcError / 主题 token / maker-core 指标 / 系统提示词 / DB migration / 凭证不入仓)。maker package 改动看 package 自己的边界规则。
2. **真实可用性**:diff 里的逻辑是否真能跑通?有没有"看起来在做但实际是空壳"(空函数、被 mock 的返回、TODO 占位、被 if(false) 屏蔽的代码)?有没有调到不存在的方法/字段?
3. **跨平台**:涉及路径、子进程、文件系统的改动,是否两端兼容(macOS/Windows)。
4. **全局关联影响分析(必查,本条最重,不准只看 diff)**:核心问题——"这个 PR 名义上做 A,但它改的东西会不会让 diff 之外的 B、C、D 也跟着出问题?"。**diff 文件只是出发点,必须顺着引用 / 数据流 / 契约走出 diff,把整仓关联方和关联功能读一遍再下结论**。系统化排查:列出"高侵入面"改动(基类 / 抽象方法、公共工具、统一 logger / storage / IPC bridge、maker package 对外 API、preload channel、DB schema、全局样式 / 主题变量、`AGENTS.md` / `DESIGN.md` 约束文件)→ 反查调用方(TS 符号优先 LSP,非符号契约 grep,每个引用点 Read 真实代码)→ 功能级关联(共享状态 / 时序假设 / 同事件 / 兄弟实现 / 数据流上下游)→ 跨进程契约(IPC 两端同步)→ 跨模块共享状态(旧数据兼容 / migration)→ 构建运行时入口 → 配置 / 环境变量 → dev vs 打包差异 → xdt-updater 红线。输出"影响面清单",对每个关联方给"仍正确 / 需同步改 / 会破坏"明确结论。**只要存在"会破坏"或"需同步改但 diff 没动",直接进步骤 3B**。
5. **副作用 / 破坏性**:是否动了共享 state、IPC 契约、DB schema、对外 API、用户配置;有无破坏向后兼容。(与第 4 条互补:第 4 条问"谁会被波及",这条问"语义层面变没变")
   - **DB migration 红线(命中 schema 源文件或 migration 目录必查——`apps/desktop/src/main/localDb/schema.ts` / `apps/desktop/drizzle/**`,对照 agent 约束「DB migration」)**:desktop 用 Drizzle/SQLite,migration 必须由生成工具产出,手写 / 手改元数据会卡死整条迁移链;另有 migration 基线约束(`drizzle/migration-baseline.json` 固定旧仓迁入 SQL 的 SHA256,数据库变化只能追加新 migration)。
     - **Drizzle(desktop)**:新增 migration 必须三件套齐全——`.sql` + `meta/_journal.json` 条目 + `meta/<idx>_snapshot.json`,由 `pnpm db:generate` 一起产出;对**已生成**的 `.sql` 改动只允许同文件内补幂等 / 注释,不得改文件名 / 序号 / meta。红旗:新增 `.sql` 没动 journal / snapshot、只改 `schema.ts` 没生成 migration、手改 `_journal.json`、序号跳号 / 重号、改历史已合入 migration。任一命中判 `[阻断]`。
   - **系统提示词红线(对照 agent 约束「系统提示词」)**:改动只要 touch 到 `packages/maker-core` 里参与拼 Claude / Codex system prompt 的代码(`MAKER_SYSTEM_PROMPT_APPEND` / `makerMemoryRules` / host 注入的 `runtimeConfig.systemPrompt` 等),description 必须有"系统提示词改动已和 Lizi 确认"或语义等同字样,缺失判 `[阻断]`。
   - **maker-core 指标红线(对照 agent 约束「maker-core 指标」)**:改动落在 prompt 组装 / tool·MCP 暴露 / translator / event loop / model 映射 / usage 计量这几条路径上,description 必须写明对缓存率 / 性能 / 返回速度 / 准确性的影响评估 + 实测结论,只写"应该不影响"不算,缺失判 `[必改]`。
   - **凭证不入仓红线(对照 agent 约束「用户凭证 / 授权信息绝不允许落入仓库工作区」)**:红旗——(a) 测试 / 脚本把 `userData` / `HOME` / `CODEX_HOME` 等路径 mock 或回落到 `process.cwd()` / 仓库内路径(如 `process.env.TEMP ?? process.cwd()`,TEMP 是 Windows 独有,macOS/Linux 直接落仓库);(b) 对 auth / token / 凭证类文件做 copy / hardlink / symlink / 落盘,目标在仓库工作区内;(c) 新增 import 即执行的模块级写盘副作用;(d) diff 里出现疑似真实密钥 / 凭证内容。任一命中判 `[阻断]`,「会被 gitignore」不是放行理由。
6. **错误处理**:边界条件、异常路径、外部依赖失败时的行为是否合理(但也注意不要为不可能的场景写冗余 error handling)。
7. **重复 / 抽象**:不能引入和已有逻辑重复的实现(对照 agent 约束「复用优先、避免重复」)。
8. **日志**:有没有 `console.log` 漏网(应走统一 logger,对照 agent 约束「日志」)。
9. **测试 / 验证**:有没有合理的验证手段(就算没单测,至少要能说清"我怎么验证过"或"我怎么验证")。

> **审查报告产出方**:上述 12 项检查由「执行方式」节中的审查子 agent 完成并按固定 markdown 格式返回报告(含「总体判断」)。主 agent **不要自己再写一份审查报告**——直接把报告原样转给用户,然后按总体判断进入步骤 3A / 3B。

## 产品 / UI 变更门(白名单人肉把关)

**背景**:Bugfix、已有功能的补充完善,自动流程可以直接审、直接合;但**牵涉产品方向 / UI 的改动**决定的是"这个产品长成什么样",必须有核心成员**人肉看过**才能进自动审查——不是不信任贡献者,而是产品品味需要收敛在少数人手里(对应 agent 约束「配置设计」里"默认配置承载创作者品味"的同一逻辑)。把关方式:请作者先在仓库提 issue 把产品思路讨论清楚,PR 暂转 draft 等讨论结果。

**白名单**:`pr-rules.json` 的 `productWhitelist`(当前 dashhuang / xdanger / magiclizi / zqchris,大小写不敏感)——**以 json 为准,本 skill 不另存名单**,增删人直接改 json。

**判定分两层(对应 agent 约束「优先用代码保证确定性」)**:

1. **确定性层(`context.mjs` 的 `productGate` 字段,直接读,不要自己推)**:
   - **豁免(`exempt=true`,任一满足即放行,连语义判断都不用做)——只认「明确同意」级别的信号**:
     - 作者在白名单(`authorInWhitelist`);
     - 白名单成员在 PR 上点过 **Approve**(`whitelistApprovals` 非空;**只认 APPROVED**——COMMENTED / CHANGES_REQUESTED 只代表「看过 / 有意见」,不代表同意推进。viewer 自动化账号的 APPROVED 可安全计入:self-approve 只发生在产品门已过、重审通过之后,时序上不可能反向豁免一个被产品门拦着的 PR);
     - 白名单成员把 PR 标回 Ready for review(`readyByWhitelist`;转 draft 的 product-hold 从不标 ready。自动化侧只有 `product-release.mjs` 会标 ready,且它只在判出「issue 里白名单已明确同意」之后执行——所以该事件无论来自人肉还是自动放行,语义都是「放行已发生」,可信)。
   - **触发器(`needsProductCheck=true`)**:未豁免,且 title type 是 `feat` 或改动命中 `uiPaths`(desktop renderer / mobile / DESIGN.md)。没触发 → 本门直接通过。
   - **讨论 issue 白名单留言(`discussionIssue`,放行主路径的确定性原料)**:PR 之前被 hold 过时非空——脚本从 PR 评论的隐藏标记定位当初开的讨论 issue,拉出其中**白名单成员的留言原文**(`whitelistComments`,含作者与时间)。留言有两个来源,脚本都已确定性处理好:① 白名单成员本人直接评论;② **Slack 同步 bot 代发**(`pr-rules.json` 的 `slackSyncBots`,当前 dash-s-cindy)——GitHub 作者是 bot、真实发言人在正文署名里,脚本按两种署名格式归属:**新版「来自 Slack #<频道> · @<GitHub login>」直接取 login**(`resolvedBy='inline-login'`,零反查);**旧版「发送者:<名字>」拿名字先查 `slackSenderAliases` 别名**(Slack 显示名与名录中文名对不上时的映射,如 Dash=dashhuang)、**再去 org 名录(`orgMappingRepos`)反查** GitHub 账号,**唯一命中且在白名单**才计入。条目带 `via: 'slack-sync'` / `sender` / `resolvedLogin` / `resolvedBy`,与本人直接评论**同等采信**(信任锚是 bot 账号本身,普通用户伪造署名行不会被归属;两种署名都没有的同步评论是 AI 机器人自己的回复,静默跳过)。归属不了的同步消息(名录没这人 / 同名多人 / 没有发送者行)进 `unattributedSlackComments`——**内容像同意表态也不得采信**,进报告 / 汇总点名让 owner 确认发送者身份;`rosterErrors` 非空 = 名录读不到、归属可能不完整,同样如实说明。`whitelistComments=null`(带 `error`)= issue 读不到(被删 / 权限 / 网络),如实进报告 / 汇总让 owner 看,**不得当「无同意」处理、也不得据此再 hold**。
2. **语义判断层(触发后由你判,两问都拿不准从严)**:
   - **第一问(`discussionIssue.whitelistComments` 非空时先问):issue 里白名单成员是否已明确同意推进?** 逐条读留言(含 `via: 'slack-sync'` 的归属条目,同等采信;Slack 条目的表态内容看 `body` 里同步正文部分),只有**明确的同意表态**(「可以推进」「同意做」「方案 OK,继续」这类)才算——单纯提问、还在讨论、有保留的部分认可都不算;`unattributedSlackComments` 里的消息无论内容如何都**不算**(身份未确认);拿不准 = 未同意。**判出同意 → 视同放行**,按原流程继续(auto 按 `auto.fallback` 走),第二问不用做;后续白名单成员在 PR 上 Approve 之前,这个语义判断每轮都会重做一次,判定口径要保持稳定。
   - **第二问:是否真属产品/UI 修改?——按产品/UI 处理,宁可多请白名单看一眼**:
     - **属「产品修改 / UI 修改」(要拦)**:新增用户可感知的产品能力 / 入口 / 页面 / 流程;改变现有交互行为、默认值、文案语义、通知或自动化策略;增删设置项;非修复性质的视觉样式 / 布局 / 组件外观 / 主题 / 动效调整;改 `DESIGN.md`。
     - **属「Bugfix / 已有功能补充」(放行)**:恢复预期行为的修复(含 UI 错位、暗色模式漏配色、i18n 补翻这类修复性改动);不改变交互模式的既有功能增强、边界补齐;纯技术改动(重构 / 性能 / 日志 / 测试 / 构建 / 文档)。

**拦截动作(= `product-hold.mjs`,确定性动作全在脚本里)**:①**自动创建讨论 issue**(替作者把 issue 开好,不让贡献者自己跑腿)→ ② 在 PR 上发评论告知作者(带 issue 链接)→ ③ 把 PR 转 draft。转 draft 后它退出普通候选池、**不会每轮反复骚扰**(auto 每轮只通过 `heldDraftResults` 静默检查 issue 是否等到了白名单同意,等到即自动放行,见「被 hold 的 draft:自动放行判定」);去重靠评论里的隐藏标记(内嵌 issue 链接),同一 PR 永远只开一个 issue、只发一次评论。issue 开失败时脚本不发评论(评论的意义就是给链接)、draft 照转,下轮自动重试。若 PR 上只有**旧版标记**(历史轮次评论过"请作者自己开 issue"、没有 issue 链接),重跑脚本会**补开 issue 并补发一条跟进评论**完成自愈——这种场景 `commentBody` 要写成简短跟进(issue 已帮开好、不用自己开了),别把首次那套完整说明再发一遍。

**文案怎么写(主 agent 拟,经 `--payload-file -` 传 JSON `{issueTitle, issueBody, commentBody}`;受「评论称呼与语气规范」约束,且本场景语气要求更高)**:

- **issueTitle**:一句话概括这个变更提案,产品视角(例:`产品讨论:设置页新增数据导出入口(来自 PR #123)`)。
- **issueBody**:替作者**客观转述**提案——从 PR title / body / 文件清单提炼:① 想解决的问题 / 场景;② PR 里的方案思路(涉及哪些产品 / UI 面);③ 需要讨论的点(你看到的产品层面疑问,如入口位置、与现有功能的关系、默认行为)。**只转述与提问,不替白名单下结论**("该不该做"留给 issue 里讨论);末尾的「关联 PR + 作者」footer 由脚本自动追加,不用写。
- **commentBody**(发在 PR 上,给作者看;issue 链接用 `{{ISSUE_URL}}` 占位——裸占位符脚本会渲染成 `<url>` 角括号 autolink,全角标点紧跟其后也不会被吞进链接;想用短文本链接就写 `[文字]({{ISSUE_URL}})`,脚本对链接目标位保持裸 URL。**不要**自己把占位符包引号 / 反引号来"防污染"):这条评论发给的是**兴致勃勃提了功能的贡献者**,措辞目标是"感谢 + 需要讨论",绝不能让对方觉得被拒之门外。硬性要求:
  - **开头必须有一处贴着 PR 实际内容的具体认可**(看得出对方想解决什么、哪里想得不错——贴事实,不空夸);
  - **说清"这不是打回"**:代码不用动、PR 内容都还在,只是产品/UI 类改动我们习惯先把产品思路对齐再进代码审查;
  - **告知 issue 已开好**:讨论 issue 我们已经帮你建好了(`{{ISSUE_URL}}`),里面整理了你这个提案的思路;**请去 issue 里补充你的想法 / 背景**,我们在那边跟你讨论;核心成员在 issue 里同意后,**流程会自动把 PR 恢复 Ready 并继续审查,你不用做任何操作**(他们直接 Approve 你的 PR 或替你标回 ready 也一样生效);
  - **解释 draft**:PR 会先转成 draft,只是暂停自动审查,不是关闭。

评论参考示例(不是死模板,按 PR 实际内容改写):

```
@<author> 这个 PR 看了，<一句贴着改动内容的具体认可，例：设置页里加导出入口这个诉求确实存在，入口位置也选得合理>。
因为它涉及产品/UI 层面的变化，这类改动我们习惯先把产品思路对齐，再进代码审查——不是打回，代码不用动。
讨论的 issue 我帮你开好了：{{ISSUE_URL}}，里面整理了这个提案想解决的问题和方案思路；有背景或想法麻烦直接补在 issue 里，我们在那边跟你讨论。核心成员同意后，流程会自动把 PR 恢复 Ready 并继续审查，你不用做任何操作（先转成 draft，内容都还在，不用重提）。
```

**飞书通知(产品讨论群 + 提交者私聊,hold 落地后的第二步)**:最终拍板的人在飞书群里,issue 开出来必须把他们引过去;提交者也同步私聊一声(邀请讨论,不是打回通知)。

- **触发与去重锚点(硬性)**:仅当 `product-hold.mjs` 返回 **`issueCreated=true`**(本轮真的新开了 issue)才发飞书通知——issue 每个 PR 只会开一次,天然保证群通知 / 私聊都**只发一次**;`alreadyHeld` 再拦截、重复转 draft 都**不发**。发送失败不自动重试(下轮 `issueCreated` 不会再为 true),把失败如实写进结果汇总即可。
- **私聊提交者(先做,结果要进群消息)**:跑 `node scripts/review-pr/resolve-author-feishu.mjs <PR_NUMBER>`——匹配键按优先级:**① PR 作者 GitHub 账号**(名录行自带 `[@login]`,不受同事用个人邮箱提交影响,主键)、② commits 的 git 邮箱(辅助)。名录走本地 clone(`~/.cindy/org-rosters/`,每次自动 pull 最新、首次自动 SSH clone,gh api 兜底——本机需能以 SSH 读这两个仓库),命中行原文在 `matched[].line`(`matchedBy=github-login` 的行优先采信)。
  - `found=true` → 用 `matched[].parsed`(脚本已按名录表格式解析出 `{githubLogin, name, email}`):**`email` 非空直接发**(`im_send_message` 走 `receive_id_type=email`),发失败再用 `name` `contact_search` 搜、唯一命中才发;`parsed=null`(名录格式变了、脚本解析不动)才读 `line` 原文语义判断。搜不到唯一匹配就当没找到处理,别乱发。
  - `found=false` → **不私聊**,原因按两种情况措辞(进群消息的附加行):`fetchErrors` 非空 = 「org 名录读不到」;否则 = 「org 名录里没找到他(GitHub 账号和提交邮箱都没匹配到)」。
  - 私聊模板:**与群通知同款 `msg_type=post` 富文本**(PR / issue 都用短文本超链接,不贴裸 URL)。传递的信息与群消息本质对齐——哪个 PR、为什么先聊、去哪聊、PR 现状与恢复条件——**只是对象不同、语气不同:私聊要比群消息更温暖、更鼓励**(这是邀请讨论,不是打回;具体认可必须贴着 PR 内容,不空夸)。**骨架只定信息结构,句子必须整体重写**:发送前把标题 + 三段连起来默读一遍,要像一个真人写给同事的话——通顺、有感情、无套话复读;**标题和正文不许复用同一句式**(反面教材:标题「你的 PR 我们看到了」+ 正文再来一句「我们看到了」);认可要说得出为什么好,谢意要真诚不客套。content 骨架(占位处全部按 PR 实际内容改写):
    ```json
    {"zh_cn":{"title":"<有温度、贴内容的标题，例：你提的 <PR 主题>，想先和你对齐下思路>","content":[
      [{"tag":"text","text":"你提的 "},{"tag":"a","text":"PR #<编号>：<PR 标题>","href":"<PR URL>"},{"tag":"text","text":" 认真看过了——<一句贴着内容的具体认可，说得出好在哪>，看得出花了心思。"}],
      [{"tag":"text","text":"因为它涉及产品/UI 层面的变化，我们习惯先把思路对齐再进代码审查，所以帮你开好了 "},{"tag":"a","text":"讨论 issue","href":"<issue URL>"},{"tag":"text","text":"，提案要点已经替你整理在里面；有想法或背景，直接回在 issue 里就行。"}],
      [{"tag":"text","text":"PR 只是暂时转成 draft——内容都在，代码一行不用动，这不是打回。核心成员在 issue 里点头后，流程会自动把 PR 恢复 Ready 接着审，你什么都不用做。期待它落地！"}]
    ]}}
    ```
- **群通知**:发到 `feishuNotify.groupName` 指定的飞书群(当前 `Cindy`;用飞书工具按群名搜 chat_id,搜不到唯一命中就把消息文本给 owner 让其自己发,别乱猜群)。**用 `msg_type=post`(富文本)发,不要用 text**——text 类型不支持「短文本挂链接」,只会把裸 URL 变成又长又丑的链接,而且 PR 行会没有链接;post 的 `a` 标签能让 PR / issue 都以短文本可点击,整条消息更短。content 按下面骨架拼(JSON 字符串;`href` 分别填 PR 页面 URL 和 issue URL,文字部分按 PR 实际内容改写):
  ```json
  {"zh_cn":{"title":"【产品讨论】<作者 GitHub 用户名> 提了一个产品/UI 改动，等你们拍板","content":[
    [{"tag":"a","text":"PR #<编号>：<PR 标题>","href":"<PR URL>"}],
    [{"tag":"text","text":"提案一句话：<从 PR 提炼的核心提案>。<半句对提案本身的中性认可，贴内容不空夸，例：思路本身是完整的>，主要是产品方向要你们定。"}],
    [{"tag":"text","text":"要对齐的点在 "},{"tag":"a","text":"讨论 issue","href":"<issue URL>"},{"tag":"text","text":" 里，去聊两句；同意推进就在 issue 里回一句（或直接 Approve / 把 PR 标回 ready），流程会自动把 PR 恢复 Ready 并继续审查，作者那边不用做任何事。PR 已转 draft，内容都在。"}]
  ]}}
  ```
  群消息语气要点:**行动指令要靠前、一眼可抓**(去 issue 聊 → 回一句同意 / Approve / 标 ready);作者多半也在群里,对提案给半句**中性认可**(克制,不到私聊的鼓励程度),别让消息读起来像"举报";**不写"不着急合"也不催**——不施压,但也别给"无限搁置"递台阶;**不 @ 任何人**(【产品讨论】前缀已够醒目,每次全 @ 只会训练大家忽略;真卡住有「再次拦截」路径点名)。
  **私聊没发成时必须追加一行**(owner 要知道作者没被触达,加到 content 末尾再补一段):`另外:没能通过飞书私聊到 <作者>(<三种原因之一>),有认识的拉他看下 issue。`
- **模式差异**:auto 模式**直接发**(这是产品门的定向邀请讨论,不适用 3B 那条「auto 不骚扰作者飞书」——那是打回场景的负反馈原则);交互模式把群消息 + 私聊消息(和收件对象)一并展示,经 AskUserQuestion 确认后才发。发送身份是当前登录用户本人,对用户口头只说「飞书」,不暴露内部工具名。

**放行与回流(状态机)**:PR 被 hold 后,放行有两类通道——**主路径(issue 同意 → 自动放行,作者全程无需操作)**:白名单成员在讨论 issue 里留言**明确同意推进**;下一轮 auto 扫描通过 `heldDraftResults` 读到该 PR(`held` 非空,draft 也在扫描范围内),你判 `discussionIssue.whitelistComments` 出「已同意」→ 跑 `product-release.mjs` 自动把 PR 标回 Ready + 评论告知(写明谁同意的),按 `auto.fallback` 继续原流程(放行后 `readyByWhitelist` 通常随之成立 → 后续轮次 `exempt=true` 走确定性豁免;若未成立,每轮语义重判一次,口径要稳定)。**确定性捷径**:白名单成员在 PR 上点 **Approve** 或亲自把 PR 标回 ready → `productGate.exempt=true`,连语义判断都不用做(PR 仍是 draft 时下一轮照样经 `heldDraftResults` + `product-release.mjs` 自动恢复 Ready)。作者**在 issue 尚无白名单同意时自己标回 ready** → 你判「未同意」且确属产品/UI → `product-hold.mjs` 再次转 draft(issue / 评论 / 飞书通知都去重、不重发),飞书汇总点名让 owner 看 issue 讨论是否卡住。PR **最终真正合并**后,讨论 issue 由 `close-product-issue.mjs` 自动关闭(带一条「已随 PR 落地」的说明评论;3A / bypass 合并后定向关,网页手动合并的由 auto 每轮 `--sweep` 兜底补关)——issue 不悬空,状态机到此闭环。

### 交互模式

1.1.5 命中时先做「issue 同意」判断:`discussionIssue.whitelistComments` 非空且判出白名单已明确同意推进 → 视同放行,向用户报告一句(谁在 issue 里同意的、哪条留言);若 PR 此刻还是被 hold 的 draft(`held.heldDraft=true`),先跑 `product-release.mjs <PR> --payload-file -` 标回 Ready(评论写明谁同意的)再回 1.2 继续,本节结束;`whitelistComments=null`(issue 读取失败)→ 如实报告、让用户定夺,不自行 hold。未同意 / 无讨论 issue,且语义定性为产品/UI 时,向用户报告(作者是谁、触发原因、issue 讨论现状、语义定性依据),AskUserQuestion:**"这个 PR 是非白名单作者的产品/UI 改动,按流程要开讨论 issue、告知作者并转 draft,怎么处理?"**,选项 `拦截(开 issue + 评论 + 转 draft)` / `这次放行,继续正常审查` / `放弃并清理本地`。选拦截 → 把拟好的 issue 标题 / 正文 + 评论草稿**一并展示给用户确认**后再跑 `product-hold.mjs`(开 issue 和评论都是对外写操作,发送前必须经用户确认);`issueCreated=true` 后接着走「飞书通知」(群消息 + 私聊草稿同样先展示、确认后才发),然后进清理章节;选放行 → 回 1.2 继续,1.7 里带一句提醒。

### Auto 模式

`auto.action=product-gate`(`isSkip=false`,轻操作)→ 主 agent 按顺序做语义判断(见「候选批处理」阶段 1):
- **`discussionIssue.whitelistComments` 非空且判出「白名单已明确同意推进」** → 视同放行,按 `auto.fallback` 的走向重新归类(汇总行带一句「讨论 issue 已获 <谁> 同意,恢复审查」;若该 PR 是 `heldDraftResults` 里的被 hold draft,先跑 `product-release.mjs` 自动标回 Ready,见「被 hold 的 draft:自动放行判定」);`whitelistComments=null`(issue 读取失败)→ 既不 hold 也不放行,跳过该候选并在汇总「未合并」组如实说明(带 issue 链接与失败原因)。
- 未同意 / 无讨论 issue,补拉 body 定性为**产品/UI** → 按上面要求拟 `{issueTitle, issueBody, commentBody}` → `node scripts/review-pr/product-hold.mjs <PR> --payload-file -`,读 `held` / `issueUrl` / `issueCreated` / `commented` / `alreadyHeld` / `drafted`,算「完整处理」占名额;**`issueCreated=true` 时接着走「飞书通知」**(先 `resolve-author-feishu.mjs` 私聊提交者,再发群消息,无需确认直接发)。飞书汇总按「自动模式结束输出」对照表写(首次 hold / 再次拦截两种措辞,都带 issue 链接,附群通知 / 私聊结果)。`issueError` / `commentError` / `draftError` 非空时如实带进汇总(下轮会自动重试)。
- 定性为 **bugfix / 已有功能补充** → 按 `auto.fallback` 的走向重新归类,当它从没触发过产品门。

## 技术架构变更门(白名单人肉把关,与产品门同机制的技术侧平行门)

**背景**:产品门管「这个产品长成什么样」,本门管「这个代码库长成什么样」——**较大的程序 / 架构调整**(改模块边界、进程间契约、核心链路重写、引入新基础设施)决定的是长期维护成本与架构一致性,必须有技术把关人**人肉看过**才能进自动审查。机制与产品门完全同构:先开 issue 把技术方案讨论清楚,PR 暂转 draft 等讨论结果。

**与产品门的三处差异(其余全部同款,产品门章节的规则不重抄、直接沿用)**:
1. **白名单**:`pr-rules.json` 的 `archGate.whitelist`(当前 magiclizi / xdanger)——以 json 为准,增删人直接改 json。
2. **触发器(`archGate.triggers`,任一命中即进语义定性;阈值在 `pr-rules.json` `archGate`)**:
   - `core-paths`:命中架构敏感路径(`corePaths`:packages/ 全部、desktop main / preload / shared、server src)的文件 diff 行数合计 ≥ `coreDiffLines`(当前 150);
   - `refactor-large`:title type 是 `refactor` 且总 diff ≥ `refactorDiffLines`(当前 400);
   - `huge-diff`:任意类型总 diff ≥ `anyTypeDiffLines`(当前 800)——兜「没标 refactor 但实际大动」。
3. **语义定性口径(第二问,拿不准从严)**:
   - **属「较大架构调整」(要拦)**:改变模块边界 / 依赖方向 / 包对外 API;改 IPC 协议、agent 事件流、DB 访问层等进程间 / 跨层契约;引入新的基础设施层、框架、存储或第三方重依赖;大规模重组目录、重写核心链路;改变跨平台 / 跨端架构决策。
   - **属「普通改动」(放行)**:局部实现优化与 bugfix(哪怕 diff 大);按既有模式新增同类功能(照现有模板加 IPC handler / MCP 工具 / 设置项);**机械性大 diff**(重命名、格式化、生成物、锁文件、i18n 文案批量、测试数据、纯测试文件)——`huge-diff` 触发器误伤的典型就是这些,识别出来直接放行。

**豁免与放行信号(口径同产品门,换成技术白名单)**:作者在 `archGate.whitelist` / 技术白名单成员在 PR 上点过 Approve(`archGate.whitelistApprovals`,viewer 自动化账号的 APPROVED 同样可安全计入——审查 approve 只发生在门已放行之后,时序上不可能反向豁免)/ 技术白名单成员亲自把 PR 标回 ready。**判定字段读 `context.json` 的 `archGate`**(`triggers` / `exempt` / `needsArchCheck` / `discussionIssue`,消费规则与 `productGate` 完全一致,`discussionIssue.whitelistComments` 已按技术白名单过滤)。**产品门优先**:`needsProductCheck=true` 时本门让位,产品门放行后下一轮再评估本门。

**拦截动作**:与产品门同一个脚本、同一套去重——`node scripts/review-pr/product-hold.mjs <PR> --payload-file - --kind arch`(marker 带 `kind=arch`,issue footer 换技术措辞;收尾复用 `close-product-issue.mjs` 定向关 + sweep,零额外动作)。文案由主 agent 拟,结构同产品门(`{issueTitle, issueBody, commentBody}`),视角换成技术:
- **issueTitle**:`架构讨论:<一句话概括调整>(来自 PR #N)`;
- **issueBody**:客观转述——① 这个 PR 动了哪些核心模块 / 契约(从文件清单与 body 提炼);② 方案思路;③ 需要对齐的技术点(依赖方向、兼容性、迁移路径、与现有架构的关系)。只转述与提问,不替把关人下结论;
- **commentBody**:同产品门的语气硬性要求(具体认可开头、说清不是打回、issue 已开好、解释 draft),把「产品/UI 思路先对齐」换成「这个体量的架构调整我们习惯先把技术方案对齐,再进代码审查」。

**飞书通知(私聊把关人 + 私聊提交者,不发群)**:`issueCreated=true` 时**飞书私聊技术把关人(`feishuNotify.archRecipientName`,当前刘佳黎)+ 私聊提交者**——机制 / 去重锚点(`issueCreated`,只发一次)/ 失败处理全部沿用产品门「飞书通知」节,但**架构门不发群**,把产品门的「群通知」整段替换成对把关人的飞书私聊:收件人按 `archRecipientName` 用飞书 `contact_search` 搜、唯一命中才发,搜不到唯一命中就不发、把消息文本写进汇总让 owner 自己看;消息内容沿用群通知骨架(`msg_type=post` 富文本、【架构讨论】前缀、PR / issue 短文本链接、认可与提问贴技术方案、不 @ 人),「私聊提交者没发成」的说明行也改为追加到这条把关人私聊末尾。私聊提交者的模板把"产品/UI 层面的变化"换成"架构层面的调整"。⚠️ 本节走向改过多次:最初「只私聊不发群」→ 后按 owner 要求改「也发群」→ **2026-07-06 owner(Lizi)明确要求改回「私聊刘佳黎替代群通知」**(架构拍板人就是他本人,发群属重复噪音)——以当前规则为准,不要按历史记忆自行回退或恢复群发。把关人私聊 / 提交者私聊失败照旧写进汇总行。

**放行与回流**:状态机与产品门完全一致(issue 同意 → 下一轮经 `heldDraftResults` 判出后 `product-release.mjs` 自动标回 Ready,作者无需操作;技术白名单 PR Approve / 亲自标 ready = 确定性捷径;未同意自行标 ready → 再次转 draft 不刷屏;合并后 issue 自动关闭)。

### 交互模式

产品门通过后 `archGate.needsArchCheck=true` 时:先判 `discussionIssue` 同意(同意 → 报告一句后继续 1.2;读取失败 → 如实报告让用户定夺);未同意 / 无 issue 且语义定性为较大架构调整 → 向用户报告(触发器、核心文件、定性依据),AskUserQuestion:**"这个 PR 是较大的技术架构调整,按流程要开技术讨论 issue、告知作者并转 draft,怎么处理?"**,选项 `拦截(开 issue + 评论 + 转 draft)` / `这次放行,继续正常审查` / `放弃并清理本地`。选拦截 → issue / 评论草稿展示确认后跑 `product-hold.mjs <PR> --payload-file - --kind arch`,把关人私聊(刘佳黎)+ 提交者私聊草稿(和收件对象)同样一并展示、确认后才发。

### Auto 模式

`auto.action=arch-gate`(`isSkip=false`,轻操作)→ 处理顺序与 `product-gate` 完全同构(见「候选批处理」阶段 1 的 arch-gate 段):issue 同意 → 按 `auto.fallback` 归类;未同意 → 补拉 body 定性;确属架构调整 → 拟文案跑 `product-hold.mjs --kind arch`,`issueCreated=true` 时飞书私聊刘佳黎(替代群通知,架构门不发群)+ 私聊提交者(机制同产品门,措辞换技术视角),算「完整处理」占名额;属普通改动 → 按 `auto.fallback` 归类。

## Workflow 待批准门(fork PR 的 CI 准入)

**背景**:对来自 public fork / 首次贡献者的 PR,GitHub 默认**不自动跑 workflow**(防恶意 PR 在 CI 里跑任意代码 / 薅 runner / 偷 secret),需要有 write 权限的人手动点「Approve workflows to run」。没人点 → required check 永远 `Expected, waiting for status` → `mergeStateStatus` 永远 `BLOCKED` → 这个 PR 在本流程里会一直卡前置门、永远推进不了。本节把那个按钮做成 API 动作。

**判定(确定性)**:`context.json` 的 `gate.workflowsAwaitingApproval` 非空(`[{id,name}]`)即命中。`gate.prTouchesCiFiles` / `gate.ciFiles` 标记该 PR 有没有改 `.github/workflows` 等 CI 配置(安全分级用)。`null`(只在 BLOCKED 时探测、且查得到才有值)→ 没探测到 / 没权限,当作无待批处理。

**安全本质(必须理解,别当成普通放行)**:approve = 放行**这个 fork PR 的代码**进 CI 跑。最高危场景是 **PR 自己改了 CI 配置**——approve 等于直接执行被改过的 workflow。所以:
- **`prTouchesCiFiles=false`(没改 CI 配置)**:相对低风险(fork PR 的 `pull_request` workflow 默认拿只读 token、无 secret),可以放行。
- **`prTouchesCiFiles=true`(改了 CI 配置)**:必须先看过那段 diff 再决定,**绝不无脑批**。

**脚本**:真批 / 探测都走 `node scripts/review-pr/approve-workflows.mjs <PR>`。它自带安全门——**改了 CI 配置时默认拒批(返回 `refused:true`、exit 2),必须显式加 `--allow-ci-changes` 才真批**(即便误调也不会在没人确认时跑被改过的 CI)。`--dry-run` 只检测不批。读返回:`approved`(已批的 run)/ `failed`(逐个失败原因,403 多为 token 缺 Actions write 权限 → 提示去网页手动点)/ `refused` / `probeError`。

### 交互模式

1.7 已报告"有 workflow 待批准"。用 AskUserQuestion 问:**"这个 fork PR 的 workflow 在等批准才能跑 CI,要我帮你点 approve 放行吗?"**
- **PR 没改 CI 配置** → 选项 `approve 放行 CI` / `先不批,我去 PR 页面看` / `放弃并清理本地`。用户选 approve → 跑 `approve-workflows.mjs <PR>`,把 `approved` / `failed` 如实回报。
- **PR 改了 CI 配置(`prTouchesCiFiles=true`)** → **先把改的 CI 文件列出来、强提示风险**,问:**"⚠️ 这个 PR 改了 CI 配置(列文件),approve 会直接执行被改过的 workflow,确定要放行吗?建议先看过 diff。"**,选项 `我看过 diff 了,确认 approve` / `先不批,我去看 diff` / `放弃`。只有用户明确确认才跑 `approve-workflows.mjs <PR> --allow-ci-changes`。
- **approve 之后**:CI 才刚开始跑,**这一轮不要急着合**——告诉用户"workflow 已放行、CI 在跑了,等 CI 过了再回来合(或我先把本地清理掉,下次重新 review 时 CI 应该已经有结果)"。是否继续做代码审查由用户定(读代码不依赖 CI,可以先审;但合并仍会被 3A 的 pre-merge-check 卡在 CI 没过上)。

### Auto 模式

由 `context.mjs` 的 `auto.action` 决定(见「候选批处理」表),无 AskUserQuestion:
- `approve-workflows`(未改 CI 配置)→ 跑 `approve-workflows.mjs <PR>` 自动放行;本轮**不 checkout、不审、不合**,approve 完进飞书汇总「未合并」组(写明已放行 CI、等 CI 跑完下轮再审)+ 清理。
- `skip-workflow-ci-change`(改了 CI 配置)→ **不自动批**(auto 不替你冒险跑被改过的 CI),跳过该候选,飞书汇总「未合并」组点名让 owner 自己去 PR 页面 approve。
- approve 失败(`failed` 非空,典型 token 缺 Actions write)→ 飞书汇总如实写明,提示 owner 手动批。

## 结构性 BLOCKED 门(永不上报结果的必需检查)

**背景**:分支保护(GitHub ruleset / classic protection)可以要求某些必需检查必须报告 success 才放行合并。如果某个必需检查门**根本不会产出结果**——典型是 org ruleset 的 `code_scanning`(CodeQL)/ `code_quality` 规则要求扫描结果上报,但该仓库压根没跑对应扫描;或某个必需 status check 的 workflow 被 job 级 `if` 跳过(`conclusion=skipped`,分支保护不把 skipped 当 success)——那么这个必需上下文永远停在 "Expected, waiting",`mergeStateStatus` **永久 `BLOCKED`**,每个 PR(无论 review 多干净)都合不进去,只能靠有 bypass 权限的人手动 "Merge without waiting for requirements"。本节把这种 BLOCKED 单独识别出来,不要误当成「作者要改」。

**判定(确定性)**:`context.json` 的 `gate.blockClass === 'structural-check'` 即命中——它的成立条件是:`mergeStateStatus=BLOCKED` + `reviewDecision=APPROVED`(review 满足)+ 无未 resolve thread + `gate.ciRuns` 里**没有** failed / pending / awaiting 的 workflow run。`gate.structuralBlock`(`{requiredCheckRules, canBypass, rulesetIds}`)给出是哪几条门(如 `["code_scanning","code_quality"]`)和当前账号能否 bypass(`canBypass=always`/`pull_requests` 表示能)。`gate.ciRuns` 是 `actions/runs` 拉到的 workflow run 分类原始数据(`check-runs` / `code-scanning/analyses` / `branches/*/protection` 在本项目 PAT 下常 403,故只用读得到的 `actions/runs` + `rulesets` 推断)。

**这不是代码问题,所以**:别走 3B 打回作者(作者没问题),也别去催 resolve(没东西要 resolve)。两条出路——

- **治标(让这个 PR 现在能合)**:有 bypass 权限(`canBypass`)时,审查通过后走 **admin bypass 合**(`gh pr merge <PR> --merge --admin`,= GitHub 网页的 "Merge without waiting for requirements")。
- **治本(否则以后每个 PR 都得手动 bypass)**:要么在仓库真正启用对应扫描(如 CodeQL default setup / code-quality 工具),让那两个门能真实报 success;要么把该仓库从对应 ruleset 的 `code_scanning`/`code_quality` 规则里豁免 / 关掉。这属于 repo 安全设置 / org ruleset 决策,**是对外动作,要和 owner(org 层 ruleset 的 owner)确认**,不要擅自改。

### 交互模式

1.7 已报告"结构性 BLOCKED"。代码审查照常做(读代码不依赖那两个门)。审查通过、进入 3A 合并时:`pre-merge-check.mjs` 会返回 `canMerge=false` + `blockClass=structural-check` + `structuralBypassAvailable=true`。用 AskUserQuestion 问:**"这个 PR 的 BLOCKED 是结构性门(列 `requiredCheckRules`)、不是代码问题;你有 bypass 权限,要我走 admin bypass 帮你合吗?"**,选项 `admin bypass 合` / `先不合,我去修那个门 / 自己在网页合` / `放弃并清理本地`。用户选 bypass → `gh pr merge <PR> --merge --admin`,如实回报结果,并**建议顺手治本**(启用扫描 / 调整 ruleset)。

### Auto 模式

`context.mjs` 根据 `structuralBlock.canBypass` 分流:
- **有 bypass 权限**(`canBypass=always`/`pull_requests`)→ `auto.action=bypass-structural-block`(`isSkip=false`):auto 模式**直接 `gh pr merge <PR> --merge --admin` bypass 合并**。安全前提已由 `context.mjs` 的 `structural-check` 分类保证(reviewDecision=APPROVED + 已跑 CI 无失败 + 0 未 resolve thread + 唯一 blocker 是永不上报的检查门)。合并后正常走 3A 评论流程,飞书汇总列入「已合并」组。
- **无 bypass 权限** → `auto.action=skip-structural-block`(`isSkip=true`):跳过该候选,飞书汇总「未合并」组点名(按「自动模式结束输出」的人话措辞:代码没问题、被必需检查设置卡住,**需要你**强制合并或调整设置)。

## 自动跟进修复(fix-handoff)——selfFixAuthors 的 PR 卡在作者侧时开跟进会话自己修

**背景与为什么**:`pr-rules.json` 的 `selfFixAuthors`(当前 magiclizi)是 owner 本人,同时也是本流程的自动化账号——GitHub 禁止对自己的 PR 提交 REQUEST_CHANGES / APPROVE(API 直接 422),3B 打回对这类 PR 根本走不通;而打回 / 催办的收件人也都是 owner 自己,没有"别人"会来修。出路:把卡点投递给一个**独立的跟进会话**(Cindy 新会话,create 时带 `use_worktree: true`,在自己的独立 git worktree 里工作,不碰主工作树),由它 checkout PR 分支、修复、push、回应 review 意见,直到 PR 能被合并。**本 session 自己始终不改 PR 代码**——审查与修复隔离在两个会话里,与「auto 模式只读不写」不冲突。

**触发条件(判定已代码化)**:`auto.selfFix=true`(`context.mjs` 按 `selfFixAuthors` 判好,大小写不敏感)**且**卡点在作者侧——具体哪几个走向改道、哪几个照旧,见「候选批处理」的「selfFix 跟进修复」段;交互模式见下面「交互模式」。

**投递机制**:handoff 走 Cindy 的会话投递工具(`mcp__lizi_xdt_helper__list_tools` 的 `handoff` 类目下的 `send_to_session`;对用户与汇总口径只说「跟进会话」,不暴露内部工具名)。绑定与去重的确定性判定全在 `fix-session-state.mjs`(状态文件 `.fix-sessions.json`,gitignored),你只管按下面顺序调:

1. **拼卡点指纹**:`fp = "<headRefOid>|<卡点类别>"`——`headRefOid` 来自 `--scan` 输出的 `meta.headRefOid`;卡点类别用 `auto.action`,唯一例外是 review 审查不通过场景用 `review-failed`(区别于「进入审查」本身)。
2. **查状态**:`node scripts/review-pr/fix-session-state.mjs get <PR> --fingerprint <fp>`:
   - `shouldDispatch=false` → 上次投递后卡点没变(跟进会话大概率还在修),**本轮不投**,汇总用「还在修,没重复打扰」措辞。
   - `shouldDispatch=true` → 继续下一步。
3. **投递**:返回里 `sessionId` 非空 → **jump**(`send_to_session` 传 `target_session_id` + 卡点消息,复用会话保留上下文);为空 → **create**(不传 `target_session_id`,**必须加 `use_worktree: true`**——host 会为新会话预建独立 git worktree 并以其为工作目录,跟进会话在自己的 worktree 里 checkout / 修复 / push,不污染主工作树、也不受本会话工作目录回收影响;工具新建专属会话并回传新 `target_session_id` 与 `worktree_path`)。
4. **回写**:投递成功后 `node scripts/review-pr/fix-session-state.mjs set <PR> --session <返回的 target_session_id> --fingerprint <fp>`。
5. **失败码处理**(都不 set,指纹未写 → 下轮同卡点自动重投):
   - `NOT_FOUND` / `ARCHIVED` / `DELETED`(绑定的会话已没了)→ `clear <PR>` 清绑定,改走 create 重试一次。
   - `WORKTREE_UNAVAILABLE`(worktree 建不出来,message 带原因,如非 git 仓库 / git 未装)→ **不要**去掉 `use_worktree` 降级重试——跟进会话没有隔离工作区就会直接改共享工作树,风险大于收益;本轮放弃,汇总里按「投递失败」措辞带上原因点名 owner。
   - `LEAD_NOT_SUPPORTED`(当前不在 Cindy 会话环境里跑,如纯 CLI)→ 静默放弃投递:skip 类候选照旧只进汇总;pushback-format / review-failed 场景**也不要退回 3B 打回**(对自己的 PR 仍会 422),汇总里按「投递失败」措辞点名 owner。
   - `AGENT_NOT_READY` / `HOST_NOT_READY` → 本轮放弃,下轮自动重试。

**投递消息模板**(create 首次投递用全文;jump 只带「当前卡点」和「要求」两段,背景省略——会话里已有)。消息必须自包含,跟进会话看不到本 session 的任何上下文:

```
你负责跟进修复 cindy-moved 仓库的 PR #<N>(<title>),目标是把它修到能被合并。
PR：<url>（分支 <headRefName>，base <baseRefName>）

当前卡点:
<逐条列,带全文:审查意见([阻断]/[必改] 条目,含 path:line 与意见原文)/ 格式问题清单 / 与主干冲突 / CI 失败的 workflow 名与失败摘要 / 未 resolve thread 的位置与意见摘要>

要求:
1. 你的会话已在独立 git worktree 里(放心 checkout,不会影响别人),但 worktree 的全量 checkout 可能仍在后台进行——先确认 `git status --short` 干净、无 index.lock 再动 git(没就绪就稍等重查)。然后用 gh pr checkout <N> 把 PR 分支拉到本地,逐条修复上面的卡点;与主干冲突就先 merge origin/<baseRefName> 解掉冲突再修。
2. 遵守仓库 AGENTS.md 的全部设计实现规范;修完跑 pnpm --filter desktop typecheck 及相关定向测试确认。
3. push 到 PR 分支;PR 上有 review thread 的,逐条回复说明改法并点 Resolve;title / description 的格式问题直接用 gh pr edit 修好。
4. 全部修完后在 PR 上留一条简短评论说明本轮改了什么。之后的自动 review 会重新审查这个 PR;如果又发现新问题,会再发消息到本会话,你继续修,直到 PR 被合并为止。
```

### 交互模式

交互式流程走到任何「该打回 / 该等作者」的分叉(1.2 格式门不过、1.7 前置门卡住、审查报告出 [阻断]/[必改])时,若作者命中 `selfFixAuthors`:**不要走 3B 草稿**,先把卡点报告给用户,然后 AskUserQuestion:**"这是 <作者> 自己的 PR,打回无效(GitHub 不允许对自己的 PR 提 REQUEST_CHANGES),要开一个跟进会话自动修吗?"**,选项 `开跟进会话自动修` / `不用,我自己处理`。用户同意 → 按上面机制投递(绑定 / 去重照走);不同意 → 只报告,不投递、不打回。

### Auto 模式

按「候选批处理」的「selfFix 跟进修复」段自动改道投递,无需确认;汇总措辞按「自动模式结束输出」对照表的四条 selfFix 行写。**闭环**:跟进会话修完 push → PR head 变化 → 下轮扫描指纹变化重新分类(审查通过即合并;又有新问题则 jump 投新卡点给同一会话)→ 直到合并;合并 / 关闭后由「跟进会话绑定收尾 sweep」清绑定。不设「最多重试 N 次」硬闸——每轮投递的前提是 PR 有新动静(指纹变化),天然限速;owner 每轮都能从飞书汇总看到该 PR 的进展,觉得空转随时人工介入。

## Server 发布通知 gate(审查结论出来后、分流 3A/3B 前必查)

**判定(确定性)**:`context.json` 的 `format.hitsServer=true` 即「牵扯 Server 代码」(命中文件清单在 `format.serverFiles`;路径前缀 = `pr-rules.json` 的 `serverPaths`)。⚠️ **本仓服务端已拆至独立的 `cindy-server` 仓,`serverPaths` 当前为空数组,本 gate 在本仓恒不触发**——机制保留,未来本仓重新出现 server 面路径时往 `serverPaths` 补前缀即可生效。`hitsServer=false` 直接跳过本节。`auto.selfFix=true` 也直接跳过——这道 gate 的目的是「作者通知到 Lizi 本人」,而 selfFixAuthors 的 PR 作者就是 Lizi 自己,无需自我通知(打回也会 422)。

**背景**:server 代码不随桌面端自动分发,需要 Lizi 本人在发布时手动部署;新增环境变量也要 Lizi 在服务器上配置。所以含 server 改动的 PR **合并前必须由作者通过飞书通知到 Lizi 本人**:① 发布时需要同步发布服务器代码;② 如有新增环境变量,**私聊**把变量告诉 Lizi(值可能是 secret,不要公开写在 PR 上)。这道 gate 确认的是「作者已经通知过 Lizi」,不是由本流程代发通知。

**执行**:

1. **查作者是否已声明通知过(语义判断)**:读 description / 普通评论 / review thread,找**作者本人**的明确声明(如「已飞书通知 Lizi server 发布」「环境变量已私聊 Lizi」;只写「已通知」但没说通知谁 / 通知了什么的,拿不准就按未声明算)。**已声明 → gate 通过**,按审查结论正常进 3A / 3B,本节结束。
2. **未声明 → 本轮强制走 3B 打回**(哪怕代码审查零问题):在打回 review 的 `comments[]` 里加一条 `[阻断]` 意见,锚到 `serverFiles` 中最有代表性的改动行,内容:
   - 本 PR 改动了 server 代码(列 `serverFiles` 摘要),合并前请先**通过飞书通知 Lizi 本人**:发布时需要同步发布服务器代码;
   - **新增环境变量**:由你从 diff 确定性提取(新增的 `process.env.XXX` 读取 / server 面 config 新增字段 / `.env.example` 新增行),有就列出变量名,要求作者**私聊**把变量名 + 取值告诉 Lizi;没有就写明「本次无新增环境变量,只需通知发布」;
   - 通知完成后**在本 thread 回复「已飞书通知 Lizi」并点 Resolve**,下一轮 review 据此放行。
   - 若代码审查本身通过,review `body` 要写明:「代码本身没问题,只差 server 发布通知确认——飞书通知 Lizi 并 resolve 这条后即可合并」,避免作者误以为代码被打回。
3. **后续轮次(机制复用现有 thread-resolve 流程,无特例)**:作者 resolve 该 thread 前,前置门(1.6.5)自然卡住;resolve 后照常走重审 / auto 的 self-approve 解死锁路径。**重审时必须核实该 thread 里作者真的回复了「已通知 Lizi」**——只点 Resolve 不回复 = 红旗,按步骤 2 第 0 条「标 resolved 但没处理」处理,不放行。
4. **模式差异**:交互模式打回前照旧把草稿给用户拍板(3B 第 3 步);auto 模式自动提交(算「完整处理」),飞书汇总「未合并」行写明,例:`[PR #21:xxx](url) — 代码审查通过,但含 server 改动、作者还没飞书通知你发布事项,已打回要求作者先通知(发布 server 代码;新增环境变量 FOO_API_KEY 需私聊给你)`。

## 步骤 3:分支处理

根据总体判断分两条路。**注意:`可以合` 也要先过上面的「Server 发布通知 gate」——`format.hitsServer=true` 且作者未声明已通知 Lizi 时,一律转 3B 打回,不进 3A。**

### 3A. 可以合 → 用户最终确认后走合并流程

用 AskUserQuestion 问:**"代码审查通过,要现在合并并发评论给作者吗?"** 给 `合并并评论` / `先不合,我再想想` 两个选项。

用户同意后:

0. **(仅 auto 模式 + `auto.needsSelfApproval=true`)先撤掉自己挂的 CHANGES_REQUESTED**:这种 PR 的 `BLOCKED` 唯一来自本流程账号自己之前的 CR(见「候选批处理 / self-approve 解死锁」)。**仅当重审已通过(零 `[阻断]`/`[必改]`)** 才走本步——用**同一账号**重新提交 APPROVE 覆盖掉自己的旧 CR,解除 BLOCKED。

   > → 跑 `node scripts/review-pr/self-approve.mjs <PR_NUMBER>`,读 `approved`。脚本**自带安全核验**(BLOCKED + reviewDecision=CHANGES_REQUESTED + 所有 CR 都是 viewer 自己的 + 0 条未 resolve thread,任一不满足返回 `approved:false`+`reason`、exit 2 拒绝):即便误调也不会替别人撤 review / 不会在 thread 没 resolve 时放行。「重审是否通过」由你(上一步已确认)负责,脚本不重复判。`approved:false` 就别往下合,把 `reason` 如实带进汇总。下面命令块是脚本内部等价逻辑(兜底)。

   ```bash
   gh pr review <PR_NUMBER> --repo <OWNER>/<REPO> --approve --body-file - <<< "重审通过:此前 request-changes 的问题已处理,所有 conversation 已 resolve。"
   ```
   提交后 GitHub 要几秒重算 `reviewDecision`(→ `APPROVED`)和 `mergeStateStatus`(→ 一般 `CLEAN`),**等几秒再跑下面的 pre-merge-check**;若它仍报 `mergeableUnknown` 就再等一次重查。交互模式 / 非 `needsSelfApproval` 的 PR **跳过本步**。

1. **合并 PR**(走 gh,不要本地 push):

   **合并前先做一道状态复核(确定性 gate,先查再合)**:

   > → 跑 `node scripts/review-pr/pre-merge-check.mjs <PR_NUMBER>`(已把"GitHub 可合状态"+"所有 thread resolve 复核"两件事一起做)。读 `canMerge`:`true` → 普通合并(下面命令)。`false` → **先看 `blockClass` 再决定**:
   > - **`structural-check` 且 `structuralBypassAvailable=true`**(review + 已跑 CI 都过、只卡在 `code_scanning`/`code_quality` 这类永不上报的必需检查门,且当前账号可 bypass)→ 这是「需要 admin bypass 才能合」的正常情况,**不是真有问题**。**交互模式**:把"这条 BLOCKED 是结构性门(列 `structuralBlock.requiredCheckRules`)、不是代码问题、要走 admin bypass 合"如实告诉用户,用 AskUserQuestion 确认后走下面的 **bypass 合并**(`gh pr merge --admin`)。**auto 模式**:直接 `gh pr merge --admin` bypass 合并(见决策表 `bypass-structural-block`)。
   > - **其它 `blockClass`**(`ci-failed` 真失败 / `ci-pending` 还在跑 / `review-changes-requested` 要作者改 / `threads-unresolved` 要 resolve / `conflict` 冲突)→ **一律别 bypass、别合**,把 `blockers` / `unresolvedThreads` / `mergeableUnknown` 如实告诉用户、问是否继续。
   >
   > **(仅交互模式)语义冲突拦截**:`canMerge=true` 后、真正合并前,若 1.4 已在主树 checkout PR 分支,跑 `node scripts/review-pr/typecheck-merged.mjs <PR_NUMBER>`(模拟 merge origin/main 后对合并结果 `tsc --noEmit`,跑完自动还原工作树;拦「PR 分支和最新 main 各自都没问题、合完编译炸」的跨文件语义冲突)。读结果:`pass=false` 且 `mergeConflict=true` → 按冲突处理(别合,如实告知);`pass=false` 且 `errors` 非空 → 把前几条错误给用户看,说明「合并后类型检查会炸,多半是该 PR 开出后 main 又合入了相关改动」,由用户拍板(让作者更新分支 / 仍要合);`ok:false`(脚本自身跑不了,如 tsc 缺失)→ 如实说明后继续,不阻断(fail-open)。auto 批处理主树不 checkout PR 分支,本步不适用——auto 的兜底是阶段 3 第 5 步的「合并后 main 健康检查」(`--current`)。
   >
   > 下面命令块是脚本内部等价逻辑(兜底)。

   ```bash
   gh pr view <PR_NUMBER> --repo <OWNER>/<REPO> --json state,mergeable,mergeStateStatus \
     --jq '"state=\(.state) mergeable=\(.mergeable) status=\(.mergeStateStatus)"'
   ```
   - `state != OPEN` / `mergeable=CONFLICTING` / `mergeStateStatus` 为 `DIRTY`(冲突)或 `BLOCKED`(分支保护、CI 未过)→ **先别合**,把状态如实告诉用户、问是否继续。
   - `mergeable=UNKNOWN`(GitHub 还在算)→ 等几秒重查一次;仍 UNKNOWN 就如实说"冲突状态计算中",由用户定夺是否硬合。
   - **再复核一次所有 conversation 已 resolve(对应 1.6.5 通过标准第 1 条,双保险)**:重跑 1.5.2 的 `reviewThreads` GraphQL,确认 `isResolved=false` 的 thread 数为 0。**只要还有一条没 resolve(哪怕是 bot / codex connector 发的)→ 先别合**,把未 resolve 清单列给用户,问"这些 conversation 还挂着,确定要合吗 / 还是先去 resolve"。审查阶段(步骤 2 第 0 条)处理过的 reviewer 意见,这里一并确认对应 thread 都已 resolve。
   - 状态 OK 再执行合并。**合并前先回写 `code-review` commit status**(让 branch protection 的 required check 对 fork PR 也能被满足):

   ```bash
   # 回写 code-review 状态(合并前必做,fork PR 的 CI 会 skip,靠这步补上)
   SHA=$(gh pr view <PR_NUMBER> --repo <OWNER>/<REPO> --json headRefOid --jq .headRefOid)
   gh api repos/<OWNER>/<REPO>/statuses/$SHA \
     -f state=success \
     -f context="code-review" \
     -f description="Reviewed and approved via /review-pr"
   ```

   回写失败(如 token 缺 `statuses` 写权限)不阻断合并——如实告诉用户"status 回写失败(<原因>),合并本身不受影响,branch protection 如果卡在这要手动处理"。

   然后执行合并:

   ```bash
   gh pr merge <PR_NUMBER> --repo <OWNER>/<REPO> --merge   # 默认 merge commit;按需 --squash / --rebase
   # 结构性 BLOCKED 且用户已确认 bypass(见上)→ 加 --admin 绕过永不上报的必需检查门:
   #   gh pr merge <PR_NUMBER> --repo <OWNER>/<REPO> --merge --admin
   # 兜底 curl:
   curl -sS -X PUT -H "Authorization: Bearer $(gh auth token)" -H "Accept: application/vnd.github+json" -H "X-GitHub-Api-Version: 2022-11-28" \
     "https://api.github.com/repos/<OWNER>/<REPO>/pulls/<PR_NUMBER>/merge" \
     -d '{"merge_method":"merge"}'
   ```
   确认成功(gh 无报错;curl 看返回 `"merged": true`)。失败把 GitHub 返回的 error 原样告诉用户(常见:冲突、CI 未通过、分支保护、权限不足)。**`--admin` 仅用于 `structuralBypassAvailable=true` 的结构性门、且用户已明确确认**;`ci-failed` / `review-changes-requested` 等真 blocker **绝不**用 `--admin` 硬合。

   合并确认成功后,**跑 `node scripts/review-pr/close-product-issue.mjs <PR_NUMBER>` 收尾产品门讨论 issue**:若这个 PR 曾被「产品 / UI 变更门」拦截,PR 评论里会有隐藏标记指向当初开的讨论 issue,脚本读标记 → 给 issue 发一条「已随 PR 落地」的说明评论并关闭;幂等——没标记(非产品门 PR)/ issue 已关都是 no-op,交互 / auto 模式都做、无需确认(关闭动作与评论文案已代码化)。读返回:`closed=true` → 在 1.7 汇报 / 飞书汇总的该 PR 行末带一句「产品讨论 issue 已自动关闭」;`closeError` 非空 → 如实报告(auto 模式下轮 sweep 会自动补关)。

2. **生成给作者的评论**(中文,人话,不要技术黑话堆砌)。**结构按下面分块组织**,缺的块直接跳过、不要硬凑:

   **① 合并结果**(1 句):告诉作者已经合了。

   **② 合并决策的原因**(1-3 句,必写):明确告诉作者**为什么这个 PR 通过了审查**——从产品视角和技术视角各说一点:
   - **产品/场景视角**:这个改动解决了什么实际问题、谁会受益、用户感知到的变化(例:"Windows 用户首次安装的闪退修了" / "草稿自动保存覆盖了 99% 用户最高频的诉求")
   - **技术视角**:为什么这个实现可接受(例:"改动落在 maker package 内部,没破坏对外契约" / "用了已有的 logger / IPC 通道,没引入重复抽象" / "跨平台路径走 path.join,Mac/Win 都验证过")
   - 不要堆形容词,直接说事实
   - **如果有具体可夸的点**,可以带一句**贴着代码事实**的认可,这是温度的主要载体——例:"这块边界处理比我担心的要细"。但**必须有具体根据**,不要空夸。
   - **如果这个 PR 经历了多轮评审**(1.5 历史里有未解决 thread 后被这次/前几次 commit 处理掉),用一句话承认作者的迭代,例:"上一轮提的 X 这次改完了,合并",不要装作没看见历史。

   **③ 我帮你修了哪些(可选,但只要有就必须写,不能藏)**:如果审查中你(reviewer)改了 PR 的代码再合,**必须**披露:修了什么(具体到文件 + 一句话)、为什么这么修(对应原 PR 什么问题)、让作者 review 你改的部分有异议直接说。例:`审查时我顺手把 xxx.ts:142 的路径拼接改成 path.join,原写法在 Windows 上会拼出非法路径。麻烦你也看一眼。` **没有任何代码改动就整个跳过,不要写"无修改"凑字数。**

   **④ 后续建议(可选)**:基于这个功能你看到的**进一步可做的事**,以建议方式提,**明确标注是 follow-up、不是本次必改**。代码向(可优化点 / 可抽象的重复 / 可补的测试 / 可加固的边界)或产品向(能延展的能力 / 体验改进)都行。每条用"后续可以考虑..." / "follow-up 想法:..."这种弱措辞,**不要命令式**。审查时发现的"建议改但不阻断"的点也归这里。没有就跳过。

   **⑤ 收尾**(1-2 句):一句行动项 / 一句人味结束。例:`先合了,有疏忽再补 issue,辛苦`。**称呼与语气受"评论称呼与语气规范"那一节硬约束**——不要油腻,不要堆叠夸赞,但允许一点人味,不要冷到像机器人通知。

   **格式注意**:不要复述 diff / 不要列文件清单(除非 ③ 披露你自己的改动);不要复述 PR description 里已写过的内容;全文控制在合理篇幅(纯合并通常 4-6 行,带 ③ 或 ④ 时可到 8-10 行,每块言之有物)。

3. **发评论**:
   ```bash
   gh pr comment <PR_NUMBER> --repo <OWNER>/<REPO> --body "<评论内容>"
   # 兜底 curl:
   curl -sS -X POST -H "Authorization: Bearer $(gh auth token)" -H "Accept: application/vnd.github+json" -H "X-GitHub-Api-Version: 2022-11-28" \
     "https://api.github.com/repos/<OWNER>/<REPO>/issues/<PR_NUMBER>/comments" \
     -d "$(jq -nc --arg body "<评论内容>" '{body:$body}')"
   ```

4. **同步本地主干**:由清理章节的 `cleanup.mjs --sync-main` 一并完成(它会切默认分支 + `git pull --ff-only`),这里不单独做。

5. 跳到 **清理章节**(合并成功 → 记得带 `--sync-main`)。

### 3B. 不应合 / 需要大改 → 提交 REQUEST_CHANGES 的 PR review(每条意见尽量成可 resolve 的 thread),用户拍板

> **先查作者**:作者命中 `selfFixAuthors`(`auto.selfFix=true`)的 PR **不进本节**——GitHub 不允许对自己的 PR 提交 REQUEST_CHANGES(422),打回给 owner 也等于打回给自己。改走「自动跟进修复(fix-handoff)」。
>
> **为什么打回用 PR review 而不是普通评论**:打回意见要成为带 `isResolved` 状态的 **review thread**,作者逐条改完 / resolve 后,下次 re-review 直接用 1.6.5.2 的布尔判定就知道"解决了没"——所有"未解决 → 不继续"的判定统一成一套逻辑。普通 issue comment 没有 resolve 状态,**只用于真正合并成功后的总结(3A),不用于打回**。

打回走 GitHub PR review 机制(`POST /repos/<OWNER>/<REPO>/pulls/<PR_NUMBER>/reviews`),一个 review 由两部分组成:
- **`comments[]`(行级评论)**:每条 attach 到 `path + line`,在 GitHub 上各自成为一个**可 resolve 的 review thread**——**问题清单里能定位到代码行的意见,全部放这里**。
- **`body`(总述)**:review 顶部一段话,**不是**可 resolve thread——放 ① 结论 / ③ 整体方向 / ④ 收尾,以及少数**定位不到具体行**的意见。
- **`event`**:用 `REQUEST_CHANGES`(GitHub 原生"打回"语义,显示 changes requested,配合分支保护能直接挡合并)。

1. **把审查报告的打回清单拆成 review 的两部分**:

   **A. 行级评论 `comments[]`(问题清单主体,逐条 → 可 resolve thread)**

   报告里每条 `[阻断]` / `[必改]` 意见 → 一条行级 comment;位置由 `path:line` 本身承载,body 含三件套:
   - **等级**:`[阻断]` / `[必改]`,放 body 开头方便扫读
     - `[阻断]` — 不改不能合(线上崩、数据丢、跨平台跑不起来、破坏核心契约、安全/权限漏洞、xdt-updater / 系统提示词红线)
     - `[必改]` — 不阻断流程但本次必须修(明显 bug、规范违反、影响面没处理干净、调用方没同步)
   - **影响**:产品/场景语言说"如果不改,什么时候会出什么后果"(例:"Windows 用户首次启动会闪退"),不要只甩技术名词
   - **建议改法**:具体可执行的方案,并加一句**"这只是参考,你也可以走自己的方案,只要解决上面那个影响就行"**——把决定权留给作者

   **锚定规则(让尽量多的意见成 thread)**:
   - 意见本来就指向某行 → 直接 attach 到那行。
   - 意见是"整体性"的(缺测试 / 缺某文件 / 方向),但能找到一个**最相关的改动行** → 锚到那行,body 里点明"这条是整体意见:…"。
   - 实在锚不到任何 diff 行的(纯 PR 元数据,如 title / description 格式不合规)→ 放进 `body` 总述(见 B),**不**硬塞行级。

   **行级 comment body 示例**(给模型参考,不是死模板;位置已由 path:line 承载,body 不再重复写文件名):
   ```
   [阻断] 这里直接用 `/` 拼路径。
   影响:Windows 上 spawn 子进程会拼出非法路径,客户端启动就崩。
   建议:换成 `path.join(app.getPath('userData'), 'xxx', String(n))`。这只是参考,你也可以走自己的方案,只要 Windows 下能正常 spawn 就行。
   ```

   **B. review `body`(总述,非 thread)**
   - **① 结论**(1 句):明确这次不能合,是"必须改完才能合"还是"想再讨论一下方向"。
   - **③ 整体方向**(可选,1-2 句):思路本身要再对齐时点一下,并建议作者先和谁对齐。没有就跳过,**不要凑字数硬加**。
   - **④ 收尾**(1-2 句):一句行动项 + 可选一句人味(例:`麻烦改一版,改完再扔给我`)。**称呼与语气受"评论称呼与语气规范"硬约束**——不油腻、不堆叠夸赞,但带一点温度。
   - **锚不到行的少数意见**(如格式门 title / description 问题):在 body 里列清楚,并说明"这几条不在某一行上,改完我下次 review 会确认"。

   **整理规则(沿用 1.5 + 步骤 2-0 的历史规则)**:列的每条先和历史比对——之前讨论过且达成共识的**不重复列**;之前提过但 diff 没解决的,点明"原 thread X 还挂着";认同别的 reviewer 已提的点就引用,不要假装是新发现。

2. **自检**:提交前确认每条行级意见齐了"等级 + 影响 + 建议改法"(位置由 `path:line` 承载),缺项补全;再过一遍"评论称呼与语气规范"的 checklist。

3. 把草稿(review `body` + 每条行级 comment 的 `path:line` + body)原样展示给用户,**问 AskUserQuestion**:`提交这份 review(REQUEST_CHANGES)` / `我来改改再发` / `先不发,只本地放弃`。

4. 用户选提交,就调 GitHub PR review API:

   ```bash
   # 行级 comment 较多时,用 --input 传整个 JSON payload 最稳(line 用新文件 RIGHT 侧行号)
   cat <<'JSON' | gh api -X POST "repos/<OWNER>/<REPO>/pulls/<PR_NUMBER>/reviews" --input -
   {
     "event": "REQUEST_CHANGES",
     "body": "<总述:①结论 / ③方向 / ④收尾 / 锚不到行的意见>",
     "comments": [
       {"path": "<文件路径>", "line": <行号>, "body": "[阻断] …影响…建议…"},
       {"path": "<文件路径2>", "line": <行号2>, "body": "[必改] …"}
     ]
   }
   JSON
   ```
   - `line` 用**新文件(RIGHT 侧)**行号;意见落在被删除行时该条加 `"side": "LEFT"`。行号对不上 GitHub 报 422——把该条降级进 `body` 总述,别卡住整份 review。
   - 没有任何行级 comment(纯格式门打回)→ 退化成只发 `body` 的 review:省掉 `comments`,仍用 `"event": "REQUEST_CHANGES"`。
   - 提交成功确认:返回 JSON 的 `state` 为 `CHANGES_REQUESTED`。
   - **提交成功后回写 `code-review` commit status 为 failure**(让 branch protection 明确标记该 PR 审查未通过):
     ```bash
     SHA=$(gh pr view <PR_NUMBER> --repo <OWNER>/<REPO> --json headRefOid --jq .headRefOid)
     gh api repos/<OWNER>/<REPO>/statuses/$SHA \
       -f state=failure \
       -f context="code-review" \
       -f description="Changes requested via /review-pr"
     ```
     回写失败不阻断流程(REQUEST_CHANGES 本身已挡住合并),如实告诉用户即可。

5. **(打回 review 已提交后)询问是否同步从飞书通知作者**:只有当第 3 步用户选了"提交这份 review"、且 review 已提交成功后才走这一步——没提交就**跳过本步**,直接进入清理章节。
   - 用 AskUserQuestion 问:**"打回 review 已提交,要不要我同步生成一段飞书消息、通知作者去看?"**,给 `生成并发飞书通知` / `不用,只留 PR review` 两个选项。
   - 用户选"不用" → 跳过,进入清理章节。
   - 用户选"生成并发" → 按下面「飞书通知作者操作细则」执行。

   **飞书通知作者操作细则**:
   - **消息内容**:短、人话、产品视角,只是"提醒去看 review",不要把整份问题清单搬过去。结构 =(1)一句"你的 PR #<PR_NUMBER>（<title>）我看了，这次先没合";(2)1-2 句最关键的打回原因(从问题清单挑等级最高的 1-2 条,用产品 / 场景语言说,别堆技术名词);(3)"细节我写在 PR review 里了：<url> 方便时看下回我一下"。**全文受本文件「评论称呼与语气规范」约束**。
   - **找收件人(已知坑,按序尝试)**:走项目内置的已鉴权飞书 MCP 工具集(`mcp__lizi_feishu__list_tools` / `mcp__lizi_feishu__call_tool`;对用户口头只说"飞书",不要暴露 `lizi_feishu` 实现名)。
     1. 如果已知作者邮箱,可以跳过搜人,后续直接用 `im_send_message(receive_id_type=email)` 发;否则用 `contact_search` 按**作者中文名**(PR `author` 对应的真实姓名)搜。⚠️ `contact_search` **只做姓名模糊搜、不支持按邮箱查**。
     2. 搜到唯一匹配 → 取 `open_id`;搜到多个 → 用 AskUserQuestion 让用户选(列 name + 部门 / 邮箱辅助区分)。
     3. 姓名搜不到 → **不要硬翻群聊去捞 open_id**(既慢又越界)。直接告诉用户"飞书没自动搜到 <作者名>",给两条出路:**(a)** 用户提供作者的邮箱,用 `receive_id_type=email` 直接发;**(b)** 用户提供作者的 `open_id`(`ou_` 开头);**(c)** 把拟好的消息原文给用户、让其自己在飞书发。
   - **发送前确认(硬性)**:`im_send_message` 是**以当前登录用户身份**发出(对方看到的是你本人,不是 bot),属于写操作。拿到 `open_id` 或邮箱后,把"发给谁(name/邮箱)+ 消息全文"展示给用户,再用 AskUserQuestion 确认一次,确认后才真正调 `im_send_message`(`msg_type=text`,`content` 传纯文本;邮箱走 `receive_id_type=email`)。用户不确认就不发。
   - **发完回执**:成功 → 告诉用户已发给谁;失败 → 把错误如实说,并把消息原文给用户兜底自己发。

6. 不论是否提交 review / 是否发飞书,都跳到 **清理章节**。

## 清理章节(任何路径结束前必走)

> **锁释放是这一章节的硬指标**:不论走 `cleanup.mjs` 还是只调 `release-lock.mjs`,**只要本轮拿到过锁(`prepare.mjs` 返回 `lock.acquired=true`),结束前必须有一次成功的释放动作**——漏掉会让下一轮 scheduler 触发被你卡住、等满 60 分钟 TTL 才能跑。
>
> → 跑 `node scripts/review-pr/cleanup.mjs --original <最初分支>`(最初分支来自环境准备的 `currentBranch`),按路径加参数:
> - 走到过 1.4 **主树** checkout 的(交互模式 / Codex 串行批处理的代码审查 / 打回 / 放弃)→ 加 `--pr <PR_NUMBER>` 删本地 `pr-<PR_NUMBER>`(脚本会先验存在,不存在自动跳过)。
> - **合并成功 ≥1 个**(3A)→ 再加 `--sync-main`,脚本切默认分支 + `git pull --ff-only` 同步主干。
> - 格式门 1.2 就被打回、没 checkout 的 → 只给 `--original`,不加 `--pr`。
>
> 读 `currentBranch` / `clean` / `deletedBranch` / `mainSynced` / **`lockReleased`**(必须为 `true`,为 `false` 说明锁早已被释放或不存在,通常 OK;但本轮明明拿过锁却返 `false` 要警惕),告诉用户当前在哪个分支、是否干净、主干有没有同步。
>
> **特殊情况**:本轮根本没走到 1.4(典型:auto 模式候选全跳但起始是格式门 1.2 就打回的、prepare 失败后已 release 等),这一节其实没事可做——`cleanup.mjs` 的 git 操作都跑空。这种情况**直接调 `node scripts/review-pr/release-lock.mjs`** 释放锁即可,不必硬跑 cleanup。
>
> 下面是脚本内部等价逻辑(兜底)。

1. `git checkout <最初记录的分支>`(回到用户原本所在的分支)
2. `git branch -D "$PR_BRANCH"` 删本地 PR 分支(`PR_BRANCH` 来自 1.4;若本次在格式门 1.2 就被打回、没走到 1.4 checkout,则本地没建分支,跳过本步)
3. 如果之前 fetch 过临时 remote ref,也清掉
4. 最后再跑一次 `git status` 确认干净,告诉用户当前在哪个分支、是否最新

## 评论称呼与语气规范(给 PR 作者的所有文字都受此约束)

**目标**:像一个平等的同事在 review,不是粉丝在彩虹屁,也不是甲方在挑刺。**同时也是一个愿意承认对方下功夫的同事**——看到具体的好处、看到作者迭代过、看到边界考虑到了,就直接说出来,只是要**贴着事实说**,不要堆形容词。冷冰冰甩结论也不是这里要的风格。

**标点(硬性)**:所有发给真人的中文文案(GitHub 评论 / issue 正文 / 飞书群消息与私聊)一律用**中文全角标点**(， 。 ； ： ？ ！ （）),不要英文半角的 , ; : ? ! ( )——满篇英文逗号是"机器味"的最大来源之一。注意:**本 skill 文档自身与代码注释里的半角标点是仓库排版惯例,不要照抄进对外文案**;技术 token(命令、路径、`PR #123`、URL)保持原样,不在转换范围。

**链接(硬性)**:GitHub 评论 / issue 正文里贴链接,只允许两种形态——markdown 短文本链接 `[文字](url)`,或角括号 autolink `<url>`。**禁止裸 URL 直接嵌进中文句子**:上一条标点规则要求全角标点,而 GitHub 的裸 URL 自动链接不把全角标点当边界,`https://…/issues/714，后面的中文` 会把逗号和后文整段吞进超链接(线上实踩过)。裸 URL 只有后面紧跟半角空格 / 换行 / 行尾时才安全,别赌这个——统一用前两种形态。`{{ISSUE_URL}}` 占位符不受此限(product-hold / product-release 脚本替换时已按此规则自动处理)。

### 称呼

- **默认直接用作者英文 handle 或中文名**,不加任何修饰词或敬语。例如:`@zhangsan` / `LiziM` / `张三`,**不要**`@张三大佬` / `亲爱的 @张三` / `张三同学` / `张三老师` / `张三哥`。
- 如果开头不想直接喊名字,可以用一句陈述句开场(`这个 PR 看完了` / `合并完成`),**不要**用"Hi/Hello/嗨"等寒暄。
- 不要用第三人称客套(`感谢作者的辛勤付出`)——直接第二人称 `你`。

### 用词黑名单(出现即视为油腻,必须删掉重写)

- 称谓类:大佬、大神、老师、巨佬、dalao、师傅、哥/姐(用于称呼对方时)
- **空夸 / 堆叠夸赞**类(关键词:**没有指向具体事实**的形容词):辛苦付出、非常感谢、十分感谢、由衷感谢、太棒了、太厉害了、写得真好、非常细致、考虑周全、思路清晰、点赞、赞一个、给力、666、nice、awesome、🙏 / ❤️ / 🎉 / 👍 等讨好向表情符号
- 寒暄类:您、贵 PR、拜读、拜读了、学习了、受教了
- 凑字数的虚词:首先、其次、最后(用于客套段落)、总的来说、整体而言(用于纯赞美段)

**重要区分**:黑名单针对的是**空夸 + 堆叠 + 煽情**(`非常感谢您的辛勤付出` / `辛苦了大佬` / `思路清晰考虑周全`),不是禁止一切正向表达。
- 单句"谢了 / 感谢 / 辛苦了"作为收尾是可以的
- **贴着代码事实的正向反馈是鼓励的**:`这块用 X 处理得挺巧` / `边界情况想得比较细` / `看 diff 改了几轮,体会到了`——这种**说得出根据**的夸不算油腻,反而是温度的来源
- 功能向的简单符号(如 `✅` 表示"已确认")不在禁用之列;讨好向的(`🙏 / ❤️ / 🎉 / 👍`)继续禁

### 用词正例

**陈述结论 / 平铺事实**:
- `合并了` / `合并完成,改动看下来 OK`
- `这个改动解决了 X,逻辑没问题`
- `有一点想提一下:...`(代替"有个小小的建议想跟您探讨一下")
- `麻烦改一版` / `这块想再确认下` / `辛苦再看看`(代替"麻烦您拨冗修改")

**有指向的正向反馈(温度的主要来源,看到了就说)**:
- `这块用 X 处理得挺巧,比我想到的方案干净` ← 贴着代码说,有比较
- `边界情况想得比较细,Y 这种 case 我一开始没注意到` ← 具体到 case
- `看 diff 改了几轮,体会到了` / `上一轮提的 X 这版处理掉了,挺好` ← 承认迭代过程
- `跨平台这块从一开始就分开考虑了,不用我再提` ← 指出做对的事
- `命名挺清楚,跟过来不费劲` ← 体验类反馈也算具体

**收尾**:
- `先这样` / `就这些` / `先合了,有疏忽再补 issue` ← 干脆型
- `辛苦` / `辛苦改一版,改完再扔给我` / `谢了,这版应该没问题了` ← 带一点人味的短句也行,只要不堆叠

### 篇幅

- **合并评论**:4-6 句为佳,留出空间装"合并原因 + 一句具体认可 + 收尾"。允许极短分段,**不要列 bullet,不要分小标题**。
- **打回评论**:开头 1 句陈述结论 + 中间具体问题(可以分点) + 结尾 1 句行动项。**总长度不超过 8 行**,不要堆背景。打回评论本身就要克制,温度主要靠"建议改法"那句"这只是参考"和收尾的人味来体现,不要在问题清单里掺夸。

### 自检 checklist(发评论前必过)

起草完先自己读一遍,任一条命中就重写:

1. 有没有出现上面黑名单里的任何一个词?
2. 有没有**连续两句空夸**?(连夸即油腻——注意是"空夸",贴着具体代码事实的正向反馈不算)
3. 把称呼换成"同事 A"读,有没有觉得过分客气或过分肉麻?
4. 如果作者就是你自己,你看到这条评论会不会觉得别扭/起鸡皮疙瘩?
5. **反向自检**:有没有冷到像机器人?如果整条评论除了结论和问题清单什么都没有,作者读完会不会觉得"被审判"了?**至少一处贴着具体代码的正向反馈或人味收尾**,这是温度底线。
6. **标点自检**:通篇扫一遍,发给真人的中文句子里出现英文半角 , ; : ? ! 的,全部换成全角再发。
7. **通顺自检(带标题的消息尤其要过,如飞书 post)**:把标题和正文**连起来**默读一遍——同一个短语 / 句式出现两次即复读(反面教材:标题「你的 PR 我们看到了」+ 正文首句又「我们看到了」),任何一句单独念着别扭、像模板填空的,整段重写,不许照抄骨架原句。骨架只定信息结构,措辞永远按当次内容现写。

## 通用守则

- **PR 是一个持续过程,不是快照**:在汇报和审查之前,必须先完整跑完 1.5(comments / review threads / commits 三类全部翻页拉完,按时间从新到老读),并且在步骤 2 的开头(第 0 / 0.5 条)先处理历史讨论和代码描述对账。不要只看 diff 不看历史——历史里通常已包含之前评审者达成的共识、作者解释过的设计权衡、还挂着没人收尾的悬念,跳过这些会让你重复别人提过的问题或放过别人已标出的风险。
- **审查的视野必须超出 diff 文件**:代码审查(步骤 2 第 4 条)的重点不是"diff 写得对不对",而是"这些改动放回整个仓库后会不会波及关联功能"。每个被改的共享符号 / 契约 / 数据 / 状态,都要顺着引用(TS 符号优先 LSP,grep 兜底)和数据流走出 diff、把关联方和关联功能读一遍再判定。主 agent 拼子 agent prompt 时要保证这条被强调。
- **任何破坏性操作前都用 AskUserQuestion 让用户确认**(auto 模式例外——按「自动模式决策规则」表行事,不调 AskUserQuestion):合并、发 GitHub 评论、飞书私信通知作者、回退本地分支、删分支。不要因为"刚才用户说继续"就把后续所有操作打包做掉。
- **所有对外文字(给作者的评论、给用户的汇报)都用中文,以产品/场景语言为主,技术细节只在用户主动追问时给**。
- **PR 已被别人合掉 / 关掉 / 有冲突 / CI 红 / 权限不足**,这些状况要第一时间如实告诉用户,不要硬走流程。
- **前置门是硬 gate,不得无脑继续**:进入代码审查(步骤 2)前必须先过 1.6.5——只要 `mergeStateStatus` 显示合并阻塞(`BLOCKED` / `DIRTY`;CI 必需检查未过会体现成 `BLOCKED`)、**有任何 review thread / conversation 没 resolve(不分作者,bot 或工具账号发的一样算)**、或 bot 总结评论 / 之前 reviewer 的"不能合"评论作者还没解决,**任一存在都不能自作主张往下走**。交互模式:按 1.7 的 gate 把未解决清单列给用户、用 AskUserQuestion 让用户拍板(默认倾向暂停去催作者);用户没明确说"仍继续"就停在这一步。Auto 模式:跳过当前 PR,按「候选批处理」尝试下一个候选(全部跳完后输出汇总,scheduler 自动飞书通知 owner);若跳过原因含「有 conversation 没 resolve」,跳过前按「候选批处理」节调 `notify-author-resolve.mjs` 评论 @作者催其 resolve(去重,同批只催一次)。**特别注意别因为"这是 bot 发的"就跳过——理论上所有 conversation 都要被 resolve 才能继续。**
- **代码审查必须起独立的审查子 agent 完成,主 agent 不直接审**(详见步骤 2「执行方式」)——目的是隔离上下文,避免审查时吞进的大量 diff 污染主 agent 后续合并 / 评论 / 清理流程。1.2 格式合规检测、1.5 历史拉取、3A/3B 合并与发评论这些**不要**起子 agent,主 agent 直接做。
- **fork PR 的 workflow 待批准要单独处理,别当成普通 BLOCKED 打回作者**:`gate.workflowsAwaitingApproval` 非空时,BLOCKED 的根因是 CI 没被批准跑、不是作者要改。交互模式确认后 approve 放行(走 `approve-workflows.mjs`);auto 模式仅对**未改 CI 配置**的自动批,**改了 `.github/workflows` 等 CI 配置的绝不自动批**(approve = 执行被改过的 CI),跳过并在飞书点名让 owner 手动批。详见「Workflow 待批准门」节。approve 是写操作 / 对外动作,交互模式必须经 AskUserQuestion 确认。
- **结构性 BLOCKED(永不上报结果的必需检查门)别当成代码问题打回作者**:`gate.blockClass=structural-check` 时(review + 已跑 CI 都过、仍 BLOCKED,卡在 `code_scanning`/`code_quality` 这类永不上报的门),不是作者要改、也没东西要 resolve。交互模式:审查照常做,合并时若 `structuralBypassAvailable=true` 经用户确认走 `gh pr merge --admin` bypass 合,并建议治本(启用扫描 / 调整 ruleset,属对外动作需和 owner 确认);auto 模式:有 bypass 权限时 `bypass-structural-block`——直接 `gh pr merge --admin` 自动合并(安全前提:reviewDecision=APPROVED + 已跑 CI 无失败 + 0 未 resolve thread);无权限时 `skip-structural-block`,跳过 + 飞书点名让 owner 处理。判 BLOCKED 成因一律读 `gate.blockClass`(它用 `reviewDecision` 权威信号 + workflow run 分类),**别再用「历史里出现过 CR」当 review-blocked 的依据**——同人后续 APPROVE 会把 reviewDecision 覆盖成 APPROVED。详见「结构性 BLOCKED 门」节。
- **默认不修改 PR 的代码**,本任务是审查 + 合并,不是参与开发。**例外**:如果用户明确让你帮忙修小问题再合(典型:一两处明显的笔误 / 跨平台路径 / 漏改的调用方等改起来比来回沟通快得多的点),可以改,但**必须**:
  1. 改之前先把"打算改什么、为什么改"告诉用户,得到同意再动手
  2. 改完在合并前 commit + push 到 PR 的源分支(走 PR 自己的分支,不要自己另开 branch)
  3. 合并后的评论里走 3A-②③ 的结构如实披露你改了什么、为什么改,让原作者 review 你的改动
  4. 不要顺手改与原 PR 主题无关的代码(哪怕看着碍眼也忍住——遵守"一个 PR 一个目的 / 不搭便车改动",本 skill 审查细则同款红线)
- **产品 / UI 变更必须有白名单明确同意才放行**:非白名单作者的产品/UI 改动(语义定性口径见「产品 / UI 变更门」,拿不准从严),在白名单成员**明确同意**之前(讨论 issue 里留言同意 / 在 PR 上点 Approve / 亲自标回 ready,任一),不进自动审查、更不合并;白名单成员只留言或打回过 PR 不算同意。auto 模式:自动开好讨论 issue(替作者转述提案,不让贡献者自己跑腿)+ 评论告知作者(语气按该节要求带具体认可与明确下一步,**别伤贡献者的提交热情**)+ 转 draft,动作走 `product-hold.mjs`(issue / 评论按标记去重、只发一次);issue 新开成功(`issueCreated=true`)后同步飞书——通知产品讨论群(`feishuNotify.groupName`,当前 `Cindy`,拍板的人在群里)+ 私聊提交者(git 邮箱经 `resolve-author-feishu.mjs` 查 org 名录映射,查不到就不发、但必须在群消息里说明),飞书通知同样锚定 `issueCreated`,绝不重发。交互模式:报告后由用户拍板,issue / 评论 / 飞书消息发出前都必须经用户确认。白名单以 `pr-rules.json` 的 `productWhitelist` 为准,不在 skill 里另存名单。Bugfix / 已有功能补充不受本门限制。**放行也是流程的责任**:白名单在 issue 里同意后,auto 下一轮经 `heldDraftResults` 判出同意即跑 `product-release.mjs` 自动把 PR 标回 Ready 恢复审查,不许把「标回 Ready」留给作者当作业。PR 最终真正合并后,讨论 issue 由 `close-product-issue.mjs` 自动关闭(合并后定向关 + auto 每轮 sweep 兜底),不留悬空 issue。
- **Server 改动是硬 gate,作者不声明「已飞书通知 Lizi」就不能合**:只要 `format.hitsServer=true`,合并前必须确认作者本人已通过飞书通知 Lizi(发布时需发布服务器代码;新增环境变量私聊告知)。作者未声明 → 哪怕代码审查零问题也一律走 3B 打回,挂 `[阻断]` thread 要求其通知后回复并 resolve;重审时核实 thread 里有真实的「已通知」回复,空 resolve 不放行。详见「Server 发布通知 gate」节,交互 / auto 模式都不可绕过。
- **重构他人历史功能是硬 gate,作者没和原作者对齐就不能合**:PR 若**实质性重构 / 重写了并非自己当初实现的既有功能**(在 base 上 `git blame` 定权属:被重写的既有行原作者 ≠ PR 作者),而作者拿不出"已与原作者对齐"的证据(description / 评论里明确声明、或原作者已 approve),一律走 3B 打回,要求其先和**原功能作者**澄清这 6 点再提:① 为解决什么实际问题、② 是否非重构不可、③ 是否必须现在做、④ 重构的节奏与阶段怎么分、⑤ 覆盖哪些测试用例、⑥ 测试是否都跑过并通过。**自我重构、或为单一主目的的必需连带改动不在此列**(避免误伤正常连带改动)。检测与权属判定由步骤 2 审查子 agent 用 git blame 完成,详见审查框架第 0.6 条。
- **token 不要 echo 到任何输出里**:鉴权统一走 `gh`,需要 token 时 `$(gh auth token)` 只在管道里用,curl header 拼接时也注意不要被日志带出来。
- **锁释放是收尾的硬性动作,不可省**:本轮只要 `prepare.mjs` 返回 `lock.acquired=true`,**结束前必须有一次释放**——走 `cleanup.mjs`(它末尾内置释放)或 `release-lock.mjs`(幂等,只删锁文件)二选一,不能两条都不走。所有早退路径(无 PR、prepare 失败、auto 候选全跳、用户放弃、模型异常退出前)都按此办。锁被别人占着的那次(`lock.acquired=false`)反过来:**绝不能调 release-lock**,锁不是你的。
