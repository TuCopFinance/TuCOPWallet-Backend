describe('wriRelay.getRelayClients', () => {
  beforeEach(() => {
    jest.resetModules()
    delete process.env.WRI_RELAY_PK
  })

  it('returns null when WRI_RELAY_PK is not set', () => {
    const { getRelayClients } = require('./wriRelay')
    expect(getRelayClients()).toBeNull()
  })

  it('returns null when WRI_RELAY_PK is malformed (not 32-byte hex)', () => {
    process.env.WRI_RELAY_PK = '0xnothex'
    const { getRelayClients } = require('./wriRelay')
    expect(getRelayClients()).toBeNull()
  })

  it('returns null when WRI_RELAY_PK is too short', () => {
    process.env.WRI_RELAY_PK = '0x' + 'aa'.repeat(31) // 31 bytes
    const { getRelayClients } = require('./wriRelay')
    expect(getRelayClients()).toBeNull()
  })

  it('loads and caches the client for a valid 32-byte hex key', () => {
    process.env.WRI_RELAY_PK = '0x' + 'aa'.repeat(32)
    const { getRelayClients, _resetRelayClientsForTests } = require('./wriRelay')
    const first = getRelayClients()
    expect(first).not.toBeNull()
    expect(first.account.address).toMatch(/^0x[a-fA-F0-9]{40}$/)
    expect(first.publicClient).toBeDefined()
    expect(first.walletClient).toBeDefined()

    const second = getRelayClients()
    expect(second).toBe(first) // cached identity

    _resetRelayClientsForTests()
    const third = getRelayClients()
    expect(third).not.toBe(first) // cache invalidated, new instance
  })
})
