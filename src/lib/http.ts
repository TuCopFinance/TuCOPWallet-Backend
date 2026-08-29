export const DEFAULT_UPSTREAM_TIMEOUT_MS = 8000

export async function fetchWithTimeout(
  url: string,
  init: RequestInit = {},
  timeoutMs: number = DEFAULT_UPSTREAM_TIMEOUT_MS,
): Promise<Response> {
  const ctrl = new AbortController()
  const timer = setTimeout(() => ctrl.abort(), timeoutMs)
  // Preserve caller-supplied AbortSignal (SIGTERM propagation from worker
  // loops) by composing it with the timeout signal via AbortSignal.any.
  // Without this the caller signal never reaches the socket and workers
  // block on the full timeout window on shutdown.
  const signal = init.signal
    ? AbortSignal.any([init.signal, ctrl.signal])
    : ctrl.signal
  try {
    return await fetch(url, { ...init, signal })
  } finally {
    clearTimeout(timer)
  }
}

// Strip common API key query params from any string before it lands in logs
// or Sentry. Etherscan's `message` field frequently echoes the request URL
// (including `apikey=...`), and Blockscout can do the same on 4xx bodies.
// Applies to `apikey`, `api_key`, `access_token`, and `token` (Etherscan v1
// + v2 + a few adjacent providers). Keeps the param name for grep-ability
// so operators can still tell WHICH key was on the URL.
const API_KEY_QUERY_RE = /((?:apikey|api_key|access_token|token)=)[^&\s"']+/gi

export function redactUpstreamString(input: string): string {
  return input.replace(API_KEY_QUERY_RE, '$1<redacted>')
}
