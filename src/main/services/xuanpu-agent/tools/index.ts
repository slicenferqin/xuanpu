/**
 * Read-only tools for xuanpu-agent M2.
 *
 * These tools are registered via agent.setTools() and provide the model with
 * read-only access to the worktree: git history, file contents, and search.
 *
 * All tools are concurrency: 'shared' (parallelSafe) — the oh-my-pi agent
 * loop respects this and runs them via Promise.allSettled when multiple tool
 * calls arrive in one turn.
 */
export { gitStatusTool, gitLogTool, gitDiffTool } from './git-tools'
export { readFileTool, listFilesTool } from './file-tools'
export { rgSearchTool } from './search-tools'

import { gitStatusTool, gitLogTool, gitDiffTool } from './git-tools'
import { readFileTool, listFilesTool } from './file-tools'
import { rgSearchTool } from './search-tools'

import type { AgentTool } from '@oh-my-pi/pi-agent-core'

/**
 * All read-only tools registered for the xuanpu-agent M2 harness.
 * Order matters: first tools appear first in the function declarations sent
 * to the model, so list from most-frequently-used to least.
 */
export const READ_ONLY_TOOLS: AgentTool[] = [
  gitStatusTool,
  readFileTool,
  rgSearchTool,
  listFilesTool,
  gitLogTool,
  gitDiffTool
]
