# Xuanpu Agent Runtime Based on oh-my-pi

Date: 2026-05-23
Status: Implementation spike in progress
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

- Should direct `@oh-my-pi/pi-ai` provider use remain only a spike path, or should Xuanpu add a
  runtime-owned provider abstraction before production exposure?
- Which provider is the initial dogfood target: Anthropic key, OpenAI key, or Ollama endpoint?
- Should Context Package traces store rendered markdown for every turn, or only section metadata by
  default with full rendered body behind a debug/privacy flag?
- Should `xuanpu-agent` sessions share the existing `session_messages` table shape or introduce a
  runtime-native transcript table?

## Immediate Next Steps

1. Dogfood the hidden no-tools `xuanpu-agent` path with a real provider API key.
2. Keep provider credentials environment-driven for the spike; decide later whether Xuanpu needs a
   runtime-native credential settings surface.
3. Add read/query helpers and focused tests for `field_context_packages`.
4. Add the first managed `transformContext` implementation before semantic compression.
5. Decide the native/tool strategy before exposing shell or file tools.

## Implementation Progress: 2026-05-23

Current branch: `feat/xuanpu-agent-oh-my-pi`.

Landed so far:

- Added `@oh-my-pi/pi-agent-core@15.2.4` and the `probe:xuanpu-agent-core` script.
- Extended the runtime id surfaces with `xuanpu-agent` across main, IPC, shared protocol, preload,
  renderer session/worktree/settings types, and database runtime persistence.
- Added `XuanpuAgentImplementer` as an experimental fourth runtime skeleton.
- Registered `xuanpu-agent` only when `XUANPU_AGENT_RUNTIME=1` is set.
- Kept Claude Code, Codex, OpenCode, and Terminal unchanged by default.
- Skipped existing Field Context prefix injection for `xuanpu-agent`, because this runtime must own
  final context assembly instead of receiving a rendered prefix.
- Added `field_context_packages` schema version 23 plus a repository for audit traces.
- Made the current `xuanpu-agent` prompt path persist the visible user message and record a context
  package trace before provider execution.
- Kept tools, permissions, plan mode, undo, fork, and production UI exposure disabled.

Latest no-tools provider progress:

- Added a direct `@oh-my-pi/pi-ai@15.2.4` dependency because Xuanpu now imports provider/model
  resolution directly instead of only pulling it transitively through `pi-agent-core`.
- Added `src/main/services/xuanpu-agent/model-config.ts` for model resolution. The spike defaults
  to `anthropic/claude-haiku-4-5`, maps existing runtime/provider ids such as `claude-code` to
  `anthropic`, and supports deterministic mock execution through `XUANPU_AGENT_MOCK_RESPONSE`.
- Added `src/main/services/xuanpu-agent/runtime.ts` with `XuanpuPiAgentSession`. It creates/reuses
  the oh-my-pi `Agent`, calls `setModel`, installs a conservative system prompt, forces
  `setTools([])`, subscribes to assistant message updates, streams text deltas, and returns final
  text/usage/raw message metadata.
- Updated `XuanpuAgentImplementer` so the prompt path now calls the no-tools pi Agent instead of
  returning the Phase 0 load-probe assistant message.
- Assistant responses are persisted to `session_messages` with provider/model/usage/raw metadata and
  emitted through the existing normalized `message.part.updated` / `message.updated` bridge.
- Context package decisions now record `phase: "phase-1-no-tools-provider"` and
  `providerExecution: "enabled"` for this runtime.

Current constraints:

- Real provider execution depends on oh-my-pi/pi-ai's environment/API-key handling. Xuanpu has not
  added a dedicated credential UI for this runtime yet.
- The `@oh-my-pi/pi-natives` compatibility alias is still intentionally limited. Shell/file/native
  tool parity is not available through `xuanpu-agent`.
- The runtime stores the raw pi assistant message in the existing message JSON payload for audit
  value during the spike. Size and privacy policy should be revisited before broad exposure.

### Packaging Findings

The direct Node probe still intentionally returns a handled failure:

```text
ERR_UNSUPPORTED_NODE_MODULES_TYPE_STRIPPING
```

This is expected because `@oh-my-pi/pi-agent-core@15.2.4` exports TypeScript source from
`node_modules`. Xuanpu cannot externalize that package in Electron main; it must bundle and
transpile the oh-my-pi TypeScript packages.

The Electron/Vite path now does that:

- `@oh-my-pi/pi-agent-core`, `@oh-my-pi/pi-ai`, and `@oh-my-pi/pi-utils` are excluded from
  `externalizeDepsPlugin` for main.
- `.md` and `.html` imports used by oh-my-pi are handled as raw text.
- The loader installs a minimal Bun compatibility global before dynamically importing the bundled
  `pi-agent-core` chunk.
