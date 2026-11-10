// Visual mode: decorations over the LaTeX source, modeled on Overleaf's atomic/mark decorations.
// The document text is never changed; constructs are hidden, styled, or replaced by widgets, and
// shown as source again whenever the selection touches them.
import { EditorState, StateField, StateEffect, type Range, type Extension } from '@codemirror/state';
import { Decoration, type DecorationSet, EditorView, ViewPlugin } from '@codemirror/view';
import { syntaxTree, ensureSyntaxTree } from '@codemirror/language';
import type { SyntaxNode, Tree } from '@lezer/common';
import { macrosFor } from './math.ts';
import {
  TextWidget, ChipWidget, MathWidget, ItemWidget, EnvLineWidget, PreambleWidget, TitleWidget, GraphicsWidget,
  CommentWidget, ReviewActionsWidget,
} from './widgets.ts';
import { itemFromNode } from '../review/model.ts';

export const mouseDownEffect = StateEffect.define<boolean>();

/** Environments whose \begin/\end lines become a label (or disappear, for lists). */
const ENV_LABELS: Record<string, string> = {
  abstract: 'Abstract', figure: 'Figure', table: 'Table', algorithm: 'Algorithm',
  theorem: 'Theorem', lemma: 'Lemma', corollary: 'Corollary', proposition: 'Proposition',
  definition: 'Definition', remark: 'Remark', example: 'Example', proof: 'Proof', claim: 'Claim',
  assumption: 'Assumption', conjecture: 'Conjecture', note: 'Note',
  quote: '', quotation: '', center: '', itemize: '', enumerate: '', description: '',
};
const LINE_CLASS_ENVS = new Set([
  'abstract', 'figure', 'table', 'algorithm', 'quote', 'quotation', 'center', 'verbatim', 'lstlisting',
  'theorem', 'lemma', 'corollary', 'proposition', 'definition', 'remark', 'example', 'proof', 'claim',
  'assumption', 'conjecture', 'note',
]);
const THEOREM_LIKE = new Set(['theorem', 'lemma', 'corollary', 'proposition', 'conjecture', 'claim']);

const FORMATTING: Record<string, string> = {
  TextBoldCommand: 'bold', TextItalicCommand: 'italic', EmphasisCommand: 'italic',
  UnderlineCommand: 'underline', TextTeletypeCommand: 'tt', TextSmallCapsCommand: 'sc',
  StrikeOutCommand: 'strike', TextSuperscriptCommand: 'sup', TextSubscriptCommand: 'sub',
  TextSansSerifCommand: 'sf', TextMediumCommand: 'medium',
};
const HEADING_LEVEL: Record<string, string> = {
  BookCtrlSeq: 'part', PartCtrlSeq: 'part', ChapterCtrlSeq: 'chapter', SectionCtrlSeq: 'section',
  SubSectionCtrlSeq: 'subsection', SubSubSectionCtrlSeq: 'subsubsection',
  ParagraphCtrlSeq: 'paragraph', SubParagraphCtrlSeq: 'paragraph',
};
const SYMBOLS: Record<string, string> = {
  '\\%': '%', '\\&': '&', '\\_': '_', '\\$': '$', '\\#': '#', '\\{': '{', '\\}': '}', '\\ ': ' ',
  '\\ldots': '…', '\\dots': '…', '\\textellipsis': '…', '\\LaTeX': 'LaTeX', '\\TeX': 'TeX',
  '\\S': '§', '\\P': '¶', '\\copyright': '©', '\\textendash': '–', '\\textemdash': '—',
  '\\textbackslash': '\\', '\\ss': 'ß', '\\o': 'ø', '\\ae': 'æ', '\\aa': 'å', '\\i': 'ı',
  '\\textdegree': '°', '\\checkmark': '✓', '\\quad': ' ', '\\qquad': '  ',
  '\\,': ' ', '\\;': ' ', '\\!': '', '\\@': '', '\\/': '',
};
const BULLETS = ['•', '◦', '▪', '•'];

const intersects = (state: EditorState, from: number, to: number) =>
  state.selection.ranges.some((r) => r.from <= to && r.to >= from);

