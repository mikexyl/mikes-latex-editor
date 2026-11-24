// The table editor's model: parse a tabular, edit it, write it back.
import { cellAt, columnCount, deleteColumn, deleteRow, findTabular, insertColumn, insertRow, newTableSource, parseTable, serialize, setAlign, setCell } from '../web/src/visual/table-edit.ts';

let fail = 0;
const check = (name: string, got: unknown, want: unknown) => {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  if (!ok) fail++;
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${name}${ok ? '' : `\n     got  ${JSON.stringify(got)}\n     want ${JSON.stringify(want)}`}`);
};

const src = String.raw`\begin{tabular}{@{}l|cr@{}}
  \toprule
  Method & ATE & Comm. \\
  \midrule
  % baselines
  Ours & \textbf{0.07} & 1.2 \\
  \multicolumn{2}{c}{Merged} & 3 \\[2pt]
  Base & 0.1\% & 2 \\
  \bottomrule
\end{tabular}`;

let t = parseTable(src)!;
check('parses', [t.rows.length, columnCount(t)], [4, 3]);
check('round trip is exact', serialize(t), src);
check('cells', t.rows.map((r) => r.cells.map((c) => c.tex)), [['Method', 'ATE', 'Comm.'], ['Ours', '\\textbf{0.07}', '1.2'], ['Merged', '3'], ['Base', '0.1\\%', '2']]);
check('multicolumn span', t.rows[2].cells[0].span, 2);
check('cellAt in a merged cell', cellAt(t.rows[2], 1), { index: 0, start: 0 });

setCell(t, 1, 2, '1.3');
check('edit one cell: only that row changes', serialize(t), src.replace('Ours & \\textbf{0.07} & 1.2 \\\\', 'Ours & \\textbf{0.07} & 1.3 \\\\'));

t = parseTable(src)!;
insertRow(t, 2);
setCell(t, 2, 0, 'New');
check('insert row keeps indentation and rules', serialize(t).split('\n').slice(4, 8), ['  % baselines', '  Ours & \\textbf{0.07} & 1.2 \\\\', '  New &  &  \\\\', '  \\multicolumn{2}{c}{Merged} & 3 \\\\[2pt]']);

t = parseTable(src)!;
deleteRow(t, 1);
check('delete row keeps the comment and rule before it', serialize(t).split('\n').slice(2, 7), ['  Method & ATE & Comm. \\\\', '  \\midrule', '  % baselines', '  \\multicolumn{2}{c}{Merged} & 3 \\\\[2pt]', '  Base & 0.1\\% & 2 \\\\']);

t = parseTable(src)!;
insertColumn(t, 1);
check('insert column: spec', serialize(t).split('\n')[0], '\\begin{tabular}{@{}lc|cr@{}}');
check('insert column: cells, merged cell widens', t.rows.map((r) => r.cells.map((c) => `${c.tex}${c.span > 1 ? '/' + c.span : ''}`).join(',')), ['Method,,ATE,Comm.', 'Ours,,\\textbf{0.07},1.2', 'Merged/3,3', 'Base,,0.1\\%,2']);
check('merged cell written with new span', serialize(t).includes('\\multicolumn{3}{c}{Merged} & 3 \\\\[2pt]'), true);

t = parseTable(src)!;
deleteColumn(t, 0);
check('delete column: spec', serialize(t).split('\n')[0], '\\begin{tabular}{@{}|cr@{}}');
check('delete column: merged cell narrows', t.rows[2].cells.map((c) => [c.tex, c.span]), [['Merged', 1], ['3', 1]]);

t = parseTable(src)!;
deleteColumn(t, 2);
insertColumn(t, 2, 'r');
setAlign(t, 0, 'c');
check('align + append column', serialize(t).split('\n')[0], '\\begin{tabular}{@{}c|cr@{}}');

// A last row without \\, tabularx with a width, [t] position, *{n}{..} specs.
const x = String.raw`\begin{tabularx}{\linewidth}{*{2}{X}}
a & b \\
c & d
\end{tabularx}`;
t = parseTable(x)!;
check('tabularx parses', [t.env, columnCount(t), t.rows.length], ['tabularx', 2, 2]);
check('tabularx round trip', serialize(t), x);
insertRow(t, 2);
setCell(t, 2, 0, 'e');
check('row after a \\\\-less last row', serialize(t), String.raw`\begin{tabularx}{\linewidth}{*{2}{X}}
a & b \\
c & d \\
e &  
\end{tabularx}`.replace('e &  \n', 'e & \n'));
const pos = parseTable(String.raw`\begin{tabular}[t]{lc} 1 & 2 \\ \end{tabular}`)!;
check('[t] position', [columnCount(pos), pos.rows[0].cells.map((c) => c.tex)], [2, ['1', '2']]);
check('nested environment refused', parseTable(String.raw`\begin{tabular}{l} \begin{itemize}\item a\end{itemize} \\ \end{tabular}`), null);

const doc = `Text\n\\begin{table}\n\\centering\n${src}\n\\caption{x}\n\\end{table}\n`;
const at = doc.indexOf('Ours');
const found = findTabular(doc, at)!;
check('findTabular', doc.slice(found.from, found.to), src);
check('findTabular outside', findTabular(doc, doc.indexOf('caption')), null);

const fresh = newTableSource(2, 2);
t = parseTable(fresh)!;
check('new table parses', [t.rows.length, columnCount(t), serialize(t) === fresh], [2, 2, true]);

t = parseTable(fresh)!;
setCell(t, 1, 0, 'alpha'); setCell(t, 1, 1, '0.5');
check('filling a new table\'s empty row: clean spacing', serialize(t).split('\n')[4], '  alpha & 0.5 \\\\');
if (fail) { console.log(`${fail} failed`); process.exit(1); }
