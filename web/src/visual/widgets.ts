// Widgets that stand in for LaTeX source in visual mode. Clicking a widget puts the cursor next
// to it, which reveals the source again (see decorations.ts).
import { WidgetType, EditorView } from '@codemirror/view';
import * as pdfjs from 'pdfjs-dist';
import { renderMath, type Macros } from './math.ts';
import { itemAt, resolveSpec, type ReviewKind } from '../review/model.ts';

// Served as-is by our server (server/index.ts), not through Vite.
pdfjs.GlobalWorkerOptions.workerSrc = '/vendor/pdf.worker.min.mjs';

const el = (tag: string, cls: string, text?: string) => {
  const e = document.createElement(tag);
  e.className = cls;
  if (text !== undefined) e.textContent = text;
  return e;
};

/** Replaces a brace or command name with nothing, or with a visible brace while editing. */
export class TextWidget extends WidgetType {
  constructor(readonly text: string, readonly cls = 'vc-brace') { super(); }
  eq(o: TextWidget) { return o.text === this.text && o.cls === this.cls; }
  toDOM() { return el('span', this.cls, this.text); }
  ignoreEvent() { return false; }
}

/** A compact chip, e.g. a citation, reference or label. */
export class ChipWidget extends WidgetType {
  constructor(readonly kind: string, readonly text: string, readonly title = '', readonly openPath?: string) { super(); }
  eq(o: ChipWidget) { return o.kind === this.kind && o.text === this.text && o.title === this.title && o.openPath === this.openPath; }
  toDOM() {
    const chip = el('span', `vc-chip vc-chip-${this.kind}`, this.text);
    if (this.title) chip.title = this.title;
    if (this.openPath) {
      chip.title = `Open ${this.openPath} (⌘/Ctrl+click)`;
      chip.addEventListener('mousedown', (e) => {
        if (!(e.metaKey || e.ctrlKey)) return;
        e.preventDefault();
        chip.dispatchEvent(new CustomEvent('vc-open-file', { detail: this.openPath, bubbles: true }));
      });
    }
    return chip;
  }
  ignoreEvent() { return false; }
}

export class MathWidget extends WidgetType {
  constructor(readonly tex: string, readonly display: boolean, readonly macrosKey: string, readonly macros: Macros, readonly preview = false) { super(); }
  eq(o: MathWidget) { return o.tex === this.tex && o.display === this.display && o.macrosKey === this.macrosKey && o.preview === this.preview; }
  toDOM() {
    const e = el(this.display ? 'div' : 'span', `vc-math${this.display ? ' vc-math-display' : ''}${this.preview ? ' vc-math-preview' : ''}`);
    renderMath(e, this.tex, this.display, this.macros);
    if (!this.preview) return e;
    const wrap = el('div', 'vc-math-preview-wrap'); // spacing as padding, see style.css
    wrap.append(e);
    return wrap;
  }
  updateDOM(dom: HTMLElement) {
    renderMath(this.preview ? (dom.firstElementChild as HTMLElement) : dom, this.tex, this.display, this.macros);
    return true;
  }
  ignoreEvent() { return this.preview; }
}

/** List bullet/number. */
export class ItemWidget extends WidgetType {
  constructor(readonly marker: string, readonly bold = false) { super(); }
  eq(o: ItemWidget) { return o.marker === this.marker && o.bold === this.bold; }
  toDOM() { return el('span', `vc-item-marker${this.bold ? ' vc-item-label' : ''}`, this.marker); }
  ignoreEvent() { return false; }
}

/** Replaces a \begin{...} or \end{...} line. `tag` is e.g. the \label on the same line. */
export class EnvLineWidget extends WidgetType {
  constructor(readonly kind: 'begin' | 'end' | 'hidden', readonly label = '', readonly tag = '') { super(); }
  eq(o: EnvLineWidget) { return o.kind === this.kind && o.label === this.label && o.tag === this.tag; }
  get estimatedHeight() { return this.kind === 'hidden' ? 0 : -1; }
  toDOM() {
    if (this.kind === 'hidden') return el('div', 'vc-hidden-line');
    const d = el('div', `vc-env-${this.kind}`, this.label);
    if (this.tag) d.append(el('span', 'vc-env-tag', this.tag));
    return d;
  }
  ignoreEvent() { return false; }
}

