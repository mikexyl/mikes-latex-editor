// The table editor's model: a tabular environment's source split into its column spec, rows and
// cells, edited (cells, rows, columns, alignment) and written back. Unchanged rows are written back
// exactly as they were, so a small edit makes a small diff; rules (\toprule, \hline, …) and comment
// lines between rows stay where they are.

export const TABULAR_ENVS = ['tabular', 'tabular*', 'tabularx', 'tabulary', 'longtable'];

/** A column in the spec: its text (with any >{..} before and <{..} after it) and alignment. */
type ColumnToken = { kind: 'col'; raw: string; align: 'l' | 'c' | 'r' | null };
/** Anything between columns: |, @{..}, !{..}, whitespace. */
type SepToken = { kind: 'sep'; raw: string };
type SpecToken = ColumnToken | SepToken;

export type EditCell = {
  tex: string;
  span: number;
  /** \multicolumn{n}{spec}{..}: the column spec of the merged cell. */
  mcSpec?: string;
};

export type EditRow = {
  /** Text before the first cell: line break, indentation, rules and comment lines. */
  prefix: string;
  cells: EditCell[];
  /** The original text of the cells (written back as is unless the row changed). */
  raw: string;
  /** \\ (with any [2pt]) ending the row, or '' for a last row without one. */
  end: string;
  dirty: boolean;
};

export type EditTable = {
  env: string;
  /** Source up to and including the spec's `{`. */
  head: string;
  spec: SpecToken[] | null; // null: a spec this editor can't take apart (columns can't be added then)
  specRaw: string;
  specDirty: boolean;
  /** Source from the spec's `}` to the start of the body. */
  mid: string;
  rows: EditRow[];
  /** Text after the last row's \\ (e.g. \bottomrule), up to \end{..}. */
  tail: string;
  /** `\end{tabular}` and anything after it. */
  foot: string;
};

/** Index just past the balanced {...} group that opens at text[open], or -1. */
function groupEnd(text: string, open: number): number {
  if (text[open] !== '{') return -1;
  let depth = 0;
  for (let i = open; i < text.length; i++) {
    const c = text[i];
    if (c === '\\') { i++; continue; }
    if (c === '%') { while (i < text.length && text[i] !== '\n') i++; continue; }
    if (c === '{') depth++;
    else if (c === '}' && --depth === 0) return i + 1;
  }
  return -1;
}

/**
 * Split at top-level separators (brace depth 0), skipping escapes and comments. Returns the pieces
 * and the separators between them.
 */
function split(text: string, sep: RegExp): { parts: string[]; seps: string[] } {
  const parts: string[] = [];
  const seps: string[] = [];
  let depth = 0;
  let start = 0;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (c === '%') { while (i < text.length && text[i] !== '\n') i++; continue; }
    if (depth === 0) {
      sep.lastIndex = i;
      const m = sep.exec(text);
      if (m && m.index === i && m[0]) {
        parts.push(text.slice(start, i));
        seps.push(m[0]);
        start = i + m[0].length;
        i = start - 1;
        continue;
      }
    }
    if (c === '\\') { i++; continue; }
    if (c === '{') depth++;
    else if (c === '}') depth--;
  }
  parts.push(text.slice(start));
  return { parts, seps };
}

const ROW_END = /\\\\\*?(?:\s*\[[^\]]*\])?/y;
const CELL_SEP = /&/y;
// What may come before a row's first cell: whitespace, comment lines and rules.
const LEAD = /^(?:\s+|%[^\n]*(?:\n|$)|\\(?:toprule|midrule|bottomrule|hline|endhead|endfirsthead|endfoot|endlastfoot|addlinespace(?:\s*\[[^\]]*\])?|cline\s*\{[^}]*\}|cmidrule(?:\([^)]*\))?\s*\{[^}]*\}|specialrule\s*\{[^}]*\}\s*\{[^}]*\}\s*\{[^}]*\})(?![A-Za-z]))/;

