import { useEffect, useState } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { act, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { expectNoA11yViolations } from '../../test/axe'
import { createMemoryRouter, Outlet, RouterProvider } from 'react-router'
import * as Y from 'yjs'
import { EditorView } from '@codemirror/view'
import { mockJsonResponse } from '../../lib/api'
import { getCollabTicket } from '../../api/collab.js'
import type { Vault } from '../../api/vaults'
import { ShellProvider } from '../../components/shell/ShellProvider'
import { useShell } from '../../components/shell/shell-context'
import { NoteView } from './NoteView'

const EDIT_VAULT: Vault = { id: 'v1', name: 'V1', ownerId: 'u1', mergeable: false, access: 'edit' }
const READ_VAULT: Vault = { id: 'v1', name: 'V1', ownerId: 'u1', mergeable: false, access: 'read' }
const OWNER_VAULT: Vault = { id: 'v1', name: 'V1', ownerId: 'u1', mergeable: false, access: 'owner' }

/* ------------------------------------------------------------------ *
 * The two transports, stubbed at the module/global boundary. Between
 * them they are the whole point of this file: exactly one may be open
 * for a given note, and which one is decided by access.
 * ------------------------------------------------------------------ */

interface ProviderOptions {
  url: string
  name: string
  document: Y.Doc
  token: () => Promise<string>
  onStatus: (data: { status: string }) => void
  onAuthenticationFailed: (data: { reason: string }) => void
  onSynced: (data: { state: boolean }) => void
  onUnsyncedChanges: (data: { number: number }) => void
  onAwarenessChange: (data: {
    states: { clientId: number; user?: { id: string; name: string } }[]
  }) => void
}

const stub = vi.hoisted(() => ({
  providers: [] as { options: ProviderOptions; fields: Record<string, unknown> }[],
}))

vi.mock('@hocuspocus/provider', () => {
  class HocuspocusProvider {
    options: ProviderOptions
    /** The duck-typed shape `yCollab` reads; a real Awareness needs
     *  y-protocols, which pnpm keeps out of this package. */
    awareness = {
      doc: { clientID: 7 },
      clientID: 7,
      getLocalState: () => null,
      setLocalStateField: () => {},
      getStates: () => new Map(),
      on: () => {},
      off: () => {},
    }
    isSynced = false
    hasUnsyncedChanges = false
    fields: Record<string, unknown> = {}

    constructor(options: ProviderOptions) {
      this.options = options
      stub.providers.push(this)
    }

    setAwarenessField(field: string, value: unknown) {
      this.fields[field] = value
    }
    disconnect() {}
    destroy() {}
  }

  return {
    HocuspocusProvider,
    WebSocketStatus: { Connecting: 'connecting', Connected: 'connected', Disconnected: 'disconnected' },
  }
})

vi.mock('../../api/collab.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../api/collab.js')>()),
  getCollabTicket: vi.fn(),
}))

const ticket = vi.mocked(getCollabTicket)

class FakeEventSource {
  static readonly CONNECTING = 0
  static readonly OPEN = 1
  static readonly CLOSED = 2
  static instances: FakeEventSource[] = []

  readyState: number = FakeEventSource.CONNECTING
  onopen: (() => void) | null = null
  onmessage: ((event: { data: string }) => void) | null = null
  onerror: (() => void) | null = null

  constructor(readonly url: string) {
    FakeEventSource.instances.push(this)
  }

  close() {
    this.readyState = FakeEventSource.CLOSED
  }

  open() {
    this.readyState = FakeEventSource.OPEN
    act(() => this.onopen?.())
  }

  /** One SSE frame: the whole note, as `server/src/sync/routes.ts` sends it. */
  send(frame: { frontmatter: Record<string, unknown>; body: string }) {
    act(() => this.onmessage?.({ data: JSON.stringify(frame) }))
  }
}

vi.stubGlobal('EventSource', FakeEventSource)

