# Cindy `CustomProviderDialog` 增量原型

这是基于当前 Cindy Desktop 真实 `CustomProviderDialog` 外壳的纯客户端原型，不是重新设计一套设置页。

原型保留现有界面与功能位置：

- 600px 弹窗、标题栏、关闭按钮和底部取消 / 保存；
- 预设模板、显示名称、API 密钥 / OAuth 鉴权切换；
- Claude Code / Codex runtime Tab；
- Base URL、API Key、模型行、请求头、测试连接、获取模型列表；
- 现有表单的字段尺寸、圆角、主题 token 和层级。

本轮只增加一个局部模块：

- “应用到其他 Harness”选择区；
- 不兼容协议明确禁选；
- 来源配置 / 独立副本状态提示；
- 保存失败后的整体回滚提示。

## 预览

直接打开 [index.html](./index.html)。它是自包含单文件，样式和交互脚本已内联，适合手机端远程预览。

可用查询参数查看状态：

- `?protocol=openai`：切换到 OpenAI Responses，观察 Codex 兼容性；
- `?runtime=codex&protocol=openai`：查看 Codex 独立副本状态；
- `?failure=1`：查看保存失败后的原子回滚状态。

顶部的主题按钮只属于原型预览控制，不是产品新增控件。

## 真实实现边界

当前仓库真实 `AgentKind` 只有 `claude-code` 与 `codex`，因此原型不会把 Pi 当作当前可用 Tab。Pi 需要在正式实现中通过 runtime capability manifest 接入后，再自然出现在同一选择区。

`app.js` 与 `styles.css` 已不再作为预览依赖；保留的图片只用于设计文档和概念说明。
