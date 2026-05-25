/**
 * XFP v1 — example fixtures.
 *
 * Two scenarios:
 *   - `fullXfpPacketExample()`   — Xuanpu desktop context with worktree,
 *                                  terminal output, git state, test results.
 *   - `minimalXfpPacketExample()` — CLI-mode standalone invocation, no
 *                                  worktree, only cwd + stdin + goal.
 *
 * Both are used as:
 *   - unit-test anchors (compile-time + Zod runtime validation)
 *   - documentation samples in docs/architecture/xfp-packet-v1.md
 *   - golden inputs for the packet compiler implementation (M1).
 */

import type { MinimalFieldPacket, XfpFieldPacket } from './types'

/**
 * Full XFP packet — typical Session HQ turn:
 *   - user is editing src/main/services/xuanpu-agent/runtime.ts
 *   - last terminal was `pnpm vitest run xfp-packet.test.ts` (failed)
 *   - branch is feat/xuanpu-agent-oh-my-pi, 2 ahead, dirty
 *   - tests are failing, 1 failure excerpt captured
 *   - user goal: "make the XFP packet schema actually parse the fixture"
 */
export function fullXfpPacketExample(): XfpFieldPacket {
  return {
    version: 1,
    identity: {
      packetId: '550e8400-e29b-41d4-a716-446655440000',
      capturedAt: 1748186400000,
      projectId: 'proj-xuanpu',
      worktreeId: 'wt-schnauzer',
      sessionId: 'sess-001'
    },
    anchor: {
      pinnedFactsMarkdown:
        '- Code style: no semicolons, single quotes, 100 char width.\n- Use shared types from src/shared/types when possible.',
      worktreeNotesMarkdown: 'Branch is the active xuanpu-agent context-native spike.',
      updatedAt: 1748100000000,
      rawRefs: [{ kind: 'memory-page', id: 'pinned-facts:wt-schnauzer' }]
    },
    gitState: {
      branchName: 'feat/xuanpu-agent-oh-my-pi',
      headShort: '29b17db',
      upstream: 'origin/feat/xuanpu-agent-oh-my-pi',
      ahead: 2,
      behind: 0,
      dirty: true,
      dirtyFiles: [
        {
          path: '/Users/slicenfer/.xuanpu-worktrees/xuanpu/xuanpu--schnauzer/src/main/services/xuanpu-agent/runtime.ts',
          relativePath: 'src/main/services/xuanpu-agent/runtime.ts',
          status: 'M',
          staged: false
        }
      ],
      dirtyTruncated: false,
      rawRefs: [
        {
          kind: 'git-object',
          id: 'git:HEAD',
          meta: { fullSha: '29b17db4f5a8c1e2b3d4a5b6c7d8e9f0a1b2c3d4' }
        }
      ]
    },
    focus: {
      file: {
        path: '/Users/slicenfer/.xuanpu-worktrees/xuanpu/xuanpu--schnauzer/src/main/services/xuanpu-agent/runtime.ts',
        name: 'runtime.ts'
      },
      selection: {
        path: '/Users/slicenfer/.xuanpu-worktrees/xuanpu/xuanpu--schnauzer/src/main/services/xuanpu-agent/runtime.ts',
        fromLine: 76,
        toLine: 132,
        length: 1840
      },
      rawRefs: [
        {
          kind: 'file',
          id: 'file:src/main/services/xuanpu-agent/runtime.ts',
          byteRange: [2800, 4640]
        }
      ]
    },
    terminal: {
      command: 'pnpm vitest run test/xfp/xfp-packet.test.ts',
      commandAt: 1748186200000,
      shell: 'zsh',
      cwd: '/Users/slicenfer/.xuanpu-worktrees/xuanpu/xuanpu--schnauzer',
      exitCode: 1,
      durationMs: 4300,
      outputHead: 'RUN  v3.0.4\n FAIL  test/xfp/xfp-packet.test.ts\n  > parses example fixture\n',
      outputTail: 'Test Files  1 failed (1)\n     Tests  1 failed (1)\n   Duration  4.30s',
      truncated: true,
      totalBytes: 18324,
      rawRefs: [{ kind: 'terminal-output', id: 'term-trace:01HZ...' }]
    },
    tests: {
      status: 'fail',
      runner: 'vitest',
      passed: 0,
      failed: 1,
      skipped: 0,
      failureExcerpts: [
        'test/xfp/xfp-packet.test.ts > parses example fixture\n  ZodError: Required at "currentGoal.objective"'
      ],
      rawRefs: [{ kind: 'terminal-output', id: 'term-trace:01HZ...' }]
    },
    commandTrace: {
      entries: [
        {
          traceId: 'trace-001',
          command: 'pnpm lint',
          capturedAt: 1748185800000,
          exitCode: 0,
          durationMs: 2100,
          compressionRatio: 0.04,
          summary: 'eslint clean: 0 errors, 0 warnings',
          rawRefs: [{ kind: 'command-trace', id: 'trace-001' }]
        }
      ],
      totalAvailable: 3
    },
    currentGoal: {
      objective: 'Define the XFP v1 packet types and Zod schema so the compiler can land in M1.',
      source: 'user-message',
      successCriteria:
        'types.ts + schema.ts + fixtures.ts compile and the example fixture validates.',
      rawRefs: [{ kind: 'message', id: 'msg-user-latest' }]
    },
    budget: {
      profile: 'balanced',
      budgetTokens: 80000,
      estimatedTokens: 6420,
      omittedSectionNames: ['retrievedMemory', 'workingSetTail'],
      compressionRatio: 0.18
    }
  }
}

/**
 * Minimal CLI packet — `xuanpu-agent --stdin` invoked in a non-Xuanpu repo:
 *   - cwd is some user repo
 *   - stdin is the file the user wants summarized
 *   - git state present because cwd is in a git repo
 *   - no worktreeId, no sessionId
 */
export function minimalXfpPacketExample(): MinimalFieldPacket {
  return {
    version: 1,
    identity: {
      packetId: '6ba7b810-9dad-11d1-80b4-00c04fd430c8',
      capturedAt: 1748186500000
    },
    cwd: '/Users/example/code/some-repo',
    stdin: {
      path: '/Users/example/code/some-repo/notes.md',
      excerpt:
        '# Notes\n\nWe need to summarize the recent commits and propose a release strategy.',
      rawRefs: [{ kind: 'file', id: 'file:/Users/example/code/some-repo/notes.md' }]
    },
    gitState: {
      branchName: 'main',
      headShort: 'a1b2c3d',
      upstream: 'origin/main',
      ahead: 0,
      behind: 1,
      dirty: false,
      dirtyFiles: [],
      dirtyTruncated: false,
      rawRefs: [
        {
          kind: 'git-object',
          id: 'git:HEAD',
          meta: { fullSha: 'a1b2c3d4e5f6a7b8c9d0e1f2a3b4c5d6e7f8a9b0' }
        }
      ]
    },
    currentGoal: {
      objective: 'Summarize this file and propose a release strategy.',
      source: 'user-message',
      successCriteria: null,
      rawRefs: [{ kind: 'message', id: 'cli-stdin' }]
    }
  }
}