/** A run of comment lines, folded. */
export class CommentFoldWidget extends WidgetType {
  constructor(readonly lines: number, readonly preview: string) { super(); }
  eq(o: CommentFoldWidget) { return o.lines === this.lines && o.preview === this.preview; }
  toDOM() {
    const wrap = el('div', 'vc-comment-fold-wrap');
    const d = el('div', 'vc-comment-fold', `% ${this.lines} comment lines`);
    if (this.preview) d.append(el('span', 'vc-comment-fold-preview', ` · ${this.preview}`));
    d.title = 'Click to show the comments';
    wrap.append(d);
    return wrap;
  }
  ignoreEvent() { return false; }
}

export class PreambleWidget extends WidgetType {
  constructor(readonly lines: number) { super(); }
  eq(o: PreambleWidget) { return o.lines === this.lines; }
  toDOM() {
    const wrap = el('div', 'vc-preamble-wrap');
    wrap.append(el('div', 'vc-preamble', `Preamble · ${this.lines} lines (click to edit)`));
    return wrap;
  }
  ignoreEvent() { return false; }
}

export type TitleAuthor = { name: string; lines: string[] };
/**
 * Content the class prints below the title but that is set in the preamble (IEEEtran's
 * \IEEEaftertitletext): its figures and caption, and `at`, where its source starts.
 */
export type TitleExtra = { figures: { path: string; width: string | null }[]; caption: string; text: string; at: number };

export class TitleWidget extends WidgetType {
  constructor(readonly title: string, readonly authors: TitleAuthor[], readonly date: string, readonly extra: TitleExtra | null = null) { super(); }
  eq(o: TitleWidget) {
    return o.title === this.title && o.date === this.date && JSON.stringify(o.authors) === JSON.stringify(this.authors)
      && JSON.stringify(o.extra) === JSON.stringify(this.extra);
  }
  toDOM(view: EditorView) {
    const box = el('div', 'vc-maketitle');
    if (this.title) {
      const t = el('div', 'vc-title');
      this.title.split('\n').forEach((line, i) => { if (i) t.append(document.createElement('br')); t.append(line); });
      box.append(t);
    }
    if (this.authors.length) {
      // IEEE-style author blocks (name + affiliation lines) as columns; plain names inline.
      const blocks = this.authors.some((a) => a.lines.length);
      const row = el('div', blocks ? 'vc-author-blocks' : 'vc-authors');
      if (blocks) {
        for (const a of this.authors) {
          const b = el('div', 'vc-author-block');
          b.append(el('div', 'vc-author-name', a.name));
          for (const l of a.lines) b.append(el('div', 'vc-author-line', l));
          row.append(b);
        }
      } else row.textContent = this.authors.map((a) => a.name).join(' · ');
      box.append(row);
    }
    if (this.date) box.append(el('div', 'vc-date', this.date));
    if (!this.title && !this.authors.length) box.append(el('div', 'vc-date', '\\maketitle'));
    const extra = this.extra;
    if (extra) {
      // A preview: its source is in the (collapsed) preamble. Clicking opens it there.
      const x = el('div', 'vc-title-extra');
      x.title = 'Set in the preamble with \\IEEEaftertitletext: click to edit';
      for (const f of extra.figures) x.append(new GraphicsWidget(f.path, f.width, true).toDOM(view));
      if (extra.caption) x.append(el('div', 'vc-title-caption', extra.caption));
      if (extra.text) x.append(el('div', 'vc-title-text', extra.text));
      x.onclick = () => {
        view.dispatch({ selection: { anchor: extra.at }, effects: EditorView.scrollIntoView(extra.at, { y: 'center' }) });
        view.focus();
      };
      box.append(x);
    }
    return box;
  }
  ignoreEvent(e: Event) { return !!(e.target as HTMLElement).closest?.('.vc-title-extra'); }
}

// ---------- figures ----------

type Rendered = { src: string } | { error: string };
const figureCache = new Map<string, Promise<Rendered>>();