/* ------------------------------------------------------------------ */

const NOTE = {
  path: 'people/jane',
  frontmatter: { type: 'people', resource: 'https://kintsugi.test/ada' },
  body: 'the REST copy',
  updatedAt: '2026-01-01',
}

const ME = {
  id: 'u1',
  email: 'taha@kintsugi.test',
  status: 'active',
  role: 'member',
  createdAt: '2026-01-01',
  mfaEnabledAt: null,
  mfaRequired: false,
}

function stubFetch(note: unknown = NOTE, noteStatus = 200) {
  const fetchMock = vi.fn().mockImplementation((url: string) => {
    if (url.endsWith('/me')) return Promise.resolve(mockJsonResponse(200, ME))
    if (url.endsWith('/tree')) return Promise.resolve(mockJsonResponse(200, {}))
    return Promise.resolve(mockJsonResponse(noteStatus, note))
  })
  vi.stubGlobal('fetch', fetchMock)
  return fetchMock
}

function putCalls(fetchMock: ReturnType<typeof vi.fn>) {
  return fetchMock.mock.calls.filter(([, init]) => (init as RequestInit | undefined)?.method === 'PUT')
}

/** What the shell's top bar would render: the status a page published. */
function ShellStatusProbe() {
  const { status } = useShell()
  return <div data-testid="shell-status">{status ? `${status.tone}:${status.label}` : 'none'}</div>
}

// No default: passing `undefined` must stay undefined (a value default would
// swallow it), so the unknown-access → reader path can be tested for real.
function renderNote(
  vault: Vault | undefined,
  initialPath = '/vaults/v1/notes/people/jane',
  { shell = false } = {},
) {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  // The outlet context is stateful so a test can change the *reported* access
  // of an already-open note, which is what a window-focus refetch of
  // `useVaults` does after the owner revokes a share.
  const publish: { current: (next: Vault | undefined) => void } = { current: () => {} }
  function VaultContext() {
    const [current, setCurrent] = useState(vault)
    useEffect(() => {
      publish.current = setCurrent
    }, [])
    return <Outlet context={current} />
  }
  const router = createMemoryRouter(
    [
      {
        path: '/vaults/:vaultId',
        element: <VaultContext />,
        children: [{ path: 'notes/*', element: <NoteView /> }],
      },
    ],
    { initialEntries: [initialPath] },
  )
  const page = shell ? (
    // A real ShellProvider, not a stub: the probe reads the same context the
    // top bar does, so this fails if the page stops publishing its status.
    <ShellProvider>
      <ShellStatusProbe />
      <RouterProvider router={router} />
    </ShellProvider>
  ) : (
    <RouterProvider router={router} />
  )
  const utils = render(<QueryClientProvider client={queryClient}>{page}</QueryClientProvider>)
  return { ...utils, router, reportAccess: (next: Vault | undefined) => act(() => publish.current(next)) }
}

/** The relay's side of the connection: the Y.Doc it loaded the note into. */
async function relay() {
  await waitFor(() => expect(stub.providers).toHaveLength(1))
  const options = stub.providers[0]!.options
  act(() => options.onStatus({ status: 'connected' }))
  return {
    options,
    ydoc: options.document,
    /** What `onLoadDocument` does when the document opens. */
    load(body: string, frontmatter: Record<string, unknown> = {}) {
      act(() => {
        options.document.getText('body').insert(0, body)
        for (const [key, value] of Object.entries(frontmatter))
          options.document.getMap('frontmatter').set(key, value)
        options.onSynced({ state: true })
      })
    },
    /** A share revoked while the tab is open: the relay drops the socket. */
    kick() {
      act(() => options.onAuthenticationFailed({ reason: 'access revoked' }))
    },
  }
}

function editorView(): EditorView {
  return EditorView.findFromDOM(document.querySelector('.cm-editor') as HTMLElement)!
}

function bodyText(): string {
  return document.querySelector('.cm-content')?.textContent ?? ''
}

