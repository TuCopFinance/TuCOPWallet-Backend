import type { PublicClient } from 'viem'
import {
  createNeeruRpc,
  ENDPOINT_SKIP_DURATION_MS,
} from './rpc'
import {
  getAnkrRpcUrl,
  getDrpcRpcUrl,
  getFornoUrl,
  getPrimaryRpcUrl,
} from '../lib/celoClient'

type Call = 'alchemy' | 'primary' | 'forno' | 'ankr' | 'drpc'

interface MockClients {
  alchemy?: PublicClient
  primary: PublicClient
  forno: PublicClient
  ankr: PublicClient
  drpc: PublicClient
  calls: Call[]
}

interface MockClientOptions {
  alchemyBehavior?: () => Promise<bigint>
  primaryBehavior: () => Promise<bigint>
  fornoBehavior: () => Promise<bigint>
  ankrBehavior: () => Promise<bigint>
  drpcBehavior: () => Promise<bigint>
}

function buildMockClients(opts: MockClientOptions): MockClients {
  const calls: Call[] = []
  const make = (name: Call, behavior: () => Promise<bigint>): PublicClient =>
    ({
      getBlockNumber: async () => {
        calls.push(name)
        return behavior()
      },
    }) as unknown as PublicClient

  return {
    ...(opts.alchemyBehavior
      ? { alchemy: make('alchemy', opts.alchemyBehavior) }
      : {}),
    primary: make('primary', opts.primaryBehavior),
    forno: make('forno', opts.fornoBehavior),
    ankr: make('ankr', opts.ankrBehavior),
    drpc: make('drpc', opts.drpcBehavior),
    calls,
  }
}

