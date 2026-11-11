#!/usr/bin/env node
// Launcher: starts the editor server in the background if it isn't running, optionally switches it
// to a project folder, and opens the editor in its own window.
//
//   latex-editor [folder]     open the editor (on that folder, or the last project)
//   latex-editor stop         stop the background server
//   latex-editor status       show whether it's running and which project is open
//
// The background server exits by itself once no editor window has been open for a while
// (LATEX_EDITOR_IDLE_EXIT seconds, default 600), so nothing keeps running after you're done.
import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const appDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PORT = Number(process.env.LATEX_EDITOR_PORT ?? 5480);
const BASE = `http://127.0.0.1:${PORT}`;
const CONFIG_DIR = process.env.LATEX_EDITOR_CONFIG ?? path.join(os.homedir(), '.config', 'latex-editor');
const LOG = path.join(CONFIG_DIR, 'server.log');
const IDLE_EXIT = process.env.LATEX_EDITOR_IDLE_EXIT ?? '600';

// Apps started from the Dock/Finder or a desktop menu get a minimal PATH: make sure TeX, Node and
// Homebrew tools are found (latexmk, synctex, latexdiff, git).
const extraPath = ['/Library/TeX/texbin', '/opt/homebrew/bin', '/usr/local/bin', path.dirname(process.execPath)];
process.env.PATH = [...new Set([...(process.env.PATH ?? '').split(':'), ...extraPath])].filter(Boolean).join(':');

const say = (msg) => console.log(`latex-editor: ${msg}`);

async function api(pathname, init) {
  const res = await fetch(BASE + pathname, { ...init, signal: AbortSignal.timeout(2000) });
  if (!res.ok) throw new Error((await res.json().catch(() => ({}))).error ?? res.statusText);
  return res.json();
}

async function running() {
  try { return await api('/api/projects'); } catch { return null; }
}

/** Build the UI if it's missing or older than its sources (first run, or after updating the code). */
function ensureBuilt() {
  const built = path.join(appDir, 'dist', 'index.html');
  const newest = (dir) => {
    let t = 0;
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const p = path.join(dir, e.name);
      t = Math.max(t, e.isDirectory() ? newest(p) : fs.statSync(p).mtimeMs);
    }
    return t;
  };
  const stale = !fs.existsSync(built) || newest(path.join(appDir, 'web')) > fs.statSync(built).mtimeMs;
  if (!stale) return;
  say('building the editor (first run or after an update)…');
  const npm = process.platform === 'win32' ? 'npm.cmd' : 'npm';
  const r = spawnSync(npm, ['run', 'build'], { cwd: appDir, stdio: ['ignore', 'pipe', 'pipe'], env: process.env });
  if (r.status !== 0) {
    process.stderr.write(r.stdout ?? '');
    process.stderr.write(r.stderr ?? '');
    throw new Error('build failed (see above)');
  }
}

const serverArgs = () => ['--import', 'tsx', path.join(appDir, 'server', 'index.ts'), '--port', String(PORT), '--idle-exit', IDLE_EXIT];
const xml = (s) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

/**
 * macOS: run the server as an on-demand launchd job. A process started by an app (Dock/Finder
 * launch) is killed when that app's launcher exits, even if detached; a launchd job isn't. The job
 * never restarts by itself (KeepAlive false), so after its idle exit nothing keeps running.
 */
