import { useEffect } from 'react'
import { Routes, Route, Navigate, useNavigate, useLocation } from 'react-router-dom'
import { Login } from './routes/Login'
import { Devices } from './routes/Devices'
import { Sessions } from './routes/Sessions'
import { SessionDetail } from './routes/SessionDetail'
import { useAuth } from './stores/useAuth'

export function App(): React.JSX.Element {
  const { authed, checking, refresh } = useAuth()
  const navigate = useNavigate()
  const location = useLocation()

  // Bootstrap: poke /api/me on mount so we know whether to show /login.
  useEffect(() => {
    refresh()
  }, [refresh])

  // Redirect unauthenticated users to /login (except when already there).
  useEffect(() => {
    if (checking) return
    if (!authed && location.pathname !== '/login') {
      navigate('/login', { replace: true })
    } else if (authed && location.pathname === '/login') {
      navigate('/devices', { replace: true })
    }
  }, [authed, checking, location.pathname, navigate])

  return (
    <Routes>
      <Route path="/login" element={<Login />} />
      <Route path="/devices" element={<Devices />} />
      <Route path="/sessions/:deviceId" element={<Sessions />} />
      <Route path="/session/:deviceId/:hiveId" element={<SessionDetail />} />
      <Route path="*" element={<Navigate to="/devices" replace />} />
    </Routes>
  )
}
