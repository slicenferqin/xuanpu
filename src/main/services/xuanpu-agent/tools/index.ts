/**
 * Tools for xuanpu-agent.
 *
 * M2 ships read-only git/file/search tools. M4 adds controlled write tools
 * that are exclusive and require diff-preview confirmation unless the session
 * is explicitly trusted. M6 adds scoped field tools (Xuanpu-owned, read-only)
 * and subtask delegation.
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
export {
  xfpGetCurrentFocusTool,
  xfpGetLastTerminalTool,
  xfpGetRecentActivityTool,
  xfpGetWorktreeSummaryTool,
  xfpGetPinnedFactsTool,
  XFP_FIELD_TOOLS
} from './field-tools'
export { xfpDelegateSubtaskTool, SUBTASK_TOOLS } from './subtask-tools'

import { gitStatusTool, gitLogTool, gitDiffTool } from './git-tools'
import { readFileTool, listFilesTool } from './file-tools'
import { rgSearchTool } from './search-tools'
import { CONTROLLED_WRITE_TOOLS } from './write-tools'
import { XFP_FIELD_TOOLS } from './field-tools'
import { SUBTASK_TOOLS } from './subtask-tools'

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

export const XUANPU_AGENT_TOOLS: AgentTool[] = [
  ...READ_ONLY_TOOLS,
  ...CONTROLLED_WRITE_TOOLS,
  ...XFP_FIELD_TOOLS,
  ...SUBTASK_TOOLS
]
