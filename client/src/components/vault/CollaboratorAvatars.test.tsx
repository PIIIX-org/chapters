import { describe, expect, it } from 'vitest'
import { render, screen } from '@testing-library/react'
import { AI_INK, inkFor } from '../../lib/ink.js'
import { expectNoA11yViolations } from '../../test/axe.js'
import type { CollabPeer } from '../../hooks/useCollabDoc.js'
import { CollaboratorAvatars } from './CollaboratorAvatars.js'

/** Peers exactly as `useCollabDoc` builds them: ink hashed from the user id.
 *  Every peer here is a person — see the note on the teal test below. */
function peer(clientId: number, userId: string, name: string): CollabPeer {
  return { clientId, userId, name, ink: inkFor(userId) }
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

  it('never wears teal, because every peer in this row is a person', () => {
    // Teal asserts a machine wrote something. MCP edits arrive through a
    // server-side direct connection that never joins awareness, so there is no
    // AI peer here to wear it — and the only way one could appear was a
    // self-declared awareness id, which any co-editor could have forged.
    // A hashed hue for an id that merely looks like 'mcp' is still a person's.
    render(<CollaboratorAvatars peers={[JANE, TAHA, peer(14, 'mcp', 'Chapters MCP')]} />)
    for (const name of ['ada.lovelace', 'taha', 'Chapters MCP']) {
      const face = screen.getByLabelText(`${name} is editing this note`)
      expect(face.style.getPropertyValue('--ink')).not.toBe(AI_INK.color)
      // Teal in either theme, not just the hue this reader happens to be in.
      for (const teal of [AI_INK.light, AI_INK.dark]) expect(face.getAttribute('style')).not.toContain(teal)
    }
  })

  it('labels every face with a name, because colour on its own is not a label', () => {
    render(<CollaboratorAvatars peers={[peer(14, 'mcp', 'Chapters MCP')]} />)
    expect(screen.getByLabelText('Chapters MCP is editing this note').textContent).toBe('CM')
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
    expect(screen.getByLabelText('2 more editing this note').textContent).toBe('+2')
    // 5th and 6th are past the cap; 'mo' is the 4th and must still show.
    expect(screen.getByLabelText('mo is editing this note')).toBeInTheDocument()
    expect(screen.queryByLabelText('ren is editing this note')).toBeNull()
  })

  it('has no accessibility violations', async () => {
    const { container } = render(<CollaboratorAvatars peers={[JANE, TAHA, SOLO]} />)
    expect(screen.getByRole('list')).toHaveAccessibleName('In this note now')
    await expectNoA11yViolations(container)
  })
})
