// Copying LaTeX source: a whole file (toolbar, inline file headers) or one (sub)section, from its
// heading to the next heading of the same or a higher level (the Copy button on headings in
// visual mode).
import { WidgetType, type EditorView } from '@codemirror/view';

const RANK: Record<string, number> = {
  part: 0, chapter: 1, section: 2, subsection: 3, subsubsection: 4, paragraph: 5, subparagraph: 6,
};
const HEADING = /^[ \t]*\\(part|chapter|section|subsection|subsubsection|paragraph|subparagraph)\*?\s*[[{]/;
// Where the last section of the body ends, whatever its level.
const BODY_END = /^[ \t]*\\(?:end\s*\{document\}|appendix\b|bibliography\s*\{|printbibliography\b|begin\s*\{thebibliography\})/;

/**
 * The (sub)section whose heading is on the line at `pos`: from the start of that line to the next
 * heading of the same or a higher level (or the end of the body / file), without trailing blank
 * lines. Null if there's no heading on that line.
 */
export function sectionRange(text: string, pos: number): { from: number; to: number; title: string } | null {
  const from = text.lastIndexOf('\n', pos - 1) + 1;
  const firstEnd = text.indexOf('\n', from);
  const first = text.slice(from, firstEnd < 0 ? text.length : firstEnd);
  const m = HEADING.exec(first);
  if (!m) return null;
  const rank = RANK[m[1]];
  let to = text.length;
  for (let p = firstEnd < 0 ? text.length : firstEnd + 1; p < text.length;) {
    const e = text.indexOf('\n', p);
    const line = text.slice(p, e < 0 ? text.length : e);
    const h = HEADING.exec(line);
    if ((h && RANK[h[1]] <= rank) || BODY_END.test(line)) { to = p; break; }
    if (e < 0) break;
    p = e + 1;
  }
  while (to > from && /\s/.test(text[to - 1])) to--;
  const title = /\{([^{}]*)/.exec(first.slice(m[0].length - 1))?.[1]?.trim() || m[1];
  return { from, to, title };
}

/** Put text on the clipboard. */
export async function copyText(text: string): Promise<void> {
  try {
    await navigator.clipboard.writeText(text);
  } catch {
    // Fallback when the async clipboard is unavailable (unfocused document, older WebViews).
    const ta = document.createElement('textarea');
    ta.value = text;
    ta.style.position = 'fixed';
    ta.style.opacity = '0';
    document.body.append(ta);
    ta.select();
    const ok = document.execCommand('copy');
    ta.remove();
    if (!ok) throw new Error('The clipboard is not available');
  }
}

/** Briefly show that a button did its job. */
export function flash(button: HTMLElement, text: string) {
  const before = button.dataset.label ?? button.textContent ?? '';
  button.dataset.label = before;
  button.textContent = text;
  clearTimeout(Number(button.dataset.timer));
  button.dataset.timer = String(window.setTimeout(() => { button.textContent = before; }, 1500));
}

/** The Copy button after a heading in visual mode: copies that (sub)section's source. */
export class CopySectionWidget extends WidgetType {
  constructor(readonly level: string) { super(); }
  eq(o: CopySectionWidget) { return o.level === this.level; }

  toDOM(view: EditorView) {
    const b = document.createElement('button');
    b.className = 'vc-copy-section';
    b.textContent = 'Copy';
    b.title = `Copy the LaTeX source of this ${this.level}`;
    b.onmousedown = (e) => e.preventDefault(); // don't move the cursor into the heading
    b.onclick = async (e) => {
      e.preventDefault();
      e.stopPropagation();
      const range = sectionRange(view.state.doc.toString(), view.posAtDOM(b));
      if (!range) return;
      try {
        await copyText(view.state.sliceDoc(range.from, range.to));
        const lines = view.state.doc.lineAt(range.to).number - view.state.doc.lineAt(range.from).number + 1;
        flash(b, `Copied ${lines} line${lines === 1 ? '' : 's'}`);
      } catch (err) {
        flash(b, (err as Error).message);
      }
    };
    return b;
  }

  ignoreEvent() { return true; }
}
