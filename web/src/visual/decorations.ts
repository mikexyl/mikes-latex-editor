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
  CommentWidget, ReviewActionsWidget, CommentFoldWidget, type TitleAuthor,
} from './widgets.ts';
import { parseTabular, TableWidget } from './table.ts';
import { IncludeWidget } from './includes.ts';
import { itemFromNode, noteMacroFacet } from '../review/model.ts';

export const mouseDownEffect = StateEffect.define<boolean>();
/** Re-render visual mode (e.g. the project's macros changed). */
export const refreshVisual = StateEffect.define<null>();

/** Environments whose \begin/\end lines become a label (or disappear, for lists). */
const ENV_LABELS: Record<string, string> = {
  abstract: 'Abstract', figure: 'Figure', teaserfigure: 'Figure', table: 'Table', algorithm: 'Algorithm',
  theorem: 'Theorem', lemma: 'Lemma', corollary: 'Corollary', proposition: 'Proposition',
  definition: 'Definition', remark: 'Remark', example: 'Example', proof: 'Proof', claim: 'Claim',
  assumption: 'Assumption', conjecture: 'Conjecture', note: 'Note',
  quote: '', quotation: '', center: '', itemize: '', enumerate: '', description: '', algorithmic: '',
  // IEEEtran
  IEEEkeywords: 'Index Terms', IEEEproof: 'Proof', IEEEbiography: 'Biography',
  IEEEbiographynophoto: 'Biography', thebibliography: 'References',
};
const LINE_CLASS_ENVS = new Set([
  'abstract', 'figure', 'teaserfigure', 'table', 'algorithm', 'quote', 'quotation', 'center', 'verbatim', 'lstlisting',
  'theorem', 'lemma', 'corollary', 'proposition', 'definition', 'remark', 'example', 'proof', 'claim',
  'assumption', 'conjecture', 'note', 'IEEEkeywords', 'IEEEproof', 'thebibliography', 'algorithmic',
  'IEEEbiography', 'IEEEbiographynophoto',
]);
/** Environments whose first {argument} on the \begin line is shown in the label, e.g. a biography's name. */
const LABEL_FROM_ARG = new Set(['IEEEbiography', 'IEEEbiographynophoto']);

// Pseudocode (algorithmic and algpseudocode): keyword before/after the first argument.
const ALGO_WITH_ARG: Record<string, [string, string]> = {
  FOR: ['for', 'do'], For: ['for', 'do'], FORALL: ['for all', 'do'], ForAll: ['for all', 'do'],
  WHILE: ['while', 'do'], While: ['while', 'do'], IF: ['if', 'then'], If: ['if', 'then'],
  ELSIF: ['else if', 'then'], ElsIf: ['else if', 'then'], UNTIL: ['until', ''], Until: ['until', ''],
  COMMENT: ['▷', ''], Comment: ['▷', ''], FUNCTION: ['function', ''], Function: ['function', ''],
  PROCEDURE: ['procedure', ''], Procedure: ['procedure', ''],
};
const ALGO_PLAIN: Record<string, string> = {
  STATE: '', State: '', Statex: '', ENDFOR: 'end for', EndFor: 'end for', ENDWHILE: 'end while',
  EndWhile: 'end while', ENDIF: 'end if', EndIf: 'end if', ELSE: 'else', Else: 'else', LOOP: 'loop',
  Loop: 'loop', ENDLOOP: 'end loop', EndLoop: 'end loop', REPEAT: 'repeat', Repeat: 'repeat',
  RETURN: 'return', Return: 'return', REQUIRE: 'Require:', Require: 'Require:', ENSURE: 'Ensure:',
  Ensure: 'Ensure:', ENDFUNCTION: 'end function', EndFunction: 'end function',
  ENDPROCEDURE: 'end procedure', EndProcedure: 'end procedure', PRINT: 'print', TRUE: 'true',
  FALSE: 'false', AND: 'and', OR: 'or', NOT: 'not', TO: 'to',
};
const ALGO_OPEN = /^\\(FOR|FORALL|WHILE|IF|LOOP|REPEAT|FUNCTION|PROCEDURE|For|ForAll|While|If|Loop|Repeat|Function|Procedure)\b/;
const ALGO_CLOSE = /^\\(END[A-Z]*|UNTIL|End[A-Za-z]*|Until)\b/;
const ALGO_MID = /^\\(ELSE|ELSIF|Else|ElsIf)\b/;

