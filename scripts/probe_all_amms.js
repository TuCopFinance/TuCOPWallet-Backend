// Probe all Celo AMM pools for USDC<->COPm and USDm<->COPm:
// - Uniswap V3 (canonical): factory 0xAfE208a311B21f13EF87E33A90049fC17A7acDEc
// - Uniswap V4 (already probed hookless, re-check known hooks)
// - UbeSwap V3 (fork): factory 0x67FEa58D5a5a4162cED847E13c2c81c73bf8aeC4
// - Mento Broker (native stable broker): 0x777A8255cA72412f0d706dc03C9D1987306B4CaD
const { createPublicClient, http } = require('viem')
const { celo } = require('viem/chains')

const USDC = '0xceba9300f2b948710d2653dd7b07f33a8b32118c'
const USDM = '0x765de816845861e75a25fca122bb6898b8b1282a'
const COPM = '0x8a567e2ae79ca692bd748ab832081c45de4041ea'
const USDT = '0x48065fbbe25f71c9282ddf5e1cd6d6a887483d5e'
const ZERO = '0x0000000000000000000000000000000000000000'

const client = createPublicClient({ chain: celo, transport: http('https://celo.publicnode.com') })

const v3FactoryAbi = [{"type":"function","name":"getPool","stateMutability":"view","inputs":[{"name":"tokenA","type":"address"},{"name":"tokenB","type":"address"},{"name":"fee","type":"uint24"}],"outputs":[{"type":"address"}]}]

async function probeV3Factory(name, factory) {
  console.log(`\n=== ${name} (${factory}) ===`)
  const feeTiers = [100, 500, 3000, 10000]
  for (const [a, b, pair] of [[USDC, COPM, 'USDC<->COPm'], [USDM, COPM, 'USDm<->COPm']]) {
    for (const fee of feeTiers) {
      try {
        const pool = await client.readContract({ address: factory, abi: v3FactoryAbi, functionName: 'getPool', args: [a, b, fee] })
        console.log(`  ${pair} fee=${fee}: ${pool === ZERO ? 'no pool' : 'POOL=' + pool}`)
      } catch (e) {
        console.log(`  ${pair} fee=${fee}: error ${((e && e.shortMessage) || (e && e.message) || '').slice(0, 80)}`)
      }
    }
  }
}

// Mento Broker: for a pair (tokenIn, tokenOut) can we get a quote?
// Broker exposes getExchangeIds() per provider. Simpler: check if pair is quotable via getAmountOut.
const brokerAbi = [
  {"type":"function","name":"getExchangeProviders","stateMutability":"view","inputs":[],"outputs":[{"type":"address[]"}]},
  {"type":"function","name":"getAmountOut","stateMutability":"view","inputs":[{"name":"exchangeProvider","type":"address"},{"name":"exchangeId","type":"bytes32"},{"name":"tokenIn","type":"address"},{"name":"tokenOut","type":"address"},{"name":"amountIn","type":"uint256"}],"outputs":[{"type":"uint256"}]},
]
const providerAbi = [
  {"type":"function","name":"getExchanges","stateMutability":"view","inputs":[],"outputs":[{"type":"tuple[]","components":[{"name":"exchangeId","type":"bytes32"},{"name":"assets","type":"address[]"}]}]}
]

async function probeMento() {
  console.log('\n=== Mento Broker (0x777A8255cA72412f0d706dc03C9D1987306B4CaD) ===')
  const broker = '0x777A8255cA72412f0d706dc03C9D1987306B4CaD'
  const providers = await client.readContract({ address: broker, abi: brokerAbi, functionName: 'getExchangeProviders' })
  console.log(`  Providers: ${providers.join(', ')}`)
  for (const p of providers) {
    try {
      const exchanges = await client.readContract({ address: p, abi: providerAbi, functionName: 'getExchanges' })
      console.log(`  Provider ${p} exchanges: ${exchanges.length}`)
      for (const ex of exchanges) {
        const has = (t) => ex.assets.some(a => a.toLowerCase() === t.toLowerCase())
        if ((has(USDM) && has(COPM)) || (has(USDC) && has(COPM)) || (has(USDT) && has(COPM))) {
          console.log(`    RELEVANT: id=${ex.exchangeId} assets=${ex.assets.join(',')}`)
          for (const [a, b, pair] of [[USDM, COPM, 'USDm->COPm'], [COPM, USDM, 'COPm->USDm'], [USDC, COPM, 'USDC->COPm']]) {
            if (has(a) && has(b)) {
              try {
                const amt = a === USDC ? 10n**6n : 10n**18n
                const out = await client.readContract({ address: broker, abi: brokerAbi, functionName: 'getAmountOut', args: [p, ex.exchangeId, a, b, amt] })
                console.log(`      quote ${pair}: 1 in -> ${out.toString()} out`)
              } catch (e) {
                console.log(`      quote ${pair}: revert ${((e && e.shortMessage) || (e && e.message) || '').slice(0, 60)}`)
              }
            }
          }
        }
      }
    } catch (e) {
      console.log(`  Provider ${p}: error ${((e && e.shortMessage) || (e && e.message) || '').slice(0, 80)}`)
    }
  }
}

async function main() {
  await probeV3Factory('Uniswap V3 (Celo)', '0xAfE208a311B21f13EF87E33A90049fC17A7acDEc')
  await probeV3Factory('UbeSwap V3', '0x67FEa58D5a5a4162cED847E13c2c81c73bf8aeC4')
  await probeMento()
}
main().catch(e => console.log('FATAL', e.message || e))
