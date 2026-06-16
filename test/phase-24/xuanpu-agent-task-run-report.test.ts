import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

vi.mock('@shared/app-identity', () => ({
  getActiveAppDatabasePath: (home: string) => join(home, '.xuanpu', 'test.db'),
  APP_BUNDLE_ID: 'test',
  APP_CLI_NAME: 'test',
  APP_PRODUCT_NAME: 'test'
}))

import { DatabaseService } from '../../src/main/db/database'
import {
  appendContextSegment,
  closeEpoch,
  createTaskRun,
  createUserRound,
  incrementEpochProviderCallCount
} from '../../src/main/db/task-run-repository'
import { createAgentTurn, createAgentTurnContextSnapshot } from '../../src/main/db/turn-repository'
import {
  buildTaskRunReport,
  exportTaskRunReport,
  renderTaskRunReportMarkdown
} from '../../src/main/services/xuanpu-agent/task-run-report'

let tmpDir: string
let db: DatabaseService
let projectId: string
let worktreeId: string
let sessionId: string

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), 'xuanpu-task-run-report-'))
  db = new DatabaseService(join(tmpDir, 'test.db'))
  db.init()

  const project = db.createProject({ name: 'Task Run Report', path: join(tmpDir, 'repo') })
  const worktree = db.createWorktree({
    project_id: project.id,
    name: 'main',
    branch_name: 'main',
    path: join(tmpDir, 'repo')
  })
  const session = db.createSession({
    project_id: project.id,
    worktree_id: worktree.id,
    agent_sdk: 'xuanpu-agent'
  })

  projectId = project.id
  worktreeId = worktree.id
  sessionId = session.id
})

afterEach(() => {
  db.close()
  rmSync(tmpDir, { recursive: true, force: true })
})

