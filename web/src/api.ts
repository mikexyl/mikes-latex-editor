import type { CompileResult, Problem } from '../../server/compile.ts';

export type { CompileResult, Problem };
export type { TexStatus, TexPackage } from '../../server/tex.ts';
import type { TexStatus, TexPackage } from '../../server/tex.ts';
export type Entry = { path: string; type: 'file' | 'dir' };
export type Project = { name: string; root: string; tree: Entry[]; mains: string[] };
export type PdfBox = { page: number; h: number; v: number; width: number; height: number };
export type Commit = { hash: string; short: string; date: string; subject: string };
export type DiffResult = CompileResult & { available: boolean; message?: string };

export class ConflictError extends Error {
  constructor(public path: string, public mtime: number) { super(`${path} changed on disk`); }
}

async function json<T>(res: Response): Promise<T> {
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new Error(body.error ?? `${res.status} ${res.statusText}`);
  }
  return res.json() as Promise<T>;
}

const q = encodeURIComponent;

export type RecentProject = { path: string; name: string; openedAt: string; exists: boolean };
export type FolderListing = {
  path: string; parent: string | null; home: string; hasTex: boolean;
  dirs: { name: string; path: string; hasTex: boolean }[];
};

/** The project this page was loaded for; sent with every request (see server/index.ts). */
let projectRoot: string | undefined;
export const setProjectRoot = (root: string | undefined) => { projectRoot = root; };
/** The project this window has open, kept across reloads (sessionStorage is per window). */
const WINDOW_PROJECT = 'project-root';
export function rememberWindowProject(root: string) {
  try { sessionStorage.setItem(WINDOW_PROJECT, root); } catch { /* storage unavailable */ }
}
export function rememberedWindowProject(): string | null {
  try { return sessionStorage.getItem(WINDOW_PROJECT); } catch { return null; }
}
/** `url` with this window's project in it, for requests that can't carry the header (<img>, pdf.js). */
export const withRoot = (url: string) => (projectRoot ? `${url}&root=${encodeURIComponent(projectRoot)}` : url);

/** fetch() that tells the server which project the request is for. */
async function call(url: string, init: RequestInit = {}): Promise<Response> {
  const headers = new Headers(init.headers);
  if (projectRoot) headers.set('X-Project-Root', projectRoot);
  const res = await fetch(url, { ...init, headers });
  if (res.status === 409 && !url.startsWith('/api/file?')) {
    const body = await res.clone().json().catch(() => ({}));
    if (body.error === 'project switched') window.dispatchEvent(new CustomEvent('project-switched', { detail: body.root }));
  }
  return res;
}

export const api = {
  project: () => call('/api/project').then(json<Project>),

  read: (path: string) => call(`/api/file?path=${q(path)}`).then(json<{ content: string; mtime: number }>),

  /** Pass baseMtime to refuse the write if the file was changed by something else meanwhile. */
  async write(path: string, content: string, baseMtime?: number): Promise<{ mtime: number }> {
    const base = baseMtime === undefined ? '' : `&baseMtime=${baseMtime}`;
    const res = await call(`/api/file?path=${q(path)}${base}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'text/plain; charset=utf-8' },
      body: content,
    });
    if (res.status === 409) {
      const body = await res.json();
      if (body.error === 'project switched') {
        window.dispatchEvent(new CustomEvent('project-switched', { detail: body.root }));
        throw new Error('The project was switched in another window. Reload to continue.');
      }
      throw new ConflictError(path, body.mtime);
    }
    return json(res);
  },

  compile: (main: string, noteMacro?: string) =>
    call('/api/compile', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ main, noteMacro }),
    }).then(json<CompileResult>),

  pdfUrl: (main: string) => withRoot(`/api/pdf?main=${q(main)}&t=${Date.now()}`),

  syncForward: (main: string, file: string, line: number) =>
    call(`/api/synctex/forward?main=${q(main)}&file=${q(file)}&line=${line}`).then(json<{ boxes: PdfBox[] }>),

  syncBackward: (main: string, page: number, x: number, y: number) =>
    call(`/api/synctex/backward?main=${q(main)}&page=${page}&x=${x.toFixed(2)}&y=${y.toFixed(2)}`)
      .then(json<{ file: string | null; line: number | null }>),

  gitLog: () => call('/api/git/log').then(json<{ repo: boolean; commits: Commit[] }>),

  gitShow: (rev: string, path: string) =>
    call(`/api/git/show?rev=${q(rev)}&path=${q(path)}`).then(json<{ exists: boolean; content: string }>),

  diff: (main: string, rev: string) =>
    call('/api/diff', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ main, rev }),
    }).then(json<DiffResult>),

  diffPdfUrl: (main: string) => withRoot(`/api/diff/pdf?main=${q(main)}&t=${Date.now()}`),

  /** For each project file, [line, page] pairs from the last compile's SyncTeX data. */
  pageMap: (main: string) =>
    call(`/api/synctex/pages?main=${q(main)}`).then(json<{ pages: number; files: Record<string, [number, number][]> }>),

  projects: () => call('/api/projects').then(json<{ current: string; recent: RecentProject[] }>),

  openProject: (path: string) =>
    call('/api/projects/open', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ path }),
    }).then(json<{ root: string }>),

  forgetProject: (path: string) =>
    call('/api/projects/forget', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ path }),
    }).then(json<{ recent: RecentProject[] }>),

  listFolder: (path: string) => call(`/api/fs/list?path=${q(path)}`).then(json<FolderListing>),

  // ---- TeX (bundled TeX Live and its packages) ----
  texStatus: () => call('/api/tex/status').then(json<TexStatus>),
  texSetMode: (mode: 'bundled' | 'system') => post<TexStatus>('/api/tex/mode', { mode }),
  texInstalled: () => call('/api/tex/packages').then(json<{ packages: TexPackage[] }>),
  texSearch: (query: string) => call(`/api/tex/search?q=${q(query)}`).then(json<{ packages: TexPackage[] }>),
  texProviders: (file: string) => call(`/api/tex/provides?file=${q(file)}`).then(json<{ packages: string[] }>),
  texInstall: (packages: string[]) => post<{ output: string }>('/api/tex/install', { packages }),
  texRemove: (packages: string[]) => post<{ output: string }>('/api/tex/remove', { packages }),
  texUpdate: () => post<{ output: string }>('/api/tex/update', {}),
  texReset: () => post<{ ok: true }>('/api/tex/reset', {}),
};

function post<T>(url: string, body: unknown): Promise<T> {
  return call(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }).then(json<T>);
}
