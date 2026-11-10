// Colors review markup (in both source and visual mode): added text green, deleted text struck
// through in red, highlighted text yellow.
import { StateField, type EditorState, type Range } from '@codemirror/state';
import { Decoration, type DecorationSet, EditorView } from '@codemirror/view';
import { syntaxTree } from '@codemirror/language';
import { findReviewItems, type Arg } from './model.ts';

function build(state: EditorState): DecorationSet {
  const marks: Range<Decoration>[] = [];
  const mark = (a: Arg, cls: string, title = '') => {
    if (a.close > a.open + 1) {
      marks.push(Decoration.mark({ class: cls, attributes: title ? { title } : undefined }).range(a.open + 1, a.close));
    }
  };
  for (const it of findReviewItems(state)) {
    const who = it.author ? ` by ${it.author}` : '';
    if (it.kind === 'added') mark(it.args[0], 'rv-added', `Added${who}`);
    else if (it.kind === 'deleted') mark(it.args[0], 'rv-deleted', `Deleted${who}`);
    else if (it.kind === 'replaced') {
      mark(it.args[0], 'rv-added', `Replacement${who}`);
      mark(it.args[1], 'rv-deleted', `Replaced${who}`);
    } else if (it.kind === 'highlight') mark(it.args[0], 'rv-highlight', it.note);
    else mark(it.args[0], 'rv-comment-text');
  }
  return Decoration.set(marks, true);
}

export const reviewHighlight = StateField.define<{ decorations: DecorationSet; tree: unknown }>({
  create: (state) => ({ decorations: build(state), tree: syntaxTree(state) }),
  update(value, tr) {
    const tree = syntaxTree(tr.state);
    if (tree === value.tree && !tr.docChanged) return value;
    return { decorations: tr.docChanged && tree === value.tree ? value.decorations.map(tr.changes) : build(tr.state), tree };
  },
  provide: (f) => EditorView.decorations.from(f, (v) => v.decorations),
});
