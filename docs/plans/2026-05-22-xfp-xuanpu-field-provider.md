# XFP: Xuanpu Field Provider Migration Plan

**Date**: 2026-05-22  
**Status**: In progress  
**Target window**: v1.5.x  
**Scope**: Field Context migration, XFP provider protocol, Claude Code/Codex field access  
**Related docs**: `docs/VISION.md`, `docs/plans/2026-05-17-context-kernel-and-provider-local-capabilities.md`, `docs/prd/phase-22a-working-memory.md`

---

## 0. Executive Summary

Xuanpu currently provides local workbench context by compiling `FieldContextSnapshot` into a markdown prefix and prepending it to every non-slash user prompt. This made agents feel more field-aware, but it also moved dynamic workbench state into the hottest and most fragile path: user message text.

The new direction is **XFP: Xuanpu Field Provider**.

```text
Old path: Xuanpu pushes [Field Context] into every prompt.
New path: Agents pull field state from Xuanpu through XFP tools when needed.
```

XFP turns Xuanpu from a prompt wrapper into a local field provider. Xuanpu owns the workbench field. Agents query it explicitly.

This plan does not throw away the existing field system. It reuses the strong parts:

- `field_events`
- `FieldContextSnapshot`
- current focus derivation
- terminal activity pairing
- pinned facts
- episodic summary
- semantic memory
- session checkpoint
- existing Claude MCP wiring

The migration has two immediate goals:

1. Stop persisting injected `[Field Context]` into user history, titles, exports, and transcripts.
2. Add an agent-facing XFP provider layer so Claude Code and Codex can request field data on demand.

---

## 1. Product Position

### 1.1 Xuanpu Is The Field Owner

Agents do not own the local development field. They run inside it.

Xuanpu owns:

- current worktree
- active file
- selection and cursor
- terminal commands and outputs
- worktree switching
- agent tool activity
- pinned facts
- episodic memory
- semantic memory
- session checkpoints

XFP is the protocol for agents to ask Xuanpu for this field.

```text
Agent: I need to know what "here" means.
Xuanpu: Current focus is ComposerBar.tsx line 1326. Last terminal command failed with exit 1.
Agent: I can now answer the user grounded in the actual field.
```

### 1.2 Why Prompt Prefix Injection Should Stop Being The Default

Current prefix injection has practical downsides:

- It adds dynamic tokens to every turn, even when the user does not need field grounding.
- It can reduce effective prompt-cache value by adding unstable timestamp/activity content.
- It pollutes title generation when implementers use injected text as the title source.
- It pollutes `session_messages` when synthetic user messages persist injected text.
- It increases context-window pressure over long sessions.
- It makes the field invisible as a tool interaction, so the user cannot audit what was used.

The issue is not that Field Context is useless. The issue is that **field data is being delivered through the wrong channel**.

### 1.3 Target Product Behavior

Normal prompt:

```text
User text stays clean.
Agent answers normally.
No dynamic field payload is injected.
```

Context-sensitive prompt:

```text
User: 这里为什么挂？
Agent calls xfp_get_current_focus.
Agent calls xfp_get_last_terminal_activity.
Agent answers based on the returned field data.
```

Long-running resume:

```text
User: 继续上次那个任务。
Agent calls xfp_get_worktree_summary or xfp_get_session_checkpoint.
Agent resumes from verified field state.
```

---

## 2. Design Principles

### 2.1 Pull Over Push

Agents must pull field context through XFP tools. Xuanpu should not push full dynamic field context into every prompt by default.

### 2.2 Structured Over Markdown

XFP returns structured data. Markdown rendering is allowed as a presenter layer, not as the core protocol.

### 2.3 Ephemeral Over Persistent

XFP results belong to the current turn. They are tool results, not user-authored messages. They must not be stored as user message content.

### 2.4 Scoped Over Full Dump

Do not start with `xfp_get_full_context()`. Field access should be split into small scoped tools:

- focus
- terminal
- recent activity
- summary
- pinned facts
- search

This prevents turning pull-based XFP into full-context injection under a new name.

### 2.5 Auditable Over Magic

The user should be able to see which XFP tools were called and what high-level field data was returned. This can live in the normal tool timeline or an XFP inspector.

### 2.6 Stable Capability Hint Over Dynamic Prompt Payload

The system prompt may say that XFP tools exist. It should not include dynamic field state.

---

