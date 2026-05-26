/**
 * Command Compression — M1 interface definitions (M2 implementation).
 *
 * CommandProfiler identifies the type of a shell command so the compressor can
 * apply the right strategy. CommandCompressor compresses raw output into a
 * structured summary suitable for the agent's context window.
 *
 * These are contracts, not implementations. M1 defines them; M2 ships MVP
 * implementations for the top-10 highest-frequency commands.
 *
 * Design constraints:
 *   - <10ms profiling overhead (command identification is regex/prefix-based)
 *   - Compression is failure-isolated — a bad strategy never blocks the agent
 *   - Raw output is always archived (command_traces table) before compression
 *   - Every compression must be observable (Context Budget + Session HQ timeline)
 */
import type { HarnessError } from '../harness/error-taxonomy'

// ───────────────────────────────────────────────────────────────────────────
// Command types
// ───────────────────────────────────────────────────────────────────────────

/**
 * Known command categories. Each category maps to a compression profile.
 *
 * Phase 1 (M2): test, lint, git, build, file, search
 * Phase 2 (M3): package, container, aws, db, curl, proxy (30+ total)
 */
export type CommandCategory =
  | 'test'       // vitest / jest / pytest / cargo test / go test
  | 'lint'       // tsc / eslint / ruff / clippy / biome
  | 'git'        // git status / log / diff / add / commit / push / pull
  | 'build'      // tsc --build / cargo build / next build / webpack
  | 'file'       // cat / ls / head / tail / read
  | 'search'     // rg / grep / find / fd
  | 'package'    // pnpm / npm / yarn / pip / cargo add
  | 'container'  // docker / kubectl
  | 'aws'        // aws cli
  | 'db'         // prisma / drizzle / sql
  | 'curl'       // curl / wget
  | 'proxy'      // pass-through, no compression (tracking only)
  | 'unknown'    // fallback — apply head/tail truncation

// ───────────────────────────────────────────────────────────────────────────
// Compression profile
// ───────────────────────────────────────────────────────────────────────────

/**
 * A compression profile describes how to compress output for a specific
 * command category. M1 defines the shape; M2 ships concrete profiles.
 */
export interface CommandProfile {
  /** Stable identifier, e.g. "vitest" or "tsc". */
  readonly name: string
  /** Which category this profile belongs to. */
  readonly category: CommandCategory
  /** Human-readable description for the Context Budget UI. */
  readonly description: string
  /** Target compression ratio (e.g. 0.85 = 85% reduction). Informational only. */
  readonly targetCompressionRatio: number
  /** Whether this profile is enabled (allows per-command opt-out). */
  readonly enabled: boolean
}

// ───────────────────────────────────────────────────────────────────────────
// Compression result
// ───────────────────────────────────────────────────────────────────────────

/**
 * The result of compressing a command's output. Always includes a pointer to
 * the raw output (rawRef) so the user can expand full output in Session HQ.
 */
export interface CompressionResult {
  /** Compressed text suitable for the agent's context window. */
  readonly text: string
  /** UTF-8 byte length of the original output. */
  readonly beforeBytes: number
  /** UTF-8 byte length of the compressed output. */
  readonly afterBytes: number
  /** Actual compression ratio: 1 - (afterBytes / beforeBytes). */
  readonly compressionRatio: number
  /** Names of strategies that fired (for UI tooltip). */
  readonly ruleHits: readonly string[]
  /** Pointer to the raw output in command_traces table. */
  readonly rawRef: string
  /** Exit code of the original command. */
  readonly exitCode: number
  /** Wall-clock duration of the original command in milliseconds. */
  readonly durationMs: number
  /** Whether the original command timed out. */
  readonly timedOut: boolean
  /** Whether the original command was aborted. */
  readonly aborted: boolean
}

// ───────────────────────────────────────────────────────────────────────────
// Profiler
// ───────────────────────────────────────────────────────────────────────────

/**
 * Identifies the command category from the shell command string + cwd.
 * Pure function — no side effects, no I/O.
 *
 * Implementation (M2): regex/prefix-based matching. The "proxy" category is
 * for commands that should pass through uncompressed (tracking only). The
 * "unknown" category triggers head/tail truncation as a safety net.
 */
export interface CommandProfiler {
  /**
   * Classify a shell command into a category.
   *
   * @param command - The full command string (e.g. "vitest run --reporter=verbose").
   * @param cwd     - The working directory the command ran in.
   * @returns The identified category. Never throws.
   */
  identify(command: string, cwd: string): CommandCategory

  /**
   * Return the compression profile for a given category.
   *
   * @returns The profile, or null if no profile is registered for this category.
   */
  getProfile(category: CommandCategory): CommandProfile | null
}

// ───────────────────────────────────────────────────────────────────────────
// Compressor
// ───────────────────────────────────────────────────────────────────────────

/**
 * Compresses raw command output according to the profile for its category.
 *
 * Implementation (M2): dispatches to per-category compression functions.
 * Each function follows a common pattern:
 *   1. Parse output into a structured representation
 *   2. Apply category-specific filters (failures only, dedup, group-by-file)
 *   3. Format the result as compact text
 *   4. Return CompressionResult with rawRef pointing to the archived original
 *
 * Design invariant: if compression throws, the caller falls back to head/tail
 * truncation and emits COMPRESSION_FAILURE. The agent must never receive a raw
 * 50K test dump because a compression strategy crashed.
 */
export interface CommandCompressor {
  /**
   * Compress raw command output.
   *
   * @param output  - Raw stdout+stderr from the command.
   * @param profile - The compression profile to apply.
   * @param metadata - Context about the execution (command, exitCode, durationMs, cwd).
   * @returns CompressionResult with the compressed text + raw ref.
   *
   * @throws {HarnessError} with code COMPRESSION_FAILURE if compression is
   *   catastrophically broken. The caller must catch and fall back to
   *   head/tail truncation. Never throws for normal output — bad strategies
   *   are skipped internally, not propagated.
   */
  compress(
    output: string,
    profile: CommandProfile,
    metadata: CompressionMetadata
  ): CompressionResult
}

/**
 * Context about the command execution, used by compression strategies.
 */
export interface CompressionMetadata {
  /** The original command string. */
  readonly command: string
  /** Exit code; non-zero biases towards FailureFocus strategies. */
  readonly exitCode: number
  /** Wall-clock duration in milliseconds. */
  readonly durationMs: number
  /** Working directory the command ran in. */
  readonly cwd: string
  /** Whether the command timed out. */
  readonly timedOut: boolean
  /** Whether the command was aborted. */
  readonly aborted: boolean
}

// ───────────────────────────────────────────────────────────────────────────
// Error handling
// ───────────────────────────────────────────────────────────────────────────

/**
 * Wraps a compression failure into a HarnessError. Used when a compression
 * strategy crashes and the caller needs to fall back to head/tail truncation.
 */
export function compressionFailed(
  originalError: unknown,
  category: CommandCategory,
  traceId: string
): HarnessError {
  const message =
    originalError instanceof Error ? originalError.message : String(originalError)
  // Dynamic import to avoid circular dependency between harness modules
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const { createHarnessError, HarnessErrorCode } = require('../harness/error-taxonomy')
  return createHarnessError(HarnessErrorCode.COMPRESSION_FAILURE, `compression failed for ${category}: ${message}`, {
    traceId,
    context: { category, cause: message }
  })
}
