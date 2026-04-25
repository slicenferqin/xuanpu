/**
 * HubSection: Hub mode settings panel.
 *
 * Sections:
 *  1. Setup wizard (only when no admin exists yet)
 *  2. Local hub on/off + URL
 *  3. Public access via cloudflared
 *  4. Auth mode (password / cf_access / hybrid)
 *  5. Security (desktop confirm + change password)
 *
 * The desktop二次确认 toast lives in `HubConfirmationToasts` (mounted higher
 * up so it survives panel close).
 */

import { useEffect, useState, type FormEvent } from 'react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Switch } from '@/components/ui/switch'
import { Textarea } from '@/components/ui/textarea'
import { useHubStore } from '@/stores/useHubStore'
import { toast } from '@/lib/toast'
import { cn } from '@/lib/utils'
import { Copy, Globe, ShieldCheck, KeyRound, QrCode, Wifi, WifiOff } from 'lucide-react'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
import { QRCodeSVG } from 'qrcode.react'

const AUTH_MODE_OPTIONS: Array<{
  value: HubAuthMode
  label: string
  description: string
}> = [
  {
    value: 'password',
    label: '密码登录',
    description: '推荐用于本机和受信任网络。'
  },
  {
    value: 'cf_access',
    label: 'Cloudflare Access',
    description: '推荐用于公网访问。前置 CF Access 后只信任邮箱白名单。'
  },
  {
    value: 'hybrid',
    label: '混合（密码 + CF Access）',
    description: '任一方式通过即放行。仅用于过渡。'
  }
]

export function HubSection(): React.JSX.Element {
  const { status, cfAccessEmails, loading, init } = useHubStore()

  useEffect(() => {
    let cleanup: (() => void) | undefined
    init().then((u) => {
      cleanup = u
    })
    return () => cleanup?.()
  }, [init])

  return (
    <div className="space-y-8">
      <header>
        <h2 className="text-lg font-semibold">远程访问 (Hub)</h2>
        <p className="text-sm text-muted-foreground mt-1">
          在本机开启 Hub 服务，让手机或平板远程查看与控制你的 Claude Code 会话。
          公网访问通过 Cloudflare 临时隧道实现。
        </p>
      </header>

      {!status.hasAdmin && status.setupKey && (
        <SetupCard setupKey={status.setupKey} loading={loading} />
      )}

      <HubSwitchCard status={status} loading={loading} />

      <TunnelCard status={status} loading={loading} />

      <AuthModeCard
        currentMode={status.authMode}
        emails={cfAccessEmails}
        loading={loading}
      />

      <SecurityCard status={status} loading={loading} />
    </div>
  )
}

// ─── Setup wizard ──────────────────────────────────────────────────────────

function SetupCard({
  setupKey,
  loading
}: {
  setupKey: string
  loading: boolean
}): React.JSX.Element {
  const createUser = useHubStore((s) => s.createUser)
  const [username, setUsername] = useState('')
  const [password, setPassword] = useState('')

  const onSubmit = async (e: FormEvent): Promise<void> => {
    e.preventDefault()
    if (!username.trim() || password.length < 8) {
      toast.error('用户名必填，密码至少 8 位')
      return
    }
    await createUser({ setupKey, username: username.trim(), password })
  }

  return (
    <Card title="首次设置" icon={<KeyRound className="h-4 w-4" />}>
      <p className="text-sm text-muted-foreground">
        Hub 还没有管理员账号。请使用下面的一次性 Setup Key 创建第一个管理员。
        创建后此 Key 会立即失效。
      </p>
      <div className="flex items-center gap-2 mt-3 mb-4">
        <code className="flex-1 px-3 py-2 bg-muted rounded text-sm font-mono select-all">
          {setupKey}
        </code>
        <CopyButton value={setupKey} />
      </div>
      <form onSubmit={onSubmit} className="space-y-3">
        <div>
          <label className="text-sm font-medium block mb-1">用户名</label>
          <Input
            value={username}
            onChange={(e) => setUsername(e.target.value)}
            disabled={loading}
            autoComplete="username"
            placeholder="例如 admin"
          />
        </div>
        <div>
          <label className="text-sm font-medium block mb-1">
            密码 <span className="text-muted-foreground">（≥ 8 位）</span>
          </label>
          <Input
            type="password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            disabled={loading}
            autoComplete="new-password"
          />
        </div>
        <Button type="submit" disabled={loading}>
          创建管理员
        </Button>
      </form>
    </Card>
  )
}

// ─── Hub switch ────────────────────────────────────────────────────────────

