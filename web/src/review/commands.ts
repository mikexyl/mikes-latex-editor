import type { EditorView } from '@codemirror/view';
import { EditorSelection } from '@codemirror/state';
import { reviewAction } from './model.ts';
import { unsafeAt, unsafeRange, reviewNotice, REASONS } from './track.ts';

export type CommentPrefs = {
  /** What the Comment button inserts: your note macro, or `changes`-package comments. */
  style: 'note' | 'changes';
  /** Author for \note{author}{text}, e.g. your initials. */
  initials: string;
  /** Note macro name without the backslash. */
  macro: string;
};

let prefs: CommentPrefs = { style: 'note', initials: '', macro: 'note' };
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
 * Add a comment at the cursor, with the cursor left inside it ready to type:
 * - note style: \note{XL}{…}, after the selection if there is one (the text stays as it is);
 * - changes style: \highlight[comment={…}]{selection}, or \comment{…} without a selection.
 */
export function addComment(view: EditorView): boolean {
  const { state } = view;
  const r = state.selection.main;

  if (prefs.style === 'note') {
    if (!prefs.initials) {
      const answer = window.prompt('Your initials for notes, e.g. XL:', '');
      if (answer === null) return true;
      prefs = { ...prefs, initials: answer.trim() };
      onPrefsChange(prefs);
    }
    const why = unsafeAt(state, r.to);
    if (why) return fail(why);
    const prefix = `\\${prefs.macro}{${prefs.initials}}{`;
    view.dispatch({
      changes: { from: r.to, insert: `${prefix}}` },
      selection: EditorSelection.cursor(r.to + prefix.length),
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
