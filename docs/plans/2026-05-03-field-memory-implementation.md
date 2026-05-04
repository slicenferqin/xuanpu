# Field Memory v1.4.1 + 1.4.2 + 1.4.3 — 实施 PRD

- 日期：2026-05-03
- 版本范围：v1.4.1 / v1.4.2 / v1.4.3
- 状态：DRAFT（待评审）
- Supersedes（合并以下三份散文档为单一执行口径，原文保留为历史背景）：
  - `docs/essays/2026-04-25-from-1-3-to-1-4-ai-native-workbench.md`
  - `docs/plans/2026-04-25-memory-product-direction.md`
  - `docs/plans/2026-04-25-v1.4.3-plan.md`

---

## 0. 现状基线（v1.4.5 已实现，无需重做）

| Phase | 内容 | 落地位置 |
|---|---|---|
| 21 | Field Event Stream | `field_events` 表（schema v18）、`src/main/ipc/field-handlers.ts`、`src/main/field/{emit,repository,privacy}.ts` |
| 22A | Working Memory / Field Context 注入 | `src/main/field/context-builder.ts`、`context-formatter.ts`、`src/shared/types/field-context.ts` |
| 22B.1 | Episodic Memory（6h 滚动 + Haiku/rule compactor） | `field_episodic_memory` 表（schema v19）、`src/main/field/episodic-{compactor,updater}.ts`、`claude-haiku-compactor.ts` |
| 22C | Semantic Memory（只读 `memory.md`） | `src/main/field/semantic-memory-loader.ts` |
| 24C | Session Checkpoint（abort 现场） | `field_session_checkpoints` 表（schema v20）、`src/main/field/checkpoint-{generator,verifier,repository}.ts` |
| Debug UI | FieldContextDebug 面板（4 tabs） | `src/renderer/src/components/sessions/FieldContextDebug.tsx` |
| IPC | `window.fieldOps` namespace | `src/preload/index.ts`（约 L1911–1977）、`src/preload/index.d.ts` |

**当前 schema 版本**：`CURRENT_SCHEMA_VERSION = 20`（`src/main/db/schema.ts` L1）。下一次 migration 编号 = **v21**。

---

## 1. 目标与非目标

### 目标
- **1.4.1**：让用户能写"永恒事实"（Pinned Facts），并被自动注入到每条 prompt 的 Field Context 前缀。
- **1.4.2**：让用户**看见**记忆（Pinned + Observed + Semantic），并能编辑 Pinned、重压 / 清空 Observed；slash command（`/remember`、`/forget`）作为快速入口。
- **1.4.3**：把"能稳定发版 + 第一次打开就看得懂"两件事补齐——release 守卫 + onboarding + 空状态 + diff/image polish + README.en 同步。

### 非目标（明确划走，不在本 PRD 内）
- Guardian / Autopilot 托管档（推 1.5+）
- 跨 agent（Codex / OpenCode / Amp）注入质量验证（1.4.4 单独立项）
- 多 provider 配置 / Haiku 替代模型（1.4.5+）
- Semantic Memory 改造为 LLM 主动提议（1.4.x 不做，仍只读 `memory.md`）
- Pinned Facts 跨 worktree 共享（1.4.x 不做，按 worktree 隔离）

---

## 2. v1.4.1 — Pinned Facts（P0，~1 天）

### 2.1 DB Schema（schema v21）

```sql
CREATE TABLE field_pinned_facts (
  worktree_id TEXT PRIMARY KEY REFERENCES worktrees(id) ON DELETE CASCADE,
  content_md  TEXT NOT NULL DEFAULT '',
  updated_at  INTEGER NOT NULL,
  created_at  INTEGER NOT NULL
);
```

- 落点：`src/main/db/schema.ts` 的 `MIGRATIONS` 数组末尾追加 v21；bump `CURRENT_SCHEMA_VERSION = 21`。
- 约束：单行 per worktree（PK = worktree_id）；2000 字上限在应用层校验，不进 DB CHECK（保留迁移弹性）。
- ON DELETE CASCADE：删除 worktree 自动清理。

### 2.2 IPC（扩 `window.fieldOps`，不新开 namespace）

| Channel | 入参 | 出参 |
|---|---|---|
| `field:getPinnedFacts` | `worktreeId: string` | `{ contentMd: string; updatedAt: number } \| null` |
| `field:updatePinnedFacts` | `worktreeId: string, contentMd: string` | `void` |

- 实现：`src/main/ipc/field-handlers.ts` 追加两个 handler；新增 `src/main/field/pinned-facts-repository.ts`，模仿 `repository.ts` 的 prepared statement 模式。
- Preload：`src/preload/index.ts` 在 `fieldOps` 对象内追加两个方法；同步类型到 `src/preload/index.d.ts`。

### 2.3 注入逻辑

- 改 `src/main/field/context-formatter.ts`：在 **Worktree 区块之后、Recent Activity 之前**插入：
  ```markdown
  ## Pinned Facts
  <content_md>
  ```
- 单独 token budget：建议 **400 tokens 上限**；超出只截断 Pinned 段（不影响其它段）。
- `content_md` 为空 / 仅空白 → 整段不渲染（连标题也不写）。

