# Cindy `CustomProviderDialog` 增量原型

这是基于当前 Cindy Desktop 真实 `CustomProviderDialog` 外壳的纯客户端原型，不是重新设计一套设置页。

原型保留现有界面与功能位置：

- 600px 弹窗、标题栏、关闭按钮和底部取消 / 保存；
- 预设模板、显示名称、API 密钥 / OAuth 鉴权切换；
- Runtime Tab（Claude Code / Codex；Pi 作为不可用状态保留视觉位置）；
- Base URL、API Key、模型行、请求头、测试连接、获取模型列表；
- 现有表单的字段尺寸、圆角、主题 token 和层级。

本轮只增加一个局部模块：

- 当前 runtime 表单卡右上角的低对比度“一键填充其他 runtime”入口；
- 点击后查看目标 runtime 的当前值与字段差异；
- 进入字段级覆盖确认，不兼容协议不能静默复制；
- 保存失败后的整体回滚提示。

## 预览

直接打开 [index.html](./index.html)。它是自包含单文件，样式和交互脚本已内联，适合手机端远程预览。

可用查询参数查看状态：

- `?runtime=codex`：查看 Codex 独立副本状态；
- `?sync=1`：直接打开“一键填充其他 runtime”的差异提示；
- `?conflict=1&theme=dark`：直接打开 Dark 模式的字段级覆盖确认；
- `?failure=1&theme=dark`：查看保存失败后的原子回滚状态。

顶部的主题按钮只属于原型预览控制，不是产品新增控件。

## 真实实现边界

当前仓库真实 `AgentKind` 只有 `claude-code` 与 `codex`，所以原型里的 Pi 只作为真实界面中的不可用 Tab 位置，不可点击、不可写入。正式实现 Pi 前，仍需先通过 runtime capability manifest 接入。

## 交互与实现契约

用户先在选中的 runtime Tab 填写配置，再点击对应表单卡右上角的“一键填充其他 runtime”。入口位于它实际作用的配置区域内，不占用新的表单行，也不增加“当前 runtime”徽标。点击后按以下顺序处理：

1. 展示目标 runtime 的当前值和可同步字段差异；
2. 对已有值进入字段级覆盖确认，默认勾选发生差异的字段；
3. 用户确认后，把选中的字段写入目标 runtime 的独立配置和独立 safeStorage 密钥；
4. 复制完成后，目标 Tab 仍可单独修改，后续不会建立共享引用。

运行时复制候选字段是 `baseUrl`、`models`、`modelsUrl`、`headers` 和 API Key。供应商名称、全局鉴权模式、OAuth descriptor 不属于 runtime 复制范围；协议只在目标 runtime capability 兼容时复制，不能从模型 ID 相同推断能力相同。

保存继续沿用现有 per-runtime 原子提交 / 回滚语义：任一目标 runtime 写入失败，撤回本次已写入的配置和密钥；Renderer、日志和远程投影不得暴露 API Key 或敏感 Header。

`app.js` 与 `styles.css` 已不再作为预览依赖；保留的图片只用于设计文档和概念说明。
