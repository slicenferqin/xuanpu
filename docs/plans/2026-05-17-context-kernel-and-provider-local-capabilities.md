# Xuanpu — Context Kernel + Provider-local Model Capabilities

**Date**: 2026-05-17  
**Status**: Draft  
**Target window**: v1.5.x / v1.6.x  
**Scope**: Context package, capability-aware model fit, explainable prompt injection  

---

## 0. 背景

玄圃已经具备个人 AI OS 的第一层地基：

- Field Event Stream：把 worktree、文件、终端、用户消息、agent 工具调用沉淀为结构化事件
- Field Context：每次 prompt 前把当前现场编译成 markdown 前缀
- Memory：Pinned Facts / Episodic / Semantic / Session Checkpoint
- Agent Runtime：Claude Code / Codex / OpenCode / Terminal
- Token Saver：Claude Code Bash 输出可压缩并归档

下一阶段不应该做“跨 agent 的模型路由”。玄圃接入的是 **agent runtime**，不是裸模型 API。Claude Code、Codex、OpenCode 不是同质执行器，它们有不同的工具协议、会话状态、权限模型、文件 checkpoint、计划模式、goal mode、流式事件形态。

所以这里的正确方向是：

> 玄圃不自动把一个任务从 Claude 切到 Codex，也不把 OpenCode 当成 Claude 的便宜替代。玄圃应该在用户选定的 agent / provider 内，管理上下文包、模型能力、预算、附件兼容性和注入可解释性。

换句话说，玄圃的核心不是 **Model Router**，而是 **Context Kernel + Model Fit Advisor**。

---

## 1. 产品原则

### 1.1 Agent runtime 不是可互换模型

禁止把以下事情做成自动化默认行为：

- Claude Code session 自动切到 Codex
- Codex session 自动切到 OpenCode
- OpenCode session 自动切到 Claude Code
- 根据一句用户输入自动换 runtime

原因：

- session state 不可无损迁移
- 工具调用和权限语义不同
- agent 的计划/执行风格不同
- 用户选 runtime 往往是在选工作方式，不只是选模型

允许做的是：

- 在当前 runtime 内建议模型或 reasoning variant
- 在当前 runtime 内提示模型能力不匹配
- 按当前模型能力生成不同 context package
- 提供明确的手动切换入口和迁移提示

### 1.2 Router 先路由上下文，不路由 agent

玄圃真正可控、也最有差异化的是 context supply chain：

- 哪些现场进入 prompt
- 以原文、摘要、路径引用还是统计信息进入
- 给多少 token 预算
- 哪些被裁剪、为什么裁剪
- 这次上下文是否足够回答用户问题

因此本计划里的“路由”只指：

- Context mode selection
- Context budget allocation
- Capability fit check
- Provider-local model/variant suggestion

不指跨 runtime dispatch。

### 1.3 用户保持控制

系统可以建议：

- “当前模型不支持图片，建议换到同 provider 下支持图片的模型”
- “这次上下文包被裁剪到 compact 模式”
- “这是 debug 请求，已优先注入 terminal output 和 focus file”

但不静默改变：

- agent runtime
- selected model
- permission policy
- field collection setting

---

## 2. 当前基线

### 2.1 已有能力

| 能力 | 当前落点 |
|---|---|
| Field events | `field_events` / `src/shared/types/field-event.ts` |
| Snapshot builder | `src/main/field/context-builder.ts` |
| Markdown formatter | `src/main/field/context-formatter.ts` |
| Prompt injection | `src/main/ipc/agent-handlers.ts` |
| Last injection cache | `src/main/field/last-injection-cache.ts` |
| Memory UI | `src/renderer/src/components/sessions/MemoryPanel.tsx` |
| Debug UI | `src/renderer/src/components/sessions/FieldContextDebug.tsx` |
| Runtime abstraction | `src/main/services/agent-runtime-types.ts` |
| Model selector | `src/renderer/src/components/sessions/ModelSelector.tsx` |
| Context usage UI | `src/renderer/src/components/sessions/ContextIndicator.tsx` |

### 2.2 主要缺口

1. Field Context 是 markdown 字符串，不是可审计的 context package。
2. Formatter 只有 `tokenBudget`，没有 `mode`、section metadata、drop reasons。
3. 模型元数据只有 `limit.context/output` 和 `variants`，缺少 capabilities。
4. UI 能看 last injection，但看不到“为什么这样注入”。
5. 当前没有 prompt preflight：附件/模型能力不匹配时只能靠 runtime 失败。
6. Context decision 没有持久 trace，无法评估注入质量。

---

## 3. 目标

### 3.1 P0：Context Package Contract

把 Field Context 从“markdown 字符串”升级为结构化产物：