function HubSwitchCard({
  status,
  loading
}: {
  status: HubStatusSnapshot
  loading: boolean
}): React.JSX.Element {
  const start = useHubStore((s) => s.start)
  const stop = useHubStore((s) => s.stop)

  const url =
    status.enabled && status.port ? `http://${status.host ?? '127.0.0.1'}:${status.port}` : null

  return (
    <Card
      title="本机服务"
      icon={
        status.enabled ? (
          <Wifi className="h-4 w-4 text-green-500" />
        ) : (
          <WifiOff className="h-4 w-4 text-muted-foreground" />
        )
      }
      headerRight={
        <Switch
          checked={status.enabled}
          disabled={loading || !status.hasAdmin}
          onCheckedChange={(checked) => {
            if (checked) start()
            else stop()
          }}
        />
      }
    >
      {status.hasAdmin ? (
        <>
          {status.enabled && url ? (
            <div className="flex items-center gap-2 mt-1">
              <code className="flex-1 px-3 py-2 bg-muted rounded text-sm font-mono">
                {url}
              </code>
              <CopyButton value={url} />
              <QrButton value={url} label="同 Wi-Fi 下扫码" />
            </div>
          ) : (
            <p className="text-sm text-muted-foreground">
              开启后将在 {`http://127.0.0.1:8317`} 上监听本机请求。
            </p>
          )}
        </>
      ) : (
        <p className="text-sm text-muted-foreground">请先完成上方的首次设置。</p>
      )}
    </Card>
  )
}

// ─── Tunnel ────────────────────────────────────────────────────────────────

function TunnelCard({
  status,
  loading
}: {
  status: HubStatusSnapshot
  loading: boolean
}): React.JSX.Element {
  const startTunnel = useHubStore((s) => s.startTunnel)
  const stopTunnel = useHubStore((s) => s.stopTunnel)

  const tunnelEnabled = status.tunnel.state === 'running' || status.tunnel.state === 'starting'
  const tunnelUrl = status.tunnel.state === 'running' ? status.tunnel.url : null

  return (
    <Card
      title="公网访问 (Cloudflare 隧道)"
      icon={<Globe className="h-4 w-4" />}
      headerRight={
        <Switch
          checked={tunnelEnabled}
          disabled={loading || !status.enabled}
          onCheckedChange={(checked) => {
            if (checked) startTunnel()
            else stopTunnel()
          }}
        />
      }
    >
      {!status.enabled && (
        <p className="text-sm text-muted-foreground">请先开启本机服务。</p>
      )}
      {status.enabled && (
        <>
          <TunnelStatusLine tunnel={status.tunnel} host={status.host} port={status.port} />
          {tunnelUrl && (
            <div className="flex items-center gap-2 mt-3">
              <code className="flex-1 px-3 py-2 bg-muted rounded text-sm font-mono break-all">
                {tunnelUrl}
              </code>
              <CopyButton value={tunnelUrl} />
              <QrButton value={tunnelUrl} label="任意网络扫码" />
            </div>
          )}
          <p className="text-xs text-amber-500 mt-3">
            ⚠ 公网 URL 任何人拿到都可以尝试登录。强烈建议切换到 Cloudflare Access
            鉴权模式，并配置邮箱白名单。
          </p>
        </>
      )}
    </Card>
  )
}

function getTunnelErrorDetails(
  status: Extract<HubTunnelStatus, { state: 'error' }>,
  host: string | null,
  port: number | null
): { summary: string; hint: string } {
  const origin = host && port ? `http://${host.includes(':') ? `[${host}]` : host}:${port}` : null
  const message = status.message

  if (message.includes('binary not found')) {
    return {
      summary: '未找到 cloudflared 可执行文件',
      hint: '当前系统里没有可用的 cloudflared，需先安装或确认应用已正确打包该二进制。'
    }
  }

  if (message.includes('hub server not running')) {
    return {
      summary: '本机 Hub 服务尚未启动',
      hint: '请先打开上方“本机服务”，再开启公网访问。'
    }
  }

  if (message.includes('cloudflared exited')) {
    return {
      summary: 'Cloudflare 隧道已启动，但无法稳定连到本地 Hub',
      hint: origin
        ? `Cloudflare 尝试连接本地 origin ${origin} 失败或连接后异常退出。请确认本机服务仍在运行；如果刚升级版本，先关闭再重新开启公网访问。`
        : 'Cloudflare 隧道启动后无法稳定连到本地 Hub。请确认本机服务仍在运行，并尝试关闭后重新开启公网访问。'
    }
  }

  return {
    summary: 'Cloudflare 隧道启动失败',
    hint: origin
      ? `请检查本地 origin ${origin} 是否可访问，并重试开启公网访问。`
      : '请检查本机 Hub 服务是否可用，并重试开启公网访问。'
  }
}

