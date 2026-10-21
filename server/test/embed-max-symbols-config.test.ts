import { describe, expect, it } from 'vitest'
import { DEFAULT_EMBED_MAX_SYMBOLS_PER_FILE, readEmbedMaxSymbolsPerFile } from '../src/config.js'

describe('readEmbedMaxSymbolsPerFile (#496)', () => {
  it('uses the default when unset or empty', () => {
    expect(readEmbedMaxSymbolsPerFile(undefined)).toBe(DEFAULT_EMBED_MAX_SYMBOLS_PER_FILE)
    expect(readEmbedMaxSymbolsPerFile('')).toBe(DEFAULT_EMBED_MAX_SYMBOLS_PER_FILE)
  })

  it('accepts whole numbers >= 0, including 0', () => {
    expect(readEmbedMaxSymbolsPerFile('0')).toBe(0)
    expect(readEmbedMaxSymbolsPerFile('64')).toBe(64)
  })

  it('rejects whitespace instead of reading it as 0 (symbol embedding off)', () => {
    expect(readEmbedMaxSymbolsPerFile(' ')).toBeNull()
    expect(readEmbedMaxSymbolsPerFile('\t')).toBeNull()
  })

  it('rejects negatives and fractions', () => {
    expect(readEmbedMaxSymbolsPerFile('-1')).toBeNull()
    expect(readEmbedMaxSymbolsPerFile('1.5')).toBeNull()
  })
})
