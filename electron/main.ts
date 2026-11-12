// The desktop app: runs the editor's back end inside this process and shows the UI in a window.
// Built with esbuild into build/electron/main.mjs (npm run electron:build).
import { app, BrowserWindow, dialog, ipcMain, Menu, session, shell } from 'electron';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

// Recent Ubuntu releases block the unprivileged namespaces Chromium's sandbox needs, so an
// AppImage (which can't install the setuid helper) wouldn't start. The window only ever shows
// the app's own local page, so run it without that sandbox there. The switch has to be on the
// real command line: set from here (app.commandLine.appendSwitch) it comes too late, Chromium's
// helper processes are already sandboxed and crash, and the window stays blank. So start again
// with it, through the AppImage itself (this process's executable is inside its mount, which
// goes away when we exit).
if (process.platform === 'linux' && process.env.APPIMAGE && !process.argv.includes('--no-sandbox')
  && userNamespacesRestricted()) {
  app.relaunch({ execPath: process.env.APPIMAGE, args: [...process.argv.slice(1), '--no-sandbox'] });
  app.exit(0);
  await new Promise(() => {}); // run nothing else in this instance
}
function userNamespacesRestricted(): boolean {
  try { return fs.readFileSync('/proc/sys/kernel/apparmor_restrict_unprivileged_userns', 'utf8').trim() === '1'; }
  catch { return false; }
}

// Development runs keep their data apart from the installed app's.
if (!app.isPackaged) app.setName("Mike's Dev");
// The app was first released as "LaTeX Editor": carry its data (recent projects, installed TeX
// packages, window and UI settings) over once. Electron has already created the new folder by
// now, so move the items rather than the folder.
if (app.isPackaged) {
  const dataDir = app.getPath('userData');
  const legacy = path.join(path.dirname(dataDir), 'LaTeX Editor');
  if (fs.existsSync(legacy) && !fs.existsSync(path.join(dataDir, 'projects.json'))) {
    try {
      fs.mkdirSync(dataDir, { recursive: true });
      for (const item of ['projects.json', 'window.json', 'tex', 'Sample Project', 'Local Storage']) {
        const from = path.join(legacy, item);
        const to = path.join(dataDir, item);
        if (!fs.existsSync(from)) continue;
        fs.rmSync(to, { recursive: true, force: true });
        fs.renameSync(from, to);
      }
      // Recent projects may point into the old folder (the sample project).
      const recent = path.join(dataDir, 'projects.json');
      if (fs.existsSync(recent)) fs.writeFileSync(recent, fs.readFileSync(recent, 'utf8').split(legacy).join(dataDir));
      fs.rmSync(legacy, { recursive: true, force: true }); // what's left is Chromium caches
    } catch { /* start fresh */ }
  }
}

const appDir = app.getAppPath(); // holds dist/, examples/ and package.json
const userData = app.getPath('userData'); // ~/Library/Application Support/Mike's, ~/.config/Mike's
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

/** Open editor windows; each has its own project. */
const windows = new Set<BrowserWindow>();
let server: Awaited<ReturnType<typeof startServer>> | null = null;

// The window's icon on Linux (macOS takes the bundle's). dist/ when built, web/public/ otherwise.
const windowIcon = [path.join(appDir, 'dist', 'icon-512.png'), path.join(appDir, 'web', 'public', 'icon-512.png')]
  .find((p) => fs.existsSync(p));

/**
 * An AppImage installs nothing, so GNOME's dock has no launcher to match the window to (by its
 * WM_CLASS, "mikes") and shows a generic icon, which can't be pinned either. Register one under
 * ~/.local/share, pointing at this AppImage; rewritten when the AppImage moves.
 */
