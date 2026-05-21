# Claude / Codex Prompt Cache 命中率优化方案

日期：2026-05-21

适用范围：玄圃 Claude Code / Codex 两条主链路

## 背景

玄圃已经有 Token Saver、Field Context、usage analytics 和 context indicator，但这些能力主要解决
“少给模型看无效输出”或“看见 token 消耗”。下一步如果从省 token 和提高缓存命中率出发，核心问题不是再
简单压缩一段文本，而是让发给 provider 的 prompt 结构更利于 prompt cache。

两家 provider 的机制不同，但对玄圃的工程结论相同：

- Prompt cache 更喜欢稳定前缀。
- 已缓存 token 通常会更便宜，但仍会占用模型上下文窗口。
- 动态现场不应该被删除，否则玄圃失去相对 TUI 的价值。
- 正确方向是把上下文拆成“稳定前缀”和“动态后缀”，并让命中率可观测。

参考资料：

- Anthropic Prompt Caching: https://docs.anthropic.com/en/docs/build-with-claude/prompt-caching
- OpenAI Prompt Caching: https://platform.openai.com/docs/guides/prompt-caching

## 当前现状

### Claude Code

Claude 链路在 `src/main/services/claude-code-implementer.ts` 中通过 Agent SDK 调用
`sdk.query()`。玄圃目前会：

- 每轮设置 `appendSystemPrompt: XUANPU_SYSTEM_CONTEXT`。
- 按 session mode 设置 `permissionMode`。
- 根据配置附加 LSP MCP server、Token Saver MCP server。
- 读取 Claude SDK usage 中的 `cache_read_input_tokens` 和 `cache_creation_input_tokens`。

这说明玄圃已经能看见 Claude 的 cache read/write 数据，但还没有围绕 cache hit 做产品化指标，也没有把
Field Context 设计成 cache-friendly 的结构。

### Codex

Codex 链路通过 `src/main/services/codex-app-server-manager.ts` 的 `turn/start` 发送 turn。
当前 `sendTurn()` 默认构造：

```ts
{
  threadId,
  input: [{ type: 'text', text }]
}
```

当有 mode / developer instructions 时，会额外带 `collaborationMode.settings`。

Codex provider 会通过 `thread/tokenUsage/updated` 返回 `cachedInputTokens`。玄圃已经在
`src/main/services/codex-implementer.ts` 把它映射为 `cacheRead`，因此 Codex 是最容易先做
cache hit 可视化的一条链路。

### Field Context

当前 `src/main/ipc/agent-handlers.ts` 在每次非 slash command prompt 前构造 Field Context，并 prepend
到用户消息：

```text
[Field Context — as of ...]
...

[User Message]
<user input>
```

这带来两个问题：

1. 每轮都注入完整上下文，导致上下文窗口持续膨胀。
2. Field Context 中包含 `asOf`、最近终端、最近活动、当前焦点等高变内容，不利于跨 session / 同类任务
   的缓存复用。

注意：这不代表 Field Context 一定会破坏同一 thread 内所有历史缓存。新一轮请求的新增动态块通常位于
prompt 尾部，provider 仍可能命中过去历史前缀。但玄圃重复注入不变的静态事实，会持续增加输入和上下文
占用，即使命中 cache，也会让会话更快接近 compaction。

## 目标

1. 降低 Claude / Codex 每轮新增 uncached input tokens。
2. 提高同一 session 后续 turn 的 cache read 比例。
3. 减少重复注入静态上下文造成的 context window 膨胀。
4. 保留玄圃的现场感知能力，不为了 cache 删除 Live Context。
5. 让用户能看到玄圃是否真的在省 token。

## 非目标

- 不重写 Claude Code / Codex runtime。
- 不直接绕过 Claude Agent SDK 或 Codex app-server 调 API。
- 不把 Field Context 整体关掉。
- 不承诺跨 provider 的统一 prompt cache key，因为 Claude Code / Codex app-server 暴露能力不同。

