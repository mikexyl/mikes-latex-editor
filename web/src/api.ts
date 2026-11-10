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

export const api = {
  project: () => fetch('/api/project').then(json<Project>),

  read: (path: string) => fetch(`/api/file?path=${q(path)}`).then(json<{ content: string; mtime: number }>),

  /** Pass baseMtime to refuse the write if the file was changed by something else meanwhile. */
  async write(path: string, content: string, baseMtime?: number): Promise<{ mtime: number }> {
    const base = baseMtime === undefined ? '' : `&baseMtime=${baseMtime}`;
    const res = await fetch(`/api/file?path=${q(path)}${base}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'text/plain; charset=utf-8' },
      body: content,
    });
    if (res.status === 409) throw new ConflictError(path, (await res.json()).mtime);
    return json(res);
  },

  compile: (main: string) =>
    fetch('/api/compile', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ main }),
    }).then(json<CompileResult>),

  pdfUrl: (main: string) => `/api/pdf?main=${q(main)}&t=${Date.now()}`,

  syncForward: (main: string, file: string, line: number) =>
    fetch(`/api/synctex/forward?main=${q(main)}&file=${q(file)}&line=${line}`).then(json<{ boxes: PdfBox[] }>),

  syncBackward: (main: string, page: number, x: number, y: number) =>
    fetch(`/api/synctex/backward?main=${q(main)}&page=${page}&x=${x.toFixed(2)}&y=${y.toFixed(2)}`)
      .then(json<{ file: string | null; line: number | null }>),

  gitLog: () => fetch('/api/git/log').then(json<{ repo: boolean; commits: Commit[] }>),

  gitShow: (rev: string, path: string) =>
    fetch(`/api/git/show?rev=${q(rev)}&path=${q(path)}`).then(json<{ exists: boolean; content: string }>),

  diff: (main: string, rev: string) =>
    fetch('/api/diff', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ main, rev }),
    }).then(json<DiffResult>),

  diffPdfUrl: (main: string) => `/api/diff/pdf?main=${q(main)}&t=${Date.now()}`,
};
