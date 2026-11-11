#!/usr/bin/env node
// Builds the TeX Live that the desktop app bundles (build/texlive, read-only inside the app).
//
//   node scripts/build-tex.mjs                       # fresh install from CTAN (needs Perl)
//   node scripts/build-tex.mjs --from /usr/local/texlive/2026basic   # start from an existing TeX Live
//   options: --platforms darwin,linux   binaries to include (default: this machine's)
//            --packages minimal|papers  what to install on top of scheme-basic (default: papers)
//            --out DIR                  (default: build/texlive)
//
// The result is a portable TeX Live: no documentation or sources, formats prebuilt, and nothing
// pointing outside the folder. Packages users add later go to the app's user layer, not here.
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2);
const opt = (name, def) => { const i = args.indexOf(`--${name}`); return i >= 0 ? args[i + 1] : def; };
const out = path.resolve(opt('out', path.join(root, 'build', 'texlive')));
const from = opt('from', null);
const platforms = opt('platforms', process.platform).split(',');
const preset = opt('packages', 'papers');
const REPO = process.env.TEXLIVE_REPOSITORY ?? 'https://mirror.ctan.org/systems/texlive/tlnet';

const BIN = {
  darwin: 'universal-darwin',
  linux: os.arch() === 'arm64' && platforms.length === 1 ? 'aarch64-linux' : 'x86_64-linux',
  'linux-x64': 'x86_64-linux',
  'linux-arm64': 'aarch64-linux',
};
const binDirs = platforms.map((p) => BIN[p] ?? (() => { throw new Error(`unknown platform ${p}`); })());
const hostBin = process.platform === 'darwin' ? 'universal-darwin' : os.arch() === 'arm64' ? 'aarch64-linux' : 'x86_64-linux';

// On top of scheme-basic: what typical papers need, so most compile without installing anything.
const PACKAGES = {
  minimal: ['latexmk', 'synctex', 'latexdiff'],
  papers: [
    'latexmk', 'synctex', 'latexdiff',
    'collection-latexrecommended', 'collection-fontsrecommended',
    // publisher classes
    'ieeetran', 'acmart', 'elsarticle', 'llncs', 'revtex',
    // bibliographies
    'natbib', 'cite', 'biblatex', 'biber', 'csquotes', 'doi', 'url',
    // floats, tables, figures
    'booktabs', 'multirow', 'makecell', 'threeparttable', 'subfig', 'capt-of', 'placeins', 'wrapfig',
    'adjustbox', 'collectbox', 'pdfpages', 'pgf', 'pgfplots', 'float', 'sttools', 'preprint',
    // algorithms and math
    'algorithms', 'algorithmicx', 'algorithm2e', 'algpseudocodex', 'siunitx', 'cleveref', 'mathtools', 'esint', 'bbm', 'bbm-macros', 'doublestroke',
    // review and writing
    'changes', 'todonotes', 'soul', 'comment', 'lipsum', 'mwe', 'enumitem', 'xstring', 'etoolbox', 'orcidlink',
    // fonts used by publisher templates
    'newtx', 'txfonts', 'libertine', 'inconsolata', 'newtxsf', 'fontaxes', 'mweights', 'xkeyval',
  ],
};

const log = (m) => console.log(`[tex] ${m}`);
function sh(cmd, cmdArgs, extra = {}) {
  log(`${path.basename(cmd)} ${cmdArgs.join(' ')}`);
  const r = spawnSync(cmd, cmdArgs, { stdio: 'inherit', ...extra });
  if (r.status !== 0) throw new Error(`${cmd} failed (${r.status})`);
}

// Run the bundle's own programs only against the bundle.
function tlEnv() {
  const env = { ...process.env, PATH: `${path.join(out, 'bin', hostBin)}:/usr/bin:/bin:/usr/sbin:/sbin` };
  for (const v of ['TEXMFCNF', 'TEXMFHOME', 'TEXMFVAR', 'TEXMFCONFIG', 'TEXMFLOCAL', 'TEXMFSYSVAR', 'TEXMFSYSCONFIG']) delete env[v];
  env.TEXMFLOCAL = path.join(out, 'texmf-local');
  return env;
}
const tlmgr = (a, allowFail = false) => {
  log(`tlmgr ${a.join(' ')}`);
  const r = spawnSync(path.join(out, 'bin', hostBin, 'tlmgr'), a, { stdio: 'inherit', env: tlEnv() });
  if (r.status !== 0 && !allowFail) throw new Error(`tlmgr ${a[0]} failed`);
  return r.status;
};

