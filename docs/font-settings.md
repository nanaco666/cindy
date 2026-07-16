# 字体与字号设置

> 类型：设计 / 调研记录
> 状态：参考
> 范围：`apps/desktop` renderer 字体、代码字号与设置页入口
> 来源：整合根目录旧文档 `font-settings-research.md`、`font-settings-plan.md`、`codex-font-mechanism.md`

## 背景

这批工作来自「设置 → 界面设置」新增字体 / 字号自定义的需求。目标是对齐 Codex 桌面端的可配置能力，同时保留 XDMaker 当前默认观感。

已拍板的产品边界：

- 设置项共 4 项：UI 字体、代码字体、UI 字号、代码字号。
- 4 项全局生效，不按浅色 / 深色主题分别存储。
- 默认字体：UI 仍是 Inter 栈；代码默认改为 Codex / 系统等宽栈，macOS 实际命中 Menlo，Windows 命中 Consolas；代码字号默认 14px。
- 字体选择使用下拉：预设置顶、自定义手填兜底。
- 默认值遵守 `docs/configuration-design-principles.md`：未自定义用户跟随版本默认；恢复默认清除 override。
- 不碰 `maker-core` / system prompt。

## 当前方案

### CSS 变量

字体族：

- `--app-font-ui`：用户 UI 字体 override。设置时写成 `${用户}, var(--app-font-ui-default)`；清空时 removeProperty。
- `--app-font-code`：用户代码字体 override。设置时写成 `${用户}, var(--app-font-code-default)`；清空时 removeProperty。
- `--app-font-ui-default`：当前默认 UI 栈，包含 Inter、系统 sans、CJK fallback。
- `--app-font-code-default`：当前默认代码栈，走 Codex / 系统等宽风格，包含系统 monospace、CJK fallback；JetBrains Mono 只作为可选预设保留。

字号：

- `--app-code-font-size`：代码内容字号，默认 14px。
- UI 字号：数字 token `--text-N` + `--app-ui-font-size`，按 `scale = uiSize / 14` 重算（详见「UI 字号阶段 2」）；阶段 1 只存 `uiSize` 不应用，阶段 2 接入。

字体注入的关键规则：用户字体永远只插到默认栈前面，不能替换掉默认栈。这样即使用户选择只含拉丁字形的字体，中文 / 日文 / 韩文仍能落到默认 CJK fallback。

### 存储与启动

`useFontSettings.ts` 使用 localStorage：

- `font.uiFamily`
- `font.codeFamily`
- `font.uiSize`
- `font.codeSize`

`index.tsx` 在 React render 前执行：

```ts
themeService.applyTheme(getInitialThemeVariant().theme);
applyFontSettings(getInitialFontSettings());
```

这样能避免首帧先显示默认字体、React mount 后再跳变。

### 设置页 UI

入口在 `AppearanceSection.tsx`。阶段 1 已接入：

- UI 字体
- 代码字体
- 代码字号

UI 字号控件留到阶段 2。`uiSize` 目前只在 hook 中保留存储 / setter，供后续 token 化使用。

字体选择器当前形态是：预设 + 自定义输入 + 实时预览。

UI 字体：

- `default`：空 override，显示 `Inter（默认）`
- `codexStyle`：`-apple-system, BlinkMacSystemFont, "Segoe UI"`，显示 `Codex 风格`
- `harmonyOS`：`HarmonyOS Sans SC`，显示 `鸿蒙字体（旧版默认）`

代码字体：

- `default`：空 override，跟随 `--app-font-code-default`，显示 `Codex 风格（默认）`
- `jetbrainsMono`：`"JetBrains Mono Variable", "JetBrains Mono"`，显示 `JetBrains Mono`

预设不带尾部 `sans-serif` / `monospace`，因为注入时会自动拼上 `var(--app-font-*-default)`，保留我们的 CJK fallback。

### 系统字体枚举决策

阶段 1 曾评估过用 renderer 端 `window.queryLocalFonts()` 做系统字体枚举，并配套搜索与虚拟化列表。实测后判断这部分价值较低，且异步加载会引起设置页抖动，因此已移除；字体选择收敛为「预设 + 自定义输入」。

### 字体预览

`FontFamilyPicker` 的下拉中有固定预览条：

- hover 预设时，预览条即时切到该字体。
- 移开后回到当前选中字体。
- UI 字体预览文案走 i18n。
- 代码字体预览使用 TypeScript 片段，并通过现有 `highlight.js` 依赖高亮；容器用 inline `fontFamily`，内部 `code` 继承字体。

