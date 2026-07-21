import { Extension } from '@tiptap/core';
import { Plugin } from '@tiptap/pm/state';
import type { EditorView } from '@tiptap/pm/view';

/** Configuration for the Windows contenteditable selection workaround. */
interface WindowsSelectionReplacementOptions {
  enabled: boolean;
}

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
    event.inputType !== 'insertText' ||
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
  if (view.composing || view.state.selection.empty) return false;
  view.dispatch(view.state.tr.deleteSelection().scrollIntoView());
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
