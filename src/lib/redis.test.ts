describe('getRedis', () => {
  const ORIGINAL_ENV = { ...process.env }

  beforeEach(() => {
    jest.resetModules()
    process.env = { ...ORIGINAL_ENV }
    delete process.env.REDIS_URL
  })

  afterAll(() => {
    process.env = ORIGINAL_ENV
  })

  it('returns null when REDIS_URL is unset', () => {
    const { getRedis } = require('./redis')
    expect(getRedis()).toBeNull()
  })

  it('returns null when REDIS_URL is the literal "disabled"', () => {
    process.env.REDIS_URL = 'disabled'
    const { getRedis } = require('./redis')
    expect(getRedis()).toBeNull()
  })

  it('returns a client when REDIS_URL is a real URL', () => {
    process.env.REDIS_URL = 'redis://localhost:6379'
    const { getRedis } = require('./redis')
    const client = getRedis()
    expect(client).not.toBeNull()
    client?.disconnect()
  })

  it('uses IPv6 (family: 6) for *.railway.internal hostnames', () => {
    process.env.REDIS_URL = 'redis://default:pw@redis.railway.internal:6379'
    const { getRedis } = require('./redis')
    const client = getRedis()
    expect(client).not.toBeNull()
    expect(client?.options.family).toBe(6)
    client?.disconnect()
  })

  it('does NOT force IPv6 for non-Railway hostnames (e.g. public proxy, localhost)', () => {
    process.env.REDIS_URL = 'redis://default:pw@turntable.proxy.rlwy.net:36515'
    const { getRedis } = require('./redis')
    const client = getRedis()
    expect(client).not.toBeNull()
    expect(client?.options.family).not.toBe(6)
    client?.disconnect()
  })
})