function startWithLaunchd() {
  const label = `local.latex-editor.server.${PORT}`;
  const plist = path.join(os.homedir(), 'Library', 'LaunchAgents', `${label}.plist`);
  const uid = process.getuid();
  const args = [process.execPath, ...serverArgs()].map((a) => `    <string>${xml(a)}</string>`).join('\n');
  fs.mkdirSync(path.dirname(plist), { recursive: true });
  fs.writeFileSync(plist, `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>${label}</string>
  <key>ProgramArguments</key>
  <array>
${args}
  </array>
  <key>WorkingDirectory</key><string>${xml(appDir)}</string>
  <key>EnvironmentVariables</key>
  <dict>
    <key>PATH</key><string>${xml(process.env.PATH ?? '')}</string>
    <key>NODE_ENV</key><string>production</string>
    <key>HOME</key><string>${xml(os.homedir())}</string>
  </dict>
  <key>StandardOutPath</key><string>${xml(LOG)}</string>
  <key>StandardErrorPath</key><string>${xml(LOG)}</string>
  <key>RunAtLoad</key><false/>
  <key>KeepAlive</key><false/>
  <key>ProcessType</key><string>Interactive</string>
</dict>
</plist>
`);
  // (Re)load the job definition (it isn't running at this point), then start it.
  spawnSync('launchctl', ['bootout', `gui/${uid}/${label}`], { stdio: 'ignore' });
  const boot = spawnSync('launchctl', ['bootstrap', `gui/${uid}`, plist], { encoding: 'utf8' });
  if (boot.status !== 0) throw new Error(`launchctl bootstrap failed: ${boot.stderr.trim()}`);
  const kick = spawnSync('launchctl', ['kickstart', `gui/${uid}/${label}`], { encoding: 'utf8' });
  if (kick.status !== 0) throw new Error(`launchctl kickstart failed: ${kick.stderr.trim()}`);
}

/** Linux: a detached background process (desktop launchers don't kill it when they exit). */
function startDetached() {
  const out = fs.openSync(LOG, 'a');
  spawn(process.execPath, serverArgs(), {
    cwd: appDir,
    detached: true,
    stdio: ['ignore', out, out],
    env: { ...process.env, NODE_ENV: 'production' },
  }).unref();
}

async function startServer() {
  ensureBuilt();
  fs.mkdirSync(CONFIG_DIR, { recursive: true });
  if (process.platform === 'darwin') startWithLaunchd();
  else startDetached();
  for (let i = 0; i < 100; i++) {
    await new Promise((r) => setTimeout(r, 150));
    const info = await running();
    if (info) return info;
  }
  throw new Error(`the server didn't start; see ${LOG}`);
}

/** Open the editor in an app-style window (Chrome/Edge/Brave/Chromium), else the default browser. */
function openWindow(url) {
  if (process.env.LATEX_EDITOR_NO_OPEN) return;
  if (process.platform === 'darwin') {
    for (const app of ['Google Chrome', 'Microsoft Edge', 'Brave Browser', 'Chromium']) {
      if (fs.existsSync(`/Applications/${app}.app`) || fs.existsSync(path.join(os.homedir(), 'Applications', `${app}.app`))) {
        spawnSync('open', ['-na', app, '--args', `--app=${url}`]);
        return;
      }
    }
    spawnSync('open', [url]);
    return;
  }
  for (const bin of ['google-chrome', 'google-chrome-stable', 'chromium', 'chromium-browser', 'microsoft-edge', 'brave-browser']) {
    if (spawnSync('which', [bin]).status === 0) {
      spawn(bin, [`--app=${url}`], { detached: true, stdio: 'ignore' }).unref();
      return;
    }
  }
  spawn('xdg-open', [url], { detached: true, stdio: 'ignore' }).unref();
}

async function main() {
  const [cmd, ...rest] = process.argv.slice(2);
  if (cmd === 'stop') {
    const info = await running();
    if (!info) return say('not running');
    await fetch(`${BASE}/api/shutdown`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' }).catch(() => {});
    return say('stopped');
  }
  if (cmd === 'status') {
    const info = await running();
    return say(info ? `running at ${BASE}, project: ${info.current}` : 'not running');
  }
  if (cmd === '--help' || cmd === '-h') {
    return console.log('usage: latex-editor [folder] | stop | status');
  }

  const folder = cmd ? path.resolve(cmd.replace(/^~(?=$|\/)/, os.homedir())) : null;
  if (folder && !fs.existsSync(folder)) throw new Error(`folder not found: ${folder}`);
  let info = await running();
  if (!info) {
    say('starting…');
    info = await startServer(); // reopens the last project; switched below if a folder was given
  }
  if (folder && info.current !== folder) {
    await api('/api/projects/open', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ path: folder }),
    });
  }
  openWindow(`${BASE}/`);
  say(`editor open at ${BASE} (project: ${folder ?? info.current})`);
}

main().catch((e) => {
  console.error(`latex-editor: ${e.message}`);
  process.exit(1);
});
