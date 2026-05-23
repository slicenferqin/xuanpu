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
  Non-strict mode now reports `ok: true` with
  `status: "expected-direct-node-import-failure"` so the aggregate spike probe does not look like a
  failed health check. Set `XUANPU_AGENT_CORE_PROBE_STRICT=1` to make the direct Node failure exit
  non-zero.
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
- The same smoke now passes an explicit Session HQ-style model override and proves it is recorded in
  the managed context package and emitted on the `session.message` field event.
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

Latest hidden UI dogfood progress:

- Extended `system:detectAgentRuntimes` so `xuanpu-agent` is reported only when
  `XUANPU_AGENT_RUNTIME=1` is present. This keeps the runtime hidden in normal builds while giving
  dogfood builds a real UI entry point.
- Added the gated `xuanpu-agent` option to New Session, the Session Tabs right-click provider menu,
  and the unlocked Session HQ provider capsule.
- Updated `XuanpuAgentImplementer.getAvailableModels()` to return the same provider-array shape as
  the other runtimes, so `ModelSelector` can populate a default dogfood model instead of failing on
  the previous nested provider object.
- In real-provider mode the default visible model is `anthropic/claude-haiku-4-5`; when
  `XUANPU_AGENT_MOCK_RESPONSE` is set, the UI lists the deterministic `xuanpu-agent-mock` model.
- `SessionShell` now passes the same effective provider/model to `SessionHeader` that it uses for
  the actual `agentOps.prompt()` call. This keeps the readiness capsule aligned with the selected
  `xuanpu-agent` session model even when no global settings default is present.
- Added a Session HQ mock dogfood test that connects a hidden `xuanpu-agent` session, sends a prompt
  through `ComposerBar`, verifies the selected model passed to the backend, and opens Context Budget
  Debugger against the runtime session id.

Additional verification:

```bash
pnpm vitest run test/phase-24/xuanpu-agent-ui-gate.test.tsx test/phase-24/xuanpu-agent-model-list.test.ts test/phase-22/session-2/system-info-codex-detection.test.ts test/phase-24/xuanpu-agent-ipc-smoke.test.ts test/phase-24/xuanpu-agent-session-shell-dogfood.test.tsx
```

Results:

- Runtime detection now proves the experimental UI gate stays off by default and turns on only with
  `XUANPU_AGENT_RUNTIME=1`.
- The new-session helper proves `xuanpu-agent` is absent from normal provider choices and present in
  dogfood mode.
- The model-list test proves both real-provider default and deterministic mock-provider shapes are
  compatible with the existing renderer model selector.
- The Session HQ mock dogfood test proves the no-tools UI path can connect, prompt, and inspect
  managed context package metadata without provider credentials.

Latest native/tool policy progress:

- Added `src/main/services/xuanpu-agent/tool-policy.ts` as the single backend policy for the
  current `xuanpu-agent` tool surface.
- The policy is explicit: no shell tools, file tools, MCP tools, permission prompts, undo/redo, or
  native process control are available until Xuanpu owns the permission and checkpoint model.
- `XuanpuPiAgentSession` now gets its system prompt and oh-my-pi tool list from that policy, and
  asserts the tool list is empty before calling `Agent.setTools()`.
- The `@oh-my-pi/pi-natives` compatibility alias remains the packaging strategy for the spike, but
  process control is inert: `killTree()` returns `0`, `terminate()` returns `false`, and
  `fromPath()` returns no processes.
- Added `test/phase-24/xuanpu-agent-tool-policy.test.ts` to lock the policy, runtime capability
  flags, prompt wording, empty tool list, and inert native process behavior.
- Extended the no-tools policy with explicit tool-surface readiness gates. Shell/file/MCP tools
  remain blocked until Xuanpu has a permission policy, checkpoint policy, audit trail, native
  packaging decision, UI capability gate, and MCP boundary. Any non-empty oh-my-pi tool list now
  fails with the unmet gate ids.

Additional verification:

```bash
pnpm vitest run test/phase-24/xuanpu-agent-tool-policy.test.ts test/phase-24/xuanpu-agent-runtime.test.ts test/phase-24/xuanpu-agent-ipc-smoke.test.ts
```

Results:

- The no-tools runtime still calls oh-my-pi with `setTools([])`.
- Attempts to install a non-empty tool list now fail at the Xuanpu policy boundary.
- Native process control exposed by the compatibility alias is non-operational in this runtime.
- The tool-surface readiness test locks the unresolved gates:
  `permission-policy`, `checkpoint-policy`, `tool-audit`, `native-packaging`, `ui-capability-gate`,
  and `mcp-boundary`.

Latest verification matrix progress:

