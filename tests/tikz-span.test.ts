// Visual mode: which source a TikZ picture is drawn from (the environment, or a box around it).
import { tikzSpan } from '../web/src/visual/tikz-span.ts';

let fail = 0;
const check = (name: string, got: unknown, want: unknown) => {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  if (!ok) fail++;
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${name}: ${JSON.stringify(got)}${ok ? '' : `  want ${JSON.stringify(want)}`}`);
};
const pic = '\\begin{tikzpicture}\n\\node {a};\n\\end{tikzpicture}';
const span = (text: string) => {
  const from = text.indexOf('\\begin{tikzpicture}');
  const r = tikzSpan(text, from, text.indexOf('\\end{tikzpicture}') + '\\end{tikzpicture}'.length);
  return r && text.slice(r.from, r.to);
};
check('alone on its lines', span(`text\n${pic}\nmore`), pic);
check('in \\resizebox{…}{!}{% … }}', span(`% c\n\\resizebox{\\linewidth}{!}{%\n${pic}}\n`), `\\resizebox{\\linewidth}{!}{%\n${pic}}`);
check('\\scalebox with the brace on its own line', span(`\\scalebox{0.8}{\n  ${pic}\n}`), `\\scalebox{0.8}{\n  ${pic}\n}`);
check('box followed by a comment', span(`\\resizebox{3in}{!}{${pic}} % note`), `\\resizebox{3in}{!}{${pic}}`);
check('text before the box: not drawn', span(`See \\resizebox{3in}{!}{${pic}}`), null);
check('other text after: not drawn', span(`\\resizebox{3in}{!}{${pic}} and more`), null);
check('inline picture: not drawn', span(`a ${pic} b`), null);
if (fail) { console.log(`${fail} failed`); process.exit(1); }