## 3. Current Baseline

### 3.1 Existing Field Core

| Capability                 | Current location                                        |
| -------------------------- | ------------------------------------------------------- |
| Field event ingestion      | `src/main/ipc/field-handlers.ts`                        |
| Field event storage        | `field_events`                                          |
| Snapshot type              | `src/shared/types/field-context.ts`                     |
| Snapshot builder           | `src/main/field/context-builder.ts`                     |
| Markdown formatter         | `src/main/field/context-formatter.ts`                   |
| Prompt injection           | `src/main/ipc/agent-handlers.ts`                        |
| Last injection debug cache | `src/main/field/last-injection-cache.ts`                |
| Pinned facts               | `src/main/field/pinned-facts-repository.ts`             |
| Episodic memory            | `field_episodic_memory` and `src/main/field/episodic-*` |
| Semantic memory            | `src/main/field/semantic-memory-loader.ts`              |
| Session checkpoint         | `src/main/field/checkpoint-*`                           |
| Claude MCP precedent       | `src/main/services/token-saver/xuanpu-tools-mcp.ts`     |

### 3.2 Existing XFP Shadow

The code already has the data layer that XFP needs, but it does not expose it as an agent-facing provider.

```text
Existing:
field_events -> FieldContextSnapshot -> formatFieldContext(markdown) -> prompt prefix

Needed:
field_events -> XfpProvider(structured APIs) -> agent tool calls
```

### 3.3 Current Risk

The current implementation uses a dynamic markdown prefix:

```text
[Field Context - as of HH:MM:SS]
...
[User Message]
...
```

That prefix changes on every turn because it includes time, activity, focus, terminal output, summaries, and memory. It is useful field data, but it is currently delivered as part of the user message.

---

## 4. Target Architecture

```text
Renderer field events
  -> main field event sink
  -> field_events / field memory tables
  -> XfpProvider
  -> runtime-specific XFP adapter
  -> Claude Code MCP / Codex tools / future OpenCode tools
  -> agent calls scoped field tools on demand
```

### 4.1 Main Modules

```text
src/main/xfp/
  types.ts
  provider.ts
  presenter.ts
  audit.ts
  claude-mcp-server.ts
  codex-adapter.ts
```

### 4.2 Runtime Integration

Claude Code:

```text
Claude Code SDK query()
  + stable Xuanpu system prompt
  + mcpServers["xuanpu-field"]
  + allowedTools mcp__xuanpu-field__xfp_*
```

Codex:

```text
If app-server supports custom tools:
  register equivalent XFP tools.

If not:
  keep XfpProvider ready.
  use tiny triggered fallback only for high-confidence field requests.
```

OpenCode:

```text
Deferred. Not urgent for the current infra cycle.
Keep the existing OpenCode behavior until Claude Code and Codex prove the
runtime-facing protocol shape and there is a concrete OpenCode stability need.
```

---

## 5. XFP v0.1 Protocol

### 5.1 Scope

```ts
export interface XfpScope {
  worktreeId: string
  sessionId?: string
}
```

### 5.2 Provider Interface

```ts
export interface XfpProvider {
  getCurrentFocus(input: XfpScope): Promise<XfpCurrentFocus>

  getLastTerminalActivity(input: XfpTerminalInput): Promise<XfpTerminalActivity | null>

  getRecentActivity(input: XfpRecentActivityInput): Promise<XfpActivityEntry[]>

  getWorktreeSummary(input: XfpScope): Promise<XfpWorktreeSummary | null>

  getPinnedFacts(input: XfpScope): Promise<XfpPinnedFacts | null>

  // Deferred after v0.1 provider core.
  searchFieldEvents(input: XfpSearchInput): Promise<XfpSearchResult[]>
}
```

### 5.3 Response Types

```ts
export interface XfpCurrentFocus {
  worktree: {
    id: string
    name: string
    branchName: string | null
    path: string
  }
  file: {
    path: string
    name: string
  } | null
  selection: {
    path: string
    fromLine: number
    toLine: number
    length: number
    textPreview?: string
  } | null
}

export interface XfpTerminalInput extends XfpScope {
  includeOutput?: 'none' | 'tail' | 'head_tail'
  maxChars?: number
}

export interface XfpTerminalActivity {
  command: string
  commandAt: number
  exitCode: number | null
  output?: {
    head?: string
    tail?: string
    truncated: boolean
  }
}

export interface XfpRecentActivityInput extends XfpScope {
  windowMs?: number
  limit?: number
  types?: string[]
}

export interface XfpActivityEntry {
  timestamp: number
  type: string
  summary: string
}

export interface XfpWorktreeSummary {
  markdown: string
  compactedAt: number
  source: string
  warnings?: string[]
}

export interface XfpPinnedFacts {
  markdown: string
  updatedAt: number
}

export interface XfpSearchInput extends XfpScope {
  query: string
  limit?: number
}

export interface XfpSearchResult {
  timestamp: number
  type: string
  summary: string
  payloadPreview?: string
}
```

