# XFP Packet v1 字段说明

日期：2026-05-25
状态：v1 契约（implement-against）
源：`docs/plans/2026-05-24-xuanpu-agent-1.5.0-context-native-harness.zh-CN.md`
代码：`src/main/services/xuanpu-agent/xfp/{types.ts,schema.ts,fixtures.ts}`

XFP 是玄圃和 xuanpu-agent 之间的边界协议。每轮对话，玄圃编译一个
`XfpFieldPacket`，agent 消费它。v1 只记录 **what + source refs**，不记录
**why included / why omitted**（plan-review AI-4：留到 v2）。

每个 packet 顶层都有 `version: 1`，schema 升级靠这个字段判别。

## 顶层 sections

| Section        | 必填    | Cache stability | 说明                                                                |
| -------------- | ------- | --------------- | ------------------------------------------------------------------- |
| `version`      | 必填    | stable          | 字面量 `1`，schema 升级标识。                                       |
| `identity`     | 必填    | stable          | packetId / 时间戳 / project / worktree / session id。               |
| `anchor`       | 可空    | stable          | pinned facts + worktree notes，进 prefix cache。                    |
| `gitState`     | 必填    | volatile        | 当前分支、HEAD、upstream、ahead/behind、dirty 状态及 dirty 文件预览。|
| `focus`        | 必填    | volatile        | 当前文件和选区。                                                    |
| `terminal`     | 可空    | volatile        | 最近一条终端命令的 head/tail 摘要。                                 |
| `tests`        | 可空    | volatile        | 测试结果状态、通过/失败数、失败摘要。                               |
| `commandTrace` | 可空    | mixed           | 最近 N 条压缩后的 command trace 条目。                              |
| `currentGoal`  | 必填    | volatile        | 用户当前请求的目标描述。                                            |
| `budget`       | 必填    | mixed           | 本轮 Context Budget 用了多少 token、丢弃了哪些 section 名。         |

## Cache stability 规则

- **stable**：值变化频率低于一个 task lifetime。进 prefix cache。
  代表：`identity`、`anchor`。
- **volatile**：每轮（甚至子轮）都可能变化。进 append-only log section，不复用 prefix cache。
  代表：`gitState`、`focus`、`terminal`、`tests`、`currentGoal`。
- **mixed**：packet compiler 在编译时按字段决策。
  代表：`commandTrace`（条目本身是 volatile，但 trace id 引用是 stable）、`budget`。

把 cache 影响明牌——这是 Reasonix 给玄圃最大的启发。M1 packet compiler 必须按
这个标记决定字段放在 prompt 的哪个区域。

## RawRefs 契约

「没有 raw refs 的总结只是传说，有 raw refs 的总结才是记忆」（plan 第 5 条原则）。

所有非平凡 section（gitState / focus / terminal / tests / commandTrace /
currentGoal / anchor）都带 `rawRefs: XfpRawRef[]`。`XfpRawRef.kind` 共 8 种：

```text
file | command-trace | terminal-output | git-object | message | episode | memory-page | checkpoint
```

每条 raw ref 至少要有：

- `kind`：枚举值
- `id`：玄圃 SQLite / 文件系统能查回的标识
- `excerpt?`：可选，模型可见片段
- `byteRange?`：可选，excerpt 对应底层 artifact 的字节范围
- `meta?`：可选，pointer-level 附加信息（如 sha、行范围）

bytes 不内联——只放 pointer。需要时由 consumer 通过 raw ref 拉取。

## 退化值约定

- 当前没有 session：`identity.sessionId = null`。
- 当前 worktree 没有 anchor（pinned facts 和 worktree notes 都为空）：`anchor = null`。
- 没有终端：`terminal = null`。
- 没有测试输出：`tests = null`。
- 没有 trace：`commandTrace = null`。
- `currentGoal` 始终存在——找不到就用 heuristic（`source: 'heuristic'`）。
- `budget` 始终存在——profile 默认 `balanced`。

## MinimalFieldPacket（CLI subset）

`MinimalFieldPacket` 是 `XfpFieldPacket` 的 **structurally narrower** 版本——
不是 `Pick<>` 字段子集，identity 字段也不同。用于 1.7.0 standalone CLI 模式
（玄圃 main 进程没起，没 SQLite / worktree manager）。

字段数：5 个顶层字段。

| Section       | 来源差异                                                                     |
| ------------- | ---------------------------------------------------------------------------- |
| `version`     | 同 `XfpFieldPacket.version`，字面量 1。                                      |
| `identity`    | 只有 `packetId` + `capturedAt`，没有 project/worktree/session id。           |
| `cwd`         | 必填，CLI 启动目录的绝对路径（替代 worktree.path）。                         |
| `stdin`       | 可空，stdin 文件 + excerpt + rawRefs。                                       |
| `gitState`    | 可空，仅当 cwd 处于 git 仓库时填充。结构等同 `XfpGitState`。                 |
| `currentGoal` | 必填，结构等同 `XfpTaskGoal`。                                               |

`narrowToMinimal(packet, { cwd, stdin? })` 把 `XfpFieldPacket` 转成
`MinimalFieldPacket`，调用方必须显式提供 cwd（full packet 用 worktree id 而非
绝对路径标识 worktree）。

## v1 不做的事

- 不写 packet compiler、validator runtime、repository——这是 M1 的事。
- 不加 "why included / why omitted" 字段——v2 配合 Context Budget UI 一起做。
- 不做 PII 脱敏 / 隐私策略——v2 在 budget section 加 `privacyPolicy` 字段。
- 不做 packet diff——XFP Inspector UI 上线时再说。

## 校验

```ts
import { XfpFieldPacketSchema, MinimalFieldPacketSchema } from './schema'
import { fullXfpPacketExample, minimalXfpPacketExample } from './fixtures'

XfpFieldPacketSchema.parse(fullXfpPacketExample())     // throws on contract drift
MinimalFieldPacketSchema.parse(minimalXfpPacketExample())
```

任何 trust boundary（IPC、磁盘读、CLI 流入）都必须过 schema parse，不允许走
type assertion bypass。
