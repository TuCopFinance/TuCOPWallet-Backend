import { z } from 'zod'
import {
  zBoolString,
  zHexAddressLower,
} from './common'

// uint256 max is 78 decimal digits. Anything beyond that is invalid for the
// upstream payload AND wastes cache-key space; reject early.
const MAX_SELL_AMOUNT_DIGITS = 78

const zNetworkIdSlug = z
  .string()
  .regex(/^[a-z0-9-]+$/, { message: 'invalid network id slug' })

const zSellAmount = z
  .string()
  .regex(/^\d+$/, { message: 'invalid sellAmount' })
  .max(MAX_SELL_AMOUNT_DIGITS, { message: 'invalid sellAmount' })

const zSlippage = z
  .string()
  .regex(/^\d+(\.\d+)?$/, { message: 'invalid slippagePercentage' })
  .transform((v) => Number(v))
  .refine((n) => Number.isFinite(n) && n >= 0 && n <= 100, {
    message: 'invalid slippagePercentage',
  })

// Express query strings parse arrays as `string | string[] | ParsedQs`. The
// schema below uses string-only fields; if a duplicate key produces an array,
// safeParse fails with "invalid <key>".
export const swapQuoteQuerySchema = z
  .object({
    buyToken: zHexAddressLower,
    buyIsNative: zBoolString,
    buyNetworkId: zNetworkIdSlug,
    sellToken: zHexAddressLower,
    sellIsNative: zBoolString,
    sellNetworkId: zNetworkIdSlug,
    sellAmount: zSellAmount,
    userAddress: zHexAddressLower,
    slippagePercentage: zSlippage.optional().default(0.5),
    quoteOnly: zBoolString.optional().default(false),
  })
  // Strict mode: any extra key triggers a "Unrecognized key" issue, which the
  // route handler converts to the canonical "unknown param" 400.
  .strict()

export type SwapQuoteInput = z.infer<typeof swapQuoteQuerySchema>

// ----------------------------------------------------------------------------
// POST /api/swap/build-tx (Fase 2 Uniswap V4 executor)
// ----------------------------------------------------------------------------

// 0x + 130 hex = 65-byte compact signature (r || s || v).
const zSignature65 = z
  .string()
  .regex(/^0x[0-9a-fA-F]{130}$/, { message: 'invalid permit2Signature' })

// uint256-shaped decimal string. Reused shape from sellAmount.
const zUint256 = z
  .string()
  .regex(/^\d+$/, { message: 'invalid uint256' })
  .max(MAX_SELL_AMOUNT_DIGITS, { message: 'invalid uint256' })

// uint48-shaped integer. Accepts JSON number or numeric string (uint48 max
// 2^48-1 fits in JS number range).
const zUint48 = z
  .union([
    z.string().regex(/^\d+$/).transform((v) => Number(v)),
    z.number().int().nonnegative(),
  ])
  .refine((n) => n >= 0 && n < 2 ** 48, {
    message: 'invalid uint48',
  })

// Wallet POSTs its signed Permit2 typed data plus the quote params it
// already validated locally. Backend re-validates, rebuilds calldata with
// the signature spliced in server-side, returns the final unsigned tx.
export const swapBuildTxSchema = z
  .object({
    direction: z.enum(['USDT_TO_COPM', 'COPM_TO_USDT']),
    userAddress: zHexAddressLower,
    sellAmount: zSellAmount,
    // User's floor amount for the OUTPUT token AFTER fee deduction. The
    // build-tx endpoint sets the pool-side amountOutMinimum slightly higher
    // to leave room for the TAKE_PORTION fee.
    minBuyAmount: zUint256,
    // Unix seconds. Enforced by UniversalRouter.execute; a stale deadline
    // reverts on-chain instantly.
    deadline: zUint256,
    permit2Signature: zSignature65,
    permitToken: zHexAddressLower,
    permitAmount: zUint256,
    permitExpiration: zUint48,
    permitNonce: zUint48,
    permitSigDeadline: zUint256,
  })
  .strict()

export type SwapBuildTxInput = z.infer<typeof swapBuildTxSchema>
