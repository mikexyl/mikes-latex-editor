// Math rendering with KaTeX, plus picking up \newcommand-style macros from the document.
import katex from 'katex';
import 'katex/dist/katex.min.css';
import { labelsToTags } from './eq-labels.ts';

export type Macros = Record<string, string>;

/** Environments KaTeX renders directly in display mode. Others are converted or wrapped. */
const KATEX_ENVS = new Set([
  'equation', 'equation*', 'align', 'align*', 'alignat', 'alignat*', 'gather', 'gather*',
  'multline', 'multline*', 'split', 'aligned', 'gathered', 'cases', 'CD',
]);

/**
 * `labels`: 'tag' shows each \label as its row's tag (KaTeX allows tags only in display math),
 * 'notag' drops it and the row's number (the label is shown elsewhere), 'drop' just drops it.
 */
export function prepareMath(content: string, labels: 'tag' | 'notag' | 'drop' = 'tag'): string {
  let tex = (labels === 'tag' ? labelsToTags(content) : content.replace(/\\label\s*\{[^}]*\}/g, labels === 'notag' ? '\\notag ' : ''))
    .replace(/\\nonumber\b/g, '\\notag');
  // eqnarray and IEEEeqnarray (rCl columns: `a & = & b`) aren't supported by KaTeX; align with
  // the relation moved into the right column looks the same (and keeps equation numbers).
  const REL = String.raw`(=|<|>|\\le|\\ge|\\leq|\\geq|\\approx|\\equiv|\\sim|\\simeq|\\propto|\\neq|\\ne|:=|\\triangleq)`;
  tex = tex
    .replace(/\\(begin|end)\{eqnarray(\*?)\}/g, '\\$1{align$2}')
    .replace(/\\begin\{IEEEeqnarray(\*?)\}(\[[^\]]*\])?\{[^}]*\}/g, '\\begin{align$1}')
    .replace(/\\end\{IEEEeqnarray(\*?)\}/g, '\\end{align$1}')
    .replace(/\\IEEEnonumber\*?/g, '\\notag')
    .replace(/\\(IEEEyesnumber|IEEEeqnarraynumspace|IEEEyessubnumber)\*?/g, '')
    .replace(new RegExp(String.raw`&\s*` + REL + String.raw`\s*&`, 'g'), '&$1');
  const env = /^\s*\\begin\{([^}]+)\}/.exec(tex)?.[1];
  if (env && !KATEX_ENVS.has(env)) {
    // Unknown display environment (e.g. flalign): render its body as gathered lines.
    tex = tex.replace(/^\s*\\begin\{[^}]+\}(\{[^}]*\})?/, '\\begin{gathered}').replace(/\\end\{[^}]+\}\s*$/, '\\end{gathered}');
  }
  return tex;
}

export function renderMath(el: HTMLElement, tex: string, display: boolean, macros: Macros, tagLabels = display) {
  try {
    katex.render(prepareMath(tex, !display ? 'drop' : tagLabels ? 'tag' : 'notag'), el, {
      displayMode: display,
      throwOnError: true,
      strict: 'ignore',
      trust: (ctx) => ctx.command === '\\htmlClass', // only for equation labels (eq-labels.ts)
      macros: { ...macros }, // KaTeX mutates this when the math itself uses \def
    });
    el.classList.remove('vc-math-error');
    el.removeAttribute('title');
  } catch (e) {
    el.textContent = tex;
    el.classList.add('vc-math-error');
    el.title = String((e as Error).message ?? e);
  }
}

// Macro collection lives in macros.ts (no CSS import, so it can be unit-tested in Node).
export { collectMacros, setProjectMacros, macrosFor } from './macros.ts';
