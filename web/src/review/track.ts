// Track changes: rewrites typing/deleting into \added{..}, \deleted{..} and \replaced{new}{old}.
// Edits inside your own \added text (or comment text) are plain edits. Edits that would break
// the LaTeX structure (inside math, command names, labels/citations, across braces) are refused
// with a notice instead of producing an invalid file.
import { Annotation, ChangeSet, EditorSelection, EditorState, Transaction, type ChangeSpec } from '@codemirror/state';
import { syntaxTree } from '@codemirror/language';
import type { SyntaxNode } from '@lezer/common';
import { findReviewItems, reviewAction, type ReviewItem } from './model.ts';

const trackedEdit = Annotation.define<boolean>();

export function reviewNotice(message: string) {
  window.dispatchEvent(new CustomEvent('review-notice', { detail: message }));
}

// Places where wrapping text in a review command would change or break its meaning.
const DENY = /^(ShortTextArgument|ShortArg|OptionalArgument|ShortOptionalArg|EnvNameGroup|BeginEnv|EndEnv|Comment|Math|InlineMath|DisplayMath|DollarMath|BracketMath|ParenMath|EquationEnvironment|EquationArrayEnvironment|VerbatimEnvironment|TikzPictureEnvironment|FilePathArgument|BareFilePathArgument|UrlArgument|LiteralArgContent|VerbContent|VerbatimContent|LstInlineContent|NewCommand|RenewCommand|Def|Let|NewEnvironment|RenewEnvironment|CtrlSym|.*CtrlSeq|.*EnvName)$/;
// Nodes a deleted range may cut through: plain text and containers of text.
const ALLOW_PARTIAL = /^(Normal|Whitespace|NewLine|BlankLine|Text|Content|LongArg|Book|Part|Chapter|Section|SubSection|SubSubSection|Paragraph|SubParagraph)$/;
const isCommand = (name: string) => name === 'Command' || /Command$/.test(name);

export const REASONS: Record<string, string> = {
  math: 'Math can’t be edited with tracking on. Select the whole formula to replace it, or turn tracking off.',
  command: 'That edit would split a LaTeX command. Edit the text inside it instead, or turn tracking off.',
  structure: 'That deletion crosses LaTeX structure (braces, environments). Select whole elements, or turn tracking off.',
  preamble: 'The preamble isn’t tracked. Turn tracking off to edit it.',
  literal: 'Labels, citations, file names and options can’t be tracked. Turn tracking off to edit them.',
  braces: 'Unmatched braces can’t be tracked. Type both braces, or turn tracking off.',
  deleted: 'That text is marked as deleted. Reject the deletion to edit it.',
  table: 'Deleting across table cells can’t be tracked. Delete within one cell, or turn tracking off.',
};

function balanced(text: string): boolean {
  let depth = 0;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (c === '\\') { i++; continue; }
    if (c === '{') depth++;
    else if (c === '}' && --depth < 0) return false;
  }
  return depth === 0;
}

function reasonFor(name: string): string {
  if (/Math|Equation/.test(name)) return 'math';
  if (/CtrlSeq|CtrlSym|^Command|NewCommand|Def|Let/.test(name)) return 'command';
  if (/EnvName|BeginEnv|EndEnv|Comment/.test(name)) return 'structure';
  return 'literal';
}

/** Why text can't be inserted at pos, or null if it can. */
export function unsafeAt(state: EditorState, pos: number): string | null {
  const tree = syntaxTree(state);
  // In a root document, only the body (between \begin{document} and \end{document}) is tracked.
  let body: SyntaxNode | null | undefined;
  tree.iterate({
    enter(n) {
      if (body !== undefined) return false;
      if (n.name === 'DocumentEnvironment') { body = n.node.getChild('Content'); return false; }
      return n.name === 'LaTeX' || n.name === 'Text' || n.name === 'KnownEnvironment';
    },
  });
  if (body !== undefined && (!body || pos < body.from)) return 'preamble';
  if (body && pos > body.to) return 'structure';

  let okCommandFrom = -1; // a command whose argument content contains pos
  for (let n: SyntaxNode | null = tree.resolveInner(pos, 0); n; n = n.parent) {
    if (!(n.from < pos && pos < n.to)) continue;
    if (n.name === 'TextArgument' || n.name === 'SectioningArgument') {
      const o = n.getChild('OpenBrace');
      const c = n.getChild('CloseBrace');
      if (o && c && pos >= o.to && pos <= c.from) { okCommandFrom = n.parent?.from ?? -1; continue; }
      return 'command';
    }
    if (DENY.test(n.name)) return reasonFor(n.name);
    if (isCommand(n.name) && n.from !== okCommandFrom) return 'command';
  }
  return null;
}