function tokenizeSpec(spec: string): SpecToken[] | null {
  const out: SpecToken[] = [];
  let pre = ''; // a >{..} waiting for its column
  for (let i = 0; i < spec.length;) {
    const c = spec[i];
    const group = (from: number) => {
      let j = from;
      while (/\s/.test(spec[j] ?? '')) j++;
      const end = groupEnd(spec, j);
      return end < 0 ? -1 : end;
    };
    if (/\s|\|/.test(c)) { out.push({ kind: 'sep', raw: c }); i++; continue; }
    if (c === '@' || c === '!') {
      const end = group(i + 1);
      if (end < 0) return null;
      out.push({ kind: 'sep', raw: spec.slice(i, end) });
      i = end;
      continue;
    }
    if (c === '>') {
      const end = group(i + 1);
      if (end < 0) return null;
      pre += spec.slice(i, end);
      i = end;
      continue;
    }
    if (c === '<') {
      const end = group(i + 1);
      const last = [...out].reverse().find((t) => t.kind === 'col') as ColumnToken | undefined;
      if (end < 0 || !last) return null;
      last.raw += spec.slice(i, end);
      i = end;
      continue;
    }
    if (c === 'l' || c === 'c' || c === 'r' || c === 'X' || c === 'S' || c === 'L' || c === 'C' || c === 'R' || c === 'J') {
      out.push({ kind: 'col', raw: pre + c, align: c === 'l' || c === 'c' || c === 'r' ? c : null });
      pre = '';
      i++;
      continue;
    }
    if (c === 'p' || c === 'm' || c === 'b') {
      const end = group(i + 1);
      if (end < 0) return null;
      out.push({ kind: 'col', raw: pre + spec.slice(i, end), align: null });
      pre = '';
      i = end;
      continue;
    }
    if (c === '*') {
      const m = /^\*\s*\{(\d+)\}\s*/.exec(spec.slice(i));
      if (!m) return null;
      const open = i + m[0].length;
      const end = groupEnd(spec, open);
      if (end < 0) return null;
      const inner = tokenizeSpec(spec.slice(open + 1, end - 1));
      if (!inner) return null;
      for (let k = 0; k < Number(m[1]); k++) out.push(...inner.map((t) => ({ ...t })));
      i = end;
      continue;
    }
    return null;
  }
  return pre ? null : out;
}

const columnsOf = (spec: SpecToken[]) => spec.filter((t): t is ColumnToken => t.kind === 'col');

function parseCell(raw: string): EditCell {
  const t = raw.trim();
  const head = /^\\multicolumn\s*\{(\d+)\}\s*/.exec(t);
  if (head) {
    const specEnd = groupEnd(t, head[0].length);
    if (specEnd > 0) {
      let open = specEnd;
      while (/\s/.test(t[open] ?? '')) open++;
      const end = groupEnd(t, open);
      if (end > 0 && !t.slice(end).trim()) {
        return { tex: t.slice(open + 1, end - 1).trim(), span: Number(head[1]), mcSpec: t.slice(head[0].length + 1, specEnd - 1) };
      }
    }
  }
  return { tex: t, span: 1 };
}

function parseRow(chunk: string, end: string): EditRow {
  let prefix = '';
  let rest = chunk;
  for (let m; (m = LEAD.exec(rest)) && m[0];) { prefix += m[0]; rest = rest.slice(m[0].length); }
  return { prefix, cells: split(rest, CELL_SEP).parts.map(parseCell), raw: rest, end, dirty: false };
}

/** Where the tabular environment around `pos` is in `text`, or null. */
export function findTabular(text: string, pos: number): { from: number; to: number } | null {
  const re = /\\begin\s*\{(tabular\*?|tabularx|tabulary|longtable)\}/g;
  let best: { from: number; to: number } | null = null;
  for (let m; (m = re.exec(text)) && m.index <= pos;) {
    const name = m[1].replace('*', '\\*');
    const both = new RegExp(`\\\\(begin|end)\\s*\\{${name}\\}`, 'g');
    both.lastIndex = m.index + m[0].length;
    let depth = 1;
    for (let e; (e = both.exec(text));) {
      depth += e[1] === 'begin' ? 1 : -1;
      if (depth === 0) {
        const to = e.index + e[0].length;
        if (to >= pos) best = { from: m.index, to }; // innermost wins: later begins come later
        break;
      }
    }
  }
  return best;
}

