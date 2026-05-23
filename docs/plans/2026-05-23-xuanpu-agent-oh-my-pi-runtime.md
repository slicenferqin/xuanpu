# Xuanpu Agent Runtime Based on oh-my-pi

Date: 2026-05-23
Status: Proposal
Branch: `feat/xuanpu-agent-oh-my-pi`

## Decision

Build an experimental fourth runtime, `xuanpu-agent`, based on `@oh-my-pi/pi-agent-core`.

This runtime is not a replacement for Claude Code, Codex, or OpenCode. It is a managed agent
runtime whose purpose is to prove that Xuanpu can own the full context assembly path:

```text
Field events + pinned facts + memory.md + episodes + working set
  -> Xuanpu Context Packer
  -> oh-my-pi Agent transformContext / convertToLlm
  -> provider LLM API
```

The key product bet is that Xuanpu should remain a workbench for existing agents while also
offering one native managed runtime where context compression, recall, budget profiles, and prompt
cache layout are first-class.

## Why Not Patch Existing Runtimes

Current Xuanpu runtime integration is prompt-forwarding plus Field Context injection:

- `src/main/ipc/agent-handlers.ts` builds Field Context and prepends it to the user message.
- Claude Code resumes via SDK-managed history with `options.resume`.
- Codex app-server stores thread history internally.
- OpenCode server stores session history internally.

This means Xuanpu can add context, but cannot reliably remove or replace old provider-owned
conversation history. Full application-layer steady-state context compression requires control of
the final `messages[]` sent to the provider.

For the existing runtimes, the practical path is still:

- keep Field Context injection
- surface context usage and compaction notices
- support session handoff / rebase later
- avoid promising full token savings from managed context

## Why oh-my-pi

Verified npm packages:

- `@oh-my-pi/pi-agent-core@15.2.4`, MIT
- `@oh-my-pi/pi-coding-agent@15.2.4`, MIT

Use `@oh-my-pi/pi-agent-core` for the spike. `@oh-my-pi/pi-coding-agent` is closer to a full CLI
product and should not be pulled into Xuanpu until the smaller core package is proven insufficient.

The useful hooks in `pi-agent-core` are:

```ts
transformContext?: (
  messages: AgentMessage[],
  signal?: AbortSignal
) => Promise<AgentMessage[]>

convertToLlm?: (
  messages: AgentMessage[]
) => Message[] | Promise<Message[]>
```

These map directly to Xuanpu's desired control points:

- `transformContext`: prune or rewrite the agent's internal working set before each LLM call.
- `convertToLlm`: emit the final provider message list in cache-friendly order.

The package also includes compaction entries and custom message support, which can represent
Xuanpu-generated frozen episodes without pretending they are ordinary user text.

## Non-Goals

Initial `xuanpu-agent` will not try to match Claude Code feature-for-feature.

Non-goals for the first spike:

- no replacement of existing Claude Code / Codex / OpenCode sessions
- no automatic migration of old sessions
- no fork of oh-my-pi
- no bundled local model
- no promise of production-quality undo, MCP parity, or plan mode parity
- no default enablement in the New Session UI until basic reliability is proven

## Target Architecture

```text
src/main/services/xuanpu-agent-implementer.ts
  AgentRuntimeAdapter implementation

src/main/services/xuanpu-agent/
  runtime.ts              # wraps pi-agent-core Agent lifecycle
  event-mapper.ts         # oh-my-pi events -> Xuanpu normalized events
  context-transform.ts    # transformContext bridge
  convert-to-llm.ts       # cache-aware final Message[] conversion
  model-config.ts         # provider/model/key selection

src/main/context-kernel/
  types.ts
  compiler.ts
  budget.ts
  trace-repository.ts

src/main/context-episodes/
  repository.ts
  maintainer.ts
  compactor.ts
```

Long term, `context-kernel` should be shared by all runtimes. Existing runtimes can still receive
the rendered package as a prefix. `xuanpu-agent` is the runtime that can consume the package as the
authoritative message assembly layer.

