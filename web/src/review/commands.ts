import type { EditorView } from '@codemirror/view';
import { EditorSelection } from '@codemirror/state';
import { OUTLINE_MACRO, reviewAction } from './model.ts';
import { unsafeAt, unsafeRange, reviewNotice, REASONS } from './track.ts';

export type CommentPrefs = {
  /** What the Comment button inserts: your note macro, or `changes`-package comments. */
  style: 'note' | 'changes';
  /** Author for \note{author}{text}, e.g. your initials. */
  initials: string;
  /** Note macro name without the backslash. */
  macro: string;
};

let prefs: CommentPrefs = { style: 'note', initials: '', macro: 'revnote' };
let onPrefsChange: (p: CommentPrefs) => void = () => {};

export function setCommentPrefs(p: CommentPrefs, onChange?: (p: CommentPrefs) => void) {
  prefs = p;
  if (onChange) onPrefsChange = onChange;
}
export const getCommentPrefs = () => prefs;

const fail = (why: string) => {
  reviewNotice((REASONS[why] ?? why).replace(/tracked|tracking/g, (w) => (w === 'tracked' ? 'commented' : 'commenting')));
  return true;
};

/**
 * Ask for the initials notes are signed with. An in-page dialog, not window.prompt(): the desktop
 * app (Electron) doesn't support prompt(), which returns nothing there. Resolves to the trimmed
 * answer, or null when cancelled.
 */
function askInitials(action = 'Add note'): Promise<string | null> {
  const d = document.createElement('dialog');
  d.className = 'project-dialog initials-dialog';
  d.setAttribute('aria-labelledby', 'initials-dialog-title');
  d.innerHTML = `
    <div class="pd-header"><h2 id="initials-dialog-title">Your initials</h2></div>
    <form class="pd-section" method="dialog">
      <p class="pd-note">Notes and outlines are signed with them, e.g. \\${prefs.macro}{XL}{…}. You can change them later in the review panel.</p>
      <div class="pd-path">
        <input name="initials" type="text" placeholder="XL" spellcheck="false" autocomplete="off" aria-label="Initials" />
      </div>
      <div class="pd-footer">
        <button type="button" value="cancel">Cancel</button>
        <button type="submit" class="primary" value="ok">${action}</button>
      </div>
    </form>`;
  document.body.append(d);
  const input = d.querySelector('input')!;
  return new Promise((resolve) => {
    let answer: string | null = null;
    d.querySelector('form')!.addEventListener('submit', () => { answer = input.value.trim(); });
    d.querySelector('button[value=cancel]')!.addEventListener('click', () => d.close());
    d.addEventListener('click', (e) => { if (e.target === d) d.close(); }); // backdrop
    d.addEventListener('close', () => { d.remove(); resolve(answer); }, { once: true });
    d.showModal();
    input.focus();
  });
}

/**
 * Add a comment at the cursor, with the cursor left inside it ready to type:
 * - note style: \note{XL}{…}, or \note[selection]{XL}{…} around a selection (the text stays in the paper);
 * - changes style: \highlight[comment={…}]{selection}, or \comment{…} without a selection.
 */
