export const FIRST_CHARS = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ'
export const SECOND_CHARS = 'abcdefghijklmnopqrstuvwxyz23456789'

export interface HintTarget {
  kind: 'worktree' | 'plus'
  worktreeId?: string
  projectId: string
}

/**
 * Build the first-char sequence, optionally starting with a preferred character.
 * E.g. if the user typed "vis", preferredFirstChar='S' → 'SABCDEFGHIJKLMNOPQRTUVWXYZ'
 * so the first hints start with the key the user's finger is already near.
 */
function buildFirstChars(preferredFirstChar?: string): string {
  if (!preferredFirstChar || !FIRST_CHARS.includes(preferredFirstChar)) return FIRST_CHARS
  return preferredFirstChar + FIRST_CHARS.replace(preferredFirstChar, '')
}

export function assignHints(targets: HintTarget[], preferredFirstChar?: string): {
  hintMap: Map<string, string>
  hintTargetMap: Map<string, HintTarget>
} {
  const hintMap = new Map<string, string>()
  const hintTargetMap = new Map<string, HintTarget>()
  const firstChars = buildFirstChars(preferredFirstChar)

  targets.forEach((target, index) => {
    const firstIndex = Math.floor(index / SECOND_CHARS.length)
    const secondIndex = index % SECOND_CHARS.length

    if (firstIndex >= firstChars.length) return // exceeded capacity

    const code = firstChars[firstIndex] + SECOND_CHARS[secondIndex]
    const key = target.kind === 'plus' ? `plus:${target.projectId}` : target.worktreeId!

    hintMap.set(key, code)
    hintTargetMap.set(key, target)
  })

  return { hintMap, hintTargetMap }
}
