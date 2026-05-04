# 玄圃 Token Saver — 通用上下文卸载管线

**版本目标**：v1.5.0（暂定）
**承接**：v1.4.6（字段内存）已交付，本计划是其后续。
**分支策略**：在当前分支 `feat_20260503_field_memory` 上连续推进，不再拆 PR、不再新开分支。

---

## 一、定位（修正自此前的视角）

### 1.1 之前的视角偏窄
v1.4.6 的后续讨论里把"压缩 / 上下文卸载"放在「现场感知增强」章节下，等于把它当现场感知的子能力。这是错的。

### 1.2 正确定位
**Token Saver 是玄圃的横切基础能力**，现场感知只是第一个受益场景：

```
玄圃 Token Saver / Context Offloading（横切能力）
  ├─ 服务于现场感知（让有限 context 装更多 signal）
  ├─ 服务于普通对话（每条 bash/工具输出都更省）
  ├─ 服务于多 agent 并发（5 个会话同时省 = 5 倍效益）
  └─ 是对外可见的差异化卖点（其他 IDE/agent 没有）
```

### 1.3 卖点定义
> "玄圃替你管 context，把昂贵的工具输出压缩或卸载到本地，agent 看到的是精简版 + 引用路径，token 实打实节省。"

这是其他 agent IDE（Cursor、Cline、Continue、Aider）都没有的能力。必须做出"用户可感知"的反馈层，不然省了也白省。

---

## 二、关键架构事实（决定方案选择）

### 2.1 SDK 数据流上的可控点

```
user 输入
   │
   ▼
① Field Context 注入 ←──── 玄圃 100% 控制
   │
   ▼
② SDK query()
   │
   ▼
③ Anthropic API ←──── 玄圃看不见、动不了
   │
   ▼ (model 返回 tool_use)
④ canUseTool hook ←──── 玄圃可拦截、可改输入、可拒绝
   │
   ▼
⑤ 工具执行
   │
   ▼
⑥ tool_result 拼回 API ←──── 玄圃看不见、动不了
   │
   ▼
⑦ SDK emit message → 玄圃 UI/DB ←──── 玄圃可读可改（仅展示）
```

**核心约束**：第 ③⑥ 段是 SDK 与 Anthropic 的封闭通道，玄圃既看不见也动不了。要真正"卸载 token"，必须**在第 ⑤ 段把输出在落到 ⑥ 之前压缩好**。

### 2.2 为什么 canUseTool + shim 不够

`canUseTool` 只能改写工具**输入**，不能改写**输出**。和 RTK `git diff → rtk git diff` 是同构的——所有压缩逻辑必须塞进 shim 脚本本身。这意味着：

- 12 类压缩规则要在 bash 里实现（不现实）
- 或每次 Bash 调用都冷启动 `node compress.js`（性能不可接受）
- 或起一个常驻 daemon 走 unix socket（**这就是 MCP**）

绕一圈又回到 MCP。

### 2.3 选定方案：进程内 MCP 接管 Bash

`@anthropic-ai/claude-agent-sdk` 支持 `sdkMcpServers`（in-process MCP），不需要 spawn 子进程，本质是 SDK 与玄圃 main process 内的一次函数调用。开销可忽略。

工作机制：

1. 玄圃 main 进程注册 in-process MCP server `xuanpu-tools`
2. 暴露工具 `Bash`（同名 shadow 内建）
3. SDK 配置 `disallowedTools: ['Bash']` 禁内建
4. agent 看到的"Bash"工具描述、参数都不变
5. 工具实现内部完成：执行 → tee 到 archive（cold） → 压缩规则（hot） → 返回压缩文本 + metadata
6. metadata 给 UI 渲染节省指示器

---

## 三、Agent 适配能力分布

| Agent | 拦截能力 | MVP 是否覆盖 |
|---|---|---|
| **Claude Code** | `canUseTool` + 进程内 MCP，能完整卸载 | ✅ MVP 唯一目标 |
| **OpenCode** | 自己的 server-tool 协议（玄圃已在跑 server），理论可改造 | ❌ 二期 |
| **Codex** | 拦截最弱，目前只能在 ⑦ 段做展示压缩，不真省 token | ❌ 二期，可能永远只展示压缩 |

---

## 四、MVP 范围（决定版）

### 4.1 工具覆盖
**只做 `Bash`**。

| 工具 | MVP | 二期 | 永不做 |
|---|---|---|---|
| Bash | ✅ | | |
| Grep | | ✅ | |
| Read | | ✅ | |
| WebFetch / WebSearch | | ✅ | |
| Glob | | | ❌（输出本就小） |
| Write | | | ❌（无输出） |
| Edit / NotebookEdit | | | ❌（无输出） |

### 4.2 输出包含
- 进程内 MCP server `xuanpu-tools`
- 接管 `Bash` 的工具实现（含 timeout / env / cwd / 信号 / background 语义对齐）
- `OutputCompressionPipeline` 接口 + 5 个最高 ROI 压缩策略（Stats Extraction / Failure Focus / NDJSON / Code Filter / Dedup —— 借鉴 RTK，TS 实现）
- `~/.xuanpu/archive/<session>/<seq>.txt` 落盘
- UI Bubble 节省指示器（`📦 8,432 → 412 tokens · 95% 省 · 展开原文`）
- 会话级累计 banner（`本会话已节省 142,318 tokens`）
- 设置开关 `Settings → 上下文卸载` 默认开
- 设置里的 archive 目录大小展示 + 一键清理

