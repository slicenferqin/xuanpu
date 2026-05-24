# Xuanpu Agent 1.5.0: Context-Native Harness

Date: 2026-05-24
Status: Planning
Target: Xuanpu 1.5.0
Branch context: `feat/xuanpu-agent-oh-my-pi`

## Thesis

Xuanpu 1.5.0 should make `xuanpu-agent` the first agent built around the Xuanpu Field Protocol
(XFP).

The product bet is not "another Claude Code clone." The bet is that Xuanpu can own the agent's
field, context budget, context offloading, command-output compression, memory, permission surface,
and timeline. The model provider is replaceable. The harness and context layer are the durable
product.

We do not sell tokens. Model providers benefit when users send more tokens, repeat stale context,
and keep noisy command output in the prompt. Xuanpu's advantage should be the opposite:

- keep the model's active context small, fresh, and relevant
- offload old work into structured, inspectable memory
- compress command output before it pollutes the conversation
- make every included context block visible and debuggable
- preserve enough raw references to recover fidelity when needed

## North Star

```text
Xuanpu provides the field.
xuanpu-agent implements the protocol.

Field events, worktree state, terminal output, file focus, prior sessions, episode blocks, pinned
facts, project memory, and command traces are not ad hoc prompt text. They are first-class
observable inputs compiled by Xuanpu and consumed by xuanpu-agent through XFP.
```

By 1.5.0, xuanpu-agent should be able to perform useful repository work inside Xuanpu while keeping
its context explainable:

```text
User asks for work
  -> Xuanpu captures the field through XFP
  -> xuanpu-agent plans with a bounded context package
  -> read-only tools inspect the repo
  -> command output is compressed before model ingestion
  -> relevant episodes and memory pages are retrieved on demand
  -> write actions request permission and produce inspectable diffs
  -> completion freezes durable episode blocks for future sessions
```

## Current Baseline

The `feat/xuanpu-agent-oh-my-pi` branch has proven the first runtime loop:

- `xuanpu-agent` can be registered behind `XUANPU_AGENT_RUNTIME=1`.
- It can call an OpenAI-compatible provider using the user's Codex config and auth.
- It can generate `field_context_packages`.
- It records `Current Field`, `Current User Message`, `Frozen Episodes`, and `Retrieved Episodes`.
- It can freeze at least one episode block and retrieve it through gated retrieval.
- Context Budget can inspect package sections, model refs, runtime id, and policy decisions.

Known limitations:

- Harness is still effectively no-tools.
- Streaming and timeline events need polish.
- The no-tools boundary must be clearer for tasks that require repo inspection.
- Image and attachment handling is not yet a real multimodal contract.
- xuanpu-agent currently proves provider/context wiring, not full coding-agent usefulness.

## Strategic Direction

### Use oh-my-pi as the Thin Runtime Substrate

Keep the current oh-my-pi/pi direction for the model runtime and basic agent lifecycle. It is thin
enough that Xuanpu can own the higher-level protocol.

oh-my-pi should not become the product boundary. It is the model execution substrate.

### Build the Harness in Xuanpu

xuanpu-agent needs a Xuanpu-owned harness:

- tool loop
- command execution
- file read/write/edit
- git inspection
- permission requests
- event normalization
- context package compilation
- context offload and retrieval
- command-output compression
- memory read/write policy

OpenClaude and Claude Code are valuable references for harness behavior, but the Xuanpu harness
should be implemented as Xuanpu-native modules. We should borrow product lessons and design
patterns, not surrender the core runtime shape.

### Make XFP the Protocol Boundary

XFP should define what "the field" means:

- current worktree and branch
- active file, selection, visible tabs
- recent user and assistant turns
- terminal/process/test state
- git status/diff/log summaries
- command traces and compressed outputs
- episode blocks
- memory pages
- pinned facts and project rules
- permission/audit state

xuanpu-agent should not scrape the UI or infer workspace state from unstructured prompts. It should
request or receive field packets compiled by Xuanpu.

## Architecture

```text
src/main/services/xuanpu-agent/
  runtime/              # oh-my-pi/pi model execution adapter
  harness/              # Xuanpu-owned agent loop
  xfp/                  # XFP packet types, compiler inputs, validation
  context/              # context packer, budget profiles, offload policy
  memory/               # memory page store, retrieval, update policy
  tools/                # read/write/git/shell tool implementations
  permissions/          # permission checks and UI request events
  command-compression/  # command output parsing, summarization, trace compaction
  events/               # harness events -> CanonicalAgentEvent
  checkpoints/          # resumable steady-state session packets
```

The key ownership rule:

```text
Xuanpu owns field, context, permission, event, and memory.
The model runtime only consumes compiled messages and returns actions/text.
```

## Core Concepts

### XFP Field Packet

