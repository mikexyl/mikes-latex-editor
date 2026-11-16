// TikZ pictures in visual mode: each tikzpicture is compiled on its own by the server with the main
// file's preamble (server/tikz.ts) and shown as an image. Clicking it puts the cursor in the source,
// which shows the code for editing; leaving it renders the new code.
import { WidgetType } from '@codemirror/view';
import * as pdfjs from 'pdfjs-dist';
import { api } from '../api.ts';
import { installProviding } from '../tex.ts';

pdfjs.GlobalWorkerOptions.workerSrc = '/vendor/pdf.worker.min.mjs';

/** CSS pixels per PDF point: a little larger than print, like the rest of visual mode. */
const SCALE = 1.6;

type Rendered = { url: string; width: number; height: number } | { error: string; missing?: string };

let main = '';
let preamble = '';
/** Changes whenever the main file or its preamble does, so widgets re-render. */
export let tikzContextKey = '';

/** Set the main file and its preamble (from main.ts). Returns true if pictures need re-rendering. */
export function setTikzContext(mainPath: string, mainText: string): boolean {
  const m = /^([^%\n]*?)\\begin\s*\{document\}/m.exec(mainText);
  const next = m ? mainText.slice(0, m.index + m[1].length) : '';
  if (mainPath === main && next === preamble) return false;
  main = mainPath;
  preamble = next;
  tikzContextKey = `${main}\0${preamble.length}\0${hashString(preamble)}`;
  return true;
}

function hashString(s: string): string {
  let h = 0;
  for (let i = 0; i < s.length; i++) h = (Math.imul(h, 31) + s.charCodeAt(i)) | 0;
  return (h >>> 0).toString(36);
}

const cache = new Map<string, Promise<Rendered>>();

async function render(code: string): Promise<Rendered> {
  if (!main || !preamble) return { error: 'No main file with a preamble to compile the picture with' };
  let data: ArrayBuffer;
  try {
    data = await api.tikz(main, preamble, code);
  } catch (e) {
    const error = (e as Error).message;
    return { error, missing: /File `([^']+\.(?:sty|cls|tex))' not found/.exec(error)?.[1] };
  }
  const task = pdfjs.getDocument({ data });
  const doc = await task.promise;
  try {
    const page = await doc.getPage(1);
    const base = page.getViewport({ scale: 1 });
    const pixels = SCALE * Math.max(2, window.devicePixelRatio || 1);
    const viewport = page.getViewport({ scale: pixels });
    const canvas = document.createElement('canvas');
    canvas.width = Math.ceil(viewport.width);
    canvas.height = Math.ceil(viewport.height);
    await page.render({ canvas, viewport }).promise;
    const blob = await new Promise<Blob | null>((r) => canvas.toBlob(r));
    if (!blob) return { error: 'Could not draw the picture' };
    return { url: URL.createObjectURL(blob), width: base.width * SCALE, height: base.height * SCALE };
  } finally {
    void task.destroy();
  }
}

function rendered(code: string, fresh = false): Promise<Rendered> {
  const key = `${tikzContextKey}\0${code}`;
  let p = fresh ? undefined : cache.get(key);
  if (!p) {
    p = render(code).catch((e) => ({ error: (e as Error).message }));
    cache.set(key, p);
    // Failures aren't kept: the next time the picture is shown it's tried again.
    void p.then((r) => { if ('error' in r) cache.delete(key); });
  }
  return p;
}

export class TikzWidget extends WidgetType {
  constructor(readonly code: string, readonly context: string) { super(); }
  eq(o: TikzWidget) { return o.code === this.code && o.context === this.context; }

  toDOM() {
    const wrap = document.createElement('div');
    wrap.className = 'vc-tikz';
    wrap.title = 'TikZ picture: click to edit the code';
    this.fill(wrap, false);
    return wrap;
  }

  private fill(wrap: HTMLElement, fresh: boolean) {
    wrap.replaceChildren();
    wrap.classList.remove('vc-tikz-error');
    const note = document.createElement('div');
    note.className = 'vc-tikz-pending';
    note.textContent = 'Rendering TikZ picture…';
    wrap.append(note);
    void rendered(this.code, fresh).then((r) => {
      wrap.replaceChildren();
      if ('url' in r) {
        const img = document.createElement('img');
        img.src = r.url;
        img.alt = 'TikZ picture';
        img.style.width = `${r.width}px`;
        img.style.aspectRatio = `${r.width} / ${r.height}`;
        wrap.append(img);
        return;
      }
      wrap.classList.add('vc-tikz-error');
      const head = document.createElement('div');
      head.className = 'vc-tikz-error-head';
      head.textContent = 'TikZ picture didn’t compile (click to see the code)';
      const msg = document.createElement('div');
      msg.className = 'vc-tikz-error-msg';
      msg.textContent = r.error;
      wrap.append(head, msg);
      if (r.missing) {
        const button = document.createElement('button');
        button.textContent = `Install the package with ${r.missing}`;
        button.onclick = async (e) => {
          e.stopPropagation();
          button.disabled = true;
          button.textContent = `Installing the package with ${r.missing}…`;
          try {
            await installProviding(r.missing!);
            this.fill(wrap, true);
          } catch (err) {
            button.textContent = (err as Error).message;
          }
        };
        wrap.append(button);
      }
    });
  }

  get estimatedHeight() { return 160; }
  ignoreEvent(e: Event) { return e.type === 'mousedown' && (e.target as HTMLElement).tagName === 'BUTTON'; }
}