### 5.4 Tool Names

Claude MCP tool names:

```text
mcp__xuanpu-field__xfp_get_current_focus
mcp__xuanpu-field__xfp_get_last_terminal_activity
mcp__xuanpu-field__xfp_get_recent_activity
mcp__xuanpu-field__xfp_get_worktree_summary
mcp__xuanpu-field__xfp_get_pinned_facts
mcp__xuanpu-field__xfp_search_field_events
```

Internal provider method names should match the tool names without the MCP prefix.

---

## 6. Stable System Prompt

Replace the current wrapper-oriented prompt with a provider-oriented prompt.

Current mental model:

```text
Xuanpu wraps each user turn with [Field Context].
```

Target mental model:

```text
You are running inside Xuanpu.
Xuanpu provides XFP tools for local workbench field state.
Use the specific XFP tool needed when the user refers to current file, selection,
last command, terminal output, recent work, resume state, or "here/this".
Do not assume local field state from stale chat history when XFP can provide
fresh field state.
```

The prompt must remain stable and short. It must not contain dynamic field state.

---

## 7. Migration Plan

### Phase 0: Plan And Contract

Status: complete.

Deliverables:

- XFP principles
- XFP v0.1 provider interface
- runtime migration plan
- acceptance criteria

### Phase 1: Stop Field Context Pollution

Status: implemented for Claude Code and Codex on 2026-05-22.

Goal: stop new `[Field Context]` content from entering durable user history and titles.

Changes:

- Add `stripFieldContextEnvelope()`.
- Keep `runtimeMessage` and `originalMessage` as separate concepts.
- Make Claude Code synthetic user messages use `originalMessage`.
- Make Codex synthetic user messages use `originalMessage`.
- Make immediate title use `originalMessage`.
- Make generated title use `originalMessage`.
- Add strip fallback when persisting transcript/thread snapshots.
- Add strip fallback in timeline/export read paths where needed.

Suggested file changes:

```text
src/shared/lib/field-context-envelope.ts
src/main/ipc/agent-handlers.ts
src/main/services/claude-code-implementer.ts
src/main/services/codex-implementer.ts
src/main/services/claude-session-title.ts
src/main/services/codex-session-title.ts
src/main/services/session-timeline-service.ts
```

Tests:

```text
test/xfp/field-context-envelope.test.ts
test/phase-22/session-*/claude-field-context-clean-history.test.ts
test/phase-22/session-*/codex-field-context-clean-history.test.ts
test/phase-23/session-title-field-context-strip.test.ts
```

Acceptance:

- New Claude Code and Codex `session_messages.user.content` should not start with
  `[Field Context`.
- Claude Code and Codex title generation use the original user message or a strip
  fallback.
- Claude Code and Codex synthetic user messages preserve attachments while cleaning
  only text parts.
- Codex readback paths sanitize old persisted/thread snapshot envelopes.
- Slash commands still bypass field injection.

Implemented files:

```text
src/shared/lib/field-context-envelope.ts
src/main/ipc/agent-handlers.ts
src/main/services/agent-runtime-types.ts
src/main/services/claude-code-implementer.ts
src/main/services/codex-implementer.ts
src/main/services/claude-session-title.ts
src/main/services/codex-session-title.ts
```

### Phase 2: XFP Provider Core

Status: v0.1 provider core implemented on 2026-05-22.

Goal: turn the existing field builder into an internal provider API.

Changes:

- Add `src/main/xfp/types.ts`.
- Add `src/main/xfp/provider.ts`.
- Reuse `buildFieldContextSnapshot()` internally where efficient.
- Expose scoped provider methods instead of one full markdown payload.
- Apply privacy and truncation policy per method.

Important constraints:

- `getLastTerminalActivity()` defaults to `includeOutput: 'tail'`.
- `getRecentActivity()` defaults to `windowMs: 5 * 60_000` and `limit: 10`.
- `getPinnedFacts()` returns only user-authored facts, not generated memory.
- `getWorktreeSummary()` returns episodic/checkpoint state with warnings.
- No default `getFullContext()` method in v0.1.

Tests:

```text
test/xfp/provider.test.ts
```

Acceptance:

- Provider can return current focus without rendering markdown.
- Provider can return last terminal command and bounded output.
- Provider respects privacy settings.
- Provider output is deterministic enough for unit tests.
- `searchFieldEvents()` remains deferred until after the MCP shape is validated.

Implemented files:

```text
src/main/xfp/types.ts
src/main/xfp/provider.ts
```

### Phase 3: Claude Code XFP MCP

Status: implemented for Claude Code on 2026-05-22.

Goal: Claude Code can actively query Xuanpu field state.

Changes:

- Add `src/main/xfp/claude-mcp-server.ts`.
- Register `xuanpu-field` MCP server per Claude session.
- Add allowed tools for `mcp__xuanpu-field__xfp_*`.
- Keep Token Saver MCP server separate as `xuanpu`.
- Update `XUANPU_SYSTEM_CONTEXT` to describe XFP tools instead of wrapper semantics.

Suggested file changes:

```text
src/main/xfp/claude-mcp-server.ts
src/main/services/claude-code-implementer.ts
src/main/services/xuanpu-system-context.ts
test/xuanpu-system-context.test.ts
```

Acceptance:

- Claude Code session options include `xuanpu-field` MCP server when a worktree
  can be resolved.
- Tool names are explicitly available in `allowedTools`.
- Token Saver MCP (`xuanpu`) and XFP MCP (`xuanpu-field`) coexist without
  overwriting each other.
- System prompt now describes XFP as the primary field access path while keeping
  legacy Field Context as fallback observed data.
- Manual prompt `这里为什么挂？` should lead Claude to call focus/terminal XFP
  tools before answering.

Implemented files:

```text
src/main/xfp/claude-mcp-server.ts
src/main/services/claude-code-implementer.ts
src/main/services/xuanpu-system-context.ts
test/xfp/claude-mcp-server.test.ts
test/xuanpu-system-context.test.ts
test/phase-21/session-4/claude-prompt-streaming.test.ts
```

### Phase 4: Default Injection Policy Change

Status: implemented for Claude Code on 2026-05-22; Codex has a transitional
bounded fallback; OpenCode is explicitly deferred because it is not urgent for
the current infra cycle.

Goal: stop default full prefix injection once Claude Code has XFP pull access.

Policy:

```text
Claude Code:
  default: XFP pull-based
  fallback: tiny triggered injection only if XFP MCP attach fails

Codex:
  default: XFP if custom tools are supported
  fallback: tiny triggered injection while tool support is missing

OpenCode:
  keep existing behavior; XFP migration is deferred until there is a concrete need
```

Fallback injection must obey:

- no durable persistence
- no title input
- no full recent activity dump by default
- no timestamp unless required for the task

Suggested files:

```text
src/main/ipc/agent-handlers.ts
src/main/services/agent-runtime-types.ts
src/main/services/claude-code-implementer.ts
src/main/services/codex-implementer.ts
```

Acceptance:

- Normal Claude Code prompt no longer receives full `[Field Context]` prefix.
- Claude Code can still answer field-sensitive prompts through XFP tool calls.
- A runtime failure to attach XFP is visible in logs and uses bounded fallback.

Implemented files:

```text
src/main/ipc/agent-handlers.ts
src/main/services/claude-code-implementer.ts
src/main/xfp/fallback-context.ts
test/xfp/agent-prompt-xfp-policy.test.ts
test/xfp/fallback-context.test.ts
test/phase-21/session-4/claude-prompt-streaming.test.ts
```

### Phase 5: Codex Adapter

Status: transitional fallback implemented on 2026-05-22; custom tool adapter is
deferred because the current `codex app-server` wrapper only sends `turn/start`
input/collaborationMode/settings and has no proven custom tool registration
surface in this codebase.

Goal: Codex reaches feature parity where supported by the app-server.

Open question:

- Does the current Codex app-server path support registering custom tools or MCP-like tool schemas?

If yes:

- Add `src/main/xfp/codex-adapter.ts`.
- Register equivalent tool schema.
- Emit XFP audit events for tool calls.