## Context Model

The managed runtime should use five regions:

1. Anchor
   Stable protocol, pinned facts, project/user memory.

2. Frozen Episodes
   Append-only structured summaries generated from old turns/events. Once written, an episode is
   immutable. It keeps raw event refs.

3. Retrieved Episodes
   Optional, gated recall based on file path, symbol, error signature, explicit historical
   reference, or sensitive constraint hit.

4. Working Set
   Recent high-fidelity turns and tool results. This is the only routinely changing conversation
   region.

5. Current Field
   Current worktree, focus file, selection, latest terminal/test state, and current user message.

The packer should default to a Balanced budget, not a 200K target:

```text
Focused:   32K-64K
Balanced:  80K-150K
Extended: 150K-200K
Max:       manual only
```

200K is a hard cap, not the desired normal operating point.

## Data Model Changes

Current `field_episodic_memory` is a single rolling worktree summary. That is useful for existing
Field Context but insufficient for append-only managed context.

Add new tables instead of replacing it:

```sql
CREATE TABLE field_episode_blocks (
  id TEXT PRIMARY KEY,
  worktree_id TEXT NOT NULL,
  session_id TEXT,
  created_at INTEGER NOT NULL,
  source_event_seq_start INTEGER,
  source_event_seq_end INTEGER,
  source_message_id_start TEXT,
  source_message_id_end TEXT,
  kind TEXT NOT NULL,
  title TEXT,
  summary_markdown TEXT NOT NULL,
  key_facts_json TEXT NOT NULL,
  constraints_json TEXT NOT NULL,
  files_json TEXT NOT NULL,
  commands_json TEXT NOT NULL,
  raw_refs_json TEXT NOT NULL,
  token_estimate INTEGER NOT NULL,
  confidence TEXT NOT NULL
);

CREATE INDEX idx_field_episode_blocks_worktree_created
  ON field_episode_blocks(worktree_id, created_at DESC);

CREATE TABLE field_context_packages (
  id TEXT PRIMARY KEY,
  session_id TEXT NOT NULL,
  worktree_id TEXT NOT NULL,
  runtime_id TEXT NOT NULL,
  model_provider_id TEXT,
  model_id TEXT,
  created_at INTEGER NOT NULL,
  budget_profile TEXT NOT NULL,
  approx_tokens INTEGER NOT NULL,
  sections_json TEXT NOT NULL,
  rendered_markdown TEXT,
  decisions_json TEXT NOT NULL
);
```

`field_context_packages` is an audit trail. It should power the Context Budget Debugger and allow a
developer to answer "what did the agent actually see on this turn?"

## MVP Plan

### Phase 0: Package Spike

Goal: prove that `@oh-my-pi/pi-agent-core` can run inside Electron main with pnpm/Vite packaging.

Tasks:

- add dependency behind a branch-only spike
- instantiate an Agent in a standalone script or test
- send one prompt to a configured provider
- receive streaming text
- confirm abort signal behavior
- confirm package bundling does not break Electron main

Exit criteria:

- one automated test or probe script can run a no-tools prompt
- failure modes are logged without crashing the main process

### Phase 1: Fourth Runtime Skeleton

Goal: register `xuanpu-agent` as a runtime without exposing it by default.

Tasks:

- extend runtime unions and DB/preload/shared types
- add `XUANPU_AGENT_CAPABILITIES`
- add `XuanpuAgentImplementer`
- register implementer in main startup
- map basic events into existing Session HQ timeline
- support `connect`, `prompt`, `abort`, `getMessages`, `disconnect`

Initial capabilities:

```ts
{
  supportsUndo: false,
  supportsRedo: false,
  supportsSteer: false,
  supportsCommands: false,
  supportsPermissionRequests: false,
  supportsQuestionPrompts: false,
  supportsModelSelection: true,
  supportsReconnect: false,
  supportsPartialStreaming: true
}
```

### Phase 2: Minimal Context Packer

Goal: prove the managed context hook works before adding real compression.

