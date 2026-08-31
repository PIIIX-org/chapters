import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  MAX_RECENTS,
  RECENTS_STORAGE_KEY,
  pushRecent,
  readRecents,
  recentsStore,
  type Recent,
} from './recents'

function recent(n: number, kind: Recent['kind'] = 'note'): Recent {
  return { kind, label: `note-${n}`, path: `/vaults/v1/notes/type/n${n}` }
}

beforeEach(() => {
  localStorage.clear()
  recentsStore.reset()
})

afterEach(() => {
  vi.restoreAllMocks()
})

describe('pushRecent', () => {
  it('puts the newest entry first', () => {
    const list = pushRecent([recent(1)], recent(2))
    expect(list.map((r) => r.label)).toEqual(['note-2', 'note-1'])
  })

  it('dedupes by path: revisiting moves the entry to the front instead of duplicating it', () => {
    const start = [recent(1), recent(2), recent(3)]
    const list = pushRecent(start, recent(2))
    expect(list.map((r) => r.label)).toEqual(['note-2', 'note-1', 'note-3'])
    expect(list).toHaveLength(3)
  })

  it(`caps the list at ${MAX_RECENTS}`, () => {
    let list: Recent[] = []
    for (let i = 0; i < MAX_RECENTS + 3; i++) list = pushRecent(list, recent(i))
    expect(list).toHaveLength(MAX_RECENTS)
    // The oldest entries fell off, newest survives at the front.
    expect(list[0]?.label).toBe(`note-${MAX_RECENTS + 2}`)
    expect(list.at(-1)?.label).toBe('note-3')
  })
})

describe('readRecents', () => {
  it('returns an empty list when nothing is stored', () => {
    expect(readRecents()).toEqual([])
  })

  it('returns an empty list on corrupt JSON instead of throwing', () => {
    localStorage.setItem(RECENTS_STORAGE_KEY, '{not json')
    expect(readRecents()).toEqual([])
  })

  it('returns an empty list when the stored value is not an array', () => {
    localStorage.setItem(RECENTS_STORAGE_KEY, JSON.stringify({ kind: 'note' }))
    expect(readRecents()).toEqual([])
  })

  it('drops malformed entries and keeps the valid ones', () => {
    localStorage.setItem(
      RECENTS_STORAGE_KEY,
      JSON.stringify([
        recent(1),
        { kind: 'wormhole', label: 'x', path: '/x' }, // unknown kind
        { kind: 'vault', label: '', path: '/vaults/v9' }, // empty label
        { kind: 'vault', label: 'Recipes' }, // missing path
        'garbage',
        recent(2, 'vault'),
      ]),
    )
    expect(readRecents().map((r) => r.label)).toEqual(['note-1', 'note-2'])
  })

  it('caps an over-long stored list at the maximum', () => {
    const stored = Array.from({ length: MAX_RECENTS + 5 }, (_, i) => recent(i))
    localStorage.setItem(RECENTS_STORAGE_KEY, JSON.stringify(stored))
    expect(readRecents()).toHaveLength(MAX_RECENTS)
  })

  it('returns an empty list when storage access throws (privacy mode)', () => {
    vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => {
      throw new DOMException('denied', 'SecurityError')
    })
    expect(readRecents()).toEqual([])
  })
})

describe('recentsStore', () => {
  it('record() persists under the chapters.recents key and get() returns the new list', () => {
    recentsStore.record(recent(1))
    recentsStore.record(recent(2, 'vault'))

    expect(recentsStore.get().map((r) => r.label)).toEqual(['note-2', 'note-1'])
    const stored = JSON.parse(localStorage.getItem(RECENTS_STORAGE_KEY) ?? '[]') as Recent[]
    expect(stored.map((r) => r.label)).toEqual(['note-2', 'note-1'])
  })

  it('returns a referentially stable snapshot between writes (useSyncExternalStore contract)', () => {
    recentsStore.record(recent(1))
    const first = recentsStore.get()
    expect(recentsStore.get()).toBe(first)
    recentsStore.record(recent(2))
    expect(recentsStore.get()).not.toBe(first)
  })

  it('notifies subscribers on record, and unsubscribing stops it', () => {
    const listener = vi.fn()
    const unsubscribe = recentsStore.subscribe(listener)
    recentsStore.record(recent(1))
    expect(listener).toHaveBeenCalledTimes(1)
    unsubscribe()
    recentsStore.record(recent(2))
    expect(listener).toHaveBeenCalledTimes(1)
  })

  it('still updates the in-memory list when persisting throws (quota)', () => {
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new DOMException('quota', 'QuotaExceededError')
    })
    expect(() => recentsStore.record(recent(1))).not.toThrow()
    expect(recentsStore.get().map((r) => r.label)).toEqual(['note-1'])
  })

  it('clear() empties the cache and removes the stored key', () => {
    recentsStore.record(recent(1))
    recentsStore.clear()
    expect(recentsStore.get()).toEqual([])
    expect(localStorage.getItem(RECENTS_STORAGE_KEY)).toBeNull()
  })
})
