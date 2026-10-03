/* eslint-disable @typescript-eslint/no-unused-vars, @typescript-eslint/no-empty-object-type */
import 'vitest'
import type { TestingLibraryMatchers } from '@testing-library/jest-dom/matchers'

declare module 'vitest' {
  interface Assertion<R extends void | Promise<void> = void, _T = unknown>
    extends TestingLibraryMatchers<typeof expect.stringContaining, R> {
    toHaveNoViolations(): R
  }
  interface AsymmetricMatchersContaining
    extends TestingLibraryMatchers<typeof expect.stringContaining, unknown> {}
}
