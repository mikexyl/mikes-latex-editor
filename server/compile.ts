// Runs latexmk and turns the .log into a list of problems the UI can jump to.
import { spawn } from 'node:child_process';
import fs from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';

export const BUILD_DIR = '.latex-editor-build';
const TIMEOUT_MS = 180_000;

export type Problem = { level: 'error' | 'warning'; file: string | null; line: number | null; message: string };
export type CompileResult = { ok: boolean; pdf: boolean; durationMs: number; problems: Problem[]; output: string };

// One compile at a time per project; a request that arrives mid-compile waits for it, then runs.
let queue: Promise<unknown> = Promise.resolve();

export function compile(root: string, main: string): Promise<CompileResult> {
  return compileFile(root, main, BUILD_DIR);
}

/** Compile any .tex file (relative to root) into outDir (relative to root), queued with the rest. */
export function compileFile(root: string, file: string, outDir: string, env: NodeJS.ProcessEnv = {}): Promise<CompileResult> {
  const run = queue.then(() => runLatexmk(root, file, outDir, env));
  queue = run.catch(() => {});
  return run;
}

// Fallbacks for the review markup (`changes` package syntax), so documents with tracked changes
// compile without that package and without editing the preamble. They're injected before the
// document is read and only take effect if nothing else defined these commands by
// \begin{document}; a document that loads `changes` gets the real package. The PDF shows the
// proposed text: additions in blue, deletions and comments hidden.
const REVIEW_FALLBACKS = String.raw`\AtBeginDocument{%
  \providecommand\added[2][]{\ifdefined\textcolor\textcolor{blue}{#2}\else #2\fi}%
  \providecommand\deleted[2][]{}%
  \providecommand\replaced[3][]{\ifdefined\textcolor\textcolor{blue}{#2}\else #2\fi}%
  \providecommand\highlight[2][]{#2}%
  \providecommand\comment[2][]{}%
}
`;
const FALLBACK_FILE = 'latex-editor-review.tex';

async function runLatexmk(root: string, main: string, outDir: string, env: NodeJS.ProcessEnv): Promise<CompileResult> {
  const start = Date.now();
  await fs.mkdir(path.join(root, BUILD_DIR), { recursive: true });
  await fs.writeFile(path.join(root, BUILD_DIR, FALLBACK_FILE), REVIEW_FALLBACKS);
  const jobname = path.basename(main).replace(/\.tex$/, '');
  const args = [
    '-pdf', '-synctex=1', '-interaction=nonstopmode', '-file-line-error', `-outdir=${outDir}`,
    `-jobname=${jobname}`, '-usepretex', `-pretex=\\input{${BUILD_DIR}/${FALLBACK_FILE}}`, main,
  ];
  const output = await new Promise<{ code: number | null; text: string }>((resolve) => {
    const child = spawn('latexmk', args, { cwd: root, env: { ...process.env, ...env } });
    let text = '';
    child.stdout.on('data', (d) => (text += d));
    child.stderr.on('data', (d) => (text += d));
    const timer = setTimeout(() => { text += '\n[latex-editor] compile timed out, killed\n'; child.kill('SIGKILL'); }, TIMEOUT_MS);
    child.on('error', (err) => { clearTimeout(timer); resolve({ code: -1, text: text + `\n${err.message}\n` }); });
    child.on('close', (code) => { clearTimeout(timer); resolve({ code, text }); });
  });

  const stem = path.basename(main).replace(/\.tex$/, '');
  const logPath = path.join(root, outDir, `${stem}.log`);
  const log = existsSync(logPath) ? await fs.readFile(logPath, 'latin1') : '';
  const problems = parseLog(log, root, main);
  if (output.code === -1) problems.unshift({ level: 'error', file: null, line: null, message: 'Could not run latexmk. Is TeX installed and on PATH?' });

  return {
    ok: output.code === 0 && !problems.some((p) => p.level === 'error'),
    pdf: existsSync(path.join(root, outDir, `${stem}.pdf`)),
    durationMs: Date.now() - start,
    problems,
    output: output.text.slice(-20_000),
  };
}

function normalize(file: string, root: string): string {
  const abs = path.resolve(root, file);
  return path.relative(root, abs).split(path.sep).join('/');
}

export function parseLog(log: string, root: string, _main: string): Problem[] {
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
      add({ level: 'error', file: normalize(err[1], root), line: Number(err[2]), message: err[3].trim() });
      continue;
    }
    if (l.startsWith('! ')) {
      add({ level: 'error', file: null, line: null, message: l.slice(2).trim() });
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
