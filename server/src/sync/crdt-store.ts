import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { config } from '../config.js'

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

export async function saveCrdtState(vaultId: string, path: string, update: Uint8Array): Promise<void> {
  const file = crdtFile(vaultId, path)
  await mkdir(dirname(file), { recursive: true })
  const tmp = `${file}.tmp`
  await writeFile(tmp, update)
  await rename(tmp, file)
}

export async function deleteCrdtState(vaultId: string, path: string): Promise<void> {
  try {
    await rm(crdtFile(vaultId, path), { force: true })
  } catch {}
}

export async function renameCrdtState(vaultId: string, oldPath: string, newPath: string): Promise<void> {
  const oldFile = crdtFile(vaultId, oldPath)
  const newFile = crdtFile(vaultId, newPath)
  try {
    await mkdir(dirname(newFile), { recursive: true })
    await rename(oldFile, newFile)
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') {
      throw err
    }
  }
}