UI 预览样本需要覆盖本地文字、大小写拉丁、数字、标点以及 `a/b/c/d`、`a,b` 这类贴近文件路径 / 列表的混排。

## 代码字号边界

代码字体族和代码内容字号是两个维度，不能混。

字体族：

- 所有 `font-mono` 都跟随 `--app-font-code`。
- 这包括代码内容，也包括状态数字、badge、快捷键、路径 label 等 UI mono 文本。

代码内容字号：

- 只作用于真正的代码内容：聊天代码块、diff、CodeMirror、markdown code/pre、工具输出代码。
- UI mono 文本不接 `--app-code-font-size`，保持原字号。

默认观感约束：用户未自定义代码字号时，原来不是 14px 的代码内容必须用相对偏移保持旧视觉。例如：

- 原 13px → `calc(var(--app-code-font-size) - 1px)`
- 原 12.5px → `calc(var(--app-code-font-size) - 1.5px)`

## UI 字号阶段 2

> 状态：已定稿待实现（2026-06-25 对齐）。本节为实现依据。

### 机制：路线 C（opt-in 数字 token）

不走 Electron `setZoomFactor`（那是窗口缩放、连布局一起放大，属另一功能），也不走 root `font-size + rem`（blast radius 太大）。采用 **C：把写死的 `text-[Npx]` 迁成数字类 `text-N`（走 `var(--text-N)`），缩放时只重算 `--text-N`**。核心理由：**一处只有被迁成 `text-N` 才缩放，留 `text-[Npx]` 即天然钉死**——这层 per-site 的「缩放 vs 钉死」控制是选 C 而非「全局值映射覆盖层（D，即 `.chat-rail-compact` 那种按值重映射）」的关键（固定高度 bar 等可零成本钉死）。

> Codex 桌面端推断也是 C（语义 `--text-*`，Tailwind v4 原生），但它从零就用语义类、无写死像素；我们是 v3 + ~986 处写死像素，故多一道追溯迁移成本。Codex GUI 闭源（openai/codex discussions#16538 maintainer 确认），以上为推断、非源码实证。

### Token 方案

- `:root` 定义 `--text-N`（N = 现存所有值：9/10/11/12/13/14/15/16/17/18/20/24/28），默认 `Npx`。
- **只管 font-size，不绑定 line-height**（绑定会给原本无行高的元素强加行高、破坏 byte-for-byte）。正文行高靠现有相对 leading（1.4/1.45/1.5/1.6）随字号自动缩（全 renderer 写死 px 行高仅 9 处，且全在 PIN 区）。
- `tailwind.config.ts` `theme.extend.fontSize` 加 `'N': 'var(--text-N)'`。
- `applyFontSettings`：写 `--app-ui-font-size: ${uiSize}px`；`scale = uiSize/14`；逐个 `--text-N = Math.round(N*scale)px`（JS 侧取整）。**scale=1（默认 14）时 byte-for-byte**。
- **UI 字号范围 12–24**（单独 `clampUiFontSize`）；代码字号仍 10–24，不共用 clamp。
- `useFontSettings` 补 `resetUiSize`；`AppearanceSection` 加 UI 字号控件（复用 code-size 输入归一模式 + 4 语言 i18n）。
- **与代码字号严格隔离**：迁移正则只匹配 `text-[<纯数字>px]`，绝不碰 `text-[length:var(--app-code-font-size)]`。

### SCALE / PIN 边界（2026-06-25 定）

方向「全迁」，两块特殊处理：

- **SCALE（迁 `text-N`，随 UI 字号缩）**：对话正文区（assistant / user / thinking / ask / plan 正文）、**正文内 inline `code`**、全部设置页、普通弹窗 / 卡片、scheduler / skillhub 可读 UI；正文 heading（`MarkdownRenderer` h1/h2/h3 现用 `text-xl/lg/base`）单独迁成数字 token。
- **PIN（留 `text-[Npx]`，不缩）**：
  - **固定高度 bar**（composer、@mention / 斜杠面板、sidebar 文件树、会话 / 文件 tabs）——容器高度写死，只放大文字会裁切；「按范围缩」需另发明一套 token、不值，直接钉死。
  - 文件路径 / mention 等 **mono UI chrome chip**；splash / login 品牌页。
  - **361 处标准类 `text-sm/xs/base/lg`**（除正文 heading）：自带 line-height，迁了非 byte-for-byte，本期不动。
- **人工细分（不整文件 codemod）**：`SystemCard.tsx`（混正文 / 命令 / pill）；**不碰** `PlanViewerCard.tsx`（属代码字号范畴，另案）。

