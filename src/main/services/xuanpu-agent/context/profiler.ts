/**
 * CommandProfiler implementation — M2 MVP.
 *
 * Identifies the command category from the shell command string using
 * prefix/regex matching. No I/O, no side effects (<1ms).
 *
 * Covers the top-10 highest-frequency commands:
 *   git (status/log/diff), vitest, tsc, eslint, pnpm (test),
 *   rg, cat, ls
 *
 * The "proxy" category is for commands that should pass through
 * uncompressed (tracking only). "unknown" triggers head/tail truncation.
 */
import type { CommandCategory, CommandProfile, CommandProfiler } from './compressor'

// ───────────────────────────────────────────────────────────────────────────
// Category profiles
// ───────────────────────────────────────────────────────────────────────────

const PROFILES: Record<CommandCategory, CommandProfile | undefined> = {
  git: {
    name: 'git',
    category: 'git',
    description: 'Git commands — extract structured summary',
    targetCompressionRatio: 0.7,
    enabled: true
  },
  test: {
    name: 'test',
    category: 'test',
    description: 'Test runners — keep failures, summarize passes',
    targetCompressionRatio: 0.85,
    enabled: true
  },
  lint: {
    name: 'lint',
    category: 'lint',
    description: 'Linters/type-checkers — keep errors, drop success noise',
    targetCompressionRatio: 0.85,
    enabled: true
  },
  build: {
    name: 'build',
    category: 'build',
    description: 'Build tools — keep errors/warnings only',
    targetCompressionRatio: 0.8,
    enabled: true
  },
  file: {
    name: 'file',
    category: 'file',
    description: 'File operations — head/tail truncation',
    targetCompressionRatio: 0.5,
    enabled: true
  },
  search: {
    name: 'search',
    category: 'search',
    description: 'Search tools — dedup, group-by-file, cap results',
    targetCompressionRatio: 0.6,
    enabled: true
  },
  package: {
    name: 'package',
    category: 'package',
    description: 'Package managers — extract install/update summary, drop progress bars',
    targetCompressionRatio: 0.75,
    enabled: true
  },
  container: {
    name: 'container',
    category: 'container',
    description: 'Container tools — keep status/errors, drop pull progress',
    targetCompressionRatio: 0.8,
    enabled: true
  },
  aws: {
    name: 'aws',
    category: 'aws',
    description: 'AWS CLI — deferred to M3 (profile only)',
    targetCompressionRatio: 0.5,
    enabled: false
  },
  db: {
    name: 'db',
    category: 'db',
    description: 'Database tools — keep errors, summarize migrations/generation',
    targetCompressionRatio: 0.7,
    enabled: true
  },
  curl: {
    name: 'curl',
    category: 'curl',
    description: 'HTTP clients — keep status/headers, truncate bodies',
    targetCompressionRatio: 0.6,
    enabled: true
  },
  proxy: {
    name: 'proxy',
    category: 'proxy',
    description: 'Pass-through, no compression (tracking only)',
    targetCompressionRatio: 0,
    enabled: true
  },
  unknown: {
    name: 'unknown',
    category: 'unknown',
    description: 'Fallback — head/tail truncation',
    targetCompressionRatio: 0.5,
    enabled: true
  }
}

// ───────────────────────────────────────────────────────────────────────────
// Command matching
// ───────────────────────────────────────────────────────────────────────────

interface Matcher {
  /** Primary executable names that match this category. */
  bins: string[]
  /** Optional first-argument patterns that refine the match within a bin. */
  subPatterns?: RegExp[]
  category: CommandCategory
}

