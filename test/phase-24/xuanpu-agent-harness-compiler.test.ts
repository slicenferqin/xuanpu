import type { Session, Worktree } from '../../src/main/db/types'
import { ContextBudgetRecorder } from '../../src/main/services/xuanpu-agent/harness/budget'
import { XfpPacketCompiler } from '../../src/main/services/xuanpu-agent/harness/compiler'
import { XfpFieldPacketSchema } from '../../src/main/services/xuanpu-agent/xfp/schema'
import { fullXfpPacketExample } from '../../src/main/services/xuanpu-agent/xfp/fixtures'

describe('XfpPacketCompiler', () => {
  it('compiles a schema-valid immutable packet from prepared snapshots', () => {
    const recorder = new ContextBudgetRecorder()
    const compiler = new XfpPacketCompiler(recorder)
    const fixture = fullXfpPacketExample()

    const result = compiler.compile(
      createWorktree(),
      createSession(),
      'Implement compiler skeleton',
      {
        now: 1760000000000,
        packetId: 'packet-compiler-1',
        turnId: 'turn-compiler-1',
        rawPacketRef: '/tmp/xuanpu-agent/packet-compiler-1.json',
        gitState: fixture.gitState,
        focus: fixture.focus,
        terminal: fixture.terminal,
        tests: fixture.tests,
        commandTrace: fixture.commandTrace,
        budgetProfile: 'balanced',
        budgetTokens: 80000,
        estimatedTokens: 1234,
        compressionRatio: 0.25,
        omittedSections: [{ name: 'retrievedMemory', reason: 'not implemented in M1 skeleton' }]
      }
    )

    expect(() => XfpFieldPacketSchema.parse(result.packet)).not.toThrow()
    expect(result.packet.identity).toEqual({
      packetId: 'packet-compiler-1',
      capturedAt: 1760000000000,
      projectId: 'project-1',
      worktreeId: 'worktree-1',
      sessionId: 'session-1'
    })
    expect(result.packet.currentGoal).toMatchObject({
      objective: 'Implement compiler skeleton',
      source: 'user-message',
      successCriteria: null
    })
    expect(result.packet.anchor?.worktreeNotesMarkdown).toBe('Worktree context note')
    expect(result.packet.budget).toEqual({
      profile: 'balanced',
      budgetTokens: 80000,
      estimatedTokens: 1234,
      omittedSectionNames: ['retrievedMemory'],
      compressionRatio: 0.25
    })
    expect(Object.isFrozen(result.packet)).toBe(true)
    expect(Object.isFrozen(result.packet.identity)).toBe(true)
  })

  it('records Context Budget for every compiled turn', () => {
    const recorder = new ContextBudgetRecorder()
    const compiler = new XfpPacketCompiler(recorder)
    const fixture = fullXfpPacketExample()

    const { packet, decisions } = compiler.compile(
      createWorktree(),
      createSession(),
      'Check budget',
      {
        now: 1760000000001,
        packetId: 'packet-budget-1',
        turnId: 'turn-budget-1',
        rawPacketRef: '/tmp/xuanpu-agent/packet-budget-1.json',
        gitState: fixture.gitState,
        estimatedTokens: 99,
        includedSections: ['identity', 'gitState', 'currentGoal', 'budget'],
        omittedSections: [
          { name: 'terminal', reason: 'not provided' },
          { name: 'tests', reason: 'not provided' }
        ]
      }
    )

    expect(decisions).toEqual({
      includedSections: ['identity', 'gitState', 'currentGoal', 'budget'],
      omittedSections: [
        { name: 'terminal', reason: 'not provided' },
        { name: 'tests', reason: 'not provided' }
      ],
      estimatedTokens: 99,
      budgetProfile: 'balanced'
    })
    expect(Object.isFrozen(decisions)).toBe(true)
    expect(recorder.getLatestRecord('session-1')).toEqual({
      turnId: 'turn-budget-1',
      capturedAt: 1760000000001,
      sessionId: 'session-1',
      runtime: 'xuanpu-agent',
      packetId: packet.identity.packetId,
      budgetProfile: 'balanced',
      includedSections: ['identity', 'gitState', 'currentGoal', 'budget'],
      omittedSections: ['terminal', 'tests'],
      estimatedTokens: 99,
      compressionRatio: null,
      rawPacketRef: '/tmp/xuanpu-agent/packet-budget-1.json'
    })
  })

  it('uses default omissions for missing optional sections', () => {
    const fixture = fullXfpPacketExample()
    const compiler = new XfpPacketCompiler()

    const { packet, decisions } = compiler.compile(
      { ...createWorktree(), context: null },
      createSession(),
      'Minimal skeleton compile',
      {
        now: 1760000000002,
        packetId: 'packet-minimal-1',
        gitState: fixture.gitState
      }
    )

    expect(packet.anchor).toBeNull()
    expect(packet.terminal).toBeNull()
    expect(packet.tests).toBeNull()
    expect(packet.commandTrace).toBeNull()
    expect(packet.retrievedMemory).toBeNull()
    expect(packet.retrievedWorkflows).toBeNull()
    expect(packet.budget.omittedSectionNames).toEqual([
      'anchor',
      'terminal',
      'tests',
      'commandTrace',
      'retrievedMemory',
      'retrievedWorkflows'
    ])
    expect(decisions.omittedSections).toEqual([
      { name: 'anchor', reason: 'not provided' },
      { name: 'terminal', reason: 'not provided' },
      { name: 'tests', reason: 'not provided' },
      { name: 'commandTrace', reason: 'not provided' },
      { name: 'retrievedMemory', reason: 'not provided' },
      { name: 'retrievedWorkflows', reason: 'not provided' }
    ])
  })
})

function createWorktree(): Worktree {
  return {
    id: 'worktree-1',
    project_id: 'project-1',
    name: 'schnauzer',
    branch_name: 'feat/xuanpu-agent-oh-my-pi',
    path: '/Users/slicenfer/.xuanpu-worktrees/xuanpu/xuanpu--schnauzer',
    status: 'active',
    is_default: false,
    branch_renamed: 1,
    last_message_at: null,
    session_titles: '[]',
    last_model_provider_id: null,
    last_model_id: null,
    last_model_variant: null,
    last_agent_sdk: 'xuanpu-agent',
    attachments: '[]',
    pinned: 0,
    context: 'Worktree context note',
    github_pr_number: null,
    github_pr_url: null,
    created_at: '2026-05-25T00:00:00.000Z',
    last_accessed_at: '2026-05-25T00:00:00.000Z'
  }
}

function createSession(): Session {
  return {
    id: 'session-1',
    worktree_id: 'worktree-1',
    project_id: 'project-1',
    connection_id: null,
    name: 'Harness compile',
    status: 'active',
    opencode_session_id: null,
    agent_sdk: 'xuanpu-agent',
    mode: 'build',
    model_provider_id: 'anthropic',
    model_id: 'claude-haiku-4-5',
    model_variant: null,
    first_message_at: null,
    created_at: '2026-05-25T00:00:00.000Z',
    updated_at: '2026-05-25T00:00:00.000Z',
    completed_at: null
  }
}
