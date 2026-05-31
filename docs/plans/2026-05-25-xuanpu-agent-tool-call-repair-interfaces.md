# 玄圃 Agent 工具调用修复层：四件套 TypeScript 接口草案

日期：2026-05-25
状态：规划中
目标版本：玄圃 1.5.0
相关分支：`feat/xuanpu-agent-oh-my-pi`
关联文档：`docs/plans/2026-05-24-xuanpu-agent-1.5.0-context-native-harness.zh-CN.md`

## 动机

玄圃 1.5.0 的 plan 把 xuanpu-agent 拆成了 runtime / harness / xfp / context / memory /
tools / permissions / command-compression / events / checkpoints 这十层，但是
**完全没提工具调用本身的失败模式修复**。在只跑 Anthropic + Claude Code harness 的时代，
这层可以被模型本身的高 fidelity 工具协议藏起来。一旦 xuanpu-agent 真的要接非 Anthropic
模型（gpt-5.5、DeepSeek、本地 Qwen / Llama 系列），这些失败模式会立刻冒头：

```text
1. 模型把工具参数拍平，不知道嵌套结构。
2. 模型把工具调用写进 reasoning，忘了输出到 tool_calls 字段。
3. 模型流式返回到一半被截断，工具参数 JSON 不完整。
4. 模型在 loop 里反复对同一个工具发同样的 args，陷入 storm。
```

plan-review 已经把 AI-3「错误分类」标记成 M2 的硬要求。其中 `MALFORMED_TOOL_CALL`
这条错误码就是为这层量身定的：没有修复层，玄圃只能把这种错误一股脑透给用户，
用户看到的就是「agent 莫名其妙地卡住 / 复读 / 沉默」。

Reasonix（DeepSeek-Reasonix）已经把这套修复机制做出来了，对应 Pillar 2
「Tool-Call Repair」四件套：`flatten`、`scavenge`、`truncation`、`storm`。
玄圃需要在 M1（XFP v1）落地之后、M2（只读 Harness）启用工具之前，**先把这层接口和
分类抽出来**——不需要立刻实现所有 profile，但 interface 必须在那时就稳定，因为
M2 一启用工具就会马上撞上这四种失败。

本文档的目标：把 Reasonix 的四件套**重写**成玄圃语境下的实现草案，给出 TypeScript
interface、处理流程伪代码、触发阈值、与 plan-review 错误分类的映射，以及与
Session HQ / Context Budget / XFP packet 的集成位置。

## 设计原则

1. **修复发生在 harness 边界，不在模型内部。** 模型给什么就是什么，玄圃负责把它
   解析、修复、再投递给 tool dispatch。
2. **修复必须可观测。** 每一次 flatten / scavenge / truncation / storm 触发都要
   进 Session HQ timeline，并被 Context Budget 记账（修复消耗的 token 也是 token）。
3. **修复必须可关闭。** 每个 profile 都要能被 per-runtime / per-model 关掉，
   否则没法做 A/B 评估「不修是不是更稳」。
4. **修复必须可追溯到 raw refs。** 命令压缩层已经定了这条原则，工具修复层也是：
   修过的 tool_call 必须能拿回模型原始输出。
5. **修复不是 prompt 工程。** 这层只动 protocol 层（JSON、tool_calls 字段、
   reasoning_content 字段），不动 system prompt。Prompt 调整是另外的事。
6. **修复要分清「修复」和「重试」。** flatten / truncation 是修复（同一轮内解决），
   scavenge 是补救（这一轮没拿到，下一轮补），storm 是抑制（不让无效轮继续）。
7. **命名向玄圃 codebase 靠拢。** 不叫 `ToolRepairManager`，叫 `ToolCallRepairer`；
   不叫 `RepairStep`，叫 `ToolCallRepairProfile`。

## 一、Flatten：拍平嵌套参数

### 问题

非 Anthropic 模型对深嵌套 / 多 leaf 的 JSON schema 处理质量参差不齐。例如：