### 前置探查（2026-06-25 复核）

- arbitrary `text-[Npx]`：986 处 / 156 文件（13px 343 / 12px 305 / 11px 140 / 14px 94 / …）。
- 标准类：361 处（text-sm 174 / text-xs 157 / …），正文 heading 在内。
- 写死 px line-height：仅 9 处，全在 PIN 区。

### 执行与验证

排序：`infra（token + tailwind config + applyFontSettings + UI 控件 + 测试）` → `迁移 SCALE 集（codemod text-[Npx]→text-N，排除 PIN）`。固定高度 bar 钉死，故无「放开容器高度」步骤。每步 lead 审查后提交。

验证口径：scale=1 byte-for-byte（token 默认 = `Npx`、相对 leading 不被覆盖）；`git diff` 确认 PIN 未误改；`rg 'text-\[[0-9]+px\]'` 残留落在 PIN 集；`rg app-code-font-size` 不变；`pnpm --filter desktop typecheck` + 定向 eslint + `fontSettings.test.ts`；视觉 uiSize 12 / 14 / 18 / 24（正文 / 设置 / 弹窗缩放且行高不挤，PIN bar 固定不裁切）；规则 7：`applyFontSettings` 只写 CSS vars、设置即时生效、无空白帧。

## HarmonyOS 字体包补丁

`harmonyos-sans-sc-webfont-splitted` 的 `dist/index.css` 原本包含：

```css
:lang(Hans),
:lang(zh),
:lang(CHS),
:lang(zh-CN),
:lang(zh-SG),
:lang(Jpan),
:lang(ja) {
  font-family: "HarmonyOS Sans SC", sans-serif;
}
```

这条规则会强制中文 / 日文界面使用 HarmonyOS Sans SC，并且会影响代码 token 后代，破坏 UI 字体和代码字体继承。

处理方式：用 pnpm patch 删除这条 `:lang` apply 规则，保留全部 `@font-face`。补丁文件：

```text
patches/harmonyos-sans-sc-webfont-splitted.patch
```

验证目标：

```bash
grep -c ':lang(' node_modules/harmonyos-sans-sc-webfont-splitted/dist/index.css
# 0

grep -c '@font-face' node_modules/harmonyos-sans-sc-webfont-splitted/dist/index.css
# 574
```

## Source Serif 清理

blockquote 改为继承 UI 字体，只保留 italic 和左边框。`font-serif` 删除后，`@fontsource-variable/source-serif-4` 不再有消费点，因此同步删除：

- `apps/desktop/src/renderer/index.tsx` 的 Source Serif import
- `apps/desktop/tailwind.config.ts` 的 `fontFamily.serif`
- `apps/desktop/package.json` 依赖
- `pnpm-lock.yaml` 相关条目

验证：

```bash
rg -n "font-serif|Source Serif|source-serif|serif:" apps/desktop/src apps/desktop/tailwind.config.ts
# 应为空
```

## Codex 桌面端调研

### 样本

Codex 桌面端没有公开 GUI app 源码。本次调研基于本机安装包：

```text
/Applications/Codex.app/Contents/Resources/app.asar
```

解包后关键打包产物：

- `/tmp/codex_src/webview/assets/app-main-Bi1wKPe3.js`
- `/tmp/codex_src/webview/assets/general-settings-BrSCFSM1.js`
- `/tmp/codex_src/.vite/build/main-D0dWFqVa.js`
- `/tmp/codex_src/.vite/build/src-BEdCFtv8.js`

结论只基于 asar 打包产物。

### 存储

Codex 的字体 / 字号不是 localStorage，也不是 IndexedDB，而是写入 Codex home 的 `config.toml` `[desktop]` 配置段。

代码层面：

- UI 字体、代码字体挂在 light / dark chrome theme 内：`appearanceLightChromeTheme.fonts`、`appearanceDarkChromeTheme.fonts`。
- UI 字号、代码字号是全局设置：`sansFontSize`、`codeFontSize`。

Schema 证据来自 `/tmp/codex_shared_src.js:14878-14933`：

```js
lightChromeTheme: { key: `appearanceLightChromeTheme`, schema: xS },
darkChromeTheme: { key: `appearanceDarkChromeTheme`, schema: xS },
sansFontSize: { default: 14, key: `sansFontSize`, schema: V() },
codeFontSize: { default: 12, key: `codeFontSize`, schema: V() }
```

`xS` 中的 fonts 结构：

```js
fonts: {
  code: string | null,
  ui: string | null
}
```

### CSS 注入

Codex 在运行时对 `document.documentElement` 和 `document.body` 写 CSS 变量。核心函数会把用户字体拼到默认变量前：

