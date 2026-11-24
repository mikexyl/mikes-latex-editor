// The table editor: a dialog with a grid of a tabular's cells (their LaTeX), to edit cells and add or
// remove rows and columns. Saving writes the environment back as one undoable change; rows that
// weren't touched keep their exact source.
import type { EditorView } from '@codemirror/view';
import {
  canEditColumns, cellAt, columnAlign, columnCount, deleteColumn, deleteRow, findTabular, insertColumn,
  insertRow, newTableSource, parseTable, serialize, setAlign, setCell, type EditTable,
} from './table-edit.ts';

const el = <K extends keyof HTMLElementTagNameMap>(tag: K, cls = '', text = '') => {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text) e.textContent = text;
  return e;
};

const RULE_NAMES = /\\(toprule|midrule|bottomrule|hline|cline|cmidrule|specialrule)/g;
const rulesIn = (text: string) => [...text.replace(/(^|[^\\])%.*$/gm, '$1').matchAll(RULE_NAMES)].map((m) => m[1]);

/**
 * Open the editor for the tabular around `pos` in `view`. Returns a message when there's no table
 * there it can edit, or null once the dialog is open.
 */
export function editTableAt(view: EditorView, pos: number): string | null {
  const text = view.state.doc.toString();
  const r = findTabular(text, pos);
  if (!r) return 'Put the cursor in a table (a tabular environment) to edit it.';
  const src = text.slice(r.from, r.to);
  const table = parseTable(src);
  if (!table) return 'This table has nested environments or a column spec the table editor can\'t read; edit its source instead.';
  openDialog(view, r.from, src, table);
  return null;
}

/** The Table button: edit the table at the cursor, or insert a new one when there's none. */
export function tableCommand(view: EditorView) {
  const pos = view.state.selection.main.head;
  if (!findTabular(view.state.doc.toString(), pos)) { insertTable(view); return; }
  const why = editTableAt(view, pos);
  if (why) window.alert(why);
}

/** Insert a new table at the cursor (in a table float unless already in one) and open the editor on it. */
export function insertTable(view: EditorView) {
  const { state } = view;
  const pos = state.selection.main.head;
  const line = state.doc.lineAt(pos);
  const indent = /^[ \t]*/.exec(line.text)![0];
  const before = state.sliceDoc(0, pos);
  const inFloat = (before.match(/\\begin\s*\{table\*?\}/g)?.length ?? 0) > (before.match(/\\end\s*\{table\*?\}/g)?.length ?? 0);
  const tabular = newTableSource(3, 3, inFloat ? indent : `${indent}  `);
  const body = inFloat ? tabular : `\\begin{table}[t]\n${indent}  \\centering\n${indent}  ${tabular}\n${indent}  \\caption{}\n${indent}  \\label{tab:}\n${indent}\\end{table}`;
  const lead = pos > line.from && state.sliceDoc(line.from, pos).trim() ? `\n${indent}` : '';
  const trail = state.sliceDoc(pos, line.to).trim() ? `\n${indent}` : '';
  const insert = lead + body + trail;
  view.dispatch({ changes: { from: pos, insert }, userEvent: 'table.insert', scrollIntoView: true });
  const at = pos + lead.length + body.indexOf('\\begin{tabular}') + 1;
  view.dispatch({ selection: { anchor: at } });
  editTableAt(view, at);
}

