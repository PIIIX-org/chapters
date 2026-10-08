import { axe } from 'vitest-axe'
import { expect } from 'vitest'

export async function expectNoA11yViolations(container: HTMLElement): Promise<void> {
  const results = await axe(container, {
    rules: {
      // happy-dom does no layout or cascade resolution, so axe-core's contrast
      // rule reads unresolved colours and reports noise; WCAG AA contrast is
      // fixed in the token set in client/src/index.css and is not what this
      // gate is for.
      'color-contrast': { enabled: false },
    },
  })
  expect(results).toHaveNoViolations()
}
