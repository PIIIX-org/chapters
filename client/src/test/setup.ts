import * as jestDomMatchers from '@testing-library/jest-dom/matchers'
import * as matchers from 'vitest-axe/matchers'
import { cleanup } from '@testing-library/react'
import { afterEach, expect } from 'vitest'

expect.extend(jestDomMatchers)
expect.extend(matchers)

afterEach(() => {
  cleanup()
})
