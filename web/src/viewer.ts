// Viewer for the project's figure files (images and PDFs), shown over the editor in the editor
// pane. The editor stays underneath, untouched, so closing the viewer returns to it as it was.
import { PdfViewer } from './pdf.ts';

/** Files the viewer can show. Others (EPS, ...) stay unopenable in the file tree. */
export const VIEWABLE = /\.(pdf|png|jpe?g|gif|svg|webp|bmp|avif)$/i;

const $ = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T;

export class FileViewer {
  /** The file shown, or null when the editor is. */
  path: string | null = null;
  private pdf: PdfViewer | null = null;
  private img: HTMLImageElement | null = null;
  private zoom = 1; // 1 = fit
  private fitWidth = 0;

  constructor(private onClose: () => void) {
    $('fv-in').onclick = () => this.zoomBy(1.25);
    $('fv-out').onclick = () => this.zoomBy(1 / 1.25);
    $('fv-fit').onclick = () => this.setZoom(1);
    $('fv-close').onclick = () => this.onClose();
  }

  async show(path: string) {
    this.clear();
    this.path = path;
    $('file-viewer').hidden = false;
    $('fv-info').textContent = '';
    const url = `/api/asset?path=${encodeURIComponent(path)}&t=${Date.now()}`;
    const body = $('fv-body');
    if (/\.pdf$/i.test(path)) {
      const box = document.createElement('div');
      box.className = 'pdf fv-pdf';
      body.append(box);
      this.pdf = new PdfViewer(box);
      try {
        await this.pdf.load(url);
        if (this.path === path) $('fv-info').textContent = plural(this.pdf.pageCount, 'page');
      } catch (e) {
        this.fail(`Couldn't open ${path}: ${(e as Error).message}`);
      }
      return;
    }
    const wrap = document.createElement('div');
    // SVGs often have no size of their own (just a viewBox): scale them to the pane.
    wrap.className = /\.svg$/i.test(path) ? 'fv-image fv-vector' : 'fv-image';
    const img = document.createElement('img');
    img.alt = path;
    img.onload = () => {
      if (this.path !== path) return;
      $('fv-info').textContent = /\.svg$/i.test(path) ? 'vector (SVG)' : `${img.naturalWidth} × ${img.naturalHeight} px`;
    };
    img.onerror = () => { if (this.path === path) this.fail(`Couldn't open ${path}.`); };
    img.src = url;
    wrap.append(img);
    body.append(wrap);
    this.img = img;
  }

  /** Read the file again, e.g. after a script regenerated the figure. */
  async reload() {
    if (!this.path) return;
    const zoom = this.zoom;
    await this.show(this.path);
    if (this.img && zoom !== 1) this.img.addEventListener('load', () => this.setZoom(zoom), { once: true });
    else if (this.pdf && zoom !== 1) this.pdf.setZoom(zoom);
  }

  hide() {
    this.clear();
    this.path = null;
    $('file-viewer').hidden = true;
  }

  private clear() {
    $('fv-body').replaceChildren();
    this.pdf = null;
    this.img = null;
    this.zoom = 1;
  }

  private fail(message: string) {
    const p = document.createElement('p');
    p.className = 'pdf-empty';
    p.textContent = message;
    $('fv-body').replaceChildren(p);
  }

  private zoomBy(f: number) { this.setZoom(this.zoom * f); }

  private setZoom(z: number) {
    if (this.pdf) {
      if (z === 1) this.pdf.fit(); else this.pdf.setZoom(z);
      this.zoom = this.pdf.zoomLevel;
      return;
    }
    const img = this.img;
    if (!img) return;
    // Fit: as large as fits, never enlarged. Zoomed: relative to that size.
    if (this.zoom === 1) this.fitWidth = img.getBoundingClientRect().width || img.naturalWidth;
    this.zoom = Math.min(8, Math.max(0.1, z));
    img.classList.toggle('zoomed', this.zoom !== 1);
    img.style.width = this.zoom === 1 ? '' : `${Math.round(this.fitWidth * this.zoom)}px`;
  }
}

const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? '' : 's'}`;
