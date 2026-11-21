// Minimal PDF.js viewer: fit-to-width pages, zoom, scroll position kept across recompiles,
// SyncTeX highlights, double-click reporting in PDF coordinates, and clickable links: the PDF's
// own (hyperref) and, without them, numbered citations found in the text, with a Back button.
import * as pdfjs from 'pdfjs-dist';
import type { PDFDocumentProxy, PDFDocumentLoadingTask, PageViewport } from 'pdfjs-dist';
import { findBibliography, findCitations, type BibEntry, type Offset, type TextRun } from './pdf-links.ts';

// Served as-is by our server (server/index.ts), not through Vite.
pdfjs.GlobalWorkerOptions.workerSrc = '/vendor/pdf.worker.min.mjs';

const PAD = 16;

/** A box in PDF points, origin top-left of the page; v is the baseline, height goes up from it. */
export type PdfBox = { page: number; h: number; v: number; width: number; height: number };

type PageInfo = { wrap: HTMLElement; scale: number; base: PageViewport }; // scale: CSS px per PDF point
type Rect = { x: number; y: number; width: number; height: number }; // PDF points, top-left origin
/** A link on a page: to a place in the document, or to a URL. */
type PageLink = Rect & { title: string; url?: string; dest?: unknown; cite?: number };
/** Where a jump lands: a page and a box to flash (PDF points, top-left origin). */
type Target = { page: number } & Rect;

/**
 * Where a character of a text run starts, from the glyph widths of a similar font, with the extra
 * width of justified lines spread over the spaces (as TeX stretches them).
 */
function measuredOffset(): Offset {
  const ctx = document.createElement('canvas').getContext('2d');
  if (!ctx) return (r, i) => (r.str.length ? (r.width * i) / r.str.length : 0);
  const measure = (r: TextRun, s: string) => {
    ctx.font = `100px ${r.font || 'serif'}`;
    return (ctx.measureText(s).width / 100) * r.height;
  };
  return (r, i) => {
    const natural = measure(r, r.str);
    if (!natural) return (r.width * i) / Math.max(1, r.str.length);
    const spaces = (r.str.match(/ /g) ?? []).length;
    const before = r.str.slice(0, i);
    if (!spaces || natural > r.width) return (measure(r, before) / natural) * r.width;
    const extra = (r.width - natural) / spaces;
    return measure(r, before) + (before.match(/ /g) ?? []).length * extra;
  };
}

/** A tooltip for a link within the document, from hyperref's destination names. */
function linkTitle(dest: unknown): string {
  const kind = typeof dest === 'string' ? /^(cite|section|subsection|subsubsection|figure|table|equation|algorithm|page|Item|appendix)\./.exec(dest)?.[1] : undefined;
  const what: Record<string, string> = {
    cite: 'the reference', section: 'the section', subsection: 'the section', subsubsection: 'the section',
    figure: 'the figure', table: 'the table', equation: 'the equation', algorithm: 'the algorithm', page: 'the page',
    Item: 'the item', appendix: 'the appendix',
  };
  return `Go to ${kind ? what[kind] : 'the link target'}`;
}

export class PdfViewer {
  private doc: PDFDocumentProxy | null = null;
  private task: PDFDocumentLoadingTask | null = null;
  private zoom = 1; // relative to fit-width
  private renderToken = 0;
  private lastWidth = 0;
  private pages: PageInfo[] = [];
  private pendingBoxes: PdfBox[] | null = null;
  /** Called with a page number (1-based) and PDF-point coordinates on double-click. */
  onDoubleClick: ((page: number, x: number, y: number) => void) | null = null;
  /** Per document: each page's links, and the numbered reference list (found once). */
  private links: Promise<PageLink[][]> | null = null;
  private history: { top: number; left: number }[] = [];
  private backBtn: HTMLButtonElement;
  /** Called with the page in view (1-based) and the page count, whenever either changes. */
  onPageChange: ((page: number, count: number) => void) | null = null;
  private shownPage = 0;
  private pageFrame = 0;