## 设计原则

### 1. Stable First, Live Last

上下文按稳定性排序：

```text
Provider / SDK system prompt
Xuanpu stable instructions
Project static context
Session static memory
Conversation history
Live context delta
User message
```

越稳定的内容越靠前，越动态的内容越靠后。

### 2. Static Once, Delta Later

静态上下文不应该每轮完整重复。

第一轮：

```text
[Xuanpu Static Context]
- project rules
- pinned facts
- worktree notes
- semantic memory digest

[Xuanpu Live Context]
- focus
- last terminal
- recent activity

[User Message]
...
```

后续轮次：

```text
[Xuanpu Live Context Delta]
- changed focus
- latest terminal error
- recent diff summary

[User Message]
...
```

如果 static digest 变化，再补发：

```text
[Xuanpu Static Context Updated]
digest: old -> new
...
```

### 3. Provider Capability Aware

Claude 和 Codex 能力不同：

| 能力 | Claude Code | Codex |
|---|---|---|
| cache usage 可见 | `cache_read_input_tokens` / `cache_creation_input_tokens` | `cachedInputTokens` |
| 直接 cache_control | 由 Claude Code / Agent SDK 内部控制，玄圃不直接标 breakpoint | app-server 当前未明确暴露 |
| 结构化 input | 支持 text / image / document blocks | app-server 支持 `input[]` text item |
| 可先做的优化 | SDK 动态段排除 + Field Context 分层 | cache hit 可视化 + input item 分层 |

### 4. Cache Hit 是指标，不是唯一目标

需要同时看：

- `cache_read_tokens`
- `cache_write_tokens`
- `fresh_input_tokens`
- `cache_hit_rate = cache_read / (fresh_input + cache_read)`
- `context_window_used`
- `repeated_static_tokens_estimate`

如果 cache hit 高但 context window 快速膨胀，仍然是失败设计。

## 方案

### Phase 1：Cache Hit 可观测化

目标：先证明玄圃当前缓存表现，不盲改。

#### 后端

在统一 `session.context_usage` payload 中补充可选字段：

```ts
cache?: {
  readTokens: number
  writeTokens: number
  freshInputTokens: number
  hitRate: number
  source: 'claude-usage' | 'codex-token-usage' | 'opencode-tokens'
}
```

Claude：

- 从 assistant message usage 读取：
  - `input_tokens`
  - `cache_read_input_tokens`
  - `cache_creation_input_tokens`
- `freshInputTokens = input_tokens`
- `readTokens = cache_read_input_tokens`
- `writeTokens = cache_creation_input_tokens`

Codex：

- 从 `thread/tokenUsage/updated.tokenUsage.last` 读取：
  - `inputTokens`
  - `cachedInputTokens`
- 当前代码已做 `input = inputTokens - cachedInputTokens`。
- `freshInputTokens = inputTokens - cachedInputTokens`
- `readTokens = cachedInputTokens`
- `writeTokens = 0`

#### 前端

在现有 Context / Cost tooltip 中增加：

```text
Cache hit: 87%
Fresh input: 8.1k
Cache read: 49.2k
Cache write: 0
```

Session 级 usage summary 增加均值：

```text
Avg cache hit: 74%
Best turn: 93%
Worst turn: 0%
```

#### 验收

- Claude 和 Codex 都能在 UI 看到最近一轮 cache hit。
- Codex 使用现有 fixtures 能稳定解析 `cachedInputTokens`。
- 无 usage 数据时 UI 不显示假 0%，而是显示 `unknown`。

### Phase 2：Claude SDK 动态段排除

目标：利用 Claude Agent SDK 已暴露的 cache-friendly 选项。

本地 `@anthropic-ai/claude-agent-sdk` 类型中已有 `excludeDynamicSections`，说明 SDK 支持把 per-user
dynamic sections 从 cached system prompt 中排除，并改为作为 user message 注入。

