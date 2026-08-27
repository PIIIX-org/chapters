import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, renderHook } from '@testing-library/react'
import { useLiveNote } from './useLiveNote.js'

/**
 * `EventSource` is stubbed at the global boundary — happy-dom would give us a
 * real network client and these tests are about the four-state machine, not
 * about SSE framing. Every handler the hook assigns is driven by hand.
 */
class FakeEventSource {
  static readonly CONNECTING = 0
  static readonly OPEN = 1
  static readonly CLOSED = 2
  static instances: FakeEventSource[] = []

  readyState: number = FakeEventSource.CONNECTING
  closed = false
  onopen: (() => void) | null = null
  onmessage: ((event: { data: string }) => void) | null = null
  onerror: (() => void) | null = null

  constructor(
    readonly url: string,
    readonly init?: { withCredentials?: boolean },
  ) {
    FakeEventSource.instances.push(this)
  }

  close() {
    this.closed = true
    this.readyState = FakeEventSource.CLOSED
  }

  /* --- drivers, standing in for the server --- */

  open() {
    this.readyState = FakeEventSource.OPEN
    act(() => this.onopen?.())
  }

  send(data: string) {
    act(() => this.onmessage?.({ data }))
  }

  /** A blip: the browser is already retrying on its own. */
  drop() {
    this.readyState = FakeEventSource.CONNECTING
    act(() => this.onerror?.())
  }

  /** The retry 404'd — access is gone and EventSource has given up. */
  giveUp() {
    this.readyState = FakeEventSource.CLOSED
    act(() => this.onerror?.())
  }
}

vi.stubGlobal('EventSource', FakeEventSource)

const FRAME = { frontmatter: { title: 'Kintsugi' }, body: 'the seam is the point' }

function mount(overrides: Partial<Parameters<typeof useLiveNote>[0]> = {}) {
  const view = renderHook(() =>
    useLiveNote({ vaultId: 'v-1', path: 'notes/kintsugi.md', enabled: true, ...overrides }),
  )
  return { view, source: FakeEventSource.instances[0] }
}

beforeEach(() => {
  FakeEventSource.instances.length = 0
})

afterEach(() => {
  vi.clearAllMocks()
})

describe('useLiveNote', () => {
  it('opens the vault live stream with the session cookie, and waits', () => {
    const { view, source } = mount()

    expect(source?.url).toBe('/api/vaults/v-1/live/notes/kintsugi.md')
    expect(source?.init?.withCredentials).toBe(true)
    expect(view.result.current.status).toBe('connecting')
    expect(view.result.current.state).toBeNull()
  })

  it('is live once the first frame lands, and carries the note it sent', () => {
    const { view, source } = mount()

    source!.open()
    expect(view.result.current.status).toBe('live')

    source!.send(JSON.stringify(FRAME))

    expect(view.result.current.status).toBe('live')
    expect(view.result.current.state).toEqual(FRAME)
  })

  it('a drop after the stream was open is reconnecting', () => {
    const { view, source } = mount()
    source!.open()
    source!.send(JSON.stringify(FRAME))

    source!.drop()

    expect(view.result.current.status).toBe('reconnecting')
    // The last frame stays on screen — it is all the reader has.
    expect(view.result.current.state).toEqual(FRAME)
  })

  it('a drop before the stream ever opened is still connecting, not reconnecting', () => {
    const { view, source } = mount()

    source!.drop()

    // Nothing has ever arrived, so calling this a *re*connect would claim a
    // session the reader never had.
    expect(view.result.current.status).toBe('connecting')
  })

  it('ends for good when EventSource gives up — access was pulled', () => {
    const { view, source } = mount()
    source!.open()
    source!.send(JSON.stringify(FRAME))

    source!.giveUp()

    expect(view.result.current.status).toBe('ended')
    expect(view.result.current.status).not.toBe('reconnecting')
  })

  it('a frame it cannot read stops claiming live instead of freezing on stale content', () => {
    const { view, source } = mount()
    source!.open()
    source!.send(JSON.stringify(FRAME))

    // A proxy split the `data:` line, or the server wrote something else.
    expect(() => source!.send('{"body": "truncated mid-fra')).not.toThrow()

    // The reader keeps the last good note, but is no longer told it is current.
    expect(view.result.current.state).toEqual(FRAME)
    expect(view.result.current.status).toBe('reconnecting')

    // ...and the next good frame recovers.
    const next = { frontmatter: {}, body: 'a later sentence' }
    source!.send(JSON.stringify(next))
    expect(view.result.current.state).toEqual(next)
    expect(view.result.current.status).toBe('live')
  })

  it('never opens a stream for an editor — they join the Yjs doc instead', () => {
    const { view } = mount({ enabled: false })

    expect(FakeEventSource.instances).toHaveLength(0)
    expect(view.result.current.status).toBe('connecting')
  })

  it('closes the stream on unmount', () => {
    const { view, source } = mount()

    view.unmount()

    expect(source?.closed).toBe(true)
  })
})
