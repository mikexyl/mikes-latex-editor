// \newcommand-style macros for KaTeX: collected from documents, plus project-wide ones from the
// main file's preamble. Kept separate from math.ts so it has no CSS import (unit-testable).
export type Macros = Record<string, string>;

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

// Macros from the main file's preamble (and macro files it loads), shared by every file of the
// project: an included section uses \R or \SE defined in main.tex. Set by the app.
let projectMacros: Macros = {};
let projectKey = '';

/** Set the project-wide macros; returns true if they changed (so views should re-render). */
export function setProjectMacros(macros: Macros): boolean {
  const key = JSON.stringify(macros);
  if (key === projectKey) return false;
  projectMacros = macros;
  projectKey = key;
  return true;
}

const ownCache = new WeakMap<object, { key: string; macros: Macros }>();

/** Macros for a document: the project's plus its own (its own win). `key` changes only when they do. */
export function macrosFor(doc: object, text: () => string): { key: string; macros: Macros } {
  let own = ownCache.get(doc);
  if (!own) {
    const macros = collectMacros(text());
    own = { key: JSON.stringify(macros), macros };
    ownCache.set(doc, own);
  }
  let hit = cache.get(doc);
  const key = `${projectKey}|${own.key}`;
  if (!hit || hit.key !== key) {
    hit = { key, macros: { ...projectMacros, ...own.macros } };
    cache.set(doc, hit);
  }
  return hit;
}