```json
{
  "patch": {
    "files": [
      { "path": "src/foo.ts", "edits": [ { "range": { ... }, "text": "..." } ] }
    ]
  }
}
```

模型常见失败：把 `patch.files[0].edits[0].range.start.line` 直接写成顶层 key，
或者干脆只填一层 path 就交差。

### 处理思路

在 `ToolRegistry.register()` 时静态分析 schema，如果命中阈值就标记为「需要 flatten
呈现」。把这个工具暴露给模型时，schema 用点号路径形式扁平化；模型给的扁平 args
进到 dispatch 时再 re-nest 回原 schema。

### 触发阈值（照抄 Reasonix 默认值，玄圃 1.5.0 不调）

- leaf 参数总数 > 10
- schema 深度 > 2
- 单个数组 leaf 超过 1 个

### 接口草案

```ts
export type FlattenLeaf = {
  path: string           // 点号路径，例如 'patch.files[].edits[].text'
  jsonType: 'string' | 'number' | 'boolean' | 'object' | 'array'
  required: boolean
  description?: string
}

export type FlattenedSchema = {
  toolName: string
  leaves: FlattenLeaf[]
  originalSchema: unknown
  reason: 'leaf_count' | 'depth' | 'array_leaves' | 'manual'
}

export interface ToolCallFlattener {
  analyze(toolName: string, schema: unknown): FlattenedSchema | null
  presentForModel(flat: FlattenedSchema): unknown
  rehydrate(flat: FlattenedSchema, modelArgs: Record<string, unknown>): unknown
}
```

### 流程伪代码

```text
on ToolRegistry.register(tool):
  flat = flattener.analyze(tool.name, tool.schema)
  if flat:
    tool.modelFacingSchema = flattener.presentForModel(flat)
    tool.flattenedSchema = flat
  else:
    tool.modelFacingSchema = tool.schema

on dispatch(toolCall):
  if tool.flattenedSchema:
    args = flattener.rehydrate(tool.flattenedSchema, toolCall.args)
  else:
    args = toolCall.args
  return tool.fn(args)
```

### 玄圃特有注意事项

- `analyze` 的结果要在 XFP packet 的 tool catalog section 里展示，让用户知道
  「这个工具被 flatten 过」。
- `rehydrate` 失败要走错误分类（见后文），不能静默把缺失字段填默认值——那等于
  替模型撒谎。
- M4「受控写入 Harness」里的 `apply_patch` 工具一定会撞上 flatten（嵌套很深），
  得在那个里程碑前测好。

## 二、Scavenge：从 reasoning 里捞被遗忘的工具调用

### 问题

DeepSeek-R1 / o1 / gpt-5.5 系列在 reasoning_content 里写「I'll call `read_file`
with path src/foo.ts」但 tool_calls 字段是空的。Anthropic 的 Claude 不太干这事，
但开源模型干得很欢。

### 处理思路

每轮 LLM 响应到手后，如果 `tool_calls` 为空但 `reasoning_content`（或推理 trace）
非空，跑一遍 regex + JSON parser 扫描，看能不能从推理里捞出 tool name + JSON args
的组合。捞到的会被「补」进 `tool_calls`，进 dispatch。

### 触发阈值

- `tool_calls.length === 0` 且 `reasoning_content` 非空
- reasoning 长度 > 200 chars（太短一般是真的没工具调用）
- 模型属于「会把工具写进 reasoning」的家族（DeepSeek-R1、o1、gpt-5.5 thinking 等）

### 接口草案

```ts
export type ScavengedToolCall = {
  toolName: string
  args: Record<string, unknown>
  source: 'reasoning_content' | 'message_content' | 'fenced_code'
  rawSpan: { start: number; end: number; text: string }
  confidence: 'high' | 'medium' | 'low'
}

export type ScavengeContext = {
  modelFamily: string
  reasoningContent?: string
  messageContent?: string
  emittedToolCalls: number
  registeredTools: { name: string; schema: unknown }[]
}

export interface ToolCallScavenger {
  shouldRun(ctx: ScavengeContext): boolean
  scavenge(ctx: ScavengeContext): ScavengedToolCall[]
}
```

