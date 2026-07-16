import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const chatInputSource = readFileSync(
  resolve(__dirname, '..', 'components', 'new-chat', 'ChatInput.tsx'),
  'utf8',
).replace(/\r\n?/g, '\n');

const sessionViewSource = readFileSync(
  resolve(__dirname, '..', 'features', 'cc-agent', 'CCAgentSessionView.tsx'),
  'utf8',
).replace(/\r\n?/g, '\n');

describe('ChatInput session switch focus contract', () => {
  it('refocuses the editor after storageKey switches only when requested', () => {
    const restoreNextDraftBlock = extractBetween(
      chatInputSource,
      'const restoreNextDraft = () => {',
      'const pendingStopAndSend = voiceInputStopAndSendPromiseRef.current;',
    );

    expect(chatInputSource).toContain('focusOnStorageKeyChange?: boolean;');
    expect(chatInputSource).toContain('focusOnStorageKeyChange = false');
    expect(chatInputSource).toContain('const focusOnStorageKeyChangeRef = useRef(focusOnStorageKeyChange);');
    expect(chatInputSource).toContain('focusOnStorageKeyChangeRef.current = focusOnStorageKeyChange;');
    expect(chatInputSource).toContain('const storageKeyFocusAnchor = document.activeElement;');
    expect(restoreNextDraftBlock).toContain('if (!focusOnStorageKeyChangeRef.current) return;');
    expect(restoreNextDraftBlock).toContain('if (disableAutofocusRef.current || disabledRef.current) return;');
    expect(restoreNextDraftBlock).toContain('if (!isCurrentTransition()) return;');
    expect(restoreNextDraftBlock).toContain('if (hasFocusMovedToInteractiveElement(storageKeyFocusAnchor, editor)) return;');
    expect(restoreNextDraftBlock).toContain("editor.commands.focus('end');");
  });

  it('enables storageKey refocus only for the main routed session view', () => {
    expect(sessionViewSource).toContain('const ownsRoute = !sessionIdProp && !isCompactRail && !isOrcaMode;');
    expect(sessionViewSource).toContain('focusOnStorageKeyChange={ownsRoute}');
  });

  it('guards delayed storageKey focus against stealing from another focused control', () => {
    expect(chatInputSource).toContain('function hasFocusMovedToInteractiveElement(');
    expect(chatInputSource).toContain('if (activeElement === focusAnchor) return false;');
    expect(chatInputSource).toContain('if (editor.view.dom.contains(activeElement)) return false;');
    expect(chatInputSource).toContain('return isInteractiveFocusedElement(activeElement);');
  });
});

function extractBetween(sourceBlock: string, startNeedle: string, endNeedle: string): string {
  const start = sourceBlock.indexOf(startNeedle);
  const end = sourceBlock.indexOf(endNeedle, start);
  expect(start).toBeGreaterThanOrEqual(0);
  expect(end).toBeGreaterThan(start);
  return sourceBlock.slice(start, end);
}
