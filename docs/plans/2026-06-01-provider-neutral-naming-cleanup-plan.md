# Provider-Neutral Naming Cleanup Plan

Date: 2026-06-01

## Summary

The repository has accumulated historical naming from two older ownership
layers:

- `opencode` names that now describe generic runtime/session concepts used by
  `claude-code`, `codex`, `xuanpu-agent`, and `terminal`.
- `hive` names inherited from the original app identity, now used for Xuanpu app
  session IDs, persisted store keys, MCP tool names, comments, and fixtures.

This is real cleanup debt, but it should not be handled as one broad rename.
Some names are internal and safe to rename; others are persisted schema,
localStorage keys, external MCP/tool identifiers, or backward-compatibility
paths. The safe path is staged: introduce neutral aliases first, migrate readers
and writers, then remove old names after compatibility tests prove no data loss.

The goal is not to remove all literal `opencode` or `hive` strings. True
provider-specific OpenCode code, legacy migration constants, and external
compatibility aliases should keep explicit names.

## Current Evidence

Rough scan of `src`, `test`, and `docs`:

- `opencode/OpenCode/openCode`: 292 files, about 965 source/test hits.
- `hive/Hive/HIVE`: 246 files, about 815 source/test hits.

High-density source files:

- `src/main/services/opencode-service.ts`
  - mostly legitimate OpenCode adapter code, but it also uses `hiveSessionId`
    for Xuanpu-side session IDs.
- `src/main/services/claude-code-implementer.ts`
  - uses `hiveSessionId` heavily for app session IDs.
  - persists Claude SDK session IDs into `sessions.opencode_session_id`.
- `src/main/services/codex-implementer.ts`
  - uses `hiveSessionId` heavily for app session IDs.
  - reads/writes runtime thread IDs through the same legacy session field.
- `src/main/ipc/agent-handlers.ts`
  - generic agent IPC persists `opencode_session_id` after connect/reconnect.
  - generic prompt routing resolves runtime by runtime session ID but still
    calls app session ID `hiveSessionId`.
- `src/renderer/src/components/session-hq/SessionShell.tsx`
  - local variable `opcSessionId` is actually a generic runtime session ID.
- `src/renderer/src/hooks/useSessionRuntimeConnection.ts`
  - accepts `opencodeSessionId` while handling all runtimes.
- `src/renderer/src/lib/session-types.ts`
  - exposes `OpenCodeMessage = TimelineMessage` as a compatibility alias.
- `src/renderer/src/lib/opencode-transcript.ts`
  - maps transcript shapes used outside pure OpenCode contexts.
- `src/renderer/src/lib/codex-timeline.ts`
  - imports `OpenCodeMessage` and uses `opencode_message_id` for Codex durable
    timeline rows.
- `src/shared/app-identity.ts`
  - correctly keeps legacy `.hive*` paths for one-time migration compatibility.

Existing guardrails:

- `test/phase-22/session-10/canonical-agent-protocol-guard.test.ts` already
  prevents `window.opencodeOps` and legacy opencode IPC naming from re-entering
  canonical protocol files.
- Production renderer code mostly uses `window.agentOps`; `window.opencodeOps`
  remains mostly in old tests/fixtures.

## Compatibility Retention Policy

Compatibility should not mean keeping every old name forever. Use three
different retention levels:

- **Internal code names: migrate and remove.** Local variables, props, function
  parameters, type aliases, and comments that are not persisted or externally
  observable should be renamed directly within the scoped phase. Once all call
  sites are moved, the old name should disappear from generic code.
- **Write compatibility: short migration window.** During a migration, write both
  the new neutral shape and the legacy shape. Keep this only long enough to
  cover upgrade and rollback confidence for the next release train. After that,
  stop writing legacy fields/keys from new code.
- **Read compatibility: long-lived.** Keep reading old SQLite columns,
  localStorage keys, and historical transcript/tool names for much longer. User
  machines can contain old records indefinitely, and some users may skip several
  versions before upgrading.
