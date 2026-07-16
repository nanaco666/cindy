### docx 写工具操作约定(append/insert/update/delete/upload_image 通用)

> 用户确认流程见 `mutation-confirm` 规则,这里只列 docx 自身的操作约定。

**【写前最好先读】**
- 改 / 删块之前用 `docx_read` 拉一次全文 + 块列表,在 mutation-confirm 的 AskUserQuestion 里
  把"准备改/删哪个 block_id、原内容是什么、改成什么"列出来给用户对比

以登录用户身份操作,无编辑权限会失败。

**【完成后必须回复】**
成功后返回 data 里包含 `document_url`,回复结尾必须是 markdown 链接 `[飞书文档](document_url)` + 让用户去 check 的提示;
只说"改完了"不算合规。
