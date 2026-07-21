import { Extension } from '@tiptap/core';
import type { Slice } from '@tiptap/pm/model';
import { Plugin, TextSelection } from '@tiptap/pm/state';
import type { EditorView } from '@tiptap/pm/view';

/** Configuration for the Windows contenteditable selection workaround. */
interface WindowsSelectionReplacementOptions {
  enabled: boolean;
}

interface PendingWindowsCompositionReplacement {
  slice: Slice;
}

const pendingCompositionReplacements = new WeakMap<
  EditorView,
  PendingWindowsCompositionReplacement
>();

/**
 * Replace a selected range through ProseMirror instead of letting Chromium
 * infer the change from its mutated contenteditable DOM.
 *
 * Windows Chromium can report the DOM diff for a selection next to a trailing
 * line break with the caret on the wrong side of the inserted text. Dispatching
 * the equivalent transaction keeps both the document suffix and caret
 * deterministic. Composition input is deliberately excluded and handled by
 * `handleWindowsCompositionStart` without cancelling the native IME lifecycle.
 */
export function handleWindowsSelectedTextInput(
  view: EditorView,
  event: InputEvent,
): boolean {
  const { selection } = view.state;
  if (
    view.composing ||
    event.isComposing ||
    !event.cancelable ||
    (event.inputType !== 'insertText' &&
      event.inputType !== 'insertReplacementText') ||
    event.data == null ||
    event.data.length === 0 ||
    selection.empty
  ) {
    return false;
  }

  event.preventDefault();
  view.dispatch(view.state.tr.insertText(event.data).scrollIntoView());
  return true;
}

/**
 * Collapse a selected range before Windows IME starts mutating the DOM.
 *
 * ProseMirror used to do this for every non-empty selection. Since
 * prosemirror-view 1.39.3 it only does so for selections crossing block
 * boundaries, leaving same-paragraph replacement to Chromium. Some Windows
 * IMEs then widen the observed DOM replacement through the trailing line break
 * and delete the unselected suffix. The chat composer has no text marks, so
 * restoring the old deterministic behavior here has no formatting trade-off.
 * Returning false is essential: ProseMirror must still enter composition mode.
 */
export function handleWindowsCompositionStart(view: EditorView): boolean {
  if (view.composing) return false;
  pendingCompositionReplacements.delete(view);
  const { selection } = view.state;
  if (selection.empty) return false;
  pendingCompositionReplacements.set(view, {
    slice: view.state.doc.slice(selection.from, selection.to),
  });
  view.dispatch(view.state.tr.deleteSelection().scrollIntoView());
  return false;
}

/**
 * Restore a selection when Windows cancels an IME composition with no data.
 *
 * The selection is deleted before composition starts to keep Chromium from
 * widening the DOM diff. A cancelled composition does not provide a native
 * transaction that can undo that deletion, so restore the captured slice and
 * selection explicitly. Successful compositions only clear the pending state.
 */
export function handleWindowsCompositionEnd(
  view: EditorView,
  event: CompositionEvent,
): boolean {
  const pending = pendingCompositionReplacements.get(view);
  if (!pending) return false;
  pendingCompositionReplacements.delete(view);

  if (event.data !== '') return false;

  const { selection } = view.state;
  const transaction = view.state.tr.replaceSelection(pending.slice);
  const restoredFrom = transaction.mapping.map(selection.from, -1);
  const restoredTo = transaction.mapping.map(selection.to, 1);
  if (
    restoredFrom >= 0 &&
    restoredFrom <= restoredTo &&
    restoredTo <= transaction.doc.content.size
  ) {
    transaction.setSelection(
      TextSelection.create(transaction.doc, restoredFrom, restoredTo),
    );
  }
  view.dispatch(transaction.scrollIntoView());
  return false;
}

/** Create the ProseMirror plugin used by the Windows-only Tiptap extension. */
export function createWindowsSelectionReplacementPlugin(): Plugin {
  return new Plugin({
    props: {
      handleDOMEvents: {
        beforeinput: (view, event) =>
          handleWindowsSelectedTextInput(view, event as InputEvent),
        compositionstart: (view) => handleWindowsCompositionStart(view),
        compositionend: (view, event) =>
          handleWindowsCompositionEnd(view, event as CompositionEvent),
      },
    },
  });
}

/**
 * Windows-only selection replacement guard for the plain-text chat composer.
 */
export const WindowsSelectionReplacement = Extension.create<WindowsSelectionReplacementOptions>({
  name: 'windowsSelectionReplacement',

  addOptions() {
    return { enabled: false };
  },

  addProseMirrorPlugins() {
    return this.options.enabled ? [createWindowsSelectionReplacementPlugin()] : [];
  },
});
