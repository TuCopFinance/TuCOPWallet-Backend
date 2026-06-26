describe('getDb', () => {
  const ORIGINAL_ENV = { ...process.env }

  beforeEach(() => {
    jest.resetModules()
    process.env = { ...ORIGINAL_ENV }
    delete process.env.DATABASE_URL
  })

  afterAll(() => {
    process.env = ORIGINAL_ENV
  })

  it('returns null when DATABASE_URL is unset', () => {
    const { getDb } = require('./db')
    expect(getDb()).toBeNull()
  })

  it('returns null when DATABASE_URL is the literal "disabled"', () => {
    process.env.DATABASE_URL = 'disabled'
    const { getDb } = require('./db')
    expect(getDb()).toBeNull()
  })

  it('returns a Pool when DATABASE_URL is a real URL', () => {
    process.env.DATABASE_URL = 'postgres://user:pw@localhost:5432/db'
    const { getDb, _resetDbForTests } = require('./db')
    const db = getDb()
    expect(db).not.toBeNull()
    expect(typeof db.query).toBe('function')
    _resetDbForTests()
  })

  it('pingDb returns false when DATABASE_URL is unset', async () => {
    const { pingDb } = require('./db')
    await expect(pingDb()).resolves.toBe(false)
  })
})
