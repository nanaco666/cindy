import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { describe, expect, it } from 'vitest';

const sidebarDir = resolve(__dirname, '..');
const sessionCardSource = readFileSync(resolve(sidebarDir, 'SessionCard.tsx'), 'utf8');
const globalsSource = readFileSync(resolve(__dirname, '..', '..', '..', '..', 'styles', 'globals.css'), 'utf8');

describe('SessionCard review regressions', () => {
  it('keeps awaiting text in list mode previews', () => {
    expect(sessionCardSource).toContain('const listPreview = awaitingText ?? runningDetail ?? summaryPreview');
    expect(sessionCardSource).toContain('{listPreview}');
  });

  it('keeps status breathing covered by reduced motion', () => {
    expect(globalsSource).toMatch(
      /@media \(prefers-reduced-motion: reduce\) \{[\s\S]*\.session-status-breathing,[\s\S]*animation: none(?: !important)?;/,
    );
  });

  it('keeps card titles to two lines with shared inline prefix alignment', () => {
    expect(sessionCardSource).toContain('[-webkit-line-clamp:2] overflow-hidden');
    expect(sessionCardSource).toContain('style={{ textIndent: 0, paddingLeft: 0 }}');
    expect(sessionCardSource).toContain('const titlePrefixNode = (');
    expect(sessionCardSource).toContain('{titlePrefixNode}');
    expect(sessionCardSource).toContain('CARD_TITLE_STATUS_SLOT_CLASS');
    expect(sessionCardSource).not.toContain('titlePrefixWidth');
  });

  it('keeps card preview line budgets stable across content sources', () => {
    expect(sessionCardSource).toContain(
      'const cardPreviewLineClamp = session.summary ? 3 : isRunning ? 2 : isAutomationGenerated ? 1 : 2',
    );
    expect(sessionCardSource).toContain('style={{ WebkitLineClamp: cardPreviewLineClamp }}');
  });

  it('keeps Dash icon precedence for scheduled and automation sessions', () => {
    expect(sessionCardSource).toContain('const showScheduleBindingBadge = boundSchedules.length > 0');
    expect(sessionCardSource).toContain('const showAutomationClock = !showScheduleBindingBadge && isAutomationGenerated');
    // Timer(schedule 绑定)优先于自动化 Clock 的判定收敛在 renderAutomationMeta,
    // list 标题前缀(10px)与 card 底部 meta 行(11px)共用同一份优先级逻辑。
    expect(sessionCardSource).toMatch(
      /const renderAutomationMeta = \(iconSize: number\) =>[\s\S]*?showScheduleBindingBadge \? \([\s\S]*?<ScheduleBindingBadge schedules=\{boundSchedules\} size=\{iconSize\} \/>[\s\S]*?\) : showAutomationClock \? \([\s\S]*?<Clock size=\{iconSize\}/,
    );
    expect(sessionCardSource).toContain('{renderAutomationMeta(10)}');
    expect(sessionCardSource).toContain('{renderAutomationMeta(11)}');
  });

  it('keeps running cards free of the removed progress bar', () => {
    // 黄一孟 review:Running 卡片不再渲染扫动进度条(w-[52px] 一并移除)。
    expect(sessionCardSource).not.toContain('w-[52px]');
    expect(sessionCardSource).not.toContain('session-card-progress');
  });

  it('keeps card time anchored to the bottom meta row instead of the overlay layout', () => {
    // 时间固定在底部 meta 行右端(ml-auto),不再依赖 overlay/block 双态测量。
    expect(sessionCardSource).not.toContain('cardTimeLayout');
    expect(sessionCardSource).toContain('{cardTimeText}');
    expect(sessionCardSource).toContain('ml-auto shrink-0'); // E1D 侧栏层级:time 色 conditional via cn,ml-auto shrink-0 保留
  });

  it('keeps running card previews stable instead of streaming compact activity text', () => {
    expect(sessionCardSource).toContain('const listPreview = awaitingText ?? runningDetail ?? summaryPreview');
    expect(sessionCardSource).toContain('const cardPreview = awaitingText ?? summaryPreview');
    expect(sessionCardSource).not.toContain('const cardPreview = awaitingText ?? runningDetail ?? summaryPreview');
  });

  it('lets single-line card content keep its natural compact height', () => {
    expect(sessionCardSource).toContain("'rounded-xl bg-[var(--surface-elevated)] border'");
    expect(sessionCardSource).not.toContain("'h-full rounded-xl bg-[var(--surface-elevated)] border'");
  });

  it('E1D 任务C: SessionCard active 反白链收全(title/time/RemoteProjectIcon 全切 sidebar-item-active-foreground)', () => {
    // 阿梅 SIDEBAR-R 打回:SessionCard 漏网(title 700 + RemoteProjectIcon 556/735/753/941)未切反白,现收全
    const re = /isActive \? 'text-sidebar-item-active-foreground'/g;
    const count = (sessionCardSource.match(re) || []).length;
    expect(count, 'isActive conditional active-foreground ≥7(title×2+time+RemoteProjectIcon×4)').toBeGreaterThanOrEqual(7);
    expect(sessionCardSource).toContain("isActive ? 'text-sidebar-item-active-foreground' : isMuted ? 'text-[var(--text-disabled)]' : 'text-[var(--text-tertiary)]'");
  });
});
