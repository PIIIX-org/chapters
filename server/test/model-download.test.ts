import { describe, expect, it } from 'vitest'
import { isTransientDownloadFailure } from './fixtures/model-download.js'

// The skip rule of the opt-in real-model test (#851): a Hugging Face outage or
// a network failure skips it with the reason; a broken model id must fail it.
const url = 'https://huggingface.co/Xenova/bge-small-en-v1.5/resolve/main/onnx/model.onnx'

describe('real-model test: which model-load errors skip', () => {
  it.each([
    ['408', `Request timeout error occurred while trying to load file: "${url}".`],
    ['429', `Error (429) occurred while trying to load file: "${url}".`],
    ['500', `Internal server error error occurred while trying to load file: "${url}".`],
    ['502', `Bad gateway error occurred while trying to load file: "${url}".`],
    ['503', `Service unavailable error occurred while trying to load file: "${url}".`],
    ['504', `Gateway timeout error occurred while trying to load file: "${url}".`],
    ['other 5xx', `Error (520) occurred while trying to load file: "${url}".`],
    ['network', 'fetch failed'],
    ['body cut short', 'terminated'],
    ['reset', 'read ECONNRESET'],
    ['DNS', 'getaddrinfo ENOTFOUND huggingface.co'],
    ['DNS retry', 'getaddrinfo EAI_AGAIN huggingface.co'],
    ['undici timeout', 'Connect Timeout Error (UND_ERR_CONNECT_TIMEOUT)'],
    ['socket', 'socket hang up'],
  ])('skips a transient failure: %s', (_, message) => {
    expect(isTransientDownloadFailure(message)).toBe(true)
  })

  it.each([
    ['404 (wrong id or missing file)', `Could not locate file: "${url}".`],
    ['401', `Unauthorized access to file: "${url}".`],
    ['403', `Forbidden access to file: "${url}".`],
    ['400', `Bad request error occurred while trying to load file: "${url}".`],
    ['other 4xx', `Error (410) occurred while trying to load file: "${url}".`],
    ['offline cache miss', `\`local_files_only=true\`, but attempted to load a remote file from: ${url}.`],
    ['no model file', 'Unable to get model file path or buffer.'],
    ['code error', "Cannot read properties of undefined (reading 'tolist')"],
  ])('fails anything else: %s', (_, message) => {
    expect(isTransientDownloadFailure(message)).toBe(false)
  })
})
