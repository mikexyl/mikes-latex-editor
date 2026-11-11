# LaTeX Editor

A personal LaTeX editor for reviewing and light revising, with a visual mode in the style of
Overleaf's. Runs as a local web app on macOS and Ubuntu and works directly on plain `.tex`
folders (git-friendly: the source file is always the single source of truth).

## Requirements

- Node.js 20+
- A TeX distribution with `latexmk` on `PATH` (MacTeX / TeX Live)

## Install as an app

```bash
npm install
npm run install-app
```

- **macOS:** adds **LaTeX Editor** to `~/Applications`; open it from Spotlight, Launchpad or
  Finder, and drag it to the Dock to keep it there.
- **Ubuntu:** adds **LaTeX Editor** to the app menu (Activities); right-click it there to add it to
  the dock.
- Both: adds a `latex-editor` terminal command in `~/.local/bin`:
  `latex-editor ~/papers/thesis` opens a folder, `latex-editor status`, `latex-editor stop`.

The app opens the editor in its own window (Chrome, Edge, Brave or Chromium in app mode;
otherwise your default browser) on the last project you had open; switch projects from the
project name in the top bar. A small background server does the work and exits by itself 10
minutes after the last editor window closes (set `LATEX_EDITOR_IDLE_EXIT` in seconds to change
that). On macOS it runs as an on-demand launchd job, so it survives the app's launcher exiting
but is never restarted after it stops. The first launch builds the editor (a few seconds); after
pulling code changes it rebuilds automatically. Logs: `~/.config/latex-editor/server.log`.
`npm run uninstall-app` removes the app, menu entry, command and launchd job (projects and
settings are kept).

You can also install the open editor as a web app from Chrome's address bar (Install icon) or
Safari's File > Add to Dock; it then opens in its own window too, as long as the server is running.

## Run (development)

```bash
npm install
npm run dev -- /path/to/your/paper     # http://127.0.0.1:5480
```

With no path it reopens the last project you had open (or `examples/sample` the first time).
`--port 5481` (or `PORT=...`) changes the port. The server binds to 127.0.0.1 only, since its API
can write files and list folders.

**Switching projects:** click the project name in the top bar (or press ⌘O / Ctrl+O). Pick a
recent project, or browse to a folder (folders with `.tex` files are marked) and press
*Open this folder*. Open files are saved first. Recent projects are kept in
`~/.config/latex-editor/projects.json`. If another window switches the editor to a different
project, windows still showing the old one get a banner and refuse to save into the wrong folder.

- **⌘S / Ctrl+S** or **Compile**: save all files, then compile with `latexmk`.
- Edits autosave after ~1 s. If a file changed on disk meanwhile (git, another editor), you are
  asked whether to reload it or keep your version; unchanged buffers reload automatically when
  the window regains focus.
- Build output goes to `.latex-editor-build/` inside the project (add it to the paper's `.gitignore`).

`npm run build && npm start` serves a prebuilt UI instead of the Vite dev server.

## Layout

```
server/index.ts     Express API: project tree, read/write files, compile, serve PDF
server/compile.ts   latexmk runner + log parser (errors/warnings with file:line)
server/tools.ts     SyncTeX lookups, git log/show, latexdiff build
server/projects.ts  recent projects, folder browsing
bin/latex-editor.mjs        launcher: start the background server, open the editor window
scripts/install-app.mjs     install the macOS app / Ubuntu menu entry / terminal command
web/src/main.ts     app shell: file tree, open buffers, autosave, conflicts, problems panel
web/src/editor.ts   CodeMirror 6 setup, source/visual switch
web/src/pdf.ts      PDF.js viewer
web/src/lezer-latex/  LaTeX grammar from Overleaf (AGPL-3.0), compiled by `npm run grammar`
web/src/compare/    compare with a git revision (diff overlay)
web/src/review/     review: model.ts (find/accept/reject), track.ts (track changes), panel.ts
web/src/visual/     visual mode: language.ts (parser + highlighting), decorations.ts (what to
                    hide/style/replace), widgets.ts, math.ts (KaTeX + \newcommand macros)
```

## Visual mode

The `.tex` source is never rewritten; visual mode only decorates it. Whatever the cursor touches is
shown as source, so clicking a construct reveals its LaTeX for editing.

Files pulled in with `\input`/`\include` (on their own line) are shown inline below that line as
editable nested editors, so the paper reads as one document; edits there are saved to the included
file. Use *Open file* in the inline header (or ⌘/Ctrl+click the chip) to open it on its own.
Find in PDF and double-clicking the PDF work inside inline files too.

The text width of visual mode is adjustable under ⚙ Settings in the top bar (Narrow / Default /
Wide / Full width, or any width with the slider).

Paragraphs flow like in the PDF: a single line break in the source is shown as a space (LaTeX
treats it as one), so only blank lines, `\\` and structural lines (headings, `\item`, `\begin`,
math, tables, pseudocode, comments) start a new line. Pressing Enter inside a paragraph starts a new
paragraph (inserts a blank line); use Source mode to add a plain line break. The exact line breaks
of the PDF depend on TeX's fonts, column width and hyphenation, so the editor wraps to its own
width instead.

- Preamble collapses to a bar; `\maketitle` renders the title, authors and date
- Section headings, bold/italic/underline/etc., links, footnotes
- Inline and display math via KaTeX, using `\newcommand`/`\DeclareMathOperator` macros from the
  file itself and from the main file's preamble (plus macro files it `\input`s and local `.sty`
  packages), so included sections render the paper's macros; editing display math shows a live
  preview underneath
