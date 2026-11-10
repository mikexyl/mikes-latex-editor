import { EditorView } from '@codemirror/view';
import type { EditorState, Text } from '@codemirror/state';
import { api, ConflictError, type Project, type CompileResult, type Problem } from './api.ts';
import { editorExtensions, createState, goToLine, setModes, supportsVisual, type Modes } from './editor.ts';
import { ReviewPanel } from './review/panel.ts';
import { addComment, setCommentPrefs, type CommentPrefs } from './review/commands.ts';
import { compareField, setCompareBase } from './compare/diff.ts';
import { setAssetBase } from './visual/widgets.ts';
import { PdfViewer } from './pdf.ts';

const $ = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T;

const TEXT_EXT = /\.(tex|bib|sty|cls|bst|bbx|cbx|dtx|ins|cfg|def|txt|md|latexmkrc)$|(^|\/)(latexmkrc|Makefile)$/i;
const AUTOSAVE_MS = 1200;

type OpenFile = {
  path: string;
  state: EditorState; // up to date only while the file is not shown; the view owns the live state
  savedDoc: Text;
  mtime: number;
  saving: Promise<void>;
};

let project: Project;
let main = '';
const open = new Map<string, OpenFile>();
let current: OpenFile | null = null;
let autosaveTimer: number | undefined;

const extensions = editorExtensions({
  onChange: () => {
    renderDirty();
    review.schedule();
    scheduleCompareStats();
    clearTimeout(autosaveTimer);
    autosaveTimer = window.setTimeout(() => { if (current) save(current); }, AUTOSAVE_MS);
  },
  onSave: () => void saveAllAndCompile(),
  onFindInPdf: () => void findInPdf(),
});

const store = {
  get(k: string) { try { return localStorage.getItem(k); } catch { return null; } },
  set(k: string, v: string) { try { localStorage.setItem(k, v); } catch { /* storage unavailable */ } },
};

let visualMode = store.get('mode') !== 'source';
let tracking = false; // per project, restored in start()
let commentPrefs: CommentPrefs = { style: 'note', initials: '', macro: 'note' }; // per project
const modes = (): Modes => ({ visual: visualMode, tracking, noteMacro: commentPrefs.macro });

const view = new EditorView({ parent: $('editor'), state: createState('', '', extensions, { visual: false, tracking: false, noteMacro: 'note' }) });
const review = new ReviewPanel($('review'), view, (changes, comments) => {
  const badge = $('review-count');
  badge.textContent = String(changes + comments);
  badge.hidden = changes + comments === 0;
});
const mainDir = () => (main.includes('/') ? main.slice(0, main.lastIndexOf('/')) : '');

// Chips for \input / \include open the file on Cmd/Ctrl+click. Like LaTeX, paths are relative to
// the main file's folder.
$('editor').addEventListener('vc-open-file', (e) => {
  const rel = (e as CustomEvent<string>).detail;
  const candidates = [mainDir() ? `${mainDir()}/${rel}` : rel, rel];
  const path = candidates.find((p) => project.tree.some((x) => x.path === p));
  if (path) void openFile(path);
  else setStatus(`File not found: ${rel}`, true);
});
view.contentDOM.setAttribute('aria-label', 'LaTeX source');
const pdf = new PdfViewer($('pdf'));
pdf.clear('Compile to see the PDF.');

// ---------- files ----------

const liveState = (f: OpenFile) => (f === current ? view.state : f.state);
const isDirty = (f: OpenFile) => !liveState(f).doc.eq(f.savedDoc);

async function openFile(path: string): Promise<OpenFile> {
  let f = open.get(path);
  if (!f) {
    const { content, mtime } = await api.read(path);
    const state = createState(path, content, extensions, modes());
    f = { path, state, savedDoc: state.doc, mtime, saving: Promise.resolve() };
    open.set(path, f);
  }
  if (current !== f) {
    if (current) current.state = view.state;
    current = f;
    view.setState(f.state);
    setModes(view, f.path, modes()); // the file may have been opened under other modes
  }
  renderModeToggle();
  review.render();
  void applyCompareBase(f);
  $('current-file').textContent = path;
  renderTree();
  view.focus();
  return f;
}

/** Saves one file. Saves of the same file are serialized so mtimes stay consistent. */
function save(f: OpenFile, opts: { force?: boolean } = {}): Promise<void> {
  f.saving = f.saving.then(async () => {
    if (!opts.force && !isDirty(f)) return;
    const doc = liveState(f).doc;
    try {
      const { mtime } = await api.write(f.path, doc.toString(), opts.force ? undefined : f.mtime);
      f.mtime = mtime;
      f.savedDoc = doc;
      if (conflictPath === f.path) hideConflict();
    } catch (e) {
      if (e instanceof ConflictError) showConflict(f);
      else setStatus(`Save failed: ${(e as Error).message}`, true);
      throw e;
    } finally {
      renderDirty();
    }
  });
  return f.saving.catch(() => {});
}

