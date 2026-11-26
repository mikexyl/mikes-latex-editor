import { labelsToTags } from '../web/src/visual/eq-labels.ts';
let failed = 0;
const check = (name: string, got: string, want: string) => {
  if (got === want) console.log(`ok   ${name}`);
  else { failed++; console.log(`FAIL ${name}\n  got:  ${got}\n  want: ${want}`); }
};
const tag = (l: string) => `\\tag{\\htmlClass{vc-eq-label}{\\text{${l}}}}`;
check('equation', labelsToTags('\\begin{equation} x=1 \\label{eq:a} \\end{equation}'), `\\begin{equation} x=1 ${tag('eq:a')} \\end{equation}`);
check('escaped', labelsToTags('x \\label{eq:a_b#1}'), `x ${tag('eq:a\\_b\\#1')}`);
check('align rows', labelsToTags('a&=1 \\label{r1}\\\\ b&=2 \\\\ c&=3\\label{r3}'), `a&=1 ${tag('r1')}\\\\ b&=2 \\\\ c&=3${tag('r3')}`);
check('existing tag kept', labelsToTags('a \\tag{*} \\label{x} \\\\ b \\label{y}'), `a \\tag{*}  \\\\ b ${tag('y')}`);
check('no label', labelsToTags('x = y'), 'x = y');
if (failed) process.exit(1);
