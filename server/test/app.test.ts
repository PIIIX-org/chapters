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
})