/** Take a tabular environment's source apart, or null if it doesn't look like one this can edit. */
export function parseTable(src: string): EditTable | null {
  const begin = /^\\begin\s*\{([^}]*)\}/.exec(src);
  if (!begin || !TABULAR_ENVS.includes(begin[1])) return null;
  const env = begin[1];
  const endRe = new RegExp(`\\\\end\\s*\\{${env.replace('*', '\\*')}\\}[\\s\\S]*$`);
  const endM = endRe.exec(src);
  if (!endM) return null;
  // Arguments: [pos], a width for tabular*/tabularx/tabulary, then the column spec.
  let i = begin[0].length;
  const skipWs = () => { while (/\s/.test(src[i] ?? '')) i++; };
  skipWs();
  if (src[i] === '[') { const close = src.indexOf(']', i); if (close < 0) return null; i = close + 1; skipWs(); }
  if (env !== 'tabular' && env !== 'longtable') {
    const w = groupEnd(src, i);
    if (w < 0) return null;
    i = w;
    skipWs();
    if (env === 'longtable' && src[i] === '[') { const close = src.indexOf(']', i); i = close + 1; skipWs(); }
  }
  const specEnd = groupEnd(src, i);
  if (specEnd < 0) return null;
  const specRaw = src.slice(i + 1, specEnd - 1);
  const body = src.slice(specEnd, endM.index);
  if (/\\begin\s*\{/.test(body.replace(/(^|[^\\])%.*$/gm, '$1'))) return null; // nested environments
  const { parts, seps } = split(body, ROW_END);
  const rows: EditRow[] = [];
  for (let k = 0; k < seps.length; k++) rows.push(parseRow(parts[k], seps[k]));
  let tail = parts[parts.length - 1];
  // A last row without \\ (anything but rules and comments).
  const last = parseRow(tail, '');
  if (last.raw.trim()) { rows.push(last); tail = ''; }
  if (!rows.length) return null;
  return {
    env, head: src.slice(0, i + 1), spec: tokenizeSpec(specRaw), specRaw, specDirty: false,
    mid: src.slice(specEnd - 1, specEnd), rows, tail, foot: src.slice(endM.index),
  };
}

/** Number of columns: the spec's, or the widest row's if the spec couldn't be read. */
export function columnCount(t: EditTable): number {
  const widest = Math.max(0, ...t.rows.map((r) => r.cells.reduce((n, c) => n + c.span, 0)));
  return t.spec ? Math.max(columnsOf(t.spec).length, widest) : widest;
}

/** The cell index in a row covering column `col`, with where that cell starts; -1 if none. */
export function cellAt(row: EditRow, col: number): { index: number; start: number } {
  let start = 0;
  for (let k = 0; k < row.cells.length; k++) {
    if (col < start + row.cells[k].span) return { index: k, start };
    start += row.cells[k].span;
  }
  return { index: -1, start };
}

export function columnAlign(t: EditTable, col: number): string {
  const c = t.spec ? columnsOf(t.spec)[col] : undefined;
  return c ? (c.align ?? c.raw.replace(/^>\{.*?\}/, '').replace(/<\{.*\}$/, '')) : '';
}

export function setCell(t: EditTable, row: number, index: number, tex: string) {
  const r = t.rows[row];
  if (!r || !r.cells[index] || r.cells[index].tex === tex) return;
  r.cells[index].tex = tex;
  r.dirty = true;
}

/** The rows' indentation: the most common one among rows whose first cell isn't empty. */
function indentOf(t: EditTable): string {
  const counts = new Map<string, number>();
  for (const r of t.rows) {
    const m = /\n([ \t]*)$/.exec(r.prefix);
    if (m && !/^\s*&/.test(r.raw) && r.raw.trim()) counts.set(m[1], (counts.get(m[1]) ?? 0) + 1);
  }
  let best = '';
  let n = 0;
  for (const [k, v] of counts) if (v > n) { best = k; n = v; }
  if (!n) for (const r of t.rows) { const m = /\n([ \t]*)$/.exec(r.prefix); if (m) return m[1]; }
  return best;
}

/** Insert an empty row so it becomes row `at`. */
export function insertRow(t: EditTable, at: number) {
  const n = columnCount(t);
  // Keep the last row's \\-less ending last.
  const row: EditRow = { prefix: `\n${indentOf(t)}`, cells: Array.from({ length: n }, () => ({ tex: '', span: 1 })), raw: '', end: '\\\\', dirty: true };
  if (at >= t.rows.length && t.rows.length && t.rows[t.rows.length - 1].end === '') {
    t.rows[t.rows.length - 1].end = ' \\\\';
    t.rows[t.rows.length - 1].dirty = true;
    row.end = '';
  }
  t.rows.splice(Math.max(0, Math.min(at, t.rows.length)), 0, row);
}

/** Delete row `i`; rules and comments before it stay (they move to the next row). */
export function deleteRow(t: EditTable, i: number) {
  const [gone] = t.rows.splice(i, 1);
  if (!gone) return;
  const keep = gone.prefix.trimEnd();
  if (keep.trim()) {
    if (t.rows[i]) t.rows[i].prefix = keep + t.rows[i].prefix;
    else t.tail = keep + t.tail;
  }
}