```ts
interface ContextPackage {
  id: string
  worktreeId: string
  runtimeId: AgentRuntimeId
  model: {
    providerID: string
    modelID: string
    variant?: string
  } | null
  mode: ContextMode
  budget: ContextBudget
  snapshot: FieldContextSnapshot
  rendered: {
    markdown: string
    approxTokens: number
    wasTruncated: boolean
  }
  sections: ContextPackageSection[]
  decision: ContextDecisionTrace
  createdAt: number
}

type ContextMode = 'tiny' | 'compact' | 'standard' | 'deep' | 'audit'

interface ContextPackageSection {
  id:
    | 'worktree'
    | 'current_focus'
    | 'checkpoint'
    | 'pinned_facts'
    | 'semantic_memory'
    | 'worktree_notes'
    | 'episodic_summary'
    | 'last_terminal'
    | 'recent_activity'
  label: string
  included: boolean
  approxTokens: number
  source: 'field_event' | 'db' | 'file' | 'derived'
  sourceRefs: string[]
  dropReason?: 'not_available' | 'privacy_disabled' | 'budget' | 'mode' | 'stale'
}
```

MVP 不要求 formatter 内部完全按 section 渲染重写；可以先在现有 formatter 外层补 metadata。

### 3.2 P0：Context Decision Trace

每次 prompt 注入时记录一份可解释决策：

```ts
interface ContextDecisionTrace {
  taskType: TaskType
  mode: ContextMode
  reasons: string[]
  warnings: string[]
  modelFit: ModelFitResult
  budgetTier: number
  fallbackUsed: boolean
}

type TaskType =
  | 'debug'
  | 'implement'
  | 'review'
  | 'explain'
  | 'summarize'
  | 'write'
  | 'plan'
  | 'unknown'
```

示例：

```json
{
  "taskType": "debug",
  "mode": "standard",
  "reasons": [
    "user message contains debug cue",
    "last terminal command exited non-zero",
    "focused file available"
  ],
  "warnings": ["terminal output was truncated at capture time"],
  "modelFit": {
    "status": "ok",
    "issues": []
  },
  "budgetTier": 3,
  "fallbackUsed": false
}
```

这不是模型路由记录，而是 context decision 记录。

### 3.3 P0：Provider-local Model Capability Catalog

在当前 runtime 的 model metadata 中补充能力信息：

```ts
interface ModelCapabilities {
  contextWindow: number
  maxOutputTokens?: number
  supportsImages: boolean
  supportsPdf: boolean
  supportsComputerUse?: boolean
  supportsTools: boolean
  supportsReasoningEffort: boolean
  recommendedContextModes: ContextMode[]
  defaultContextMode: ContextMode
}
```

现有模型返回值可扩展为：

```ts
{
  id: string
  name: string
  limit: { context: number; input?: number; output: number }
  capabilities?: ModelCapabilities
  variants?: Record<string, Record<string, never>>
}
```

MVP 要求：

- Claude 模型补 `supportsImages/supportsPdf/contextWindow/output`
- Codex 模型补 `contextWindow/output/reasoningEffort`
- OpenCode 对未知 provider 给保守 default，并允许 provider config 后续覆盖

### 3.4 P0：Prompt Preflight

发送前做轻量检查，不拦正常文本：

| 场景 | 行为 |
|---|---|
| message 带图片，但当前模型标记 `supportsImages=false` | 阻止发送或提示换当前 provider 下支持图片的模型 |
| message 带 PDF，但当前模型标记 `supportsPdf=false` | 阻止发送或提示 |
| context package 超预算 | 自动降 mode，并在 trace 里展示 |
| field collection disabled | 明确显示“只会注入用户手写 worktree context / memory” |
| debug 问题但没有 terminal output | 提示“没有捕获到最近终端输出” |

Preflight 只在当前 runtime/provider 内给建议，不自动切 runtime。

### 3.5 P1：Context Inspector

把 dev-only `FieldContextDebug` 的能力产品化为 Context Inspector：

- Last Package：本次实际发送的 context package
- Included：已发送 section 列表
- Dropped：未发送 section 和原因
- Model Fit：附件和模型能力兼容性
- Budget：mode、tier、approx tokens、裁剪说明
- Raw Markdown：可展开，不默认展示

入口建议：

- Composer 旁边的 `ContextIndicator` tooltip 增强
- MemoryPanel 旁边增加 “Context” tab
- Session header 增加小型 package pill

### 3.6 P1：Field Event 扩展

为更准确的现场补 P1 事件：

```ts
type FieldEventType =
  | existing
  | 'file.edit'
  | 'git.status_change'
  | 'session.approval'
  | 'context.package_created'
```

优先级：

1. `git.status_change`：dirty files、branch、ahead/behind、staged count
2. `file.edit`：手动编辑摘要，不存全文
3. `session.approval`：用户允许/拒绝的工具请求
4. `context.package_created`：记录 context package trace

