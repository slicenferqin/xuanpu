# xuanpu-agent 根治方案：基于 oh-my-pi 二开的 turn-scoped runtime

日期：2026-06-01
状态：实施设计
分支：`feat/xuanpu-agent-oh-my-pi`
面向读者：mimno / 继续实现 `xuanpu-agent` 的工程 agent

## 结论

当前 `xuanpu-agent` 不是一个真正由玄圃拥有上下文和 provider 请求的 runtime。

它现在是：

```text
Xuanpu context / tools / budget / events
  -> adapter
  -> npm @oh-my-pi/pi-agent-core Agent
  -> Agent.prompt(...)
  -> oh-my-pi stateful conversation loop
```

这只是 **oh-my-pi adapter 集成**，不是原计划里需要的 **基于 oh-my-pi 二开的玄圃原生
runtime**。

根治目标不是在当前 adapter 上过滤几个事件，而是把 `xuanpu-agent` 改成：

```text
Xuanpu-owned turn-scoped runtime
  owns: session / turn / context / provider request / usage / UI events / DB snapshots
  uses: oh-my-pi fork or vendored core for model loop / tool calling / provider adapters
```

换句话说：

```text
玄圃拥有上下文和执行边界。
oh-my-pi 只提供薄模型循环和 provider/tool 基础设施。
```

## 背景：这次 dogfood 暴露的问题

真实 dogfood 会话：

```text
opencode_session_id: xuanpu-agent-7ff9615d-810e-4809-9310-09332993777b
hive session id:    09918cbf-60b9-4aa3-b755-20db38efbe36
runtime:            xuanpu-agent
model:              openai/gpt-5.5
```

数据侧事实：

```text
session_messages: 29 rows = 14 user + 15 assistant
usage_entries: 12 rows
field_context_packages: 12 rows
session_usage_snapshots: 0 rows
field_episode_blocks: 5 rows
field_memory_pages: 35 proposed rows
```

累计 provider usage：

```text
input_tokens       241,691
output_tokens       15,467
cache_write_tokens       0
cache_read_tokens  775,168
total_tokens     1,032,326
```

用户看到的早期异常也属实：到 `2026-05-31T09:30:59Z` 那轮累计为 `509,865` tokens。

更关键的是现象：

```text
用户发出新问题
  -> UI 先在当前用户消息下面显示上一条 assistant 回复
  -> 模型真正生成结束后再被最终答案替换 / 覆盖
```

这不是纯 UI 闪烁，而是 runtime 语义错位。

## 根因

当前主路径大致如下：

```text
XuanpuAgentImplementer.prompt()
  -> field.getPriorTurns(sessionId)
  -> packContext({ workingSet: priorMessages, currentRequest: text })
  -> harnessMessages = packedContext.messages
  -> piSession.prompt(harnessMessages, modelRef, handlers)
  -> XuanpuPiAgentSession.getOrCreateAgent()
  -> agent.prompt(inputArray)
```

关键问题有三个。

### 1. 历史 assistant 被当成本轮 prompt message

`context-packer.ts` 当前把 working set 里的 turn 直接转换为 prompt message：

```ts
function createConversationMessage(turn: FieldTurn, fallbackTimestamp: number): XuanpuPiPromptMessage {
  return {
    role: turn.role,
    content: [{ type: 'text', text: turn.content }],
    timestamp: typeof turn.createdAt === 'number' ? turn.createdAt : fallbackTimestamp
  }
}
```

所以历史 assistant turn 会变成：

```ts
{ role: 'assistant', content: [...] }
```

然后作为 `Agent.prompt(inputArray)` 的一部分传给 oh-my-pi。

### 2. oh-my-pi 会 echo prompt messages

`@oh-my-pi/pi-agent-core/src/agent-loop.ts` 中，`agentLoop(prompts, context, ...)` 会先把传入的
每条 prompt message 作为事件发出来：

```ts
for (const prompt of prompts) {
  stream.push({ type: "message_start", message: prompt });
  stream.push({ type: "message_end", message: prompt });
}
```

这对 oh-my-pi 自己是合理语义：它把 prompt messages 视作本轮新输入。

但对玄圃不合理：玄圃把历史上下文也塞进了 prompt array。

### 3. xuanpu runtime 把 prompt echo 当成模型新输出

`src/main/services/xuanpu-agent/runtime.ts` 中当前逻辑只看：

