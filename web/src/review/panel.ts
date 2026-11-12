// Side panel listing the tracked changes and comments in the open file and the files it includes.
import type { EditorState, TransactionSpec } from '@codemirror/state';
import { findReviewItems, isCommentKind, isResolvable, itemLabel, itemSummary, resolveSpec, type ReviewItem } from './model.ts';
import type { CommentPrefs } from './commands.ts';

const el = (tag: string, cls: string, text?: string) => {
  const e = document.createElement(tag);
  e.className = cls;
  if (text !== undefined) e.textContent = text;
  return e;
};

/** A file whose items the panel lists: the open file first, then the files it includes. */
export type ReviewSource = {
  path: string;
  state: () => EditorState;
  dispatch: (spec: TransactionSpec) => void;
  /** Show `pos` in the editor and put the cursor there. */
  reveal: (pos: number) => void;
};

export class ReviewPanel {
  private timer: number | undefined;
  private content = el('div', 'review-content');
  private settings = el('details', 'review-settings') as HTMLDetailsElement;
  private prefs: CommentPrefs = { style: 'note', initials: '', macro: 'revnote' };
  onPrefsChange: (p: CommentPrefs) => void = () => {};

  constructor(private root: HTMLElement, private sources: () => ReviewSource[], private onCount: (changes: number, comments: number) => void) {
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
    if (opt) opt.textContent = `\\${this.prefs.macro || 'revnote'}{${this.prefs.initials || 'XL'}}{…}`;
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
    style.append(new Option('\\revnote{XL}{…}', 'note'), new Option('\\comment / \\highlight (changes package)', 'changes'));
    const initials = document.createElement('input');
    initials.name = 'initials';
    initials.placeholder = 'XL';
    initials.size = 6;
    const macro = document.createElement('input');
    macro.name = 'macro';
    macro.placeholder = 'revnote';
    macro.size = 10;
    const commit = () => {
      this.prefs = {
        style: style.value as CommentPrefs['style'],
        initials: initials.value.trim(),
        macro: macro.value.trim().replace(/^\\/, '') || 'revnote',
      };
      this.updateStyleLabel();
      this.onPrefsChange(this.prefs);
    };
    style.onchange = commit;
    initials.onchange = commit;
    macro.onchange = commit;
    const hint = el('p', 'review-hint', 'Notes print in the PDF through the note macro, e.g. \\newcommand{\\revnote}[3][]{#1\\textcolor{red}{[#2: #3]}}, where the optional argument is the paper text a note is about (it prints as usual). If the paper doesn\'t define the macro, that definition is used when compiling. The default name, \\revnote, avoids \\note, which beamer and other packages define; notes written as \\note{..}{..} are still read.');
    this.settings.append(summary, field('Comment button inserts', style), field('Your initials', initials), field('Note macro', macro), hint);
  }

  /** Re-render soon; cheap to call on every keystroke. */
  schedule() {
    clearTimeout(this.timer);
    this.timer = window.setTimeout(() => this.render(), 150);
  }

  render() {
    const groups = this.sources().map((src) => ({ src, items: findReviewItems(src.state()) }));
    const all = groups.flatMap((g) => g.items);
    const changes = all.filter((i) => !isResolvable(i.kind));
    const comments = all.filter((i) => isCommentKind(i.kind));
    const outlines = all.filter((i) => i.kind === 'outline');
    this.onCount(changes.length, comments.length + outlines.length);
    if (this.root.hidden) return;

    const header = el('div', 'review-header');
    const count = (n: number, w: string) => `${n} ${w}${n === 1 ? '' : 's'}`;
    const title = [count(changes.length, 'change'), count(comments.length, 'comment')];
    if (outlines.length) title.push(`${outlines.length} to write`);
    header.append(el('span', 'review-title', title.join(' · ')));
    const bulk = (label: string, accept: boolean) => {
      const b = el('button', 'review-all', label) as HTMLButtonElement;
      b.disabled = changes.length === 0;
      b.onclick = () => {
        for (const src of this.sources()) {
          const state = src.state();
          const items = findReviewItems(state).filter((i) => !isResolvable(i.kind));
          if (items.length) src.dispatch(resolveSpec(state, items, accept));
        }
        this.render();
      };
      return b;
    };
    const actions = el('div', 'review-all-actions');
    actions.append(bulk('Accept all', true), bulk('Reject all', false));
    header.append(actions);

    const list = el('ul', 'review-list');
    if (!all.length) list.append(el('li', 'review-empty', 'No changes, comments or outlines in this file or the files it includes. Turn on Track changes to record edits, press Comment to add a note, or Outline to sketch what to write.'));
    const withItems = groups.filter((g) => g.items.length);
    for (const { src, items } of withItems) {
      // Name the file when there's more than one, or when the items aren't in the open file.
      if (withItems.length > 1 || src !== groups[0].src) list.append(el('li', 'review-file', src.path));
      for (const it of items) list.append(this.row(src, it));
    }
    this.content.replaceChildren(header, list);
  }

  private row(src: ReviewSource, it: ReviewItem) {
    const state = src.state();
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
    } else if (it.kind === 'outline') {
      body.append(el('div', 'review-note', text || '(empty outline)'));
    } else if (it.kind === 'comment' || it.kind === 'note') {
      body.append(el('div', 'review-note', text || '(empty comment)'));
      if (old) body.append(el('div', 'review-quote', old));
    } else {
      body.append(el(it.kind === 'added' ? 'ins' : 'del', it.kind === 'added' ? 'rv-added' : 'rv-deleted', text || '∅'));
    }
    const buttons = el('div', 'review-buttons');
    const button = (label: string, title: string, accept: boolean) => {
      const b = el('button', `rv-action ${accept ? 'rv-accept' : 'rv-reject'}`, label);
      b.title = title;
      b.onclick = (e) => {
        e.stopPropagation();
        const now = src.state();
        const fresh = findReviewItems(now).find((x) => x.from === it.from && x.kind === it.kind);
        if (fresh) src.dispatch(resolveSpec(now, [fresh], accept));
        this.render();
      };
      return b;
    };
    if (it.kind === 'outline') buttons.append(button('✓ Done', 'Written: remove the outline', true));
    else if (isCommentKind(it.kind)) buttons.append(button('✓ Resolve', it.kind === 'highlight' ? 'Remove the comment, keep the text' : it.kind === 'note' && it.quote ? 'Remove the note, keep the text' : 'Delete the note', true));
    else buttons.append(button('✓ Accept', 'Accept change', true), button('✗ Reject', 'Reject change', false));
    li.append(meta, body, buttons);
    li.onclick = () => {
      // Put the cursor just inside the item so visual mode shows its actions.
      const a = it.kind === 'note' || it.kind === 'outline' ? it.args[it.args.length - 1] : it.args[0];
      src.reveal(Math.min(a.open + 1, src.state().doc.length));
    };
    return li;
  }
}
