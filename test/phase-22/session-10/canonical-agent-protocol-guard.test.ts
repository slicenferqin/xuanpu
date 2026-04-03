import fs from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'

const repoRoot = path.resolve(__dirname, '..', '..', '..')

const scanRoots = [
  path.join(repoRoot, 'src', 'main'),
  path.join(repoRoot, 'src', 'preload'),
  path.join(repoRoot, 'src', 'server'),
  path.join(repoRoot, 'src', 'shared'),
  path.join(repoRoot, 'src', 'renderer', 'src', 'hooks'),
  path.join(repoRoot, 'src', 'renderer', 'src', 'stores')
]

const allowedLegacyMatches = new Map<string, RegExp[]>([
  [
    path.join(repoRoot, 'src', 'renderer', 'src', 'stores', 'useSettingsStore.ts'),
    [/\bdefaultAgentSdk\b/]
  ]
])

function collectFiles(dirPath: string): string[] {
  const entries = fs.readdirSync(dirPath, { withFileTypes: true })
  return entries.flatMap((entry) => {
    const fullPath = path.join(dirPath, entry.name)
    if (entry.isDirectory()) return collectFiles(fullPath)
    if (!/\.(ts|tsx|graphql)$/.test(entry.name)) return []
    return [fullPath]
  })
}

function readMatches(filePath: string, pattern: RegExp): string[] {
  const source = fs.readFileSync(filePath, 'utf8')
  const matches = source.match(pattern) ?? []
  const allowedPatterns = allowedLegacyMatches.get(filePath) ?? []

  return matches.filter((match) => !allowedPatterns.some((allowed) => allowed.test(match)))
}

describe('canonical agent protocol guardrails', () => {
  const files = scanRoots.flatMap(collectFiles)

  it('formal protocol boundaries do not reintroduce legacy opencode or AgentSdk naming', () => {
    const forbiddenPatterns: Array<{ label: string; pattern: RegExp }> = [
      { label: 'window.opencodeOps', pattern: /\bwindow\.opencodeOps\b/g },
      { label: 'legacy opencode IPC channels', pattern: /['"`]opencode:[^'"`\n]+['"`]/g },
      { label: 'legacy defaultAgentSdk field', pattern: /\bdefaultAgentSdk\b/g },
      { label: 'legacy detectAgentSdks helper', pattern: /\bdetectAgentSdks\b/g },
      { label: 'legacy AgentSdkDetection type', pattern: /\bAgentSdkDetection\b/g },
      { label: 'deleted shared/types/opencode import', pattern: /shared\/types\/opencode/g },
      { label: 'runtime-dispatch should not regress to sdk-dispatch naming', pattern: /sdk-dispatch/g }
    ]

    const violations = files.flatMap((filePath) =>
      forbiddenPatterns.flatMap(({ label, pattern }) =>
        readMatches(filePath, pattern).map((match) => ({
          filePath: path.relative(repoRoot, filePath),
          label,
          match
        }))
      )
    )

    expect(violations).toEqual([])
  })

  it('graphql schema no longer exposes opencode-prefixed fields or OpenCode type names', () => {
    const schemaFiles = collectFiles(path.join(repoRoot, 'src', 'server', 'schema'))
    const violations = schemaFiles.flatMap((filePath) => {
      const source = fs.readFileSync(filePath, 'utf8')
      return [
        ...Array.from(source.matchAll(/\bopencode[A-Z][A-Za-z0-9_]*/g)).map((match) => ({
          filePath: path.relative(repoRoot, filePath),
          match: match[0]
        })),
        ...Array.from(source.matchAll(/\bOpenCode[A-Za-z0-9_]*/g)).map((match) => ({
          filePath: path.relative(repoRoot, filePath),
          match: match[0]
        }))
      ]
    })

    expect(violations).toEqual([])
  })
})
