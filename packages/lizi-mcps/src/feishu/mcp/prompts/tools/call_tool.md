调用一个具体的飞书工具(参数会经过 zod 校验)。先用 list_tools 获取工具名;参数错误时会返回该工具的 JSON Schema 用于自我修正。常见 errorCode: UNKNOWN_TOOL / INVALID_ARGS / AUTH_EXPIRED / FEISHU_API_ERROR。
