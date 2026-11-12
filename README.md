# Mike's

A LaTeX editor for reading, reviewing and lightly revising papers. It works directly on a folder
of plain `.tex` files, on macOS and Linux.

**[Download](https://github.com/mikexyl/mikes-latex-editor/releases)**: a `.dmg` for macOS (Apple
Silicon or Intel) or an AppImage for Linux.

## Design principles

**1. Visual mode first, for light editing and reviewing.**
The paper reads like the PDF: headings, math, figures, lists, citations and `\input` files shown
inline as one document. Whatever the cursor touches turns back into LaTeX, so you can still fix
anything. Writing a whole paper from scratch or heavy restructuring is what Source mode is for.

**2. Everything lives in the LaTeX source.**
There is no sidecar database or cloud account: tracked changes, comments and notes are ordinary
LaTeX macros in the `.tex` files. They travel with the source code through git, email or
Overleaf, and diff cleanly.

```latex
\added{new text}   \deleted{old text}   \replaced{new}{old}
\revnote[the sentence in question]{XL}{Do we need this?}
\highlight[comment={Which metric?}]{accuracy}   \comment{A standalone note}
\revoutline{XL}{Motivate the problem with a failure case}
```

The review macros use the syntax of the [`changes`](https://ctan.org/pkg/changes) package. When
compiling, the editor supplies definitions for anything the paper doesn't define, so no preamble
changes are needed. To compile elsewhere (Overleaf, a co-author's TeX), add
`\usepackage{changes}`, `\newcommand{\revnote}[3][]{#1\textcolor{red}{[#2: #3]}}` and
`\newcommand{\revoutline}[2]{\textcolor{blue}{[To write (#1): #2]}}`, or accept and resolve
everything first.

**3. TeX is bundled and easy to configure.**
The app ships its own TeX Live (TeX Live 2026, with the classes and packages papers usually need:
IEEE, ACM, Elsevier, LNCS, REVTeX, biblatex, TikZ, algorithms, …). Nothing else has to be
installed, and compiles don't depend on what's on the machine. When a compile stops on a missing
package, **Install & recompile** fixes it. ⚙ → **Manage TeX packages…** adds, updates or removes
packages, or switches to the system's TeX.

## What you can do

- **Visual or Source mode**, switchable any time. In visual mode, single line breaks flow like in
  the PDF; Enter starts a new paragraph.
- **Track changes** (toolbar switch): typing, deleting and overwriting are recorded as
  `\added` / `\deleted` / `\replaced`, signed with your initials (`\deleted[id=XL]{…}`). Edits
  that would break the LaTeX are refused.
- **Comment** (⌘⌥M / Ctrl+Alt+M, or select text and use the toolbar that appears): adds
  `\revnote{XL}{…}` with your initials, or `\revnote[selection]{XL}{…}` on a selection, which
  highlights the text the note is about. Notes print in red in the PDF. Notes written as
  `\note{…}{…}` by earlier versions still work.
- **Outline** (⌘⌥O / Ctrl+Alt+O): sketch what still has to be written with
  `\revoutline{XL}{…}`, shown as a "To write" box and printed in blue in the PDF. Mark it done
  once written.
- **Delete** (⌘⌥D / Ctrl+Alt+D): strike out the selection as `\deleted{…}`. The text stays in the
  source until the deletion is accepted.
- **Review panel**: every change, comment and outline in the file and the files it includes, with
  Accept, Reject, Resolve and Done, one at a time or all at once.
- **Source ↔ PDF**: *Find in PDF* (⌘⌥J / Ctrl+Alt+J) jumps to the cursor's spot in the PDF, and
  double-clicking the PDF jumps to the source, across `\input` files.
- **Compare with a git commit**: see what changed since then, plus a latexdiff PDF if
  [latexdiff](https://ctan.org/pkg/latexdiff) is installed.
- **View figures and notes**: images, PDFs and Markdown files (rendered, with math) open right in
  the editor; **Edit** switches a Markdown file to its source, **Preview** back.
- **Reload from disk** (↻) after git or another tool changed files; edits autosave.
- **Several windows**, each with its own project: the dock's *New Window*, Ctrl+Shift+N (⌘⇧N on
  the Mac), or *Open in new window* in the project picker.
- ⚙ **Settings**: light or dark theme, font size, and text width.

## Running from source

Needs Node.js 20+ and, outside the desktop app, a TeX distribution with `latexmk`.

```bash
npm install
npm run dev -- /path/to/paper     # the editor in your browser, http://127.0.0.1:5480
npm run electron:dev               # the desktop app from the sources
```

Building the desktop app (the bundled TeX comes from CTAN, or from an existing TeX Live with
`--from`):

```bash
npm run tex:build                 # → build/texlive
npm run dist:mac                  # → release/Mikes-<version>-{arm64,x64}.dmg
npm run dist:linux                # → release/Mikes-<version>-x86_64.AppImage
```

Pushing a `v*` tag builds both on GitHub Actions and publishes a release. `npm test` runs the
tests.

**First launch:** the Mac app isn't notarized by Apple, so right-click it and choose **Open**, or
run `xattr -cr "/Applications/Mike's.app"`. On Linux, `chmod +x` the AppImage; Ubuntu 22.04 and
later also need `sudo apt install libfuse2`.

## License

AGPL-3.0 (see [LICENSE](LICENSE)). The LaTeX grammar in `web/src/lezer-latex/` comes from
[Overleaf](https://github.com/overleaf/overleaf) under AGPL-3.0, so the editor as a whole uses the
same license.
