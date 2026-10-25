// #464: structure for Rust, Java, C, C++, C#, Kotlin, Ruby and PHP, on the
// #450 contract: module-level declarations, the methods (and public or
// static fields) of module-level classes with their class in `parent`,
// namespace members with their namespace; nothing nested in a body. Each
// fixture under fixtures/languages is a small real-code file.
import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { extractStructure, isSupportedLanguage, type ExtractedSymbol } from '../src/repositories/extraction.js'
import { detectLanguage } from '../src/repositories/language.js'

const fixture = (name: string) => readFileSync(new URL(`./fixtures/languages/${name}`, import.meta.url), 'utf8')
/** The fields a reader sees, in document order: `parent` only when there is one. */
const brief = (symbols: ExtractedSymbol[]) =>
  symbols.map((s) => `${s.startLine}-${s.endLine} ${s.kind} ${s.parent ? `${s.parent}.` : ''}${s.name}${s.exported ? ' (exported)' : ''}`)

/** Labels the fixture by its extension, as a sync does, and extracts it. */
async function extract(name: string) {
  const path = `src/${name}`
  const language = detectLanguage(path)
  expect(language !== null && isSupportedLanguage(language)).toBe(true)
  const result = await extractStructure(language!, fixture(name), path)
  return { symbols: brief(result.symbols), imports: result.imports.map((i) => `${i.line} ${i.target}`) }
}

describe('labels (#464)', () => {
  it('labels the new languages by extension, and Markdown and HTML', () => {
    expect(
      ['a.rs', 'A.java', 'a.c', 'a.h', 'a.cpp', 'a.cc', 'a.cxx', 'a.hpp', 'a.hh', 'A.cs', 'A.kt', 'a.kts', 'a.rb', 'a.php', 'README.md', 'a.markdown', 'a.html', 'a.htm'].map(
        detectLanguage,
      ),
    ).toEqual(['rust', 'java', 'c', 'c', 'cpp', 'cpp', 'cpp', 'cpp', 'cpp', 'csharp', 'kotlin', 'kotlin', 'ruby', 'php', 'markdown', 'markdown', 'html', 'html'])
  })

  it('parses the new languages; Swift, Markdown and HTML get no symbols', () => {
    for (const language of ['rust', 'java', 'c', 'cpp', 'csharp', 'kotlin', 'ruby', 'php']) expect(isSupportedLanguage(language)).toBe(true)
    for (const language of ['swift', 'markdown', 'html']) expect(isSupportedLanguage(language)).toBe(false)
  })
})

describe('Rust (#464)', () => {
  it('captures fn, struct, enum, trait, type, const/static, mod and impl/trait methods; `use` paths are imports', async () => {
    const { symbols, imports } = await extract('store.rs')
    expect(symbols).toEqual([
      '5-5 variable MAX_ITEMS (exported)',
      '6-6 variable COUNTER',
      '10-12 class Store (exported)',
      '14-17 enum Event (exported)',
      '19-24 interface Backend (exported)',
      '20-20 method Backend.load',
      '21-23 method Backend.save',
      '26-26 type Shared (exported)',
      '29-33 method Store.new',
      '35-37 method Store.get',
      '41-43 method Store.load',
      '46-49 function open',
      '51-55 namespace tests (exported)',
      '52-54 function tests.fixture (exported)',
    ])
    expect(imports).toEqual(['1 std::collections::HashMap', '2 crate::index', '3 super::codec::Codec'])
  })

  it("names an impl for a reference or a path by its type: `impl IntoIterator for &'a Store` gives `Store` methods", async () => {
    const src = [
      "impl<'a> IntoIterator for &'a Store {",
      '    fn into_iter(self) -> Iter<\'a> { todo!() }',
      '}',
      'impl Default for crate::store::Store {',
      '    fn default() -> Self { todo!() }',
      '}',
    ].join('\n')
    const result = await extractStructure('rust', src, 'src/iter.rs')
    expect(brief(result.symbols)).toEqual(['2-2 method Store.into_iter', '5-5 method Store.default'])
  })

  it('a use list straight under crate/self/super imports one module per item; `mod x;` loads the module file x', async () => {
    const src = ['mod codec;', 'pub mod disk;', 'mod inline { fn f() {} }', 'use crate::{index, store::Store, self as root};', 'use super::{self, codec::Codec};', 'use crate::store::{A, B};'].join('\n')
    const result = await extractStructure('rust', src, 'src/store/mod.rs')
    expect(result.imports.map((i) => `${i.line} ${i.target}`)).toEqual([
      '1 codec',
      '2 disk',
      '4 crate::index',
      '4 crate::store::Store',
      '5 super::codec::Codec',
      '6 crate::store',
    ])
  })
})

