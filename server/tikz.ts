// TikZ pictures for visual mode: each picture is compiled on its own with the main file's preamble
// (class, packages, \usetikzlibrary, macros), so it looks like it does in the PDF. The picture is
// typeset in a box and shipped out on a page cut to the box's size. Results are cached by content.
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { BUILD_DIR } from './compile.ts';
import { texEnv } from './tex.ts';

const TIMEOUT_MS = 60_000;
const VERSION = '1'; // bump when the wrapper below changes, so old cached pictures are rebuilt

export type TikzResult = { ok: true; pdf: string } | { ok: false; error: string };

// One picture at a time, so opening a paper with many pictures doesn't start dozens of TeX runs.
let queue: Promise<unknown> = Promise.resolve();
const running = new Map<string, Promise<TikzResult>>();

/** The main file's preamble: everything before \begin{document} (one that isn't commented out). */
export function preambleOf(main: string): string | null {
  const m = /^([^%\n]*?)\\begin\s*\{document\}/m.exec(main);
  return m ? main.slice(0, m.index + m[1].length) : null;
}

/** The document that typesets one picture on a page of exactly its size. */
export function tikzDocument(preamble: string, code: string): string {
  return `${preamble}
\\begin{document}%
\\ifdefined\\pdfpagewidth\\else\\let\\pdfpagewidth\\pagewidth\\let\\pdfpageheight\\pageheight\\fi
\\pagestyle{empty}%
\\setbox0=\\hbox{%
${code}%
}%
\\ifdim\\wd0=0pt \\errmessage{The picture is empty}\\fi
\\pdfpagewidth=\\wd0 \\pdfpageheight=\\dimexpr\\ht0+\\dp0\\relax
\\hoffset=-1in \\voffset=-1in
\\shipout\\box0
\\end{document}
`;
}

/** The first TeX error in a log, short enough to show under the picture. */
export function firstError(log: string): string {
  const lines = log.split('\n');
  const i = lines.findIndex((l) => l.startsWith('! '));
  if (i < 0) return /Emergency stop|Fatal error/.test(log) ? 'TeX stopped without a message' : 'No picture was produced';
  // TeX wraps log lines at 79 characters: the message runs until a blank line or the l.N context.
  let msg = lines[i].slice(2);
  for (let k = i + 1; k < lines.length && lines[k].trim() && !/^l\.\d+/.test(lines[k]) && msg.length < 400; k++) {
    if (lines[k - 1].length < 79) break;
    msg += lines[k];
  }
  msg = msg.replace(/\s+/g, ' ').trim();
  const context = lines.slice(i + 1, i + 4).find((l) => /^l\.\d+/.test(l));
  return context ? `${msg} (${context.replace(/^l\.\d+\s*/, 'at: ').trim().slice(0, 80)})` : msg;
}

/**
 * Compile `code` (a tikzpicture environment) with the preamble of `main` (project-relative), or
 * with `given`, the preamble as the editor has it.
 * Returns the PDF's path (absolute) or the TeX error.
 */
export async function renderTikz(root: string, main: string, code: string, given?: string): Promise<TikzResult> {
  // The editor sends the preamble as it is on screen (it may not be saved yet).
  const preamble = given ?? preambleOf(await fs.readFile(path.join(root, main), 'utf8'));
  if (preamble === null) return { ok: false, error: `${main} has no \\begin{document}` };
  const hash = createHash('sha256').update(`${VERSION}\0${main}\0${preamble}\0${code}`).digest('hex').slice(0, 24);
  const outDir = path.join(root, BUILD_DIR, 'tikz');
  const pdf = path.join(outDir, `${hash}.pdf`);
  if (existsSync(pdf)) return { ok: true, pdf };
  const pending = running.get(hash);
  if (pending) return pending;
  const job = queue.then(() => run(root, main, preamble, code, outDir, hash));
  queue = job.catch(() => {});
  running.set(hash, job);
  try { return await job; } finally { running.delete(hash); }
}

async function run(root: string, main: string, preamble: string, code: string, outDir: string, hash: string): Promise<TikzResult> {
  await fs.mkdir(outDir, { recursive: true });
  const texFile = path.join(outDir, `${hash}.tex`);
  await fs.writeFile(texFile, tikzDocument(preamble, code));
  // Run where the main file is, like a full compile, so \input and \includegraphics paths resolve.
  const cwd = path.join(root, path.dirname(main));
  const rel = (p: string) => path.relative(cwd, p).split(path.sep).join('/') || '.';
  const text = await new Promise<string>((resolve) => {
    const child = spawn('pdflatex', ['-interaction=nonstopmode', '-halt-on-error', `-output-directory=${rel(outDir)}`, rel(texFile)], { cwd, env: texEnv() });
    let out = '';
    child.stdout.on('data', (d) => (out += d));
    child.stderr.on('data', (d) => (out += d));
    const timer = setTimeout(() => { out += '\n! The picture took too long to compile.\n'; child.kill('SIGKILL'); }, TIMEOUT_MS);
    child.on('error', (err) => { clearTimeout(timer); resolve(`! Could not run pdflatex: ${err.message}\n`); });
    child.on('close', () => { clearTimeout(timer); resolve(out); });
  });
  const pdf = path.join(outDir, `${hash}.pdf`);
  const logFile = path.join(outDir, `${hash}.log`);
  const log = existsSync(logFile) ? await fs.readFile(logFile, 'latin1') : text;
  for (const ext of ['aux', 'out', 'nav', 'snm', 'toc']) await fs.rm(path.join(outDir, `${hash}.${ext}`), { force: true });
  if (existsSync(pdf) && !/^! /m.test(log)) return { ok: true, pdf };
  await fs.rm(pdf, { force: true });
  // Failures aren't cached: installing a missing package fixes them without changing the input.
  return { ok: false, error: firstError(log) };
}
