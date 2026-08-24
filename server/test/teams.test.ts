import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { FastifyInstance } from 'fastify'
import { buildApp } from '../src/app.js'
import { createActiveUser, loginCookie } from './helpers.js'

let app: FastifyInstance
beforeAll(async () => {
  app = await buildApp()
  await app.ready()
})
afterAll(async () => app.close())

describe('GET /api/users/lookup', () => {
  it('finds an active user by exact email', async () => {
    const user = await createActiveUser()
    const finder = await createActiveUser()
    const cookie = await loginCookie(app, finder.email)
    const res = await app.inject({
      method: 'GET',
      url: `/api/users/lookup?email=${encodeURIComponent(user.email)}`,
      headers: { cookie },
    })
    expect(res.statusCode).toBe(200)
    expect(res.json()).toEqual({ id: user.id, email: user.email })
  })

  it('returns 404 for a pending or deactivated user', async () => {
    const pending = await createActiveUser({ status: 'pending_approval' })
    const deactivated = await createActiveUser({ status: 'deactivated' })
    const finder = await createActiveUser()
    const cookie = await loginCookie(app, finder.email)

    const resPending = await app.inject({
      method: 'GET',
      url: `/api/users/lookup?email=${encodeURIComponent(pending.email)}`,
      headers: { cookie },
    })
    expect(resPending.statusCode).toBe(404)

    const resDeactivated = await app.inject({
      method: 'GET',
      url: `/api/users/lookup?email=${encodeURIComponent(deactivated.email)}`,
      headers: { cookie },
    })
    expect(resDeactivated.statusCode).toBe(404)
  })

  it('does not match a prefix of a real email', async () => {
    const user = await createActiveUser()
    const finder = await createActiveUser()
    const cookie = await loginCookie(app, finder.email)
    const prefix = user.email.slice(0, -4)
    const res = await app.inject({
      method: 'GET',
      url: `/api/users/lookup?email=${encodeURIComponent(prefix)}`,
      headers: { cookie },
    })
    expect(res.statusCode).toBe(404)
  })

  it('normalises whitespace and case', async () => {
    const user = await createActiveUser()
    const finder = await createActiveUser()
    const cookie = await loginCookie(app, finder.email)
    const messy = `  ${user.email.toUpperCase()}  `
    const res = await app.inject({
      method: 'GET',
      url: `/api/users/lookup?email=${encodeURIComponent(messy)}`,
      headers: { cookie },
    })
    expect(res.statusCode).toBe(200)
    expect(res.json()).toEqual({ id: user.id, email: user.email })
  })

  it('requires a session', async () => {
    const user = await createActiveUser()
    const res = await app.inject({
      method: 'GET',
      url: `/api/users/lookup?email=${encodeURIComponent(user.email)}`,
    })
    expect(res.statusCode).toBe(401)
  })
})

