// Probe USDC<->COPm V3 pools for real liquidity + Uniswap V3 QuoterV2 quotes
const { createPublicClient, http } = require('viem')
const { celo } = require('viem/chains')

const USDC = '0xceba9300f2b948710d2653dd7b07f33a8b32118c'
const COPM = '0x8a567e2ae79ca692bd748ab832081c45de4041ea'
const QUOTER_V2 = '0x5615CDAb10dc425a742d643d949a7F474C01abc4'  // Uniswap V3 QuoterV2 Celo (canonical)
const POOL_3000 = '0x357596DD7a0EF5CB703C5AAe4dA01EDFf176aE95'
const POOL_10000 = '0xD512F028C2927ecd72f7e68Fa0eE236B46e25120'

const client = createPublicClient({ chain: celo, transport: http('https://celo.publicnode.com') })

const poolAbi = [
  {"type":"function","name":"liquidity","stateMutability":"view","inputs":[],"outputs":[{"type":"uint128"}]},
  {"type":"function","name":"slot0","stateMutability":"view","inputs":[],"outputs":[{"name":"sqrtPriceX96","type":"uint160"},{"name":"tick","type":"int24"},{"name":"observationIndex","type":"uint16"},{"name":"observationCardinality","type":"uint16"},{"name":"observationCardinalityNext","type":"uint16"},{"name":"feeProtocol","type":"uint8"},{"name":"unlocked","type":"bool"}]},
  {"type":"function","name":"token0","stateMutability":"view","inputs":[],"outputs":[{"type":"address"}]},
  {"type":"function","name":"token1","stateMutability":"view","inputs":[],"outputs":[{"type":"address"}]},
]

const quoterAbi = [{"type":"function","name":"quoteExactInputSingle","stateMutability":"nonpayable","inputs":[{"name":"params","type":"tuple","components":[{"name":"tokenIn","type":"address"},{"name":"tokenOut","type":"address"},{"name":"amountIn","type":"uint256"},{"name":"fee","type":"uint24"},{"name":"sqrtPriceLimitX96","type":"uint160"}]}],"outputs":[{"name":"amountOut","type":"uint256"},{"name":"sqrtPriceX96After","type":"uint160"},{"name":"initializedTicksCrossed","type":"uint32"},{"name":"gasEstimate","type":"uint256"}]}]

async function pool(name, addr) {
  console.log(`\n=== ${name} ${addr} ===`)
  try {
    const [liq, t0, t1, s0] = await Promise.all([
      client.readContract({ address: addr, abi: poolAbi, functionName: 'liquidity' }),
      client.readContract({ address: addr, abi: poolAbi, functionName: 'token0' }),
      client.readContract({ address: addr, abi: poolAbi, functionName: 'token1' }),
      client.readContract({ address: addr, abi: poolAbi, functionName: 'slot0' }),
    ])
    console.log(`  token0=${t0} token1=${t1}`)
    console.log(`  liquidity=${liq.toString()} sqrtPriceX96=${s0[0].toString()} tick=${s0[1]}`)
    console.log(`  in-range: ${liq > 0n}`)
  } catch (e) {
    console.log(`  error: ${((e && e.shortMessage) || (e && e.message)).slice(0,100)}`)
  }
}

async function quote(name, tokenIn, tokenOut, fee, amountIn) {
  try {
    const { result } = await client.simulateContract({ address: QUOTER_V2, abi: quoterAbi, functionName: 'quoteExactInputSingle', args: [{ tokenIn, tokenOut, amountIn, fee, sqrtPriceLimitX96: 0n }] })
    console.log(`  ${name} fee=${fee}: amountOut=${result[0].toString()} gasEstimate=${result[3].toString()}`)
  } catch (e) {
    console.log(`  ${name} fee=${fee}: revert ${((e && e.shortMessage) || (e && e.message)).slice(0,80)}`)
  }
}

async function main() {
  await pool('USDC<->COPm fee=3000', POOL_3000)
  await pool('USDC<->COPm fee=10000', POOL_10000)
  console.log('\n=== V3 QuoterV2 (USDC 6dec -> COPm 18dec, 1 USDC = 1e6 wei) ===')
  await quote('1 USDC -> COPm', USDC, COPM, 3000, 10n**6n)
  await quote('1 USDC -> COPm', USDC, COPM, 10000, 10n**6n)
  console.log('\n=== V3 QuoterV2 (COPm 18dec -> USDC 6dec, 3000 COPm = 3000e18 wei) ===')
  await quote('3000 COPm -> USDC', COPM, USDC, 3000, 3000n * 10n**18n)
  await quote('3000 COPm -> USDC', COPM, USDC, 10000, 3000n * 10n**18n)
}
main().catch(e => console.log('FATAL', e.message || e))
