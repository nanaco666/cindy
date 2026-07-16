列出或搜索当前用户可见的飞书群组/对话。List or search Feishu chats/groups visible to the current user. 以当前登录用户的飞书权限操作。

- 搜群优先传核心关键词,例如用户说“小镇工程师群”时先搜 `小镇工程师` 或 `工程师`;飞书群名经常带项目前缀/符号/后缀,核心关键词更容易命中。
- 结果很多、无法判断目标群时,再换更窄关键词或加 `exact_name:true` 做精确后过滤。
- `query` 会走飞书服务端群搜索接口;`page_token` 仅用于搜索结果翻页。
- 群名包含 `-` 时可直接传原始群名,工具会按飞书搜索接口习惯自动整串加引号。
- `chat_modes:["group"]` 查普通群,`chat_modes:["topic"]` 查话题群。
