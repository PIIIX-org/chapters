// The benchmark never runs against production (#572): the only instance it
// may call is the lab instance the workflow builds from the commit under
// test, which listens on this machine (lab/bootstrap.ts, LAB_BASE_URL
// default http://localhost:3000).

const LOOPBACK = new Set(['localhost', '127.0.0.1', '[::1]'])

/** The parsed URL when it is a loopback lab instance; throws for anything else. */
export function assertLabBaseUrl(raw: string): URL {
  let url: URL
  try {
    url = new URL(raw)
  } catch {
    throw new Error(`refusing to benchmark "${raw}": not a URL`)
  }
  if (url.protocol !== 'http:' || !LOOPBACK.has(url.hostname) || url.username || url.password) {
    throw new Error(`refusing to benchmark ${url.origin}: only the lab instance on this machine (http://localhost:<port>) may be measured, never production`)
  }
  return url
}
