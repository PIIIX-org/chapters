import { describe, expect, it } from 'vitest'
import { resolveNotePath, splitPath } from '../src/notes/okf/paths.js'
import { OkfValidationError } from '../src/notes/okf.js'

describe('resolveNotePath', () => {
  it('resolves 1-segment path (root note)', () => {
    const res = resolveNotePath('index')
    expect(res).toEqual({
      fullPath: 'index',
      directory: '',
      baseName: 'index',
      segments: ['index'],
      type: 'index',
      name: 'index',
      isRootBundleFile: true,
      ancestorDirectories: [],
    })
  })

  it('resolves 1-segment path with .md extension', () => {
    const res = resolveNotePath('readme.md')
    expect(res.fullPath).toBe('readme')
    expect(res.baseName).toBe('readme')
    expect(res.directory).toBe('')
    expect(res.isRootBundleFile).toBe(true)
    expect(res.ancestorDirectories).toEqual([])
  })

  it('resolves 2-segment path (standard OKF type/name)', () => {
    const res = resolveNotePath('people/john')
    expect(res).toEqual({
      fullPath: 'people/john',
      directory: 'people',
      baseName: 'john',
      segments: ['people', 'john'],
      type: 'people',
      name: 'john',
      isRootBundleFile: false,
      ancestorDirectories: ['people'],
    })
  })

  it('resolves 2-segment path with .md extension', () => {
    const res = resolveNotePath('people/john.md')
    expect(res.fullPath).toBe('people/john')
    expect(res.baseName).toBe('john')
    expect(res.directory).toBe('people')
    expect(res.ancestorDirectories).toEqual(['people'])
  })

  it('resolves 3-segment hierarchical path', () => {
    const res = resolveNotePath('domains/auth/session')
    expect(res).toEqual({
      fullPath: 'domains/auth/session',
      directory: 'domains/auth',
      baseName: 'session',
      segments: ['domains', 'auth', 'session'],
      type: 'domains',
      name: 'auth/session',
      isRootBundleFile: false,
      ancestorDirectories: ['domains/auth', 'domains'],
    })
  })

  it('resolves 8-segment path (maximum allowed depth)', () => {
    const res = resolveNotePath('a/b/c/d/e/f/g/h')
    expect(res.segments).toHaveLength(8)
    expect(res.fullPath).toBe('a/b/c/d/e/f/g/h')
    expect(res.directory).toBe('a/b/c/d/e/f/g')
    expect(res.baseName).toBe('h')
    expect(res.type).toBe('a')
    expect(res.name).toBe('b/c/d/e/f/g/h')
    expect(res.ancestorDirectories).toEqual([
      'a/b/c/d/e/f/g',
      'a/b/c/d/e/f',
      'a/b/c/d/e',
      'a/b/c/d',
      'a/b/c',
      'a/b',
      'a',
    ])
  })

  it('normalizes Windows backslashes to forward slashes', () => {
    const res = resolveNotePath('domains\\auth\\session.md')
    expect(res.fullPath).toBe('domains/auth/session')
    expect(res.directory).toBe('domains/auth')
    expect(res.baseName).toBe('session')
    expect(res.ancestorDirectories).toEqual(['domains/auth', 'domains'])
  })

  it('trims leading and trailing whitespace', () => {
    const res = resolveNotePath('   domains/auth/session   ')
    expect(res.fullPath).toBe('domains/auth/session')
  })

  it('rejects empty paths', () => {
    for (const empty of ['', '   ', '.md', '   .md   ']) {
      expect(() => resolveNotePath(empty)).toThrow(OkfValidationError)
      expect(() => resolveNotePath(empty)).toThrow('note path cannot be empty')
    }
  })

  it('rejects paths exceeding maximum depth of 8 segments', () => {
    expect(() => resolveNotePath('1/2/3/4/5/6/7/8/9')).toThrow(OkfValidationError)
    expect(() => resolveNotePath('1/2/3/4/5/6/7/8/9')).toThrow('note path exceeds maximum depth of 8 segments')
    expect(() => resolveNotePath('a/b/c/d/e/f/g/h/i.md')).toThrow('note path exceeds maximum depth of 8 segments')
  })

  it('rejects directory traversal segments', () => {
    for (const bad of ['../etc', 'etc/..', 'domains/../auth', 'domains/./auth', '.']) {
      expect(() => resolveNotePath(bad)).toThrow(OkfValidationError)
    }
  })

  it('rejects leading, trailing, and consecutive slashes', () => {
    for (const bad of ['/domains/auth', 'domains/auth/', 'domains//auth', '//', '/']) {
      expect(() => resolveNotePath(bad)).toThrow(OkfValidationError)
    }
  })

  it('rejects hidden segments starting with dot', () => {
    for (const bad of ['.hidden', '.git/config', 'domains/.auth/session']) {
      expect(() => resolveNotePath(bad)).toThrow(OkfValidationError)
    }
  })

  it('rejects uppercase and invalid characters in segments', () => {
    for (const bad of ['UPPER', 'domains/UPPER/session', 'has space/name', 'special@char/name']) {
      expect(() => resolveNotePath(bad)).toThrow(OkfValidationError)
    }
  })

  it('rejects paths containing null bytes', () => {
    expect(() => resolveNotePath('auth/\0session')).toThrow(OkfValidationError)
    expect(() => resolveNotePath('auth/\0session')).toThrow('note path contains null bytes')
  })

  it('computes ancestorDirectories correctly for various depths', () => {
    expect(resolveNotePath('index').ancestorDirectories).toEqual([])
    expect(resolveNotePath('auth/session').ancestorDirectories).toEqual(['auth'])
    expect(resolveNotePath('domains/auth/session').ancestorDirectories).toEqual([
      'domains/auth',
      'domains',
    ])
    expect(resolveNotePath('a/b/c/d').ancestorDirectories).toEqual(['a/b/c', 'a/b', 'a'])
  })
})

describe('splitPath', () => {
  it('returns type and name for 1-segment root note', () => {
    expect(splitPath('index')).toEqual({ type: 'index', name: 'index' })
  })

  it('returns type and name for 2-segment note', () => {
    expect(splitPath('people/john')).toEqual({ type: 'people', name: 'john' })
  })

  it('returns type and nested name for hierarchical note', () => {
    expect(splitPath('domains/auth/session')).toEqual({
      type: 'domains',
      name: 'auth/session',
    })
  })

  it('throws OkfValidationError on invalid paths', () => {
    expect(() => splitPath('../bad')).toThrow(OkfValidationError)
    expect(() => splitPath('a/b/c/d/e/f/g/h/i')).toThrow(OkfValidationError)
    expect(() => splitPath('UPPER/case')).toThrow(OkfValidationError)
  })
})
