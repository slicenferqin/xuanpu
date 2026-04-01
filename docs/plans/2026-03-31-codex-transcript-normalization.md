# Codex Transcript Normalization Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Make Codex session rendering as stable as Claude Code by normalizing Codex app-server data into a canonical turn-based transcript before it reaches the renderer.

**Architecture:** Keep `codex app-server` as the transport layer. Normalize every Codex turn in the main process into one `user` message plus one `assistant` message with ordered `parts` (`text`, `reasoning`, `tool`). Persist that canonical transcript in `session_messages`, and treat `session_activities` as auxiliary metadata for approvals, plan-ready state, and legacy backfill only. Then simplify the renderer to trust the canonical transcript first and only synthesize rows for old transcripts that do not yet contain canonical tool parts.

**Tech Stack:** Electron 33, TypeScript 5.7, React 19, Vitest, Zustand, SQLite, Codex app-server JSON-RPC

---

## Execution Context

- Execute this plan in the dedicated worktree: `/Users/slicenfer/.hive-cn-worktrees/xuanpu/xuanpu--cavalier`
- Use `pnpm` only
- Do not modify unrelated dirty files from other branches or worktrees
- Favor small commits after each task

## Success Criteria

- A single Codex turn persists as:
  - one user message
  - one assistant message
- The assistant message contains ordered `parts` for:
  - reasoning
  - tool calls
  - assistant text / plan text
- `SessionView` no longer needs to reconstruct the main Codex transcript from multiple competing sources
- Legacy Codex transcripts still render acceptably via timeline backfill
- Existing Claude Code behavior remains unchanged

## Non-Goals

- Do not replace `codex app-server` with the SDK
- Do not redesign the chat UI
- Do not rewrite unrelated Claude Code logic
- Do not remove legacy compatibility paths until the new transcript path is covered by tests

### Task 1: Lock Down the Canonical Codex Turn Contract

**Files:**
- Modify: `src/main/services/codex-implementer.ts`
- Test: `test/phase-22/session-6/codex-abort-getmessages.test.ts`

**Step 1: Write the failing tests for item-based turns**

Add tests that cover real `thread/read` turns with `items` arrays:

1. A turn with:
   - `userMessage`
   - `reasoning`
   - `commandExecution`
   - `fileChange`
   - `agentMessage`

   should return exactly two messages:
   - `turn-1:user`
   - `turn-1:assistant`

2. The assistant message should contain ordered parts:
   - `{ type: 'reasoning', text: '...' }`
   - `{ type: 'tool', callID: '...', tool: '...', state: ... }`
   - `{ type: 'tool', callID: '...', tool: '...', state: ... }`
   - `{ type: 'text', text: 'Saved assistant reply' }`

3. A turn with `plan` plus `agentMessage` should still produce one assistant message, not multiple assistant bubbles.

Suggested test fixture shape:

```ts
internalManager.readThread = vi.fn().mockResolvedValue({
  thread: {
    id: 'thread-msg-1',
    turns: [
      {
        id: 'turn-1',
        createdAt: '2026-01-01T00:00:00Z',
        updatedAt: '2026-01-01T00:00:10Z',
        items: [
          {
            type: 'userMessage',
            id: 'user-1',
            content: [{ type: 'text', text: 'Saved user message' }]
          },
          {
            type: 'reasoning',
            id: 'reasoning-1',
            summary: ['Reasoning summary'],
            content: ['Reasoning detail']
          },
          {
            type: 'commandExecution',
            id: 'cmd-1',
            toolName: 'bash',
            status: 'completed',
            input: { command: ['pnpm', 'test'] },
            output: 'ok'
          },
          {
            type: 'fileChange',
            id: 'edit-1',
            name: 'apply_patch',
            status: 'completed',
            changes: [{ path: 'src/file.ts' }],
            output: 'patched'
          },
          {
            type: 'agentMessage',
            id: 'assistant-1',
            text: 'Saved assistant reply'
          }
        ]
      }
    ]
  }
})
```

**Step 2: Run the targeted test file and verify failure**

Run:

```bash
pnpm vitest run test/phase-22/session-6/codex-abort-getmessages.test.ts
```