describe('Java (#464)', () => {
  it('captures classes, interfaces, enums, records, methods and public or static fields; imports', async () => {
    const { symbols, imports } = await extract('Store.java')
    expect(symbols).toEqual([
      '9-29 class Store (exported)',
      '11-11 variable Store.MAX_ITEMS',
      '15-19 method Store.Store',
      '21-24 method Store.load',
      '31-37 interface Backend',
      '32-32 variable Backend.NAME',
      '34-34 method Backend.load',
      '36-36 method Backend.close',
      '39-45 enum Event',
      '42-44 method Event.destructive',
      '47-49 class Pair',
      '48-48 method Pair.size',
    ])
    expect(imports).toEqual(['3 java.util.HashMap', '4 java.util.Map', '5 com.example.index.Entry', '6 com.example.index.Keys.normalize'])
  })
})

describe('C and C++ (#464)', () => {
  it('captures a header: typedefs, structs, enums and prototypes; quoted includes only', async () => {
    const { symbols, imports } = await extract('store.h')
    expect(symbols).toEqual([
      '9-11 type Buffer (exported)',
      '13-16 class store (exported)',
      '18-18 enum event (exported)',
      '20-20 function store_open (exported)',
      '21-21 function store_count (exported)',
    ])
    expect(imports).toEqual(['5 codec.h'])
  })

  it('captures C functions; a prototype the file defines is not a second symbol; `static` is not exported', async () => {
    const { symbols, imports } = await extract('store.c')
    expect(symbols).toEqual(['7-12 function store_open (exported)', '14-16 function store_count (exported)', '18-20 function helper'])
    expect(imports).toEqual(['2 store.h', '3 ../util/log.h'])
  })

  it('captures C++ namespaces, classes, structs, enums, in-class and out-of-line methods', async () => {
    const { symbols, imports } = await extract('store.cpp')
    expect(symbols).toEqual([
      '5-40 namespace elara (exported)',
      '6-10 namespace elara.detail (exported)',
      '8-8 function detail.hash (exported)',
      '13-26 class elara.Store (exported)',
      '15-15 method Store.Store',
      '17-19 method Store.save',
      '28-30 class elara.Options (exported)',
      '32-32 enum elara.Event (exported)',
      '35-38 method Store.load',
      '42-42 function run',
      '44-47 function main (exported)',
    ])
    expect(imports).toEqual(['3 store.hpp'])
  })

  it('names an out-of-line method by its innermost scope: `void ns::Store::load()` is `Store.load`, one symbol with its in-class prototype', async () => {
    const src = [
      'namespace ns {',
      'class Store {',
      ' public:',
      '  void load();',
      '};',
      '}',
      'void ns::Store::load() {}',
      'void ns::outer::Inner::run() {}',
    ].join('\n')
    const { symbols } = await extractStructure('cpp', src, 'src/store.cc')
    expect(brief(symbols)).toEqual(['1-6 namespace ns (exported)', '2-5 class ns.Store (exported)', '7-7 method Store.load', '8-8 method Inner.run'])
  })

  it('captures a C function returning a pointer to a pointer', async () => {
    const { symbols } = await extractStructure('c', 'char **split(const char *s) { return 0; }\nstatic int **table(void) { return 0; }\n', 'src/split.c')
    expect(brief(symbols)).toEqual(['1-1 function split (exported)', '2-2 function table'])
  })

  it('parses a `.h` header with the C++ grammar: a C++ class header keeps its class, namespace and methods', async () => {
    const src = ['#pragma once', 'namespace db {', 'class DBImpl : public DB {', ' public:', '  Status Get(const Slice& key);', '};', '}'].join('\n')
    const { symbols } = await extractStructure('c', src, 'db/db_impl.h')
    expect(brief(symbols)).toEqual(['2-7 namespace db (exported)', '3-6 class db.DBImpl (exported)', '5-5 method DBImpl.Get'])
  })
})

