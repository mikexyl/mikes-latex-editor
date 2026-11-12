// CodeMirror 6 setup. The source text is always the single source of truth; visual mode is a set
// of extra extensions that decorate it (web/src/visual), switched on and off per editor state.
import { basicSetup } from 'codemirror';
import { Compartment, EditorSelection, EditorState, Prec, type Extension } from '@codemirror/state';
import { EditorView, keymap } from '@codemirror/view';
import { HighlightStyle, StreamLanguage, syntaxHighlighting } from '@codemirror/language';
import { tags as t } from '@lezer/highlight';
import { stex } from '@codemirror/legacy-modes/mode/stex';
import { latex } from './visual/language.ts';
import { visualDecorations, enterNewParagraph } from './visual/decorations.ts';
import { reviewHighlight } from './review/highlight.ts';
import { trackChanges } from './review/track.ts';
import { addComment, addOutline, suggestDeletion } from './review/commands.ts';
import { pageBreaks } from './pages.ts';
import { compareExtension } from './compare/diff.ts';
import { noteMacroFacet } from './review/model.ts';
import { selectionToolbar } from './review/selection-toolbar.ts';

const theme = EditorView.theme({
  // Follows the Font size setting (settings.ts): 2px under visual mode's size.
  '&': { height: '100%', fontSize: 'calc(var(--editor-font-size, 16px) - 2px)' },
  '.cm-scroller': { fontFamily: 'var(--mono)', lineHeight: '1.6' },
  '.cm-content': { maxWidth: '52rem', padding: '12px 0' },
  '.cm-gutters': { background: 'var(--surface)', borderRight: '1px solid var(--border)', color: 'var(--muted)' },
  '.cm-activeLineGutter': { background: 'var(--hover)' },
});

// Syntax colors as CSS variables, so the dark theme (style.css) can recolor them. The fallbacks are
// CodeMirror's default light colors, which this replaces for these tags.
const highlight = syntaxHighlighting(HighlightStyle.define([
  { tag: t.keyword, color: 'var(--hl-keyword, #708)' },
  { tag: t.tagName, color: 'var(--hl-command, #085)' },
  { tag: [t.string, t.special(t.string)], color: 'var(--hl-math, #a11)' },
  { tag: [t.literal, t.number], color: 'var(--hl-symbol, #164)' },
  { tag: t.comment, color: 'var(--hl-comment, #940)' },
  { tag: [t.url, t.atom, t.labelName], color: 'var(--hl-url, #219)' },
  { tag: t.attributeValue, color: 'var(--hl-attr, inherit)' },
]));

export type EditorHooks = {
  onChange: () => void;
  onSave: () => void;
  onFindInPdf: () => void;
};

const visualCompartment = new Compartment();
const trackCompartment = new Compartment();
const noteCompartment = new Compartment();
const visualExtensions: Extension = [
  visualDecorations,
  EditorView.editorAttributes.of({ class: 'cm-visual' }),
  // Paragraphs flow in visual mode, so Enter inside one starts a new paragraph.
  Prec.high(keymap.of([{ key: 'Enter', run: enterNewParagraph }])),
];

export const supportsVisual = (path: string) => /\.(tex|ltx)$/i.test(path);

export function editorExtensions(hooks: EditorHooks): Extension[] {
  return [
    basicSetup,
    pageBreaks,
    EditorView.lineWrapping,
    theme,
    highlight,
    Prec.high(keymap.of([
      { key: 'Mod-s', preventDefault: true, run: () => (hooks.onSave(), true) },
      { key: 'Mod-Alt-m', preventDefault: true, run: addComment },
      { key: 'Mod-Alt-o', preventDefault: true, run: addOutline },
      { key: 'Mod-Alt-d', preventDefault: true, run: suggestDeletion },
      { key: 'Mod-Alt-j', preventDefault: true, run: () => (hooks.onFindInPdf(), true) },
    ])),
    EditorView.updateListener.of((u) => { if (u.docChanged) hooks.onChange(); }),
    compareExtension,
  ];
}

export type Modes = { visual: boolean; tracking: boolean; noteMacro: string };

export function createState(path: string, doc: string, base: Extension[], modes: Modes): EditorState {
  const isTex = supportsVisual(path);
  // In visual mode, whatever the cursor touches is shown as source. Start .tex files with the
  // cursor at the very end (typically a blank line) so the top of the document starts rendered.
  const anchor = isTex ? doc.length : 0;
  return EditorState.create({
    doc,
    selection: EditorSelection.cursor(anchor),
    extensions: [
      ...base,
      isTex ? [latex(), reviewHighlight, selectionToolbar] : StreamLanguage.define(stex),
      visualCompartment.of(isTex && modes.visual ? visualExtensions : []),
      trackCompartment.of(isTex && modes.tracking ? trackChanges : []),
      noteCompartment.of(noteMacroFacet.of(modes.noteMacro)),
    ],
  });
}

/** Apply source/visual mode and track changes to the editor, keeping the document and history. */
export function setModes(view: EditorView, path: string, modes: Modes) {
  const tex = supportsVisual(path);
  view.dispatch({
    effects: [
      visualCompartment.reconfigure(tex && modes.visual ? visualExtensions : []),
      trackCompartment.reconfigure(tex && modes.tracking ? trackChanges : []),
      noteCompartment.reconfigure(noteMacroFacet.of(modes.noteMacro)),
    ],
  });
}

export function goToLine(view: EditorView, line: number) {
  const n = Math.min(Math.max(1, line), view.state.doc.lines);
  const pos = view.state.doc.line(n).from;
  view.dispatch({ selection: { anchor: pos }, effects: EditorView.scrollIntoView(pos, { y: 'center' }) });
  view.focus();
}