```text
event.type === 'message_update' && role === 'assistant'
event.type === 'message_end' && role === 'assistant'
```

它没有区分：

```text
历史 assistant prompt echo
模型本轮新 assistant delta
```

于是旧 assistant 回复被转成 `onTextDelta()`，进入 renderer streaming buffer。

## 为什么这不能靠小补丁解决

可以临时过滤 prompt echo，但这只是挡住 UI 症状。

真正的问题是两个 runtime model 冲突：

```text
玄圃想要：
每轮由 Context Packer 编译完整上下文，provider 只看本轮 snapshot。

oh-my-pi 默认：
Agent 是 stateful conversation，自己持有 messages/provider session，
prompt 是追加到当前 conversation 的新输入。
```

因此当前出现了四个不一致：

```text
Context Packer: 我认为我已经把上下文压到 2K-8K。
oh-my-pi Agent: 我仍然持有长期 state.messages / provider session state。
Provider Usage: 我实际每轮仍然看到/缓存十几万 token 级上下文。
UI Context Budget: 我只展示了 packer 的 managed context 压力。
```

根治必须收回 provider request 控制权。

## 目标不变量

实现完成后，以下不变量必须成立。

### INV-TURN-1：provider 每轮输入只能来自 turn snapshot

provider 实际看到的 messages/tools/model/config 必须由本轮 `AgentTurnSnapshot` 生成。

禁止任何隐藏输入源：

```text
长期 agent.state.messages
长期 providerSessionState
长期 provider session id continuation
未入库的 in-memory transcript
renderer optimistic content
```

### INV-TURN-2：session 是产品概念，turn 是 provider 执行边界

`session_id` 可以长期存在。

但每次用户 prompt 必须创建新的 `turn_id`，且 provider request、streaming buffer、usage、
context package 都挂在 `turn_id` 上。

### INV-TURN-3：输入、上下文、模型输出必须有 origin

所有 runtime event 必须有 origin：

```ts
type XuanpuTurnEventOrigin =
  | 'context'
  | 'prompt'
  | 'model'
  | 'tool'
  | 'system'
```

只有：

```text
origin === 'model' && role === 'assistant'
```

可以进入 assistant streaming bubble。

### INV-TURN-4：Context Budget 必须能和 provider request 对账

每轮必须同时记录：

```text
managed context tokens
provider estimated input tokens
provider actual input tokens
provider cache read/write tokens
provider total tokens
provider request hash
```

UI 不允许只展示 managed context 的 `approx_tokens` 后暗示这是 provider 实际上下文。

### INV-TURN-5：每轮 provider request 可回放

任意 `turn_id` 必须能从 SQLite 还原：

```text
system prompt
context messages
current user prompt
tools schema
model config
provider session policy
budget decisions
provider request hash
```

### INV-TURN-6：长会话单轮输入必须稳态

连续 50 轮短问答后，第 10 轮以后的单轮 provider input/cache 规模不能线性增长。

允许 session cumulative usage 增长。

不允许单轮 provider request 因隐藏历史持续增大。

## 目标架构

新增清晰分层：

```text
src/main/services/xuanpu-agent/
  turn/
    turn-id.ts
    turn-runner.ts
    turn-events.ts
    turn-snapshot.ts
    provider-request-builder.ts
    provider-request-recorder.ts

  runtime/
    xuanpu-turn-runtime.ts
    pi-core-adapter.ts
    pi-event-router.ts
    pi-agent-factory.ts

  context/
    context-packer.ts
    turn-context-compiler.ts
    token-estimator.ts

  budget/
    context-budget-ledger.ts
    provider-usage-ledger.ts

  db/
    turn-repository.ts
```

现有的 `src/main/services/xuanpu-agent/runtime.ts` 不应继续作为长期 stateful session wrapper。
它可以被拆分或替换为 `runtime/pi-core-adapter.ts`。

新主链路：

```text
XuanpuAgentImplementer.prompt()
  -> create turn_id
  -> persist user message
  -> build XFP / field snapshot / retrieval / memory / prior turn candidates
  -> TurnContextCompiler.compile(...)
  -> ProviderRequestBuilder.build(...)
  -> ProviderRequestRecorder.persist(...)
  -> XuanpuTurnRunner.run(...)
  -> PiEventRouter.map(...)
  -> persist assistant message
  -> persist usage + budget + final turn status
```

## oh-my-pi 二开策略

这次不要再把 `@oh-my-pi/pi-agent-core` 当不可变黑盒。

