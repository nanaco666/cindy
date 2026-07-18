import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { describe, expect, it } from 'vitest';

const source = readFileSync(resolve(__dirname, '..', 'features', 'cc-agent', 'NewMakerDraftRoute.tsx'), 'utf8');
const chatInputSource = readFileSync(resolve(__dirname, '..', 'components', 'new-chat', 'ChatInput.tsx'), 'utf8');
const sendButtonSource = readFileSync(resolve(__dirname, '..', 'components', 'new-chat', 'SendButton.tsx'), 'utf8');
const vendorSwitcherSource = readFileSync(resolve(__dirname, '..', 'components', 'new-chat', 'VendorSegmentedSwitcher.tsx'), 'utf8');
const permissionSelectorSource = readFileSync(resolve(__dirname, '..', 'components', 'new-chat', 'PermissionSelector.tsx'), 'utf8');
const modelSelectorSource = readFileSync(resolve(__dirname, '..', 'components', 'new-chat', 'ModelSelector.tsx'), 'utf8');
const extraDirsButtonSource = readFileSync(resolve(__dirname, '..', 'components', 'new-chat', 'ExtraDirsButton.tsx'), 'utf8');
const colorsSource = readFileSync(resolve(__dirname, '..', 'themes', 'colors.ts'), 'utf8');
const globalsSource = readFileSync(resolve(__dirname, '..', 'styles', 'globals.css'), 'utf8');

