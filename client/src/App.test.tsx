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

    await waitFor(() => expect(screen.getByLabelText('Email')).toBeInTheDocument())
  })
})