- Added `probe:xuanpu-agent-spike` as the fast aggregate health check for the current branch. It
  runs the core packaging probe, all xuanpu-agent model/runtime/context/episode/tool/UI focused
  tests, and the safe default real-provider probe.
- Added `probe:xuanpu-agent-spike:build` for the heavier pre-merge path: aggregate probe plus
  `XUANPU_AGENT_RUNTIME=1 pnpm build` plus a built-artifact mock dogfood probe.
- Added `probe:xuanpu-agent-built-mock`, which loads the built
  `out/main/xuanpu-agent-implementer-*` chunk, installs Electron main-process mocks, runs
  `connect -> prompt -> persist` with `XUANPU_AGENT_MOCK_RESPONSE`, and verifies the visible
  transcript contains only the user prompt and assistant response.
- The built mock probe now also installs a probe-only fake `better-sqlite3` layer so the packaged
  `XuanpuAgentImplementer` can record a real managed context package without depending on the local
  Node/Electron native SQLite ABI. It verifies the packaged context package keeps the selected
  provider/model and `persist-user-authored-message-only` transcript policy.
- Added a no-op `bun:sqlite` compatibility alias for the main-process build. This keeps pi-ai
  cache/auth-storage imports loadable in Electron/Node without granting xuanpu-agent a real
  runtime-owned SQLite credential store.

Additional aggregate verification:

```bash
pnpm run probe:xuanpu-agent-spike
```

Results:

- Core probe reports the expected direct Node import limitation in non-strict success mode.
- 18 focused test files pass, covering 55 tests across model readiness, runtime status, no-tools
  runtime, IPC smoke, UI gate, managed context packages, Context Budget Debugger, episode
  repository/freezer/retrieval, and tool-surface gates.
- Real-provider probe defaults to `status: "skipped"` without touching network credentials.

Heavier built-artifact verification:

```bash
pnpm run probe:xuanpu-agent-spike:build
```

Results:

- Builds with `XUANPU_AGENT_RUNTIME=1`.
- The built mock dogfood probe loads the emitted `xuanpu-agent-implementer` chunk and confirms the
  hidden runtime can answer one text prompt without provider credentials.
- The same built probe now verifies a packaged managed context package with the selected model and
  transcript policy, using an in-memory probe SQLite shim to avoid local native ABI drift.
- The emitted `out/main` bundle no longer contains a bare `bun:sqlite` import.
- This still does not prove real-provider or full Electron UI dogfood; it proves the packaged
  no-tools runtime path is executable and transcript-safe.

Latest provider/model readiness progress:

- Confirmed the default model configured in `src/main/services/xuanpu-agent/model-config.ts` is
  present in bundled `@oh-my-pi/pi-ai@15.2.4`: `anthropic/claude-haiku-4-5`.
- Confirmed `pi-ai` resolves provider credentials from environment variables for the spike. The
  first dogfood target can use `ANTHROPIC_API_KEY`; OpenAI-compatible testing can use
  `OPENAI_API_KEY`.
- Confirmed provider aliases are intentionally narrow for now: `claude-code -> anthropic`,
  `codex -> openai`, and `gemini -> google`.
- Directly importing the built app chunks from plain Node is not a reliable provider-readiness
  check because the built main graph still expects Electron process assumptions. Provider readiness
  should be validated through focused tests/probes or the hidden desktop UI path after
  `XUANPU_AGENT_RUNTIME=1 pnpm build`.
- Added `test/phase-24/xuanpu-agent-model-config.test.ts` to lock the default model, explicit model
  override precedence, existing runtime provider aliases, and unsupported-model diagnostics without
  requiring a real API key.
- Added `probe:xuanpu-agent-model-readiness` as the fast regression check for model config plus
  renderer-facing model-list compatibility.
- Added `probe:xuanpu-agent-real-provider` as an opt-in real provider probe. By default it exits
  with `status: "skipped"` and does not access the network. It only calls a provider when
  `XUANPU_AGENT_REAL_PROVIDER_PROBE=1` is set, `XUANPU_AGENT_MOCK_RESPONSE` is unset, a required
  provider credential env var is present, and a built `out/main/xuanpu-agent-implementer-*` chunk
  exists.
- The real-provider probe now shares the built-probe SQLite shim used by the mock probe. When a
  real key is available, the same run verifies provider response persistence plus the packaged
  managed context package, selected provider/model, and transcript policy.
- Added a runtime credential preflight in `src/main/services/xuanpu-agent/model-config.ts`.
  Real-provider execution now fails before creating or prompting a pi Agent when required env vars
  are missing. Deterministic mock execution remains exempt.
- Added `system:getXuanpuAgentRuntimeStatus` and `window.systemOps.getXuanpuAgentRuntimeStatus()`.
  Session HQ now shows a small `Mock` or `Env` status capsule for `xuanpu-agent` sessions so the
  hidden runtime can expose mock mode and missing provider env vars before the first send.
