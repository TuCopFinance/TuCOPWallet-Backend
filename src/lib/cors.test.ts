import request from 'supertest'

jest.mock('./wriRelay', () => ({
  getRelayClients: () => null,
  _resetRelayClientsForTests: () => {},
}))

jest.mock('./redis', () => ({
  getRedis: () => null,
}))

import { app } from '../app'

describe('CORS', () => {
  describe('read paths (permissive)', () => {
    it('reflects no Origin and returns Access-Control-Allow-Origin: *', async () => {
      const res = await request(app)
        .options('/health')
        .set('Origin', 'https://random.example')
        .set('Access-Control-Request-Method', 'GET')
      expect(res.headers['access-control-allow-origin']).toBe('*')
    })
  })

  describe('write paths (strict allowlist)', () => {
    it('allows a browser from the default tucop.xyz origin', async () => {
      const res = await request(app)
        .options('/api/wri/delegate-relay')
        .set('Origin', 'https://tucop.xyz')
        .set('Access-Control-Request-Method', 'POST')
      expect(res.headers['access-control-allow-origin']).toBe('https://tucop.xyz')
    })

    it('omits the Allow-Origin header when called from a disallowed origin', async () => {
      const res = await request(app)
        .options('/api/wri/delegate-relay')
        .set('Origin', 'https://evil.example')
        .set('Access-Control-Request-Method', 'POST')
      expect(res.headers['access-control-allow-origin']).toBeUndefined()
    })

    it('allows requests with no Origin (mobile / curl / server-to-server)', async () => {
      // No Origin header set; the actual POST then falls through to the route
      // handler which 400s on missing body. The cors check passes regardless.
      const res = await request(app).post('/api/wri/delegate-relay').send({})
      // 400 from the handler, not a cors-rejection 5xx. Proves the cors layer
      // did not block.
      expect(res.status).toBe(400)
    })

    it('also strictly enforces on /hooks-api/triggerShortcut', async () => {
      const res = await request(app)
        .options('/hooks-api/triggerShortcut')
        .set('Origin', 'https://evil.example')
        .set('Access-Control-Request-Method', 'POST')
      expect(res.headers['access-control-allow-origin']).toBeUndefined()
    })

    it('also strictly enforces on /api/transactions/watch', async () => {
      const res = await request(app)
        .options('/api/transactions/watch')
        .set('Origin', 'https://evil.example')
        .set('Access-Control-Request-Method', 'POST')
      expect(res.headers['access-control-allow-origin']).toBeUndefined()
    })
  })

  describe('env-driven origin override', () => {
    const ORIG = process.env.CORS_WRITE_ALLOWED_ORIGINS

    afterEach(() => {
      if (ORIG === undefined) {
        delete process.env.CORS_WRITE_ALLOWED_ORIGINS
      } else {
        process.env.CORS_WRITE_ALLOWED_ORIGINS = ORIG
      }
    })

    it('allows an origin added via CORS_WRITE_ALLOWED_ORIGINS', async () => {
      process.env.CORS_WRITE_ALLOWED_ORIGINS =
        'https://partner.example,https://other.example'
      const res = await request(app)
        .options('/api/wri/delegate-relay')
        .set('Origin', 'https://partner.example')
        .set('Access-Control-Request-Method', 'POST')
      expect(res.headers['access-control-allow-origin']).toBe(
        'https://partner.example',
      )
    })

    it('rejects the default origins when env override is set (override REPLACES, not extends)', async () => {
      process.env.CORS_WRITE_ALLOWED_ORIGINS = 'https://partner.example'
      const res = await request(app)
        .options('/api/wri/delegate-relay')
        .set('Origin', 'https://tucop.xyz')
        .set('Access-Control-Request-Method', 'POST')
      expect(res.headers['access-control-allow-origin']).toBeUndefined()
    })
  })
})