有两条可选路线。

### 推荐路线 A：workspace vendor/fork

把 oh-my-pi core 纳入仓库或 workspace，形成玄圃可控包：

```text
packages/xuanpu-pi-agent-core/
packages/xuanpu-pi-ai/
```

然后 `package.json` 改为：

```json
{
  "dependencies": {
    "@xuanpu/pi-agent-core": "workspace:*",
    "@xuanpu/pi-ai": "workspace:*"
  }
}
```

优点：

- 可以改 `Agent` / `agentLoop` 的事件语义。
- 可以加 turn-scoped API。
- 可以加 provider request snapshot hook。
- 可以禁用/显式化 provider session state。
- 后续不被 npm 包更新破坏不变量。

代价：

- 要承担 fork 维护。
- 后续 upstream merge 需要规范。

### 路线 B：厚 adapter + upstream patch

暂时继续依赖 npm 包，但写一个很厚的 `XuanpuPiCoreAdapter`，并尽量不改 node_modules。

要求：

- 每轮 fresh Agent。
- 每轮 `reset()`。
- 每轮 `providerSessionState = undefined`。
- 每轮 turn-scoped `sessionId`。
- 禁止直接传 `packedContext.messages` 到 `prompt(array)`。
- 所有 oh-my-pi 事件都先过 `PiEventRouter`。

缺点：

- 仍受 oh-my-pi 事件模型限制。
- provider request snapshot 可能拿不到最底层真实 payload。
- 长期仍会堆 workaround。

如果目标是“不考虑代价，只要结果”，应选路线 A。

## 新 API：runTurn

不要继续让玄圃业务层调用：

```ts
agent.prompt(inputArray)
```

新增玄圃语义 API：

```ts
export interface XuanpuRunTurnInput {
  turnId: string
  sessionId: string
  worktreePath: string
  modelRef: XuanpuAgentModelRef
  systemPrompt: string[]
  contextMessages: XuanpuProviderMessage[]
  promptMessage: XuanpuProviderMessage
  tools: XuanpuToolDefinition[]
  toolMode: 'plan' | 'build'
  providerSessionPolicy: ProviderSessionPolicy
  budget: XuanpuTurnBudget
  requestSnapshot: XuanpuProviderRequestSnapshot
}

export interface ProviderSessionPolicy {
  mode: 'disabled' | 'explicit-prefix-cache' | 'provider-continuation'
  providerSessionId?: string
  providerSessionStateKey?: string
  reason: string
}

export interface XuanpuRunTurnResult {
  turnId: string
  assistantMessageId: string
  text: string
  rawAssistantMessage?: unknown
  usage?: XuanpuProviderUsage
  events: XuanpuTurnEvent[]
}
```

默认：

```ts
providerSessionPolicy = {
  mode: 'disabled',
  reason: 'xuanpu owns turn-scoped context; hidden provider continuation is disabled'
}
```

只有未来明确实现 prefix cache ledger 后，才能打开 `explicit-prefix-cache`。

`provider-continuation` 不得作为默认模式；它只适合兼容迁移或显式 resume 场景。

## Context Packer 输出协议重写

当前 `packContext()` 返回裸 `messages`，这正是 bug 入口。

改成不可误用的结构：

```ts
export interface PackedTurnContext {
  turnId: string
  sessionId: string
  xfpPacketId: string

  stablePrefix: ContextRegion
  volatileContext: ContextRegion[]
  workingSet: PackedConversationTurn[]
  retrievedMemory: PackedMemoryPage[]
  retrievedEpisodes: PackedEpisode[]
  currentRequest: XuanpuProviderMessage

  providerContextMessages: XuanpuProviderMessage[]
  providerPromptMessage: XuanpuProviderMessage

  budget: {
    profile: 'focused' | 'balanced' | 'extended'
    managedApproxTokens: number
    providerEstimatedInputTokens: number
    maxContextTokens: number
    fillRatio: number
  }

  audit: {
    prefixHash: string
    providerRequestHash: string
    includedMessageIds: string[]
    omittedMessageIds: string[]
    dedupedMessageIds: string[]
    includedEpisodeIds: string[]
    omittedEpisodeIds: string[]
    retrievalReasons: Record<string, string>
  }
}
```

禁止：

```ts
packedContext.messages
```

所有调用方必须显式写：

```ts
turnRunner.run({
  contextMessages: packed.providerContextMessages,
  promptMessage: packed.providerPromptMessage,
  ...
})
```