/** Folder of the main file (project-relative); LaTeX resolves figure paths from there. */
let assetBase = '';
export function setAssetBase(dir: string) {
  if (dir !== assetBase) { assetBase = dir; figureCache.clear(); }
}

async function loadFigure(path: string): Promise<Rendered> {
  const res = await fetch(`/api/asset?base=${encodeURIComponent(assetBase)}&path=${encodeURIComponent(path)}`);
  if (!res.ok) return { error: `Figure not found: ${path}` };
  const blob = await res.blob();
  if (blob.type !== 'application/pdf') return { src: URL.createObjectURL(blob) };
  const task = pdfjs.getDocument({ data: new Uint8Array(await blob.arrayBuffer()) });
  const doc = await task.promise;
  try {
    const page = await doc.getPage(1);
    const base = page.getViewport({ scale: 1 });
    const viewport = page.getViewport({ scale: Math.min(4, 1400 / base.width) });
    const canvas = document.createElement('canvas');
    canvas.width = Math.ceil(viewport.width);
    canvas.height = Math.ceil(viewport.height);
    await page.render({ canvas, viewport }).promise;
    return { src: canvas.toDataURL('image/png') };
  } finally {
    void task.destroy();
  }
}

export function invalidateFigures() { figureCache.clear(); }

export class GraphicsWidget extends WidgetType {
  constructor(readonly path: string, readonly width: string | null, readonly block: boolean) { super(); }
  eq(o: GraphicsWidget) { return o.path === this.path && o.width === this.width && o.block === this.block; }
  toDOM(view: EditorView) {
    const box = el(this.block ? 'div' : 'span', 'vc-graphics');
    const img = document.createElement('img');
    img.alt = this.path;
    img.title = this.path;
    if (this.width) img.style.width = this.width;
    box.append(img);
    let p = figureCache.get(this.path);
    if (!p) {
      p = loadFigure(this.path).catch((e) => ({ error: String(e?.message ?? e) }));
      figureCache.set(this.path, p);
    }
    void p.then((r) => {
      if ('src' in r) {
        img.onload = () => view.requestMeasure();
        img.src = r.src;
      } else {
        box.replaceChildren(el('span', 'vc-chip vc-chip-missing', r.error));
      }
    });
    return box;
  }
  ignoreEvent() { return false; }
}

// ---------- review ----------

/** A comment shown inline as a small note. */
export class CommentWidget extends WidgetType {
  constructor(readonly note: string, readonly author: string, readonly variant: 'comment' | 'note' = 'comment') { super(); }
  eq(o: CommentWidget) { return o.note === this.note && o.author === this.author && o.variant === this.variant; }
  toDOM() {
    const c = el('span', this.variant === 'note' ? 'rv-comment rv-note' : 'rv-comment');
    if (this.author) c.append(el('span', 'rv-comment-author', this.author));
    c.append(document.createTextNode(this.note || 'empty comment'));
    c.title = 'Comment: click to edit';
    return c;
  }
  ignoreEvent() { return false; }
}

/** Accept/reject buttons shown next to the change the cursor is in. */
export class ReviewActionsWidget extends WidgetType {
  constructor(readonly pos: number, readonly kind: ReviewKind) { super(); }
  eq(o: ReviewActionsWidget) { return o.pos === this.pos && o.kind === this.kind; }
  toDOM(view: EditorView) {
    const box = el('span', 'rv-actions');
    const button = (label: string, title: string, accept: boolean) => {
      const b = el('button', `rv-action ${accept ? 'rv-accept' : 'rv-reject'}`, label);
      b.title = title;
      b.addEventListener('mousedown', (e) => {
        e.preventDefault();
        e.stopPropagation();
        const it = itemAt(view.state, this.pos);
        if (it) view.dispatch(resolveSpec(view.state, [it], accept));
        view.focus();
      });
      return b;
    };
    if (this.kind === 'comment' || this.kind === 'highlight' || this.kind === 'note') {
      box.append(button('✓ Resolve', this.kind === 'highlight' ? 'Resolve comment (removes it, keeps the text)' : 'Resolve (delete the note)', true));
    }
    else box.append(button('✓', 'Accept change', true), button('✗', 'Reject change', false));
    return box;
  }
  ignoreEvent() { return true; }
}
