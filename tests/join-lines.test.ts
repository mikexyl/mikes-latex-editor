// "Join lines": joining the lines of a sentence broken over several source lines.
import { joinLines } from '../web/src/join-lines.ts';

let fail = 0;
const check = (name: string, got: unknown, want: unknown) => {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  if (!ok) fail++;
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${name}: ${JSON.stringify(got)}${ok ? '' : `  want ${JSON.stringify(want)}`}`);
};
const apply = (text: string, from?: number, to?: number) => {
  let out = text;
  for (const j of joinLines(text, from, to).reverse()) out = out.slice(0, j.from) + j.insert + out.slice(j.to);
  return out;
};

check('mid-sentence lines join', apply('Robots must\n  identify overlaps, and\nreject outliers.'), 'Robots must identify overlaps, and reject outliers.');
check('a sentence end keeps its break', apply('First one.\nSecond one\ncontinues.'), 'First one.\nSecond one continues.');
check('closing brackets after the period', apply('(as shown.)\nNext'), '(as shown.)\nNext');
check('paragraphs stay apart', apply('one\n\ntwo'), 'one\n\ntwo');
check('comments are never joined', apply('text % note\nmore\n% c\nend'), 'text % note\nmore\n% c\nend');
check('an escaped percent is text', apply('50\\%\nof'), '50\\% of');
check('\\\\ keeps its break', apply('a\\\\\nb\\\\[2pt]\nc'), 'a\\\\\nb\\\\[2pt]\nc');
check('headings and labels', apply('\\section{Intro}\n\\label{s}\nText\n\\subsection{X}'), '\\section{Intro}\n\\label{s}\nText\n\\subsection{X}');
check('\\item takes its continuation', apply('\\begin{itemize}\n  \\item \\textbf{A:}\n  more text\n  \\item B\n\\end{itemize}'), '\\begin{itemize}\n  \\item \\textbf{A:} more text\n  \\item B\n\\end{itemize}');
check('\\cite at a line start joins', apply('optimization\n\\cite{a,b}.'), 'optimization \\cite{a,b}.');
check('inline math joins', apply('error of\n$1.01\\,\\mathrm{m}$ over'), 'error of $1.01\\,\\mathrm{m}$ over');
check('display math stays', apply('where\n\\[\nx = 1\n\\]\nholds'), 'where\n\\[\nx = 1\n\\]\nholds');
check('tables and code are left alone', apply('\\begin{tabular}{ll}\na & b\nc & d\n\\end{tabular}\n\\begin{verbatim}\nx\ny\n\\end{verbatim}'),
  '\\begin{tabular}{ll}\na & b\nc & d\n\\end{tabular}\n\\begin{verbatim}\nx\ny\n\\end{verbatim}');
check('the preamble is left alone', apply('\\newcommand{\\x}\n{y}\n\\begin{document}\nsome\ntext\n\\end{document}'), '\\newcommand{\\x}\n{y}\n\\begin{document}\nsome text\n\\end{document}');
const t = 'aa\nbb\ncc\ndd';
check('only within the range', apply(t, t.indexOf('bb'), t.indexOf('cc') + 1), 'aa\nbb cc\ndd');
if (fail) { console.log(`${fail} failed`); process.exit(1); }
