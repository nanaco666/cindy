按关键词搜索当前登录用户**全部可见**的飞书消息(跨所有群聊/单聊),可见范围与你在飞书客户端里搜索一致。Search all messages visible to the current user across chats by keyword; visibility matches the in-app suite search. 与 `im_read_messages` 互补:`im_read_messages` 需要你已经知道 `chat_id`(读某个会话的消息),本工具用于「我不知道在哪个会话、只记得关键词」时跨会话定位消息。

`query` 必填(关键词)。可选过滤:`from_ids`(按发送者 open_id)、`chat_ids`(限定在某些会话内搜)、`at_chatter_ids`(按被 @ 的人 open_id)、`from_type`(bot/user)、`chat_type`(group_chat/p2p_chat)、`message_type`(只搜 file/image/media 资源消息)。`page_size` 默认 20、上限 20(越界自动钳制),更多结果用返回的 `page_token` 翻页。

默认 `hydrate=true`:对每条命中的消息自动调 `im.message.get` 拉取正文,并 best-effort 批量解析 open_id → 姓名,返回与 `im_read_messages` 一致的富消息结构(每条 `sender` 带 `sender_name`,顶层带 `user_map`),拿到即可读,无需再单独调 `im_read_messages` 或 `contact_batch_get_users`。`hydrate=false` 只返回 `message_ids` 列表(更快),仅适用于「只需要 id」的场景(计数、去重、把 id 传给别处);它**不足以**读正文或下载附件——`im_read_messages` 按会话/话题读取、不接受裸 `message_id`(chat 模式传 message_id 会返回 INVALID_ARGS),`media_download` 也需要正文里的 `file_key`。要读正文或下载附件就用默认的 `hydrate=true`:富消息里已含正文,图片/文件消息的正文带 `file_key`,可再用 `media_download` 传该 `message_id` + `file_key` 下载。

以当前登录用户的飞书权限调用,只能搜到你本人可见的消息。**权限**:搜索本身需要专用的 `search:message` user scope(不蹭 `im:message:readonly`);`hydrate=true` 拉取**单聊**命中正文还需 p2p get-as-user 读取权限。这两个 scope 需先由应用 owner 在飞书后台开通、再补进 OAuth 授权串;在此之前搜索会返回 scope 错误,单聊命中的正文会降级为 `fetch_error`(可传 `hydrate=false` 只取 message_id 规避)。