### 历史对话的表达方式

Working set 可以保留 user/assistant 对话角色，但它必须作为 provider context，而不是作为本轮
prompt echo 源。

若继续使用 oh-my-pi 原始 `Agent.prompt()`，必须这样调用：

```ts
const agent = createFreshAgentForTurn(...)
agent.reset()
agent.providerSessionState = undefined
agent.sessionId = turnId
agent.replaceMessages(providerContextMessages)
await agent.prompt(providerPromptMessage)
```

不得这样调用：

```ts
await agent.prompt([...providerContextMessages, providerPromptMessage])
```

根治版 fork 应提供 `runTurn()`，内部不再对 context messages 产生 prompt echo events。

## Event Router 重写

新增 `PiEventRouter`，成为 oh-my-pi event 到 CanonicalAgentEvent 的唯一出口。

输入事件：

```ts
interface PiRawEventEnvelope {
  turnId: string
  raw: unknown
  receivedAt: number
}
```

输出事件：

```ts
interface XuanpuTurnEvent {
  turnId: string
  sessionId: string
  sequence: number
  origin: 'context' | 'prompt' | 'model' | 'tool' | 'system'
  kind:
    | 'turn.started'
    | 'input.message'
    | 'model.message.started'
    | 'model.message.delta'
    | 'model.message.completed'
    | 'tool.started'
    | 'tool.completed'
    | 'turn.completed'
    | 'turn.failed'
  messageId?: string
  role?: 'user' | 'assistant' | 'tool' | 'system'
  delta?: string
  data?: Record<string, unknown>
}
```

renderer 只消费 `XuanpuTurnEvent`，不能直接消费 oh-my-pi event。

映射规则：

```text
prompt echo user message       -> origin=prompt, kind=input.message
prompt echo assistant message  -> origin=context, kind=input.message, not streamable
model assistant delta          -> origin=model, kind=model.message.delta
tool start/end                 -> origin=tool
budget/status/diagnostics      -> origin=system
```

UI streaming 规则：

```text
origin=model AND role=assistant -> render assistant streaming text
origin=tool                     -> render tool card
origin=prompt/context/system    -> never render as assistant answer text
```

## Turn-scoped renderer buffer

当前 streaming buffer 以 session 为主，容易出现旧 overlay 和新 turn 混叠。

改成：

```ts
interface TurnStreamingBuffer {
  turnId: string
  sessionId: string
  userMessageId: string
  assistantMessageId?: string
  status: 'running' | 'idle' | 'error'
  startedAt: number
  lastSequence: number
  parts: StreamingPart[]
}
```

store 结构：

```ts
streamingByTurnId: Record<string, TurnStreamingBuffer>
activeTurnBySessionId: Record<string, string>
```

关键行为：

- `beginLocalSessionRun()` 必须创建 `turnId` 或接收 main process 返回的 `turnId`。
- `message.part.updated` 必须带 `turnId`。
- idle refresh 清理的是 turn run state，而不是误清 session 全局 overlay。
- tab 切换后按 `turnId` 恢复，不从 session 级 residual parts 猜测当前 turn。

## 数据库改造

新增 turn 级表。

### agent_turns

```sql
CREATE TABLE agent_turns (
  id TEXT PRIMARY KEY,
  session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  worktree_id TEXT REFERENCES worktrees(id) ON DELETE SET NULL,
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  runtime_id TEXT NOT NULL,
  user_message_id TEXT,
  assistant_message_id TEXT,
  status TEXT NOT NULL CHECK (status IN ('running', 'completed', 'failed', 'aborted')),
  model_provider_id TEXT,
  model_id TEXT,
  model_variant TEXT,
  started_at TEXT NOT NULL,
  completed_at TEXT,
  error_message TEXT
);

CREATE INDEX idx_agent_turns_session_started
  ON agent_turns(session_id, started_at ASC);
```

### agent_turn_context_snapshots

