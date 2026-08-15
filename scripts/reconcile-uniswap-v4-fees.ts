// Reconciliation script for the Uniswap V4 integrator fee flow.
//
// Usage:
//   yarn tsx scripts/reconcile-uniswap-v4-fees.ts \
//     --logs-file <path-to-jsonl-of-uniswap_v4_build_tx-events> \
//     --from-block <blockNumber> \
//     --to-block <blockNumber>
//
// What it does:
//   1. Reads a newline-delimited JSON file of `uniswap_v4_build_tx` audit
//      events (one per line). These are emitted by
//      POST /api/swap/build-tx at WARN level; you get them from Railway
//      logs with `severity=warn AND message contains "uniswap_v4_build_tx"`.
//   2. Computes the expected TOTAL fee routed to
//      SQUID_INTEGRATOR_FEE_ADDRESS, in COPm, across all logged events in
//      the range: sum over each event of
//        minBuyAmount / (10000 - feeBips) * feeBips
//      (this is the exact TAKE_PORTION formula because
//      TAKE_PORTION takes `feeBips/10000` of the credit balance, and the
//      credit balance is what's left after min-slippage payout).
//      NOTE: this uses `minBuyAmount` as a lower bound; actual on-chain
//      transfer will be `actualOutput * feeBips / 10000` which is >=
//      the lower bound. Use this as a "fee floor" per event.
//   3. Queries the recipient address's COPm balance at from-block and
//      to-block, computes the delta.
//   4. Prints a table: expected floor (from logs) vs actual delta
//      (on-chain), plus per-event breakdown.
//
// This is a diagnostic tool, not a monitoring loop. Run it monthly (or
// after any fee-behavior change) to verify the log accounting matches
// the on-chain outcome. Baseline for wire-safe reconciliation.
//
// Requires the ETHERSCAN_API_KEY env var to be set (same key backend
// uses). No RPC-only fallback because the balance-at-block lookup uses
// the Etherscan V2 unified API for reliability.

import { readFileSync } from 'node:fs'

interface UniswapV4BuildTxLog {
  event: 'uniswap_v4_build_tx'
  direction: 'USDT_TO_COPM' | 'COPM_TO_USDT'
  userAddress: string
  sellAmount: string
  minBuyAmount: string
  deadline: string
  permitNonce: number
  permitAmount: string
}

interface CliArgs {
  logsFile: string
  fromBlock: number
  toBlock: number
  feeRecipient: string
  copmAddress: string
  usdtAddress: string
  feeBips: number
}

function parseArgs(): CliArgs {
  const argv = process.argv.slice(2)
  const get = (name: string): string | undefined => {
    const idx = argv.indexOf(`--${name}`)
    if (idx === -1 || idx + 1 >= argv.length) return undefined
    return argv[idx + 1]
  }
  const logsFile = get('logs-file')
  const fromBlock = get('from-block')
  const toBlock = get('to-block')
  if (!logsFile || !fromBlock || !toBlock) {
    process.stderr.write(
      'Usage: yarn tsx scripts/reconcile-uniswap-v4-fees.ts --logs-file <path> --from-block <n> --to-block <n>\n',
    )
    process.exit(2)
  }
  return {
    logsFile,
    fromBlock: Number(fromBlock),
    toBlock: Number(toBlock),
    feeRecipient:
      process.env.SQUID_INTEGRATOR_FEE_ADDRESS ??
      '0x17CD032F61998cD0E8e9AF87c8390b98496b9354',
    copmAddress: '0x8a567e2ae79ca692bd748ab832081c45de4041ea',
    usdtAddress: '0x48065fbbe25f71c9282ddf5e1cd6d6a887483d5e',
    feeBips: Math.round(Number(process.env.SQUID_INTEGRATOR_FEE_PERCENTAGE ?? '0.5') * 100),
  }
}

function readLogs(path: string): UniswapV4BuildTxLog[] {
  const raw = readFileSync(path, 'utf8')
  const lines = raw.split('\n').filter((l) => l.trim().length > 0)
  const events: UniswapV4BuildTxLog[] = []
  for (const line of lines) {
    let obj: unknown
    try {
      obj = JSON.parse(line)
    } catch {
      // Some Railway log lines have a `[routes:swap]` prefix + JSON payload.
      // Strip the prefix.
      const idx = line.indexOf('{')
      if (idx === -1) continue
      try {
        obj = JSON.parse(line.slice(idx))
      } catch {
        continue
      }
    }
    if (
      typeof obj === 'object' &&
      obj !== null &&
      (obj as { event?: string }).event === 'uniswap_v4_build_tx'
    ) {
      events.push(obj as UniswapV4BuildTxLog)
    }
  }
  return events
}

// Compute the fee floor per event. The TAKE_PORTION action grabs
// `feeBips/10000` of the OUTPUT credit balance. The credit balance is
// >= minBuyAmount (that's the whole point of the slippage floor). So the
// fee-taken >= minBuyAmount * feeBips / 10000. Actual can be higher when
// the pool prices better than the slippage limit.
function feeFloor(log: UniswapV4BuildTxLog, feeBips: number): bigint {
  // The output token for USDT_TO_COPM is COPm; for COPM_TO_USDT is USDT.
  // Callers must scope by direction to sum per-currency.
  const minOut = BigInt(log.minBuyAmount)
  return (minOut * BigInt(feeBips)) / BigInt(10000)
}

