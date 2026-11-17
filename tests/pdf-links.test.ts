import { citationNumbers, findBibliography, findCitations, type TextRun } from '../web/src/pdf-links.ts';

let failed = 0;
function check(name: string, got: unknown, want: unknown) {
  const g = JSON.stringify(got), w = JSON.stringify(want);
  if (g === w) console.log(`ok   ${name}`);
  else { failed++; console.log(`FAIL ${name}: ${g}\n     want ${w}`); }
}

check('single', citationNumbers('as in [2].').map((c) => c.n), [2]);
check('list and range', citationNumbers('methods [3, 5], [7–9] and [10-11]').map((c) => c.n), [3, 5, 7, 9, 10, 11]);
check('offsets', citationNumbers('x [12]').map((c) => [c.start, c.end]), [[3, 5]]);
check('not text in brackets', citationNumbers('[a] [2a] [ ] [1.5]').length, 0);

// A tiny two-page paper: citations on page 1, the reference list on page 2.
const run = (page: number, str: string, x: number, y: number, width = str.length * 5): TextRun => ({ page, str, x, y, width, height: 10 });
const runs: TextRun[] = [
  run(1, 'Prior work [1], [2, 3] studied this.', 50, 100),
  run(1, 'See also [3] and [9].', 50, 115),
  run(2, 'References', 50, 40),
  run(2, '[1]', 50, 60, 15), run(2, 'A. Author, “First paper,” 2020.', 70, 60),
  run(2, '[2]', 50, 75, 15), run(2, 'B. Author, “Second', 70, 75), run(2, 'paper,” 2021.', 70, 87),
  run(2, '[3]', 50, 100, 15), run(2, 'C. Author, “Third,” 2022.', 70, 100),
];
const bib = findBibliography(runs)!;
check('entries found', [...bib.keys()], [1, 2, 3]);
check('entry text', bib.get(2)!.text, 'B. Author, “Second paper,” 2021.');
check('entry first line width', bib.get(1)!.width, 70 - 50 + 'A. Author, “First paper,” 2020.'.length * 5);
const hits = findCitations(runs, bib);
check('citations with entries (not [9], not the labels)', hits.map((h) => `${h.page}:${h.n}`), ['1:1', '1:2', '1:3', '1:3']);
check('hit sits over its number', Math.round(hits[0].x), Math.round(50 + 5 * ('Prior work ['.length - 0.5)));
check('no numbered list, no links', findBibliography([run(1, 'Smith et al. (2020) said [sic].', 0, 0)]), null);
// A citation of [1] made before the heading, and a "[1]" in the text after it that isn't a label.
const tricky = [...runs, run(2, 'as noted in', 50, 130), run(2, '[1]', 110, 130, 15)];
check('mid-line [1] after the list is not a label', findBibliography(tricky)!.get(1)!.y, 60);

if (failed) { console.log(`${failed} FAILED`); process.exit(1); }