### 2.4 UI 草图（最小化）

```
┌─ Worktree Detail Page ──────────────────────────────┐
│ ...existing header...                              │
│ ...existing sections...                            │
│                                                    │
│ ┌─ Pinned Facts ─────────────────────────[saved]─┐ │
│ │ ┌──────────────────────────────────────────┐   │ │
│ │ │ - 用 pnpm，不要用 npm                       │   │ │
│ │ │ - DB at ~/.xuanpu/xuanpu.db              │   │ │
│ │ │ - 我们不写注释                              │   │ │
│ │ └──────────────────────────────────────────┘   │ │
│ │                              123 / 2000   [Save]│ │
│ └────────────────────────────────────────────────┘ │
└────────────────────────────────────────────────────┘
```

- 文件：`src/renderer/src/components/worktrees/PinnedFactsCard.tsx`
- 控件：shadcn `<Textarea>` + 字数计数 + 「保存」按钮
- 自动保存：debounce 800ms；显式按钮兜底 + 显示 `saved` / `saving...` 状态
- 状态：复用 `useWorktreeStore`，**不新开 store**

### 2.5 验收信号

- [ ] DB 升级到 v21，`field_pinned_facts` 表在 `~/.xuanpu/xuanpu.db` 中存在
- [ ] 写一条 fact → reload app → fact 仍在
- [ ] 发一条 prompt → `FieldContextDebug` 的 Last Injection 里能看到 `## Pinned Facts` 段
- [ ] 清空 textarea → 下一次 injection 中 Pinned Facts 段消失
- [ ] 字数 > 2000 → 应用层提示 + 保存被拒

---

## 3. v1.4.2 — Memory 面板 + slash commands（P0，~1 天）

### 3.1 DB

无新增。复用 1.4.1 的 `field_pinned_facts` + 1.4.0 的 `field_episodic_memory`。

### 3.2 IPC（扩 `fieldOps`）

| Channel | 入参 | 出参 |
|---|---|---|
| `field:regenerateEpisodic` | `worktreeId` | `{ summaryMd; compactorId; version; compactedAt }` |
| `field:clearEpisodic` | `worktreeId` | `void` |
| 复用 1.4.1 | `getPinnedFacts` / `updatePinnedFacts` | — |

- `regenerateEpisodic`：触发 `episodic-updater.ts` 强制重跑（绕过滚动窗口判断）。
- `clearEpisodic`：删除该 worktree 的 episodic 行（下次自动重建）。

### 3.3 Slash commands

- `/remember <fact>`：追加一行 `- <fact>` 到 `field_pinned_facts.content_md` 末尾；超 2000 字 → toast 提示 + 不保存。
- `/forget <fact>`：在 content_md 中按子串 case-insensitive 匹配并删除该行；
  - 0 命中 → toast「未找到」
  - 1 命中 → 直接删 + toast 确认
  - >1 命中 → toast「请到 Memory 面板手动选择」并打开面板
- 实现：`src/renderer/src/hooks/useCommands.ts` 注册命令；dispatch 到 `window.fieldOps.updatePinnedFacts`。

### 3.4 UI 草图

```
┌─ Session HQ Right Panel ────────────────────────────┐
│ [Files] [Git] [Memory] [Field Debug*]              │
│         (* dev-only)                               │
│                                                    │
│ ┌─ Pinned Facts ──────────────────────────────────┐│
│ │ <PinnedFactsCard 复用>                           ││
│ └────────────────────────────────────────────────┘│
│                                                    │
│ ┌─ Observed (Episodic) ────────[Regenerate][Clear]┐│
│ │ compactor: claude-haiku v3 · 12m ago             ││
│ │ ─────────────────────────────────────────       ││
│ │ <markdown summary>                              ││
│ └────────────────────────────────────────────────┘│
│                                                    │
│ ┌─ Semantic ──────────────────────────────────────┐│
│ │ .xuanpu/memory.md (3 days ago)    [Open]        ││
│ │ ~/.xuanpu/memory.md (never)       [Create]      ││
│ └────────────────────────────────────────────────┘│
└────────────────────────────────────────────────────┘
```

- 新文件：`src/renderer/src/components/sessions/MemoryPanel.tsx`
- 入口：Session HQ 右侧 panel tab 列表加 "Memory"（在 Files / Git 之后）
- `FieldContextDebug.tsx` 退化为 dev-only：用 `import.meta.env.DEV` 控制 tab 是否注册；非 DEV 模式不出现。

### 3.5 验收信号

- [ ] `/remember 项目用 pnpm 不要用 npm` → Memory 面板 Pinned Facts 多一行
- [ ] `/forget pnpm` → 该行消失
- [ ] 点 [Regenerate] → Episodic 摘要在 ≤10s 内更新，`compactedAt` 刷新
- [ ] 点 [Clear] → Episodic 区域显示空状态文案
- [ ] 普通 build 启动后**默认看不到** "Field Debug" tab
- [ ] Semantic 区显示两个 memory.md 路径 + mtime；存在 → [Open]，不存在 → [Create]

---

