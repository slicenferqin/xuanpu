# Hub M1 — 手动 E2E 冒烟 Checklist

> 在每次发版前由人执行一遍。一项失败即应回滚。  
> 单元测试覆盖见 `docs/architecture/hub.md`，本文档专注用户路径。

## 准备

```bash
# 干净环境（清空 hub 表）
sqlite3 ~/.xuanpu/xuanpu.db <<'EOF'
DELETE FROM hub_users;
DELETE FROM hub_tokens;
DELETE FROM hub_cookie_sessions;
DELETE FROM hub_settings;
EOF

# 启动
pnpm dev
```

准备 2 台设备：
- **桌面**：跑 Xuanpu 的开发机
- **手机**：iPhone Safari / Android Chrome，**先连同一 Wi-Fi**（验本地）

---

## 1. 首次 Setup

- [ ] 设置 → Hub (Mobile)，看到「首次设置」卡片，显示 8 字符 Setup Key
- [ ] 输入 username + 8 位以上 password，点「创建管理员」
- [ ] Setup Key 卡片消失，「本机服务」卡片解禁
- [ ] DB 验证：`sqlite3 ~/.xuanpu/xuanpu.db 'SELECT username, length(password_hash) FROM hub_users;'` 应该有一行，hash 长度 > 70
- [ ] 重启 dev，刷新设置面板，**Setup 卡片不再出现**（admin 已存在）
- [ ] 错误路径：在「首次设置」时填错 key → 弹错，admin 仍未创建

## 2. 本机访问

- [ ] 打开「本机服务」开关 → 显示 `http://127.0.0.1:8317` 和复制按钮
- [ ] 桌面浏览器访问 → 渲染 mobile UI 登录页
- [ ] 输入正确账密 → 跳到 /devices，看到本机一条记录（绿点 online）
- [ ] 点进去 → /sessions/:deviceId，看到当前活跃会话（按 project/worktree 分组）
- [ ] 点一个会话 → /session/:deviceId/:hiveId，header 显示「● 在线」
- [ ] curl `http://127.0.0.1:8317/health` → `{"ok":true}`

## 3. 公网访问

- [ ] 打开「公网访问」开关 → 状态变 `starting`
- [ ] 5 秒内变 `running`，显示 `https://xxx.trycloudflare.com` URL
- [ ] **手机切到 4G/5G**（不是 Wi-Fi！要验真公网路径）
- [ ] 手机浏览器打开 tunnel URL → 渲染 mobile UI
- [ ] 登录 → 看到设备 → 选会话
- [ ] curl 桌面 `https://xxx.trycloudflare.com/health` → `{"ok":true}`

## 4. 桌面端二次确认

- [ ] tunnel 开启状态下，**确认面板里「桌面端二次确认」开关变灰且强制 ON**
- [ ] 手机端在 PromptComposer 输入「ls」点发送
- [ ] 桌面端右下角弹 sonner toast「手机请求执行 prompt: ls」+ 批准/拒绝
- [ ] 桌面点「批准」→ 手机看到 user bubble + claude 开始流式回复
- [ ] 重新发一条 prompt，桌面 30 秒不点 → 手机收到 `CONFIRM_TIMEOUT` 错误条
- [ ] 关 tunnel，再关「二次确认」开关 → 此时手机 prompt 直接执行无 toast

## 5. 中断长任务

- [ ] 发一条会跑很久的 prompt（如「写一个完整的 React 项目脚手架」）
- [ ] 桌面批准
- [ ] 手机「发送」按钮变成红色「中断」
- [ ] 点「中断」→ runtime.abort 触发，桌面端 claude 进程立刻停
- [ ] 手机端 status 变回 idle

## 6. 权限请求审批

- [ ] 让 claude 请求一个未批准的 tool（例如让它写新文件）
- [ ] 手机端在消息流中看到黄色 PermissionCard：工具名 + 入参 JSON
- [ ] 点「允许一次」→ 卡片消失，工具继续执行
- [ ] 再触发一次 → 点「总是允许」→ 同样消失
- [ ] 第三次同类请求 → claude 直接放行，无新卡片
- [ ] 触发新工具，点「拒绝」→ runtime 收到 reject

