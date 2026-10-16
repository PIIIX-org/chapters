import { afterEach, describe, expect, it, vi } from 'vitest'
import { readHealthHidesVersion } from '../src/config.js'

// ELARA_HEALTH_HIDE_VERSION (#638): only `true` hides `version` on /health;
// a value that is neither true nor false keeps it shown and warns at boot.
describe('ELARA_HEALTH_HIDE_VERSION', () => {
  afterEach(() => {
    vi.restoreAllMocks()
    vi.unstubAllEnvs()
    vi.resetModules()
  })

  it('hides only on `true`, silently keeps it shown when unset, empty or `false`', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    expect(readHealthHidesVersion('true')).toBe(true)
    expect(readHealthHidesVersion(undefined)).toBe(false)
    expect(readHealthHidesVersion('')).toBe(false)
    expect(readHealthHidesVersion('false')).toBe(false)
    expect(warn).not.toHaveBeenCalled()
  })

  it('keeps version shown and warns on any other value', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    for (const raw of ['TRUE', '1', 'yes', ' true']) {
      warn.mockClear()
      expect(readHealthHidesVersion(raw)).toBe(false)
      expect(warn).toHaveBeenCalledTimes(1)
      expect(warn.mock.calls[0]![0]).toContain('ELARA_HEALTH_HIDE_VERSION')
      expect(warn.mock.calls[0]![0]).toContain('/health keeps reporting version')
    }
  })

  // Dynamic import on purpose: config reads the env when the module loads,
  // so each case re-loads it after vi.resetModules().
  it('is read from the environment when the config loads', async () => {
    vi.stubEnv('ELARA_HEALTH_HIDE_VERSION', 'true')
    vi.resetModules()
    expect((await import('../src/config.js')).config.healthHidesVersion).toBe(true)

    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    vi.stubEnv('ELARA_HEALTH_HIDE_VERSION', 'yes')
    vi.resetModules()
    expect((await import('../src/config.js')).config.healthHidesVersion).toBe(false)
    expect(warn).toHaveBeenCalledTimes(1)
  })
})
