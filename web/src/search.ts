// Project-wide search: matching in one file's text. main.ts runs it over every text file (with
// unsaved edits), shows the results in the sidebar and does replacements through the editors.

export type SearchOptions = { query: string; caseSensitive: boolean; wholeWord: boolean; regex: boolean };
export type Match = { from: number; to: number; line: number; text: string; lineText: string; lineFrom: number };

/** The query as a global RegExp, or an error message for a bad regular expression. */
export function compileQuery(o: SearchOptions): RegExp | string | null {
  if (!o.query) return null;
  let source = o.regex ? o.query : o.query.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  if (o.wholeWord) source = `(?<![\\p{L}\\p{N}_])(?:${source})(?![\\p{L}\\p{N}_])`;
  try {
    return new RegExp(source, `gu${o.caseSensitive ? '' : 'i'}m`);
  } catch (e) {
    return (e as Error).message.replace(/^Invalid regular expression: /, '');
  }
}

/** Matches of `re` in `text`, at most `limit`. Empty matches are skipped. */
export function findMatches(text: string, re: RegExp, limit = 1000): Match[] {
  const out: Match[] = [];
  re.lastIndex = 0;
  let lineNo = 1;
  let lineStart = 0;
  let scanned = 0; // line counting has reached here
  for (let m = re.exec(text); m && out.length < limit; m = re.exec(text)) {
    if (m[0] === '') { re.lastIndex++; continue; }
    for (let i = text.indexOf('\n', scanned); i !== -1 && i < m.index; i = text.indexOf('\n', i + 1)) {
      lineNo++;
      lineStart = i + 1;
    }
    scanned = m.index;
    const lineEnd = text.indexOf('\n', m.index);
    out.push({
      from: m.index, to: m.index + m[0].length, line: lineNo, text: m[0],
      lineText: text.slice(lineStart, lineEnd === -1 ? text.length : lineEnd), lineFrom: lineStart,
    });
  }
  return out;
}

/** What one match is replaced with: `$1` etc. work with regular expressions. */
export function replacementFor(match: string, re: RegExp, replacement: string, regex: boolean): string {
  if (!regex) return replacement;
  const single = new RegExp(re.source, re.flags.replace('g', ''));
  return match.replace(single, replacement);
}
