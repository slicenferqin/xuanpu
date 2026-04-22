/**
 * Tiny fetch wrapper for the Hub API.
 *
 * Base URL: `?api=https://...` query string OR same-origin (default).
 * We persist the override to localStorage so the user only types it once
 * per device. Everything is `credentials:'include'` so the sh_session
 * cookie travels.
 *
 * On any 401, listeners registered via `onAuthError(cb)` fire — App uses
 * this to bounce the user to /login.
 */

const API_BASE_KEY = 'xuanpu.apiBase'

function detectApiBase(): string {
  const url = new URL(window.location.href)
  const fromQuery = url.searchParams.get('api')
  if (fromQuery) {
    localStorage.setItem(API_BASE_KEY, fromQuery)
    // Rewrite the URL so we don't keep the query param visible.
    url.searchParams.delete('api')
    window.history.replaceState({}, '', url.toString())
    return fromQuery
  }
  const stored = localStorage.getItem(API_BASE_KEY)
  if (stored) return stored
  return window.location.origin
}

let apiBase = detectApiBase()

export function getApiBase(): string {
  return apiBase
}

export function setApiBase(value: string): void {
  apiBase = value
  localStorage.setItem(API_BASE_KEY, value)
}

const authListeners = new Set<() => void>()

export function onAuthError(cb: () => void): () => void {
  authListeners.add(cb)
  return () => authListeners.delete(cb)
}

interface RequestOptions {
  method?: 'GET' | 'POST' | 'PUT' | 'DELETE'
  body?: unknown
  headers?: Record<string, string>
  signal?: AbortSignal
}

export class ApiError extends Error {
  constructor(
    public readonly status: number,
    public readonly code: string,
    message: string
  ) {
    super(message)
    this.name = 'ApiError'
  }
}

export async function api<T = unknown>(path: string, opts: RequestOptions = {}): Promise<T> {
  const url = path.startsWith('http') ? path : `${apiBase}${path}`
  const headers: Record<string, string> = {
    accept: 'application/json',
    ...(opts.headers ?? {})
  }
  if (opts.body !== undefined) headers['content-type'] = 'application/json'

  const res = await fetch(url, {
    method: opts.method ?? 'GET',
    credentials: 'include',
    headers,
    body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined,
    signal: opts.signal
  })

  if (res.status === 401) {
    for (const cb of authListeners) cb()
  }

  const text = await res.text()
  let parsed: unknown = text
  try {
    parsed = text.length > 0 ? JSON.parse(text) : null
  } catch {
    /* keep as string */
  }

  if (!res.ok) {
    const errPayload =
      parsed && typeof parsed === 'object' && parsed !== null && 'error' in parsed
        ? (parsed as { error: { code?: string; message?: string } }).error
        : { code: 'HTTP_' + res.status, message: typeof parsed === 'string' ? parsed : '' }
    throw new ApiError(
      res.status,
      errPayload.code ?? 'HTTP_' + res.status,
      errPayload.message ?? `HTTP ${res.status}`
    )
  }

  return parsed as T
}
