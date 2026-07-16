import {
  DEFAULT_NEAR_BOTTOM_THRESHOLD,
  isNearMessageListBottom,
  type MessageScrollMetrics,
} from '@lizi/maker-shared/message-window';
import type {
  MobileMessageRenderItem,
  MobileWorkChildItem,
} from '@/session/messageRenderModel';
import type { NormalizedRemoteMessage } from '@/session/messageNormalize';

export {
  DEFAULT_NEAR_BOTTOM_THRESHOLD,
  DEFAULT_LOAD_EARLIER_THRESHOLD,
  buildMessageLoadEarlierAction,
  buildSearchLoadEarlierAction,
  evaluateMessageWindowUpdate,
  isNearMessageListBottom,
  isNearMessageListTop,
  shouldAutoFollowMessages,
  shouldShowNewMessageIndicator,
  type MessageLoadEarlierActionPresentation,
  type MessageScrollMetrics,
  type MessageWindowChangeKind,
  type MessageWindowUpdateDecision,
} from '@lizi/maker-shared/message-window';

export const MOBILE_MESSAGE_LIST_BOTTOM_PADDING = 132;
export const MOBILE_NEAR_BOTTOM_THRESHOLD =
  DEFAULT_NEAR_BOTTOM_THRESHOLD + MOBILE_MESSAGE_LIST_BOTTOM_PADDING;

export function mobileMessageListBottomPadding(bottomOverlayHeight?: number): number {
  if (typeof bottomOverlayHeight !== 'number' || !Number.isFinite(bottomOverlayHeight)) {
    return MOBILE_MESSAGE_LIST_BOTTOM_PADDING;
  }
  return Math.max(MOBILE_MESSAGE_LIST_BOTTOM_PADDING, Math.ceil(bottomOverlayHeight));
}

export function mobileMessageListNearBottomThreshold(bottomOverlayHeight?: number): number {
  return DEFAULT_NEAR_BOTTOM_THRESHOLD + mobileMessageListBottomPadding(bottomOverlayHeight);
}

export function isNearMobileMessageListBottom(
  metrics: MessageScrollMetrics,
  bottomOverlayHeight?: number,
): boolean {
  return isNearMessageListBottom(metrics, mobileMessageListNearBottomThreshold(bottomOverlayHeight));
}

export function mobileMessageListEndOffset(metrics: MessageScrollMetrics): number {
  return Math.max(0, metrics.contentHeight - metrics.viewportHeight);
}

/**
 * 贴底锚定校验的判定容差:contentSize / offset 都是浮点布局值,亚像素误差不算落空。
 * 取 2px:小于任何真实遮挡(一行文字 ≥ 20px),大于 Fabric 布局的舍入抖动。
 */
export const MOBILE_ANCHOR_VERIFY_TOLERANCE = 2;

/**
 * 校验补滚上限:每次补滚目标幂等(同一 end offset),多滚无视觉副作用,上限只为防
 * 目标不可达(如 metrics 偏大被原生截停)时空转。6 次 × 双帧 ≈ 200ms 内收敛。
 */
export const MOBILE_ANCHOR_VERIFY_MAX_ATTEMPTS = 6;

/**
 * 校验等待上限(独立于补滚预算):mVCP 还开着 / metrics 未就绪时环只等不滚,等待
 * 不消耗补滚额度——否则 mVCP 长开(open-settle cap 2s)会把预算烧光,窗口关闭后
 * 反而没额度补滚,遮挡残留(review P1)。上限按最长 mVCP 窗口取:双帧一轮 ≈ 33ms,
 * 75 轮 ≈ 2.5s > OPEN_SETTLE_CAP_MS(2000ms),窗口自然关闭后环仍活着;再长说明
 * 状态异常(如列表空置),结束环交给常规事件跟随,每轮只是一次纯函数比较,无副作用。
 */
export const MOBILE_ANCHOR_VERIFY_MAX_WAIT_ROUNDS = 75;

export interface MobileAnchorVerifyInput {
  attempts: number;
  listVisible: boolean;
  metrics: MessageScrollMetrics;
  preserveVisibleContentPosition: boolean;
  stickToLatest: boolean;
  waitRounds: number;
}

