// Compare the open file with an older version (e.g. a git commit): insertions are marked in the
// text, deletions shown as struck-through widgets. Display only; the document is not changed,
// and the overlay follows your edits.
import { StateEffect, StateField, type EditorState, type Range, type Extension } from '@codemirror/state';
import { Decoration, type DecorationSet, EditorView, ViewPlugin, WidgetType } from '@codemirror/view';
import { diffLines, diffWordsWithSpace } from 'diff';
import { visualHiddenRanges } from '../visual/decorations.ts';

export const setCompareBase = StateEffect.define<string | null>();
const recompute = StateEffect.define<null>();

export type DiffStats = { insertions: number; deletions: number };

export function computeDiff(base: string, current: string) {
  const ins: [number, number][] = [];
  const del: { pos: number; text: string }[] = [];
  const parts = diffLines(base, current);
  let pos = 0;
  for (let i = 0; i < parts.length; i++) {
    const p = parts[i];
    const next = parts[i + 1];
    if (!p.added && !p.removed) { pos += p.value.length; continue; }
    if (p.removed && next?.added) {
      // A modified block: diff it word by word so small edits stay small.
      let q = pos;
      for (const w of diffWordsWithSpace(p.value, next.value)) {
        if (w.added) { ins.push([q, q + w.value.length]); q += w.value.length; }
        else if (w.removed) del.push({ pos: q, text: w.value });
        else q += w.value.length;
      }
      pos += next.value.length;
      i++;
      continue;
    }
    if (p.added) { ins.push([pos, pos + p.value.length]); pos += p.value.length; }
    else del.push({ pos, text: p.value });
  }
  return { ins, del };
}

class DeletedWidget extends WidgetType {
  constructor(readonly text: string) { super(); }
  eq(o: DeletedWidget) { return o.text === this.text; }
  toDOM() {
    const s = document.createElement('span');
    s.className = 'df-del';
    const clipped = this.text.length > 400 ? `${this.text.slice(0, 200)} … ${this.text.slice(-150)}` : this.text;
    s.textContent = clipped;
    s.title = `Deleted since the compared version:\n${this.text.slice(0, 2000)}`;
    return s;
  }
  ignoreEvent() { return false; }
}

type Value = { base: string | null; decorations: DecorationSet; stats: DiffStats };

function build(state: EditorState, base: string): Value {
  const { ins, del } = computeDiff(base, state.doc.toString());
  const ranges: Range<Decoration>[] = [];
  for (const [from, to] of ins) if (to > from) ranges.push(Decoration.mark({ class: 'df-ins' }).range(from, to));
  for (const d of del) if (d.text) ranges.push(Decoration.widget({ widget: new DeletedWidget(d.text), side: -1 }).range(d.pos));
  return {
    base,
    decorations: Decoration.set(ranges, true),
    stats: { insertions: ins.length, deletions: del.length },
  };
}

class HiddenChangeWidget extends WidgetType {
  eq() { return true; }
  toDOM() {
    const s = document.createElement('span');
    s.className = 'df-hidden-change';
    s.textContent = '✱';
    s.title = 'Changed inside hidden LaTeX. Switch to Source to see it.';
    return s;
  }
}

/** In visual mode, changes inside hidden source would be invisible: move deletions to the edge
 *  of the hidden range and flag insertions that are entirely hidden. */
function adaptToVisual(state: EditorState, decorations: DecorationSet): DecorationSet {
  const hidden = visualHiddenRanges(state);
  if (!hidden || decorations.size === 0) return decorations;
  const hiddenAround = (from: number, to: number) => {
    let found: { from: number; to: number } | null = null;
    hidden.between(from, to, (hf, ht) => {
      if (hf < ht && hf <= from && to <= ht && (hf < from || to < ht || from === to)) { found = { from: hf, to: ht }; return false; }
    });
    return found as { from: number; to: number } | null;
  };
  const out: Range<Decoration>[] = [];
  const flagged = new Set<number>();
  decorations.between(0, state.doc.length, (from, to, deco) => {
    const h = hiddenAround(from, to);
    if (!h || (from === to && (from === h.from || from === h.to))) { out.push(deco.range(from, to)); return; }
    if (from === to) out.push(Decoration.widget({ widget: deco.spec.widget, side: 1 }).range(h.to));
    else if (!flagged.has(h.to)) {
      flagged.add(h.to);
      out.push(Decoration.widget({ widget: new HiddenChangeWidget(), side: 1 }).range(h.to));
    }
  });
  return Decoration.set(out, true);
}

const empty: Value = { base: null, decorations: Decoration.none, stats: { insertions: 0, deletions: 0 } };

export const compareField = StateField.define<Value>({
  create: () => empty,
  update(value, tr) {
    for (const e of tr.effects) {
      if (e.is(setCompareBase)) return e.value === null ? empty : build(tr.state, e.value);
      if (e.is(recompute) && value.base !== null) return build(tr.state, value.base);
    }
    if (tr.docChanged && value.base !== null) return { ...value, decorations: value.decorations.map(tr.changes) };
    return value;
  },
  provide: (f) => EditorView.decorations.of((view) => adaptToVisual(view.state, view.state.field(f).decorations)),
});

// Recompute the diff shortly after typing stops (mapping keeps it roughly right meanwhile).
const recomputer = ViewPlugin.define((view) => {
  let timer: number | undefined;
  return {
    update(u) {
      if (!u.docChanged || u.state.field(compareField).base === null) return;
      clearTimeout(timer);
      timer = window.setTimeout(() => view.dispatch({ effects: recompute.of(null) }), 300);
    },
    destroy() { clearTimeout(timer); },
  };
});

export const compareExtension: Extension = [compareField, recomputer];