/** Ordered list of matchers — first match wins. */
const MATCHERS: Matcher[] = [
  // Test runners first (more specific than general bins)
  { bins: ['vitest'], category: 'test' },
  { bins: ['jest'], category: 'test' },
  { bins: ['pytest'], category: 'test' },
  {
    bins: ['pnpm'],
    subPatterns: [/^vitest\s+run\b/, /^exec\s+vitest\s+run\b/, /^test\b/, /^run\s+test(?::|$|\s)/],
    category: 'test'
  },
  { bins: ['npm', 'yarn'], subPatterns: [/^test\b/, /^run\s+test(?::|$|\s)/], category: 'test' },
  { bins: ['go'], subPatterns: [/^test\b/], category: 'test' },
  { bins: ['cargo'], subPatterns: [/^test\b/], category: 'test' },

  // Linters / type-checkers
  { bins: ['tsc'], category: 'lint' },
  { bins: ['eslint'], category: 'lint' },
  { bins: ['ruff'], category: 'lint' },
  { bins: ['clippy'], category: 'lint' },
  { bins: ['biome'], category: 'lint' },
  { bins: ['prettier'], category: 'lint' },

  // Build
  { bins: ['cargo'], subPatterns: [/^build\b/], category: 'build' },
  { bins: ['next'], subPatterns: [/^build\b/], category: 'build' },
  { bins: ['webpack'], category: 'build' },
  { bins: ['vite'], subPatterns: [/^build\b/], category: 'build' },

  // Git
  { bins: ['git'], category: 'git' },

  // Package managers — broader coverage
  { bins: ['pnpm', 'npm', 'yarn', 'pip', 'pip3', 'cargo', 'bun'], category: 'package' },

  // Search — add ag (silver searcher)
  { bins: ['rg', 'grep', 'egrep', 'find', 'fd', 'ag'], category: 'search' },

  // File ops — add more
  { bins: ['cat', 'ls', 'head', 'tail', 'read', 'wc', 'sort', 'uniq', 'cut'], category: 'file' },

  // Container — add docker-compose, kubectl variants, podman
  {
    bins: ['docker', 'docker-compose', 'kubectl', 'kubectl.exe', 'podman', 'helm'],
    category: 'container'
  },

  // AWS — add aws, sam, cdk
  { bins: ['aws', 'sam', 'cdk'], category: 'aws' },

  // DB — add drizzle-kit, prisma variants, pg, mongosh
  {
    bins: [
      'prisma',
      'drizzle-kit',
      'drizzle',
      'sqlite3',
      'psql',
      'mysql',
      'pg',
      'mongosh',
      'redis-cli'
    ],
    category: 'db'
  },

  // HTTP — add httpie
  { bins: ['curl', 'wget', 'http', 'httpx'], category: 'curl' },

  // Additional test runners
  { bins: ['mocha', 'ava', 'playwright'], subPatterns: [/^test\b/], category: 'test' },

  // Additional linters
  { bins: ['stylelint', 'markdownlint', 'hadolint', 'shellcheck'], category: 'lint' },

  // Additional build tools
  { bins: ['make', 'ninja', 'bazel', 'cmake'], category: 'build' },
  { bins: ['gradle', 'mvn'], category: 'build' },

  // Go tools
  { bins: ['go'], subPatterns: [/^(build|vet|mod)\b/], category: 'build' },
  { bins: ['go'], subPatterns: [/^(fmt)\b/], category: 'lint' }
]

// ───────────────────────────────────────────────────────────────────────────
// Implementation
// ───────────────────────────────────────────────────────────────────────────

export function createCommandProfiler(): CommandProfiler {
  return {
    identify(command: string, _cwd: string): CommandCategory {
      const trimmed = command.trim()

      // Extract the executable name (first word after any path prefix)
      let execName = trimmed.split(/\s+/)[0] ?? ''
      // Strip path prefix: /usr/bin/git → git
      const slashIdx = execName.lastIndexOf('/')
      if (slashIdx >= 0) execName = execName.slice(slashIdx + 1)
      // Strip Windows backslash: C:\Program Files\Git\bin\git.exe → git.exe
      const bsIdx = execName.lastIndexOf('\\')
      if (bsIdx >= 0) execName = execName.slice(bsIdx + 1)
      // Strip .exe suffix
      if (execName.endsWith('.exe')) execName = execName.slice(0, -4)

      // Extract the rest after the executable for sub-pattern matching
      const rest = trimmed.slice(trimmed.indexOf(execName) + execName.length).trim()

      for (const matcher of MATCHERS) {
        if (!matcher.bins.includes(execName)) continue

        // If sub-patterns are specified, at least one must match
        if (matcher.subPatterns && matcher.subPatterns.length > 0) {
          if (!matcher.subPatterns.some((pattern) => pattern.test(rest))) {
            continue
          }
        }

        return matcher.category
      }

      return 'unknown'
    },

    getProfile(category: CommandCategory): CommandProfile | null {
      return PROFILES[category] ?? null
    }
  }
}