Expected:
- FAIL because the current parser emits multiple assistant messages or drops tool parts from the canonical transcript

**Step 3: Implement turn-level normalization in the main process**

In `src/main/services/codex-implementer.ts`, refactor `parseThreadSnapshot()` so that `items`-based turns are normalized per turn instead of per item.

Implementation requirements:

1. Add a turn-local accumulator:

```ts
const userParts: Array<{ type: 'text'; text: string; timestamp: string }> = []
const assistantParts: Array<
  | { type: 'text'; text: string; timestamp: string }
  | { type: 'reasoning'; text: string; timestamp: string }
  | {
      type: 'tool'
      callID: string
      tool: string
      state: {
        status: 'running' | 'completed' | 'error'
        input?: unknown
        output?: unknown
        error?: unknown
      }
    }
> = []
```

2. Convert item types as follows:
- `userMessage` -> append text entries to `userParts`
- `reasoning` -> append one reasoning part to `assistantParts`
- `commandExecution` / `fileChange` -> append one `tool` part to `assistantParts`
- `agentMessage` / `plan` -> append one text part to `assistantParts`

3. Emit messages only once per turn:
- one user message if `userParts.length > 0`
- one assistant message if `assistantParts.length > 0`

4. Use stable canonical IDs:
- user: `${turnId}:user`
- assistant: `${turnId}:assistant`

5. Preserve fallback behavior for the older `turn.input` / `turn.output` shape when `items` is absent.

6. Keep the tool part shape compatible with the existing renderer streaming shape:

```ts
{
  type: 'tool',
  callID: itemId,
  tool: toolName,
  state: {
    status,
    input,
    output,
    error
  }
}
```

**Step 4: Run the targeted test file and verify success**

Run:

```bash
pnpm vitest run test/phase-22/session-6/codex-abort-getmessages.test.ts
```

Expected:
- PASS

**Step 5: Commit**

```bash
git add test/phase-22/session-6/codex-abort-getmessages.test.ts src/main/services/codex-implementer.ts
git commit -m "feat: normalize codex thread transcripts per turn"
```

### Task 2: Stop Duplicating Canonical Tool Parts in the Codex Timeline Layer

**Files:**
- Modify: `src/renderer/src/lib/codex-timeline.ts`
- Test: `test/phase-22/session-8/codex-timeline.test.ts`

**Step 1: Write failing timeline tests for canonical transcripts**

Add tests for two cases:

1. Canonical assistant messages that already contain `tool_use` or `tool`-derived parts should not create extra synthetic tool rows from matching `session_activities`.
2. `plan.ready` should only synthesize an `ExitPlanMode` card when the canonical transcript does not already carry the same plan/tool identity.

Suggested expectation for the canonical case:

```ts
expect(timeline.map((message) => message.id)).toEqual([
  'turn-1:user',
  'turn-1:assistant'
])
```

and:

```ts
expect(
  timeline[1]?.parts?.some(
    (part) => part.type === 'tool_use' && part.toolUse?.id === 'tool-1'
  )
).toBe(true)
```

Retain separate tests for legacy transcripts where synthetic tool rows are still required.

**Step 2: Run the timeline test file and verify failure**

Run:

```bash
pnpm vitest run test/phase-22/session-8/codex-timeline.test.ts
```

Expected:
- FAIL because `mergeCodexActivityMessages()` currently injects synthetic rows even when the canonical assistant message already contains the same tool

**Step 3: Implement timeline dedupe for canonical transcripts**

In `src/renderer/src/lib/codex-timeline.ts`:

1. Extract all existing tool IDs from canonical assistant message parts before synthesizing anything.
2. Skip synthetic insertion when the tool ID already exists in the canonical transcript.
3. Keep synthetic insertion only for:
- legacy raw item-based transcripts
- persisted activities that do not yet exist in canonical messages
- plan-ready state that still needs a visible pending card

Implementation guidance:

```ts
const existingToolIds = new Set(
  mergedMessages.flatMap((message) =>
    (message.parts ?? [])
      .filter((part) => part.type === 'tool_use' && part.toolUse?.id)
      .map((part) => part.toolUse!.id)
  )
)
```

