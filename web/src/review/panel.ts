// Side panel listing the tracked changes and comments in the open file.
import { EditorView } from '@codemirror/view';
import { findReviewItems, isCommentKind, itemLabel, itemSummary, resolveSpec, type ReviewItem } from './model.ts';
import type { CommentPrefs } from './commands.ts';

const el = (tag: string, cls: string, text?: string) => {
  const e = document.createElement(tag);
  e.className = cls;
  if (text !== undefined) e.textContent = text;
  return e;
};

export class ReviewPanel {
  private timer: number | undefined;
  private content = el('div', 'review-content');
  private settings = el('details', 'review-settings') as HTMLDetailsElement;
  private prefs: CommentPrefs = { style: 'note', initials: '', macro: 'note' };
  onPrefsChange: (p: CommentPrefs) => void = () => {};

  constructor(private root: HTMLElement, private view: EditorView, private onCount: (changes: number, comments: number) => void) {
    // Built once (not on every render) so typing in these fields isn't interrupted.
    this.root.append(this.content, this.settings);
    this.buildSettings();
  }

  setPrefs(p: CommentPrefs) {
    this.prefs = p;
    const f = this.settings;
    (f.querySelector('[name=style]') as HTMLSelectElement).value = p.style;
    (f.querySelector('[name=initials]') as HTMLInputElement).value = p.initials;
    (f.querySelector('[name=macro]') as HTMLInputElement).value = p.macro;
    this.updateStyleLabel();
  }

  private updateStyleLabel() {
    const opt = this.settings.querySelector('[name=style] option[value=note]');
    if (opt) opt.textContent = `\\${this.prefs.macro || 'note'}{${this.prefs.initials || 'XL'}}{…}`;
  }

  private buildSettings() {
    const summary = el('summary', '', 'Comment settings');
    const field = (label: string, input: HTMLElement) => {
      const row = el('label', 'review-field');
      row.append(el('span', '', label), input);
      return row;
    };
    const style = document.createElement('select');
    style.name = 'style';
    style.append(new Option('\\note{XL}{…}', 'note'), new Option('\\comment / \\highlight (changes package)', 'changes'));
    const initials = document.createElement('input');
    initials.name = 'initials';
    initials.placeholder = 'XL';
    initials.size = 6;
    const macro = document.createElement('input');
    macro.name = 'macro';
    macro.placeholder = 'note';
    macro.size = 10;
    const commit = () => {
      this.prefs = {
        style: style.value as CommentPrefs['style'],
        initials: initials.value.trim(),
        macro: macro.value.trim().replace(/^\\/, '') || 'note',
      };
      this.updateStyleLabel();
      this.onPrefsChange(this.prefs);
    };
    style.onchange = commit;
    initials.onchange = commit;
    macro.onchange = commit;
    const hint = el('p', 'review-hint', 'Notes print in the PDF through your own macro, e.g. \\newcommand{\\note}[2]{\\textcolor{red}{[#1: #2]}}. If the paper doesn\'t define \\note, that definition is used when compiling.');
    this.settings.append(summary, field('Comment button inserts', style), field('Your initials', initials), field('Note macro', macro), hint);
  }

  /** Re-render soon; cheap to call on every keystroke. */
  schedule() {
    clearTimeout(this.timer);
    this.timer = window.setTimeout(() => this.render(), 150);
  }

  render() {
    const state = this.view.state;
    const items = findReviewItems(state);
    const changes = items.filter((i) => i.kind === 'added' || i.kind === 'deleted' || i.kind === 'replaced');
    const comments = items.filter((i) => isCommentKind(i.kind));
    this.onCount(changes.length, comments.length);
    if (this.root.hidden) return;

    const header = el('div', 'review-header');
    header.append(el('span', 'review-title', `${changes.length} change${changes.length === 1 ? '' : 's'} · ${comments.length} comment${comments.length === 1 ? '' : 's'}`));
    const all = (label: string, accept: boolean) => {
      const b = el('button', 'review-all', label) as HTMLButtonElement;
      b.disabled = changes.length === 0;
      b.onclick = () => {
        this.view.dispatch(resolveSpec(this.view.state, findReviewItems(this.view.state).filter((i) => i.kind === 'added' || i.kind === 'deleted' || i.kind === 'replaced'), accept));
        this.view.focus();
      };
      return b;
    };
    const actions = el('div', 'review-all-actions');
    actions.append(all('Accept all', true), all('Reject all', false));
    header.append(actions);

    const list = el('ul', 'review-list');
    if (!items.length) list.append(el('li', 'review-empty', 'No changes or comments in this file. Turn on Track changes to record edits, or press Comment to add a note.'));
    for (const it of items) list.append(this.row(it));
    this.content.replaceChildren(header, list);
  }

  private row(it: ReviewItem) {
    const state = this.view.state;
    const li = el('li', `review-item review-${it.kind}`);
    const meta = el('div', 'review-meta');
    meta.append(el('span', `review-tag review-tag-${it.kind}`, itemLabel(it)));
    if (it.author) meta.append(el('span', 'review-author', it.author));
    meta.append(el('span', 'review-line', `line ${state.doc.lineAt(it.from).number}`));
    const { text, old } = itemSummary(state, it);
    const body = el('div', 'review-text');
    if (it.kind === 'replaced') {
      body.append(el('del', 'rv-deleted', old || '∅'), document.createTextNode(' → '), el('ins', 'rv-added', text || '∅'));
    } else if (it.kind === 'highlight') {
      body.append(el('div', 'review-note', text || '(empty comment)'), el('div', 'review-quote', old ?? ''));
    } else if (it.kind === 'comment' || it.kind === 'note') {
      body.append(el('div', 'review-note', text || '(empty comment)'));
    } else {
      body.append(el(it.kind === 'added' ? 'ins' : 'del', it.kind === 'added' ? 'rv-added' : 'rv-deleted', text || '∅'));
    }
    const buttons = el('div', 'review-buttons');
    const button = (label: string, title: string, accept: boolean) => {
      const b = el('button', `rv-action ${accept ? 'rv-accept' : 'rv-reject'}`, label);
      b.title = title;
      b.onclick = (e) => {
        e.stopPropagation();
        const fresh = findReviewItems(this.view.state).find((x) => x.from === it.from && x.kind === it.kind);
        if (fresh) this.view.dispatch(resolveSpec(this.view.state, [fresh], accept));
        this.view.focus();
      };
      return b;
    };
    if (isCommentKind(it.kind)) buttons.append(button('✓ Resolve', it.kind === 'highlight' ? 'Remove the comment, keep the text' : 'Delete the note', true));
    else buttons.append(button('✓ Accept', 'Accept change', true), button('✗ Reject', 'Reject change', false));
    li.append(meta, body, buttons);
    li.onclick = () => {
      // Put the cursor just inside the item so visual mode shows its actions.
      const a = it.kind === 'note' ? it.args[it.args.length - 1] : it.args[0];
      const pos = Math.min(a.open + 1, state.doc.length);
      this.view.dispatch({ selection: { anchor: pos }, effects: EditorView.scrollIntoView(pos, { y: 'center' }) });
      this.view.focus();
    };
    return li;
  }
}
