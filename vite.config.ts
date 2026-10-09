// Demo app: `npm run dev`. It imports `watcher-ui` from src/, exactly as a consumer would.
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'
import { watcher } from './src/vite.ts'

const { version } = JSON.parse(readFileSync(new URL('./package.json', import.meta.url), 'utf8'))

export default defineConfig({
  root: 'demo',
  publicDir: '../assets',
  plugins: [watcher(), react(), tailwindcss()],
  define: { __VERSION__: JSON.stringify(version) },
  resolve: { alias: { 'watcher-ui': fileURLToPath(new URL('./src/index.ts', import.meta.url)) } },
  server: { port: 5179 },
})