- `@oh-my-pi/pi-natives` is aliased to a Xuanpu compatibility module for this runtime spike. It
  provides the small surface currently needed for package load and no-tools execution
  (`countTokens`, `Process`, `ProcessStatus`) without loading `.node` binaries through a bundled
  native loader.

This native alias is deliberate for the spike. It means shell/native oh-my-pi behavior is not
available through `xuanpu-agent` yet. That is acceptable because the next milestone is no-tools
provider execution, not local command/file tool parity.

### Verification Notes

Local pnpm linking was repaired after earlier timed-out installs by hydrating the missing store
artifacts and reinstalling offline with the frozen lockfile. Current verification:

```bash
pnpm run probe:xuanpu-agent-core
pnpm run probe:xuanpu-agent-no-tools
XUANPU_AGENT_RUNTIME=1 pnpm build
pnpm exec tsc -p tsconfig.node.json --noEmit --pretty false 2>&1 | rg "xuanpu-agent|xuanpu_agent|XuanpuAgent|model-config|pi-agent-core-loader" || true
node -e "const f=require('node:fs');const p=f.readdirSync('./out/main').find(x=>x.startsWith('pi-agent-core-loader-')&&x.endsWith('.js'));import('./out/main/'+p).then(async m=>console.log(await m.loadPiAgentCore()))"
```

Results:

- `probe:xuanpu-agent-core` exits `0` and documents the direct Node import failure as expected.
- `probe:xuanpu-agent-no-tools` exercises the wrapped runtime with a deterministic mock provider. It
  verifies `setTools([])`, text deltas, final response shape, and abort-on-dispose behavior without
  requiring Electron or a real API key.
- `XUANPU_AGENT_RUNTIME=1 pnpm build` passes.
- The scoped `tsconfig.node.json` grep reports no `xuanpu-agent` TypeScript errors. Full node
  `tsc --noEmit` still reports unrelated pre-existing runtime manager / GraphQL type errors.
- Direct import of the built `pi-agent-core-loader-*` chunk succeeds and returns the exported
  `pi-agent-core` keys.

## Implementation Progress: 2026-05-24

Task 2 and the minimal Task 3 bridge are now partially landed:

- Added `getFieldContextPackage()` and `listFieldContextPackages()` in
  `src/main/field/context-package-repository.ts`.
- Query helpers parse `sections_json` and `decisions_json`, filter by session/worktree/runtime, and
  support deterministic ordering plus a bounded limit.
- Read helpers hide full `rendered_markdown` by default. Callers must opt in with
  `includeRenderedMarkdown: true`, and the record exposes `renderedMarkdownStored` so a debugger can
  show whether full markdown exists without loading it.
- `xuanpu-agent` no longer stores full rendered Field Context markdown by default. Set
  `XUANPU_AGENT_STORE_CONTEXT_MARKDOWN=1` to store it during debugging.
- Context package decisions now record the rendered-markdown policy and the context transform
  decisions.
- Added read-only debug IPC/preload APIs for managed context traces:
  `field:listContextPackages` and `field:listEpisodeBlocks`.
- Added shared renderer-facing debug types for context package sections and episode block records.
- Extended the dev-only `FieldContextDebug` panel with `Managed Context` and `Episode Blocks` tabs.
  The panel uses the runtime session id first, falls back to the Hive session id, and displays
  included/excluded sections, decisions JSON, rendered-markdown storage state, frozen episode
  metadata, extracted files/commands/constraints/failures, and raw refs.
- Added `src/main/services/xuanpu-agent/context-transform.ts`, which builds the first Xuanpu-owned
  `messages[]` boundary for oh-my-pi Agent:
  - Xuanpu context anchor
  - current Field Context markdown when available
  - recent complete visible user/assistant turns
  - current user message last
- The transform deliberately drops old turns instead of summarizing or truncating retained messages;
  semantic compression remains disabled.
- `XuanpuAgentImplementer` now sends the transformed message array to `XuanpuPiAgentSession` while
  still persisting only the user-authored visible message and assistant response in
  `session_messages`.
- The transform now distinguishes retrieved episode context from stored frozen episode blocks. When
  episodes are selected by the gated retrieval policy, they are emitted as
  `<xuanpu-retrieved-episodes>` before the recent raw working set.

Focused verification:

```bash
pnpm vitest run test/phase-24/field-managed-debug-handlers.test.ts test/phase-24/field-context-debug-managed.test.tsx test/phase-24/xuanpu-agent-episode-retrieval.test.ts test/phase-24/xuanpu-agent-gated-retrieval-package.test.ts test/phase-24/xuanpu-agent-context-transform.test.ts test/phase-24/field-context-package-repository.test.ts test/phase-24/xuanpu-agent-runtime.test.ts
```