## 7. WS 断线重连 + seq 对齐

- [ ] 手机连上一个跑长任务的 session，看到流式输出
- [ ] 桌面终端临时 `lsof -i :8317 | awk 'NR>1{print $2}' | xargs kill -9`（让 server 进程重启不优雅断 ws）
- [ ] 手机连接条变红「已断开，尝试重连中」
- [ ] 5-10 秒（指数退避 1s/2s/4s）后变绿
- [ ] 在断线期间桌面继续产生的消息 **应该被回放出来**（来自 ringBuffer.replayAfter(lastSeq)）
- [ ] 极端：让 server 停 60 秒以上 + 期间产生 > 500 帧 → 收到 `NEED_FULL_RELOAD` 错误条，**手动刷新页面**应能从 REST `/api/sessions/:id/history` 拉到完整历史

## 8. Rate Limit

- [ ] 桌面 curl 5 次错密码：
  ```bash
  for i in 1 2 3 4 5; do
    curl -i -X POST http://127.0.0.1:8317/api/login \
      -H 'content-type: application/json' \
      -H "origin: http://127.0.0.1:8317" \
      -d '{"username":"admin","password":"WRONG"}'
  done
  ```
  前 5 次返回 401。第 6 次返回 429 `RATE_LIMITED`。
- [ ] 等 15 分钟 + 1 秒后再试 → 401 复活（限流窗口过期）
- [ ] 用真密码登录成功 → IP 计数 reset
- [ ] 没改 `LoginRateLimiter` 配置 → 默认 5 / 15min

## 9. 鉴权模式切换

- [ ] 切到 **cf_access** 模式
- [ ] 此时本机浏览器（无 CF Access header）访问 → /api/me 返回 401
- [ ] 用 curl 模拟 CF Access：
  ```bash
  curl -H "cf-access-authenticated-user-email: alice@example.com" \
       http://127.0.0.1:8317/api/me
  ```
  → 401（因为没在白名单）
- [ ] 设置面板里把 `alice@example.com` 加入白名单
- [ ] 重试 curl → 200，返回 `{via:"cf_access", email:"alice@example.com"}`
- [ ] 切回 **password** 模式，本机浏览器恢复正常登录

## 10. 改密码

- [ ] 设置面板 → Hub → 安全 → 修改密码
- [ ] 填错原密码 → 弹错 toast
- [ ] 正确原密码 + 8 位以上新密码 → 成功 toast
- [ ] 用旧密码 curl /api/login → 401，新密码 → 200

## 11. 退出 + 清理

- [ ] 手机端「登出」 → 跳到 /login，cookie 失效
- [ ] 桌面停 Hub → 服务停止，tunnel 同时停
- [ ] 重启 dev，状态正确恢复（hub 默认关、tunnel 默认关、admin 仍存在）

---

## 已知问题（M1 deliberate）

| Symptom | 状态 |
| :-- | :-- |
| Codex / OpenCode 会话在手机端不可见 | M1.5 |
| 消息流大量 `agent activity` JSON 折叠卡 | M1.5 翻译常见类型 |
| 没有文件附件上传 | M2 |
| Hub 状态栏没有 PWA 图标提示 | M2 |
| 无 Service Worker 离线壳 | M2 |
| Token 列表 UI 隐藏（已实现 IPC） | M2 解锁 |
| Origin 校验对 cf_access 模式可能过严 | 已知，可在 hub-server.ts allowedOrigins 加入自定义域名 |

## 路线

- **M1.5**：Codex + OpenCode；消息流富渲染（MarkDown / Diff）；附件 base64 上传
- **M2**：xuanpu-agent (其他电脑 → 你的 Hub) ；Token 鉴权；PWA Service Worker；CSRF Token
- **M3**：端到端加密；DHT / 无中心 relay
