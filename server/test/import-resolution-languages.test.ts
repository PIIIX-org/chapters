// #464: the imports the new languages write resolve to repository files the
// way each language finds them; anything else (a standard library, an
// external crate, gem or package, a system header) stays unresolved.
import { describe, expect, it } from 'vitest'
import { resolveImportPath } from '../src/repositories/import-resolution.js'

const known = new Set([
  // Rust: a crate with modules as files and as directories.
  'crates/core/src/lib.rs',
  'crates/core/src/index.rs',
  'crates/core/src/store/mod.rs',
  'crates/core/src/store/codec.rs',
  'crates/core/src/store/disk.rs',
  // Java and Kotlin, by package directory.
  'app/src/main/java/com/example/store/Store.java',
  'app/src/main/java/com/example/index/Entry.java',
  'app/src/main/java/com/example/index/Keys.java',
  'app/src/main/kotlin/com/example/codec/Codec.kt',
  // C and C++.
  'native/store.c',
  'native/store.h',
  'native/util/log.h',
  'native/cpp/store.hpp',
  // Ruby and PHP.
  'lib/elara/store.rb',
  'lib/elara/codec.rb',
  'lib/index.rb',
  'web/src/Store.php',
  'web/src/codec.php',
  'web/src/vendor/autoload.php',
])
const resolve = (source: string, specifier: string) => resolveImportPath(source, specifier, known)

describe('Rust `use` (#464)', () => {
  it('resolves crate::, self:: and super:: paths to the module file, as file or directory', () => {
    expect(resolve('crates/core/src/lib.rs', 'crate::index')).toBe('crates/core/src/index.rs')
    expect(resolve('crates/core/src/lib.rs', 'crate::store::Store')).toBe('crates/core/src/store/mod.rs')
    expect(resolve('crates/core/src/lib.rs', 'crate::store::codec::Codec')).toBe('crates/core/src/store/codec.rs')
    expect(resolve('crates/core/src/store/mod.rs', 'self::disk::Disk')).toBe('crates/core/src/store/disk.rs')
    expect(resolve('crates/core/src/store/disk.rs', 'super::codec::Codec')).toBe('crates/core/src/store/codec.rs')
    expect(resolve('crates/core/src/store/disk.rs', 'crate::index::Entry')).toBe('crates/core/src/index.rs')
  })

  it('resolves a path relative to the current module (2018 uniform paths), and a `mod x;` name to its file', () => {
    expect(resolve('crates/core/src/lib.rs', 'store::codec')).toBe('crates/core/src/store/codec.rs')
    expect(resolve('crates/core/src/lib.rs', 'store')).toBe('crates/core/src/store/mod.rs')
    expect(resolve('crates/core/src/store/mod.rs', 'disk')).toBe('crates/core/src/store/disk.rs')
  })

  it('leaves std and external crates unresolved', () => {
    expect(resolve('crates/core/src/lib.rs', 'std::collections::HashMap')).toBeNull()
    expect(resolve('crates/core/src/lib.rs', 'serde::Deserialize')).toBeNull()
    expect(resolve('crates/core/src/lib.rs', 'crate::missing::Thing')).toBeNull()
  })
})

describe('Java and Kotlin `import` (#464)', () => {
  it('resolves a class by its package path, a static member by its class, across both languages', () => {
    const source = 'app/src/main/java/com/example/store/Store.java'
    expect(resolve(source, 'com.example.index.Entry')).toBe('app/src/main/java/com/example/index/Entry.java')
    expect(resolve(source, 'com.example.index.Keys.normalize')).toBe('app/src/main/java/com/example/index/Keys.java')
    expect(resolve(source, 'com.example.codec.Codec')).toBe('app/src/main/kotlin/com/example/codec/Codec.kt')
    expect(resolve('app/src/main/kotlin/com/example/codec/Codec.kt', 'com.example.store.Store')).toBe(
      'app/src/main/java/com/example/store/Store.java',
    )
  })

  it('leaves the JDK, libraries and wildcard imports unresolved', () => {
    const source = 'app/src/main/java/com/example/store/Store.java'
    expect(resolve(source, 'java.util.HashMap')).toBeNull()
    expect(resolve(source, 'com.example.index.*')).toBeNull()
    expect(resolve('app/src/main/kotlin/com/example/codec/Codec.kt', 'kotlinx.coroutines.flow.*')).toBeNull()
  })
})

describe('C and C++ `#include "x"` (#464)', () => {
  it('resolves relative to the including file only', () => {
    expect(resolve('native/store.c', 'store.h')).toBe('native/store.h')
    expect(resolve('native/store.c', 'util/log.h')).toBe('native/util/log.h')
    expect(resolve('native/cpp/store.cpp', 'store.hpp')).toBe('native/cpp/store.hpp')
    expect(resolve('native/cpp/store.cpp', '../store.h')).toBe('native/store.h')
    expect(resolve('native/cpp/store.cpp', 'log.h')).toBeNull()
  })
})

describe('Ruby require_relative and PHP require/include (#464)', () => {
  it('Ruby: relative to the file, `.rb` optional', () => {
    expect(resolve('lib/elara/store.rb', 'codec')).toBe('lib/elara/codec.rb')
    expect(resolve('lib/elara/store.rb', '../index.rb')).toBe('lib/index.rb')
    expect(resolve('lib/elara/store.rb', 'missing')).toBeNull()
  })

  it('PHP: relative to the file', () => {
    expect(resolve('web/src/Store.php', 'codec.php')).toBe('web/src/codec.php')
    expect(resolve('web/src/Store.php', 'vendor/autoload.php')).toBe('web/src/vendor/autoload.php')
    expect(resolve('web/src/Store.php', 'missing.php')).toBeNull()
  })
})
