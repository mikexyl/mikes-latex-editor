// Markdown files (README, notes, reviews) shown rendered in the file viewer. GitHub-flavored
// Markdown via marked, $math$ / $$math$$ with KaTeX, images from the project. The HTML is
// sanitized: a Markdown file from anywhere must not be able to run script in the editor.
import { Marked, type TokenizerAndRendererExtension } from 'marked';
import DOMPurify from 'dompurify';
import { renderMath } from './visual/math.ts';
import { withRoot } from './api.ts';

export const MARKDOWN = /\.(md|markdown)$/i;

const escapeAttr = (s: string) => s.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;');

// $$display$$ and $inline$ math, rendered after sanitizing (from data-tex).
const blockMath: TokenizerAndRendererExtension = {
  name: 'blockMath',
  level: 'block',
  start: (src) => src.indexOf('$$'),
  tokenizer(src) {
    const m = /^\$\$([\s\S]+?)\$\$[^\S\n]*(?:\n|$)/.exec(src);
    if (m) return { type: 'blockMath', raw: m[0], text: m[1].trim() };
  },
  renderer: (t) => `<div class="md-math" data-display="1" data-tex="${escapeAttr(t.text)}"></div>\n`,
};
const inlineMath: TokenizerAndRendererExtension = {
  name: 'inlineMath',
  level: 'inline',
  start: (src) => src.indexOf('$'),
  tokenizer(src) {
    // $x$ but not "$5 and $6" prices: no space just inside the dollars.
    const m = /^\$(?!\s)((?:\\.|[^$\\\n])+?)(?<!\s)\$(?!\d)/.exec(src);
    if (m) return { type: 'inlineMath', raw: m[0], text: m[1] };
  },
  renderer: (t) => `<span class="md-math" data-tex="${escapeAttr(t.text)}"></span>`,
};

const marked = new Marked({ gfm: true, extensions: [blockMath, inlineMath] });

export type MarkdownHooks = {
  /** A link to another file in the project (path relative to the project root). */
  openPath: (path: string) => void;
};

/** Resolve `ref` (as written in a file at `from`) to a project path, or null if it leaves the project. */
function resolve(from: string, ref: string): string | null {
  const parts = from.includes('/') ? from.split('/').slice(0, -1) : [];
  for (const p of decodeURI(ref).split('/')) {
    if (p === '' || p === '.') continue;
    if (p === '..') { if (!parts.length) return null; parts.pop(); } else parts.push(p);
  }
  return parts.join('/');
}

const isExternal = (url: string) => /^[a-z][a-z0-9+.-]*:/i.test(url) || url.startsWith('//');

/** Render `text`, the Markdown file at `path`, into `el`. */
export function renderMarkdown(el: HTMLElement, text: string, path: string, hooks: MarkdownHooks) {
  const html = DOMPurify.sanitize(marked.parse(text, { async: false }) as string, { ADD_ATTR: ['target'] });
  el.innerHTML = html;

  for (const m of el.querySelectorAll<HTMLElement>('.md-math')) {
    renderMath(m, m.dataset.tex ?? '', m.dataset.display === '1', {});
  }
  // Images: relative to the Markdown file, served from the project.
  for (const img of el.querySelectorAll('img')) {
    const src = img.getAttribute('src') ?? '';
    if (!src || isExternal(src)) continue;
    const p = resolve(path, src.split(/[?#]/)[0]);
    if (p) img.src = withRoot(`/api/asset?path=${encodeURIComponent(p)}`);
  }
  // Links: the web opens in the browser, project files open here, #anchors scroll.
  for (const a of el.querySelectorAll('a')) {
    const href = a.getAttribute('href') ?? '';
    if (!href) continue;
    if (isExternal(href)) {
      a.target = '_blank';
      a.rel = 'noopener noreferrer';
      continue;
    }
    a.addEventListener('click', (e) => {
      e.preventDefault();
      if (href.startsWith('#')) {
        const id = decodeURIComponent(href.slice(1));
        const target = [...el.querySelectorAll<HTMLElement>('h1, h2, h3, h4, h5, h6')].find((h) => slug(h.textContent ?? '') === id);
        target?.scrollIntoView({ block: 'start' });
        return;
      }
      const p = resolve(path, href.split('#')[0]);
      if (p) hooks.openPath(p);
    });
  }
}

/** GitHub's heading anchors: lower case, spaces to dashes, punctuation dropped. */
const slug = (s: string) => s.trim().toLowerCase().replace(/[^\p{L}\p{N}\s-]/gu, '').replace(/\s/g, '-');
