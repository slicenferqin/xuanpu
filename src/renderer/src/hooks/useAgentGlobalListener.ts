/**
 * @deprecated Phase 1 — replaced by useAgentEventBridge.
 *
 * This shim exists so existing imports (`hooks/index.ts`) don't break.
 * All event-handling logic has been migrated to `useAgentEventBridge`.
 * Remove this file after all import sites are cleaned up.
 */

export function useAgentGlobalListener(): void {
  // Intentionally empty — all logic moved to useAgentEventBridge
}
