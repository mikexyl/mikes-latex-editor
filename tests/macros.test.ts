// Project-wide macros: an included section renders macros defined in the main file's preamble.
import katex from 'katex';
import { collectMacros, setProjectMacros, macrosFor } from '../web/src/visual/macros.ts';

let fail = 0;
const check = (name: string, got: unknown, want: unknown) => {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  if (!ok) fail++;
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${name}: ${JSON.stringify(got)}${ok ? '' : `  want ${JSON.stringify(want)}`}`);
};
const renders = (tex: string, macros: Record<string, string>) => {
  try { katex.renderToString(tex, { throwOnError: true, macros: { ...macros } }); return true; } catch { return false; }
};

const mainTex = String.raw`\documentclass{article}
\newcommand{\SE}{\mathrm{SE}}
\newcommand{\R}{\mathbb{R}}
% \newcommand{\commented}{x}
\DeclareMathOperator*{\argmin}{arg\,min}
\begin{document}\input{sections/submapping}\end{document}`;
const sectionTex = String.raw`Its points form $\mathcal P_i\subset\R^3$, and the odometry pose $\tilde T_i\in\SE(3)$.`;
const formula = String.raw`\tilde T_i\in\SE(3)`;

const project = collectMacros(mainTex);
check('macros from main preamble', Object.keys(project).sort(), ['\\R', '\\SE', '\\argmin']);

const sectionDoc = {}; // stands in for the section's CodeMirror document
check('section alone: \\SE unknown', renders(formula, macrosFor(sectionDoc, () => sectionTex).macros), false);

check('project macros set (changed)', setProjectMacros(project), true);
check('setting the same again is a no-op', setProjectMacros(collectMacros(mainTex)), false);
const merged = macrosFor(sectionDoc, () => sectionTex);
check('section with project macros renders', renders(formula, merged.macros), true);
check('\\R in the section renders', renders(String.raw`\mathcal P_i\subset\R^3`, merged.macros), true);

const ownDoc = {};
const own = macrosFor(ownDoc, () => String.raw`\renewcommand{\R}{\mathbf{R}}`);
check("a file's own definition wins", own.macros['\\R'], '\\mathbf{R}');

console.log(fail ? `${fail} FAILED` : 'all passed');
if (fail) process.exit(1);
