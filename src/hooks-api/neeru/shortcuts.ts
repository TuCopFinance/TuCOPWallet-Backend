import type { ShortcutDefinition } from './types'

export const NEERU_APP_ID = 'neeru-vaults' as const

const NETWORK_ID = 'celo-mainnet' as const

const SHORTCUTS: ShortcutDefinition[] = [
  {
    id: 'deposit',
    appId: NEERU_APP_ID,
    name: 'Deposit',
    description: 'Deposit COPm into a Neeru Vault tranche',
    networkIds: [NETWORK_ID],
    category: 'deposit',
  },
  {
    id: 'withdraw',
    appId: NEERU_APP_ID,
    name: 'Withdraw',
    description: 'Close a Neeru Vault position',
    networkIds: [NETWORK_ID],
    category: 'withdraw',
  },
  {
    id: 'withdraw-principal-only',
    appId: NEERU_APP_ID,
    name: 'Emergency withdraw',
    description:
      'Close a position recovering only principal (no interest)',
    networkIds: [NETWORK_ID],
    category: 'withdraw',
  },
]

export function getNeeruShortcuts(): ShortcutDefinition[] {
  return SHORTCUTS.map((s) => ({ ...s, networkIds: [...s.networkIds] }))
}
