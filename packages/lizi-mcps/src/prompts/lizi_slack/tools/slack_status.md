查询 Slack 连接与授权状态(绑定的 workspace / 用户 / 已授予的 scopes / 是否持有工具权限)。调用 Slack 工具报错时先用它判断是「未绑定」「需重新授权(NO_USER_TOKEN / TOKEN_EXPIRED)」还是「连接不在线」,并按返回的 hint 指引用户;正常使用前不需要主动调它。