/** Commands with an argument that only affect spacing/layout: hidden in visual mode. */
const HIDE_WITH_ARG: Record<string, string> = {
  vspace: '', 'vspace*': '', hspace: ' ', 'hspace*': ' ', IEEEauthorrefmark: '',
  // Running heads, page footers and column balancing: not part of the text being reviewed.
  markboth: '', IEEEpubid: '', IEEEtriggeratref: '', IEEEtriggercmd: '',
};
/**
 * Commands whose argument is content the class prints with the title block, e.g. IEEEtran's
 * \IEEEaftertitletext{teaser figure} or the Computer Society's abstract and index terms. They come
 * before \maketitle in the source; visual mode shows their content (editable) below the title.
 */
const TITLE_CONTENT = new Set(['IEEEaftertitletext', 'IEEEtitleabstractindextext', 'IEEEspecialpapernotice']);
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
  // Spacing and layout commands that print nothing worth showing while reviewing.
  '\\hfill': ' ', '\\vfill': '', '\\noindent': '', '\\newpage': '', '\\clearpage': '',
  '\\relax': '', '\\smallskip': '', '\\medskip': '', '\\bigskip': '', '\\protect': '',
  '\\IEEEpeerreviewmaketitle': '', '\\IEEEoverridecommandlockouts': '', '\\par': '',
  '\\IEEEdisplaynontitleabstractindextext': '', '\\IEEEpubidadjcol': '',
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

/** Remove `\cmd{...}` (balanced braces), e.g. \thanks with nested formatting. */
function removeCommand(tex: string, cmd: string): string {
  let out = tex;
  for (let i = out.indexOf(`\\${cmd}`); i >= 0; i = out.indexOf(`\\${cmd}`, i)) {
    let j = i + cmd.length + 1;
    while (/\s/.test(out[j] ?? '')) j++;
    if (out[j] !== '{') { i = j; continue; }
    let depth = 0;
    for (; j < out.length; j++) {
      if (out[j] === '\\') { j++; continue; }
      if (out[j] === '{') depth++;
      else if (out[j] === '}' && --depth === 0) break;
    }
    out = out.slice(0, i) + out.slice(j + 1);
  }
  return out;
}

/** The content of the first `\cmd{...}` in tex (balanced), or null. */
function commandArg(tex: string, cmd: string): string | null {
  const i = tex.indexOf(`\\${cmd}`);
  if (i < 0) return null;
  let j = i + cmd.length + 1;
  while (/\s/.test(tex[j] ?? '')) j++;
  if (tex[j] !== '{') return null;
  let depth = 0;
  for (let k = j; k < tex.length; k++) {
    if (tex[k] === '\\') { k++; continue; }
    if (tex[k] === '{') depth++;
    else if (tex[k] === '}' && --depth === 0) return tex.slice(j + 1, k);
  }
  return null;
}

/** Split at top-level \and (author separator). */
function splitAuthors(tex: string): string[] {
  const parts: string[] = [];
  let depth = 0;
  let start = 0;
  for (let i = 0; i < tex.length; i++) {
    const c = tex[i];
    if (c === '{') depth++;
    else if (c === '}') depth--;
    else if (c === '\\' && depth === 0 && /^\\(and|AND)\b/.test(tex.slice(i))) {
      parts.push(tex.slice(start, i));
      start = i + 4;
    } else if (c === '\\') i++;
  }
  parts.push(tex.slice(start));
  return parts.map((p) => p.trim()).filter(Boolean);
}

