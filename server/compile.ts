// Runs latexmk and turns the .log into a list of problems the UI can jump to.
import { spawn } from 'node:child_process';
import fs from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { texEnv } from './tex.ts';

export const BUILD_DIR = '.latex-editor-build';
const TIMEOUT_MS = 180_000;

export type Problem = {
  level: 'error' | 'warning'; file: string | null; line: number | null; message: string;
  /** A LaTeX file (package or class) that wasn't found, e.g. `capt-of.sty`. */
  missingFile?: string;
};
export type CompileResult = { ok: boolean; pdf: boolean; durationMs: number; problems: Problem[]; output: string };

// One compile at a time per project; a request that arrives mid-compile waits for it, then runs.
let queue: Promise<unknown> = Promise.resolve();

/**
 * Build output for a root document: one folder per source folder, so `paper/main.tex` and
 * `slides/main.tex` don't overwrite each other. Relative to the project root.
 */
export const buildDirFor = (main: string) => path.join(BUILD_DIR, path.dirname(main));
export const pdfPathFor = (root: string, main: string) =>
  path.join(root, buildDirFor(main), path.basename(main).replace(/\.tex$/, '.pdf'));

export function compile(root: string, main: string): Promise<CompileResult> {
  return compileFile(root, main, buildDirFor(main));
}

/**
 * Compile a .tex file (relative to root) into outDir (relative to root), queued with the rest.
 * LaTeX runs in `cwdDir` (relative to root; default: the file's own folder), like running
 * latexmk next to the file, so \includegraphics, \input and .bib paths resolve as usual.
 */
export function compileFile(
  root: string, file: string, outDir: string, env: NodeJS.ProcessEnv = {}, cwdDir = path.dirname(file),
): Promise<CompileResult> {
  const run = queue.then(() => runLatexmk(root, file, outDir, env, cwdDir));
  queue = run.catch(() => {});
  return run;
}

// Fallbacks for the review markup (`changes` package syntax), so documents with tracked changes
// compile without that package and without editing the preamble. They're injected before the
// document is read and only take effect if nothing else defined these commands by
// \begin{document}; a document that loads `changes` gets the real package. The PDF shows the
// proposed text: additions in blue, deletions and comments hidden. \note{XL}{text} (the editor's
// default note macro) prints as a red [XL: text], unless the document defines its own \note.
const REVIEW_FALLBACKS = String.raw`\AtBeginDocument{%
  \providecommand\added[2][]{\ifdefined\textcolor\textcolor{blue}{#2}\else #2\fi}%
  \providecommand\deleted[2][]{}%
  \providecommand\replaced[3][]{\ifdefined\textcolor\textcolor{blue}{#2}\else #2\fi}%
  \providecommand\highlight[2][]{#2}%
  \providecommand\comment[2][]{}%
  \providecommand\note[2]{\ifdefined\textcolor\textcolor{red}{[#1: #2]}\else[#1: #2]\fi}%
}
`;
const FALLBACK_FILE = 'latex-editor-review.tex';

