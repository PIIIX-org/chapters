import { describe, expect, it, vi } from 'vitest'
import { handleWikilinkClick } from './handleWikilinkClick'

describe('handleWikilinkClick', () => {
  it('navigates directly to an existing note (no create)', () => {
    const navigate = vi.fn()
    const create = vi.fn()
    handleWikilinkClick('people/jane', 'v1', ['people/jane'], true, navigate, create)
    expect(navigate).toHaveBeenCalledWith('/vaults/v1/notes/people/jane')
    expect(create).not.toHaveBeenCalled()
  })

  it('creates a missing note (type/name) then navigates', () => {
    const navigate = vi.fn()
    const create = vi.fn((_input, onSettled: () => void) => onSettled())
    handleWikilinkClick('people/bob', 'v1', ['people/jane'], true, navigate, create)
    expect(create).toHaveBeenCalledWith({ type: 'people', name: 'bob' }, expect.any(Function))
    expect(navigate).toHaveBeenCalledWith('/vaults/v1/notes/people/bob')
  })

  it('does not create when the user cannot create (read-only) — just navigates', () => {
    const navigate = vi.fn()
    const create = vi.fn()
    handleWikilinkClick('people/bob', 'v1', ['people/jane'], false, navigate, create)
    expect(create).not.toHaveBeenCalled()
    expect(navigate).toHaveBeenCalledWith('/vaults/v1/notes/people/bob')
  })

  it('does not create an unparseable target (no type/name) — just navigates', () => {
    const navigate = vi.fn()
    const create = vi.fn()
    handleWikilinkClick('justaname', 'v1', [], true, navigate, create)
    expect(create).not.toHaveBeenCalled()
    expect(navigate).toHaveBeenCalledWith('/vaults/v1/notes/justaname')
  })
})
