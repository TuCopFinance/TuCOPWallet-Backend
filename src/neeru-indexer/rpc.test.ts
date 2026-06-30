import type { PublicClient } from 'viem'
import {
  getAnkrRpcUrl,
  getDrpcRpcUrl,
  getFornoUrl,
  getPrimaryRpcUrl,
} from '../lib/celoClient'
import { createNeeruRpc, PRIMARY_SKIP_DURATION_MS } from './rpc'

type Call = 'primary' | 'forno' | 'ankr' | 'drpc'

interface MockClients {
  primary: PublicClient
  forno: PublicClient
  ankr: PublicClient
  drpc: PublicClient
  calls: Call[]
}

function buildMockClients(opts: {
  primaryBehavior: () => Promise<bigint>
  fornoBehavior: () => Promise<bigint>
  ankrBehavior: () => Promise<bigint>
  drpcBehavior: () => Promise<bigint>
}): MockClients {
  const calls: Call[] = []
  const make = (name: Call, behavior: () => Promise<bigint>): PublicClient => {
    return {
      getBlockNumber: async () => {
        calls.push(name)
        return behavior()
      },
    } as unknown as PublicClient
  }
  return {
    primary: make('primary', opts.primaryBehavior),
    forno: make('forno', opts.fornoBehavior),
    ankr: make('ankr', opts.ankrBehavior),
    drpc: make('drpc', opts.drpcBehavior),
    calls,
  }
}

describe('createNeeruRpc', () => {
  it('tries the primary first, succeeds, never falls through', async () => {
    const mocks = buildMockClients({
      primaryBehavior: async () => 100n,
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
        primary: mocks.primary,
        forno: mocks.forno,
        ankr: mocks.ankr,
        drpc: mocks.drpc,
      },
    })
    expect(await rpc.getBlockNumber()).toBe(100n)
    expect(mocks.calls).toEqual(['primary'])
  })

  it('falls back to Forno when the primary fails once', async () => {
    const mocks = buildMockClients({
      primaryBehavior: async () => {
        throw new Error('primary 503')
      },
      fornoBehavior: async () => 200n,
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
    expect(await rpc.getBlockNumber()).toBe(200n)
    expect(mocks.calls).toEqual(['primary', 'forno'])
  })

  it('cascades all the way to dRPC when the first three fail', async () => {
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
      drpcBehavior: async () => 300n,
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
    expect(mocks.calls).toEqual(['primary', 'forno', 'ankr', 'drpc'])
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

  it('multicall passes through to the primary with its full return shape', async () => {
    const fakeReturn = [
      { status: 'success', result: 123n },
      { status: 'success', result: 456n },
    ]
    const multicallCalls: unknown[] = []
    const primary = {
      multicall: async (args: unknown) => {
        multicallCalls.push(args)
        return fakeReturn
      },
    } as unknown as PublicClient
    const forno = {
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

  it('getBlock returns number + timestamp from the primary endpoint', async () => {
    const calls: Call[] = []
    const primary = {
      getBlock: async (args: { blockNumber: bigint }) => {
        calls.push('primary')
        return { number: args.blockNumber, timestamp: 1_700_000_000n }
      },
    } as unknown as PublicClient
    const forno = {
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
    expect(calls).toEqual(['primary'])
  })

  it('after 3 consecutive primary failures, skips it for 5 min, then resumes', async () => {
    let primaryCalls = 0
    let fornoCalls = 0
    const calls: Call[] = []
    let nowMs = 1_000_000

    const primary = {
      getBlockNumber: async () => {
        calls.push('primary')
        primaryCalls += 1
        throw new Error('primary 503')
      },
    } as unknown as PublicClient
    const forno = {
      getBlockNumber: async () => {
        calls.push('forno')
        fornoCalls += 1
        return 42n
      },
    } as unknown as PublicClient
    const ankr = {
      getBlockNumber: async () => {
        calls.push('ankr')
        return 0n
      },
    } as unknown as PublicClient
    const drpc = {
      getBlockNumber: async () => {
        calls.push('drpc')
        return 0n
      },
    } as unknown as PublicClient

    const rpc = createNeeruRpc({
      endpoints: { primary, forno, ankr, drpc },
      now: () => nowMs,
    })

    // 3 ticks: every call tries primary (fails), then Forno (succeeds).
    expect(await rpc.getBlockNumber()).toBe(42n)
    expect(await rpc.getBlockNumber()).toBe(42n)
    expect(await rpc.getBlockNumber()).toBe(42n)
    expect(primaryCalls).toBe(3)
    expect(fornoCalls).toBe(3)
    expect(calls.filter((c) => c === 'ankr').length).toBe(0)
    expect(calls.filter((c) => c === 'drpc').length).toBe(0)

    // 4th tick: primary is now in the skip window, only Forno should be called.
    nowMs += 1000
    expect(await rpc.getBlockNumber()).toBe(42n)
    expect(primaryCalls).toBe(3)
    expect(fornoCalls).toBe(4)

    // 5th tick: still inside the skip window.
    nowMs += PRIMARY_SKIP_DURATION_MS - 2000
    expect(await rpc.getBlockNumber()).toBe(42n)
    expect(primaryCalls).toBe(3)
    expect(fornoCalls).toBe(5)

    // 6th tick: past the skip mark, primary should be retried.
    nowMs += 3000
    expect(await rpc.getBlockNumber()).toBe(42n)
    expect(primaryCalls).toBe(4)
    expect(fornoCalls).toBe(6)
  })
})