function TunnelStatusLine({
  tunnel,
  host,
  port
}: {
  tunnel: HubTunnelStatus
  host: string | null
  port: number | null
}): React.JSX.Element {
  switch (tunnel.state) {
    case 'stopped':
      return <p className="text-sm text-muted-foreground">未开启</p>
    case 'starting':
      return <p className="text-sm text-amber-500">正在连接 Cloudflare …</p>
    case 'running':
      return <p className="text-sm text-green-500">已连接</p>
    case 'error': {
      const details = getTunnelErrorDetails(tunnel, host, port)
      return (
        <div className="mt-1 rounded-xl border border-red-500/25 bg-red-500/8 px-3.5 py-3 text-sm">
          <p className="font-medium text-red-500">{details.summary}</p>
          <p className="mt-1 leading-6 text-red-500/90">{details.hint}</p>
          <p className="mt-2 text-xs text-red-500/75">原始错误：{tunnel.message}</p>
        </div>
      )
    }
  }
}

// ─── Auth mode ─────────────────────────────────────────────────────────────

function AuthModeCard({
  currentMode,
  emails,
  loading
}: {
  currentMode: HubAuthMode
  emails: string[]
  loading: boolean
}): React.JSX.Element {
  const setAuthMode = useHubStore((s) => s.setAuthMode)
  const setCfAccessEmails = useHubStore((s) => s.setCfAccessEmails)
  const [draftEmails, setDraftEmails] = useState(emails.join('\n'))

  useEffect(() => {
    setDraftEmails(emails.join('\n'))
  }, [emails])

  return (
    <Card title="鉴权模式" icon={<ShieldCheck className="h-4 w-4" />}>
      <div className="space-y-2">
        {AUTH_MODE_OPTIONS.map((opt) => (
          <button
            key={opt.value}
            type="button"
            disabled={loading}
            onClick={() => setAuthMode(opt.value)}
            className={cn(
              'w-full text-left px-3 py-2 rounded-md border transition-colors',
              currentMode === opt.value
                ? 'border-primary bg-primary/5'
                : 'border-border hover:bg-accent/50'
            )}
          >
            <div className="flex items-center gap-2">
              <span
                className={cn(
                  'h-3 w-3 rounded-full border',
                  currentMode === opt.value
                    ? 'bg-primary border-primary'
                    : 'border-muted-foreground'
                )}
              />
              <span className="text-sm font-medium">{opt.label}</span>
            </div>
            <p className="text-xs text-muted-foreground mt-1 ml-5">{opt.description}</p>
          </button>
        ))}
      </div>

      {(currentMode === 'cf_access' || currentMode === 'hybrid') && (
        <div className="mt-4 space-y-2">
          <label className="text-sm font-medium block">允许的邮箱（每行一个）</label>
          <Textarea
            value={draftEmails}
            onChange={(e) => setDraftEmails(e.target.value)}
            disabled={loading}
            rows={4}
            placeholder="alice@example.com"
            className="font-mono text-xs"
          />
          <div className="flex items-center gap-3">
            <Button
              size="sm"
              disabled={loading}
              onClick={() => {
                const list = draftEmails
                  .split(/[\n,]/)
                  .map((s) => s.trim())
                  .filter(Boolean)
                setCfAccessEmails(list)
              }}
            >
              保存白名单
            </Button>
            <a
              href="https://developers.cloudflare.com/cloudflare-one/applications/configure-apps/self-hosted-public-app/"
              target="_blank"
              rel="noreferrer"
              className="text-xs text-primary underline"
            >
              如何配置 Cloudflare Access?
            </a>
          </div>
        </div>
      )}
    </Card>
  )
}

// ─── Security ──────────────────────────────────────────────────────────────