- **External protocol aliases: effectively permanent unless intentionally
  breaking.** Tool/MCP identifiers such as `mcp__hive-lsp__lsp` may exist in
  historical transcripts and runtime allowlists. Prefer adding the new
  `xuanpu-*` identity while continuing to classify/render the old one.

Practical implication:

- It is acceptable to remove `hiveSessionId` and `opencodeSessionId` variable
  names after migration.
- It is acceptable to stop writing `opencode_session_id` after the neutral DB
  column has shipped and backfilled safely.
- It is not safe to stop reading `opencode_session_id`, `opencode_message_id`,
  or `hive-*` localStorage keys until the project explicitly decides to drop old
  user-data compatibility.
- It is not safe to remove `hive-lsp` recognition unless old transcripts and
  external tool references are deliberately abandoned.

## Naming Categories

### Keep Explicitly Provider-Specific Names

These should stay unless the implementation itself changes:

- `src/main/services/opencode-service.ts`
- `src/main/services/opencode-activity-mapper.ts`
- `src/main/services/opencode-session-title.ts`
- `src/main/services/opencode-binary-resolver.ts`
- `src/main/services/opencode-event-dumper.ts`
- `src/shared/lib/opencode-classify.ts`
- OpenCode CLI commands, SDK imports, and runtime ID literals: `opencode`
- OpenCode-specific tests and fixtures

Risk of renaming these: low functional value, high confusion. They are correct
because they describe the OpenCode adapter boundary.

### Rename Internal App-Session Names

`hiveSessionId` is usually the Xuanpu database `sessions.id`, not a Hive runtime
entity. Candidate replacement:

- `appSessionId` for generic application session ID.
- `xuanpuSessionId` only when distinguishing from external app protocols is
  useful.

Targets:

- `AgentRuntimeAdapter.connect(worktreePath, hiveSessionId)`
- `AgentRuntimeAdapter.reconnect(..., hiveSessionId)`
- `claude-code-implementer.ts`
- `codex-implementer.ts`
- `xuanpu-agent-implementer.ts`
- `opencode-service.ts` internal routing maps
- `hub-controller.ts`, `hub-bridge.ts`, `hub-registry.ts`
- preload method args for `agentOps.connect/reconnect/planApprove/planReject`

Risk: medium. This is mostly TypeScript-local, but it spans all runtimes and
tests. Rename in one adapter at a time only after neutral interface names exist.

### Rename Generic Runtime Session Names

`opencodeSessionId` and `opcSessionId` often mean "runtime session ID" for
Claude, Codex, OpenCode, or Xuanpu Agent.

Candidate replacement:

- `runtimeSessionId`
- `agentSessionId` where it matches `session_activities.agent_session_id`

Targets:

- `SessionShell.tsx`
- `useSessionRuntimeConnection.ts`
- `useSessionTimeline.ts`
- `useSessionUsageHydration.ts`
- `useSessionComposerActions.ts`
- `useSessionPlanActions.ts`
- `usePendingMessageDrain.ts`
- `usePendingInitialMessageSender.ts`
- `useSessionUserMessageActions.ts`
- `useAgentEventBridge.ts`
- `useWorktreeStore.ts`
- `useSessionHistoryStore.ts`

Risk: medium. Renderer logic is broad, but most changes are local variable and
prop names. The dangerous edge is accidentally changing persisted field names
or IPC payload names before compatibility aliases exist.

### Migrate Persisted DB Fields Carefully

These are misnamed but persisted:

- `sessions.opencode_session_id`
- `session_messages.opencode_message_id`

They are now generic runtime/session concepts:

- `sessions.opencode_session_id` stores OpenCode session ID, Claude SDK session
  ID, Codex thread ID, and sometimes Xuanpu Agent runtime/session ID.
