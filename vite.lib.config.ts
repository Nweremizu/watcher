// Library build: `npm run build` → dist/{index,noop}.js + one lazily-loaded overlay chunk.
import { readFileSync } from 'node:fs'
import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

const { version } = JSON.parse(readFileSync(new URL('./package.json', import.meta.url), 'utf8'))

export default defineConfig({
  plugins: [react()],
  define: { __VERSION__: JSON.stringify(version) },
  publicDir: false,
  build: {
    outDir: 'dist',
    emptyOutDir: true,
    sourcemap: true,
    target: 'es2022',
    minify: true,
    lib: { entry: { index: 'src/index.ts', noop: 'src/noop.ts' }, formats: ['es'] },
    rollupOptions: {
      external: [/^react($|\/)/, /^react-dom($|\/)/],
      output: { chunkFileNames: '[name]-[hash].js' },
    },
  },
})
