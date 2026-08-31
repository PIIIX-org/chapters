import { useEffect, useRef } from 'react'
import { EditorState } from '@codemirror/state'
import { EditorView, lineNumbers } from '@codemirror/view'
import {
  HighlightStyle,
  StreamLanguage,
  syntaxHighlighting,
  type StreamParser,
  type StringStream,
} from '@codemirror/language'
import { tags } from '@lezer/highlight'

/**
 * The read-only code viewer's editor: a non-editable CodeMirror plus the
 * language mode for whatever `language` the index recorded (plan task 3).
 *
 * Read-only is permanent — editing code through Chapters is "explicitly out of
 * scope" in `2026-07-18-code-graph-integration-design.md` — so there is no
 * `onChange`, no autosave and no revert, and the view is non-editable in both
 * of the two ways CM6 offers.
 */

interface ModeSpec {
  keywords: string
  /** `#` for Python, `//` for the C-family three. */
  lineComment: string
  /** Only the C-family three have block comments. */
  blockComment: boolean
  quotes: string
}

/**
 * The four languages `server/src/repositories/extraction.ts` parses, which are
 * also the four worth colouring: everything else the index labels (rust, java,
 * c, cpp, ruby — see `server/src/repositories/language.ts`) has no outline
 * either, so it renders as the plain mono text it already was.
 *
 * ponytail: keyword/comment/string/number tokens off one shared scanner, not
 * four real grammars. That is one `StreamLanguage` and no new dependency
 * (`@codemirror/lang-javascript` and friends are not installed, and a language
 * package per language is four). Swap in the real Lezer grammars if anyone
 * ever needs bracket matching, folding or indentation in here — none of which
 * a viewer with no caret can use.
 */
const MODES: Record<string, ModeSpec> = {
  typescript: {
    keywords:
      'abstract any as async await boolean break case catch class const constructor continue declare default delete do else enum export extends false finally for from function get if implements import in instanceof interface keyof let new null number of private protected public readonly return satisfies set static string super switch this throw true try type typeof undefined unknown var void while yield',
    lineComment: '//',
    blockComment: true,
    quotes: `"'\``,
  },
  javascript: {
    keywords:
      'async await break case catch class const constructor continue default delete do else export extends false finally for from function get if import in instanceof let new null of return set static super switch this throw true try typeof undefined var void while yield',
    lineComment: '//',
    blockComment: true,
    quotes: `"'\``,
  },
  python: {
    keywords:
      'and as assert async await break class continue def del elif else except False finally for from global if import in is lambda None nonlocal not or pass raise return self True try while with yield',
    lineComment: '#',
    blockComment: false,
    quotes: `"'`,
  },
  go: {
    keywords:
      'break case chan const continue default defer else fallthrough false for func go goto if import interface map nil package range return select struct switch true type var',
    lineComment: '//',
    blockComment: true,
    quotes: `"'\``,
  },
}

function eatString(stream: StringStream, quote: string): void {
  let escaped = false
  let next: string | void
  while ((next = stream.next()) != null) {
    if (next === quote && !escaped) return
    escaped = !escaped && next === '\\'
  }
  // ponytail: an unterminated string colours to end of line rather than
  // carrying into the next one. A viewer never has a half-typed string.
}

function parserFor(spec: ModeSpec): StreamParser<{ inBlockComment: boolean }> {
  const keywords = new Set(spec.keywords.split(' '))
  return {
    startState: () => ({ inBlockComment: false }),
    token(stream, state) {
      if (state.inBlockComment) {
        if (stream.skipTo('*/')) {
          stream.match('*/')
          state.inBlockComment = false
        } else {
          stream.skipToEnd()
        }
        return 'comment'
      }
      if (stream.eatSpace()) return null
      if (stream.match(spec.lineComment)) {
        stream.skipToEnd()
        return 'comment'
      }
      if (spec.blockComment && stream.match('/*')) {
        state.inBlockComment = true
        return 'comment'
      }
      const ahead = stream.peek()
      if (ahead && spec.quotes.includes(ahead)) {
        stream.next()
        eatString(stream, ahead)
        return 'string'
      }
      if (stream.match(/^\d[\w.]*/)) return 'number'
      const word = stream.match(/^[A-Za-z_$][\w$]*/)
      if (word) return keywords.has((word as RegExpMatchArray)[0]) ? 'keyword' : null
      stream.next()
      return null
    },
  }
}

