// The editor's back end: serves the UI and a small API over one LaTeX project folder at a time.
// Started by the command line (server/index.ts) or inside the desktop app (electron/main.ts).
import express from 'express';
import http from 'node:http';
import { createRequire } from 'node:module';
import path from 'node:path';
import fs from 'node:fs/promises';
import { existsSync } from 'node:fs';
import type { AddressInfo } from 'node:net';
import { compile, BUILD_DIR, pdfPathFor } from './compile.ts';
import { synctexForward, synctexBackward, gitLog, gitShow, buildDiff, diffPdfPath } from './tools.ts';
import { addRecent, removeRecent, listRecent, listFolder, checkProjectDir } from './projects.ts';
import { texRoutes } from './tex-routes.ts';

export type ServerOptions = {
  /** The project opened first. */
  root: string;
  /** Folder with dist/ (the built UI) and vite.config.ts. */
  appDir: string;
  port: number;
  /** Try `port` first, and take any free port if it's in use. */
  portFallback?: boolean;
  host?: string;
  /** Serve the built UI from dist/ (otherwise through Vite, with hot reload). */
  production: boolean;
  /** Exit after this many seconds without an editor window (0 = never). */
  idleExitS?: number;
  /** Require this value in an X-App-Token header on every request. */
  token?: string;
};

export type RunningServer = { port: number; url: string; close(): Promise<void>; root(): string };

export async function startServer(opts: ServerOptions): Promise<RunningServer> {
  /** The open project folder. Switched from the UI via POST /api/projects/open. */
  let root = path.resolve(opts.root);
  const HOST = opts.host ?? '127.0.0.1'; // local only by default: the API can write files
  opts.host = HOST;
  await addRecent(root).catch(() => {});

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

  // Only answer requests addressed to this machine. A web page can't reach the API from another site
  // anyway (the browser blocks it), but checking Host also defeats DNS-rebinding tricks.
  const LOCAL_HOSTS = new Set(['127.0.0.1', 'localhost', '[::1]']);
  app.use((req, res, next) => {
    const host = (req.headers.host ?? '').replace(/:\d+$/, '');
    if (opts.host !== '127.0.0.1' && opts.host !== 'localhost') return next(); // deliberately exposed
    if (!LOCAL_HOSTS.has(host)) { res.status(403).send('forbidden'); return; }
    next();
  });

  // Idle shutdown: open editor windows ping every 30 s; with none for idleExitS, exit.
  let lastSeen = Date.now();
  app.use('/api', (_req, _res, next) => { lastSeen = Date.now(); next(); });
  if (opts.idleExitS) {
    const limit = opts.idleExitS * 1000;
    setInterval(() => {
      if (Date.now() - lastSeen > limit) {
        console.log(`No editor window for ${opts.idleExitS}s, exiting.`);
        process.exit(0);
      }
    }, 15_000).unref();
  }

  // The desktop app gives its window a secret; anything else on this machine is refused.
  if (opts.token) {
    app.use((req, res, next) => {
      if (req.get('X-App-Token') !== opts.token) { res.status(403).send('forbidden'); return; }
      next();
    });
  }

  app.use(express.text({ limit: '50mb', type: 'text/plain' }));
  app.use(express.json());

  const wrap = (fn: express.RequestHandler): express.RequestHandler => (req, res, next) =>
    Promise.resolve(fn(req, res, next)).catch(next);

  // Requests made for one project must not land in another after a switch (e.g. from another tab
  // or window): the client sends the root it loaded, and anything sent for a different one is
  // refused, so it can't save a file into the wrong project.
  app.use('/api', (req, res, next) => {
    const expected = req.get('X-Project-Root');
    if (expected !== undefined && expected !== root && !req.path.startsWith('/projects') && !req.path.startsWith('/fs') && !req.path.startsWith('/tex')) {
      res.status(409).json({ error: 'project switched', root });
      return;
    }
    next();
  });

  app.get('/api/ping', (_req, res) => { res.json({ ok: true }); });

  // Stop the server (`latex-editor stop`). JSON-only, so a plain cross-site form/POST can't trigger it.
  app.post('/api/shutdown', (req, res) => {
    if (!req.is('application/json')) { res.status(415).json({ error: 'expected JSON' }); return; }
    res.json({ ok: true });
    setTimeout(() => process.exit(0), 100);
  });

  // ---- projects: recent list, open, folder browsing ----
  app.get('/api/projects', wrap(async (_req, res) => {
    res.json({ current: root, recent: await listRecent() });
  }));

  app.post('/api/projects/open', wrap(async (req, res) => {
    let dir: string;
    try { dir = checkProjectDir(String(req.body?.path ?? '')); }
    catch (e) { throw new HttpError(400, (e as Error).message); }
    root = dir;
    await addRecent(dir);
    console.log(`Project:      ${root}`);
    res.json({ root });
  }));

  app.post('/api/projects/forget', wrap(async (req, res) => {
    await removeRecent(String(req.body?.path ?? ''));
    res.json({ recent: await listRecent() });
  }));

  app.get('/api/fs/list', wrap(async (req, res) => {
    try { res.json(await listFolder(String(req.query.path ?? '~'))); }
    catch (e) { throw new HttpError(400, (e as Error).message); }
  }));

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

  app.use('/api/tex', texRoutes());

  app.use('/api', ((err, _req, res, _next) => {
    const status = err instanceof HttpError ? err.status : err?.code === 'ENOENT' ? 404 : 500;
    res.status(status).json({ error: String(err?.message ?? err) });
  }) as express.ErrorRequestHandler);

  // The pdf.js worker, served untouched: going through Vite's dev transform would inject its
  // browser client into the worker, which fails there (no `document`).
  // A production build carries its own copy (dist/vendor, see scripts/postbuild.mjs).
  const builtWorker = path.join(opts.appDir, 'dist', 'vendor', 'pdf.worker.min.mjs');
  const worker = opts.production && existsSync(builtWorker)
    ? builtWorker : createRequire(import.meta.url).resolve('pdfjs-dist/build/pdf.worker.min.mjs');
  app.get('/vendor/pdf.worker.min.mjs', (_req, res) => {
    // dotfiles: the AppImage runs from a hidden mount (/tmp/.mount_…).
    res.type('text/javascript').sendFile(worker, { dotfiles: 'allow' });
  });

  const server = http.createServer(app);
  if (opts.production) {
    app.use(express.static(path.join(opts.appDir, 'dist')));
  } else {
    const { createServer } = await import('vite');
    const vite = await createServer({
      configFile: path.join(opts.appDir, 'vite.config.ts'),
      root: path.join(opts.appDir, 'web'),
      // Hot reload over this server's own port, so several instances can run side by side.
      server: { middlewareMode: true, hmr: { server } },
      appType: 'spa',
    });
    app.use(vite.middlewares);
  }

  const listen = (port: number) => new Promise<void>((resolve, reject) => {
    const onError = (e: Error) => { server.off('listening', onListening); reject(e); };
    const onListening = () => { server.off('error', onError); resolve(); };
    server.once('error', onError);
    server.once('listening', onListening);
    server.listen(port, HOST);
  });
  try { await listen(opts.port); }
  catch (e) {
    if (!opts.portFallback || (e as NodeJS.ErrnoException).code !== 'EADDRINUSE') throw e;
    await listen(0);
  }
  const port = (server.address() as AddressInfo).port;
  return {
    port,
    url: `http://${HOST === '0.0.0.0' ? 'localhost' : HOST}:${port}`,
    root: () => root,
    close: () => new Promise((resolve) => { server.closeAllConnections(); server.close(() => resolve()); }),
  };
}
