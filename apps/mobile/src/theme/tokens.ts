/**
 * 设计 token —— 移动端唯一颜色 / 尺寸真相源。
 *
 * 本文件**刻意不依赖 react-native**(便于 node 环境单测直接 import 校验调色板 / 阶梯)。
 * 需要 Platform 的 `monoFont` 单独放在 `./monoFont.ts`;消费 token 统一从 `@/theme` barrel 取。
 *
 * 颜色分两层:
 *  - `ThemeColors`:随 light / dark 切换的色板(见 lightColors / darkColors),组件通过
 *    `useTheme().colors` 或 `useThemedStyles(makeStyles)` 消费,**永远写 token 不写 hex**。
 *  - spacing / radius / typeScale / lineHeight / fontWeight / iconSize:主题无关的不变量阶梯。
 *
 * 色值对齐桌面 `DESIGN.md` 的 Ollama Light / Dark,保证跨端一致。
 */

export type ThemeMode = 'light' | 'dark';

/** 随主题切换的颜色 token。light / dark 必须有完全一致的 key 集合。 */
export interface ThemeColors {
  /** 页面 Surface 背景 */
  surface: string;
  /** 抬一层的 Card / 弹窗 / 输入框 */
  surfaceElevated: string;
  /** Surface 半透明(吸顶栏等) */
  surfaceTranslucent: string;
  /** Chip / pill / 选中行填充 */
  surfaceChip: string;
  /** 1px 分隔线 / 边框(桌面 Board) */
  border: string;
  /** 半透明边框 */
  borderTranslucent: string;
  /** 强调边框 / 次要图标点 */
  borderStrong: string;
  /** 主标题 / 主正文 */
  textPrimary: string;
  /** 次要文字 / 图标 */
  textSecondary: string;
  /** 三级文字 / placeholder / metadata */
  textTertiary: string;
  /** CTA / 主操作填充(dark 下反相为白) */
  cta: string;
  /** CTA 上的文字 */
  ctaText: string;
  /** 就绪 / 在线状态点(品牌 teal,语义不变) */
  statusReady: string;
  /**
   * 录音中状态指示红(#ef4444,与 statusError 同值、对齐桌面;区分「停止录音」与中性色的
   * 「停止任务」)。红色系分工:状态指示(点/波形)用 statusError / statusRecording;
   * 破坏性按钮文字用 destructive;错误说明文案用 errorText(黑白系)。
   */
  statusRecording: string;
  /** 运行 / thinking 强调 + 完全访问权限(Heart Orange,语义不变) */
  statusAccent: string;
  /** 会话状态点 — 等待用户回复/选择(TapTap 蓝,对齐桌面 --card-status-awaiting 与灵动岛 needs-interaction) */
  statusAwaiting: string;
  /**
   * 会话状态点 — 任务出错(状态指示红 #ef4444,对齐桌面 --card-status-error;红专职表示出错)。
   * 仅用于状态指示(状态点/徽标),不用于按钮文字(那是 destructive)也不用于成段错误文案
   * (那是 errorText,黑白系)。
   */
  statusError: string;
  /** 会话状态点 — 完成未读(绿,对齐桌面 --card-status-done;橙专职 running) */
  statusDone: string;
  /** 自动审批权限模式强调色(TapTap 星蓝 light / teal dark,对齐桌面 --perm-auto-selected-text) */
  permAutoAccent: string;
  /**
   * 错误说明文案的黑白系前景 —— **刻意跟随 textPrimary,不是红色**(黑白反色设计里成段
   * 错误文案不点红,错误语义由文案与上下文承担;"error" 是历史命名)。勿用于按钮文字
   * (破坏性按钮用 destructive)、勿用于状态指示(用 statusError / statusRecording)。
   */
  errorText: string;
  /**
   * 破坏性操作按钮(退出登录/删除等)的**文字红**(#f43d3f),跨主题一致。只上按钮/菜单项
   * 文字;状态指示红是另一档 #ef4444(statusError / statusRecording),不要混用。
   */
  destructive: string;
  /** 错误边框(跟随 borderStrong) */
  errorBorder: string;
  /** Modal / lightbox 背板 */
  overlay: string;
  /** 素雅新建对话 FAB:dark 用柔白 #ECEDEF 而非纯白 cta,避免主入口在深底上过跳 */
  homeListFab: string;
  /** 会话行右滑「置顶/取消置顶」按钮底色(Heart Orange,与 statusAccent 同值但语义独立) */
  swipeActionPin: string;
  /** 会话行左滑「选项」按钮底色(iOS systemGray 感的中性灰) */
  swipeActionNeutral: string;
  /** 会话行左滑「归档」按钮底色(iOS 系统蓝;不用 statusAwaiting 青——其上白字对比不足) */
  swipeActionArchive: string;
  /** swipe 按钮上的文字/图标色:两个主题都是白(按钮底色恒为深色系,不能用会反相的 ctaText) */
  swipeActionText: string;
}