export type MobileAnchorVerifyAction =
  /** 已贴底(或用户已接管滚动),校验结束。 */
  | 'settled'
  /** 未贴底且允许补滚:重发一次落底 scrollToOffset 后继续校验。 */
  | 'retry'
  /** 暂不能判定/不能滚(mVCP 还开着、metrics 未就绪):下一轮再校验。 */
  | 'wait'
  /** 重试预算耗尽,放弃(交给后续 contentSize / layout 事件的常规跟随)。 */
  | 'give-up';

/**
 * 贴底锚定校验判定(纯函数,供 MessageRenderer 的 verify 环使用)。
 *
 * 背景:贴底跟随的落底 scrollToOffset 存在两类静默落空——
 * (a) maintainVisibleContentPosition 尚未真正关闭的帧里执行,被 mVCP 当成上方内容
 *     增长吸收/抵消(组件内 open-settle 注释实测过的偶发路径);
 * (b) 落底一刻 scrollMetricsRef 里的 contentHeight / viewportHeight 是陈旧值,目标
 *     offset 偏短,且之后再无 contentSize / layout 事件来纠正。
 * 两类的共同结果都是「最新消息停在底部浮层(composer)后面」。verify 环在每次落底后
 * 校验 offset 是否真到内容末端,未到位则带上限补滚,从机制上兜掉所有此类竞态。
 */
export function evaluateMobileAnchorVerify(input: MobileAnchorVerifyInput): MobileAnchorVerifyAction {
  if (!input.stickToLatest || !input.listVisible) return 'settled';
  // mVCP 还开着(state 已请求关闭但 prop 未下发,或 settle 窗口仍在):此刻补滚会再次
  // 被吸收,等窗口真正关闭后的下一轮再判。等待走独立预算,不消耗补滚额度。
  const { contentHeight, offsetY, viewportHeight } = input.metrics;
  if (input.preserveVisibleContentPosition || contentHeight <= 0 || viewportHeight <= 0) {
    return input.waitRounds >= MOBILE_ANCHOR_VERIFY_MAX_WAIT_ROUNDS ? 'give-up' : 'wait';
  }
  // 内容不足一屏时 end offset 为 0,任何非负 offset 都算贴底(iOS bounce 可为负,同样无遮挡)。
  const endOffset = mobileMessageListEndOffset(input.metrics);
  if (offsetY >= endOffset - MOBILE_ANCHOR_VERIFY_TOLERANCE) return 'settled';
  if (input.attempts >= MOBILE_ANCHOR_VERIFY_MAX_ATTEMPTS) return 'give-up';
  return 'retry';
}

/** 顶部让位后额外的呼吸间距:第一条消息与工具栏 hairline 分隔线之间留一点空隙。 */
const MOBILE_MESSAGE_LIST_TOP_GAP = 8;

/**
 * 顶部 chrome(绝对定位的半透明工具栏)高度 → 列表内容顶部让位。
 * chrome 浮在列表之上,不让位的话滚到历史最顶端时第一条消息永远被工具栏盖住、再也滑不出来;
 * 让位只加在内容起点,滚动途中内容仍从工具栏下方穿过,半透明效果不变(与 bottomOverlayHeight 同款模式)。
 */
export function mobileMessageListTopPadding(topOverlayHeight?: number): number {
  if (typeof topOverlayHeight !== 'number' || !Number.isFinite(topOverlayHeight) || topOverlayHeight <= 0) {
    return 0;
  }
  return Math.ceil(topOverlayHeight) + MOBILE_MESSAGE_LIST_TOP_GAP;
}

export interface MobileTopPaddingCompensationInput {
  previousTopPadding: number;
  nextTopPadding: number;
  offsetY: number;
  stickToLatest: boolean;
  preserveVisibleContentPosition: boolean;
  listVisible: boolean;
}

