# Xuanpu Agent 1.5.0 Plan Review

Date: 2026-05-24
Reviewer: OpenClaude
Status: Reviewed

## Verdict

Direction is correct and differentiated. Scope is large but acceptable for solo-maintainer / small-user-base context. No showstoppers. Five action items below.

## Strengths

1. **Thesis is defensible.** "Not selling tokens, selling context quality" is a real differentiator against Codex/Claude Code. Compression + offload + memory as a product advantage is the right bet in a market where everyone else is chasing larger context windows.

2. **Ownership boundary is clean.** "Xuanpu owns field/context/permission/event/memory; model runtime only consumes compiled messages." This decouples the harness from any specific model provider, which is the right long-term architecture.

3. **"Summary without refs is lore, summary with refs is memory."** The most precise insight in the whole plan. This is the litmus test for whether the memory system will be trustworthy.

4. **Context Budget as black box recorder.** Making agent context auditable — what was seen, why, what was omitted — builds user trust and debuggability. This is a strong product surface.

## Action Items

### AI-1: Define oh-my-pi runtime contract

The plan says "keep oh-my-pi as thin runtime substrate" but doesn't define what "thin" means. Write down the minimum contract:

```text
Runtime MUST:
  - receive compiled messages (system + user + context)
  - stream assistant text + tool calls back
  - abort mid-stream
  - feed tool results back into conversation

Runtime MUST NOT:
  - compile context
  - select tools
  - make permission decisions
  - manage memory
```

This contract is in `src/main/services/xuanpu-agent/runtime.ts` — make it explicit as a TypeScript interface so swapping the provider (Anthropic SDK, Codex model runtime, etc.) doesn't require changing harness code.

**Target:** M1 phase, before read-only tools land.

### AI-2: Tool output truncation strategy for M2

M2 ships read-only tools before M3's compression layer. Tools like `git_log` will produce large outputs immediately. Don't let them land uncompressed.

**Recommendation A (preferred):** M2 tools ship with a hard truncation policy:
- head 500 lines + tail 500 lines
- full raw output stored as artifact ref
- metadata row in SQLite: command, exit code, duration, byte size, ref path

Replace truncation with compression profiles in M3. Low cost to implement, clean replacement path.

**Alternative B:** Build one compression profile (git log) as M2 prerequisite. Higher upfront cost, cleaner from day one.

**Target:** Decide before M2 implementation starts.

### AI-3: Define harness error taxonomy

Harness-level error types should be defined in M0-M2, even if not all recovery paths are implemented immediately:

| Error Type | Meaning | Harness Behavior |
|-----------|---------|-----------------|
| `TIMEOUT` | Tool/model timeout | Retry 1x → abort turn |
| `MALFORMED_TOOL_CALL` | Model returned unparseable tool call | Feed back to model for correction |
| `PERMISSION_DENIED` | User denied permission | Inform model, allow alternative approach |
| `COMPRESSION_FAILURE` | Compressor error | Fallback to truncation |
| `RUNTIME_ERROR` | oh-my-pi crashed | Reconnect + retry current turn |
| `TOOL_EXECUTION_ERROR` | Tool returned non-zero exit | Return structured error to model |
| `BUDGET_EXCEEDED` | Context budget limit hit | Trigger offload, refuse further tool calls |

Define as a TypeScript enum + `HarnessError` interface in `src/main/services/xuanpu-agent/harness/`. Individual recovery paths can be implemented incrementally, but the type taxonomy should be stable from M1 onward.

**Target:** M1 phase.

### AI-4: Defer XFP packet "why" to v2

The plan asks XFP field packets to answer: "Why was it included? Why was it omitted?" This is too heavy for v1.

V1 scope: track **what** was included/excluded + source refs. V2 scope: add explainability layer when Context Budget rendering is mature.

No architecture change needed — just reduce M1's deliverable scope.

**Target:** M1 scoping decision.

### AI-5: Context Budget should be cross-runtime

The plan positions Context Budget as the agent's black box recorder, but the current implementation only renders when `agentSdk === 'xuanpu-agent'`. At minimum, Codex runtime's field context injection should also be recorded and auditable.

This can be a parallel improvement during M1-M2 — no need to block the main roadmap.

**Target:** M1-M2 timeframe, as a parallel task.

## Command Trace Storage Decision

Related to open question in the plan ("store raw output in SQLite, files, or both?"):

**Recommendation:** Raw output → files (too large for SQLite). Metadata + compressed summary → SQLite row with file path reference. Don't co-locate raw bytes and structured data.

## Non-issues

- **Scope vs. version count.** Solo maintainer + small user base means shipping M0-M6 in one release is acceptable. No community pressure to deliver partial releases.
- **XFP packet versioning.** Implicitly assumed; add an explicit `version` field from day one for schema evolution.