```sql
CREATE TABLE agent_turn_context_snapshots (
  id TEXT PRIMARY KEY,
  turn_id TEXT NOT NULL REFERENCES agent_turns(id) ON DELETE CASCADE,
  session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  xfp_packet_id TEXT,
  provider_request_hash TEXT NOT NULL,
  prefix_hash TEXT,
  managed_context_json TEXT NOT NULL,
  provider_messages_json TEXT NOT NULL,
  provider_tools_json TEXT NOT NULL,
  provider_config_json TEXT NOT NULL,
  decisions_json TEXT NOT NULL,
  managed_approx_tokens INTEGER NOT NULL DEFAULT 0,
  provider_estimated_input_tokens INTEGER NOT NULL DEFAULT 0,
  max_context_tokens INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL
);

CREATE UNIQUE INDEX idx_agent_turn_context_turn
  ON agent_turn_context_snapshots(turn_id);
```

### agent_turn_usage_events

不要只存一个 assistant message usage。应按 provider usage event 记账，避免以后和 Codex 一样被
单 turn 多 usage event 覆盖。

```sql
CREATE TABLE agent_turn_usage_events (
  id TEXT PRIMARY KEY,
  turn_id TEXT NOT NULL REFERENCES agent_turns(id) ON DELETE CASCADE,
  session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  source_event_id TEXT NOT NULL,
  provider_id TEXT,
  model_id TEXT,
  input_tokens INTEGER NOT NULL DEFAULT 0,
  output_tokens INTEGER NOT NULL DEFAULT 0,
  cache_write_tokens INTEGER NOT NULL DEFAULT 0,
  cache_read_tokens INTEGER NOT NULL DEFAULT 0,
  total_tokens INTEGER NOT NULL DEFAULT 0,
  cost REAL NOT NULL DEFAULT 0,
  raw_usage_json TEXT NOT NULL,
  occurred_at TEXT NOT NULL,
  created_at TEXT NOT NULL
);

CREATE UNIQUE INDEX idx_agent_turn_usage_source
  ON agent_turn_usage_events(turn_id, source_event_id);
```

### 与现有表的关系

保留：

```text
session_messages
usage_entries
field_context_packages
```

但后续语义调整为：

- `session_messages`：用户可见 transcript。
- `agent_turns`：执行边界。
- `agent_turn_context_snapshots`：provider request 可回放事实。
- `agent_turn_usage_events`：provider usage 原子账本。
- `usage_entries`：兼容现有 UI 的聚合视图，可由 `agent_turn_usage_events` roll up。
- `field_context_packages`：可继续作为 Context Budget/Inspector 的展示摘要，但必须从
  `agent_turn_context_snapshots.managed_context_json` 派生，不能 response 后重算。

## Context Budget UI 口径

当前 UI 的“上下文压力”容易误导，因为它只展示 managed context。

新 UI 至少展示三组数字：

```text
Managed context
  approx tokens / max context tokens
  included / omitted sections

Provider request
  estimated input tokens
  provider request hash
  prefix hash
  message count

Provider actual
  input tokens
  cache read tokens
  cache write tokens
  output tokens
  turn total tokens
```

示例：

```text
Managed: 2.6k / 150k
Provider input: 15.3k
Cache read: 121.3k
Turn total: 138.4k
```

不要再把 `managed approxTokens` 单独展示成“上下文压力”。

## Provider session / cache 策略

默认禁用 provider continuation：

```ts
providerSessionPolicy.mode = 'disabled'
```

原因：

- 当前第一目标是 provider 输入稳态。
- 隐藏 provider session state 会让 Context Budget 失真。
- 自动 continuation 会让 DB 无法还原 provider 实际上下文。

后续若要做 prefix cache，应单独实现 `explicit-prefix-cache`：

```text
stablePrefix bytes
  -> prefixHash
  -> provider-specific cache control / automatic cache observation
  -> provider usage cacheRead/cacheWrite
  -> Context Budget cache metrics
```

原则：

```text
可以利用 provider cache。
不能利用 provider hidden history。
```

## 实施阶段

### Phase 0：冻结当前 claim，补 dogfood 复现测试

目标：先防止继续误判“稳态已完成”。

任务：

1. 新增 dogfood fixture，复现 session `xuanpu-agent-7ff9615d-810e-4809-9310-09332993777b`
   的关键模式。
2. 在 `test/phase-24/xuanpu-agent-runtime.test.ts` 增加 fake agent mode：

   ```text
   XUANPU_AGENT_FAKE_EVENT_MODE=prompt-echoes
   ```

3. fake agent 行为：

   ```text
   receive prompt/context array
   emit message_start/message_end for each input prompt
   include at least one role=assistant prompt echo
   emit real model assistant delta/end
   ```

4. 断言：

   - 旧 assistant prompt echo 不进入 `onTextDelta`。
   - 最终 assistant text 只来自 real model output。
   - `pendingAssistantMessages` 不选择 prompt echo 作为最终答案。

