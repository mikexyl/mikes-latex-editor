// Which source a TikZ picture in visual mode is drawn from (decorations.ts).

// A box command scaling or rotating the picture it wraps: \resizebox{\linewidth}{!}{% … }.
const BOX_BEFORE = /\\(?:resizebox\*?|scalebox|adjustbox|rotatebox)(?:\s*\[[^\]]*\])?(?:\s*\{(?:[^{}]|\{[^{}]*\})*\})*\s*\{(?:\s|%[^\n]*\n)*$/;
const BOX_AFTER = /^(?:\s|%[^\n]*\n)*\}[ \t]*(?:%[^\n]*)?(?=\n|$)/;

/**
 * A tikzpicture shown as one picture: the environment alone on its lines, or the box command
 * around it (\resizebox, \scalebox, …) if that's what stands alone, so it's drawn at the size the
 * paper uses.
 */
export function tikzSpan(text: string, from: number, to: number): { from: number; to: number } | null {
  const lineStart = (p: number) => text.lastIndexOf('\n', p - 1) + 1;
  const lineEnd = (p: number) => { const e = text.indexOf('\n', p); return e < 0 ? text.length : e; };
  const alone = (a: number, b: number) => !text.slice(lineStart(a), a).trim() && !text.slice(b, lineEnd(b)).trim();
  // The box first: a picture alone on its lines may still be inside one (braces on their own lines).
  const before = BOX_BEFORE.exec(text.slice(Math.max(0, from - 400), from));
  const after = BOX_AFTER.exec(text.slice(to, to + 400));
  if (before && after) {
    const start = from - before[0].length;
    const end = to + after[0].replace(/[ \t]*(?:%[^\n]*)?$/, '').length;
    // BOX_AFTER already checked that only a comment can follow the closing brace on its line.
    if (!text.slice(lineStart(start), start).trim()) return { from: start, to: end };
  }
  return alone(from, to) ? { from, to } : null;
}