## 4. v1.4.3 — 基础设施 + UX polish（P1，~1–2 天）

拆三个独立 PR，可并行：

### 4.1 PR A · Release / Onboarding 守卫

**Release verify step**（`.github/workflows/release.yml`）：
- 检查 `out/<platform>/cloudflared/<expected>/cloudflared` 存在且 `chmod +x` 可执行
- 检查 `out/<platform>/resources/mobile-ui/index.html` 存在
- 检查 `app.asar` + `better-sqlite3.node` / `node-pty.node` 三平台 native bindings
- 任一失败 → workflow fail，release 不发布

**首次 onboarding（4 step checklist）**：
- 新组件：`src/renderer/src/components/onboarding/FirstRunChecklist.tsx`
- 状态存 `useUiStateStore`（**不再 bump schema**）
- 步骤：
  1. 选 / 创建一个 worktree
  2. 发出第一条 prompt
  3. 展开 Field Context Debug（或 Memory 面板）
  4. 启用 Hub 扫码

### 4.2 PR B · 空状态 + 文案 + README.en

**空状态文案**（`FieldContextDebug.tsx` & `MemoryPanel.tsx`）：

| 区块 | 空状态文案 | CTA |
|---|---|---|
| Last Injection | 还没有现场。发一条消息试试。 | — |
| Episodic | 约 20 个事件后会自动压缩成摘要。 | — |
| Semantic | 还没有 memory.md。这是你写项目永恒事实的地方。 | [创建 memory.md] |
| Checkpoint | abort 当前 session 时会自动记录现场，方便下次接着干。 | — |

- Semantic 的 [创建 memory.md] 调 `window.fileOps.create`（路径用 `.xuanpu/memory.md`），创建后调用 `systemOps.openInEditor`。

**README.en.md 同步**：
- 把中文版 1.4.0 的"现场提供者 + 分层记忆"章节翻译到 README.en.md
- 中英目录结构 1:1 对齐

### 4.3 PR C · 卡片可视化增强

**Diff 折叠**（`FileWriteCard` / `FileEditCard`）：
- 落点目录：`src/renderer/src/components/sessions/cards/`（实施时 grep 确认）
- 默认展示前 **10 行**（多行 padding 提示「+N more lines」）
- 「展开 / 收起」按钮（`<ChevronDown>` / `<ChevronUp>`）
- 实现优先用现成 `react-diff-viewer`，不行再手卷

**Composer 缩略图 lightbox**：
- 新组件：`src/renderer/src/components/ui/image-lightbox.tsx`
- 触发：composer 中点击图片缩略图
- 行为：modal 居中、保持比例、最大 90vw × 90vh、ESC 关闭、点背景关闭、双击恢复 1:1

### 4.4 验收信号（合并表）

| 项 | 信号 |
|---|---|
| Release verify | 故意删一个 cloudflared 二进制 → workflow 红灯 |
| Onboarding | 全新数据库启动 → 看到 4 step checklist；完成后不再出现 |
| 空状态 | 全新 worktree 打开 Memory 面板 → 四个区块都有人话 + 必要 CTA |
| Semantic CTA | 点「创建 memory.md」→ 文件创建 + 自动在编辑器打开 |
| Diff 折叠 | 触发一次 100 行的 Edit → 卡片默认 ≤12 行 + 展开按钮可用 |
| Image lightbox | composer 贴图 → 点击放大 → ESC 收回 |
| README.en | 中英文 1.4.0 章节内容点对点对齐 |

---

## 5. 复用的现有代码（不要重写）

| 用途 | 文件 |
|---|---|
| DB migration | `src/main/db/schema.ts`（追加 v21） |
| Repository 模式参考 | `src/main/field/repository.ts` |
| Field Context 注入位置 | `src/main/field/context-formatter.ts` |
| IPC handler 落点 | `src/main/ipc/field-handlers.ts` |
| Preload 暴露 | `src/preload/index.ts`（`fieldOps` 对象，约 L1911–1977）|
| Preload 类型 | `src/preload/index.d.ts` |
| UI 模式参考 | `src/renderer/src/components/sessions/FieldContextDebug.tsx` |
| Slash command 接入 | `src/renderer/src/hooks/useCommands.ts` |
| Worktree 状态 | `src/renderer/src/stores/useWorktreeStore.ts` |

---

## 6. 实施顺序与 PR 拆分

```
1.4.1  → 1 个 PR：DB migration + fieldOps 扩展 + PinnedFactsCard + injection
1.4.2  → 1 个 PR：MemoryPanel + slash commands + FieldContextDebug 收纳
1.4.3  → 3 个 PR（A / B / C），可并行
```

总估时：3–4 个工作日。

---

## 7. Open Questions

- Pinned Facts 与未来"衰减/合并"机制的关系（1.5+ 才决）
- Semantic Memory 是否最终走 LLM 主动提议（暂不在 1.4.x）
- Guardian 何时启动（看 1.4.0 稳定信号）
- 跨 agent 注入质量验证（1.4.4 单独立项）
- `/forget` 的模糊匹配策略——子串够不够？是否需要 fuzzy（FuseJS）？暂定子串，PR 中再回看。
