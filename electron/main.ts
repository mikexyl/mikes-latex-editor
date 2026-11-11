// The desktop app: runs the editor's back end inside this process and shows the UI in a window.
// Built with esbuild into build/electron/main.mjs (npm run electron:build).
import { app, BrowserWindow, dialog, ipcMain, Menu, session, shell } from 'electron';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

// Development runs keep their data apart from the installed app's.
if (!app.isPackaged) app.setName('LaTeX Editor Dev');
const appDir = app.getAppPath(); // holds dist/, examples/ and package.json
const userData = app.getPath('userData'); // ~/Library/Application Support/LaTeX Editor, ~/.config/LaTeX Editor
// Recent projects etc. live with the app's data, not with the browser version's.
process.env.LATEX_EDITOR_CONFIG = userData;

// Imported after LATEX_EDITOR_CONFIG is set.
const { startServer } = await import('../server/app.ts');
const { configureTex } = await import('../server/tex.ts');
const { lastProject } = await import('../server/projects.ts');

// A fixed port keeps the window's origin, and with it the UI's saved settings, the same across
// launches. If it's taken, any free port works (settings then start fresh for that session).
const PREFERRED_PORT = app.isPackaged ? 47801 : 47802;

if (!app.requestSingleInstanceLock()) app.exit(0);

// Recent Ubuntu releases block the unprivileged namespaces Chromium's sandbox needs, so an
// AppImage (which can't install the setuid helper) wouldn't start. The window only ever shows
// the app's own local page, so run it without that sandbox there.
if (process.platform === 'linux' && process.env.APPIMAGE) app.commandLine.appendSwitch('no-sandbox');

/** The bundled TeX Live: in the app's resources when packaged, build/texlive while developing. */
function texBase(): string | null {
  const candidates = [
    process.env.LATEX_EDITOR_TEX_BASE,
    app.isPackaged ? path.join(process.resourcesPath, 'texlive') : path.join(appDir, 'build', 'texlive'),
  ];
  return candidates.find((c) => c && fs.existsSync(path.join(c, 'texmf-dist'))) ?? null;
}

/** The project to open first: the last one, or a copy of the sample (the app's own is read-only). */
async function firstProject(): Promise<string> {
  const last = await lastProject();
  if (last) return last;
  const sample = path.join(userData, 'Sample Project');
  if (!fs.existsSync(sample)) fs.cpSync(path.join(appDir, 'examples', 'sample'), sample, {
    recursive: true,
    filter: (src) => !src.includes('.latex-editor-build'),
  });
  return sample;
}

// ---- window position and size, remembered between launches ----
type Bounds = { x?: number; y?: number; width: number; height: number; maximized?: boolean };
const boundsFile = path.join(userData, 'window.json');
function loadBounds(): Bounds {
  try { return { width: 1400, height: 900, ...JSON.parse(fs.readFileSync(boundsFile, 'utf8')) }; }
  catch { return { width: 1400, height: 900 }; }
}
function saveBounds(win: BrowserWindow) {
  try {
    fs.mkdirSync(userData, { recursive: true });
    fs.writeFileSync(boundsFile, JSON.stringify({ ...win.getNormalBounds(), maximized: win.isMaximized() }));
  } catch { /* not important */ }
}

let win: BrowserWindow | null = null;
let server: Awaited<ReturnType<typeof startServer>> | null = null;

function createWindow(url: string) {
  const b = loadBounds();
  win = new BrowserWindow({
    x: b.x, y: b.y, width: b.width, height: b.height, minWidth: 700, minHeight: 450,
    title: 'LaTeX Editor',
    show: false,
    backgroundColor: '#ffffff',
    webPreferences: {
      preload: path.join(appDir, 'electron', 'preload.cjs'),
      contextIsolation: true,
      sandbox: true,
      nodeIntegration: false,
      spellcheck: true,
    },
  });
  if (b.maximized) win.maximize();
  win.once('ready-to-show', () => win?.show());
  win.on('close', () => { if (win) saveBounds(win); });
  win.on('closed', () => { win = null; });

  // Links to the web open in the user's browser; the window itself never leaves the editor.
  win.webContents.setWindowOpenHandler(({ url: target }) => {
    if (/^https?:/.test(target) && !target.startsWith(url)) void shell.openExternal(target);
    return { action: 'deny' };
  });
  win.webContents.on('will-navigate', (e, target) => {
    if (!target.startsWith(url)) { e.preventDefault(); if (/^https?:/.test(target)) void shell.openExternal(target); }
  });
  void win.loadURL(url);
}

app.on('second-instance', () => {
  if (!win) return;
  if (win.isMinimized()) win.restore();
  win.focus();
});

ipcMain.handle('pick-folder', async (_e, defaultPath?: string) => {
  const r = await dialog.showOpenDialog(win!, {
    title: 'Open LaTeX project folder',
    properties: ['openDirectory', 'createDirectory'],
    defaultPath: typeof defaultPath === 'string' ? defaultPath : undefined,
  });
  return r.canceled ? null : r.filePaths[0] ?? null;
});

ipcMain.handle('reveal-path', (_e, p: unknown) => {
  if (typeof p === 'string' && path.isAbsolute(p)) shell.showItemInFolder(p);
});

app.whenReady().then(async () => {
  // Under the app's data folder: the writable layer for packages installed from the app.
  await configureTex({ base: texBase(), userDir: path.join(userData, 'tex') });
  const token = crypto.randomBytes(24).toString('hex');
  try {
    server = await startServer({
      root: await firstProject(),
      appDir,
      port: PREFERRED_PORT,
      portFallback: true,
      production: app.isPackaged || process.env.NODE_ENV === 'production',
      token,
    });
  } catch (e) {
    dialog.showErrorBox('LaTeX Editor', `The editor couldn't start:\n${(e as Error).message}`);
    app.quit();
    return;
  }
  // Every request from the window carries the token; nothing else on this machine has it.
  const origin = server.url;
  session.defaultSession.webRequest.onBeforeSendHeaders({ urls: [`${origin}/*`] }, (details, callback) => {
    callback({ requestHeaders: { ...details.requestHeaders, 'X-App-Token': token } });
  });
  // The editor needs no camera, location, notifications, ...
  session.defaultSession.setPermissionRequestHandler((_wc, permission, cb) => cb(permission === 'clipboard-sanitized-write'));

  if (process.platform === 'darwin') Menu.setApplicationMenu(Menu.buildFromTemplate(macMenu()));
  else Menu.setApplicationMenu(null);
  createWindow(origin);
});

app.on('window-all-closed', () => app.quit());
app.on('will-quit', () => { void server?.close(); });

function macMenu(): Electron.MenuItemConstructorOptions[] {
  return [
    { role: 'appMenu' },
    { role: 'editMenu' },
    {
      label: 'View',
      submenu: [
        { role: 'reload' }, { role: 'toggleDevTools' }, { type: 'separator' },
        { role: 'resetZoom' }, { role: 'zoomIn' }, { role: 'zoomOut' }, { type: 'separator' }, { role: 'togglefullscreen' },
      ],
    },
    { role: 'windowMenu' },
    {
      role: 'help',
      submenu: [{ label: 'Source code (AGPL-3.0)', click: () => void shell.openExternal('https://github.com/mikexyl/latex-editor') }],
    },
  ];
}
