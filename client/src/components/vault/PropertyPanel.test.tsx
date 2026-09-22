import { describe, expect, it } from 'vitest'
import * as Y from 'yjs'
import { act, fireEvent, render, screen } from '@testing-library/react'
import { expectNoA11yViolations } from '../../test/axe.js'
import { CollabPropertyPanel, LivePropertyPanel } from './PropertyPanel.js'

/**
 * Uneven on purpose: an immutable `type`, two of the three editable keys
 * filled and one empty, two tags rather than one, and an extra OKF key that
 * belongs to nobody's form field. A panel that dropped unknown keys, or that
 * rendered only the first tag, passes a flatter fixture.
 */
const SEED: Record<string, unknown> = {
  type: 'people',
  resource: 'https://kintsugi.test/ada',
  tags: ['research', 'seams'],
  custom: 'keep me',
}

/** A note document shaped exactly as the relay loads it
 *  (`onLoadDocument` in server/src/sync/collab-server.ts). */
function seededDoc(frontmatter: Record<string, unknown> = SEED) {
  const ydoc = new Y.Doc()
  const map = ydoc.getMap('frontmatter')
  for (const [key, value] of Object.entries(frontmatter)) map.set(key, value)
  return map
}

describe('CollabPropertyPanel (editors)', () => {
  it('renders the frontmatter Y.Map, immutable and extra keys included', () => {
    render(<CollabPropertyPanel frontmatter={seededDoc()} readOnly={false} />)

    expect(screen.getByText('people')).toBeInTheDocument()
    expect(screen.getByDisplayValue('https://kintsugi.test/ada')).toBeInTheDocument()
    expect(screen.getByText('research')).toBeInTheDocument()
    expect(screen.getByText('seams')).toBeInTheDocument()
    expect(screen.getByText('keep me')).toBeInTheDocument()
    // Absent key, not an empty string in the document.
    expect(screen.getByPlaceholderText(/ISO date/)).toHaveValue('')
  })

  it('writes an edit straight into the Y.Map — no debounce, no PUT', () => {
    const map = seededDoc()
    render(<CollabPropertyPanel frontmatter={map} readOnly={false} />)

    fireEvent.change(screen.getByPlaceholderText(/ISO date/), { target: { value: '2026-08-25' } })

    // The CRDT is the store: a last-write-wins PUT racing it is issue #66
    // aimed at the engine that fixes it.
    expect(map.get('timestamp')).toBe('2026-08-25')
    // Everything else is untouched by a single-key write.
    expect(map.get('resource')).toBe('https://kintsugi.test/ada')
    expect(map.get('type')).toBe('people')
    expect(map.get('custom')).toBe('keep me')
  })

  it('shows another editor’s change without anyone touching this panel', () => {
    const map = seededDoc()
    render(<CollabPropertyPanel frontmatter={map} readOnly={false} />)

    // What an inbound update from the relay does to the document.
    act(() => {
      map.set('resource', 'https://kintsugi.test/lovelace')
      map.set('tags', ['research', 'seams', 'gold'])
    })

    expect(screen.getByDisplayValue('https://kintsugi.test/lovelace')).toBeInTheDocument()
    expect(screen.queryByDisplayValue('https://kintsugi.test/ada')).toBeNull()
    expect(screen.getByText('gold')).toBeInTheDocument()
  })

  it('re-reads when the document underneath it is replaced', () => {
    // `useCollabDoc` swaps in a brand new Y.Doc when the note changes. Nothing
    // is emitted on the new map, so an observer alone would leave the previous
    // note's properties on screen under the new note's name.
    const { rerender } = render(<CollabPropertyPanel frontmatter={seededDoc()} readOnly={false} />)
    rerender(
      <CollabPropertyPanel
        frontmatter={seededDoc({ type: 'journal', resource: 'https://kintsugi.test/other' })}
        readOnly={false}
      />,
    )

    expect(screen.getByDisplayValue('https://kintsugi.test/other')).toBeInTheDocument()
    expect(screen.getByText('journal')).toBeInTheDocument()
    expect(screen.queryByDisplayValue('https://kintsugi.test/ada')).toBeNull()
  })

  it('deletes an emptied key rather than storing an empty value', () => {
    const map = seededDoc()
    render(<CollabPropertyPanel frontmatter={map} readOnly={false} />)

    fireEvent.change(screen.getByDisplayValue('https://kintsugi.test/ada'), { target: { value: '  ' } })

    expect(map.has('resource')).toBe(false)
    expect(map.get('resource')).toBeUndefined()
  })

  it('locks every field when the session is not writable', () => {
    const map = seededDoc()
    // `readOnly` here is `!writable` — revoked OR offline, not just revoked.
    render(<CollabPropertyPanel frontmatter={map} readOnly />)

    expect(screen.getByDisplayValue('https://kintsugi.test/ada')).toBeDisabled()
    expect(screen.getByPlaceholderText(/ISO date/)).toBeDisabled()
    // NOW button is disabled, and TagInput hides its remove buttons.
    expect(screen.getByRole('button', { name: 'NOW' })).toBeDisabled()
    expect(screen.getByText('research')).toBeInTheDocument()
  })

  it('updates timestamp to an ISO string when clicking NOW button', () => {
    const map = seededDoc()
    render(<CollabPropertyPanel frontmatter={map} readOnly={false} />)

    const nowButton = screen.getByRole('button', { name: 'NOW' })
    fireEvent.click(nowButton)

    const timestamp = map.get('timestamp') as string
    expect(timestamp).toBeDefined()
    expect(
      /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/.test(timestamp),
    ).toBe(true)
    expect(Number.isNaN(Date.parse(timestamp))).toBe(false)
  })

  it('highlights timestamp input with border-destructive when invalid ISO string is entered', () => {
    const map = seededDoc({ ...SEED, timestamp: 'invalid-date' })
    render(<CollabPropertyPanel frontmatter={map} readOnly={false} />)

    const input = screen.getByPlaceholderText(/ISO date/)
    expect(input.className).toContain('border-destructive/60')
  })

  it('renders status pill correctly for status: active', () => {
    const map = seededDoc({ ...SEED, status: 'active' })
    render(<CollabPropertyPanel frontmatter={map} readOnly={false} />)

    expect(screen.getByText('active')).toBeInTheDocument()
  })

  it('renders trust badges correctly for verified metadata', () => {
    const map = seededDoc({
      ...SEED,
      verified: { tier: 'human-reviewed', by: 'alice' },
    })
    render(<CollabPropertyPanel frontmatter={map} readOnly={false} />)

    expect(screen.getByText('human-reviewed by alice')).toBeInTheDocument()
  })

  it('renders sources list correctly', () => {
    const map = seededDoc({
      ...SEED,
      sources: [{ resource: 'repo:chapters/app.ts', title: 'Main App' }],
    })
    render(<CollabPropertyPanel frontmatter={map} readOnly={false} />)

    expect(screen.getByText('Main App')).toBeInTheDocument()
    expect(screen.getByText('repo:chapters/app.ts')).toBeInTheDocument()
  })

  it('has no accessibility violations', async () => {
    const { container } = render(<CollabPropertyPanel frontmatter={seededDoc()} readOnly={false} />)
    await expectNoA11yViolations(container)
  })

  it('has no accessibility violations with all OKF v0.2 fields present', async () => {
    const map = seededDoc({
      ...SEED,
      status: 'active',
      verified: [{ tier: 'human-reviewed', by: 'alice' }, { tier: 'machine-confirmed' }],
      generated: { by: 'gemini-2.5', at: '2026-09-22T12:00:00Z' },
      sources: [
        { resource: 'repo:chapters/app.ts', title: 'Main App', last_modified: '2026-09-22T10:00:00Z' },
        { resource: 'https://example.com/docs', title: 'External Docs' },
      ],
      timestamp: '2026-09-22T14:00:00Z',
    })
    const { container } = render(<CollabPropertyPanel frontmatter={map} readOnly={false} />)
    await expectNoA11yViolations(container)
  })
})

describe('LivePropertyPanel (readers)', () => {
  it('renders the SSE frame, locked', () => {
    render(<LivePropertyPanel frontmatter={SEED} />)

    expect(screen.getByText('people')).toBeInTheDocument()
    expect(screen.getByDisplayValue('https://kintsugi.test/ada')).toBeDisabled()
    expect(screen.getByPlaceholderText(/ISO date/)).toBeDisabled()
    expect(screen.getByText('research')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'NOW' })).toBeDisabled()
  })

  it('follows the frames: locked is not frozen', () => {
    const { rerender } = render(<LivePropertyPanel frontmatter={SEED} />)
    rerender(<LivePropertyPanel frontmatter={{ ...SEED, resource: 'https://kintsugi.test/next', tags: ['gold'] }} />)

    expect(screen.getByDisplayValue('https://kintsugi.test/next')).toBeInTheDocument()
    expect(screen.getByText('gold')).toBeInTheDocument()
    expect(screen.queryByText('research')).toBeNull()
  })

  it('has no accessibility violations', async () => {
    const { container } = render(<LivePropertyPanel frontmatter={SEED} />)
    await expectNoA11yViolations(container)
  })
})