### 4.3 不做
- ❌ 替换 Read / Grep / Write / Edit
- ❌ OpenCode / Codex 适配
- ❌ 全局看板（"本周节省 X tokens"）→ v1.6
- ❌ archive 检索（"上次那个错误日志在哪"）→ v1.6
- ❌ 自动学习压缩规则 → 永远不做（玄学）

---

## 五、实施阶段（同分支连续提交）

> 都在 `feat_20260503_field_memory` 分支上推进，每个阶段一个 commit，不开 PR、不切分支。最后由用户决定何时合并。

### 阶段 0 · 安全边界（半天）
**目标**：为后续压缩管线打底。
- 翻 privacy 默认（采集开关默认开）
- 抽出 redact 模块为独立单元
- 补单测覆盖关键脱敏场景

### 阶段 1 · OutputCompressionPipeline 接口（1 天）
**目标**：抽接口，不绑定 Bash。
- `OutputStrategy` 接口：`compress(stdout, stderr, ctx) → { text, archive, before, after, ruleHits }`
- 5 个内置策略实现（Stats / Failure / NDJSON / Code / Dedup）
- 单测覆盖每个策略 happy path + 极端输入

### 阶段 2 · 进程内 MCP server + Bash 接管（2 天）
**目标**：MVP 核心。
- 在 `src/main/services/` 下新建 `xuanpu-tools-mcp.ts`
- 实现 `sdkMcpServers` 注册逻辑
- 实现 `Bash` 工具完整语义对齐（参考内建 Bash 文档/行为）
- 接入 OutputCompressionPipeline
- archive 落盘（`ContextOffloadStore`）
- `claude-code-implementer.ts` 配置 `disallowedTools: ['Bash']` + 注入 MCP

**关键测试**：
- 同一条 `npm test` 命令，开关开 vs 关，对比 token 计数
- archive 文件可读、原文完整
- 长输出（>10MB）不内存爆掉（流式 tee）
- 中断信号正确传递

### 阶段 3 · UI 感知层（1.5 天）
**目标**：用户能直观感受到玄圃在帮他省 token。
- Bubble metadata 渲染（节省指示器 + "展开原文"按钮）
- 展开走 `fileOps.read(archive)`
- 会话级累计 banner（在 SessionView 顶部）
- 设置页 toggle + archive 用量展示

### 阶段 4 · 验收 + 文档 + 落地（半天）
- README 中英双语补一节"Token Saver"
- 跑一遍真实场景 demo（pnpm dev / pnpm test 几次）
- 截图归档至 `docs/screenshots/token-saver/`
- commit `feat(v1.5.0): Token Saver MVP`

**总计**：约 5 天。

---

## 六、验收信号

### 6.1 功能验收
- ✅ 开 toggle 后，Claude Code 会话里执行 `pnpm test` 一次，agent 收到的 `tool_result` token 数 ≤ 原始的 30%
- ✅ Bubble 上能看到 `before / after / saved` 数字
- ✅ "展开原文"能完整还原（diff 原文 vs archive 文件，hash 一致）
- ✅ 关闭 toggle，回退到原生 Bash 行为，无副作用

### 6.2 性能验收
- ✅ 单次 Bash 包装开销 < 5ms（不含 user command 执行时间）
- ✅ archive 写入异步，不阻塞 tool_result 返回
- ✅ 10MB 输出压缩耗时 < 200ms

### 6.3 卖点验收
- ✅ 用户首次开会话能看到 banner "本会话已节省 X tokens"
- ✅ 截图能直观传达"省了多少"

---

## 七、风险与对冲

| 风险 | 影响 | 对冲 |
|---|---|---|
| Bash 语义遗漏（agent 期望某个特性丢失） | 任务执行失败 | 大量集成测试 + 一键关闭 toggle |
| 压缩规则误删关键信息 | agent 误判 | 默认保守压缩 + 用户可关 |
| archive 占盘 | 磁盘膨胀 | 设置里展示用量 + 自动 7 天清理 |
| SDK 升级后 `sdkMcpServers` API 变 | 阶段 2 失效 | 锁 SDK 版本 + CI 测试 |
| 内建 Bash 后续有玄圃缺失的特性 | 体验倒退 | 监控 SDK changelog，必要时合并 |

---

## 八、未来路线（不在 MVP 内）

- v1.6：扩到 Read / Grep / WebFetch
- v1.6：archive 检索（"上次那个 OOM 日志在哪"）
- v1.7：OpenCode 适配
- v1.7：全局节省看板
- v1.8：Codex 展示层压缩（无法真省 token，仅 UI 体验）
- v2.0：把 archive 接入字段内存的 episodic 层（"压缩+召回"闭环）

---

## 九、与 RTK 的关系（最终澄清）

**RTK 是参考实现，不是依赖**。

- RTK 的 12 类规则 → 玄圃 TS 实现，进 `OutputCompressionPipeline`
- RTK 的 tee 模式 → 玄圃 `ContextOffloadStore` 同思路
- 不 shell-out 调 RTK 二进制，不增加外部依赖
- 内部技术文档可以提一句"灵感来源于 RTK"，对外文档不出现 RTK 字样

---

## 十、对外命名

内部代码层：`OutputCompressionPipeline` / `ContextOffloadStore` / `xuanpu-tools-mcp`

对外用户层：**Token Saver**（中文："上下文卸载" / "智能压缩"）

设置项命名：`Settings → 性能 → 上下文卸载`（默认开）
