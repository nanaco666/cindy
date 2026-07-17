import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { describe, expect, it } from 'vitest';

const source = readFileSync(
  resolve(__dirname, '..', 'features', 'cc-agent', 'NewMakerDraftRoute.tsx'),
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
    expect(source).toContain('[--send-btn-bg:#3C3F43]');
    expect(source).toContain('dark:[--send-btn-bg:#EEEEEE]');
    expect(source).not.toContain('shadow-[');
    expect(source).not.toContain('boxShadow');
  });

  it('keeps global sidebar chrome out of the route body', () => {
    expect(source).not.toContain('TODO-E4D');
    expect(source).not.toContain('cindy-avatar-account.png');
  });
});