describe('NewMakerDraftRoute CREATE AGENT visual contract', () => {
  it('keeps the approved CREATE AGENT shell while preserving the functional composer', () => {
    expect(source).toContain('data-testid="create-agent-shell"');
    expect(source).toContain('data-testid="create-agent-main"');
    expect(source).toContain('data-testid="create-agent-mode-pill"');
    expect(source).toContain('data-testid="create-agent-brand-lockup"');
    expect(source).toContain('data-testid="create-agent-quick-starts"');
    expect(source).toContain('createAgentQuickStarts.map');
    expect(source).toContain('<ChatInput');
    expect(source).toContain('<VendorSegmentedSwitcher');
    expect(source).toContain('middleToolbarSlot={');
    expect(source).not.toContain('<HomeUsageDashboard');
    expect(source).not.toContain('newChat.createAgent.more');
    expect(source).not.toContain('data-testid="create-agent-sidebar"');
    expect(source).not.toContain('<aside');
    expect(source).not.toContain('createAgentSidebarNav');
    expect(source).not.toContain('createAgentSidebarProjects');
    expect(source).not.toContain('<WorktreeChipsRow');
    expect(source).not.toContain('h-2.5 w-2.5 rounded-full');
    expect(source).not.toContain('surface-translucent-sidebar');
    expect(source).not.toContain('agent-island-annie');
    expect(source).toContain('cindy-avatar-lockup.png');
  });

  it('centers the CREATE AGENT content group without reintroducing route chrome', () => {
    expect(source).toContain('items-center justify-start');
    expect(source).toContain('pt-[clamp(96px,25.5vh,268px)]');
    expect(source).toContain('relative flex w-full max-w-[637px] flex-col items-start');
    expect(source).toContain('absolute right-0 top-[22px]');
  });

  it('preserves New Maker behavior-critical props on ChatInput', () => {
    const chatInputIndex = source.indexOf('<ChatInput');
    expect(chatInputIndex).toBeGreaterThan(-1);
    const chatInputBlock = source.slice(chatInputIndex, source.indexOf('<NewGoalDialog', chatInputIndex));

    for (const invariant of [
      'onSend={handleSend}',
      'onBeforeVoiceInputStart={handleBeforeVoiceInputStart}',
      'externalDragOver={pageDragOver}',
      'sessionId={undefined}',
      'initialWorkingDir={effectiveWorkingDir}',
      'remoteHostId={draft.remoteHostId ?? null}',
      'deviceLinkDeviceId={effectiveDeviceLinkDeviceId}',
      'modelMemoryOverride={deviceLinkDraftMemory}',
      'initialModel={draftInitialModel}',
      'initialEffort={draftInitialEffort}',
      'initialPermissionMode={chatInitialPermissionMode}',
      'initialProviderId={chatInitialProviderId}',
      'planModeEnabled={effectivePlanMode}',
      'fastMode={effectiveFastMode}',
      'onWorkingDirChange={handleWorkingDirChange}',
      'onModelDidChange={handleModelDidChange}',
      'onEffortDidChange={handleEffortDidChange}',
      'onPermissionModeDidChange={handlePermissionModeDidChange}',
      'onProviderDidChange={handleProviderDidChange}',
      'vendorKey={draft.vendor ===',
      'attachmentState={attachmentState}',
      'draftKey={NEW_MAKER_DRAFT_KEY}',
      'extraDirs={effectiveExtraDirs}',
      'onExtraDirsChange={handleExtraDirsChange}',
      'onNewGoal={(text) =>',
      'rememberedEffortByModel={isDeviceLinkDraft ? undefined : draft.effortByModel}',
      'onRememberedEffortChange={',
      'isDeviceLinkDraft ? undefined : handleRememberedEffortChange',
      'placeholder="Hi Cindy!"',
      'middleToolbarSlot={',
    ]) {
      expect(chatInputBlock).toContain(invariant);
    }
  });

  it('uses the R2 quick-start icon mapping and avoids page-level shadows', () => {
    expect(source).toContain('SearchCode');
    expect(source).toContain('Code2');
    expect(source).toContain('MessageSquareCode');
    expect(source).toContain('Hammer');
    expect(source).not.toContain('shadow-[');
    expect(source).not.toContain('boxShadow');
  });

  it('uses exact CREATE AGENT quick-start and avatar tokens from the Figma slices', () => {
    expect(source).toContain('border-[var(--create-agent-avatar-ring)]');
    expect(source).toContain('bg-[var(--create-agent-avatar-glass-bg)]');
    expect(source).toContain('var(--create-agent-avatar-inner-ring-start)');
    expect(source).toContain('var(--create-agent-avatar-inner-ring-end)');
    expect(source).toContain('WebkitMaskComposite');
    expect(source).toContain('h-[44.55px] w-[44.55px]');
    expect(source).toContain('bg-[var(--create-agent-quick-card-bg)]');
    expect(source).toContain('border-[var(--create-agent-quick-card-border)]');
    expect(source).toContain('text-[var(--create-agent-quick-card-text)]');
    expect(source).toContain('bg-[var(--create-agent-quick-card-icon-bg)]');
    expect(source).toContain('text-[var(--create-agent-quick-card-icon)]');

    expect(colorsSource).toContain("'create-agent-quick-card-icon-bg'");
    expect(colorsSource).toContain("light: '#EDEDED'");
    expect(colorsSource).toContain("dark: '#2A2828'");
    expect(colorsSource).toContain("'create-agent-avatar-ring'");
    expect(colorsSource).toContain("'create-agent-avatar-glass-bg'");
    expect(colorsSource).toContain("'create-agent-avatar-inner-ring-start'");
    expect(colorsSource).toContain("'create-agent-avatar-inner-ring-end'");
  });

  it('keeps global sidebar chrome out of the route body', () => {
    expect(source).not.toContain('TODO-E4D');
    expect(source).not.toContain('cindy-avatar-account.png');
  });

  it('uses CREATE AGENT private tokens for composer controls', () => {
    expect(source).toContain('border-[var(--create-agent-control-border)]');
    expect(source).toContain('bg-[var(--create-agent-control-bg)]');
    expect(source).toContain('text-[var(--create-agent-control-text)]');
    expect(source).toContain('text-[var(--create-agent-control-icon)]');
    expect(source).toContain('visualVariant="create-agent"');

    expect(chatInputSource).toContain("visualVariant={isCreateAgentVariant ? 'create-agent' : 'default'}");
    expect(chatInputSource).toContain('focus-within:border-[var(--create-agent-focus-ring)]');
    expect(chatInputSource).toContain("'min-w-0 flex-nowrap justify-between gap-2 overflow-hidden'");
    const permissionSelectorIndex = chatInputSource.indexOf('<PermissionSelector');
    const middleToolbarSlotIndex = chatInputSource.indexOf('{middleToolbarSlot}');
    const modelSelectorIndex = chatInputSource.indexOf('<ModelSelector');
    expect(middleToolbarSlotIndex).toBeGreaterThan(permissionSelectorIndex);
    expect(middleToolbarSlotIndex).toBeLessThan(modelSelectorIndex);

    expect(sendButtonSource).toContain('bg-[var(--create-agent-send-bg)]');
    expect(sendButtonSource).toContain('text-[var(--create-agent-send-icon)]');
    expect(sendButtonSource).not.toContain('create-agent-send-border');
    expect(sendButtonSource).toContain('hover:bg-[var(--create-agent-send-bg-hover)]');
    expect(sendButtonSource).toContain('active:bg-[var(--create-agent-send-bg-pressed)]');
    expect(sendButtonSource).toContain('bg-[var(--create-agent-send-icon)]');
    expect(sendButtonSource).toContain('function CreateAgentSendIcon');
    expect(sendButtonSource).toContain('fill="currentColor"');
    expect(sendButtonSource).toContain("'cursor-not-allowed bg-[var(--create-agent-send-bg)] text-[var(--create-agent-send-icon)] opacity-40'");
    expect(sendButtonSource).not.toContain('bg-[var(--create-agent-send-disabled-bg)]');
    expect(sendButtonSource).not.toContain('text-[var(--create-agent-send-disabled-icon)]');

    expect(vendorSwitcherSource).toContain('bg-[var(--create-agent-segment-track-bg)]');
    expect(vendorSwitcherSource).toContain('text-[var(--create-agent-segment-inactive-text)]');
    expect(vendorSwitcherSource).toContain('border-[var(--create-agent-control-border)]');

    expect(permissionSelectorSource).toContain('border-[var(--create-agent-control-border)]');
    expect(permissionSelectorSource).toContain('min-w-[52px] max-w-full shrink');
    expect(permissionSelectorSource).toContain("'truncate'");
    expect(modelSelectorSource).toContain('border-[var(--create-agent-control-border)]');
    expect(modelSelectorSource).toContain('min-w-[72px] max-w-full shrink overflow-hidden');
    expect(modelSelectorSource).not.toContain('w-[206px] min-w-[160px] max-w-[206px] shrink');
    expect(modelSelectorSource).not.toContain('max-w-[180px] truncate');

    expect(colorsSource).toContain("'create-agent-send-bg'");
    expect(colorsSource).toContain("light: '#3C3F43'");
    expect(colorsSource).toContain("dark: '#EEEEEE'");
    expect(colorsSource).toContain("'create-agent-send-icon'");
    expect(colorsSource).toContain("light: '#FCFCFC'");
    expect(colorsSource).not.toContain("'create-agent-send-border'");
    expect(colorsSource).toContain("'create-agent-send-bg-hover'");
    expect(colorsSource).toContain("light: '#2E3237'");
    expect(colorsSource).toContain("dark: '#E2E2E2'");
    expect(colorsSource).toContain("'create-agent-send-bg-pressed'");
    expect(colorsSource).toContain("light: '#25282C'");
    expect(colorsSource).toContain("dark: '#D4D4D4'");
    expect(colorsSource).toContain("'create-agent-send-disabled-bg'");
    expect(colorsSource).toContain("dark: '#444242'");
    expect(colorsSource).toContain("'create-agent-send-disabled-icon'");
    expect(colorsSource).toContain("dark: '#585555'");
    expect(colorsSource).toContain("'create-agent-segment-inactive-text'");
    expect(colorsSource).toContain("light: '#9A9DA3'");
    expect(colorsSource).toContain("dark: '#6F6F6F'");
    expect(colorsSource).toContain("'create-agent-control-border'");
    expect(colorsSource).toContain("light: '#DCDFE3'");
    expect(colorsSource).toContain("dark: '#434343'");
    expect(colorsSource).toContain("'create-agent-control-icon'");
    expect(colorsSource).toContain("light: '#3C3F43'");

    expect(chatInputSource).toContain("'min-w-0 flex-nowrap justify-between gap-2 overflow-hidden'");
    expect(chatInputSource).toContain("'min-w-0 flex-nowrap justify-between gap-1 overflow-hidden'");
    expect(chatInputSource).toContain("'flex min-w-0 shrink items-center gap-2'");
    expect(chatInputSource).toContain("'flex min-w-0 shrink items-center justify-end gap-2'");
    expect(chatInputSource).toContain("'flex min-w-0 shrink items-center gap-1'");
    expect(chatInputSource).toContain("'flex min-w-0 shrink items-center justify-end gap-1'");
    expect(chatInputSource).not.toContain("'contents'");
    expect(chatInputSource).not.toContain("grid-cols-[minmax(0,max-content)_minmax(0,1fr)]");
    expect(chatInputSource).not.toContain("isCreateAgentVariant ? 'flex-wrap gap-2' : 'min-w-0 gap-1'");
    expect(chatInputSource).not.toContain("'flex min-w-0 flex-1 flex-wrap items-center justify-end gap-2'");
    expect(source).toContain('className="shrink-0"');
    expect(extraDirsButtonSource).toContain("'flex shrink-0 items-center rounded-full transition-colors'");
    expect(permissionSelectorSource).toContain("'h-[30px] min-w-[52px] max-w-full shrink");
    expect(permissionSelectorSource).not.toContain("'h-[30px] min-w-[90px] max-w-none shrink-0");
    expect(permissionSelectorSource).not.toContain("'h-[30px] min-w-[72px] max-w-full shrink border border-[var(--create-agent-control-border)]");
    expect(permissionSelectorSource).not.toContain("'h-[30px] min-w-max shrink-0 px-2.5");
    expect(sendButtonSource).toContain("'flex shrink-0 items-center justify-center transition-colors'");
    expect(modelSelectorSource).toContain("'h-[30px] min-w-[72px] max-w-full shrink overflow-hidden");
    expect(modelSelectorSource).not.toContain("'h-[30px] min-w-max shrink-0");
    expect(modelSelectorSource).not.toContain("'h-[30px] w-[206px] min-w-[160px] max-w-[206px]");
    expect(modelSelectorSource).toContain("? 'truncate'");
    expect(modelSelectorSource).toContain("? 'truncate'");
    expect(modelSelectorSource).toContain('<ChevronDown');
    expect(modelSelectorSource).toContain("'shrink-0'");
    expect(chatInputSource).toContain("className={isCreateAgentVariant ? 'ml-[7px]' : undefined}");
  });

  it('uses the CINDY brand accent for editable carets', () => {
    expect(globalsSource).toContain('caret-color: var(--caret-accent);');
    expect(globalsSource).toContain('.cm-editor .cm-cursor');
    expect(globalsSource).toContain('border-left-color: var(--caret-accent) !important;');
    expect(colorsSource).toContain("'caret-accent'");
    expect(colorsSource).toContain('CINDY overrides to focus blue #417CDD per user decision 2026-07-18');
  });

  it('keeps default composer send buttons aligned with the neutral inverse rule', () => {
    expect(sendButtonSource).toContain('bg-[var(--send-btn-bg)] text-[var(--send-btn-icon)]');
    expect(sendButtonSource).toContain('hover:bg-[var(--send-btn-hover-bg)]');
    expect(sendButtonSource).toContain('active:bg-[var(--send-btn-pressed-bg)]');
    expect(sendButtonSource).toContain('bg-[var(--send-btn-icon)]');
    expect(sendButtonSource).toContain("'cursor-not-allowed bg-[var(--send-btn-bg)] text-[var(--send-btn-icon)] opacity-40'");
    expect(sendButtonSource).not.toContain('stop-btn-bg');
    expect(sendButtonSource).not.toContain('stop-btn-icon');
    expect(sendButtonSource).not.toContain('hover:opacity-85');
    expect(sendButtonSource).not.toContain('rounded-[8px]');
    expect(sendButtonSource).not.toContain('bg-[var(--send-btn-disabled-bg)] text-[var(--send-btn-disabled-icon)]');

    expect(colorsSource).toContain("'send-btn-bg'");
    expect(colorsSource).toContain("light: '#3C3F43'");
    expect(colorsSource).toContain("dark: '#EEEEEE'");
    expect(colorsSource).toContain("'send-btn-icon'");
    expect(colorsSource).toContain("light: '#FCFCFC'");
    expect(colorsSource).toContain("dark: '#252222'");
    expect(colorsSource).not.toContain("'stop-btn-bg'");
    expect(colorsSource).not.toContain("'stop-btn-icon'");
  });

  it('does not own global sidebar glass or selected-state tokens', () => {
    expect(colorsSource).not.toContain("'sidebar-glass-bg'");
    expect(colorsSource).not.toContain("'sidebar-glass-overlay-linear'");
    expect(colorsSource).not.toContain("'sidebar-glass-overlay-radial'");
    expect(colorsSource).not.toContain("'sidebar-item-active-border'");
    expect(colorsSource).not.toContain("'sidebar-item-active-text'");
  });
});
