// SyncTeX lookups, git history and latexdiff builds for one project folder.
import { spawn } from 'node:child_process';
import fs from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { BUILD_DIR, compileFile, type CompileResult } from './compile.ts';

type Run = { code: number | null; stdout: string; stderr: string };

export function run(cmd: string, args: string[], opts: { cwd: string; env?: NodeJS.ProcessEnv; timeoutMs?: number; stdoutFile?: string }): Promise<Run> {
  return new Promise((resolve) => {
    const child = spawn(cmd, args, { cwd: opts.cwd, env: opts.env ?? process.env });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (d) => (stdout += d));
    child.stderr.on('data', (d) => (stderr += d));
    const timer = setTimeout(() => child.kill('SIGKILL'), opts.timeoutMs ?? 30_000);
    child.on('error', (err) => { clearTimeout(timer); resolve({ code: -1, stdout, stderr: stderr + err.message }); });
    child.on('close', (code) => { clearTimeout(timer); resolve({ code, stdout, stderr }); });
  });
}

const pdfFor = (root: string, main: string) => path.join(root, BUILD_DIR, path.basename(main).replace(/\.tex$/, '.pdf'));

// ---------- SyncTeX ----------

export type PdfBox = { page: number; h: number; v: number; width: number; height: number };

/** Source position -> boxes in the PDF (PDF points, origin top-left, v = baseline). */
export async function synctexForward(root: string, main: string, file: string, line: number): Promise<PdfBox[]> {
  const r = await run('synctex', ['view', '-i', `${line}:0:${path.join(root, file)}`, '-o', pdfFor(root, main)], { cwd: root });
  const boxes: PdfBox[] = [];
  let cur: Partial<Record<string, number>> = {};
  for (const l of r.stdout.split('\n')) {
    const m = /^(Page|h|v|W|H):(-?[\d.]+)/.exec(l);
    if (!m) continue;
    if (m[1] === 'Page' && cur.Page !== undefined) cur = {};
    cur[m[1]] = Number(m[2]);
    if (cur.Page !== undefined && cur.H !== undefined && cur.W !== undefined && cur.h !== undefined && cur.v !== undefined) {
      boxes.push({ page: cur.Page, h: cur.h, v: cur.v, width: cur.W, height: cur.H });
      cur = {};
    }
  }
  return boxes;
}

/** PDF point -> source file (relative to root) and line. */
export async function synctexBackward(root: string, main: string, page: number, x: number, y: number): Promise<{ file: string; line: number } | null> {
  const r = await run('synctex', ['edit', '-o', `${page}:${x}:${y}:${pdfFor(root, main)}`], { cwd: root });
  const input = /^Input:(.+)$/m.exec(r.stdout)?.[1];
  const line = Number(/^Line:(\d+)/m.exec(r.stdout)?.[1]);
  if (!input || !line) return null;
  const rel = path.relative(root, path.resolve(root, input)).split(path.sep).join('/');
  if (rel.startsWith('..') || rel.startsWith(BUILD_DIR)) return null;
  return { file: rel, line };
}

// ---------- git ----------

export type Commit = { hash: string; short: string; date: string; subject: string };

export async function gitLog(root: string): Promise<Commit[] | null> {
  const inside = await run('git', ['rev-parse', '--is-inside-work-tree'], { cwd: root });
  if (inside.code !== 0 || inside.stdout.trim() !== 'true') return null;
  const r = await run('git', ['log', '-n', '50', '--date=short', '--format=%H%x1f%h%x1f%ad%x1f%s', '--', '.'], { cwd: root });
  if (r.code !== 0) return [];
  return r.stdout.split('\n').filter(Boolean).map((l) => {
    const [hash, short, date, subject] = l.split('\x1f');
    return { hash, short, date, subject };
  });
}

const REV = /^[0-9a-f]{4,40}$|^HEAD(~\d+)?$/i;

