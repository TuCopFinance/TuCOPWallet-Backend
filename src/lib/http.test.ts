import { fetchWithTimeout } from './http'

describe('fetchWithTimeout', () => {
  const originalFetch = global.fetch

  afterEach(() => {
    global.fetch = originalFetch
  })

  it('aborts the request when the timeout elapses', async () => {
    let abortSignal: AbortSignal | undefined
    global.fetch = jest.fn(async (_url: unknown, init: RequestInit | undefined) => {
      abortSignal = init?.signal as AbortSignal
      return new Promise<Response>((_resolve, reject) => {
        if (abortSignal) {
          abortSignal.addEventListener('abort', () => {
            const err = new Error('aborted') as Error & { name: string }
            err.name = 'AbortError'
            reject(err)
          })
        }
      })
    }) as typeof global.fetch

    await expect(
      fetchWithTimeout('https://example.com', {}, 25),
    ).rejects.toThrow(/abort/i)
    expect(abortSignal).toBeDefined()
    expect(abortSignal!.aborted).toBe(true)
  })

  it('passes through a successful response and clears the timer', async () => {
    const okResponse = new Response('ok', { status: 200 })
    global.fetch = jest.fn(async () => okResponse) as typeof global.fetch

    const res = await fetchWithTimeout('https://example.com', {}, 1000)
    expect(res).toBe(okResponse)
    expect(global.fetch).toHaveBeenCalledTimes(1)
  })

  it('forwards init.headers/method/body to fetch', async () => {
    let captured: { url: string; init: RequestInit | undefined } | undefined
    global.fetch = jest.fn(async (url, init) => {
      captured = { url: String(url), init }
      return new Response('ok', { status: 200 })
    }) as typeof global.fetch

    await fetchWithTimeout(
      'https://example.com/x',
      { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{"a":1}' },
      1000,
    )

    expect(captured?.url).toBe('https://example.com/x')
    expect(captured?.init?.method).toBe('POST')
    expect(captured?.init?.body).toBe('{"a":1}')
    expect(captured?.init?.signal).toBeDefined()
  })
})
