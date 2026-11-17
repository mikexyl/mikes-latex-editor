// Finding numbered citations ("[2]", "[3, 5]", "[4–7]") and the reference list entries they point
// to in a PDF's text, for PDFs without hyperref links. Works on pdf.js text items converted to
// top-left page coordinates, in PDF points.

/** A run of text on a page: x/y top-left of the glyph box (y is the top), in PDF points. */
export type TextRun = { page: number; str: string; x: number; y: number; width: number; height: number; font?: string };
/** Where character `i` of a run starts, in PDF points from the run's left edge. */
export type Offset = (run: TextRun, i: number) => number;
/** The default: every character the same width. */
const byChars: Offset = (r, i) => (r.str.length ? (r.width * i) / r.str.length : 0);
/** A clickable number inside a citation, and where it is on the page. */
export type CiteHit = { n: number; page: number; x: number; y: number; width: number; height: number };
/** A reference list entry: where its "[n]" label is, and how far the first line reaches. */
export type BibEntry = { page: number; x: number; y: number; width: number; height: number; text: string };

const CITE = /\[(\s*\d+(?:\s*[–—-]\s*\d+)?(?:\s*[,;]\s*\d+(?:\s*[–—-]\s*\d+)?)*\s*)\]/g;
const LABEL = /^\s*\[(\d+)\]/;
const HEADING = /^\s*(?:\d+\.?\s*|[IVX]+\.?\s*)?(?:references|bibliography|works cited)\s*$/i;

/** The numbers in each citation of `str`, with their character offsets. */
export function citationNumbers(str: string): { n: number; start: number; end: number }[] {
  const out: { n: number; start: number; end: number }[] = [];
  for (const m of str.matchAll(CITE)) {
    const base = m.index! + 1;
    for (const d of m[1].matchAll(/\d+/g)) {
      out.push({ n: Number(d[0]), start: base + d.index!, end: base + d.index! + d[0].length });
    }
  }
  return out;
}

/**
 * The reference list: for each number, its "[n]" label at the start of a run, after the
 * "References" heading if there is one (otherwise the last label with that number). Null when the
 * document doesn't look like it has a numbered reference list.
 */
export function findBibliography(runs: TextRun[]): Map<number, BibEntry> | null {
  let start = 0;
  for (let i = runs.length - 1; i >= 0; i--) if (HEADING.test(runs[i].str)) { start = i + 1; break; }
  const entries = new Map<number, BibEntry>();
  for (let i = start; i < runs.length; i++) {
    const r = runs[i];
    const m = LABEL.exec(r.str);
    if (!m) continue;
    // A label starts its line: nothing just before it on the same baseline.
    const prev = runs[i - 1];
    if (prev && prev.page === r.page && Math.abs(prev.y - r.y) < r.height * 0.5 && prev.x < r.x && r.x - (prev.x + prev.width) < r.height * 2) continue;
    // The first line of the entry: the runs that follow on the same baseline.
    let right = r.x + r.width;
    for (let j = i + 1; j < runs.length; j++) {
      const s = runs[j];
      if (s.page !== r.page || Math.abs(s.y - r.y) > r.height * 0.5 || s.x < right - 1 || s.x - right > r.height * 3) break;
      right = s.x + s.width;
    }
    // The entry's text (for a tooltip): up to the next label.
    let text = r.str.replace(LABEL, '');
    for (let j = i + 1; j < runs.length && text.length < 300 && !LABEL.test(runs[j].str) && !HEADING.test(runs[j].str); j++) {
      text += (/[-‐]$/.test(text) ? '' : ' ') + runs[j].str;
    }
    text = text.replace(/\s+/g, ' ').trim();
    entries.set(Number(m[1]), { page: r.page, x: r.x, y: r.y, width: right - r.x, height: r.height, text: text.length > 280 ? text.slice(0, 277) + '…' : text });
  }
  // A numbered list starts at [1] and has a few entries.
  if (!entries.has(1) || entries.size < 2) return null;
  return entries;
}

/** The citation numbers on the pages that have an entry in `bib`, each with its box. */
export function findCitations(runs: TextRun[], bib: Map<number, BibEntry>, offset: Offset = byChars): CiteHit[] {
  const hits: CiteHit[] = [];
  for (const r of runs) {
    if (!r.str.includes('[')) continue;
    for (const c of citationNumbers(r.str)) {
      const entry = bib.get(c.n);
      if (!entry) continue;
      // Skip the reference list's own labels.
      if (entry.page === r.page && Math.abs(entry.y - r.y) < 0.5 && Math.abs(entry.x - r.x) < 0.5 && c.start <= 2) continue;
      // Widen by half a character each side, so the brackets around a lone number count too.
      const from = offset(r, c.start), to = offset(r, c.end);
      const pad = (to - from) / (c.end - c.start) / 2;
      hits.push({ n: c.n, page: r.page, x: r.x + from - pad, y: r.y, width: to - from + 2 * pad, height: r.height });
    }
  }
  return hits;
}
