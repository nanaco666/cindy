/**
 * migration/copyExcludes — userData 拷贝排除清单的**唯一生成源**(§4.1)。
 *
 * Cindy 首启自拷(userDataCopy.ts)的排除清单只能由本文件提供,禁止在任何
 * 地方手写第二份(评审 P1-7:双源必然漂移)。清单与设计文档 §4.1 逐条对应,
 * 增删必须同步文档并过 review。
 *
 * glob 语义(与 userDataCopy.ts 的匹配器对齐):
 *  - **锚定于拷贝根**(dataCopy.from,即老 userData 根),不做任意深度模糊
 *    匹配——Chromium 缓存等嵌套目录用完整相对路径写出;
 *  - `*` 单段通配,`**` 任意深度;
 *  - Windows 下大小写不敏感比较,路径分隔符统一按 `/` 匹配。
 *
 * 原则:**宁可多拷,不可误杀**——排除项必须是"新 app 首启可完全再生"的内容;
 * 拿不准的一律不排(如 voice-input/ 下混着录音配置与 helper 二进制,只精确
 * 排 helper 文件形态)。
 */

/** 相对老 userData 根的排除 glob 清单。 */
export const USER_DATA_COPY_EXCLUDES: readonly string[] = Object.freeze([
  // ── 迁移自身的元数据:marker 属于老侧,拷过去会污染新侧语义
  //    (handoff.json 必须随拷,不在排除之列)
  'migration/state.json',

  // ── Electron 当前实例持有的根级 singleton 文件/链接。Cindy 在自拷前已
  //    requestSingleInstanceLock，不能让老 profile 覆盖这些实时 IPC 端点。
  'Singleton*',

  // ── 日志与热更暂存
  'logs/**',
  'updates/**',

  // ── 可再生缓存
  'cache/**',            // usage history / model pricing 缓存
  'diagnostics/**',      // 启动诊断 run-markers
  'file-browser/**',     // 远程文件浏览缓存

  // ── agent 二进制(新 app 按 tools/<kind>/latest.json pin 重下;目录实名
  //    claude-code/<version>/、codex/<version>/,注意与 orphan-reaper 的
  //    `<userData>/claude-code/` 路径标记保持一致的目录认知)
  'claude-code/**',
  'codex/**',
  'prepared-android-platform-tools/**',

  // ── 从 resources 抽取的原生 helper(mac)
  'agent-island/**',
  'voice-input/xdt-macos-*',

  // ── 受管浏览器运行时:media 暂存与 profile 内 Chromium 缓存可再生;
  //    profile 本体(browser/<name>/user-data/ 其余内容)承载登录态,必迁
  'browser-runtime/media/**',
  'browser-runtime/browser/*/user-data/Cache/**',
  'browser-runtime/browser/*/user-data/Code Cache/**',
  'browser-runtime/browser/*/user-data/GPUCache/**',
  'browser-runtime/browser/*/user-data/DawnCache/**',
  'browser-runtime/browser/*/user-data/Crashpad/**',
  'browser-runtime/browser/*/user-data/ShaderCache/**',

  // ── Chromium 主 profile 缓存(⚠️ Local Storage / IndexedDB / Session Storage
  //    是 renderer 水位数据,绝不排除——见 §4.1 保留例外)
  'Cache/**',
  'Code Cache/**',
  'GPUCache/**',
  'DawnCache/**',
  'Crashpad/**',
  'blob_storage/**',
]);

/** 必须保留(绝不允许出现在排除清单里)的路径前缀——一致性测试用。 */
export const COPY_MUST_KEEP_PREFIXES: readonly string[] = Object.freeze([
  'safe-storage',
  'codex-home',
  'claude-home',
  'dialogues',
  'brain',
  'maker-memory',
  'learn',
  'skillhub',
  'remote-ssh',
  'schedule-hooks',
  'im-working-dir',
  'cc-agent',
  'voice-input-recordings',
  'migration/handoff.json',
  'migration/identity-anchor.json',
  'Local Storage',
  'IndexedDB',
  'Session Storage',
]);