- `session_messages.opencode_message_id` stores OpenCode message IDs, Claude
  message IDs, Codex synthetic turn/message IDs, and Xuanpu Agent message IDs.

Preferred new names:

- `sessions.agent_session_id` or `sessions.runtime_session_id`
- `session_messages.agent_message_id` or `session_messages.runtime_message_id`

Recommended migration shape:

1. Add new nullable columns:
   - `sessions.runtime_session_id`
   - `session_messages.runtime_message_id`
2. Backfill from legacy columns.
3. Update all readers to use `COALESCE(runtime_session_id, opencode_session_id)`
   and `COALESCE(runtime_message_id, opencode_message_id)`.
4. Update all writers to write both columns for one migration cycle.
5. Update IPC/preload/shared types to expose neutral names while retaining
   legacy optional fields for compatibility.
6. After the migration window, stop writing legacy columns from new code, but
   keep legacy read fallback.
7. Physical column deletion should be deferred indefinitely or handled only in a
   later explicit data-format-breaking release.

Risk: high. This touches SQLite schema migration, indexes, unique constraints,
timeline recovery, usage analytics, reconnect, session history, and tests.

### Rename Shared Transcript/Timeline Aliases

Current examples:

- `OpenCodeMessage = TimelineMessage`
- `mapOpencodeMessagesToSessionViewMessages`
- `mapOpencodePartToStreamingPart`
- `opencode-transcript.ts`
- comments in `timeline-mappers.ts` and `session-timeline-service.ts`

Preferred direction:

- `TimelineMessage` for durable/rendered messages.
- `mapRawTranscriptToTimelineMessages`
- `mapRawPartToStreamingPart`
- `agent-transcript.ts` or `transcript-mappers.ts`

Compatibility shape:

1. Add neutral exports next to existing names.
2. Switch Session HQ and shared mappers to neutral exports.
3. Keep old exports as aliases only for legacy `SessionView` tests until
   SessionView deletion.
4. Delete alias exports when the legacy view is gone.

Risk: low to medium. Most of this is type/function naming, but Codex timeline
and legacy SessionView still depend on compatibility behavior.

### Handle `hive-*` Local Storage Keys as Data Migration

Current source examples:

- `hive-settings`
- `hive-theme`
- `hive-session-tabs`
- `hive-projects`
- `hive-worktree-order`
- `hive-layout`
- `hive-file-tree`
- `hive-command-palette`
- `hive-connections`
- `hive-spaces`
- `hive-shortcuts`
- `hive-prompt-history`

Preferred names:

- `xuanpu-settings`
- `xuanpu-theme`
- etc.

Migration strategy:

1. Add a small `createPersistentStorageName({ current, legacy })` helper or a
   Zustand storage wrapper.
2. On read, prefer current key; if missing, read legacy key and write current
   key.
3. Stop writing legacy keys after the migration helper proves stable.
4. Keep legacy read fallback long-term because users can skip releases and still
   have old browser storage.
5. Add focused tests for settings/theme/session tabs migration.

Risk: medium. A naive rename would reset user settings, tabs, themes, shortcuts,
and layout. Do not rename persist names without dual-read migration.

### Treat `hive-lsp` as External Protocol

Current examples:

- MCP server name: `hive-lsp`
- tool name: `mcp__hive-lsp__lsp`
- classifier/rendering checks in `ToolCard` and `opencode-classify`
- Claude allowed tools include `mcp__hive-lsp__lsp`

Preferred end state:

- New server/tool identity: `xuanpu-lsp` / `mcp__xuanpu-lsp__lsp`
- Compatibility alias: keep accepting/rendering `hive-lsp`.

Risk: high if renamed in place. MCP tool names are protocol-visible and may be
referenced in old transcripts, allowed tool lists, tests, and durable timeline
records.

### Clean Test-Only Legacy Names

Examples:

- Tests still mocking `window.opencodeOps` even though production canonical API
  is `window.agentOps`.
- Test fixtures using `hive-1` as generic session IDs.