/** Default Light —— 对齐桌面 Ollama Light。 */
export const lightColors: ThemeColors = {
  surface: '#f8f8f6',
  surfaceElevated: '#ffffff',
  surfaceTranslucent: 'rgba(248, 248, 246, 0.78)',
  surfaceChip: '#e5e5e5',
  border: '#d7d7d4',
  borderTranslucent: 'rgba(215, 215, 212, 0.62)',
  borderStrong: '#a3a3a3',
  textPrimary: '#262626',
  textSecondary: '#525252',
  textTertiary: '#737373',
  cta: '#1f1f1f',
  ctaText: '#fbfbfa',
  statusReady: '#00D9C5',
  statusRecording: '#ef4444',
  statusAccent: '#ff6600',
  statusAwaiting: '#00D9C5',
  statusError: '#ef4444',
  statusDone: '#22c55e',
  permAutoAccent: '#000050',
  errorText: '#262626',
  destructive: '#f43d3f',
  errorBorder: '#a3a3a3',
  overlay: 'rgba(38, 38, 38, 0.24)',
  homeListFab: '#262626',
  swipeActionPin: '#ff6600',
  swipeActionNeutral: '#8e8e93',
  swipeActionArchive: '#3b82f6',
  swipeActionText: '#fbfbfa',
};

/** Default Dark —— 对齐桌面 Ollama Dark。 */
export const darkColors: ThemeColors = {
  surface: '#1f1f1e',
  surfaceElevated: '#2c2c2a',
  surfaceTranslucent: 'rgba(31, 31, 30, 0.78)',
  surfaceChip: '#3c3c3a',
  border: '#3c3c3a',
  borderTranslucent: 'rgba(60, 60, 58, 0.62)',
  borderStrong: '#525252',
  textPrimary: '#d4d4d4',
  textSecondary: '#a3a3a3',
  textTertiary: '#737373',
  // CTA 在 dark 反相为白 pill + 深色文字(同桌面 inverted CTA)。
  cta: '#ffffff',
  ctaText: '#1f1f1e',
  statusReady: '#00D9C5',
  statusRecording: '#ef4444',
  statusAccent: '#ff6600',
  statusAwaiting: '#00D9C5',
  statusError: '#ef4444',
  statusDone: '#22c55e',
  permAutoAccent: '#00D9C5',
  errorText: '#d4d4d4',
  destructive: '#f43d3f',
  errorBorder: '#525252',
  overlay: 'rgba(0, 0, 0, 0.45)',
  homeListFab: '#ECEDEF',
  swipeActionPin: '#ff6600',
  swipeActionNeutral: '#636366',
  swipeActionArchive: '#3b82f6',
  swipeActionText: '#fbfbfa',
};

export const palettes: Record<ThemeMode, ThemeColors> = {
  light: lightColors,
  dark: darkColors,
};

// —— 以下为主题无关(light / dark 一致)的不变量阶梯 ——

/** 间距阶梯,基数 4。 */
export const spacing = {
  xs: 4,
  sm: 8,
  md: 12,
  lg: 16,
  xl: 24,
  xxl: 32,
} as const;

/**
 * 圆角四档,对齐桌面 DESIGN.md 三档(8 内层控件 / 12 容器 / pill)+ 移动端微元素档:
 * - micro(4):缩略图内 chip、行内高亮等微元素;
 * - control(8):卡片内层控件 / 小按钮 / 缩略图;
 * - container(12):卡片 / 弹窗 / 输入容器;
 * - pill(9999):胶囊交互元素与细条 / 圆点(RN 自动截半)。
 * 阶梯外圆角禁止(守护测试拦截);组件几何专用值(如 composer 聚焦卡片)须带注释豁免。
 */
export const radius = {
  micro: 4,
  control: 8,
  container: 12,
  pill: 9999,
} as const;

/**
 * 收敛后的字号阶梯(对标桌面 hierarchy,保持克制)。
 * micro..headline 为工作号;largeTitle 是首页大标题(iOS large title 风格);hero 留给 login 品牌位。
 * 阶梯外字号一律禁止——需要新号先回本文件扩档,不许在组件里写字面量(有守护测试拦截)。
 */
