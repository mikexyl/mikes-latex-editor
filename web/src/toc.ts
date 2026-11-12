// Contents panel: the document's headings (\section, \subsection, ...), in reading order across
// \input / \include files, numbered like LaTeX numbers them. main.ts walks the files and handles
// navigation; this module reads one file's headings and renders the list.
import { syntaxTree } from '@codemirror/language';
import type { EditorState } from '@codemirror/state';

export type HeadingLevel = 'part' | 'chapter' | 'section' | 'subsection' | 'subsubsection' | 'paragraph';

const LEVEL_OF: Record<string, HeadingLevel> = {
  BookCtrlSeq: 'part', PartCtrlSeq: 'part', ChapterCtrlSeq: 'chapter', SectionCtrlSeq: 'section',
  SubSectionCtrlSeq: 'subsection', SubSubSectionCtrlSeq: 'subsubsection',
  ParagraphCtrlSeq: 'paragraph', SubParagraphCtrlSeq: 'paragraph',
};

/** In one file, in order: its headings, \input/\include lines and \appendix. */
export type FilePart =
  | { kind: 'heading'; level: HeadingLevel; title: string; starred: boolean; pos: number }
  | { kind: 'include'; rel: string; pos: number }
  | { kind: 'appendix'; pos: number };

/** A heading's title as readable text: commands dropped, their text kept; math kept as written. */
function titleText(tex: string): string {
  return tex
    .replace(/(^|[^\\])%.*$/gm, '$1')
    .replace(/\\(label|cite\w*|ref|eqref|cref|Cref|footnote|thanks|index)\s*(\[[^\]]*\])?\s*\{[^{}]*\}/g, '')
    .replace(/\\\\(\[[^\]]*\])?/g, ' ')
    .replace(/\\([%&_#$])/g, '$1')
    .replace(/\\[a-zA-Z@]+\*?\s*/g, '')
    .replace(/[{}~]/g, (c) => (c === '~' ? ' ' : ''))
    .replace(/\s+/g, ' ')
    .trim();
}

export function fileParts(state: EditorState): FilePart[] {
  const out: FilePart[] = [];
  syntaxTree(state).iterate({
    enter(ref) {
      const node = ref.node;
      if (ref.name === 'SectioningCommand') {
        const ctrl = node.firstChild;
        const arg = node.getChild('SectioningArgument');
        const title = arg?.getChild('LongArg');
        if (!ctrl || !title) return false;
        const level = LEVEL_OF[ctrl.name] ?? 'section';
        const starred = state.sliceDoc(ctrl.from, arg!.from).includes('*');
        out.push({ kind: 'heading', level, title: titleText(state.sliceDoc(title.from, title.to)), starred, pos: title.from });
        return false;
      }
      if (ref.name === 'Input' || ref.name === 'Include') {
        const file = /\{([^}]*)\}/.exec(state.sliceDoc(ref.from, ref.to))?.[1].trim();
        if (file) out.push({ kind: 'include', rel: /\.\w+$/.test(file) ? file : `${file}.tex`, pos: ref.from });
        return false;
      }
      if (ref.name === 'UnknownCommand' && /^\\appendix\b/.test(state.sliceDoc(ref.from, ref.from + 9))) {
        out.push({ kind: 'appendix', pos: ref.from });
        return false;
      }
      if (ref.name === 'CtrlSeq' && state.sliceDoc(ref.from, ref.to) === '\\appendix') {
        out.push({ kind: 'appendix', pos: ref.from });
      }
    },
  });
  return out;
}

/** A heading in the whole document, with where it is. */
export type TocEntry = {
  level: HeadingLevel;
  title: string;
  number: string;
  path: string;
  pos: number;
  /** Position in the open file: the heading's own, or the \input line of the file it's in. */
  anchor: number;
};

const ORDER: HeadingLevel[] = ['part', 'chapter', 'section', 'subsection', 'subsubsection', 'paragraph'];

/** Number headings like LaTeX: 1, 1.1, 1.1.1 (chapters first if any); A, B after \appendix. */
export function numberHeadings(entries: (Omit<TocEntry, 'number'> & { starred: boolean; appendix: boolean })[]): TocEntry[] {
  const hasChapters = entries.some((e) => e.level === 'chapter');
  const counters = [0, 0, 0, 0]; // chapter, section, subsection, subsubsection
  const top = hasChapters ? 0 : 1;
  let inAppendix = false;
  return entries.map((e) => {
    if (e.appendix && !inAppendix) { inAppendix = true; counters.fill(0); }
    const depth = { chapter: 0, section: 1, subsection: 2, subsubsection: 3 }[e.level as string];
    let number = '';
    if (depth !== undefined && depth >= top && !e.starred) {
      counters[depth]++;
      for (let d = depth + 1; d < counters.length; d++) counters[d] = 0;
      const parts = counters.slice(top, depth + 1).map((n, i) => (i === 0 && inAppendix ? String.fromCharCode(64 + n) : String(n)));
      number = parts.join('.');
    }
    return { level: e.level, title: e.title, number, path: e.path, pos: e.pos, anchor: e.anchor };
  });
}

export const levelRank = (l: HeadingLevel) => ORDER.indexOf(l);
