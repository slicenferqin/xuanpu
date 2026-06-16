/**
 * Compatibility alias for the Xuanpu controlled oh-my-pi runtime package.
 *
 * New code should prefer @xuanpu/oh-my-pi-runtime. This alias remains so older
 * imports keep working while package boundaries are migrated.
 */
export * from '@xuanpu/oh-my-pi-runtime'
export { runTurn, agentLoop, agentLoopContinue } from '@xuanpu/oh-my-pi-runtime'