- Added `xuanpu-agent-session-header-status.test.tsx` to lock the Session HQ status capsule behavior
  and ensure it checks credentials against the selected provider/model, not only the default model.
- No real API key has been used in this branch yet. The remaining Task 1 blocker is still a
  real-provider dogfood run through the hidden `xuanpu-agent` UI entry point.

Latest Context Budget Debugger progress:

- Added `src/renderer/src/components/sessions/ContextBudgetDebugger.tsx` as a production-visible
  managed context inspector for `xuanpu-agent` sessions in Session HQ.
- The panel reads `field_context_packages` through the existing debug IPC path with
  `includeRenderedMarkdown: false`, so the first production view shows section metadata and
  decisions without loading full rendered context by default.
- It shows latest package budget profile, approximate tokens, included/excluded section counts,
  retrieved episode count, frozen episode candidate count, per-section source/reason metadata, model
  id, rendered-markdown policy, and decisions JSON.
- Extended the panel with an `Episodes` tab backed by `field:listEpisodeBlocks`. It shows frozen
  episode title, kind, confidence, token estimate, summary, files, commands, constraints, failures,
  message bounds, and raw-ref count/details.
- `SessionShell` only mounts this first-class panel for `agentSdk === "xuanpu-agent"`, leaving
  Claude Code, Codex, and OpenCode UI unchanged.
- Added `test/phase-24/context-budget-debugger.test.tsx` to lock fallback session lookup and the
  privacy-preserving package read behavior plus frozen episode rendering.

Additional verification:

```bash
pnpm run probe:xuanpu-agent-model-readiness
pnpm run probe:xuanpu-agent-real-provider
env -u ANTHROPIC_API_KEY -u ANTHROPIC_OAUTH_TOKEN -u ANTHROPIC_FOUNDRY_API_KEY \
  XUANPU_AGENT_REAL_PROVIDER_PROBE=1 node scripts/xuanpu-agent-real-provider-probe.mjs || test $? -eq 1
```

Results:

- `xuanpu-agent-model-config.test.ts` and `xuanpu-agent-model-list.test.ts` pass.
- The model readiness probe covers default model resolution, aliases, unsupported-model errors,
  credential requirements, mock credential bypass, and ModelSelector-compatible provider list shape.
- The real-provider probe defaults to a safe skip without touching network credentials.
- With the real-provider flag enabled but Anthropic credentials removed, the probe fails before any
  provider call and reports the required env vars.
- With credentials, the real-provider probe is now expected to also report a packaged
  `contextPackage` block with selected model metadata and `persist-user-authored-message-only`.
- `xuanpu-agent-runtime.test.ts` proves the runtime also fails before creating a pi Agent when
  real-provider credentials are missing.
- `xuanpu-agent-runtime-status.test.ts` proves disabled, missing-credentials, mock-ready, and ready
  states, including explicit provider/model overrides, without revealing secrets or calling
  providers.
- `context-budget-debugger.test.tsx` proves the production panel reads managed packages with
  `includeRenderedMarkdown: false`, uses runtime-session then Hive-session fallback, and renders
  included/excluded package sections plus frozen episode metadata.

Real-provider dogfood command shape:

```bash
XUANPU_AGENT_RUNTIME=1 pnpm build
XUANPU_AGENT_REAL_PROVIDER_PROBE=1 ANTHROPIC_API_KEY=... \
  pnpm run probe:xuanpu-agent-real-provider
```

Optional overrides:

```bash
XUANPU_AGENT_PROVIDER_ID=openai XUANPU_AGENT_MODEL_ID=gpt-4.1 OPENAI_API_KEY=...
```

## 2026-05-24 Checkpoint

Current scope for this push:

- Added a main-process runtime status resolver for the hidden `xuanpu-agent` runtime. It reports
  whether the runtime is disabled, mock-ready, credential-ready, or blocked by missing provider
  env vars for the default model or an explicit provider/model override.
- Exposed that status through `system:getXuanpuAgentRuntimeStatus` and
  `window.systemOps.getXuanpuAgentRuntimeStatus()` with shared preload types.
- Added a Session HQ status capsule for `xuanpu-agent` sessions. The capsule can show `Mock`, `Env`,
  or `Off` and its tooltip lists provider/model, missing env keys, and the still-blocked tool gates.
- Added focused tests for disabled, missing-credential, mock-ready, and ready states. The status
  path intentionally reports only env key names and boolean presence, not secret values.
- Added a SessionHeader UI test that verifies the status capsule calls the runtime-status IPC with
  the current `xuanpu-agent` provider/model and hides itself when that provider is ready.
