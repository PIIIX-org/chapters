// @vitest-environment happy-dom
//
// react-router's data router builds a native `Request` (Node's undici) for every
// client-side navigation, even without loaders. jsdom overrides global
// AbortController/AbortSignal with its own (non-undici-compatible) versions but
// doesn't provide Request/fetch, so undici's Request rejects the signal:
// https://github.com/vitest-dev/vitest/issues/8374
// happy-dom ships a matching fetch/Request/AbortController set, so this test
// (which triggers the RequireAuth -> Navigate redirect) runs under it instead.
import { afterEach, describe, expect, it, vi } from 'vitest'
import { render, screen, waitFor } from '@testing-library/react'
import { mockJsonResponse } from './lib/api'
import App from './App'

describe('App', () => {
  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('redirects to the login page when there is no session', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(mockJsonResponse(401, { error: 'unauthorized' })))

    render(<App />)

    await waitFor(() => expect(screen.getByText('Login page (Task 10)')).toBeInTheDocument())
  })
})
