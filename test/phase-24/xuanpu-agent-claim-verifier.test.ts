import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import {
  extractFilePathClaims,
  verifyPostResponseClaims
} from '../../src/main/services/xuanpu-agent/harness/post-response-claim-verifier'

describe('xuanpu-agent post-response claim verifier', () => {
  it('extracts repo-relative file path claims from assistant text', () => {
    expect(
      extractFilePathClaims(
        'Updated src/main/services/xuanpu-agent/runtime.ts and docs/plans/example.md.'
      )
    ).toEqual(['src/main/services/xuanpu-agent/runtime.ts', 'docs/plans/example.md'])
  })

  it('passes claims that exist in the worktree or were observed through tool context', () => {
    const worktreePath = mkdtempSync(join(tmpdir(), 'xuanpu-agent-claims-'))
    try {
      mkdirSync(join(worktreePath, 'src/main'), { recursive: true })
      writeFileSync(join(worktreePath, 'src/main/existing.ts'), 'export {}\n', 'utf-8')

      const result = verifyPostResponseClaims({
        worktreePath,
        text: [
          'Verified src/main/existing.ts.',
          'Also reviewed src/main/generated.ts from the write tool.'
        ].join('\n'),
        observedPaths: ['src/main/generated.ts']
      })

      expect(result.passed).toBe(true)
      expect(result.claims.map((claim) => claim.evidence)).toEqual([
        'exists-in-worktree',
        'observed-tool-context'
      ])
    } finally {
      rmSync(worktreePath, { recursive: true, force: true })
    }
  })

  it('builds a correction when file path claims are not verifiable', () => {
    const worktreePath = mkdtempSync(join(tmpdir(), 'xuanpu-agent-claims-'))
    try {
      const result = verifyPostResponseClaims({
        worktreePath,
        text: 'The fix is in src/missing/file.ts.'
      })

      expect(result.passed).toBe(false)
      expect(result.unverifiedClaims).toEqual([
        expect.objectContaining({ value: 'src/missing/file.ts', verified: false })
      ])
      expect(result.correctionText).toContain('Post-response claim verifier')
      expect(result.correctionText).toContain('src/missing/file.ts')
    } finally {
      rmSync(worktreePath, { recursive: true, force: true })
    }
  })
})
