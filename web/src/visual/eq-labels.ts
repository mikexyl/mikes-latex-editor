// Equation labels in visual mode: KaTeX doesn't know the paper's equation numbers, so each
// \label{eq:x} is shown as the equation's tag, "(eq:x)", the same text an \eqref{eq:x} chip shows.

/** The label as text-mode TeX for KaTeX. */
function escapeText(s: string): string {
  return s.replace(/[\\_#$%&{}~^]/g, (c) => (
    c === '\\' ? '\\textbackslash{}' : c === '~' ? '\\textasciitilde{}' : c === '^' ? '\\textasciicircum{}' : `\\${c}`
  ));
}

/**
 * Each \label{..} becomes a \tag on its row (the stretch between the nearest \\ on either side),
 * wrapped in \htmlClass{vc-eq-label}. Rows that already have a \tag just lose the \label.
 */
export function labelsToTags(tex: string): string {
  const re = /\\label\s*\{([^}]*)\}/g;
  let out = '';
  let last = 0;
  for (let m: RegExpExecArray | null; (m = re.exec(tex));) {
    const before = tex.lastIndexOf('\\\\', m.index);
    const afterAt = tex.indexOf('\\\\', m.index + m[0].length);
    const row = tex.slice(before < 0 ? 0 : before + 2, afterAt < 0 ? tex.length : afterAt);
    const label = m[1].trim();
    const tagged = /\\tag\b/.test(row) || !label;
    out += tex.slice(last, m.index) + (tagged ? '' : `\\tag{\\htmlClass{vc-eq-label}{\\text{${escapeText(label)}}}}`);
    last = m.index + m[0].length;
  }
  return out + tex.slice(last);
}

/** The labels in an equation, in order. */
export function equationLabels(tex: string): string[] {
  return [...tex.matchAll(/\\label\s*\{([^}]*)\}/g)].map((m) => m[1].trim()).filter(Boolean);
}