### 流程伪代码

```text
on llmResponse(response):
  if scavenger.shouldRun(ctx):
    found = scavenger.scavenge(ctx)
    for call in found:
      if call.confidence === 'low':
        emit timeline event 'tool_call_scavenge_skipped' with reason
        continue
      response.toolCalls.push(call)
      emit timeline event 'tool_call_scavenged' with raw rawSpan
  return response
```

### 玄圃特有注意事项

- 捞回来的 tool call 在 Session HQ timeline 里要打上 `scavenged` 标签，**不能**
  伪装成模型「正常」发出的工具调用——用户得知道这次工具是被捞出来的，不是模型
  显式给的。
- `rawSpan` 必须存进 command trace 表，作为 raw refs。
- confidence: low 的不自动跑，但要在 Context Budget 里记一条「scavenger 看到了
  疑似工具调用但置信度太低」，方便用户调阈值。
- 与 Context Budget 集成：scavenge 跑了 regex 和 JSON 解析消耗的算力可忽略，
  但「捞到的 tool call 被执行」消耗的是真正的 tool budget，要记账。

## 三、Truncation：修复被截断的 JSON

### 问题

流式响应被 max_tokens 截断、被网络断开、被模型自己 stop sequence 切掉，导致
`tool_calls[i].function.arguments` 是个不完整的 JSON 字符串：

```text
{"path": "src/foo.ts", "edits": [{"range": {"start":
```

直接 `JSON.parse` 会炸，传给 tool 会传错。

### 处理思路

两条路：
1. **本地修复**：检测未闭合的 `{` `[` `"`，按栈补齐。这条只对「明显能补」的情况
   有效，比如就差一个 `}`。
2. **请求续传**：如果本地补不出来（比如缺的不是闭合符而是 value），向模型发一个
   continuation completion 请求，让它接着写完。

### 触发阈值

- finish_reason === 'length' 或 'stop' 且 args 是字符串且 JSON.parse 失败
- 字符串末尾不在合法 JSON 结尾位置
- 续传请求每轮最多 1 次（防止死循环）

### 接口草案

```ts
export type TruncationDiagnosis = {
  kind: 'unbalanced' | 'mid_value' | 'mid_key' | 'mid_string' | 'unknown'
  unclosed: ('{' | '[' | '"')[]
  raw: string
  position: number
}

export type TruncationRepairResult =
  | { strategy: 'local_close'; repaired: string }
  | { strategy: 'continuation'; continuation: string; merged: string }
  | { strategy: 'give_up'; reason: string }

export interface ToolCallTruncationRepairer {
  diagnose(raw: string): TruncationDiagnosis
  repairLocal(diag: TruncationDiagnosis): TruncationRepairResult
  requestContinuation(
    diag: TruncationDiagnosis,
    runtime: { requestContinuation: (prompt: string) => Promise<string> }
  ): Promise<TruncationRepairResult>
}
```

### 流程伪代码

```text
on parsedToolCall(raw):
  try JSON.parse(raw) -> ok
  catch:
    diag = repairer.diagnose(raw)
    local = repairer.repairLocal(diag)
    if local.strategy === 'local_close' and JSON.parse(local.repaired) ok:
      emit 'tool_call_truncation_repaired_local'
      return local.repaired
    if continuation budget available:
      cont = await repairer.requestContinuation(diag, runtime)
      if cont.strategy === 'continuation' and JSON.parse(cont.merged) ok:
        emit 'tool_call_truncation_repaired_continuation'
        return cont.merged
    emit 'tool_call_truncation_give_up'
    raise MALFORMED_TOOL_CALL
```

### 玄圃特有注意事项

- 续传请求要走同一个 runtime adapter，**用同一个 model + 同一个上下文**。
  不要换模型「接力」补，那会引入 inconsistency。