describe('C# (#464)', () => {
  it('captures namespaces, types, methods, public or static fields and properties', async () => {
    const { symbols, imports } = await extract('Store.cs')
    expect(symbols).toEqual([
      '4-49 namespace Elara.Storage (exported)',
      '6-6 type Changed (exported)',
      '9-33 class Store (exported)',
      '12-12 variable Store.MaxItems',
      '14-14 variable Store.Instances',
      '16-16 variable Store.Root',
      '18-21 method Store.Store',
      '23-27 method Store.Load',
      '35-38 interface IBackend (exported)',
      '37-37 method IBackend.Load',
      '40-40 enum Event',
      '42-46 class Options (exported)',
      '44-44 variable Options.Sync',
      '45-45 method Options.ToString',
      '48-48 class Pair (exported)',
    ])
    expect(imports).toEqual([])
  })

  it('a file-scoped namespace holds its types the same way', async () => {
    const { symbols } = await extract('Codec.cs')
    expect(symbols).toEqual(['1-1 namespace Elara.Codecs (exported)', '3-6 class Codec (exported)', '5-5 method Codec.Encode'])
  })
})

describe('Kotlin (#464)', () => {
  it('captures classes, interfaces, enums, objects, companion members, functions, properties and type aliases; imports', async () => {
    const { symbols, imports } = await extract('Store.kt')
    expect(symbols).toEqual([
      '7-7 variable MAX_ITEMS (exported)',
      '11-28 class Store (exported)',
      '13-13 variable Store.size',
      '16-19 method Store.load',
      '22-22 method Store.create',
      '30-32 interface Backend (exported)',
      '31-31 method Backend.load',
      '34-34 enum Event (exported)',
      '36-38 class Registry (exported)',
      '37-37 method Registry.register',
      '40-40 type Stores (exported)',
      '42-42 function open (exported)',
    ])
    expect(imports).toEqual(['3 com.example.index.Entry', '4 kotlinx.coroutines.flow.*', '5 com.example.codec.Codec'])
  })
})

describe('Ruby (#464)', () => {
  it('captures modules as namespaces, classes, methods, `def self.x` and `class << self`; require_relative', async () => {
    const { symbols, imports } = await extract('store.rb')
    expect(symbols).toEqual([
      '7-46 namespace Elara (exported)',
      '8-41 namespace Elara.Storage (exported)',
      '11-13 method Storage.open',
      '15-40 class Storage.Store (exported)',
      '18-20 method Store.initialize',
      '22-25 method Store.load',
      '27-29 method Store.default',
      '32-34 method Store.instances',
      '39-39 method Store.helper',
      '43-45 method Elara.mixin_method',
      '48-51 function top_level (exported)',
    ])
    expect(imports).toEqual(['2 codec', '3 ../lib/index.rb'])
  })
})

describe('PHP (#464)', () => {
  it('captures functions, classes, interfaces, traits, enums and methods; literal require/include', async () => {
    const { symbols, imports } = await extract('Store.php')
    expect(symbols).toEqual([
      '3-3 namespace App\\Storage (exported)',
      '13-16 interface Backend (exported)',
      '15-15 method Backend.load',
      '18-21 class Logs (exported)',
      '20-20 method Logs.log',
      '24-43 class Store (exported)',
      '31-31 method Store.__construct',
      '33-37 method Store.load',
      '39-42 method Store.open',
      '45-50 enum Event (exported)',
      '49-49 method Event.label',
      '52-56 function open_store (exported)',
    ])
    expect(imports).toEqual(['5 codec.php', '7 vendor/autoload.php'])
  })
})
