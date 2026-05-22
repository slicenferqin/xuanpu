import './styles/globals.css'
import React from 'react'
import ReactDOM from 'react-dom/client'
import App from './App'
import { applyTypographySettings } from '@/lib/font-size'

// Apply persisted typography settings from localStorage before first paint to avoid flash.
// (Zoom is already applied in preload via webFrame.setZoomFactor.)
try {
  const stored = localStorage.getItem('hive-settings')
  if (stored) {
    const parsed = JSON.parse(stored)
    applyTypographySettings({
      uiFontScale: parsed?.state?.uiFontScale,
      uiFontFamily: parsed?.state?.uiFontFamily,
      uiCustomFontFamily: parsed?.state?.uiCustomFontFamily,
      uiFontWeight: parsed?.state?.uiFontWeight
    })
  }
} catch {
  // Ignore — default typography will be used
}

ReactDOM.createRoot(document.getElementById('root') as HTMLElement).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>
)
