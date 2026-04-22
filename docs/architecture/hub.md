# Hub 架构（M1）

> 给要在 Hub 层面动刀的贡献者。  
> 文件路径以 `src/main/services/hub/` 为根。

## 总览

```
┌─────────────────────────────────────────────────────────────────┐
│                         Electron Main                            │
│                                                                  │
│   ClaudeCodeImplementer ──┐                                      │
│   CodexImplementer ───────┼──► mainWindow.webContents.send(      │
│   OpenCodeService ────────┘      'agent:stream', CanonicalEvent) │
│                                          │                       │
│   wrapBrowserWindow() Proxy ◄────────────┘                       │
│          │           │                                           │
│          │           └──► real renderer (unchanged)              │
│          ▼                                                       │
│     HubBridge ──────► HubRegistry (devices / sessions / WS subs) │
│          │                              │                        │
│          │              ┌───────────────┘                        │
│          ▼              ▼                                        │
│     (ClientMsg)     HubServer (HTTP + WS, 127.0.0.1:8317)        │
│          ▲              │   │                                    │
│          │              │   └─► cloudflared child (public URL)   │
│          │              ▼                                        │
│          │         mobile/dist (served statically)               │
└──────────┼──────────────────────────────────────────────────────┘
           │
           ▼ (WebSocket /ws/ui/:deviceId/:hiveSessionId)
    ┌──────────────┐
    │ Mobile React │  (mobile/ pnpm workspace)
    │  + zustand   │
    └──────────────┘
```

## 设计约束（不可回撤）

1. **零侵入** — Claude/Codex/OpenCode 的 implementer 文件未修改。fan-out 完全在 `wrapBrowserWindow` Proxy 里：拦截 `webContents.send(channel, ...)`，只对 `channel==='agent:stream'` 分流给 HubBridge。
2. **loopback-only 监听** — `HubServer` 只 bind `127.0.0.1`（v6 fallback `::1`）。公网暴露必须走 `cloudflared` 子进程，从设计上杜绝误操作。
3. **桌面端二次确认不可由移动端跳过** — `HubBridge.handleClientMessage` 对 `prompt` frame 强制走 `PromptConfirmer.confirm()`，30s 超时返回 `CONFIRM_TIMEOUT`。
4. **消息幂等** — 每个 ServerMsg 都带单调 `seq`（per-session `SeqCounter`）；reconnect 用 `resume{lastSeq}` 从 `MessageRingBuffer` 重播（容量 500 帧）。buffer 被挤出就回 `NEED_FULL_RELOAD`，客户端走 REST `/api/sessions/:id/history` 全量回填。

## 文件地图

| 文件 | 作用 |
| :-- | :-- |
| `hub-protocol.ts` | `ServerMsg` / `ClientMsg` zod schema，`MessageRingBuffer`，`SeqCounter` |
| `hub-auth.ts` | `hashPassword/verifyPassword` (scrypt)、`LoginRateLimiter`、CF Access header 读取、`isOriginAllowed` |
| `hub-registry.ts` | 设备注册表 + 活跃 session + WS 订阅 Set；`broadcast(frame)` 用 |
| `hub-bridge.ts` | IPC → ServerMsg 翻译；ClientMsg → runtime method；`wrapBrowserWindow` Proxy |
| `hub-server.ts` | HTTP + WS 路由；setup / login / logout / me / config / devices / sessions / history |
| `tunnel-service.ts` | spawn cloudflared；URL 解析；指数退避重启；跨平台二进制解析 |
| `hub-controller.ts` | 组合以上 + 管理 PendingConfirmation Map + 给 IPC 层唯一入口 |

## 数据流（sequence）

### 桌面 → 手机（push）

```
ClaudeCodeImplementer.emitAgentEvent
  ├─ normalize-agent-event.ts  → CanonicalAgentEvent
  └─ mainWindow.webContents.send('agent:stream', envelope)
                                       │
                    (wrapped Proxy intercepts .send)
                                       │
                                       ▼
                              HubBridge.onIpcEvent
                                       │
                           HubBridge.translate(event)
                                       │
                    [ServerMsg without seq] × N
                                       │
                   HubRegistry.nextSeq + broadcast
                                       │
                    (every subscriber WebSocket gets JSON)
```

**翻译策略（loose, lossless）：**
- `session.status` → `status` frame (filter: idle/busy/retry/error)
- `permission.asked` → `permission/request` frame
- `question.asked` → `question/request` frame
- 其他 CanonicalAgentEvent → `message/append` 带单个 `UnknownPart{raw:event}`（保证不丢数据）

### 手机 → 桌面（inbound）

