import { createPublicClient, createWalletClient, http, type Hex } from 'viem'
import { privateKeyToAccount } from 'viem/accounts'
import { celo } from 'viem/chains'
import { createLogger } from './logger'

const log = createLogger('lib:wri-relay')

function buildClients(pk: Hex) {
  const account = privateKeyToAccount(pk)
  const transport = http()
  const publicClient = createPublicClient({ chain: celo, transport })
  const walletClient = createWalletClient({ account, chain: celo, transport })
  return { account, publicClient, walletClient }
}

export type RelayClients = ReturnType<typeof buildClients>

let cached: RelayClients | null = null

export function getRelayClients(): RelayClients | null {
  if (cached) return cached

  const pk = process.env.WRI_RELAY_PK
  if (!pk) return null

  if (!/^0x[a-fA-F0-9]{64}$/.test(pk)) {
    log.error('WRI_RELAY_PK is set but not a valid 32-byte hex; refusing to load')
    return null
  }

  const built = buildClients(pk as Hex)
  log.info(`relay hot wallet loaded: ${built.account.address}`)
  cached = built
  return cached
}

export function _resetRelayClientsForTests(): void {
  cached = null
}
