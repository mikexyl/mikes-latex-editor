// Where the PDF's pages begin, shown in the editor: a thin "Page 5" rule before the first line that
// lands on a new page (from the last compile's SyncTeX data; see main.ts). Positions follow edits
// until the next compile updates them.
import { StateEffect, StateField, type EditorState, type Range } from '@codemirror/state';
import { Decoration, type DecorationSet, EditorView, WidgetType } from '@codemirror/view';

class PageBreakWidget extends WidgetType {
  constructor(readonly page: number) { super(); }
  eq(o: PageBreakWidget) { return o.page === this.page; }
  toDOM() {
    const d = document.createElement('div');
    d.className = 'vc-page-break';
    const label = document.createElement('span');
    label.textContent = `Page ${this.page}`;
    d.append(label);
    d.title = `Page ${this.page} of the PDF starts about here (as of the last compile)`;
    return d;
  }
  get estimatedHeight() { return 22; }
  ignoreEvent() { return true; }
}

/** Page breaks for this file: [line number, page] where a page begins. */
export const setPageBreaks = StateEffect.define<[number, number][]>();

function build(state: EditorState, breaks: [number, number][]): DecorationSet {
  const ranges: Range<Decoration>[] = [];
  for (const [line, page] of breaks) {
    if (line < 1 || line > state.doc.lines) continue;
    ranges.push(Decoration.widget({ widget: new PageBreakWidget(page), block: true, side: -1 }).range(state.doc.line(line).from));
  }
  return Decoration.set(ranges, true);
}

export const pageBreaks = StateField.define<DecorationSet>({
  create: () => Decoration.none,
  update(value, tr) {
    for (const e of tr.effects) if (e.is(setPageBreaks)) return build(tr.state, e.value);
    return tr.docChanged ? value.map(tr.changes) : value;
  },
  provide: (f) => EditorView.decorations.from(f),
});
