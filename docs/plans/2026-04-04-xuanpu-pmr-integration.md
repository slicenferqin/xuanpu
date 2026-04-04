# Xuanpu PMR Integration Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Integrate Project Memory Runtime into Xuanpu's Claude Agent SDK path as an optional enhancement, so the local developer can enable PMR on their own machine without adding any hard dependency or installation burden for other users.

**Architecture:** Keep Xuanpu's current Claude Agent SDK integration unchanged by default. Add a small main-process loader that optionally imports PMR's Claude Agent SDK adapter at runtime from a path provided via environment variable, wraps `sdk.query()` options with `withProjectMemory()`, and falls back to the original options if PMR is unavailable or fails to load.

**Tech Stack:** Electron main process, TypeScript, `@anthropic-ai/claude-agent-sdk`, dynamic `import()`, runtime environment variable gating, Vitest.

---

## Non-Negotiable Constraints

- Do **not** add `@slicenferqin/project-memory-adapter-claude-agent-sdk` to Xuanpu `package.json`.
- Do **not** add a `file:`, `link:`, `workspace:`, or absolute-path dependency to PMR.
- Do **not** modify renderer code, settings UI, database schema, or GraphQL/API contracts in v1.
- Do **not** change `claude-session-title.ts`; title generation stays on the raw SDK path.
- Do **not** change `claude-sdk-loader.ts`; it should continue to load only the official Claude SDK.
- Default behavior must remain exactly the same when PMR is not configured.
- Missing PMR adapter must never crash prompt execution.

---

## Task 1: Add an Optional PMR Loader

**Files:**
- Create: `src/main/services/claude-project-memory-loader.ts`
- Reuse: `src/main/services/logger.ts`

**Objective:** Add a single-purpose helper that tries to load PMR's Claude Agent SDK adapter at runtime and returns wrapped SDK options only when available.

**Implementation requirements:**
1. Create a new service `claude-project-memory-loader.ts`.
2. Use a fixed environment variable:
   - `XUANPU_CLAUDE_PROJECT_MEMORY_ADAPTER`
3. Support both input forms:
   - direct file path to PMR adapter entry, for example:
     `/Users/.../project-memory-runtime/packages/adapters/claude-agent-sdk/dist/index.js`
   - adapter package directory, which must resolve to:
     `<dir>/dist/index.js`
4. Dynamically import the adapter using `pathToFileURL(...).href`.
5. Expect the imported module to expose:
   - `withProjectMemory(options, config?)`
6. Export a single public helper:

```ts
export async function maybeWithClaudeProjectMemory(options: Options): Promise<Options>
```

7. The helper must:
   - return the original `options` immediately if the env var is missing
   - return the original `options` if the file/path does not exist
   - return the original `options` if the module loads but has no `withProjectMemory`
   - return the original `options` if the wrapper throws
   - log each of these cases at `info` or `warn` level, but never throw
8. Pass this config into `withProjectMemory()`:

```ts
{
  cwd: options.cwd,
  agent_id: 'xuanpu'
}
```

9. Cache the loaded wrapper by resolved specifier so repeated prompts do not re-import it every turn.
10. Add a small `__testing__` export with:
   - `resolveAdapterEntry(path: string): string`
   - `resetCache(): void`

**Behavioral contract:**
- PMR is **opt-in**, local-only, and runtime-only.
- Xuanpu must not know anything about PMR package installation.
- This loader is the only PMR-specific file in the repo.

---

## Task 2: Wire PMR Only Into the Main Claude Prompt Path

**Files:**
- Modify: `src/main/services/claude-code-implementer.ts`

**Objective:** Wrap the main `sdk.query()` options for real coding sessions, but leave all other Claude SDK usage untouched.

**Implementation requirements:**
1. Import `maybeWithClaudeProjectMemory` from the new loader service.
2. In `ClaudeCodeImplementer.prompt(...)`, change the SDK options variable from `const options` to `let options`.
3. After all existing option mutations are complete:
   - after `options.mcpServers` / `options.allowedTools` LSP augmentation
   - before `options.resume`
   - before `options.forkSession` / `options.resumeSessionAt`
4. Insert:

```ts
options = await maybeWithClaudeProjectMemory(options)
```

5. Do not move the existing logic ordering except for this one wrapper call.

**Why this placement matters:**
- PMR should see the final `cwd`, permission mode, MCP server list, tool list, and env.
- Resume/fork metadata should still be applied by Xuanpu after PMR wrapping, so Xuanpu remains the owner of session continuity semantics.

**Explicitly do not modify:**
- `src/main/services/claude-session-title.ts`
- `src/main/services/claude-sdk-loader.ts`
- undo/redo helper query path in `rewindWithResumedQuery()`