async function saveAll(): Promise<boolean> {
  clearTimeout(autosaveTimer);
  await Promise.all([...open.values()].map((f) => save(f)));
  return [...open.values()].every((f) => !isDirty(f));
}

/** Pick up edits made outside the editor (git, another editor) for files with no unsaved changes. */
async function refreshFromDisk() {
  for (const f of open.values()) {
    if (isDirty(f)) continue;
    try {
      const { content, mtime } = await api.read(f.path);
      if (mtime === f.mtime) continue;
      f.mtime = mtime;
      if (content === liveState(f).doc.toString()) continue;
      replaceContent(f, content);
    } catch {
      /* file may have been deleted; leave the buffer as is */
    }
  }
}

function replaceContent(f: OpenFile, content: string) {
  if (f === current) {
    view.dispatch({ changes: { from: 0, to: view.state.doc.length, insert: content } });
    f.savedDoc = view.state.doc;
  } else {
    f.state = f.state.update({ changes: { from: 0, to: f.state.doc.length, insert: content } }).state;
    f.savedDoc = f.state.doc;
  }
  renderDirty();
}

// ---------- conflict banner ----------

let conflictPath: string | null = null;

function showConflict(f: OpenFile) {
  conflictPath = f.path;
  $('conflict-text').textContent = `${f.path} was changed on disk by something else. Your edits are not saved yet.`;
  $('conflict').hidden = false;
}
function hideConflict() {
  conflictPath = null;
  $('conflict').hidden = true;
}
$('conflict-reload').onclick = async () => {
  const f = conflictPath && open.get(conflictPath);
  if (!f) return hideConflict();
  const { content, mtime } = await api.read(f.path);
  f.mtime = mtime;
  replaceContent(f, content);
  hideConflict();
};
$('conflict-overwrite').onclick = async () => {
  const f = conflictPath && open.get(conflictPath);
  if (!f) return hideConflict();
  await save(f, { force: true });
};

// ---------- compile ----------

let compiling = false;

async function saveAllAndCompile() {
  if (!main || compiling) return;
  compiling = true;
  const btn = $<HTMLButtonElement>('compile-btn');
  btn.disabled = true;
  setStatus('Saving…');
  try {
    if (!(await saveAll())) {
      setStatus('Not compiled: some files could not be saved.', true);
      return;
    }
    setStatus('Compiling…');
    const result = await api.compile(main);
    renderProblems(result);
    // While comparing, show the marked-up diff PDF when latexdiff is available.
    const showedDiff = compareRev && result.pdf ? await showDiffPdf() : false;
    if (showedDiff) { /* diff PDF is shown */ }
    else if (result.pdf) await showNormalPdf();
    else pdf.clear('No PDF was produced. See the problems below.');
    const errors = result.problems.filter((p) => p.level === 'error').length;
    const warnings = result.problems.length - errors;
    setStatus(
      `${result.ok ? 'Compiled' : 'Compiled with errors'} in ${(result.durationMs / 1000).toFixed(1)}s` +
        (errors ? ` · ${errors} error${errors > 1 ? 's' : ''}` : '') +
        (warnings ? ` · ${warnings} warning${warnings > 1 ? 's' : ''}` : '') +
        (showedDiff ? ' · diff PDF updated' : ''),
      !result.ok,
    );
  } catch (e) {
    setStatus(`Compile failed: ${(e as Error).message}`, true);
  } finally {
    compiling = false;
    btn.disabled = false;
  }
}

$('compile-btn').onclick = () => void saveAllAndCompile();

// ---------- SyncTeX: source <-> PDF ----------

let showingDiffPdf = false;

async function showNormalPdf() {
  await pdf.load(api.pdfUrl(main));
  showingDiffPdf = false;
  $('pdf-title').textContent = 'PDF';
}

async function findInPdf() {
  if (!current || !main) return;
  if (showingDiffPdf) {
    setStatus('Find in PDF uses the normal PDF. Stop comparing first.', true);
    return;
  }
  const line = view.state.doc.lineAt(view.state.selection.main.head).number;
  try {
    const { boxes } = await api.syncForward(main, current.path, line);
    if (boxes.length) pdf.showBoxes(boxes);
    else setStatus('No PDF location for this line. Compile first, or the line produces no output.', true);
  } catch (e) {
    setStatus(`Find in PDF failed: ${(e as Error).message}`, true);
  }
}

