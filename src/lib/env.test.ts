import {
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