function contentEditable(): string | null {
  return document.querySelector('.cm-content')!.getAttribute('contenteditable')
}

beforeEach(() => {
  stub.providers.length = 0
  FakeEventSource.instances.length = 0
  ticket.mockResolvedValue({
    token: 't-1',
    url: 'ws://relay.test:3001',
    expiresAt: '2026-08-25T10:00:60.000Z',
  })
})

afterEach(() => {
  vi.unstubAllGlobals()
  vi.useRealTimers()
  vi.stubGlobal('EventSource', FakeEventSource)
})

describe('NoteView — editors take the collab path', () => {
  it('joins the note document and renders the body from the Y.Text, not the REST copy', async () => {
    stubFetch()
    renderNote(EDIT_VAULT)

    const doc = await relay()
    expect(doc.options.name).toBe('v1/people/jane')
    expect(doc.options.url).toBe('ws://relay.test:3001')
    // Editors never open the read-only stream: one transport per person.
    expect(FakeEventSource.instances).toHaveLength(0)

    doc.load('# Jane, merged by the relay', { type: 'people', resource: 'https://kintsugi.test/ada' })

    await waitFor(() => expect(bodyText()).toContain('# Jane, merged by the relay'))
    // The stale REST body is never inserted alongside it.
    expect(bodyText()).not.toContain('the REST copy')
    expect(contentEditable()).toBe('true')
    // The property panel is bound to the same document's frontmatter map.
    expect(screen.getByText('people')).toBeInTheDocument()
    expect(screen.getByDisplayValue('https://kintsugi.test/ada')).toBeInTheDocument()
    // Presence is labelled with the local part of the address, never the whole
    // one: until unit 4 adds display names, a full email here would be shown to
    // every co-editor in the note (unit 6 plan, gap 7).
    expect(stub.providers[0]!.fields.user).toMatchObject({ id: 'u1', name: 'taha' })
  })

  it('never PUTs — typing goes into the Y.Text and nowhere else (issue #66)', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true })
    const fetchMock = stubFetch()
    renderNote(EDIT_VAULT)

    const doc = await relay()
    doc.load('tail')
    await waitFor(() => expect(bodyText()).toContain('tail'))

    act(() => {
      editorView().dispatch({ changes: { from: 0, insert: 'head and ' } })
    })

    // Well past the 1.2s debounce this file used to run.
    await vi.advanceTimersByTimeAsync(3000)
    expect(putCalls(fetchMock)).toHaveLength(0)
    expect(doc.ydoc.getText('body').toString()).toBe('head and tail')
  })

  it('shows who else is in the note, in the breadcrumb', async () => {
    stubFetch()
    renderNote(EDIT_VAULT)

    const doc = await relay()
    act(() => {
      doc.options.onAwarenessChange({
        states: [
          { clientId: 7, user: { id: 'u1', name: 'taha' } },
          { clientId: 9, user: { id: 'u-ada', name: 'ada.lovelace' } },
        ],
      })
    })

    expect(screen.getByLabelText('ada.lovelace is editing this note')).toBeInTheDocument()
  })
})