Also add a helper that treats both canonical assistant IDs and raw/legacy IDs correctly when deciding whether synthetic rows are still needed.

**Step 4: Run the test file and verify success**

Run:

```bash
pnpm vitest run test/phase-22/session-8/codex-timeline.test.ts
```

Expected:
- PASS

**Step 5: Commit**

```bash
git add test/phase-22/session-8/codex-timeline.test.ts src/renderer/src/lib/codex-timeline.ts
git commit -m "fix: dedupe codex timeline rows against canonical parts"
```

### Task 3: Make SessionView Trust the Canonical Codex Transcript First

**Files:**
- Modify: `src/renderer/src/components/sessions/SessionView.tsx`
- Test: `test/phase-22/session-8/codex-sessionview-loading.test.tsx`

**Step 1: Create a new SessionView loading test file**

Create `test/phase-22/session-8/codex-sessionview-loading.test.tsx` with focused tests for:

1. When durable DB messages already contain canonical turn-scoped Codex messages, `loadMessages()` should use them as the primary source.
2. When the durable transcript is canonical and non-empty, `loadMessages()` should not merge in duplicate live tool rows from `window.opencodeOps.getMessages()`.
3. When the durable transcript is empty and the session is busy, live Codex messages can still be used as a temporary fallback.

Test harness expectations:

```ts
expect(screen.getAllByTestId('message-assistant')).toHaveLength(1)
expect(screen.queryByText(/duplicate tool row/i)).toBeNull()
```

**Step 2: Run the new test file and verify failure**

Run:

```bash
pnpm vitest run test/phase-22/session-8/codex-sessionview-loading.test.tsx
```

Expected:
- FAIL because `SessionView` currently merges durable and live Codex sources too aggressively

**Step 3: Simplify Codex loading rules in SessionView**

In `src/renderer/src/components/sessions/SessionView.tsx`:

1. Add a small helper that detects whether a Codex transcript is already canonical:

```ts
function isCanonicalCodexTranscript(messages: OpenCodeMessage[]): boolean {
  return messages.some(
    (message) =>
      message.role === 'assistant' &&
      /^.+:assistant$/.test(message.id) &&
      (message.parts?.length ?? 0) > 0
  )
}
```

2. Update `loadMessages()` so that:
- canonical durable Codex transcripts are primary
- live `getMessages()` is only used when:
  - the durable transcript is empty
  - or the session is actively running and the durable transcript clearly lacks the current turn

3. Restrict `mergeCodexActivityMessages()` to:
- legacy transcripts
- compatibility backfill
- not the default path for canonical Codex sessions

4. Keep the `plan.ready` pending-plan state, but prevent it from injecting a second card if the canonical transcript already contains the same plan tool.

**Step 4: Run the new loading test and the existing timeline test**

Run:

```bash
pnpm vitest run test/phase-22/session-8/codex-sessionview-loading.test.tsx
pnpm vitest run test/phase-22/session-8/codex-timeline.test.ts
```

Expected:
- PASS

**Step 5: Commit**

```bash
git add test/phase-22/session-8/codex-sessionview-loading.test.tsx src/renderer/src/components/sessions/SessionView.tsx
git commit -m "fix: prefer canonical codex transcripts in session view"
```

### Task 4: Keep Streaming Plan/Tool UX Stable Until Finalization

**Files:**
- Modify: `src/renderer/src/components/sessions/SessionView.tsx`
- Test: `test/phase-22/session-8/codex-sessionview-streaming.test.tsx`

**Step 1: Add a streaming regression test**

Create `test/phase-22/session-8/codex-sessionview-streaming.test.tsx` to cover:

1. During streaming, Codex can still show a transient plan card while `<proposed_plan>` content is arriving.
2. After finalization, the canonical durable transcript replaces the transient streaming structure without:
- duplicate plan cards
- extra assistant bubbles
- detached tool rows

**Step 2: Run the new test and verify failure**

Run:

```bash
pnpm vitest run test/phase-22/session-8/codex-sessionview-streaming.test.tsx
```

