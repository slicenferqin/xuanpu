/**
 * Tools for xuanpu-agent.
 *
 * M2 ships read-only git/file/search tools. M4 adds controlled write tools
 * that are exclusive and require diff-preview confirmation unless the session
 * is explicitly trusted.
 */
export { gitStatusTool, gitLogTool, gitDiffTool } from './git-tools'
export { readFileTool, listFilesTool } from './file-tools'
export { rgSearchTool } from './search-tools'
export {
  applyPatchTool,
  writeFileTool,
  editFileTool,
  runTestTool,
  formatFileTool,
  CONTROLLED_WRITE_TOOLS
} from './write-tools'

import { gitStatusTool, gitLogTool, gitDiffTool } from './git-tools'
import { readFileTool, listFilesTool } from './file-tools'
import { rgSearchTool } from './search-tools'
import { CONTROLLED_WRITE_TOOLS } from './write-tools'

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

export const XUANPU_AGENT_TOOLS: AgentTool[] = [...READ_ONLY_TOOLS, ...CONTROLLED_WRITE_TOOLS]
