// Math rendering with KaTeX, plus picking up \newcommand-style macros from the document.
import katex from 'katex';
import 'katex/dist/katex.min.css';

export type Macros = Record<string, string>;

/** Environments KaTeX renders directly in display mode. Others are converted or wrapped. */
const KATEX_ENVS = new Set([
  'equation', 'equation*', 'align', 'align*', 'alignat', 'alignat*', 'gather', 'gather*',
  'multline', 'multline*', 'split', 'aligned', 'gathered', 'cases', 'CD',
]);

export function prepareMath(content: string): string {
  let tex = content
    .replace(/\\label\s*\{[^}]*\}/g, '')
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

export function renderMath(el: HTMLElement, tex: string, display: boolean, macros: Macros) {
  try {
    katex.render(prepareMath(tex), el, {
      displayMode: display,
      throwOnError: true,
      strict: 'ignore',
      trust: false,
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
