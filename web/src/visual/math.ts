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
  // eqnarray is not supported by KaTeX; align is close enough for review purposes.
  tex = tex.replace(/\\(begin|end)\{eqnarray(\*?)\}/g, '\\$1{align$2}').replace(/&\s*=\s*&/g, '&=');
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

// ---------- macro collection ----------

const cache = new WeakMap<object, { key: string; macros: Macros }>();

/** Reads a balanced {...} group starting at text[open] === '{'. Returns the inner text and end index. */
function readGroup(text: string, open: number): { body: string; end: number } | null {
  if (text[open] !== '{') return null;
  let depth = 0;
  for (let i = open; i < text.length; i++) {
    const c = text[i];
    if (c === '\\') { i++; continue; }
    if (c === '{') depth++;
    else if (c === '}' && --depth === 0) return { body: text.slice(open + 1, i), end: i + 1 };
  }
  return null;
}

export function collectMacros(text: string): Macros {
  const src = text.replace(/(^|[^\\])%.*$/gm, '$1'); // drop comments
  const macros: Macros = {};
  const patterns: [RegExp, (m: RegExpExecArray, body: string) => void][] = [
    [/\\(?:re|provide)?newcommand\*?\s*\{?\s*(\\[A-Za-z@]+)\s*\}?\s*(?:\[\d\])?\s*(?:\[[^\]]*\])?\s*(?=\{)/g,
      (m, body) => { macros[m[1]] = body; }],
    [/\\DeclareMathOperator(\*?)\s*\{\s*(\\[A-Za-z@]+)\s*\}\s*(?=\{)/g,
      (m, body) => { macros[m[2]] = `\\operatorname${m[1]}{${body}}`; }],
    [/\\def\s*(\\[A-Za-z@]+)\s*(?:#\d)*\s*(?=\{)/g,
      (m, body) => { macros[m[1]] = body; }],
  ];
  for (const [re, add] of patterns) {
    let m: RegExpExecArray | null;
    while ((m = re.exec(src))) {
      const g = readGroup(src, re.lastIndex);
      if (g) { add(m, g.body); re.lastIndex = g.end; }
    }
  }
  return macros;
}

/** Macros for a document, cached per document version. `key` changes only when macros do. */
export function macrosFor(doc: object, text: () => string): { key: string; macros: Macros } {
  let hit = cache.get(doc);
  if (!hit) {
    const macros = collectMacros(text());
    hit = { key: JSON.stringify(macros), macros };
    cache.set(doc, hit);
  }
  return hit;
}
