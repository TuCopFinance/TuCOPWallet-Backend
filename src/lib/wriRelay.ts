import { createWalletClient, http, type Hex } from 'viem'
import { privateKeyToAccount } from 'viem/accounts'
import { celo } from 'viem/chains'
import { createCeloPublicClient } from './celoClient'
import { HEX_BYTES32_RE } from './hex'
import { createLogger } from './logger'

const log = createLogger('lib:wri-relay')

function buildClients(pk: Hex) {
  const account = privateKeyToAccount(pk)
  const transport = http()
  const publicClient = createCeloPublicClient()
  const walletClient = createWalletClient({ account, chain: celo, transport })
  return { account, publicClient, walletClient }
}

export type RelayClients = ReturnType<typeof buildClients>

let cached: RelayClients | null = null
let missingPkLogged = false

export function getRelayClients(): RelayClients | null {
  if (cached) return cached

  const pk = process.env.WRI_RELAY_PK
  if (!pk) {
    if (!missingPkLogged) {
      // Surface the disabled-state once at boot so a misconfigured deploy is
      // obvious in logs rather than discovered when /api/wri/* starts 503ing.
      log.error('WRI_RELAY_PK not set; /api/wri/* will return 503')
      missingPkLogged = true
    }
    return null
  }

  if (!HEX_BYTES32_RE.test(pk)) {
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
  missingPkLogged = false
}