```js
function PN(e, t) {
  return `${e}, var(${t})`;
}
```

关键变量：

| 变量                            | 用途                  |
| ------------------------------- | --------------------- |
| `--font-sans-default`           | UI 默认 fallback 栈   |
| `--font-mono-default`           | 代码默认 fallback 栈  |
| `--vscode-font-family`          | 用户 UI 字体 + 默认栈 |
| `--vscode-editor-font-family`   | 用户代码字体 + 默认栈 |
| `--vscode-font-size`            | UI 基准字号           |
| `--vscode-editor-font-size`     | 代码基准字号          |
| `--codex-chat-font-size`        | 聊天正文字号          |
| `--codex-chat-code-font-size`   | 聊天代码字号          |
| `--diffs-font-family`           | diff 字体             |
| `--diffs-font-size`             | diff 字号             |
| `--text-*` / `--text-heading-*` | UI 字号 token         |

### UI 字号机制

Codex 的 UI 字号不是 Electron zoom，也不是 root font-size + rem 体系。它做的是 token 级缩放：

1. `sansFontSize` 默认 14。
2. 设置 UI 限制输入范围 11 到 16。
3. 运行时计算 `scale = sansFontSize / 14`。
4. 写 `--vscode-font-size: ${sansFontSize}px`。
5. 把内置 `TN` 表里的文字 token 乘以 scale，四舍五入后写为 px 变量。

`TN` 表证据来自 `/tmp/codex_app_main.js:19263-19275`：

```js
var TN = {
  "--text-4xl": 72,
  "--text-3xl": 48,
  "--text-2xl": 36,
  "--text-xl": 28,
  "--text-lg": 16,
  "--text-base": 14,
  "--text-sm": 13,
  "--text-xs": 12,
  "--text-heading-lg": 24,
  "--text-heading-md": 20,
  "--text-heading-sm": 18,
};
```

Codex 另有独立窗口缩放 `--codex-window-zoom` 和主进程 `webContents.setZoomFactor()`，但它们不是设置页 UI 字号的实现路径。

### 代码字号机制

Codex 的代码字号设置默认 12，范围 8 到 24。运行时写：

```js
--vscode-editor-font-size: `${codeFontSize ?? 12}px`
```

随后通过变量链影响聊天代码和 diff：

- `--vscode-chat-editor-font-size`
- `--codex-chat-code-font-size`
- `--diffs-font-size`

### Windows 字体与预设

Codex 没有字体预设下拉。设置页字体输入是文本框，用户自由输入 `font-family`。

默认栈：

```css
--font-sans-default: -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
--font-mono-default:
  ui-monospace, "SFMono-Regular", "SF Mono", Menlo, Consolas, "Liberation Mono",
  monospace;
```

Windows 明确相关字体：

- UI：`"Segoe UI"`
- 代码：`Consolas`

未在 Codex 打包产物中找到这些字体作为默认值或预设：

- `Cascadia`
- `Cascadia Code`
- `Cascadia Mono`
- `Microsoft YaHei`
- `YaHei`
- `微软雅黑`

也未找到按 `process.platform` / `navigator.platform` / `win32` 切换字体默认值或预设列表的逻辑。平台识别主要用于 macOS 字体平滑、WSL、路径、进程等其它逻辑。

### 出厂默认值

| 项       | Codex 默认值                                                                               |
| -------- | ------------------------------------------------------------------------------------------ |
| UI 字体  | `-apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif`                                |
| 代码字体 | `ui-monospace, "SFMono-Regular", "SF Mono", Menlo, Consolas, "Liberation Mono", monospace` |
| UI 字号  | `14`                                                                                       |
| 代码字号 | `12`                                                                                       |

Codex 未找到平台差异；靠 CSS fallback 兼容 macOS / Windows。

## 实施核查清单

- 用户未自定义时，UI 字体和代码字号观感保持旧值；代码字体默认已改为 Codex / 系统等宽栈。
- 用户字体注入必须是 `${用户}, var(--app-font-*-default)`。
- `--app-code-font-size` 只给代码内容，不给 UI mono。
- CodeMirror plain / markdown / table / fence / mermaid fallback 的字体族都要核到。
- `harmonyos-sans-sc-webfont-splitted` patch 后 `:lang(` 为 0，`@font-face` 仍为 574。
- `font-serif` / Source Serif 删除后无残留引用。
- i18n 四语言 key 对齐，不能依赖 fallback 英文。
- Windows 字体 fallback、125% DPI 下的 UI 字号阶段 2 需要实机验证。
