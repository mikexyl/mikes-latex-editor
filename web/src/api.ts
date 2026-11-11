import type { CompileResult, Problem } from '../../server/compile.ts';

export type { CompileResult, Problem };
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
export const setProjectRoot = (root: string) => { projectRoot = root; };

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

  compile: (main: string) =>
    call('/api/compile', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ main }),
    }).then(json<CompileResult>),

  pdfUrl: (main: string) => `/api/pdf?main=${q(main)}&t=${Date.now()}`,

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

  diffPdfUrl: (main: string) => `/api/diff/pdf?main=${q(main)}&t=${Date.now()}`,

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
};