Results:

- Context transform test proves ordering, current-user-last, field context injection, drop decisions,
  and no semantic compression.
- Context package repository test proves v23 migration SQL coverage, create/read/list behavior, and
  privacy-by-default rendered markdown reads without relying on native `better-sqlite3` in Node
  Vitest.
- Managed debug handler/component tests prove scoped package and episode IPC reads, query
  validation, fallback Hive session lookup, and visible included/excluded package sections plus
  frozen episode metadata in the dev debugger.
- Gated retrieval tests prove unrelated prompts do not retrieve stored episodes, file-path matches
  select only relevant episodes, historical/short referential prompts retrieve recent episodes, token
  and count limits are enforced, and `XuanpuAgentImplementer` records available-vs-retrieved
  sections plus retrieval decisions in `field_context_packages`.
- Runtime test still proves deterministic no-tools provider flow.

Task 4 base layer is now partially landed:

- Added schema v24 with `field_episode_blocks`, plus idempotent database repair.
- Added `src/main/field/episode-block-repository.ts`.
- Episode blocks are append-only at the repository layer: there are create/get/list helpers, but no
  update/delete helper. Existing blocks are not overwritten.
- `createFieldEpisodeBlock()` requires non-empty `rawRefs`; this keeps every frozen block auditable
  back to raw session messages/events/manual refs.
- Added `createRuleBasedEpisodeFromTurns()` as the first deterministic episode creator. It freezes
  raw visible turns and extracts files, commands, failures, constraints, key facts, token estimate,
  confidence, and source message bounds without LLM compaction.
- `xuanpu-agent` context packaging now queries episode block candidates and records both
  `frozen_episodes` availability and `retrieved_episodes` inclusion in `field_context_packages`.
- The context transform now places retrieved episodes after Field Context and before recent raw
  visible turns, preserving the current user message as the final message.
- Added a first automatic freeze policy for `xuanpu-agent`: after a successful turn, Xuanpu keeps the
  latest 6 visible user/assistant messages raw and freezes older unreferenced visible messages once
  at least 4 are eligible.
- The freezer skips messages already referenced by existing episode blocks, so later turns do not
  overwrite or duplicate frozen raw refs.
- Episode blocks are now inspectable from the dev-only Field Context debugger through the same
  read-only `field:listEpisodeBlocks` IPC/preload path used by the managed context tab.
- Added the first deterministic gated retrieval policy for stored episode blocks. It retrieves
  episodes only when the current prompt has an explicit historical reference, short referential
  wording, matching file path, matching command, error signal, or constraint signal. File matches
  outrank commands, failures, constraints, historical references, and recency.
- `field_context_packages.sections_json` now records `frozen_episodes` as available-but-not-sent and
  `retrieved_episodes` as the actually included prompt context, so the debugger can show why an old
  episode was or was not sent.

Focused verification:

```bash
pnpm vitest run test/phase-24/field-episode-block-repository.test.ts test/phase-24/xuanpu-agent-episode-freezer.test.ts test/phase-24/xuanpu-agent-auto-freeze.test.ts test/phase-24/xuanpu-agent-episode-retrieval.test.ts test/phase-24/xuanpu-agent-gated-retrieval-package.test.ts test/phase-24/xuanpu-agent-context-transform.test.ts test/phase-24/field-context-package-repository.test.ts test/phase-24/xuanpu-agent-runtime.test.ts
```

Results:

- Episode repository test proves v24 migration SQL, append insert/read/list behavior, mandatory raw
  refs, and rule-based extraction for files/commands/failures/constraints.
- Episode freezer tests prove the keep-recent policy, no duplicate freezing for already referenced
  raw messages, and successful invocation from `XuanpuAgentImplementer`.
- Episode retrieval tests prove the gated policy and package trace decisions.
- Context transform test proves retrieved episodes are included in the hidden message boundary and
  that current user text remains last.

Latest hidden-runtime IPC progress:

- Added `test/phase-24/xuanpu-agent-ipc-smoke.test.ts` and the
  `probe:xuanpu-agent-ipc-smoke` script.
- The smoke registers the real `agent:*` IPC handlers with `AgentRuntimeManager` and
  `XuanpuAgentImplementer`, then connects and prompts a hidden `xuanpu-agent` session through the
  same path used by Session HQ.
- The test uses the deterministic mock provider, persists the runtime session id, verifies visible
  `session_messages` contain only the user-authored text plus assistant response, records a
  `field_context_packages` trace, emits the original `session.message`, and confirms no
  `[User Message]` Field Context prefix is injected for `xuanpu-agent`.
