import * as fs from 'node:fs'
import * as path from 'node:path'

export interface PostResponseClaimVerifierInput {
  text: string
  worktreePath: string
  observedPaths?: Iterable<string>
  maxClaims?: number
}

export interface VerifiedResponseClaim {
  value: string
  kind: 'file-path'
  verified: boolean
  evidence: 'exists-in-worktree' | 'observed-tool-context' | null
}

export interface PostResponseClaimVerification {
  passed: boolean
  claims: VerifiedResponseClaim[]
  unverifiedClaims: VerifiedResponseClaim[]
  correctionText: string | null
}

const PATH_LIKE_PATTERN =
  /(?:^|[\s([`'"])((?:\.{1,2}\/)?(?:[A-Za-z0-9_@.-]+\/)+[A-Za-z0-9_@./-]+\.(?:ts|tsx|js|jsx|mjs|cjs|json|md|mdx|css|scss|sql|yaml|yml|toml|rs|go|py|java|kt|swift|html|sh|c|h|cpp|hpp|lock))(?:$|[\s)\]`'",:;.])/g

const MAX_PATH_CLAIMS = 20

export function verifyPostResponseClaims(
  input: PostResponseClaimVerifierInput
): PostResponseClaimVerification {
  const observedPaths = normalizeObservedPaths(input.observedPaths ?? [])
  const claims = extractFilePathClaims(input.text)
    .slice(0, Math.max(1, Math.min(input.maxClaims ?? MAX_PATH_CLAIMS, MAX_PATH_CLAIMS)))
    .map((value): VerifiedResponseClaim => {
      const normalized = normalizeClaimPath(value)
      if (observedPaths.has(normalized)) {
        return { value, kind: 'file-path', verified: true, evidence: 'observed-tool-context' }
      }
      if (pathExistsInWorktree(input.worktreePath, normalized)) {
        return { value, kind: 'file-path', verified: true, evidence: 'exists-in-worktree' }
      }
      return { value, kind: 'file-path', verified: false, evidence: null }
    })

  const unverifiedClaims = claims.filter((claim) => !claim.verified)
  return {
    passed: unverifiedClaims.length === 0,
    claims,
    unverifiedClaims,
    correctionText:
      unverifiedClaims.length > 0
        ? buildCorrectionText(unverifiedClaims.map((claim) => claim.value))
        : null
  }
}

export function extractFilePathClaims(text: string): string[] {
  const claims: string[] = []
  for (const match of text.matchAll(PATH_LIKE_PATTERN)) {
    const candidate = stripTrailingPunctuation(match[1] ?? '')
    if (!candidate || candidate.includes('://')) continue
    if (candidate.startsWith('/')) continue
    if (candidate.includes('node_modules/')) continue
    claims.push(candidate)
  }
  return Array.from(new Set(claims))
}

function normalizeObservedPaths(paths: Iterable<string>): Set<string> {
  return new Set([...paths].map(normalizeClaimPath).filter(Boolean))
}

function normalizeClaimPath(value: string): string {
  return stripTrailingPunctuation(value).replace(/^\.\/+/, '').replace(/\\/g, '/')
}

function stripTrailingPunctuation(value: string): string {
  return value.trim().replace(/[.,;:)\]}]+$/g, '')
}

function pathExistsInWorktree(worktreePath: string, claimPath: string): boolean {
  try {
    const root = fs.realpathSync(path.resolve(worktreePath))
    const candidate = path.resolve(root, claimPath)
    const relative = path.relative(root, candidate)
    if (!relative || relative.startsWith('..') || path.isAbsolute(relative)) return false
    if (!fs.existsSync(candidate)) return false
    const real = fs.realpathSync(candidate)
    return real === root || real.startsWith(root + path.sep)
  } catch {
    return false
  }
}

function buildCorrectionText(unverifiedPaths: string[]): string {
  return [
    'Post-response claim verifier detected unverified file-path claims.',
    '',
    'The previous assistant answer mentioned paths that were not found in the current worktree and were not observed through tool context:',
    ...unverifiedPaths.map((item) => `- ${item}`),
    '',
    'Treat those path references as unverified until a tool call or file lookup confirms them.'
  ].join('\n')
}
