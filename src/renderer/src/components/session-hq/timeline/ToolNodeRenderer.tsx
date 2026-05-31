import type React from 'react'
import type { StreamingPart } from '@shared/lib/timeline-types'
import { SystemNotificationBar } from '@/components/sessions/SystemNotificationBar'
import {
  AskUserCard,
  BashCard,
  FileReadCard,
  FileWriteCard,
  PlanCard,
  SearchCard,
  SubAgentCard,
  TextCard,
  ThinkingCard,
  TodoCard
} from '@/components/session-hq/cards'
import { ThreadStatusRow } from '@/components/session-hq/ThreadStatusRow'
import { useI18n } from '@/i18n/useI18n'
import type { TimelineNode } from '@/lib/session-timeline/view-model'
import { cn } from '@/lib/utils'
import { useQuestionStore, type QuestionRequest } from '@/stores/useQuestionStore'

const EMPTY_QUESTIONS: readonly QuestionRequest[] = Object.freeze([])

interface ToolNodeRendererProps {
  node: TimelineNode
  sessionId?: string
  worktreePath?: string | null
  childPartsMap?: Map<string, StreamingPart[]>
  planContentByToolUseId?: Map<string, string>
}

function isXfpToolName(name: string): boolean {
  const lower = name.toLowerCase()
  return lower.startsWith('mcp__xuanpu-field__') || lower.startsWith('xfp_')
}

function formatXfpToolLabel(name: string): string {
  const normalized = name
    .replace(/^mcp__xuanpu-field__/i, '')
    .replace(/^xfp_get_/i, '')
    .replace(/^xfp_/i, '')
    .replace(/_/g, ' ')
  return `XFP · ${normalized || 'field'}`
}

function getGenericToolLabel(name: string, input?: Record<string, unknown>): string {
  const lower = name.toLowerCase()
  if (isXfpToolName(name)) {
    return formatXfpToolLabel(name)
  }
  if (lower === 'skill' && input?.skill) {
    return `/${input.skill as string}`
  }
  if ((lower === 'webfetch' || lower === 'web_fetch') && input?.url) {
    try {
      return new URL(input.url as string).hostname
    } catch {
      return name
    }
  }
  if ((lower === 'websearch' || lower === 'web_search') && input?.query) {
    const q = String(input.query)
    return q.length > 60 ? q.slice(0, 57) + '...' : q
  }
  return name.charAt(0).toUpperCase() + name.slice(1)
}

