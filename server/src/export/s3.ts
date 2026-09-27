import { createHash, createHmac } from 'node:crypto'

export interface S3Config {
  endpoint?: string
  region: string
  bucket: string
  accessKeyId: string
  secretAccessKey: string
  forcePathStyle?: boolean
}

export interface S3ObjectSummary {
  key: string
  lastModified?: Date
}

function sha256Hex(data: Buffer | string): string {
  return createHash('sha256').update(data).digest('hex')
}

function hmac(key: Buffer | string, data: string): Buffer {
  return createHmac('sha256', key).update(data).digest()
}

function getSigningKey(secretKey: string, dateStamp: string, region: string): Buffer {
  const kDate = hmac(`AWS4${secretKey}`, dateStamp)
  const kRegion = hmac(kDate, region)
  const kService = hmac(kRegion, 's3')
  return hmac(kService, 'aws4_request')
}

/**
 * Signs an HTTP request using AWS Signature Version 4 for S3-compatible APIs
 * (AWS S3, MinIO, Cloudflare R2, Google Cloud Storage S3-interoperability).
 */
export function signS3Request(
  config: S3Config,
  method: 'GET' | 'PUT' | 'DELETE',
  key: string,
  queryParams: Record<string, string> = {},
  body: Buffer | string = Buffer.alloc(0),
  contentType?: string,
  now: Date = new Date(),
): { url: string; headers: Record<string, string> } {
  const endpointUrl = new URL(config.endpoint || `https://s3.${config.region}.amazonaws.com`)
  const cleanKey = key.replace(/^\//, '')
  const forcePathStyle = config.forcePathStyle ?? (Boolean(config.endpoint) || endpointUrl.hostname === 'localhost')

  let host: string
  let pathname: string
  let fullUrl: string

  if (forcePathStyle) {
    host = endpointUrl.host
    pathname = `/${config.bucket}${cleanKey ? `/${cleanKey}` : ''}`
    fullUrl = `${endpointUrl.origin}${pathname}`
  } else {
    host = `${config.bucket}.${endpointUrl.host}`
    pathname = cleanKey ? `/${cleanKey}` : '/'
    fullUrl = `${endpointUrl.protocol}//${host}${pathname}`
  }

  const amzDate = now.toISOString().replace(/[:-]|\.\d{3}/g, '')
  const dateStamp = amzDate.slice(0, 8)
  const payloadHash = sha256Hex(body)

  const headers: Record<string, string> = {
    host,
    'x-amz-content-sha256': payloadHash,
    'x-amz-date': amzDate,
  }
  if (contentType) {
    headers['content-type'] = contentType
  }

  // Canonical Query String
  const sortedQueryParams = Object.entries(queryParams).sort(([a], [b]) => a.localeCompare(b))
  const canonicalQuery = sortedQueryParams
    .map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(v)}`)
    .join('&')

  if (canonicalQuery) {
    fullUrl += `?${canonicalQuery}`
  }

  // Canonical Headers
  const sortedHeaderKeys = Object.keys(headers).map((k) => k.toLowerCase()).sort()
  const canonicalHeaders = sortedHeaderKeys.map((k) => `${k}:${(headers[k] ?? '').trim()}\n`).join('')
  const signedHeaders = sortedHeaderKeys.join(';')

  // Canonical URI (standard URI encoding per segment)
  const canonicalUri =
    '/' +
    pathname
      .split('/')
      .filter(Boolean)
      .map(encodeURIComponent)
      .join('/') +
    (pathname.endsWith('/') && pathname !== '/' ? '/' : '')

  const canonicalRequest = [
    method,
    canonicalUri || '/',
    canonicalQuery,
    canonicalHeaders,
    signedHeaders,
    payloadHash,
  ].join('\n')

  const stringToSign = [
    'AWS4-HMAC-SHA256',
    amzDate,
    `${dateStamp}/${config.region}/s3/aws4_request`,
    sha256Hex(canonicalRequest),
  ].join('\n')

  const signingKey = getSigningKey(config.secretAccessKey, dateStamp, config.region)
  const signature = hmac(signingKey, stringToSign).toString('hex')

  headers.authorization = `AWS4-HMAC-SHA256 Credential=${config.accessKeyId}/${dateStamp}/${config.region}/s3/aws4_request, SignedHeaders=${signedHeaders}, Signature=${signature}`

  return { url: fullUrl, headers }
}

/** Uploads an object to an S3-compatible bucket. */
export async function uploadS3Object(
  config: S3Config,
  key: string,
  data: Buffer,
  contentType = 'application/zip',
): Promise<void> {
  const { url, headers } = signS3Request(config, 'PUT', key, {}, data, contentType)
  const res = await fetch(url, {
    method: 'PUT',
    headers,
    body: new Uint8Array(data),
  })
  if (!res.ok) {
    const errorText = await res.text().catch(() => '')
    throw new Error(`S3 upload failed (${res.status} ${res.statusText}): ${errorText.slice(0, 300)}`)
  }
}

/** Lists objects in an S3-compatible bucket matching a prefix. */
export async function listS3Objects(config: S3Config, prefix = ''): Promise<S3ObjectSummary[]> {
  const query: Record<string, string> = { 'list-type': '2' }
  if (prefix) query.prefix = prefix
  const { url, headers } = signS3Request(config, 'GET', '', query)
  const res = await fetch(url, { method: 'GET', headers })
  if (!res.ok) {
    const errorText = await res.text().catch(() => '')
    throw new Error(`S3 list objects failed (${res.status} ${res.statusText}): ${errorText.slice(0, 300)}`)
  }
  const text = await res.text()
  const results: S3ObjectSummary[] = []
  const contentsRegex = /<Contents>([\s\S]*?)<\/Contents>/g
  let match: RegExpExecArray | null
  while ((match = contentsRegex.exec(text)) !== null) {
    const content = match[1]
    if (!content) continue
    const keyMatch = /<Key>(.*?)<\/Key>/.exec(content)
    const dateMatch = /<LastModified>(.*?)<\/LastModified>/.exec(content)
    if (keyMatch && keyMatch[1]) {
      results.push({
        key: keyMatch[1],
        lastModified: dateMatch && dateMatch[1] ? new Date(dateMatch[1]) : undefined,
      })
    }
  }
  return results
}

/** Deletes an object from an S3-compatible bucket. */
export async function deleteS3Object(config: S3Config, key: string): Promise<void> {
  const { url, headers } = signS3Request(config, 'DELETE', key)
  const res = await fetch(url, { method: 'DELETE', headers })
  if (!res.ok && res.status !== 204 && res.status !== 404) {
    const errorText = await res.text().catch(() => '')
    throw new Error(`S3 delete object failed (${res.status} ${res.statusText}): ${errorText.slice(0, 300)}`)
  }
}
