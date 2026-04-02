import { useState, useCallback, useRef, useLayoutEffect } from 'react'
import { MessageCircleQuestion, Check, X, ChevronRight, Pencil } from 'lucide-react'
import { cn } from '@/lib/utils'
import { Button } from '@/components/ui/button'
import type { QuestionRequest, QuestionAnswer } from '@/stores/useQuestionStore'
import { useI18n } from '@/i18n/useI18n'
import { isComposingKeyboardEvent } from '@/lib/message-composer-shortcuts'

interface QuestionPromptProps {
  request: QuestionRequest
  onReply: (requestId: string, answers: QuestionAnswer[]) => void
  onReject: (requestId: string) => void
}

export function QuestionPrompt({ request, onReply, onReject }: QuestionPromptProps) {
  const { t } = useI18n()
  const [currentTab, setCurrentTab] = useState(0)
  const [answers, setAnswers] = useState<QuestionAnswer[]>(request.questions.map(() => []))
  const [customInputs, setCustomInputs] = useState<string[]>(request.questions.map(() => ''))
  const [editingCustom, setEditingCustom] = useState(false)
  const [sending, setSending] = useState(false)

  const textareaRef = useRef<HTMLTextAreaElement>(null)
  const isImeComposingRef = useRef(false)

  const isMultiQuestion = request.questions.length > 1
  const currentQuestion = request.questions[currentTab]
  const isMultiple = currentQuestion?.multiple ?? false
  const isCustomAllowed = currentQuestion?.custom !== false
  const isLastTab = currentTab === request.questions.length - 1

  // Auto-resize the custom answer textarea
  useLayoutEffect(() => {
    const textarea = textareaRef.current
    if (textarea) {
      textarea.style.height = 'auto'
      textarea.style.height = `${Math.min(textarea.scrollHeight, 200)}px`
    }
  }, [customInputs, currentTab])

  const handleSubmit = useCallback(
    (finalAnswers?: QuestionAnswer[]) => {
      if (sending) return
      setSending(true)
      onReply(request.id, finalAnswers || answers)
    },
    [sending, onReply, request.id, answers]
  )

  const handleOptionClick = useCallback(
    (label: string) => {
      if (sending) return

      if (isMultiple) {
        // Multi-choice: toggle the selection
        setAnswers((prev) => {
          const updated = [...prev]
          const current = updated[currentTab] || []
          if (current.includes(label)) {
            updated[currentTab] = current.filter((l) => l !== label)
          } else {
            updated[currentTab] = [...current, label]
          }
          return updated
        })
        return
      }

      // Single-choice: select this option (replaces previous selection)
      setAnswers((prev) => {
        const updated = [...prev]
        updated[currentTab] = [label]
        return updated
      })

      // Multi-question: auto-advance to next tab
      if (isMultiQuestion && !isLastTab) {
        setTimeout(() => {
          setCurrentTab((t) => t + 1)
          setEditingCustom(false)
        }, 150)
      }
    },
    [sending, isMultiple, isMultiQuestion, currentTab, isLastTab]
  )

  const handleCustomSubmit = useCallback(
    (e: React.FormEvent) => {
      e.preventDefault()
      const text = customInputs[currentTab]?.trim()
      if (!text || sending) return

      // Save custom text as the selected answer (no auto-submit)
      setAnswers((prev) => {
        const updated = [...prev]
        updated[currentTab] = [text]
        return updated
      })
      setEditingCustom(false)

      // Multi-question: auto-advance
      if (isMultiQuestion && !isLastTab) {
        setCurrentTab((t) => t + 1)
      }
    },
    [customInputs, currentTab, sending, isMultiQuestion, isLastTab]
  )

  const handleCustomInputChange = useCallback(
    (value: string) => {
      setCustomInputs((prev) => {
        const updated = [...prev]
        updated[currentTab] = value
        return updated
      })
    },
    [currentTab]
  )

  const handleNext = useCallback(() => {
    if (isLastTab) {
      handleSubmit()
    } else {
      setCurrentTab((t) => t + 1)
      setEditingCustom(false)
    }
  }, [isLastTab, handleSubmit])

  const handleDismiss = useCallback(() => {
    if (sending) return
    onReject(request.id)
  }, [sending, onReject, request.id])

  const currentAnswers = answers[currentTab] || []
  const hasCurrentAnswer = currentAnswers.length > 0

  // Detect a custom answer (one not matching any predefined option label)
  const customAnswer = isCustomAllowed
    ? currentAnswers.find((a) => !currentQuestion?.options.some((o) => o.label === a))
    : undefined

  // For multi-question: check all questions have at least one answer
  const allAnswered = isMultiQuestion ? answers.every((a) => a.length > 0) : false

  if (!currentQuestion) return null

  return (
    <div
      className="overflow-hidden rounded-3xl border border-border/75 bg-card/96 shadow-[0_8px_24px_rgba(15,23,42,0.055)] backdrop-blur-sm"
      data-testid="question-prompt"
    >
      {/* Header */}
      <div className="border-b border-border/60 bg-gradient-to-b from-background/95 to-muted/20 px-4 py-3">
        <div className="flex items-center gap-3">
          <span className="inline-flex size-8 items-center justify-center rounded-xl bg-sky-500/10 text-sky-600 dark:text-sky-300">
            <MessageCircleQuestion className="h-4 w-4 shrink-0" />
          </span>
          <div className="min-w-0 flex-1">
            {!isMultiQuestion ? (
              <span className="block truncate text-sm font-semibold text-foreground">
                {currentQuestion.header}
              </span>
            ) : (
              <span className="block truncate text-sm font-semibold text-foreground">
                {t('toolCard.labels.question')}
              </span>
            )}
            <span className="text-[11px] text-muted-foreground">
              {isMultiQuestion
                ? `${currentTab + 1}/${request.questions.length}`
                : t('questionPrompt.actions.submit')}
            </span>
          </div>
          <button
            onClick={handleDismiss}
            disabled={sending}
            className="ml-auto inline-flex size-8 items-center justify-center rounded-xl text-muted-foreground transition-colors hover:bg-background/80 hover:text-foreground disabled:opacity-50 shrink-0"
            aria-label={t('questionPrompt.actions.dismiss')}
          >
            <X className="h-4 w-4" />
          </button>
        </div>
        {isMultiQuestion ? (
          <div className="mt-3 flex flex-wrap gap-1.5" data-testid="question-tabs">
            {request.questions.map((q, i) => (
              <button
                key={i}
                onClick={() => {
                  setCurrentTab(i)
                  setEditingCustom(false)
                }}
                className={cn(
                  'inline-flex items-center gap-1 rounded-full border px-2.5 py-1 text-[11px] font-medium transition-colors',
                  i === currentTab
                    ? 'border-sky-300/80 bg-sky-500/10 text-sky-700 shadow-[0_0_0_1px_rgba(125,211,252,0.14)] dark:border-sky-400/40 dark:text-sky-200'
                    : 'border-border/65 bg-background/70 text-muted-foreground hover:border-border hover:bg-background hover:text-foreground'
                )}
              >
                {q.header}
                {answers[i]?.length > 0 && <Check className="h-3 w-3 ml-1 inline text-green-500" />}
              </button>
            ))}
          </div>
        ) : null}
      </div>

      <div className="px-4 py-4">
        {/* Question text */}
        <p className="mb-4 text-[15px] font-medium leading-6 text-foreground/95">
          {currentQuestion.question}
        </p>

        {/* Options */}
        <div className="space-y-2">
          {currentQuestion.options.map((option) => {
            const isSelected = currentAnswers.includes(option.label)
            return (
              <button
                key={option.label}
                onClick={() => handleOptionClick(option.label)}
                disabled={sending}
                className={cn(
                  'w-full rounded-2xl border px-4 py-3 text-left transition-[border-color,background-color,box-shadow,transform] duration-200 disabled:opacity-50',
                  isSelected
                    ? 'border-sky-300/90 bg-sky-500/10 shadow-[0_6px_18px_rgba(56,189,248,0.07)]'
                    : 'border-border/70 bg-background/75 hover:-translate-y-[1px] hover:border-border hover:bg-background hover:shadow-[0_6px_16px_rgba(15,23,42,0.045)]'
                )}
                data-testid={`option-${option.label}`}
              >
                <div className="flex items-center gap-2">
                  {isMultiple && (
                    <div
                      className={cn(
                        'flex h-4 w-4 shrink-0 items-center justify-center rounded-full border transition-colors',
                        isSelected
                          ? 'border-sky-500 bg-sky-500'
                          : 'border-muted-foreground/35 bg-background'
                      )}
                    >
                      {isSelected && <Check className="h-3 w-3 text-white" />}
                    </div>
                  )}
                  <span className="text-sm font-semibold text-foreground">{option.label}</span>
                </div>
                {option.description && (
                  <p
                    className={cn(
                      'mt-1 text-xs leading-5 text-muted-foreground',
                      isMultiple && 'ml-6'
                    )}
                  >
                    {option.description}
                  </p>
                )}
              </button>
            )
          })}

          {/* Custom answer display (when a custom answer has been entered) */}
          {isCustomAllowed && !editingCustom && customAnswer && (
            <button
              onClick={() => {
                setEditingCustom(true)
                handleCustomInputChange(customAnswer)
              }}
              disabled={sending}
              className="w-full rounded-2xl border border-sky-300/80 bg-sky-500/10 px-4 py-3 text-left transition-colors disabled:opacity-50"
              data-testid="custom-answer-display"
            >
              <div className="flex items-center gap-2 min-w-0">
                <Pencil className="h-3.5 w-3.5 shrink-0 text-sky-500" />
                <span className="line-clamp-3 whitespace-pre-wrap text-sm font-medium text-foreground">
                  {customAnswer}
                </span>
              </div>
            </button>
          )}

          {/* Custom text option (when no custom answer yet) */}
          {isCustomAllowed && !editingCustom && !customAnswer && (
            <button
              onClick={() => setEditingCustom(true)}
              disabled={sending}
              className="w-full rounded-2xl border border-dashed border-border/75 bg-background/55 px-4 py-3 text-left transition-colors hover:border-border hover:bg-background/80 disabled:opacity-50"
              data-testid="custom-option"
            >
              <div className="flex items-center gap-2 text-muted-foreground">
                <Pencil className="h-3.5 w-3.5 shrink-0" />
                <span className="text-sm">{t('questionPrompt.custom.typeOwn')}</span>
              </div>
            </button>
          )}

          {/* Custom text input form */}
          {editingCustom && (
            <form
              onSubmit={handleCustomSubmit}
              className="flex flex-col gap-2 rounded-2xl border border-border/65 bg-background/75 p-3 sm:flex-row"
              data-testid="custom-input-form"
            >
              <textarea
                ref={textareaRef}
                autoFocus
                value={customInputs[currentTab] || ''}
                onChange={(e) => handleCustomInputChange(e.target.value)}
                onCompositionStart={() => {
                  isImeComposingRef.current = true
                }}
                onCompositionEnd={() => {
                  isImeComposingRef.current = false
                }}
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
                    handleCustomSubmit(e)
                  }
                }}
                className="min-h-[44px] max-h-[200px] flex-1 resize-none rounded-xl border border-border/70 bg-background px-3 py-2 text-sm transition-colors focus:border-sky-400/70 focus:outline-none"
                placeholder={t('questionPrompt.custom.placeholder')}
                rows={1}
                disabled={sending}
              />
              <Button
                size="sm"
                type="submit"
                disabled={!customInputs[currentTab]?.trim() || sending}
              >
                {t('questionPrompt.actions.submit')}
              </Button>
              <Button
                size="sm"
                variant="ghost"
                type="button"
                onClick={() => setEditingCustom(false)}
                disabled={sending}
              >
                {t('questionPrompt.actions.cancel')}
              </Button>
            </form>
          )}
        </div>

        {/* Action buttons */}
        <div className="mt-4 flex items-center gap-2 border-t border-border/60 pt-3">
          {/* Single-question submit */}
          {!isMultiQuestion && (
            <Button
              size="sm"
              onClick={() => handleSubmit()}
              disabled={!hasCurrentAnswer || sending}
              className="rounded-full px-4"
            >
              {sending ? t('questionPrompt.actions.sending') : t('questionPrompt.actions.submit')}
            </Button>
          )}

          {/* Multi-question navigation */}
          {isMultiQuestion && (
            <>
              {currentTab > 0 && (
                <Button
                  size="sm"
                  variant="ghost"
                  onClick={() => {
                    setCurrentTab((t) => t - 1)
                    setEditingCustom(false)
                  }}
                  disabled={sending}
                  className="rounded-full px-4"
                >
                  {t('questionPrompt.actions.back')}
                </Button>
              )}
              <Button
                size="sm"
                onClick={handleNext}
                disabled={
                  (isLastTab && !allAnswered) || (!isLastTab && !hasCurrentAnswer) || sending
                }
                className="rounded-full px-4"
              >
                {sending ? (
                  t('questionPrompt.actions.sending')
                ) : isLastTab ? (
                  t('questionPrompt.actions.submitAll')
                ) : (
                  <>
                    {t('questionPrompt.actions.next')}
                    <ChevronRight className="h-3.5 w-3.5" />
                  </>
                )}
              </Button>
            </>
          )}

          {/* Dismiss button */}
          <Button
            size="sm"
            variant="ghost"
            onClick={handleDismiss}
            disabled={sending}
            className="rounded-full px-4 text-muted-foreground"
          >
            {t('questionPrompt.actions.dismiss')}
          </Button>
        </div>
      </div>
    </div>
  )
}
