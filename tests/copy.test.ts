// Copy section: the source of a (sub)section, from its heading to the next one of its level.
import { sectionRange } from '../web/src/visual/copy.ts';

let fail = 0;
const check = (name: string, got: unknown, want: unknown) => {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  if (!ok) fail++;
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${name}: ${JSON.stringify(got)}${ok ? '' : `  want ${JSON.stringify(want)}`}`);
};
const doc = [
  '\\section{Method}', 'Intro text.', '', '\\subsection{Tiles}', 'Tile text.', '%\\section{Old}',
  '\\subsubsection*{Detail}', 'More.', '', '\\subsection[short]{Loops}', 'Loop text.', '',
  '\\section{Experiments}', 'Results.', '', '\\bibliography{refs}', '\\end{document}',
].join('\n');
const copy = (heading: string) => { const r = sectionRange(doc, doc.indexOf(heading) + 3); return r && [r.title, doc.slice(r.from, r.to)]; };
check('section runs to the next section', copy('\\section{Method}'), ['Method', doc.slice(0, doc.indexOf('\n\n\\section{Experiments}'))]);
check('subsection includes its subsubsections, ignores commented headings', copy('\\subsection{Tiles}'), ['Tiles', 'Tile text.'.replace(/^/, '\\subsection{Tiles}\n') + '\n%\\section{Old}\n\\subsubsection*{Detail}\nMore.']);
check('optional short title', copy('\\subsection[short]{Loops}')?.[0], 'Loops');
check('last section stops at the bibliography', copy('\\section{Experiments}'), ['Experiments', '\\section{Experiments}\nResults.']);
check('no heading on the line', sectionRange(doc, doc.indexOf('Intro')), null);
check('end of file', sectionRange('\\section{A}\ntext\n', 2), { from: 0, to: 16, title: 'A' });
if (fail) { console.log(`${fail} failed`); process.exit(1); }
