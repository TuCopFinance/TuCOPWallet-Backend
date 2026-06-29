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
