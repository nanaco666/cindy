修改已有字段。可改名(`field_name`)、改类型(`type` + 对应 property)。**改类型可能丢失数据**,调用前必须先 `bitable_list_fields` 看当前定义 + 跟用户确认。同样支持 `type='raw'` 透传。