```
Mobile HubWebSocket.send(ClientMsg)
  │
  ▼
HubServer WS route → bridge.handleClientMessage(ws, hiveSessionId, raw)
  │
  ├─ ClientMsgSchema.parse (zod)
  │
  ├─ 'prompt' → PromptConfirmer.confirm{confirmId, preview}
  │      │    ├─ resolve{approved:true}  → runtime.prompt(wt, sid, text)
  │      │    └─ resolve{approved:false} → error BAD_REQUEST 'rejected'
  │      │    └─ 30s timeout              → error CONFIRM_TIMEOUT
  │
  ├─ 'interrupt' → runtime.abort(wt, sid)
  │
  ├─ 'permission/respond' → runtime.permissionReply(reqId, decision, wt, msg?)
  │
  ├─ 'question/respond' → runtime.questionReply | questionReject
  │
  └─ 'resume' → registry.ringBuffer.replayAfter(lastSeq) → ws.send(frame[])
```

## 数据库

Schema v17 (`src/main/db/schema.ts` 第 445-500 行)。五张表：

| 表 | 作用 |
| :-- | :-- |
| `hub_users` | 管理员账号；scrypt 哈希 |
| `hub_tokens` | M2 agent/PWA token；prefix 索引 + sha256 哈希 |
| `hub_cookie_sessions` | UI 7 天 Cookie；expires 索引 |
| `hub_devices` | M2 多设备；M1 只填本机一条 |
| `hub_settings` | 键值存储：auth_mode、require_desktop_confirm、cf_access_emails (JSON)、tunnel_url |

## 鉴权矩阵

| 路径 | password | cf_access | hybrid | public |
| :-- | :-: | :-: | :-: | :-: |
| GET /health | ✓ | ✓ | ✓ | ✓ |
| GET /api/setup/status | ✓ | ✓ | ✓ | ✓ |
| POST /api/setup | *setup-key only* | *setup-key only* | *setup-key only* | ✓（第一次时） |
| POST /api/login | ✓ | ✗ | ✓ | ✓ |
| POST /api/logout | cookie | – | cookie | – |
| GET /api/me, /api/config, /api/devices* | cookie | CF Access email | cookie ∨ CF Access | ✗ |
| WS /ws/ui/:d/:s | cookie + Origin | CF Access + Origin | 任一 + Origin | ✗ |

Origin 检查：允许 `http://127.0.0.1:<port>` + `http://[::1]:<port>` + `http://localhost:<port>` + `tunnel_url`（如有）。

## 测试

| 文件 | 覆盖 |
| :-- | :-- |
| `test/server/hub-auth.test.ts` | scrypt 盐哈希往返、rate limiter 滑窗、CF Access header / Origin check | 14 tests |
| `test/server/hub-protocol.test.ts` | zod schema 正/反例、RingBuffer 驱逐 + NEED_FULL_RELOAD、SeqCounter 单调 | 18 tests |
| `test/server/hub-registry.test.ts` | 订阅/取消、broadcast 丢失 WS 清理、status 传递 | 9 tests |
| `test/server/hub-bridge.test.ts` | Proxy 拦截、runtimeId 过滤、翻译、CONFIRM_TIMEOUT、resume 回放 | 11 tests |
| `test/server/hub-server.test.ts` | 集成（真 fetch）：setup/login/me/logout、四种鉴权、Origin、路由 404 | 22 tests |
| `test/server/tunnel-service.test.ts` | 假 spawn：启动/URL 解析、无二进制、退避链、reset、手动 stop | 8 tests |

共 **82 tests**。跑单个模块：`pnpm exec vitest run test/server/hub-<name>.test.ts`。

## 添加新的 ServerMsg 类型

1. `hub-protocol.ts`：在 zod `ServerMsgSchema` 里加 discriminated union 分支
2. `hub-bridge.ts`：`translate()` 里处理或落到 unknown fallback
3. `mobile/src/types/hub.ts`：镜像加同名成员（无 zod）
4. `mobile/src/hooks/useSessionStream.ts`：reducer `frame` 分支里处理
5. 加 unit test

## 添加新的 ClientMsg 类型

1. `hub-protocol.ts`：加 `ClientMsgSchema` 分支
2. `hub-bridge.ts`：`handleClientMessage` switch 加 case，决定是否需要 `routing`
3. mobile `types/hub.ts` + `useSessionStream.ts` 增加对应 action
4. 加 unit test

## 已知折中

- **UnknownPart 回退**：代价是手机消息流里很多事件是 `agent activity` 折叠 JSON；好处是任何未来的 CanonicalAgentEvent 都不会掉。M1.5 会把常见 `message.updated` / `tool.called` 专门翻译。
- **Ring buffer 容量 500**：长会话或慢 reconnect 会触发 `NEED_FULL_RELOAD`。mobile 已经实现 fallback 路径，但用户体验是"白屏一秒后满血"。调大容量的代价是内存。
- **Mobile bundle 92KB gzip**：没有 react-markdown / qrcode 等大库。代价是 MiniMarkdown 能力弱（仅 fence / inline / bold）。
- **CSRF 靠 Origin/Referer**：没发 CSRF token（loopback + SameSite=Lax 已经挡住 80% 场景）。M2 加 CSRF token。