/** A file's content at a revision, or null if it didn't exist then. */
export async function gitShow(root: string, rev: string, file: string): Promise<string | null> {
  if (!REV.test(rev)) throw new Error('bad revision');
  const r = await run('git', ['show', `${rev}:./${file}`], { cwd: root });
  return r.code === 0 ? r.stdout : null;
}

// ---------- latexdiff ----------

export async function findLatexdiff(): Promise<string | null> {
  // Apps started outside a terminal (macOS) may not have Homebrew on PATH, so try its locations too.
  const candidates = [process.env.LATEXDIFF, 'latexdiff', '/opt/homebrew/bin/latexdiff', '/usr/local/bin/latexdiff', '/Library/TeX/texbin/latexdiff']
    .filter(Boolean) as string[];
  for (const c of candidates) {
    const r = await run(c, ['--version'], { cwd: process.cwd(), timeoutMs: 10_000 });
    if (r.code === 0) return c;
  }
  return null;
}

export type DiffResult = CompileResult & { available: boolean; message?: string };

/**
 * Marked-up PDF of the changes since `rev`: the project at that revision is exported to the build
 * folder, both versions are flattened and diffed by latexdiff, and the result is compiled from the
 * project root so figures and the bibliography resolve.
 */
export async function buildDiff(root: string, main: string, rev: string): Promise<DiffResult> {
  if (!REV.test(rev)) throw new Error('bad revision');
  const latexdiff = await findLatexdiff();
  const empty = { ok: false, pdf: false, durationMs: 0, problems: [], output: '' };
  if (!latexdiff) {
    return { ...empty, available: false, message: 'latexdiff is not installed. Install it with `brew install latexdiff`, `sudo tlmgr install latexdiff` or `sudo apt install latexdiff`, or set LATEXDIFF to its path.' };
  }
  const start = Date.now();
  const diffDir = path.join(root, BUILD_DIR, 'diff');
  const oldDir = path.join(diffDir, 'old');
  await fs.rm(diffDir, { recursive: true, force: true });
  await fs.mkdir(oldDir, { recursive: true });

  // Export the project folder as it was at rev (works when the project is a subfolder of the repo).
  const prefix = (await run('git', ['rev-parse', '--show-prefix'], { cwd: root })).stdout.trim();
  const archive = path.join(diffDir, 'old.tar');
  const a = await run('git', ['archive', '--format=tar', '-o', archive, `${rev}:${prefix}`], { cwd: root });
  if (a.code !== 0) return { ...empty, available: true, message: `git archive failed: ${a.stderr.trim()}` };
  await run('tar', ['-xf', archive, '-C', oldDir], { cwd: root });
  if (!existsSync(path.join(oldDir, main))) {
    return { ...empty, available: true, message: `${main} did not exist at ${rev.slice(0, 8)}.` };
  }

  const stem = path.basename(main).replace(/\.tex$/, '');
  const diffTex = path.join(diffDir, `${stem}-diff.tex`);
  const d = await run(latexdiff, ['--flatten', '--type=UNDERLINE', path.join(oldDir, main), path.join(root, main)], { cwd: root, timeoutMs: 120_000 });
  if (d.code !== 0 || !d.stdout.trim()) {
    return { ...empty, available: true, message: `latexdiff failed: ${d.stderr.trim().split('\n').slice(-3).join(' ')}` };
  }
  await fs.writeFile(diffTex, d.stdout);
  // Compiled from the project root so \includegraphics paths resolve; BibTeX runs in the output
  // folder, so point it at the project for .bib files.
  const sep = path.delimiter;
  const result = await compileFile(root, path.relative(root, diffTex), path.relative(root, diffDir), {
    BIBINPUTS: `${root}${sep}${process.env.BIBINPUTS ?? ''}`,
    BSTINPUTS: `${root}${sep}${process.env.BSTINPUTS ?? ''}`,
  });
  return { ...result, durationMs: Date.now() - start, available: true };
}

export const diffPdfPath = (root: string, main: string) =>
  path.join(root, BUILD_DIR, 'diff', `${path.basename(main).replace(/\.tex$/, '')}-diff.pdf`);
