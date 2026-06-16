import type { DatabaseService } from '../../db/database'
import {
  createAgentTurn,
  updateAgentTurnStatus,
  type AgentTurnStatus
} from '../../db/turn-repository'
import {
  appendContextSegment,
  closeEpoch,
  createUserRound,
  updateTaskRunStatus,
  updateUserRoundStatus
} from '../../db/task-run-repository'
import type {
  AgentContextSegment,
  AgentUserRound,
  TaskRunStatus,
  UserRoundOrigin,
  UserRoundStatus
} from '../../../shared/types/agent-task-run'
import type { XuanpuAgentModelRef } from './model-config'

export interface UserRoundStartInput {
  taskRunId: string
  sessionId: string
  worktreeId: string | null
  projectId: string
  runtimeId: string
  promptText: string
  requestedTaskRunId?: string | null
  userMessageId: string
  modelRef: XuanpuAgentModelRef
}

export interface UserRoundScope {
  userRound: AgentUserRound
  contextSegment: AgentContextSegment
  turnId: string
}

export interface ActiveUserRoundScopeIds {
  turnId?: string | null
  contextSegmentId?: string | null
  taskRunId?: string | null
  userRoundId?: string | null
}

export class UserRoundRunner {
  constructor(private readonly db: DatabaseService) {}

  start(input: UserRoundStartInput): UserRoundScope {
    const userRound = createUserRound(
      {
        taskRunId: input.taskRunId,
        sessionId: input.sessionId,
        origin: inferUserRoundOrigin(input.promptText, input.requestedTaskRunId ?? null),
        userMessageId: input.userMessageId,
        promptText: input.promptText
      },
      this.db
    )
    const contextSegment = appendContextSegment(
      {
        taskRunId: input.taskRunId,
        sessionId: input.sessionId,
        userRoundId: userRound.id
      },
      this.db
    )
    const turnId = createAgentTurn(
      {
        sessionId: input.sessionId,
        worktreeId: input.worktreeId,
        projectId: input.projectId,
        runtimeId: input.runtimeId,
        taskRunId: input.taskRunId,
        userRoundId: userRound.id,
        epochId: contextSegment.id,
        userMessageId: input.userMessageId,
        modelProviderId: input.modelRef.providerID,
        modelId: input.modelRef.modelID,
        modelVariant: input.modelRef.variant ?? null
      },
      this.db
    ).id

    return { userRound, contextSegment, turnId }
  }

  completeUserRound(userRoundId: string): void {
    updateUserRoundStatus(userRoundId, 'completed', undefined, this.db)
  }

  failActiveScope(ids: ActiveUserRoundScopeIds, errorMessage: string): void {
    this.settleActiveScope(ids, {
      turnStatus: 'failed',
      taskRunStatus: 'failed',
      userRoundStatus: 'failed',
      errorMessage
    })
  }

  abortActiveScope(ids: ActiveUserRoundScopeIds, errorMessage: string): void {
    this.settleActiveScope(ids, {
      turnStatus: 'aborted',
      taskRunStatus: 'aborted',
      userRoundStatus: 'aborted',
      errorMessage
    })
  }

  private settleActiveScope(
    ids: ActiveUserRoundScopeIds,
    options: {
      turnStatus: AgentTurnStatus
      taskRunStatus: TaskRunStatus
      userRoundStatus: UserRoundStatus
      errorMessage: string
    }
  ): void {
    if (ids.turnId) {
      updateAgentTurnStatus(
        ids.turnId,
        options.turnStatus,
        { errorMessage: options.errorMessage },
        this.db
      )
    }
    if (ids.contextSegmentId) {
      closeEpoch(
        ids.contextSegmentId,
        {
          status: 'failed',
          endFillRatio: null,
          closeReason: 'watchdog'
        },
        this.db
      )
    }
    if (ids.taskRunId) {
      updateTaskRunStatus(
        ids.taskRunId,
        options.taskRunStatus,
        { errorMessage: options.errorMessage },
        this.db
      )
    }
    if (ids.userRoundId) {
      updateUserRoundStatus(
        ids.userRoundId,
        options.userRoundStatus,
        { errorMessage: options.errorMessage },
        this.db
      )
    }
  }
}

export function inferUserRoundOrigin(
  text: string,
  requestedTaskRunId: string | null
): UserRoundOrigin {
  if (/\bno-progress-recovery\b/i.test(text)) return 'recovery-continuation'
  if (requestedTaskRunId || /<xuanpu-task-run-continuation\b/i.test(text)) {
    return 'agent-continuation'
  }
  return 'user-originated'
}
