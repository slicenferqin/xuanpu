# Xuanpu Agent Progress And Roadmap

Date: 2026-05-27
Branch: `feat/xuanpu-agent-oh-my-pi`
Code baseline before this handoff doc: `3b119d29`

This document is the current handoff state for M4 and later work. At the time this
handoff was written, local `HEAD` matched `origin/feat/xuanpu-agent-oh-my-pi` at
`3b119d2967a6b3c9ef39c5e3d032ba7471352055`, and the worktree was clean.

## Source Documents

- Main plan: `docs/plans/2026-05-24-xuanpu-agent-1.5.0-context-native-harness.md`
- Chinese main plan: `docs/plans/2026-05-24-xuanpu-agent-1.5.0-context-native-harness.zh-CN.md`
- XFP design: `docs/plans/2026-05-22-xfp-xuanpu-field-provider.md`
- Runtime spike background: `docs/plans/2026-05-23-xuanpu-agent-oh-my-pi-runtime.md`

## Pushed Work

| Commit | Stage | Summary |
| --- | --- | --- |
| `e73c9d98` | M3 | Finish context budget traces |
| `4d85d5a2` | M4 | Add controlled write harness |
| `4ac26988` | M5 | Add memory graph foundation |
| `497b035e` | M6 | Add checkpoint/resume and claim-verifier recovery |
| `72b2bdf5` | M6 | Supervise long-running test tools |
| `0ce87444` | M6 | Add multi-worktree and PR/review context |
| `dd8abc99` | M6 | Add harness metrics |
| `3b119d29` | M6/hub | Preserve advanced agent parts for mobile |

## Current Status

M4 and M5 have implementation and tests in place. M6 is materially advanced but
must not be called complete yet, because the design scope still includes MCP
integration and subtask delegation.

| Area | Status | Notes |
| --- | --- | --- |
| M4 controlled writes | Done | `apply_patch`, `write_file`, `edit_file`, `run_test`, and `format_file` are preview-gated. Dangerous paths are blocked. |
| M5 memory graph | Done | Memory proposals, retrieval, and trace workflow materialization are wired into context packages. |
| checkpoint/resume | Done | Verified checkpoint blocks are injected into XFP packets on resume turns. |
| post-response claim verifier | Done | File/API claims in final assistant text are checked against observed paths and local files. |
| long-running supervision | Done | `run_test` tracks timeout, abort, long-running notification, and compressed output. |
| multi-worktree awareness | Done | XFP includes bounded sibling worktree context. |
| PR/review context | Done | XFP includes current branch, compare target, attached PR, and dirty count. |
| harness metrics | Done | Context package records cache ratio, parallel-safe ratio, and compression metrics. |
| hub/mobile event propagation | Done | Unknown advanced parts are preserved through hub/mobile via `unknown.raw`. |
| MCP integration | Not done | `xuanpu-agent` still blocks MCP with `mcp-boundary`. Claude Code has XFP MCP, but xuanpu-agent does not yet have a scoped MCP policy. |
| subtask delegation | Not done | Timeline/UI can represent `subtask` parts, but xuanpu-agent runtime does not yet delegate or emit subtask lifecycle parts. |

## Important Constraints

- Do not open arbitrary shell or arbitrary external MCP for xuanpu-agent.
- Keep `nativeProcessControlEnabled` false.
- Keep the permission model Xuanpu-owned: writes stay preview-gated unless trusted writes are explicitly enabled.
- Reuse the existing Field/XFP providers where possible instead of inventing a second context channel.
- Each stage or substage should be committed and pushed before handing to Claude Code for review.

## M6 Remaining Work

### 1. Scoped MCP Integration

Recommended next implementation:

- Add a xuanpu-agent scoped MCP manifest/bridge, not general MCP server discovery.
- Expose only Xuanpu-owned read-only field tools first, probably mirroring the existing Claude XFP tool surface:
  - `xfp_get_current_focus`
  - `xfp_get_last_terminal_activity`
  - `xfp_get_recent_activity`
  - `xfp_get_worktree_summary`
  - `xfp_get_pinned_facts`
- Keep arbitrary external MCP blocked until there is an explicit allowlist, permission UI, and audit trail.
- Update `tool-policy.ts` so the prompt says scoped Xuanpu MCP is available only if the implementation is actually wired and tested.
- Add focused tests under `test/phase-24/` for allowed tool names, audit behavior, and failure handling.

Acceptance bar:

- xuanpu-agent can call scoped Xuanpu field tools without broad MCP discovery.
- `mcp-boundary` is either satisfied with a precise reason or remains blocked with a documented partial implementation.
- A disallowed MCP/native tool still fails policy checks.

### 2. Subtask Delegation

Recommended next implementation:

- Start with a controlled delegation tool or runtime event, not arbitrary child process spawning.
- Persist and emit `subtask` parts that match `src/shared/lib/timeline-types.ts`.
- Route child tool/text parts under the parent subtask where possible.
- Preserve the part through desktop timeline, hub bridge, and mobile bridge.

Acceptance bar:

- A xuanpu-agent turn can create a visible delegated subtask with id, session id, prompt/description, agent name, status, and nested parts.
- Completed/error states are represented deterministically.
- Existing non-subtask message rendering does not regress.

## Suggested Command Sequence For Continuation

```bash
git checkout feat/xuanpu-agent-oh-my-pi
git pull --ff-only
pnpm vitest run test/phase-24/xuanpu-agent-tool-policy.test.ts
pnpm vitest run test/phase-24/xuanpu-agent-runtime.test.ts
pnpm vitest run test/phase-24/xuanpu-agent-ipc-smoke.test.ts
pnpm exec tsc --noEmit --pretty false
pnpm lint
pnpm build
```

Known wider-suite caveat from the previous run:

- `test/server/hub-server.test.ts` can fail locally from `better-sqlite3` Node ABI mismatch.
- `test/server/hub-controller.test.ts` can fail locally from the Electron install check.

Those are environment issues unless reproduced after rebuilding dependencies.

## Do Not Claim Complete Yet

The main M6 design scope is:

- MCP integration
- subtask delegation
- checkpoint/resume
- long-running command supervision
- multi-worktree awareness
- PR/review workflows
- hub/mobile event propagation

The last five are implemented. MCP integration and subtask delegation remain the
handoff focus.
