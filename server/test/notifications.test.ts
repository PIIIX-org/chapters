import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { FastifyInstance } from 'fastify'
import { buildApp } from '../src/app.js'
import { db } from '../src/db/client.js'
import { notifications } from '../src/db/schema.js'
import { createActiveUser, loginCookie } from './helpers.js'

let app: FastifyInstance

beforeAll(async () => {
  app = await buildApp()
  await app.ready()
})

afterAll(async () => app.close())

describe('notifications routes', () => {
  it('lists notifications, marks single notification read, and marks all notifications read', async () => {
    const user1 = await createActiveUser()
    const user2 = await createActiveUser()
    const cookie1 = await loginCookie(app, user1.email)
    const cookie2 = await loginCookie(app, user2.email)

    // Insert notifications for user1 and user2
    const inserted = await db
      .insert(notifications)
      .values([
        { recipientId: user1.id, type: 'test', message: 'Notification 1' },
        { recipientId: user1.id, type: 'test', message: 'Notification 2' },
        { recipientId: user1.id, type: 'test', message: 'Notification 3' },
      ])
      .returning()
    const n1 = inserted[0]!

    await db.insert(notifications).values({
      recipientId: user2.id,
      type: 'test',
      message: "User 2 notification",
    })

    // List notifications for user1
    const listRes = await app.inject({
      method: 'GET',
      url: '/api/notifications',
      headers: { cookie: cookie1 },
    })
    expect(listRes.statusCode).toBe(200)
    const list = listRes.json() as Array<{ id: string; readAt: string | null; message: string }>
    expect(list.length).toBe(3)
    expect(list.every((n) => n.readAt === null)).toBe(true)

    // User2 cannot read User1's notification
    const wrongUserRes = await app.inject({
      method: 'POST',
      url: `/api/notifications/${n1.id}/read`,
      headers: { cookie: cookie2 },
    })
    expect(wrongUserRes.statusCode).toBe(404)

    // Mark single notification read
    const singleReadRes = await app.inject({
      method: 'POST',
      url: `/api/notifications/${n1.id}/read`,
      headers: { cookie: cookie1 },
    })
    expect(singleReadRes.statusCode).toBe(200)
    expect(singleReadRes.json()).toEqual({ status: 'read' })

    // Duplicate read on already-read notification returns 404
    const dupRes = await app.inject({
      method: 'POST',
      url: `/api/notifications/${n1.id}/read`,
      headers: { cookie: cookie1 },
    })
    expect(dupRes.statusCode).toBe(404)

    // Mark all read for user1
    const readAllRes = await app.inject({
      method: 'POST',
      url: '/api/notifications/read-all',
      headers: { cookie: cookie1 },
    })
    expect(readAllRes.statusCode).toBe(200)
    expect(readAllRes.json()).toEqual({ status: 'read', count: 2 })

    // Second call to read-all returns count 0
    const readAllAgain = await app.inject({
      method: 'POST',
      url: '/api/notifications/read-all',
      headers: { cookie: cookie1 },
    })
    expect(readAllAgain.statusCode).toBe(200)
    expect(readAllAgain.json()).toEqual({ status: 'read', count: 0 })

    // User 2 notification remains unread
    const u2List = await app.inject({
      method: 'GET',
      url: '/api/notifications',
      headers: { cookie: cookie2 },
    })
    expect(u2List.statusCode).toBe(200)
    const u2Items = u2List.json() as Array<{ id: string; readAt: string | null }>
    expect(u2Items.length).toBe(1)
    expect(u2Items[0]!.readAt).toBeNull()
  })

  it('deletes only the recipient\'s own notification', async () => {
    const owner = await createActiveUser()
    const other = await createActiveUser()
    const ownerCookie = await loginCookie(app, owner.email)
    const otherCookie = await loginCookie(app, other.email)
    const [kept, removed] = await db
      .insert(notifications)
      .values([
        { recipientId: owner.id, type: 'test', message: 'Keep me' },
        { recipientId: owner.id, type: 'test', message: 'Delete me' },
      ])
      .returning()
    const del = (id: string, cookie: string) =>
      app.inject({ method: 'DELETE', url: `/api/notifications/${id}`, headers: { cookie } })

    expect((await del(removed!.id, otherCookie)).statusCode).toBe(404)
    expect((await del('not-a-uuid', ownerCookie)).statusCode).toBe(400)

    const res = await del(removed!.id, ownerCookie)
    expect(res.statusCode).toBe(200)
    expect(res.json()).toEqual({ status: 'deleted' })
    expect((await del(removed!.id, ownerCookie)).statusCode).toBe(404)

    const list = await app.inject({ method: 'GET', url: '/api/notifications', headers: { cookie: ownerCookie } })
    expect(list.json()).toEqual([expect.objectContaining({ id: kept!.id, message: 'Keep me' })])
  })
})
