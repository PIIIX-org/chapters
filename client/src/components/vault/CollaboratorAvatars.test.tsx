import { describe, expect, it } from 'vitest'
import { render, screen } from '@testing-library/react'
import { AI_INK, inkFor } from '../../lib/ink.js'
import { expectNoA11yViolations } from '../../test/axe.js'
import type { CollabPeer } from '../../hooks/useCollabDoc.js'
import { CollaboratorAvatars } from './CollaboratorAvatars.js'

/** People exactly as `useCollabDoc` builds them: ink hashed from the user id. */
function peer(clientId: number, userId: string, name: string): CollabPeer {
  return { kind: 'person', clientId, userId, name, ink: inkFor(userId) }
}

/** An agent the relay put in presence (#481): always teal. */
function agent(clientId: number, name: string, activity: 'editing' | 'reading'): CollabPeer {
  return { kind: 'agent', clientId, name, ink: AI_INK, activity }
}

// Deliberately uneven: different id shapes, different name shapes (dotted,
// bare, single-letter), and inks asserted distinct below. Four peers who all
// hashed to one hue would pass a component that painted every avatar the same.
const JANE = peer(11, 'b7', 'ada.lovelace')
const TAHA = peer(12, '9', 'taha')
const SOLO = peer(13, 'e2d0c1b4-aaaa-bbbb-cccc-ddddeeeeffff', 'k')


describe('CollaboratorAvatars', () => {
  it('shows nothing at all when nobody else is in the note', () => {
    const { container } = render(<CollaboratorAvatars peers={[]} />)
    expect(container).toBeEmptyDOMElement()
  })

  it('gives each collaborator their own ink, matching their pen nib', () => {
    expect(JANE.ink.color).not.toBe(TAHA.ink.color) // fixture guard: two hues, not one

    render(<CollaboratorAvatars peers={[JANE, TAHA]} />)
    const jane = screen.getByLabelText('ada.lovelace is editing this note')
    const taha = screen.getByLabelText('taha is editing this note')

    // Read as custom properties, not as `style.color`: the ink is a `var()` so
    // the *reader's* theme resolves it, and happy-dom drops `var()` from the
    // colour properties it parses while keeping custom ones verbatim.
    expect(jane.style.getPropertyValue('--ink')).toBe(JANE.ink.color)
    expect(jane.style.getPropertyValue('--ink-wash')).toBe(JANE.ink.colorLight)
    expect(taha.style.getPropertyValue('--ink')).toBe(TAHA.ink.color)
    expect(taha.style.getPropertyValue('--ink')).not.toBe(jane.style.getPropertyValue('--ink'))
    // ...and the paint really is hung on those properties.
    for (const el of [jane, taha]) {
      expect(el.className).toContain('text-[color:var(--ink)]')
      expect(el.className).toContain('border-[color:var(--ink)]')
      expect(el.className).toContain('bg-[color:var(--ink-wash)]')
    }
  })

  it('never puts teal on a person, even one whose id looks like the MCP', () => {
    // Teal asserts a machine is at work, and only the relay can say that: a
    // person's awareness id is self-declared, so a hashed hue for an id that
    // merely looks like 'mcp' is still a person's.
    render(<CollaboratorAvatars peers={[JANE, TAHA, peer(14, 'mcp', 'Elara MCP')]} />)
    for (const name of ['ada.lovelace', 'taha', 'Elara MCP']) {
      const face = screen.getByLabelText(`${name} is editing this note`)
      expect(face.style.getPropertyValue('--ink')).not.toBe(AI_INK.color)
      // Teal in either theme, not just the hue this reader happens to be in.
      for (const teal of [AI_INK.light, AI_INK.dark]) expect(face.getAttribute('style')).not.toContain(teal)
    }
  })

  it('shows agents distinctly: teal, square, a bot mark, and what they are doing (#481)', () => {
    render(
      <CollaboratorAvatars peers={[JANE, agent(21, 'Claude Code', 'editing'), agent(22, 'nightly-indexer', 'reading')]} />,
    )
    const person = screen.getByLabelText('ada.lovelace is editing this note')
    const editing = screen.getByLabelText('Claude Code (agent) is editing this note')
    const reading = screen.getByLabelText('nightly-indexer (agent) is reading this note')

    for (const face of [editing, reading]) {
      expect(face.style.getPropertyValue('--ink')).toBe(AI_INK.color)
      expect(face).toHaveAttribute('data-kind', 'agent')
      expect(face.className).toContain('rounded-md')
      expect(face.className).not.toContain('rounded-full')
      expect(face.querySelector('svg')).not.toBeNull() // the bot mark
    }
    expect(editing.textContent).toBe('CC')
    expect(editing).toHaveAttribute('title', 'Claude Code (agent) is editing this note')
    // Reading is drawn differently from editing, not only said differently.
    expect(reading.className).toContain('border-dashed')
    expect(editing.className).not.toContain('border-dashed')

    // The person beside them keeps a round face, their own ink and no mark.
    expect(person).toHaveAttribute('data-kind', 'person')
    expect(person.className).toContain('rounded-full')
    expect(person.style.getPropertyValue('--ink')).not.toBe(AI_INK.color)
    expect(person.querySelector('svg')).toBeNull()
  })

  it('labels every face with a name, because colour on its own is not a label', () => {
    render(<CollaboratorAvatars peers={[peer(14, 'mcp', 'Elara MCP')]} />)
    expect(screen.getByLabelText('Elara MCP is editing this note').textContent).toBe('EM')
  })

  it('reduces a name to initials, one letter or two', () => {
    render(<CollaboratorAvatars peers={[JANE, TAHA, SOLO]} />)
    expect(screen.getByLabelText('ada.lovelace is editing this note').textContent).toBe('AL')
    expect(screen.getByLabelText('taha is editing this note').textContent).toBe('TA')
    expect(screen.getByLabelText('k is editing this note').textContent).toBe('K')
  })

  it('names each person on hover as well as to a screen reader', () => {
    render(<CollaboratorAvatars peers={[JANE]} />)
    expect(screen.getByLabelText('ada.lovelace is editing this note')).toHaveAttribute('title', 'ada.lovelace')
  })

  it('caps the row at four faces and counts the rest', () => {
    const crowd = [JANE, TAHA, SOLO, peer(14, 'u4', 'mo'), peer(15, 'u5', 'ren'), peer(16, 'u6', 'kai')]
    render(<CollaboratorAvatars peers={crowd} />)
    expect(screen.getAllByRole('listitem')).toHaveLength(5) // 4 faces + the overflow count
    expect(screen.getByLabelText('2 more in this note').textContent).toBe('+2')
    // 5th and 6th are past the cap; 'mo' is the 4th and must still show.
    expect(screen.getByLabelText('mo is editing this note')).toBeInTheDocument()
    expect(screen.queryByLabelText('ren is editing this note')).toBeNull()
  })

  it('has no accessibility violations', async () => {
    const { container } = render(
      <CollaboratorAvatars peers={[JANE, TAHA, SOLO, agent(21, 'Claude Code', 'reading')]} />,
    )
    expect(screen.getByRole('list')).toHaveAccessibleName('In this note now')
    await expectNoA11yViolations(container)
  })
})