- Context Budget 要把续传消耗的 prompt tokens 记账到当前轮，不能算成新一轮。
- 续传次数累计要进 metrics（plan 第 506 行的度量指标里 `tool failure recovery
  rate` 就是干这个的）。
- `give_up` 要直接走 plan-review AI-3 的 `MALFORMED_TOOL_CALL` 错误码，
  让 harness 决定是回退、重试，还是把这条错误透传给用户。

## 四、Storm：抑制重复工具调用

### 问题

模型陷入 loop：连续 5 次调用 `read_file({path: 'src/foo.ts'})`，每次拿到同样
的内容，下一轮又调一次。原因可能是 prompt 里的工具结果没被正确格式化、模型不
理解 prior tool result、或者模型「忘了自己刚读过」。

不抑制的话，玄圃会被这种 loop 烧掉一大堆 token + tool budget，用户体验也烂。

### 处理思路

维护一个滑动窗口（默认最近 N 轮工具调用），用 `(toolName, normalizedArgs)`
做去重 key。窗口内同 key 出现次数超过阈值就**抑制本次调用**，注入一个
「reflection turn」——告诉模型「你刚才已经这么调过 X 次了，结果是 Y，请换个
策略」。

### 触发阈值（照抄 Reasonix）

- 窗口大小：最近 5 轮工具调用
- 抑制阈值：同 key 出现 ≥ 3 次
- args 规范化：JSON canonicalize（排序 key、统一空白）
- 抑制后注入 reflection turn，最多注入 2 次；第 3 次走 give_up，让 harness 决定

### 接口草案

```ts
export type ToolCallSignature = {
  toolName: string
  argsHash: string         // 规范化后的 SHA-256，前 16 字节 hex
  canonicalArgs: string    // 规范化后的 JSON
}

export type StormDetection = {
  signature: ToolCallSignature
  windowOccurrences: number
  windowSize: number
  pastTurnIds: string[]
  pastResults: { turnId: string; ok: boolean; resultDigest: string }[]
}

export type StormAction =
  | { kind: 'allow' }
  | { kind: 'suppress_with_reflection'; reflection: string }
  | { kind: 'give_up'; reason: string }

export interface ToolCallStormDetector {
  observe(turnId: string, call: { toolName: string; args: unknown }): void
  observeResult(turnId: string, ok: boolean, resultDigest: string): void
  evaluate(call: { toolName: string; args: unknown }): StormDetection | null
  decide(detection: StormDetection): StormAction
}
```

### 流程伪代码

```text
before dispatch(toolCall):
  detection = stormDetector.evaluate(toolCall)
  if detection:
    action = stormDetector.decide(detection)
    if action.kind === 'suppress_with_reflection':
      emit timeline event 'tool_call_storm_suppressed'
      inject_assistant_turn(action.reflection)
      return suppressed
    if action.kind === 'give_up':
      raise REPEATED_TOOL_CALL_GIVE_UP
  result = await tool.fn(args)
  stormDetector.observeResult(turnId, result.ok, digest(result))
```

### 玄圃特有注意事项

- `argsHash` 要稳定。规范化要处理 path normalization（`src/foo.ts` vs
  `./src/foo.ts` vs `/abs/repo/src/foo.ts`），不然 storm 检测会漏。
- Reflection 注入的 turn 在 Session HQ timeline 里要明确标成「玄圃注入」，
  不是模型自己说的，否则用户会以为模型有自我反省能力——其实是 harness 替它反省的。
- Storm 抑制要被 Context Budget 记录：「这一轮没消耗 tool budget，因为被 storm
  detector 抑制」是用户能看见的省钱事件。
- 与 plan 506 行 metrics 里「repeated answer 事件」对齐，但工具版要单独一条。
- 不要对所有工具统一阈值。`read_file` 的同参数重复几乎一定是 loop，但
  `rg_search` 同 query 翻页是合理的——签名要把分页 token 包进去。

## 集成位置

