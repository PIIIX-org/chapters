// Which model-load errors the opt-in real-model test (embedding-worker.test.ts,
// #851) reports as skipped: a download that did not finish because of the
// network or a Hugging Face outage. Anything else fails the test, in particular
// 404 "Could not locate file" and 401/403: a wrong model id or a missing file
// would break production local embedding too.
//
// Transformers.js (src/utils/hub/utils.js handleError) turns an HTTP status
// into "<reason> error occurred while trying to load file: <url>." for 400,
// 408 and 5xx, and "Error (<status>) occurred while trying to load file" for a
// status it has no text for (429, 501, ...). Node's fetch reports a network
// failure as "fetch failed", a body cut short as "terminated".

/** Statuses worth retrying another night. */
const TRANSIENT_STATUS_TEXT = /^(Request timeout|Internal server error|Bad gateway|Service unavailable|Gateway timeout) error occurred while trying to load file/
const TRANSIENT_STATUS_CODE = /^Error \((408|429|5\d\d)\) occurred while trying to load file/
const NETWORK = /^(fetch failed|terminated)$|\b(ECONNRESET|ECONNREFUSED|ETIMEDOUT|ENOTFOUND|EAI_AGAIN|UND_ERR_[A-Z_]+)\b|socket hang up/

export function isTransientDownloadFailure(message: string): boolean {
  return TRANSIENT_STATUS_TEXT.test(message) || TRANSIENT_STATUS_CODE.test(message) || NETWORK.test(message)
}
