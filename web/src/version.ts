// Settings › Version: the app's version, and a check against the latest GitHub release.
declare const __APP_VERSION__: string;
export const APP_VERSION = typeof __APP_VERSION__ === 'string' ? __APP_VERSION__ : '';

const RELEASES = 'https://github.com/mikexyl/mikes-latex-editor/releases';
const LATEST_API = 'https://api.github.com/repos/mikexyl/mikes-latex-editor/releases/latest';

/** Compares "0.1.4" and "v0.2.0" style versions: negative if a is older than b. */
export function compareVersions(a: string, b: string): number {
  const parts = (v: string) => v.replace(/^v/, '').split(/[.-]/).map((p) => Number.parseInt(p, 10) || 0);
  const x = parts(a), y = parts(b);
  for (let i = 0; i < Math.max(x.length, y.length); i++) {
    const d = (x[i] ?? 0) - (y[i] ?? 0);
    if (d) return d;
  }
  return 0;
}

const $ = (id: string) => document.getElementById(id)!;

function say(text: string, link?: { href: string; label: string }) {
  const out = $('set-version-status');
  out.textContent = text;
  if (link) {
    const a = document.createElement('a');
    a.href = link.href;
    a.target = '_blank';
    a.rel = 'noopener';
    a.textContent = link.label;
    out.append(' ', a);
  }
}

async function check() {
  const button = $('set-version-check') as HTMLButtonElement;
  button.disabled = true;
  say('Checking…');
  try {
    const res = await fetch(LATEST_API, { headers: { Accept: 'application/vnd.github+json' } });
    if (!res.ok) throw new Error(`GitHub answered ${res.status}`);
    const latest = (await res.json()) as { tag_name: string; html_url: string };
    const v = latest.tag_name.replace(/^v/, '');
    if (compareVersions(v, APP_VERSION) > 0) say(`Version ${v} is available.`, { href: latest.html_url, label: 'Download' });
    else say(`You have the latest version (${v}).`);
  } catch (e) {
    say(`Couldn’t check: ${(e as Error).message}.`, { href: RELEASES, label: 'See releases' });
  } finally {
    button.disabled = false;
  }
}

export function initVersion() {
  $('set-version-value').textContent = APP_VERSION;
  $('set-version-check').addEventListener('click', () => void check());
}
