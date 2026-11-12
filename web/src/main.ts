import { EditorView } from '@codemirror/view';
import type { EditorState, Text, TransactionSpec } from '@codemirror/state';
import { ensureSyntaxTree } from '@codemirror/language';
import { initProjectPicker } from './projects.ts';
import { initSettings } from './settings.ts';
import { initTex, installProviding, texStatus } from './tex.ts';
import { api, setProjectRoot, ConflictError, type Project, type CompileResult, type Problem } from './api.ts';
import { editorExtensions, createState, goToLine, setModes, supportsVisual, type Modes } from './editor.ts';
import { ReviewPanel, type ReviewSource } from './review/panel.ts';
import { findIncludes } from './review/model.ts';
import { addComment, setCommentPrefs, type CommentPrefs } from './review/commands.ts';
import { compareField, setCompareBase } from './compare/diff.ts';
import { setAssetBase } from './visual/widgets.ts';
import { setIncludeHost, includeHeights } from './visual/includes.ts';
import { collectMacros, setProjectMacros } from './visual/math.ts';
import { refreshVisual } from './visual/decorations.ts';
import { PdfViewer } from './pdf.ts';
import { FileViewer, VIEWABLE } from './viewer.ts';

const $ = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T;

const TEXT_EXT = /\.(tex|bib|sty|cls|bst|bbx|cbx|dtx|ins|cfg|def|txt|md|latexmkrc)$|(^|\/)(latexmkrc|Makefile)$/i;
const AUTOSAVE_MS = 1200;

type OpenFile = {
  path: string;
  state: EditorState; // up to date only while the file is not shown; the view owns the live state
  savedDoc: Text;
  mtime: number;
  saving: Promise<void>;
  /** Document position at the top of the view when the file was last left (restored later). */
  scroll?: number;
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
    scheduleAutosave();
    view.requestMeasure(); // an inline included file may have changed height
  },
  onSave: () => void saveAllAndCompile(),
  onFindInPdf: () => void findInPdf(),
});

function scheduleAutosave() {
  clearTimeout(autosaveTimer);
  // All open files, not just the current one: included files are edited inline too.
  autosaveTimer = window.setTimeout(() => { void saveAll().then(() => refreshProjectMacros()); }, AUTOSAVE_MS);
}

const store = {
  get(k: string) { try { return localStorage.getItem(k); } catch { return null; } },
  set(k: string, v: string) { try { localStorage.setItem(k, v); } catch { /* storage unavailable */ } },
};

let visualMode = store.get('mode') !== 'source';
let tracking = false; // per project, restored in start()
// Per project. \revnote, not \note: beamer, seminar and others define \note.
const DEFAULT_NOTE_MACRO = 'revnote';
let commentPrefs: CommentPrefs = { style: 'note', initials: '', macro: DEFAULT_NOTE_MACRO };
const modes = (): Modes => ({ visual: visualMode, tracking, noteMacro: commentPrefs.macro });

const view = new EditorView({ parent: $('editor'), state: createState('', '', extensions, { visual: false, tracking: false, noteMacro: 'note' }) });
const review = new ReviewPanel($('review'), () => reviewSources(), (changes, comments) => {
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
  if (path) { ensureEditorVisible(); void openFile(path); }
  else setStatus(`File not found: ${rel}`, true);
});
view.contentDOM.setAttribute('aria-label', 'LaTeX source');
const pdf = new PdfViewer($('pdf'));
// Figures (images, PDFs) open in the editor pane, over the editor.
const viewer = new FileViewer(() => hideViewer());
function showViewer(path: string) {
  ensureEditorVisible();
  void viewer.show(path);
  $('editor-pane').classList.add('viewing');
  $('current-file').textContent = path;
  renderTree();
}
function hideViewer() {
  if (!viewer.path) return;
  viewer.hide();
  $('editor-pane').classList.remove('viewing');
  $('current-file').textContent = current?.path ?? 'No file open';
  renderTree();
  (activeEditor()?.v ?? view).focus();
}
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape' && viewer.path && !(e.target as HTMLElement).closest('dialog, input, textarea, .settings-popover')) hideViewer();
});
pdf.clear('Compile to see the PDF.');