/**
 * 顶部让位(paddingTop)在阅读中途变化时的 offset 补偿目标(review P2)。
 * 场景:chrome 实高会因连接横幅出现/消失而变,paddingTop 随之突变;稳态阅读时 mVCP 未开启,
 * contentSize 变化走 skip 分支、contentOffset 不动,可见内容会整体跳 padding delta。
 * 返回补偿后的目标 offset;返回 null 表示不需要补偿:
 * - 贴底跟随中(stickToLatest):contentSize follow 分支自会重锚到底;
 * - preserve 窗口开着(load-earlier / open-settle):mVCP 正锚着首个可见 cell,会自行吸收上方位移,
 *   再手动补偿会双重位移;
 * - 列表未揭开:揭开路径自己定位;
 * - 停在最顶(offset<=0):让位本来就该把内容推下来给横幅腾位,补偿反而会把第一条消息藏回横幅下。
 */
export function mobileTopPaddingCompensationOffset(input: MobileTopPaddingCompensationInput): number | null {
  const delta = input.nextTopPadding - input.previousTopPadding;
  if (delta === 0) return null;
  if (input.stickToLatest || input.preserveVisibleContentPosition || !input.listVisible) return null;
  if (input.offsetY <= 0) return null;
  return Math.max(0, input.offsetY + delta);
}

/**
 * 「加载更早」预取触发距离:离顶还有约两屏时就开始拉上一页,而不是撞到顶(旧默认 96px)才拉。
 * 目标是无感翻页——用户滑到旧内容顶端之前,更早的消息已经 prepend 完毕,浏览像连续对话一样;
 * 同时触发时刻锚点(首个可见消息 cell)远离接缝,mVCP 的视口补偿也最稳定。
 * 视口高度未知(布局前)时退回旧默认,不凭空放大。
 * 不会级联连拉:每页 80 条消息的高度远超两屏,prepend 落地后 offsetY 被 mVCP 顶高、立即脱离阈值。
 * 边界假设(review P2):上一行成立的前提是页均高度 > 两屏,即平均每条 > viewportHeight/40
 * (典型视口 844px 约 21px/条,低于单行气泡的最小实高)。理论上整页全是极短消息才可能连拉一页,
 * 且有 loadingEarlier 门禁串行化,最坏是多拉一页,不会失控循环。
 */
export function mobileLoadEarlierPrefetchThreshold(viewportHeight: number): number {
  if (!Number.isFinite(viewportHeight) || viewportHeight <= 0) return 96;
  return Math.max(96, Math.ceil(viewportHeight * 2));
}

export interface MobileAutoLoadEarlierDecisionInput {
  /** 「加载更早」动作当前不可点(加载中)。 */
  actionDisabled: boolean;
  /** 「加载更早」入口可见(hasOlderMessages 且列表非空)。 */
  actionVisible: boolean;
  /** 列表当前贴在内容末端(LegendList getState().isAtEnd,含 prepend 补偿后的记账)。 */
  atEnd: boolean;
  /** 当前首个渲染项 key(prepend 落地后必变,作为「上次尝试有进展」的信号)。 */
  firstItemKey: string | null;
  /** 上一次自动触发时的首项 key;相同说明上次尝试无进展(失败/重复页),不再自动重试。 */
  lastAttemptedFirstItemKey: string | null;
  /** 列表处于近顶预取区(LegendList getState().isNearStart,阈值 = onStartReachedThreshold × 视口)。 */
  nearStart: boolean;
  /** 用户产生过真实上翻意图(拖动 / 上跳导航);冷开初始布局不算。 */
  userScrolledForOlder: boolean;
}