这些事件的价值是让 context decision 有证据来源，而不是纯 UI 状态。

---

## 4. 非目标

- 不做跨 Claude / Codex / OpenCode 自动切换
- 不做全局“选择最便宜 agent”
- 不做 LLM-based 自动长期记忆写入
- 不做 Claim Store / Outcome Loop 的大设计回归
- 不做向量检索
- 不默认上传任何 context / trace
- 不改变用户已选模型，只提供同 provider 内的建议

---

## 5. 技术设计

### 5.1 新模块：Context Kernel

建议新增目录：

```text
src/main/context-kernel/
  types.ts
  intent.ts
  model-capabilities.ts
  budget.ts
  compiler.ts
  trace-repository.ts
```

核心接口：

```ts
interface CompileContextInput {
  userMessage: string
  messageParts?: Array<{ type: string; mime?: string }>
  worktreeId: string
  runtimeId: AgentRuntimeId
  model: { providerID: string; modelID: string; variant?: string } | null
  requestedMode?: ContextMode
}

async function compileContextPackage(
  input: CompileContextInput
): Promise<ContextPackage | null>
```

`agent-handlers.ts` 中的注入逻辑变成：

```ts
const contextPackage = await compileContextPackage({
  userMessage,
  messageParts,
  worktreeId,
  runtimeId,
  model
})

if (contextPackage) {
  messageOrParts = prependToMessage(
    messageOrParts,
    `${contextPackage.rendered.markdown}\n\n[User Message]\n`
  )
  cacheLastContextPackage(...)
}
```

### 5.2 Intent v0：规则优先

不调 LLM，先用规则：

```ts
function classifyTaskType(userMessage: string): TaskType {
  const text = userMessage.toLowerCase()
  if (/报错|错误|failed|failure|error|stack|trace|why.*break/.test(text)) return 'debug'
  if (/review|审查|看看 diff|风险|问题/.test(text)) return 'review'
  if (/实现|修复|加一个|改一下|build|implement/.test(text)) return 'implement'
  if (/解释|为什么|原理|explain/.test(text)) return 'explain'
  if (/总结|summary|summarize/.test(text)) return 'summarize'
  if (/计划|规划|plan/.test(text)) return 'plan'
  return 'unknown'
}
```

规则只影响 context mode，不影响 runtime。

### 5.3 Context mode 策略

| Mode | 目标 | 预算建议 | 主要内容 |
|---|---|---:|---|
| tiny | 分类/预检 | 300-600 tokens | user message + model fit + minimal worktree |
| compact | 日常问答 | 1000-1500 tokens | focus + pinned + terminal summary |
| standard | debug/implement 默认 | 2000-4000 tokens | focus + terminal + recent activity + memory |
| deep | 跨文件/长任务 | 6000-12000 tokens | wider event window + semantic + episodic |
| audit | review | 4000-8000 tokens | diff/git status + approvals + tests |

MVP 不需要一次实现所有 mode 的完全差异化。先把 mode 参数透传到 formatter：

```ts
formatFieldContext(snapshot, {
  tokenBudget,
  mode
})
```

再逐步细化 section priority。

### 5.4 Model fit 不是 Model route

```ts
interface ModelFitResult {
  status: 'ok' | 'warn' | 'blocked'
  issues: Array<{
    code:
      | 'image_unsupported'
      | 'pdf_unsupported'
      | 'context_budget_small'
      | 'unknown_capabilities'
    message: string
    suggestedModelIds?: string[]
  }>
}
```

示例：

```json
{
  "status": "blocked",
  "issues": [
    {
      "code": "image_unsupported",
      "message": "Current Claude model does not advertise image support.",
      "suggestedModelIds": ["claude-sonnet-4-5", "claude-opus-4-5"]
    }
  ]
}
```

注意：`suggestedModelIds` 只能来自当前 runtime/provider 的 available models。

### 5.5 Trace 存储

新增表：

```sql
CREATE TABLE IF NOT EXISTS field_context_packages (
  id TEXT PRIMARY KEY,
  created_at INTEGER NOT NULL,
  worktree_id TEXT NOT NULL,
  session_id TEXT,
  runtime_id TEXT NOT NULL,
  provider_id TEXT,
  model_id TEXT,
  model_variant TEXT,
  task_type TEXT NOT NULL,
  mode TEXT NOT NULL,
  approx_tokens INTEGER NOT NULL,
  was_truncated INTEGER NOT NULL DEFAULT 0,
  budget_tier INTEGER,
  sections_json TEXT NOT NULL,
  decision_json TEXT NOT NULL,
  preview_md TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_field_context_packages_session_created
  ON field_context_packages(session_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_field_context_packages_worktree_created
  ON field_context_packages(worktree_id, created_at DESC);
```

