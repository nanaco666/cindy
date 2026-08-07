# Cindy 多 Harness 自定义供应商原型

这是一个纯客户端设计原型，不包含真实 IPC、数据库或 safeStorage 写入。它用 Cindy 当前设计系统的 token、圆角、按钮和设置页语言，演示以下产品决策：

- 创建时先选择要应用的 Harness 范围；
- 来源协议不兼容的 Harness 保留可见，但明确禁选原因；
- 只填写一套公共配置，再预览每个 runtime 的独立快照；
- 保存后允许进入单个 Harness 的高级配置覆盖端点、模型、请求头和凭证；
- 任一 runtime 保存失败时，用户看到的是“全部回滚”，而不是半成功状态。

## 预览

直接打开 `index.html` 即可操作。为了快速查看评审状态，可使用：

- `index.html?screen=scope`：应用范围选择；
- `index.html?screen=review`：确认快照与回滚演示；
- `index.html?screen=scope&protocol=openai`：切换到 OpenAI Responses，观察 Codex 兼容性。

主题切换在右上角，原型覆盖 Light / Dark 两套界面。

## 目录

- `index.html`：可交互的 Cindy 设置页原型；
- `styles.css`：对齐 `DESIGN.md` 的单色 token、三档圆角和 pill 控件；
- `app.js`：协议切换、Harness 勾选、单 runtime 覆盖提示、保存失败回滚等交互；
- `assets/runtime-snapshot-concept.png`：由 `imagegen` 生成的概念图，只用于设计文档与原型侧栏，不作为功能依赖。
