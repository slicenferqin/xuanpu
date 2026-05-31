# Usage Metrics Accuracy Audit

> Date: 2026-05-28
> Scope: right-side worktree overview panel, current context-window usage, session total cost.
> Goal: make displayed numbers reproducible from provider/raw data. Unknown or partial data must be marked as such instead of shown as authoritative zero.

## Executive Conclusion

The current chain has one confirmed correctness bug and several structural risks.

Confirmed bug: Codex usage persistence is wrong. `CodexImplementer.persistCodexTurnUsage()` stores one row per `turnId` and upserts repeated `thread/tokenUsage/updated` events into `source_message_id='codex-turn:<turnId>'`. The local evidence shows Codex emits multiple `token_count` usage events inside a single turn, and `tokenUsage.last` is the delta for one provider usage event, not the final total of that turn. Upserting by turn overwrites previous deltas and undercounts both total tokens and cost by about 90% in the checked session.

Claude usage for the two provided IDs is currently consistent with the raw Claude JSONL after the current reader's intended de-duplication by assistant `message.id`. The old diagnosis that `syncClaudeSession` deletes all rows before reading the transcript is stale for this worktree: the current code uses `upsertUsageEntry()` and preserves existing rows when the transcript is missing.

The right-side worktree overview is still not a trustworthy source of truth because the renderer aggregates mixed sources: per-session DB summaries plus in-memory live snapshots. It also loops over all sessions in a worktree while the analytics backend only supports `claude-code` and `codex`, silently dropping unsupported sessions such as `opencode` and `xuanpu-agent`.

The context-window indicator and usage totals are currently overloaded into the same `session.context_usage` payload, but they are different metrics:

- Context-window usage means current prompt/context occupancy, for example "168,829 of 258,400 tokens".
- Session usage total means cumulative billable/provider usage across all model calls in the session, for example "9,919,327 total tokens".

Those should be persisted and queried as separate concepts.

## Tested Session IDs

The two IDs provided by the user are both runtime/source IDs, not Xuanpu internal `sessions.id`.

| User label | Provided ID | Xuanpu `sessions.id` | DB `agent_sdk` | Worktree | Raw source found |
| --- | --- | --- | --- | --- | --- |
| Claude | `7098db9d-7373-44ff-850d-98393bf1d732` | `479fc978-7a67-4117-9cac-659642e70782` | `claude-code` | `feat/xuanpu-agent-oh-my-pi` | `~/.claude/projects/-Users-slicenfer--xuanpu-worktrees-xuanpu-xuanpu--schnauzer/7098db9d-7373-44ff-850d-98393bf1d732.jsonl` |
| "Codex" as provided | `d5813586-bc96-4f9f-9588-8f02aea17b8c` | `32ccde6a-3347-4fab-b2e0-4a57c1c66738` | `claude-code` | `release/v1.4.9` | `~/.claude/projects/-Users-slicenfer--xuanpu-worktrees-xuanpu-xuanpu--release/d5813586-bc96-4f9f-9588-8f02aea17b8c.jsonl` |

Important: the second ID is not a Codex session in the local DB or logs. It is a Claude Code runtime session. I used it as a Claude evidence sample and used a real Codex session from the same local data set for the Codex-specific correctness check:

| Actual Codex sample | Xuanpu `sessions.id` | Worktree | Raw source |
| --- | --- | --- | --- |
| `019e5e95-a17e-7a21-8d3e-e89585dc62fe` | `bce8c676-1b79-4af3-a425-9648bda80fb4` | `feat/xuanpu-agent-oh-my-pi` | `~/.codex/sessions/2026/05/25/rollout-2026-05-25T18-02-05-019e5e95-a17e-7a21-8d3e-e89585dc62fe.jsonl` |

This mismatch itself is a product/data-quality issue: the UI and debug surfaces should expose both "Xuanpu session id" and "provider/runtime session id", plus the runtime type, so a human can locate the right raw source without guessing.

## Evidence From Raw Data

### Claude Sample A: `7098db9d...`

Raw file:

```text
~/.claude/projects/-Users-slicenfer--xuanpu-worktrees-xuanpu-xuanpu--schnauzer/7098db9d-7373-44ff-850d-98393bf1d732.jsonl
```

Raw JSONL facts:

| Metric | Value |
| --- | ---: |
| JSONL lines | 707 |
| Assistant usage lines | 228 |
| Duplicate assistant `message.id` replacements | 134 |
| Unique final assistant usage entries | 94 |
| Total tokens | 11,399,739 |
| Input tokens | 16,761 |
| Cache read tokens | 9,935,786 |
| Cache write tokens | 1,309,215 |
| Output tokens | 137,977 |
| Cost estimate | `$16.68371675` |
| First usage | `2026-05-25T06:33:29.943Z` |
| Last usage | `2026-05-25T08:25:11.398Z` |