pdf.onDoubleClick = async (page, x, y) => {
  if (!main || showingDiffPdf) return;
  const hit = await api.syncBackward(main, page, x, y).catch(() => null);
  if (!hit?.file || !hit.line) return setStatus('No source location found there.', true);
  if (!project.tree.some((e) => e.path === hit.file)) return setStatus(`Source is outside the project: ${hit.file}`, true);
  await openFile(hit.file);
  goToLine(view, hit.line);
};

$('find-in-pdf').onclick = () => void findInPdf();

// ---------- compare with a git commit ----------

let compareRev: string | null = null;
let latexdiffAvailable: boolean | null = null; // unknown until the first try
let commits: { hash: string; short: string; date: string; subject: string }[] = [];

async function loadGitLog() {
  const select = $<HTMLSelectElement>('compare-select');
  try {
    const log = await api.gitLog();
    commits = log.commits;
    if (!log.repo) {
      select.replaceChildren(new Option('not a git repository', ''));
      select.disabled = true;
      return;
    }
    const keep = select.value;
    select.replaceChildren(
      new Option('—', ''),
      ...commits.map((c, i) => new Option(`${i === 0 ? 'Last commit · ' : ''}${c.short} · ${c.date} · ${c.subject.slice(0, 48)}`, c.hash)),
    );
    select.disabled = commits.length === 0;
    select.value = commits.some((c) => c.hash === keep) ? keep : compareRev ?? '';
  } catch {
    select.disabled = true;
  }
}

async function applyCompareBase(f: OpenFile) {
  if (!compareRev) {
    if (view.state.field(compareField).base !== null) view.dispatch({ effects: setCompareBase.of(null) });
    return;
  }
  const rev = compareRev;
  const old = await api.gitShow(rev, f.path).catch(() => null);
  if (current !== f || compareRev !== rev) return; // switched meanwhile
  view.dispatch({ effects: setCompareBase.of(old?.content ?? '') });
  renderCompareBanner(!!old && !old.exists);
}

let statsTimer: number | undefined;
function scheduleCompareStats() {
  if (!compareRev) return;
  clearTimeout(statsTimer);
  statsTimer = window.setTimeout(() => renderCompareBanner(false), 500);
}

function renderCompareBanner(newFile: boolean) {
  const banner = $('compare-banner');
  if (!compareRev) { banner.hidden = true; return; }
  const c = commits.find((x) => x.hash === compareRev);
  const { insertions, deletions } = view.state.field(compareField).stats;
  const what = newFile ? 'this file is new since then' : `${insertions} insertion${insertions === 1 ? '' : 's'}, ${deletions} deletion${deletions === 1 ? '' : 's'} in this file`;
  $('compare-text').textContent = `Changes since ${c ? `${c.short} (${c.date})` : compareRev.slice(0, 8)}: ${what}`;
  banner.hidden = false;
}

/** Build and show the latexdiff PDF; false if it isn't available or failed. */
async function showDiffPdf(): Promise<boolean> {
  if (!compareRev || !main || latexdiffAvailable === false) return false;
  setStatus('Building diff PDF…');
  try {
    const r = await api.diff(main, compareRev);
    latexdiffAvailable = r.available;
    if (r.pdf && r.available) {
      await pdf.load(api.diffPdfUrl(main));
      showingDiffPdf = true;
      $('pdf-title').textContent = 'PDF · changes';
      setStatus(`Diff PDF built in ${(r.durationMs / 1000).toFixed(1)}s`);
      return true;
    }
    const firstError = r.problems.find((p) => p.level === 'error')?.message;
    setStatus(r.message ?? `Diff PDF failed${firstError ? `: ${firstError}` : ''}`, true);
  } catch (e) {
    setStatus(`Diff PDF failed: ${(e as Error).message}`, true);
  }
  return false;
}

async function startCompare(rev: string) {
  compareRev = rev;
  if (current) await applyCompareBase(current);
  if (!(await showDiffPdf()) && showingDiffPdf) await showNormalPdf();
}

async function stopCompare() {
  compareRev = null;
  $<HTMLSelectElement>('compare-select').value = '';
  $('compare-banner').hidden = true;
  if (view.state.field(compareField).base !== null) view.dispatch({ effects: setCompareBase.of(null) });
  if (showingDiffPdf) await showNormalPdf().catch(() => pdf.clear('Compile to see the PDF.'));
}

