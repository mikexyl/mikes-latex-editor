#!/usr/bin/env node
// Installs a launcher for the editor:
//   macOS:  ~/Applications/Mike's.app   (Dock, Launchpad, Spotlight)
//   Ubuntu: ~/.local/share/applications/latex-editor.desktop   (app menu / Activities)
//   both:   ~/.local/bin/latex-editor   (terminal command)
// No admin rights needed. `npm run uninstall-app` removes them again.
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const appDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const home = os.homedir();
const launcher = path.join(appDir, 'bin', 'latex-editor.mjs');
const icon = path.join(appDir, 'web', 'public', 'icon.svg');
// Prefer the `node` found on PATH (e.g. /opt/homebrew/bin/node, a stable link) over the resolved
// binary, whose versioned path (…/Cellar/node/26.0.0/…) breaks when Node is upgraded.
const nodeOnPath = spawnSync('sh', ['-c', 'command -v node'], { encoding: 'utf8' }).stdout.trim();
const node = nodeOnPath && fs.existsSync(nodeOnPath) ? nodeOnPath : process.execPath;
const uninstall = process.argv.includes('--uninstall');

const macApp = path.join(home, 'Applications', "Mike's.app");
const legacyMacApp = path.join(home, 'Applications', 'LaTeX Editor.app'); // the launcher's earlier name
const desktopFile = path.join(home, '.local', 'share', 'applications', 'latex-editor.desktop');
const binDir = path.join(home, '.local', 'bin');
const cliPath = path.join(binDir, 'latex-editor');

// GUI launches get a minimal PATH; keep the one from the terminal the installer runs in (where
// node, npm, latexmk and git are found), plus the usual TeX/Homebrew locations.
const PATH = [...new Set([...(process.env.PATH ?? '').split(':'), '/Library/TeX/texbin', '/opt/homebrew/bin', '/usr/local/bin', path.dirname(node)])]
  .filter((p) => p && !p.includes('"')).join(':');

const q = (s) => `"${s.replace(/(["\\$`])/g, '\\$1')}"`; // quote for sh
const log = (m) => console.log(m);
const run = (cmd, args) => {
  const r = spawnSync(cmd, args, { stdio: ['ignore', 'pipe', 'pipe'] });
  if (r.status !== 0) throw new Error(`${cmd} ${args.join(' ')} failed: ${r.stderr}`);
};

function writeCli() {
  fs.mkdirSync(binDir, { recursive: true });
  fs.writeFileSync(cliPath, `#!/bin/sh\n# Mike's (LaTeX editor) launcher (installed by npm run install-app)\nexport PATH=${q(PATH)}\nexec ${q(node)} ${q(launcher)} "$@"\n`);
  fs.chmodSync(cliPath, 0o755);
  log(`  terminal command: ${cliPath}`);
  if (!(process.env.PATH ?? '').split(':').includes(binDir)) {
    log(`    (add ${binDir} to your PATH to run \`latex-editor\` from anywhere)`);
  }
}

function macIcon(resources) {
  const iconset = path.join(os.tmpdir(), `latex-editor-${process.pid}.iconset`);
  fs.rmSync(iconset, { recursive: true, force: true });
  fs.mkdirSync(iconset);
  for (const size of [16, 32, 128, 256, 512]) {
    run('sips', ['-s', 'format', 'png', '-z', String(size), String(size), icon, '--out', path.join(iconset, `icon_${size}x${size}.png`)]);
    run('sips', ['-s', 'format', 'png', '-z', String(size * 2), String(size * 2), icon, '--out', path.join(iconset, `icon_${size}x${size}@2x.png`)]);
  }
  run('iconutil', ['-c', 'icns', iconset, '-o', path.join(resources, 'AppIcon.icns')]);
  fs.rmSync(iconset, { recursive: true, force: true });
}

