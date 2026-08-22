import { axe } from 'vitest-axe'
import { expect } from 'vitest'

// The `toHaveNoViolations` matcher is registered globally in test/setup.ts
// via `expect.extend(matchers)`. vitest-axe@0.1.0 ships its type
// augmentation under the old `Vi` namespace, which vitest 4's `Assertion`
// type no longer merges with — declare it the way vitest 4 expects instead.
declare module 'vitest' {
  interface Assertion<T> {
    toHaveNoViolations(): T
  }
}
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
