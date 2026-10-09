/// <reference types="node" />
// watcher-ui/vite: lets Watcher write inspector edits back to your JSX as Tailwind classes. Dev server only.
//
//   import { watcher } from 'watcher-ui/vite'
//   export default defineConfig({ plugins: [watcher(), react(), tailwindcss()] })
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { dirname, isAbsolute, relative, resolve, sep } from 'node:path'
import type { Plugin } from 'vite'
import { editSource, stampSource, type ElementEdit } from './writeback.ts'

type TwVersion = 3 | 4
export type WatcherPluginOptions = { /** Tailwind major version; detected from package.json when omitted. */ tailwind?: TwVersion }

/** Nearest package.json's tailwindcss version (4 if not found). */
function detectTailwind(from: string): TwVersion {
  for (let dir = from; ; dir = dirname(dir)) {
    const pkg = resolve(dir, 'package.json')
    if (existsSync(pkg)) {
      const j = JSON.parse(readFileSync(pkg, 'utf8'))
      const v = j.dependencies?.tailwindcss ?? j.devDependencies?.tailwindcss
      if (v) return /^[\^~]?3\./.test(v) ? 3 : 4
    }
    if (dirname(dir) === dir) return 4
  }
}
const body = (req: IncomingMessage) => new Promise<string>((ok, fail) => {
  let s = ''
  req.on('data', c => { s += c; if (s.length > 1e6) fail(new Error('body too large')) })
  req.on('end', () => ok(s)); req.on('error', fail)
})
const send = (res: ServerResponse, status: number, data: unknown) => {
  res.statusCode = status; res.setHeader('content-type', 'application/json'); res.end(JSON.stringify(data))
}

export function watcher(opts: WatcherPluginOptions = {}): Plugin {
  let root = process.cwd()
  let ver: TwVersion = 4
  return {
    name: 'watcher-ui',
    apply: 'serve',
    enforce: 'pre', // stamp the JSX before React's transform turns it into calls
    configResolved(c) { root = c.root; ver = opts.tailwind ?? detectTailwind(root) },
    transform(code, id) {
      const file = id.split('?')[0]
      if (!/\.[jt]sx$/.test(file) || file.includes(`${sep}node_modules${sep}`) || file.includes('/node_modules/')) return
      const ms = stampSource(code, relative(root, file).split(sep).join('/'))
      return ms ? { code: ms.toString(), map: ms.generateMap({ hires: true, source: file }) } : undefined
    },
    configureServer(server) {
      server.middlewares.use('/__watcher', async (req, res) => {
        if (req.method === 'GET' && req.url === '/ping') return send(res, 200, { ok: true, tailwind: ver })
        if (req.method !== 'POST' || req.url !== '/apply') return send(res, 404, { error: 'not found' })
        // it writes files: only same-origin requests carrying our header (blocks cross-site POSTs to localhost)
        const origin = req.headers.origin
        if (req.headers['x-watcher'] !== '1' || (origin && new URL(origin).host !== req.headers.host)) return send(res, 403, { error: 'forbidden' })
        try {
          const { edits, dryRun } = JSON.parse(await body(req)) as { edits: (ElementEdit & { file: string })[]; dryRun?: boolean }
          const byFile = new Map<string, ElementEdit[]>()
          for (const e of edits) byFile.set(e.file, [...(byFile.get(e.file) ?? []), e])
          const files = []
          for (const [file, list] of byFile) {
            const abs = resolve(root, file), rel = relative(process.cwd(), abs)
            // stay inside the project, and only JSX sources
            if (!/\.[jt]sx$/.test(abs) || rel.startsWith('..') || isAbsolute(rel) || !existsSync(abs)) {
              files.push({ file, changed: false, results: list.map(e => ({ loc: e.loc, ok: false, error: 'not an editable source file', mapped: [], skipped: [] })) })
              continue
            }
            const src = readFileSync(abs, 'utf8')
            const out = editSource(src, list, ver)
            const changed = out.code !== src
            if (changed && !dryRun) writeFileSync(abs, out.code)
            files.push({ file, changed, results: out.results })
          }
          send(res, 200, { files, tailwind: ver })
        } catch (err) {
          send(res, 400, { error: String((err as Error).message ?? err) })
        }
      })
    },
  }
}
export default watcher
