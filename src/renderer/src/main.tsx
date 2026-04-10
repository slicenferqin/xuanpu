import './styles/globals.css'
import React from 'react'
import ReactDOM from 'react-dom/client'
import App from './App'
import { applyFontScale } from '@/lib/font-size'

// Apply persisted font scale from localStorage before first paint to avoid flash.
// (Zoom is already applied in preload via webFrame.setZoomFactor.)
try {
  const stored = localStorage.getItem('hive-settings')
  if (stored) {
    const parsed = JSON.parse(stored)
    const scale = parsed?.state?.uiFontScale
    if (typeof scale === 'number' && scale !== 1) {
      applyFontScale(scale)
    }
  }
} catch {
  // Ignore — default font sizes will be used
}

ReactDOM.createRoot(document.getElementById('root') as HTMLElement).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>
)
