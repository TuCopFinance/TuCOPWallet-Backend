import { fetchWithTimeout } from './http'

const SQUID_ROUTE_URL = 'https://apiplus.squidrouter.com/v2/route'

export class SquidUpstreamError extends Error {
  constructor(
    public readonly status: number,
    public readonly retryAfter?: string,
    public readonly bodyHint?: string,
  ) {
    super(
      bodyHint
        ? `Squid upstream ${status}: ${bodyHint}`
        : `Squid upstream ${status}`,
    )
    this.name = 'SquidUpstreamError'
  }
}

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
    const retryAfter = res.headers.get('retry-after') ?? undefined
    let bodyHint: string | undefined
    try {
      const text = await res.text()
      bodyHint = text.length > 200 ? `${text.slice(0, 200)}...` : text
    } catch {
      // body unreadable; status alone is enough
    }
    throw new SquidUpstreamError(res.status, retryAfter, bodyHint)
  }
  return (await res.json()) as SquidRouteResponse
}