DB `usage_entries` facts for `479fc978-7a67-4117-9cac-659642e70782`:

| Metric | Value |
| --- | ---: |
| Rows | 94 |
| Total tokens | 11,399,739 |
| Input tokens | 16,761 |
| Cache read tokens | 9,935,786 |
| Cache write tokens | 1,309,215 |
| Output tokens | 137,977 |
| Cost estimate | `$16.68371675` |
| Sync state | `synced` |

Conclusion: current Claude summary matches the reader's final-by-message-id interpretation. The repeated raw usage lines are provider rewrites/snapshots for the same assistant message; summing all raw lines would overcount. The current de-duplication by assistant `message.id` is reasonable.

### Claude Sample B: `d5813586...`

Raw file:

```text
~/.claude/projects/-Users-slicenfer--xuanpu-worktrees-xuanpu-xuanpu--release/d5813586-bc96-4f9f-9588-8f02aea17b8c.jsonl
```

Raw JSONL facts:

| Metric | Value |
| --- | ---: |
| JSONL lines | 256 |
| Assistant usage lines | 125 |
| Duplicate assistant `message.id` replacements | 85 |
| Unique final assistant usage entries | 40 |
| Total tokens | 4,091,532 |
| Input tokens | 386 |
| Cache read tokens | 3,262,200 |
| Cache write tokens | 779,158 |
| Output tokens | 49,788 |
| Cost estimate | `$7.74746750` |

DB `usage_entries` facts for `32ccde6a-3347-4fab-b2e0-4a57c1c66738`:

| Metric | Value |
| --- | ---: |
| Rows | 40 |
| Total tokens | 4,091,532 |
| Cost estimate | `$7.74746750` |
| Sync state | `synced` |

Conclusion: this ID is also a Claude Code session and matches raw Claude JSONL after de-duplication.

### Actual Codex Sample: `019e5e95...`

Raw Codex file:

```text
~/.codex/sessions/2026/05/25/rollout-2026-05-25T18-02-05-019e5e95-a17e-7a21-8d3e-e89585dc62fe.jsonl
```

Raw Codex `event_msg.payload.type='token_count'` facts:

| Metric | Value |
| --- | ---: |
| Token-count events | 90 |
| Unique turns in Xuanpu logs | 9 |
| Final `total_token_usage.total_tokens` | 9,919,327 |
| Final `total_token_usage.input_tokens` | 9,879,114 |
| Final `total_token_usage.cached_input_tokens` | 9,553,152 |
| Final `total_token_usage.output_tokens` | 40,213 |
| Final `total_token_usage.reasoning_output_tokens` | 5,644 |
| Final `last_token_usage.total_tokens` | 169,778 |
| Model context window | 258,400 |
| Raw cost estimate with current pricing table | `$7.61277600` |

DB `usage_entries` facts for `bce8c676-1b79-4af3-a425-9648bda80fb4`:

| Metric | Value |
| --- | ---: |
| Rows | 9 |
| Total tokens | 962,876 |
| Input uncached tokens | 13,436 |
| Cache read tokens | 940,416 |
| Output tokens | 9,024 |
| Cost estimate | `$0.80810800` |

Measured error:

| Metric | Raw | DB | DB / Raw |
| --- | ---: | ---: | ---: |
| Total tokens | 9,919,327 | 962,876 | 9.71% |
| Cost | `$7.61277600` | `$0.80810800` | 10.62% |

Per-turn evidence from Xuanpu logs:

| Turn | Distinct token events | Sum of `last.totalTokens` | Final stored `last.totalTokens` |
| --- | ---: | ---: | ---: |
| `019e5e95-bd1e-75b2-b61c-d89008ed11e3` | 5 | 182,886 | 52,806 |
| `019e5ea5-4526-7743-8066-39ac0e48cc49` | 8 | 494,482 | 66,918 |
| `019e5eac-7e68-7e63-bf6b-c18fcb838494` | 17 | 1,379,207 | 88,186 |
| `019e5eb2-8365-7623-aeef-3d15eef11e58` | 13 | 1,272,605 | 103,075 |
| `019e5ee5-e2a7-7613-8ead-1fba58ea5006` | 10 | 1,660,512 | 169,778 |

Conclusion: one Codex turn can contain many billable token-count events. The DB keeps only one row per turn, so previous deltas inside that turn are lost.