  constructor(private container: HTMLElement) {
    this.backBtn = document.createElement('button');
    this.backBtn.className = 'pdf-back';
    this.backBtn.textContent = '← Back';
    this.backBtn.title = 'Back to where you were before following the link (Alt+←)';
    this.backBtn.hidden = true;
    this.backBtn.onclick = () => this.back();
    container.after(this.backBtn);
    container.addEventListener('keydown', (e) => {
      if (e.altKey && e.key === 'ArrowLeft' && this.history.length) { e.preventDefault(); this.back(); }
    });
    container.addEventListener('scroll', () => {
      if (!this.pageFrame) this.pageFrame = requestAnimationFrame(() => { this.pageFrame = 0; this.reportPage(); });
    }, { passive: true });
    // Ctrl (⌘ on a Mac) + wheel, or a touchpad pinch, zooms around the pointer.
    container.addEventListener('wheel', (e) => this.onWheel(e), { passive: false });
    container.addEventListener('mouseup', (e) => { if (e.button === 3 && this.history.length) { e.preventDefault(); this.back(); } });
    if (!container.hasAttribute('tabindex')) container.tabIndex = -1;
    let t: number | undefined;
    new ResizeObserver(() => {
      const w = this.container.clientWidth;
      if (Math.abs(w - this.lastWidth) < 2) return;
      clearTimeout(t);
      t = window.setTimeout(() => this.render(), 150);
    }).observe(container);
    container.addEventListener('dblclick', (e) => {
      const wrap = (e.target as HTMLElement).closest<HTMLElement>('.pdf-page-wrap');
      if (!wrap || !this.onDoubleClick) return;
      const info = this.pages[Number(wrap.dataset.page) - 1];
      const r = wrap.getBoundingClientRect();
      this.onDoubleClick(Number(wrap.dataset.page), (e.clientX - r.left) / info.scale, (e.clientY - r.top) / info.scale);
    });
  }

  async load(url: string) {
    const task = pdfjs.getDocument({ url });
    const doc = await task.promise;
    const old = this.task;
    this.task = task;
    this.doc = doc;
    this.links = null;
    await this.render();
    await old?.destroy();
  }

  private zoomTimer: number | undefined;

  private onWheel(e: WheelEvent) {
    if (!(e.ctrlKey || e.metaKey) || !this.pages.length) return;
    e.preventDefault();
    const dy = e.deltaMode === 1 ? e.deltaY * 16 : e.deltaMode === 2 ? e.deltaY * 400 : e.deltaY;
    const next = Math.min(4, Math.max(0.3, this.zoom * Math.exp(-Math.max(-100, Math.min(100, dy)) / 550)));
    const f = next / this.zoom;
    if (Math.abs(f - 1) < 1e-3) return;
    this.zoom = next;
    // Scale the pages already drawn right away (the canvases stretch), keeping the spot under the
    // pointer in place; draw them sharp at the new size once the wheel stops.
    const c = this.container;
    // The page under the pointer (or the nearest one), and where on it the pointer is.
    const anchor = this.pages.find((p) => p.wrap.getBoundingClientRect().bottom >= e.clientY) ?? this.pages[this.pages.length - 1];
    const before = anchor.wrap.getBoundingClientRect();
    const fx = (e.clientX - before.left) / before.width, fy = (e.clientY - before.top) / before.height;
    c.classList.add('pdf-zooming');
    for (const p of this.pages) {
      p.wrap.style.width = `${parseFloat(p.wrap.style.width) * f}px`;
      p.wrap.style.height = `${parseFloat(p.wrap.style.height) * f}px`;
      p.scale *= f;
    }
    const after = anchor.wrap.getBoundingClientRect();
    c.scrollLeft += after.left + fx * after.width - e.clientX;
    c.scrollTop += after.top + fy * after.height - e.clientY;
    clearTimeout(this.zoomTimer);
    this.zoomTimer = window.setTimeout(() => {
      void this.render().then(() => c.classList.remove('pdf-zooming'));
    }, 180);
  }

  setZoom(z: number) {
    this.zoom = Math.min(4, Math.max(0.3, z));
    this.render();
  }
  zoomIn() { this.setZoom(this.zoom * 1.15); }
  zoomOut() { this.setZoom(this.zoom / 1.15); }
  fit() { this.setZoom(1); }
  get zoomLevel() { return this.zoom; }
  get pageCount() { return this.doc?.numPages ?? 0; }

  /** Renders into a detached element, then swaps it in, so recompiles don't flicker. */
  async render() {
    const doc = this.doc;
    if (!doc) return;
    const token = ++this.renderToken;
    const c = this.container;
    const scrollRatio = c.scrollHeight > 0 ? c.scrollTop / c.scrollHeight : 0;
    const scrollLeftRatio = c.scrollWidth > 0 ? c.scrollLeft / c.scrollWidth : 0;
    this.lastWidth = c.clientWidth;
    const available = Math.max(100, c.clientWidth - PAD * 2);
    const dpr = window.devicePixelRatio || 1;

    const pagesEl = document.createElement('div');
    pagesEl.className = 'pdf-pages';
    const pages: PageInfo[] = [];
    for (let i = 1; i <= doc.numPages; i++) {
      const page = await doc.getPage(i);
      if (token !== this.renderToken) return;
      const base = page.getViewport({ scale: 1 });
      const scale = (available / base.width) * this.zoom;
      const viewport = page.getViewport({ scale: scale * dpr });
      const canvas = document.createElement('canvas');
      canvas.className = 'pdf-page';
      canvas.width = Math.floor(viewport.width);
      canvas.height = Math.floor(viewport.height);
      const wrap = document.createElement('div');
      wrap.className = 'pdf-page-wrap';
      wrap.dataset.page = String(i);
      wrap.style.width = `${Math.floor(viewport.width / dpr)}px`;
      wrap.style.height = `${Math.floor(viewport.height / dpr)}px`;
      wrap.append(canvas);
      await page.render({ canvas, viewport }).promise;
      if (token !== this.renderToken) return;
      pagesEl.append(wrap);
      pages.push({ wrap, scale, base });
    }
    c.replaceChildren(pagesEl);
    this.pages = pages;
    void this.addLinks(doc, token);
    this.shownPage = 0;
    this.reportPage();
    c.scrollTop = scrollRatio * c.scrollHeight;
    c.scrollLeft = scrollLeftRatio * c.scrollWidth;
    if (this.pendingBoxes) {
      const boxes = this.pendingBoxes;
      this.pendingBoxes = null;
      this.showBoxes(boxes);
    }
  }

