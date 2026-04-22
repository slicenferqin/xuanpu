# Hub 模式：手机远程访问（M1）

> 让手机或平板通过浏览器远程查看、控制你的 Claude Code 会话。  
> 无需账号、无需额外工具，桌面端一次开关即用。

## 快速开始

1. **设置 → Hub (Mobile)**。第一次打开会让你用一次性 Setup Key 创建管理员：
   - 记下页面上显示的 Key（进程重启后失效）
   - 填入用户名 + 8 位以上密码
2. 打开 **本机服务** 开关。你会看到 `http://127.0.0.1:8317`。
3. 本机浏览器试试：输入上面的 URL 登录，应当能看到你的会话列表。
4. 需要手机访问时再开 **公网访问 (Cloudflare 隧道)**。5 秒左右会出现 `https://xxx.trycloudflare.com`。
5. 手机打开这个 URL → 登录 → 选设备 → 点一个 session 开始聊天。

## 安全模型

Xuanpu Hub 默认只接受 **loopback（127.0.0.1 / ::1）** 连接。公网暴露必须由你主动打开。

### 三种鉴权模式（在 Hub 面板里切）

| 模式 | 何时用 | 工作方式 |
| :-- | :-- | :-- |
| **password**（默认） | 本机或可信网络 | 用户名 + 密码登录，Cookie 会话 7 天 |
| **cf_access** | 公网暴露 **推荐** | 使用 Cloudflare Access 前置，信任 `CF-Access-Authenticated-User-Email` + 白名单 |
| **hybrid** | 过渡切换 | 以上任一方式通过即放行 |

### 桌面端二次确认

默认开启：手机发起的每条 prompt，都会在桌面端弹 Toast 让你 **批准 / 拒绝**，30 秒超时视为拒绝。

> **公网访问开启时此开关强制为 ON，无法关闭**。这是 Xuanpu 防止 Hub URL 泄漏后被滥用的最后一道闸门。

### 登录限流

同一 IP **5 次/15 分钟** 登录失败就会被拒绝 15 分钟。避免自动爆破。

### 攻击面注释

- Hub 服务只监听 `127.0.0.1` / `::1`，从不绑 `0.0.0.0`
- 公网暴露由 `cloudflared` 子进程隧道实现，进程退出就会断
- WebSocket 升级前校验 Origin header + cookie 会话
- 所有响应 `SameSite=Lax; HttpOnly`，密码走 scrypt (N=2^15, 32MB)
- 登录 token 未在 M1 启用（M2 用于手机 PWA 长连），现在只接受 Cookie + CF Access

## 配 Cloudflare Access（强烈推荐公网场景）

如果你要把 Hub 长期暴露在公网，**不要只靠密码**。Cloudflare Access 是免费、能白名单邮箱、支持 2FA 的前置网关。

1. 在 [Cloudflare Zero Trust](https://one.dash.cloudflare.com/) 创建一个 **Access Application**：
   - Type: **Self-hosted**
   - Application domain: 你自己的域名（配好 CNAME 到 trycloudflare tunnel 或买稳定 Named Tunnel）
   - Identity providers: 打开 **One-time PIN** 或 Google / GitHub SSO
   - Policies: 选 **Emails** rule，填入允许访问的邮箱
2. Tunnel 改成用 Named Tunnel 绑到这个域名（trycloudflare 快速隧道不接 Access）
3. Xuanpu：**鉴权模式 → cf_access**，在「允许的邮箱」里填上同样的白名单（双保险）

之后 Hub 不再处理密码；所有请求都会带 `Cf-Access-Authenticated-User-Email` header，Hub 会比对白名单。

## 常见问题

### 手机访问报 403 / WebSocket 连不上

- Origin 不在允许列表。M1 允许 loopback + 当前 tunnel URL。如果你用了 Named Tunnel + 自定义域名，临时可以在 Login 的「高级设置」里直接输入 API base，然后走 CF Access 鉴权模式（绕开 Origin 校验重点其实是 Cookie，CF Access 场景下 origin 也会继续校验到 tunnel URL）
- `?api=https://...` URL 参数只需要访问一次，会写进 localStorage

### Tunnel 状态一直是 `starting`

- 公司网络屏蔽了 Cloudflare？试试手机 4G 热点
- 看桌面端日志：`~/.xuanpu/logs/xuanpu-*.log`，搜 `TunnelService`

### 手机 prompt 发出后卡住

- 桌面端 Toast 被你忽略了 → 30 秒后会返回 `CONFIRM_TIMEOUT` 错误
- 关掉二次确认开关（仅内网建议）

### 二次确认开关是灰的

公网隧道开启时会强制 ON。先关 tunnel 再改。

## 已知限制（M1）

- **仅 Claude Code**：Codex / OpenCode 会话在手机端不可见（M1.5）
- **不支持文件附件上传**：手机端只能发文本 prompt
- **消息流是"agent activity"JSON dump**：复杂工具调用目前没有专用 UI（M2 补）
- **没有深色/浅色切换**：手机端固定深色
- **没有 PWA 离线壳**：刷新需要网络（M2 加 Service Worker）

## 后续路线

- **M1.5**：Codex + OpenCode 接入、消息流富渲染（MarkDown/Diff）
- **M2**：Agent 模式（装 xuanpu-agent 的其他电脑汇报给 Hub）、Token 鉴权、PWA 离线壳
- **M3**：端到端加密、无中心（DHT）
