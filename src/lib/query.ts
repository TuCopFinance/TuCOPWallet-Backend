const RESERVED = new Set(['apikey', 'api_key'])
const MAX_CACHE_KEY_LEN = 512

type QueryInput = Record<string, string | string[] | undefined>
type CleanQuery = Record<string, string>

export function stripReservedParams(query: QueryInput): CleanQuery {
  const out: CleanQuery = {}
  for (const [rawKey, rawVal] of Object.entries(query)) {
    if (rawVal === undefined) continue
    if (RESERVED.has(rawKey.toLowerCase())) continue
    out[rawKey] = Array.isArray(rawVal) ? rawVal.join(',') : String(rawVal)
  }
  return out
}

export function buildSafeQueryString(query: CleanQuery): string {
  const entries = Object.entries(query).sort(([a], [b]) => a.localeCompare(b))
  return entries.map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(v)}`).join('&')
}

export function buildCacheKey(namespace: string, path: string, query: QueryInput): string {
  const clean = stripReservedParams(query)
  const qs = buildSafeQueryString(clean)
  const key = qs ? `${namespace}:${path}?${qs}` : `${namespace}:${path}`
  return key.length > MAX_CACHE_KEY_LEN ? key.slice(0, MAX_CACHE_KEY_LEN) : key
}