  /** Scroll to SyncTeX boxes and flash a highlight over them. */
  showBoxes(boxes: PdfBox[]) {
    if (!boxes.length) return;
    if (!this.pages.length) { this.pendingBoxes = boxes; return; }
    const first = boxes[0];
    const info = this.pages[first.page - 1];
    if (!info) return;
    const c = this.container;
    const top = Math.min(...boxes.filter((b) => b.page === first.page).map((b) => b.v - b.height));
    const wrapTop = info.wrap.getBoundingClientRect().top - c.getBoundingClientRect().top + c.scrollTop;
    c.scrollTo({ top: Math.max(0, wrapTop + top * info.scale - c.clientHeight / 3), behavior: 'smooth' });
    for (const b of boxes) {
      const p = this.pages[b.page - 1];
      if (!p) continue;
      const mark = document.createElement('div');
      mark.className = 'pdf-highlight';
      Object.assign(mark.style, {
        left: `${b.h * p.scale - 2}px`,
        top: `${(b.v - b.height) * p.scale - 3}px`,
        width: `${b.width * p.scale + 4}px`,
        height: `${b.height * p.scale + 6}px`,
      });
      p.wrap.append(mark);
      setTimeout(() => mark.remove(), 1800);
    }
  }

  /** The page in view: the one at a third of the way down the pane (the last one at the bottom). */
  get currentPage(): number {
    if (!this.pages.length) return 0;
    const c = this.container;
    if (c.scrollTop + c.clientHeight >= c.scrollHeight - 2) return this.pages.length;
    const line = c.getBoundingClientRect().top + Math.min(c.clientHeight / 3, 200);
    let page = 1;
    this.pages.forEach((p, i) => { if (p.wrap.getBoundingClientRect().top <= line) page = i + 1; });
    return page;
  }

  private reportPage() {
    const page = this.currentPage;
    if (page === this.shownPage) return;
    this.shownPage = page;
    this.onPageChange?.(page, this.pages.length);
  }

  /** Scroll so page `n` (1-based) starts at the top of the pane. */
  goToPage(n: number) {
    const info = this.pages[Math.min(this.pages.length, Math.max(1, Math.round(n))) - 1];
    if (!info) return;
    const c = this.container;
    c.scrollTop += info.wrap.getBoundingClientRect().top - c.getBoundingClientRect().top - 8;
    this.reportPage();
  }

  /** Put each page's links over it, once they're known. */
  private async addLinks(doc: PDFDocumentProxy, token: number) {
    let all: PageLink[][];
    try {
      this.links ??= this.findLinks(doc);
      all = await this.links;
    } catch (err) {
      console.warn('PDF links:', err);
      return;
    }
    if (token !== this.renderToken || doc !== this.doc) return;
    this.pages.forEach((p, i) => {
      for (const l of all[i] ?? []) {
        const a = document.createElement('a');
        a.className = l.cite ? 'pdf-link pdf-cite' : 'pdf-link';
        a.title = l.title;
        if (l.url) a.href = l.url;
        Object.assign(a.style, {
          left: `${l.x * p.scale}px`, top: `${l.y * p.scale}px`,
          width: `${l.width * p.scale}px`, height: `${l.height * p.scale}px`,
        });
        a.addEventListener('click', (e) => {
          e.preventDefault();
          e.stopPropagation();
          if (l.url) { window.open(l.url, '_blank', 'noopener'); return; }
          void this.follow(l.dest);
        });
        a.addEventListener('dblclick', (e) => e.stopPropagation()); // not a SyncTeX jump
        p.wrap.append(a);
      }
    });
  }

