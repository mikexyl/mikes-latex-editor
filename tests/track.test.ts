import { EditorState, EditorSelection } from '@codemirror/state';
import { ensureSyntaxTree } from '@codemirror/language';
import { latex } from '../web/src/visual/language.ts';
import { trackChanges } from '../web/src/review/track.ts';
import { findReviewItems, resolveSpec } from '../web/src/review/model.ts';

let notices: string[] = [];
(globalThis as any).window = { dispatchEvent: (e: any) => notices.push(e.detail) };
(globalThis as any).CustomEvent = class { constructor(public type: string, o: any) { (this as any).detail = o.detail; } };

const PRE = '\\documentclass{article}\n\\begin{document}\n';
const POST = '\n\\end{document}\n';
function mk(body: string, cursor?: number | [number, number]) {
  const doc = PRE + body + POST;
  const c = cursor === undefined ? PRE.length : Array.isArray(cursor) ? cursor.map((x) => PRE.length + x) : PRE.length + cursor;
  let s = EditorState.create({ doc, selection: Array.isArray(c) ? EditorSelection.range(c[0], c[1]) : EditorSelection.cursor(c), extensions: [latex(), trackChanges] });
  ensureSyntaxTree(s, s.doc.length, 5000);
  return s;
}
const body = (s: EditorState) => s.doc.toString().slice(PRE.length, -POST.length);
const cur = (s: EditorState) => s.selection.main.head - PRE.length;
function type(s: EditorState, text: string) {
  const r = s.selection.main;
  s = s.update({ changes: { from: r.from, to: r.to, insert: text }, selection: { anchor: r.from + text.length }, userEvent: 'input.type' }).state;
  ensureSyntaxTree(s, s.doc.length, 5000); return s;
}
function bs(s: EditorState) {
  const r = s.selection.main;
  const [f, t] = r.empty ? [r.head - 1, r.head] : [r.from, r.to];
  s = s.update({ changes: { from: f, to: t }, selection: { anchor: f }, userEvent: 'delete.backward' }).state;
  ensureSyntaxTree(s, s.doc.length, 5000); return s;
}
function del(s: EditorState) {
  const h = s.selection.main.head;
  s = s.update({ changes: { from: h, to: h + 1 }, userEvent: 'delete.forward' }).state;
  ensureSyntaxTree(s, s.doc.length, 5000); return s;
}
let fail = 0;
function check(name: string, got: string, want: string) {
  const ok = got === want;
  if (!ok) fail++;
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${name}: ${JSON.stringify(got)}${ok ? '' : `  want ${JSON.stringify(want)}`}`);
}

let s = mk('Hello world.', 5);
s = type(s, 'X'); s = type(s, 'Y');
check('insert+extend', body(s), 'Hello\\added{XY} world.'); check('cursor after insert', String(cur(s)), String('Hello\\added{XY'.length));
s = bs(s); check('backspace own text', body(s), 'Hello\\added{X} world.');
s = bs(s); check('backspace last own char removes item', body(s), 'Hello world.');

s = mk('Hello world.', 5); s = bs(s); check('backspace wraps', body(s), 'Hell\\deleted{o} world.'); check('cursor before deleted', String(cur(s)), '4');
s = bs(s); check('backspace merges', body(s), 'Hel\\deleted{lo} world.');
s = del(s); check('forward delete at deleted skips', String(cur(s)), String('Hel\\deleted{lo}'.length));
s = del(s); check('forward delete merges after', body(s), 'Hel\\deleted{lo }world.');

s = mk('Hello world.', [6, 11]); s = type(s, 'there');
check('replace selection', body(s), 'Hello \\replaced{there}{world}.');
s = type(s, '!'); check('typing continues inside replacement', body(s), 'Hello \\replaced{there!}{world}.');

s = mk('Before \\added{XY} after', 'Before \\added{XY}'.length); s = bs(s);
check('backspace after added brace', body(s), 'Before \\added{X} after');

s = mk('a \\textbf{bold} b', 'a \\textbf{bo'.length); s = type(s, 'Z');
check('insert in bold arg', body(s), 'a \\textbf{bo\\added{Z}ld} b');

notices = [];
s = mk('a $x+y$ b', 4); const before = body(s); s = type(s, 'Q');
check('math refused', body(s), before); check('math notice', String(notices.length > 0), 'true');

s = mk('see \\cite{key} b', 'see \\cite{ke'.length); s = type(s, 'Q');
check('cite refused', body(s), 'see \\cite{key} b');

s = mk('a \\textbf{bold} b', ['a \\textbf{bo'.length, 'a \\textbf{bold} '.length]); s = bs(s);
check('cross-structure delete refused', body(s), 'a \\textbf{bold} b');

s = mk('a \\textbf{bold} b', [2, 'a \\textbf{bold}'.length]); s = bs(s);
check('delete whole command', body(s), 'a \\deleted{\\textbf{bold}} b');

s = mk('x'); s = s.update({ selection: { anchor: 3 } }).state; // inside \documentclass line
s = type(s, 'Q'); check('preamble refused', s.doc.toString().startsWith('\\documentclass{article}') ? 'ok' : 'changed', 'ok');

s = mk('Hello world.', 5); s = type(s, ' '); check('whitespace untracked', body(s), 'Hello  world.');

// accept / reject
s = mk('A \\added{new} B \\deleted{old} C \\replaced{n}{o} D \\highlight[comment={why}]{hi} E \\comment{note} F');
const items = findReviewItems(s);
check('found items', items.map((i) => i.kind + (i.note ? ':' + i.note : '')).join(','), 'added,deleted,replaced,highlight:why,comment:note');
check('accept all', body(s.update(resolveSpec(s, items, true)).state), 'A new B C n D hi E F');
check('reject all', body(s.update(resolveSpec(s, items, false)).state), 'A B old C o D hi E F');
console.log(fail ? `${fail} FAILED` : 'all passed');
if (fail) process.exit(1);