**v1 boundary:**
- PMR only wraps the main prompt path used for real Claude coding sessions.
- Lightweight helper queries remain unchanged.

---

## Task 3: Add Focused Tests

**Files:**
- Create: `test/phase-21/session-2/claude-project-memory-loader.test.ts`
- Modify: `test/phase-21/session-6/claude-prompt-model.test.ts`

**Objective:** Prove the integration is optional, non-breaking, and actually wired into the prompt path.

### Test A: Loader no-op when env is absent

Create `claude-project-memory-loader.test.ts` covering:

1. When `XUANPU_CLAUDE_PROJECT_MEMORY_ADAPTER` is unset:
   - `maybeWithClaudeProjectMemory(inputOptions)` returns the exact original object
2. When the configured path does not exist:
   - returns the original object
3. When `resolveAdapterEntry()` receives a directory path:
   - it resolves to `dist/index.js`

Notes:
- Mock `logger`
- Reset module cache between cases
- Use a real temporary directory for the directory-resolution test

### Test B: Existing prompt tests stay stable

Modify `claude-prompt-model.test.ts`:

1. Mock the new loader:

```ts
vi.mock('../../../src/main/services/claude-project-memory-loader', () => ({
  maybeWithClaudeProjectMemory: vi.fn(async (options) => options)
}))
```

2. Keep the existing expectations on `sdk.query(...)`.
3. Add one new assertion to verify the wrapper was called with an options object containing:
   - `cwd`
   - `model`

Do not rewrite the whole prompt test suite; only isolate it from the new loader and assert the integration point exists.

---

## Task 4: Add a Short Internal Usage Note

**Files:**
- Create: `docs/implementation/PMR_XUANPU_LOCAL_SETUP.md`

**Objective:** Document how the local developer enables PMR on their own machine without affecting anyone else.

**Document content requirements:**
1. State that PMR support is optional and disabled by default.
2. State that no extra dependency is required in Xuanpu.
3. Show the required environment variable:

```bash
export XUANPU_CLAUDE_PROJECT_MEMORY_ADAPTER=/Users/slicenfer/Development/projects/self/project-memory-runtime/packages/adapters/claude-agent-sdk/dist/index.js
```

4. Show how to run Xuanpu afterward:

```bash
pnpm dev
```

5. Explain fallback behavior:
   - if the env var is missing, Xuanpu uses raw Claude SDK
   - if the path is broken, Xuanpu logs a warning and uses raw Claude SDK
6. Explicitly state:
   - this does **not** require teammates to install PMR
   - this does **not** affect packaged builds for other users

Keep this doc short and operational, not architectural.

---

## Verification Steps

Run these commands from the Xuanpu repo root:

```bash
pnpm exec eslint src/main/services/claude-project-memory-loader.ts src/main/services/claude-code-implementer.ts test/phase-21/session-2/claude-project-memory-loader.test.ts test/phase-21/session-6/claude-prompt-model.test.ts
pnpm exec vitest run --project main test/phase-21/session-2/claude-project-memory-loader.test.ts test/phase-21/session-6/claude-prompt-model.test.ts
```

Then do one manual smoke check:

1. Start Xuanpu without `XUANPU_CLAUDE_PROJECT_MEMORY_ADAPTER`
2. Confirm Claude sessions still work as before
3. Set `XUANPU_CLAUDE_PROJECT_MEMORY_ADAPTER` to the local PMR adapter build output
4. Start Xuanpu again
5. Confirm Claude sessions still work and PMR warnings/errors do not appear unless the path is invalid

Optional local smoke check:
- Use a git-backed worktree
- Trigger one or two Claude coding prompts
- Verify PMR's database starts receiving events in the configured shared/local runtime location

---

## Acceptance Criteria

- Xuanpu builds and tests without any PMR package dependency.
- When the PMR env var is absent, behavior is unchanged.
- When the PMR env var points to a valid local adapter build, `ClaudeCodeImplementer.prompt()` wraps options through PMR.
- When the PMR env var is invalid, prompts still run and only warnings are logged.
- `claude-session-title.ts` remains untouched.
- `claude-sdk-loader.ts` remains PMR-agnostic.

---

## Implementation Notes for Claude

- Favor the smallest possible change set.
- Treat PMR as a private local enhancement, not a first-class product feature yet.
- Do not add UI toggles, DB flags, or settings panels in this task.
- Do not attempt to generalize this to OpenCode or Codex in the same change.
- If any existing prompt tests are brittle because of unrelated Electron mocks, isolate the new loader with mocks rather than broadening the feature scope.