describe('xuanpu-agent task-run report export', () => {
  it('builds a replayable report with provider snapshots and raw command refs', () => {
    const taskRun = createTaskRun(
      {
        sessionId,
        worktreeId,
        projectId,
        originMessageId: 'msg-user-1',
        autonomy: 'long',
        objective: 'Ship task-run report export'
      },
      db
    )
    const round = createUserRound(
      {
        taskRunId: taskRun.id,
        sessionId,
        origin: 'user-originated',
        userMessageId: 'msg-user-1',
        promptText: 'export a task-run report'
      },
      db
    )
    const segment = appendContextSegment(
      {
        taskRunId: taskRun.id,
        sessionId,
        userRoundId: round.id,
        startFillRatio: 0.2
      },
      db
    )
    incrementEpochProviderCallCount(segment.id, db)
    closeEpoch(
      segment.id,
      {
        status: 'compacted',
        endFillRatio: 0.72,
        closeReason: 'compact'
      },
      db
    )
    const turn = createAgentTurn(
      {
        sessionId,
        worktreeId,
        projectId,
        runtimeId: 'xuanpu-agent',
        taskRunId: taskRun.id,
        userRoundId: round.id,
        epochId: segment.id,
        userMessageId: 'msg-user-1',
        modelProviderId: 'openai',
        modelId: 'gpt-test'
      },
      db
    )
    const snapshot = createAgentTurnContextSnapshot(
      {
        turnId: turn.id,
        sessionId,
        xfpPacketId: 'packet-1',
        taskRunId: taskRun.id,
        userRoundId: round.id,
        contextSegmentId: segment.id,
        contextSegmentOrdinal: segment.ordinal,
        providerCallSeq: 0,
        providerRequestHash: 'hash-abcdef',
        prefixHash: 'prefix-123456',
        managedContextJson: JSON.stringify({ budget: { fillRatio: 0.2 }, messageCount: 3 }),
        providerMessagesJson: JSON.stringify({ promptMessage: { role: 'user' } }),
        providerToolsJson: JSON.stringify([{ name: 'read_file' }]),
        providerConfigJson: JSON.stringify({
          modelRef: { providerID: 'openai', modelID: 'gpt-test' },
          providerSessionPolicy: { mode: 'disabled' }
        }),
        decisionsJson: JSON.stringify({
          providerRequestHash: 'hash-abcdef',
          prefixHash: 'prefix-123456',
          providerCallSeq: 0,
          gateway: {
            action: 'compact',
            reason: 'maintenance',
            requestedProfile: 'balanced',
            effectiveProfile: 'extended',
            profileMaxTokens: 200000,
            maintenanceTokenLimit: 220000,
            hardTokenLimit: 250000,
            providerEstimatedInputTokens: 221000,
            providerContextWindowTokens: 1000000,
            fillRatio: 1.105
          }
        }),
        managedApproxTokens: 1200,
        providerEstimatedInputTokens: 1500,
        maxContextTokens: 150000
      },
      db
    )
    db.createCommandTrace({
      traceId: 'trace-1',
      sessionId,
      worktreeId,
      command: 'pnpm vitest run test/phase-24/xuanpu-agent-task-run-report.test.ts',
      cwd: join(tmpDir, 'repo'),
      exitCode: 0,
      durationMs: 1234,
      rawOutput: 'tests passed',
      compressedOutput: '<ToolObservation>tests passed</ToolObservation>',
      compressionRatio: 0.5,
      category: 'run_test',
      ruleHits: 'large-output'
    })

    const report = buildTaskRunReport(taskRun.id, {
      database: db,
      generatedAt: '2026-06-16T10:00:00.000Z'
    })

    expect(report).toMatchObject({
      schemaVersion: 1,
      generatedAt: '2026-06-16T10:00:00.000Z',
      taskRun: { id: taskRun.id, objective: 'Ship task-run report export' },
      totals: {
        userRoundCount: 1,
        contextSegmentCount: 1,
        providerRequestCount: 1,
        providerCallCount: 1,
        relatedCommandTraceCount: 1
      }
    })
    expect(report?.providerRequests[0]).toMatchObject({
      id: snapshot.id,
      xfpPacketId: 'packet-1',
      providerConfig: {
        modelRef: { providerID: 'openai', modelID: 'gpt-test' }
      },
      decisions: {
        providerRequestHash: 'hash-abcdef',
        providerCallSeq: 0,
        gateway: {
          action: 'compact',
          providerEstimatedInputTokens: 221000
        }
      },
      replayPayloadBytes: {
        providerMessagesJson: expect.any(Number),
        providerToolsJson: expect.any(Number)
      }
    })
    expect(report?.relatedCommandTraces[0]).toMatchObject({
      id: 'trace-1',
      rawOutputBytes: Buffer.byteLength('tests passed', 'utf-8'),
      rawOutputSha256: expect.stringMatching(/^[0-9a-f]{64}$/)
    })

    const markdown = renderTaskRunReportMarkdown(report!)
    expect(markdown).toContain('# Xuanpu Agent Task Run Report')
    expect(markdown).toContain('Ship task-run report export')
    expect(markdown).toContain('## ProviderRequests')
    expect(markdown).toContain('compact extended 111% 221000/250000')
    expect(markdown).toContain('packet-1')
    expect(markdown).toContain('## Related Command Trace Raw Refs')
    expect(markdown).toContain('trace-1')
  })

  it('exports markdown and json reports to deterministic files', () => {
    const taskRun = createTaskRun({ sessionId, worktreeId, projectId }, db)
    const reportDir = join(tmpDir, 'reports')

    const markdown = exportTaskRunReport(taskRun.id, {
      database: db,
      generatedAt: '2026-06-16T10:00:00.000Z',
      reportDir
    })
    const json = exportTaskRunReport(taskRun.id, {
      database: db,
      generatedAt: '2026-06-16T10:00:01.000Z',
      reportDir,
      format: 'json'
    })

    expect(markdown.success).toBe(true)
    expect(markdown.filePath).toMatch(/xuanpu-agent-task-run-.+\.md$/)
    expect(markdown.filePath && existsSync(markdown.filePath)).toBe(true)
    expect(readFileSync(markdown.filePath!, 'utf-8')).toContain('Xuanpu Agent Task Run Report')

    expect(json.success).toBe(true)
    expect(json.filePath).toMatch(/xuanpu-agent-task-run-.+\.json$/)
    expect(JSON.parse(readFileSync(json.filePath!, 'utf-8'))).toMatchObject({
      schemaVersion: 1,
      taskRun: { id: taskRun.id }
    })
  })

  it('returns a structured error when the task run does not exist', () => {
    expect(
      exportTaskRunReport('missing-task-run', {
        database: db,
        generatedAt: '2026-06-16T10:00:00.000Z',
        reportDir: join(tmpDir, 'reports')
      })
    ).toMatchObject({
      success: false,
      taskRunId: 'missing-task-run',
      error: 'Task run not found: missing-task-run'
    })
  })
})
