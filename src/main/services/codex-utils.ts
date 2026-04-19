// ── Shared type-narrowing helpers for Codex JSON-RPC payloads ────

export function asObject(value: unknown): Record<string, unknown> | undefined {
  if (!value || typeof value !== 'object') {
    return undefined
  }
  return value as Record<string, unknown>
}

export function asString(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined
}

export function asNumber(value: unknown): number | undefined {
  return typeof value === 'number' ? value : undefined
}

export function toDebugSnapshot(value: unknown, maxLength = 500): string {
  if (value === undefined) return 'undefined'

  try {
    const serialized = JSON.stringify(value)
    if (serialized === undefined) return 'undefined'
    return serialized.length > maxLength ? serialized.slice(0, maxLength) : serialized
  } catch {
    return '[unserializable]'
  }
}
