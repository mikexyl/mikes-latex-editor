// Review markup in the source, using the `changes` package syntax so files stay compatible:
//   \added[id=..]{new}   \deleted{old}   \replaced{new}{old}
//   \highlight[comment={note}]{text}   \comment{note}
// plus your own note macro, by default \note{author}{text} (e.g. defined as
// \newcommand{\note}[2]{\textcolor{red}{[#1: #2]}}), which also prints in the PDF.
import { Annotation, Facet, type EditorState, type TransactionSpec } from '@codemirror/state';
import { syntaxTree } from '@codemirror/language';
import type { SyntaxNode } from '@lezer/common';

export type ReviewKind = 'added' | 'deleted' | 'replaced' | 'highlight' | 'comment' | 'note';

/** Name of the note macro (without backslash). Configured per project. */
export const noteMacroFacet = Facet.define<string, string>({ combine: (v) => v[0] ?? 'note' });
export const REVIEW_KINDS = new Set<string>(['added', 'deleted', 'replaced', 'highlight', 'comment']);

/** A brace argument: `open` is the position of `{`, `close` the position of `}`. */
export type Arg = { open: number; close: number };

export type ReviewItem = {
  kind: ReviewKind;
  from: number;
  to: number;
  args: Arg[]; // replaced: [new, old]; note: [author, text] or [text]; others: [content]
  opt: { from: number; to: number } | null; // [..] optional argument, if any
  author: string;
  note: string; // comment text (\comment content, or comment= option)
};

/** Marks transactions made by review actions (accept/reject/comment), which are never tracked. */
export const reviewAction = Annotation.define<boolean>();

const content = (state: EditorState, a: Arg) => state.sliceDoc(a.open + 1, a.close);

function parseOptions(text: string) {
  const author = /(?:^|,)\s*id\s*=\s*([^,\]]+)/.exec(text)?.[1].trim() ?? '';
  const m = /(?:^|,)\s*comment\s*=\s*(\{([\s\S]*)\}|[^,]*)/.exec(text);
  const note = m ? (m[2] ?? m[1]).trim() : '';
  return { author, note };
}

export function itemFromNode(state: EditorState, node: SyntaxNode): ReviewItem | null {
  if (node.name !== 'UnknownCommand') return null;
  const ctrl = node.firstChild;
  if (!ctrl || ctrl.name !== 'CtrlSeq') return null;
  const name = state.sliceDoc(ctrl.from + 1, ctrl.to);
  const isNote = name === state.facet(noteMacroFacet);
  if (!isNote && !REVIEW_KINDS.has(name)) return null;
  const kind = isNote ? 'note' : name;
  const args: Arg[] = [];
  for (const a of node.getChildren('TextArgument')) {
    const open = a.getChild('OpenBrace');
    const close = a.getChild('CloseBrace');
    if (!open || !close) return null;
    args.push({ open: open.from, close: close.from });
  }
  if (kind === 'note' ? args.length < 1 || args.length > 2 : args.length !== (kind === 'replaced' ? 2 : 1)) return null;
  const optNode = node.getChild('OptionalArgument');
  const opt = optNode ? { from: optNode.from, to: optNode.to } : null;
  const { author, note } = parseOptions(opt ? state.sliceDoc(opt.from + 1, opt.to - 1) : '');
  if (kind === 'note') {
    return {
      kind: 'note',
      from: node.from,
      to: args[args.length - 1].close + 1,
      args,
      opt,
      author: args.length === 2 ? content(state, args[0]).trim() : author,
      note: content(state, args[args.length - 1]).trim(),
    };
  }
  return {
    kind: kind as ReviewKind,
    from: node.from,
    to: args[args.length - 1].close + 1,
    args,
    opt,
    author,
    note: kind === 'comment' ? content(state, args[0]).trim() : note,
  };
}

export function findReviewItems(state: EditorState): ReviewItem[] {
  const items: ReviewItem[] = [];
  syntaxTree(state).iterate({
    enter(ref) {
      if (ref.name === 'UnknownCommand') {
        const item = itemFromNode(state, ref.node);
        if (item) items.push(item);
      }
    },
  });
  return items;
}

export function itemAt(state: EditorState, pos: number): ReviewItem | null {
  // Innermost item containing pos.
  let best: ReviewItem | null = null;
  for (const it of findReviewItems(state)) {
    if (it.from <= pos && pos <= it.to && (!best || it.to - it.from < best.to - best.from)) best = it;
  }
  return best;
}

/** The text that replaces an item when it is accepted or rejected. Comments are just resolved. */
export function resolvedText(state: EditorState, it: ReviewItem, accept: boolean): string {
  switch (it.kind) {
    case 'added': return accept ? content(state, it.args[0]) : '';
    case 'deleted': return accept ? '' : content(state, it.args[0]);
    case 'replaced': return content(state, it.args[accept ? 0 : 1]);
    case 'highlight': return content(state, it.args[0]);
    case 'comment': return '';
    case 'note': return '';
  }
}

/** Change for resolving one item; removing text also drops a now-doubled space. */
export function resolveChange(state: EditorState, it: ReviewItem, accept: boolean) {
  const insert = resolvedText(state, it, accept);
  let { from, to } = it;
  if (!insert) {
    const before = state.sliceDoc(from - 1, from);
    const after = state.sliceDoc(to, to + 1);
    if (before === ' ' && (after === ' ' || after === '.' || after === ',')) from--;
    else if ((before === '' || before === '\n') && after === ' ') to++;
  }
  return { from, to, insert };
}

export function resolveSpec(state: EditorState, items: ReviewItem[], accept: boolean): TransactionSpec {
  // Outermost items only, so nested markup doesn't produce overlapping changes.
  const sorted = [...items].sort((a, b) => a.from - b.from || b.to - a.to);
  const picked: ReviewItem[] = [];
  for (const it of sorted) if (!picked.length || it.from >= picked[picked.length - 1].to) picked.push(it);
  return {
    changes: picked.map((it) => resolveChange(state, it, accept)),
    annotations: reviewAction.of(true),
    userEvent: accept ? 'review.accept' : 'review.reject',
  };
}

export function itemLabel(it: ReviewItem): string {
  return { added: 'Added', deleted: 'Deleted', replaced: 'Replaced', highlight: 'Comment', comment: 'Comment', note: 'Note' }[it.kind];
}

/** Short readable text of an item, for the review panel. */
export function itemSummary(state: EditorState, it: ReviewItem): { text: string; old?: string } {
  const clip = (s: string) => {
    const t = s.replace(/\s+/g, ' ').trim();
    return t.length > 120 ? t.slice(0, 117) + '…' : t;
  };
  if (it.kind === 'replaced') return { text: clip(content(state, it.args[0])), old: clip(content(state, it.args[1])) };
  if (it.kind === 'highlight') return { text: clip(it.note), old: clip(content(state, it.args[0])) };
  if (it.kind === 'note') return { text: clip(it.note) };
  return { text: clip(content(state, it.args[0])) };
}

/** Comments of any style (resolved, not accepted/rejected). */
export const isCommentKind = (k: ReviewKind) => k === 'comment' || k === 'highlight' || k === 'note';
