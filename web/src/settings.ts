// App settings (top-bar ⚙ menu). Stored per browser profile in localStorage, not per project.
const $ = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T;

const store = {
  get(k: string) { try { return localStorage.getItem(k); } catch { return null; } },
  set(k: string, v: string) { try { localStorage.setItem(k, v); } catch { /* storage unavailable */ } },
};

const DEFAULT_WIDTH = 44; // em; 0 = full width

/** Text width of visual mode, in em (0 = use the whole editor width). */
function applyWidth(width: number, onLayout: () => void) {
  document.documentElement.style.setProperty('--visual-width', width ? `${width}em` : 'none');
  $<HTMLInputElement>('set-width').value = String(width || 100);
  $('set-width-value').textContent = width ? `${width} em` : 'Full width';
  for (const b of $('set-width-presets').querySelectorAll<HTMLButtonElement>('button')) {
    b.setAttribute('aria-pressed', String(Number(b.dataset.width) === width));
  }
  onLayout();
}

export function initSettings(opts: { onLayoutChange: () => void }) {
  const saved = Number(store.get('visual-width'));
  let width = Number.isFinite(saved) && store.get('visual-width') !== null ? saved : DEFAULT_WIDTH;
  const set = (w: number) => {
    width = w;
    store.set('visual-width', String(w));
    applyWidth(w, opts.onLayoutChange);
  };
  applyWidth(width, opts.onLayoutChange);

  // The slider's right end means "full width".
  $<HTMLInputElement>('set-width').addEventListener('input', (e) => {
    const v = Number((e.target as HTMLInputElement).value);
    set(v >= 100 ? 0 : v);
  });
  $('set-width-presets').addEventListener('click', (e) => {
    const b = (e.target as HTMLElement).closest('button');
    if (b) set(Number(b.dataset.width));
  });

  // Open/close the popover; closes on outside click or Escape.
  const panel = $('settings');
  const btn = $('settings-btn');
  let open = false;
  const show = (next: boolean) => {
    open = next;
    panel.hidden = !next;
    btn.setAttribute('aria-expanded', String(next));
  };
  btn.addEventListener('click', (e) => { e.stopPropagation(); show(!open); });
  document.addEventListener('mousedown', (e) => {
    if (open && !panel.contains(e.target as Node) && e.target !== btn) show(false);
  });
  document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && open) show(false); });
}