## Current Code Chain

### Worktree Overview Panel

Renderer entrypoint: `src/renderer/src/components/context-panel/ContextPanelHost.tsx`.

Current flow:

1. `ContextPanelHost` builds `overviewSessions` from `useSessionStore.sessionsByWorktree`, then reloads all sessions from `window.db.session.getByWorktree()`.
2. `OverviewPanel` maps those sessions to `sessionIds`.
3. For every session id, it calls `window.usageAnalyticsOps.fetchSessionSummary(sessionId)`.
4. `UsageAnalyticsService.fetchSessionSummary()` only supports sessions returned by `getUsageAnalyticsSessions(['claude-code', 'codex'], 'all')`.
5. Unsupported session types return `{ success: false }` and are ignored by the overview panel.
6. Totals are rendered by combining:
   - persisted `UsageAnalyticsSessionSummary`;
   - in-memory `useContextStore.tokensBySession`;
   - in-memory `useContextStore.costBySession`.

Important implementation points:

- `ContextPanelHost.tsx` uses all sessions in the worktree, not just active sessions, after the async DB load.
- The label exposes active/inactive session counts but the metric title does not clearly say whether cost/tokens are all-time, active-only, or supported-only.
- Cost uses `Math.max(summary.total_cost, liveCost)`.
- Tokens use `resolveUsageTokenTotals(summary, liveTokens)`, which chooses the larger complete snapshot and avoids adding summary plus live tokens.
- The renderer loop causes one IPC call per session and duplicates aggregation logic that should live in the data service.

### Usage Analytics Backend

Backend service: `src/main/services/usage-analytics-service.ts`.

Current behavior:

- `UsageAnalyticsEngine` is only `'claude-code' | 'codex'`.
- `fetchDashboard()` and `fetchSessionSummary()` aggregate from `usage_entries`.
- `syncClaudeSession()` reads Claude JSONL via `readClaudeTranscriptUsage()` and upserts final assistant usage entries.
- `syncCodexSession()` does not parse Codex JSONL; it only counts existing `source_kind='codex-message'` rows and refreshes sync state.
- `fetchSessionSummary(sessionId)` forces `syncSession(session, true)` on every call.

The current Claude sync is non-destructive for missing files. If a Claude transcript is missing, it sets `usage_sync_state.status='partial'` and preserves any existing usage rows. That is correct behavior and should be retained.

The current Codex sync is incomplete. It treats runtime-persisted rows as already authoritative, but those rows are undercounted because the runtime persist path is wrong.

### Usage DB Schema

Current table: `usage_entries`.

Key columns:

- `session_id`
- `agent_sdk`
- `source_kind`
- `source_message_id`
- token fields
- `cost`
- `occurred_at`

Current unique index:

```sql
CREATE UNIQUE INDEX idx_usage_entries_session_source
  ON usage_entries(session_id, source_message_id);
```

This unique key is too narrow for Codex. `turnId` is not a unique billable event. A single turn can have many token-count events.

The table also lacks:

- raw provider payload;
- runtime session/thread id;
- turn id as first-class column;
- event sequence or cumulative-total fingerprint;
- source file path;
- quality/status per row;
- persisted current context-window snapshot.

### Runtime Context Store

Renderer store: `src/renderer/src/stores/useContextStore.ts`.

The store holds:

- `tokensBySession`: latest/cumulative token snapshot, depending on provider event shape.
- `contextSnapshotsBySession`: current context-window snapshot.
- `costBySession`: cumulative live cost estimate.
- `costEventKeysBySession`: renderer-side duplicate guard.

This is useful for live UI but it is not a durable source of truth. Worktree totals that depend on it are not reproducible after app restart unless the provider-specific hydration path restores equivalent data.

### Claude Runtime Events

Claude context usage:

- `ClaudeCodeImplementer.emitClaudeContextUsageSnapshot()` calls `query.getContextUsage()` when available.
- It emits `session.context_usage` with `breakdown.usedTokens`, `breakdown.maxTokens`, and categories.
- It does not emit billing cost or cumulative token totals through this path.

Claude session totals come from transcript sync, not live `session.context_usage`.

### Codex Runtime Events

Codex token event path:

- `CodexImplementer.handleManagerEvent()` handles `thread/tokenUsage/updated`.
- It reads `tokenUsage.total`, `tokenUsage.last`, `turnId`, and `modelContextWindow`.
- It emits `session.context_usage` where:
  - `data.tokens` is based on cumulative `tokenUsage.total`;
  - `data.breakdown.usedTokens` is based on `last.inputTokens`;
  - `data.cost` is computed by `calculateTurnTokenUsageCostDelta()`.
