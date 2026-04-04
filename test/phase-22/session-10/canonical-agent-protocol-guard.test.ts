import fs from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'

const repoRoot = path.resolve(__dirname, '..', '..', '..')

// Only scan canonical protocol files — the NEW agent protocol layer.
// Legacy files (opencode-handlers, opencode-service, old resolvers, old schema)
// are intentionally excluded and will be removed in a future cleanup phase.
const scanRoots = [
  path.join(repoRoot, 'src', 'main', 'ipc', 'agent-handlers.ts'),
  path.join(repoRoot, 'src', 'main', 'services', 'agent-runtime-manager.ts'),
  path.join(repoRoot, 'src', 'main', 'services', 'agent-runtime-types.ts'),
  path.join(repoRoot, 'src', 'preload'),
  path.join(repoRoot, 'src', 'shared', 'types', 'agent-protocol.ts'),
  path.join(repoRoot, 'src', 'renderer', 'src', 'hooks'),
  path.join(repoRoot, 'src', 'renderer', 'src', 'stores'),
  path.join(repoRoot, 'src', 'server', 'resolvers', 'helpers', 'runtime-dispatch.ts'),
  path.join(repoRoot, 'src', 'server', 'resolvers', 'mutation', 'agent.resolvers.ts'),
  path.join(repoRoot, 'src', 'server', 'resolvers', 'query', 'agent.resolvers.ts'),
  path.join(repoRoot, 'src', 'server', 'resolvers', 'subscription', 'agent.resolvers.ts'),
  path.join(repoRoot, 'src', 'server', 'schema', 'types', 'agent.graphql'),
  path.join(repoRoot, 'src', 'server', 'schema', 'types', 'results.graphql')
]

// Files that still reference legacy naming during migration — allowed with specific patterns
const allowedLegacyMatches = new Map<string, RegExp[]>([
  [
    path.join(repoRoot, 'src', 'renderer', 'src', 'stores', 'useSettingsStore.ts'),
    [/\bdefaultAgentSdk\b/]
  ],
  // opencode-service.ts is imported as a fallback path in agent-handlers
  [
    path.join(repoRoot, 'src', 'main', 'ipc', 'agent-handlers.ts'),
    [/opencode-service/]
  ],
  // preload onStream listens on both agent:stream AND legacy opencode:stream for backward compat
  [
    path.join(repoRoot, 'src', 'preload', 'index.ts'),
    [/opencode:stream/]
  ]
])

function collectFiles(pathOrDir: string): string[] {
  if (!fs.existsSync(pathOrDir)) return []
  const stat = fs.statSync(pathOrDir)
  if (stat.isFile()) {
    return /\.(ts|tsx|graphql)$/.test(pathOrDir) ? [pathOrDir] : []
  }
  const entries = fs.readdirSync(pathOrDir, { withFileTypes: true })
  return entries.flatMap((entry) => {
    const fullPath = path.join(pathOrDir, entry.name)
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

  it('canonical protocol files do not reintroduce legacy opencode or AgentSdk naming', () => {
    const forbiddenPatterns: Array<{ label: string; pattern: RegExp }> = [
      { label: 'window.opencodeOps', pattern: /\bwindow\.opencodeOps\b/g },
      { label: 'legacy opencode IPC channels', pattern: /['"`]opencode:[^'"`\n]+['"`]/g },
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

  it('new graphql schema types use agent-prefixed naming, not opencode-prefixed', () => {
    const newSchemaFiles = [
      path.join(repoRoot, 'src', 'server', 'schema', 'types', 'agent.graphql'),
      path.join(repoRoot, 'src', 'server', 'schema', 'types', 'results.graphql')
    ]
    const violations = newSchemaFiles
      .filter((f) => fs.existsSync(f))
      .flatMap((filePath) => {
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