An XFP field packet is a bounded, structured description of the current workbench state. It is not a
raw prompt prefix.

It should include:

- packet id and timestamp
- project/worktree/session identifiers
- branch/head/dirty status
- visible file/selection state
- recent terminal/test summaries
- command trace summaries
- active task goal if known
- context budget metadata
- raw references for every nontrivial claim

Every XFP field packet should answer:

```text
What did the agent see?
Where did it come from?
Why was it included?
What was omitted?
How can the user inspect it?
```

### Steady-State Context

The agent should not grow a conversation forever. Every turn should compile a fresh bounded context
from durable state:

```text
Anchor
  stable protocol, project rules, pinned facts

Current Field
  current worktree, visible file, selection, terminal/test/git state

Working Set
  recent high-fidelity turns and tool results

Retrieved Memory
  relevant memory pages and episode blocks

Current Request
  the user's active instruction
```

The steady-state context goal:

```text
The active prompt should be small enough to reason well and large enough to avoid amnesia.
```

Default budget targets:

- Focused: 32K-64K
- Balanced: 80K-150K
- Extended: 150K-200K
- Max: manual only

The default should not chase the largest available context window.

### Context Offloading

Context offloading is the process of moving old high-fidelity transcript/tool output out of the
active working set into durable, queryable stores.

Offload targets:

- episode blocks for completed turns or task segments
- command traces for raw stdout/stderr plus compressed summaries
- memory pages for durable facts, decisions, constraints, and project knowledge
- checkpoint packets for resumable in-flight work

Offloading must preserve raw refs:

```text
summary without refs is lore
summary with refs is memory
```

### Command Execution Compression

Command output is often the fastest way to destroy context quality. Inspired by tools such as RTK,
Xuanpu should intercept command output before it reaches the model and turn it into a structured
trace:

```text
raw command output
  -> parser/profile
  -> compressed model summary
  -> retained raw artifact/ref
  -> visible timeline output
  -> context budget accounting
```

Compression profiles should exist for common command families:

- `git status`, `git diff`, `git log`
- `pnpm test`, `vitest`, `playwright`
- `tsc`, `eslint`, `prettier`
- `cargo`, `go test`, `pytest`
- build tools with long warnings
- package managers and dependency resolution

The model should see:

- command
- cwd
- exit code
- duration
- important errors
- changed files
- failing tests
- relevant excerpts
- truncation/compression decision
- raw trace id

The user should still be able to inspect raw output in Xuanpu.

### Memory

GBrain is a useful directional reference: memory should not be one giant prompt blob. It should be a
local-first, queryable, editable knowledge system that agents can read from and write to.

Xuanpu memory should be scoped:

- user memory
- project memory
- worktree memory
- session memory
- episode memory
- command memory

Memory writes need policy:

- do not save trivial chatter
- do not save transient build noise as durable fact
- require raw refs
- separate facts from decisions and hypotheses
- make memory pages inspectable and editable
- support deletion and correction
- guard against memory poisoning

Memory retrieval should be explicit in Context Budget:

```text
Memory page included because file path matched src/main/...
Episode included because user referred to "上次那个失败"
Command trace included because last test failure matches current file
```

## Harness Roadmap

### M0: Runtime Closure

Goal: turn the current spike into a reliable no-tools runtime.

Scope:

- fix final assistant message selection across reused sessions
- stabilize real provider configuration through Codex-compatible env
- polish no-tools boundary responses
- make streaming assistant text reliable in Session HQ
- keep Context Budget as the source of truth for what the agent saw

Exit criteria:

- repeated prompts produce fresh responses
- context package records model/runtime/user message accurately
- no-tools requests are answered honestly
- xuanpu-agent can be dogfooded without confusing stale output

### M1: XFP v1 Contract

Goal: formalize XFP as the contract between Xuanpu and xuanpu-agent.

Deliverables:

- `XfpFieldPacket` shared type
- packet compiler in main process
- packet validator
- packet repository/audit trail
- Context Budget rendering for packet decisions
- tests for packet size, source refs, and omission reasons

Exit criteria:

- xuanpu-agent consumes XFP packets, not ad hoc Field Context strings
- every included section has a reason and source refs
- every omitted candidate can report why it was omitted

### M2: Read-Only Harness

Goal: make xuanpu-agent genuinely useful for repository understanding without write risk.

Tools:

- `git_status`
- `git_log`
- `git_diff`
- `list_files`
- `read_file`
- `rg_search`
- `inspect_package_scripts`

Policy:

- read-only tools allowed in trusted worktrees
- large outputs always compressed
- raw output stored as trace artifact
- tool events appear in Session HQ timeline

Exit criteria:

- user can ask "看下当前分支最近提交/上游变化" and xuanpu-agent actually inspects git state
- user can ask "这个错误可能在哪" and xuanpu-agent can search/read relevant files
- Context Budget shows command traces and file refs included in the answer

### M3: Command Compression Layer

Goal: prevent shell/tool output from becoming prompt garbage.

Deliverables:

- command trace table
- compression profiles
- raw output artifact retention
- compressed summary format
- timeline raw/compressed toggle
- budget accounting for raw vs compressed size

Exit criteria:

- long test/build output is summarized before model ingestion
- failures preserve exact error lines and file paths
- user can open raw trace when needed
- repeated command outputs do not bloat the working set

### M4: Controlled Write Harness

Goal: enable small coding tasks with inspectable writes.

Tools:

- `apply_patch`
- `write_file`
- `edit_file`
- `run_test`
- `format_file`

Policy:

- writes require diff preview or explicit trust mode
- dangerous paths blocked by default
- generated patches tied to source context refs
- test output compressed before re-entering the model
- rollback/revert path visible

Exit criteria:

- xuanpu-agent can make a small code edit, run a focused test, and explain the diff
- all file writes appear in timeline and can be audited
- failed tests loop back into the harness with compressed failure context

### M5: Memory Graph

Goal: turn project/session knowledge into durable, scoped memory.

Deliverables:

- memory page schema
- entity/reference extraction
- project/worktree/session scopes
- memory write proposals
- memory correction/deletion UI
- retrieval reasons in Context Budget

Exit criteria:

- completed tasks produce useful memory without saving noise
- future tasks retrieve relevant decisions and constraints
- memory pages are editable, inspectable, and ref-backed

### M6: Advanced Harness

Goal: reach Claude Code-class task reliability with Xuanpu-native control.

Scope:

- MCP integration
- subtask delegation
- checkpoint/resume
- long-running command supervision
- multi-worktree awareness
- PR/review workflows
- hub/mobile event propagation

Exit criteria:

- xuanpu-agent can run multi-step engineering tasks while preserving Xuanpu's context and permission
  model.

## Product Surfaces

### Session HQ

Needs first-class cards for:

- XFP packet compiled
- tool permission requested
- tool running
- compressed command output
- raw trace available
- memory write proposed
- episode frozen
- checkpoint created

### Context Budget

Context Budget should become the agent's black box recorder:

- budget profile
- included sections
- omitted sections
- frozen episodes available
- retrieved episodes included
- memory pages included
- command traces included
- raw refs
- token estimates
- compression ratios
- safety/policy decisions

### XFP Inspector

XFP Inspector should show:

- packet history
- field event sources
- packet diff between turns
- why a packet changed
- missing sources
- stale sources
- privacy/storage policy

## Metrics

Track these per turn:

- raw candidate context chars/tokens
- final active context tokens
- compression ratio
- command output raw vs compressed
- number of retrieved episodes
- number of retrieved memory pages
- stale-context incidents
- repeated-answer incidents
- permission prompts shown/accepted/denied
- tool failure recovery rate
- user-visible raw-output opens

The core quality metric:

```text
Did the agent solve the task with less context, less noise, and better inspectability?
```

## Principles

1. Xuanpu owns the field.
2. xuanpu-agent implements XFP first.
3. Context is compiled, not appended.
4. Old work is offloaded, not forgotten.
5. Summaries require raw refs.
6. Command output is data exhaust until compressed.
7. Memory is scoped, editable, and ref-backed.
8. Large context windows are a fallback, not a goal.
9. The model is replaceable; the harness is product.
10. We optimize for user work, not provider token consumption.

## Open Questions

- Should read-only tools be enabled by default for trusted worktrees?
- Should command traces store raw output in SQLite, files, or both?
- What is the minimal XFP packet schema needed before read-only tools land?
- Should memory writes be automatic, proposed, or manually accepted in 1.5.0?
- How should xuanpu-agent distinguish durable project memory from ephemeral session episode blocks?
- Can RTK-style compression profiles be implemented in-process, or should Xuanpu support external
  compressor binaries?
- Should OpenClaude be used only as a harness reference, or also as an optional external runtime
  adapter for comparison?

## Immediate Next Steps

1. Commit the current runtime bugfix that selects the latest assistant message.
2. Add an XFP v1 shared type draft.
3. Implement a read-only `git_status` + `git_log` harness spike.
4. Add command trace storage and one compression profile for `git log`.
5. Extend Context Budget to display command trace inclusion and compression ratio.
6. Write the first dogfood script: "summarize upstream changes in this worktree."

## References

- RTK / Rust Token Killer: command-output compression before command output enters the model
  context.
- GBrain: local-first long-term memory direction for AI agents.
- OpenClaude / Claude Code-style harness: reference for coding-agent tool loops, permission flow,
  streaming events, and task UX.