/** Authors for the title block; understands IEEE \IEEEauthorblockN / \IEEEauthorblockA. */
function parseAuthors(tex: string): TitleAuthor[] {
  return splitAuthors(removeCommand(tex, 'thanks')).map((part) => {
    const name = commandArg(part, 'IEEEauthorblockN');
    const affil = commandArg(part, 'IEEEauthorblockA');
    if (name === null) return { name: plainText(part), lines: [] };
    return {
      name: plainText(name, ' '),
      lines: (affil ?? '').split(/\\\\(?:\[[^\]]*\])?/).map((l) => plainText(l)).filter(Boolean),
    };
  });
}

/** Strip LaTeX markup down to readable text. `lineBreak` replaces \\ (title: a real newline). */
function plainText(tex: string, lineBreak = ', '): string {
  return removeCommand(tex, 'thanks')
    .replace(/\\textsuperscript\s*\{([^{}]*)\}/g, '$1')
    .replace(/\\today\b/g, new Date().toLocaleDateString(undefined, { year: 'numeric', month: 'long', day: 'numeric' }))
    .replace(/\\\\(\[[^\]]*\])?/g, '\u0000')
    .replace(/\\(?:and|AND)\b/g, ' · ')
    .replace(/\\([%&_#$])/g, '$1')
    .replace(/\\[a-zA-Z@]+\*?\s*(\[[^\]]*\])?/g, '')
    .replace(/[{}~]/g, (c) => (c === '~' ? ' ' : ''))
    .replace(/[ \t\n]+/g, ' ')
    .replace(/\s*\u0000\s*/g, lineBreak)
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

// ---------- paragraph flow ----------
// LaTeX treats a single newline as a space; only blank lines (or \\, \par) end a paragraph. Visual
// mode shows such "soft" line breaks as spaces, so paragraphs flow like in the PDF. These lines keep
// their own line: they start something structural, or are line-oriented content.
const STRUCT_LINE = /^\s*(?:%|\\\[|\\\]|\$\$|\\(?:begin|end|item|bibitem|(?:sub)*section|chapter|part|paragraph|subparagraph|caption|label|includegraphics|centering|maketitle|input|include|bibliography|bibliographystyle|newpage|clearpage|appendix|appendices|vspace|par|noindent|toprule|midrule|bottomrule|hline|title|author|date|documentclass|usepackage)\b)/;
const HARD_END = /(?:\\\\(?:\s*\[[^\]]*\])?|\\par|\\newline|\\linebreak)\s*$/;
const HAS_COMMENT = /(^|[^\\])%/;
const LINE_ENVS = new Set([
  'verbatim', 'lstlisting', 'minted', 'tabular', 'tabularx', 'tabular*', 'longtable', 'array', 'algorithmic',
  'tikzpicture', 'equation', 'equation*', 'align', 'align*', 'gather', 'gather*', 'multline', 'multline*',
  'eqnarray', 'eqnarray*', 'IEEEeqnarray', 'IEEEeqnarray*', 'displaymath', 'flalign', 'flalign*',
]);
const LINE_NODES = new Set(['EquationEnvironment', 'EquationArrayEnvironment', 'VerbatimEnvironment', 'TabularEnvironment', 'TikzPictureEnvironment']);

/** Line numbers inside line-oriented content (display math, tables, pseudocode, verbatim). */
function lineOrientedLines(state: EditorState, tree: Tree): Set<number> {
  const lines = new Set<number>();
  tree.iterate({
    enter(n) {
      const env = n.type.is('$Environment') ? envNameOf(n.node, state) : null;
      const display = n.type.is('$MathContainer') && (n.name === 'BracketMath' || !!n.node.getChild('DisplayMath'));
      if (LINE_NODES.has(n.name) || display || (env && LINE_ENVS.has(env))) {
        for (let k = state.doc.lineAt(n.from).number, end = state.doc.lineAt(n.to).number; k <= end; k++) lines.add(k);
        return false;
      }
    },
  });
  return lines;
}

/** Where the document body starts (after \begin{document}), or 0 for an included file. */
function bodyStart(state: EditorState, tree: Tree): number {
  let start = 0;
  tree.iterate({
    enter(n) {
      if (n.name === 'DocumentEnvironment') { start = n.node.getChild('Content')?.from ?? n.to; return false; }
      return n.name === 'LaTeX' || n.name === 'Text' || n.name === 'KnownEnvironment';
    },
  });
  return start;
}

/** True if line n is ordinary paragraph text (it may flow into its neighbours). */
function isProseLine(state: EditorState, n: number, excluded: Set<number>, body: number): boolean {
  const line = state.doc.line(n);
  return line.from >= body && !!line.text.trim() && !excluded.has(n) && !STRUCT_LINE.test(line.text);
}

/**
 * Enter in visual mode: a single newline would be invisible (it flows into a space), so inside a
 * paragraph Enter starts a new paragraph (a blank line), like a word processor. Elsewhere it does
 * the normal thing.
 */
export function enterNewParagraph(view: EditorView): boolean {
  const { state } = view;
  const r = state.selection.main;
  if (!r.empty) return false;
  const tree = syntaxTree(state);
  const n = state.doc.lineAt(r.head).number;
  if (!isProseLine(state, n, lineOrientedLines(state, tree), bodyStart(state, tree))) return false;
  // Swallow spaces around the cursor so neither paragraph keeps a stray one at its edge.
  const line = state.doc.line(n);
  let from = r.head;
  let to = r.head;
  while (from > line.from && state.sliceDoc(from - 1, from) === ' ') from--;
  while (to < line.to && state.sliceDoc(to, to + 1) === ' ') to++;
  view.dispatch({
    changes: { from, to, insert: '\n\n' },
    selection: { anchor: from + 2 },
    scrollIntoView: true,
    userEvent: 'input',
  });
  return true;
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
  const unwrappedClose = new Set<number>(); // closing braces hidden by unwrapArg
  const replaceLines = (node: SyntaxNode, widget: EnvLineWidget | TitleWidget) => {
    // A hidden closing brace may follow, as in `\end{IEEEkeywords}}`.
    const rest = state.sliceDoc(node.to, doc.lineAt(node.to).to);
    const closer = /^\s*\}\s*$/.test(rest) && unwrappedClose.has(node.to + rest.indexOf('}'));
    if ((!aloneOnLines(state, node) && !(closer && !state.sliceDoc(doc.lineAt(node.from).from, node.from).trim())) || touchesLines(node.from, node.to)) return false;
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

  /**
   * Hide `\cmd{` and `}` around an argument whose content shows as part of the document. On lines
   * of their own, those lines disappear (unless the cursor is on them).
   */
  const unwrapArg = (node: SyntaxNode, arg: SyntaxNode) => {
    const open = arg.getChild('OpenBrace');
    const close = arg.getChild('CloseBrace');
    if (!open || !close) return;
    const blank = (from: number, to: number) => !state.sliceDoc(from, to).replace(/(^|[^\\])%.*$/, '$1').trim();
    const part = (from: number, to: number) => {
      const a = doc.lineAt(from), b = doc.lineAt(to);
      if (a.number !== b.number) return hide(from, to);
      if (blank(a.from, from) && blank(to, a.to)) {
        if (!touchesLines(from, to)) atomic.push(Decoration.replace({ widget: new EnvLineWidget('hidden'), block: true }).range(a.from, a.to));
      } else if (!touches(from, to)) hide(from, to);
    };
    unwrappedClose.add(close.from);
    part(node.from, open.to);
    part(close.from, close.to);
  };

  /** Like replaceLines for a \begin line, but also allows a trailing \label{..} (shown as a tag). */
  const replaceBeginLine = (begin: SyntaxNode, widget: (tag: string) => EnvLineWidget) => {
    const line = doc.lineAt(begin.from);
    const endLine = doc.lineAt(begin.to);
    if (state.sliceDoc(line.from, begin.from).trim() || touchesLines(begin.from, begin.to)) return false;
    const rest = state.sliceDoc(begin.to, endLine.to);
    const m = /^\s*(?:\\label\s*\{([^}]*)\})?\s*(?:%.*)?$/.exec(rest);
    if (!m) return false;
    atomic.push(Decoration.replace({ widget: widget(m[1] ? `#${m[1]}` : ''), block: true }).range(line.from, endLine.to));
    return true;
  };

  /** Indent pseudocode lines by nesting level (for/while/if ... end). */
  const indentPseudocode = (from: number, to: number) => {
    let depth = 0;
    for (let n = doc.lineAt(from).number + 1, last = doc.lineAt(to).number; n < last; n++) {
      const text = doc.line(n).text.trimStart();
      if (ALGO_CLOSE.test(text) || ALGO_MID.test(text)) depth = Math.max(0, depth - 1);
      if (depth) addLineClass(doc.line(n).from, doc.line(n).from, `vc-algo-${Math.min(depth, 6)}`);
      if (ALGO_OPEN.test(text) || ALGO_MID.test(text)) depth++;
    }
  };

  /** Replace a simple tabular with a rendered table; false if it can't be parsed (source stays). */
  const renderTable = (node: SyntaxNode, begin: SyntaxNode, end: SyntaxNode) => {
    if (!aloneOnLines(state, node) || touchesLines(node.from, node.to)) return false;
    // The column spec is the last {..} group right after \begin{tabular} (tabularx has a width first).
    const after = state.sliceDoc(begin.from, Math.min(end.from, begin.from + 400)).replace(/^\\begin\s*\{[^}]*\}/, '');
    const groups = /^(\s*\{(?:[^{}]|\{[^{}]*\})*\})(\s*\{(?:[^{}]|\{[^{}]*\})*\})?/.exec(after);
    if (!groups) return false;
    const envName = envNameOf(node, state) ?? 'tabular';
    const specGroup = envName === 'tabularx' && groups[2] ? groups[2] : groups[1];
    const consumed = envName === 'tabularx' && groups[2] ? groups[0] : groups[1];
    const spec = specGroup.trim().slice(1, -1);
    const bodyStart = begin.from + state.sliceDoc(begin.from, begin.to).match(/^\\begin\s*\{[^}]*\}/)![0].length + consumed.length;
    const table = parseTabular(spec, state.sliceDoc(bodyStart, end.from));
    if (!table) return false;
    atomic.push(Decoration.replace({
      widget: new TableWidget(table, state.sliceDoc(node.from, node.to), macros.key, macros.macros), block: true,
    }).range(doc.lineAt(node.from).from, doc.lineAt(node.to).to));
    return true;
  };

  let preamble: { to: number } | null = null;
  let maketitleSeen = false;
  let titleContentAt = -1; // start of the first title-block content before \maketitle (TITLE_CONTENT, teaserfigure)
  const titleParts = { title: '', authors: [] as TitleAuthor[], date: '' };
  let skipUntil = -1; // nodes inside a range already replaced (e.g. \hskip glue ... \relax)
  let algoDepth = 0; // inside algorithmic environments
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
      if (node.to <= skipUntil) return false;
      if (name === 'Title' || name === 'Author' || name === 'Date') {
        // Drop TeX comments first (IEEE templates put `% <-this % stops a space` inside \author).
        const raw = argText(node.getChild('TextArgument') ?? node.getChild('ShortTextArgument')).replace(/(^|[^\\])%.*$/gm, '$1');
        if (name === 'Title') titleParts.title = plainText(raw, '\n');
        else if (name === 'Author') titleParts.authors.push(...parseAuthors(raw));
        else titleParts.date = plainText(raw);
        return false;
      }
      if (name === 'Maketitle') {
        // Like Overleaf: \title, \author etc. placed after \begin{document} (as IEEE templates do)
        // join the collapsed preamble, since the title block shows them. Content the class prints
        // with the title (\IEEEaftertitletext, a teaser figure) stays out of it, below the title.
        const pre = preamble as { to: number } | null;
        const extra = !maketitleSeen && pre && titleContentAt > pre.to ? titleContentAt : -1;
        if (pre && !maketitleSeen && node.from > pre.to) {
          const lineBefore = doc.lineAt(extra >= 0 ? extra : node.from).number - 1;
          if (lineBefore >= 1) pre.to = Math.max(pre.to, doc.line(lineBefore).to);
        }
        maketitleSeen = true;
        const title = new TitleWidget(titleParts.title, titleParts.authors, titleParts.date);
        if (extra >= 0) {
          atomic.push(Decoration.widget({ widget: title, block: true, side: -1 }).range(doc.lineAt(extra).from));
          replaceLines(node, new EnvLineWidget('hidden'));
        } else replaceLines(node, title);
        return false;
      }
      if (!maketitleSeen && titleContentAt < 0 && name.endsWith('Environment') && envNameOf(node, state) === 'teaserfigure') {
        titleContentAt = node.from;
      }
      if (name === 'Comment') {
        if (node.to > node.from) marks.push(Decoration.mark({ class: 'vc-comment' }).range(node.from, node.to));
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
        if (env === 'algorithmic') {
          algoDepth++;
          indentPseudocode(begin.to, end.from);
        }
        if (name === 'TabularEnvironment' || env === 'tabular' || env === 'tabularx') {
          if (renderTable(node, begin, end)) return false;
        }
        if (env in ENV_LABELS) {
          const label = ENV_LABELS[env];
          const opt = begin.getChild('OptionalArgument');
          let extra = '';
          if (LABEL_FROM_ARG.has(env)) extra = `: ${plainText(argText(begin.getChild('TextArgument')))}`;
          else if (opt && label && !/^(figure|table|algorithm|thebibliography)$/.test(env)) extra = ` (${plainText(argText(opt))})`;
          replaceBeginLine(begin, label ? (tag) => new EnvLineWidget('begin', label + extra, tag) : () => new EnvLineWidget('hidden'));
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
        // On its own line: show the included file's content right below, as a nested editor.
        if (file && aloneOnLines(state, node)) {
          atomic.push(Decoration.widget({ widget: new IncludeWidget(path), block: true, side: 1 }).range(doc.lineAt(node.to).to));
        }
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
          } else if (review.kind === 'note' && review.quote && !editing) {
            // \note[text]{XL}{..}: the text reads on as part of the paper, the note follows it.
            hide(review.from, review.quote.from);
            hide(review.quote.to, review.to);
            atomic.push(Decoration.widget({ widget: new CommentWidget(review.note, review.author, 'note'), side: 1 }).range(review.to));
          } else if (review.kind === 'note' && !editing) {
            atomic.push(Decoration.replace({ widget: new CommentWidget(review.note, review.author, 'note') }).range(review.from, review.to));
          }
          if (editing) {
            atomic.push(Decoration.widget({ widget: new ReviewActionsWidget(review.from, review.kind), side: 2 }).range(review.to));
          }
          return (review.kind === 'comment' || (review.kind === 'note' && !review.quote)) && !editing ? false : undefined;
        }
        const ctrl = node.firstChild;
        if (!ctrl) return;
        const cmd = state.sliceDoc(ctrl.from + 1, ctrl.to);
        const args = node.getChildren('TextArgument');
        const brace = (a: SyntaxNode, which: 'OpenBrace' | 'CloseBrace') => a.getChild(which);

        // Pseudocode keywords (always rendered, like list bullets).
        if (algoDepth > 0 && cmd in ALGO_PLAIN && !args.length) {
          const kw = ALGO_PLAIN[cmd];
          atomic.push(Decoration.replace({ widget: new TextWidget(kw ? `${kw} ` : '', 'vc-algo-kw') }).range(node.from, node.to));
          return false;
        }
        if (algoDepth > 0 && cmd in ALGO_WITH_ARG && args.length) {
          const [pre, post] = ALGO_WITH_ARG[cmd];
          const open = brace(args[0], 'OpenBrace');
          const last = args[args.length - 1];
          const close = brace(last, 'CloseBrace');
          if (open && close) {
            const cls = cmd.toLowerCase() === 'comment' ? 'vc-algo-comment' : 'vc-algo-kw';
            atomic.push(Decoration.replace({ widget: new TextWidget(`${pre} `, cls) }).range(node.from, open.to));
            if (args.length === 2) { // \Function{name}{args} -> name(args)
              const c0 = brace(args[0], 'CloseBrace');
              const o1 = brace(args[1], 'OpenBrace');
              if (c0 && o1) hide(c0.from, o1.to, '(');
              atomic.push(Decoration.replace({ widget: new TextWidget(post ? `) ${post}` : ')', 'vc-algo-kw') }).range(close.from, close.to));
            } else {
              atomic.push(Decoration.replace({ widget: new TextWidget(post ? ` ${post}` : '', 'vc-algo-kw') }).range(close.from, close.to));
            }
          }
          return;
        }

        // IEEE drop cap: \IEEEPARstart{D}{eep}
        if (cmd === 'IEEEPARstart' && args.length === 2) {
          if (touches(node.from, node.to)) return;
          const [a, b] = args;
          const ao = brace(a, 'OpenBrace'), ac = brace(a, 'CloseBrace'), bo = brace(b, 'OpenBrace'), bc = brace(b, 'CloseBrace');
          if (!ao || !ac || !bo || !bc) return;
          hide(node.from, ao.to);
          hide(ac.from, bo.to);
          hide(bc.from, node.to);
          if (ac.from > ao.to) marks.push(Decoration.mark({ class: 'vc-dropcap' }).range(ao.to, ac.from));
          if (bc.from > bo.to) marks.push(Decoration.mark({ class: 'vc-parstart-rest' }).range(bo.to, bc.from));
          return;
        }
        // algpseudocode's \Call{Name}{args} in text: Name(args), with the name in small caps.
        if (cmd === 'Call' && args.length === 2) {
          if (touches(node.from, node.to)) return;
          const [a, b] = args;
          const ao = brace(a, 'OpenBrace'), ac = brace(a, 'CloseBrace'), bo = brace(b, 'OpenBrace'), bc = brace(b, 'CloseBrace');
          if (!ao || !ac || !bo || !bc) return;
          hide(node.from, ao.to);
          atomic.push(Decoration.replace({ widget: new TextWidget('(', 'vc-symbol') }).range(ac.from, bo.to));
          atomic.push(Decoration.replace({ widget: new TextWidget(')', 'vc-symbol') }).range(bc.from, node.to));
          if (ac.from > ao.to) marks.push(Decoration.mark({ class: 'vc-fmt-sc' }).range(ao.to, ac.from));
          return;
        }
        if (cmd === 'bibitem' && args.length) {
          if (!touches(node.from, node.to)) {
            atomic.push(Decoration.replace({ widget: new ChipWidget('cite', `[${argText(args[args.length - 1])}]`) }).range(node.from, node.to));
          }
          return false;
        }
        if (cmd === 'appendices' && !args.length) {
          if (aloneOnLines(state, node)) replaceLines(node, new EnvLineWidget('begin', 'Appendices'));
          return false;
        }
        if (TITLE_CONTENT.has(cmd) && args.length === 1) {
          if (!maketitleSeen && titleContentAt < 0) titleContentAt = node.from;
          unwrapArg(node, args[0]);
          return; // the content renders as usual
        }
        if (cmd in HIDE_WITH_ARG && args.length) {
          if (!touches(node.from, node.to)) atomic.push(Decoration.replace({ widget: new TextWidget(HIDE_WITH_ARG[cmd]) }).range(node.from, node.to));
          return false;
        }
        // \hskip 1em plus 0.5em minus 0.4em\relax (IEEE bibliographies): hide the glue too.
        if ((cmd === 'hskip' || cmd === 'vskip') && !args.length) {
          const glue = /^\s*-?[\d.]+\s*(?:em|ex|pt|cm|mm|in|bp|sp|mu)(?:\s+plus\s+-?[\d.]+\s*\w+)?(?:\s+minus\s+-?[\d.]+\s*\w+)?\s*(?:\\relax\b\s?)?/
            .exec(state.sliceDoc(ctrl.to, Math.min(doc.length, ctrl.to + 80)));
          const to = ctrl.to + (glue?.[0].length ?? 0);
          if (!touches(ctrl.from, to)) {
            atomic.push(Decoration.replace({ widget: new TextWidget(cmd === 'hskip' ? ' ' : '') }).range(ctrl.from, to));
            skipUntil = to;
          }
          return false;
        }
        if (ctrl.nextSibling) return; // other commands with arguments: leave as source
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
        if (env === 'algorithmic') algoDepth--;
      }
    },
  });

  for (const { from, to, depth } of listLines) addLineClass(from, to, `vc-list-${Math.min(depth, 4)}`);

  // Fold runs of 4+ whole-line comments (templates are full of them) until the cursor enters.
  const isComment = (k: number) => {
    const line = doc.line(k);
    const indent = line.text.length - line.text.trimStart().length;
    return line.text.trimStart().startsWith('%') && tree.resolveInner(line.from + indent, 1).name === 'Comment';
  };
  for (let n = 1; n <= doc.lines; n++) {
    if (!isComment(n)) continue;
    let m = n;
    while (m < doc.lines && isComment(m + 1)) m++;
    if (m - n + 1 >= 4) {
      const from = doc.line(n).from;
      const to = doc.line(m).to;
      if (!touches(from, to)) {
        let preview = '';
        for (let k = n; k <= m && !preview; k++) preview = doc.line(k).text.replace(/^\s*%+\s*/, '').slice(0, 60);
        atomic.push(Decoration.replace({ widget: new CommentFoldWidget(m - n + 1, preview), block: true }).range(from, to));
        for (const start of [...lineClass.keys()]) if (start >= from && start <= to) lineClass.delete(start);
      }
    }
    n = m;
  }

  // Flow paragraphs: show soft line breaks (single newlines between prose lines) as spaces.
  {
    const excluded = lineOrientedLines(state, tree);
    const body = Math.max(bodyStart(state, tree), (preamble as { to: number } | null)?.to ?? 0);
    const blockLines = new Set<number>();
    const inline: { from: number; to: number }[] = [];
    for (const r of atomic) {
      if (r.value.spec.block) {
        for (let k = doc.lineAt(r.from).number, end = doc.lineAt(r.to).number; k <= end; k++) blockLines.add(k);
      } else if (r.to > r.from) inline.push({ from: r.from, to: r.to });
    }
    inline.sort((a, b) => a.from - b.from);
    let j = 0;
    const firstLine = doc.lineAt(Math.min(body, doc.length)).number;
    for (let n = firstLine; n < doc.lines; n++) {
      if (blockLines.has(n) || blockLines.has(n + 1)) continue;
      if (!isProseLine(state, n, excluded, body) || !isProseLine(state, n + 1, excluded, body)) continue;
      const a = doc.line(n);
      const b = doc.line(n + 1);
      if (HARD_END.test(a.text) || HAS_COMMENT.test(a.text)) continue;
      // Skip if the line break is already inside something replaced (e.g. inline math spanning lines).
      while (j < inline.length && inline[j].to <= a.to) j++;
      if (j < inline.length && inline[j].from <= a.to) continue;
      const from = a.from + a.text.trimEnd().length;
      const to = b.from + (b.text.length - b.text.trimStart().length);
      atomic.push(Decoration.replace({ widget: new TextWidget(' ', 'vc-softbreak') }).range(from, to));
    }
  }

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
    const macroChanged = tr.startState.facet(noteMacroFacet) !== tr.state.facet(noteMacroFacet)
      || tr.effects.some((e) => e.is(refreshVisual));
    if (tree !== value.tree || tr.selection || tr.docChanged || mouseReleased || macroChanged) {
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
