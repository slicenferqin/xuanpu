import { dirname, resolve } from 'path'
import { readFileSync } from 'fs'
import { defineConfig, externalizeDepsPlugin } from 'electron-vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'

function rawTextPlugin() {
  const prefix = '\0xuanpu-raw-text:'

  return {
    name: 'raw-text',
    enforce: 'pre' as const,
    resolveId(source: string, importer?: string) {
      if (!source.endsWith('.md') && !source.endsWith('.html')) return null
      const filePath =
        importer && !source.startsWith('/') ? resolve(dirname(importer), source) : source
      return `${prefix}${Buffer.from(filePath).toString('base64url')}`
    },
    load(id: string) {
      if (!id.startsWith(prefix)) return null
      const filePath = Buffer.from(id.slice(prefix.length), 'base64url').toString()
      return `export default ${JSON.stringify(readFileSync(filePath, 'utf8'))}`
    }
  }
}

export default defineConfig({
  main: {
    plugins: [
      externalizeDepsPlugin({
        exclude: ['@oh-my-pi/pi-agent-core', '@oh-my-pi/pi-ai', '@oh-my-pi/pi-utils']
      }),
      rawTextPlugin()
    ],
    resolve: {
      alias: {
        '@main': resolve('src/main'),
        '@shared': resolve('src/shared'),
        '@oh-my-pi/pi-natives': resolve('src/main/services/xuanpu-agent/pi-natives-compat.ts'),
        bun: resolve('src/main/services/xuanpu-agent/bun-compat.ts')
      }
    }
  },
  preload: {
    plugins: [externalizeDepsPlugin()],
    resolve: {
      alias: {
        '@preload': resolve('src/preload'),
        '@shared': resolve('src/shared')
      }
    }
  },
  renderer: {
    resolve: {
      alias: {
        '@': resolve('src/renderer/src'),
        '@shared': resolve('src/shared')
      }
    },
    plugins: [react(), tailwindcss()],
    build: {
      rollupOptions: {
        output: {
          manualChunks: {
            monaco: ['monaco-editor', '@monaco-editor/react'],
            markdown: ['react-markdown', 'remark-gfm'],
            vendor: ['zustand', '@tanstack/react-virtual', 'cmdk']
          }
        }
      }
    }
  }
})