const envNameOf = (env: SyntaxNode, state: EditorState): string | null => {
  for (let c = env.getChild('BeginEnv')?.getChild('EnvNameGroup')?.firstChild; c; c = c.nextSibling) {
    if (c.name.endsWith('EnvName')) return state.sliceDoc(c.from, c.to);
  }
  return null;
};

/** True if the node is the only non-blank thing on its line(s). */
const aloneOnLines = (state: EditorState, node: { from: number; to: number }) => {
  const a = state.doc.lineAt(node.from);
  const b = state.doc.lineAt(node.to);
  return !state.sliceDoc(a.from, node.from).trim() && !state.sliceDoc(node.to, b.to).trim();
};

/** Strip LaTeX markup down to readable text, for the title block. */
function plainText(tex: string): string {
  return tex
    .replace(/\\thanks\s*\{[^{}]*\}/g, '')
    .replace(/\\today\b/g, new Date().toLocaleDateString(undefined, { year: 'numeric', month: 'long', day: 'numeric' }))
    .replace(/\\\\(\[[^\]]*\])?/g, ', ')
    .replace(/\\(?:and|AND)\b/g, ' · ')
    .replace(/\\[a-zA-Z@]+\*?\s*(\[[^\]]*\])?/g, '')
    .replace(/[{}~]/g, (c) => (c === '~' ? ' ' : ''))
    .replace(/\s+/g, ' ')
    .trim();
}

function graphicsWidth(opts: string): string | null {
  const w = /width\s*=\s*([\d.]+)\s*\\(?:line|text|column)width/.exec(opts);
  if (w) return `${Math.min(100, Number(w[1]) * 100)}%`;
  const abs = /width\s*=\s*([\d.]+)\s*(cm|mm|in|pt)/.exec(opts);
  if (abs) return `min(100%, ${abs[1]}${abs[2]})`;
  const scale = /scale\s*=\s*([\d.]+)/.exec(opts);
  if (scale) return `${Math.min(100, Number(scale[1]) * 100)}%`;
  return null;
}

/** The outermost math construct around a Math node: $..$, \[..\], \(..\), or an equation environment. */
function mathContainer(node: SyntaxNode): SyntaxNode | null {
  let env: SyntaxNode | null = null;
  for (let p = node.parent; p; p = p.parent) {
    if (p.type.is('$MathContainer')) return p;
    if (p.name === 'EquationEnvironment') env = p;
    else if (p.name === 'EquationArrayEnvironment' && !env) env = p;
  }
  return env;
}

type Built = { atomic: DecorationSet; marks: DecorationSet };