建议在 Claude options 中启用：

```ts
excludeDynamicSections: true
```

落点：

- `src/main/services/claude-code-implementer.ts`
- 构造 `Options` 的地方

风险：

- 只对 preset system prompt 生效；如果 Claude Code 内部判断为 custom prompt，可能无效果。
- 动态段位置改变后，模型对 cwd / memory path 的权重可能略降。

缓解：

- 加开关：`provider_prompt_cache_optimization_enabled`
- 默认打开，设置页可关闭。
- 日志记录是否启用。

验收：

- Claude 会话正常启动。
- cache read/write 指标可见。
- 没有新增 `No response requested.` 或 resume 行为回退。

### Phase 3：Field Context 分层

目标：停止每轮重复发送静态上下文。

新增结构：

```ts
interface FieldContextPackage {
  staticContext: {
    digest: string
    markdown: string
    approxTokens: number
    sections: string[]
  } | null
  liveContext: {
    markdown: string
    approxTokens: number
    sections: string[]
  } | null
}
```

Static sections：

- Worktree identity：project/worktree/branch
- Worktree notes
- Pinned facts
- Semantic memory
- Project conventions
- Stable resumed checkpoint summary

Live sections：

- `asOf`
- Current focus
- Selection
- Last terminal command/output
- Recent activity
- Recent agent file read/write
- Dynamic warnings

新增 formatter：

```ts
formatStableFieldContext(snapshot)
formatLiveFieldContext(snapshot)
formatFieldContextPackage(snapshot)
```

Session 级状态：

```ts
staticContextDigestBySession: Map<hiveSessionId, string>
```

发送策略：

1. 如果 session 没发过 static digest：发送 static + live。
2. 如果 static digest 未变化：只发送 live。
3. 如果 static digest 变化：发送 static update + live。

注意：digest 要用 canonical markdown 计算，不能包含 `asOf`、event id、时间戳、随机排序。

验收：

- 第二轮同 session 不再重复发送 Pinned Facts / Semantic Memory 全文。
- Field Context Debug 能显示本轮发送了 `static+live`、`live-only` 或 `static-updated+live`。
- Static digest 变更后下一轮能补发。

### Phase 4：结构化 input item

目标：保留上下文边界，让 provider 更容易命中稳定片段，也便于未来精确控制。

Claude 当前 text-only 会 flatten 为字符串。建议即使没有文件，也使用 content blocks：

```ts
[
  { type: 'text', text: staticContext },
  { type: 'text', text: liveContext },
  { type: 'text', text: userMessage }
]
```

Codex 当前可以传 `input[]`：

```ts
[
  { type: 'text', text: staticContext },
  { type: 'text', text: liveContext },
  { type: 'text', text: userMessage }
]
```

短期不要假设 provider 会按 item 做 cache boundary，但结构化边界至少让玄圃后续能：

- 对 static/live 分别计算 token。
- 对 debug UI 显示更清楚。
- 对 Codex app-server 新参数做兼容实验。

验收：

- 纯文本 prompt、带图片 prompt、带 PDF prompt 都能正常发送。
- UI 仍只展示用户原文，不展示注入块。
- `session.message` field event 仍记录 original user message。

### Phase 5：Codex Cache Key 实验

目标：在 Codex app-server 支持时，稳定 prompt cache 归属。

因为玄圃不是直连 OpenAI Responses API，而是通过 Codex app-server。当前 `turn/start` 参数没有显式
`prompt_cache_key` / retention。不能默认加未知字段影响稳定性。

实验设计：

```ts
if (process.env.XUANPU_CODEX_PROMPT_CACHE_KEY === '1') {
  params.prompt_cache_key = buildCodexPromptCacheKey({
    workspacePath,
    model,
    mode,
    staticContextDigest
  })
}
```

key 格式：

```text
xuanpu:<workspaceHash>:<model>:<mode>:<staticDigest>
```

