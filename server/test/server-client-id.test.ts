// #408: a server write that inserts where a person is typing (the end of the
// note, while the lab's S1 agent appends a line) races the keystrokes still
// in flight: the change is compiled against the document as it was before
// the write, and Yjs orders two inserts at one spot by client id. With a
// random uint32 server id, the person's next characters landed after the
// agent's line in about half the server processes (lab run 39609582716:
// " a08 a" / AGENT-S1 / "09 a10"). The server's id is above every editor's
// (editors draw a uint32), so concurrent typing keeps its place.
import { describe, expect, it } from 'vitest'
import * as Y from 'yjs'
import { SERVER_CLIENT_ID, cloneDocument, compileChange, docState } from '../src/sync/live-docs.js'

describe('a server change and typing in flight at the same spot (#408)', () => {
  it("puts the person's keystrokes before the server's insert, whatever the editor's client id", () => {
    for (const editorId of [0, 1, 0x7fffffff, 0xfffffffe, 0xffffffff]) {
      const relay = new Y.Doc()
      relay.getText('body').insert(0, 'line\n a08 a')
      const editor = new Y.Doc()
      editor.clientID = editorId
      Y.applyUpdate(editor, Y.encodeStateAsUpdate(relay))

      // The agent's line is compiled against the relay's state; the person types "09" meanwhile.
      const update = compileChange(cloneDocument(relay), { ...docState(relay), body: 'line\n a08 a\nAGENT\n' })
      editor.getText('body').insert(editor.getText('body').length, '09')
      Y.applyUpdate(relay, update)
      Y.applyUpdate(relay, Y.encodeStateAsUpdate(editor, Y.encodeStateVector(relay)))
      Y.applyUpdate(editor, Y.encodeStateAsUpdate(relay, Y.encodeStateVector(editor)))

      expect(editor.getText('body').toString(), `editor client ${editorId}`).toBe('line\n a08 a09\nAGENT\n')
      expect(relay.getText('body').toString()).toBe(editor.getText('body').toString())
    }
  })

  it("is a safe integer above every uint32, so no editor's id is above it", () => {
    expect(SERVER_CLIENT_ID).toBeGreaterThan(0xffffffff)
    expect(Number.isSafeInteger(SERVER_CLIENT_ID)).toBe(true)
  })
})
