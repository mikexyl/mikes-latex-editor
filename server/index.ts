// Local server for the browser version of the editor.
// Usage: npm run dev -- [/path/to/project] [--port 5480] [--idle-exit SECONDS]
// Without a path it reopens the last project (or the bundled sample); the UI can switch projects.
import path from 'node:path';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { startServer } from './app.ts';
import { lastProject, expandPath } from './projects.ts';
import { configureTex } from './tex.ts';

const appDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const argv = process.argv.slice(2);
const portFlag = argv.indexOf('--port');
const portArg = portFlag >= 0 ? argv.splice(portFlag, 2)[1] : undefined;
const idleFlag = argv.indexOf('--idle-exit');
const idleExitS = idleFlag >= 0 ? Number(argv.splice(idleFlag, 2)[1]) || 0 : 0;
const initial = argv[0] ?? process.env.PROJECT_DIR;
const root = path.resolve(initial ? expandPath(initial) : (await lastProject()) ?? path.join(appDir, 'examples/sample'));

if (!existsSync(root)) {
  console.error(`Project folder not found: ${root}`);
  process.exit(1);
}

// The system's TeX, unless LATEX_EDITOR_TEX_BASE points at a TeX Live to use in isolation
// (as the desktop app does with its bundled one).
await configureTex({
  base: process.env.LATEX_EDITOR_TEX_BASE ?? null,
  userDir: process.env.LATEX_EDITOR_TEX_USER ?? null,
});

const server = await startServer({
  root,
  appDir,
  port: Number(portArg ?? process.env.PORT ?? 5480),
  host: process.env.HOST,
  production: process.env.NODE_ENV === 'production',
  idleExitS,
});
console.log(`LaTeX editor: ${server.url}`);
console.log(`Project:      ${root}`);