`preview_md` 可限制 20KB，避免 DB 膨胀。完整 markdown 仍可只存在 last injection cache；MVP 可先不落全文。

---

## 6. UI 设计

### 6.1 Composer Context Pill

现有 `ContextIndicator` 增强：

```text
Context: standard · ~2.8k · 7 sections
```

Tooltip：

```text
Context Package
Mode: standard
Task: debug
Included:
- Current Focus
- Last Terminal Activity
- Pinned Facts
- Worktree Summary

Dropped:
- Recent Activity: budget

Model Fit:
- OK
```

### 6.2 Context Inspector Panel

建议作为 Session HQ 底部面板里的新 tab：

```text
[Memory] [Context]
```

Context tab：

- Latest Package
- Decision Trace
- Sections
- Raw Markdown
- Privacy

### 6.3 Preflight Dialog

只在 blocked 场景弹：

```text
当前模型可能无法处理这条消息

原因：
- 包含 2 张图片
- 当前模型未声明图片能力

可选：
[换到 Sonnet] [仍然发送] [取消]
```

是否允许“仍然发送”由 runtime 决定。若 runtime 明确会失败，则不允许。

---

## 7. 分阶段实施

### Phase A — Context Package Metadata

目标：不改变行为，只让每次注入可解释。

改动：

- 新增 `ContextPackage` / `ContextDecisionTrace` 类型
- `formatFieldContext()` 返回 section metadata 或外层包装 metadata
- `agent-handlers.ts` 缓存 context package
- `fieldOps.getLastContextPackage(sessionId)` IPC
- Context Inspector 最小 UI

验收：

- 发 prompt 后能看到 mode、taskType、sections、tokens
- Raw markdown 与实际注入一致
- 不改变现有 prompt 注入结果

### Phase B — Provider-local Model Capabilities

目标：让模型选择器和 preflight 知道模型能不能处理附件。

改动：

- 扩展 model metadata 类型
- Claude / Codex catalog 填 capabilities
- OpenCode unknown provider 使用 conservative default
- ModelSelector 展示能力 icon：image / pdf / context
- Preflight 检查图片/PDF

验收：

- 带图片消息在不支持图片的模型下出现提示
- 不跨 runtime 推荐
- 所有旧模型列表仍能渲染

### Phase C — Context Modes

目标：按任务和模型预算生成不同 context package。

改动：

- `classifyTaskType()`
- `selectContextMode()`
- `resolveContextBudget(modelCapabilities, mode)`
- formatter 支持 mode
- UI 显示 mode

验收：

- debug 请求默认 standard
- explain/summarize 默认 compact
- review 默认 audit
- budget 裁剪原因可见

### Phase D — Field Event Expansion

目标：补现场证据。

改动：

- `git.status_change`
- `file.edit`
- `session.approval`
- `context.package_created`

验收：

- Context Inspector 能显示 git dirty/staged 信息来源
- 审查/implement 场景能注入最近 diff 摘要或至少 dirty file 列表
- approval trace 能用于 audit mode

---

## 8. 测试计划

### Unit

- `context-kernel/intent.test.ts`
- `context-kernel/model-fit.test.ts`
- `context-kernel/budget.test.ts`
- `context-kernel/compiler.test.ts`
- `field/context-formatter-modes.test.ts`

### IPC

- `field:getLastContextPackage`
- backward compatibility with `field:getLastInjection`

### UI

- ContextIndicator tooltip shows package metadata
- ModelSelector renders capabilities
- Preflight blocks unsupported image/PDF

### Regression

- Slash commands still bypass Field Context prefix
- Privacy off still suppresses event-derived context
- Existing MemoryPanel behavior unchanged
- Existing agent runtime selection unchanged

---

## 9. 风险

| 风险 | 影响 | 对策 |
|---|---|---|
| capabilities 过时 | 错误提示或误拦 | 默认 warn，不默认 hard block；只对明确不支持的附件 block |
| UI 信息过载 | 用户看不懂 | 默认只显示 pill，详情折叠到 Inspector |
| trace DB 膨胀 | 本地库变大 | preview 限长；只保留最近 N 天或提供清理 |
| 误分类 taskType | mode 不合适 | 用户可手动切 mode；规则保守 |
| formatter 改动引入注入退化 | agent 表现变差 | Phase A 先 metadata-only，不改 markdown |

---

## 10. 成功标准

这项特性成功，不是因为玄圃“自动选了更聪明模型”，而是因为用户能清楚看到：

1. 这次 AI 到底看到了什么现场
2. 为什么这些上下文被带入
3. 哪些上下文因为预算/隐私/模式没带入
4. 当前模型是否适合这条消息
5. 玄圃没有越权替用户换 agent

一句话目标：

> 让玄圃从“会注入现场”升级为“会解释、预算和校验现场”。

