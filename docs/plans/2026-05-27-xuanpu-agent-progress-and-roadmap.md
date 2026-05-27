# 玄圃 Agent — 当前进度与后续规划

日期：2026-05-27
分支：`feat/xuanpu-agent-oh-my-pi`
最新提交：`8a06256`

---

## 一、架构设计

完整架构文档：[`docs/architecture/xuanpu-agent-architecture.md`](./architecture/xuanpu-agent-architecture.md)

**三句话定义：**

1. **以"开发现场"为操作系统。** Worktree、分支、文件、终端、测试、session 历史——通过 XFP 协议结构化暴露。
2. **上下文窗口被当作有固定容量的缓存管理。** 工具输出压缩 → 旧对话卸载 → 按需检索 → 稳态 ~300K token。
3. **"成本地形"做进 harness 而非 prompt。** 让调工具比偷懒便宜，让错误被自动拦截，约束来自工程层。

**三层架构：**

```
Field Layer (现场感知)     → XFP Packet Compiler + Context Budget + Memory
Context Layer (上下文工程)  → 命令压缩 + Episode Freeze + Gated Retrieval + Tool Repair
Runtime Layer (模型运行时)  → oh-my-pi Agent (不 fork, 挂钩子)
```

**关键决策：**
- **不 fork oh-my-pi**。pi-agent-core 原生支持 `beforeToolCall` / `afterToolCall` / `transformContext` 钩子，够用。
- **不绑死单一模型**。Provider-agnostic，追求上下文稳态而非字节级 cache hit。
- **FieldProvider 解耦**。harness 不依赖 IDE 基础设施，CLI 模式只需换一个 FieldProvider 实现。

---

## 二、已完成 (M0–M1.5)

| 里程碑 | 交付 | 文件 |
|--------|------|------|
| **M0** | Budget 配置对齐 (150K/300K/500K)，删除 `max` profile | `xfp/types.ts`, `xfp/schema.ts`, `harness/compiler.ts` |
| **M1** | XFP v1 端到端接通。`prompt()` 走 harness 路径：编译 XFP packet → `buildMessages` → oh-my-pi | `xuanpu-agent-implementer.ts`, `harness/build-messages.ts` |
| **M1** | `SessionAppendOnlyLog`：会话历史包装为 `AppendOnlyLog` | `harness/build-messages.ts` (+70 行) |
| **M1** | `CommandProfiler` + `CommandCompressor` 接口定义 (M2 实现) | `context/compressor.ts` (160 行) |
| **M1** | `FieldProvider` 接口 + `IdeFieldProvider` 实现。删除 ~300 行旧方法 | `field/provider.ts`, `field/ide-field-provider.ts` |
| **M1** | 成本地形不变量 INV-COST-1~7，原则表 10→12 条 | `xuanpu-agent-invariants.md` |
| **M1.5** | `StormDetector`：滑动窗口去重，`beforeToolCall` 钩子 | `harness/tool-call-repair/storm.ts` |
| **M1.5** | `ToolOutputTruncator`：head/tail 截断 MVP，`afterToolCall` 钩子 | `harness/tool-call-repair/truncation.ts` |

**统计：** 15 个文件，+2167 / -353 行。14 个核心测试通过。

---

## 三、当前架构状态

```
用户输入
  → FieldProvider.getPriorTurns(sessionId)        ← IDE: SQLite / CLI: 文件
  → FieldProvider.buildFieldSnapshot(worktree)     ← IDE: field events / CLI: 无
  → buildGitStateForWorktree(path)                 ← simple-git（通用）
  → XfpPacketCompiler.compile(worktree, session, text, { gitState, ... })
  → SessionAppendOnlyLog(priorMessages, packetId)
  → buildMessages(packet, log, text)
  → XuanpuPiAgentSession.prompt(harnessMessages, modelRef)
      └→ oh-my-pi Agent
           ├→ beforeToolCall → StormDetector.hook    ← 同签名 ≥3 次 → block
           ├→ 模型调用 (40+ providers)
           └→ afterToolCall  → ToolOutputTruncator.hook ← >12K chars → 截断
  → FieldProvider.persistMessage(assistantText)
  → FieldProvider.freezeEpisodes()
  → Session HQ timeline 事件
```

**解耦面：** `FieldProvider` 接口是 harness 与 IDE/CLI 的唯一接触点。6 读 + 4 写方法。当前 `IdeFieldProvider` 实现中，未来 `CliFieldProvider` 只需实现同一接口。