  /** The PDF's own links on every page; failing those, its numbered citations. */
  private async findLinks(doc: PDFDocumentProxy): Promise<PageLink[][]> {
    const out: PageLink[][] = [];
    const runs: TextRun[] = [];
    let internal = 0;
    for (let i = 1; i <= doc.numPages; i++) {
      const page = await doc.getPage(i);
      const base = page.getViewport({ scale: 1 });
      const links: PageLink[] = [];
      for (const a of await page.getAnnotations({ intent: 'display' })) {
        if (a.subtype !== 'Link' || !a.rect) continue;
        const [x1, y1] = base.convertToViewportPoint(a.rect[0], a.rect[1]);
        const [x2, y2] = base.convertToViewportPoint(a.rect[2], a.rect[3]);
        const box = { x: Math.min(x1, x2), y: Math.min(y1, y2), width: Math.abs(x2 - x1), height: Math.abs(y2 - y1) };
        if (a.url && /^(https?|mailto):/i.test(a.url)) links.push({ ...box, url: a.url, title: a.url });
        else if (a.dest) { links.push({ ...box, dest: a.dest, title: linkTitle(a.dest) }); internal++; }
      }
      out.push(links);
      const content = await page.getTextContent();
      for (const item of content.items) {
        if (!('str' in item) || !item.str.trim()) continue;
        const t = item.transform;
        const [x, baseline] = base.convertToViewportPoint(t[4], t[5]);
        const height = item.height || Math.hypot(t[2], t[3]);
        runs.push({ page: i, str: item.str, x, y: baseline - height, width: item.width, height, font: content.styles[item.fontName]?.fontFamily });
      }
    }
    // hyperref already links citations; only find them in the text when the PDF has no links.
    if (internal) return out;
    const bib = findBibliography(runs);
    if (!bib) return out;
    for (const c of findCitations(runs, bib, measuredOffset())) {
      const e = bib.get(c.n)!;
      out[c.page - 1].push({ x: c.x, y: c.y, width: c.width, height: c.height, cite: c.n, dest: e, title: `[${c.n}] ${e.text}` });
    }
    return out;
  }

  /** Jump to a link's destination: a hyperref destination, or a reference list entry. */
  private async follow(dest: unknown) {
    const doc = this.doc;
    if (!doc) return;
    let target: Target | null = null;
    if (dest && typeof dest === 'object' && 'text' in dest) {
      const e = dest as BibEntry;
      target = { page: e.page, x: e.x, y: e.y, width: e.width, height: e.height };
    } else {
      const explicit = typeof dest === 'string' ? await doc.getDestination(dest) : dest;
      if (!Array.isArray(explicit) || explicit[0] == null) return;
      const ref = explicit[0];
      const index = typeof ref === 'object' ? await doc.getPageIndex(ref) : Number(ref);
      const info = this.pages[index];
      if (!info) return;
      const kind = explicit[1]?.name;
      const top = kind === 'XYZ' ? explicit[3] : kind === 'FitH' || kind === 'FitBH' ? explicit[2] : null;
      const left = kind === 'XYZ' && typeof explicit[2] === 'number' ? explicit[2] : 0;
      const [x, y] = typeof top === 'number' ? info.base.convertToViewportPoint(left, top) : [0, 0];
      target = { page: index + 1, x, y, width: info.base.width - x - 36, height: 14 };
    }
    this.jumpTo(target);
  }

  private jumpTo(t: Target) {
    const info = this.pages[t.page - 1];
    if (!info) return;
    const c = this.container;
    this.history.push({ top: c.scrollTop, left: c.scrollLeft });
    this.backBtn.hidden = false;
    const wrapTop = info.wrap.getBoundingClientRect().top - c.getBoundingClientRect().top + c.scrollTop;
    c.scrollTo({ top: Math.max(0, wrapTop + t.y * info.scale - c.clientHeight / 3), behavior: 'smooth' });
    const mark = document.createElement('div');
    mark.className = 'pdf-highlight';
    Object.assign(mark.style, {
      left: `${t.x * info.scale - 3}px`, top: `${t.y * info.scale - 3}px`,
      width: `${Math.max(t.width, 20) * info.scale + 6}px`, height: `${t.height * info.scale + 6}px`,
    });
    info.wrap.append(mark);
    setTimeout(() => mark.remove(), 1800);
    c.focus({ preventScroll: true });
  }

  /** Back to where the last link was followed from. */
  back() {
    const to = this.history.pop();
    if (to) this.container.scrollTo({ top: to.top, left: to.left, behavior: 'smooth' });
    this.backBtn.hidden = this.history.length === 0;
  }

  clear(message: string) {
    this.renderToken++;
    this.pages = [];
    this.shownPage = 0;
    this.onPageChange?.(0, 0);
    const p = document.createElement('p');
    p.className = 'pdf-empty';
    p.textContent = message;
    this.container.replaceChildren(p);
  }
}