async function runLatexmk(root: string, main: string, outDir: string, env: NodeJS.ProcessEnv, cwdDir: string): Promise<CompileResult> {
  const start = Date.now();
  const cwd = path.join(root, cwdDir);
  const outAbs = path.join(root, outDir);
  await fs.mkdir(outAbs, { recursive: true });
  await fs.writeFile(path.join(root, BUILD_DIR, FALLBACK_FILE), REVIEW_FALLBACKS);
  const jobname = path.basename(main).replace(/\.tex$/, '');
  // Paths given to TeX are relative to cwd (TeX doesn't cope with spaces in paths).
  const rel = (p: string) => path.relative(cwd, p).split(path.sep).join('/') || '.';
  const args = [
    '-pdf', '-synctex=1', '-interaction=nonstopmode', '-file-line-error', `-outdir=${rel(outAbs)}`,
    `-jobname=${jobname}`, '-usepretex', `-pretex=\\input{${rel(path.join(root, BUILD_DIR, FALLBACK_FILE))}}`,
    rel(path.join(root, main)),
  ];
  const runOnce = (extra: string[]) => new Promise<{ code: number | null; text: string }>((resolve) => {
    const child = spawn('latexmk', [...extra, ...args], { cwd, env: { ...texEnv(), ...env } });
    let text = '';
    child.stdout.on('data', (d) => (text += d));
    child.stderr.on('data', (d) => (text += d));
    const timer = setTimeout(() => { text += '\n[latex-editor] compile timed out, killed\n'; child.kill('SIGKILL'); }, TIMEOUT_MS);
    child.on('error', (err) => { clearTimeout(timer); resolve({ code: -1, text: text + `\n${err.message}\n` }); });
    child.on('close', (code) => { clearTimeout(timer); resolve({ code, text }); });
  });
  let output = await runOnce([]);
  // latexmk doesn't rerun after a failed compile if no source file changed, and just repeats the old
  // error. But the cause may have been fixed outside the sources (a package installed, a figure
  // added), so force one fresh run in that case.
  if (output.code !== 0 && /gave an error in previous invocation|All targets .* are up-to-date/.test(output.text)) {
    output = await runOnce(['-g']);
  }

  const stem = path.basename(main).replace(/\.tex$/, '');
  const logPath = path.join(outAbs, `${stem}.log`);
  const log = existsSync(logPath) ? await fs.readFile(logPath, 'latin1') : '';
  const problems = parseLog(log, root, cwd);
  if (output.code === -1) problems.unshift({ level: 'error', file: null, line: null, message: 'Could not run latexmk. Is TeX installed and on PATH?' });

  return {
    ok: output.code === 0 && !problems.some((p) => p.level === 'error'),
    pdf: existsSync(path.join(outAbs, `${stem}.pdf`)),
    durationMs: Date.now() - start,
    problems,
    output: output.text.slice(-20_000),
  };
}

/** A path from the log (relative to the folder LaTeX ran in) as a project-relative path. */
function normalize(file: string, root: string, cwd: string): string {
  const abs = path.resolve(cwd, file);
  return path.relative(root, abs).split(path.sep).join('/');
}

const MISSING = /File `([^']+)\.(sty|cls)' not found/;

export function parseLog(log: string, root: string, cwd: string = root): Problem[] {
  const problems: Problem[] = [];
  const seen = new Set<string>();
  const add = (p: Problem) => {
    const key = `${p.level}|${p.file}|${p.line}|${p.message}`;
    if (!seen.has(key)) { seen.add(key); problems.push(p); }
  };
  const lines = log.split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    const l = lines[i];
    // -file-line-error format: ./sections/intro.tex:12: Undefined control sequence.
    const err = /^(\.?\/?[^:\s][^:]*\.(?:tex|sty|cls|bbl|aux)):(\d+): (.*)$/.exec(l);
    if (err) {
      const missing = MISSING.exec(err[3]);
      add({
        level: 'error', file: normalize(err[1], root, cwd), line: Number(err[2]), message: err[3].trim(),
        ...(missing ? { missingFile: `${missing[1]}.${missing[2]}` } : {}),
      });
      continue;
    }
    if (l.startsWith('! ')) {
      const message = l.slice(2).trim();
      // Smaller TeX installs lack many packages. The UI offers to install the missing one (or
      // says how). The TeX Live package is usually named like the file, but not always.
      const missing = MISSING.exec(message);
      if (missing) {
        add({ level: 'error', file: null, line: null, message: `Missing LaTeX package "${missing[1]}" (${missing[1]}.${missing[2]} not found).`, missingFile: `${missing[1]}.${missing[2]}` });
        continue;
      }
      add({ level: 'error', file: null, line: null, message });
      continue;
    }
    const warn = /^(?:LaTeX|Package (\S+)) Warning: (.*)$/.exec(l);
    if (warn) {
      // Warnings wrap at 79 columns; join continuation lines until a blank line.
      let msg = warn[2];
      while (i + 1 < lines.length && lines[i + 1].trim() !== '' && !/Warning:|^\(|^!/.test(lines[i + 1])) {
        msg += ' ' + lines[++i].trim();
      }
      msg = msg.replace(/^\(\S+\)\s*/, '');
      const m = /on input line (\d+)\.?/.exec(msg);
      add({
        level: 'warning',
        file: null, // the log does not reliably say which file the line belongs to, so don't guess
        line: m ? Number(m[1]) : null,
        message: (warn[1] ? `[${warn[1]}] ` : '') + msg.replace(/\s*on input line \d+\.?/, '').trim(),
      });
    }
  }
  return problems;
}
