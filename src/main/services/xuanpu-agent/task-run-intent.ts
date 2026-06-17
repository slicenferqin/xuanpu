import type { TaskRunAutonomy } from '../../../shared/types/agent-task-run'

export type TaskRunIntentSignal =
  | 'explicit-autonomy'
  | 'documentation-package'
  | 'multiple-artifacts'
  | 'incremental-checkpoint'
  | 'source-grounded-writing'
  | 'manifest-tracking'
  | 'readme-index'
  | 'partial-state'
  | 'complete-all'
  | 'path-citations'
  | 'code-review'
  | 'diagnostic-report'
  | 'opportunistic-fix'

export interface TaskRunIntentAnalysis {
  autonomy: TaskRunAutonomy | null
  confidence: 'explicit' | 'strong' | 'weak' | 'none'
  score: number
  signals: TaskRunIntentSignal[]
  reason: string | null
}

const LONG_TASK_THRESHOLD = 5

export function inferTaskRunAutonomyFromPromptText(text: string): TaskRunAutonomy | null {
  return analyzeTaskRunIntent(text).autonomy
}

export function analyzeTaskRunIntent(text: string): TaskRunIntentAnalysis {
  const normalized = normalizePromptText(text)
  if (!normalized) {
    return {
      autonomy: null,
      confidence: 'none',
      score: 0,
      signals: [],
      reason: null
    }
  }

  const explicitAutonomy = readExplicitAutonomy(normalized)
  if (explicitAutonomy) {
    return {
      autonomy: explicitAutonomy,
      confidence: 'explicit',
      score: Number.POSITIVE_INFINITY,
      signals: ['explicit-autonomy'],
      reason: `explicit ${explicitAutonomy} task-run request`
    }
  }

  const scored = scoreLongTaskSignals(normalized)
  if (scored.score >= LONG_TASK_THRESHOLD) {
    return {
      autonomy: 'long',
      confidence: 'strong',
      score: scored.score,
      signals: scored.signals,
      reason: `multi-artifact task signals: ${scored.signals.join(', ')}`
    }
  }

  return {
    autonomy: null,
    confidence: scored.score > 0 ? 'weak' : 'none',
    score: scored.score,
    signals: scored.signals,
    reason: scored.signals.length > 0 ? `weak task signals: ${scored.signals.join(', ')}` : null
  }
}

function scoreLongTaskSignals(text: string): { score: number; signals: TaskRunIntentSignal[] } {
  const signals: TaskRunIntentSignal[] = []
  let score = 0

  const add = (signal: TaskRunIntentSignal, weight: number): void => {
    if (signals.includes(signal)) return
    signals.push(signal)
    score += weight
  }

  if (containsAny(text, ['文档包', 'documentation package', 'docs package'])) {
    add('documentation-package', 3)
  }

  if (
    containsAny(text, ['一套', '全套', '多份', '多篇', '多个']) &&
    containsAny(text, ['文档', 'markdown', 'docs', 'documents'])
  ) {
    add('multiple-artifacts', 2)
  }

  if (hasNumberedDocumentCount(text) || containsAny(text, ['每份文档', '每篇文档', '每个文档'])) {
    add('multiple-artifacts', 2)
  }

  if (containsAny(text, ['写完每份', '写完每篇', '写完每个', '每份后', '每篇后', '每个后'])) {
    add('incremental-checkpoint', 1.5)
  }

  if (
    containsAny(text, ['先读取', '先读', '先看', 'read first']) &&
    containsAny(text, ['源码', '代码', '测试文件', 'test file', 'source']) &&
    containsAny(text, ['再写', 'then write'])
  ) {
    add('source-grounded-writing', 1.5)
  }

  if (text.includes('manifest.json')) add('manifest-tracking', 2)
  if (text.includes('readme.md')) add('readme-index', 1)
  if (containsAny(text, ['partial', '未完成', '没写完', '还没写完'])) add('partial-state', 1)
  if (containsAny(text, ['完成全部', '全部完成', 'finish all', 'complete all']))
    add('complete-all', 1)
  if (containsAny(text, ['引用实际文件路径', '实际文件路径', 'file path citations'])) {
    add('path-citations', 1)
  }

  if (
    containsAny(text, [
      'code review',
      'review recent commit',
      'review recent commits',
      'review the diff',
      'cr一下',
      'cr 一下',
      '代码审查',
      '代码评审',
      '审查代码',
      '看下最近的提交',
      '最近的提交代码',
      '最近提交代码'
    ])
  ) {
    add('code-review', 2)
  }

  if (
    containsAny(text, [
      '诊断报告',
      '诊断文档',
      '审查报告',
      'review report',
      'diagnostic report',
      '出一份报告',
      '输出报告'
    ])
  ) {
    add('diagnostic-report', 2)
  }

  if (
    containsAny(text, [
      '随手修',
      '修掉',
      '修复掉',
      '不需要我确认',
      '无需确认',
      'without asking',
      'fix it',
      'fix them'
    ])
  ) {
    add('opportunistic-fix', 1.5)
  }

  return { score, signals }
}