// ---------- files ----------

/** Nested editors for \input files shown inline in visual mode (path -> view), attached or not. */
const nested = new Map<string, EditorView>();
/** Their DOM (header + editor), kept when scrolled out of view and reattached when back. */
const pool = new Map<string, HTMLElement>();
/** Inline editors currently on the page. */
const attached = new Set<string>();
/** The \input argument each inline file was mounted for (the key of its remembered height). */
const includeRel = new Map<string, string>();

/** Remember an inline file's on-page height, so it comes back at that size (no layout shift). */
function rememberIncludeHeight(path: string) {
  const box = pool.get(path)?.closest('.vc-include');
  const rel = includeRel.get(path);
  if (box && rel) includeHeights.set(rel, box.getBoundingClientRect().height);
}

/** Drop all inline editors (the main file changed), keeping their state in the open files. */
function disposeInline() {
  for (const path of attached) rememberIncludeHeight(path);
  for (const [path, v] of nested) {
    const f = open.get(path);
    if (f) f.state = v.state;
    v.destroy();
  }
  nested.clear();
  pool.clear();
  attached.clear();
}

const liveState = (f: OpenFile) => (f === current ? view.state : nested.get(f.path)?.state ?? f.state);
const isDirty = (f: OpenFile) => !liveState(f).doc.eq(f.savedDoc);

/** Load a file into the open-files map (without showing it). */
async function loadFile(path: string): Promise<OpenFile> {
  let f = open.get(path);
  if (!f) {
    const { content, mtime } = await api.read(path);
    f = open.get(path); // loaded meanwhile?
    if (!f) {
      const state = createState(path, content, extensions, modes());
      f = { path, state, savedDoc: state.doc, mtime, saving: Promise.resolve() };
      open.set(path, f);
    }
  }
  return f;
}

