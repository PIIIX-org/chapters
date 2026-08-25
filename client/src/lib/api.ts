export class ApiError extends Error {
  status: number
  body: unknown

  constructor(status: number, body: unknown) {
    const message =
      typeof body === 'object' && body !== null && 'error' in body && typeof (body as { error: unknown }).error === 'string'
        ? (body as { error: string }).error
        : `Request failed (${status})`
    super(message)
    this.status = status
    this.body = body
  }
}

export async function apiFetch<T>(path: string, init?: RequestInit): Promise<T> {
  // Content-Type only when there IS content. Fastify rejects a request that
  // declares `application/json` and sends nothing with
  // FST_ERR_CTP_EMPTY_JSON_BODY (400), which is every bodyless call this
  // client makes: logout, note delete, vault delete, share revoke, mark
  // notification read, approve user. Sending the header unconditionally broke
  // all of them in a real browser while every test passed, because the tests
  // stub `fetch` and never reach a server that parses the header.
  const res = await fetch(`/api${path}`, {
    ...init,
    credentials: 'include',
    headers: {
      ...(init?.body === undefined ? {} : { 'Content-Type': 'application/json' }),
      ...init?.headers,
    },
  })
  const body = await res.json().catch(() => undefined)
  if (!res.ok) throw new ApiError(res.status, body)
  return body as T
}

/** Test-only helper: builds a real Response for stubbed fetch calls. */
export function mockJsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  })
}