function build(state: EditorState, tree: Tree): Built {
  const atomic: Range<Decoration>[] = [];
  const marks: Range<Decoration>[] = [];
  const doc = state.doc;
  const touches = (from: number, to: number) => intersects(state, from, to);
  const touchesLines = (from: number, to: number) => touches(doc.lineAt(from).from, doc.lineAt(to).to);
  const hide = (from: number, to: number, text = '') => {
    if (to > from) atomic.push(Decoration.replace({ widget: new TextWidget(text) }).range(from, to));
  };
  const lineClass = new Map<number, Set<string>>();
  const addLineClass = (from: number, to: number, cls: string) => {
    for (let n = doc.lineAt(from).number, end = doc.lineAt(to).number; n <= end; n++) {
      const start = doc.line(n).from;
      if (!lineClass.has(start)) lineClass.set(start, new Set());
      lineClass.get(start)!.add(cls);
    }
  };
  /** Replace a whole-line construct (\begin{..} line etc.) with a block widget unless the cursor is on it. */
  const replaceLines = (node: SyntaxNode, widget: EnvLineWidget | TitleWidget) => {
    if (!aloneOnLines(state, node) || touchesLines(node.from, node.to)) return false;
    atomic.push(Decoration.replace({ widget, block: true }).range(doc.lineAt(node.from).from, doc.lineAt(node.to).to));
    return true;
  };
  /** Hide `\cmd{` and `}` around an argument, showing braces while the cursor is inside. */
  const hideAroundArg = (node: SyntaxNode, arg: SyntaxNode | null | undefined, alwaysShowBraces = false) => {
    const open = arg?.getChild('OpenBrace');
    const close = arg?.getChild('CloseBrace');
    if (!open || !close) return false;
    const show = alwaysShowBraces || touches(node.from, node.to) || close.from === open.to;
    hide(node.from, open.to, show ? '{' : '');
    hide(close.from, close.to, show ? '}' : '');
    return true;
  };
  const argText = (arg: SyntaxNode | null | undefined) => {
    if (!arg) return '';
    const t = state.sliceDoc(arg.from, arg.to);
    return t.replace(/^\s*[{[]/, '').replace(/[}\]]\s*$/, '');
  };
  const macros = macrosFor(doc, () => doc.toString());

  let preamble: { to: number } | null = null;
  const titleParts = { title: '', authors: [] as string[], date: '' };
  const lists: { kind: string; n: number }[] = [];
  const listLines: { from: number; to: number; depth: number }[] = [];

  tree.iterate({
    enter(ref) {
      const node = ref.node;
      const name = ref.name;

      if (name === 'DocumentEnvironment') {
        const begin = node.getChild('BeginEnv');
        if (!preamble && begin) preamble = { to: doc.lineAt(begin.to).to };
        const end = node.getChild('EndEnv');
        if (end) replaceLines(end, new EnvLineWidget('hidden'));
        return;
      }
      if (name === 'Title' || name === 'Author' || name === 'Date') {
        const text = plainText(argText(node.getChild('TextArgument') ?? node.getChild('ShortTextArgument')));
        if (name === 'Title') titleParts.title = text;
        else if (name === 'Author') titleParts.authors.push(text);
        else titleParts.date = text;
        return false;
      }
      if (name === 'Maketitle') {
        replaceLines(node, new TitleWidget(titleParts.title, titleParts.authors, titleParts.date));
        return false;
      }

      // ---- math ----
      if (name === 'Math') {
        const container = mathContainer(node);
        if (!container) return false;
        const isEnv = container.type.is('$Environment');
        const env = isEnv ? envNameOf(container, state) : null;
        if (env === 'tikzcd') return false;
        const content = isEnv && env !== 'math' && env !== 'displaymath'
          ? state.sliceDoc(container.from, container.to).trim()
          : state.sliceDoc(node.from, node.to).trim();
        if (!content) return false;
        const display = isEnv ? env !== 'math' : container.name === 'BracketMath' || !!container.getChild('DisplayMath');
        const editing = isEnv ? touchesLines(container.from, container.to) : touches(container.from, container.to);
        const block = display && aloneOnLines(state, container);
        if (!editing) {
          const widget = new MathWidget(content, display, macros.key, macros.macros);
          atomic.push(Decoration.replace({ widget, block }).range(
            block ? doc.lineAt(container.from).from : container.from,
            block ? doc.lineAt(container.to).to : container.to,
          ));
        } else if (display) {
          // While editing display math, show a live preview underneath.
          atomic.push(Decoration.widget({
            widget: new MathWidget(content, true, macros.key, macros.macros, true), block: true, side: 1,
          }).range(doc.lineAt(container.to).to));
        }
        return false;
      }

      // ---- environments ----
      if (node.type.is('$Environment')) {
        const env = envNameOf(node, state)?.replace(/\*$/, '');
        if (!env) return;
        const begin = node.getChild('BeginEnv');
        const end = node.getChild('EndEnv');
        if (!begin || !end || !begin.getChild('EnvNameGroup')?.getChild('CloseBrace') || !end.getChild('EnvNameGroup')?.getChild('CloseBrace')) return;
        if (LINE_CLASS_ENVS.has(env)) {
          addLineClass(begin.to, end.from, `vc-env-${env}`);
          if (THEOREM_LIKE.has(env)) addLineClass(begin.to, end.from, 'vc-env-theoremlike');
        }
        if (name === 'ListEnvironment' || env === 'itemize' || env === 'enumerate' || env === 'description') {
          lists.push({ kind: env, n: 0 });
          listLines.push({ from: begin.to, to: end.from, depth: lists.length });
        }
        if (env in ENV_LABELS) {
          const label = ENV_LABELS[env];
          const opt = begin.getChild('OptionalArgument');
          const optText = opt && label && !/^(figure|table|algorithm)$/.test(env) ? ` (${plainText(argText(opt))})` : '';
          replaceLines(begin, label ? new EnvLineWidget('begin', label + optText) : new EnvLineWidget('hidden'));
          replaceLines(end, label ? new EnvLineWidget('end') : new EnvLineWidget('hidden'));
        }
        return;
      }

      if (name === 'Item') {
        const list = lists[lists.length - 1];
        if (!list) return;
        list.n++;
        const line = doc.lineAt(node.from);
        const from = state.sliceDoc(line.from, node.from).trim() ? node.from : line.from;
        const opt = node.getChild('OptionalArgument');
        let marker: string;
        if (opt) marker = plainText(argText(opt));
        else if (list.kind === 'enumerate') marker = `${list.n}.`;
        else if (list.kind === 'description') marker = '';
        else marker = BULLETS[Math.min(lists.length, BULLETS.length) - 1];
        atomic.push(Decoration.replace({ widget: new ItemWidget(marker, !!opt) }).range(from, node.to));
        addLineClass(node.from, node.from, 'vc-item-line');
        return false;
      }

      // ---- headings & formatting ----
      if (name === 'SectioningCommand') {
        const ctrl = node.firstChild;
        const arg = node.getChild('SectioningArgument');
        const title = arg?.getChild('LongArg');
        const close = arg?.getChild('CloseBrace');
        if (!ctrl || !arg || !title || !close || !state.sliceDoc(title.from, title.to).trim()) return;
        const level = HEADING_LEVEL[ctrl.name] ?? 'section';
        marks.push(Decoration.mark({ class: `vc-heading vc-heading-${level}` }).range(node.from, node.to));
        const showBraces = touches(ctrl.from, title.from) || touches(close.from, close.to);
        hide(node.from, title.from, showBraces ? '{' : '');
        hide(close.from, close.to, showBraces ? '}' : '');
        return;
      }
      if (name in FORMATTING) {
        const arg = node.getChild('TextArgument');
        const content = arg?.getChild('LongArg');
        if (content && content.to > content.from) {
          marks.push(Decoration.mark({ class: `vc-fmt-${FORMATTING[name]}`, inclusive: true }).range(content.from, content.to));
        }
        hideAroundArg(node, arg);
        return;
      }
      if (name === 'FootnoteCommand' || name === 'EndnoteCommand') {
        const arg = node.getChild('TextArgument');
        const open = arg?.getChild('OpenBrace');
        const close = arg?.getChild('CloseBrace');
        if (!arg || !open || !close || touches(node.from, node.to)) return;
        atomic.push(Decoration.replace({ widget: new ChipWidget('footnote', name === 'FootnoteCommand' ? 'footnote' : 'endnote') }).range(node.from, open.to));
        hide(close.from, close.to);
        marks.push(Decoration.mark({ class: 'vc-footnote' }).range(open.to, close.from));
        return;
      }
      if (name === 'Caption') {
        const arg = node.getChild('TextArgument');
        const open = arg?.getChild('OpenBrace');
        const close = arg?.getChild('CloseBrace');
        if (!open || !close) return;
        addLineClass(node.from, node.to, 'vc-caption-line');
        if (touches(node.from, node.to)) return;
        atomic.push(Decoration.replace({ widget: new TextWidget('Caption: ', 'vc-caption-label') }).range(node.from, open.to));
        hide(close.from, close.to);
        return;
      }
      if (name === 'HrefCommand') {
        const text = node.getChild('ShortTextArgument');
        const url = argText(node.getChild('UrlArgument'));
        const open = text?.getChild('OpenBrace');
        const close = text?.getChild('CloseBrace');
        if (!text || !open || !close || touches(node.from, node.to)) return false;
        hide(node.from, open.to);
        hide(close.from, close.to);
        marks.push(Decoration.mark({ class: 'vc-link', attributes: { title: url } }).range(open.to, close.from));
        return false;
      }
      if (name === 'UrlCommand') {
        const arg = node.getChild('UrlArgument');
        const open = arg?.getChild('OpenBrace');
        const close = arg?.getChild('CloseBrace');
        if (!arg || !open || !close || touches(node.from, node.to)) return false;
        hide(node.from, open.to);
        hide(close.from, close.to);
        marks.push(Decoration.mark({ class: 'vc-link' }).range(open.to, close.from));
        return false;
      }

      // ---- references & files: compact chips, source while the cursor touches them ----
      const chip = (kind: string, text: string, title = '', openPath?: string) => {
        if (!touches(node.from, node.to)) {
          atomic.push(Decoration.replace({ widget: new ChipWidget(kind, text, title, openPath) }).range(node.from, node.to));
        }
        return false;
      };
      if (name === 'Cite') {
        const keys = argText(node.getChild('BibKeyArgument')).split(',').map((k) => k.trim()).filter(Boolean);
        const opts = node.getChildren('OptionalArgument').map((o) => plainText(argText(o))).filter(Boolean);
        return chip('cite', `[${[...keys, ...opts.reverse()].join(', ')}]`, state.sliceDoc(node.from, node.to));
      }
      if (name === 'Ref') {
        const cmd = state.sliceDoc(node.from, node.firstChild?.to ?? node.from);
        const label = argText(node.getChild('RefArgument'));
        return chip('ref', cmd.startsWith('\\eqref') ? `(${label})` : `→ ${label}`, cmd);
      }
      if (name === 'Label') return chip('label', `#${argText(node.getChild('LabelArgument'))}`, 'label');
      if (name === 'Input' || name === 'Include') {
        const m = /\{([^}]*)\}/.exec(state.sliceDoc(node.from, node.to));
        const file = m?.[1].trim() ?? '';
        const path = /\.\w+$/.test(file) ? file : `${file}.tex`;
        return chip('file', `↪ ${file}`, '', path);
      }
      if (name === 'BibliographyCommand') return chip('file', `Bibliography: ${argText(node.lastChild)}`);
      if (name === 'BibliographyStyleCommand') return chip('label', `style: ${argText(node.lastChild)}`);
      if (name === 'IncludeGraphics') {
        const file = argText(node.getChild('IncludeGraphicsArgument'));
        const opts = argText(node.getChild('OptionalArgument'));
        if (!file || touches(node.from, node.to)) return false;
        const block = aloneOnLines(state, node);
        const widget = new GraphicsWidget(file, graphicsWidth(opts), block);
        atomic.push(Decoration.replace({ widget, block }).range(
          block ? doc.lineAt(node.from).from : node.from, block ? doc.lineAt(node.to).to : node.to,
        ));
        return false;
      }
      if (name === 'Centering') {
        if (aloneOnLines(state, node)) replaceLines(node, new EnvLineWidget('hidden'));
        return false;
      }

      // ---- small things ----
      if (name === 'Tilde') {
        if (!touches(node.from, node.to)) atomic.push(Decoration.replace({ widget: new TextWidget(' ', 'vc-nbsp') }).range(node.from, node.to));
        return;
      }
      if (name === 'UnknownCommand') {
        const review = itemFromNode(state, node);
        if (review) {
          // Tracked changes: hide the commands and keep the text (colored by review/highlight.ts).
          // They stay hidden while editing so typing inside them feels like normal text.
          const editing = touches(review.from, review.to);
          const [a, b] = review.args;
          if (review.kind === 'added' || review.kind === 'deleted') {
            hide(review.from, a.open + 1);
            hide(a.close, review.to);
          } else if (review.kind === 'replaced') {
            hide(review.from, a.open + 1);
            hide(a.close, b.open + 1);
            hide(b.close, review.to);
          } else if (review.kind === 'highlight' && !editing) {
            hide(review.from, a.open + 1);
            hide(a.close, review.to);
            atomic.push(Decoration.widget({ widget: new CommentWidget(review.note, review.author), side: 1 }).range(review.to));
          } else if (review.kind === 'comment' && !editing) {
            atomic.push(Decoration.replace({ widget: new CommentWidget(review.note, review.author) }).range(review.from, review.to));
          }
          if (editing) {
            atomic.push(Decoration.widget({ widget: new ReviewActionsWidget(review.from, review.kind), side: 2 }).range(review.to));
          }
          return review.kind === 'comment' && !editing ? false : undefined;
        }
        const ctrl = node.firstChild;
        if (!ctrl || ctrl.nextSibling) return; // has arguments: leave as source
        const text = state.sliceDoc(ctrl.from, ctrl.to);
        const sym = SYMBOLS[text];
        if (sym !== undefined && !touches(ctrl.from, ctrl.to)) {
          atomic.push(Decoration.replace({ widget: new TextWidget(sym, 'vc-symbol') }).range(ctrl.from, ctrl.to));
        }
        return;
      }
    },
    leave(ref) {
      if (ref.node.type.is('$Environment')) {
        const env = envNameOf(ref.node, state)?.replace(/\*$/, '');
        if (ref.name === 'ListEnvironment' || env === 'itemize' || env === 'enumerate' || env === 'description') lists.pop();
      }
    },
  });

  for (const { from, to, depth } of listLines) addLineClass(from, to, `vc-list-${Math.min(depth, 4)}`);

  // The preamble collapses to a bar until the cursor enters it.
  const pre = preamble as { to: number } | null;
  let atomicRanges = atomic;
  let markRanges = marks;
  if (pre && pre.to > 0) {
    if (!touches(0, pre.to)) {
      atomicRanges = atomic.filter((r) => r.from >= pre.to + 1);
      markRanges = marks.filter((r) => r.from >= pre.to + 1);
      for (const start of [...lineClass.keys()]) if (start <= pre.to) lineClass.delete(start);
      atomicRanges.push(Decoration.replace({ widget: new PreambleWidget(doc.lineAt(pre.to).number), block: true }).range(0, pre.to));
    } else {
      addLineClass(0, pre.to, 'vc-preamble-line');
    }
  }
  for (const [start, classes] of lineClass) {
    atomicRanges.push(Decoration.line({ class: [...classes].join(' ') }).range(start));
  }
  return { atomic: Decoration.set(atomicRanges, true), marks: Decoration.set(markRanges, true) };
}

