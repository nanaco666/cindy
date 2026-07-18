列出 Slack 官方 MCP 当前授权下可用的工具清单(名称 / 说明 / 参数 JSON Schema)。工具面由 Slack 按授权 scope 动态决定:搜索消息 / 读频道历史 / 查用户 / 发消息 / 加 reaction 等。第一次操作 Slack 前先调它,再用 slack_call_tool 调具体工具;清单会话内基本不变,不要反复拉取。
