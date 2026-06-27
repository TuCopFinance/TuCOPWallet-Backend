import type { AbiFunction } from 'viem'

// View-function ABI fragments the hooks-api layer needs on top of what
// the indexer already declares in src/neeru-indexer/abi.ts. Output names
// are opaque (r0..r3); callers access by index.

export const TRANCHES_FN_ABI = {
  type: 'function',
  name: 'tranches',
  stateMutability: 'view',
  inputs: [{ name: '', type: 'uint8' }],
  outputs: [
    { name: 'r0', type: 'uint256' },
    { name: 'r1', type: 'uint256' },
    { name: 'r2', type: 'uint256' },
    { name: 'r3', type: 'uint256' },
  ],
} as const satisfies AbiFunction

export const PREVIEW_ACCRUED_INTEREST_FN_ABI = {
  type: 'function',
  name: 'previewAccruedInterest',
  stateMutability: 'view',
  inputs: [{ name: '', type: 'uint256' }],
  outputs: [{ name: '', type: 'uint256' }],
} as const satisfies AbiFunction

export const EARLY_CLAIM_PENALTY_BPS_FN_ABI = {
  type: 'function',
  name: 'earlyClaimPenaltyBps',
  stateMutability: 'view',
  inputs: [],
  outputs: [{ name: '', type: 'uint256' }],
} as const satisfies AbiFunction

export const DEPOSITS_PAUSED_FN_ABI = {
  type: 'function',
  name: 'depositsPaused',
  stateMutability: 'view',
  inputs: [],
  outputs: [{ name: '', type: 'bool' }],
} as const satisfies AbiFunction

export const GLOBAL_TVL_FN_ABI = {
  type: 'function',
  name: 'globalTvl',
  stateMutability: 'view',
  inputs: [],
  outputs: [{ name: '', type: 'uint256' }],
} as const satisfies AbiFunction

export const GLOBAL_CAP_FN_ABI = {
  type: 'function',
  name: 'globalCap',
  stateMutability: 'view',
  inputs: [],
  outputs: [{ name: '', type: 'uint256' }],
} as const satisfies AbiFunction

export const MIN_DEPOSIT_FN_ABI = {
  type: 'function',
  name: 'minDeposit',
  stateMutability: 'view',
  inputs: [],
  outputs: [{ name: '', type: 'uint256' }],
} as const satisfies AbiFunction

export const HOOKS_READ_ABI = [
  TRANCHES_FN_ABI,
  PREVIEW_ACCRUED_INTEREST_FN_ABI,
  EARLY_CLAIM_PENALTY_BPS_FN_ABI,
  DEPOSITS_PAUSED_FN_ABI,
  GLOBAL_TVL_FN_ABI,
  GLOBAL_CAP_FN_ABI,
  MIN_DEPOSIT_FN_ABI,
] as const

// ERC20 view bits the deposit-token resolver needs. Minimal subset to
// avoid pulling viem's erc20Abi (which is permissive on outputs we don't
// consume).
export const ERC20_DECIMALS_FN_ABI = {
  type: 'function',
  name: 'decimals',
  stateMutability: 'view',
  inputs: [],
  outputs: [{ name: '', type: 'uint8' }],
} as const satisfies AbiFunction

export const ERC20_SYMBOL_FN_ABI = {
  type: 'function',
  name: 'symbol',
  stateMutability: 'view',
  inputs: [],
  outputs: [{ name: '', type: 'string' }],
} as const satisfies AbiFunction

export const ERC20_READ_ABI = [
  ERC20_DECIMALS_FN_ABI,
  ERC20_SYMBOL_FN_ABI,
] as const
