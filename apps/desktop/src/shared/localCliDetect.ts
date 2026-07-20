/**
 * localCliDetect —— 本机 agent CLI 安装 / 登录态检测的共享类型与映射表。
 *
 * 用途:设置 → 模型供应商的「检测建议」——本机装了 Claude Code / Codex CLI 的用户,
 * 大概率已有对应订阅,左栏建议行 + 添加向导置顶提示引导其直接授权接入,而不是让
 * 用户自己在目录里找渠道。
 *
 * 映射表设计为数据驱动(cliId → 建议 providerId),后续扩国产 CLI(qwen / iflow /
 * gemini / kimi 等)只需加条目;当前只做 claude / codex 两条(优先级最高、判据最稳)。
 *
 * 检测只做**存在性 stat**,绝不读取 / 解析 / 复制凭证内容(CLAUDE.md 规则 23:
 * 凭证不入仓、不落盘、不进日志;这里更进一步——连读都不读)。
 */

/** 可检测的本机 CLI 标识。 */
export type LocalCliId = 'claude-cli' | 'codex-cli';

/** 单条检测结果:CLI 是否安装 / 是否已登录 + 建议接入的供应商 id。 */
export interface LocalCliDetection {
  cli: LocalCliId;
  /** 建议接入的内置供应商 id(anthropic / openai,与 active-catalog 的 provider id 对齐)。 */
  providerId: string;
  /** 配置目录存在(~/.claude / ~/.codex)。 */
  installed: boolean;
  /** 登录态凭证文件存在(只 stat 不读)。 */
  loggedIn: boolean;
}

/**
 * 检测映射表:cli → { 配置目录, 登录态文件, 建议供应商 }。
 * 路径相对 home 目录,由 main 侧用 path.join 拼接(跨平台,规则 15)。
 */
export const LOCAL_CLI_DETECT_MAP: ReadonlyArray<{
  cli: LocalCliId;
  providerId: string;
  /** 配置目录(相对 home 的路径段)。 */
  configDirSegments: readonly string[];
  /** 登录态凭证文件(相对 home 的路径段)。 */
  credentialFileSegments: readonly string[];
}> = [
  {
    cli: 'claude-cli',
    providerId: 'anthropic',
    configDirSegments: ['.claude'],
    credentialFileSegments: ['.claude', '.credentials.json'],
  },
  {
    cli: 'codex-cli',
    providerId: 'openai',
    configDirSegments: ['.codex'],
    credentialFileSegments: ['.codex', 'auth.json'],
  },
];
