import type { PublicClient } from 'viem'
import {
  ANKR_URL,
  createNeeruRpc,
  DRPC_URL,
  FORNO_SKIP_DURATION_MS,
  FORNO_URL,
} from './rpc'

type Call = 'forno' | 'ankr' | 'drpc'

interface MockClients {
  forno: PublicClient
  ankr: PublicClient
  drpc: PublicClient
  calls: Call[]
}

function buildMockClients(opts: {
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
    forno: make('forno', opts.fornoBehavior),
    ankr: make('ankr', opts.ankrBehavior),
    drpc: make('drpc', opts.drpcBehavior),
    calls,
  }
}

describe('createNeeruRpc', () => {
  it('tries Forno first, succeeds, never falls through', async () => {
    const mocks = buildMockClients({
      fornoBehavior: async () => 100n,
      ankrBehavior: async () => {
        throw new Error('should not be called')
      },
      drpcBehavior: async () => {
        throw new Error('should not be called')
      },
    })
    const rpc = createNeeruRpc({
      endpoints: { forno: mocks.forno, ankr: mocks.ankr, drpc: mocks.drpc },
    })
    expect(await rpc.getBlockNumber()).toBe(100n)
    expect(mocks.calls).toEqual(['forno'])
  })

  it('falls back to Ankr when Forno fails once', async () => {
    const mocks = buildMockClients({
      fornoBehavior: async () => {
        throw new Error('forno 503')
      },
      ankrBehavior: async () => 200n,
      drpcBehavior: async () => {
        throw new Error('should not be called')
      },
    })
    const rpc = createNeeruRpc({
      endpoints: { forno: mocks.forno, ankr: mocks.ankr, drpc: mocks.drpc },
    })
    expect(await rpc.getBlockNumber()).toBe(200n)
    expect(mocks.calls).toEqual(['forno', 'ankr'])
  })

  it('falls back to dRPC when Forno and Ankr both fail', async () => {
    const mocks = buildMockClients({
      fornoBehavior: async () => {
        throw new Error('forno 503')
      },
      ankrBehavior: async () => {
        throw new Error('ankr timeout')
      },
      drpcBehavior: async () => 300n,
    })
    const rpc = createNeeruRpc({
      endpoints: { forno: mocks.forno, ankr: mocks.ankr, drpc: mocks.drpc },
    })
    expect(await rpc.getBlockNumber()).toBe(300n)
    expect(mocks.calls).toEqual(['forno', 'ankr', 'drpc'])
  })

  it('throws when all three endpoints fail, with all error contexts', async () => {
    const mocks = buildMockClients({
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
      endpoints: { forno: mocks.forno, ankr: mocks.ankr, drpc: mocks.drpc },
    })
    await expect(rpc.getBlockNumber()).rejects.toThrow(
      /all Neeru RPC endpoints failed/,
    )
    const err = await rpc.getBlockNumber().catch((e: Error) => e)
    expect(String(err)).toContain(FORNO_URL)
    expect(String(err)).toContain(ANKR_URL)
    expect(String(err)).toContain(DRPC_URL)
  })

  it('multicall passes through to the active endpoint with its full return shape', async () => {
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
    const rpc = createNeeruRpc({ endpoints: { forno, ankr, drpc } })
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

  it('getBlock returns number + timestamp from the active endpoint', async () => {
    const calls: Call[] = []
    const forno = {
      getBlock: async (args: { blockNumber: bigint }) => {
        calls.push('forno')
        return { number: args.blockNumber, timestamp: 1_700_000_000n }
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
    const rpc = createNeeruRpc({ endpoints: { forno, ankr, drpc } })
    const block = await rpc.getBlock({ blockNumber: 1_234_568n })
    expect(block.number).toBe(1_234_568n)
    expect(block.timestamp).toBe(1_700_000_000n)
    expect(calls).toEqual(['forno'])
  })

  it('after 3 consecutive Forno failures, skips Forno for 5 min, then resumes', async () => {
    let fornoCalls = 0
    let ankrCalls = 0
    const calls: Call[] = []
    let nowMs = 1_000_000

    const forno = {
      getBlockNumber: async () => {
        calls.push('forno')
        fornoCalls += 1
        throw new Error('forno 503')
      },
    } as unknown as PublicClient
    const ankr = {
      getBlockNumber: async () => {
        calls.push('ankr')
        ankrCalls += 1
        return 42n
      },
    } as unknown as PublicClient
    const drpc = {
      getBlockNumber: async () => {
        calls.push('drpc')
        return 0n
      },
    } as unknown as PublicClient

    const rpc = createNeeruRpc({
      endpoints: { forno, ankr, drpc },
      now: () => nowMs,
    })

    // 3 ticks: every call tries Forno (fails), then Ankr (succeeds).
    expect(await rpc.getBlockNumber()).toBe(42n)
    expect(await rpc.getBlockNumber()).toBe(42n)
    expect(await rpc.getBlockNumber()).toBe(42n)
    expect(fornoCalls).toBe(3)
    expect(ankrCalls).toBe(3)
    expect(calls.filter((c) => c === 'drpc').length).toBe(0)

    // 4th tick: Forno is now in the skip window, only Ankr should be called.
    nowMs += 1000 // less than 5 min
    expect(await rpc.getBlockNumber()).toBe(42n)
    expect(fornoCalls).toBe(3) // unchanged
    expect(ankrCalls).toBe(4)

    // 5th tick: still inside the skip window.
    nowMs += FORNO_SKIP_DURATION_MS - 2000
    expect(await rpc.getBlockNumber()).toBe(42n)
    expect(fornoCalls).toBe(3)
    expect(ankrCalls).toBe(5)

    // 6th tick: past the 5-min mark, Forno should be retried.
    nowMs += 3000 // total > FORNO_SKIP_DURATION_MS since skip started
    expect(await rpc.getBlockNumber()).toBe(42n)
    expect(fornoCalls).toBe(4)
    expect(ankrCalls).toBe(6)
  })
})