function readExplicitAutonomy(text: string): TaskRunAutonomy | null {
  const commandText = stripLeadingCommandMarker(text)
  const direct = readAutonomyAtStart(commandText)
  if (direct) return direct

  const chineseDirective = readChineseAutonomyDirective(commandText)
  if (chineseDirective) return chineseDirective

  for (const starter of ['请按 ', '按 ', '以 ', '用 ', '使用 ', 'please use ']) {
    if (!commandText.startsWith(starter)) continue
    const value = readAutonomyAtStart(commandText.slice(starter.length).trimStart())
    if (value) return value
    const chineseValue = readChineseAutonomyDirective(commandText.slice(starter.length).trimStart())
    if (chineseValue) return chineseValue
  }

  return null
}

function readAutonomyAtStart(text: string): TaskRunAutonomy | null {
  for (const autonomy of ['short', 'long', 'overnight'] as const) {
    if (startsWithWord(text, autonomy)) return autonomy
  }
  return null
}

function startsWithWord(text: string, word: string): boolean {
  if (!text.startsWith(word)) return false
  const next = text.at(word.length)
  return !next || next === ' ' || next === '-' || next === '_' || next === '/'
}

function readChineseAutonomyDirective(text: string): TaskRunAutonomy | null {
  const compact = text.replace(/\s+/g, '')

  if (
    /^(?:请)?(?:按|用|使用|以)?短任务(?:执行|模式|跑|推进|处理|继续)?/.test(compact) ||
    /(?:按|用|使用|以|切到|改成|作为)短任务/.test(compact)
  ) {
    return 'short'
  }

  if (
    /^(?:请)?(?:按|用|使用|以)?(?:隔夜|过夜|overnight)任务(?:执行|模式|跑|推进|处理|继续)?/.test(
      compact
    ) ||
    /(?:按|用|使用|以|切到|改成|作为)(?:隔夜|过夜)任务/.test(compact)
  ) {
    return 'overnight'
  }

  if (
    /^(?:请)?(?:按|用|使用|以)?长任务(?:执行|模式|跑|推进|处理|继续)?/.test(compact) ||
    /(?:按|用|使用|以|切到|改成|作为)长任务/.test(compact) ||
    /继续.*长任务(?:执行|模式|跑|推进|处理)?/.test(compact)
  ) {
    return 'long'
  }

  return null
}

function stripLeadingCommandMarker(text: string): string {
  const trimmed = text.trimStart()
  const first = trimmed.at(0)
  return first === '/' || first === '#' ? trimmed.slice(1).trimStart() : trimmed
}

function containsAny(text: string, values: string[]): boolean {
  return values.some((value) => text.includes(value))
}

function hasNumberedDocumentCount(text: string): boolean {
  return (
    hasDigitBeforeAny(text, ['份文档', '篇文档', '个文档', '份 markdown', '篇 markdown']) ||
    hasChineseNumberBeforeAny(text, ['份文档', '篇文档', '个文档'])
  )
}

function hasDigitBeforeAny(text: string, units: string[]): boolean {
  return units.some((unit) => hasCharFromBefore(text, unit, '0123456789'))
}

function hasChineseNumberBeforeAny(text: string, units: string[]): boolean {
  return units.some((unit) => hasCharFromBefore(text, unit, '一二三四五六七八九十百两'))
}

function hasCharFromBefore(text: string, unit: string, chars: string): boolean {
  const unitIndex = text.indexOf(unit)
  if (unitIndex <= 0) return false

  const windowStart = Math.max(0, unitIndex - 6)
  for (const char of text.slice(windowStart, unitIndex)) {
    if (chars.includes(char)) return true
  }
  return false
}

function normalizePromptText(text: string): string {
  let normalized = ''
  let lastWasWhitespace = false

  for (const char of text.toLowerCase().trim()) {
    if (isWhitespace(char)) {
      if (!lastWasWhitespace) normalized += ' '
      lastWasWhitespace = true
      continue
    }

    normalized += char
    lastWasWhitespace = false
  }

  return normalized.trim()
}

function isWhitespace(char: string): boolean {
  return char === ' ' || char === '\n' || char === '\t' || char === '\r'
}
