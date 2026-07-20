import { basenameRemotePath } from './filePreview.js';

/**
 * 命令「意图」解析（issue #450 codex 人话摘要）。
 *
 * Claude Code 的 Bash 有模型自写的 `description`，codex 的 shell 工具 schema
 * 没有等价字段 —— 本模块用两条**纯代码确定性**路径（规则 9）为 command 描述符
 * 补上结构化意图，供各端渲染成「读取 index.ts」「搜索 "logger"」这类人话：
 *
 * 1. `commandIntentFromActions`：消费 codex app-server v2 CommandExecution 自带的
 *    `commandActions`（codex 侧 parse_command 的确定性产物，read / listFiles /
 *    search / unknown 四类）。
 * 2. `commandIntentFromCommand`：本地规则表解析命令原文，兜底 codex 的 unknown
 *    命令与 Claude 漏填 description 的场景。
 *
 * 安全不变量（review 逐条钉死的口径）：**有副作用的命令绝不能被贴上无害的
 * 人话动词**（「读取 / 搜索 / 列出」），必须回退原文可见。所有形态级安全检查
 * 统一收在 `analyzeCommandShape`：命令链（&& / ; / &）、非展示型管道尾
 * （tee / xargs …）、写文件重定向（含紧贴形态 `a>b`）、子命令替换 / heredoc /
 * 多行,任一命中即整体放弃解析。`commandActions` 路径在采纳任何 action 前也
 * 必须先过同一道闸（防止「首个 action 无害、后段有副作用」的组合绕过），并
 * 对 read / search / listFiles action 各自再做语义门控（executable-read、
 * sed 就地编辑、破坏性 find）。`rm` 等破坏性命令**刻意不进规则表**。
 *
 * 与 toolUseDescriptor 一致：只输出结构化数据，不拼面向用户的句子；任意残缺
 * 输入不抛异常。
 */

// ── 类型 ─────────────────────────────────────────────────────────────────────

export type CommandIntentAction =
  | 'read'
  | 'list'
  | 'search'
  | 'fetch'
  | 'install'
  | 'test'
  | 'build'
  | 'lint'
  | 'typecheck'
  | 'runScript'
  | 'checkSyntax'
  | 'showVersion'
  | 'checkFormatting'
  | 'parseJson'
  | 'count'
  | 'showCurrentDirectory'
  | 'showDateTime'
  | 'locateCommand'
  | 'inspectProcesses'
  | 'inspectPorts'
  | 'queryDatabase'
  | 'gitStatus'
  | 'gitDiff'
  | 'gitLog'
  | 'gitShow'
  | 'gitAdd'
  | 'gitCommit'
  | 'gitFetch'
  | 'gitPull'
  | 'gitPush'
  | 'gitRemote'
  | 'gitRevParse'
  | 'gitBranch'
  | 'gitGrep'
  | 'gitMergeBase'
  | 'gitLsFiles'
  | 'gitRevList'
  | 'gitLsRemote'
  | 'gitWorktreeList'
  | 'gitWorktreeAdd'
  | 'gitWorktreeRemove'
  | 'gitWorktreeMove'
  | 'gitWorktreePrune'
  | 'ghPrList'
  | 'ghPrView'
  | 'ghPrChecks'
  | 'ghPrStatus'
  | 'ghPrDiff'
  | 'ghPrCreate'
  | 'ghPrEdit'
  | 'ghPrComment'
  | 'ghPrReview'
  | 'ghPrMerge'
  | 'ghPrClose'
  | 'ghPrReopen'
  | 'ghPrCheckout'
  | 'ghIssueList'
  | 'ghIssueView'
  | 'ghIssueStatus'
  | 'ghIssueCreate'
  | 'ghIssueEdit'
  | 'ghIssueComment'
  | 'ghIssueClose'
  | 'ghIssueReopen'
  | 'ghAuthStatus'
  | 'ghAuthLogin'
  | 'ghAuthLogout'
  | 'ghAuthRefresh'
  | 'ghAuthSwitch'
  | 'ghRunList'
  | 'ghRunView'
  | 'ghRunWatch'
  | 'ghSearch'
  | 'ghRepoList'
  | 'ghRepoView'
  | 'ghApiQuery'
  | 'ghApiMutation'
  | 'ghApiCall';

export interface CommandIntent {
  action: CommandIntentAction;
  /** 意图参数（文件名 / 搜索词 / URL / 包名等）；缺省时消费端回退命令原文。 */
  target?: string;
  /** 作用范围路径（读取的完整路径 / 搜索目录），只进 hover 细节不进主文案。 */
  path?: string;
}

/**
 * tokenize 产物:text 已去引号;unquotedMeta 标记 token 是否含**未引号**的
 * shell 元字符(< / > / ()。按字符粒度记录,`cat a>"b"`(未引号 > + 引号
 * 目标)与 `rg ">" src`(元字符整体在引号里)才能被正确区分 —— token 级
 * 「是否带引号」布尔分不清这两种形态。
 */
interface ShellWord {
  text: string;
  unquotedMeta: boolean;
  /** token 是否含引号部分 —— `>"&2"` 里被引号的 `&2` 是文件名而非 fd 复制。 */
  hasQuoted: boolean;
}

// ── codex commandActions → intent ────────────────────────────────────────────

/** read action 门控:action.command 的首 token 必须是这些已知读文件命令。 */
const READ_COMMAND_BINS = new Set(['cat', 'head', 'tail', 'less', 'more', 'sed', 'bat', 'nl']);

/**
 * find 的副作用 action 家族 —— 命中即不解析,保持原文可见(与 rm / sed -i 同理)。
 * 除执行/删除类外,-fprint 家族(-fprint / -fprint0 / -fprintf / -fls)会
 * 创建/截断输出文件,同样不能贴「搜索」动词。
 */
const FIND_DESTRUCTIVE_FLAGS = new Set([
  '-exec', '-execdir', '-ok', '-okdir', '-delete',
  '-fprint', '-fprint0', '-fprintf', '-fls',
]);

/**
 * 解析 codex `commandActions`（v2 协议 CommandAction[]，serde camelCase tag：
 * read / listFiles / search / unknown）。管道命令会拆成多个 action，取第一个
 * 可渲染项 —— 首个动作即主意图，后续通常是 head/wc 之类过滤器。
 *
 * 传入 `fullCommand` 时（describeToolUse 的 exec 路径总是传），先对完整命令
 * 过 `analyzeCommandShape` 形态闸：`cat a | tee b` 这类首个 action 无害、
 * 后段有副作用的组合会被整体拒绝，不给 commandActions 绕过本地检查的机会。
 *
 * 单个 action 也不盲信：
 * - read：codex 在某些路径（如 zsh-fork 审批）会给**被执行的二进制**也报
 *   `Read { name: "rm" }`，要求 action.command 首 token 是已知读文件命令
 *   （sed 另须只读形态）才接受；
 * - search / listFiles：codex 会把 `find … -delete/-exec` 的 -name 过滤归类
 *   成 search，对 action.command 做破坏性 find 检查。
 */
