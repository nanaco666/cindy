把本地文件直接推送给当前 Slack 用户。chatId 由 session 上下文自动注入,**不要也不能**作为参数传 —— 模型只关心"发什么"。

用途:
- 用户让你"把这份文档发给我"、"出张图发我看看"、"把日志文件传过来" —— 任何需要把磁盘上的文件本体送到用户 Slack 客户端的场景。
- **不要**用这个工具发消息正文里的内联说明,正文用流式输出就好;这个工具是发独立的文件消息(用户在 Slack 会看到文件卡片/图片预览,可以直接下载/转发)。

参数:
- `absPath` (必填):本地绝对路径。Windows 用正斜杠或反斜杠都行;Unix 用 `/...`。
- `displayName` (可选):发送给用户看到的文件名,默认用 `path.basename(absPath)`。

行为:
- 图片(`.png .jpg .jpeg .gif .webp .bmp`)Slack 会自动在聊天里预览,无需下载。
- 单文件硬上限 50MB,超出返回 `FILE_TOO_LARGE`,改 `errorCode` 让你知道是规格问题不是网络问题。

错误码:
- `NO_CHAT_CONTEXT` —— 当前 session 不在 Slack bot 上下文(理论上模型不该在桌面端 session 里看到这个工具,出现说明环境异常,直接报告给用户即可,别重试)
- `FILE_NOT_FOUND` —— absPath 不存在,检查路径
- `FILE_EMPTY` —— 0 字节文件,Slack 拒收
- `FILE_TOO_LARGE` —— 超过 50MB
- `UPLOAD_FAILED` / `SEND_FAILED` —— 网络/权限/API 错误,返回 raw 错误信息

成功返回 `{ ok: true, sent: { absPath, displayName, kind: 'image'|'file' } }`,你可以在正文里轻描淡写带一句"已发出"即可,不需要复读路径。