- Lists with bullets/numbers and nesting; abstract, theorem-like, quote, figure environments
- `\includegraphics` (PDF figures rendered with pdf.js, raster images directly)
- Chips for `\cite`, `\ref`/`\eqref`, `\label`, `\input`/`\include` (⌘/Ctrl+click to open)

Anything it doesn't recognize (custom macros with arguments, tables, `\verb`) stays as source.

## Review: tracked changes and comments

Review markup is stored in the `.tex` source using the
[`changes`](https://ctan.org/pkg/changes) package syntax, so it diffs cleanly in git:

```latex
\added{new text}   \deleted{old text}   \replaced{new}{old}
\highlight[comment={Which metric?}]{accuracy}   \comment{A standalone note}
```

- **Track changes** (toolbar switch, remembered per project): typing records `\added{…}`,
  deleting records `\deleted{…}`, typing over a selection records `\replaced{new}{old}`.
  Consecutive edits merge; editing your own added text is a plain edit. Edits that would break
  the LaTeX (inside math, command names, labels/citations, the preamble, across braces) are
  refused with a message instead.
- **Notes** (⌘⌥M / Ctrl+Alt+M, or the Comment button): inserts your own note macro,
  `\note{XL}{…}` by default, with your initials and the cursor in the note text. Notes render as
  red bubbles in visual mode, appear in the review panel (Resolve deletes them), and print in the
  PDF through your macro, e.g. `\newcommand{\note}[2]{\textcolor{red}{[#1: #2]}}`; if the paper
  doesn't define `\note`, that definition is used when compiling. Initials, the macro name (one-
  or two-argument) and the comment style are under *Comment settings* in the review panel.
- **Comment** in `changes` style (pick it in *Comment settings*): on a selection adds
  `\highlight[comment={…}]{…}`, otherwise `\comment{…}`.
- **Review panel** lists every change and comment in the open file with Accept / Reject /
  Resolve, plus Accept all / Reject all. The same buttons appear inline next to the change the
  cursor is in. Undo works for all of it.
- **Compiling** doesn't need the `changes` package: the editor injects fallback definitions at
  compile time (your preamble is untouched), so the PDF shows the proposed text with additions in
  blue and deletions/comments hidden. If the document loads `\usepackage{changes}`, the real
  package is used. To share a file with someone not using this editor, accept/reject everything
  first, or add `\usepackage{changes}`.

`npm test` runs the track-changes tests.

## Source ↔ PDF and comparing versions

- **Find in PDF** (⌘⌥J / Ctrl+Alt+J, or the button above the PDF) scrolls the PDF to the cursor's
  line and flashes it. **Double-click the PDF** to open the source file at that line (SyncTeX;
  works across `\input` files).
- **Compare with** (top bar) lists the git commits that touched the project folder. Pick one and
  the open file shows what changed since then: blue for text added, orange strikethrough for text
  removed. It follows your edits; *Stop comparing* turns it off. In visual mode, a change hidden
  inside collapsed LaTeX is shown next to it (✱ = changed inside hidden markup).
- With [latexdiff](https://ctan.org/pkg/latexdiff) installed, comparing also builds a marked-up
  **diff PDF** (shown in the PDF pane while comparing). Install it with one of:

  ```bash
  brew install latexdiff
  sudo tlmgr install latexdiff
  sudo apt install latexdiff
  ```

  or set `LATEXDIFF=/path/to/latexdiff`.

## Roadmap

1. ~~Open folder, edit, save, compile, PDF preview~~
2. ~~Visual mode: Lezer LaTeX grammar + decorations (sections, emphasis, math, cite/ref chips)~~
3. ~~Review layer: tracked changes with accept/reject, comments~~
4. ~~SyncTeX source ↔ PDF jumping, compare against a git revision (+ latexdiff PDF)~~

## License

AGPL-3.0 (see [LICENSE](LICENSE)). The LaTeX grammar in `web/src/lezer-latex/` comes from
[Overleaf](https://github.com/overleaf/overleaf) and is licensed AGPL-3.0, so the editor as a whole
is distributed under the same license.
