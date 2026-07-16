import { describe, expect, it } from 'vitest';
import { commandIntentFromActions, commandIntentFromCommand } from '../commandIntent';

describe('commandIntentFromActions — codex commandActions 解析', () => {
  it('maps read actions with name and path', () => {
    expect(
      commandIntentFromActions([
        { type: 'read', command: 'cat src/app.ts', name: 'app.ts', path: '/repo/src/app.ts' },
      ]),
    ).toEqual({ action: 'read', target: 'app.ts', path: '/repo/src/app.ts' });
  });

  it('falls back to basename when read action has no name', () => {
    expect(commandIntentFromActions([{ type: 'read', command: 'cat x', path: '/repo/src/app.ts' }])).toEqual({
      action: 'read',
      target: 'app.ts',
      path: '/repo/src/app.ts',
    });
  });

  it('maps listFiles with and without path', () => {
    expect(commandIntentFromActions([{ type: 'listFiles', command: 'ls src', path: 'src' }])).toEqual({
      action: 'list',
      target: 'src',
    });
    expect(commandIntentFromActions([{ type: 'listFiles', command: 'ls' }])).toEqual({ action: 'list' });
  });

  it('maps search with query, falling back to path-only search', () => {
    expect(
      commandIntentFromActions([{ type: 'search', command: 'rg foo src', query: 'foo', path: 'src' }]),
    ).toEqual({ action: 'search', target: 'foo', path: 'src' });
    expect(commandIntentFromActions([{ type: 'search', command: 'rg', path: 'src' }])).toEqual({
      action: 'search',
      target: 'src',
    });
  });

  it('takes the first renderable action from a pipeline, skipping unknowns', () => {
    expect(
      commandIntentFromActions([
        { type: 'unknown', command: 'ps aux' },
        { type: 'search', command: 'grep node', query: 'node' },
      ]),
    ).toEqual({ action: 'search', target: 'node' });
  });

  it('rejects read actions whose command is not a known read command (executed binaries)', () => {
    // codex zsh-fork 审批路径会给被执行的二进制也报 Read —— 不能渲染成「读取 rm」。
    expect(
      commandIntentFromActions([{ type: 'read', command: '/bin/rm -rf build', name: 'rm', path: '/bin/rm' }]),
    ).toBeUndefined();
    expect(
      commandIntentFromActions([{ type: 'read', name: 'app.ts', path: '/repo/src/app.ts' }]),
    ).toBeUndefined();
  });

  it('rejects the whole action list when the full command shape is unsafe', () => {
    // 首个 action 无害但后段有副作用(| tee)—— 形态闸整体拒绝,不给
    // commandActions 绕过本地检查的机会。
    const readAction = { type: 'read', command: 'cat README.md', name: 'README.md', path: '/r/README.md' };
    expect(commandIntentFromActions([readAction], 'cat README.md | tee important.conf')).toBeUndefined();
    expect(commandIntentFromActions([readAction], 'cat README.md > out.conf')).toBeUndefined();
    // 展示型管道尾不受影响;不传 fullCommand 时保持旧行为(仅逐 action 门控)。
    expect(commandIntentFromActions([readAction], 'cat README.md | head -5')).toMatchObject({
      action: 'read',
      target: 'README.md',
    });
    expect(commandIntentFromActions([readAction])).toMatchObject({ action: 'read' });
  });

  it('rejects sed read actions unless the command is the read-only -n form', () => {
    // codex 可能给 sed -i 就地编辑也报 read action,只认与本地解析同口径的只读形态。
    expect(
      commandIntentFromActions([
        { type: 'read', command: "sed -i '' 's/a/b/' f.ts", name: 'f.ts', path: '/repo/f.ts' },
      ]),
    ).toBeUndefined();
    expect(
      commandIntentFromActions([
        { type: 'read', command: "sed 's/a/b/' f.ts", name: 'f.ts', path: '/repo/f.ts' },
      ]),
    ).toBeUndefined();
    expect(
      commandIntentFromActions([
        { type: 'read', command: "sed -n '1,10p' f.ts", name: 'f.ts', path: '/repo/f.ts' },
      ]),
    ).toEqual({ action: 'read', target: 'f.ts', path: '/repo/f.ts' });
    // --in-place 长选项与 -i 同义,两条路径都要拒。
    expect(
      commandIntentFromActions([
        { type: 'read', command: "sed -n --in-place '1,10p' f.ts", name: 'f.ts', path: '/repo/f.ts' },
      ]),
    ).toBeUndefined();
    expect(commandIntentFromCommand("sed -n --in-place '1,10p' f.ts")).toBeUndefined();
    expect(commandIntentFromCommand("sed -n --in-place=.bak '1,10p' f.ts")).toBeUndefined();
  });

  it('normalizes cd prefixes in action.command and rejects sed script files', () => {
    // action.command 带 cd 前缀时不能拿 cd 当 bin 绕过副作用检查。
    expect(
      commandIntentFromActions([
        { type: 'search', command: "cd repo && find . -name '*.log' -delete", query: '*.log', path: '.' },
      ]),
    ).toBeUndefined();
    expect(
      commandIntentFromActions([
        { type: 'read', command: 'cd repo && sed -i "s/a/b/" f.ts', name: 'f.ts', path: '/r/f.ts' },
      ]),
    ).toBeUndefined();
    // 干净的 cd 前缀正常剥掉后放行。
    expect(
      commandIntentFromActions([
        { type: 'read', command: 'cd repo && cat README.md', name: 'README.md', path: '/r/README.md' },
      ]),
    ).toMatchObject({ action: 'read', target: 'README.md' });
    // sed -f 从文件加载脚本,内容不可静态判定。
    expect(commandIntentFromCommand('sed -n -f p input.txt')).toBeUndefined();
    expect(
      commandIntentFromActions([
        { type: 'read', command: 'sed -n -f p input.txt', name: 'input.txt', path: '/r/input.txt' },
      ]),
    ).toBeUndefined();
  });

  it('rejects search/listFiles actions whose command is a destructive find shape', () => {
    // codex 上游把 find 的 -name 过滤归类成 search,不能让 -delete/-exec 从
    // commandActions 路径绕过本地 find 门控。
    expect(
      commandIntentFromActions([
        { type: 'search', command: 'find . -name "*.log" -delete', query: '*.log', path: '.' },
      ]),
    ).toBeUndefined();
    expect(
      commandIntentFromActions([
        { type: 'search', command: 'find . -name "*.tmp" -exec rm {} ;', query: '*.tmp' },
      ]),
    ).toBeUndefined();
    expect(
      commandIntentFromActions([{ type: 'listFiles', command: 'find . -delete', path: '.' }]),
    ).toBeUndefined();
    // 非破坏性 find 的 search action 正常接受。
    expect(
      commandIntentFromActions([
        { type: 'search', command: 'find src -name "*.ts"', query: '*.ts', path: 'src' },
      ]),
    ).toEqual({ action: 'search', target: '*.ts', path: 'src' });
  });

  it('returns undefined for all-unknown, malformed, or non-array input', () => {
    expect(commandIntentFromActions([{ type: 'unknown', command: 'foo' }])).toBeUndefined();
    expect(commandIntentFromActions([{ type: 'search', command: 'rg' }])).toBeUndefined();
    expect(commandIntentFromActions([null, 'x', 42, ['y'], { type: 'read' }])).toBeUndefined();
    expect(commandIntentFromActions('not-an-array')).toBeUndefined();
    expect(commandIntentFromActions(undefined)).toBeUndefined();
  });
});