export function commandIntentFromActions(raw: unknown, fullCommand?: string): CommandIntent | undefined {
  if (!Array.isArray(raw)) return undefined;
  if (fullCommand !== undefined && analyzeCommandShape(fullCommand) === undefined) return undefined;
  for (const entry of raw) {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) continue;
    const action = entry as Record<string, unknown>;
    switch (action.type) {
      case 'read': {
        if (!isKnownReadCommand(readNonEmptyString(action.command))) continue;
        const path = readNonEmptyString(action.path);
        const name = readNonEmptyString(action.name) ?? (path ? basenameRemotePath(path) : undefined);
        if (!name) continue;
        return { action: 'read', target: name, ...(path ? { path } : {}) };
      }
      case 'listFiles': {
        if (searchCommandHasSideEffects(readNonEmptyString(action.command))) continue;
        const path = readNonEmptyString(action.path);
        return { action: 'list', ...(path ? { target: path } : {}) };
      }
      case 'search': {
        if (searchCommandHasSideEffects(readNonEmptyString(action.command))) continue;
        const query = readNonEmptyString(action.query);
        const path = readNonEmptyString(action.path);
        if (query) return { action: 'search', target: query, ...(path ? { path } : {}) };
        if (path) return { action: 'search', target: path };
        continue;
      }
      default:
        continue;
    }
  }
  return undefined;
}

// ── 命令原文 → intent（本地规则表） ──────────────────────────────────────────

/** 管道尾段允许的纯展示型过滤器；出现其它命令（如 grep / tee / xargs）就放弃解析。 */
const PIPE_FILTERS = new Set([
  'head', 'tail', 'wc', 'sort', 'uniq', 'less', 'more', 'cat', 'column', 'nl', 'sed',
]);

/** 单条命令长度上限 —— 超长命令多半是脚本内联，解析价值低且徒增开销。 */
const COMMAND_MAX_CHARS = 1000;

/**
 * 形态安全分析：整条命令通过全部检查时返回首段 argv（已去引号、剥 env/sudo
 * 前缀与无害重定向），任何不安全 / 解析不了的形态返回 undefined。
 *
 * 检查项：
 * - 子命令替换（$( / 反引号）、heredoc、多行、`||` 分支 → 放弃；
 * - 顶层命令链（&& / ; / 后台 `&`）→ 剥掉前导 cd 后仍多于一段就放弃
 *   （`cat foo & rm -rf bar` 不能渲染成「读取 foo」）；
 * - 管道尾段必须全是展示型过滤器，且每段同样过写文件重定向检查；
 * - 首段命中写文件重定向（含紧贴形态 `a>b`）→ 放弃。
 */