/** Insert an empty column so it becomes column `at`. */
export function insertColumn(t: EditTable, at: number, align: 'l' | 'c' | 'r' = 'c') {
  if (t.spec) {
    const cols = columnsOf(t.spec);
    const token: ColumnToken = { kind: 'col', raw: align, align };
    // Right after the column to its left (before any | or @{..} that follows it); first: before the first.
    const left = cols[Math.min(at, cols.length) - 1];
    const idx = left ? t.spec.indexOf(left) + 1 : cols[0] ? t.spec.indexOf(cols[0]) : t.spec.length;
    t.spec.splice(idx, 0, token);
    t.specDirty = true;
  }
  for (const r of t.rows) {
    const { index, start } = cellAt(r, at);
    if (index >= 0 && start < at) r.cells[index].span++; // inside a merged cell: widen it
    else if (index >= 0) r.cells.splice(index, 0, { tex: '', span: 1 });
    else {
      const width = r.cells.reduce((n, c) => n + c.span, 0);
      if (width < at) continue; // a short row: leave it short
      r.cells.push({ tex: '', span: 1 });
    }
    r.dirty = true;
  }
}

/** Delete column `col`. */
export function deleteColumn(t: EditTable, col: number) {
  if (t.spec) {
    const token = columnsOf(t.spec)[col];
    if (token) {
      const idx = t.spec.indexOf(token);
      t.spec.splice(idx, 1);
      // Don't leave || where a single | separated the columns.
      if (t.spec[idx - 1]?.raw === '|' && t.spec[idx]?.raw === '|') t.spec.splice(idx, 1);
      t.specDirty = true;
    }
  }
  for (const r of t.rows) {
    const { index } = cellAt(r, col);
    if (index < 0) continue;
    if (r.cells[index].span > 1) r.cells[index].span--;
    else r.cells.splice(index, 1);
    r.dirty = true;
  }
}

/** Set column `col` to l, c or r (a p{..}/X column becomes plain l/c/r). */
export function setAlign(t: EditTable, col: number, align: 'l' | 'c' | 'r') {
  const token = t.spec ? columnsOf(t.spec)[col] : undefined;
  if (!token || token.align === align) return;
  token.raw = align;
  token.align = align;
  t.specDirty = true;
}

/** True when column operations can keep the spec in step. */
export const canEditColumns = (t: EditTable) => t.spec !== null;

function cellTex(c: EditCell): string {
  const tex = /(^|[^\\])%/.test(c.tex) ? `${c.tex}\n` : c.tex; // a comment needs its line end
  return c.span > 1 || c.mcSpec !== undefined ? `\\multicolumn{${c.span}}{${c.mcSpec ?? 'c'}}{${tex}}` : tex;
}

/** The environment's source, with the edits. */
export function serialize(t: EditTable): string {
  const spec = t.specDirty && t.spec ? t.spec.map((s) => s.raw).join('') : t.specRaw;
  let body = '';
  const indent = indentOf(t);
  t.rows.forEach((r, i) => {
    let end = r.end;
    let dirty = r.dirty;
    if (!end && i < t.rows.length - 1) { end = ' \\\\'; dirty = true; } // only the last row may lack \\
    if (!dirty) { body += r.prefix + r.raw + end; return; }
    const cells = r.cells.map(cellTex).join(' & ');
    const ws = /\s*$/.exec(r.raw)?.[0] ?? '';
    // A changed row starts at the table's indentation (an empty first cell's padding isn't kept).
    const prefix = r.prefix.replace(/\n[ \t]*$/, `\n${indent}`);
    // A last row that gets a \\ (a row was added after it): the next row brings its own line break.
    if (end && ws.includes('\n')) body += prefix + cells + ' ' + end.trimStart();
    else if (ws.includes('\n')) body += prefix + cells + ws + end.trimStart();
    else body += prefix + cells + (end ? ' ' : '') + end.trimStart();
  });
  let tail = t.tail;
  if (!tail && !/\n\s*$/.test(body)) tail = '\n';
  return t.head + spec + t.mid + body + tail + t.foot;
}

/** A new empty table with `rows` × `cols` cells and booktabs-free \hline rules. */
export function newTableSource(rows = 3, cols = 3, indent = ''): string {
  const line = (k: number) => `${indent}  ${Array.from({ length: cols }, (_, c) => (k === 0 ? `Header ${c + 1}` : '')).join(' & ')} \\\\`;
  const body = Array.from({ length: rows }, (_, k) => line(k) + (k === 0 ? `\n${indent}  \\hline` : '')).join('\n');
  return `\\begin{tabular}{${'c'.repeat(cols)}}\n${indent}  \\hline\n${body}\n${indent}  \\hline\n${indent}\\end{tabular}`;
}