describe('commandIntentFromCommand — 本地规则解析', () => {
  it('parses file reads (cat/head/tail/sed -n)', () => {
    expect(commandIntentFromCommand('cat /repo/src/app.ts')).toEqual({
      action: 'read',
      target: 'app.ts',
      path: '/repo/src/app.ts',
    });
    expect(commandIntentFromCommand('head -n 50 README.md')).toEqual({
      action: 'read',
      target: 'README.md',
      path: 'README.md',
    });
    // cat 的 -n 是布尔 flag,不能吞掉文件名。
    expect(commandIntentFromCommand('cat -n src/index.ts')).toMatchObject({ target: 'index.ts' });
    expect(commandIntentFromCommand("sed -n '120,180p' src/main.ts")).toEqual({
      action: 'read',
      target: 'main.ts',
      path: 'src/main.ts',
    });
    // sed -i 是就地编辑,刻意不解析。
    expect(commandIntentFromCommand("sed -i '' 's/a/b/' f.ts")).toBeUndefined();
  });

  it('parses directory listing and search commands', () => {
    expect(commandIntentFromCommand('ls -la apps/desktop')).toEqual({ action: 'list', target: 'apps/desktop' });
    expect(commandIntentFromCommand('grep -nE "logger\\.|refin" apps/desktop -r')).toEqual({
      action: 'search',
      target: 'logger\\.|refin',
      path: 'apps/desktop',
    });
    expect(commandIntentFromCommand('rg -A 3 useMemo src/renderer')).toEqual({
      action: 'search',
      target: 'useMemo',
      path: 'src/renderer',
    });
    expect(commandIntentFromCommand('grep -e pattern file.txt')).toEqual({
      action: 'search',
      target: 'pattern',
      path: 'file.txt',
    });
    expect(commandIntentFromCommand('find src -name "*.test.ts"')).toEqual({
      action: 'search',
      target: '*.test.ts',
      path: 'src',
    });
    // find 的 -exec / -delete 是破坏性形态,与 rm 同理不解析。
    expect(commandIntentFromCommand('find . -name "*.tmp" -exec rm {} \\;')).toBeUndefined();
    expect(commandIntentFromCommand('find . -name "*.log" -delete')).toBeUndefined();
  });

  it('parses package manager and tool commands', () => {
    expect(commandIntentFromCommand('pnpm install')).toEqual({ action: 'install' });
    expect(commandIntentFromCommand('npm i lodash')).toEqual({ action: 'install', target: 'lodash' });
    expect(commandIntentFromCommand('pnpm add -D vitest')).toEqual({ action: 'install', target: 'vitest' });
    expect(commandIntentFromCommand('pnpm --filter desktop test -- src/x.test.ts')).toEqual({
      action: 'test',
    });
    expect(commandIntentFromCommand('npm run build')).toEqual({ action: 'build' });
    expect(commandIntentFromCommand('pnpm test:migration-replay')).toEqual({ action: 'test' });
    expect(commandIntentFromCommand('npx vitest run')).toEqual({ action: 'test' });
    expect(commandIntentFromCommand('pnpm lint')).toEqual({ action: 'lint' });
    expect(commandIntentFromCommand('tsc --noEmit')).toEqual({ action: 'typecheck' });
    expect(commandIntentFromCommand('cargo clippy')).toEqual({ action: 'lint' });
    expect(commandIntentFromCommand('go test ./...')).toEqual({ action: 'test' });
  });

  it('parses network fetches but rejects mutating curl/wget forms', () => {
    expect(commandIntentFromCommand('curl -s https://api.github.com/repos/x')).toEqual({
      action: 'fetch',
      target: 'https://api.github.com/repos/x',
    });
    // 写盘 / 非只读请求不能只标「访问」。
    expect(commandIntentFromCommand('curl -X DELETE https://api.example/items/1')).toBeUndefined();
    expect(commandIntentFromCommand('curl -XPOST https://api.example/items')).toBeUndefined();
    expect(commandIntentFromCommand('curl -o app.ts https://example.com/app.ts')).toBeUndefined();
    expect(commandIntentFromCommand("curl -d '{\"a\":1}' https://api.example/items")).toBeUndefined();
    // 捆绑短选项里的写盘字符必须拆字符识别(-sO / -LO / -fsSLO)。
    expect(commandIntentFromCommand('curl -sO https://example.com/app.ts')).toBeUndefined();
    expect(commandIntentFromCommand('curl -LO https://example.com/app.ts')).toBeUndefined();
    expect(commandIntentFromCommand('curl -fsSLO https://example.com/app.ts')).toBeUndefined();
    // 纯只读捆绑不误杀。
    expect(commandIntentFromCommand('curl -fsSL https://example.com/api')).toMatchObject({
      action: 'fetch',
    });
    // wget 默认就把响应写成本地文件,裸 wget 也不解析。
    expect(commandIntentFromCommand('wget https://example.com/app.ts')).toBeUndefined();
    expect(commandIntentFromCommand('wget --output-document=x.bin https://example.com/x')).toBeUndefined();
    expect(commandIntentFromCommand('wget --post-data a=1 https://example.com/x')).toBeUndefined();
  });

  it('rejects >&file writes, tree output flags, cd-prefix side effects and zsh =() substitution', () => {
    // bash `>&word`(word 非 fd 数字)等价 `>word 2>&1`,写文件;纯 fd 复制放行。
    expect(commandIntentFromCommand('cat secret.txt >&leak.txt')).toBeUndefined();
    expect(commandIntentFromCommand('cat a.txt 1>&out')).toBeUndefined();
    expect(commandIntentFromCommand('cat a.txt >& leak.txt')).toBeUndefined();
    expect(commandIntentFromCommand('pnpm test 2>&1')).toEqual({ action: 'test' });
    // tree 的 -o FILE / -R(含捆绑短选项)写文件。
    expect(commandIntentFromCommand('tree src -o report.txt')).toBeUndefined();
    expect(commandIntentFromCommand('tree -aR src')).toBeUndefined();
    expect(commandIntentFromCommand('tree src')).toEqual({ action: 'list', target: 'src' });
    // cd 前缀段自身的副作用不能连着 cd 一起被丢掉。
    expect(commandIntentFromCommand('cd repo > touched && cat README.md')).toBeUndefined();
    // zsh =(cmd) 进程替换;引号内 =( 是搜索词不误伤。
    expect(commandIntentFromCommand('rg TODO =(rm -rf build)')).toBeUndefined();
    expect(commandIntentFromCommand('rg "=(" src')).toMatchObject({ action: 'search', target: '=(' });
  });

  it('rejects side-effecting sed scripts, fd exec, rg preprocessors and <> redirection', () => {
    // sed 脚本自身可写文件(w)/执行(e),只接受纯打印形态。
    expect(commandIntentFromCommand("sed -n '1w out.txt' in.txt")).toBeUndefined();
    expect(commandIntentFromCommand("sed -n 's/a/b/p' in.txt")).toBeUndefined();
    expect(
      commandIntentFromActions([
        { type: 'read', command: "sed -n '1w out.txt' in.txt", name: 'in.txt', path: '/r/in.txt' },
      ]),
    ).toBeUndefined();
    // fd -x / --exec 逐结果执行命令。
    expect(commandIntentFromCommand("fd '*.tmp' . -x rm {}")).toBeUndefined();
    expect(commandIntentFromCommand("fd '*.tmp' . --exec-batch rm")).toBeUndefined();
    expect(
      commandIntentFromActions([
        { type: 'search', command: "fd '*.tmp' . -x rm {}", query: '*.tmp', path: '.' },
      ]),
    ).toBeUndefined();
    // rg --pre 预处理器为每个文件 spawn 进程。
    expect(commandIntentFromCommand('rg --pre=rm TODO src')).toBeUndefined();
    expect(
      commandIntentFromActions([
        { type: 'search', command: 'rg --pre=rm TODO src', query: 'TODO', path: 'src' },
      ]),
    ).toBeUndefined();
    // <> 读写重定向会创建目标文件。
    expect(commandIntentFromCommand('cat <> created.txt')).toBeUndefined();
  });

  it('rejects non-fd >& targets, tree output flags, dirty cd prefixes and zsh =()', () => {
    // bash `>&word`(word 非 fd 数字)等价 `>word 2>&1`,写文件。
    expect(commandIntentFromCommand('cat secret.txt >&leak.txt')).toBeUndefined();
    expect(commandIntentFromCommand('cat secret.txt >& leak.txt')).toBeUndefined();
    expect(commandIntentFromCommand('cat secret.txt 1>&out')).toBeUndefined();
    // 真 fd 复制 / 关闭仍放行。
    expect(commandIntentFromCommand('pnpm test 2>&1 | tail -5')).toEqual({ action: 'test' });
    expect(commandIntentFromCommand('cat a.txt 2>&-')).toMatchObject({ action: 'read' });
    // tree 的 -o / -R 写文件;ls -R 不受影响。
    expect(commandIntentFromCommand('tree src -o report.txt')).toBeUndefined();
    expect(commandIntentFromCommand('tree -L 2 src')).toMatchObject({ action: 'list', target: 'src' });
    expect(commandIntentFromCommand('ls -R src')).toMatchObject({ action: 'list', target: 'src' });
    // cd 前缀段丢弃前必须干净(无重定向等副作用)。
    expect(commandIntentFromCommand('cd repo > touched && cat README.md')).toBeUndefined();
    expect(commandIntentFromCommand('cd /repo && pnpm test')).toEqual({ action: 'test' });
    // zsh =( ) 进程替换,含独立 < 之后的形态。
    expect(commandIntentFromCommand('rg TODO =(rm -rf build)')).toBeUndefined();
    expect(commandIntentFromCommand('cat < =(rm -rf build)')).toBeUndefined();
  });

  it('tracks unquoted metacharacters per character, not per token', () => {
    // 混合引号紧贴重定向:> 未引号、目标带引号,shell 仍是写文件。
    expect(commandIntentFromCommand('cat README.md>"important.conf"')).toBeUndefined();
    expect(commandIntentFromCommand('grep foo src>"report.txt"')).toBeUndefined();
    // env 赋值段黏着重定向,不能当无害前缀白丢。
    expect(commandIntentFromCommand('LOG=x>secret.txt cat README.md')).toBeUndefined();
    // 引号里的元字符是普通内容,不受影响。
    expect(commandIntentFromCommand('rg ">" src')).toMatchObject({ action: 'search', target: '>' });
    expect(commandIntentFromCommand('NODE_ENV=test pnpm vitest run')).toEqual({ action: 'test' });
  });

  it('scans curl short bundles with non-letter chars and parses attached regexp values', () => {
    // 捆绑里混非字母字符时写盘的 O 仍要命中。
    expect(commandIntentFromCommand('curl -#O https://example.com/a.tgz')).toBeUndefined();
    expect(commandIntentFromCommand('curl -# https://example.com/api')).toMatchObject({
      action: 'fetch',
    });
    // --regexp= / -e 紧贴值:pattern 取紧贴值,不把搜索路径错标成 pattern。
    expect(commandIntentFromCommand('rg --regexp=TODO src')).toEqual({
      action: 'search',
      target: 'TODO',
      path: 'src',
    });
    expect(commandIntentFromCommand('grep -eTODO file.txt')).toEqual({
      action: 'search',
      target: 'TODO',
      path: 'file.txt',
    });
    // listFiles action 门控与本地 tree 口径一致。
    expect(
      commandIntentFromActions([{ type: 'listFiles', command: 'tree -o report.txt', path: '.' }]),
    ).toBeUndefined();
    expect(
      commandIntentFromActions([{ type: 'listFiles', command: 'tree src', path: 'src' }]),
    ).toEqual({ action: 'list', target: 'src' });
  });

  it('rejects curl trace/stderr outputs and grep/rg -f pattern files', () => {
    expect(commandIntentFromCommand('curl --trace trace.log https://example.com')).toBeUndefined();
    expect(commandIntentFromCommand('curl --trace-ascii t.log https://example.com')).toBeUndefined();
    expect(commandIntentFromCommand('curl --stderr err.log https://example.com')).toBeUndefined();
    // -f 的 pattern 来自文件,首个 positional 是路径不是 pattern,回退原文。
    expect(commandIntentFromCommand('grep -f patterns.txt file.txt')).toBeUndefined();
    expect(commandIntentFromCommand('rg -f patterns.txt src')).toBeUndefined();
  });

  it('rejects attached fd exec and grep pattern-file short forms', () => {
    // 紧贴 / 捆绑短选项形态同样要命中。
    expect(commandIntentFromCommand("fd '*.tmp' . -xrm {}")).toBeUndefined();
    expect(
      commandIntentFromActions([
        { type: 'search', command: "fd '*.tmp' . -xrm {}", query: '*.tmp', path: '.' },
      ]),
    ).toBeUndefined();
    expect(commandIntentFromCommand('grep -fpatterns.txt file.txt')).toBeUndefined();
    expect(commandIntentFromCommand('rg -fpatterns.txt src')).toBeUndefined();
    expect(commandIntentFromCommand('grep -rf patterns.txt dir')).toBeUndefined();
    // -F(fixed-strings)与含 f 的 -e 紧贴 pattern 不误伤。
    expect(commandIntentFromCommand('rg -F literal src')).toMatchObject({
      action: 'search',
      target: 'literal',
    });
    expect(commandIntentFromCommand('grep -efoo file.txt')).toMatchObject({
      action: 'search',
      target: 'foo',
    });
  });

  it('rejects tool write modes: eslint --fix, non-noEmit tsc, snapshot updates, curl --etag-save', () => {
    // eslint --fix 改写源码;--fix-dry-run 不落盘。
    expect(commandIntentFromCommand('eslint --fix src')).toBeUndefined();
    expect(commandIntentFromCommand('pnpm eslint --fix src')).toBeUndefined();
    expect(commandIntentFromCommand('eslint --fix-dry-run src')).toEqual({ action: 'lint' });
    expect(commandIntentFromCommand('eslint src')).toEqual({ action: 'lint' });
    // tsc 只有 --noEmit 是纯类型检查;裸 tsc 产出 JS、--init 写 tsconfig。
    expect(commandIntentFromCommand('tsc --init')).toBeUndefined();
    expect(commandIntentFromCommand('tsc -p .')).toBeUndefined();
    expect(commandIntentFromCommand('npx tsc --noEmit')).toEqual({ action: 'typecheck' });
    // 快照更新会改写测试文件。
    expect(commandIntentFromCommand('npx vitest run -u')).toBeUndefined();
    expect(commandIntentFromCommand('pnpm jest --updateSnapshot')).toBeUndefined();
    // curl --etag-save 写 etag 文件。
    expect(commandIntentFromCommand('curl --etag-save etag.txt https://example.com')).toBeUndefined();
    // script 转发参数携带写文件 flag。
    expect(commandIntentFromCommand('npm test -- --updateSnapshot')).toBeUndefined();
    expect(commandIntentFromCommand('pnpm run lint -- --fix')).toBeUndefined();
    expect(commandIntentFromCommand('pnpm lint -- --fix')).toBeUndefined();
    expect(commandIntentFromCommand('pnpm run lint')).toEqual({ action: 'lint' });
    // cargo clippy --fix 改写源码。
    expect(commandIntentFromCommand('cargo clippy --fix')).toBeUndefined();
    expect(commandIntentFromCommand('cargo clippy')).toEqual({ action: 'lint' });
    // 管道尾 less 的日志文件选项(-O / --LOG-FILE)把管道内容写盘。
    expect(commandIntentFromCommand('cat README.md | less --LOG-FILE=copy.txt')).toBeUndefined();
    expect(commandIntentFromCommand('cat README.md | less -Ocopy.txt')).toBeUndefined();
    expect(commandIntentFromCommand('cat README.md | less')).toMatchObject({ action: 'read' });
    // curl --libcurl 把等价 C 代码写盘。
    expect(commandIntentFromCommand('curl --libcurl client.c https://example.com')).toBeUndefined();
    // less 的 + 启动命令可执行 shell。
    expect(commandIntentFromCommand("less '+!touch pwned' README.md")).toBeUndefined();
    expect(commandIntentFromCommand('less README.md')).toMatchObject({ action: 'read' });
    expect(
      commandIntentFromActions([
        { type: 'read', command: "less '+!touch pwned' README.md", name: 'README.md', path: '/r/README.md' },
      ]),
    ).toBeUndefined();
    // go test 的编译/输出模式不跑测试。
    expect(commandIntentFromCommand('go test -c -o pkg.test ./...')).toBeUndefined();
    expect(commandIntentFromCommand('go test ./...')).toEqual({ action: 'test' });
    // curl 缓存 / write-out 写文件形态。
    expect(commandIntentFromCommand('curl --hsts cache.txt https://example.com')).toBeUndefined();
    expect(commandIntentFromCommand('curl --alt-svc as.txt https://example.com')).toBeUndefined();
    expect(commandIntentFromCommand("curl -w '%output{report.txt}ok' https://example.com")).toBeUndefined();
    // rg --files 是列文件模式,不是搜索。
    expect(commandIntentFromCommand('rg --files src | head -20')).toEqual({
      action: 'list',
      target: 'src',
    });
    // cargo test --no-run 只编译不跑。
    expect(commandIntentFromCommand('cargo test --no-run')).toBeUndefined();
    // 引号伪装的 fd 复制目标是字面文件名(bash 会创建文件 &2)。
    expect(commandIntentFromCommand('cat README.md >"&2"')).toBeUndefined();
    expect(commandIntentFromCommand('cat README.md > "&2"')).toBeUndefined();
    // 布尔取值形态:--fix=true 落盘,--noEmit false 仍产出 JS。
    expect(commandIntentFromCommand('eslint --fix=true src')).toBeUndefined();
    expect(commandIntentFromCommand('pnpm run lint -- --fix=true')).toBeUndefined();
    expect(commandIntentFromCommand('tsc --noEmit false a.ts')).toBeUndefined();
    expect(commandIntentFromCommand('npx tsc --noEmit false')).toBeUndefined();
    expect(commandIntentFromCommand('tsc --noEmit')).toEqual({ action: 'typecheck' });
  });

  it('rejects curl config files and make with multiple targets', () => {
    // -K/--config 从文件读参数,可注入 -O 等写盘选项,静态不可判定。
    expect(commandIntentFromCommand('curl -K opts https://example.com')).toBeUndefined();
    expect(commandIntentFromCommand('curl --config opts https://example.com')).toBeUndefined();
    // make 会执行全部 target,多 target 只标首个会隐藏后续动作。
    expect(commandIntentFromCommand('make test clean')).toBeUndefined();
    expect(commandIntentFromCommand('make test deploy')).toBeUndefined();
    expect(commandIntentFromCommand('make test')).toEqual({ action: 'test' });
    expect(commandIntentFromCommand('make')).toEqual({ action: 'build' });
  });

  it('rejects process substitution and find file-writing actions', () => {
    // 进程替换内嵌任意命令,不能被当成无害输入重定向丢掉。
    expect(commandIntentFromCommand('cat <(rm -rf build)')).toBeUndefined();
    expect(commandIntentFromCommand('diff <(sort a.txt) <(sort b.txt)')).toBeUndefined();
    // 独立 < 之后跟进程替换:消费目标前必须检查。
    expect(commandIntentFromCommand('cat < <(rm -rf build)')).toBeUndefined();
    expect(commandIntentFromCommand('grep foo < <(rm -rf build)')).toBeUndefined();
    // 引号里的 <( 是搜索词,不误伤。
    expect(commandIntentFromCommand('rg "<(" src')).toMatchObject({ action: 'search', target: '<(' });
    // find 的 -fprint 家族会创建/截断输出文件。
    expect(commandIntentFromCommand("find . -name '*.log' -fprint report.txt")).toBeUndefined();
    expect(commandIntentFromCommand("find . -name '*.log' -fls listing.txt")).toBeUndefined();
    expect(
      commandIntentFromActions([
        { type: 'search', command: "find . -name '*.log' -fprint report.txt", query: '*.log', path: '.' },
      ]),
    ).toBeUndefined();
    expect(
      commandIntentFromActions(
        [{ type: 'read', command: 'cat <(rm -rf build)', name: 'build', path: '/x/build' }],
      ),
    ).toBeUndefined();
  });

  it('strips cd prefixes, env assignments and display-only pipe filters', () => {
    expect(commandIntentFromCommand('cd /repo && pnpm test')).toEqual({ action: 'test' });
    expect(commandIntentFromCommand('NODE_ENV=test pnpm vitest run')).toEqual({ action: 'test' });
    expect(commandIntentFromCommand('grep -n foo src/a.ts | head -20')).toEqual({
      action: 'search',
      target: 'foo',
      path: 'src/a.ts',
    });
  });

  it('bails out on file-writing redirection but keeps harmless stream forms', () => {
    // > / >> 会创建/覆盖文件,不能渲染成无害的「读取/搜索」。
    expect(commandIntentFromCommand('cat README.md > important.conf')).toBeUndefined();
    expect(commandIntentFromCommand('grep foo src > report')).toBeUndefined();
    expect(commandIntentFromCommand('cat a.txt >> log.txt')).toBeUndefined();
    // shell 重定向不要求空格:紧贴形态同样拒;引号里的 > 是搜索词,不受影响。
    expect(commandIntentFromCommand('cat README.md>important.conf')).toBeUndefined();
    expect(commandIntentFromCommand('grep foo src>report')).toBeUndefined();
    expect(commandIntentFromCommand('rg "=>" src')).toEqual({
      action: 'search',
      target: '=>',
      path: 'src',
    });
    // 后台 & 会隐藏第二条命令,整体放弃(cat foo & rm -rf bar 不能标成「读取」)。
    expect(commandIntentFromCommand('cat foo.txt & rm -rf bar')).toBeUndefined();
    // 管道尾段的写文件重定向同样不能放过。
    expect(commandIntentFromCommand('cat README.md | head -5 > important.conf')).toBeUndefined();
    expect(commandIntentFromCommand('grep foo src | tee report.txt')).toBeUndefined();
    // 白名单过滤器自带的写文件形态(sort -o / uniq IN OUT)也要拒。
    expect(commandIntentFromCommand('cat README.md | sort -o important.conf')).toBeUndefined();
    expect(commandIntentFromCommand('cat README.md | uniq dup.txt out.txt')).toBeUndefined();
    expect(commandIntentFromCommand('grep foo src | sort | head -5')).toMatchObject({
      action: 'search',
      target: 'foo',
    });
    // fd 复制与丢弃流无副作用,照常解析(含管道尾段上的)。
    expect(commandIntentFromCommand('pnpm test 2>&1 | tail -5')).toEqual({ action: 'test' });
    expect(commandIntentFromCommand('grep -n foo src/a.ts | head -20 2>/dev/null')).toMatchObject({
      action: 'search',
      target: 'foo',
    });
    expect(commandIntentFromCommand('cat a.txt 2>/dev/null')).toMatchObject({
      action: 'read',
      target: 'a.txt',
    });
  });

  it('bails out on complex or unparseable shapes', () => {
    // 管道尾段不是纯展示过滤器。
    expect(commandIntentFromCommand('ps aux | grep node')).toBeUndefined();
    // 多段命令链 / 分支 / 子命令替换 / 多行。
    expect(commandIntentFromCommand('pnpm build && pnpm test')).toBeUndefined();
    expect(commandIntentFromCommand('pnpm test || echo failed')).toBeUndefined();
    expect(commandIntentFromCommand('echo $(date)')).toBeUndefined();
    expect(commandIntentFromCommand('cat <<EOF\nhi\nEOF')).toBeUndefined();
    // 引号里的分隔符不影响解析,未闭合引号放弃。
    expect(commandIntentFromCommand('grep "a && b" src')).toEqual({
      action: 'search',
      target: 'a && b',
      path: 'src',
    });
    expect(commandIntentFromCommand('grep "unterminated')).toBeUndefined();
    // 认不出的命令与破坏性命令。
    expect(commandIntentFromCommand('git status')).toBeUndefined();
    expect(commandIntentFromCommand('rm -rf node_modules')).toBeUndefined();
    expect(commandIntentFromCommand('')).toBeUndefined();
  });
});
