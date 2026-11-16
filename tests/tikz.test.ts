// TikZ in visual mode: reading the preamble and TeX's error message (server/tikz.ts).
import { firstError, preambleOf, tikzDocument } from '../server/tikz.ts';

let fail = 0;
const check = (name: string, got: unknown, want: unknown) => {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  if (!ok) fail++;
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${name}: ${JSON.stringify(got)}${ok ? '' : `  want ${JSON.stringify(want)}`}`);
};
const main = '\\documentclass{article}\n% \\begin{document} in a comment\n\\usepackage{tikz}\n  \\begin{document}\nText\n\\end{document}\n';
check('preamble stops at the real \\begin{document}', preambleOf(main), '\\documentclass{article}\n% \\begin{document} in a comment\n\\usepackage{tikz}\n  ');
check('no \\begin{document}', preambleOf('\\section{x}'), null);
check('wrapper ships the picture box', /\\shipout\\box0/.test(tikzDocument('P', 'C')), true);
const log = `x\n! Package pgfkeys Error: I do not know the key '/tikz/nonsense key' and I am going t\no ignore it. Perhaps you misspelled it.\n\nSee the pgfkeys package documentation for explanation.\nl.12 \\node[nonsense key]\n`;
check('wrapped error joined', firstError(log), "Package pgfkeys Error: I do not know the key '/tikz/nonsense key' and I am going to ignore it. Perhaps you misspelled it.");
check('missing file', firstError("! LaTeX Error: File `paralist.sty' not found.\n\nType X to quit\n"), "LaTeX Error: File `paralist.sty' not found.");
if (fail) { console.log(`${fail} failed`); process.exit(1); }