$('compare-select').onchange = () => {
  const rev = $<HTMLSelectElement>('compare-select').value;
  void (rev ? startCompare(rev) : stopCompare());
  view.focus(); // keep keyboard shortcuts working
};
$('compare-exit').onclick = () => { void stopCompare(); view.focus(); };

// ---------- rendering ----------

function setStatus(text: string, error = false) {
  const s = $('status');
  s.textContent = text;
  s.classList.toggle('error', error);
}

function renderTree() {
  const nav = $('files');
  nav.replaceChildren(
    ...project.tree.map((e) => {
      const depth = e.path.split('/').length - 1;
      const name = e.path.split('/').pop()!;
      const el = document.createElement('button');
      el.className = 'item';
      el.style.paddingLeft = `${10 + depth * 14}px`;
      el.dataset.path = e.path;
      el.textContent = e.type === 'dir' ? `${name}/` : name;
      if (e.type === 'dir') {
        el.classList.add('dir');
        el.tabIndex = -1;
      } else if (!TEXT_EXT.test(e.path)) {
        el.classList.add('binary');
        el.title = 'Not a text file';
        el.tabIndex = -1;
      } else {
        el.onclick = () => void openFile(e.path);
        if (current?.path === e.path) el.classList.add('active');
      }
      return el;
    }),
  );
  renderDirty();
}

function renderDirty() {
  for (const el of $('files').querySelectorAll<HTMLElement>('.item[data-path]')) {
    const f = open.get(el.dataset.path!);
    const dirty = !!f && isDirty(f);
    let mark = el.querySelector('.dirty');
    if (dirty && !mark) {
      mark = document.createElement('span');
      mark.className = 'dirty';
      mark.textContent = '●';
      mark.setAttribute('aria-label', 'unsaved');
      el.append(mark);
    } else if (!dirty && mark) mark.remove();
  }
  const name = current ? current.path + (isDirty(current) ? ' ●' : '') : 'No file open';
  $('current-file').textContent = name;
  document.title = `${current ? current.path + ' — ' : ''}${project?.name ?? 'LaTeX Editor'}`;
}

function renderProblems(result: CompileResult) {
  const box = $('problems');
  const list = $('problems-list');
  $('raw-log').textContent = result.output;
  // Errors first; cap the list so a runaway log does not flood the UI.
  const problems = [...result.problems].sort((a, b) => Number(a.level === 'warning') - Number(b.level === 'warning')).slice(0, 200);
  list.replaceChildren(...problems.map(problemRow));
  const errors = result.problems.filter((p) => p.level === 'error').length;
  $('problems-summary').textContent = result.problems.length
    ? `${errors} error${errors === 1 ? '' : 's'}, ${result.problems.length - errors} warning${result.problems.length - errors === 1 ? '' : 's'}`
    : 'No problems';
  box.hidden = result.problems.length === 0 && result.ok;
}

function problemRow(p: Problem) {
  const li = document.createElement('li');
  const icon = document.createElement('span');
  icon.className = `icon ${p.level}`;
  icon.textContent = p.level === 'error' ? '✕' : '!';
  const loc = document.createElement('span');
  loc.className = 'loc';
  loc.textContent = p.file ? `${p.file}:${p.line ?? ''}` : p.line ? `line ${p.line}` : '';
  const msg = document.createElement('span');
  msg.textContent = p.message;
  li.append(icon, loc, msg);
  if (p.file && TEXT_EXT.test(p.file) && project.tree.some((e) => e.path === p.file)) {
    li.onclick = async () => {
      await openFile(p.file!);
      if (p.line) goToLine(view, p.line);
    };
  } else li.classList.add('no-jump');
  return li;
}

$('log-toggle').onclick = () => { $('raw-log').hidden = !$('raw-log').hidden; };
$('zoom-in').onclick = () => pdf.zoomIn();
$('zoom-out').onclick = () => pdf.zoomOut();
$('zoom-fit').onclick = () => pdf.fit();

// ---------- source / visual mode ----------

function renderModeToggle() {
  const enabled = !!current && supportsVisual(current.path);
  const track = $<HTMLButtonElement>('track-toggle');
  track.setAttribute('aria-pressed', String(tracking));
  track.disabled = !enabled;
  $<HTMLButtonElement>('comment-btn').disabled = !enabled;
  $('editor').classList.toggle('tracking', tracking && enabled);
  for (const b of $('mode-toggle').querySelectorAll<HTMLButtonElement>('button')) {
    const active = enabled ? (b.dataset.mode === 'visual') === visualMode : b.dataset.mode === 'source';
    b.setAttribute('aria-pressed', String(active));
    b.disabled = !enabled;
  }
}

