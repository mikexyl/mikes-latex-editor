// Project picker: recent projects plus a folder browser. Switching saves open files, tells the
// server to open the new folder, and reloads the page for a clean start in that project. In the
// desktop app a project can also open in a new window, next to this one.
import { api, rememberWindowProject, type FolderListing, type RecentProject } from './api.ts';
import { desktop } from './desktop.ts';

const $ = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T;

const el = (tag: string, cls: string, text?: string) => {
  const e = document.createElement(tag);
  e.className = cls;
  if (text !== undefined) e.textContent = text;
  return e;
};

type Hooks = {
  /** Save open files before leaving; false aborts the switch. */
  beforeSwitch: () => Promise<boolean>;
  setStatus: (text: string, error?: boolean) => void;
};

let hooks: Hooks;
let currentRoot = '';
let listing: FolderListing | null = null;

const dialog = () => $<HTMLDialogElement>('project-dialog');

/** Shorten paths under the home folder to ~/... for display. */
function tilde(p: string): string {
  const home = listing?.home;
  return home && (p === home || p.startsWith(home + '/')) ? '~' + p.slice(home.length) : p;
}

async function switchTo(path: string) {
  if (path === currentRoot) { dialog().close(); return; }
  if (!(await hooks.beforeSwitch())) {
    $('pd-note').textContent = 'Some files could not be saved, so the project was not switched.';
    return;
  }
  try {
    await api.openProject(path);
    rememberWindowProject(path);
    location.reload();
  } catch (e) {
    $('pd-note').textContent = (e as Error).message;
  }
}

const canOpenWindows = () => !!desktop?.newWindow;

/** Open a project in a new window; this one stays as it is. */
async function openInNewWindow(path: string) {
  try {
    await api.openProject(path);
    await desktop!.newWindow!(path);
    dialog().close();
  } catch (e) {
    $('pd-note').textContent = (e as Error).message;
  }
}

function renderRecent(recent: RecentProject[]) {
  const list = $('pd-recent');
  if (!recent.length) {
    list.replaceChildren(el('li', 'pd-empty', 'No recent projects yet.'));
    return;
  }
  list.replaceChildren(...recent.map((r) => {
    const li = el('li', `pd-recent-item${r.path === currentRoot ? ' current' : ''}${r.exists ? '' : ' missing'}`);
    const open = el('button', 'pd-recent-open') as HTMLButtonElement;
    open.append(el('span', 'pd-recent-name', r.name), el('span', 'pd-recent-path', tilde(r.path)));
    if (r.path === currentRoot) open.append(el('span', 'pd-badge', 'open'));
    if (!r.exists) open.append(el('span', 'pd-badge missing', 'missing'));
    open.disabled = !r.exists;
    open.onclick = () => void switchTo(r.path);
    const forget = el('button', 'pd-forget link', '✕') as HTMLButtonElement;
    forget.title = 'Remove from recent projects (the folder is not touched)';
    forget.setAttribute('aria-label', `Remove ${r.name} from recent projects`);
    forget.onclick = async () => renderRecent((await api.forgetProject(r.path)).recent);
    li.append(open);
    if (canOpenWindows() && r.exists) {
      const win = el('button', 'pd-new-window link', '⧉') as HTMLButtonElement;
      win.title = 'Open in a new window';
      win.setAttribute('aria-label', `Open ${r.name} in a new window`);
      win.onclick = () => void openInNewWindow(r.path);
      li.append(win);
    }
    li.append(forget);
    return li;
  }));
}

async function browse(path: string) {
  try {
    listing = await api.listFolder(path);
  } catch (e) {
    $('pd-note').textContent = (e as Error).message;
    return;
  }
  $<HTMLInputElement>('pd-path').value = tilde(listing.path);
  $<HTMLButtonElement>('pd-up').disabled = !listing.parent;
  $('pd-note').textContent = listing.hasTex ? 'This folder has .tex files.' : 'No .tex files directly in this folder.';
  const dirs = $('pd-dirs');
  if (!listing.dirs.length) {
    dirs.replaceChildren(el('li', 'pd-empty', 'No subfolders.'));
    return;
  }
  dirs.replaceChildren(...listing.dirs.map((d) => {
    const li = el('li', 'pd-dir');
    const b = el('button', 'pd-dir-btn') as HTMLButtonElement;
    b.append(el('span', 'pd-dir-name', `${d.name}/`));
    if (d.hasTex) b.append(el('span', 'pd-badge tex', 'LaTeX'));
    b.title = d.hasTex ? 'Contains .tex files. Double-click to open as a project.' : 'Open folder';
    b.onclick = () => void browse(d.path);
    b.ondblclick = () => void switchTo(d.path);
    li.append(b);
    return li;
  }));
}

export async function openProjectPicker() {
  const d = dialog();
  if (d.open) return;
  $('pd-note').textContent = '';
  d.showModal();
  const { current, recent } = await api.projects();
  currentRoot = current;
  // Start browsing next to the current project, where other papers usually live.
  await browse(current.split('/').slice(0, -1).join('/') || '/');
  renderRecent(recent);
}

export function initProjectPicker(h: Hooks) {
  hooks = h;
  $('project-name').onclick = () => void openProjectPicker();
  $('pd-close').onclick = () => dialog().close();
  dialog().addEventListener('click', (e) => { if (e.target === dialog()) dialog().close(); }); // backdrop
  $<HTMLFormElement>('pd-path-form').onsubmit = (e) => {
    e.preventDefault();
    void browse($<HTMLInputElement>('pd-path').value);
  };
  $('pd-up').onclick = () => { if (listing?.parent) void browse(listing.parent); };
  $('pd-home').onclick = () => void browse('~');
  $('pd-open').onclick = () => { if (listing) void switchTo(listing.path); };
  if (canOpenWindows()) {
    const b = $<HTMLButtonElement>('pd-open-new');
    b.hidden = false;
    b.onclick = () => { if (listing) void openInNewWindow(listing.path); };
  }
  // In the desktop app: the system's own folder chooser.
  if (desktop) {
    const choose = $<HTMLButtonElement>('pd-choose');
    choose.hidden = false;
    if (desktop.platform !== 'darwin') choose.textContent = 'Choose folder…';
    choose.onclick = async () => {
      const picked = await desktop!.pickFolder(listing?.path);
      if (picked) void switchTo(picked);
    };
  }
  window.addEventListener('keydown', (e) => {
    if ((e.metaKey || e.ctrlKey) && !e.shiftKey && !e.altKey && e.key.toLowerCase() === 'o') {
      e.preventDefault();
      void openProjectPicker();
    }
    // Ctrl+Shift+N: a new window (on the Mac, the File menu's ⌘⇧N does it).
    if (canOpenWindows() && desktop!.platform !== 'darwin' && e.ctrlKey && e.shiftKey && !e.altKey && e.key.toLowerCase() === 'n') {
      e.preventDefault();
      void desktop!.newWindow!();
    }
  });
}
