批量创建记录。`records` 数组每项是 `{ fields: { 字段名: 值 } }`,字段名必须与表 schema 完全一致(用 `bitable_list_fields` 核对)。单选传字符串,多选/人员传数组,日期传毫秒时间戳,链接传 `{text, link}`。单次最多 1000 条。
