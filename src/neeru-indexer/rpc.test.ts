import type { PublicClient } from 'viem'
import {
  createNeeruRpc,
  PRIMARY_SKIP_DURATION_MS,
} from './rpc'
import {
  getAnkrRpcUrl,
  getDrpcRpcUrl,
  getFornoUrl,
  getPrimaryRpcUrl,
} from '../lib/celoClient'

type Call = 'primary' | 'forno' | 'ankr' | 'drpc'

interface MockClients {
  primary: PublicClient
  forno: PublicClient
  ankr: PublicClient
  drpc: PublicClient
  calls: Call[]
}

interface MockClientOptions {
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
    primary: make('primary', opts.primaryBehavior),
    forno: make('forno', opts.fornoBehavior),
    ankr: make('ankr', opts.ankrBehavior),
    drpc: make('drpc', opts.drpcBehavior),
    calls,
  }
}

// Chain order after the 2026-08-03 reorder: forno -> drpc -> ankr ->
// primary (celocolombia). Forno is tried first because it has been the
// most reliable endpoint in production; primary is kept at the tail with
// its 3-failure skip window so a silently-degraded celocolombia (has been
// observed returning block=0 while 200-OK) does not thrash retries when
// the healthy upstreams could serve the request.
describe('createNeeruRpc', () => {
  // Order (2026-08-04): [ankr, forno, drpc, primary]. See rpc.ts header
  // comment for the ordering rationale.
  it('tries Ankr first, succeeds, never falls through', async () => {
    const mocks = buildMockClients({
      primaryBehavior: async () => {
        throw new Error('should not be called')
      },
      fornoBehavior: async () => {
        throw new Error('should not be called')
      },
      ankrBehavior: async () => 100n,
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
    expect(mocks.calls).toEqual(['ankr'])
  })

  it('falls back to Forno when Ankr fails once', async () => {
    const mocks = buildMockClients({
      primaryBehavior: async () => {
        throw new Error('should not be called')
      },
      fornoBehavior: async () => 200n,
      ankrBehavior: async () => {
        throw new Error('ankr 503')
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
    expect(await rpc.getBlockNumber()).toBe(200n)
    expect(mocks.calls).toEqual(['ankr', 'forno'])
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
    expect(mocks.calls).toEqual(['ankr', 'forno', 'drpc', 'primary'])
  })

  it('cascades past an endpoint that returns block=0 as if it threw', async () => {
    // Silent-degradation guard. rpc.celocolombia.org was observed on
    // 2026-08-03 responding HTTP 200 with block=0 to eth_blockNumber
    // while multicall threw; the previous fallback treated that as a
    // valid successful result and never cascaded. Now the sanity check
    // in getBlockNumber turns the bad-data case into a throw and the
    // iterator continues to the next endpoint. Same guard applies
    // regardless of position, so this test uses ankr as the degraded
    // endpoint to reflect the current chain order.
    const mocks = buildMockClients({
      primaryBehavior: async () => {
        throw new Error('should not be called')
      },
      fornoBehavior: async () => 400n, // healthy fallback
      ankrBehavior: async () => 0n, // degraded silently
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
    expect(mocks.calls).toEqual(['ankr', 'forno'])
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

  it('after 3 consecutive primary failures, skips it for 5 min, then resumes', async () => {
    let primaryCalls = 0
    let fornoCalls = 0
    let drpcCalls = 0
    let ankrCalls = 0
    const calls: Call[] = []
    let nowMs = 1_000_000

    // Forno + drpc + ankr all throw so each request cascades all the way
    // to primary; primary throws for the first three to trigger the skip
    // window, then succeeds after the skip window expires.
    const forno = {
      getBlockNumber: async () => {
        calls.push('forno')
        fornoCalls += 1
        throw new Error('forno 503')
      },
    } as unknown as PublicClient
    const drpc = {
      getBlockNumber: async () => {
        calls.push('drpc')
        drpcCalls += 1
        throw new Error('drpc 500')
      },
    } as unknown as PublicClient
    const ankr = {
      getBlockNumber: async () => {
        calls.push('ankr')
        ankrCalls += 1
        throw new Error('ankr timeout')
      },
    } as unknown as PublicClient
    const primary = {
      getBlockNumber: async () => {
        calls.push('primary')
        primaryCalls += 1
        if (primaryCalls <= 3) {
          throw new Error('primary 503')
        }
        return 42n
      },
    } as unknown as PublicClient

    const rpc = createNeeruRpc({
      endpoints: { primary, forno, ankr, drpc },
      now: () => nowMs,
    })

    // 3 ticks: each cascades forno -> drpc -> ankr -> primary (all fail).
    // After the 3rd primary failure the skip window opens.
    await expect(rpc.getBlockNumber()).rejects.toThrow(
      /all Neeru RPC endpoints failed/,
    )
    await expect(rpc.getBlockNumber()).rejects.toThrow(
      /all Neeru RPC endpoints failed/,
    )
    await expect(rpc.getBlockNumber()).rejects.toThrow(
      /all Neeru RPC endpoints failed/,
    )
    expect(primaryCalls).toBe(3)
    expect(fornoCalls).toBe(3)
    expect(drpcCalls).toBe(3)
    expect(ankrCalls).toBe(3)

    // 4th tick: primary is now in the skip window. forno/drpc/ankr still
    // throw so the request still fails, but primary is not called.
    nowMs += 1000
    await expect(rpc.getBlockNumber()).rejects.toThrow(
      /all Neeru RPC endpoints failed/,
    )
    expect(primaryCalls).toBe(3) // unchanged, skipped
    expect(fornoCalls).toBe(4)
    expect(drpcCalls).toBe(4)
    expect(ankrCalls).toBe(4)

    // 5th tick: still inside the skip window.
    nowMs += PRIMARY_SKIP_DURATION_MS - 2000
    await expect(rpc.getBlockNumber()).rejects.toThrow(
      /all Neeru RPC endpoints failed/,
    )
    expect(primaryCalls).toBe(3) // still skipped
    expect(fornoCalls).toBe(5)

    // 6th tick: past the skip mark, primary should be retried and now
    // succeeds (behavior flip on primaryCalls > 3).
    nowMs += 3000
    expect(await rpc.getBlockNumber()).toBe(42n)
    expect(primaryCalls).toBe(4)
    expect(fornoCalls).toBe(6)
  })
})