- It persists usage by calling `persistCodexTurnUsage(targetSession, turnId, modelID, lastTokens)`.

The semantic split inside `session.context_usage` is reasonable for live display:

- cumulative `tokens` can support session total fallback;
- latest `last.inputTokens` can support current context-window occupancy.

The persistence is wrong because it upserts `lastTokens` into a single row per turn.

`hydrateTokenUsageFromThread()` reads the Codex JSONL and finds the last `token_count` event. It emits cumulative tokens and current context usage to the renderer, but it does not backfill `usage_entries`. So the UI can look correct temporarily while the DB and worktree aggregate remain wrong.

## Root Causes

### P0: Codex Uses the Wrong Persistence Key

Current assumption in code comments:

> same turn multiple `tokenUsage/updated` events UPSERT and replace latest values; different turns accumulate.

Observed provider behavior:

- `tokenUsage.last` is one token-count event's delta.
- `tokenUsage.total` is the thread cumulative total after applying that delta.
- One `turnId` can contain many token-count events.

Therefore, `(session_id, codex-turn:<turnId>)` cannot be the unique key for usage entries.

Correct key should represent the provider usage event, not the turn. A stable event fingerprint can be built from `threadId`, `turnId`, and the cumulative `tokenUsage.total` fields. If the raw JSONL has an explicit event id or position, that is even better.

### P0: Live Codex Cost Uses the Same Wrong Semantics

`calculateTurnTokenUsageCostDelta()` keeps `tokenUsageCostByTurn` and emits only positive differences of the latest `lastTokens` cost versus previous max for the same turn. That makes sense only if the value is cumulative per turn. It is not.

The live cost should add each unique token-count event delta once. Duplicate prevention should be done by provider event fingerprint, not by "max cost per turn".

### P1: Worktree Overview Aggregates in the Renderer

Right now the right panel fetches summaries per session and aggregates in React. That makes the display dependent on:

- which sessions are loaded into the renderer store;
- whether live runtime snapshots have arrived;
- whether the per-session summary IPC happened to finish;
- whether unsupported sessions fail silently;
- whether a session is active or completed.

This is not acceptable for metrics that should be correct.

### P1: Unsupported Runtime Types Are Counted But Not Explained

The overview session list can include `opencode`, `terminal`, and `xuanpu-agent`.

The usage analytics service only supports `claude-code` and `codex`. For unsupported sessions:

- `fetchSessionSummary()` returns failure;
- the overview panel swallows it;
- totals show no contribution;
- the panel still shows the session count in active/inactive breakdown.

The user cannot tell whether zero means "no usage", "unsupported", "not synced", or "transcript missing".

### P1: Context Window and Billing Totals Share One Event Shape

`session.context_usage` currently carries both:

- current context-window occupancy;
- cumulative token total fallback;
- cost delta.

These are related but not the same metric. Mixing them makes it easy to accidentally use "current prompt size" as a session total or "session cumulative total" as a context-window percent.

### P2: Cost Is an Estimate Unless Provider Reports Exact Billing

Claude and Codex costs are computed locally from `src/shared/usage/pricing.ts`.

This is useful and deterministic, but it is not necessarily the exact billed cost if provider pricing, discounts, service tier, cache pricing, or model aliases change. The UI should label this as estimated unless the provider reports exact billing.

## Proposed Refactor

I recommend a destructive cleanup of the usage subsystem, with compatibility views during migration.

### 1. Define Metrics as Separate Concepts

Use these names consistently:

| Metric | Meaning | Source |
| --- | --- | --- |
| `usage_total` | cumulative billable/provider usage for a session | provider usage events / transcript usage |
| `usage_cost_estimate` | cost estimate derived from normalized usage and pricing table | local pricing or provider cost if available |
| `context_current` | latest current prompt/context-window occupancy | provider context snapshot / latest token-count event |
| `sync_quality` | whether numbers are complete, partial, live-only, stale, or unsupported | sync service |

The UI should never show a number without knowing which concept it represents.

### 2. Replace Turn-Keyed Codex Rows With Event-Keyed Ledger Rows

Add a v2 ledger table or expand `usage_entries` with a new unique event key.

Recommended table:

```sql
CREATE TABLE usage_events (
  id TEXT PRIMARY KEY,
  session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  worktree_id TEXT REFERENCES worktrees(id) ON DELETE SET NULL,
  agent_sdk TEXT NOT NULL,
  source_kind TEXT NOT NULL,
  source_event_id TEXT NOT NULL,
  runtime_session_id TEXT,
  thread_id TEXT,
  turn_id TEXT,
  provider_id TEXT,
  model_id TEXT,
  model_label TEXT,
  input_tokens INTEGER NOT NULL DEFAULT 0,
  output_tokens INTEGER NOT NULL DEFAULT 0,
  reasoning_tokens INTEGER NOT NULL DEFAULT 0,
  cache_write_tokens INTEGER NOT NULL DEFAULT 0,
  cache_read_tokens INTEGER NOT NULL DEFAULT 0,
  total_tokens INTEGER NOT NULL DEFAULT 0,
  cost_estimate REAL NOT NULL DEFAULT 0,
  source_payload_json TEXT,
  occurred_at TEXT NOT NULL,
  created_at TEXT NOT NULL
);

CREATE UNIQUE INDEX idx_usage_events_session_source_event
  ON usage_events(session_id, source_kind, source_event_id);
```

For Codex live events:

- source kind: `codex-token-count`
- source event id:
  - preferred: raw JSONL/event id if Codex exposes one;
  - fallback: `threadId:turnId:totalTokens:inputTokens:cachedInputTokens:outputTokens:reasoningOutputTokens`.
- row tokens: the event delta from `tokenUsage.last`.
- snapshot totals: the cumulative numbers from `tokenUsage.total`.

This gives us:

- duplicate-safe live inserts;
- correct totals by summing event delta rows;
- correct recovery by parsing raw JSONL;
- a stable audit trail for why a number changed.

### 3. Add a Durable Usage/Context Snapshot Table

Recommended table:

```sql
CREATE TABLE session_usage_snapshots (
  session_id TEXT PRIMARY KEY REFERENCES sessions(id) ON DELETE CASCADE,
  agent_sdk TEXT NOT NULL,
  runtime_session_id TEXT,
  thread_id TEXT,
  provider_id TEXT,
  model_id TEXT,
  model_label TEXT,
  total_input_tokens INTEGER NOT NULL DEFAULT 0,
  total_output_tokens INTEGER NOT NULL DEFAULT 0,
  total_reasoning_tokens INTEGER NOT NULL DEFAULT 0,
  total_cache_write_tokens INTEGER NOT NULL DEFAULT 0,
  total_cache_read_tokens INTEGER NOT NULL DEFAULT 0,
  total_tokens INTEGER NOT NULL DEFAULT 0,
  total_cost_estimate REAL NOT NULL DEFAULT 0,
  context_used_tokens INTEGER,
  context_window_tokens INTEGER,
  context_percent REAL,
  source_kind TEXT NOT NULL,
  source_ref TEXT,
  source_mtime_ms INTEGER,
  source_payload_json TEXT,
  sync_status TEXT NOT NULL,
  last_event_at TEXT,
  updated_at TEXT NOT NULL,
  last_error TEXT
);
```

This table is the fast path for current UI display. The ledger remains the audit/source-of-truth for totals and timeline breakdowns.

For Codex:

- update snapshot on every token-count event using `tokenUsage.total`;
- set `context_used_tokens = tokenUsage.last.inputTokens`;
- set `context_window_tokens = tokenUsage.modelContextWindow`;
- compute `total_cost_estimate` from cumulative total fields.

For Claude:

- update usage total snapshot from transcript final assistant usage rows;
- update context snapshot from `query.getContextUsage()` when available.

### 4. Backfill Codex From JSONL, Not From `session_messages`

Current `syncCodexSession()` only counts existing rows. It needs to become a real sync.

New behavior:

1. Resolve the Codex raw JSONL path:
   - from `thread/read` when runtime is reachable;
   - from known `~/.codex/sessions/**/rollout-*-<threadId>.jsonl` fallback when offline.
2. Parse every `event_msg` where `payload.type === 'token_count'`.
3. Insert one `usage_events` row for each unique token-count event using `last_token_usage`.
4. Upsert `session_usage_snapshots` from the last token-count event.
5. Mark sync as:
   - `synced` if raw source was found and parsed;
   - `partial` if only legacy rows exist;
   - `missing-source` if no raw source is found.

The existing `source_kind='codex-message'` rows should be treated as legacy undercounted data. They can be kept during migration but must not be presented as complete if no raw backfill is available.

### 5. Keep Claude Sync Non-Destructive

Do not restore the old delete-and-reinsert behavior.

Claude sync should:

- parse all assistant usage rows;
- keep final usage per assistant `message.id`;
- upsert rows by final assistant message id;
- preserve existing rows if the transcript disappears;
- mark the session `partial` with `last_error='Claude transcript file is missing.'`;
- avoid forced full sync on every `fetchSessionSummary()` if `source_mtime_ms` did not change.