function openDialog(view: EditorView, from: number, original: string, t: EditTable) {
  const d = el('dialog', 'project-dialog table-editor');
  d.setAttribute('aria-label', 'Edit table');
  const header = el('div', 'pd-header');
  header.append(el('h2', '', 'Edit table'), el('span', 'te-hint', 'Tab / Enter move between cells · ⌘↵ / Ctrl+↵ saves'));
  const toolbar = el('div', 'te-toolbar');
  const gridWrap = el('div', 'te-grid-wrap');
  const note = el('p', 'pd-note te-note');
  const footer = el('div', 'pd-footer');
  const cancel = el('button', '', 'Cancel');
  const save = el('button', 'primary', 'Save');
  footer.append(el('span', 'pd-note', `${t.env} · LaTeX in each cell`), cancel, save);
  const body = el('div', 'pd-section te-body');
  body.append(toolbar, gridWrap, note, footer);
  d.append(header, body);

  let cur = { row: 0, col: 0 };
  const button = (label: string, title: string, run: () => void, disabled = false) => {
    const b = el('button', 'te-btn', label);
    b.title = title;
    b.disabled = disabled;
    b.onmousedown = (e) => e.preventDefault(); // keep the cell focused
    b.onclick = () => { run(); render(); };
    return b;
  };
  const group = (label: string, ...items: HTMLElement[]) => {
    const g = el('span', 'te-group');
    g.append(el('span', 'te-label', label), ...items);
    return g;
  };

  function renderToolbar() {
    const cols = canEditColumns(t);
    const n = columnCount(t);
    const align = columnAlign(t, cur.col);
    const alignBtn = (a: 'l' | 'c' | 'r', label: string) => {
      const b = button(label, `Align column ${cur.col + 1} ${{ l: 'left', c: 'center', r: 'right' }[a]}`, () => setAlign(t, cur.col, a), !cols);
      b.classList.toggle('active', align === a);
      return b;
    };
    toolbar.replaceChildren(
      group('Row',
        button('+ Above', 'Insert a row above', () => { insertRow(t, cur.row); cur.col = 0; }),
        button('+ Below', 'Insert a row below', () => { insertRow(t, cur.row + 1); cur = { row: cur.row + 1, col: 0 }; }),
        button('Delete', 'Delete this row', () => { deleteRow(t, cur.row); cur.row = Math.min(cur.row, t.rows.length - 1); }, t.rows.length <= 1)),
      group('Column',
        button('+ Left', 'Insert a column to the left', () => { insertColumn(t, cur.col); }, !cols),
        button('+ Right', 'Insert a column to the right', () => { insertColumn(t, cur.col + 1); cur.col++; }, !cols),
        button('Delete', 'Delete this column', () => { deleteColumn(t, cur.col); cur.col = Math.min(cur.col, columnCount(t) - 1); }, !cols || n <= 1)),
      group('Align', alignBtn('l', 'Left'), alignBtn('c', 'Center'), alignBtn('r', 'Right')),
    );
    note.textContent = cols ? '' : 'Columns can\'t be added or removed here: the column spec is more than this editor understands.';
    note.hidden = cols;
  }

  const inputs: HTMLTextAreaElement[][] = [];
  function render() {
    renderToolbar();
    const n = columnCount(t);
    const table = el('table', 'te-grid');
    const head = el('tr');
    head.append(el('th', 'te-corner'));
    for (let c = 0; c < n; c++) {
      const th = el('th', c === cur.col ? 'te-colhead current' : 'te-colhead');
      th.append(document.createTextNode(String.fromCharCode(65 + (c % 26)) + (c >= 26 ? Math.floor(c / 26) : '')));
      const a = columnAlign(t, c);
      if (a) th.append(el('span', 'te-align', a));
      th.onclick = () => { cur.col = c; focusCell(); renderToolbar(); markCurrent(); };
      head.append(th);
    }
    table.append(el('thead'));
    table.tHead!.append(head);
    const tbody = el('tbody');
    inputs.length = 0;
    t.rows.forEach((row, ri) => {
      const rules = rulesIn(row.prefix);
      const tr = el('tr');
      if (rules.length) tr.classList.add(rules.some((r) => /top|bottom|special/.test(r)) ? 'te-rule-thick' : 'te-rule-thin');
      const th = el('th', ri === cur.row ? 'te-rowhead current' : 'te-rowhead', String(ri + 1));
      if (rules.length) th.title = `Before this row: ${rules.map((r) => `\\${r}`).join(' ')}`;
      tr.append(th);
      const rowInputs: HTMLTextAreaElement[] = [];
      let col = 0;
      row.cells.forEach((cell, ci) => {
        const td = el('td');
        if (cell.span > 1) { td.colSpan = cell.span; td.classList.add('te-merged'); td.title = `Merged cell (\\multicolumn{${cell.span}}{…})`; }
        const a = columnAlign(t, col);
        const ta = el('textarea', 'te-cell');
        ta.value = cell.tex;
        ta.rows = 1;
        ta.spellcheck = false;
        ta.style.textAlign = a === 'r' ? 'right' : a === 'c' ? 'center' : 'left';
        const start = col;
        ta.oninput = () => setCell(t, ri, ci, ta.value.replace(/\n/g, ' '));
        ta.onfocus = () => {
          if (cur.row !== ri || cur.col < start || cur.col >= start + cell.span) {
            cur = { row: ri, col: start };
            renderToolbar();
            markCurrent();
          }
        };
        ta.onkeydown = (e) => onKey(e, ri);
        for (let k = 0; k < cell.span; k++) rowInputs.push(ta);
        td.append(ta);
        tr.append(td);
        col += cell.span;
      });
      // A short row: empty slots to fill in (typing there adds the cells).
      for (; col < n; col++) {
        const td = el('td', 'te-missing');
        const ta = el('textarea', 'te-cell');
        ta.rows = 1;
        ta.placeholder = '—';
        const at = col;
        ta.oninput = () => {
          while (row.cells.reduce((s, c) => s + c.span, 0) <= at) row.cells.push({ tex: '', span: 1 });
          const { index } = cellAt(row, at);
          setCell(t, ri, index, ta.value.replace(/\n/g, ' '));
          row.dirty = true;
        };
        ta.onfocus = () => { cur = { row: ri, col: at }; renderToolbar(); markCurrent(); };
        ta.onkeydown = (e) => onKey(e, ri);
        rowInputs.push(ta);
        td.append(ta);
        tr.append(td);
      }
      inputs.push(rowInputs);
      tbody.append(tr);
    });
    table.append(tbody);
    gridWrap.replaceChildren(table);
    focusCell();
  }

  function markCurrent() {
    gridWrap.querySelectorAll('.current').forEach((e) => e.classList.remove('current'));
    gridWrap.querySelectorAll('.te-colhead')[cur.col]?.classList.add('current');
    gridWrap.querySelectorAll('.te-rowhead')[cur.row]?.classList.add('current');
  }

  function focusCell() {
    const ta = inputs[cur.row]?.[cur.col];
    if (ta && document.activeElement !== ta) { ta.focus(); ta.select(); }
  }

  function move(dRow: number, dCol: number, wrap = false) {
    const n = columnCount(t);
    let { row, col } = cur;
    // Step over the rest of a merged cell.
    const here = inputs[row]?.[col];
    if (dCol > 0) while (col + 1 < n && inputs[row][col + 1] === here) col++;
    col += dCol;
    row += dRow;
    if (wrap && col >= n) { col = 0; row++; }
    if (wrap && col < 0) { col = n - 1; row--; }
    if (row < 0 || col < 0 || col >= n) return;
    if (row >= t.rows.length) {
      if (!wrap) return;
      insertRow(t, t.rows.length); // Tab in the last cell adds a row, as in a spreadsheet
      cur = { row, col };
      render();
      return;
    }
    // Land on the start of a merged cell.
    const target = inputs[row][col];
    while (col > 0 && inputs[row][col - 1] === target) col--;
    cur = { row, col };
    renderToolbar();
    markCurrent();
    focusCell();
  }

  function onKey(e: KeyboardEvent, _row: number) {
    if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) { e.preventDefault(); done(true); return; }
    if (e.key === 'Tab') { e.preventDefault(); move(0, e.shiftKey ? -1 : 1, true); return; }
    if (e.key === 'Enter') { e.preventDefault(); move(e.shiftKey ? -1 : 1, 0); return; }
    const ta = e.target as HTMLTextAreaElement;
    if (e.key === 'ArrowUp' && !e.shiftKey) { e.preventDefault(); move(-1, 0); }
    else if (e.key === 'ArrowDown' && !e.shiftKey) { e.preventDefault(); move(1, 0); }
    else if (e.key === 'ArrowLeft' && ta.selectionStart === 0 && ta.selectionEnd === 0) { e.preventDefault(); move(0, -1); }
    else if (e.key === 'ArrowRight' && ta.selectionStart === ta.value.length) { e.preventDefault(); move(0, 1); }
  }

  let finished = false;
  function done(apply: boolean) {
    if (finished) return;
    finished = true;
    if (apply) {
      const out = serialize(t);
      const now = view.state.sliceDoc(from, from + original.length);
      if (now !== original) {
        window.alert('The table changed in the editor while this was open; nothing was saved.');
      } else if (out !== original) {
        view.dispatch({ changes: { from, to: from + original.length, insert: out }, userEvent: 'table.edit', scrollIntoView: true });
      }
    }
    d.close();
  }
  cancel.onclick = () => done(false);
  save.onclick = () => done(true);
  d.addEventListener('close', () => { d.remove(); view.focus(); }, { once: true });
  d.addEventListener('cancel', (e) => {
    // Escape: close without saving, but ask first if something changed.
    if (serialize(t) !== original && !window.confirm('Discard your changes to this table?')) { e.preventDefault(); return; }
    finished = true;
  });

  document.body.append(d);
  d.showModal();
  render();
}