/**
 * 「自动加载更早」的电平触发判定(纯函数,MessageRenderer 每个可能改变结果的时机都重新评估)。
 *
 * 背景(bug:停在顶部但更早消息永远不自动加载):LegendList 的 onStartReached 是**边沿触发**——
 * 触发过一次后,要么滚离顶部超过 threshold × 1.3(迟滞)再回来、要么阈值内发生 data 变化,才会再发。
 * 而 handleStartReached 里有一组业务 guard(用户没拖动过 / 正在加载 / hasOlderMessages 未就绪),
 * guard 不满足时这次边沿被直接吞掉;之后 guard 条件就绪,却再也等不到下一个边沿:
 * - 短加载窗口(内容总高 < ~3.6 屏)冷开时列表底部就落在近顶阈值内,边沿在用户拖动前就被消费,
 *   用户之后永远滚不出 1.3 × 阈值的复位区 → 永久哑火(实机高频复现的截图场景);
 * - 上一页在途时到达顶部(disabled guard 吞边沿),加载完成后停在顶部无任何重评估 → 哑火。
 * 修复:把判定改成电平语义——nearStart / atEnd 直接读 LegendList getState() 的实时账
 * (它的 scroll 记账含 prepend 锚点补偿,app 侧 onScroll 的原生 offsetY 在 prepend 后不可信),
 * 并在 scroll 事件、onStartReached、eligibility 变化(加载结束/入口点亮/首项变化)时都重新评估。
 *
 * 防失控:
 * - atEnd 时不触发:贴底跟流的用户(含短会话)不因自动预取被关掉 end-pin;
 * - firstItemKey 去重:一次尝试后必须看到首项变化(真有 prepend)才允许下一次,
 *   加载失败或拉回重复页(host cursor 未命中返回最新页)不会无限重试;用户重新拖动时清除,
 *   保证手势永远能重新驱动一次尝试。
 */
export function shouldAutoLoadEarlier(input: MobileAutoLoadEarlierDecisionInput): boolean {
  if (!input.userScrolledForOlder) return false;
  if (!input.actionVisible || input.actionDisabled) return false;
  if (!input.nearStart || input.atEnd) return false;
  if (!input.firstItemKey) return false;
  return input.lastAttemptedFirstItemKey !== input.firstItemKey;
}

export interface MobilePreviousUserJumpTarget {
  clientId: string;
  index: number;
  itemKey: string;
  preview: string;
}

export function previousUserMessageJumpTarget(
  items: readonly MobileMessageRenderItem[],
  firstVisibleIndex: number,
): MobilePreviousUserJumpTarget | null {
  if (!Number.isFinite(firstVisibleIndex)) return null;
  const startIndex = Math.min(items.length - 1, Math.floor(firstVisibleIndex) - 1);
  if (startIndex < 0) return null;
  for (let index = startIndex; index >= 0; index -= 1) {
    const item = items[index];
    if (item.type !== 'message' || item.message.kind !== 'user') continue;
    const clientId = mobileMessageClientId(item.message);
    if (!clientId) continue;
    return {
      clientId,
      index,
      itemKey: item.key,
      preview: firstNonEmptyMessageLine(item.message.body),
    };
  }
  return null;
}

export function findMobileRenderItemKeyByClientId(
  items: readonly MobileMessageRenderItem[],
  clientId: string | null | undefined,
): string | null {
  if (!clientId) return null;
  for (const item of items) {
    const key = findClientIdInRenderItem(item, clientId, item.key);
    if (key) return key;
  }
  return null;
}

export function firstNonEmptyMessageLine(raw: string): string {
  return raw.split('\n').find((line) => line.trim().length > 0)?.trim() ?? '';
}

function findClientIdInRenderItem(
  item: MobileMessageRenderItem | MobileWorkChildItem,
  clientId: string,
  scrollTargetKey: string,
): string | null {
  if (item.type === 'message' && mobileMessageClientId(item.message) === clientId) {
    return scrollTargetKey;
  }
  if (item.type === 'thinking' && mobileMessageClientId(item.message) === clientId) {
    return scrollTargetKey;
  }
  if (item.type === 'tool_group') {
    return item.tools.some((tool) => (tool.source.clientId || tool.source.id || tool.key) === clientId)
      ? scrollTargetKey
      : null;
  }
  if (item.type === 'agent_task') {
    const tool = item.toolCall;
    return tool && (tool.source.clientId || tool.source.id || tool.key) === clientId ? scrollTargetKey : null;
  }
  if (item.type === 'work_group') {
    for (const child of item.children) {
      const key = findClientIdInRenderItem(child, clientId, scrollTargetKey);
      if (key) return key;
    }
  }
  if (item.type === 'subagent_group') {
    for (const child of item.childItems) {
      const key = findClientIdInRenderItem(child, clientId, scrollTargetKey);
      if (key) return key;
    }
  }
  return null;
}

function mobileMessageClientId(message: NormalizedRemoteMessage): string {
  return message.source.clientId || message.source.id || message.key;
}
