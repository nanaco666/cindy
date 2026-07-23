# 全仓 locale 消费者盘点(U-1 zh-TW 全量接入)

> 交付于 PR0b-desktop(implementation-plan.md Step 1 WHAT4);`scripts/check-login-i18n-parity.mjs` ⑤消费者双向核对的机读源。
> **机读契约**:脚本解析 `BEGIN/END:CONSUMER_TABLE scope=<scope>` 标记内的表格;`zhTwAssert` 列是必须命中文件内容的 JS 正则(证明该消费者真实接受 zh-TW,不折叠简中)。静态扫描信号(引号 `zh-CN` 字面量或 `startsWith('zh` 前缀分支)命中而未登记 → 门禁失败;登记而文件缺失或断言不中 → 同样失败。扫描误报走脚本内冻结排除表 `SCAN_EXCLUSIONS`(每项带理由+登记 reviewer,变更走 review)。

## desktop scope(PR0b-desktop 交付,已全部接入 zh-TW)

<!-- BEGIN:CONSUMER_TABLE scope=desktop -->
| id | file | kind | zhTwAssert |
|----|------|------|------------|
| shared-locale | apps/desktop/src/shared/locale.ts | union+matcher(SUPPORTED_LOCALES + 中文分流) | `'zh-TW'[\s\S]*hant` |
| renderer-i18n | apps/desktop/src/renderer/i18n/index.ts | resources Record + fallbackLng | `'zh-TW':\s*\['zh-CN',\s*'en'\]` |
| main-i18n | apps/desktop/src/main/i18n.ts | resources Record + fallback 链 | `'zh-TW':\s*\['zh-TW',\s*'zh-CN',\s*'en'\]` |
| app-menu | apps/desktop/src/main/bootstrap-electron.ts | 菜单字典 Record(typecheck 强制) | `'zh-TW':\s*\{[\s\S]{0,200}關於` |
| learn-reply-language | apps/desktop/src/main/learn-host/promptBuilder.ts | REPLY_LANGUAGE_BY_LOCALE Record(v6.8 必检) | `'zh-TW':\s*'Traditional Chinese \(繁體中文\)'` |
| help-locale-name | apps/desktop/src/main/maker-ipc/help.ts | LOCALE_NAME Record + normalizeLocale union | `'zh-TW':\s*'Traditional Chinese'` |
| help-feedback-valid | apps/desktop/src/main/maker-ipc/help-feedback.ts | VALID_LOCALES Set | `'zh-TW',` |
| help-types | apps/desktop/src/shared/helpTypes.ts | HelpLocale union | `HelpLocale = [^;]*'zh-TW'` |
| help-thread-view | apps/desktop/src/renderer/components/settings/HelpThreadView.tsx | localeFromI18n 前缀分支(zh 折叠改真实分支) | `lang === 'zh-TW'[\s\S]{0,80}return 'zh-TW'` |
| selection-menu | apps/desktop/src/main/selection-context-menu.ts | localizedActionLabel 前缀分支(zh 折叠改真实分支) | `zh-tw` |
<!-- END:CONSUMER_TABLE scope=desktop -->

**key 驱动消费者(无显式 locale 集合,由 SUPPORTED_LOCALES + i18n key 驱动,parity 脚本以「zh-TW 必备 UI key」断言落点)**:

| 文件 | 说明 | 落点 |
|------|------|------|
| apps/desktop/src/renderer/components/settings/LanguageSection.tsx | 语言下拉 `['system', ...SUPPORTED_LOCALES]`,label 取 `t('settings.language.options.<locale>')` | 5 语文件均含 `settings.language.options.zh-TW`(endonym「繁體中文」) |
| apps/desktop/src/renderer/components/settings/VoiceInputSection.tsx | 语音语言 `['auto', ...SUPPORTED_LOCALES]`,描述取 `t('settings.voiceInput.language.optionDescriptions.<locale>')`;zh-TW 语音语义沿中文配置(语言码原样透传识别服务,`resolveBrowserVoiceInputLanguage` 不折叠) | 5 语文件均含 `settings.voiceInput.language.optionDescriptions.zh-TW` |

**校验类消费者(动态读 SUPPORTED_LOCALES/locales 目录,zh-TW 自动纳入,无需改动)**:`scripts/check-i18n.mjs`(并集查缺)、`apps/desktop/src/renderer/__tests__/i18nCompleteness.test.ts`(静态 key 完整性闸)。

## callback scope(归 PR0b-callback 支;本表由该支合入时生效,desktop 扫描分区已排除)

<!-- BEGIN:CONSUMER_TABLE scope=callback -->
| id | file | kind | zhTwAssert |
|----|------|------|------------|
| oauth-result-page | apps/desktop/src/main/oauthResultPage.ts | 回调页 copy 表 + pickOAuthResultPageLang(zh-Hant/HK/MO 识别) | `isTraditionalChineseTag[\s\S]*'zh-TW':` |
<!-- END:CONSUMER_TABLE scope=callback -->

> callback 支落地后应把 `pickOAuthResultPageLang` 的 zh-Hant 识别与 copy 表 zh-TW 节的更精确断言(如 `zh-Hant`)更新进上表 zhTwAssert;`apps/desktop/scripts/preview-oauth-pages.ts` 与生产 copy builder 合一后共用同一 copy 源,不单列。

## mobile scope(归 PR0b-mobile 支;desktop 支预登记,该支合入时按实况修订断言)

<!-- BEGIN:CONSUMER_TABLE scope=mobile -->
| id | file | kind | zhTwAssert |
|----|------|------|------------|
| login-messages | apps/mobile/src/auth/loginMessages.ts | 5 语 catalog + 系统 locale 分流(zh-Hant*→zh-TW / 其余 zh→zh-CN / ja / ko / 兜底 en) | `'zh-TW'` |
<!-- END:CONSUMER_TABLE scope=mobile -->

> parity `--scope mobile` 另对 loginMessages catalog 做 5 语 key 全集一致非空校验(结构化提取,见脚本 `extractMobileCatalog`)。

## 扫描排除表(与脚本 SCAN_EXCLUSIONS 同步,此处为人读镜像)

| 路径 | 理由 | reviewer |
|------|------|----------|
| apps/desktop/src/renderer/i18n/locales/** | i18n 资源文件本体,不是消费者 | PR0b-desktop worker 2026-07-20 |
| **/__tests__/** | 测试文件不是运行时 locale 消费者 | PR0b-desktop worker 2026-07-20 |
| apps/desktop/src/renderer/components/new-chat/CjkPunctDecoration.ts | `lang="zh-CN"` 是 CJK 标点字形渲染的 HTML lang 属性常量,zh-TW 同属中文标点域行为一致,非 locale 分支集合 | PR0b-desktop worker 2026-07-20 |
| apps/mobile/src/session/mobileVoiceInput.ts | 语音转写 uiLanguage 提示常量(送 ASR/LLM),非 UI locale 分支集合 | PR0b-desktop worker 2026-07-20 |
| apps/mobile/src/session/mobileVoiceLiteLlmSettings.ts | ASR/LLM 语言参数常量,非 UI locale 分支集合 | PR0b-desktop worker 2026-07-20 |
| apps/mobile/src/session/modelPickerRows.ts | 模型能力说明文案含 zh-CN 字样,非 UI locale 分支集合 | PR0b-desktop worker 2026-07-20 |
