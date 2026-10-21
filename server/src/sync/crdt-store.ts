import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { config } from '../config.js'

/**
 * `.crdt/<path>.bin`: the Yjs state of a note, keyed by path, as the relay
 * kept it before ADR-003 S2b. Nothing writes it any more; the S2b backfill
 * (collab-backfill.ts) attaches each bin to `note_crdt` once and then
 * renames `.crdt/` to `.crdt.pre-adr-003/`.
 */
export function crdtFile(vaultId: string, path: string): string {
  return join(config.dataDir, 'vaults', vaultId, '.crdt', `${path}.bin`)
}

export async function loadCrdtState(vaultId: string, path: string): Promise<Uint8Array | null> {
  try {
    const buf = await readFile(crdtFile(vaultId, path))
    return new Uint8Array(buf.buffer, buf.byteOffset, buf.byteLength)
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return null
    throw err
  }
}