export function addComment(view: EditorView): boolean {
  const { state } = view;
  const r = state.selection.main;

  if (prefs.style === 'note') {
    if (!prefs.initials) {
      void askInitials().then((answer) => {
        if (answer === null) { view.focus(); return; }
        prefs = { ...prefs, initials: answer };
        onPrefsChange(prefs);
        if (answer) addComment(view); // asked again next time if left empty
        else view.focus();
      });
      return true;
    }
    // With a selection, the note says what it's about: \note[selected text]{XL}{…}. The text stays
    // in the paper (the macro prints it); `]` inside it needs braces around the whole argument.
    const why = r.empty ? unsafeAt(state, r.to) : unsafeRange(state, r.from, r.to);
    if (why) return fail(why);
    const selected = state.sliceDoc(r.from, r.to);
    const quote = r.empty ? '' : `[${selected.includes(']') ? `{${selected}}` : selected}]`;
    const prefix = `\\${prefs.macro}${quote}{${prefs.initials}}{`;
    view.dispatch({
      changes: { from: r.from, to: r.to, insert: `${prefix}}` },
      selection: EditorSelection.cursor(r.from + prefix.length),
      annotations: reviewAction.of(true),
      userEvent: 'review.comment',
      scrollIntoView: true,
    });
    view.focus();
    return true;
  }

  const why = r.empty ? unsafeAt(state, r.head) : unsafeRange(state, r.from, r.to);
  if (why) return fail(why);
  const prefix = r.empty ? '\\comment{' : '\\highlight[comment={';
  const insert = r.empty ? `${prefix}}` : `${prefix}}]{${state.sliceDoc(r.from, r.to)}}`;
  view.dispatch({
    changes: { from: r.from, to: r.to, insert },
    selection: EditorSelection.cursor(r.from + prefix.length),
    annotations: reviewAction.of(true),
    userEvent: 'review.comment',
    scrollIntoView: true,
  });
  view.focus();
  return true;
}

/**
 * Outline something still to be written: \revoutline{XL}{…} at the cursor, with the cursor inside
 * ready to type what should go there. A selection becomes the outline's text (e.g. notes you typed).
 */
export function addOutline(view: EditorView): boolean {
  const { state } = view;
  const r = state.selection.main;
  if (!prefs.initials) {
    void askInitials('Add outline').then((answer) => {
      if (answer === null) { view.focus(); return; }
      prefs = { ...prefs, initials: answer };
      onPrefsChange(prefs);
      if (answer) addOutline(view);
      else view.focus();
    });
    return true;
  }
  const why = r.empty ? unsafeAt(state, r.to) : unsafeRange(state, r.from, r.to);
  if (why) return fail(why);
  const selected = state.sliceDoc(r.from, r.to);
  const prefix = `\\${OUTLINE_MACRO}{${prefs.initials}}{`;
  view.dispatch({
    changes: { from: r.from, to: r.to, insert: `${prefix}${selected}}` },
    selection: r.empty ? EditorSelection.cursor(r.from + prefix.length) : EditorSelection.range(r.from + prefix.length, r.from + prefix.length + selected.length),
    annotations: reviewAction.of(true),
    userEvent: 'review.outline',
    scrollIntoView: true,
  });
  view.focus();
  return true;
}

/**
 * Suggest an edit to the selection: it becomes \replaced{<new>}{<old>} with the new text selected,
 * so typing replaces it (typing there is your own suggestion, never tracked again).
 */
export function suggestEdit(view: EditorView): boolean {
  const { state } = view;
  const r = state.selection.main;
  if (r.empty) return false;
  const why = unsafeRange(state, r.from, r.to);
  if (why) return fail(why);
  const text = state.sliceDoc(r.from, r.to);
  const start = r.from + '\\replaced{'.length;
  view.dispatch({
    changes: { from: r.from, to: r.to, insert: `\\replaced{${text}}{${text}}` },
    selection: EditorSelection.range(start, start + text.length),
    annotations: reviewAction.of(true),
    userEvent: 'review.suggest',
    scrollIntoView: true,
  });
  view.focus();
  return true;
}

/** Mark the selection as deleted (\deleted{…}), as tracked changes would. */
export function suggestDeletion(view: EditorView): boolean {
  const { state } = view;
  const r = state.selection.main;
  if (r.empty) return false;
  const why = unsafeRange(state, r.from, r.to);
  if (why) return fail(why);
  const insert = `\\deleted{${state.sliceDoc(r.from, r.to)}}`;
  view.dispatch({
    changes: { from: r.from, to: r.to, insert },
    selection: EditorSelection.cursor(r.from + insert.length),
    annotations: reviewAction.of(true),
    userEvent: 'review.delete',
    scrollIntoView: true,
  });
  view.focus();
  return true;
}
