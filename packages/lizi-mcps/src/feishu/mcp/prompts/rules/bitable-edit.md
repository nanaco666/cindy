### bitable 写工具值/格式约定(create_app / table / field / records 通用)

> 用户确认流程见 `mutation-confirm` 规则,这里只列 bitable 自身的值/格式约定。

**【字段值传入约定】**
- 文本/链接:`"abc"` 或 `{text, link}`
- 数字/复选框:`123` / `true`
- 单选:`"选项名"`(选项不存在会自动创建)
- 多选/人员:`["A","B"]` / `[{id:"open_id"}]`
- 日期:Unix 毫秒时间戳(整数)
- 附件/关联/公式 等稀有类型:按飞书官方 schema 直接传 record 值

**【容易踩的坑】**
- `create_records` / `update_records` 之前最好先 `bitable_list_fields` 核对字段名与值类型,
  飞书对字段名是大小写敏感的,错一个字会整批失败
- `update_field` 改字段类型可能丢列数据,在 mutation-confirm 提示用户时务必把"丢数据风险"说清楚
- 以登录用户身份操作,无编辑权限会失败

**【完成后必须回复】**
- 创建类工具(`bitable_create_app` / `bitable_create_table`)成功后返回 data 里包含 `url`,
  回复结尾必须是 markdown 链接 `[飞书多维表格](url)` + 让用户去 check 的提示
- 写记录/字段类成功后简要说明影响行数 / 字段名,不要只说"做完了"
