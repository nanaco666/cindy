import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const rendererRoot = path.resolve(__dirname, '..');
const read = (relativePath: string) => fs.readFileSync(path.join(rendererRoot, relativePath), 'utf8');

const chatInput = read('components/new-chat/ChatInput.tsx');
const modelSelector = read('components/new-chat/ModelSelector.tsx');
const permissionSelector = read('components/new-chat/PermissionSelector.tsx');
const extraDirsButton = read('components/new-chat/ExtraDirsButton.tsx');
const settingsModel = read('components/settings/ImDefaultSettingsSection.tsx');
const subagentModel = read('components/settings/SubagentModelSection.tsx');
const createWorker = read('features/cc-agent/CreateWorkerPopover.tsx');

describe('composer morph scope', () => {
  it('opts in only from the normal ChatInput toolbar', () => {
    expect(chatInput.match(/useMorphPopover=\{!isCreateAgentVariant\}/g)).toHaveLength(3);
    expect(settingsModel).not.toContain('useMorphPopover');
    expect(subagentModel).not.toContain('useMorphPopover');
    expect(createWorker).not.toContain('useMorphPopover');
  });

  it('keeps every shared selector on Radix by default', () => {
    expect(modelSelector).toContain('useMorphPopover = false');
    expect(modelSelector).toContain('<PopoverTrigger asChild>{trigger}</PopoverTrigger>');
    expect(permissionSelector).toContain('useMorphPopover = false');
    expect(permissionSelector).toContain('<PopoverTrigger asChild>{trigger}</PopoverTrigger>');
    expect(extraDirsButton).toContain('useMorphPopover = false');
    expect(extraDirsButton).toContain('<PopoverTrigger asChild>{trigger}</PopoverTrigger>');
  });

  it('keeps Create Agent controls fixed-size and cleans up the voice timer', () => {
    expect(chatInput).toContain('const expandable = !isCreateAgentVariant;');
    expect(chatInput).toContain('return () => window.clearInterval(id);');
    expect(chatInput).toContain("isCreateAgentVariant ? (");
  });
});
