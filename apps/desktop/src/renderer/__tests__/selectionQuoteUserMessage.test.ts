import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it, vi } from 'vitest';

import { selectionIntersectsFloatingQuoteDisabledArea } from '../components/chat/SelectionQuoteButton';

const userMessageSource = readFileSync(
  resolve(__dirname, '..', 'components', 'chat', 'UserMessage.tsx'),
  'utf8',
);

describe('SelectionQuoteButton — user message floating action exclusion', () => {
  it('marks the whole user message as opted out of the floating action', () => {
    expect(userMessageSource).toContain('data-selection-floating-quote-disabled=""');
  });

  it('keeps right-click Add to chat enabled while suppressing the floating button', () => {
    const buttonSource = readFileSync(
      resolve(__dirname, '..', 'components', 'chat', 'SelectionQuoteButton.tsx'),
      'utf8',
    );
    expect(buttonSource).toContain("container.dataset.selectionQuoteContext = '';");
    expect(buttonSource).toContain('readSelectionInStream(true)');
    expect(buttonSource).toContain('!allowQuoteDisabled && selectionIntersectsFloatingQuoteDisabledArea');
  });

  it('keeps the floating action at its intrinsic width near either viewport edge', () => {
    const buttonSource = readFileSync(
      resolve(__dirname, '..', 'components', 'chat', 'SelectionQuoteButton.tsx'),
      'utf8',
    );

    expect(buttonSource).toContain('w-max');
    expect(buttonSource).toContain('whitespace-nowrap');
    expect(buttonSource).toContain('const BUTTON_MIN_X_PX = 100;');
    expect(buttonSource).toContain('const BUTTON_RIGHT_MARGIN_PX = 100;');
  });

  it('rejects a selection intersecting any copy-only region', () => {
    const allowed = {} as Element;
    const disabled = {} as Element;
    const range = {
      intersectsNode: vi.fn((node: Node) => node === disabled),
    };
    const container = {
      querySelectorAll: vi.fn(() => [allowed, disabled]),
    };

    expect(selectionIntersectsFloatingQuoteDisabledArea(
      range as Pick<Range, 'intersectsNode'>,
      container as unknown as Pick<HTMLElement, 'querySelectorAll'>,
    )).toBe(true);
    expect(range.intersectsNode).toHaveBeenCalledTimes(2);
  });

  it('keeps assistant/file selections eligible when no copy-only region intersects', () => {
    const range = { intersectsNode: vi.fn(() => false) };
    const container = { querySelectorAll: vi.fn(() => [{} as Element]) };

    expect(selectionIntersectsFloatingQuoteDisabledArea(
      range as Pick<Range, 'intersectsNode'>,
      container as unknown as Pick<HTMLElement, 'querySelectorAll'>,
    )).toBe(false);
  });
});