function registerAppImageLauncher() {
  const appImage = process.env.APPIMAGE;
  if (process.platform !== 'linux' || !appImage || !windowIcon) return;
  try {
    const share = process.env.XDG_DATA_HOME || path.join(app.getPath('home'), '.local', 'share');
    const iconFile = path.join(share, 'icons', 'hicolor', '512x512', 'apps', 'mikes.png');
    const desktopFile = path.join(share, 'applications', 'mikes.desktop');
    const icon = fs.readFileSync(windowIcon);
    if (!fs.existsSync(iconFile) || !fs.readFileSync(iconFile).equals(icon)) {
      fs.mkdirSync(path.dirname(iconFile), { recursive: true });
      fs.writeFileSync(iconFile, icon);
    }
    const quoted = `"${appImage.replace(/(["`$\\])/g, '\\$1')}"`;
    const entry = `[Desktop Entry]
Type=Application
Name=Mike's
Comment=Review and revise LaTeX papers with a visual editor
Exec=${quoted} %U
TryExec=${appImage}
Icon=${iconFile}
Terminal=false
Categories=Office;
StartupWMClass=mikes
StartupNotify=true
`;
    if (fs.existsSync(desktopFile) && fs.readFileSync(desktopFile, 'utf8') === entry) return;
    fs.mkdirSync(path.dirname(desktopFile), { recursive: true });
    fs.writeFileSync(desktopFile, entry, { mode: 0o755 });
  } catch { /* the window still works, just with a generic dock icon */ }
}

/**
 * Open an editor window on the server at `origin`. `query` says what it shows first: `project=<dir>`
 * (a project opened for it), `pick=1` (the project picker), or nothing (the last project).
 */
function createWindow(origin: string, query = '') {
  const b = loadBounds();
  // Further windows open a little down and right of the one in front, not on top of it.
  const front = BrowserWindow.getFocusedWindow() ?? [...windows].pop();
  const fb = front?.getNormalBounds();
  const at: Bounds = fb ? { ...fb, x: fb.x + 32, y: fb.y + 32 } : b;
  const win = new BrowserWindow({
    x: at.x, y: at.y, width: at.width, height: at.height, minWidth: 700, minHeight: 450,
    title: "Mike's",
    icon: process.platform === 'linux' ? windowIcon : undefined,
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
  if (!front && b.maximized) win.maximize();
  windows.add(win);
  win.once('ready-to-show', () => win.show());
  win.on('close', () => saveBounds(win));
  win.on('closed', () => { windows.delete(win); });

  // Links to the web open in the user's browser; the window itself never leaves the editor.
  win.webContents.setWindowOpenHandler(({ url: target }) => {
    if (/^https?:/.test(target) && !target.startsWith(origin)) void shell.openExternal(target);
    return { action: 'deny' };
  });
  win.webContents.on('will-navigate', (e, target) => {
    if (!target.startsWith(origin)) { e.preventDefault(); if (/^https?:/.test(target)) void shell.openExternal(target); }
  });
  void win.loadURL(query ? `${origin}/?${query}` : origin);
}

/** A new window: on `project` (already opened on the server), else showing the project picker. */
function newWindow(project?: string) {
  if (!server) return;
  createWindow(server.url, project ? `project=${encodeURIComponent(project)}` : 'pick=1');
}

// Launching the app again (e.g. the dock's "New Window") opens another window.
app.on('second-instance', () => newWindow());

ipcMain.handle('new-window', (_e, project?: unknown) => newWindow(typeof project === 'string' ? project : undefined));

ipcMain.handle('pick-folder', async (e, defaultPath?: string) => {
  const parent = BrowserWindow.fromWebContents(e.sender);
  const r = await dialog.showOpenDialog(parent!, {
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
  registerAppImageLauncher();
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
    dialog.showErrorBox("Mike's", `The editor couldn't start:\n${(e as Error).message}`);
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

  if (process.platform === 'darwin') {
    Menu.setApplicationMenu(Menu.buildFromTemplate(macMenu()));
    app.dock?.setMenu(Menu.buildFromTemplate([{ label: 'New Window', click: () => newWindow() }]));
  } else Menu.setApplicationMenu(null);
  createWindow(origin);
});

app.on('window-all-closed', () => app.quit());
app.on('will-quit', () => { void server?.close(); });

function macMenu(): Electron.MenuItemConstructorOptions[] {
  return [
    { role: 'appMenu' },
    { label: 'File', submenu: [{ label: 'New Window', accelerator: 'CmdOrCtrl+Shift+N', click: () => newWindow() }, { type: 'separator' }, { role: 'close' }] },
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
      submenu: [{ label: 'Source code (AGPL-3.0)', click: () => void shell.openExternal('https://github.com/mikexyl/mikes-latex-editor') }],
    },
  ];
}
