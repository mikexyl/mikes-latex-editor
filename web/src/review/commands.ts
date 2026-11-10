import type { EditorView } from '@codemirror/view';
import { EditorSelection } from '@codemirror/state';
import { reviewAction } from './model.ts';
import { unsafeAt, unsafeRange, reviewNotice, REASONS } from './track.ts';

/**
 * Add a comment: on a selection, \highlight[comment={…}]{selection}; otherwise \comment{…}.
 * The cursor lands inside the comment text, ready to type.
 */
export function addComment(view: EditorView): boolean {
  const { state } = view;
  const r = state.selection.main;
  const why = r.empty ? unsafeAt(state, r.head) : unsafeRange(state, r.from, r.to);
  if (why) {
    reviewNotice((REASONS[why] ?? why).replace(/tracked|tracking/g, (w) => (w === 'tracked' ? 'commented' : 'commenting')));
    return true;
  }
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