验收：

```bash
pnpm vitest run test/phase-24/xuanpu-agent-runtime.test.ts
```

### Phase 1：引入 turn id 和 turn repository

目标：把 provider 执行边界从 session 拆出来。

任务：

1. 新增 migration：

   - `agent_turns`
   - `agent_turn_context_snapshots`
   - `agent_turn_usage_events`

2. 新增 main DB methods：

   ```ts
   createAgentTurn(...)
   updateAgentTurnStatus(...)
   createAgentTurnContextSnapshot(...)
   createAgentTurnUsageEvent(...)
   listAgentTurns(sessionId)
   getAgentTurnContextSnapshot(turnId)
   ```

3. `XuanpuAgentImplementer.prompt()` 开始创建 `turnId`。
4. 所有 emitted runtime events 带 `turnId`。

验收：

- 每次 xuanpu-agent prompt 都有一条 `agent_turns`。
- 成功、失败、abort 都能落最终 status。
- session reload 后能按 turn 顺序恢复。

测试：

```bash
pnpm vitest run test/phase-24/xuanpu-agent-turn-repository.test.ts
pnpm vitest run test/phase-24/xuanpu-agent-ipc-smoke.test.ts
```

### Phase 2：重写 Context Packer 输出协议

目标：禁止裸 `messages` 被误当成 prompt array。

任务：

1. 将 `packContext()` 输出从：

   ```ts
   { messages, decisions, ... }
   ```

   改为：

   ```ts
   PackedTurnContext
   ```

2. 删除或 deprecated `packedContext.messages`。
3. 明确产出：

   ```ts
   providerContextMessages
   providerPromptMessage
   ```

4. `createContextPackage()` 只能消费 `PackedTurnContext`，禁止内部重新 retrieval。
5. `field_context_packages.decisions_json` 写入：

   - `turnId`
   - `providerRequestHash`
   - `prefixHash`
   - `includedMessageIds`
   - `omittedMessageIds`
   - `providerEstimatedInputTokens`

验收：

- 全仓 `rg "packedContext\\.messages"` 只剩测试里的负例或 migration 说明。
- `field_context_packages` 与 `agent_turn_context_snapshots` 的 package/request hash 一致。

测试：

```bash
pnpm vitest run test/phase-24/xuanpu-agent-context-packer.test.ts
pnpm vitest run test/phase-24/xuanpu-agent-context-package.test.ts
```

### Phase 3：引入 ProviderRequestBuilder 和 request snapshot

目标：provider 实际请求可回放、可对账。

任务：

1. 新增 `provider-request-builder.ts`：

   ```ts
   buildProviderRequest({
     packedContext,
     modelRef,
     tools,
     toolMode,
     providerSessionPolicy
   }): XuanpuProviderRequestSnapshot
   ```

2. `providerRequestHash` 计算必须稳定：

   - 排除 volatile `createdAt`。
   - 包含 system prompt、context messages、prompt message、tools schema、modelRef、session policy。

3. 在调用模型前写入 `agent_turn_context_snapshots`。
4. 如果模型调用失败，snapshot 仍必须存在。

验收：

- 任意 failed turn 也能查看 provider request snapshot。
- request hash 在同输入下 byte-identical。

测试：

```bash
pnpm vitest run test/phase-24/xuanpu-agent-provider-request-builder.test.ts
```

### Phase 4：替换 XuanpuPiAgentSession 为 turn-scoped runner

目标：彻底移除长期 stateful Agent 对 provider 输入的控制权。

推荐实现：

```ts
export class XuanpuTurnRunner {
  async run(input: XuanpuRunTurnInput): Promise<XuanpuRunTurnResult> {
    const agent = await this.agentFactory.createForTurn(input)
    agent.reset()
    agent.providerSessionState = undefined
    agent.sessionId = input.turnId
    agent.replaceMessages(input.contextMessages)
    return this.piCoreAdapter.runPrompt(agent, input.promptMessage, input)
  }
}
```

如果已 fork oh-my-pi，则优先新增：

```ts
agent.runTurn({
  contextMessages,
  promptMessage,
  emitPromptEcho: false,
  providerSessionPolicy
})
```

任务：

