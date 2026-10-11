import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { rm, readFile } from 'node:fs/promises'
import { join } from 'node:path'
import * as Y from 'yjs'
import { config } from '../src/config.js'
import {
  crdtFile,
  loadCrdtState,
  saveCrdtState,
  deleteCrdtState,
  renameCrdtState,
} from '../src/sync/crdt-store.js'

describe('crdt-store', () => {
  const vaultId = 'v-test-crdt'
  const path = 'docs/sample'
  const targetDir = join(config.dataDir, 'vaults', vaultId)

  beforeEach(async () => {
    await rm(targetDir, { recursive: true, force: true })
  })

  afterEach(async () => {
    await rm(targetDir, { recursive: true, force: true })
  })

  it('returns null when loading non-existent crdt state', async () => {
    const loaded = await loadCrdtState(vaultId, path)
    expect(loaded).toBeNull()
  })

  it('saves and loads binary Yjs CRDT state accurately', async () => {
    const doc = new Y.Doc()
    doc.getText('body').insert(0, 'Hello from CRDT store!')
    doc.getMap('frontmatter').set('type', 'docs')
    doc.getMap('frontmatter').set('tags', ['crdt', 'persistence'])

    const update = Y.encodeStateAsUpdate(doc)
    await saveCrdtState(vaultId, path, update)

    const loadedUpdate = await loadCrdtState(vaultId, path)
    expect(loadedUpdate).not.toBeNull()

    const loadedDoc = new Y.Doc()
    Y.applyUpdate(loadedDoc, loadedUpdate!)

    expect(loadedDoc.getText('body').toString()).toBe('Hello from CRDT store!')
    expect(loadedDoc.getMap('frontmatter').toJSON()).toEqual({
      type: 'docs',
      tags: ['crdt', 'persistence'],
    })
  })

  it('renames crdt state when note is moved', async () => {
    const doc = new Y.Doc()
    doc.getText('body').insert(0, 'Content to rename')
    await saveCrdtState(vaultId, path, Y.encodeStateAsUpdate(doc))

    const newPath = 'docs/renamed'
    await renameCrdtState(vaultId, path, newPath)

    expect(await loadCrdtState(vaultId, path)).toBeNull()
    const loaded = await loadCrdtState(vaultId, newPath)
    expect(loaded).not.toBeNull()

    const restoredDoc = new Y.Doc()
    Y.applyUpdate(restoredDoc, loaded!)
    expect(restoredDoc.getText('body').toString()).toBe('Content to rename')
  })

  it('deletes crdt state when note is purged', async () => {
    const doc = new Y.Doc()
    doc.getText('body').insert(0, 'Content to delete')
    await saveCrdtState(vaultId, path, Y.encodeStateAsUpdate(doc))

    expect(await loadCrdtState(vaultId, path)).not.toBeNull()
    await deleteCrdtState(vaultId, path)
    expect(await loadCrdtState(vaultId, path)).toBeNull()
  })

  it('reconnecting with existing Y.Doc after server reload does not duplicate text when CRDT state is preserved', () => {
    // 1. Initial document created on server
    const serverDoc1 = new Y.Doc()
    serverDoc1.getText('body').insert(0, 'Initial note text')

    // 2. Client connects and syncs
    const clientDoc = new Y.Doc()
    Y.applyUpdate(clientDoc, Y.encodeStateAsUpdate(serverDoc1))
    expect(clientDoc.getText('body').toString()).toBe('Initial note text')

    // 3. Persist server CRDT state
    const savedUpdate = Y.encodeStateAsUpdate(serverDoc1)

    // 4. Server unloads document. Later server reloads document WITH saved CRDT state:
    const serverDoc2 = new Y.Doc()
    Y.applyUpdate(serverDoc2, savedUpdate)

    // 5. Client reconnects with its existing in-memory Y.Doc (sync exchange):
    const clientUpdate = Y.encodeStateAsUpdate(clientDoc, Y.encodeStateVector(serverDoc2))
    const serverUpdate = Y.encodeStateAsUpdate(serverDoc2, Y.encodeStateVector(clientDoc))
    Y.applyUpdate(serverDoc2, clientUpdate)
    Y.applyUpdate(clientDoc, serverUpdate)

    // 6. Verification: NO duplication! Text remains identical!
    expect(clientDoc.getText('body').toString()).toBe('Initial note text')
    expect(serverDoc2.getText('body').toString()).toBe('Initial note text')
  })

  it('demonstrates bug duplication if CRDT state were NOT preserved (seeding plain text into new Y.Doc)', () => {
    // 1. Server seeds plain text into Y.Doc 1
    const serverDoc1 = new Y.Doc()
    serverDoc1.getText('body').insert(0, 'Duplication test')

    // 2. Client connects and gets text
    const clientDoc = new Y.Doc()
    Y.applyUpdate(clientDoc, Y.encodeStateAsUpdate(serverDoc1))
    expect(clientDoc.getText('body').toString()).toBe('Duplication test')

    // 3. Server unloads. Server reloads by seeding plain text into a fresh Y.Doc (WITHOUT saved CRDT state):
    const serverDocUnloaded = new Y.Doc()
    serverDocUnloaded.getText('body').insert(0, 'Duplication test')

    // 4. Client reconnects with its in-memory Y.Doc:
    const clientUpdate = Y.encodeStateAsUpdate(clientDoc, Y.encodeStateVector(serverDocUnloaded))
    const serverUpdate = Y.encodeStateAsUpdate(serverDocUnloaded, Y.encodeStateVector(clientDoc))
    Y.applyUpdate(serverDocUnloaded, clientUpdate)
    Y.applyUpdate(clientDoc, serverUpdate)

    // 5. Without CRDT persistence, Yjs sees two independent insertions at index 0 and duplicates!
    expect(clientDoc.getText('body').toString()).toBe('Duplication testDuplication test')
    expect(serverDocUnloaded.getText('body').toString()).toBe('Duplication testDuplication test')
  })

  it('agent edit via CRDT transaction cleanly updates client on reconnect without duplication', () => {
    // 1. Client and server start in sync
    const serverDoc = new Y.Doc()
    serverDoc.getText('body').insert(0, 'Initial text')
    const clientDoc = new Y.Doc()
    Y.applyUpdate(clientDoc, Y.encodeStateAsUpdate(serverDoc))

    // 2. Agent performs edit through CRDT transaction (delete + insert)
    const bodyText = serverDoc.getText('body')
    bodyText.delete(0, bodyText.length)
    bodyText.insert(0, 'Updated by AI Agent')

    // 3. Server saves CRDT state
    const savedUpdate = Y.encodeStateAsUpdate(serverDoc)

    // 4. Server unloads and later reloads with saved CRDT state
    const reloadedServerDoc = new Y.Doc()
    Y.applyUpdate(reloadedServerDoc, savedUpdate)

    // 5. Client (which was in another tab) syncs with server
    const clientUpdate = Y.encodeStateAsUpdate(clientDoc, Y.encodeStateVector(reloadedServerDoc))
    const serverUpdate = Y.encodeStateAsUpdate(reloadedServerDoc, Y.encodeStateVector(clientDoc))
    Y.applyUpdate(reloadedServerDoc, clientUpdate)
    Y.applyUpdate(clientDoc, serverUpdate)

    // 6. Clean update: no duplicate text
    expect(clientDoc.getText('body').toString()).toBe('Updated by AI Agent')
    expect(reloadedServerDoc.getText('body').toString()).toBe('Updated by AI Agent')
  })
})
