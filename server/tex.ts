// Which TeX the editor runs, and managing its packages.
//
// The desktop app ships its own TeX Live (the "base", read-only inside the app) and keeps a
// writable "user layer" next to its data, where packages installed from the app go. Compiles see
// only those two layers: no system TeX tree and no ~/Library/texmf or ~/texmf, so a project
// builds the same on every machine the app runs on. Without a bundled base (the browser version)
// the system's TeX is used as-is.
import fs from 'node:fs/promises';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';

export type TexMode = 'bundled' | 'system';

type Config = {
  /** Root of the bundled TeX Live (holds bin/, texmf-dist/, tlpkg/), or null. */
  base: string | null;
  /** Writable folder for the user layer and its settings, or null. */
  userDir: string | null;
  mode: TexMode;
};

let cfg: Config = { base: null, userDir: null, mode: 'system' };

// Where GUI-launched apps often don't look: the usual TeX and Homebrew locations.
const EXTRA_PATH = ['/Library/TeX/texbin', '/opt/homebrew/bin', '/usr/local/bin', '/usr/texbin', '/usr/bin', '/bin'];

const settingsFile = () => (cfg.userDir ? path.join(cfg.userDir, 'settings.json') : null);

export async function configureTex(opts: { base: string | null; userDir: string | null }) {
  const base = opts.base && existsSync(path.join(opts.base, 'texmf-dist')) ? path.resolve(opts.base) : null;
  cfg = { base, userDir: opts.userDir ? path.resolve(opts.userDir) : null, mode: base ? 'bundled' : 'system' };
  const file = settingsFile();
  if (base && file) {
    try {
      const saved = JSON.parse(await fs.readFile(file, 'utf8'));
      if (saved.mode === 'system' || saved.mode === 'bundled') cfg.mode = saved.mode;
    } catch { /* first run */ }
  }
}

export async function setTexMode(mode: TexMode) {
  if (mode === 'bundled' && !cfg.base) throw new Error('this build has no bundled TeX');
  cfg.mode = mode;
  const file = settingsFile();
  if (file) {
    await fs.mkdir(path.dirname(file), { recursive: true });
    await fs.writeFile(file, JSON.stringify({ mode }, null, 2));
  }
}

/** The bundled TeX's binaries folder for this machine (e.g. bin/universal-darwin). */
function baseBin(base: string): string | null {
  const want = process.platform === 'darwin' ? ['universal-darwin', `${process.arch === 'arm64' ? 'arm64' : 'x86_64'}-darwin`]
    : process.platform === 'linux' ? [process.arch === 'arm64' ? 'aarch64-linux' : 'x86_64-linux'] : [];
  let have: string[] = [];
  try { have = readdirSync(path.join(base, 'bin')); } catch { return null; }
  const dir = want.find((w) => have.includes(w));
  return dir ? path.join(base, 'bin', dir) : null;
}

const usingBundled = () => cfg.mode === 'bundled' && cfg.base !== null && cfg.userDir !== null;
const userTree = () => path.join(cfg.userDir!, 'texmf');

const mergePath = (first: string[], rest: string | undefined) =>
  [...new Set([...first, ...(rest ?? '').split(path.delimiter), ...EXTRA_PATH])].filter(Boolean).join(path.delimiter);

/** Environment for running TeX programs (latexmk, synctex, latexdiff, tlmgr). */
export function texEnv(): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env };
  if (!usingBundled()) {
    env.PATH = mergePath([], env.PATH);
    return env;
  }
  const base = cfg.base!;
  const bin = baseBin(base);
  // Perl, git and tar still come from the system; TeX comes only from the bundle.
  env.PATH = mergePath(bin ? [bin] : [], env.PATH);
  for (const v of ['TEXMFCNF', 'TEXMFDIST', 'TEXMFMAIN', 'TEXMFSYSVAR', 'TEXMFSYSCONFIG', 'TEXMFAUXTREES', 'TEXMFDOTDIR']) delete env[v];
  env.TEXMFHOME = userTree();
  env.TEXMFVAR = path.join(cfg.userDir!, 'texmf-var');
  env.TEXMFCONFIG = path.join(cfg.userDir!, 'texmf-config');
  // The default would be the folder next to the base (outside the app); keep it inside.
  env.TEXMFLOCAL = path.join(base, 'texmf-local');
  return env;
}