1. `getOrCreateAgent()` 改为 `createAgentForTurn()`。
2. 每轮 fresh Agent 或 hard reset。
3. 禁止复用 `agent.state.messages`。
4. 禁止默认 providerSessionState。
5. `sessionId` 改为 turn-scoped。
6. tool hooks、system prompt、model、getApiKey 在每轮显式设置。

验收：

- 连续多轮后，`agent.state.messages` 不作为下一轮隐式输入。
- provider request snapshot 与实际传给 model loop 的 context 一致。

测试：

```bash
pnpm vitest run test/phase-24/xuanpu-agent-turn-runner.test.ts
pnpm vitest run test/phase-24/xuanpu-agent-runtime.test.ts
```

### Phase 5：PiEventRouter 和 renderer turn buffer

目标：UI 不再可能把 context/prompt echo 当成 assistant 输出。

任务：

1. 新增 `pi-event-router.ts`。
2. 所有 oh-my-pi raw events 先映射成 `XuanpuTurnEvent`。
3. CanonicalAgentEvent 增加或携带：

   ```text
   turnId
   origin
   eventSequence
   ```

4. renderer `useSessionRuntimeStore` 改为 turn-scoped streaming buffer。
5. `AgentTimeline` 按 active turn 渲染 streaming nodes。
6. session idle refresh 后按 turn 清理状态。

验收：

- prompt echo assistant message 不显示。
- 刷新 / 切 tab / idle refresh 不造成旧 streaming bubble 复活。
- 当前用户消息下面只出现当前 turn 的 model-origin assistant 输出。

测试：

```bash
pnpm vitest run test/phase-24/xuanpu-agent-session-shell-dogfood.test.tsx
pnpm vitest run test/phase-24/xuanpu-agent-runtime-status.test.ts
```

### Phase 6：usage ledger 和 Context Budget 对账

目标：让 UI token 数字可复现。

任务：

1. provider usage 原子事件写入 `agent_turn_usage_events`。
2. `usage_entries` 从 turn usage rollup 派生，保持兼容。
3. `session.context_usage` payload 改为：

   ```ts
   {
     managedContext: {...},
     providerRequest: {...},
     providerActual: {...}
   }
   ```

4. Session HQ Context Budget 展示三层指标。
5. 无 provider usage 时显示 `source: unavailable`，不能写 0 冒充真实值。

验收：

- session 总 token = turn usage event sum。
- UI 展示值可从 DB 查询复现。
- dogfood session 的 `managed 2.6k` 和 `provider 138k` 会同时显示，不再互相掩盖。

测试：

```bash
pnpm vitest run test/phase-24/xuanpu-agent-usage-ledger.test.ts
pnpm vitest run test/phase-24/context-budget-debugger.test.tsx
```

### Phase 7：稳态压力测试

目标：证明根治结果，而不是证明局部模块能跑。

新增长会话测试：

```text
create xuanpu-agent session
for i in 1..50:
  send short prompt
  fake provider returns short answer
assert:
  providerEstimatedInputTokens stabilizes after warmup
  context snapshot message count stabilizes
  omittedMessageIds increases
  no hidden agent.state.messages growth affects next turn
  no prompt echo appears in streaming output
```

真实 provider dogfood 验收：

```text
至少 15 轮中文连续对话
中途插入长小说设定文本
再切回 xuanpu-agent 架构问题
检查：
  managed context bounded
  provider input/cache bounded or explainable
  UI 不闪旧 assistant
  memory proposals 不把小说设定污染为 worktree 约束
```

测试：

```bash
pnpm vitest run test/phase-24/xuanpu-agent-context-steady-state.test.ts
pnpm run probe:xuanpu-agent-built-mock
```

## 必须删除或废弃的旧语义

以下内容如果继续存在，根治就没有完成。

### 1. 长期 `XuanpuPiAgentSession.agent`

当前字段：

```ts
private agent: PiAgentLike | null = null
private lastModelKey: string | null = null
```

必须废弃。

保留长期 session object 可以，但不能保留长期 provider conversation state。

### 2. `getOrCreateAgent()`

当前 `getOrCreateAgent()` 会复用同一个 Agent。

改为：

```ts
createAgentForTurn()
```

或 fork 后直接：

```ts
createTurnRuntime()
```

### 3. `agent.prompt(inputArray)` 作为主入口

主入口必须变成：

```ts
runTurn({ contextMessages, promptMessage })
```

### 4. `ContextBudgetManager.transformContext` 作为主压缩机制

`transformContext` 可以保留为 emergency guard，但不能再是主上下文控制点。