export const typeScale = {
  micro: 11,
  caption: 12,
  footnote: 13,
  code: 15,
  body: 16,
  bodyLarge: 17,
  subtitle: 18,
  title: 20,
  headline: 24,
  largeTitle: 30,
  hero: 40,
} as const;

/**
 * 与字号配对的行高。除标准配对外只有三个场景档:
 * - bodyLarge(17/24):对话消息流正文(对齐 iOS 对话类 app 的 17pt 惯例);
 * - bodyRelaxed(16/24):login 副标题等宽松正文;
 * - listTitle(18/28、20/28):首页列表标题类,行高撑触控行。
 * micro(16) 同时服务紧凑 caption 场景(diff 行、媒体 hint 等行高即盒高的地方)。
 */
export const lineHeight = {
  micro: 16,
  caption: 18,
  code: 20,
  body: 22,
  bodyRelaxed: 24,
  bodyLarge: 24,
  title: 25,
  subtitle: 26,
  listTitle: 28,
  headline: 30,
  largeTitle: 36,
  hero: 44,
} as const;

/** 字重:克制到 4 档。默认 medium;semibold 仅限大写微标签等少量强调;bold 仅限 login 品牌 hero 标题。 */
export const fontWeight = {
  regular: '400',
  medium: '500',
  semibold: '600',
  bold: '700',
} as const;

/**
 * 排版 preset —— 每档字号与其标准行高的配对,组件里 `...textStyles.body` 一次展开,
 * 保证字号 / 行高永远成对不漂移;字重按需用 `fontWeight` token 叠加。
 * 非标准配对(如 subtitle 字号 + listTitle 行高)手动组合两个 token,但禁止字面量。
 */
export const textStyles = {
  micro: { fontSize: typeScale.micro, lineHeight: lineHeight.micro },
  caption: { fontSize: typeScale.caption, lineHeight: lineHeight.caption },
  footnote: { fontSize: typeScale.footnote, lineHeight: lineHeight.caption },
  code: { fontSize: typeScale.code, lineHeight: lineHeight.code },
  body: { fontSize: typeScale.body, lineHeight: lineHeight.body },
  bodyRelaxed: { fontSize: typeScale.body, lineHeight: lineHeight.bodyRelaxed },
  bodyLarge: { fontSize: typeScale.bodyLarge, lineHeight: lineHeight.bodyLarge },
  subtitle: { fontSize: typeScale.subtitle, lineHeight: lineHeight.subtitle },
  title: { fontSize: typeScale.title, lineHeight: lineHeight.title },
  headline: { fontSize: typeScale.headline, lineHeight: lineHeight.headline },
  largeTitle: { fontSize: typeScale.largeTitle, lineHeight: lineHeight.largeTitle },
  hero: { fontSize: typeScale.hero, lineHeight: lineHeight.hero },
} as const;

/**
 * lucide 图标尺寸阶梯。xs..xxl 为工作档;action 是工具栏 / lightbox 操作图标档
 * (18 与 22 之间的真实需求档,语义命名避免 size 名整体重排);
 * display / hero 留给空态大图标与导航级大 chevron。
 * 阶梯外尺寸一律禁止——需要新档先回本文件扩档(守护测试拦截)。
 */
export const iconSize = {
  xs: 12,
  sm: 14,
  md: 16,
  lg: 18,
  action: 20,
  xl: 22,
  xxl: 26,
  display: 32,
  hero: 44,
  /** 文件浏览网格的大图标档(文件夹/通用文件 glyph),与列表 lucide 描边图标同语言放大。 */
  glyph: 64,
} as const;

/**
 * lucide 图标 strokeWidth 阶梯。收敛前仓库里散落 14 种碎片值(1.5~3),
 * 视觉上无法区分意图;收敛为四档:thin(大圆形图标的轻盈描边)、
 * regular(默认,lucide 出厂值)、medium(选中态 Check 等强调)、bold(微图标增粗保清晰)。
 */
export const iconStroke = {
  thin: 1.75,
  regular: 2,
  medium: 2.2,
  bold: 2.5,
} as const;

/**
 * 文件浏览网格「真实内容迷你页」缩略图的微缩文本档位。
 * 不进 typeScale:它不是供阅读的排版,是把文档首屏画成缩略图的装饰性渲染
 * (对标 iOS Files 文档缩略图),阅读态字号永远走 typeScale。
 */
export const docThumbSnippetType = {
  fontSize: 4,
  lineHeight: 6,
} as const;
