# 第三方模型供应商接入 — QA 测试验收清单

> 对应 PR：`xdt/auto-br9374`（供应商预设模板 / 测试连接 / 上游错误分类 / OAuth 订阅形态）。
> 方案背景见 `docs/third-party-provider-plan.md`。
> 服务商测试范围对齐 CodePilot 内置预设目录（其 README 宣称 "17+ providers"，去掉
> Anthropic 官方、Bedrock/Vertex 云平台、Ollama/LiteLLM 本地、图像生成类后，第三方聊天
> 服务商共 17 家，见下表）。

## 0. 环境准备

- 分支 dev 包或合入后的 main 构建；**Windows / macOS 各过一遍主路径**。
- 按下表准备各厂商 API key（QA 可按优先级只开通 P0 行；key 从各厂商控制台自助申请）。
- 准备一个**故意写错的 key**（错误分类用例）。
- 升级场景需要一台装过旧版本、已有自定义供应商数据的环境（DB 迁移用例）。
- 入口统一为：设置 → 模型供应商 → 添加自定义供应商。

## 1. 服务商测试矩阵（17 家）

**统一执行步骤（每行服务商跑一遍，记录结论）**：

1. 有预设的从模板下拉选中；无预设的按表中 baseUrl 手填（Runtime 选表中标注的那端）。
2. 填真实 key → 点「测试连接」→ 预期绿色「连接正常（xx ms）」。
3. 保存 → 会话里选该供应商模型发一条消息 → 预期正常流式回复。
4. 把 key 改错再测试连接 → 预期「密钥无效」类**分类文案**（不是原始 JSON）。
5. 模型 ID 写错 → 预期「模型不存在」类分类文案。

> 模型 ID 一律以厂商当前文档/控制台为准（表中示例仅供参考，过期不算 bug）。
> 「预期」列为 `⚠ 记录结论` 的行属于探索性测试：该端点是 OpenAI 兼容（Chat Completions）
> 形态，XDMaker 当前两个 runtime 分别要求 Anthropic Messages / OpenAI Responses 协议，
> 不通是**已知边界**（Phase 4 wire 长尾），QA 只需记录实际表现，不按 bug 报。

### 1a. 应用内已有预设（模板下拉直选）

| # | 服务商 | Runtime | baseUrl（模板已带） | 优先级 | 预期 |
|---|--------|---------|---------------------|--------|------|
| 1 | DeepSeek | Claude Code | `https://api.deepseek.com/anthropic` | P0 | 全通 |
| 2 | 智谱 GLM（中国大陆） | Claude Code | `https://open.bigmodel.cn/api/anthropic` | P0 | 全通 |
| 3 | Z.ai GLM（Global） | Claude Code | `https://api.z.ai/api/anthropic` | P1 | 全通（需海外网络） |
| 4 | Kimi / Moonshot（中国大陆） | Claude Code | `https://api.moonshot.cn/anthropic` | P0 | 全通 |
| 5 | Kimi / Moonshot（Global） | Claude Code | `https://api.moonshot.ai/anthropic` | P1 | 全通（需海外网络） |
| 6 | MiniMax（中国大陆） | Claude Code | `https://api.minimaxi.com/anthropic` | P0 | 全通 |
| 7 | MiniMax（Global） | Claude Code | `https://api.minimax.io/anthropic` | P1 | 全通（需海外网络） |
| 8 | OpenRouter | Claude Code / Codex 双端 | cc: `https://openrouter.ai/api`；codex: `https://openrouter.ai/api/v1` | P0 | 全通；重点验证同一供应商双 Runtime 并存 |

### 1b. 暂无预设，手填自定义（baseUrl 来自 CodePilot 目录）

| # | 服务商 | Runtime | baseUrl | 优先级 | 预期 |
|---|--------|---------|---------|--------|------|
| 9 | 字节火山方舟 Coding Plan | Claude Code | `https://ark.cn-beijing.volces.com/api/coding` | P0 | 全通 |
| 10 | 阿里云百炼 Coding Plan | Claude Code | `https://coding.dashscope.aliyuncs.com/apps/anthropic` | P0 | 全通 |
| 11 | 阿里云百炼 Token Plan（团队版） | Claude Code | `https://token-plan.cn-beijing.maas.aliyuncs.com/apps/anthropic` | P2 | 全通（需团队版套餐） |
| 12 | 小米 MiMo（按量付费） | Claude Code | `https://api.xiaomimimo.com/anthropic` | P1 | 全通 |
| 13 | 小米 MiMo Token Plan（订阅） | Claude Code | `https://token-plan-cn.xiaomimimo.com/anthropic` | P2 | 全通（需订阅套餐） |
| 14 | Kimi 编程计划（Coding Plan） | Claude Code | `https://api.kimi.com/coding/` | P1 | 全通（需编程计划套餐；与 #4 Moonshot 按量 key 不同源） |
| 15 | ClinePass | Codex | `https://api.cline.bot/api/v1` | P2 | ⚠ 记录结论（OpenAI 兼容形态） |
| 16 | OpenCode Zen Go（OpenAI 形态） | Codex | `https://opencode.ai/zen/go/v1` | P2 | ⚠ 记录结论（OpenAI 兼容形态） |
| 17 | OpenCode Zen Go（Anthropic 形态） | Claude Code | `https://opencode.ai/zen/go` | P2 | 全通（同一订阅 key） |