function analyzeCommandShape(command: string): string[] | undefined {
  if (typeof command !== 'string') return undefined;
  const trimmed = command.trim();
  if (!trimmed || trimmed.length > COMMAND_MAX_CHARS) return undefined;
  if (/[`\n]|\$\(|<</.test(trimmed)) return undefined;

  const chain = splitTopLevel(trimmed, ['&&', ';', '&']);
  if (chain === undefined) return undefined;
  // 剥掉前导的 cd（agent 常见形态：cd <dir> && <真实命令>）。丢弃前必须
  // 验证该段真的只是 `cd <dir>` —— `cd repo > touched && cat a` 的 cd 段
  // 带写文件重定向,不能无检查跳过。
  while (chain.length > 1 && /^cd(\s|$)/.test(chain[0])) {
    const cdWords = tokenize(chain[0]);
    if (!cdWords) return undefined;
    const cdArgv = stripPrefixTokens(cdWords);
    if (!cdArgv || cdArgv.length > 2 || binaryName(cdArgv[0] ?? '') !== 'cd') return undefined;
    chain.shift();
  }
  if (chain.length !== 1) return undefined;

  const pipeline = splitTopLevel(chain[0], ['|']);
  if (pipeline === undefined || pipeline.length === 0) return undefined;
  for (let index = 1; index < pipeline.length; index += 1) {
    const tailWords = tokenize(pipeline[index]);
    if (!tailWords || tailWords.length === 0) return undefined;
    // 尾段同样过副作用检查:`| head -5 > out` 的写文件重定向不能藏进管道尾。
    const tail = stripPrefixTokens(tailWords);
    if (!tail || tail.length === 0) return undefined;
    if (!PIPE_FILTERS.has(binaryName(tail[0]))) return undefined;
    if (binaryName(tail[0]) === 'sed') {
      if (!sedPipelineFilterIsReadOnly(tail.slice(1))) return undefined;
      continue;
    }
    // 白名单过滤器自身的写文件形态也要拒:sort -o FILE / uniq IN OUT。
    // 展示型过滤器在管道里正常不接文件参数,positional 只放行行数类数字
    // (head -n 50 / tail -n +10);-o / --output 一律拒(column -o 是分隔符,
    // 误杀代价只是回退原文)。
    const tailRest = tail.slice(1);
    // 大小写不敏感匹配:sort -o、less -o/-O(--log-file/--LOG-FILE)都写文件。
    if (
      tailRest.some((token) => {
        const lower = token.toLowerCase();
        return lower.startsWith('-o') || lower.startsWith('--output') || lower.startsWith('--log-file');
      })
    ) {
      return undefined;
    }
    if (positionals(tailRest, new Set(['-n', '-c'])).some((token) => !/^[+-]?\d+$/.test(token))) {
      return undefined;
    }
  }

  const words = tokenize(pipeline[0]);
  if (!words || words.length === 0) return undefined;
  const argv = stripPrefixTokens(words);
  if (!argv || argv.length === 0) return undefined;
  return argv;
}

/**
 * 从命令原文解析意图。可靠性优先：形态安全检查见 `analyzeCommandShape`；
 * 通过后按首段 argv 的二进制名走规则表，握不准一律返回 undefined 回退原文。
 */
export function commandIntentFromCommand(command: string): CommandIntent | undefined {
  const argv = typeof command === 'string' ? analyzeCommandShape(command) : undefined;
  if (!argv) return undefined;

  const bin = binaryName(argv[0]);
  const rest = argv.slice(1);
  switch (bin) {
    case 'cat': {
      const file = positionals(rest, new Set([]))[0];
      if (!file) return undefined;
      return { action: 'read', target: basenameRemotePath(file) || file, path: file };
    }
    case 'less':
    case 'more': {
      // less 的 + 启动命令可执行 shell / 写文件(`less '+!touch x' f` /
      // `+s`),含 + 参数一律拒。
      if (rest.some((token) => token.startsWith('+'))) return undefined;
      const file = positionals(rest, new Set([]))[0];
      if (!file) return undefined;
      return { action: 'read', target: basenameRemotePath(file) || file, path: file };
    }
    case 'head':
    case 'tail': {
      // head/tail 的 -n/-c 是取值型（`head -n 50 file`）；cat 的 -n 是布尔,分开处理。
      const file = positionals(rest, new Set(['-n', '-c']))[0];
      if (!file) return undefined;
      return { action: 'read', target: basenameRemotePath(file) || file, path: file };
    }
    case 'nl': {
      const file = positionals(rest, NL_VALUE_FLAGS)[0];
      if (!file) return undefined;
      return { action: 'read', target: basenameRemotePath(file) || file, path: file };
    }
    case 'sed': {
      // 只认只读形态 `sed -n '<range>p' <file>`（agent 常用来看文件片段）；
      // -i / --in-place 的就地编辑不解析,保持原文可见。
      if (!sedTokensAreReadOnly(rest)) return undefined;
      const pos = positionals(rest, new Set(['-e']));
      const file = pos[1];
      if (!file) return undefined;
      return { action: 'read', target: basenameRemotePath(file) || file, path: file };
    }
    case 'ls':
    case 'tree': {
      // tree 的 -o FILE 输出到文件、-R 写 00Tree.html;短 flag 可能捆绑,
      // 含 o/R 字符即拒(--noreport 被误杀的代价只是回退原文)。ls 不受影响。
      if (bin === 'tree' && rest.some((token) => token.startsWith('-') && /[oR]/.test(token))) {
        return undefined;
      }
      // tree 的 -L(层数)/--filelimit 是取值型,别把值当路径。
      const pos = positionals(rest, bin === 'tree' ? new Set(['-L', '--filelimit']) : new Set([]));
      return { action: 'list', ...(pos[0] ? { target: pos[0] } : {}) };
    }
    case 'grep':
    case 'egrep':
    case 'fgrep':
    case 'rg':
    case 'ag':
      return grepIntent(rest);
    case 'find': {
      // -exec / -delete 家族是破坏性形态,与 rm / sed -i 同理刻意不解析,
      // 保持原文可见,不贴无害的「搜索」动词。
      if (rest.some((token) => FIND_DESTRUCTIVE_FLAGS.has(token))) {
        return undefined;
      }
      const nameIndex = rest.findIndex((token) => token === '-name' || token === '-iname');
      const pattern = nameIndex >= 0 ? rest[nameIndex + 1] : undefined;
      const path = rest[0] && !rest[0].startsWith('-') ? rest[0] : undefined;
      if (!pattern) return { action: 'list', ...(path ? { target: path } : {}) };
      return { action: 'search', target: pattern, ...(path ? { path } : {}) };
    }
    case 'fd': {
      // -x/--exec 会对每个结果执行命令(`fd '*.tmp' . -x rm {}`),不解析。
      if (rest.some((token) => hasFdExecFlag(token))) return undefined;
      const pos = positionals(rest, new Set(['-e', '-t', '-E', '--extension', '--type', '--exclude']));
      if (!pos[0]) return undefined;
      return { action: 'search', target: pos[0], ...(pos[1] ? { path: pos[1] } : {}) };
    }
    case 'curl': {
      // 写盘 / 变更类 flag(-o/-O 输出文件、-X/-d/-F 非只读请求)不能只
      // 渲染成「访问 <url>」,回退原文。wget 不在此列:它默认就把响应写成
      // 本地文件,裸 wget 也不解析(见 default 分支)。
      if (hasMutatingCurlFlag(rest)) return undefined;
      const url = rest.find((token) => /^https?:\/\//.test(token));
      if (!url) return undefined;
      return { action: 'fetch', target: url };
    }
    case 'node':
      return nodeIntent(rest);
    case 'jq':
      return jqIntent(rest);
    case 'wc':
      return countIntent(rest);
    case 'pwd':
      return rest.every((token) => ['-L', '-P', '--logical', '--physical'].includes(token))
        ? { action: 'showCurrentDirectory' }
        : undefined;
    case 'date':
      return dateIntent(rest);
    case 'command':
      return locateCommandIntent(rest);
    case 'which': {
      const targets = positionals(rest, new Set([]));
      return targets[0] ? { action: 'locateCommand', target: targets.join(' ') } : undefined;
    }
    case 'ps':
    case 'pgrep':
      return { action: 'inspectProcesses' };
    case 'lsof':
      return lsofIntent(rest);
    case 'sqlite3':
      return sqliteIntent(rest);
    case 'git':
      if (isVersionRequest(rest)) return { action: 'showVersion', target: 'Git' };
      return gitIntent(rest);
    case 'gh':
      if (isVersionRequest(rest)) return { action: 'showVersion', target: 'GitHub CLI' };
      return githubCliIntent(rest);
    case 'pnpm':
    case 'npm':
    case 'yarn':
    case 'bun':
      return packageManagerIntent(bin, rest);
    case 'npx':
    case 'pnpx':
    case 'bunx': {
      const tool = positionals(rest, new Set([]))[0];
      return tool ? toolBinaryIntent(tool, argsAfter(rest, tool)) : undefined;
    }
    case 'make': {
      // GNU make 会执行**全部** target,多 target(make test deploy)只标
      // 首个会隐藏后续动作,回退原文。
      const goals = positionals(rest, new Set(['-C', '-j', '-f']));
      if (goals.length === 0) return { action: 'build' };
      if (goals.length > 1) return undefined;
      return scriptIntent(goals[0]);
    }
    case 'cargo':
      return cargoIntent(rest[0], rest.slice(1));
    case 'go': {
      if (rest[0] === 'test') {
        // -c 只编译不跑、-o 写测试二进制,不能标「运行测试」。
        if (rest.some((token) => token === '-c' || token === '-o' || token.startsWith('-o='))) {
          return undefined;
        }
        return { action: 'test' };
      }
      if (rest[0] === 'build') return { action: 'build' };
      if (rest[0] === 'vet') return { action: 'lint' };
      return undefined;
    }
    default:
      return toolBinaryIntent(bin, rest);
  }
}

// ── 各命令族的意图规则 ───────────────────────────────────────────────────────

/**
 * curl 的写盘 / 变更类长 flag 前缀(startsWith 匹配,覆盖 `--data-raw` /
 * `--form-string` 等派生形态;前缀命中偏保守,代价只是回退原文)。
 */
const CURL_MUTATING_LONG_FLAGS = [
  '--output', '--remote-name', '--request', '--data', '--form', '--upload-file', '--json',
  '--dump-header', '--cookie-jar', '--trace', '--stderr', '--config', '--etag-save', '--libcurl',
  '--alt-svc', '--hsts', '--write-out',
];

/**
 * curl 写盘 / 变更类短选项字符(大小写敏感)。o/O 写响应文件,X 改方法,
 * d/F/T 非只读请求,D dump-header 写文件,c cookie-jar 写文件,
 * K 从配置文件读参数(可注入 output= / -O 等任意写盘选项,静态不可判定),
 * w write-out 可经 %output{FILE} 写文件。
 */
const CURL_MUTATING_SHORT_CHARS = new Set(['o', 'O', 'X', 'd', 'F', 'T', 'D', 'c', 'K', 'w']);

/**
 * curl 变更形态判定。短选项必须**拆字符**查:curl 允许捆绑短选项,写盘的
 * -O 常见于 `curl -sO` / `curl -fsSLO`,整体 startsWith 会漏掉捆绑在其它
 * flag 之后的写盘字符。`-XPOST` / `-d@file` 这类带值紧贴形态由前缀分支兜住。
 */
function hasMutatingCurlFlag(rest: string[]): boolean {
  return rest.some((token) => {
    if (CURL_MUTATING_LONG_FLAGS.some((flag) => token.startsWith(flag))) return true;
    // 短选项捆绑可混非字母字符(`-#O`),对整个短 token 逐字符扫描;
    // 附带值形态(`-XPOST` / `-AMozilla`)的值字符也会命中 —— 偏保守,
    // 误杀代价只是回退原文。
    if (token.startsWith('-') && !token.startsWith('--')) {
      return [...token.slice(1)].some((ch) => CURL_MUTATING_SHORT_CHARS.has(ch));
    }
    return false;
  });
}

/** nl options whose value may be passed as the following argv token. */
const NL_VALUE_FLAGS = new Set([
  '-b', '-d', '-f', '-h', '-i', '-l', '-n', '-s', '-v', '-w',
  '--body-numbering', '--section-delimiter', '--footer-numbering', '--header-numbering',
  '--line-increment', '--join-blank-lines', '--number-format', '--number-separator',
  '--starting-line-number', '--number-width',
]);

function isVersionRequest(rest: string[]): boolean {
  return rest.length === 1 && (rest[0] === '-v' || rest[0] === '--version' || rest[0] === '-V');
}

const NODE_VALUE_FLAGS = new Set([
  '-r', '--require', '--import', '--loader', '--experimental-loader', '--conditions', '-C',
]);