function installMac() {
  fs.rmSync(legacyMacApp, { recursive: true, force: true });
  fs.rmSync(macApp, { recursive: true, force: true });
  const contents = path.join(macApp, 'Contents');
  const macos = path.join(contents, 'MacOS');
  const resources = path.join(contents, 'Resources');
  fs.mkdirSync(macos, { recursive: true });
  fs.mkdirSync(resources, { recursive: true });
  fs.writeFileSync(path.join(contents, 'Info.plist'), `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>CFBundleName</key><string>Mike's</string>
  <key>CFBundleDisplayName</key><string>Mike's</string>
  <key>CFBundleIdentifier</key><string>local.latex-editor.launcher</string>
  <key>CFBundleExecutable</key><string>latex-editor</string>
  <key>CFBundleIconFile</key><string>AppIcon</string>
  <key>CFBundlePackageType</key><string>APPL</string>
  <key>CFBundleShortVersionString</key><string>1.0</string>
  <key>LSMinimumSystemVersion</key><string>11.0</string>
  <key>NSHighResolutionCapable</key><true/>
</dict>
</plist>
`);
  const exe = path.join(macos, 'latex-editor');
  fs.writeFileSync(exe, `#!/bin/sh
# Starts the LaTeX editor (server in the background) and opens its window.
export PATH=${q(PATH)}
mkdir -p "$HOME/.config/latex-editor"
exec ${q(node)} ${q(launcher)} "$@" >> "$HOME/.config/latex-editor/launcher.log" 2>&1
`);
  fs.chmodSync(exe, 0o755);
  try { macIcon(resources); } catch (e) { log(`  (couldn't build the app icon: ${e.message})`); }
  // Let Spotlight/Launchpad know about it right away.
  spawnSync('/System/Library/Frameworks/CoreServices.framework/Frameworks/LaunchServices.framework/Support/lsregister', ['-f', macApp]);
  log(`  app: ${macApp}`);
  log('    open it from Spotlight, Launchpad or Finder > Applications; drag it to the Dock to keep it there');
}

function installLinux() {
  fs.mkdirSync(path.dirname(desktopFile), { recursive: true });
  fs.writeFileSync(desktopFile, `[Desktop Entry]
Type=Application
Name=Mike's
Comment=Review and revise LaTeX papers with a visual editor
Exec=env ${q(`PATH=${PATH}`)} ${q(node)} ${q(launcher)} %f
Icon=${icon}
Terminal=false
Categories=Office;Publishing;TextEditor;
MimeType=inode/directory;
StartupNotify=false
`);
  fs.chmodSync(desktopFile, 0o755);
  spawnSync('update-desktop-database', [path.dirname(desktopFile)]);
  log(`  app menu entry: ${desktopFile}`);
  log('    find "Mike's" in Activities; right-click it there to add it to the dock');
}

function remove(p) {
  if (fs.existsSync(p)) { fs.rmSync(p, { recursive: true, force: true }); log(`  removed ${p}`); }
}

if (uninstall) {
  log("Removing the Mike's launcher…");
  // The on-demand server jobs the launcher registers on macOS (one per port).
  const agents = path.join(home, 'Library', 'LaunchAgents');
  if (process.platform === 'darwin' && fs.existsSync(agents)) {
    for (const f of fs.readdirSync(agents).filter((n) => /^local\.latex-editor\.server\.\d+\.plist$/.test(n))) {
      spawnSync('launchctl', ['bootout', `gui/${process.getuid()}/${f.replace(/\.plist$/, '')}`], { stdio: 'ignore' });
      remove(path.join(agents, f));
    }
  }
  remove(macApp);
  remove(legacyMacApp);
  remove(desktopFile);
  remove(cliPath);
  log('Done. (Your projects and ~/.config/latex-editor are left alone.)');
} else {
  log("Installing the Mike's launcher…");
  if (process.platform === 'darwin') installMac();
  else if (process.platform === 'linux') installLinux();
  else log(`  no desktop launcher for ${process.platform}; use the terminal command`);
  writeCli();
  log('Done. The first launch builds the editor, which takes a few seconds.');
}
