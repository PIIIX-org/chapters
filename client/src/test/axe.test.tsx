import { describe, it, expect } from 'vitest'
import { render } from '@testing-library/react'
import { expectNoA11yViolations } from './axe.js'

describe('expectNoA11yViolations', () => {
  it('passes on correctly labelled markup', async () => {
    const { container } = render(
      <main>
        <label htmlFor="n">Name</label>
        <input id="n" />
        <button>Save</button>
      </main>,
    )

    await expectNoA11yViolations(container)
  })

  it('rejects markup with missing accessible names', async () => {
    const { container } = render(
      <main>
        <img src="x.png" />
        <input />
      </main>,
    )

    await expect(expectNoA11yViolations(container)).rejects.toThrow()
  })
})
