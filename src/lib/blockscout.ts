import { fetchWithTimeout } from './http'
import { buildSafeQueryString, stripReservedParams } from './query'

const DEFAULT_BASE = 'https://celo.blockscout.com'

export interface BlockscoutGetInput {
  path: string
  query?: Record<string, string | string[] | undefined>
}

export async function blockscoutGet({ path, query = {} }: BlockscoutGetInput): Promise<unknown> {
  const base = process.env.BLOCKSCOUT_BASE_URL?.replace(/\/$/, '') ?? DEFAULT_BASE
  const apiKey = process.env.BLOCKSCOUT_API_KEY

  const safeQuery = stripReservedParams(query)
  if (apiKey) safeQuery.apikey = apiKey

  const qs = buildSafeQueryString(safeQuery)
  const url = qs ? `${base}${path}?${qs}` : `${base}${path}`

  const res = await fetchWithTimeout(url, { headers: { accept: 'application/json' } })
  if (!res.ok) {
    let bodyHint = ''
    try {
      const text = await res.text()
      bodyHint = text.length > 200 ? `${text.slice(0, 200)}...` : text
    } catch {
      // body unreadable; status alone is enough
    }
    throw new Error(`Blockscout error: ${res.status} ${bodyHint}`.trim())
  }

  return (await res.json()) as unknown
}
