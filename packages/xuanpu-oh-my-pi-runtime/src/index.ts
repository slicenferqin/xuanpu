/**
 * Xuanpu controlled oh-my-pi-derived runtime facade.
 *
 * Re-exports the public Agent API unchanged, and adds:
 *   - runTurn() — turn-scoped prompt without context-message echo.
 */
export * from '@oh-my-pi/pi-agent-core'

// Override agent-loop exports with turn-scoped variants.
export { runTurn, agentLoop, agentLoopContinue } from './agent-loop'
