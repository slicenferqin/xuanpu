import { execFile } from 'node:child_process'
import { access, readdir, readFile, stat } from 'node:fs/promises'
import { constants } from 'node:fs'
import { join, resolve } from 'node:path'
import { promisify } from 'node:util'

const execFileAsync = promisify(execFile)

export interface XuanpuAgentCliRuleFile {
  kind: 'agents' | 'claude' | 'codex' | 'copilot' | 'cursor'
  path: string
  relativePath: string
  content: string
  bytes: number
  truncated: boolean
}

export interface XuanpuAgentCliGitStatus {
  available: boolean
  branch: string | null
  porcelain: string
  error?: string
}

export interface XuanpuAgentCliProjectStore {
  sqlitePath: string
  exists: boolean
}

export interface XuanpuAgentCliFieldContext {
  cwd: string
  projectRoot: string
  rules: XuanpuAgentCliRuleFile[]
  git: XuanpuAgentCliGitStatus
  store: XuanpuAgentCliProjectStore
  markdown: string
}

export interface CollectCliFieldContextOptions {
  cwd?: string
  maxRuleBytes?: number
  sqlitePath?: string
}

interface RuleCandidate {
  kind: XuanpuAgentCliRuleFile['kind']
  relativePath: string
}

const STATIC_RULE_CANDIDATES: RuleCandidate[] = [
  { kind: 'agents', relativePath: 'AGENTS.md' },
  { kind: 'claude', relativePath: 'CLAUDE.md' },
  { kind: 'codex', relativePath: 'CODEX.md' },
  { kind: 'codex', relativePath: '.codex/instructions.md' },
  { kind: 'copilot', relativePath: 'COPILOT.md' },
  { kind: 'copilot', relativePath: '.github/copilot-instructions.md' },
  { kind: 'cursor', relativePath: '.cursorrules' }
]

export async function collectCliFieldContext(
  options: CollectCliFieldContextOptions = {}
): Promise<XuanpuAgentCliFieldContext> {
  const cwd = resolve(options.cwd ?? process.cwd())
  const projectRoot = await resolveProjectRoot(cwd)
  const rules = await readRuleFiles(projectRoot, options.maxRuleBytes ?? 24_000)
  const git = await readGitStatus(projectRoot)
  const sqlitePath = options.sqlitePath ?? join(projectRoot, '.xuanpu', 'agent.sqlite')
  const store = {
    sqlitePath,
    exists: await pathExists(sqlitePath)
  }

  return {
    cwd,
    projectRoot,
    rules,
    git,
    store,
    markdown: formatCliFieldContext({ cwd, projectRoot, rules, git, store })
  }
}

export async function resolveProjectRoot(cwd: string): Promise<string> {
  try {
    const { stdout } = await execFileAsync('git', ['rev-parse', '--show-toplevel'], {
      cwd,
      encoding: 'utf8'
    })
    const root = stdout.trim()
    return root ? resolve(root) : cwd
  } catch {
    return cwd
  }
}

async function readRuleFiles(
  projectRoot: string,
  maxRuleBytes: number
): Promise<XuanpuAgentCliRuleFile[]> {
  const cursorRules = await listCursorRuleCandidates(projectRoot)
  const candidates = [...STATIC_RULE_CANDIDATES, ...cursorRules]
  const rules: XuanpuAgentCliRuleFile[] = []

  for (const candidate of candidates) {
    const path = join(projectRoot, candidate.relativePath)
    const file = await readBoundedTextFile(path, maxRuleBytes)
    if (!file) continue
    rules.push({
      kind: candidate.kind,
      path,
      relativePath: candidate.relativePath,
      content: file.content,
      bytes: file.bytes,
      truncated: file.truncated
    })
  }

  return rules
}

async function listCursorRuleCandidates(projectRoot: string): Promise<RuleCandidate[]> {
  const rulesDir = join(projectRoot, '.cursor', 'rules')
  try {
    const entries = await readdir(rulesDir, { withFileTypes: true })
    return entries
      .filter(
        (entry) => entry.isFile() && (entry.name.endsWith('.md') || entry.name.endsWith('.mdc'))
      )
      .map((entry) => ({
        kind: 'cursor' as const,
        relativePath: join('.cursor', 'rules', entry.name)
      }))
      .sort((a, b) => a.relativePath.localeCompare(b.relativePath))
  } catch {
    return []
  }
}

async function readBoundedTextFile(
  path: string,
  maxBytes: number
): Promise<{ content: string; bytes: number; truncated: boolean } | null> {
  try {
    const info = await stat(path)
    if (!info.isFile()) return null
    const raw = await readFile(path)
    const truncated = raw.byteLength > maxBytes
    const content = raw.subarray(0, maxBytes).toString('utf8')
    return { content, bytes: raw.byteLength, truncated }
  } catch {
    return null
  }
}

async function readGitStatus(projectRoot: string): Promise<XuanpuAgentCliGitStatus> {
  try {
    const { stdout } = await execFileAsync('git', ['status', '--short', '--branch'], {
      cwd: projectRoot,
      encoding: 'utf8'
    })
    const lines = stdout.trimEnd().split('\n').filter(Boolean)
    const branchLine = lines[0]?.startsWith('## ') ? lines[0].slice(3) : null
    return {
      available: true,
      branch: branchLine,
      porcelain: stdout.trimEnd()
    }
  } catch (error) {
    return {
      available: false,
      branch: null,
      porcelain: '',
      error: error instanceof Error ? error.message : String(error)
    }
  }
}

function formatCliFieldContext(input: {
  cwd: string
  projectRoot: string
  rules: XuanpuAgentCliRuleFile[]
  git: XuanpuAgentCliGitStatus
  store: XuanpuAgentCliProjectStore
}): string {
  const lines = [
    '# Xuanpu Agent CLI Field Context',
    '',
    `- cwd: ${input.cwd}`,
    `- projectRoot: ${input.projectRoot}`,
    `- sqlite: ${input.store.sqlitePath}${input.store.exists ? ' (exists)' : ' (planned)'}`,
    `- git: ${input.git.available ? (input.git.branch ?? 'available') : 'unavailable'}`,
    ''
  ]

  if (input.git.porcelain) {
    lines.push('## Git Status', '', '```text', input.git.porcelain, '```', '')
  }

  if (input.rules.length > 0) {
    lines.push('## Project Rules')
    for (const rule of input.rules) {
      lines.push(
        '',
        `### ${rule.relativePath}`,
        '',
        rule.truncated
          ? `<!-- truncated at ${rule.content.length} chars from ${rule.bytes} bytes -->`
          : '',
        rule.content.trim()
      )
    }
  }

  return lines.filter((line) => line !== '').join('\n')
}

async function pathExists(path: string): Promise<boolean> {
  try {
    await access(path, constants.F_OK)
    return true
  } catch {
    return false
  }
}
