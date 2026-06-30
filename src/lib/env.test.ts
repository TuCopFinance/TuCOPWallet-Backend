import {
  _resetParsedEnvForTests,
  parseEnv,
  parseEnvBigInt,
  readEnvAddress,
  readEnvTopic0,
  ZERO_ADDRESS,
  ZERO_TOPIC,
} from './env'

describe('readEnvAddress', () => {
  const VAR = 'TEST_ENV_ADDR'
  afterEach(() => {
    delete process.env[VAR]
  })

  it('returns ZERO_ADDRESS when env var is unset', () => {
    expect(readEnvAddress(VAR)).toBe(ZERO_ADDRESS)
  })

  it('returns the value as-is when checksummed and lowercase=false (default)', () => {
    process.env[VAR] = '0xaE6a87E88b55644Eda54C3AA55B11944eE5E1DFe'
    expect(readEnvAddress(VAR)).toBe('0xaE6a87E88b55644Eda54C3AA55B11944eE5E1DFe')
  })

  it('lowercases when lowercase=true', () => {
    process.env[VAR] = '0xaE6a87E88b55644Eda54C3AA55B11944eE5E1DFe'
    expect(readEnvAddress(VAR, { lowercase: true })).toBe(
      '0xae6a87e88b55644eda54c3aa55b11944ee5e1dfe',
    )
  })

  it('throws when value is malformed', () => {
    process.env[VAR] = '0xnothex'
    expect(() => readEnvAddress(VAR)).toThrow(/40 hex/)
  })
})

describe('readEnvTopic0', () => {
  const VAR = 'TEST_ENV_TOPIC'
  afterEach(() => {
    delete process.env[VAR]
  })

  it('returns ZERO_TOPIC when unset', () => {
    expect(readEnvTopic0(VAR)).toBe(ZERO_TOPIC)
  })

  it('lowercases a valid topic', () => {
    process.env[VAR] = '0x' + 'A'.repeat(64)
    expect(readEnvTopic0(VAR)).toBe('0x' + 'a'.repeat(64))
  })

  it('throws when value is malformed', () => {
    process.env[VAR] = '0xshort'
    expect(() => readEnvTopic0(VAR)).toThrow(/64 hex/)
  })
})

describe('parseEnv (zod schema)', () => {
  const ORIG_ENV = { ...process.env }

  // Minimum set of REQUIRED env vars to satisfy the zod schema. Tests that
  // wipe process.env start from this baseline and add what their case needs.
  const MIN_REQUIRED = {
    ETHERSCAN_API_KEY: 'test',
    PRIMARY_RPC_URL: 'https://rpc.test',
    FORNO_URL: 'https://forno.test',
    ANKR_RPC_URL: 'https://ankr.test',
    DRPC_RPC_URL: 'https://drpc.test',
  }

  beforeEach(() => {
    _resetParsedEnvForTests()
    // Reset to a known-good baseline. Required field present, optionals empty.
    process.env = { ...ORIG_ENV }
  })

  afterAll(() => {
    process.env = ORIG_ENV
    _resetParsedEnvForTests()
  })

  it('parses a minimal env (only required vars set)', () => {
    process.env = { ...MIN_REQUIRED } as NodeJS.ProcessEnv
    const e = parseEnv()
    expect(e.ETHERSCAN_API_KEY).toBe('test')
    expect(e.PRIMARY_RPC_URL).toBe('https://rpc.test')
    expect(e.PORT).toBe(8080) // default
    expect(e.WRI_RELAY_PER_IP_LIMIT).toBe(20) // default
    expect(e.INDEXER_ENABLED).toBe(false) // default (string 'false' -> bool false)
    expect(e.NEERU_INDEXER_ENABLED).toBe(false)
  })

  it('throws when ETHERSCAN_API_KEY is missing', () => {
    process.env = {} as NodeJS.ProcessEnv
    expect(() => parseEnv()).toThrow(/ETHERSCAN_API_KEY/)
  })

  it('throws on malformed BLOCKSCOUT_BASE_URL (not https)', () => {
    process.env = {
      ...MIN_REQUIRED,
      BLOCKSCOUT_BASE_URL: 'http://evil.example',
    } as NodeJS.ProcessEnv
    expect(() => parseEnv()).toThrow(/BLOCKSCOUT_BASE_URL/)
  })

  it('throws on malformed WRI_RELAY_PK (wrong length)', () => {
    process.env = {
      ...MIN_REQUIRED,
      WRI_RELAY_PK: '0xshort',
    } as NodeJS.ProcessEnv
    expect(() => parseEnv()).toThrow(/WRI_RELAY_PK/)
  })

  it('coerces PORT/PG_POOL_MAX strings to numbers', () => {
    process.env = {
      ...MIN_REQUIRED,
      PORT: '9090',
      PG_POOL_MAX: '50',
    } as NodeJS.ProcessEnv
    const e = parseEnv()
    expect(e.PORT).toBe(9090)
    expect(e.PG_POOL_MAX).toBe(50)
  })

  it('throws when any of the 4 RPC URLs is missing', () => {
    process.env = {
      ETHERSCAN_API_KEY: 'test',
      // PRIMARY_RPC_URL deliberately omitted
      FORNO_URL: 'https://forno.test',
      ANKR_RPC_URL: 'https://ankr.test',
      DRPC_RPC_URL: 'https://drpc.test',
    } as NodeJS.ProcessEnv
    expect(() => parseEnv()).toThrow(/PRIMARY_RPC_URL/)
  })

  it('throws when NEERU_INDEXER_ENABLED=true but contract vars missing', () => {
    process.env = {
      ...MIN_REQUIRED,
      NEERU_INDEXER_ENABLED: 'true',
      DATABASE_URL: 'postgres://...',
      // missing NEERU_INDEXER_GENESIS_BLOCK, NEERU_CONTRACT_ADDRESS, topics
    } as NodeJS.ProcessEnv
    expect(() => parseEnv()).toThrow(/NEERU_INDEXER_ENABLED.*required vars/)
  })

  it('throws when INDEXER_ENABLED=true but DATABASE_URL missing', () => {
    process.env = {
      ...MIN_REQUIRED,
      INDEXER_ENABLED: 'true',
    } as NodeJS.ProcessEnv
    expect(() => parseEnv()).toThrow(/INDEXER_ENABLED.*DATABASE_URL/)
  })

  it('caches the parsed env across calls', () => {
    process.env = { ...MIN_REQUIRED } as NodeJS.ProcessEnv
    const first = parseEnv()
    const second = parseEnv()
    expect(second).toBe(first) // same reference (cached)
  })
})

describe('parseEnvBigInt', () => {
  const VAR = 'TEST_ENV_BIGINT'
  afterEach(() => {
    delete process.env[VAR]
  })

  it('returns fallback when unset', () => {
    expect(parseEnvBigInt(VAR, 7n)).toBe(7n)
  })

  it('parses a valid positive integer', () => {
    process.env[VAR] = '12345'
    expect(parseEnvBigInt(VAR, 7n)).toBe(12345n)
  })

  it('falls back when value is negative', () => {
    process.env[VAR] = '-1'
    expect(parseEnvBigInt(VAR, 7n)).toBe(7n)
  })

  it('falls back when value is not an integer', () => {
    process.env[VAR] = 'notanint'
    expect(parseEnvBigInt(VAR, 7n)).toBe(7n)
  })
})
