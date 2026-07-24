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

async function truncatedBody(res: Response, maxChars = 200): Promise<string> {
  try {
    const text = await res.text()
    return text.length > maxChars ? `${text.slice(0, maxChars)}...` : text
  } catch {
    return ''
  }
}

export async function getXautPriceUsd(): Promise<{ priceUsd: number; asOf: string }> {
  const key = process.env.COINMARKETCAP_API_KEY
  if (!key) throw new Error('COINMARKETCAP_API_KEY not set')

  const url = `${CMC_BASE}/cryptocurrency/quotes/latest?symbol=XAUT&convert=USD`
  const res = await fetchWithTimeout(url, { headers: { 'X-CMC_PRO_API_KEY': key } })
  if (!res.ok) {
    const body = await truncatedBody(res)
    throw new Error(`CMC error: ${res.status} ${body}`.trim())
  }

  const json = (await res.json()) as CmcQuoteResponse
  const data = json.data?.XAUT?.[0]
  if (!data) throw new Error('CMC: unexpected response shape')

  return { priceUsd: data.quote.USD.price, asOf: data.quote.USD.last_updated }
}

// COPm is a Mento stablecoin pegged 1:1 to Colombian peso. To derive its
// USD price we query CMC for USDT expressed in COP terms (USDT ≈ 1 USD)
// and invert. Approach avoids adding a forex-only data source and reuses
// the existing CMC integration + rate limits.
interface CmcCopQuoteResponse {
  data?: {
    USDT?: Array<{
      quote: {
        COP: {
          price: number
          last_updated: string
        }
      }
    }>
  }
}

export async function getCopmPriceUsd(): Promise<{ priceUsd: number; asOf: string }> {
  const key = process.env.COINMARKETCAP_API_KEY
  if (!key) throw new Error('COINMARKETCAP_API_KEY not set')

  const url = `${CMC_BASE}/cryptocurrency/quotes/latest?symbol=USDT&convert=COP`
  const res = await fetchWithTimeout(url, { headers: { 'X-CMC_PRO_API_KEY': key } })
  if (!res.ok) {
    const body = await truncatedBody(res)
    throw new Error(`CMC error: ${res.status} ${body}`.trim())
  }

  const json = (await res.json()) as CmcCopQuoteResponse
  const data = json.data?.USDT?.[0]
  if (!data) throw new Error('CMC: unexpected response shape for USDT/COP')

  const copPerUsdt = data.quote.COP.price
  if (!copPerUsdt || !Number.isFinite(copPerUsdt) || copPerUsdt <= 0) {
    throw new Error(`CMC: implausible COP rate ${copPerUsdt}`)
  }
  // 1 COPm ≈ 1 COP (Mento peg); 1 USDT ≈ 1 USD.
  return { priceUsd: 1 / copPerUsdt, asOf: data.quote.COP.last_updated }
}