主控制点必须是模型调用前的：

```text
TurnContextCompiler -> ProviderRequestBuilder
```

### 5. response 后重新计算 context package

`field_context_packages` 必须从本轮已持久化的 `PackedTurnContext` / `ProviderRequestSnapshot`
派生，不能在 response 后重新 retrieval。

## 与既有文档的关系

本文覆盖 `docs/plans/2026-05-27-xuanpu-agent-context-drift-remediation.md` 中 M7 的修复方向。

旧 M7 的核心要求仍保留：

```text
Context Packer 是 active prompt 唯一装配入口。
Context Budget 记录模型实际所见。
旧 turns freeze/offload 后从 active prompt 移除。
```

但本文新增更强要求：

```text
active prompt 控制权不只在 packer，还必须落到 provider request snapshot。
oh-my-pi 不再拥有跨轮上下文。
UI streaming 必须基于 turnId + origin。
```

`docs/plans/2026-05-23-xuanpu-agent-oh-my-pi-runtime.md` 中写过 “no fork of oh-my-pi” 是 spike 阶段非目标。

现在 dogfood 已证明 adapter 层不足，因此该非目标作废。新的目标是：

```text
fork / vendor / workspace 化 oh-my-pi core，或至少实现等价的 turn-scoped adapter。
```

## 实施顺序建议

推荐 PR 分层：

```text
PR 1: failing tests + turn id/event schema
PR 2: DB migration + turn repository
PR 3: Context Packer output protocol rewrite
PR 4: ProviderRequestBuilder + snapshot persistence
PR 5: TurnRunner replaces stateful XuanpuPiAgentSession
PR 6: PiEventRouter + renderer turn-scoped streaming buffer
PR 7: usage ledger + Context Budget UI three-layer metrics
PR 8: long-session steady-state tests + dogfood probes
PR 9: oh-my-pi fork/workspace cleanup, remove legacy adapter paths
```

每个 PR 都要有独立验收，不能等到最后一次性发现 provider 实际上下文仍失控。

## 最终验收清单

### 代码层

- `rg "getOrCreateAgent" src/main/services/xuanpu-agent` 无主路径命中。
- `rg "packedContext\\.messages" src/main/services/xuanpu-agent` 无主路径命中。
- `rg "agent\\.prompt\\(.*\\[" src/main/services/xuanpu-agent` 无主路径命中。
- `XuanpuAgentImplementer.prompt()` 每轮创建 `turnId`。
- provider request snapshot 在模型调用前持久化。
- oh-my-pi raw event 不直接进入 renderer。

### 数据层

- 每个 xuanpu-agent user prompt 对应一条 `agent_turns`。
- 每个 completed/failed turn 都有 `agent_turn_context_snapshots`。
- usage 可从 `agent_turn_usage_events` 原子求和。
- `field_context_packages` 和 turn snapshot 的 hash 能对上。

### UI 层

- 新问题发送后，不显示上一条 assistant 回复。
- streaming bubble 只来自当前 active turn。
- Context Budget 同时展示 managed / provider request / provider actual。
- provider usage 不可用时明确显示 unavailable。

### 稳态层

- 50 轮 fake provider 测试通过。
- 15 轮真实 provider dogfood 中，单轮 provider input/cache 不随 session 长度线性增长。
- 长文本插曲后，后续问题不把插曲无关内容长期保留在 active provider request。

### 可回放层

给定任意 `turn_id`，开发者可以回答：

```text
这一轮用户说了什么？
这一轮 XFP packet 是什么？
哪些旧消息被包含 / 省略 / 去重？
哪些 memory / episode 被召回，为什么？
实际发给 provider 的 messages/tools/model/config 是什么？
provider 返回了多少 input/output/cache tokens？
UI 为什么显示这些 context budget 数字？
```

如果这些问题不能从 DB 和日志回答，根治未完成。

## 一句话交付口径

这次不是修一个旧回复闪烁 bug。

这次要把 `xuanpu-agent` 从：

```text
oh-my-pi Agent.prompt() 的外围 adapter
```

改成：

```text
玄圃拥有 turn / context / provider request / usage / UI event 的原生 runtime，
oh-my-pi 只是可二开的模型循环内核。
```

只有做到这一层，玄圃才能合理宣称：

```text
xuanpu-agent 的上下文稳态是实际 provider 层面的稳态，而不只是 UI/packer 层面的估算。
```