### 6. Move Worktree Aggregation to the Main Process

Add a single IPC endpoint:

```ts
usageAnalyticsOps.fetchScopeSummary({
  scope: 'worktree' | 'connection' | 'project' | 'session',
  scopeId: string,
  sessionStatus: 'active' | 'completed' | 'all',
  engines: 'all' | Array<'claude-code' | 'codex' | 'opencode' | 'xuanpu-agent'>
})
```

Return a normalized object:

```ts
interface UsageScopeSummary {
  scope: 'worktree' | 'connection' | 'project' | 'session'
  scopeId: string
  generatedAt: string
  totals: {
    costEstimate: number
    totalTokens: number
    inputTokens: number
    outputTokens: number
    reasoningTokens: number
    cacheReadTokens: number
    cacheWriteTokens: number
  }
  contextCurrent?: {
    sessionId: string
    usedTokens: number
    maxTokens: number
    percent: number
    model?: { providerID: string; modelID: string }
    updatedAt: string
    status: 'live' | 'snapshot' | 'stale'
  }
  sessionCounts: {
    total: number
    active: number
    completed: number
    supported: number
    unsupported: number
    partial: number
  }
  sessions: Array<{
    sessionId: string
    runtimeSessionId: string | null
    agentSdk: string
    status: string
    costEstimate: number
    totalTokens: number
    quality: 'synced' | 'partial' | 'live-only' | 'legacy-undercounted' | 'unsupported'
    reason?: string
  }>
}
```

Then `ContextPanelHost` should render this endpoint result. It should not loop over session ids and manually combine DB summaries with live store state.

### 7. Make Scope Explicit in the Right Panel

The current panel loads all sessions in a worktree, including completed sessions. That is a legitimate metric, but the UI must say so.

Recommended right-panel labels:

- `Worktree lifetime` for all sessions in this worktree;
- `Active sessions` for active-only totals;
- show active/completed/unsupported/partial counts in a compact tooltip.

Do not let the panel display "Worktree" while silently mixing all-time completed sessions with current active snapshots.

### 8. Redefine the Product/UI Surface

The right rail in the current UI is a worktree-level overview, not a session usage debugger. That means it should answer:

- how much this worktree has likely cost;
- whether any active session is near its context limit;
- whether the numbers are complete enough to trust;
- which runtime/session is responsible for the cost or risk.

It should not headline mixed provider token internals such as input tokens, output tokens, cache writes, cache reads, or cache hit rate. Those are useful, but only after the user drills into one session or one provider/runtime. At worktree scope, Claude, Codex, OpenCode, Xuanpu Agent, active sessions, completed sessions, and unsupported sessions are all mixed together. A single cache hit rate or input/output split across that container is mathematically computable but product-wise weak and easy to misread.

Recommended UI ownership:

| UI location | Scope | Should show | Should not show |
| --- | --- | --- | --- |
| Top session header | selected session | runtime, model, status, current context indicator, selected-session cost pill | worktree lifetime cost |
| Right rail `Worktree Overview` tab | selected worktree | estimated cost, active context pressure, session coverage/quality, provider cost split, top costly sessions | mixed input/output/cache hit rate as headline cards |
| Right rail `Session Usage` drilldown | selected session | session total cost, current context, input/output/reasoning/cache details, sync source, raw runtime ids | worktree-wide mixed provider ratios |
| Usage dashboard/settings | project/worktree/provider/date range | provider-specific trends, model split, cache hit rate per provider/model, export/debug filters | unlabeled cross-provider averages |
| Debug/inspector view | raw source/event | usage ledger rows, raw JSONL path, sync errors, source fingerprints | primary end-user summary |

#### Top Session Header

The existing top bar already has the right shape: provider/runtime, model, status, a compact context indicator, and a cost pill. Keep this as selected-session scope only.

Required adjustments:

- label/tooltip the cost as `Session estimate`, not worktree cost;
- label/tooltip the context bar as `Current session context`;
- clicking the cost pill opens the `Session Usage` drilldown for the selected session;
- never show worktree lifetime totals in the top session header.

In the screenshot, the top cost pill around `$7.7475` is session-shaped data. The right rail cost around `$476.75` is worktree lifetime-shaped data. Those two can coexist only if the scope labels are explicit.

#### Right Rail: Worktree Overview Tab

Keep the current bar-chart side tab as the worktree overview. Recompose the cards in this order:

