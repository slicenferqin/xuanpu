/**
 * AgentTimeline — Vertical timeline view for agent actions.
 *
 * Replaces ThreadPane as the main message rendering container.
 * Left-side vertical line + colored icon nodes, each dispatching
 * to the appropriate Action Card based on StreamingPart type.
 *
 * Data flow:
 *   timelineMessages (durable) → extract parts → render cards
 *   streamingContent (live)    → inline streaming text at bottom
 */

import React, { useMemo } from 'react'
import { cn } from '@/lib/utils'
import type { TimelineMessage, StreamingPart } from '@shared/lib/timeline-types'
import type { SessionLifecycle } from '@/stores/useSessionRuntimeStore'
import { useI18n } from '@/i18n/useI18n'
import { TextCard, TodoCard } from '@/components/session-hq/cards'
import { ThreadStatusRow, type ThreadStatusRowData } from '@/components/session-hq/ThreadStatusRow'
import type { SessionTask } from '@/lib/session-tasks'
import { buildTimelineViewModel, type TimelineNode } from '@/lib/session-timeline/view-model'
import type { TimelineCardType } from '@/lib/session-timeline/card-type'

import {
  TimelineNodeFrame,
  type TimelineNodeIconConfig
} from '@/components/session-hq/timeline/TimelineNodeFrame'
import { TimelineNodeRenderer } from '@/components/session-hq/timeline/TimelineNodeRenderer'
import { RoundNavigator } from '@/components/session-hq/timeline/RoundNavigator'
import { buildRoundNavigatorItems } from '@/lib/session-timeline/round-navigator'

import {
  Terminal,
  FileText,
  Pencil,
  Search,
  Brain,
  ClipboardList,
  CheckSquare,
  HelpCircle,
  Users,
  MessageSquare,
  User,
  Loader2
} from 'lucide-react'

// ---------------------------------------------------------------------------
// Timeline icon config
// ---------------------------------------------------------------------------

const ICON_MAP: Record<TimelineCardType, TimelineNodeIconConfig> = {
  'user-message': {
    icon: User,
    colorClass: 'text-tech-blue',
    bgClass: 'bg-tech-blue-soft'
  },
  system: { icon: MessageSquare, colorClass: 'text-steel', bgClass: 'bg-agent-card-muted' },
  'task-notification': {
    icon: MessageSquare,
    colorClass: 'text-steel',
    bgClass: 'bg-agent-card-muted'
  },
  thinking: {
    icon: Brain,
    colorClass: 'text-neon-violet',
    bgClass: 'bg-neon-violet-soft'
  },
  bash: { icon: Terminal, colorClass: 'text-neon-mint', bgClass: 'bg-neon-mint-soft' },
  'file-read': { icon: FileText, colorClass: 'text-neon-mint', bgClass: 'bg-neon-mint-soft' },
  'file-write': {
    icon: Pencil,
    colorClass: 'text-tech-blue',
    bgClass: 'bg-tech-blue-soft'
  },
  search: { icon: Search, colorClass: 'text-neon-mint', bgClass: 'bg-neon-mint-soft' },
  'sub-agent': {
    icon: Users,
    colorClass: 'text-neon-violet',
    bgClass: 'bg-neon-violet-soft'
  },
  plan: {
    icon: ClipboardList,
    colorClass: 'text-neon-violet',
    bgClass: 'bg-neon-violet-soft'
  },
  'ask-user': {
    icon: HelpCircle,
    colorClass: 'text-neon-pink',
    bgClass: 'bg-neon-pink-soft'
  },
  todo: { icon: CheckSquare, colorClass: 'text-neon-mint', bgClass: 'bg-neon-mint-soft' },
  'tool-call': {
    icon: Terminal,
    colorClass: 'text-neon-violet',
    bgClass: 'bg-neon-violet-soft'
  },
  text: { icon: MessageSquare, colorClass: 'text-ink', bgClass: 'bg-agent-card-muted' }
}

// ---------------------------------------------------------------------------
// AgentTimeline
// ---------------------------------------------------------------------------

