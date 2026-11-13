// Visual-mode tables: column specs with nested braces, as in @{\hspace{7pt}}.
import { parseTabular, textMacro } from '../web/src/visual/table.ts';

let fail = 0;
const check = (name: string, got: unknown, want: unknown) => {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  if (!ok) fail++;
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${name}: ${JSON.stringify(got)}${ok ? '' : `  want ${JSON.stringify(want)}`}`);
};

const body = String.raw`
\toprule
Robots & Poses & \method & iMESA & DDF-SAM2 & Indep. & Centr. & No frames \\
\midrule
3 & 300 & \textbf{0.073} & 0.083 & 0.078 & 0.118 & 0.072 & 0.073 \\
\bottomrule
`;
const t = parseTabular(String.raw`@{}rrccccc@{\hspace{7pt}}c@{}`, body);
check('nested @{} spec parses', t?.aligns.join(''), 'rrcccccc');
check('rows', t?.rows.length, 2);
check('rules', [t?.rows[0].ruleAbove, t?.rows[1].ruleAbove, t?.ruleBelow], ['thick', 'thin', 'thick']);
check('p{} with nested width', parseTabular(String.raw`lp{0.3\linewidth}`, 'a & b \\\\')?.aligns.join(''), 'll');
check('>{\\centering\\arraybackslash}', parseTabular(String.raw`>{\centering\arraybackslash}p{2cm}|c`, 'a & b')?.aligns.join(''), 'lc');

const m = { '\\method': 'BBS', '\\methodlong': 'Bounded Belief Sharing', '\\x': '\\mathrm{x}', '\\full': '\\textbf{\\method} method', '\\pair': '(#1, #2)' };
check('text macro', textMacro('methodlong', m), 'Bounded Belief Sharing');
check('nested text macro', textMacro('full', m), 'BBS method');
check('math macro stays', textMacro('x', m), null);
check('macro with args stays', textMacro('pair', m), null);
check('unknown', textMacro('nope', m), null);

if (fail) { console.log(`${fail} failed`); process.exit(1); }