1. `Estimated cost`
   - headline value: worktree lifetime cost by default;
   - scope control: `Lifetime` / `Active` / `24h` or `7d`;
   - small quality line: `Synced 9 / Partial 1 / Unsupported 2`;
   - tooltip: explain that cost is estimated from normalized usage events.

2. `Active context pressure`
   - show the highest current context percent among active sessions, not a sum;
   - include runtime/model and a short session label;
   - example: `65% / Codex / 168.8K / 258.4K`;
   - if no active context snapshot exists, show `Unknown` or `Stale`, not `0%`.

3. `Session coverage`
   - compact status grid: total, active, completed, synced, partial, unsupported;
   - this makes data quality visible before the user trusts the totals.

4. `Provider cost split`
   - small stacked bar or rows by runtime: Claude, Codex, OpenCode, Xuanpu Agent;
   - unsupported runtimes get a neutral/hatched segment with `unsupported`, not `$0`;
   - this is the only worktree-level provider breakdown that belongs in the overview.

5. `Top sessions`
   - top 3 or 5 sessions by estimated cost or current context pressure;
   - each row shows runtime, status, quality, cost, and context percent if active;
   - clicking a row opens the `Session Usage` drilldown.

6. `Worktree`
   - path, branch, and raw identifiers stay at the bottom as metadata.

Remove or demote these from the worktree overview:

- headline `Tokens` card;
- mixed input/output/cache bar group;
- mixed cache hit rate;
- any "0" that actually means unsupported, missing source, or not synced.

If total tokens remain visible at worktree scope, keep them as secondary detail under `Estimated cost` or in the provider split tooltip, labeled as `Normalized usage events total`. They should not be treated as a primary worktree KPI because the cost/risk question is better answered by dollars, active context pressure, and data quality.

#### Right Rail: Session Usage Drilldown

Add a second state inside the same right rail, opened by:

- clicking the top session cost pill;
- clicking a row in `Top sessions`;
- selecting `Usage` from a session row/menu.

This view is where the detailed token cards belong:

- `Session cost estimate`;
- `Total tokens`;
- `Current context`;
- provider-specific `Input`, `Output`, `Reasoning`, `Cache read`, `Cache write`;
- cache hit rate only when the provider has a coherent cache model;
- sync quality: `synced`, `partial`, `live-only`, `legacy-undercounted`, `unsupported`;
- raw identifiers: Xuanpu session id, runtime session/thread id, transcript/JSONL path;
- last sync time and source mtime.

This lets the user answer "why did this session cost so much?" without polluting the worktree overview with provider-specific internals.

#### Usage Dashboard / Settings

The larger analytics page can still expose input/output/cache hit rate, but it must be filter-first:

- date range;
- worktree/project;
- provider/runtime;
- model;
- session status;
- sync quality.

Cache hit rate should be shown per provider/model, not as one mixed worktree number. A mixed worktree cache hit rate can be exported/debugged, but should not be a default product KPI.

#### Resulting Mental Model

Use this rule:

- Worktree overview = cost risk, active context risk, and data quality.
- Session usage = exact token categories and raw-source traceability.
- Provider analytics = comparative input/output/cache behavior.

This UI split is part of the correctness fix. Accurate raw data is not enough if the product puts precise-looking but low-meaning ratios in the wrong scope.

### 9. Split Renderer Events

Keep `session.context_usage` for current context occupancy only, or rename/add:

- `session.context_usage`: current prompt/context-window usage.
- `session.usage_snapshot`: cumulative session usage totals.
- `session.usage_delta`: one billable usage event delta.

This makes the intended consumer obvious:

- `ContextIndicator` reads `context_usage`.
- `SessionCostPill` and worktree totals read `usage_snapshot` or backend scope summary.
- The ledger writer consumes `usage_delta`.

## Migration Plan

### Phase 1: Add Correct Codex Ledger Without Removing Old Table

- Add `usage_events` and `session_usage_snapshots`.
- Keep existing `usage_entries` for compatibility.
- Update Codex live handling to insert event-keyed rows.
- Update Codex reconnect/backfill to parse raw JSONL and fill missing token-count events.
- Update `fetchSessionSummary()` to prefer v2 ledger/snapshot when available.
- Mark legacy `codex-message` summaries as `legacy-undercounted` when no raw backfill exists.

Acceptance for `019e5e95...`:

| Metric | Expected after Phase 1 |
| --- | ---: |
| Total tokens | 9,919,327 |
| Cost estimate | `$7.61277600` |
| Current context | `168,829 / 258,400` |
| Context percent | about `65.34%` |

### Phase 2: Move Worktree Overview to `fetchScopeSummary`