describe('GET /api/teams/:id/stats', () => {
  async function createTeamWithMember() {
    const owner = await createActiveUser()
    const member = await createActiveUser()
    const ownerCookie = await loginCookie(app, owner.email)
    const memberCookie = await loginCookie(app, member.email)

    const teamRes = await app.inject({
      method: 'POST',
      url: '/api/teams',
      headers: { cookie: ownerCookie },
      body: { name: 'Test Team' },
    })
    const team = teamRes.json()

    await app.inject({
      method: 'POST',
      url: `/api/teams/${team.id}/members`,
      headers: { cookie: ownerCookie },
      body: { userId: member.id },
    })

    return { owner, member, ownerCookie, memberCookie, team }
  }

  async function createVault(cookie: string, name: string) {
    const res = await app.inject({
      method: 'POST',
      url: '/api/vaults',
      headers: { cookie },
      body: { name },
    })
    return res.json()
  }

  async function shareVault(ownerCookie: string, vaultId: string, granteeId: string) {
    await app.inject({
      method: 'POST',
      url: `/api/vaults/${vaultId}/shares`,
      headers: { cookie: ownerCookie },
      body: { granteeType: 'user', granteeId, permission: 'edit' },
    })
  }

  async function writeNote(cookie: string, vaultId: string, name: string) {
    const res = await app.inject({
      method: 'POST',
      url: `/api/vaults/${vaultId}/notes`,
      headers: { cookie },
      body: { type: 'note', name },
    })
    return res.json()
  }

  async function updateNoteBody(cookie: string, vaultId: string, path: string, body: string) {
    return app.inject({
      method: 'PUT',
      url: `/api/vaults/${vaultId}/notes/${path}`,
      headers: { cookie },
      body: { body },
    })
  }

  it('counts distinct notes and vaults, using the latest edit as lastActivityAt', async () => {
    const { member, ownerCookie, memberCookie, team } = await createTeamWithMember()
    const vaultA = await createVault(ownerCookie, 'Vault A')
    const vaultB = await createVault(ownerCookie, 'Vault B')
    await shareVault(ownerCookie, vaultA.id, member.id)
    await shareVault(ownerCookie, vaultB.id, member.id)

    const noteA = await writeNote(memberCookie, vaultA.id, 'note-a')
    // Edit the same note again: distinct-note count must stay 1 for this vault,
    // not 2 (that would mean revisions were counted instead of distinct notes).
    const editRes = await updateNoteBody(memberCookie, vaultA.id, noteA.path, 'edited body')
    expect(editRes.statusCode).toBe(200)
    const editedNoteA = editRes.json()
    const noteB = await writeNote(memberCookie, vaultB.id, 'note-b')

    const res = await app.inject({
      method: 'GET',
      url: `/api/teams/${team.id}/stats`,
      headers: { cookie: ownerCookie },
    })
    expect(res.statusCode).toBe(200)
    const row = res.json().find((r: { userId: string }) => r.userId === member.id)
    expect(row.notesTouched).toBe(2)
    expect(row.vaultsTouched).toBe(2)
    // Must reflect the LATEST revision (vault B's write), not the earlier
    // create-then-edit on vault A's note. Compare only against DB-issued
    // timestamps (never the test process's own clock) to avoid clock skew
    // against the dockerized Postgres instance.
    expect(row.lastActivityAt).not.toBeNull()
    const lastMs = new Date(row.lastActivityAt).getTime()
    expect(lastMs).toBeGreaterThanOrEqual(new Date(editedNoteA.updatedAt).getTime())
    expect(lastMs).toBeGreaterThanOrEqual(new Date(noteB.updatedAt).getTime() - 1000)
    expect(lastMs).toBeLessThanOrEqual(new Date(noteB.updatedAt).getTime() + 1000)
  })

  it('excludes activity in vaults the caller cannot access (privacy)', async () => {
    const { member, ownerCookie, memberCookie, team } = await createTeamWithMember()
    const vaultA = await createVault(ownerCookie, 'Vault A')
    const vaultB = await createVault(ownerCookie, 'Vault B')
    await shareVault(ownerCookie, vaultA.id, member.id)
    await shareVault(ownerCookie, vaultB.id, member.id)
    await writeNote(memberCookie, vaultA.id, 'note-a')
    const noteB = await writeNote(memberCookie, vaultB.id, 'note-b')

    // A third vault owned by the member, shared with nobody. Its edit is the
    // most recent of all three, so a missing accessible-vault filter shows
    // up in lastActivityAt too, not just the counts.
    const privateVault = await createVault(memberCookie, 'Private Vault')
    const privateNote = await writeNote(memberCookie, privateVault.id, 'secret-note')

    const res = await app.inject({
      method: 'GET',
      url: `/api/teams/${team.id}/stats`,
      headers: { cookie: ownerCookie },
    })
    const row = res.json().find((r: { userId: string }) => r.userId === member.id)
    expect(row.notesTouched).toBe(2)
    expect(row.vaultsTouched).toBe(2)
    expect(row.lastActivityAt).not.toBeNull()
    // Compare only against DB-issued timestamps (avoids clock skew against
    // the dockerized Postgres instance). The invisible (private-vault) edit
    // is strictly the most recent write overall; if it leaked in,
    // lastActivityAt would equal or exceed privateNote's timestamp instead
    // of staying pinned to the last visible write (noteB).
    const lastMs = new Date(row.lastActivityAt).getTime()
    expect(lastMs).toBeLessThan(new Date(privateNote.updatedAt).getTime())
    expect(lastMs).toBeGreaterThanOrEqual(new Date(noteB.updatedAt).getTime() - 1000)
    expect(lastMs).toBeLessThanOrEqual(new Date(noteB.updatedAt).getTime() + 1000)
  })

  it('includes members with zero activity as 0 / 0 / null', async () => {
    const { team, ownerCookie } = await createTeamWithMember()
    const res = await app.inject({
      method: 'GET',
      url: `/api/teams/${team.id}/stats`,
      headers: { cookie: ownerCookie },
    })
    expect(res.statusCode).toBe(200)
    const body = res.json()
    expect(body.length).toBe(2) // owner + member, both with no writes
    for (const row of body) {
      expect(row.notesTouched).toBe(0)
      expect(row.vaultsTouched).toBe(0)
      expect(row.lastActivityAt).toBeNull()
    }
  })

  it('never returns per-note identifying detail', async () => {
    const { member, ownerCookie, memberCookie, team } = await createTeamWithMember()
    const vault = await createVault(ownerCookie, 'Vault')
    await shareVault(ownerCookie, vault.id, member.id)
    const note = await writeNote(memberCookie, vault.id, 'a-secret-title')

    const res = await app.inject({
      method: 'GET',
      url: `/api/teams/${team.id}/stats`,
      headers: { cookie: ownerCookie },
    })
    const raw = JSON.stringify(res.json())
    expect(raw).not.toContain(note.path)
    expect(raw).not.toContain(note.id)
  })

  it('returns 404 for a non-member and 401 when unauthenticated', async () => {
    const { team } = await createTeamWithMember()
    const outsider = await createActiveUser()
    const outsiderCookie = await loginCookie(app, outsider.email)

    const forbidden = await app.inject({
      method: 'GET',
      url: `/api/teams/${team.id}/stats`,
      headers: { cookie: outsiderCookie },
    })
    expect(forbidden.statusCode).toBe(404)

    const unauth = await app.inject({
      method: 'GET',
      url: `/api/teams/${team.id}/stats`,
    })
    expect(unauth.statusCode).toBe(401)
  })
})
