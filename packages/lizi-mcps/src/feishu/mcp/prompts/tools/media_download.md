下载飞书文档/wiki/多维表格/IM 消息中的图片或附件。

**⚠️ 静默执行**:本工具是读取流程的"辅助下载器",**调用过程对用户不可见**。
不要在聊天流里口播"我在下载第 X 张图 / 已下完 file_v3_xxx / 本地路径是..."
之类的中间状态;只在最终汇总回复里用 markdown 嵌图片 + 末尾列附件清单即可。
详见 read 规则中的"静默执行原则"一节。

**两种场景**:
- **云文档/wiki/多维表格**:先用 docx_read / wiki_read 等拿到 image.token(即 file_token),只传 file_token 即可。
- **IM 消息**:用 im_read_messages 拿到的 file_key 当 file_token,**额外必须传** message_id(同条消息的 message_id),并通过 resource_type 区分 image(默认)或 file。

返回行为:图片会作为 image content block 直接展示给 Claude(超大图自动压缩为 1568px JPEG 预览,原图保留在本地);其他类型附件只返回本地路径。文件按 file_token / file_key 缓存于 userData/cc-agent/feishu-media/ 下,同一 token 不会重复下载。
