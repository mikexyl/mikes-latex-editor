// LaTeX language support built on Overleaf's Lezer grammar.
import { LRLanguage, LanguageSupport, foldNodeProp, foldInside } from '@codemirror/language';
import { styleTags, tags as t, type Tag } from '@lezer/highlight';
import { parser } from '../lezer-latex/latex.mjs';

// Token-name based styles, as in Overleaf: every *CtrlSeq is a command name, etc.
const byName: Record<string, Tag | Tag[]> = {};
for (const type of parser.nodeSet.types) {
  const n = type.name;
  if (/^(Begin|End|.*CtrlSeq)$/.test(n)) byName[n] = t.tagName;
  else if (/CtrlSym$/.test(n)) byName[n] = t.literal;
  else if (/EnvName$/.test(n)) byName[n] = t.attributeValue;
}
for (const n of ['CiteCtrlSeq', 'CiteStarrableCtrlSeq', 'RefCtrlSeq', 'RefStarrableCtrlSeq', 'LabelCtrlSeq', 'DocumentClassCtrlSeq', 'UsePackageCtrlSeq']) {
  byName[n] = t.keyword;
}

export const latexLanguage = LRLanguage.define({
  name: 'latex',
  parser: parser.configure({
    props: [
      foldNodeProp.add({
        Group: foldInside,
        NonEmptyGroup: foldInside,
        TextArgument: foldInside,
        $Environment: (node) => node.getChild('Content'),
      }),
      styleTags({
        ...byName,
        'CtrlSeq Csname': t.tagName,
        Number: t.number,
        'OpenBrace CloseBrace': t.brace,
        'OpenBracket CloseBracket': t.squareBracket,
        'Dollar Math Math/MathChar Math/MathSpecialChar Math/Number': t.string,
        'MathGroup/OpenBrace MathGroup/CloseBrace': t.string,
        MathDelimiter: t.literal,
        'DoubleDollar Tilde Ampersand LineBreakCtrlSym': t.keyword,
        Comment: t.comment,
        TrailingContent: t.comment,
        'LiteralArgContent VerbContent VerbatimContent LstInlineContent': t.string,
        'LabelArgument/ShortTextArgument/ShortArg/...': t.attributeValue,
        'RefArgument/ShortTextArgument/ShortArg/...': t.attributeValue,
        'BibKeyArgument/ShortTextArgument/ShortArg/...': t.attributeValue,
        'UrlArgument/LiteralArgContent': [t.attributeValue, t.url],
        'FilePathArgument/LiteralArgContent': t.attributeValue,
        'TextBoldCommand/TextArgument/LongArg/...': t.strong,
        'TextItalicCommand/TextArgument/LongArg/... EmphasisCommand/TextArgument/LongArg/...': t.emphasis,
      }),
    ],
  }),
  languageData: { commentTokens: { line: '%' } },
});

export const latex = () => new LanguageSupport(latexLanguage);