describe('NoteView — a session that cannot write is locked', () => {
  it('turns the editor and the properties read-only when the relay kicks us', async () => {
    stubFetch()
    renderNote(EDIT_VAULT)

    const doc = await relay()
    doc.load('work in progress', { resource: 'https://kintsugi.test/ada' })
    await waitFor(() => expect(contentEditable()).toBe('true'))
    expect(screen.getByDisplayValue('https://kintsugi.test/ada')).not.toBeDisabled()

    doc.kick()

    // The lock follows `writable`, which covers 'offline' too — not
    // `status === 'revoked'`, which would leave 'offline' typing into a void.
    await waitFor(() => expect(contentEditable()).toBe('false'))
    expect(screen.getByDisplayValue('https://kintsugi.test/ada')).toBeDisabled()
  })

  it('says so inline, and leaves every unsent character on screen', async () => {
    stubFetch()
    renderNote(EDIT_VAULT)

    const doc = await relay()
    doc.load('saved so far')
    await waitFor(() => expect(bodyText()).toContain('saved so far'))
    act(() => {
      editorView().dispatch({ changes: { from: 0, insert: 'never sent — ' } })
    })

    doc.kick()

    await waitFor(() => expect(screen.getByText(/access to this note was removed/i)).toBeInTheDocument())
    // The one thing a kick must not do. `useCollabDoc` keeps the Y.Doc alive
    // precisely so this text is still here to be copied out.
    expect(bodyText()).toContain('never sent — ')
    expect(bodyText()).toContain('saved so far')
    expect(screen.getByText(/copy it somewhere safe/i)).toBeInTheDocument()
    // Inline, in the flow — not a dialog over the text it says to rescue.
    expect(screen.queryByRole('dialog')).toBeNull()
  })

  it('downgrades in place when the REPORTED access changes, keeping every unsent character', async () => {
    // The sequence that used to lose work: an editor is typing, the owner
    // revokes the share, the tab regains focus, React Query refetches
    // `useVaults` and reports the new access. Keying the editor on that access
    // unmounted it, `useCollabDoc`'s cleanup destroyed the Y.Doc, and the
    // stale REST body repainted over everything unsent.
    stubFetch()
    const { reportAccess } = renderNote(EDIT_VAULT)

    const doc = await relay()
    doc.load('synced so far', { resource: 'https://kintsugi.test/ada' })
    await waitFor(() => expect(bodyText()).toContain('synced so far'))
    act(() => {
      editorView().dispatch({ changes: { from: 0, insert: 'never sent — ' } })
    })

    reportAccess(READ_VAULT)

    // Downgraded, not remounted: locked editor, locked properties, the reason
    // said inline.
    await waitFor(() => expect(contentEditable()).toBe('false'))
    expect(screen.getByDisplayValue('https://kintsugi.test/ada')).toBeDisabled()
    expect(screen.getByText(/access to this note was removed/i)).toBeInTheDocument()

    // The same document, still alive, still holding the unsent text.
    expect(stub.providers).toHaveLength(1)
    expect(stub.providers[0]!.options.document).toBe(doc.ydoc)
    expect(doc.ydoc.isDestroyed).toBe(false)
    expect(bodyText()).toContain('never sent — synced so far')

    // And it never falls through to the reader transport, whose stale REST
    // body is what used to overwrite the screen.
    expect(FakeEventSource.instances).toHaveLength(0)
    expect(bodyText()).not.toContain('the REST copy')
  })

  it('whispers something different for offline than for revoked', async () => {
    // Not a 403: the ticket endpoint or the relay is down. Nothing was taken
    // away, and the copy must not claim it was.
    ticket.mockRejectedValue(new Error('relay unreachable'))
    stubFetch()
    renderNote(EDIT_VAULT)

    await waitFor(() => expect(screen.getByText(/staying in this tab/i)).toBeInTheDocument())
    const offline = screen.getByText(/staying in this tab/i).textContent!
    expect(screen.queryByText(/access to this note was removed/i)).toBeNull()
    expect(stub.providers).toHaveLength(0)
    // The lock that a `status === 'revoked'` check would miss: offline is not
    // revoked, and an unlocked editor here is someone typing into nothing.
    // Async: the whisper and the readOnly reconfigure land in different
    // renders, so waiting on the text alone raced the lock under CI load.
    await waitFor(() => expect(contentEditable()).toBe('false'))
    expect(screen.getByPlaceholderText(/ISO date/)).toBeDisabled()

    // Same tab, different cause.
    ticket.mockResolvedValue({ token: 't-2', url: 'ws://relay.test:3001', expiresAt: '2026-08-25T10:00:60.000Z' })
    renderNote(EDIT_VAULT, '/vaults/v1/notes/people/jane')
    const doc = await relay()
    doc.kick()

    await waitFor(() => expect(screen.getByText(/access removed/i)).toBeInTheDocument())
    expect(screen.getByText(/access removed/i).textContent).not.toBe(offline)
  })
})

