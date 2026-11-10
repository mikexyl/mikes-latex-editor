// Local server: serves the editor UI and a small API over one LaTeX project folder.
// Usage: npm run dev -- /path/to/project [--port 5480]
import express from 'express';
import http from 'node:http';
import { createRequire } from 'node:module';
import path from 'node:path';
import fs from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { compile, BUILD_DIR, pdfPathFor } from './compile.ts';
import { synctexForward, synctexBackward, gitLog, gitShow, buildDiff, diffPdfPath } from './tools.ts';

const appDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const argv = process.argv.slice(2);
const portFlag = argv.indexOf('--port');
const portArg = portFlag >= 0 ? argv.splice(portFlag, 2)[1] : undefined;
const root = path.resolve(argv[0] ?? process.env.PROJECT_DIR ?? path.join(appDir, 'examples/sample'));
const PORT = Number(portArg ?? process.env.PORT ?? 5480);
const HOST = process.env.HOST ?? '127.0.0.1'; // local only by default: the API can write files
const isProd = process.env.NODE_ENV === 'production';

if (!existsSync(root)) {
  console.error(`Project folder not found: ${root}`);
  process.exit(1);
}

const IGNORED = new Set(['.git', 'node_modules', BUILD_DIR, '.DS_Store']);

/** Resolve a project-relative path, refusing anything outside the project root. */
function resolveInRoot(rel: unknown): string {
  if (typeof rel !== 'string' || rel === '') throw new HttpError(400, 'missing path');
  const abs = path.resolve(root, rel);
  if (abs !== root && !abs.startsWith(root + path.sep)) throw new HttpError(403, 'path outside project');
  return abs;
}

class HttpError extends Error {
  constructor(public status: number, message: string) { super(message); }
}

type Entry = { path: string; type: 'file' | 'dir' };

async function listTree(dir = root, out: Entry[] = []): Promise<Entry[]> {
  const entries = await fs.readdir(dir, { withFileTypes: true });
  entries.sort((a, b) => Number(b.isDirectory()) - Number(a.isDirectory()) || a.name.localeCompare(b.name));
  for (const e of entries) {
    if (IGNORED.has(e.name) || e.name.startsWith('.')) continue;
    const abs = path.join(dir, e.name);
    const rel = path.relative(root, abs).split(path.sep).join('/');
    if (e.isDirectory()) {
      out.push({ path: rel, type: 'dir' });
      await listTree(abs, out);
    } else if (e.isFile()) {
      out.push({ path: rel, type: 'file' });
    }
  }
  return out;
}

/** Root documents: .tex files that contain \documentclass. main.tex first. */
async function findMainCandidates(tree: Entry[]): Promise<string[]> {
  const found: string[] = [];
  for (const e of tree) {
    if (e.type !== 'file' || !e.path.endsWith('.tex')) continue;
    const text = await fs.readFile(path.join(root, e.path), 'utf8');
    if (/^[^%\n]*\\documentclass/m.test(text)) found.push(e.path);
  }
  const score = (p: string) => (p === 'main.tex' ? 0 : p.includes('/') ? 2 : 1);
  return found.sort((a, b) => score(a) - score(b) || a.localeCompare(b));
}

const app = express();
app.use(express.text({ limit: '50mb', type: 'text/plain' }));
app.use(express.json());

const wrap = (fn: express.RequestHandler): express.RequestHandler => (req, res, next) =>
  Promise.resolve(fn(req, res, next)).catch(next);

app.get('/api/project', wrap(async (_req, res) => {
  const tree = await listTree();
  res.json({ name: path.basename(root), root, tree, mains: await findMainCandidates(tree) });
}));

app.get('/api/file', wrap(async (req, res) => {
  const abs = resolveInRoot(req.query.path);
  const [content, stat] = await Promise.all([fs.readFile(abs, 'utf8'), fs.stat(abs)]);
  res.json({ content, mtime: stat.mtimeMs });
}));

// Write a file. If baseMtime is given and the file changed on disk since then, refuse with 409
// so edits made outside the editor (git checkout, another editor) are never silently clobbered.
app.put('/api/file', wrap(async (req, res) => {
  const abs = resolveInRoot(req.query.path);
  if (typeof req.body !== 'string') throw new HttpError(400, 'body must be text/plain');
  const base = req.query.baseMtime !== undefined ? Number(req.query.baseMtime) : undefined;
  if (base !== undefined && existsSync(abs)) {
    const current = (await fs.stat(abs)).mtimeMs;
    if (current !== base) {
      res.status(409).json({ error: 'changed on disk', mtime: current });
      return;
    }
  }
  await fs.mkdir(path.dirname(abs), { recursive: true });
  await fs.writeFile(abs, req.body, 'utf8');
  res.json({ mtime: (await fs.stat(abs)).mtimeMs });
}));