function installFresh() {
  const work = fs.mkdtempSync(path.join(os.tmpdir(), 'latex-editor-tl-'));
  sh('curl', ['-fL', '--retry', '3', '-o', path.join(work, 'install-tl-unx.tar.gz'), `${REPO}/install-tl-unx.tar.gz`]);
  sh('tar', ['-xzf', 'install-tl-unx.tar.gz'], { cwd: work });
  const dir = fs.readdirSync(work).find((d) => d.startsWith('install-tl-'));
  const profile = path.join(work, 'texlive.profile');
  fs.writeFileSync(profile, [
    'selected_scheme scheme-basic',
    `TEXDIR ${out}`,
    `TEXMFLOCAL ${out}/texmf-local`,
    `TEXMFSYSVAR ${out}/texmf-var`,
    `TEXMFSYSCONFIG ${out}/texmf-config`,
    `TEXMFVAR ${out}/texmf-var`,
    `TEXMFCONFIG ${out}/texmf-config`,
    `TEXMFHOME ${out}/texmf-local`,
    ...binDirs.map((b) => `binary_${b} 1`),
    `binary_${hostBin} 1`,
    'instopt_adjustpath 0',
    'instopt_adjustrepo 1',
    'instopt_letter 0',
    'instopt_portable 1',
    'instopt_write18_restricted 1',
    'tlpdbopt_autobackup 0',
    'tlpdbopt_install_docfiles 0',
    'tlpdbopt_install_srcfiles 0',
    'tlpdbopt_create_formats 1',
    'tlpdbopt_generate_updmap 0',
    '',
  ].join('\n'));
  sh('perl', [path.join(work, dir, 'install-tl'), '--profile', profile, '--repository', REPO, '--no-interaction'], { env: tlEnv() });
  fs.rmSync(work, { recursive: true, force: true });
}

function copyExisting() {
  if (!fs.existsSync(path.join(from, 'texmf-dist'))) throw new Error(`not a TeX Live folder: ${from}`);
  sh('rsync', ['-a', '--delete',
    '--exclude', '/texmf-dist/doc/', '--exclude', '/texmf-dist/source/', '--exclude', '/install-tl.log',
    '--exclude', '/tlpkg/backups/', '--exclude', '/texmf-var/luatex-cache/',
    `${from.replace(/\/$/, '')}/`, `${out}/`]);
  tlmgr(['option', 'docfiles', '0']);
  tlmgr(['option', 'srcfiles', '0']);
  tlmgr(['option', 'autobackup', '0']);
  tlmgr(['option', 'repository', REPO]);
  // The repository refuses older package managers.
  tlmgr(['update', '--self']);
  for (const b of binDirs) if (!fs.existsSync(path.join(out, 'bin', b))) tlmgr(['platform', 'add', b]);
}

fs.mkdirSync(out, { recursive: true });
if (from) copyExisting(); else { fs.rmSync(out, { recursive: true, force: true }); installFresh(); }
const list = PACKAGES[preset];
if (!list) throw new Error(`unknown --packages ${preset}`);
// One at a time would be slow; tlmgr skips names it doesn't know and reports them.
if (tlmgr(['install', ...list], true) !== 0) log('some packages could not be installed (see above); continuing');
// Leave nothing that points to this build machine or wastes space.
for (const p of ['texmf-dist/doc', 'texmf-dist/source', 'tlpkg/backups', 'install-tl.log', 'texmf-var/luatex-cache']) {
  fs.rmSync(path.join(out, p), { recursive: true, force: true });
}
fs.mkdirSync(path.join(out, 'texmf-local'), { recursive: true });
const size = spawnSync('du', ['-sh', out], { encoding: 'utf8' }).stdout.trim();
log(`done: ${size}`);