describe('NoteView — readers take the SSE path', () => {
  it('opens the live stream instead of the document, and never joins it', async () => {
    stubFetch()
    renderNote(READ_VAULT)

    await waitFor(() => expect(FakeEventSource.instances).toHaveLength(1))
    expect(FakeEventSource.instances[0]!.url).toBe('/api/vaults/v1/live/people/jane')
    // The audit's presence rule, enforced structurally: a reader is not in the
    // Yjs document at all, so there is no awareness of them to leak.
    expect(stub.providers).toHaveLength(0)
    expect(await screen.findByText(/read-only/i)).toBeInTheDocument()
    expect(contentEditable()).toBe('false')
  })

  it('follows the frames: locked, but not stale', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true })
    const fetchMock = stubFetch()
    renderNote(READ_VAULT)

    await waitFor(() => expect(bodyText()).toContain('the REST copy'))
    const source = FakeEventSource.instances[0]!
    source.open()
    source.send({
      frontmatter: { type: 'people', resource: 'https://kintsugi.test/lovelace' },
      body: 'an editor just typed this',
    })

    await waitFor(() => expect(bodyText()).toContain('an editor just typed this'))
    expect(bodyText()).not.toContain('the REST copy')
    expect(screen.getByDisplayValue('https://kintsugi.test/lovelace')).toBeDisabled()
    expect(contentEditable()).toBe('false')

    await vi.advanceTimersByTimeAsync(3000)
    expect(putCalls(fetchMock)).toHaveLength(0)
  })

  it('takes the reader path when access is unknown', async () => {
    stubFetch()
    // No vault in outlet context → access unknown → conservative reader path.
    renderNote(undefined)

    await waitFor(() => expect(FakeEventSource.instances).toHaveLength(1))
    expect(stub.providers).toHaveLength(0)
    expect(contentEditable()).toBe('false')
  })
})

describe('NoteView — the shell top bar mirrors the page status', () => {
  it("publishes the collab sync state as the shell's status pill", async () => {
    stubFetch()
    renderNote(EDIT_VAULT, undefined, { shell: true })

    const doc = await relay()
    // Connected but not yet synced: the handshake is still in flight.
    await waitFor(() => expect(screen.getByTestId('shell-status')).toHaveTextContent('idle:Syncing…'))

    doc.load('# Jane')
    await waitFor(() => expect(screen.getByTestId('shell-status')).toHaveTextContent('live:Synced'))
  })

  it("publishes the reader's live-stream state, in a status tone, never the AI accent", async () => {
    stubFetch()
    renderNote(READ_VAULT, undefined, { shell: true })

    await waitFor(() => expect(FakeEventSource.instances).toHaveLength(1))
    expect(screen.getByTestId('shell-status')).toHaveTextContent('idle:Connecting…')

    FakeEventSource.instances[0]!.open()
    await waitFor(() => expect(screen.getByTestId('shell-status')).toHaveTextContent('live:Live'))
    // A sync state is semantic status, not authorship: never the `ai` tone.
    expect(screen.getByTestId('shell-status').textContent).not.toContain('ai:')
  })
})

