// Side panel listing the tracked changes and comments in the open file.
import { EditorView } from '@codemirror/view';
import { findReviewItems, itemLabel, itemSummary, resolveSpec, type ReviewItem } from './model.ts';

const el = (tag: string, cls: string, text?: string) => {
  const e = document.createElement(tag);
  e.className = cls;
  if (text !== undefined) e.textContent = text;
  return e;
};

export class ReviewPanel {
  private timer: number | undefined;

  constructor(private root: HTMLElement, private view: EditorView, private onCount: (changes: number, comments: number) => void) {}

  /** Re-render soon; cheap to call on every keystroke. */
  schedule() {
    clearTimeout(this.timer);
    this.timer = window.setTimeout(() => this.render(), 150);
  }

  render() {
    const state = this.view.state;
    const items = findReviewItems(state);
    const changes = items.filter((i) => i.kind === 'added' || i.kind === 'deleted' || i.kind === 'replaced');
    const comments = items.filter((i) => i.kind === 'comment' || i.kind === 'highlight');
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
    if (!items.length) list.append(el('li', 'review-empty', 'No changes or comments in this file. Turn on Track changes to record edits, or select text and press Comment.'));
    for (const it of items) list.append(this.row(it));
    this.root.replaceChildren(header, list);
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
    } else if (it.kind === 'comment') {
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
    if (it.kind === 'comment' || it.kind === 'highlight') buttons.append(button('✓ Resolve', 'Remove the comment, keep the text', true));
    else buttons.append(button('✓ Accept', 'Accept change', true), button('✗ Reject', 'Reject change', false));
    li.append(meta, body, buttons);
    li.onclick = () => {
      // Put the cursor just inside the item so visual mode shows its actions.
      const pos = Math.min(it.args[0].open + 1, state.doc.length);
      this.view.dispatch({ selection: { anchor: pos }, effects: EditorView.scrollIntoView(pos, { y: 'center' }) });
      this.view.focus();
    };
    return li;
  }
}