- Added a SessionShell dogfood regression that verifies the status capsule, prompt call, and Context
  Budget Debugger all use the same session-selected provider/model/runtime id.
- Extended the opt-in real-provider probe so a credentialed run verifies the same packaged context
  package path as the built mock probe: persisted provider answer, selected provider/model,
  transcript policy, and package section ids.
- Kept the current runtime strict no-tools: shell/file/MCP tools, permission prompts, native process
  control, and oh-my-pi tool surfaces remain blocked behind explicit readiness gates.

Follow-up sequence:

- Run one real-provider dogfood pass through the built hidden runtime after credentials are
  available. This should now produce both provider-response evidence and context-package evidence
  in a single probe output.
- Then run the full Session HQ UI dogfood with `XUANPU_AGENT_RUNTIME=1`, validating that the status
  capsule matches the actual provider path before the first prompt and after a successful answer.
- After real-provider and UI dogfood pass, decide whether to keep `xuanpu-agent` inside this repo for
  the next iteration or extract it into an independently maintained agent package/repo.
- Only revisit shell/file/MCP tools after Xuanpu has an explicit permission and packaging policy for
  the oh-my-pi tool surface.

## Next Task Plan

### Task 1: Minimal No-Tools Provider Call

Status: implemented for the managed wrapper, mock probe, model resolution readiness probe, hidden
Session HQ IPC path, environment-gated UI entry points, credential preflight, and an opt-in
real-provider probe. Built-artifact mock dogfood is now automated; pending one actual real-provider
dogfood run with credentials. Session HQ can now show mock/missing-credential runtime status before
the first prompt.

- Use `XUANPU_AGENT_RUNTIME=1` to register the runtime and real provider env vars such as
  `ANTHROPIC_API_KEY` or `OPENAI_API_KEY` according to the selected bundled pi-ai provider.
- Keep reusing existing model selection where possible; avoid a separate settings surface until the
  real-provider spike shows it is needed.
- Validate the text-only path from the desktop UI with one provider first. The UI path is now
  selectable only when `XUANPU_AGENT_RUNTIME=1` is set.
- Keep shell/file tools, permission prompts, slash commands, plan mode, undo, and fork disabled.
- Keep the IPC smoke as the fast regression check; use `probe:xuanpu-agent-real-provider` for a
  provider call through the built runtime before the full Electron UI dogfood pass.
- Use `probe:xuanpu-agent-built-mock` after `XUANPU_AGENT_RUNTIME=1 pnpm build` as the credential-free
  packaging/runtime sanity check.

Exit criteria: a hidden `xuanpu-agent` session can answer a simple prompt from Session HQ.

### Task 2: Context Package Trace Hardening

Status: implemented for repository create/read/list, query filtering, migration SQL coverage,
rendered markdown privacy defaults, a dev-only deep debugger surface, and a first production-visible
Context Budget Debugger for `xuanpu-agent` Session HQ.

- Add read/query helpers for `field_context_packages`.
- Store enough section metadata for a future Context Budget Debugger.
- Decide whether full rendered context markdown is always stored or guarded behind a debug/privacy
  setting.
- Add a focused test around trace insertion and schema migration.

Exit criteria: every `xuanpu-agent` turn has an auditable record of what the runtime packaged, and
Session HQ can inspect the latest package metadata without loading full rendered context by default.

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

Status: schema/repository/rule-based creation, automatic old-turn freezing, packer inclusion,
dev-only inspection, and first production-visible Session HQ inspection implemented. Future LLM
prose compaction remains deferred until deterministic extraction stabilizes.

- Add `field_episode_blocks` after the no-tools loop is usable.
- Implement rule-based episode creation first.
- Add LLM prose compaction only after deterministic metadata extraction works.
- Keep raw refs mandatory and never overwrite existing episode blocks.

Exit criteria: old raw turns can be frozen into immutable blocks, selectively included by the
packer, and inspected from Session HQ without mutating the append-only records.

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

Status: v1 policy implemented and test-locked for the no-tools spike. Native process control and
oh-my-pi shell/file/MCP tools are intentionally inert; enabling them requires clearing explicit
tool-surface readiness gates first.

- Decide whether to keep the `pi-natives` compatibility alias long term, externalize the real native
  package with explicit packaging rules, or isolate native use in a separate wrapper package.
- Map Xuanpu's permission model before enabling any oh-my-pi shell/file tools.
- Treat Claude Code/Codex/OpenCode parity as out of scope until the managed no-tools loop is stable.

Exit criteria: native/tool execution has an explicit packaging and safety policy before it is exposed.
Current v1 exit state is a blocked policy, inert native compatibility alias, and tests that fail any
attempt to expose a non-empty oh-my-pi tool list before the required gates are satisfied.