---

## 四、后续规划

### M2：只读 Harness + 压缩 MVP

**前提：** M1.5 的 storm 检测和 head/tail 截断已经挂上，工具执行有了基本保护。

**要做的：**

| 任务 | 说明 |
|------|------|
| 注册只读工具 | `git_status` / `git_log` / `git_diff` / `read_file` / `rg_search` / `list_files`。通过 oh-my-pi 的 `agent.setTools()` |
| 压缩 MVP（高频 10 命令） | 实现 `CommandProfiler.identify` + 10 个命令的 `CommandCompressor.compress`。覆盖：`git status/log/diff`、`vitest`、`tsc`、`eslint`、`pnpm test`、`rg`、`cat`、`ls` |
| 工具输出归档 | 压缩前写 `command_traces` 表（raw output + exit code + duration）。压缩摘要返回模型 |
| `parallelSafe` 调度 | Read-only 工具 `parallelSafe: true`，`Promise.allSettled` 并发。环境变量 `XUANPU_AGENT_PARALLEL_MAX` 默认 3 |

**验收：**
- 问"看下当前分支最近提交" → agent 真的能调 `git log`
- 问"这个错误可能在哪" → agent 能 `rg_search` + `read_file`
- 长命令输出不被裸塞进上下文（vitest 跑 200 个测试只看到失败摘要）

### M3：压缩 profile 扩展 + Context Budget 可视化

| 任务 | 说明 |
|------|------|
| 压缩 profile 扩展到 30+ 命令 | `cargo test`、`jest`、`pytest`、`ruff`、`clippy`、`docker` 等 |
| per-turn auto-compaction | 单条 tool result >3000 token 自动压缩；上下文填充率 40% 触发 shrink / 80% 紧急 shrink |
| Context Budget UI | Session HQ 顶栏展示：cache hit ratio、压缩比、included/omitted sections、token 估算 |
| 300K 稳态验证 | 实际跑长会话，验证上下文不膨胀 |

### M4：受控写入 Harness

| 任务 | 说明 |
|------|------|
| 写入工具 | `apply_patch` / `write_file` / `edit_file` / `run_test` / `format_file` |
| 安全机制 | diff preview、trusted worktree 标记、危险路径阻止 |

### M5：Memory Graph + Trace 物化

| 任务 | 说明 |
|------|------|
| 六层 scope memory | user / project / worktree / session / episode / command |
| memory write proposal | harness 提议 → 用户确认 → 落库 |
| Trace 物化 | 高频执行路径 → 参数化 workflow 模板 |

### M6：高级 Harness

| 任务 | 说明 |
|------|------|
| MCP | 接入外部 MCP server |
| checkpoint/resume | 可恢复的任务现场 |
| Post-response claim verifier | 模型输出的文件名/API 名自动验证 |

### 2.0.0：独立 CLI 形态

- 实现 `CliFieldProvider`（simple-git + cwd + 文件存储）
- `xuanpu agent` CLI 命令
- MinimalField XFP packet 子集

---

## 五、参考项目

| 项目 | 借鉴 |
|------|------|
| **oh-my-pi** | Agent loop + beforeToolCall/afterToolCall 钩子（不 fork） |
| **RTK** (54K⭐) | 100+ 命令 profile 分类法 → 玄圃内嵌 CommandCompressor |
| **context-mode** (15.7K⭐) | 工具输出沙箱化、"Think in Code" 理念 |
| **Reasonix** (9K⭐) | 三段式 prompt 分区、Tool-call repair 四件套、parallelSafe 调度 |
| **阿里 OPC** | 评估的评估（meta-evaluation）、人机混合迭代闭环 |

---

## 六、设计原则速查

1. 玄圃拥有现场
2. XFP 是协议，不是 prompt 模板
3. 上下文是编译出来的，不是追加出来的
4. 旧工作要卸载，不是遗忘
5. 没有 raw refs 的总结不能叫记忆
6. 命令输出进入模型前必须被压缩和结构化
7. 记忆必须分 scope、可编辑、可追溯
8. 大上下文窗口是 fallback，不是目标 (~300K 稳态)
9. 模型可替换，harness 才是产品
10. 我们优化用户工作，不优化模型厂商 token 消耗
11. 约束 LLM 靠改造成本地形，不靠 prompt 说教
12. Trace 是资产，不是废热
