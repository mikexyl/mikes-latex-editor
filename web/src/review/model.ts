// Review markup in the source, using the `changes` package syntax so files stay compatible:
//   \added[id=..]{new}   \deleted{old}   \replaced{new}{old}
//   \highlight[comment={note}]{text}   \comment{note}
// plus note macros: new notes use the project's, by default \revnote{author}{text} (earlier
// versions' \note{author}{text} is still read), or \revnote[paper text]{author}{text}
// for a note about a piece of the paper (e.g. defined as
// \newcommand{\revnote}[3][]{#1\textcolor{red}{[#2: #3]}}), which also prints in the PDF.
// Outlines, \revoutline{author}{what to write here}, mark text still to be written.
import { Annotation, Facet, type EditorState, type TransactionSpec } from '@codemirror/state';
import { syntaxTree } from '@codemirror/language';
import type { SyntaxNode } from '@lezer/common';

export type ReviewKind = 'added' | 'deleted' | 'replaced' | 'highlight' | 'comment' | 'note' | 'outline';

/** Name of the note macro (without backslash). Configured per project. */
export const noteMacroFacet = Facet.define<string, string>({ combine: (v) => v[0] ?? 'revnote' });
/** Earlier versions' note macro: still read as a note, never inserted any more. */
export const LEGACY_NOTE_MACRO = 'note';
export const REVIEW_KINDS = new Set<string>(['added', 'deleted', 'replaced', 'highlight', 'comment']);
/** Outline macro: what still has to be written at this spot, \revoutline{author}{text}. */
export const OUTLINE_MACRO = 'revoutline';

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
  quote?: { from: number; to: number }; // note: the paper text it's about, \note[this]{..}{..}
};

/**
 * Who changes are signed by: your initials (from the comment settings), written as
 * \added[id=XL]{..}, the `changes` package's syntax. Empty: changes aren't signed.
 */
let reviewAuthor = '';
export function setReviewAuthor(initials: string) {
  reviewAuthor = initials.replace(/[\[\]{}%\\,=#$&^_~]/g, '').trim();
}
export const getReviewAuthor = () => reviewAuthor;
/** The `[id=XL]` option for a new change, or '' when unsigned. */
export const authorOpt = () => (reviewAuthor ? `[id=${reviewAuthor}]` : '');

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
  const isNote = name === state.facet(noteMacroFacet) || name === LEGACY_NOTE_MACRO;
  const isOutline = name === OUTLINE_MACRO;
  if (!isNote && !isOutline && !REVIEW_KINDS.has(name)) return null;
  const kind = isNote ? 'note' : isOutline ? 'outline' : name;
  const args: Arg[] = [];
  for (const a of node.getChildren('TextArgument')) {
    const open = a.getChild('OpenBrace');
    const close = a.getChild('CloseBrace');
    if (!open || !close) return null;
    args.push({ open: open.from, close: close.from });
  }
  const noteLike = kind === 'note' || kind === 'outline';
  if (noteLike ? args.length < 1 || args.length > 2 : args.length !== (kind === 'replaced' ? 2 : 1)) return null;
  const optNode = node.getChild('OptionalArgument');
  const opt = optNode ? { from: optNode.from, to: optNode.to } : null;
  const { author, note } = parseOptions(opt ? state.sliceDoc(opt.from + 1, opt.to - 1) : '');
  if (kind === 'outline') {
    return {
      kind: 'outline',
      from: node.from,
      to: args[args.length - 1].close + 1,
      args,
      opt,
      author: args.length === 2 ? content(state, args[0]).trim() : author,
      note: content(state, args[args.length - 1]).trim(),
    };
  }
  if (kind === 'note') {
    // \note[text]{..}{..}: the text the note is about; \note[{a]b}] protects a `]` in it.
    let quote: { from: number; to: number } | undefined;
    if (opt && args.length === 2) { // (with one argument, [..] holds options: \note[id=XL]{text})
      quote = { from: opt.from + 1, to: opt.to - 1 };
      if (state.sliceDoc(quote.from, quote.from + 1) === '{' && state.sliceDoc(quote.to - 1, quote.to) === '}') {
        quote = { from: quote.from + 1, to: quote.to - 1 };
      }
    }
    return {
      kind: 'note',
      quote,
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
    case 'note': return it.quote ? state.sliceDoc(it.quote.from, it.quote.to) : '';
    case 'outline': return '';
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
  return { added: 'Added', deleted: 'Deleted', replaced: 'Replaced', highlight: 'Comment', comment: 'Comment', note: 'Note', outline: 'To write' }[it.kind];
}

/** Short readable text of an item, for the review panel. */
export function itemSummary(state: EditorState, it: ReviewItem): { text: string; old?: string } {
  const clip = (s: string) => {
    const t = s.replace(/\s+/g, ' ').trim();
    return t.length > 120 ? t.slice(0, 117) + '…' : t;
  };
  if (it.kind === 'replaced') return { text: clip(content(state, it.args[0])), old: clip(content(state, it.args[1])) };
  if (it.kind === 'highlight') return { text: clip(it.note), old: clip(content(state, it.args[0])) };
  if (it.kind === 'outline') return { text: clip(it.note) };
  if (it.kind === 'note') return { text: clip(it.note), old: it.quote ? clip(state.sliceDoc(it.quote.from, it.quote.to)) : undefined };
  return { text: clip(content(state, it.args[0])) };
}

/** Comments of any style (resolved, not accepted/rejected). */
export const isCommentKind = (k: ReviewKind) => k === 'comment' || k === 'highlight' || k === 'note';
/** Items resolved rather than accepted or rejected: comments and outlines. */
export const isResolvable = (k: ReviewKind) => isCommentKind(k) || k === 'outline';

/** The files a document \input-s or \include-s, as written (with .tex added), in order. */
export function findIncludes(state: EditorState): { rel: string; pos: number }[] {
  const out: { rel: string; pos: number }[] = [];
  syntaxTree(state).iterate({
    enter(ref) {
      if (ref.name !== 'Input' && ref.name !== 'Include') return;
      const file = /\{([^}]*)\}/.exec(state.sliceDoc(ref.from, ref.to))?.[1].trim();
      if (file) out.push({ rel: /\.\w+$/.test(file) ? file : `${file}.tex`, pos: ref.from });
      return false;
    },
  });
  return out;
}