export function unsafeRange(state: EditorState, from: number, to: number): string | null {
  const text = state.sliceDoc(from, to);
  if (!balanced(text)) return 'structure';
  const a = unsafeAt(state, from) ?? unsafeAt(state, to);
  if (a) return a;
  let bad: string | null = null;
  syntaxTree(state).iterate({
    from, to,
    enter(n) {
      if (bad) return false;
      const partial = (n.from < from && from < n.to && n.to < to) || (from < n.from && n.from < to && to < n.to);
      if (partial && !ALLOW_PARTIAL.test(n.name)) bad = 'structure';
      if (n.name === 'TabularEnvironment' && n.from < from && to < n.to && /&|\\\\/.test(text)) bad = 'table';
    },
  });
  return bad;
}

type Change = { fromA: number; toA: number; fromB: number; text: string };
type Result = { changes: ChangeSpec[]; cursor: number } | { error: string };

const ownArg = (it: ReviewItem) => (it.kind === 'added' || it.kind === 'replaced' || it.kind === 'comment' ? it.args[0] : null);
const deletedArg = (it: ReviewItem) => (it.kind === 'deleted' ? it.args[0] : it.kind === 'replaced' ? it.args[1] : null);

function trackOne(state: EditorState, items: ReviewItem[], c: Change, backward: boolean, headB: number, depth = 0): Result {
  const { fromA: from, toA: to, text } = c;
  const k = headB - c.fromB >= 0 && headB - c.fromB <= text.length ? headB - c.fromB : text.length;
  const own = items.find((it) => {
    const a = ownArg(it);
    return (a && from >= a.open + 1 && to <= a.close) || (it.opt && from > it.opt.from && to < it.opt.to);
  });
  const del = items.find((it) => { const a = deletedArg(it); return a && from >= a.open + 1 && to <= a.close; });

  // ---- insertion ----
  if (from === to) {
    if (own) return { changes: [{ from, insert: text }], cursor: from + k };
    if (!text.trim()) return { changes: [{ from, insert: text }], cursor: from + k }; // whitespace: not worth tracking
    if (!balanced(text)) return { error: 'braces' };
    const at = del ? del.to : from;
    const adj = items.find((it) => it.kind === 'added' && (it.to === at || it.from === at));
    if (adj) {
      const pos = adj.to === at ? adj.args[0].close : adj.args[0].open + 1;
      return { changes: [{ from: pos, insert: text }], cursor: pos + k };
    }
    const why = unsafeAt(state, at);
    if (why) return { error: why };
    return { changes: [{ from: at, insert: `\\added{${text}}` }], cursor: at + 7 + k };
  }

  // ---- deletion ----
  if (!text) {
    if (own) {
      const a = ownArg(own)!;
      if (own.kind === 'added' && from === a.open + 1 && to === a.close) return { changes: [{ from: own.from, to: own.to }], cursor: own.from };
      return { changes: [{ from, to }], cursor: from };
    }
    if (del) return { changes: [], cursor: backward ? del.from : del.to };

    // Deletions that hit a review command's own markup (e.g. backspace right after `}`).
    if (depth < 2) {
      const redo = (a: number, b: number) => trackOne(state, items, { fromA: a, toA: b, fromB: a, text: '' }, backward, headB, depth + 1);
      for (const it of items) {
        const first = it.args[0];
        const last = it.args[it.args.length - 1];
        const lastText = { from: last.open + 1, to: last.close };
        if (from >= last.close && to <= it.to) { // the closing brace
          if (!backward) return { changes: [], cursor: it.to };
          if (it.kind === 'added') return lastText.to > lastText.from ? redo(lastText.to - 1, lastText.to) : { changes: [{ from: it.from, to: it.to }], cursor: it.from };
          if (it.kind === 'replaced') {
            const a = it.args[0];
            if (a.close > a.open + 1) return { changes: [{ from: a.close - 1, to: a.close }], cursor: a.close - 1 };
            return { changes: [{ from: it.from, to: it.to, insert: `\\deleted{${state.sliceDoc(last.open + 1, last.close)}}` }], cursor: it.from };
          }
          if (it.kind === 'highlight') return redo(lastText.to - 1, lastText.to);
          return it.from > 0 ? redo(it.from - 1, it.from) : { changes: [], cursor: it.from };
        }
        if (from >= it.from && to <= first.open + 1) { // the command name / opening brace
          if (backward) return it.from > 0 ? redo(it.from - 1, it.from) : { changes: [], cursor: it.from };
          if (it.kind === 'added' || it.kind === 'replaced') {
            const a = it.args[0];
            return a.close > a.open + 1 ? { changes: [{ from: a.open + 1, to: a.open + 2 }], cursor: a.open + 1 } : { changes: [], cursor: it.to };
          }
          if (it.kind === 'highlight') return redo(first.open + 1, first.open + 2);
          return { changes: [], cursor: it.to };
        }
      }
    }

    const why = unsafeRange(state, from, to);
    if (why) return { error: why };
    const removed = state.sliceDoc(from, to);
    const before = items.find((it) => it.kind === 'deleted' && it.from === to);
    if (before) {
      const start = before.args[0].open + 1;
      return { changes: [{ from, to: start, insert: state.sliceDoc(to, start) + removed }], cursor: from };
    }
    const after = items.find((it) => it.kind === 'deleted' && it.to === from);
    if (after) {
      const close = after.args[0].close;
      return { changes: [{ from: close, to, insert: removed + '}' }], cursor: backward ? after.from : to };
    }
    const wrapped = `\\deleted{${removed}}`;
    return { changes: [{ from, to, insert: wrapped }], cursor: backward ? from : from + wrapped.length };
  }

  // ---- replacement ----
  if (own) return { changes: [{ from, to, insert: text }], cursor: from + k };
  if (del) return { error: 'deleted' };
  if (!balanced(text)) return { error: 'braces' };
  const why = unsafeRange(state, from, to);
  if (why) return { error: why };
  return { changes: [{ from, to, insert: `\\replaced{${text}}{${state.sliceDoc(from, to)}}` }], cursor: from + 10 + k };
}