type FieldValue = Built & { tree: Tree; mousedown: boolean };

const visualField = StateField.define<FieldValue>({
  create(state) {
    // Parse the whole document up front (bounded) so the first render is already visual.
    const tree = ensureSyntaxTree(state, state.doc.length, 1000) ?? syntaxTree(state);
    return { ...build(state, tree), tree, mousedown: false };
  },
  update(value, tr) {
    let mousedown = value.mousedown;
    let mouseReleased = false;
    for (const e of tr.effects) {
      if (e.is(mouseDownEffect)) {
        mouseReleased = mousedown && !e.value;
        mousedown = e.value;
      }
    }
    const tree = syntaxTree(tr.state);
    const stillParsing = tree.length < tr.state.doc.length;
    // Don't rebuild mid-drag: revealing source under the mouse would make the selection jump.
    if (stillParsing || (mousedown && !tr.docChanged)) {
      return { ...value, mousedown, atomic: value.atomic.map(tr.changes), marks: value.marks.map(tr.changes) };
    }
    if (tree !== value.tree || tr.selection || tr.docChanged || mouseReleased) {
      return { ...build(tr.state, tree), tree, mousedown };
    }
    return mousedown === value.mousedown ? value : { ...value, mousedown };
  },
  provide: (f) => [
    EditorView.decorations.from(f, (v) => v.atomic),
    EditorView.decorations.from(f, (v) => v.marks),
    EditorView.atomicRanges.from(f, (v) => () => v.atomic),
  ],
});

const mouseTracker = ViewPlugin.define((view) => {
  // Rebuild only after CodeMirror's own mouseup handling: it re-resolves the click position, and
  // must do so against the layout the user clicked on, not the one after source collapses.
  // Then keep the cursor in view, since collapsing source above it can move it.
  const up = () => setTimeout(() => {
    const field = view.state.field(visualField, false);
    if (!field?.mousedown) return;
    view.dispatch({
      effects: [mouseDownEffect.of(false), EditorView.scrollIntoView(view.state.selection.main.head)],
    });
  });
  document.addEventListener('mouseup', up);
  return { destroy: () => document.removeEventListener('mouseup', up) };
}, {
  eventHandlers: {
    mousedown(e, view) {
      if (e.button === 0) view.dispatch({ effects: mouseDownEffect.of(true) });
    },
  },
});

export const visualDecorations: Extension = [visualField, mouseTracker];

/** Source ranges visual mode currently hides (replaced by widgets), or null in source mode. */
export function visualHiddenRanges(state: EditorState): DecorationSet | null {
  return state.field(visualField, false)?.atomic ?? null;
}
