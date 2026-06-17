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

  it('uses IPv6 (family: 6) so Railway internal hostnames resolve', () => {
    process.env.REDIS_URL = 'redis://default:pw@redis.railway.internal:6379'
    const { getRedis } = require('./redis')
    const client = getRedis()
    expect(client).not.toBeNull()
    expect(client?.options.family).toBe(6)
    client?.disconnect()
  })
})
