import { describe, expect, it, vi } from 'vitest';
import { Schema } from '@tiptap/pm/model';
import { EditorState, TextSelection, type Transaction } from '@tiptap/pm/state';
import type { EditorView } from '@tiptap/pm/view';

import {
  handleWindowsCompositionStart,
  handleWindowsSelectedTextInput,
} from '../components/new-chat/WindowsSelectionReplacement';

const schema = new Schema({
  nodes: {
    doc: { content: 'paragraph+' },
    paragraph: { content: 'inline*' },
    text: { group: 'inline' },
    hardBreak: { inline: true, group: 'inline' },
  },
});

/** Minimal mutable EditorView facade for exercising DOM-event transactions. */
function makeView(state: EditorState, composing = false) {
  let current = state;
  const view = {
    get state() {
      return current;
    },
    composing,
    dispatch(transaction: Transaction) {
      current = current.apply(transaction);
    },
  } as unknown as EditorView;
  return { view, getState: () => current };
}

function selectedPrefixState(trailingKind: 'hardBreak' | 'emptyParagraph'): EditorState {
  const text = schema.text('GPT5.5啊啊啊啊');
  const firstParagraph = schema.nodes.paragraph.create(
    null,
    trailingKind === 'hardBreak' ? [text, schema.nodes.hardBreak.create()] : [text],
  );
  const paragraphs = trailingKind === 'emptyParagraph'
    ? [firstParagraph, schema.nodes.paragraph.create()]
    : [firstParagraph];
  const doc = schema.nodes.doc.create(null, paragraphs);
  const state = EditorState.create({ schema, doc });
  return state.apply(state.tr.setSelection(TextSelection.create(doc, 1, 7)));
}

function documentText(state: EditorState): string {
  return state.doc.textBetween(0, state.doc.content.size, '\n', '\n');
}

function inputEvent(data: string) {
  return {
    cancelable: true,
    data,
    inputType: 'insertText',
    isComposing: false,
    preventDefault: vi.fn(),
  } as unknown as InputEvent;
}

describe('Windows chat composer selection replacement', () => {
  it.each(['hardBreak', 'emptyParagraph'] as const)(
    'replaces a selected prefix before a trailing %s and leaves the caret after the new text',
    (trailingKind) => {
      const { view, getState } = makeView(selectedPrefixState(trailingKind));
      const event = inputEvent('K');

      expect(handleWindowsSelectedTextInput(view, event)).toBe(true);

      const state = getState();
      expect(event.preventDefault).toHaveBeenCalledOnce();
      expect(documentText(state)).toBe('K啊啊啊啊\n');
      expect(state.selection.empty).toBe(true);
      expect(state.selection.from).toBe(2);
    },
  );

  it('collapses the selected range before IME composition without deleting the suffix', () => {
    const { view, getState } = makeView(selectedPrefixState('hardBreak'));

    expect(handleWindowsCompositionStart(view)).toBe(false);

    const collapsed = getState();
    expect(documentText(collapsed)).toBe('啊啊啊啊\n');
    expect(collapsed.selection.empty).toBe(true);
    expect(collapsed.selection.from).toBe(1);

    // Simulate the IME's first committed character at the collapsed caret.
    view.dispatch(collapsed.tr.insertText('你'));
    expect(documentText(getState())).toBe('你啊啊啊啊\n');
    expect(getState().selection.from).toBe(2);
  });

  it('leaves native input alone when there is no replaceable selection', () => {
    const selected = selectedPrefixState('hardBreak');
    const collapsed = selected.apply(
      selected.tr.setSelection(TextSelection.create(selected.doc, 1)),
    );
    const { view, getState } = makeView(collapsed);
    const event = inputEvent('K');

    expect(handleWindowsSelectedTextInput(view, event)).toBe(false);
    expect(event.preventDefault).not.toHaveBeenCalled();
    expect(getState()).toBe(collapsed);
  });

  it('does not intercept composition text in beforeinput', () => {
    const { view } = makeView(selectedPrefixState('hardBreak'), true);
    const event = inputEvent('n');

    expect(handleWindowsSelectedTextInput(view, event)).toBe(false);
    expect(event.preventDefault).not.toHaveBeenCalled();
  });
});
