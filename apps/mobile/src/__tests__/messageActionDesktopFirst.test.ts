import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

describe('mobile message actions desktop-first surface', () => {
  it('keeps visible message controls compact while preserving touch hit slop', () => {
    const source = readFileSync(resolve(process.cwd(), 'src/session/MessageRenderer.tsx'), 'utf8');
    const sharedSource = readFileSync(resolve(process.cwd(), '../../packages/maker-shared/src/messagePresentation.ts'), 'utf8');

    expect(source).toContain('const MESSAGE_CONTROL_HIT_SLOP = { bottom: 10, left: 10, right: 10, top: 10 };');
    expect(source).toContain('buildMessageActionBarPresentation');
    expect(sharedSource).toContain("input.canCopy ? 'copy' : null");
    expect(sharedSource).toContain("input.canFork ? 'fork' : null");
    expect(sharedSource).toContain("input.hasTime ? 'time' : null");
    expect(sharedSource).toContain("input.hasTurnCost ? 'cost' : null");
    expect(sharedSource).toContain("input.hasTime ? 'time' : null");
    expect(sharedSource).toContain("input.canRewind ? 'rewind' : null");
    expect(source).toContain('hitSlop={MESSAGE_CONTROL_HIT_SLOP}');
    expect(source).toContain('buttonSize={actionBar.buttonSize}');
    expect(source).toContain('iconSize={actionBar.iconSize}');
    expect(source).toContain('{ height: buttonSize, width: buttonSize }');
    expect(source).toContain('height: 24');
    expect(source).toContain('width: 24');
    expect(source).toContain('borderRadius: radius.pill');
    expect(sharedSource).toContain('buttonSize: 24');
    expect(sharedSource).toContain('iconSize: 14');
    expect(source).not.toContain('MESSAGE_CONTROL_ICON_SIZE = 16');
    expect(source).not.toContain('messageMetaRow');
    expect(source).not.toContain('messageControlRow');
    expect(source).not.toContain('testID="message.metaRow"');
    expect(source).not.toContain('testID="message.controlRow"');
  });

  it('renders user rows carrying a system card as system presentation (no user affordances)', () => {
    // silent-stop 自动续跑行(kind='user' + systemCardType,turn 边界所需)必须在
    // 渲染层降级为 system 再进 MessageBubble——presentation 的 isUserAligned 是
    // `align==='user' || kind==='user'`,不降级会右对齐成用户气泡并挂 fork / rewind
    // 操作行(对齐桌面 MessageStream 对该形态提前 return SystemCard,review P2)。
    const source = readFileSync(resolve(process.cwd(), 'src/session/MessageRenderer.tsx'), 'utf8');
    expect(source).toContain("? { ...item, message: { ...item.message, kind: 'system' as const } }");
    expect(source).toContain('<MessageBubble item={systemCardUserItem ?? item} actions={actions} />');
  });

  it('keeps message controls outside the user bubble like the desktop action bar', () => {
    const source = readFileSync(resolve(process.cwd(), 'src/session/MessageRenderer.tsx'), 'utf8');
    const bubbleStart = source.indexOf('const bubble = (');
    const returnStart = source.indexOf('return (', bubbleStart);
    const bubbleSource = source.slice(bubbleStart, returnStart);
    const renderSource = source.slice(returnStart, source.indexOf('function copyActionLabel', returnStart));

    expect(bubbleStart).toBeGreaterThan(-1);
    expect(returnStart).toBeGreaterThan(bubbleStart);
    expect(bubbleSource).toContain('testID={isUser ? \'message.userBubble\' : \'message.agentBubble\'}');
    expect(bubbleSource).not.toContain('testID="message.actionBar"');
    expect(renderSource).toContain('styles.messageItem');
    expect(renderSource).toContain('isUser ? styles.userMessageItem : styles.agentMessageItem');
    // 附件条与气泡都在 action bar 之前(气泡在纯图片消息下可被跳过,但渲染位置不变)
    expect(renderSource).toContain('{hasBubbleContent || (!attachmentStripNode && !leadingQuotes) ? bubble : null}');
    expect(renderSource.indexOf('? bubble : null')).toBeLessThan(renderSource.indexOf('testID="message.actionBar"'));
  });

  it('renders collapsed work groups like the desktop work summary row, not a detail card', () => {
    const source = readFileSync(resolve(process.cwd(), 'src/session/MessageRenderer.tsx'), 'utf8');
    const start = source.indexOf('function WorkGroupCard');
    const end = source.indexOf('function FoldablePanel', start);
    const workGroupSource = source.slice(start, end);

    // 产品决策(2026-06):所有 agent 活动卡(work / 工具组 / subagent / 协同)统一用小机器人 Bot,
    // 故 work group 用 Bot 而非桌面 WorkGroupBlock 的 Layers —— 有意偏离桌面,勿改回 Layers。
    expect(source).toContain('Bot,');
    expect(workGroupSource).toContain('const header = presentation.header;');
    expect(workGroupSource).toContain('chevronPosition={header.chevronPosition}');
    expect(workGroupSource).toContain('chevronSize={header.chevronSize}');
    expect(workGroupSource).toContain('title={header.title}');
    expect(workGroupSource).toContain('subtitle={header.subtitle ?? undefined}');
    // 展开态走 blockId 共享记忆,不再传 defaultExpanded(blockId 存在时该值无效)。
    expect(workGroupSource).not.toContain('defaultExpanded');
    expect(workGroupSource).toContain('leadingIcon={<Bot color={colors.textTertiary} size={header.iconSize} strokeWidth={iconStroke.regular} />}');
    expect(workGroupSource).toContain('variant={header.variant}');
    expect(workGroupSource).toContain('summaryCount: header.summaryCount');
    expect(workGroupSource).toContain('<RenderItemView key={child.key} item={child} actions={actions} />');
    expect(workGroupSource).not.toContain('subtitle={presentation.subtitle}');
    expect(workGroupSource).not.toContain('badges={presentation.badges}');
    expect(workGroupSource).not.toContain('badgeCount: presentation.badges.length');
    expect(source).not.toContain('testID="message.workGroupToggle"\n      variant="card"');
  });

  it('keeps plain foldable headers as desktop summary rows, not mobile cards', () => {
    const source = readFileSync(resolve(process.cwd(), 'src/session/MessageRenderer.tsx'), 'utf8');
    const start = source.indexOf('function FoldablePanel');
    const end = source.indexOf('function Rail', start);
    const foldableSource = source.slice(start, end);

    expect(source).toContain('const FOLDABLE_HEADER_HIT_SLOP = { bottom: 10, left: 4, right: 4, top: 10 };');
    expect(foldableSource).toContain("const headerLayoutStyle = variant === 'plain'");
    expect(foldableSource).toContain('? styles.foldHeaderPlain');
    expect(foldableSource).toContain("hitSlop={variant === 'plain' ? FOLDABLE_HEADER_HIT_SLOP : undefined}");
    expect(source).toContain('foldHeaderPlain: {');
    expect(source).toContain('gap: 6');
    expect(source).toContain('minHeight: 22');
    expect(source).toContain('paddingHorizontal: 0');
    expect(source).toContain('paddingVertical: 2');
    expect(source).toContain("variant === 'plain' && styles.foldTitlePlain");
    expect(source).toContain('foldTitlePlain: { color: colors.textTertiary, fontWeight: fontWeight.regular }');
  });

  it('keeps the load-earlier affordance lighter than message content', () => {
    const source = readFileSync(resolve(process.cwd(), 'src/session/MessageRenderer.tsx'), 'utf8');
    const styleStart = source.indexOf('loadEarlierButton: {');
    const styleEnd = source.indexOf('loadEarlierText:', styleStart);
    const buttonStyle = source.slice(styleStart, styleEnd);

    expect(buttonStyle).toContain('minHeight: 32');
    expect(buttonStyle).toContain('paddingHorizontal: spacing.md');
    expect(buttonStyle).not.toContain('borderWidth');
    expect(buttonStyle).not.toContain('borderColor');
    expect(source).toContain("loadEarlierText: { color: colors.textTertiary");
  });

  it('renders collapsed tool groups like the desktop agent action summary row', () => {
    const source = readFileSync(resolve(process.cwd(), 'src/session/MessageRenderer.tsx'), 'utf8');
    const start = source.indexOf('function ToolGroupCard');
    const end = source.indexOf('function TodoCard', start);
    const toolGroupSource = source.slice(start, end);

    expect(source).toContain('Bot,');
    expect(toolGroupSource).toContain('const header = presentation.header;');
    expect(toolGroupSource).toContain('chevronPosition={header.chevronPosition}');
    expect(toolGroupSource).toContain('chevronSize={header.chevronSize}');
    expect(toolGroupSource).toContain('title={header.title}');
    expect(toolGroupSource).toContain('subtitle={header.subtitle ?? undefined}');
    // 展开态走 blockId 共享记忆,不再传 defaultExpanded(blockId 存在时该值无效)。
    expect(toolGroupSource).not.toContain('defaultExpanded');
    expect(toolGroupSource).toContain('blockId={item.key}');
    // 块头图标:有执行中工具时同槽位换成进行中形态(对齐桌面 #454),否则维持 Bot。
    expect(toolGroupSource).toContain('? <CircleDashed color={colors.textTertiary} size={header.iconSize} strokeWidth={iconStroke.regular} />');
    expect(toolGroupSource).toContain(': <Bot color={colors.textTertiary} size={header.iconSize} strokeWidth={iconStroke.regular} />');
    expect(toolGroupSource).toContain('variant={header.variant}');
    expect(toolGroupSource).toContain('<Rail layout={layout}>');
    expect(toolGroupSource).toContain('summaryCount: header.summaryCount');
    // 工具行对齐桌面 AgentActionRow:一行摘要,点击就地展开详情;展开态走共享记忆(toolrow- 前缀)。
    expect(toolGroupSource).toContain('useFoldableExpandedState(`toolrow-${tool.key}`, false)');
    expect(toolGroupSource).toContain('testID="message.toolRowToggle"');
    expect(toolGroupSource).toContain('{showDetails ? (');
    // 「查看内容」hint 只在文本结果被截断时显示。
    const resultPreviewStart = source.indexOf('function ToolResultPreview');
    const resultPreviewEnd = source.indexOf('function MessageContentOpenButton', resultPreviewStart);
    const resultPreviewSource = source.slice(resultPreviewStart, resultPreviewEnd);
    expect(resultPreviewSource).toContain("payload.kind !== 'text' || clipped");
    expect(resultPreviewSource).toContain('{showHint ? <Text style={styles.toolResultHint}>{preview.actionLabel}</Text> : null}');
    expect(toolGroupSource).not.toContain('row.signals.map');
    expect(toolGroupSource).not.toContain('styles.toolRowSignals');
    expect(toolGroupSource).not.toContain('styles.toolRowSignal');
    expect(toolGroupSource).not.toContain('subtitle={presentation.subtitle}');
    expect(toolGroupSource).not.toContain('badges={presentation.badges}');
    expect(toolGroupSource).not.toContain('badgeCount: presentation.badges.length');
    expect(toolGroupSource).not.toContain('variant="card"');
  });

  it('renders todo cards like the desktop inline checklist, not a separate details sheet', () => {
    const source = readFileSync(resolve(process.cwd(), 'src/session/MessageRenderer.tsx'), 'utf8');
    const start = source.indexOf('function TodoCard');
    const end = source.indexOf('function WorkGroupCard', start);
    const todoSource = source.slice(start, end);

    expect(source).toContain('ListTodo,');
    expect(source).toContain('CircleCheck,');
    expect(source).toContain('CircleDashed,');
    expect(source).toContain('Circle,');
    expect(todoSource).toContain('const header = presentation.header;');
    expect(todoSource).toContain('title={header.title}');
    expect(todoSource).toContain('subtitle={header.subtitle ?? undefined}');
    expect(todoSource).toContain('chevronPosition={header.chevronPosition}');
    expect(todoSource).toContain('chevronSize={header.chevronSize}');
    expect(todoSource).toContain('defaultExpanded={header.defaultExpanded}');
    expect(todoSource).toContain('leadingIcon={<ListTodo color={colors.textPrimary} size={header.iconSize} strokeWidth={iconStroke.regular} />}');
    expect(todoSource).toContain('variant={header.variant}');
    expect(todoSource).toContain('summaryCount: header.summaryCount');
    expect(todoSource).toContain('item.todos.map');
    expect(todoSource).toContain('<TodoStatusIcon status={presentation.status} />');
    expect(todoSource).not.toContain('summaryTodos');
    expect(todoSource).not.toContain('hiddenCount');
    expect(todoSource).not.toContain('todoOpenButton');
    expect(todoSource).not.toContain('TodoDetailModal');
    expect(todoSource).not.toContain('todoStatusLabel');
    expect(source).not.toContain('testID="message.todoSheet"');
    expect(source).not.toContain('testID="message.todoOpenButton"');
  });

  it('does not keep a hidden badge rendering path in foldable message hierarchy panels', () => {
    const source = readFileSync(resolve(process.cwd(), 'src/session/MessageRenderer.tsx'), 'utf8');
    const sharedSource = readFileSync(resolve(process.cwd(), '../../packages/maker-shared/src/messagePresentation.ts'), 'utf8');
    const start = source.indexOf('function FoldablePanel');
    const end = source.indexOf('function Rail', start);
    const foldableSource = source.slice(start, end);

    expect(source).not.toContain('function MessageBadges');
    expect(source).not.toContain('MessagePresentationBadge');
    expect(sharedSource).not.toContain('MessagePresentationBadge');
    expect(sharedSource).not.toContain('badges:');
    expect(sharedSource).not.toContain('signals:');
    expect(sharedSource).not.toContain('const badges');
    expect(sharedSource).not.toContain('const signals');
    expect(foldableSource).not.toContain('badges');
    expect(source).not.toContain('messageBadgeRow');
    expect(source).not.toContain('messageBadgeText');
  });

  it('keeps work-group children as collapsed header rows on open (desktop two-level expand) with blockId memory', () => {
    const source = readFileSync(resolve(process.cwd(), 'src/session/MessageRenderer.tsx'), 'utf8');
    const renderItemStart = source.indexOf('function RenderItemView');
    const renderItemEnd = source.indexOf('function EmptyMessages', renderItemStart);
    const renderItemSource = source.slice(renderItemStart, renderItemEnd);
    const thinkingStart = source.indexOf('function ThinkingCard');
    const thinkingEnd = source.indexOf('function ToolGroupCard', thinkingStart);
    const thinkingSource = source.slice(thinkingStart, thinkingEnd);
    const workGroupStart = source.indexOf('function WorkGroupCard');
    const workGroupEnd = source.indexOf('function FoldablePanel', workGroupStart);
    const workGroupSource = source.slice(workGroupStart, workGroupEnd);
    const foldableStart = source.indexOf('function FoldablePanel');
    const foldableEnd = source.indexOf('function Rail', foldableStart);
    const foldableSource = source.slice(foldableStart, foldableEnd);

    // 两级展开(对齐桌面 WorkGroupBlock):打开组只显示子卡折叠头,不再有 expandByDefault 一开全展。
    expect(source).not.toContain('expandByDefault');
    expect(workGroupSource).toContain('<RenderItemView key={child.key} item={child} actions={actions} />');
    expect(workGroupSource).toContain('blockId={item.key}');
    // 展开态走共享进程内记忆(blockId = render item key,跨虚拟化重挂/切会话/重分组稳定)。
    expect(foldableSource).toContain('useFoldableExpandedState(blockId, defaultExpanded)');
    expect(thinkingSource).toContain('blockId={item.key}');
    expect(renderItemSource).toContain('<ToolGroupCard item={item} actions={actions} />');
    // 思考卡接收会话流式信号,用于流式实时时长(对齐桌面 500ms tick)。
    expect(renderItemSource).toContain('isSessionStreaming={actions.isSessionStreaming === true}');
  });

  it('does not render user or assistant role labels inside message bubbles', () => {
    const source = readFileSync(resolve(process.cwd(), 'src/session/MessageRenderer.tsx'), 'utf8');
    const sharedSource = readFileSync(resolve(process.cwd(), '../../packages/maker-shared/src/messagePresentation.ts'), 'utf8');
    const bubbleStart = source.indexOf('function MessageBubble');
    const bubbleEnd = source.indexOf('function copyActionLabel', bubbleStart);
    const bubbleSource = source.slice(bubbleStart, bubbleEnd);

    expect(bubbleSource).toContain('summarizeMessageBubblePresentation');
    expect(source).not.toContain('label: item.message.label');
    expect(sharedSource).not.toContain('roleLabel:');
    expect(sharedSource).not.toContain('displayMessageRoleLabel');
    expect(bubbleSource).not.toContain('presentation.roleLabel');
    expect(bubbleSource).not.toContain('message.roleLabel');
    expect(bubbleSource).not.toContain('message.authorLabel');
    expect(bubbleSource).not.toContain('你</Text>');
    expect(bubbleSource).not.toContain('XDMaker</Text>');
  });
});
