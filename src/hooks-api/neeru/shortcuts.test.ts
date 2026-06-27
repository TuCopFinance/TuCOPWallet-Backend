import { NEERU_APP_ID, getNeeruShortcuts } from './shortcuts'

describe('getNeeruShortcuts', () => {
  it('returns the 3 expected shortcut entries with appId=neeru-vaults', () => {
    const shortcuts = getNeeruShortcuts()
    expect(shortcuts).toHaveLength(3)
    const ids = shortcuts.map((s) => s.id).sort()
    expect(ids).toEqual(['deposit', 'withdraw', 'withdraw-principal-only'])
    for (const s of shortcuts) {
      expect(s.appId).toBe(NEERU_APP_ID)
      expect(s.networkIds).toEqual(['celo-mainnet'])
    }
  })

  it('categorises deposit / withdraw correctly', () => {
    const shortcuts = getNeeruShortcuts()
    const byId = Object.fromEntries(shortcuts.map((s) => [s.id, s]))
    expect(byId.deposit?.category).toBe('deposit')
    expect(byId.withdraw?.category).toBe('withdraw')
    expect(byId['withdraw-principal-only']?.category).toBe('withdraw')
  })

  it('returns a fresh array each call (no shared mutable state)', () => {
    const a = getNeeruShortcuts()
    const b = getNeeruShortcuts()
    a[0]!.name = 'tampered'
    expect(b[0]!.name).not.toBe('tampered')
  })
})