Risk: low. This can be a mechanical cleanup after production aliases are in
place. Keep fixtures that intentionally cover legacy migration behavior.

## Recommended Plan

### Phase 0: Inventory Guardrails

Add a repository-level naming inventory test that classifies legacy names into
allowed buckets:

- provider-specific OpenCode adapter files
- legacy migration constants
- DB compatibility fields
- localStorage migration keys
- external MCP compatibility aliases
- tests/fixtures marked as legacy

This should extend the existing canonical protocol guard instead of replacing
it. The test should fail when new generic code introduces `opencodeSessionId`,
`OpenCodeMessage`, `hiveSessionId`, or `hive-*` persist names without an
explicit allowlist entry.

Suggested verification:

- `pnpm vitest run test/phase-22/session-10/canonical-agent-protocol-guard.test.ts`
- new naming inventory test

### Phase 1: Low-Risk Type and Function Alias Cleanup

Start with neutral aliases without DB migration:

- Add `TimelineMessage` exports where `OpenCodeMessage` is currently used as a
  generic renderer message type.
- Add neutral transcript mapper names while preserving old exports:
  - `mapRawTranscriptToTimelineMessages`
  - `mapRawPartToStreamingPart`
- Move generic code away from `opencode-transcript.ts` imports.
- Keep old names for legacy `SessionView` and old tests.

Verification:

- transcript mapper tests
- Codex timeline tests
- Session HQ timeline tests
- `pnpm lint`

### Phase 2: Renderer Runtime Session Naming

Rename renderer-local props and variables:

- `opencodeSessionId` -> `runtimeSessionId` or `agentSessionId`
- `opcSessionId` -> `runtimeSessionId`
- `OpenCodeMessage` props -> `TimelineMessage`

Do not rename DB fields in this phase. Keep the adapter at the boundary:

```ts
const runtimeSessionId = sessionRecord?.opencode_session_id ?? null
```

Verification:

- `useSessionRuntimeConnection` tests
- `SessionShell` tests
- smart scroll/session timeline tests
- manual smoke for Claude, Codex, OpenCode reconnect

### Phase 3: Main Runtime Interface Naming

Rename `hiveSessionId` to `appSessionId` in generic runtime interfaces and
implementers:

- `AgentRuntimeAdapter`
- `agent-handlers.ts`
- `hub-*`
- `claude-code-implementer.ts`
- `codex-implementer.ts`
- `xuanpu-agent-implementer.ts`
- OpenCode adapter internal maps where the value is the Xuanpu DB session ID

This phase is large but mostly TypeScript-local. Avoid DB schema changes here.

Verification:

- agent IPC tests
- Claude lifecycle tests
- Codex lifecycle tests
- OpenCode routing tests
- Xuanpu Agent dogfood/smoke tests
- hub tests

### Phase 4: DB Neutral Column Migration

Add neutral persisted columns and dual-write:

- `sessions.runtime_session_id`
- `session_messages.runtime_message_id`

Backfill from legacy columns. Update read paths to prefer neutral columns:

```sql
COALESCE(runtime_session_id, opencode_session_id)
COALESCE(runtime_message_id, opencode_message_id)
```

Update write paths to write both old and new columns for one release cycle.

Do not drop old columns in this phase. The exit criteria for this phase are:

- all production readers prefer neutral columns with legacy fallback;
- all production writers write neutral columns;
- legacy writes are isolated behind a clearly named compatibility helper;
- tests cover upgrade from rows with only legacy values.

After the next release train validates this path, remove legacy writes from new
code. Keep legacy reads.

Verification:

- DB migration tests
- session timeline service tests
- Codex durable read tests
- Claude transcript recovery tests
- OpenCode persistence tests
- usage analytics tests
- app restart/reconnect smoke

### Phase 5: localStorage `hive-*` Migration

Introduce dual-read storage names for persisted Zustand stores:

- current key: `xuanpu-*`
- legacy key: `hive-*`