async function openFile(path: string): Promise<OpenFile> {
  hideViewer();
  const f = await loadFile(path);
  if (current !== f) {
    if (current) {
      current.state = view.state;
      current.scroll = topVisiblePos();
    }
    // Inline editors belong to the page being left; their state (and history) goes back to the
    // open files, so the file being opened here starts from its latest content.
    disposeInline();
    current = f;
    view.setState(f.state);
    setModes(view, f.path, modes()); // the file may have been opened under other modes
    // Back where you left it: put the line that was at the top back at the top. A document
    // position (not a pixel offset) stays right while heights settle. Without taking focus: a
    // focused editor keeps the browser's caret in sync with the selection, which (for a file you
    // only scrolled) is still at the end and would pull the view down there.
    if (f.scroll !== undefined) {
      view.dispatch({ effects: EditorView.scrollIntoView(Math.min(f.scroll, view.state.doc.length), { y: 'start' }) });
    }
  }
  renderBackToMain();
  revealInTree(path);
  renderModeToggle();
  review.render();
  void applyCompareBase(f);
  $('current-file').textContent = path;
  renderTree();
  if (f.scroll === undefined) view.focus(); // (see above: restoring a scroll position must not take focus)
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

/** The one change that turns `old` into `next`: only the differing middle, so the cursor and scroll
 *  position outside it stay where they were. */
function minimalChange(old: string, next: string) {
  const max = Math.min(old.length, next.length);
  let a = 0;
  while (a < max && old.charCodeAt(a) === next.charCodeAt(a)) a++;
  let b = 0;
  while (b < max - a && old.charCodeAt(old.length - 1 - b) === next.charCodeAt(next.length - 1 - b)) b++;
  return { from: a, to: old.length - b, insert: next.slice(a, next.length - b) };
}

function replaceContent(f: OpenFile, content: string) {
  const live = f === current ? view : nested.get(f.path);
  if (live) {
    live.dispatch({ changes: minimalChange(live.state.doc.toString(), content) });
    f.savedDoc = live.state.doc;
  } else {
    f.state = f.state.update({ changes: minimalChange(f.state.doc.toString(), content) }).state;
    f.savedDoc = f.state.doc;
  }
  renderDirty();
}

/**
 * ↻ Reload: re-read every open file and the file tree from disk. Files with unsaved edits are only
 * reloaded if the user agrees to discard those edits.
 */
async function reloadFromDisk() {
  clearTimeout(autosaveTimer); // don't save over what's about to be read
  const dirty = [...open.values()].filter(isDirty);
  const discard = dirty.length > 0 && confirm(
    `Unsaved edits in ${dirty.map((f) => f.path).join(', ')}.\n\n` +
    'OK: discard them and reload everything from disk.\nCancel: keep them, reload the other files only.');
  let changed = 0;
  for (const f of open.values()) {
    if (isDirty(f) && !discard) continue;
    try {
      const { content, mtime } = await api.read(f.path);
      f.mtime = mtime;
      if (content !== liveState(f).doc.toString()) { replaceContent(f, content); changed++; }
      else if (isDirty(f)) { f.savedDoc = liveState(f).doc; renderDirty(); }
      if (conflictPath === f.path) hideConflict();
    } catch {
      /* deleted on disk: keep the buffer */
    }
  }
  try {
    project.tree = (await api.project()).tree; // files added or removed outside
    renderTree();
  } catch { /* keep the old tree */ }
  void refreshProjectMacros();
  void viewer.reload(); // a figure being viewed may have been regenerated
  const kept = discard ? 0 : dirty.length;
  setStatus(`${changed ? `Reloaded ${changed} file${changed === 1 ? '' : 's'} from disk.` : 'Up to date with the disk.'}` +
    (kept ? ` Kept unsaved edits in ${kept} file${kept === 1 ? '' : 's'}.` : ''));
  (activeEditor()?.v ?? view).focus();
}
$('reload-btn').onmousedown = (e) => e.preventDefault(); // keep the editor's focus and cursor
$('reload-btn').onclick = () => void reloadFromDisk();

/** The document position shown at the top of the editor (read from the screen). */
function topVisiblePos(): number | undefined {
  if (view.scrollDOM.scrollTop < 4) return undefined; // at the top: nothing to restore
  const r = view.scrollDOM.getBoundingClientRect();
  const c = view.contentDOM.getBoundingClientRect();
  return view.posAtCoords({ x: c.left + 8, y: r.top + 4 }, false) ?? undefined;
}

// ---------- back to the root file ----------

/** In a file other than the root (main) document, offer a one-click way back to it. */
function renderBackToMain() {
  const b = $<HTMLButtonElement>('back-to-main');
  const show = !!main && !!current && current.path !== main;
  b.hidden = !show;
  if (show) {
    b.textContent = `↩ ${main.split('/').pop()}`;
    b.title = `Back to the root file, ${main}`;
  }
}
$('back-to-main').onclick = () => { ensureEditorVisible(); void openFile(main); };

// ---------- \input files inline ----------

/** Resolve an \input path like LaTeX does: relative to the main file's folder. */
function resolveInclude(rel: string): string | null {
  const candidates = [mainDir() ? `${mainDir()}/${rel}` : rel, rel];
  return candidates.find((p) => project.tree.some((x) => x.path === p)) ?? null;
}

setIncludeHost({
  async mount(el, rel) {
    const message = (text: string) => { el.textContent = text; el.classList.add('vc-include-message'); return () => {}; };
    const path = resolveInclude(rel);
    if (!path) return message(`File not found: ${rel}`);
    // No cycles, and each file inline only once (a second \input of it just shows the chip).
    const ancestors = new Set<string>(current ? [current.path] : []);
    for (let p = el.parentElement; p; p = p.parentElement) if (p.dataset.includePath) ancestors.add(p.dataset.includePath);
    if (ancestors.has(path) || attached.has(path)) return message(`${rel} is already shown above.`);

    includeRel.set(path, rel);
    const unmount = () => {
      const wrapper = pool.get(path);
      if (wrapper?.isConnected) rememberIncludeHeight(path);
      wrapper?.remove(); // kept alive in the pool; reattached when scrolled back into view
      attached.delete(path);
    };
    const reattach = () => {
      el.textContent = '';
      el.dataset.includePath = path;
      el.append(pool.get(path)!);
      attached.add(path);
      nested.get(path)?.requestMeasure();
      view.requestMeasure();
      return unmount;
    };
    if (pool.has(path)) return reattach();

    let f: OpenFile;
    try { f = await loadFile(path); } catch (e) { return message(`Couldn't load ${rel}: ${(e as Error).message}`); }
    if (!el.isConnected) return () => {};
    if (pool.has(path)) return reattach(); // created meanwhile
    const wrapper = document.createElement('div');
    wrapper.className = 'vc-include-wrapper';
    const header = document.createElement('div');
    header.className = 'vc-include-header';
    const name = document.createElement('span');
    name.textContent = path;
    const openBtn = document.createElement('button');
    openBtn.className = 'link';
    openBtn.textContent = 'Open file';
    openBtn.onclick = () => void openFile(path);
    header.append(name, openBtn);
    wrapper.append(header);
    const v = new EditorView({ parent: wrapper, state: f.state });
    // Draw the whole file, not just the part CodeMirror thinks is on screen: inside the outer
    // editor that guess lags behind, leaving blank stretches and changing heights (scroll jumps).
    // This is CodeMirror's print mode; section files are small enough for it to be cheap.
    (v as unknown as { viewState: { printing: boolean } }).viewState.printing = true;
    setModes(v, path, modes());
    nested.set(path, v);
    pool.set(path, wrapper);
    return reattach();
  },
});

/** Apply the current modes (visual, tracking, note macro) to the main and inline editors. */
function applyModes() {
  if (current) setModes(view, current.path, modes());
  for (const [path, v] of nested) setModes(v, path, modes());
}

/**
 * Math macros for the whole project: those defined in the main file's preamble, in files it
 * \input-s there (e.g. macros.tex), and in local .sty packages it loads. Included sections render
 * \SE, \R etc. with these.
 */
async function refreshProjectMacros() {
  if (!main) return;
  const read = async (path: string) => {
    const f = open.get(path);
    if (f) return liveState(f).doc.toString();
    try { return (await api.read(path)).content; } catch { return ''; }
  };
  const mainText = await read(main);
  const texts = [mainText];
  const preamble = mainText.split(/\\begin\s*\{document\}/)[0].replace(/(^|[^\\])%.*$/gm, '$1');
  for (const m of preamble.matchAll(/\\(?:input|include)\s*\{([^}]+)\}/g)) {
    const p = resolveInclude(/\.\w+$/.test(m[1].trim()) ? m[1].trim() : `${m[1].trim()}.tex`);
    if (p) texts.push(await read(p));
  }
  for (const m of preamble.matchAll(/\\usepackage\s*(?:\[[^\]]*\])?\s*\{([^}]+)\}/g)) {
    for (const name of m[1].split(',')) {
      const p = resolveInclude(`${name.trim()}.sty`);
      if (p) texts.push(await read(p));
    }
  }
  if (setProjectMacros(collectMacros(texts.join('\n')))) {
    view.dispatch({ effects: refreshVisual.of(null) });
    for (const v of nested.values()) v.dispatch({ effects: refreshVisual.of(null) });
  }
}

