// #450: the definitions code is written with, not only `function` and
// `class` statements. Arrow functions bound to consts, generators, abstract
// classes, enums, namespaces, class methods (with their class in `parent`),
// exported consts (`variable`), anonymous default exports, Python methods
// and Go receiver methods are symbols; functions nested in a body are not.
import { describe, expect, it } from 'vitest'
import { extractStructure, type ExtractedSymbol } from '../src/repositories/extraction.js'

const lines = (...l: string[]) => l.join('\n')
/** The fields a reader sees, in document order: `parent` only when there is one. */
const brief = (symbols: ExtractedSymbol[]) =>
  symbols.map((s) => `${s.startLine}-${s.endLine} ${s.kind} ${s.parent ? `${s.parent}.` : ''}${s.name}${s.exported ? ' (exported)' : ''}`)

describe('TypeScript and TSX definitions (#450)', () => {
  it('captures every top-level definition form of a TypeScript module', async () => {
    const src = lines(
      "import { db } from './db.js'",
      '',
      'export const DEFAULT_LIMIT = 20',
      'export let counter = 0',
      'const internalCache = new Map<string, number>()',
      '',
      'export const fetchUser = async (id: string) => {',
      '  return db.find(id)',
      '}',
      '',
      'const normalise = function (s: string) { return s.trim() }',
      '',
      'export function* pages(total: number) {',
      '  for (let i = 0; i < total; i++) yield i',
      '}',
      '',
      'export abstract class Repository<T> {',
      '  abstract find(id: string): Promise<T>',
      '  static create() { return null }',
      '  get size() { return 0 }',
      '  set size(n: number) {}',
      '  private onChange = (v: T) => v',
      '  #secret() {}',
      '}',
      '',
      'export enum Status { Active, Closed }',
      '',
      'export interface User { id: string }',
      'export type UserId = User["id"]',
      '',
      'export namespace Paths {',
      '  export function join(a: string, b: string) { return a + b }',
      '}',
      '',
      'export default class {',
      '  run() {}',
      '}',
    )
    const result = await extractStructure('typescript', src, 'src/users.ts')
    expect(brief(result.symbols)).toEqual([
      '3-3 variable DEFAULT_LIMIT (exported)',
      '4-4 variable counter (exported)',
      '7-9 function fetchUser (exported)',
      '11-11 function normalise',
      '13-15 function pages (exported)',
      '17-24 class Repository (exported)',
      '18-18 method Repository.find',
      '19-19 method Repository.create',
      '20-20 method Repository.size',
      '21-21 method Repository.size',
      '22-22 method Repository.onChange',
      '23-23 method Repository.#secret',
      '26-26 enum Status (exported)',
      '28-28 interface User (exported)',
      '29-29 type UserId (exported)',
      '31-33 namespace Paths (exported)',
      '32-32 function Paths.join (exported)',
      '35-37 class default (exported)',
      '36-36 method default.run',
    ])
  })

  it('captures a TSX component written as an arrow function, and anonymous default exports', async () => {
    const src = lines(
      "import { useState } from 'react'",
      '',
      'export const Counter = ({ start }: { start: number }) => {',
      '  const [n, setN] = useState(start)',
      '  const increment = () => setN(n + 1)',
      '  return <button onClick={increment}>{n}</button>',
      '}',
      '',
      'export default () => <Counter start={1} />',
    )
    const result = await extractStructure('typescript', src, 'client/src/Counter.tsx')
    expect(brief(result.symbols)).toEqual(['3-7 function Counter (exported)', '9-9 function default (exported)'])
  })

  it('captures the declarations of a .d.ts: an ambient module is a namespace, `declare global` members have parent `global`', async () => {
    const src = lines(
      'declare module "frida" {',
      '  export interface Session { detach(): void }',
      '  export type Pid = number',
      '}',
      'declare global {',
      '  interface Window { elara: string }',
      '}',
    )
    const result = await extractStructure('typescript', src, 'src/frida/bindings.d.ts')
    expect(brief(result.symbols)).toEqual([
      '1-4 namespace frida',
      '2-2 interface frida.Session (exported)',
      '3-3 type frida.Pid (exported)',
      '6-6 interface global.Window',
    ])
  })

  it('does not capture functions, classes or consts declared inside a body', async () => {
    const src = lines(
      'export function outer() {',
      '  function inner() { return 1 }',
      '  const helper = () => inner()',
      '  class Local { m() {} }',
      '  return helper()',
      '}',
      '',
      'export const make = () => {',
      '  function nested() {}',
      '  return { method() { return nested() } }',
      '}',
    )
    const result = await extractStructure('typescript', src, 'src/nested.ts')
    expect(brief(result.symbols)).toEqual(['1-6 function outer (exported)', '8-11 function make (exported)'])
  })
})

describe('JavaScript definitions (#450)', () => {
  it('captures arrow functions, class methods and `exports.f =` functions; `module.exports = { f }` adds nothing', async () => {
    const src = lines(
      "'use strict'",
      '',
      'function parse(text) { return JSON.parse(text) }',
      'const format = (value) => JSON.stringify(value)',
      'var legacy = function () {}',
      '',
      'class Queue {',
      '  push(item) {}',
      '  static from(list) { return new Queue() }',
      '  drain = () => []',
      '}',
      '',
      'exports.loadConfig = async (path) => parse(path)',
      'module.exports.saveConfig = function (path, value) {}',
      'module.exports = { parse, format, Queue }',
    )
    const result = await extractStructure('javascript', src, 'lib/config.js')
    expect(brief(result.symbols)).toEqual([
      '3-3 function parse',
      '4-4 function format',
      '5-5 function legacy',
      '7-11 class Queue',
      '8-8 method Queue.push',
      '9-9 method Queue.from',
      '10-10 method Queue.drain',
      '13-13 function loadConfig (exported)',
      '14-14 function saveConfig (exported)',
    ])
  })
})

describe('Python and Go methods (#450)', () => {
  it('captures Python methods as `method` with their class, not as functions; nested defs are not symbols', async () => {
    const src = lines(
      'import os',
      '',
      'class Store:',
      '    def __init__(self, root):',
      '        self.root = root',
      '',
      '    @staticmethod',
      '    def default():',
      '        return Store(os.getcwd())',
      '',
      '    async def load(self, key):',
      '        def decode(raw):',
      '            return raw',
      '        return decode(key)',
      '',
      'def _private():',
      '    pass',
      '',
      '@cache',
      'def public():',
      '    class Inner:',
      '        def hidden(self): pass',
      '    return Inner',
    )
    const result = await extractStructure('python', src, 'pkg/store.py')
    expect(brief(result.symbols)).toEqual([
      '3-14 class Store (exported)',
      '4-5 method Store.__init__',
      '8-9 method Store.default',
      '11-14 method Store.load',
      '16-17 function _private',
      '20-23 function public (exported)',
    ])
  })

  it('captures Go receiver methods as `method` with the receiver type as parent', async () => {
    const src = lines(
      'package store',
      '',
      'type Repo[T any] struct{ items []T }',
      '',
      'func New() *Repo[int] { return &Repo[int]{} }',
      '',
      'func (r *Repo[T]) Get(i int) T { return r.items[i] }',
      '',
      'func (Repo[T]) size() int {',
      '\ttype local struct{}',
      '\treturn 0',
      '}',
    )
    const result = await extractStructure('go', src, 'store/repo.go')
    expect(brief(result.symbols)).toEqual([
      '3-3 type Repo (exported)',
      '5-5 function New (exported)',
      '7-7 method Repo.Get',
      '9-12 method Repo.size',
    ])
  })
})