describe('NoteView', () => {
  it('shows a not-found message for a missing note, and opens no transport', async () => {
    stubFetch({ error: 'note not found' }, 404)

    renderNote(EDIT_VAULT, '/vaults/v1/notes/people/ghost')

    await waitFor(() => expect(screen.getByText('Note not found.')).toBeInTheDocument())
    expect(stub.providers).toHaveLength(0)
    expect(FakeEventSource.instances).toHaveLength(0)
  })
  it('a downgrade sticks to the open note only, not to the whole vault', async () => {
    // Holding the transport decision per VAULT made one revocation poison every
    // other note in it: each opened on the collab path, where the relay refuses
    // the connection, so the reader got a blank body under 'access removed'.
    // What the decision protects is an OPEN document with unsent characters;
    // a different note has none, so it decides afresh from current access.
    stubFetch()
    const { reportAccess, router } = renderNote(EDIT_VAULT)

    await relay()
    reportAccess(READ_VAULT)
    await waitFor(() => expect(contentEditable()).toBe('false'))
    // Still the collab transport for the note that was open — that is the fix
    // for the data-loss blocker and must not regress.
    expect(FakeEventSource.instances).toHaveLength(0)

    await act(async () => {
      await router.navigate('/vaults/v1/notes/people/omar')
    })

    // The next note starts clean, on the transport this access actually allows.
    await waitFor(() => expect(FakeEventSource.instances).toHaveLength(1))
  })
  it('shows the note instead of a blank editor when the relay cannot be reached', async () => {
    // An editor whose relay is down has an empty Y.Text, so the collab editor
    // renders nothing at all — a blank page over a note that has content, on
    // the screen someone opened to read it. The REST body is shown read-only
    // instead. It is deliberately NOT seeded into the Y.Text: that would merge
    // a local copy into the shared document on eventual connect and duplicate
    // the whole note.
    ticket.mockRejectedValue(new Error('relay unreachable'))
    stubFetch()
    renderNote(EDIT_VAULT)

    await waitFor(() => expect(bodyText()).toContain('the REST copy'))
    // Read-only, so nothing typed here can be lost when the relay returns.
    expect(contentEditable()).toBe('false')
    // And it says why, without claiming access was taken away.
    expect(screen.queryByText(/access to this note was removed/i)).toBeNull()
  })
})

describe('NoteView — the inspector tabs', () => {
  function inspector(): HTMLElement {
    // Outside an AppShell the Inspector renders inline as a labelled aside.
    return document.querySelector('aside[data-shell-panel="inspector"]') as HTMLElement
  }

  it('folds properties, history and sharing into inspector tabs for the owner', async () => {
    stubFetch()
    renderNote(OWNER_VAULT)

    const doc = await relay()
    doc.load('body', { resource: 'https://kintsugi.test/ada' })

    await waitFor(() => expect(screen.getByRole('tab', { name: 'Properties' })).toBeInTheDocument())
    expect(screen.getByRole('tab', { name: 'History' })).toBeInTheDocument()
    expect(screen.getByRole('tab', { name: 'Sharing' })).toBeInTheDocument()
    // Properties is the resting tab, bound to the live document.
    expect(screen.getByDisplayValue('https://kintsugi.test/ada')).toBeInTheDocument()
    // All three live in the inspector track, not over the editor.
    expect(inspector()).toContainElement(screen.getByRole('tab', { name: 'Sharing' }))

    await expectNoA11yViolations(inspector())
  })

  it('offers no Sharing tab below owner — shares are the owner’s to grant', async () => {
    stubFetch()
    renderNote(EDIT_VAULT)

    await relay()
    await waitFor(() => expect(screen.getByRole('tab', { name: 'History' })).toBeInTheDocument())
    expect(screen.queryByRole('tab', { name: 'Sharing' })).toBeNull()
  })

  it('gives a reader the same tabs, locked: history explains instead of 403ing', async () => {
    stubFetch()
    renderNote(READ_VAULT)

    await screen.findByText(/read-only/i)
    expect(screen.queryByRole('tab', { name: 'Sharing' })).toBeNull()

    await userEvent.click(screen.getByRole('tab', { name: 'History' }))
    expect(await screen.findByText(/needs edit access/i)).toBeInTheDocument()
    // The reason, not a request that can only fail: nothing was fetched for it.
    const fetchMock = vi.mocked(globalThis.fetch)
    expect(fetchMock.mock.calls.some(([url]) => String(url).includes('/revisions'))).toBe(false)
  })
})
