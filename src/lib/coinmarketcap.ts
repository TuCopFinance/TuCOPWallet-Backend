import { fetchWithTimeout } from './http'

const CMC_BASE = 'https://pro-api.coinmarketcap.com/v2'

interface CmcQuoteResponse {
  data?: {
    XAUT?: Array<{
      quote: {
        USD: {
          price: number
          last_updated: string
        }
      }
    }>
  }
}

export async function getXautPriceUsd(): Promise<{ priceUsd: number; asOf: string }> {
  const key = process.env.COINMARKETCAP_API_KEY
  if (!key) throw new Error('COINMARKETCAP_API_KEY not set')

  const url = `${CMC_BASE}/cryptocurrency/quotes/latest?symbol=XAUT&convert=USD`
  const res = await fetchWithTimeout(url, { headers: { 'X-CMC_PRO_API_KEY': key } })
  if (!res.ok) throw new Error(`CMC error: ${res.status}`)

  const json = (await res.json()) as CmcQuoteResponse
  const data = json.data?.XAUT?.[0]
  if (!data) throw new Error('CMC: unexpected response shape')

  return { priceUsd: data.quote.USD.price, asOf: data.quote.USD.last_updated }
}
