import { createHash } from 'node:crypto'
import { EMBEDDER_ID } from './embeddings.js'

/**
 * Version of how a file is cut into blocks and of each block's embedded
 * text (#452, ADR-004 §2.4 `chunk`): repositories/code-blocks.ts (and, with
 * #452b, note blocks). Bump it with any change to the block kinds, their
 * spans, the small-file limits or the block texts: it is part of the
 * extraction job key and stored on `repository_files.chunk_version`, so the
 * next boot re-extracts every file. Blocks whose embedded text the bump did
 * not change keep their vectors (`embedKey`).
 * 1: symbol, skeleton and file blocks (#413, #452a).
 */
export const CHUNK_VERSION = 1

/**
 * What a block's vector was made from (ADR-004 §2.4 `embed_key`): the first
 * 16 hex characters of sha256(`EMBEDDER_ID` + `\n` + the embedded text).
 * Stored on every embedded `blocks` row (null: not embedded, e.g. over the
 * per-file symbol budget). A re-extraction reuses the vector of a block of
 * the same owner with the same key instead of embedding the text again, so
 * a version bump, a line shift or an edit elsewhere re-embeds only the
 * blocks whose text or model changed. Reads `EMBEDDER_ID` at each call, so a
 * test that changes it changes the key.
 */
export function embedKey(text: string): string {
  return createHash('sha256').update(`${EMBEDDER_ID}\n${text}`).digest('hex').slice(0, 16)
}
