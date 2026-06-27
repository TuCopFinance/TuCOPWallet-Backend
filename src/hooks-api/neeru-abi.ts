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

// ERC20 allowance fragment used by the deposit preflight to decide
// whether an approve tx must precede the deposit call.
export const ERC20_ALLOWANCE_FN_ABI = {
  type: 'function',
  name: 'allowance',
  stateMutability: 'view',
  inputs: [
    { name: '', type: 'address' },
    { name: '', type: 'address' },
  ],
  outputs: [{ name: '', type: 'uint256' }],
} as const satisfies AbiFunction

export const ERC20_ALLOWANCE_ABI = [ERC20_ALLOWANCE_FN_ABI] as const

// Nonpayable function fragments the trigger handlers encode for the
// wallet to sign. Input names are kept empty so viem accepts positional
// args without leaking field semantics into source.
export const DEPOSIT_FN_ABI = {
  type: 'function',
  name: 'deposit',
  stateMutability: 'nonpayable',
  inputs: [
    { name: '', type: 'uint256' },
    { name: '', type: 'uint8' },
  ],
  outputs: [],
} as const satisfies AbiFunction

export const CLOSE_POSITION_FN_ABI = {
  type: 'function',
  name: 'closePosition',
  stateMutability: 'nonpayable',
  inputs: [{ name: '', type: 'uint256' }],
  outputs: [],
} as const satisfies AbiFunction

export const CLOSE_POSITION_PRINCIPAL_ONLY_FN_ABI = {
  type: 'function',
  name: 'closePositionPrincipalOnly',
  stateMutability: 'nonpayable',
  inputs: [{ name: '', type: 'uint256' }],
  outputs: [],
} as const satisfies AbiFunction

export const ERC20_APPROVE_FN_ABI = {
  type: 'function',
  name: 'approve',
  stateMutability: 'nonpayable',
  inputs: [
    { name: '', type: 'address' },
    { name: '', type: 'uint256' },
  ],
  outputs: [{ name: '', type: 'bool' }],
} as const satisfies AbiFunction

export const ERC20_WRITE_ABI = [ERC20_APPROVE_FN_ABI] as const

export const HOOKS_WRITE_ABI = [
  DEPOSIT_FN_ABI,
  CLOSE_POSITION_FN_ABI,
  CLOSE_POSITION_PRINCIPAL_ONLY_FN_ABI,
  ERC20_APPROVE_FN_ABI,
] as const
