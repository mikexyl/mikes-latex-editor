// Recent projects (kept in ~/.config/latex-editor/projects.json) and folder browsing for the
// "Open folder" dialog. Folders only: the browser never sees file contents through this.
import fs from 'node:fs/promises';
import { existsSync, statSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// Read when used, so the desktop app can point it at its own data folder before starting.
const configDir = () => process.env.LATEX_EDITOR_CONFIG ?? path.join(os.homedir(), '.config', 'latex-editor');
const recentFile = () => path.join(configDir(), 'projects.json');
const MAX_RECENT = 15;

export type RecentProject = { path: string; name: string; openedAt: string; exists: boolean };

async function readRecent(): Promise<{ path: string; openedAt: string }[]> {
  try {
    const data = JSON.parse(await fs.readFile(recentFile(), 'utf8'));
    return Array.isArray(data.recent) ? data.recent.filter((r: { path?: unknown }) => typeof r?.path === 'string') : [];
  } catch {
    return [];
  }
}

async function writeRecent(recent: { path: string; openedAt: string }[]) {
  await fs.mkdir(configDir(), { recursive: true });
  const tmp = `${recentFile()}.tmp`;
  await fs.writeFile(tmp, JSON.stringify({ recent }, null, 2));
  await fs.rename(tmp, recentFile());
}

const isDir = (p: string) => { try { return statSync(p).isDirectory(); } catch { return false; } };

export async function listRecent(): Promise<RecentProject[]> {
  return (await readRecent()).map((r) => ({ ...r, name: path.basename(r.path), exists: isDir(r.path) }));
}

export async function addRecent(dir: string) {
  const recent = (await readRecent()).filter((r) => r.path !== dir);
  recent.unshift({ path: dir, openedAt: new Date().toISOString() });
  await writeRecent(recent.slice(0, MAX_RECENT));
}

export async function removeRecent(dir: string) {
  await writeRecent((await readRecent()).filter((r) => r.path !== dir));
}

/** The most recently opened project that still exists, if any. */
export async function lastProject(): Promise<string | null> {
  return (await readRecent()).find((r) => isDir(r.path))?.path ?? null;
}

/** Expand ~ and make absolute. */
export function expandPath(p: string): string {
  const t = p.trim();
  if (t === '~' || t.startsWith('~/')) return path.join(os.homedir(), t.slice(1));
  return path.resolve(t || os.homedir());
}

export function checkProjectDir(p: string): string {
  const dir = expandPath(p);
  if (!existsSync(dir)) throw new Error(`Folder not found: ${dir}`);
  if (!isDir(dir)) throw new Error(`Not a folder: ${dir}`);
  return dir;
}

const SKIP = new Set(['node_modules', '.git', 'Library', '$RECYCLE.BIN']);

async function containsTex(dir: string): Promise<boolean> {
  try {
    return (await fs.readdir(dir)).some((n) => n.endsWith('.tex'));
  } catch {
    return false;
  }
}

export type FolderListing = {
  path: string;
  parent: string | null;
  home: string;
  hasTex: boolean;
  dirs: { name: string; path: string; hasTex: boolean }[];
};

/** Subfolders of a folder (hidden ones skipped), flagging those with .tex files in them. */
export async function listFolder(p: string): Promise<FolderListing> {
  const dir = checkProjectDir(p);
  const entries = await fs.readdir(dir, { withFileTypes: true });
  const subdirs = entries
    .filter((e) => (e.isDirectory() || (e.isSymbolicLink() && isDir(path.join(dir, e.name)))) && !e.name.startsWith('.') && !SKIP.has(e.name))
    .map((e) => e.name)
    .sort((a, b) => a.localeCompare(b, undefined, { sensitivity: 'base' }))
    .slice(0, 500);
  const dirs = await Promise.all(subdirs.map(async (name) => {
    const full = path.join(dir, name);
    return { name, path: full, hasTex: await containsTex(full) };
  }));
  const parent = path.dirname(dir);
  return {
    path: dir,
    parent: parent === dir ? null : parent,
    home: os.homedir(),
    hasTex: entries.some((e) => e.isFile() && e.name.endsWith('.tex')),
    dirs,
  };
}
