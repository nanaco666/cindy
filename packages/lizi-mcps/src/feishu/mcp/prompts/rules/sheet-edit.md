### sheet 写工具值/格式约定(write_range / append_rows 通用)

> 用户确认流程见 `mutation-confirm` 规则,这里只列 sheet 自身的值/格式约定。

**【写前最好先读】**
- `sheet_write_range` 调用前建议先 `sheet_read_range` 把目标范围现状读出来,
  在 mutation-confirm 的 AskUserQuestion 里展示给用户做对比
- `sheet_append_rows` 调用前建议先读表头或末尾几行,确认列结构与待追加数据一致

以登录用户身份操作,无编辑权限会失败。

**【完成后必须回复】**
- 成功后返回 data 里包含 `url`,回复结尾必须是 markdown 链接 `[飞书电子表格](url)` + 让用户去 check 的提示
- 简要说明影响的行数 / 单元格数,不要只说"写完了"

**【值类型约定】**
- 数字 / 布尔:原生类型直接传,如 `123` / `true`
- 文本:字符串,如 `"abc"`
- 空单元格:传 `null` 或 `""`
- 公式:传字符串,如 `"=SUM(A1:A5)"`,飞书会按公式解析
