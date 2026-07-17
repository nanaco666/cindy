import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { describe, expect, it } from 'vitest';

const source = readFileSync(
  resolve(__dirname, '..', 'features', 'cc-agent', 'NewMakerDraftRoute.tsx'),
  'utf8',
);
const chatInputSource = readFileSync(
  resolve(__dirname, '..', 'components', 'new-chat', 'ChatInput.tsx'),
  'utf8',
);
const sendButtonSource = readFileSync(
  resolve(__dirname, '..', 'components', 'new-chat', 'SendButton.tsx'),
  'utf8',
);
const vendorSwitcherSource = readFileSync(
  resolve(__dirname, '..', 'components', 'new-chat', 'VendorSegmentedSwitcher.tsx'),
  'utf8',
);
const permissionSelectorSource = readFileSync(
  resolve(__dirname, '..', 'components', 'new-chat', 'PermissionSelector.tsx'),
  'utf8',
);
const modelSelectorSource = readFileSync(
  resolve(__dirname, '..', 'components', 'new-chat', 'ModelSelector.tsx'),
  'utf8',
);
const colorsSource = readFileSync(
  resolve(__dirname, '..', 'themes', 'colors.ts'),
  'utf8',
);

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

  it('preserves New Maker behavior-critical props on ChatInput', () => {
    const chatInputIndex = source.indexOf('<ChatInput');
    expect(chatInputIndex).toBeGreaterThan(-1);
    const chatInputBlock = source.slice(
      chatInputIndex,
      source.indexOf('<NewGoalDialog', chatInputIndex),
    );

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
      'onRememberedEffortChange={isDeviceLinkDraft ? undefined : handleRememberedEffortChange}',
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

    expect(sendButtonSource).toContain('bg-[var(--create-agent-send-bg)]');
    expect(sendButtonSource).toContain('text-[var(--create-agent-send-icon)]');
    expect(sendButtonSource).toContain('hover:bg-[var(--create-agent-send-bg-hover)]');

    expect(vendorSwitcherSource).toContain('bg-[var(--create-agent-segment-track-bg)]');
    expect(vendorSwitcherSource).toContain('text-[var(--create-agent-segment-inactive-text)]');
    expect(vendorSwitcherSource).toContain('border-[var(--create-agent-control-border)]');

    expect(permissionSelectorSource).toContain('border-[var(--create-agent-control-border)]');
    expect(modelSelectorSource).toContain('border-[var(--create-agent-control-border)]');

    expect(colorsSource).toContain("registerColor('create-agent-send-bg'");
    expect(colorsSource).toContain("light: '#3C3F43'");
    expect(colorsSource).toContain("dark: '#EEEEEE'");
    expect(colorsSource).toContain("registerColor('create-agent-send-icon'");
    expect(colorsSource).toContain("light: '#FCFCFC'");
    expect(colorsSource).toContain("registerColor('create-agent-segment-inactive-text'");
    expect(colorsSource).toContain("light: '#9A9DA3'");
    expect(colorsSource).toContain("dark: '#6F6F6F'");
    expect(colorsSource).toContain("registerColor('create-agent-control-border'");
    expect(colorsSource).toContain("light: '#DCDFE3'");
    expect(colorsSource).toContain("dark: '#434343'");
    expect(colorsSource).toContain("registerColor('create-agent-control-icon'");
    expect(colorsSource).toContain("light: '#3C3F43'");
  });
});
