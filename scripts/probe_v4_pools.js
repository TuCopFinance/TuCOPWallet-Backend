// Probe V4 pools for COPm<->USDC and COPm<->USDm on Celo mainnet
// via V4Quoter.quoteExactInputSingle
const { createPublicClient, http, encodeFunctionData, decodeFunctionResult } = require('viem')
const { celo } = require('viem/chains')

const V4_QUOTER = '0x28566da1093609182dff2cb2a91cfd72e61d66cd'
const USDT = '0x48065fbbe25f71c9282ddf5e1cd6d6a887483d5e'
const USDC = '0xceba9300f2b948710d2653dd7b07f33a8b32118c'
const USDM = '0x765de816845861e75a25fca122bb6898b8b1282a'
const COPM = '0x8a567e2ae79ca692bd748ab832081c45de4041ea'
const ZERO = '0x0000000000000000000000000000000000000000'

const abi = [{"type":"function","name":"quoteExactInputSingle","stateMutability":"nonpayable","inputs":[{"name":"params","type":"tuple","components":[{"name":"poolKey","type":"tuple","components":[{"name":"currency0","type":"address"},{"name":"currency1","type":"address"},{"name":"fee","type":"uint24"},{"name":"tickSpacing","type":"int24"},{"name":"hooks","type":"address"}]},{"name":"zeroForOne","type":"bool"},{"name":"exactAmount","type":"uint128"},{"name":"hookData","type":"bytes"}]}],"outputs":[{"name":"amountOut","type":"uint256"},{"name":"gasEstimate","type":"uint256"}]}]

const client = createPublicClient({ chain: celo, transport: http('https://celo.publicnode.com') })

async function probe(name, currency0, currency1, sellIsC0, exactAmount, fee, tickSpacing) {
  const params = {
    poolKey: { currency0, currency1, fee, tickSpacing, hooks: ZERO },
    zeroForOne: sellIsC0,
    exactAmount,
    hookData: '0x',
  }
  try {
    const { result } = await client.simulateContract({ address: V4_QUOTER, abi, functionName: 'quoteExactInputSingle', args: [params] })
    console.log(`  ${name} fee=${fee} tick=${tickSpacing}: OK amountOut=${result[0]}`)
    return true
  } catch (e) {
    const msg = (e && e.shortMessage) || (e && e.message) || String(e)
    console.log(`  ${name} fee=${fee} tick=${tickSpacing}: REVERT ${msg.slice(0, 80)}`)
    return false
  }
}

async function main() {
  // USDC (0xceba... < COPm 0x8a56...? — sort by hex): 8a56 < ceba, so COPm = currency0
  // Wait: 0x8a... > 0x48... > 0x76... so USDC 0xce > USDM 0x76 > COPm 0x8a > USDT 0x48
  // Sorted low->high: USDT (0x48) < USDM (0x76) < COPm (0x8a) < USDC (0xce)
  const feeTiers = [100, 500, 3000, 10000]
  const tickBy = { 100: 1, 500: 10, 3000: 60, 10000: 200 }

  console.log('USDC<->COPm (currency0=COPm 0x8a56, currency1=USDC 0xceba):')
  for (const fee of feeTiers) await probe('  1 COPm sell', COPM, USDC, true, 10n**18n, fee, tickBy[fee])
  for (const fee of feeTiers) await probe('  1 USDC sell', COPM, USDC, false, 10n**6n, fee, tickBy[fee])

  console.log('\nUSDm<->COPm (currency0=USDm 0x765d, currency1=COPm 0x8a56):')
  for (const fee of feeTiers) await probe('  1 USDm sell', USDM, COPM, true, 10n**18n, fee, tickBy[fee])
  for (const fee of feeTiers) await probe('  1 COPm sell', USDM, COPM, false, 10n**18n, fee, tickBy[fee])

  console.log('\nSanity: USDT<->COPm (known pool at fee=100):')
  await probe('  1 USDT sell', USDT, COPM, true, 10n**6n, 100, 1)
}
main().catch(console.error)