按 plan 第 121–135 行的目录约定，工具调用修复层应该落在：

```text
src/main/services/xuanpu-agent/
  harness/
    tool-call-repair/
      index.ts              # 导出 ToolCallRepairer 主类
      types.ts              # 共享类型（StormDetection、FlattenedSchema 等）
      flatten.ts            # ToolCallFlattener 实现
      scavenge.ts           # ToolCallScavenger 实现
      truncation.ts         # ToolCallTruncationRepairer 实现
      storm.ts              # ToolCallStormDetector 实现
      registry.ts           # 把四件套挂进 ToolRegistry 和 dispatch
      events.ts             # 修复事件 -> CanonicalAgentEvent
      __tests__/
        flatten.test.ts
        scavenge.test.ts
        truncation.test.ts
        storm.test.ts
```

主类形态建议：

```ts
export interface ToolCallRepairer {
  flatten: ToolCallFlattener
  scavenge: ToolCallScavenger
  truncation: ToolCallTruncationRepairer
  storm: ToolCallStormDetector

  // 在 ToolRegistry.register 时调用一次
  onToolRegistered(tool: RegisteredTool): void

  // 在每轮 LLM response 到手后调用，可能补 tool_calls
  onModelResponse(ctx: ScavengeContext, response: ModelResponse): ModelResponse

  // 在每个 tool_call 进 dispatch 前调用
  onBeforeDispatch(call: NormalizedToolCall): RepairDecision

  // 在 dispatch 完成后调用，喂给 storm detector
  onAfterDispatch(call: NormalizedToolCall, result: ToolResult): void
}
```

四件套和 plan 已有层的关系：

- `harness/` 主循环在每轮 LLM 响应后调用 `onModelResponse`（scavenge）
- `harness/` 在 `tools/` 工具 dispatch 前后调用 `onBeforeDispatch` /
  `onAfterDispatch`（flatten + storm）
- `events/` 把修复事件转成 `CanonicalAgentEvent`，进 Session HQ timeline
- `context/` 的 Context Budget 订阅修复事件，更新 token 估算和事件计数
- `xfp/` 在 packet 的 tool catalog section 里展示 flatten 状态

## 与玄圃错误分类的映射

plan-review AI-3 的 error taxonomy 草案：

```text
TIMEOUT
MALFORMED_TOOL_CALL
PERMISSION_DENIED
TOOL_EXECUTION_FAILED
CONTEXT_OVERFLOW
RATE_LIMIT
PROVIDER_UNAVAILABLE
REPEATED_TOOL_CALL_GIVE_UP   # 新增，专门给 storm
```

四件套和这套错误码的挂钩：

| 四件套 | 触发场景 | 成功时事件 | 失败时错误码 |
| --- | --- | --- | --- |
| flatten | 工具注册期 | `tool_flattened` | （注册期不抛错，最多 fallback 到原 schema） |
| flatten (rehydrate) | dispatch 前 | （静默） | `MALFORMED_TOOL_CALL`（rehydrate 失败时） |
| scavenge | LLM 响应后 | `tool_call_scavenged` | （无错误码，捞不到就当模型没调） |
| truncation (local) | parse 失败时 | `tool_call_truncation_repaired_local` | （走 continuation 兜底） |
| truncation (continuation) | local 不行 | `tool_call_truncation_repaired_continuation` | `MALFORMED_TOOL_CALL` |
| storm (suppress) | 同签名 ≥3 次 | `tool_call_storm_suppressed` | （成功路径，不抛错） |
| storm (give up) | reflection 注入 ≥2 次 | `tool_call_storm_gave_up` | `REPEATED_TOOL_CALL_GIVE_UP` |

`REPEATED_TOOL_CALL_GIVE_UP` 是新增错误码，建议加进 AI-3 taxonomy。
理由：和 `MALFORMED_TOOL_CALL` 不同，storm give up 不是「这条 tool call 坏了」，
而是「模型在 loop，本轮放弃」，harness 的处理路径不一样——前者可以重试，
后者必须打断 + 升级到用户。