$('mode-toggle').addEventListener('click', (e) => {
  const mode = (e.target as HTMLElement).closest('button')?.dataset.mode;
  if (!mode || !current) return;
  visualMode = mode === 'visual';
  store.set('mode', mode);
  setModes(view, current.path, modes());
  renderModeToggle();
  view.focus();
});

// ---------- review: track changes, comments, panel ----------

$('track-toggle').onclick = () => {
  if (!current) return;
  tracking = !tracking;
  store.set(`track:${project.root}`, tracking ? '1' : '0');
  setModes(view, current.path, modes());
  renderModeToggle();
  setStatus(tracking ? 'Track changes on: edits are recorded as \\added / \\deleted.' : 'Track changes off.');
  view.focus();
};
$('comment-btn').onclick = () => { addComment(view); };
$('review-toggle').onclick = () => {
  const panel = $('review');
  panel.hidden = !panel.hidden;
  $('review-toggle').setAttribute('aria-pressed', String(!panel.hidden));
  store.set('review-panel', panel.hidden ? '0' : '1');
  review.render();
};
if (store.get('review-panel') === '1') {
  $('review').hidden = false;
  $('review-toggle').setAttribute('aria-pressed', 'true');
}
function applyCommentPrefs(p: CommentPrefs) {
  const macroChanged = p.macro !== commentPrefs.macro;
  commentPrefs = p;
  store.set(`comment-prefs:${project.root}`, JSON.stringify(p));
  setCommentPrefs(p, applyCommentPrefs);
  review.setPrefs(p);
  $('comment-btn').title = p.style === 'note'
    ? `Add a note \\${p.macro}{${p.initials || 'initials'}}{…} (⌘⌥M / Ctrl+Alt+M)`
    : 'Comment on the selection (⌘⌥M / Ctrl+Alt+M)';
  if (macroChanged && current) setModes(view, current.path, modes());
  review.render();
}
review.onPrefsChange = applyCommentPrefs;

window.addEventListener('review-notice', (e) => setStatus((e as CustomEvent<string>).detail, true));

// ---------- layout: draggable splitter ----------

{
  const layout = $('layout');
  const splitter = $('splitter');
  const saved = store.get('pdf-width');
  if (saved) layout.style.setProperty('--pdf-w', saved);
  splitter.addEventListener('pointerdown', (e) => {
    splitter.setPointerCapture(e.pointerId);
    splitter.classList.add('dragging');
    const move = (ev: PointerEvent) => {
      const rect = layout.getBoundingClientRect();
      const px = Math.min(rect.width - 500, Math.max(250, rect.right - ev.clientX));
      layout.style.setProperty('--pdf-w', `${px}px`);
    };
    const up = () => {
      splitter.classList.remove('dragging');
      splitter.removeEventListener('pointermove', move);
      store.set('pdf-width', layout.style.getPropertyValue('--pdf-w'));
    };
    splitter.addEventListener('pointermove', move);
    splitter.addEventListener('pointerup', up, { once: true });
  });
}

// ---------- startup ----------

window.addEventListener('focus', () => { void refreshFromDisk(); void loadGitLog(); });
window.addEventListener('beforeunload', (e) => {
  if ([...open.values()].some(isDirty)) {
    void saveAll();
    e.preventDefault();
  }
});

async function start() {
  project = await api.project();
  $('project-name').textContent = project.name;
  $('project-name').title = project.root;

  const select = $<HTMLSelectElement>('main-select');
  select.replaceChildren(...project.mains.map((m) => new Option(m, m)));
  const remembered = store.get(`main:${project.root}`);
  main = remembered && project.mains.includes(remembered) ? remembered : project.mains[0] ?? '';
  setAssetBase(mainDir());
  select.value = main;
  select.onchange = () => {
    main = select.value;
    setAssetBase(mainDir());
    store.set(`main:${project.root}`, main);
    void saveAllAndCompile();
  };
  $<HTMLButtonElement>('compile-btn').disabled = !main;
  tracking = store.get(`track:${project.root}`) === '1';
  try {
    const saved = JSON.parse(store.get(`comment-prefs:${project.root}`) ?? 'null');
    if (saved) commentPrefs = { ...commentPrefs, ...saved };
  } catch { /* ignore bad saved prefs */ }
  applyCommentPrefs(commentPrefs);

  renderTree();
  void loadGitLog();
  const first = main || project.tree.find((e) => e.type === 'file' && TEXT_EXT.test(e.path))?.path;
  if (first) await openFile(first);
  if (main) await saveAllAndCompile();
  else setStatus('No .tex file with \\documentclass found in this folder.', true);
}

start().catch((e) => setStatus(`Failed to load project: ${(e as Error).message}`, true));