export function ToolNodeRenderer({
  node,
  sessionId,
  worktreePath,
  childPartsMap,
  planContentByToolUseId
}: ToolNodeRendererProps): React.JSX.Element | null {
  const { t } = useI18n()

  // Keep an ask-user card pending while the runtime question store still has a
  // matching unanswered question, even if the durable tool status already says
  // success. This protects session-switch races for Codex/OpenCode HITL cards.
  const pendingQuestions = useQuestionStore((s) =>
    sessionId ? (s.pendingBySession.get(sessionId) ?? EMPTY_QUESTIONS) : EMPTY_QUESTIONS
  )

  switch (node.cardType) {
    case 'system':
      return (
        <ThreadStatusRow
          status={{
            id: node.message.id,
            kind: 'compacted',
            timestamp: Date.parse(node.message.timestamp) || Date.now()
          }}
        />
      )

    case 'task-notification':
      return <SystemNotificationBar content={node.textContent ?? ''} />

    case 'thinking':
      return <ThinkingCard content={node.textContent ?? ''} />

    case 'bash':
      return node.toolUse ? <BashCard toolUse={node.toolUse} /> : null

    case 'file-read':
      return node.toolUse ? <FileReadCard toolUse={node.toolUse} /> : null

    case 'file-write':
      return node.toolUse ? <FileWriteCard toolUse={node.toolUse} /> : null

    case 'search':
      return node.toolUse ? <SearchCard toolUse={node.toolUse} /> : null

    case 'sub-agent': {
      const subtaskData = node.part?.subtask
        ? node.part.subtask
        : node.toolUse
          ? {
              id: node.toolUse.id,
              sessionID: '',
              prompt: (node.toolUse.input?.prompt as string) ?? '',
              description:
                (node.toolUse.input?.description as string) ??
                t('sessionHq.cards.subAgent.defaultDescription'),
              agent:
                (node.toolUse.input?.subagent_type as string) ??
                t('sessionHq.cards.subAgent.agentFallback'),
              parts: [],
              status: (node.toolUse.status === 'success'
                ? 'completed'
                : node.toolUse.status === 'error'
                  ? 'error'
                  : 'running') as 'running' | 'completed' | 'error'
            }
          : null
      if (!subtaskData) return null
      const childParts = childPartsMap?.get(subtaskData.id) ?? []
      return <SubAgentCard subtask={subtaskData} childParts={childParts} />
    }

    case 'plan': {
      const toolUseId = node.toolUse?.id
      const overrideContent = toolUseId ? planContentByToolUseId?.get(toolUseId) : undefined
      const inputPlan = node.toolUse?.input?.plan as string | undefined
      const output = node.toolUse?.output as string | undefined
      const content =
        (overrideContent && overrideContent.length > 0 ? overrideContent : undefined) ??
        (inputPlan && inputPlan.length > 0 ? inputPlan : undefined) ??
        output ??
        ''
      const planStatus = node.toolUse?.status
      const verdict: 'approved' | 'rejected' | undefined =
        planStatus === 'success' ? 'approved' : planStatus === 'rejected' ? 'rejected' : undefined
      return (
        <PlanCard
          content={content}
          isPending={planStatus === 'pending' || planStatus === 'running'}
          verdict={verdict}
        />
      )
    }

    case 'ask-user': {
      const askToolUseId = node.toolUse?.id
      const stillPendingForThisCard =
        !!askToolUseId &&
        pendingQuestions.some((q) => q.tool?.callID === askToolUseId || q.id === askToolUseId)
      const askStatus = node.toolUse?.status
      const isPending =
        askStatus === 'pending' || askStatus === 'running' || stillPendingForThisCard
      return (
        <AskUserCard
          question={(node.toolUse?.input?.question as string) ?? ''}
          questions={
            Array.isArray(node.toolUse?.input?.questions)
              ? (node.toolUse!.input!.questions as Array<{
                  question: string
                  options?: Array<{ label: string; description?: string }>
                  header?: string
                  multiple?: boolean
                }>)
              : undefined
          }
          isPending={isPending}
          sessionId={sessionId}
          worktreePath={worktreePath}
          answer={node.toolUse?.output}
        />
      )
    }

    case 'todo':
      return node.toolUse ? <TodoCard toolUse={node.toolUse} /> : null

    case 'tool-call': {
      if (!node.toolUse) return null
      const label = getGenericToolLabel(node.toolUse.name, node.toolUse.input)
      const isSuccess = node.toolUse.status === 'success'
      const isError = node.toolUse.status === 'error'
      const isRunning = node.toolUse.status === 'running' || node.toolUse.status === 'pending'
      const isXfp = isXfpToolName(node.toolUse.name)
      return (
        <div
          className={cn(
            'crisp-subtle-shadow rounded-xl border px-3.5 py-2',
            isXfp
              ? 'border-tech-blue/25 bg-tech-blue-soft/55'
              : 'border-neon-violet/25 bg-neon-violet-soft/55'
          )}
        >
          <div className="flex items-center gap-2 text-sm">
            <span
              className={cn(
                'crisp-status-dot h-2 w-2 rounded-full',
                isXfp ? 'bg-tech-blue text-tech-blue' : 'bg-neon-violet text-neon-violet'
              )}
            />
            <span className="font-medium text-ink">{label}</span>
            <span className="text-xs text-muted-foreground">
              {isRunning
                ? t('sessionHq.timeline.genericToolStatus.running')
                : isError
                  ? t('sessionHq.timeline.genericToolStatus.error')
                  : isSuccess
                    ? t('sessionHq.timeline.genericToolStatus.done')
                    : node.toolUse.status}
            </span>
          </div>
        </div>
      )
    }

    case 'text':
      return <TextCard content={node.textContent ?? ''} />

    default:
      return null
  }
}