/**
 * The editor the user is working in: an inline included file if focused, else the main one. Focus
 * may have moved to a toolbar control by now, so fall back to the editor focused last.
 */
let lastNested: string | null = null; // path of the inline editor focused last, null = the main one
document.addEventListener('focusin', (e) => {
  const t = e.target as Node;
  if (!view.dom.contains(t)) return; // a toolbar, panel or dialog: keep what we had
  lastNested = null;
  for (const [path, v] of nested) if (v.dom.contains(t)) lastNested = path;
});
function activeEditor(): { v: EditorView; path: string } | null {
  for (const [path, v] of nested) if (v.hasFocus) return { v, path };
  if (!view.hasFocus && lastNested) {
    const v = nested.get(lastNested);
    if (v) return { v, path: lastNested };
  }
  return current ? { v: view, path: current.path } : null;
}

// ---------- review panel: the open file and the files it includes ----------

const unreadable = new Set<string>(); // included files that couldn't be loaded, not retried
/** A state with its syntax tree parsed (states of files not on screen aren't parsed by a view). */
const parsed = (state: EditorState) => { ensureSyntaxTree(state, state.doc.length, 500); return state; };

/** The open file, then (in document order, recursively) every file it \input-s or \include-s. */
function reviewSources(): ReviewSource[] {
  if (!current) return [];
  const out: ReviewSource[] = [{
    path: current.path,
    state: () => view.state,
    dispatch: (spec) => view.dispatch(spec),
    reveal: (pos) => revealIn(view, pos),
  }];
  const seen = new Set([current.path]);
  const walk = (state: EditorState, anchor: number | null) => {
    for (const { rel, pos } of findIncludes(state)) {
      const path = resolveInclude(rel);
      if (!path || seen.has(path) || !supportsVisual(path)) continue;
      seen.add(path);
      const f = open.get(path);
      if (!f) {
        // Load it, then list it.
        if (!unreadable.has(path)) void loadFile(path).then(() => review.schedule(), () => unreadable.add(path));
        continue;
      }
      const at = anchor ?? pos; // where it comes in the open file
      out.push({
        path,
        state: () => parsed(liveState(f)),
        dispatch: (spec) => dispatchTo(f, spec),
        reveal: (p) => revealIncluded(f, at, p),
      });
      walk(parsed(liveState(f)), at);
    }
  };
  walk(view.state, null);
  return out;
}

