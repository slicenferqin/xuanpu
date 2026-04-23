import { useState, type FormEvent } from 'react'
import { useNavigate } from 'react-router-dom'
import { useAuth } from '../stores/useAuth'
import { getApiBase, setApiBase } from '../api/client'

export function Login(): React.JSX.Element {
  const { login, error } = useAuth()
  const navigate = useNavigate()
  const [username, setUsername] = useState('')
  const [password, setPassword] = useState('')
  const [submitting, setSubmitting] = useState(false)
  const [showAdvanced, setShowAdvanced] = useState(false)
  const [apiBaseDraft, setApiBaseDraft] = useState(getApiBase())

  const onSubmit = async (e: FormEvent): Promise<void> => {
    e.preventDefault()
    if (!username.trim() || !password) return
    setSubmitting(true)
    const ok = await login(username.trim(), password)
    setSubmitting(false)
    if (ok) navigate('/devices', { replace: true })
  }

  const saveApiBase = (): void => {
    const v = apiBaseDraft.trim().replace(/\/+$/, '')
    if (v) {
      setApiBase(v)
      setShowAdvanced(false)
    }
  }

  return (
    <div className="flex flex-col items-center justify-center min-h-dvh px-6 safe-pad-top safe-pad-bottom">
      <div className="w-full max-w-sm">
        <div className="flex items-center gap-3 mb-6">
          <div className="h-10 w-10 rounded-lg bg-zinc-800 flex items-center justify-center text-lg font-semibold">
            玄
          </div>
          <div>
            <h1 className="text-2xl font-semibold leading-none">Xuanpu</h1>
            <p className="text-sm text-zinc-400 mt-1">Hub 远程访问</p>
          </div>
        </div>

        <form onSubmit={onSubmit} className="space-y-3">
          <label className="block">
            <span className="sr-only">用户名</span>
            <input
              type="text"
              placeholder="用户名"
              value={username}
              onChange={(e) => setUsername(e.target.value)}
              autoComplete="username"
              autoCapitalize="none"
              autoCorrect="off"
              className="w-full px-3 py-3 rounded-lg bg-zinc-900 border border-zinc-800 text-base focus:outline-none focus:border-zinc-600"
            />
          </label>
          <label className="block">
            <span className="sr-only">密码</span>
            <input
              type="password"
              placeholder="密码"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              autoComplete="current-password"
              className="w-full px-3 py-3 rounded-lg bg-zinc-900 border border-zinc-800 text-base focus:outline-none focus:border-zinc-600"
            />
          </label>
          {error && (
            <p className="text-sm text-red-400 px-1" role="alert">
              {error}
            </p>
          )}
          <button
            type="submit"
            disabled={submitting || !username.trim() || !password}
            className="w-full py-3 rounded-lg bg-zinc-100 text-zinc-900 font-medium disabled:opacity-50 active:bg-zinc-200"
          >
            {submitting ? '登录中…' : '登录'}
          </button>
        </form>

        <div className="mt-6 text-center">
          <button
            type="button"
            onClick={() => setShowAdvanced((v) => !v)}
            className="text-xs text-zinc-500 hover:text-zinc-300"
          >
            {showAdvanced ? '收起高级设置' : '高级设置'}
          </button>
        </div>

        {showAdvanced && (
          <div className="mt-4 p-3 rounded-lg bg-zinc-900 border border-zinc-800 space-y-2">
            <label className="block">
              <span className="text-xs text-zinc-400">Hub API 地址</span>
              <input
                type="url"
                value={apiBaseDraft}
                onChange={(e) => setApiBaseDraft(e.target.value)}
                placeholder="https://xxx.trycloudflare.com"
                className="w-full mt-1 px-2 py-2 rounded bg-zinc-950 border border-zinc-800 text-sm font-mono"
              />
            </label>
            <button
              type="button"
              onClick={saveApiBase}
              className="w-full py-2 rounded bg-zinc-800 text-zinc-200 text-sm"
            >
              保存并刷新
            </button>
            <p className="text-xs text-zinc-500">
              保存后本地持久化，无需每次在 URL 加 <code>?api=</code>。
            </p>
          </div>
        )}
      </div>
    </div>
  )
}