export interface AgentTimelineProps {
  timelineMessages: TimelineMessage[]
  streamingContent: string
  streamingParts?: StreamingPart[]
  isStreaming: boolean
  /**
   * Timestamp (ISO string or epoch ms) of when the current streaming run
   * started. Assistant messages with timestamp >= this value are suppressed
   * from the durable timeline so they don't double-render alongside the live
   * streaming overlay (the SDK persists partial progress to DB throughout the
   * turn — without this filter the user sees their own message twice after
   * switching tabs and back during streaming).
   */
  activeRunStartedAt?: number | string | null
  lifecycle: SessionLifecycle
  ephemeralStatusRows?: ThreadStatusRowData[]
  /**
   * Live compaction marker that should appear inline at its own timestamp
   * (NOT pinned at the bottom). Once the run finishes and the compaction
   * lands in `timelineMessages` as a durable message part, the parent stops
   * passing this so the durable copy takes over.
   */
  inflightCompaction?: ThreadStatusRowData | null
  /** Suppress inline TodoCard rendering when the right context panel owns tasks. */
  suppressTodoCards?: boolean
  /** Aggregated final task list — renders one TodoCard when explicitly requested. */
  finalTodoTasks?: SessionTask[]
  /** Session ID — needed for interactive AskUserCard reply */
  sessionId?: string
  /** Worktree path — needed for interactive AskUserCard reply */
  worktreePath?: string | null
  /** Child-session parts keyed by parent tool_use id (sub-agent tool calls) */
  childPartsMap?: Map<string, StreamingPart[]>
  /**
   * Plan content resolved out-of-band (e.g. Claude Code reads the plan from
   * disk in `canUseTool(ExitPlanMode)` and ships it via plan.ready — the SDK's
   * own tool_use.input.plan is empty). Keyed by tool_use id.
   */
  planContentByToolUseId?: Map<string, string>
  onCopyUserMessage?: (message: TimelineMessage) => void
  onEditUserMessage?: (message: TimelineMessage) => void
  onForkUserMessage?: (message: TimelineMessage) => void | Promise<void>
  canEditUserMessage?: (message: TimelineMessage) => boolean
  editingMessageId?: string | null
  editingContent?: string
  onEditingContentChange?: (content: string) => void
  onSaveUserMessageEdit?: (messageId: string) => void | Promise<void>
  onCancelUserMessageEdit?: () => void
  forkingMessageId?: string | null
  scrollContainerRef?: React.RefObject<HTMLDivElement | null>
  /**
   * Ref owned by useTimelineScrollController. AgentTimeline only attaches it
   * to the content div; scroll geometry remains outside this renderer.
   */
  timelineContentRef?: React.RefObject<HTMLDivElement | null>
  /**
   * Ref for the tail sentinel element. Used by IntersectionObserver to
   * determine tail readability against the bottom overlay.
   */
  tailSentinelRef?: React.RefObject<HTMLDivElement | null>
  onScroll?: () => void
  onWheel?: () => void
  onPointerDown?: () => void
  onPointerUp?: () => void
  onPointerCancel?: () => void
  /**
   * Measured bottom readable inset (overlay height + breathing room).
   * Used as paddingBottom so content is readable above the overlay.
   */
  bottomReadableInset?: number
  /** Spacer height computed by useTimelineScrollController for clear-screen rounds. */
  clearScreenSpacerHeight?: number
  activeRoundId?: string | null
  onRoundAnchorNavigate?: (roundId: string) => void
}