async function balanceOfAtBlock(
  token: string,
  address: string,
  blockNumber: number,
): Promise<bigint> {
  const apiKey = process.env.ETHERSCAN_API_KEY
  if (!apiKey) {
    throw new Error('ETHERSCAN_API_KEY env not set')
  }
  const url = new URL('https://api.etherscan.io/v2/api')
  url.searchParams.set('chainid', '42220')
  url.searchParams.set('module', 'account')
  url.searchParams.set('action', 'tokenbalancehistory')
  url.searchParams.set('contractaddress', token)
  url.searchParams.set('address', address)
  url.searchParams.set('blockno', String(blockNumber))
  url.searchParams.set('apikey', apiKey)
  const res = await fetch(url.toString())
  const json: unknown = await res.json()
  const result = (json as { result?: string; message?: string; status?: string }).result
  if (!result || typeof result !== 'string') {
    throw new Error(
      `etherscan tokenbalancehistory failed: ${JSON.stringify(json).slice(0, 400)}`,
    )
  }
  return BigInt(result)
}

function fmt(bn: bigint, decimals: number): string {
  const s = bn.toString().padStart(decimals + 1, '0')
  const whole = s.slice(0, -decimals)
  const frac = s.slice(-decimals).replace(/0+$/, '')
  return frac.length === 0 ? whole : `${whole}.${frac}`
}

async function main() {
  const args = parseArgs()
  process.stderr.write(`reading logs from ${args.logsFile}...\n`)
  const events = readLogs(args.logsFile)
  process.stderr.write(`parsed ${events.length} uniswap_v4_build_tx events\n`)

  // Split by direction. Output tokens differ.
  const usdtToCopm = events.filter((e) => e.direction === 'USDT_TO_COPM')
  const copmToUsdt = events.filter((e) => e.direction === 'COPM_TO_USDT')

  const copmFeeFloor = usdtToCopm.reduce(
    (acc, e) => acc + feeFloor(e, args.feeBips),
    0n,
  )
  const usdtFeeFloor = copmToUsdt.reduce(
    (acc, e) => acc + feeFloor(e, args.feeBips),
    0n,
  )

  process.stderr.write('querying on-chain balances via Etherscan V2...\n')
  const copmBefore = await balanceOfAtBlock(
    args.copmAddress,
    args.feeRecipient,
    args.fromBlock,
  )
  const copmAfter = await balanceOfAtBlock(
    args.copmAddress,
    args.feeRecipient,
    args.toBlock,
  )
  const usdtBefore = await balanceOfAtBlock(
    args.usdtAddress,
    args.feeRecipient,
    args.fromBlock,
  )
  const usdtAfter = await balanceOfAtBlock(
    args.usdtAddress,
    args.feeRecipient,
    args.toBlock,
  )
  const copmDelta = copmAfter - copmBefore
  const usdtDelta = usdtAfter - usdtBefore

  process.stdout.write('\n=== Uniswap V4 integrator fee reconciliation ===\n')
  process.stdout.write(`Fee recipient : ${args.feeRecipient}\n`)
  process.stdout.write(`Block range   : ${args.fromBlock} -> ${args.toBlock}\n`)
  process.stdout.write(`Fee bips      : ${args.feeBips} (from env)\n`)
  process.stdout.write(`\nEvents        : ${events.length} total\n`)
  process.stdout.write(`  USDT->COPm  : ${usdtToCopm.length} (fee in COPm, 18 decimals)\n`)
  process.stdout.write(`  COPm->USDT  : ${copmToUsdt.length} (fee in USDT, 6 decimals)\n`)

  process.stdout.write('\nCOPm accounting:\n')
  process.stdout.write(`  Log floor   : ${fmt(copmFeeFloor, 18)}\n`)
  process.stdout.write(`  On-chain    : ${fmt(copmDelta, 18)}\n`)
  process.stdout.write(
    `  Diff        : ${fmt(copmDelta - copmFeeFloor, 18)} (>=0 = healthy)\n`,
  )

  process.stdout.write('\nUSDT accounting:\n')
  process.stdout.write(`  Log floor   : ${fmt(usdtFeeFloor, 6)}\n`)
  process.stdout.write(`  On-chain    : ${fmt(usdtDelta, 6)}\n`)
  process.stdout.write(
    `  Diff        : ${fmt(usdtDelta - usdtFeeFloor, 6)} (>=0 = healthy)\n`,
  )

  const copmHealthy = copmDelta >= copmFeeFloor
  const usdtHealthy = usdtDelta >= usdtFeeFloor
  if (copmHealthy && usdtHealthy) {
    process.stdout.write('\nRESULT: on-chain fees >= floor from logs. Accounting healthy.\n')
    process.exit(0)
  }
  process.stdout.write('\nRESULT: DRIFT DETECTED. On-chain fee < floor from logs.\n')
  process.stdout.write(
    '  Possible causes: (a) events counted here that did not actually settle on-chain (user did not submit the tx or it reverted), (b) fee-recipient balance was moved elsewhere within the block range, (c) a bug in the executor calldata routing the fee somewhere else. Investigate first with block-explorer of the fee recipient across the range.\n',
  )
  process.exit(1)
}

void main().catch((err: unknown) => {
  process.stderr.write(`FATAL: ${err instanceof Error ? err.message : String(err)}\n`)
  process.exit(1)
})
