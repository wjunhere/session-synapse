/**
 * Host validation for the `/synapse` surface.
 *
 * pi-web validates `/api/*` itself (a non-loopback Host is rejected with 403),
 * but its own routes are not the only entry: the canvas is served by this
 * proxy. Loopback is always trusted; extra authorities opt in explicitly, which
 * keeps the DNS-rebinding defense pi-web already has.
 */
const MAX_BODY_BYTES = 32 * 1024

export function createGuard(trustedHosts = []) {
  const trusted = new Set([
    'localhost',
    '127.0.0.1',
    '::1',
    '[::1]',
    ...trustedHosts.map(host => String(host).trim().toLowerCase()).filter(Boolean),
  ])
  return function isTrustedHost(hostHeader) {
    const hostname = String(hostHeader ?? '').replace(/:\d+$/, '').toLowerCase()
    if (hostname === '') return false
    return trusted.has(hostname)
  }
}

/** Read a JSON request body, bounded so a large body cannot exhaust memory. */
export async function readJson(req) {
  const chunks = []
  let length = 0
  for await (const chunk of req) {
    length += chunk.length
    if (length > MAX_BODY_BYTES) throw new InputError('请求内容过大')
    chunks.push(chunk)
  }
  if (length === 0) return {}
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8'))
  } catch {
    throw new InputError('请求不是有效 JSON')
  }
}

export function sendJson(res, status, body) {
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' })
  res.end(JSON.stringify(body))
}

export function sendFile(res, contentType, body) {
  res.writeHead(200, { 'content-type': contentType, 'cache-control': 'no-store' })
  res.end(body)
}

export class InputError extends Error {}
export class NotFoundError extends Error {}