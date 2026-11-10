// Renders simple `tabular` environments as HTML tables in visual mode: rows split on \\, cells on
// &, booktabs/\hline rules, \multicolumn, bold/italic text and inline math. Anything it can't
// parse confidently returns null, and the source stays visible instead.
import { WidgetType } from '@codemirror/view';
import katex from 'katex';
import type { Macros } from './math.ts';

type Cell = { tex: string; span: number; align: string | null };
type Row = { cells: Cell[]; ruleAbove: 'thick' | 'thin' | null };
export type Table = { aligns: string[]; rows: Row[]; ruleBelow: 'thick' | 'thin' | null };

/** Split on a separator at brace depth 0, ignoring escaped characters. */
function splitTop(text: string, sep: RegExp): string[] {
  const out: string[] = [];
  let depth = 0;
  let start = 0;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (c === '\\') {
      if (depth === 0) {
        sep.lastIndex = i;
        const m = sep.exec(text);
        if (m && m.index === i) { out.push(text.slice(start, i)); start = i + m[0].length; i = start - 1; continue; }
      }
      i++;
      continue;
    }
    if (c === '{') depth++;
    else if (c === '}') depth--;
    else if (depth === 0) {
      sep.lastIndex = i;
      const m = sep.exec(text);
      if (m && m.index === i) { out.push(text.slice(start, i)); start = i + m[0].length; i = start - 1; }
    }
  }
  out.push(text.slice(start));
  return out;
}

function parseAligns(spec: string): string[] | null {
  const aligns: string[] = [];
  const s = spec.replace(/@\{[^}]*\}|!\{[^}]*\}|>\{[^}]*\}|<\{[^}]*\}|\|/g, '');
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (c === 'l' || c === 'c' || c === 'r') aligns.push(c);
    else if (c === 'p' || c === 'm' || c === 'b' || c === 'X') { aligns.push('l'); if (s[i + 1] === '{') i = s.indexOf('}', i); }
    else if (c === 'S') aligns.push('c');
    else if (c === '*') {
      const m = /^\*\{(\d+)\}\{([^}]*)\}/.exec(s.slice(i));
      if (!m) return null;
      const inner = parseAligns(m[2]);
      if (!inner) return null;
      for (let k = 0; k < Number(m[1]); k++) aligns.push(...inner);
      i += m[0].length - 1;
    } else if (!/\s/.test(c)) return null;
  }
  return aligns.length ? aligns : null;
}

const RULE = /^\s*\\(toprule|midrule|bottomrule|hline|cline\s*\{[^}]*\}|cmidrule(\([^)]*\))?\s*\{[^}]*\}|specialrule\s*\{[^}]*\}\s*\{[^}]*\}\s*\{[^}]*\})\s*/;

export function parseTabular(spec: string, body: string): Table | null {
  const aligns = parseAligns(spec);
  if (!aligns) return null;
  const text = body.replace(/(^|[^\\])%.*$/gm, '$1');
  if (/\\begin\{/.test(text)) return null; // nested environments: leave as source
  const rawRows = splitTop(text, /\\\\(\s*\[[^\]]*\])?/y);
  const rows: Row[] = [];
  let pendingRule: Row['ruleAbove'] = null;
  for (let raw of rawRows) {
    // Leading rules belong between rows.
    let m: RegExpExecArray | null;
    while ((m = RULE.exec(raw))) {
      pendingRule = /toprule|bottomrule|specialrule/.test(m[1]) ? 'thick' : 'thin';
      raw = raw.slice(m[0].length);
    }
    if (!raw.trim()) continue;
    const cells: Cell[] = splitTop(raw, /&/y).map((c) => {
      const mc = /^\s*\\multicolumn\s*\{(\d+)\}\s*\{([^}]*)\}\s*\{([\s\S]*)\}\s*$/.exec(c);
      if (mc) return { tex: mc[3].trim(), span: Number(mc[1]), align: parseAligns(mc[2])?.[0] ?? null };
      return { tex: c.trim(), span: 1, align: null };
    });
    rows.push({ cells, ruleAbove: pendingRule });
    pendingRule = null;
  }
  if (!rows.length) return null;
  const width = Math.max(...rows.map((r) => r.cells.reduce((n, c) => n + c.span, 0)));
  if (width > aligns.length + 1) return null;
  return { aligns, rows, ruleBelow: pendingRule };
}

/** Cell LaTeX -> DOM: inline math via KaTeX, \textbf/\textit/\emph, everything else as text. */
function renderCell(target: HTMLElement, tex: string, macros: Macros) {
  const parts = tex.split(/(\$[^$]+\$)/);
  for (const part of parts) {
    if (part.startsWith('$') && part.endsWith('$') && part.length > 1) {
      const span = document.createElement('span');
      try { katex.render(part.slice(1, -1), span, { throwOnError: false, strict: 'ignore', macros: { ...macros } }); }
      catch { span.textContent = part; }
      target.append(span);
      continue;
    }
    let rest = part;
    const fmt = /\\(textbf|textit|emph|underline|texttt)\s*\{([^{}]*)\}/;
    let m: RegExpExecArray | null;
    while ((m = fmt.exec(rest))) {
      target.append(plain(rest.slice(0, m.index)));
      const tag = m[1] === 'textbf' ? 'b' : m[1] === 'underline' ? 'u' : m[1] === 'texttt' ? 'code' : 'i';
      const e = document.createElement(tag);
      e.textContent = plain(m[2]);
      target.append(e);
      rest = rest.slice(m.index + m[0].length);
    }
    target.append(plain(rest));
  }
}

function plain(tex: string): string {
  return tex
    .replace(/\\([%&_#$])/g, '$1')
    .replace(/~/g, ' ')
    .replace(/\\(?:bf|it|em|centering|raggedright|raggedleft)\b\s*/g, '')
    .replace(/\\[a-zA-Z@]+\*?\s*(\[[^\]]*\])?/g, '')
    .replace(/[{}]/g, '');
}

export class TableWidget extends WidgetType {
  constructor(readonly table: Table, readonly key: string, readonly macrosKey: string, readonly macros: Macros) { super(); }
  eq(o: TableWidget) { return o.key === this.key && o.macrosKey === this.macrosKey; }
  toDOM() {
    const wrap = document.createElement('div');
    wrap.className = 'vc-table-wrap';
    const t = document.createElement('table');
    t.className = 'vc-table';
    const { rows, aligns, ruleBelow } = this.table;
    rows.forEach((row, i) => {
      const tr = document.createElement('tr');
      if (row.ruleAbove) tr.classList.add(`rule-above-${row.ruleAbove}`);
      if (i === rows.length - 1 && ruleBelow) tr.classList.add(`rule-below-${ruleBelow}`);
      let col = 0;
      for (const cell of row.cells) {
        const td = document.createElement('td');
        if (cell.span > 1) td.colSpan = cell.span;
        const a = cell.align ?? aligns[col] ?? 'l';
        td.style.textAlign = a === 'r' ? 'right' : a === 'c' ? 'center' : 'left';
        renderCell(td, cell.tex, this.macros);
        tr.append(td);
        col += cell.span;
      }
      t.append(tr);
    });
    wrap.append(t);
    return wrap;
  }
  ignoreEvent() { return false; }
}