export const trackChanges = EditorState.transactionFilter.of((tr) => {
  if (!tr.docChanged || tr.annotation(reviewAction) || tr.annotation(trackedEdit)) return tr;
  if (!(tr.isUserEvent('input') || tr.isUserEvent('delete') || tr.isUserEvent('move.drop'))) return tr;
  const state = tr.startState;
  const items = findReviewItems(state);
  const backward = !tr.isUserEvent('delete.forward');
  const parts: Change[] = [];
  tr.changes.iterChanges((fromA, toA, fromB, _toB, inserted) => parts.push({ fromA, toA, fromB, text: inserted.toString() }));

  const specs: ChangeSpec[] = [];
  let cursor: number | null = null;
  for (const part of parts) {
    const r = trackOne(state, items, part, backward, tr.newSelection.main.head);
    if ('error' in r) {
      reviewNotice(REASONS[r.error] ?? r.error);
      return [];
    }
    specs.push(...r.changes);
    cursor = r.cursor;
  }
  const sorted = (specs as { from: number }[]).sort((a, b) => a.from - b.from) as ChangeSpec[];
  const changes = ChangeSet.of(sorted, state.doc.length);
  const userEvent = tr.annotation(Transaction.userEvent);
  return {
    changes,
    selection: parts.length === 1 && cursor !== null ? EditorSelection.cursor(cursor) : state.selection.map(changes),
    scrollIntoView: true,
    effects: tr.effects,
    annotations: [trackedEdit.of(true), ...(userEvent ? [Transaction.userEvent.of(userEvent)] : [])],
  };
});
