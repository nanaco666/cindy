# format-bundle

批量 beautify 反编译 / 打包后的 JS bundle，让 grep 和阅读变得可能。

## 安装

```bash
cd tools/format-bundle
pnpm install
```

## 用法

```bash
# 格式化一个目录下所有 .js 文件（递归）
node format.mjs ../codex/cd-code/.vite/build

# 多个目录
node format.mjs ../codex/cd-code/.vite/build ../claude/cd-code/vite/build

# 直接覆盖原文件（默认是写到 <name>.pretty.js）
node format.mjs ../codex/cd-code --inplace

# 强制重新格式化（默认有缓存：<name>.pretty.js 比源文件新就跳过）
node format.mjs ../codex/cd-code --force

# 提高/降低大文件阈值（MB，默认 30）
node format.mjs ../codex/cd-code --max-mb 100

# 提高并发（默认 4）
node format.mjs ../codex/cd-code --concurrency 8

# 安静模式
node format.mjs ../codex/cd-code --quiet
```

## 自动跳过

- 非 `.js` 文件
- `*.pretty.js` / `*.lines.js` / `*.min.js`（除非加 `--include-pretty`）
- `node_modules` / `.git` / `dist` / `out` 目录
- 大于 `--max-mb` 的文件（默认 30 MB，如 Codex 的 `comment-preload.js` 28 MB 会处理；超大 renderer bundle 会跳）

## 输出

每个 `<name>.js` 旁边写一份 `<name>.pretty.js`。后续 grep 优先用 `.pretty.js`：

```bash
grep -n "mcp_servers" tools/codex/cd-code/.vite/build/main-BBYeJ7_G.pretty.js
```

## 缓存

如果 `<name>.pretty.js` 的修改时间 ≥ `<name>.js`，下次跑会跳过。改了源文件或加 `--force` 才重新处理。
