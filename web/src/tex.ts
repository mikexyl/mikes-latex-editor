// TeX settings: which TeX compiles (the app's bundled TeX Live or the system's) and the packages
// installed on top of the bundled one. Also installs a missing package from a compile error.
import { api, type TexPackage, type TexStatus } from './api.ts';

const $ = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T;
const el = (tag: string, cls: string, text?: string) => {
  const e = document.createElement(tag);
  e.className = cls;
  if (text !== undefined) e.textContent = text;
  return e;
};

let status: TexStatus | null = null;
let busy = false;
let showing: 'installed' | 'search' = 'installed';
const dialog = () => $<HTMLDialogElement>('tex-dialog');

export const texStatus = () => status;

async function refreshStatus(): Promise<TexStatus | null> {
  try { status = await api.texStatus(); } catch { status = null; }
  renderSettings();
  return status;
}

function describe(s: TexStatus | null): { version: string; detail: string } {
  if (!s) return { version: '', detail: 'Couldn’t check the TeX installation.' };
  if (s.mode === 'bundled') {
    return { version: s.version ?? 'bundled', detail: 'Bundled with the app and isolated from any system TeX. Missing packages can be installed from the compile log.' };
  }
  if (!s.latexmk) return { version: 'not found', detail: 'No TeX found (latexmk isn’t on PATH). Install MacTeX or TeX Live to compile.' };
  return { version: s.version ?? 'system', detail: `System TeX: ${s.latexmk.replace(/\/latexmk$/, '')}` };
}

function renderSettings() {
  const d = describe(status);
  $('set-tex-version').textContent = d.version;
  $('set-tex-detail').textContent = d.detail;
  $('set-tex-manage').hidden = !status?.bundled;
}

function setBusy(next: boolean, note = '') {
  busy = next;
  $('tx-note').textContent = note;
  for (const b of dialog().querySelectorAll<HTMLButtonElement>('button:not(#tx-close)')) b.disabled = next;
  for (const i of dialog().querySelectorAll<HTMLInputElement>('input')) i.disabled = next;
}

function showOutput(text: string) {
  const out = $('tx-output');
  out.textContent = text.trim();
  out.hidden = !text.trim();
  out.scrollTop = out.scrollHeight;
}

async function run(note: string, fn: () => Promise<string | void>) {
  if (busy) return;
  setBusy(true, note);
  try {
    const output = await fn();
    showOutput(output ?? '');
    setBusy(false, 'Done.');
  } catch (e) {
    showOutput((e as Error).message);
    setBusy(false, 'Failed (see above).');
  }
  await renderList();
}

function packageRow(p: TexPackage): HTMLElement {
  const li = el('li', 'tx-item');
  li.append(el('span', 'tx-name', p.name), el('span', 'tx-desc', p.description));
  li.title = p.description;
  if (p.layer === 'base') li.append(el('span', 'pd-badge', 'included'));
  else if (p.layer === 'user') {
    const b = el('button', '', 'Remove') as HTMLButtonElement;
    b.onclick = () => void run(`Removing ${p.name}…`, async () => (await api.texRemove([p.name])).output);
    li.append(b);
  } else {
    const b = el('button', 'primary', 'Install') as HTMLButtonElement;
    b.onclick = () => void run(`Installing ${p.name}…`, async () => (await api.texInstall([p.name])).output);
    li.append(b);
  }
  return li;
}

async function renderList() {
  const list = $('tx-list');
  const query = $<HTMLInputElement>('tx-search').value.trim();
  showing = query ? 'search' : 'installed';
  $('tx-list-title').textContent = query ? `Results for “${query}”` : 'Installed by you';
  try {
    const packages = query
      ? (await api.texSearch(query)).packages
      : (await api.texInstalled()).packages.filter((p) => p.layer === 'user');
    list.replaceChildren(...(packages.length ? packages.map(packageRow)
      : [el('li', 'pd-empty', query ? 'No packages found.' : 'Nothing yet. Packages you install on top of the bundled TeX appear here.')]));
  } catch (e) {
    list.replaceChildren(el('li', 'pd-empty', (e as Error).message));
  }
}

function renderDialog() {
  const s = status;
  const d = describe(s);
  $('tx-status').textContent = s ? `${d.version}. ${d.detail}` : d.detail;
  $('tx-mode').hidden = !s?.bundled;
  for (const r of dialog().querySelectorAll<HTMLInputElement>('input[name="tx-mode"]')) r.checked = r.value === s?.mode;
  $('tx-system-path').textContent = s?.mode === 'system' && s.latexmk ? s.latexmk.replace(/\/latexmk$/, '') : '';
  $('tx-manage').hidden = s?.mode !== 'bundled';
}

export async function openTexDialog() {
  const d = dialog();
  if (!d.open) d.showModal();
  showOutput('');
  $('tx-note').textContent = '';
  await refreshStatus();
  renderDialog();
  if (status?.mode === 'bundled') await renderList();
}

/**
 * Install the package that provides a missing file (e.g. `capt-of.sty`). Resolves to the package
 * name on success; throws with a readable message otherwise.
 */
export async function installProviding(file: string): Promise<string> {
  const { packages } = await api.texProviders(file);
  if (!packages.length) throw new Error(`No TeX Live package provides ${file}.`);
  await api.texInstall([packages[0]]);
  return packages[0];
}

export function initTex() {
  void refreshStatus();
  $('set-tex-manage').onclick = () => void openTexDialog();
  $('tx-close').onclick = () => { if (!busy) dialog().close(); };
  dialog().addEventListener('cancel', (e) => { if (busy) e.preventDefault(); });
  dialog().addEventListener('click', (e) => { if (e.target === dialog() && !busy) dialog().close(); });
  $<HTMLFormElement>('tx-search-form').onsubmit = (e) => {
    e.preventDefault();
    if (busy) return;
    setBusy(true, 'Searching the TeX Live repository…');
    void renderList().finally(() => setBusy(false));
  };
  $('tx-search').addEventListener('input', () => {
    if (!$<HTMLInputElement>('tx-search').value && showing === 'search') void renderList();
  });
  $('tx-update').onclick = () => void run('Updating packages…', async () => (await api.texUpdate()).output);
  $('tx-reset').onclick = () => {
    if (!confirm('Remove every package installed from the app? The bundled TeX itself stays as it is.')) return;
    void run('Resetting…', async () => { await api.texReset(); return 'Removed the packages installed from the app.'; });
  };
  for (const r of dialog().querySelectorAll<HTMLInputElement>('input[name="tx-mode"]')) {
    r.onchange = async () => {
      if (!r.checked) return;
      setBusy(true, 'Switching…');
      try { status = await api.texSetMode(r.value as 'bundled' | 'system'); } catch (e) { showOutput((e as Error).message); }
      setBusy(false);
      renderSettings();
      renderDialog();
      if (status?.mode === 'bundled') await renderList();
    };
  }
}