// ---------- status ----------

export type TexStatus = {
  mode: TexMode;
  bundled: boolean; // this build has a bundled TeX
  manageable: boolean; // packages can be installed from the app
  version: string | null; // e.g. "TeX Live 2026"
  latexmk: string | null; // the latexmk that compiles will run
  userLayer: string | null;
};

type Run = { code: number | null; stdout: string; stderr: string };

function run(cmd: string, args: string[], timeoutMs = 60_000): Promise<Run> {
  return new Promise((resolve) => {
    const child = spawn(cmd, args, { cwd: os.homedir(), env: texEnv() });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (d) => (stdout += d));
    child.stderr.on('data', (d) => (stderr += d));
    const timer = setTimeout(() => child.kill('SIGKILL'), timeoutMs);
    child.on('error', (err) => { clearTimeout(timer); resolve({ code: -1, stdout, stderr: stderr + err.message }); });
    child.on('close', (code) => { clearTimeout(timer); resolve({ code, stdout, stderr }); });
  });
}

/** Where a program is found on the TeX PATH. */
function which(name: string): string | null {
  for (const dir of (texEnv().PATH ?? '').split(path.delimiter)) {
    const p = path.join(dir, name);
    if (dir && existsSync(p)) return p;
  }
  return null;
}

function baseVersion(): string | null {
  try {
    const text = readFileSync(path.join(cfg.base!, 'release-texlive.txt'), 'utf8');
    const m = /version (\d{4})/.exec(text);
    return m ? `TeX Live ${m[1]}` : null;
  } catch { return null; }
}

export async function texStatus(): Promise<TexStatus> {
  const bundled = usingBundled();
  let version = bundled ? baseVersion() : null;
  if (!bundled) {
    const r = await run('tlmgr', ['--version'], 15_000);
    version = /TeX Live \(\S+\) version (\d{4})/.exec(r.stdout)?.[1] ? `TeX Live ${/version (\d{4})/.exec(r.stdout)![1]}` : null;
  }
  return {
    mode: cfg.mode,
    bundled: cfg.base !== null,
    manageable: bundled && which('tlmgr') !== null,
    version,
    latexmk: which('latexmk'),
    userLayer: bundled ? userTree() : null,
  };
}

// ---------- packages (bundled TeX only) ----------

export type TexPackage = { name: string; description: string; layer: 'base' | 'user' | null };

function requireManaged() {
  if (!usingBundled()) throw new Error('Packages can only be managed for the bundled TeX. Use your TeX distribution\'s own tools (tlmgr, apt) for the system TeX.');
}

async function ensureUserTree() {
  if (existsSync(path.join(userTree(), 'tlpkg', 'texlive.tlpdb'))) return;
  await fs.mkdir(cfg.userDir!, { recursive: true });
  const r = await run('tlmgr', ['init-usertree']);
  if (r.code !== 0) throw new Error(`Couldn't set up the package folder: ${(r.stderr || r.stdout).trim()}`);
}

/** Lines of `tlmgr info --data name,shortdesc`: name,"description" */
function parseInfo(text: string): { name: string; description: string }[] {
  const out: { name: string; description: string }[] = [];
  for (const line of text.split('\n')) {
    const m = /^([^,\s]+),(.*)$/.exec(line.trim());
    if (!m) continue;
    out.push({ name: m[1], description: m[2].replace(/^"|"$/g, '').replace(/""/g, '"') });
  }
  return out;
}

// One package operation at a time (tlmgr locks its database).
let queue: Promise<unknown> = Promise.resolve();
function queued<T>(fn: () => Promise<T>): Promise<T> {
  const p = queue.then(fn);
  queue = p.catch(() => {});
  return p;
}

export async function installedPackages(): Promise<TexPackage[]> {
  requireManaged();
  await ensureUserTree();
  const [base, user] = await Promise.all([
    run('tlmgr', ['info', '--only-installed', '--data', 'name,shortdesc']),
    run('tlmgr', ['--usermode', 'info', '--only-installed', '--data', 'name,shortdesc']),
  ]);
  const map = new Map<string, TexPackage>();
  for (const p of parseInfo(base.stdout)) map.set(p.name, { ...p, layer: 'base' });
  for (const p of parseInfo(user.stdout)) map.set(p.name, { ...p, layer: 'user' });
  return [...map.values()].filter((p) => !p.name.includes('.')).sort((a, b) => a.name.localeCompare(b.name));
}