- Add backend scope summary endpoint.
- Replace renderer per-session summary loop.
- Return quality counts and session-level reasons.
- Surface partial/unsupported status in the overview panel.
- Redesign the right rail so worktree overview headlines only cost, active context pressure, session coverage, provider cost split, and top sessions.
- Move input/output/cache/reasoning/cache-hit metrics into session drilldown and provider analytics views.
- Add tests for active-only vs lifetime scope.

Acceptance:

- Right panel equals SQL/backend scope summary for the selected worktree.
- Settings Usage dashboard and right-panel totals agree when using the same scope/filter.
- Unsupported sessions do not silently appear as zero-usage supported sessions.
- Worktree overview does not display a mixed-provider cache hit rate or mixed input/output/cache cards.
- Clicking the top session cost pill or a top-session row opens the session usage drilldown with provider-specific token details.

### Phase 3: Claude Sync Cleanup

- Stop forced sync on every per-session summary when transcript mtime is unchanged.
- Keep non-destructive partial handling.
- Store raw source payload or at least source file metadata for audit.
- Add a repair/backfill command that can re-read all Claude transcripts without deleting missing-source data.

Acceptance for the two provided Claude IDs:

| Runtime ID | Expected rows | Expected total tokens | Expected cost estimate |
| --- | ---: | ---: | ---: |
| `7098db9d-7373-44ff-850d-98393bf1d732` | 94 | 11,399,739 | `$16.68371675` |
| `d5813586-bc96-4f9f-9588-8f02aea17b8c` | 40 | 4,091,532 | `$7.74746750` |

### Phase 4: Optional Runtime Expansion

Decide whether `opencode` and `xuanpu-agent` are first-class usage engines.

If yes:

- persist their usage events into the same ledger;
- define pricing/model mappings;
- include them in `UsageAnalyticsEngine`;
- return real totals in scope summaries.

If no:

- exclude them from usage totals;
- count them as unsupported;
- show that explicitly in the panel.

## Test Plan

Add focused tests before changing UI.

### Codex Persistence Tests

Use a fixture with multiple `thread/tokenUsage/updated` events in the same turn.

Required assertions:

- multiple events in the same `turnId` produce multiple usage event rows;
- duplicate notification with the same cumulative total is ignored;
- sum of event deltas equals final provider `total_token_usage`;
- session summary cost matches cost computed from final cumulative totals;
- current context snapshot uses latest `last.inputTokens`, not cumulative total input tokens.

### Codex JSONL Backfill Tests

Use a fixture modeled after:

```text
~/.codex/sessions/2026/05/25/rollout-2026-05-25T18-02-05-019e5e95-a17e-7a21-8d3e-e89585dc62fe.jsonl
```

Required assertions:

- parsing all `token_count` events produces 90 rows for this sample;
- final snapshot total is 9,919,327 tokens;
- re-running sync is idempotent.

### Claude Transcript Tests

Required assertions:

- duplicate assistant usage lines with the same `message.id` resolve to the final row;
- missing transcript does not delete existing rows;
- sync state becomes `partial` with a useful reason.

### Worktree Overview Tests

Required assertions:

- renderer calls `fetchScopeSummary()` once instead of N per-session calls;
- unsupported sessions are counted separately;
- partial sessions are visible;
- active-only and lifetime totals are not confused;
- Settings Usage and right-panel summary agree when filters match;
- worktree overview shows cost, active context pressure, coverage, provider cost split, and top sessions;
- worktree overview does not headline mixed input/output/cache hit rate;
- session usage drilldown shows provider-specific input/output/reasoning/cache fields for one selected session.

## Final Recommendation

Do not patch the renderer math first. The biggest visible inaccuracy is already in the persisted Codex data. Fix the data model and provider ingestion path first, then simplify the renderer.

Concrete order:

1. Build v2 event-keyed usage ledger and snapshot table.
2. Fix Codex live persistence and JSONL backfill.
3. Make `fetchSessionSummary()` read from the normalized source.
4. Add `fetchScopeSummary()` and move right-panel aggregation into the main process.
5. Redesign the right rail around worktree-scope metrics: estimated cost, active context pressure, coverage/quality, provider cost split, and top sessions.
6. Move input/output/cache/reasoning/cache-hit details to session drilldown and provider analytics.
7. Keep Claude non-destructive sync and mark missing transcripts as partial.
8. Make unsupported runtime types explicit.

After that, the right panel can be small and boring: it renders one normalized object with cost risk, context risk, and data-quality flags. Detailed token categories still exist, but only in the places where their scope is meaningful.
