import { describe, expect, it } from 'vitest'
import { buildApp } from '../src/app.js'

describe('app', () => {
  it('responds ok on /health', async () => {
    const app = await buildApp()
    const res = await app.inject({ method: 'GET', url: '/health' })
    expect(res.statusCode).toBe(200)
    expect(res.json()).toEqual({ status: 'ok' })
    await app.close()
  })

  it('sends security headers on every response', async () => {
    const app = await buildApp()
    const res = await app.inject({ method: 'GET', url: '/health' })
    expect(res.headers['x-content-type-options']).toBe('nosniff')
    expect(res.headers['x-frame-options']).toBeTruthy()
    await app.close()
  })

  it('sends no CORS headers when CORS_ORIGIN is unconfigured (same-origin only)', async () => {
    const app = await buildApp()
    const res = await app.inject({
      method: 'GET',
      url: '/health',
      headers: { origin: 'https://evil.example.com' },
    })
    expect(res.headers['access-control-allow-origin']).toBeUndefined()
    await app.close()
  })

  it('formats unhandled exceptions as structured JSON responses via global error handler', async () => {
    const app = await buildApp()
    app.get('/test-crash', async () => {
      throw new Error('Simulation of unexpected failure')
    })
    const res = await app.inject({ method: 'GET', url: '/test-crash' })
    expect(res.statusCode).toBe(500)
    const json = res.json()
    expect(json.statusCode).toBe(500)
    expect(json.error).toBeDefined()
    expect(json.message).toBeDefined()
    await app.close()
  })
})