// Chain order aligned with the shared `getCeloRpcFallbackUrls()` (see
// `src/lib/celoClient.ts` for the full 8-endpoint order + rationale).
// In tests only the env-defaulted URLs (forno/ankr/drpc/primary) plus
// injected overrides get populated, so the effective test chain is
// [alchemy?, forno, ankr, drpc, primary]. Publicnode/blockscout/thirdweb
// are optional and stay unset in tests.
describe('createNeeruRpc', () => {
  // Effective test chain: [alchemy?, forno, ankr, drpc, primary].
  it('when Alchemy client is injected, tries Alchemy first + never falls through', async () => {
    // Guards the 2026-08-08 change that inserts Alchemy at position 0 of
    // the chain when ALCHEMY_RPC_URL is set. All other endpoints throw so
    // any fall-through would be visible via `mocks.calls`.
    const mocks = buildMockClients({
      alchemyBehavior: async () => 999n,
      primaryBehavior: async () => {
        throw new Error('should not be called')
      },
      fornoBehavior: async () => {
        throw new Error('should not be called')
      },
      ankrBehavior: async () => {
        throw new Error('should not be called')
      },
      drpcBehavior: async () => {
        throw new Error('should not be called')
      },
    })
    const rpc = createNeeruRpc({
      endpoints: {
        alchemy: mocks.alchemy!,
        primary: mocks.primary,
        forno: mocks.forno,
        ankr: mocks.ankr,
        drpc: mocks.drpc,
      },
    })
    expect(await rpc.getBlockNumber()).toBe(999n)
    expect(mocks.calls).toEqual(['alchemy'])
  })

  it('when Alchemy fails, cascades to Forno and preserves the rest of the chain', async () => {
    const mocks = buildMockClients({
      alchemyBehavior: async () => {
        throw new Error('alchemy 503')
      },
      primaryBehavior: async () => {
        throw new Error('should not be called')
      },
      fornoBehavior: async () => 111n,
      ankrBehavior: async () => {
        throw new Error('should not be called')
      },
      drpcBehavior: async () => {
        throw new Error('should not be called')
      },
    })
    const rpc = createNeeruRpc({
      endpoints: {
        alchemy: mocks.alchemy!,
        primary: mocks.primary,
        forno: mocks.forno,
        ankr: mocks.ankr,
        drpc: mocks.drpc,
      },
    })
    expect(await rpc.getBlockNumber()).toBe(111n)
    expect(mocks.calls).toEqual(['alchemy', 'forno'])
  })

  it('when no Alchemy client is injected, chain starts at Forno', async () => {
    // Backwards-compat guard. When ALCHEMY_RPC_URL is not set in the env
    // AND options.endpoints.alchemy is not passed, the chain must be
    // exactly the shared-chain order minus the optional slots:
    // [forno, ankr, drpc, primary].
    const mocks = buildMockClients({
      primaryBehavior: async () => {
        throw new Error('should not be called')
      },
      fornoBehavior: async () => 42n,
      ankrBehavior: async () => {
        throw new Error('should not be called')
      },
      drpcBehavior: async () => {
        throw new Error('should not be called')
      },
    })
    const rpc = createNeeruRpc({
      endpoints: {
        primary: mocks.primary,
        forno: mocks.forno,
        ankr: mocks.ankr,
        drpc: mocks.drpc,
      },
    })
    expect(await rpc.getBlockNumber()).toBe(42n)
    expect(mocks.calls).toEqual(['forno'])
  })

  it('tries Forno first, succeeds, never falls through', async () => {
    const mocks = buildMockClients({
      primaryBehavior: async () => {
        throw new Error('should not be called')
      },
      fornoBehavior: async () => 100n,
      ankrBehavior: async () => {
        throw new Error('should not be called')
      },
      drpcBehavior: async () => {
        throw new Error('should not be called')
      },
    })
    const rpc = createNeeruRpc({
      endpoints: {
        primary: mocks.primary,
        forno: mocks.forno,
        ankr: mocks.ankr,
        drpc: mocks.drpc,
      },
    })
    expect(await rpc.getBlockNumber()).toBe(100n)
    expect(mocks.calls).toEqual(['forno'])
  })

  it('falls back to Ankr when Forno fails once', async () => {
    const mocks = buildMockClients({
      primaryBehavior: async () => {
        throw new Error('should not be called')
      },
      fornoBehavior: async () => {
        throw new Error('forno 503')
      },
      ankrBehavior: async () => 200n,
      drpcBehavior: async () => {
        throw new Error('should not be called')
      },
    })
    const rpc = createNeeruRpc({
      endpoints: {
        primary: mocks.primary,
        forno: mocks.forno,
        ankr: mocks.ankr,
        drpc: mocks.drpc,
      },
    })
    expect(await rpc.getBlockNumber()).toBe(200n)
    expect(mocks.calls).toEqual(['forno', 'ankr'])
  })

  it('cascades all the way to primary (last-resort celocolombia) when the first three fail', async () => {
    const mocks = buildMockClients({
      primaryBehavior: async () => 300n,
      fornoBehavior: async () => {
        throw new Error('forno 503')
      },
      ankrBehavior: async () => {
        throw new Error('ankr timeout')
      },
      drpcBehavior: async () => {
        throw new Error('drpc 500')
      },
    })
    const rpc = createNeeruRpc({
      endpoints: {
        primary: mocks.primary,
        forno: mocks.forno,
        ankr: mocks.ankr,
        drpc: mocks.drpc,
      },
    })
    expect(await rpc.getBlockNumber()).toBe(300n)
    expect(mocks.calls).toEqual(['forno', 'ankr', 'drpc', 'primary'])
  })

  it('cascades past an endpoint that returns block=0 as if it threw', async () => {
    // Silent-degradation guard. rpc.celocolombia.org was observed on
    // 2026-08-03 responding HTTP 200 with block=0 to eth_blockNumber
    // while multicall threw; the previous fallback treated that as a
    // valid successful result and never cascaded. Now the sanity check
    // in getBlockNumber turns the bad-data case into a throw and the
    // iterator continues to the next endpoint. Same guard applies
    // regardless of position, so this test uses forno as the degraded
    // endpoint (position 0 in the shared chain) to reflect the current
    // order.
    const mocks = buildMockClients({
      primaryBehavior: async () => {
        throw new Error('should not be called')
      },
      fornoBehavior: async () => 0n, // degraded silently
      ankrBehavior: async () => 400n, // healthy fallback
      drpcBehavior: async () => {
        throw new Error('should not be called')
      },
    })
    const rpc = createNeeruRpc({
      endpoints: {
        primary: mocks.primary,
        forno: mocks.forno,
        ankr: mocks.ankr,
        drpc: mocks.drpc,
      },
    })
    expect(await rpc.getBlockNumber()).toBe(400n)
    expect(mocks.calls).toEqual(['forno', 'ankr'])
  })

  it('throws when all four endpoints fail, with all error contexts', async () => {
    const mocks = buildMockClients({
      primaryBehavior: async () => {
        throw new Error('primary 503')
      },
      fornoBehavior: async () => {
        throw new Error('forno 503')
      },
      ankrBehavior: async () => {
        throw new Error('ankr timeout')
      },
      drpcBehavior: async () => {
        throw new Error('drpc 500')
      },
    })
    const rpc = createNeeruRpc({
      endpoints: {
        primary: mocks.primary,
        forno: mocks.forno,
        ankr: mocks.ankr,
        drpc: mocks.drpc,
      },
    })
    await expect(rpc.getBlockNumber()).rejects.toThrow(
      /all Neeru RPC endpoints failed/,
    )
    const err = await rpc.getBlockNumber().catch((e: Error) => e)
    expect(String(err)).toContain(getPrimaryRpcUrl())
    expect(String(err)).toContain(getFornoUrl())
    expect(String(err)).toContain(getAnkrRpcUrl())
    expect(String(err)).toContain(getDrpcRpcUrl())
  })

  it('multicall passes through to Forno first with its full return shape', async () => {
    const fakeReturn = [
      { status: 'success', result: 123n },
      { status: 'success', result: 456n },
    ]
    const multicallCalls: unknown[] = []
    const forno = {
      multicall: async (args: unknown) => {
        multicallCalls.push(args)
        return fakeReturn
      },
    } as unknown as PublicClient
    const primary = {
      multicall: async () => {
        throw new Error('should not be called')
      },
    } as unknown as PublicClient
    const ankr = {
      multicall: async () => {
        throw new Error('should not be called')
      },
    } as unknown as PublicClient
    const drpc = {
      multicall: async () => {
        throw new Error('should not be called')
      },
    } as unknown as PublicClient
    const rpc = createNeeruRpc({
      endpoints: { primary, forno, ankr, drpc },
    })
    const result = await rpc.multicall({
      contracts: [
        {
          address: '0x000000000000000000000000000000000000beef',
          abi: [
            {
              type: 'function',
              name: 'foo',
              stateMutability: 'view',
              inputs: [],
              outputs: [{ type: 'uint256' }],
            },
          ],
          functionName: 'foo',
        },
      ],
    } as never)
    expect(result).toEqual(fakeReturn)
    expect(multicallCalls).toHaveLength(1)
  })

  it('getBlock cascades past an endpoint that returns timestamp=0 as if it threw', async () => {
    // Same silent-degradation guard as the block=0 case above. A block
    // response with timestamp=0 (or number=0 for a non-genesis fetch)
    // is treated as untrusted data and turned into a throw so the
    // iterator cascades.
    const calls: Call[] = []
    const forno = {
      getBlock: async (args: { blockNumber: bigint }) => {
        calls.push('forno')
        return { number: args.blockNumber, timestamp: 0n } // degraded
      },
    } as unknown as PublicClient
    const drpc = {
      getBlock: async (args: { blockNumber: bigint }) => {
        calls.push('drpc')
        return { number: args.blockNumber, timestamp: 1_700_000_000n }
      },
    } as unknown as PublicClient
    const ankr = {
      getBlock: async () => {
        throw new Error('should not be called')
      },
    } as unknown as PublicClient
    const primary = {
      getBlock: async () => {
        throw new Error('should not be called')
      },
    } as unknown as PublicClient
    const rpc = createNeeruRpc({
      endpoints: { primary, forno, ankr, drpc },
    })
    const block = await rpc.getBlock({ blockNumber: 1_234_568n })
    expect(block.number).toBe(1_234_568n)
    expect(block.timestamp).toBe(1_700_000_000n)
    expect(calls).toEqual(['forno', 'drpc'])
  })

  it('getBlock returns number + timestamp from the Forno endpoint', async () => {
    const calls: Call[] = []
    const forno = {
      getBlock: async (args: { blockNumber: bigint }) => {
        calls.push('forno')
        return { number: args.blockNumber, timestamp: 1_700_000_000n }
      },
    } as unknown as PublicClient
    const primary = {
      getBlock: async () => {
        throw new Error('should not be called')
      },
    } as unknown as PublicClient
    const ankr = {
      getBlock: async () => {
        throw new Error('should not be called')
      },
    } as unknown as PublicClient
    const drpc = {
      getBlock: async () => {
        throw new Error('should not be called')
      },
    } as unknown as PublicClient
    const rpc = createNeeruRpc({
      endpoints: { primary, forno, ankr, drpc },
    })
    const block = await rpc.getBlock({ blockNumber: 1_234_568n })
    expect(block.number).toBe(1_234_568n)
    expect(block.timestamp).toBe(1_700_000_000n)
    expect(calls).toEqual(['forno'])
  })

  it('universal skip-window: any endpoint that fails 3x in a row gets skipped for 5 min, then retried', async () => {
    // Universal skip semantics: ANY endpoint that fails 3x consecutive
    // gets skipped for ENDPOINT_SKIP_DURATION_MS, not just primary.
    //
    // Scenario: forno (position 0 in the current chain) fails 3x and
    // gets skipped. Ankr takes over and succeeds. After the skip window
    // elapses, forno is retried and now succeeds too. Primary + drpc
    // remain untouched.
    let fornoCalls = 0
    let ankrCalls = 0
    let nowMs = 1_000_000

    const forno = {
      getBlockNumber: async () => {
        fornoCalls += 1
        if (fornoCalls <= 3) {
          throw new Error('forno 503')
        }
        return 100n
      },
    } as unknown as PublicClient
    const ankr = {
      getBlockNumber: async () => {
        ankrCalls += 1
        return 200n
      },
    } as unknown as PublicClient
    const drpc = {
      getBlockNumber: async () => {
        throw new Error('should not be called')
      },
    } as unknown as PublicClient
    const primary = {
      getBlockNumber: async () => {
        throw new Error('should not be called')
      },
    } as unknown as PublicClient

    const rpc = createNeeruRpc({
      endpoints: { primary, forno, ankr, drpc },
      now: () => nowMs,
    })

    // Ticks 1-3: forno fails each time, ankr takes over. After the 3rd
    // forno failure the skip window opens.
    for (let i = 1; i <= 3; i++) {
      expect(await rpc.getBlockNumber()).toBe(200n)
    }
    expect(fornoCalls).toBe(3)
    expect(ankrCalls).toBe(3)

    // Tick 4: forno is now skipped. Only ankr is called.
    nowMs += 1000
    expect(await rpc.getBlockNumber()).toBe(200n)
    expect(fornoCalls).toBe(3) // unchanged
    expect(ankrCalls).toBe(4)

    // Tick 5: still inside the skip window.
    nowMs += ENDPOINT_SKIP_DURATION_MS - 2000
    expect(await rpc.getBlockNumber()).toBe(200n)
    expect(fornoCalls).toBe(3) // still skipped

    // Tick 6: past the skip mark, forno is retried and now succeeds
    // (behavior flip on fornoCalls > 3). Ankr not called this time.
    nowMs += 3000
    expect(await rpc.getBlockNumber()).toBe(100n)
    expect(fornoCalls).toBe(4)
    expect(ankrCalls).toBe(5) // unchanged from tick 5
  })
})