function SecurityCard({
  status,
  loading
}: {
  status: HubStatusSnapshot
  loading: boolean
}): React.JSX.Element {
  const setRequireDesktopConfirm = useHubStore((s) => s.setRequireDesktopConfirm)
  const changePassword = useHubStore((s) => s.changePassword)
  const [username, setUsername] = useState('')
  const [oldPassword, setOldPassword] = useState('')
  const [newPassword, setNewPassword] = useState('')

  // Tunnel-open nudges the switch ON by default for safety, but we don't
  // hard-lock it — if the user is actually using remote control from their
  // phone, forcing them to walk back to the desktop for every message
  // defeats the purpose. Keep a visible warning instead.
  const tunnelOpen = status.tunnel.state === 'running' || status.tunnel.state === 'starting'

  const onSubmit = async (e: FormEvent): Promise<void> => {
    e.preventDefault()
    if (!username.trim() || newPassword.length < 8) {
      toast.error('用户名必填，新密码至少 8 位')
      return
    }
    const result = await changePassword({
      username: username.trim(),
      oldPassword,
      newPassword
    })
    if (result.success) {
      setOldPassword('')
      setNewPassword('')
    }
  }

  return (
    <Card title="安全" icon={<ShieldCheck className="h-4 w-4" />}>
      <div className="flex items-start justify-between gap-4">
        <div>
          <p className="text-sm font-medium">手机端 prompt 需桌面端二次确认</p>
          <p className="text-xs text-muted-foreground mt-1">
            收到手机端发起的 prompt 时，桌面端会弹出 Toast 让你批准。
            {tunnelOpen && !status.requireDesktopConfirm && (
              <span className="text-amber-500">
                {' '}公网已开启且二次确认关闭——任何拿到隧道 URL 并登录成功的人都能直接驱动 agent，务必配合鉴权模式（Cloudflare Access 或强密码）。
              </span>
            )}
            {tunnelOpen && status.requireDesktopConfirm && (
              <span className="text-amber-500"> 公网开启时建议保持开启。</span>
            )}
          </p>
        </div>
        <Switch
          checked={status.requireDesktopConfirm}
          disabled={loading}
          onCheckedChange={(checked) => setRequireDesktopConfirm(checked)}
        />
      </div>

      <div className="border-t border-border my-4" />

      <p className="text-sm font-medium mb-2">修改密码</p>
      <form onSubmit={onSubmit} className="space-y-2">
        <Input
          placeholder="用户名"
          value={username}
          onChange={(e) => setUsername(e.target.value)}
          autoComplete="username"
          disabled={loading}
        />
        <Input
          type="password"
          placeholder="原密码"
          value={oldPassword}
          onChange={(e) => setOldPassword(e.target.value)}
          autoComplete="current-password"
          disabled={loading}
        />
        <Input
          type="password"
          placeholder="新密码（≥ 8 位）"
          value={newPassword}
          onChange={(e) => setNewPassword(e.target.value)}
          autoComplete="new-password"
          disabled={loading}
        />
        <Button type="submit" size="sm" disabled={loading}>
          修改密码
        </Button>
      </form>
    </Card>
  )
}

// ─── Building blocks ───────────────────────────────────────────────────────

function Card({
  title,
  icon,
  headerRight,
  children
}: {
  title: string
  icon?: React.ReactNode
  headerRight?: React.ReactNode
  children: React.ReactNode
}): React.JSX.Element {
  return (
    <section className="rounded-lg border border-border bg-card p-4">
      <div className="flex items-center justify-between mb-3">
        <h3 className="text-sm font-semibold flex items-center gap-2">
          {icon}
          {title}
        </h3>
        {headerRight}
      </div>
      {children}
    </section>
  )
}

function CopyButton({ value }: { value: string }): React.JSX.Element {
  const [copied, setCopied] = useState(false)
  return (
    <Button
      type="button"
      size="icon"
      variant="ghost"
      onClick={async () => {
        try {
          await navigator.clipboard.writeText(value)
          setCopied(true)
          setTimeout(() => setCopied(false), 1500)
        } catch {
          toast.error('复制失败')
        }
      }}
      title={copied ? '已复制' : '复制'}
    >
      <Copy className={cn('h-3.5 w-3.5', copied && 'text-green-500')} />
    </Button>
  )
}

function QrButton({ value, label }: { value: string; label?: string }): React.JSX.Element {
  return (
    <Popover>
      <PopoverTrigger asChild>
        <Button type="button" size="icon" variant="ghost" title="扫码访问">
          <QrCode className="h-3.5 w-3.5" />
        </Button>
      </PopoverTrigger>
      <PopoverContent align="end" className="w-auto p-3">
        <div className="flex flex-col items-center gap-2">
          <div className="rounded-md bg-white p-3">
            <QRCodeSVG value={value} size={192} level="M" includeMargin={false} />
          </div>
          <p className="max-w-[12rem] break-all text-center text-[11px] text-muted-foreground font-mono">
            {value}
          </p>
          {label ? (
            <p className="text-[11px] text-muted-foreground">{label}</p>
          ) : null}
        </div>
      </PopoverContent>
    </Popover>
  )
}