If no:

- Keep provider core.
- Use triggered tiny fallback for high-confidence field requests.
- Track Codex tool support as a runtime capability.

Acceptance:

- Codex does not receive full Field Context by default.
- Codex either calls XFP tools or uses bounded triggered fallback.
- Codex titles and history remain clean.

Implemented transition:

```text
src/main/ipc/agent-handlers.ts
src/main/services/codex-implementer.ts
src/main/xfp/fallback-context.ts
test/xfp/agent-prompt-xfp-policy.test.ts
test/phase-22/session-5/codex-prompt-streaming.test.ts
```

### Phase 6: XFP Inspector

Status: first slice implemented on 2026-05-22.

Goal: make field access auditable.

Changes:

- Rename or evolve `FieldContextDebug` into `XFP Inspector`.
- Show XFP calls for the current turn.
- Show per-turn field-delivery mode:
  `none | xfp-mcp | xfp-fallback | legacy-injection`.
- Show result summaries, token/char size, truncation, privacy decisions.
- Keep legacy Last Injection view behind a debug/fallback section.

Possible event shape:

```ts
interface XfpAuditEvent {
  id: string
  sessionId: string
  runtimeId: 'claude-code' | 'codex' | 'opencode'
  kind: 'tool' | 'fallback' | 'prompt'
  toolName: string
  input: Record<string, unknown>
  outputSummary: string
  outputChars: number
  truncated: boolean
  privacy: 'allowed' | 'redacted' | 'disabled'
  createdAt: number
}
```

Acceptance:

- User can see which field tools were used.
- User can see whether a turn used XFP MCP, bounded fallback, no field delivery,
  or legacy injection.
- Debug UI no longer centers on hidden prompt injection.
- Tool timeline can distinguish XFP calls from normal shell/file tools.

Implemented first slice:

```text
src/shared/types/xfp-audit.ts
src/main/xfp/audit.ts
src/main/xfp/claude-mcp-server.ts
src/main/services/claude-code-implementer.ts
src/main/services/codex-implementer.ts
src/main/ipc/field-handlers.ts
src/preload/index.ts
src/preload/index.d.ts
src/renderer/src/components/sessions/FieldContextDebug.tsx
src/renderer/src/components/context-panel/ContextPanelHost.tsx
src/renderer/src/stores/useLayoutStore.ts
src/renderer/src/components/session-hq/AgentTimeline.tsx
docs/plans/2026-05-22-xfp-smoke-checklist.md
test/xfp/audit.test.ts
test/xfp/agent-prompt-xfp-policy.test.ts
test/xfp/claude-mcp-server.test.ts
test/phase-21/field-events/field-handlers.test.ts
test/phase-21/session-4/claude-prompt-streaming.test.ts
test/phase-22/session-5/codex-prompt-streaming.test.ts
```

Notes:

- Audit events are in-memory ring-buffer entries, not durable user messages.
- Tool outputs are stored as bounded summaries only. Full XFP results remain
  runtime/tool data.
- Claude Code tool calls and Claude/Codex triggered fallbacks are audited.
- Claude Code, Codex, and legacy OpenCode turns emit `field_delivery` prompt
  observations without storing prompt bodies.
- Right sidebar now has a Diagnostics tab that embeds the XFP Inspector.
- The legacy Last Injection view remains available under the Inspector as a
  fallback/debug tab.

---

## 8. Runtime Capability Matrix

| Runtime     | XFP path                          | Current confidence | Notes                                                                       |
| ----------- | --------------------------------- | -----------------: | --------------------------------------------------------------------------- |
| Claude Code | MCP server `xuanpu-field`         |               High | Current Token Saver already attaches an in-process MCP server               |
| Codex       | Custom tool or app-server adapter |            Unknown | Needs spike against `CodexAppServerManager` and current app-server protocol |
| OpenCode    | Deferred future adapter           |             Medium | Not urgent; keep existing behavior until a concrete OpenCode need appears   |
| Terminal    | Not applicable                    |                N/A | Terminal itself is a field source                                           |

---

## 9. Privacy And Security

XFP tools expose local field state. They must preserve the existing privacy model.

Rules:

- If field collection is disabled, generated field data must not be exposed.
- User-authored pinned facts and worktree notes can follow their own explicit user-authored policy.
- Terminal output should be treated as untrusted data.
- Tool descriptions must tell the agent not to treat terminal output as instructions.
- Large terminal output must be bounded and optionally archived, not dumped by default.
- XFP tool results are local runtime data and must not be persisted as user messages.