function nodeIntent(rest: string[]): CommandIntent | undefined {
  if (isVersionRequest(rest)) return { action: 'showVersion', target: 'Node.js' };
  if (rest.some((token) => token === '-e' || token === '--eval' || token === '-p' || token === '--print')) {
    return undefined;
  }

  const syntaxFlag = rest.findIndex((token) => token === '-c' || token === '--check');
  const files = positionals(rest, NODE_VALUE_FLAGS);
  const script = files[0];
  if (!script || script === '-') return undefined;
  const target = basenameRemotePath(script) || script;
  return syntaxFlag >= 0 ? { action: 'checkSyntax', target } : { action: 'runScript', target };
}

const JQ_VALUE_FLAGS = new Set(['-L', '--indent', '-f', '--from-file']);
const JQ_TWO_VALUE_FLAGS = new Set(['--arg', '--argjson', '--slurpfile', '--rawfile', '--argfile']);

function jqIntent(rest: string[]): CommandIntent | undefined {
  if (isVersionRequest(rest)) return { action: 'showVersion', target: 'jq' };
  if (rest.includes('-h') || rest.includes('--help')) return undefined;
  if (rest.some((token) => JQ_TWO_VALUE_FLAGS.has(token))) return { action: 'parseJson' };
  const files = positionals(rest, JQ_VALUE_FLAGS);
  const filterComesFromFile = rest.includes('-f') || rest.includes('--from-file');
  const input = filterComesFromFile ? files[0] : files[1];
  return {
    action: 'parseJson',
    ...(input ? { target: basenameRemotePath(input) || input } : {}),
  };
}

function countIntent(rest: string[]): CommandIntent | undefined {
  if (rest.includes('--help')) return undefined;
  if (isVersionRequest(rest)) return { action: 'showVersion', target: 'wc' };
  const files = positionals(rest, new Set(['--files0-from']));
  const target = files[0];
  return {
    action: 'count',
    ...(target ? { target: basenameRemotePath(target) || target } : {}),
  };
}

/** `date` can set the system clock; only known display-only forms get a friendly label. */
function dateIntent(rest: string[]): CommandIntent | undefined {
  if (
    rest.every(
      (token) =>
        token === '-u' ||
        token === '--utc' ||
        token === '--universal' ||
        token === '-R' ||
        token === '--rfc-email' ||
        token.startsWith('+'),
    )
  ) {
    return { action: 'showDateTime' };
  }
  return undefined;
}

function locateCommandIntent(rest: string[]): CommandIntent | undefined {
  if (rest.length < 2 || (rest[0] !== '-v' && rest[0] !== '-V')) return undefined;
  const targets = rest.slice(1).filter((token) => token && !token.startsWith('-'));
  return targets[0] ? { action: 'locateCommand', target: targets.join(' ') } : undefined;
}

function lsofIntent(rest: string[]): CommandIntent {
  for (let index = 0; index < rest.length; index += 1) {
    const token = rest[index];
    if (token === '-i') {
      const target = rest[index + 1];
      return { action: 'inspectPorts', ...(target && !target.startsWith('-') ? { target } : {}) };
    }
    if (token.startsWith('-i') && token.length > 2) {
      return { action: 'inspectPorts', target: token.slice(2) };
    }
  }
  return { action: 'inspectProcesses' };
}

const SQLITE_VALUE_FLAGS = new Set(['-separator', '-newline', '-vfs']);
const SQLITE_UNSAFE_OPTIONS = ['-cmd', '-init'];
const SQLITE_MUTATING_SQL = /\b(?:insert|update|delete|replace|create|drop|alter|vacuum|attach|detach|reindex|load_extension|writefile)\b/i;

function sqliteIntent(rest: string[]): CommandIntent | undefined {
  if (!rest.includes('-readonly')) return undefined;
  if (rest.some((token) => SQLITE_UNSAFE_OPTIONS.some((flag) => token === flag || token.startsWith(`${flag}=`)))) {
    return undefined;
  }
  const pos = positionals(rest, SQLITE_VALUE_FLAGS);
  const database = pos[0];
  if (!database) return undefined;
  const statements = pos.slice(1);
  if (
    statements.some((statement) => /^\s*\./.test(statement) || /\n\s*\./.test(statement)) ||
    SQLITE_MUTATING_SQL.test(statements.join(' '))
  ) {
    return undefined;
  }
  return { action: 'queryDatabase', target: basenameRemotePath(database) || database };
}

interface CliSubcommand {
  name: string;
  args: string[];
}

/** Find the first non-option argv and return it with the untouched tail. */
function cliSubcommand(tokens: string[], valueFlags: Set<string>): CliSubcommand | undefined {
  for (let index = 0; index < tokens.length; index += 1) {
    const token = tokens[index];
    if (token === '--') return undefined;
    if (token.startsWith('-') && token.length > 1) {
      if (valueFlags.has(token)) index += 1;
      continue;
    }
    return { name: token.toLowerCase(), args: tokens.slice(index + 1) };
  }
  return undefined;
}

const GIT_GLOBAL_VALUE_FLAGS = new Set([
  '-C', '-c', '--git-dir', '--work-tree', '--namespace', '--exec-path', '--config-env',
]);

function hasGitOutputFileFlag(args: string[]): boolean {
  return args.some((token) => token === '--output' || token.startsWith('--output='));
}

const GIT_BRANCH_MUTATING_FLAGS = [
  '-d', '-D', '-m', '-M', '-c', '-C', '-f', '-u',
  '--delete', '--move', '--copy', '--force', '--edit-description', '--set-upstream-to', '--unset-upstream',
];

function gitBranchIsReadOnly(args: string[]): boolean {
  if (
    args.some((token) =>
      GIT_BRANCH_MUTATING_FLAGS.some((flag) => token === flag || token.startsWith(`${flag}=`)) ||
      (/^-[^-]/.test(token) && /[dDmMcCfu]/.test(token.slice(1))),
    )
  ) {
    return false;
  }
  if (args.includes('--list')) return true;
  const valueFlags = new Set([
    '--contains', '--no-contains', '--merged', '--no-merged', '--points-at', '--sort', '--format',
  ]);
  return positionals(args, valueFlags).length === 0;
}

function gitRemoteIsReadOnly(args: string[]): boolean {
  const operation = cliSubcommand(args, new Set([]));
  return operation === undefined || operation.name === 'show' || operation.name === 'get-url';
}

function gitGrepIsReadOnly(args: string[]): boolean {
  return !args.some(
    (token) => token.startsWith('-O') || token.startsWith('--open-files-in-pager'),
  );
}

