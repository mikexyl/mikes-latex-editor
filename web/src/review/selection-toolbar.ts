// A small floating toolbar above a text selection: comment on it, suggest an edit, or mark it
// deleted. Shown once the selection is made (not while the mouse is still dragging).
import { StateEffect, StateField, type EditorState } from '@codemirror/state';
import { EditorView, showTooltip, type Tooltip, ViewPlugin } from '@codemirror/view';
import { addComment, getCommentPrefs, suggestDeletion, suggestEdit } from './commands.ts';

const MAX_SELECTION = 20_000;

function tooltipFor(state: EditorState): readonly Tooltip[] {
  const r = state.selection.main;
  if (r.empty || state.selection.ranges.length > 1 || r.to - r.from > MAX_SELECTION) return [];
  // Hide while the selection is only whitespace (e.g. a stray double-click on an empty line).
  if (!state.sliceDoc(r.from, r.to).trim()) return [];
  return [{
    pos: r.from,
    above: true,
    strictSide: false,
    arrow: false,
    create: (view) => ({ dom: toolbarDOM(view), offset: { x: 0, y: 6 } }),
  }];
}

function toolbarDOM(view: EditorView): HTMLElement {
  const bar = document.createElement('div');
  bar.className = 'rv-selbar';
  bar.setAttribute('role', 'toolbar');
  bar.setAttribute('aria-label', 'Review the selection');
  const button = (label: string, title: string, run: (v: EditorView) => boolean) => {
    const b = document.createElement('button');
    b.className = 'rv-selbar-btn';
    b.textContent = label;
    b.title = title;
    // mousedown, not click: keep the selection (and focus) in the editor.
    b.addEventListener('mousedown', (e) => {
      e.preventDefault();
      e.stopPropagation();
      run(view);
    });
    return b;
  };
  const prefs = getCommentPrefs();
  const commentTitle = prefs.style === 'note'
    ? `Add a note after the selection (\\${prefs.macro}{${prefs.initials || 'initials'}}{…}) — ⌘⌥M`
    : 'Comment on the selection (\\highlight[comment={…}]) — ⌘⌥M';
  bar.append(
    button('Comment', commentTitle, addComment),
    button('Suggest edit', 'Replace the selection with your suggestion, kept as a tracked change', suggestEdit),
    button('Delete', 'Mark the selection as deleted (tracked change)', suggestDeletion),
  );
  return bar;
}

// While a mouse drag is in progress, don't show the toolbar (it would chase the pointer).
const setDragging = StateEffect.define<boolean>();

const toolbarField = StateField.define<{ dragging: boolean; tooltips: readonly Tooltip[] }>({
  create: (state) => ({ dragging: false, tooltips: tooltipFor(state) }),
  update(value, tr) {
    let dragging = value.dragging;
    for (const e of tr.effects) if (e.is(setDragging)) dragging = e.value;
    if (dragging) return value.tooltips.length || !value.dragging ? { dragging, tooltips: [] } : value;
    if (!value.dragging && !tr.docChanged && !tr.selection && !tr.reconfigured) return value;
    return { dragging, tooltips: tooltipFor(tr.state) };
  },
  provide: (f) => showTooltip.computeN([f], (state) => state.field(f).tooltips),
});

const dragTracker = ViewPlugin.define((view) => {
  const up = () => {
    if (view.state.field(toolbarField, false)?.dragging) {
      // After CodeMirror has finished its own mouseup handling, so the selection is final.
      setTimeout(() => view.dispatch({ effects: setDragging.of(false) }), 0);
    }
  };
  document.addEventListener('mouseup', up);
  return { destroy: () => document.removeEventListener('mouseup', up) };
}, {
  eventHandlers: {
    mousedown(e, view) { if (e.button === 0) view.dispatch({ effects: setDragging.of(true) }); },
  },
});

export const selectionToolbar = [toolbarField, dragTracker];