**矩阵结论产出**：每行记录「测试连接结果 / 会话对话结果 / 错误分类是否人话」三项。
1b 里跑通的厂商会作为下一批进 OSS 预设目录的依据；跑不通的记下原始报错。

## 2. 功能用例

### 2.1 预设模板（P0）

| # | 步骤 | 预期 |
|---|------|------|
| 2.1.1 | 打开新建弹窗 | 「从模板快速填充」为**下拉框**，占位「选择一个模板…」 |
| 2.1.2 | 展开下拉（中文界面） | 厂商按首字母排序、同厂商国内/海外相邻、国内版在前 |
| 2.1.3 | 切英文界面再看 | 同厂商组内 Global 在前 |
| 2.1.4 | 选中模板 | 显示名 / baseUrl / 模型自动填充；已填 key 不丢 |
| 2.1.5 | 编辑已有供应商 | 不显示模板下拉 |

### 2.2 测试连接（P0）

| # | 步骤 | 预期 |
|---|------|------|
| 2.2.1 | 正确配置 → 测试 | 转圈 → 绿色「连接正常（xx ms）」，≤10s |
| 2.2.2 | 错 key / 错模型 / 不通地址 | 分别给出对应**分类文案**，不卡死不崩溃 |
| 2.2.3 | baseUrl 或模型留空 → 测试 | toast 拦截，不发请求 |
| 2.2.4 | 未保存的表单直接测试 | 可以测 |

### 2.3 API key 形态链路 + 上游错误呈现（P0）

| # | 步骤 | 预期 |
|---|------|------|
| 2.3.1 | 保存后会话对话 | 正常回复 |
| 2.3.2 | 编辑（改名/加模型/换 key）| 列表与模型选择器 live 刷新 |
| 2.3.3 | 删除供应商 | 列表移除；使用中会话合理回落不崩溃 |
| 2.3.4 | 会话中用错误 key 发消息 | 分类中文 toast；429 类为 warning 样式；同一错误 30s 内不重复弹 |

### 2.4 OAuth 订阅形态（P0，新能力）

> 端到端授权需真实 OAuth 供应商公开参数；QA 无参数时 2.4.5 起可标 blocked，表单项照测。

| # | 步骤 | 预期 |
|---|------|------|
| 2.4.1 | 切「OAuth 订阅授权」 | 表单只剩：显示名 + 4 个 OAuth 字段 + 基础 URL；密钥/测试连接/模型/请求头不可见；有「模型将在授权成功后自动获取」提示 + 默认折叠「高级配置」 |
| 2.4.2 | 展开高级配置 | 出现模型/请求头编辑器，布局无跳变 |
| 2.4.3 | OAuth 字段留空或 http:// 端点 → 保存 | toast 拦截 |
| 2.4.4 | 合法四字段 + 基础 URL + 模型留空 → 保存 | 保存成功；供应商行出现「授权」按钮（与内置订阅一致） |
| 2.4.5 | 点授权 → 浏览器登录 | 行变「已连接」；模型自动出现在选择器 |
| 2.4.6 | 授权后重启应用 | 连接态保持；自动发现的模型仍在（已持久化） |
| 2.4.7 | 授权中途取消/关浏览器 | 回未连接、无残留凭证；可再次发起 |
| 2.4.8 | 断开 / 删除已授权供应商 | 断开后配置不丢；删除连凭证一起清，重建同名不会自动已连接 |

### 2.5 内置供应商回归（P0）

- Anthropic / OpenAI / xAI 三家授权、断开、会话使用与改动前一致。
- xAI（SuperGrok）在 Codex 下的 grok 模型路由正常（与 main #822 机制并存）。
- XD 网关默认路由、模型选择器整体列表无异常、无重复模型。

### 2.6 升级与数据（P1）

- 旧版本（已有自定义供应商 + key）升级：启动正常、迁移无报错、旧供应商照常可用。
- 升级后再次重启：无 "column already exists" 类迁移重放错误。

### 2.7 i18n 与视觉（P1）

- 四语言（简中/英/日/韩）检查本次新增文案：模板占位、鉴权方式、OAuth 字段、
  「模型自动获取」提示、「高级配置」、测试连接三态、上游错误 toast——出现夹生英文即 bug。
- 深色模式 + 至少一个非默认主题下检查新弹窗控件配色。
- 测试连接转圈期间 CPU 无异常占用。

## 3. 已知事项（不按本 PR 缺陷报）

1. OpenAI 兼容（Chat Completions）形态端点（1b 的 #15/#16 及 Ollama / LiteLLM 本地端点）
   属 Phase 4 wire 长尾，当前不承诺可用，只记录结论。
2. OAuth 端到端依赖真实供应商公开参数，首家试点接入前 2.4.5 可能无法闭环。
3. `test:migration-replay` 的 0060 用例在 main 上已有失败（0067 迁移存量问题），与本 PR 无关。

**执行优先级建议**：1a（P0 行）→ 2.1/2.2 → 2.4 → 2.3 → 1b（P0/P1 行）→ 2.5 → 2.6 → 2.7。
