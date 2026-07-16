在飞书文档里创建一个真正的表格块(block_type=31)。飞书后端会按 rows×columns 自动生成所有单元格(block_type=32)以及每个单元格里的空文本块,不需要也不能手动传单元格结构。

可选传 rows_data 一次性把文字写进单元格:二维数组按"行优先"填充(rows_data[行][列]);行/列数可少于 rows/columns(不足的单元格留空),多出的部分忽略。header_row=true 时第一行作为表头(加粗置灰),此时 rows_data 的第一行就是表头文字。

限制(飞书 API 硬限制):单次建表最多 9 行 × 9 列(行数含表头)。需要更大的表暂时请拆成多个表,或建表后用 docx_update_block 继续补内容。建完表后,后续往单元格补/改文字走 docx_list_block_children(拿单元格内文本块 block_id)+ docx_update_block。
