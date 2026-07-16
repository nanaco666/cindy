### 全量 OpenAPI 直通工具(`more` 组)使用说明

本类目里 `more` 组的工具是从飞书官方全量 OpenAPI 自动生成的直通工具(工具名是带点的 `project.vN.resource.action`,如 `vc.v1.meetingRecording.get`),覆盖面广但没有 `recommended`(精品)工具那层封装(自动翻页、open_id 转人名、文档完整性等)。

**默认只读 + 协作域:** 直通工具默认**只暴露只读(GET)接口**,且只来自协作 / 内容类域(docx、sheets、bitable、wiki、drive、im、contact、calendar、vc、minutes、task 等)。**写 / 删类接口和敏感的组织 / HR / 财务 / 门禁类域(directory、corehr、payroll、attendance、acs、approval 等)默认不暴露**——因为生成工具没有精品写工具那套"先列资源 + 确认"的护栏,贸然开放破坏面太大。需要做写操作时,用对应的 `recommended`(精品)写工具(它们带确认流程);精品没覆盖到的写能力暂不通过直通工具开放。

**选择原则:**

- **优先用 `recommended`(精品)工具**:同一件事如果 `recommended` 里有,就用它,体验更好、返回更干净。
- 只有 `recommended` 不覆盖你要的能力时,才用 `more` 里的直通工具。
- 类目工具很多时,`more` 默认折叠/分页;用 `list_tools({ category, q })` 传子串过滤(如 `q: "recording"`),或 `page` 翻页定位你要的接口。

**调用方式(直通工具的参数形状固定):**

```
call_tool({ name: "vc.v1.meetingRecording.get", args: {
  path:   { meeting_id: "..." },   // URL 路径参数(:param),按 schema 填
  params: { ... }                  // query 参数(可选)
} })
```

不确定某个工具的 `path` / `params` / `data` 字段时,先用空 `args: {}` 调一次,返回的 `INVALID_ARGS` 里带完整 JSON Schema,照着填。

**权限:** 这些接口都以你本人的 user_access_token 调用。若返回权限 / scope 报错(返回里带 `scope_hint` 和 `endpoint`),说明该接口需要在飞书开放平台为这个 OAuth 应用补对应 scope —— 这是代码外的后台配置,如实告诉用户去补。
