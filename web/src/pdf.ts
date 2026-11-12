// Minimal PDF.js viewer: fit-to-width pages, zoom, scroll position kept across recompiles,
// SyncTeX highlights, and double-click reporting in PDF coordinates.
import * as pdfjs from 'pdfjs-dist';
import type { PDFDocumentProxy, PDFDocumentLoadingTask } from 'pdfjs-dist';

// Served as-is by our server (server/index.ts), not through Vite.
pdfjs.GlobalWorkerOptions.workerSrc = '/vendor/pdf.worker.min.mjs';

const PAD = 16;

/** A box in PDF points, origin top-left of the page; v is the baseline, height goes up from it. */
export type PdfBox = { page: number; h: number; v: number; width: number; height: number };

type PageInfo = { wrap: HTMLElement; scale: number }; // scale: CSS px per PDF point

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

  constructor(private container: HTMLElement) {
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
    await this.render();
    await old?.destroy();
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
      pages.push({ wrap, scale });
    }
    c.replaceChildren(pagesEl);
    this.pages = pages;
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

  clear(message: string) {
    this.renderToken++;
    this.pages = [];
    const p = document.createElement('p');
    p.className = 'pdf-empty';
    p.textContent = message;
    this.container.replaceChildren(p);
  }
}