要求：

- 默认关闭。
- 如果 app-server 报 unknown field，自动熔断本进程实验开关。
- 只记录是否成功，不把 key 暴露到 UI。

验收：

- 默认不开启时行为完全不变。
- 开启后如果 app-server 不支持，turn 不失败。
- 开启后如果支持，观察 `cachedInputTokens` 是否更稳定。

## UI 设计

### Context Indicator

新增一行：

```text
Cache 87% · Fresh 8.1k · Read 49.2k
```

tooltip：

```text
Prompt cache
- Fresh input: 8,112
- Cache read: 49,280
- Cache write: 0
- Hit rate: 85.9%

Context package
- Static: skipped (same digest)
- Live: 1,432 tokens
```

### Field Context Debug

增加 metadata：

```json
{
  "mode": "live-only",
  "staticDigest": "sha256:...",
  "staticSent": false,
  "liveTokens": 1432,
  "staticTokens": 0
}
```

### Usage Analytics

Session summary 增加：

- total fresh input
- total cache read
- total cache write
- average cache hit rate
- estimated cache savings

## 数据与存储

短期不需要新表，可以先用现有 message usage 和 session activity 派生。

如果要做长期看板，再加：

```sql
CREATE TABLE provider_cache_metrics (
  id TEXT PRIMARY KEY,
  session_id TEXT NOT NULL,
  runtime_id TEXT NOT NULL,
  turn_id TEXT,
  model_id TEXT,
  fresh_input_tokens INTEGER NOT NULL DEFAULT 0,
  cache_read_tokens INTEGER NOT NULL DEFAULT 0,
  cache_write_tokens INTEGER NOT NULL DEFAULT 0,
  hit_rate REAL,
  static_digest TEXT,
  package_mode TEXT,
  created_at TEXT NOT NULL
);
```

## 风险

### 风险 1：缓存命中率提高，但现场价值下降

缓解：Live Context 不取消，只限制 token budget 和位置。

### 风险 2：Static 只发一次后，模型忘掉项目规则

缓解：Static 仍在 conversation history 里；如果 session compaction 后摘要丢失，checkpoint / compaction
事件触发 static refresh。

### 风险 3：Claude / Codex 对结构化 input 的语义不完全一致

缓解：先保持文本内容一致，只改变分块；加回退开关。

### 风险 4：cache hit 指标口径混乱

缓解：统一定义：

```text
hitRate = cacheRead / (freshInput + cacheRead)
```

Claude 的 cache write 不算入 denominator，因为它是写入成本，不是本轮命中。

## 推荐排期

### v1.4.9.x

1. Cache hit UI / logging。
2. Claude `excludeDynamicSections` 开关。
3. Codex cache metric 从 `cachedInputTokens` 到 UI。

### v1.5

1. Field Context static/live 分层。
2. Static digest session cache。
3. Field Context Debug 显示 package mode。

### v1.5.x 实验

1. Codex prompt cache key feature flag。
2. Provider cache analytics 看板。

## 最小验收脚本

1. 新建 Claude session，连续发送 5 条相关 prompt。
2. 查看每轮 cache read/write 是否进入 UI。
3. 新建 Codex session，连续发送 5 条相关 prompt。
4. 查看 `cachedInputTokens` 是否映射为 cache hit。
5. 修改 Pinned Facts，发送下一条 prompt。
6. 确认 static digest 变化后只补发一次 Static Context Updated。
7. 再发送一条 prompt，确认变回 live-only。

## 最终判断

玄圃最值得做的不是“再压一次上下文”，而是建立一套 provider cache-aware 的 context packaging：

```text
Stable Context 负责缓存命中。
Live Context 负责现场感。
Metrics 负责证明它真的省钱。
```

这条路线和玄圃当前优势一致：Warp/TUI 能跑 agent，但很难系统性控制 prompt package；玄圃正好可以在
agent 入口前做这层优化。
