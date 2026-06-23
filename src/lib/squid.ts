import { fetchWithTimeout } from './http'

const SQUID_ROUTE_URL = 'https://apiplus.squidrouter.com/v2/route'

export interface SquidRouteRequest {
  fromAddress: string
  fromChain: string
  fromToken: string
  fromAmount: string
  toChain: string
  toToken: string
  toAddress: string
  slippage: number
  quoteOnly: boolean
}

interface SquidFeeCost {
  amount?: string
  name?: string
}

interface SquidGasCost {
  amount?: string
  limit?: string
}

export interface SquidRouteResponse {
  route: {
    estimate: {
      fromAmount?: string
      toAmount?: string
      toAmountMin?: string
      exchangeRate?: string
      aggregatePriceImpact?: string
      estimatedRouteDuration?: number
      feeCosts?: SquidFeeCost[]
      gasCosts?: SquidGasCost[]
    }
    transactionRequest: {
      target?: string
      data?: string
      value?: string
      gasLimit?: string
      from?: string
    }
  }
}

export async function squidRoute(
  body: SquidRouteRequest,
  integratorId: string,
): Promise<SquidRouteResponse> {
  const res = await fetchWithTimeout(SQUID_ROUTE_URL, {
    method: 'POST',
    headers: {
      'x-integrator-id': integratorId,
      'Content-Type': 'application/json',
      accept: 'application/json',
    },
    body: JSON.stringify(body),
  })
  if (!res.ok) {
    throw new Error(`Squid error: ${res.status}`)
  }
  return (await res.json()) as SquidRouteResponse
}