// The full package list from the repository, cached for an hour (it's ~8000 lines).
let catalog: { at: number; list: { name: string; description: string }[] } | null = null;

export async function searchPackages(query: string): Promise<TexPackage[]> {
  requireManaged();
  if (!catalog || Date.now() - catalog.at > 3_600_000) {
    const r = await run('tlmgr', ['info', '--data', 'name,shortdesc'], 120_000);
    if (r.code !== 0) throw new Error(`Couldn't reach the TeX Live package repository: ${r.stderr.trim().split('\n').pop()}`);
    catalog = { at: Date.now(), list: parseInfo(r.stdout).filter((p) => !p.name.includes('.')) };
  }
  const installed = new Map((await installedPackages()).map((p) => [p.name, p.layer]));
  const q = query.trim().toLowerCase();
  const scored = catalog.list
    .map((p) => {
      const n = p.name.toLowerCase();
      const score = n === q ? 0 : n.startsWith(q) ? 1 : n.includes(q) ? 2 : p.description.toLowerCase().includes(q) ? 3 : -1;
      return { p, score };
    })
    .filter((x) => q && x.score >= 0)
    .sort((a, b) => a.score - b.score || a.p.name.localeCompare(b.p.name))
    .slice(0, 60);
  return scored.map(({ p }) => ({ ...p, layer: installed.get(p.name) ?? null }));
}

/** Packages that provide a file such as `capt-of.sty`, best match first. */
export async function packagesProviding(file: string): Promise<string[]> {
  requireManaged();
  const name = path.basename(file);
  if (!/^[\w.+-]+$/.test(name)) throw new Error('bad file name');
  const r = await run('tlmgr', ['search', '--global', '--file', `/${name}`], 60_000);
  if (r.code !== 0) throw new Error(`Couldn't search the TeX Live repository: ${(r.stderr || r.stdout).trim().split('\n').pop()}`);
  const found: { pkg: string; rank: number }[] = [];
  let pkg: string | null = null;
  let rank = 9;
  for (const line of r.stdout.split('\n')) {
    const head = /^(\S+):$/.exec(line);
    if (head) {
      if (pkg) found.push({ pkg, rank });
      pkg = head[1]; rank = 9;
      continue;
    }
    const f = line.trim();
    if (!pkg || !f.endsWith(`/${name}`)) continue;
    // A file under tex/ is what LaTeX loads; copies under doc/ or source/ are examples.
    rank = Math.min(rank, f.includes('/tex/') ? 0 : f.includes('/doc/') ? 2 : 1);
  }
  if (pkg) found.push({ pkg, rank });
  return found.filter((f) => f.rank < 9 && !f.pkg.includes('.')).sort((a, b) => a.rank - b.rank).map((f) => f.pkg);
}

const PKG_NAME = /^[\w.+-]+$/;

async function tlmgrUser(args: string[]): Promise<string> {
  const r = await run('tlmgr', ['--usermode', ...args], 600_000);
  const output = (r.stdout + r.stderr).trim();
  if (r.code !== 0) throw new Error(output.split('\n').slice(-6).join('\n') || 'tlmgr failed');
  return output;
}

export function installPackages(names: string[]): Promise<string> {
  requireManaged();
  if (!names.length || !names.every((n) => PKG_NAME.test(n))) throw new Error('bad package name');
  return queued(async () => { await ensureUserTree(); return tlmgrUser(['install', ...names]); });
}

export function removePackages(names: string[]): Promise<string> {
  requireManaged();
  if (!names.length || !names.every((n) => PKG_NAME.test(n))) throw new Error('bad package name');
  return queued(async () => { await ensureUserTree(); return tlmgrUser(['remove', ...names]); });
}

export function updateAll(): Promise<string> {
  requireManaged();
  return queued(async () => { await ensureUserTree(); return tlmgrUser(['update', '--all']); });
}

/** Back to the TeX as shipped: drop every package installed from the app, and caches. */
export function resetUserLayer(): Promise<void> {
  requireManaged();
  return queued(async () => {
    for (const d of ['texmf', 'texmf-var', 'texmf-config']) await fs.rm(path.join(cfg.userDir!, d), { recursive: true, force: true });
    catalog = null;
  });
}