Expected:
- FAIL because the current finalization path can leave both transient streaming parts and durable synthetic rows visible

**Step 3: Tighten the finalize path**

In `src/renderer/src/components/sessions/SessionView.tsx`:

1. Make `finalizeResponse()` for Codex prefer the reloaded canonical durable transcript.
2. Clear transient streaming plan/tool artifacts once the canonical transcript has loaded successfully.
3. Keep the streaming XML detection logic only as an in-flight UX helper; do not let it define durable message structure.

**Step 4: Run the new streaming test**

Run:

```bash
pnpm vitest run test/phase-22/session-8/codex-sessionview-streaming.test.tsx
```

Expected:
- PASS

**Step 5: Commit**

```bash
git add test/phase-22/session-8/codex-sessionview-streaming.test.tsx src/renderer/src/components/sessions/SessionView.tsx
git commit -m "fix: collapse codex streaming artifacts into canonical transcript"
```

### Task 5: End-to-End Regression Verification

**Files:**
- Modify if needed: `test/phase-22/session-9/codex-regression-smoke.test.ts`
- Optional test add: `test/phase-22/session-9/codex-canonical-transcript-smoke.test.ts`

**Step 1: Add or update a smoke test that exercises the full happy path**

Cover:
- send prompt
- stream reasoning
- stream at least one tool
- finish turn
- reload transcript
- verify one assistant bubble with ordered parts

Minimal assertion shape:

```ts
expect(messages.map((m) => m.role)).toEqual(['user', 'assistant'])
expect(messages[1]?.parts?.map((part) => part.type)).toEqual([
  'reasoning',
  'tool_use',
  'text'
])
```

**Step 2: Run the focused Codex suite**

Run:

```bash
pnpm vitest run test/phase-22/session-6/codex-abort-getmessages.test.ts
pnpm vitest run test/phase-22/session-8/codex-timeline.test.ts
pnpm vitest run test/phase-22/session-8/codex-sessionview-loading.test.tsx
pnpm vitest run test/phase-22/session-8/codex-sessionview-streaming.test.tsx
pnpm vitest run test/phase-22/session-9/codex-regression-smoke.test.ts
```

Expected:
- PASS

**Step 3: Run a broader sanity slice**

Run:

```bash
pnpm vitest run test/phase-22/session-5/codex-event-mapper.test.ts
pnpm vitest run test/phase-22/session-5/codex-prompt-streaming.test.ts
pnpm vitest run test/phase-21/session-4/claude-prompt-streaming.test.ts
```

Expected:
- PASS
- No Claude Code regressions

**Step 4: Manual verification in the app**

Run:

```bash
pnpm dev
```

Manual checklist:
- Open a Codex session
- Send a prompt that triggers reasoning plus a file/tool action
- Confirm the UI shows:
  - one user bubble
  - one assistant bubble
  - reasoning block inside the assistant bubble
  - tool card inside the assistant bubble or tightly associated with the turn
  - no duplicate plan/tool cards after refresh or reconnect

**Step 5: Final commit**

```bash
git add src/main/services/codex-implementer.ts src/renderer/src/lib/codex-timeline.ts src/renderer/src/components/sessions/SessionView.tsx test/phase-22/session-6/codex-abort-getmessages.test.ts test/phase-22/session-8/codex-timeline.test.ts test/phase-22/session-8/codex-sessionview-loading.test.tsx test/phase-22/session-8/codex-sessionview-streaming.test.tsx test/phase-22/session-9/codex-regression-smoke.test.ts
git commit -m "fix: stabilize codex transcript rendering"
```

## Notes for the Execution Session

- The current repository already contains unrelated dirty files in another worktree/session; do not revert them.
- The main design rule is: **Codex transcript structure must be solved in the main process first, not patched repeatedly in the renderer.**
- If a change forces large new special-casing in `SessionView.tsx`, stop and simplify the upstream transcript shape instead.

## Deliverables

- Canonical Codex turn parsing in the main process
- Timeline dedupe that respects canonical parts
- Simpler Codex transcript source selection in `SessionView`
- New regression coverage for canonical transcript rendering
- Manual verification notes recorded in the final handoff