Migrate store by store:

1. settings/theme
2. layout/file tree/sidebar state
3. session tabs/worktree order
4. projects/connections/spaces/shortcuts/prompt history

After a successful migration release, new writes should only target `xuanpu-*`
keys. The storage wrapper should keep reading `hive-*` keys and copying them
forward when no current key exists.

Verification:

- settings/theme migration tests
- session tabs migration tests
- manual startup with existing profile

### Phase 6: External `hive-lsp` Compatibility Rename

Add `xuanpu-lsp` while keeping `hive-lsp` accepted:

- register/allow the new MCP tool name
- classify both old and new names
- render old transcript rows correctly
- update generated prompts/tool allowlists to prefer the new name

Verification:

- Claude tool allowlist tests
- tool rendering tests
- old transcript replay test containing `mcp__hive-lsp__lsp`

### Phase 7: Remove Deprecated Aliases

Only after at least one compatibility cycle:

- remove old generic `OpenCodeMessage` aliases from new code and eventually from
  legacy UI tests once legacy `SessionView` is gone
- remove old test mocks for `window.opencodeOps`
- tighten naming guard allowlists
- stop legacy DB/localStorage writes once neutral write paths are stable

Do not treat this phase as permission to remove every legacy reader. Keep
low-cost read aliases for persisted user data and external protocol/tool names
unless there is an explicit breaking-change decision.

## Risk Register

| Area | Risk | Mitigation |
| --- | --- | --- |
| SQLite schema | Data loss or broken reconnect if `opencode_session_id` is renamed directly | Add neutral columns, backfill, dual-write, use `COALESCE` readers |
| Session reconnect | Claude/Codex/OpenCode route lookup can break because runtime session IDs differ from app session IDs | Keep boundary adapters and tests for `agent:connect`, `agent:reconnect`, `agent:prompt` |
| Timeline ordering | Codex/OpenCode durable timelines use legacy message ID fields | Rename after mapper tests and durable read tests are in place |
| Usage analytics | Codex/Claude sync uses `opencode_session_id` as thread/runtime ID | Migrate usage code in same DB phase as session runtime ID |
| localStorage | User settings/tabs/layout reset | Dual-read legacy keys and write current keys |
| MCP tool identity | `hive-lsp` rename can make old transcripts unrenderable or tools unavailable | Add `xuanpu-lsp` alias while keeping `hive-lsp` accepted |
| Tests | Mechanical rename can hide behavior regressions by updating assertions blindly | Keep behavior tests, add naming guard tests, avoid sweeping fixture-only churn early |
| Legacy SessionView | Old fallback still imports historical names | Finish SessionView deprecation first or keep explicit compatibility aliases |

## Suggested Commit Boundaries

1. `test: add provider-neutral naming guardrails`
2. `refactor: add neutral transcript mapper aliases`
3. `refactor: use timeline message naming in renderer`
4. `refactor: rename renderer runtime session variables`
5. `refactor: rename app session id variables in runtime adapters`
6. `db: add runtime session/message id compatibility columns`
7. `refactor: dual-write neutral runtime identifiers`
8. `refactor: migrate hive local storage keys with legacy fallback`
9. `refactor: add xuanpu-lsp alias while preserving hive-lsp`
10. `cleanup: remove deprecated naming aliases`

## Current Recommendation

Yes, this can be cleaned up, but not as a single rename PR.

Start with guardrails and low-risk aliases, then rename renderer/runtime locals,
and only then touch persisted DB/localStorage/external MCP names. The highest
risk items are `sessions.opencode_session_id`, `session_messages.opencode_message_id`,
and `hive-*` persisted keys. Those need compatibility migration rather than
direct replacement.

The long-term target is:

- no legacy names in generic internal code;
- no new writes to legacy DB/localStorage names after migration;
- continued reads for old persisted data;
- continued alias recognition for external historical protocol names such as
  `hive-lsp`.
