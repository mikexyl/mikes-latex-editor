// "Join lines": joins the source lines of a sentence that was broken over several lines (hard
// wrapping) back into one line. LaTeX treats a single line break as a space, so the PDF doesn't
// change. Lines are only joined where that's certain to be safe and is in the middle of a sentence:
// a line that ends a sentence stays the end of its line (one sentence per line is kept), and
// comments, \\ breaks, environments' \begin / \end, headings, \item, display math, the preamble and
// environments where line breaks matter (verbatim, code, tables, TikZ, algorithms) are left alone.

export type Join = { from: number; to: number; insert: string };

// Commands that start a line of their own (structure, not running text).
const BLOCK = new RegExp('^\\\\(?:' + [
  'begin', 'end', 'item', 'part', 'chapter', '(?:sub)*section', '(?:sub)?paragraph', 'label',
  'centering', 'raggedright', 'raggedleft', 'includegraphics', 'input', 'include', 'subfile',
  'bibliography', 'bibliographystyle', 'printbibliography', 'addbibresource', 'nocite',
  'usepackage', 'documentclass', 'maketitle', 'title', 'author', 'date', 'newcommand',
  'renewcommand', 'providecommand', 'newenvironment', 'renewenvironment', 'def', 'let',
  'DeclareMathOperator', 'newtheorem', 'setlength', 'addtolength', 'setcounter',
  'hline', 'toprule', 'midrule', 'bottomrule', 'cline', 'cmidrule', 'addlinespace',
  'vspace', 'vskip', 'smallskip', 'medskip', 'bigskip', 'newpage', 'clearpage',
  'cleardoublepage', 'pagebreak', 'appendix', 'tableofcontents', 'listoffigures',
  'tiny', 'scriptsize', 'footnotesize', 'small', 'normalsize', 'large', 'Large', 'LARGE',
].join('|') + ')(?![a-zA-Z])');

// Environments whose lines are left exactly as they are.
const KEEP_ENVS = new Set([
  'verbatim', 'Verbatim', 'lstlisting', 'minted', 'comment', 'filecontents', 'tikzpicture',
  'algorithmic', 'algorithmicx', 'algorithm2e', 'tabular', 'tabular*', 'tabularx', 'tabulary',
  'longtable', 'array', 'align', 'align*', 'alignat', 'alignat*', 'gather', 'gather*',
  'multline', 'multline*', 'eqnarray', 'eqnarray*', 'flalign', 'flalign*', 'split', 'cases',
  'matrix', 'pmatrix', 'bmatrix', 'thebibliography',
]);

const COMMENT = /(?:^|[^\\])(?:\\\\)*%/;
const SENTENCE_END = /[.!?][)\]}'"’”]*$/;
const LINE_BREAK = /(?:\\\\\*?(?:\s*\[[^\]]*\])?|\\newline|\\par|\\linebreak(?:\[\d\])?)$/;
const DISPLAY_MATH = /^(?:\\\[|\\\]|\$\$)|(?:\\\[|\\\]|\$\$)$/;
const ENV = /\\(begin|end)\s*\{([^}]*)\}/g;

/** A line the next line mustn't be joined onto. */
function endsHere(t: string): boolean {
  return !t || COMMENT.test(t) || SENTENCE_END.test(t) || LINE_BREAK.test(t) || DISPLAY_MATH.test(t)
    || /\\(?:begin|end)\s*\{/.test(t) || (BLOCK.test(t) && !/^\\item(?![a-zA-Z])/.test(t));
}

/** A line that mustn't be joined onto the previous one. */
function startsHere(t: string): boolean {
  return !t || t.startsWith('%') || BLOCK.test(t) || DISPLAY_MATH.test(t) || /\\(?:begin|end)\s*\{/.test(t);
}

/**
 * The joins for `text`, as changes (each replaces one line break and the spaces around it with a
 * space). Only line breaks between `from` and `to` are joined (the whole text by default).
 */
export function joinLines(text: string, from = 0, to = text.length): Join[] {
  const lines: { from: number; text: string }[] = [];
  for (let pos = 0; ;) {
    const nl = text.indexOf('\n', pos);
    lines.push({ from: pos, text: text.slice(pos, nl < 0 ? text.length : nl) });
    if (nl < 0) break;
    pos = nl + 1;
  }
  // The preamble is left alone: start after \begin{document}, if the file has one.
  let start = 0;
  const doc = lines.findIndex((l) => /^[^%]*\\begin\s*\{document\}/.test(l.text));
  if (doc >= 0) start = doc + 1;

  const joins: Join[] = [];
  let keep = 0; // depth inside environments in KEEP_ENVS
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const keptBefore = keep > 0;
    for (const m of line.text.replace(/(?:^|[^\\])(?:\\\\)*%.*$/, '').matchAll(ENV)) {
      if (!KEEP_ENVS.has(m[2].trim())) continue;
      keep = Math.max(0, keep + (m[1] === 'begin' ? 1 : -1));
    }
    if (i < start || i + 1 >= lines.length || keptBefore || keep > 0) continue;
    const next = lines[i + 1];
    const nl = line.from + line.text.length; // the line break
    if (nl < from || nl >= to) continue;
    const cur = line.text.trim();
    const following = next.text.trim();
    if (endsHere(cur) || startsHere(following)) continue;
    const end = line.from + line.text.trimEnd().length;
    const begin = next.from + (next.text.length - next.text.trimStart().length);
    joins.push({ from: end, to: begin, insert: ' ' });
  }
  return joins;
}
