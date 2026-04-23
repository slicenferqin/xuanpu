import React from 'react'
import ReactDOM from 'react-dom/client'
import { BrowserRouter } from 'react-router-dom'
import { Toaster } from 'sonner'
import { App } from './App'
import './styles.css'

const root = document.getElementById('root')
if (!root) throw new Error('root element missing')

ReactDOM.createRoot(root).render(
  <React.StrictMode>
    <BrowserRouter>
      <App />
      <Toaster
        position="top-center"
        theme="dark"
        toastOptions={{ duration: 3000 }}
      />
    </BrowserRouter>
  </React.StrictMode>
)
