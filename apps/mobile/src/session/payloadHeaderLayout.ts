export interface PayloadHeaderLayoutInput {
  canCopy: boolean;
  canOpen: boolean;
  canPageGallery: boolean;
  screenWidth: number;
}

export interface PayloadModalSafeAreaInput {
  androidStatusBarHeight?: number;
  platform: string;
  safeAreaBottom: number;
  safeAreaTop: number;
}

export interface PayloadHeaderLayout {
  actionButtonMinWidth: number;
  actionGap: number;
  actionsAlignItems: 'flex-end' | 'flex-start';
  actionsWidth: 'auto' | '100%';
  closeButtonMinWidth: number;
  compact: boolean;
  galleryButtonMinWidth: number;
  headerDirection: 'row' | 'column';
  headerGap: number;
  headerPaddingHorizontal: number;
  primaryActionsJustifyContent: 'flex-end' | 'flex-start';
  titleNumberOfLines: number;
}

export interface PayloadModalSafeArea {
  paddingBottom: number;
  paddingTop: number;
}

const DEFAULT_SCREEN_WIDTH = 390;
const COMPACT_WIDTH = 300;
const MIN_TITLE_WIDTH = 176;
const STANDARD_HORIZONTAL_PADDING = 16;
const COMPACT_HORIZONTAL_PADDING = 12;
const HEADER_GAP = 12;
const ACTION_GAP = 4;
const ACTION_BUTTON_MIN_WIDTH = 36;
const CLOSE_BUTTON_MIN_WIDTH = 40;
const GALLERY_BUTTON_MIN_WIDTH = 36;
const IOS_MODAL_TOP_FALLBACK = 56;
const IOS_MODAL_BOTTOM_FALLBACK = 24;

export function buildPayloadHeaderLayout(input: PayloadHeaderLayoutInput): PayloadHeaderLayout {
  const screenWidth = normalizeDimension(input.screenWidth, DEFAULT_SCREEN_WIDTH);
  const primaryActionCount = Number(input.canCopy) + Number(input.canOpen);
  const primaryActionsWidth = rowWidth(primaryActionCount, ACTION_BUTTON_MIN_WIDTH, ACTION_GAP);
  const galleryActionsWidth = input.canPageGallery
    ? rowWidth(2, GALLERY_BUTTON_MIN_WIDTH, ACTION_GAP)
    : 0;
  const actionColumnWidth = Math.max(primaryActionsWidth, galleryActionsWidth, CLOSE_BUTTON_MIN_WIDTH);
  const standardTextWidth = screenWidth
    - STANDARD_HORIZONTAL_PADDING * 2
    - HEADER_GAP
    - actionColumnWidth;
  const compact = screenWidth <= COMPACT_WIDTH || standardTextWidth < MIN_TITLE_WIDTH;

  return {
    actionButtonMinWidth: ACTION_BUTTON_MIN_WIDTH,
    actionGap: ACTION_GAP,
    actionsAlignItems: compact ? 'flex-start' : 'flex-end',
    actionsWidth: compact ? '100%' : 'auto',
    closeButtonMinWidth: CLOSE_BUTTON_MIN_WIDTH,
    compact,
    galleryButtonMinWidth: GALLERY_BUTTON_MIN_WIDTH,
    headerDirection: compact ? 'column' : 'row',
    headerGap: compact ? ACTION_GAP : HEADER_GAP,
    headerPaddingHorizontal: compact ? COMPACT_HORIZONTAL_PADDING : STANDARD_HORIZONTAL_PADDING,
    primaryActionsJustifyContent: compact ? 'flex-start' : 'flex-end',
    titleNumberOfLines: compact ? 2 : 2,
  };
}

export function buildPayloadModalSafeArea(input: PayloadModalSafeAreaInput): PayloadModalSafeArea {
  const top = normalizeNonNegative(input.safeAreaTop);
  const bottom = normalizeNonNegative(input.safeAreaBottom);
  const androidStatusBarHeight = normalizeNonNegative(input.androidStatusBarHeight ?? 0);

  return {
    paddingBottom: Math.max(bottom, input.platform === 'ios' ? IOS_MODAL_BOTTOM_FALLBACK : 0),
    paddingTop: Math.max(
      top,
      input.platform === 'ios' ? IOS_MODAL_TOP_FALLBACK : 0,
      input.platform === 'android' ? androidStatusBarHeight : 0,
    ),
  };
}

function rowWidth(count: number, itemWidth: number, gap: number): number {
  if (count <= 0) return 0;
  return count * itemWidth + Math.max(count - 1, 0) * gap;
}

function normalizeDimension(value: number, fallback: number): number {
  return Number.isFinite(value) && value > 0 ? value : fallback;
}

function normalizeNonNegative(value: number): number {
  return Number.isFinite(value) && value > 0 ? value : 0;
}
