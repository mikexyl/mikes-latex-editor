// \input / \include files shown inline in visual mode: a nested, editable editor for the included
// file sits below the \input line, so the paper reads (and can be edited) as one document. The
// app (main.ts) provides the host that loads files and keeps their state, saving and modes.
import { WidgetType } from '@codemirror/view';

export type IncludeHost = {
  /** Mount an editor for `rel` into `el`; returns a function that unmounts it. */
  mount(el: HTMLElement, rel: string): Promise<() => void>;
};

let host: IncludeHost | null = null;
export const setIncludeHost = (h: IncludeHost) => { host = h; };

/** Last measured height of each inline file, so it reappears at full height (no layout jumps). */
export const includeHeights = new Map<string, number>();

const unmounts = new WeakMap<HTMLElement, () => void>();
const destroyed = new WeakSet<HTMLElement>(); // destroyed before its editor finished loading

export class IncludeWidget extends WidgetType {
  constructor(readonly rel: string) { super(); }
  eq(o: IncludeWidget) { return o.rel === this.rel; }
  get estimatedHeight() { return includeHeights.get(this.rel) ?? -1; }

  toDOM() {
    const box = document.createElement('div');
    box.className = 'vc-include';
    // Hold the remembered height until the editor is attached, so content below doesn't shift.
    const known = includeHeights.get(this.rel);
    if (known) box.style.minHeight = `${known}px`;
    const body = document.createElement('div');
    body.className = 'vc-include-body';
    body.textContent = host ? 'Loading…' : '';
    box.append(body);
    if (host) {
      void host.mount(body, this.rel).then((unmount) => {
        box.style.minHeight = '';
        if (destroyed.has(box)) unmount();
        else unmounts.set(box, unmount);
      });
    }
    return box;
  }

  destroy(dom: HTMLElement) {
    const unmount = unmounts.get(dom);
    if (unmount) { unmounts.delete(dom); unmount(); }
    else destroyed.add(dom);
  }

  // Events inside the nested editor belong to it, not to the outer one.
  ignoreEvent() { return true; }
}