## 里程碑建议

按 plan 当前里程碑顺序（M0 Runtime 收口 → M1 XFP v1 → M2 只读 Harness → M3
命令压缩 → M4 写入 → M5 Memory → M6 高级），建议插入：

```text
M1.5：Tool-Call Repair Interfaces
```

放在 M1 完成后、M2 开工前。理由：

1. M2 一启用工具就会撞 flatten / scavenge / storm（read_file / rg_search
   都是高频工具，立刻能复现 storm）。
2. truncation 在 M2 影响小（只读工具 args 不深），但到 M4 写入时一定爆发。
3. interface 必须先稳定，否则 M2 / M4 写代码时会反复改 tool dispatch 路径。

M1.5 的最小可交付：

- 四个 interface 全部 stub 出来，编译通过
- flatten 和 storm 出 working implementation（M2 立即需要）
- scavenge 留 stub，只在 model family 命中时才走完整路径
- truncation 留 stub + local_close 实现，continuation 推到 M4 前
- 四件套全部对接 Session HQ timeline + Context Budget 事件
- 单元测试覆盖 happy path + 主要 edge case
- 文档化默认阈值，并在 settings 里露出开关

不需要 M1.5 就完成的事：

- 不同 model family 的 scavenge 正则库（M2/M3 边接边补）
- 续传 prompt 的精细调优（M4 前再调）
- storm reflection prompt 的多语言版本（M5 / M6）

## 待决问题

1. flatten 的 `presentForModel` 输出格式：用 OpenAI tools schema（function /
   parameters）还是 Anthropic tools schema？还是抽象一层，让 runtime adapter
   各自翻译？
2. scavenge 的 model family 检测靠什么？模型名（gpt-5.5 / deepseek-r1）还是
   provider hint？玄圃 runtime adapter 暴露哪个？
3. truncation 续传走 `request continuation` 还是「重新发整轮」？前者省 token
   但要 provider 支持 prefix completion；后者通用但贵。M1.5 先做哪个？
4. storm 的 args 规范化要不要做 path normalization？做了会更准但可能跨平台
   有差异（Windows 反斜杠）；不做的话会漏检测。
5. 修复事件进 Session HQ timeline 时，要不要折叠成单个「Tool Call Repair」
   分组，还是和工具调用本身并列？UI 怎么呈现？
6. 修复消耗的 token 是不是要单算一栏（不是 prompt / completion，而是 repair）？
   还是合并进 prompt cost？
7. per-tool 修复开关：read_file 不需要 flatten 但要 storm；apply_patch 反过来。
   配置粒度放在 tool 注册时，还是用户 settings？
8. 四件套是不是要做成插件式（让 community 自己加 profile），还是 M1.5 阶段
   全部硬编码？

## 近期行动

1. 在 plan-review AI-3 错误 taxonomy 里增加 `REPEATED_TOOL_CALL_GIVE_UP`。
2. 起草 `src/main/services/xuanpu-agent/harness/tool-call-repair/types.ts`
   shared type（不需要实现）。
3. 在当前 spike 里跑一次 gpt-5.5 + 简单 read_file，记录 scavenge / storm
   实际触发率，校准默认阈值。
4. 在 XFP packet schema 里预留 `toolRepair` section。
5. 在 Session HQ timeline 事件类型枚举里预留 `tool_call_repair_*` 五个事件名。
6. 写一份「修复事件 vs 工具事件」的 UI mock，确认折叠策略。

## 参考方向

- Reasonix（DeepSeek-Reasonix）Pillar 2「Tool-Call Repair」：
  flatten / scavenge / truncation / storm 四件套的原始定义和默认阈值。
- OpenAI function calling 和 Anthropic tools 的 schema 差异：flatten 输出格式
  的取舍依据。
- 现有 Codex CLI 工具 dispatch 路径：玄圃 runtime adapter 已经在做一部分
  normalize，重复的部分要避免。
