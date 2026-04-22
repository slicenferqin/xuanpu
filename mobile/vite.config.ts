import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'

// Mobile UI is a fully separate Vite app (NOT compiled by electron-vite).
// In dev, hub-server proxies / -> http://localhost:5173 via the resolve
// `getMobileDistRoot()` returning null; mobile devs run `pnpm -C mobile dev`
// and point their phone at `http://<laptop-ip>:5173?api=http://...:8317`.
//
// In production, electron-builder packs `mobile/dist` into resources/mobile-ui.
export default defineConfig({
  plugins: [react(), tailwindcss()],
  base: './',
  server: {
    host: '0.0.0.0',
    port: 5173,
    strictPort: true
  },
  build: {
    outDir: 'dist',
    emptyOutDir: true,
    sourcemap: true,
    target: 'es2020'
  }
})
