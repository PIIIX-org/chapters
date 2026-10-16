import { describe, expect, it } from 'vitest'
import { buildApp } from '../src/app.js'
import { config } from '../src/config.js'

describe('app', () => {
  it('responds ok on /health with the process identity (#583)', async () => {
    const app = await buildApp()
    const res = await app.inject({ method: 'GET', url: '/health' })
    expect(res.statusCode).toBe(200)
    const body = res.json()
    expect(Object.keys(body).sort()).toEqual(['bootId', 'lastShutdown', 'previousBootId', 'startedAt', 'status', 'version'])
    expect(body.status).toBe('ok')
    expect(body.bootId).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/)
    expect(new Date(body.startedAt).toISOString()).toBe(body.startedAt)
    expect(Date.parse(body.startedAt)).toBeLessThanOrEqual(Date.now())
    // No ELARA_VERSION in the test env; boot was never recorded in this process.
    expect(body.version).toBeNull()
    expect(body.lastShutdown).toBe('unknown')
    expect(body.previousBootId).toBeNull()
    const again = (await app.inject({ method: 'GET', url: '/health' })).json()
    expect(again.bootId).toBe(body.bootId)
    await app.close()
  })

  it('leaves version out of /health when ELARA_HEALTH_HIDE_VERSION is set (#638)', async () => {
    const original = config.healthHidesVersion
    config.healthHidesVersion = true
    const app = await buildApp()
    try {
      const body = (await app.inject({ method: 'GET', url: '/health' })).json()
      expect(Object.keys(body).sort()).toEqual(['bootId', 'lastShutdown', 'previousBootId', 'startedAt', 'status'])
      expect(body.status).toBe('ok')
    } finally {
      config.healthHidesVersion = original
      await app.close()
    }
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

  it('converts Postgres 22P02 invalid input syntax errors into 404 not found', async () => {
    const app = await buildApp()
    app.get('/test-22p02', async () => {
      const err = new Error('invalid input syntax for type uuid')
      ;(err as unknown as { code: string }).code = '22P02'
      throw err
    })
    const res = await app.inject({ method: 'GET', url: '/test-22p02' })
    expect(res.statusCode).toBe(404)
    expect(res.json()).toEqual({ error: 'not found' })
    await app.close()
  })
})