- The pi Agent prompt boundary is asserted to be a Xuanpu-owned message array with the current user
  message last, and the runtime still calls `setTools([])` so shell/file tools remain disabled.
- Tightened `agent:prompt` and `agent:steer` message normalization in
  `src/main/ipc/agent-handlers.ts` so only the runtime adapter's supported `text` and `file` parts
  cross the IPC/runtime boundary.

Additional verification:

```bash
pnpm run probe:xuanpu-agent-ipc-smoke
pnpm exec tsc -p tsconfig.node.json --noEmit --pretty false 2>&1 | rg "xuanpu-agent-ipc-smoke|xuanpu-agent|agent-handlers" || true
```

Results:

- The IPC smoke passes.
- The scoped node TypeScript grep reports no `xuanpu-agent`, `agent-handlers`, or smoke-test type
  errors after narrowing IPC message parts.

## Next Task Plan

### Task 1: Minimal No-Tools Provider Call

Status: implemented for the managed wrapper, mock probe, and hidden Session HQ IPC path; pending
real provider/UI dogfood.

- Use `XUANPU_AGENT_RUNTIME=1` to register the runtime and real provider env vars such as
  `ANTHROPIC_API_KEY` or `OPENAI_API_KEY` according to the selected bundled pi-ai provider.
- Keep reusing existing model selection where possible; avoid a separate settings surface until the
  real-provider spike shows it is needed.
- Validate the text-only path from the desktop UI with one provider first.
- Keep shell/file tools, permission prompts, slash commands, plan mode, undo, and fork disabled.
- Keep the IPC smoke as the fast regression check; add a real-provider/Electron UI dogfood check
  once credentials and provider target are selected.

Exit criteria: a hidden `xuanpu-agent` session can answer a simple prompt from Session HQ.

### Task 2: Context Package Trace Hardening

Status: implemented for repository create/read/list, query filtering, migration SQL coverage,
rendered markdown privacy defaults, and a dev-only renderer/debugger surface. Still needs a
first-class production Context Budget Debugger later.

- Add read/query helpers for `field_context_packages`.
- Store enough section metadata for a future Context Budget Debugger.
- Decide whether full rendered context markdown is always stored or guarded behind a debug/privacy
  setting.
- Add a focused test around trace insertion and schema migration.

Exit criteria: every `xuanpu-agent` turn has an auditable record of what the runtime packaged.

### Task 3: Minimal Context Transform

Status: minimal backend bridge implemented and covered by unit tests; pending real-provider/UI
dogfood from the hidden runtime.

- Implement a conservative `transformContext` bridge with anchor, current Field Context, latest
  user/assistant exchanges, and current user message last.
- Pass the transformed context to oh-my-pi Agent through a Xuanpu-owned context boundary instead of
  relying on visible prompt prefixing.
- Keep visible transcript messages user-authored; do not persist injected context as chat text.
- Store inclusion and exclusion decisions for dropped old turns.
- Avoid semantic compression of code, diffs, and tool output in this phase.

Exit criteria: Xuanpu owns final `messages[]` for `xuanpu-agent` while preserving transcript clarity.

### Task 4: Append-Only Episodes

Status: schema/repository/rule-based creation, automatic old-turn freezing, packer inclusion, and
dev-only inspection implemented. Still needs a first-class production UI and a future LLM prose
compactor after deterministic extraction stabilizes.

- Add `field_episode_blocks` after the no-tools loop is usable.
- Implement rule-based episode creation first.
- Add LLM prose compaction only after deterministic metadata extraction works.
- Keep raw refs mandatory and never overwrite existing episode blocks.

Exit criteria: old raw turns can be frozen into immutable blocks and selectively included by the
packer.

### Task 4.5: Gated Episode Retrieval

Status: first deterministic backend policy implemented and covered by focused tests; pending
real-provider/UI dogfood.

- Trigger retrieval only on explicit historical references, short referential prompts, file path
  matches, command matches, error signals, or constraint signals.
- Prefer deterministic ranking: file path > command > error/failure > constraint > historical
  reference > recency.
- Record candidate count, trigger set, included ids, scores, and token/count limits in the context
  package decisions.
- Keep vector similarity and LLM-based recall out of v1.

Exit criteria: old episodes are not sent every turn, but are included when the current request
clearly needs them.

### Task 5: Native/Tool Surface Decision

- Decide whether to keep the `pi-natives` compatibility alias long term, externalize the real native
  package with explicit packaging rules, or isolate native use in a separate wrapper package.
- Map Xuanpu's permission model before enabling any oh-my-pi shell/file tools.
- Treat Claude Code/Codex/OpenCode parity as out of scope until the managed no-tools loop is stable.

Exit criteria: native/tool execution has an explicit packaging and safety policy before it is exposed.
