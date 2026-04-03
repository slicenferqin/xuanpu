# PMR Local Setup for Xuanpu

PMR (Project Memory Runtime) support is **optional** and **disabled by default**. No extra dependency is required in Xuanpu.

## Enable PMR

Set the environment variable before starting Xuanpu:

```bash
export XUANPU_CLAUDE_PROJECT_MEMORY_ADAPTER=/Users/slicenfer/Development/projects/self/project-memory-runtime/packages/adapters/claude-agent-sdk/dist/index.js
```

Then start normally:

```bash
pnpm dev
```

## Fallback Behavior

- If `XUANPU_CLAUDE_PROJECT_MEMORY_ADAPTER` is **not set**, Xuanpu uses the raw Claude SDK as-is.
- If the path is **invalid or broken**, Xuanpu logs a warning and uses the raw Claude SDK. Prompts are not interrupted.

## Scope

- This does **not** require teammates to install PMR.
- This does **not** affect packaged builds for other users.
- PMR wrapping only applies to the main Claude coding prompt path (`ClaudeCodeImplementer.prompt()`). Title generation and other lightweight helper queries are not affected.