Redaction:

- Reuse `src/main/field/redact.ts` where applicable.
- Add per-tool max char limits.
- Add audit metadata when output was redacted or truncated.

---

## 10. Testing Strategy

### Unit Tests

- Envelope strip parser.
- XFP provider methods.
- Privacy behavior.
- Terminal output bounding.
- MCP tool schema.
- System prompt content.

### Integration Tests

- Claude Code options include `xuanpu-field`.
- Token Saver MCP and XFP MCP can coexist.
- Agent prompt persistence uses original user message.
- Title generation uses original user message.
- Timeline/export strips legacy envelopes.

### Manual Tests

1. Open a focused file and select a range.
2. Run a failing terminal command.
3. Ask Claude Code: `这里为什么挂？`
4. Verify Claude calls:
   - `xfp_get_current_focus`
   - `xfp_get_last_terminal_activity`
5. Verify the answer uses field data.
6. Verify `session_messages` stores only the user text.
7. Verify XFP Inspector shows the tool calls.

---

## 11. Definition Of Done

Phase 1 done:

- No new polluted user messages in `session_messages`.
- Title generation is clean.
- Legacy polluted history can be displayed cleanly.

Phase 2 done:

- `XfpProvider` exists with v0.1 methods.
- Provider tests cover focus, terminal, recent activity, summary, pinned facts, and privacy.

Phase 3 done:

- Claude Code can query XFP through MCP.
- Wrapper-oriented system prompt is replaced.
- Normal Claude Code prompt no longer needs full default Field Context prefix.

Full migration done:

- Dynamic Field Context prefix is fallback-only.
- Field access is visible as tool calls.
- User-authored message history remains clean.
- Claude Code and Codex have runtime-appropriate XFP paths.

---

## 12. Non-Goals

These are explicitly out of scope for v0.1:

- Public XFP specification repository.
- MCP community proposal.
- Cross-runtime automatic migration.
- OpenCode XFP migration in the current infra cycle.
- Full field subscription streaming.
- `xfp_get_full_context()` as a default tool.
- Automatic model routing based on field content.

---

## 13. Risks

### Agent Does Not Call XFP When It Should

Mitigation:

- Keep the system prompt short and explicit.
- Use clear tool names and descriptions.
- Add triggered tiny fallback for high-confidence field requests while tuning.

### Pull-Based Tools Add Latency

Mitigation:

- Keep provider methods fast and bounded.
- Reuse current snapshot builder where possible.
- Cache short-lived provider results per turn if needed.

### Codex Does Not Support Custom Tools Yet

Mitigation:

- Separate provider core from runtime adapter.
- Use capability detection.
- Keep Codex on triggered tiny fallback until tool support is available.

### XFP Becomes Full Context Dump By Another Name

Mitigation:

- No default `getFullContext()`.
- Scoped tools only.
- Per-tool budgets.
- Inspector shows result size and truncation.

---

## 14. Recommended PR Split

PR 1: Clean history and title pollution.

```text
stripFieldContextEnvelope
original/runtime message separation
Claude/Codex synthetic message cleanup
title cleanup
tests
```

PR 2: XFP provider core.

```text
src/main/xfp/types.ts
src/main/xfp/provider.ts
provider tests
```

PR 3: Claude Code MCP.

```text
xuanpu-field MCP server
Claude implementer integration
system prompt replacement
manual validation
```

PR 4: Injection policy switch.

```text
default XFP pull for Claude
fallback-only prefix injection
audit logs
```

PR 5: Codex adapter or fallback policy.

```text
Codex capability spike
tool adapter if available
triggered tiny fallback otherwise
```

PR 6: XFP Inspector.

```text
tool call audit UI
legacy FieldContextDebug fallback section
```

---

## 15. Working Thesis

XFP should replace Field Context Prefix as the primary field delivery mechanism.

Field Context remains useful as:

- internal snapshot model
- legacy fallback
- debug renderer
- formatter for human inspection

But the default agent path should be:

```text
stable capability prompt + scoped field tools + clean user history
```

That is the path most aligned with Xuanpu's product position: a desktop workbench that provides field-aware infrastructure to agents, not a prompt wrapper that hides dynamic context in every user message.