`transformContext` behavior:

- keep latest 6 user/assistant exchanges
- prepend a synthetic `xuanpu.anchor` message from pinned facts + memory.md
- prepend a synthetic `xuanpu.field` message from the existing Field Context builder
- drop older raw turns
- record a context package trace

`convertToLlm` behavior:

- order stable sections first
- place working set and current user message last
- convert custom Xuanpu messages into ordinary provider-compatible text messages

Exit criteria:

- visible session answer quality is comparable to a normal runtime for simple prompts
- Context Budget Debugger shows included/excluded sections
- UI still displays the user's original message, not injected context

### Phase 3: Append-Only Episodes

Goal: turn old raw turns into frozen episode blocks.

Tasks:

- add `field_episode_blocks`
- add deterministic metadata extraction for files, commands, failures, constraints
- add LLM compaction only for intent/decision/open-task prose
- store raw refs and confidence
- never overwrite an existing episode

First version can use:

- existing `ClaudeHaikuCompactor` when Claude is configured
- a provider-specific cheap model later
- rule-based fallback always

### Phase 4: Gated Retrieval

Goal: avoid every-turn RAG.

Trigger recall only when:

- user says "before", "last time", "earlier", "that plan", "之前", "上次", "刚才"
- user mentions a file or symbol not present in the working set
- current error matches a historical error signature
- agent is about to modify a file with historical constraints
- user input is short but referential and working set is insufficient

Prefer deterministic retrieval over vector similarity:

```text
file path > symbol > error code/stack frame > command > event type > recency > embedding
```

Vector search is optional and should not be required for the first working version.

## Settings

Do not bundle a local model.

Compaction model resolution should be:

1. explicit Xuanpu compaction model setting
2. cheap model from the active provider
3. rule-based compactor

Ollama or other local OpenAI-compatible endpoints can be supported as configuration, not as bundled
runtime assets.

## Risks

### Runtime Surface Area

Claude Code parity is large: tools, permissions, file checkpoints, undo, MCP, plan mode, slash
commands, and transcript semantics. The spike must avoid promising parity.

Mitigation: ship as experimental runtime, hidden behind a setting until the core loop is stable.

### Electron Packaging

`pi-agent-core` exports TypeScript source and depends on `@oh-my-pi/pi-natives`. Electron/Vite may
need explicit externalization or packaging rules.

Mitigation: Phase 0 exists specifically to validate packaging before product work.

### Tool Safety

Managed tools mean Xuanpu owns command/file safety. Existing Claude Code permission semantics will
not automatically apply.

Mitigation: first spike is no-tools. Add shell/file tools only after permission policy is mapped.

### Context Drift

Summaries can lose constraints. This is the central quality risk.

Mitigation:

- raw event refs are mandatory
- user constraints are extracted deterministically where possible
- code blocks and diffs are not semantically compressed in v1
- low-confidence episodes are visible and editable

## Open Questions

- Should `xuanpu-agent` use `@oh-my-pi/pi-ai` providers directly, or route provider calls through a
  Xuanpu abstraction first?
- Which provider is the initial dogfood target: Anthropic key, OpenAI key, or Ollama endpoint?
- Should Context Package traces store rendered markdown for every turn, or only section metadata by
  default with full rendered body behind a debug/privacy flag?
- Should `xuanpu-agent` sessions share the existing `session_messages` table shape or introduce a
  runtime-native transcript table?

## Immediate Next Steps

1. Add a Phase 0 probe script for `@oh-my-pi/pi-agent-core`.
2. Verify Electron main packaging and native dependency behavior.
3. Draft `XuanpuAgentImplementer` with no-tools prompt streaming.
4. Add `xuanpu-agent` to runtime unions behind a hidden feature flag.
5. Add `ContextPackage` types and trace repository before real compression.

## Implementation Progress: 2026-05-23

Current branch: `feat/xuanpu-agent-oh-my-pi`.

Landed in the first implementation pass:

- Added `@oh-my-pi/pi-agent-core@15.2.4` to the root dependency graph.
- Added `probe:xuanpu-agent-core` to document and reproduce the Phase 0 package-load check.
- Extended the core runtime id surfaces with `xuanpu-agent`:
  - main runtime types and capabilities
  - IPC runtime schema
  - shared protocol/session/worktree types
  - preload API types
  - renderer session/worktree/settings type surfaces
- Added `XuanpuAgentImplementer` as an experimental fourth runtime skeleton.
- Registered `xuanpu-agent` only when `XUANPU_AGENT_RUNTIME=1` is set.
- Kept normal Claude Code, Codex, OpenCode, and Terminal flows unchanged by default.

The skeleton intentionally does not call a provider yet. Its `prompt` path performs a guarded
`@oh-my-pi/pi-agent-core` load probe and persists a clear success/failure assistant message. This
keeps the runtime testable without pretending tool execution, provider routing, or context packing
is already complete.

### Verification Notes

`pnpm install --prefer-offline --frozen-lockfile` repeatedly timed out while linking the workspace
`node_modules`. The pnpm store contains the downloaded packages, including `@oh-my-pi/pi-agent-core`,
but the root `.bin` links were not produced in this worktree, so `pnpm exec tsc ...` could not run
normally.

The important Phase 0 finding remains:

```text
@oh-my-pi/pi-agent-core@15.2.4 exports TypeScript source.
Electron main currently uses externalizeDepsPlugin().
Xuanpu must bundle/transpile the oh-my-pi packages for main, or route loading through a compiled
wrapper, before provider execution can be enabled.
```

## Next Task Plan

### Task 1: Finish Package Load Validation

- Repair local pnpm linking in this worktree or verify on a clean checkout.
- Run `pnpm run probe:xuanpu-agent-core`.
- Decide whether Electron main should bundle `@oh-my-pi/*` packages by configuring
  `externalizeDepsPlugin`, or whether Xuanpu should introduce a small compiled wrapper package.
- Run `pnpm build` with `XUANPU_AGENT_RUNTIME=1` after the packaging rule is chosen.

Exit criteria: the app can start with `XUANPU_AGENT_RUNTIME=1` and the xuanpu-agent load probe fails
or succeeds as a handled runtime message, never as a main-process crash.

### Task 2: Wire Minimal Managed Runtime

- Replace the load-probe-only prompt path with a no-tools oh-my-pi agent call.
- Support one configured provider first, preferably reusing Xuanpu's existing model/provider
  settings instead of adding a new settings surface.
- Stream assistant text into the existing `agent:stream` protocol.
- Persist user and assistant messages in the existing `session_messages` table.
- Keep permissions, shell tools, file tools, slash commands, plan mode, undo, and fork disabled.

Exit criteria: a hidden `xuanpu-agent` session can answer a simple prompt from Session HQ.

### Task 3: Add Context Package Trace Before Compression

- Add `field_context_packages` migration and repository.
- Record each rendered package with runtime id, model id, approximate tokens, section metadata, and
  inclusion/exclusion decisions.
- Use the existing Field Context builder as the first `xuanpu.field` section.
- Keep summaries and retrieval out of scope until traces are inspectable.

Exit criteria: every xuanpu-agent turn has an auditable "what did the agent see" record.

### Task 4: Minimal Context Transform

- Implement a conservative `transformContext` bridge:
  - anchor from pinned facts / worktree note / memory
  - current Field Context
  - latest 6 user/assistant exchanges
  - current user message last
- Do not compress code, diffs, or tool output yet.
- Store context package decisions for dropped old turns.

Exit criteria: Xuanpu owns the final `messages[]` for xuanpu-agent while preserving the visible
transcript as user-authored messages.

### Task 5: Append-Only Episodes

- Add `field_episode_blocks`.
- Implement rule-based episode creation first.
- Add LLM prose compaction only after deterministic metadata extraction works.
- Never overwrite existing episode blocks.

Exit criteria: old raw turns can be frozen into immutable episode blocks and selectively included by
the packer.