function gitIntent(rest: string[]): CommandIntent | undefined {
  const subcommand = cliSubcommand(rest, GIT_GLOBAL_VALUE_FLAGS);
  if (!subcommand) return undefined;

  switch (subcommand.name) {
    case 'status':
      return { action: 'gitStatus' };
    case 'diff':
      return hasGitOutputFileFlag(subcommand.args) ? undefined : { action: 'gitDiff' };
    case 'log':
      return hasGitOutputFileFlag(subcommand.args) ? undefined : { action: 'gitLog' };
    case 'show':
      return hasGitOutputFileFlag(subcommand.args) ? undefined : { action: 'gitShow' };
    case 'add':
      return { action: 'gitAdd' };
    case 'commit':
      // Amend rewrites existing history rather than creating an ordinary commit;
      // keep the exact command as the only description in that less-common case.
      return subcommand.args.includes('--amend') ? undefined : { action: 'gitCommit' };
    case 'fetch':
      return { action: 'gitFetch' };
    case 'pull':
      return { action: 'gitPull' };
    case 'push':
      // Force/deletion forms deserve the raw fallback instead of the neutral
      // "push changes" title, which would hide their destructive semantics.
      if (
        subcommand.args.some(
          (token) =>
            token === '-f' ||
            token === '--force' ||
            token.startsWith('--force=') ||
            token.startsWith('--force-with-lease') ||
            token === '-d' ||
            token === '--delete' ||
            token === '--mirror' ||
            token === '--prune',
        )
      ) {
        return undefined;
      }
      return { action: 'gitPush' };
    case 'remote':
      return gitRemoteIsReadOnly(subcommand.args) ? { action: 'gitRemote' } : undefined;
    case 'rev-parse':
      return { action: 'gitRevParse' };
    case 'branch':
      return gitBranchIsReadOnly(subcommand.args) ? { action: 'gitBranch' } : undefined;
    case 'grep':
      return gitGrepIsReadOnly(subcommand.args) ? { action: 'gitGrep' } : undefined;
    case 'merge-base':
      return { action: 'gitMergeBase' };
    case 'ls-files':
      return { action: 'gitLsFiles' };
    case 'rev-list':
      return { action: 'gitRevList' };
    case 'ls-remote':
      return subcommand.args.some((token) => token === '-u' || token.startsWith('--upload-pack'))
        ? undefined
        : { action: 'gitLsRemote' };
    case 'worktree': {
      const worktree = cliSubcommand(subcommand.args, new Set([]));
      switch (worktree?.name) {
        case 'list':
          return { action: 'gitWorktreeList' };
        case 'add':
          return { action: 'gitWorktreeAdd' };
        case 'remove':
          return { action: 'gitWorktreeRemove' };
        case 'move':
          return { action: 'gitWorktreeMove' };
        case 'prune':
          return { action: 'gitWorktreePrune' };
        default:
          return undefined;
      }
    }
    default:
      return undefined;
  }
}

const GH_GLOBAL_VALUE_FLAGS = new Set(['-R', '--repo', '--hostname']);

const GH_PR_ACTIONS: Readonly<Record<string, CommandIntentAction>> = {
  list: 'ghPrList',
  view: 'ghPrView',
  checks: 'ghPrChecks',
  status: 'ghPrStatus',
  diff: 'ghPrDiff',
  create: 'ghPrCreate',
  edit: 'ghPrEdit',
  comment: 'ghPrComment',
  review: 'ghPrReview',
  merge: 'ghPrMerge',
  close: 'ghPrClose',
  reopen: 'ghPrReopen',
  checkout: 'ghPrCheckout',
};

const GH_ISSUE_ACTIONS: Readonly<Record<string, CommandIntentAction>> = {
  list: 'ghIssueList',
  view: 'ghIssueView',
  status: 'ghIssueStatus',
  create: 'ghIssueCreate',
  edit: 'ghIssueEdit',
  comment: 'ghIssueComment',
  close: 'ghIssueClose',
  reopen: 'ghIssueReopen',
};

const GH_AUTH_ACTIONS: Readonly<Record<string, CommandIntentAction>> = {
  status: 'ghAuthStatus',
  login: 'ghAuthLogin',
  logout: 'ghAuthLogout',
  refresh: 'ghAuthRefresh',
  switch: 'ghAuthSwitch',
};

const GH_RUN_ACTIONS: Readonly<Record<string, CommandIntentAction>> = {
  list: 'ghRunList',
  view: 'ghRunView',
  watch: 'ghRunWatch',
};

const GH_SEARCH_GROUPS = new Set(['code', 'commits', 'issues', 'prs', 'repos']);

function githubCliIntent(rest: string[]): CommandIntent | undefined {
  const group = cliSubcommand(rest, GH_GLOBAL_VALUE_FLAGS);
  if (!group) return undefined;
  if (group.name === 'api') return githubApiIntent(group.args);

  const operationCommand = cliSubcommand(group.args, GH_GLOBAL_VALUE_FLAGS);
  const operation = operationCommand?.name;
  if (!operation) return undefined;
  switch (group.name) {
    case 'pr':
      return GH_PR_ACTIONS[operation] ? { action: GH_PR_ACTIONS[operation] } : undefined;
    case 'issue':
      return GH_ISSUE_ACTIONS[operation] ? { action: GH_ISSUE_ACTIONS[operation] } : undefined;
    case 'auth':
      return GH_AUTH_ACTIONS[operation] ? { action: GH_AUTH_ACTIONS[operation] } : undefined;
    case 'run':
      return GH_RUN_ACTIONS[operation] ? { action: GH_RUN_ACTIONS[operation] } : undefined;
    case 'search':
      return GH_SEARCH_GROUPS.has(operation) ? { action: 'ghSearch' } : undefined;
    case 'repo':
      if (operation === 'list') return { action: 'ghRepoList' };
      if (operation === 'view') {
        const target = positionals(operationCommand?.args ?? [], GH_GLOBAL_VALUE_FLAGS)[0];
        return { action: 'ghRepoView', ...(target ? { target } : {}) };
      }
      return undefined;
    default:
      return undefined;
  }
}

function readCliOptionValue(tokens: string[], short: string, long: string): string | undefined {
  for (let index = 0; index < tokens.length; index += 1) {
    const token = tokens[index];
    if (token === short || token === long) return tokens[index + 1];
    if (token.startsWith(`${long}=`)) return token.slice(long.length + 1);
    if (token.startsWith(short) && token.length > short.length) return token.slice(short.length);
  }
  return undefined;
}

function collectGithubApiFields(tokens: string[]): string[] {
  const fields: string[] = [];
  for (let index = 0; index < tokens.length; index += 1) {
    const token = tokens[index];
    if (token === '-f' || token === '-F' || token === '--raw-field' || token === '--field') {
      if (tokens[index + 1] !== undefined) fields.push(tokens[index + 1]);
      index += 1;
      continue;
    }
    for (const flag of ['--raw-field=', '--field=', '-f', '-F']) {
      if (token.startsWith(flag) && token.length > flag.length) {
        fields.push(token.slice(flag.length));
        break;
      }
    }
  }
  return fields;
}

const GH_API_VALUE_FLAGS = new Set([
  '-H', '--header', '--hostname', '--input', '-q', '--jq', '-X', '--method',
  '-f', '--raw-field', '-F', '--field', '-t', '--template', '--cache',
]);