app.post('/api/compile', wrap(async (req, res) => {
  const main = req.body?.main;
  resolveInRoot(main);
  res.json(await compile(root, main));
}));

app.get('/api/pdf', wrap(async (req, res) => {
  resolveInRoot(req.query.main);
  const pdf = pdfPathFor(root, String(req.query.main));
  if (!existsSync(pdf)) throw new HttpError(404, 'no PDF yet');
  res.setHeader('Cache-Control', 'no-store');
  res.sendFile(pdf, { dotfiles: 'allow' });
}));

// A figure referenced from LaTeX, e.g. \includegraphics{figs/plot}. Like LaTeX, paths are relative
// to the main file's folder (`base`), and the usual extensions are tried when none is given.
const GRAPHICS_EXT = ['.pdf', '.png', '.jpg', '.jpeg', '.gif', '.svg'];
app.get('/api/asset', wrap(async (req, res) => {
  const base = String(req.query.base ?? '');
  const rel = path.posix.join(base, String(req.query.path ?? ''));
  const candidates = path.extname(rel) ? [rel] : GRAPHICS_EXT.map((e) => rel + e);
  for (const c of candidates) {
    const abs = resolveInRoot(c);
    if (existsSync(abs) && (await fs.stat(abs)).isFile()) {
      res.setHeader('Cache-Control', 'no-cache');
      res.sendFile(abs, { dotfiles: 'allow' });
      return;
    }
  }
  throw new HttpError(404, `figure not found: ${rel}`);
}));

// ---- SyncTeX: source <-> PDF ----
app.get('/api/synctex/forward', wrap(async (req, res) => {
  const main = String(req.query.main ?? '');
  const file = String(req.query.file ?? '');
  resolveInRoot(main);
  resolveInRoot(file);
  res.json({ boxes: await synctexForward(root, main, file, Number(req.query.line) || 1) });
}));

app.get('/api/synctex/backward', wrap(async (req, res) => {
  const main = String(req.query.main ?? '');
  resolveInRoot(main);
  const hit = await synctexBackward(root, main, Number(req.query.page), Number(req.query.x), Number(req.query.y));
  res.json(hit ?? { file: null, line: null });
}));

// ---- git history and comparisons ----
app.get('/api/git/log', wrap(async (_req, res) => {
  const commits = await gitLog(root);
  res.json({ repo: commits !== null, commits: commits ?? [] });
}));

app.get('/api/git/show', wrap(async (req, res) => {
  const file = String(req.query.path ?? '');
  resolveInRoot(file);
  const content = await gitShow(root, String(req.query.rev ?? ''), file);
  res.json({ exists: content !== null, content: content ?? '' });
}));

app.post('/api/diff', wrap(async (req, res) => {
  const main = String(req.body?.main ?? '');
  resolveInRoot(main);
  res.json(await buildDiff(root, main, String(req.body?.rev ?? '')));
}));

app.get('/api/diff/pdf', wrap(async (req, res) => {
  const main = String(req.query.main ?? '');
  resolveInRoot(main);
  const pdf = diffPdfPath(root, main);
  if (!existsSync(pdf)) throw new HttpError(404, 'no diff PDF');
  res.setHeader('Cache-Control', 'no-store');
  res.sendFile(pdf, { dotfiles: 'allow' });
}));

app.use('/api', ((err, _req, res, _next) => {
  const status = err instanceof HttpError ? err.status : err?.code === 'ENOENT' ? 404 : 500;
  res.status(status).json({ error: String(err?.message ?? err) });
}) as express.ErrorRequestHandler);

// The pdf.js worker, served untouched: going through Vite's dev transform would inject its
// browser client into the worker, which fails there (no `document`).
const require = createRequire(import.meta.url);
app.get('/vendor/pdf.worker.min.mjs', (_req, res) => {
  res.type('text/javascript').sendFile(require.resolve('pdfjs-dist/build/pdf.worker.min.mjs'));
});

const server = http.createServer(app);
if (isProd) {
  app.use(express.static(path.join(appDir, 'dist')));
} else {
  const { createServer } = await import('vite');
  const vite = await createServer({
    configFile: path.join(appDir, 'vite.config.ts'),
    // Hot reload over this server's own port, so several instances can run side by side.
    server: { middlewareMode: true, hmr: { server } },
    appType: 'spa',
  });
  app.use(vite.middlewares);
}

server.listen(PORT, HOST, () => {
  console.log(`LaTeX editor: http://${HOST === '0.0.0.0' ? 'localhost' : HOST}:${PORT}`);
  console.log(`Project:      ${root}`);
});
