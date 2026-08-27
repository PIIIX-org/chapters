import { describe, expect, it } from 'vitest'
import { collabSocketUrl } from './collab.js'

describe('collabSocketUrl', () => {
  it('resolves the relay path against the page origin, not the API port', () => {
    // The bug this pins: the server used to build this from its own `host`
    // header, which behind vite is `localhost:3000` — the API port, which has
    // no relay on it, so every handshake 404'd. Only the browser knows the
    // origin that can reach back through the proxy.
    expect(collabSocketUrl('/collab', 'http://localhost:5173/vaults/v1/notes/a')).toBe(
      'ws://localhost:5173/collab',
    )
  })

  it('gives an https page wss, or the browser blocks it as mixed content', () => {
    expect(collabSocketUrl('/collab', 'https://chapters.example.com/vaults/v1')).toBe(
      'wss://chapters.example.com/collab',
    )
  })

  it('keeps a non-default port, which a dev origin has and production does not', () => {
    // Both cases in one test on purpose: a fixture with only the default port
    // cannot tell "keeps the origin" from "hardcodes the host".
    expect(collabSocketUrl('/collab', 'http://192.168.1.9:4321/')).toBe('ws://192.168.1.9:4321/collab')
    expect(collabSocketUrl('/collab', 'https://chapters.example.com/')).toBe(
      'wss://chapters.example.com/collab',
    )
  })
})