/** Change a file that may not be on screen: in its inline editor if it has one, else its state. */
function dispatchTo(f: OpenFile, spec: TransactionSpec) {
  const v = nested.get(f.path);
  if (v) return v.dispatch(spec);
  f.state = f.state.update(spec).state;
  renderDirty();
  scheduleAutosave();
}

function revealIn(v: EditorView, pos: number) {
  v.dispatch({ selection: { anchor: pos }, effects: EditorView.scrollIntoView(pos, { y: 'center' }) });
  v.focus();
}

/** Show a place in an included file: inline below its \input (visual mode), or open the file. */
function revealIncluded(f: OpenFile, anchor: number, pos: number) {
  const inline = () => (attached.has(f.path) ? nested.get(f.path) : undefined);
  const v = visualMode ? inline() : undefined;
  if (v) return revealIn(v, pos);
  const openIt = () => void openFile(f.path).then(() => revealIn(view, pos));
  if (!visualMode) return openIt();
  // Inline but scrolled away (not on the page): bring its \input into view, wait for the
  // editor to mount, then go to the spot. If it never mounts (not shown inline), open the file.
  view.dispatch({ effects: EditorView.scrollIntoView(Math.min(anchor, view.state.doc.length), { y: 'start' }) });
  const until = performance.now() + 1500;
  const wait = () => {
    const w = inline();
    if (w) return requestAnimationFrame(() => revealIn(w, pos));
    if (performance.now() > until) return openIt();
    requestAnimationFrame(wait);
  };
  requestAnimationFrame(wait);
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
    const result = await api.compile(main, commentPrefs.macro);
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
  const active = activeEditor() ?? { v: view, path: current.path };
  const line = active.v.state.doc.lineAt(active.v.state.selection.main.head).number;
  ensurePdfVisible();
  try {
    const { boxes } = await api.syncForward(main, active.path, line);
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
  ensureEditorVisible();
  const inline = nested.get(hit.file);
  const target = inline ?? view; // shown inline in the current page, or open the file
  if (!inline) await openFile(hit.file);
  goToLine(target, hit.line);
  setTimeout(() => target.focus(), 0); // after the double-click's own mouse events
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
  s.title = text; // the status line truncates long messages
  s.classList.toggle('error', error);
}

/** Folders collapsed in the file tree (per project, remembered). */
let collapsed = new Set<string>();
const saveCollapsed = () => store.set(`collapsed:${project.root}`, JSON.stringify([...collapsed]));
const isHidden = (path: string) => {
  // Hidden if any ancestor folder is collapsed.
  for (let i = path.indexOf('/'); i >= 0; i = path.indexOf('/', i + 1)) {
    if (collapsed.has(path.slice(0, i))) return true;
  }
  return false;
};
/** Expand the folders containing a file (e.g. when it's opened from elsewhere). */
function revealInTree(path: string) {
  let changed = false;
  for (let i = path.indexOf('/'); i >= 0; i = path.indexOf('/', i + 1)) {
    changed = collapsed.delete(path.slice(0, i)) || changed;
  }
  if (changed) saveCollapsed();
}

function renderTree() {
  const nav = $('files');
  nav.replaceChildren(
    ...project.tree.filter((e) => !isHidden(e.path)).map((e) => {
      const depth = e.path.split('/').length - 1;
      const name = e.path.split('/').pop()!;
      const el = document.createElement('button');
      el.className = 'item';
      el.style.paddingLeft = `${8 + depth * 14}px`;
      el.dataset.path = e.path;
      if (e.type === 'dir') {
        const open = !collapsed.has(e.path);
        const caret = document.createElement('span');
        caret.className = 'caret';
        caret.textContent = open ? '▼' : '▶';
        el.append(caret, `${name}/`);
        el.classList.add('dir');
        el.setAttribute('aria-expanded', String(open));
        el.title = open ? 'Collapse folder' : 'Expand folder';
        el.onclick = () => {
          if (open) collapsed.add(e.path); else collapsed.delete(e.path);
          saveCollapsed();
          renderTree();
        };
        return el;
      }
      const spacer = document.createElement('span');
      spacer.className = 'caret';
      el.append(spacer, name);
      if (VIEWABLE.test(e.path)) {
        el.onclick = () => showViewer(e.path);
        el.title = 'View';
        if (viewer.path === e.path) el.classList.add('active');
      } else if (!TEXT_EXT.test(e.path)) {
        el.classList.add('binary');
        el.title = 'Not a text file';
        el.tabIndex = -1;
      } else {
        el.onclick = () => { ensureEditorVisible(); void openFile(e.path); };
        if (!viewer.path && current?.path === e.path) el.classList.add('active');
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
  const name = viewer.path ?? (current ? current.path + (isDirty(current) ? ' ●' : '') : 'No file open');
  $('current-file').textContent = name;
  const shown = viewer.path ?? current?.path;
  document.title = `${shown ? shown + ' — ' : ''}${project?.name ?? "Mike's"}`;
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
  box.classList.toggle('has-errors', errors > 0); // keeps errors noticeable while collapsed
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
  if (p.missingFile) li.append(missingPackageFix(p.missingFile));
  if (p.file && TEXT_EXT.test(p.file) && project.tree.some((e) => e.path === p.file)) {
    li.onclick = async () => {
      ensureEditorVisible();
      await openFile(p.file!);
      if (p.line) goToLine(view, p.line);
    };
  } else li.classList.add('no-jump');
  return li;
}

/** For "File `x.sty' not found": install it (bundled TeX) or say how (system TeX). */
function missingPackageFix(file: string): HTMLElement {
  const name = file.replace(/\.(sty|cls)$/, '');
  if (!texStatus()?.manageable) {
    const hint = document.createElement('span');
    hint.className = 'hint';
    hint.textContent = `Install it with \`tlmgr --usermode install ${name}\` or \`sudo tlmgr install ${name}\` (the package name may differ).`;
    return hint;
  }
  const b = document.createElement('button');
  b.className = 'fix primary';
  b.textContent = 'Install & recompile';
  b.title = `Install the TeX Live package that provides ${file} into the app's TeX, then compile again`;
  b.onclick = async (e) => {
    e.stopPropagation();
    b.disabled = true;
    b.textContent = 'Installing…';
    setStatus(`Installing the package that provides ${file}…`);
    try {
      const pkg = await installProviding(file);
      setStatus(`Installed ${pkg}. Compiling…`);
      await saveAllAndCompile();
    } catch (err) {
      b.disabled = false;
      b.textContent = 'Install & recompile';
      setStatus((err as Error).message, true);
    }
  };
  return b;
}

$('log-toggle').onclick = () => {
  if (problemsCollapsed) setProblemsCollapsed(false);
  $('raw-log').hidden = !$('raw-log').hidden;
};

// The problems/log panel can be collapsed to its one-line summary (remembered).
let problemsCollapsed = store.get('problems-collapsed') === '1';
function setProblemsCollapsed(collapsed: boolean) {
  problemsCollapsed = collapsed;
  store.set('problems-collapsed', collapsed ? '1' : '0');
  $('problems').classList.toggle('collapsed', collapsed);
  const t = $('problems-toggle');
  t.textContent = collapsed ? '▸ Show' : '▾ Hide';
  t.title = collapsed ? 'Show the problems list' : 'Hide the problems list';
  t.setAttribute('aria-expanded', String(!collapsed));
  view.requestMeasure();
}
$('problems-toggle').onclick = () => setProblemsCollapsed(!problemsCollapsed);
$('problems-summary').onclick = () => setProblemsCollapsed(!problemsCollapsed);
setProblemsCollapsed(problemsCollapsed);
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
  applyModes();
  renderModeToggle();
  view.focus();
});

// ---------- review: track changes, comments, panel ----------

$('track-toggle').onclick = () => {
  if (!current) return;
  tracking = !tracking;
  store.set(`track:${project.root}`, tracking ? '1' : '0');
  applyModes();
  renderModeToggle();
  setStatus(tracking ? 'Track changes on: edits are recorded as \\added / \\deleted.' : 'Track changes off.');
  view.focus();
};
// In the editor being typed in: often an inline \input file, not the main one. Clicking mustn't
// take focus from it.
$('comment-btn').onmousedown = (e) => e.preventDefault();
$('comment-btn').onclick = () => { addComment(activeEditor()?.v ?? view); };
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
  if (macroChanged && current) applyModes();
  review.render();
}
review.onPrefsChange = applyCommentPrefs;

window.addEventListener('review-notice', (e) => setStatus((e as CustomEvent<string>).detail, true));

// ---------- layout: editor only / both / PDF only ----------

type Layout = 'editor' | 'both' | 'pdf';
let layout: Layout = (['editor', 'both', 'pdf'] as const).find((l) => l === store.get('layout')) ?? 'both';

function setLayout(next: Layout) {
  layout = next;
  store.set('layout', next);
  const el = $('layout');
  el.classList.toggle('layout-editor', next === 'editor');
  el.classList.toggle('layout-pdf', next === 'pdf');
  for (const b of $('layout-toggle').querySelectorAll<HTMLButtonElement>('button')) {
    b.setAttribute('aria-pressed', String(b.dataset.layout === next));
  }
  view.requestMeasure(); // the editor may have been hidden
}
/** Show the editor (switching from PDF-only), e.g. before jumping to a source line. */
function ensureEditorVisible() { if (layout === 'pdf') setLayout('both'); }
/** Show the PDF (switching from editor-only), e.g. for Find in PDF. */
function ensurePdfVisible() { if (layout === 'editor') setLayout('both'); }

$('layout-toggle').addEventListener('click', (e) => {
  const l = (e.target as HTMLElement).closest('button')?.dataset.layout as Layout | undefined;
  if (l) setLayout(l);
});
setLayout(layout);

// ---------- Zen mode: only the text ----------

let zen = false;
function setZen(on: boolean) {
  zen = on;
  document.body.classList.toggle('zen', on);
  $('zen-exit').hidden = !on;
  view.requestMeasure();
  for (const v of nested.values()) v.requestMeasure();
  view.focus();
}
$('zen-btn').onclick = () => setZen(true);
$('zen-exit').onclick = () => setZen(false);
// Esc leaves Zen mode, unless it's closing something else first (search panel, completion, dialog).
window.addEventListener('keydown', (e) => {
  if (!zen || e.key !== 'Escape' || e.defaultPrevented) return;
  if (document.querySelector('.cm-panels, .cm-tooltip-autocomplete, dialog[open]')) return;
  setZen(false);
});

// ---------- file tree: show / hide ----------

let filesHidden = store.get('files-hidden') === '1';
function setFilesHidden(hidden: boolean) {
  filesHidden = hidden;
  store.set('files-hidden', hidden ? '1' : '0');
  $('layout').classList.toggle('files-hidden', hidden);
  const b = $('sidebar-toggle');
  b.setAttribute('aria-pressed', String(!hidden));
  b.title = hidden ? 'Show the file tree' : 'Hide the file tree';
  view.requestMeasure();
}
$('sidebar-toggle').onclick = () => setFilesHidden(!filesHidden);
setFilesHidden(filesHidden);

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

initProjectPicker({ beforeSwitch: saveAll, setStatus });
initTex();
initSettings({ onLayoutChange: () => { view.requestMeasure(); for (const v of nested.values()) v.requestMeasure(); } });

// Another window switched this server to a different project: this page's files are stale.
window.addEventListener('project-switched', (e) => {
  const other = (e as CustomEvent<string>).detail;
  $('switched-text').textContent = `The editor was switched to another project${other ? ` (${other})` : ''} in another window. Unsaved edits here can't be saved.`;
  $('switched-banner').hidden = false;
});
$('switched-reload').onclick = () => location.reload();

// Keep-alive for the background server's idle shutdown (see `--idle-exit`).
setInterval(() => { fetch('/api/ping').catch(() => {}); }, 30_000);

async function start() {
  project = await api.project();
  setProjectRoot(project.root);
  $('project-name').textContent = `${project.name} ▾`;
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
    renderBackToMain();
    void refreshProjectMacros();
    store.set(`main:${project.root}`, main);
    void saveAllAndCompile();
  };
  $<HTMLButtonElement>('compile-btn').disabled = !main;
  tracking = store.get(`track:${project.root}`) === '1';
  try { collapsed = new Set(JSON.parse(store.get(`collapsed:${project.root}`) ?? '[]')); } catch { collapsed = new Set(); }
  // Initials follow you between projects; the rest is the project's own.
  let saved: Partial<CommentPrefs> | null = null;
  try { saved = JSON.parse(store.get(`comment-prefs:${project.root}`) ?? 'null'); } catch { /* bad saved prefs */ }
  const base: CommentPrefs = { style: 'note', initials: commentPrefs.initials, macro: DEFAULT_NOTE_MACRO };
  commentPrefs = saved ? { ...base, ...saved } : base;
  // New notes use \revnote from now on; existing \note{..}{..} notes are still read (model.ts).
  if (commentPrefs.macro === 'note') commentPrefs = { ...commentPrefs, macro: DEFAULT_NOTE_MACRO };
  applyCommentPrefs(commentPrefs);

  renderTree();
  void loadGitLog();
  await refreshProjectMacros(); // before the first render, so included files' math is right
  const first = main || project.tree.find((e) => e.type === 'file' && TEXT_EXT.test(e.path))?.path;
  if (first) await openFile(first);
  if (main) await saveAllAndCompile();
  else setStatus('No .tex file with \\documentclass found in this folder.', true);
}

start().catch((e) => setStatus(`Failed to load project: ${(e as Error).message}`, true));
