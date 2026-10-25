// #455: how identifiers are split for the keyword channel (search/identifiers.ts).
import { describe, expect, it } from 'vitest'
import { MAX_FILE_KEYWORDS, fileKeywords, isPlainWord, keywordTerms, splitIdentifier, symbolKeywords } from '../src/search/identifiers.js'

describe('splitIdentifier', () => {
  it.each([
    ['parseFrontmatter', ['parse', 'frontmatter'], ['parsefrontmatter', 'parse', 'frontmatter']],
    ['ParseFrontmatter', ['parse', 'frontmatter'], ['parsefrontmatter', 'parse', 'frontmatter']],
    ['parse_frontmatter', ['parse', 'frontmatter'], ['parse_frontmatter', 'parse', 'frontmatter']],
    ['UUID_ARG', ['uuid', 'arg'], ['uuid_arg', 'uuid', 'arg']],
    ['tree-sitter', ['tree', 'sitter'], ['tree-sitter', 'tree', 'sitter']],
    ['mcp.server.ts', ['mcp', 'server', 'ts'], ['mcp.server.ts', 'mcp', 'server', 'ts']],
    ['std::io', ['std', 'io'], ['std::io', 'std', 'io']],
    ['HTMLParser', ['html', 'parser'], ['htmlparser', 'html', 'parser']],
    ['mulberry32', ['mulberry', '32'], ['mulberry32', 'mulberry', '32']],
    ['fm.parseFrontmatter', ['fm', 'parse', 'frontmatter'], ['fm.parsefrontmatter', 'fm', 'parsefrontmatter', 'parse', 'frontmatter']],
    ['parse_frontmatter_v2', ['parse', 'frontmatter', 'v', '2'], ['parse_frontmatter_v2', 'parse', 'frontmatter', 'v2', 'v', '2']],
    ['__init__', ['init'], ['__init__', 'init']],
  ])('%s', (compound, parts, lexemes) => {
    const id = splitIdentifier(compound)
    expect(id.parts).toEqual(parts)
    expect(id.lexemes).toEqual(lexemes)
    expect(isPlainWord(id)).toBe(false)
  })

  it('a plain word is its own only part', () => {
    expect(isPlainWord(splitIdentifier('parse'))).toBe(true)
    expect(isPlainWord(splitIdentifier('UUID'))).toBe(true)
    expect(splitIdentifier('Parse').lexemes).toEqual(['parse'])
  })
})

describe('keywords stored', () => {
  it('a file: its path segments and the compounds of its content, not its plain words', () => {
    expect(fileKeywords('src/mcp/server.ts', 'export const UUID_ARG = fm.parseFrontmatter(text)\n').sort()).toEqual(
      ['src', 'mcp', 'server.ts', 'server', 'ts', 'uuid_arg', 'uuid', 'arg', 'fm.parsefrontmatter', 'fm', 'parsefrontmatter', 'parse', 'frontmatter'].sort(),
    )
  })

  it('a minified file: its path only', () => {
    expect(fileKeywords('dist/app.min.js', null).sort()).toEqual(['dist', 'app.min.js', 'app', 'min', 'js'].sort())
  })

  it('at most MAX_FILE_KEYWORDS lexemes per file', () => {
    const content = Array.from({ length: MAX_FILE_KEYWORDS }, (_, i) => `name_${i}`).join(' ')
    expect(fileKeywords('a.ts', content)).toHaveLength(MAX_FILE_KEYWORDS)
  })

  it('a symbol: its inner path only, plain words included', () => {
    expect(symbolKeywords('Reader.parse').sort()).toEqual(['reader.parse', 'reader', 'parse'].sort())
  })
})

describe('keywordTerms', () => {
  it('splits a query into terms with their identifiers', () => {
    expect(keywordTerms('where is `parseFrontmatter` used?')?.map((t) => [t.text, t.identifiers.map((i) => i.whole)])).toEqual([
      ['where', ['where']],
      ['is', ['is']],
      ['`parseFrontmatter`', ['parsefrontmatter']],
      ['used?', ['used']],
    ])
  })

  it('leaves websearch syntax to the English query', () => {
    expect(keywordTerms('"parse frontmatter"')).toBeNull()
    expect(keywordTerms('parse -yaml')).toBeNull()
    expect(keywordTerms('parse or read')).toBeNull()
    expect(keywordTerms('tree-sitter')).not.toBeNull()
  })
})
