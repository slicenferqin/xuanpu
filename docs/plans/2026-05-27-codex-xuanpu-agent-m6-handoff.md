# Codex 交接：xuanpu-agent M6 状态

日期：2026-05-27
分支：`feat/xuanpu-agent-oh-my-pi`
交接基线：`3b119d29`

本文件只记录 Codex 本轮 M4+ 实现后的交接状态，不替代
`2026-05-27-xuanpu-agent-progress-and-roadmap.md` 原路线图。

## 远端状态

写入本交接前已确认：

- 本地 `HEAD` 与 `origin/feat/xuanpu-agent-oh-my-pi` 一致。
- 基线提交为 `3b119d2967a6b3c9ef39c5e3d032ba7471352055`。
- 工作树干净。

## 已推送提交

| 提交 | 范围 | 说明 |
|------|------|------|
| `4d85d5a2` | M4 | Controlled write harness |
| `4ac26988` | M5 | Memory graph foundation |
| `497b035e` | M6 | checkpoint/resume 与 claim verifier recovery |
| `72b2bdf5` | M6 | long-running test tool supervision |
| `0ce87444` | M6 | multi-worktree 与 PR/review context |
| `dd8abc99` | M6 | harness metrics |
| `3b119d29` | M6/hub | hub/mobile 保留 advanced agent parts |

## 当前完成度

M4 和 M5 已有实现与测试。M6 只能算部分完成，不能声称完成。

| 能力 | 状态 | 说明 |
|------|------|------|
| M4 受控写入 | 已完成 | `apply_patch`、`write_file`、`edit_file`、`run_test`、`format_file` 已接入 preview token 与危险路径阻断。 |
| M5 Memory Graph | 已完成 | memory proposal、retrieval、trace workflow materialization 已进入 context package。 |
| checkpoint/resume | 已完成 | verified checkpoint block 会在 resume turn 注入 XFP packet。 |
| Post-response claim verifier | 已完成 | assistant 最终输出里的文件/API claim 会基于 observed paths 和本地文件校验。 |
| long-running supervision | 已完成 | `run_test` 记录 timeout、abort、long-running notification 与压缩输出。 |
| multi-worktree awareness | 已完成 | XFP 包含同 project sibling worktrees 的有界视图。 |
| PR/review workflows | 已完成 | XFP 包含 current branch、compare target、attached PR 与 dirty count。 |
| harness metrics | 已完成 | context package 记录 cache ratio、parallel-safe ratio、compression metrics。 |
| hub/mobile event propagation | 已完成 | hub/mobile 对 unknown advanced parts 通过 `unknown.raw` 保留。 |
| MCP integration | 未完成 | `xuanpu-agent` 仍通过 `mcp-boundary` 阻止 MCP；Claude Code 的 XFP MCP 不能等同于 xuanpu-agent MCP。 |
| subtask delegation | 未完成 | timeline/UI 已支持 `subtask` part，但 xuanpu-agent runtime 尚未委派或发出 subtask lifecycle。 |

## 剩余 M6 工作

### Scoped MCP integration

建议先做 Xuanpu-owned、只读、受控的 MCP-like field tool surface，不做任意外部 MCP discovery。

优先暴露现有 Claude XFP MCP 的同构能力：

- `xfp_get_current_focus`
- `xfp_get_last_terminal_activity`
- `xfp_get_recent_activity`
- `xfp_get_worktree_summary`
- `xfp_get_pinned_facts`

验收标准：

- xuanpu-agent 能调用 scoped Xuanpu field tools。
- 任意外部 MCP、native process control、arbitrary shell 仍被策略拦截。
- `tool-policy.ts` 中的 `mcp-boundary` 状态与真实实现一致，不能只改文案。
- `test/phase-24/` 有 focused tests 覆盖 tool allowlist、audit、失败路径。

### Subtask delegation

建议从受控 delegation tool 或 runtime event 开始，不直接 spawn 任意 child agent 进程。

验收标准：

- xuanpu-agent turn 可以产生可见的 delegated subtask。
- subtask part 符合 `src/shared/lib/timeline-types.ts` 的结构。
- 有稳定的 running/completed/error 状态。
- child text/tool parts 能归到 parent subtask 下，或至少不污染主 assistant text。
- desktop timeline、hub bridge、mobile bridge 不丢失 subtask part。

## 继续工作建议

```bash
git checkout feat/xuanpu-agent-oh-my-pi
git pull --ff-only
pnpm vitest run test/phase-24/xuanpu-agent-tool-policy.test.ts
pnpm vitest run test/phase-24/xuanpu-agent-runtime.test.ts
pnpm vitest run test/phase-24/xuanpu-agent-ipc-smoke.test.ts
pnpm exec tsc --noEmit --pretty false
pnpm lint
pnpm build
```

已知本地环境 caveat：

- `test/server/hub-server.test.ts` 可能因 `better-sqlite3` Node ABI mismatch 失败。
- `test/server/hub-controller.test.ts` 可能因 Electron install check 失败。

除非重建依赖后仍复现，否则这两个更像环境问题，不应直接归因于 M6 改动。
