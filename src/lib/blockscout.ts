const DEFAULT_BASE = 'https://celo.blockscout.com'

export async function blockscoutGet(pathAndQuery: string): Promise<unknown> {
  const base = process.env.BLOCKSCOUT_BASE_URL?.replace(/\/$/, '') ?? DEFAULT_BASE
  const apiKey = process.env.BLOCKSCOUT_API_KEY

  let url = `${base}${pathAndQuery}`
  if (apiKey) {
    url += pathAndQuery.includes('?') ? `&apikey=${apiKey}` : `?apikey=${apiKey}`
  }

  const res = await fetch(url, { headers: { accept: 'application/json' } })
  if (!res.ok) throw new Error(`Blockscout error: ${res.status}`)

  return (await res.json()) as unknown
}