/** Null for a language with no mode — the caller then mounts plain text. */
function languageExtension(language: string | null) {
  const spec = language ? MODES[language] : undefined
  return spec ? StreamLanguage.define(parserFor(spec)) : null
}

const codeHighlight = HighlightStyle.define([
  { tag: tags.keyword, class: 'cm-code-keyword' },
  { tag: tags.comment, class: 'cm-code-comment' },
  { tag: tags.string, class: 'cm-code-string' },
  { tag: tags.number, class: 'cm-code-number' },
])

/**
 * An editor-console theme written entirely in CSS variables, so it follows the
 * active theme live — no colour is read at mount, which is what let the old
 * version show stale token colours after a theme switch. The background stays
 * transparent over the viewer's own `bg-card`; gutter numbers sit in
 * `--faint`; the syntax palette is three restrained ink hues plus faint
 * comments — the collaborator inks exist precisely because `--primary`
 * (human) and `--accent` (AI/MCP) are authorship tokens and a keyword did not
 * author anything. Selection is the one place `--primary` appears: selecting
 * is something the person is doing.
 */
const viewerTheme = EditorView.theme({
  '&': {
    fontFamily: 'var(--font-mono)',
    fontSize: '13px',
    height: '100%',
    backgroundColor: 'transparent',
    color: 'var(--foreground)',
  },
  '&.cm-focused': { outline: 'none' },
  '.cm-content': { fontFamily: 'var(--font-mono)', caretColor: 'transparent' },
  '.cm-scroller': { overflow: 'auto', lineHeight: '1.6' },
  '.cm-gutters': {
    backgroundColor: 'transparent',
    color: 'var(--faint)',
    border: 'none',
  },
  '.cm-lineNumbers .cm-gutterElement': { minWidth: '3ch', padding: '0 12px 0 10px' },
  '.cm-activeLine': { backgroundColor: 'transparent' },
  '.cm-activeLineGutter': { backgroundColor: 'transparent', color: 'var(--muted-foreground)' },
  '.cm-selectionBackground, &.cm-focused .cm-selectionBackground': {
    backgroundColor: 'color-mix(in srgb, var(--primary) 24%, transparent)',
  },
  '.cm-content ::selection': {
    backgroundColor: 'color-mix(in srgb, var(--primary) 24%, transparent)',
  },
  '.cm-code-keyword': { color: 'var(--ink-indigo)' },
  '.cm-code-comment': { color: 'var(--faint)', fontStyle: 'italic' },
  '.cm-code-string': { color: 'var(--ink-forest)' },
  '.cm-code-number': { color: 'var(--ink-ochre)' },
})

/**
 * Mounts a non-editable CodeMirror over `doc`, and remounts when the document
 * or its language changes — a viewer has no cursor or history worth preserving
 * across files.
 */
export function useCodeViewer(doc: string | undefined, label: string, language: string | null) {
  const containerRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (!containerRef.current || doc === undefined) return
    const mode = languageExtension(language)
    const view = new EditorView({
      state: EditorState.create({
        doc,
        extensions: [
          lineNumbers(),
          ...(mode ? [mode, syntaxHighlighting(codeHighlight)] : []),
          // CM6 puts role="textbox" on the content element; without a name it
          // is an unlabelled input field to a screen reader (axe
          // aria-input-field-name).
          EditorView.contentAttributes.of({ 'aria-label': `${label} (read-only)` }),
          // Both are needed for a genuinely non-editable view: readOnly blocks
          // edit transactions, editable=false drops contentEditable so there
          // is no caret to type into.
          EditorState.readOnly.of(true),
          EditorView.editable.of(false),
          viewerTheme,
        ],
      }),
      parent: containerRef.current,
    })
    return () => view.destroy()
  }, [doc, label, language])

  return containerRef
}