function githubApiIntent(args: string[]): CommandIntent {
  const method = readCliOptionValue(args, '-X', '--method')?.toUpperCase();
  const hasInput = args.some((token) => token === '--input' || token.startsWith('--input='));
  const fields = collectGithubApiFields(args);
  const endpoint = positionals(args, GH_API_VALUE_FLAGS)[0]?.toLowerCase();

  // --input may contain either a GraphQL query or a mutation; without reading
  // another file the semantic operation is intentionally left unspecified.
  if (hasInput && (method === undefined || endpoint === 'graphql')) return { action: 'ghApiCall' };

  if (endpoint === 'graphql') {
    const queryField = fields.find((field) => field.startsWith('query='));
    const operation = queryField?.slice('query='.length).trim();
    if (operation && /^mutation\b/i.test(operation)) return { action: 'ghApiMutation' };
    if (operation && /^(?:query\b|\{)/i.test(operation)) return { action: 'ghApiQuery' };
    if (method === undefined) return { action: 'ghApiCall' };
  }

  if (method === 'GET' || method === 'HEAD') return { action: 'ghApiQuery' };
  if (method && ['POST', 'PUT', 'PATCH', 'DELETE'].includes(method)) {
    return { action: 'ghApiMutation' };
  }
  if (method !== undefined) return { action: 'ghApiCall' };
  if (!endpoint) return { action: 'ghApiCall' };
  if (fields.length > 0) return { action: 'ghApiMutation' };
  return { action: 'ghApiQuery' };
}

/** grep/rg 家族里「取值型」flag —— 解析 positional 时要连着跳过它的值。 */
const GREP_VALUE_FLAGS = new Set([
  '-A', '-B', '-C', '-m', '-d', '-g', '-t', '-T', '-f',
  '--type', '--glob', '--include', '--exclude', '--exclude-dir', '--max-count', '--context',
]);

function grepIntent(rest: string[]): CommandIntent | undefined {
  // rg 的 --pre* 预处理器会为每个文件 spawn 进程(`rg --pre=rm ...`),不解析。
  if (rest.some((token) => token.startsWith('--pre'))) return undefined;
  // rg --files 是列文件模式(不搜索),按「列出」处理,别把路径当搜索词。
  if (rest.includes('--files')) {
    const pos = positionals(rest, new Set([...GREP_VALUE_FLAGS, '-e', '--regexp']));
    return { action: 'list', ...(pos[0] ? { target: pos[0] } : {}) };
  }
  // -f/--file 时 pattern 来自文件,剩余 positional 全是搜索路径 —— 硬把
  // 首个路径当 pattern 会渲染出错误的「搜索 src」,直接回退原文。覆盖紧贴
  // (`-fpatterns.txt`)与捆绑(`-rf`)形态:非 `--` 短 token 含小写 f 即拒
  // (-F fixed-strings 大小写有别,不受影响)。
  if (
    rest.some(
      (token) =>
        token === '--file' ||
        token.startsWith('--file=') ||
        token.startsWith('-f') ||
        // 捆绑扫描豁免 -e* / --regexp*(pattern 载体,值里的 f 是搜索词)。
        (/^-[a-zA-Z]/.test(token) &&
          !token.startsWith('--') &&
          !token.startsWith('-e') &&
          token.includes('f')),
    )
  ) {
    return undefined;
  }
  // -e/--regexp 显式给 pattern 时优先;紧贴值形态(--regexp=X / -eX)同样认。
  let pattern: string | undefined;
  for (let index = 0; index < rest.length; index += 1) {
    const token = rest[index];
    if (token === '-e' || token === '--regexp') {
      pattern = rest[index + 1];
      break;
    }
    if (token.startsWith('--regexp=')) {
      pattern = token.slice('--regexp='.length);
      break;
    }
    if (token.startsWith('-e') && token.length > 2 && token !== '-e') {
      pattern = token.slice(2);
      break;
    }
  }
  const pos = positionals(rest, new Set([...GREP_VALUE_FLAGS, '-e', '--regexp']));
  pattern ??= pos[0];
  if (!pattern) return undefined;
  const path = pattern === pos[0] ? pos[1] : pos[0];
  return { action: 'search', target: pattern, ...(path ? { path } : {}) };
}

/** pnpm/npm/yarn/bun 里「取值型」flag。 */
const PM_VALUE_FLAGS = new Set(['--filter', '-F', '--dir', '-C', '--cwd', '--prefix']);

const PACKAGE_MANAGER_BUILTINS = new Set([
  'access', 'add', 'allow-builds', 'approve-builds', 'audit', 'bin', 'bugs', 'cache', 'catalog', 'ci',
  'completion', 'config', 'constraints', 'create', 'dedupe', 'delete', 'deploy', 'deprecate', 'diff',
  'dist-tag', 'dlx', 'doctor', 'docs', 'edit', 'env', 'exec', 'explain', 'explore', 'fetch', 'find-dupes',
  'fund', 'get', 'help', 'help-search', 'hook', 'ignored-builds', 'import', 'info', 'init', 'install',
  'install-ci-test', 'install-test', 'i', 'link', 'list', 'licenses', 'login', 'logout', 'ls', 'node',
  'npm', 'org', 'outdated', 'owner', 'pack', 'patch', 'patch-commit', 'ping', 'pkg', 'plugin', 'pm',
  'prefix', 'profile', 'prune', 'publish', 'query', 'rebuild', 'remove', 'repo', 'root', 'run', 'sbom',
  'search', 'self-update', 'server', 'set', 'setup', 'shrinkwrap', 'stage', 'star', 'stars', 'store',
  'team', 'token', 'uninstall', 'unlink', 'unplug', 'unpublish', 'update', 'up', 'upgrade-interactive',
  'version', 'view', 'whoami', 'why', 'workspace', 'workspaces', 'x',
]);

function packageManagerIntent(manager: string, rest: string[]): CommandIntent | undefined {
  if (isVersionRequest(rest)) return { action: 'showVersion', target: manager };
  const pos = positionals(rest, PM_VALUE_FLAGS);
  const sub = pos[0];
  if (!sub) return undefined;
  switch (sub) {
    case 'install':
    case 'i':
    case 'ci': {
      const pkgs = pos.slice(1).join(' ');
      return { action: 'install', ...(pkgs ? { target: pkgs } : {}) };
    }
    case 'add': {
      const pkgs = pos.slice(1).join(' ');
      return { action: 'install', ...(pkgs ? { target: pkgs } : {}) };
    }
    case 'run': {
      if (!pos[1]) return undefined;
      // 转发参数可携带写文件 flag(`pnpm run lint -- --fix`),先查再分类。
      if (hasMutatingForwardedArg(argsAfter(rest, pos[1]))) return undefined;
      return scriptIntent(pos[1]) ?? { action: 'runScript', target: pos[1] };
    }
    case 'test':
      // `npm test -- --updateSnapshot` 会改写快照,不能标「运行测试」。
      if (hasMutatingForwardedArg(argsAfter(rest, sub))) return undefined;
      return { action: 'test' };
    case 'exec':
    case 'dlx':
      return pos[1] ? toolBinaryIntent(pos[1], argsAfter(rest, pos[1])) : undefined;
    default: {
      // 先按 package.json script 名认,再按直调本地工具二进制认
      // (`pnpm vitest run` / `pnpm eslint .` 这种形态)。args 传原始 token
      // 序列(positionals 会丢 flag,--fix 这类检查必须看得到)。
      const forwarded = argsAfter(rest, sub);
      const script = scriptIntent(sub);
      if (script) return hasMutatingForwardedArg(forwarded) ? undefined : script;
      const tool = toolBinaryIntent(sub, forwarded);
      if (tool) return tool;
      if (KNOWN_TOOL_BINARIES.has(binaryName(sub))) return undefined;
      return PACKAGE_MANAGER_BUILTINS.has(sub)
        ? undefined
        : { action: 'runScript', target: sub };
    }
  }
}

/** 转发给 script / 工具的已知写文件 flag(eslint --fix[=true]、快照更新)。 */
function hasMutatingForwardedArg(args: string[]): boolean {
  return args.some(
    (token) => token === '--fix' || token.startsWith('--fix=') || token === '-u' || token.startsWith('--update'),
  );
}

/** rest 中 anchor(必存在)之后的原始 token 序列 —— 保留 flag 供写文件形态检查。 */
function argsAfter(rest: string[], anchor: string): string[] {
  return rest.slice(rest.indexOf(anchor) + 1);
}

/** package.json script 名 → 意图（只认 test/build/lint/typecheck 前缀族）。 */
function scriptIntent(script: string): CommandIntent | undefined {
  if (/^test([:.-]|$)/.test(script)) return { action: 'test' };
  if (/^build([:.-]|$)/.test(script)) return { action: 'build' };
  if (/^lint([:.-]|$)/.test(script)) return { action: 'lint' };
  // 'tsc' 是二进制不是 script 名,交给 toolBinaryIntent 做 --noEmit 检查。
  if (/^typecheck([:.-]|$)/.test(script)) return { action: 'typecheck' };
  return undefined;
}

const KNOWN_TOOL_BINARIES = new Set([
  'vitest', 'jest', 'pytest', 'eslint', 'tsc', 'prettier', 'node',
]);

/** 直接调用的工具二进制 → 意图（vitest / eslint / tsc …),args 用于拒绝写文件形态。 */
function toolBinaryIntent(bin: string | undefined, args: string[] = []): CommandIntent | undefined {
  if (!bin) return undefined;
  switch (binaryName(bin)) {
    case 'vitest':
    case 'jest':
    case 'pytest':
      // 快照更新形态(-u / --update*)会改写测试文件,不解析。
      if (args.some((token) => token === '-u' || token.startsWith('--update'))) return undefined;
      return { action: 'test' };
    case 'eslint':
      // --fix 会改写源码(含 --fix=true 取值形态);--fix-dry-run 不落盘,放行。
      if (args.some((token) => token === '--fix' || token.startsWith('--fix='))) return undefined;
      return { action: 'lint' };
    case 'tsc': {
      // 裸 tsc 会产出 JS、--init 写 tsconfig —— 只有 --noEmit 是纯类型检查,
      // 且布尔取值不能显式为 false(`tsc --noEmit false a.ts` 仍会产出)。
      const idx = args.indexOf('--noEmit');
      if (idx === -1) return undefined;
      if ((args[idx + 1] ?? '').toLowerCase() === 'false') return undefined;
      return { action: 'typecheck' };
    }
    case 'prettier':
      if (args.includes('--check') || args.includes('-c')) return { action: 'checkFormatting' };
      return undefined;
    case 'node':
      return nodeIntent(args);
    default:
      return undefined;
  }
}

function cargoIntent(sub: string | undefined, args: string[] = []): CommandIntent | undefined {
  switch (sub) {
    case 'test':
      // --no-run 只编译不跑,不能标「运行测试」。
      return args.includes('--no-run') ? undefined : { action: 'test' };
    case 'build':
      return { action: 'build' };
    case 'check':
      return { action: 'typecheck' };
    case 'clippy':
      // clippy --fix 会自动改写源码,不能标「代码检查」。
      return args.includes('--fix') ? undefined : { action: 'lint' };
    case 'add':
      return { action: 'install' };
    default:
      return undefined;
  }
}

// ── action 门控实现 ──────────────────────────────────────────────────────────

/**
 * sed 只读形态判定:-n 存在、无 -i* / --in-place[=SUFFIX] 就地编辑,且脚本
 * 是**纯打印形态**(如 `1,120p` / `5p` / `$p`)。sed 脚本自身就能写文件
 * (`1w out.txt`)/ 执行命令(GNU `e`),非纯打印一律拒,回退原文。
 */
const SED_PRINT_ONLY_SCRIPT = /^[0-9,$;~\s]*p$/;

function sedTokensAreReadOnly(rest: string[]): boolean {
  if (!rest.includes('-n')) return false;
  if (rest.some((token) => token.startsWith('-i') || token === '--in-place' || token.startsWith('--in-place='))) {
    return false;
  }
  // -f/--file 从脚本文件加载 sed 脚本,内容不可静态判定(可含 w / e),拒。
  if (rest.some((token) => token.startsWith('-f') || token === '--file' || token.startsWith('--file='))) {
    return false;
  }
  // 多段脚本(多个 -e)不在「看文件片段」的目标形态内,保守拒。
  const expressionFlags = rest.filter((token) => token === '-e' || token === '--expression');
  if (expressionFlags.length > 1) return false;
  const eIndex = rest.findIndex((token) => token === '-e' || token === '--expression');
  const script = eIndex >= 0 ? rest[eIndex + 1] : positionals(rest, new Set([]))[0];
  return script !== undefined && SED_PRINT_ONLY_SCRIPT.test(script);
}

/** A pipeline filter must consume stdin; an extra file operand would change the displayed source. */
function sedPipelineFilterIsReadOnly(rest: string[]): boolean {
  if (!sedTokensAreReadOnly(rest)) return false;
  const usesExpressionFlag = rest.some((token) => token === '-e' || token === '--expression');
  const pos = positionals(rest, new Set(['-e', '--expression']));
  return usesExpressionFlag ? pos.length === 0 : pos.length === 1;
}

/**
 * read action 门控:action.command 过 `analyzeCommandShape` 完整归一化
 * (剥 cd 前缀 / 验证命令链、管道尾、重定向)后,首 token 需在
 * READ_COMMAND_BINS(sed 另须只读形态)。与本地路径共用同一套归一化 ——
 * `cd repo && sed -i ...` 这类带前缀的 action.command 不能拿 `cd` 当 bin
 * 绕过检查。
 */
function isKnownReadCommand(command: string | undefined): boolean {
  if (!command) return false;
  const argv = analyzeCommandShape(command);
  if (!argv || argv.length === 0) return false;
  const bin = binaryName(argv[0]);
  if (!READ_COMMAND_BINS.has(bin)) return false;
  // codex 可能给 `sed -i` 就地编辑(或 /usr/bin/sed 的 executable-read)也报 read action。
  if (bin === 'sed') return sedTokensAreReadOnly(argv.slice(1));
  // less/more 的 + 启动命令可执行 shell,与本地解析同口径拒。
  if ((bin === 'less' || bin === 'more') && argv.slice(1).some((token) => token.startsWith('+'))) {
    return false;
  }
  return true;
}

/**
 * search / listFiles action 门控:action.command 含副作用形态时拒绝 ——
 * 破坏性 find、`fd -x/--exec[-batch]`(逐结果执行命令)、grep 家族的
 * `--pre*` 预处理器(rg 会为每个文件 spawn 进程)。tokenize / strip 失败
 * (未闭合引号、写文件重定向等)同样保守拒绝 —— 代价只是回退原文,零风险。
 */
function searchCommandHasSideEffects(command: string | undefined): boolean {
  if (!command) return false;
  // 与 read 门控同理:先过 analyzeCommandShape 完整归一化,`cd repo &&
  // find ... -delete` 不能拿 `cd` 当 bin 绕过下面的副作用检查。
  const argv = analyzeCommandShape(command);
  if (!argv || argv.length === 0) return true;
  const bin = binaryName(argv[0]);
  const rest = argv.slice(1);
  if (bin === 'find') return rest.some((token) => FIND_DESTRUCTIVE_FLAGS.has(token));
  if (bin === 'fd') return rest.some((token) => hasFdExecFlag(token));
  if (bin === 'rg' || bin === 'grep' || bin === 'egrep' || bin === 'fgrep' || bin === 'ag') {
    return rest.some((token) => token.startsWith('--pre'));
  }
  // tree 的写文件 flag(-o FILE / -R 写 00Tree.html)—— 与本地解析同口径,
  // codex 把 `tree -o x` 归成 listFiles 时不能被贴「列出」。
  if (bin === 'tree') return rest.some((token) => token.startsWith('-') && /[oR]/.test(token));
  return false;
}

/**
 * fd 的逐结果执行 flag(-x / --exec / -X / --exec-batch)。短选项可紧贴值
 * (`-xrm`)或捆绑(`-Hx`),短 token 含 x/X 字符即拒 —— 偏保守,误杀代价
 * 只是回退原文。
 */
function hasFdExecFlag(token: string): boolean {
  if (token.startsWith('--exec')) return true;
  return /^-[a-zA-Z]/.test(token) && !token.startsWith('--') && /[xX]/.test(token);
}

// ── 词法辅助 ─────────────────────────────────────────────────────────────────

/**
 * 顶层分割（引号内的分隔符不算）。遇到 `||`（无法确定实际执行哪支）或
 * 未闭合引号返回 undefined。分隔符按传入列表顺序匹配 —— 调用方须把 `&&`
 * 排在 `&` 前,避免拆成两个 `&`;`>&`（fd 复制,如 2>&1）里的 `&` 不算分隔符。
 */
function splitTopLevel(input: string, separators: string[]): string[] | undefined {
  const segments: string[] = [];
  let current = '';
  let quote: '"' | "'" | null = null;
  for (let index = 0; index < input.length; index += 1) {
    const ch = input[index];
    if (quote) {
      current += ch;
      if (ch === quote && (quote !== '"' || input[index - 1] !== '\\')) quote = null;
      continue;
    }
    if (ch === '"' || ch === "'") {
      quote = ch;
      current += ch;
      continue;
    }
    if (ch === '|' && input[index + 1] === '|') return undefined;
    const matched = separators.find((sep) => input.startsWith(sep, index));
    if (matched === '&' && index > 0 && input[index - 1] === '>') {
      current += ch; // 2>&1 / >&2 里的 fd 复制,不是后台操作符
      continue;
    }
    if (matched) {
      segments.push(current);
      current = '';
      index += matched.length - 1;
      continue;
    }
    current += ch;
  }
  if (quote) return undefined;
  segments.push(current);
  return segments.map((segment) => segment.trim()).filter((segment) => segment.length > 0);
}

/**
 * 引号感知的 token 化；text 去引号取内容,unquotedMeta 按字符粒度标记该
 * token 是否含未引号的 < / > / ((重定向 / 进程替换判定只看未引号部分,
 * `rg ">" src` 的引号元字符是普通搜索词)。未闭合引号返回 undefined。
 */
function tokenize(input: string): ShellWord[] | undefined {
  const tokens: ShellWord[] = [];
  let current = '';
  let hasToken = false;
  let unquotedMeta = false;
  let hasQuoted = false;
  let quote: '"' | "'" | null = null;
  for (let index = 0; index < input.length; index += 1) {
    const ch = input[index];
    if (quote) {
      if (ch === quote) {
        quote = null;
      } else if (quote === '"' && ch === '\\' && input[index + 1] === '"') {
        current += '"';
        index += 1;
      } else {
        current += ch;
      }
      continue;
    }
    if (ch === '"' || ch === "'") {
      quote = ch;
      hasToken = true;
      hasQuoted = true;
      continue;
    }
    if (/\s/.test(ch)) {
      if (hasToken) tokens.push({ text: current, unquotedMeta, hasQuoted });
      current = '';
      hasToken = false;
      unquotedMeta = false;
      hasQuoted = false;
      continue;
    }
    if (ch === '<' || ch === '>' || ch === '(') unquotedMeta = true;
    current += ch;
    hasToken = true;
  }
  if (quote) return undefined;
  if (hasToken) tokens.push({ text: current, unquotedMeta, hasQuoted });
  return tokens;
}

/**
 * 剥掉 env 前缀赋值（FOO=bar cmd）、sudo 与无害重定向 token。
 * 命中**写文件**重定向时返回 undefined —— 这类命令有创建 / 覆盖文件的副作用,
 * 意图解析必须整体放弃,不能把 `cat a > b` 渲染成无害的「读取 a」。按 shell
 * 语义,重定向不要求空格:未引号 token 中间出现 `>` / `<`（如 `a>b`）同样
 * 视为重定向处理;引号包裹的 `>`（如搜索 "=>"）不受影响。丢弃流（>/dev/null）
 * 与 fd 复制（2>&1 / >&2）无副作用,照常剥掉;输入重定向（< file）只读,同样剥掉。
 */
function stripPrefixTokens(words: ShellWord[]): string[] | undefined {
  let start = 0;
  // env 前缀 / sudo 只在**不含未引号元字符**时才可无害跳过 ——
  // `LOG=x>secret.txt cat a` 的赋值段黏着写文件重定向,不能白丢。
  while (
    start < words.length &&
    !words[start].unquotedMeta &&
    (/^[A-Za-z_][A-Za-z0-9_]*=/.test(words[start].text) || words[start].text === 'sudo')
  ) {
    start += 1;
  }
  const out: string[] = [];
  for (let index = start; index < words.length; index += 1) {
    const word = words[index];
    // 无未引号元字符 → 普通参数(引号里的 > / < / ( 是内容,如搜索 "=>")。
    if (!word.unquotedMeta) {
      out.push(word.text);
      continue;
    }
    const token = word.text;
    // 未引号元字符 + 引号部分混排(`>"&2"`):去引号后的 text 会把引号里的
    // 文件名伪装成 fd 复制 / 无害目标,无法可靠区分,一律保守拒。
    if (word.hasQuoted) return undefined;
    // 进程替换 <(cmd) / >(cmd) / zsh =(cmd) 内嵌任意命令(`cat <(rm -rf build)`),
    // 必须在输入重定向剥除之前拒绝,不能当成无害 `<` 丢掉。
    if (token.includes('<(') || token.includes('>(') || token.includes('=(')) return undefined;
    // <> 读写重定向会创建目标文件(`cat <> created.txt`),同样不能当无害输入丢掉。
    if (token.includes('<>')) return undefined;
    if (token === '<') {
      // 输入重定向:消费目标前必须检查 —— `cat < <(rm -rf build)` /
      // `cat < =(rm ...)` 的目标是进程替换,含未引号元字符的目标一律整体放弃。
      const target = words[index + 1];
      index += 1;
      if (target?.unquotedMeta) return undefined;
      continue;
    }
    if (token.startsWith('<') && !token.slice(1).includes('<') && !token.slice(1).includes('>')) {
      continue; // 纯附加输入重定向 `<file`,只读无害
    }
    const redirect = token.match(/^(?:\d?|&)(>>?)(.*)$/);
    if (redirect) {
      const targetWord = redirect[2] === '' ? words[index + 1] : undefined;
      const target = redirect[2] !== '' ? redirect[2] : targetWord?.text ?? '';
      if (redirect[2] === '') index += 1; // 目标是下一个 token,一并消费
      // fd 复制只放行 &数字 / &-(关闭):bash 的 `>&word`(word 非 fd)等价
      // `>word 2>&1`,会创建/截断文件 word,不能当无害 fd 复制放过。
      // 目标带引号(`> "&2"`)时是字面文件名,不享受 fd/devnull 豁免。
      if (
        !targetWord?.hasQuoted &&
        (target === '/dev/null' || /^&(\d+|-)$/.test(target))
      ) {
        continue;
      }
      return undefined;
    }
    // 其余含未引号元字符的形态(紧贴重定向 `a>b`、混合引号 `a>"b"`、
    // 裸 `(` 等)一律保守放弃 —— shell 重定向不要求空格。
    return undefined;
  }
  return out;
}

/** 取 positional 参数：跳过 flag,以及 valueFlags 里 flag 携带的下一个值。 */
function positionals(tokens: string[], valueFlags: Set<string>): string[] {
  const out: string[] = [];
  for (let index = 0; index < tokens.length; index += 1) {
    const token = tokens[index];
    if (token === '--') {
      out.push(...tokens.slice(index + 1));
      break;
    }
    if (token.startsWith('-') && token.length > 1) {
      if (valueFlags.has(token)) index += 1;
      continue;
    }
    out.push(token);
  }
  return out;
}

/** 去掉路径前缀取二进制名（/usr/bin/grep → grep,大小写不敏感平台统一小写）。 */
function binaryName(token: string): string {
  const base = basenameRemotePath(token) || token;
  return base.toLowerCase();
}

function readNonEmptyString(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}
