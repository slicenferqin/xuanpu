/**
 * AskUserCard — Interactive question card for the agent timeline.
 *
 * When pending: renders clickable option buttons inline in the timeline,
 * replacing the old InterruptDock QuestionPrompt for the session-hq UI.
 * When answered: compact read-only display of the question.
 */

import React, { useState, useCallback, useRef, useLayoutEffect } from 'react'
import { ActionCard } from './ActionCard'
import { useQuestionStore } from '@/stores/useQuestionStore'
import { cn } from '@/lib/utils'
import { Button } from '@/components/ui/button'
import { Check, Pencil, ChevronRight } from 'lucide-react'
import { isComposingKeyboardEvent } from '@/lib/message-composer-shortcuts'

interface AskUserCardProps {
  question: string
  /** Structured questions with options (from AskUserQuestion tool) */
  questions?: Array<{
    question: string
    options?: Array<{ label: string; description?: string }>
    header?: string
    multiple?: boolean
  }>
  /** Whether we're still waiting for user reply */
  isPending?: boolean
  /** Session ID for resolving the question request and sending the reply */
  sessionId?: string
  /** Worktree path for the reply IPC */
  worktreePath?: string | null
  /** Raw tool output — used to highlight the selected answer when answered */
  answer?: string
}

export function AskUserCard({
  question,
  questions,
  isPending = false,
  sessionId,
  worktreePath,
  answer
}: AskUserCardProps): React.JSX.Element {
  const questionsList = questions ?? []
  const isMultiQuestion = questionsList.length > 1

  // Interactive state — only used when isPending
  const [answers, setAnswers] = useState<string[][]>(() =>
    questionsList.map(() => [])
  )
  const [currentTab, setCurrentTab] = useState(0)
  const [editingCustom, setEditingCustom] = useState(false)
  const [customInput, setCustomInput] = useState('')
  const [sending, setSending] = useState(false)
  const textareaRef = useRef<HTMLTextAreaElement>(null)
  const isImeComposingRef = useRef(false)

  const currentQuestion = questionsList[currentTab]
  const isMultiple = currentQuestion?.multiple ?? false
  const isLastTab = currentTab === questionsList.length - 1
  const currentAnswers = answers[currentTab] ?? []
  const hasCurrentAnswer = currentAnswers.length > 0
  const allAnswered = isMultiQuestion ? answers.every((a) => a.length > 0) : false

  // Detect custom answer (not matching any predefined option)
  const customAnswer = currentAnswers.find(
    (a) => !currentQuestion?.options?.some((o) => o.label === a)
  )

  useLayoutEffect(() => {
    if (textareaRef.current) {
      textareaRef.current.style.height = 'auto'
      textareaRef.current.style.height = `${Math.min(textareaRef.current.scrollHeight, 200)}px`
    }
  }, [customInput])

  const handleOptionClick = useCallback((label: string) => {
    if (sending) return
    if (isMultiple) {
      setAnswers((prev) => {
        const updated = [...prev]
        const current = updated[currentTab] ?? []
        updated[currentTab] = current.includes(label)
          ? current.filter((l) => l !== label)
          : [...current, label]
        return updated
      })
    } else {
      setAnswers((prev) => {
        const updated = [...prev]
        updated[currentTab] = [label]
        return updated
      })
      // Auto-advance for single-choice multi-question
      if (isMultiQuestion && !isLastTab) {
        setTimeout(() => {
          setCurrentTab((t) => t + 1)
          setEditingCustom(false)
        }, 150)
      }
    }
  }, [sending, isMultiple, currentTab, isMultiQuestion, isLastTab])

  const handleCustomSubmit = useCallback(() => {
    const text = customInput.trim()
    if (!text || sending) return
    setAnswers((prev) => {
      const updated = [...prev]
      updated[currentTab] = [text]
      return updated
    })
    setEditingCustom(false)
    setCustomInput('')
    if (isMultiQuestion && !isLastTab) {
      setCurrentTab((t) => t + 1)
    }
  }, [customInput, sending, currentTab, isMultiQuestion, isLastTab])

  const handleSubmit = useCallback(() => {
    if (!sessionId || sending) return
    const request = useQuestionStore.getState().getActiveQuestion(sessionId)
    if (!request) return
    setSending(true)
    window.agentOps.questionReply(request.id, answers, worktreePath ?? undefined)
    useQuestionStore.getState().removeQuestion(sessionId, request.id)
  }, [sessionId, sending, answers, worktreePath])

  const handleDismiss = useCallback(() => {
    if (!sessionId || sending) return
    const request = useQuestionStore.getState().getActiveQuestion(sessionId)
    if (!request) return
    window.agentOps.questionReject(request.id, worktreePath ?? undefined)
    useQuestionStore.getState().removeQuestion(sessionId, request.id)
  }, [sessionId, sending, worktreePath])

  // ─── Non-pending: compact read-only view ────────────────────────

  // Check if an option label matches the answer text
  const isSelectedAnswer = (label: string): boolean => {
    if (!answer) return false
    return answer.includes(label)
  }

  if (!isPending) {
    return (
      <ActionCard
        key="answered"
        accentClass="border-amber-500 bg-amber-500/5"
        headerClass="border-b-amber-500/20 text-amber-700 dark:text-amber-400"
        headerLeft={<span className="font-semibold">Question for you</span>}
        headerRight="Answered"
        defaultExpanded={false}
        collapsible
      >
        {questionsList.length > 0 ? (
          <div className="space-y-3">
            {questionsList.map((q, i) => (
              <div key={i}>
                <div className="text-foreground text-sm font-medium">{q.question}</div>
                {q.options && q.options.length > 0 && (
                  <div className="mt-1.5 space-y-1">
                    {q.options.map((opt, j) => {
                      const selected = isSelectedAnswer(opt.label)
                      return (
                        <div
                          key={j}
                          className={cn(
                            'flex items-start gap-2 text-sm rounded-lg px-2 py-1 -mx-2',
                            selected && 'bg-amber-500/10'
                          )}
                        >
                          {selected ? (
                            <Check className="h-3.5 w-3.5 shrink-0 text-amber-600 dark:text-amber-400 mt-0.5" />
                          ) : (
                            <span className="text-muted-foreground/40 shrink-0">&middot;</span>
                          )}
                          <div>
                            <span className={cn(
                              selected
                                ? 'text-foreground font-semibold'
                                : 'text-muted-foreground'
                            )}>
                              {opt.label}
                            </span>
                            {opt.description && (
                              <span className="text-muted-foreground ml-1.5">&mdash; {opt.description}</span>
                            )}
                          </div>
                        </div>
                      )
                    })}

                    {/* Custom answer — shown when user typed "Other" instead of picking a predefined option */}
                    {answer && q.options && !q.options.some((opt) => isSelectedAnswer(opt.label)) && (
                      <div className="mt-1 rounded-lg bg-amber-500/10 px-2.5 py-1.5 -mx-1">
                        <div className="flex items-start gap-2 text-sm">
                          <Check className="h-3.5 w-3.5 shrink-0 text-amber-600 dark:text-amber-400 mt-0.5" />
                          <span className="text-foreground font-semibold whitespace-pre-wrap">{answer}</span>
                        </div>
                      </div>
                    )}
                  </div>
                )}
              </div>
            ))}
          </div>
        ) : question ? (
          <div className="text-foreground text-sm whitespace-pre-wrap">{question}</div>
        ) : null}
      </ActionCard>
    )
  }

  // ─── Pending: interactive with selectable options ────────────────

  return (
    <ActionCard
      key="pending"
      accentClass="border-amber-500 bg-amber-500/5"
      headerClass="border-b-amber-500/20 text-amber-700 dark:text-amber-400"
      headerLeft={<span className="font-semibold">Question for you</span>}
      headerRight="Waiting for reply"
      defaultExpanded
      collapsible={false}
    >
      {/* Multi-question tabs */}
      {isMultiQuestion && (
        <div className="flex flex-wrap gap-1.5 mb-3">
          {questionsList.map((q, i) => (
            <button
              key={i}
              onClick={() => { setCurrentTab(i); setEditingCustom(false) }}
              className={cn(
                'inline-flex items-center gap-1 rounded-full border px-2.5 py-1 text-[11px] font-medium transition-colors',
                i === currentTab
                  ? 'border-amber-300/80 bg-amber-500/10 text-amber-700 dark:border-amber-400/40 dark:text-amber-200'
                  : 'border-border/65 bg-background/70 text-muted-foreground hover:border-border hover:text-foreground'
              )}
            >
              {q.header || `Q${i + 1}`}
              {answers[i]?.length > 0 && <Check className="h-3 w-3 ml-1 text-emerald-500" />}
            </button>
          ))}
        </div>
      )}

      {/* Current question */}
      {currentQuestion ? (
        <>
          <p className="text-sm font-medium text-foreground mb-3">
            {currentQuestion.question}
          </p>

          {/* Clickable option buttons */}
          {currentQuestion.options && currentQuestion.options.length > 0 && (
            <div className="space-y-2">
              {currentQuestion.options.map((opt) => {
                const isSelected = currentAnswers.includes(opt.label)
                return (
                  <button
                    key={opt.label}
                    onClick={() => handleOptionClick(opt.label)}
                    disabled={sending}
                    className={cn(
                      'w-full rounded-xl border px-3.5 py-2.5 text-left',
                      'transition-all duration-200 disabled:opacity-50',
                      isSelected
                        ? 'border-amber-400/80 bg-amber-500/10'
                        : 'border-border/70 bg-background/75 hover:border-border hover:bg-background'
                    )}
                  >
                    <div className="flex items-center gap-2">
                      {isMultiple && (
                        <div
                          className={cn(
                            'flex h-4 w-4 shrink-0 items-center justify-center rounded-full border transition-colors',
                            isSelected
                              ? 'border-amber-500 bg-amber-500'
                              : 'border-muted-foreground/35 bg-background'
                          )}
                        >
                          {isSelected && <Check className="h-3 w-3 text-white" />}
                        </div>
                      )}
                      <span className="text-sm font-semibold text-foreground">{opt.label}</span>
                    </div>
                    {opt.description && (
                      <p className={cn('mt-1 text-xs text-muted-foreground', isMultiple && 'ml-6')}>
                        {opt.description}
                      </p>
                    )}
                  </button>
                )
              })}

              {/* Custom answer display (when custom text was entered) */}
              {!editingCustom && customAnswer && (
                <button
                  onClick={() => {
                    setEditingCustom(true)
                    setCustomInput(customAnswer)
                  }}
                  disabled={sending}
                  className="w-full rounded-xl border border-amber-400/80 bg-amber-500/10 px-3.5 py-2.5 text-left transition-colors disabled:opacity-50"
                >
                  <div className="flex items-center gap-2 min-w-0">
                    <Pencil className="h-3.5 w-3.5 shrink-0 text-amber-500" />
                    <span className="line-clamp-3 whitespace-pre-wrap text-sm font-medium text-foreground">
                      {customAnswer}
                    </span>
                  </div>
                </button>
              )}

              {/* Custom text option (when no custom answer yet) */}
              {!editingCustom && !customAnswer && (
                <button
                  onClick={() => setEditingCustom(true)}
                  disabled={sending}
                  className="w-full rounded-xl border border-dashed border-border/75 bg-background/55 px-3.5 py-2.5 text-left transition-colors hover:border-border hover:bg-background/80 disabled:opacity-50"
                >
                  <div className="flex items-center gap-2 text-muted-foreground">
                    <Pencil className="h-3.5 w-3.5 shrink-0" />
                    <span className="text-sm">Other...</span>
                  </div>
                </button>
              )}

              {/* Custom text input form */}
              {editingCustom && (
                <div className="flex flex-col gap-2 rounded-xl border border-border/65 bg-background/75 p-3">
                  <textarea
                    ref={textareaRef}
                    autoFocus
                    value={customInput}
                    onChange={(e) => setCustomInput(e.target.value)}
                    onCompositionStart={() => { isImeComposingRef.current = true }}
                    onCompositionEnd={() => { isImeComposingRef.current = false }}
                    onKeyDown={(e) => {
                      if (
                        e.key === 'Enter' &&
                        !e.shiftKey &&
                        !isComposingKeyboardEvent(
                          e.nativeEvent as KeyboardEvent & { keyCode?: number },
                          isImeComposingRef.current
                        )
                      ) {
                        e.preventDefault()
                        handleCustomSubmit()
                      }
                    }}
                    className="min-h-[44px] max-h-[200px] w-full resize-none rounded-lg border border-border/70 bg-background px-3 py-2 text-sm transition-colors focus:border-amber-400/70 focus:outline-none"
                    placeholder="Type your answer..."
                    rows={1}
                    disabled={sending}
                  />
                  <div className="flex gap-2">
                    <Button
                      size="sm"
                      onClick={handleCustomSubmit}
                      disabled={!customInput.trim() || sending}
                    >
                      OK
                    </Button>
                    <Button
                      size="sm"
                      variant="ghost"
                      onClick={() => setEditingCustom(false)}
                      disabled={sending}
                    >
                      Cancel
                    </Button>
                  </div>
                </div>
              )}
            </div>
          )}
        </>
      ) : question ? (
        <div className="text-foreground text-sm whitespace-pre-wrap">{question}</div>
      ) : (
        <div className="text-muted-foreground text-sm italic">Waiting for input...</div>
      )}

      {/* Action bar */}
      <div className="mt-3 flex items-center gap-2 border-t border-border/40 pt-3">
        {isMultiQuestion ? (
          <>
            {currentTab > 0 && (
              <Button
                size="sm"
                variant="ghost"
                onClick={() => { setCurrentTab((t) => t - 1); setEditingCustom(false) }}
                disabled={sending}
                className="rounded-full px-3"
              >
                Back
              </Button>
            )}
            <Button
              size="sm"
              onClick={
                isLastTab
                  ? handleSubmit
                  : () => { setCurrentTab((t) => t + 1); setEditingCustom(false) }
              }
              disabled={
                (isLastTab && !allAnswered) || (!isLastTab && !hasCurrentAnswer) || sending
              }
              className="rounded-full px-4"
            >
              {sending ? 'Sending...' : isLastTab ? 'Submit' : (
                <>Next <ChevronRight className="h-3.5 w-3.5" /></>
              )}
            </Button>
          </>
        ) : (
          <Button
            size="sm"
            onClick={handleSubmit}
            disabled={!hasCurrentAnswer || sending}
            className="rounded-full px-4"
          >
            {sending ? 'Sending...' : 'Submit'}
          </Button>
        )}
        <Button
          size="sm"
          variant="ghost"
          onClick={handleDismiss}
          disabled={sending}
          className="rounded-full px-3 text-muted-foreground"
        >
          Dismiss
        </Button>
      </div>
    </ActionCard>
  )
}
