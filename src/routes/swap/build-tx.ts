// Wallet spec: `tasks/specs/wallet-consumer-spec.md` section "Uniswap V4
// executor (Fase 2)". Any change to wire shape here must update the spec.
import { Router, Request, Response } from 'express'
import { createLogger } from '../../lib/logger'
import { POOL_USDT_COPM } from '../../lib/uniswapV4'
import { buildV4SwapCalldata } from '../../lib/uniswapV4Executor'
import { firstZodIssueAsError } from '../schemas/common'
import {
  swapBuildTxSchema,
  type SwapBuildTxInput,
} from '../schemas/swap'

const router = Router()
const log = createLogger('routes:swap:build-tx')

// POST /api/swap/build-tx - Fase 2 Uniswap V4 executor
//
// Called by the wallet AFTER it has signed the Permit2 typed data returned
// from GET /api/swap/quote (uniswap-v4 path). Body carries the signature
// plus the exact PermitSingle values the wallet signed. Backend re-validates,
// asserts the pair matches the USDT<->COPm pool + the signed token matches
// the sell token, then rebuilds the UniversalRouter.execute() calldata
// server-side and returns the final tx bytes {to, data, value}.
//
// Gated behind SWAP_FALLBACK_UNISWAP_V4_ACTIVE. Returns 503 when off,
// 400 on any input mismatch, 200 with the tx on success.
router.post('/api/swap/build-tx', async (req: Request, res: Response) => {
  if (process.env.SWAP_FALLBACK_UNISWAP_V4_ACTIVE !== 'true') {
    return res.status(503).json({ error: 'uniswap v4 executor not enabled' })
  }
  const parsed = swapBuildTxSchema.safeParse(req.body)
  if (!parsed.success) {
    return res.status(400).json({ error: firstZodIssueAsError(parsed.error) })
  }
  const body: SwapBuildTxInput = parsed.data

  // Pair sanity check. The direction + permitToken combination must map to
  // the known USDT<->COPm pool.
  const expectedSellToken =
    body.direction === 'USDT_TO_COPM'
      ? POOL_USDT_COPM.currency0
      : POOL_USDT_COPM.currency1
  if (body.permitToken !== expectedSellToken) {
    return res
      .status(400)
      .json({ error: 'permitToken does not match direction sell token' })
  }
  // The permit amount must cover the swap. If the wallet signed less than
  // sellAmount, the swap would revert at SETTLE_ALL.
  if (BigInt(body.permitAmount) < BigInt(body.sellAmount)) {
    return res
      .status(400)
      .json({ error: 'permitAmount is less than sellAmount' })
  }

  try {
    const tx = buildV4SwapCalldata({
      direction: body.direction,
      recipient: body.userAddress as `0x${string}`,
      sellAmount: BigInt(body.sellAmount),
      minBuyAmount: BigInt(body.minBuyAmount),
      deadline: BigInt(body.deadline),
      permit2Signature: body.permit2Signature as `0x${string}`,
      permitDetails: {
        token: body.permitToken as `0x${string}`,
        amount: BigInt(body.permitAmount),
        expiration: body.permitExpiration,
        nonce: body.permitNonce,
      },
      permitSigDeadline: BigInt(body.permitSigDeadline),
    })
    // Emit a structured audit log symmetric to the squid_integrator_fee log
    // so we can reconcile Uniswap swap volume + fee routing off-chain.
    log.warn(
      JSON.stringify({
        event: 'uniswap_v4_build_tx',
        direction: body.direction,
        userAddress: body.userAddress,
        sellAmount: body.sellAmount,
        minBuyAmount: body.minBuyAmount,
        deadline: body.deadline,
        permitNonce: body.permitNonce,
        permitAmount: body.permitAmount,
      }),
    )
    return res.json({
      to: tx.to,
      data: tx.data,
      value: tx.value.toString(),
    })
  } catch (err) {
    log.warn(
      'buildV4SwapCalldata failed:',
      err instanceof Error ? err.message : err,
    )
    return res.status(400).json({ error: 'invalid build-tx params' })
  }
})

export default router
