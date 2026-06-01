export interface SlashCommandInfo {
  name: string
  description?: string
  template: string
  agent?: string
  builtIn?: boolean
}

export const BUILT_IN_SLASH_COMMANDS: SlashCommandInfo[] = [
  {
    name: 'undo',
    description: 'Undo the last message and file changes',
    template: '/undo',
    builtIn: true
  },
  {
    name: 'redo',
    description: 'Redo the last undone message and file changes',
    template: '/redo',
    builtIn: true
  },
  {
    name: 'clear',
    description: 'Close current tab and open a new one',
    template: '/clear',
    builtIn: true
  },
  {
    name: 'ask',
    description: 'Ask a question without making code changes',
    template: '/ask ',
    builtIn: true
  },
  {
    name: 'status',
    description: 'Show session status and current task',
    template: '/status',
    builtIn: true
  },
  {
    name: 'context',
    description: 'Show context window usage',
    template: '/context',
    builtIn: true
  },
  {
    name: 'compact',
    description: 'Compact conversation to save context',
    template: '/compact ',
    builtIn: true
  },
  {
    name: 'mcp',
    description: 'Show MCP server status',
    template: '/mcp',
    builtIn: true
  },
  {
    name: 'remember',
    description: 'Add a permanent fact about this worktree (Pinned Facts)',
    template: '/remember ',
    builtIn: true
  },
  {
    name: 'forget',
    description: 'Remove a Pinned Fact by substring match',
    template: '/forget ',
    builtIn: true
  }
]