export function AgentTimeline({
  timelineMessages,
  streamingContent,
  streamingParts = [],
  isStreaming,
  activeRunStartedAt,
  lifecycle: _lifecycle,
  ephemeralStatusRows = [],
  inflightCompaction = null,
  suppressTodoCards,
  finalTodoTasks,
  sessionId,
  worktreePath,
  childPartsMap,
  planContentByToolUseId,
  onCopyUserMessage,
  onEditUserMessage,
  onForkUserMessage,
  canEditUserMessage,
  editingMessageId,
  editingContent,
  onEditingContentChange,
  onSaveUserMessageEdit,
  onCancelUserMessageEdit,
  forkingMessageId,
  scrollContainerRef,
  timelineContentRef: externalTimelineContentRef,
  tailSentinelRef,
  onScroll,
  onWheel,
  onPointerDown,
  onPointerUp,
  onPointerCancel,
  bottomReadableInset = 72,
  clearScreenSpacerHeight = 0,
  activeRoundId = null,
  onRoundAnchorNavigate
}: AgentTimelineProps): React.JSX.Element {
  const { t } = useI18n()
  const internalScrollContainerRef = React.useRef<HTMLDivElement | null>(null)
  const effectiveScrollContainerRef = scrollContainerRef ?? internalScrollContainerRef
  const internalTimelineContentRef = React.useRef<HTMLDivElement | null>(null)
  const timelineContentRef = externalTimelineContentRef ?? internalTimelineContentRef

  const { nodes, preludeNodes, rounds, streamingNodes } = useMemo(
    () =>
      buildTimelineViewModel({
        timelineMessages,
        streamingParts,
        isStreaming,
        activeRunStartedAt,
        suppressTodoCards
      }),
    [activeRunStartedAt, isStreaming, streamingParts, suppressTodoCards, timelineMessages]
  )

  // Scroll-edge gradient masks (Step 4 — visual boundary feedback)
  const [showTopGradient, setShowTopGradient] = React.useState(false)
  const [showBottomGradient, setShowBottomGradient] = React.useState(false)

  React.useEffect(() => {
    const el = effectiveScrollContainerRef.current
    if (!el) return

    const update = (): void => {
      setShowTopGradient(el.scrollTop > 16)
      setShowBottomGradient(el.scrollHeight - el.scrollTop - el.clientHeight > 16)
    }

    update()
    el.addEventListener('scroll', update, { passive: true })

    const obs =
      typeof ResizeObserver !== 'undefined'
        ? (() => {
            const o = new ResizeObserver(update)
            o.observe(el)
            return o
          })()
        : null

    return () => {
      el.removeEventListener('scroll', update)
      obs?.disconnect()
    }
  }, [effectiveScrollContainerRef])

  // Overlay model: use the measured bottomReadableInset directly.
  // This replaces the old safeBottomPadding heuristic.
  const paddingBottom = bottomReadableInset

  const renderNodeContent = (node: TimelineNode): React.JSX.Element | null => (
    <TimelineNodeRenderer
      node={node}
      sessionId={sessionId}
      worktreePath={worktreePath}
      childPartsMap={childPartsMap}
      planContentByToolUseId={planContentByToolUseId}
      canEditUserMessage={canEditUserMessage}
      editingMessageId={editingMessageId}
      editingContent={editingContent}
      onEditingContentChange={onEditingContentChange}
      onSaveUserMessageEdit={onSaveUserMessageEdit}
      onCancelUserMessageEdit={onCancelUserMessageEdit}
      onCopyUserMessage={onCopyUserMessage}
      onEditUserMessage={onEditUserMessage}
      onForkUserMessage={onForkUserMessage}
      forkingMessageId={forkingMessageId}
    />
  )

  const renderCommittedTimelineNode = (
    node: TimelineNode,
    nextNode?: TimelineNode
  ): React.JSX.Element => {
    if (node.cardType === 'user-message') {
      return (
        <div key={node.key} className="mb-6">
          {renderNodeContent(node)}
        </div>
      )
    }

    const showTimestamp =
      node.isLastInMessage && (!nextNode || nextNode.cardType === 'user-message')
    const iconConfig = node.cardType === 'text' ? undefined : ICON_MAP[node.cardType]

    return (
      <TimelineNodeFrame
        key={node.key}
        node={node}
        iconConfig={iconConfig}
        renderConnector
        showTimestamp={showTimestamp}
      >
        {renderNodeContent(node)}
      </TimelineNodeFrame>
    )
  }

  const renderStreamingTimelineNode = (node: TimelineNode, index: number): React.JSX.Element => {
    const iconCfg = ICON_MAP[node.cardType]
    const isLastStreamNode = index === streamingNodes.length - 1
    const showSpinner = isStreaming && isLastStreamNode

    if (node.cardType === 'text') {
      return (
        <TimelineNodeFrame
          key={node.key}
          node={node}
          iconConfig={iconCfg}
          iconClassName={showSpinner ? 'bg-neon-mint-soft text-neon-mint' : undefined}
          iconChildren={showSpinner ? <Loader2 className="h-3 w-3 animate-spin" /> : undefined}
          renderConnector
        >
          <TextCard content={node.textContent ?? ''} isStreaming={showSpinner} />
        </TimelineNodeFrame>
      )
    }

    return (
      <TimelineNodeFrame key={node.key} node={node} iconConfig={iconCfg} renderConnector>
        {renderNodeContent(node)}
      </TimelineNodeFrame>
    )
  }

  return (
    <div
      ref={effectiveScrollContainerRef}
      className="relative h-full min-h-0 overflow-y-auto overscroll-contain"
      onScroll={onScroll}
      onWheel={onWheel}
      onPointerDown={onPointerDown}
      onPointerUp={onPointerUp}
      onPointerCancel={onPointerCancel}
      data-testid="hq-agent-timeline-scroll"
    >
      {/* Top edge mask: visible when content extends above the viewport */}
      <div
        aria-hidden="true"
        className={cn(
          'pointer-events-none sticky top-0 z-10 h-10 -mb-10 bg-gradient-to-b from-background/65 to-transparent transition-opacity duration-200',
          showTopGradient ? 'opacity-100' : 'opacity-0'
        )}
      />
      <RoundNavigator
        rounds={buildRoundNavigatorItems(rounds)}
        activeRoundId={activeRoundId}
        bottomReadableInset={bottomReadableInset}
        scrollContainerRef={effectiveScrollContainerRef}
        onRoundAnchorNavigate={onRoundAnchorNavigate}
      />
      <div
        className="w-[85%] ml-[5%]"
        style={
          {
            paddingTop: '24px',
            paddingBottom: `${paddingBottom}px`,
            // Keep assistant prose and wide markdown blocks within the timeline column.
            '--xp-reader-wide-max': '100%',
            '--xp-reader-wide-measure': '100%'
          } as React.CSSProperties
        }
      >
        <div ref={timelineContentRef} className="min-w-0">
          {preludeNodes.map((node, index) =>
            renderCommittedTimelineNode(node, preludeNodes[index + 1])
          )}

          {rounds.map((round) => {
            return (
              <section
                key={round.id}
                id={round.anchorId}
                data-round-anchor="true"
                data-round-id={round.id}
                className="mb-7 scroll-mt-8"
              >
                {round.nodes.map((node, nodeIndex) =>
                  renderCommittedTimelineNode(node, round.nodes[nodeIndex + 1])
                )}
              </section>
            )
          })}

          {/* Inflight 压缩 marker：永远落在 rounds 之后、streaming 之前。 */}
          {inflightCompaction && (
            <ThreadStatusRow key={inflightCompaction.id} status={inflightCompaction} />
          )}

          {/* Final aggregated TodoCard — rendered only when a parent explicitly passes it. */}
          {finalTodoTasks && finalTodoTasks.length > 0 && (
            <div className="relative pl-10 mb-4">
              <div className="absolute left-[15px] top-0 bottom-0 w-[2px] bg-border opacity-60" />
              <div
                className={cn(
                  'absolute left-[4px] top-2.5 w-[24px] h-[24px] rounded-full',
                  'flex items-center justify-center z-10',
                  ICON_MAP.todo.bgClass,
                  ICON_MAP.todo.colorClass
                )}
              >
                <CheckSquare className="h-3 w-3" />
              </div>
              <TodoCard tasks={finalTodoTasks} />
            </div>
          )}

          {/* Live streaming parts — real-time tool/text/reasoning rendering.
                Render from buffer regardless of streaming state so content survives
                session switches: the buffer holds what thread/read hasn't persisted yet. */}
          {streamingNodes.length > 0 &&
            streamingNodes.map((node, index) => renderStreamingTimelineNode(node, index))}

          {/* Streaming with no content yet — show pulse */}
          {isStreaming &&
            streamingNodes.length === 0 &&
            !streamingContent &&
            ephemeralStatusRows.length === 0 && (
              <div className="relative pl-10 mb-4">
                <div
                  className={cn(
                    'absolute left-[4px] top-2.5 w-[24px] h-[24px] rounded-full',
                    'flex items-center justify-center z-10',
                    'bg-neon-mint-soft text-neon-mint'
                  )}
                >
                  <Loader2 className="h-3 w-3 animate-spin" />
                </div>
                <div className="text-sm text-muted-foreground italic">
                  {t('sessionHq.timeline.thinking')}
                </div>
              </div>
            )}

          {ephemeralStatusRows.map((status) => (
            <ThreadStatusRow key={status.id} status={status} />
          ))}

          {/* Tail sentinel: represents the real content tail.
                Must be before the clear-screen/focus filler, because filler
                is a layout affordance, not real content. */}
          <div
            ref={tailSentinelRef}
            data-timeline-tail-sentinel="true"
            data-testid="timeline-tail-sentinel"
            className="h-px w-full"
            aria-hidden="true"
          />

          {/* Clear-screen spacer: value is computed by useTimelineScrollController,
                which is the single owner of timeline scroll geometry. */}
          {clearScreenSpacerHeight > 0 && nodes.length > 0 && (
            <div
              aria-hidden="true"
              data-clear-screen-spacer="true"
              data-testid="timeline-clear-screen-spacer"
              style={{ height: `${clearScreenSpacerHeight}px` }}
            />
          )}

          {/* Empty state */}
          {nodes.length === 0 && ephemeralStatusRows.length === 0 && !isStreaming && (
            <div className="flex flex-col items-center justify-center py-20 text-muted-foreground">
              <MessageSquare className="h-10 w-10 mb-3 opacity-30" />
              <div className="text-sm font-medium">{t('sessionHq.timeline.emptyTitle')}</div>
              <div className="text-xs mt-1">{t('sessionHq.timeline.emptySubtitle')}</div>
            </div>
          )}
        </div>
      </div>
      {/* Bottom edge mask: visible when content extends below the viewport */}
      <div
        aria-hidden="true"
        className={cn(
          'pointer-events-none sticky bottom-0 z-10 h-10 -mt-10 bg-gradient-to-t from-background/65 to-transparent transition-opacity duration-200',
          showBottomGradient ? 'opacity-100' : 'opacity-0'
        )}
      />
    </div>
  )
}
