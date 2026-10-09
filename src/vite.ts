/// <reference types="node" />
// watcher-ui/vite: lets Watcher write inspector edits back to your JSX as Tailwind classes. Dev server only.
//
//   import { watcher } from 'watcher-ui/vite'
//   export default defineConfig({ plugins: [watcher(), react(), tailwindcss()] })
import { existsSync, readdirSync, readFileSync, writeFileSync } from 'node:fs'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { dirname, isAbsolute, relative, resolve, sep } from 'node:path'
import { loadEnv, type Plugin } from 'vite'
import { editSource, stampSource, type ElementEdit } from './writeback.ts'
import { editKeyframes, setThemeVar } from './cssedit.ts'

type TwVersion = 3 | 4
export type WatcherPluginOptions = { /** Tailwind major version; detected from package.json when omitted. */ tailwind?: TwVersion }
/** WATCHER=false turns Watcher off, WATCHER_SHORTCUT sets its keys. From the shell or any .env file. */
function envConfig(mode: string, dir: string) {
  const env = loadEnv(mode, dir, 'WATCHER')
  const out: { enabled?: boolean; shortcut?: string } = {}
  const flag = env.WATCHER?.trim().toLowerCase()
  if (flag) out.enabled = !/^(0|false|off|no)$/.test(flag)
  if (env.WATCHER_SHORTCUT?.trim()) out.shortcut = env.WATCHER_SHORTCUT.trim()
  return out
}

/** Which Motion package the app uses, as the path to import `motion` from. */
function detectMotion(from: string): string | null {
  for (let dir = from; ; dir = dirname(dir)) {
    const pkg = resolve(dir, 'package.json')
    if (existsSync(pkg)) {
      const j = JSON.parse(readFileSync(pkg, 'utf8')), deps = { ...j.dependencies, ...j.devDependencies }
      return deps.motion ? 'motion/react' : deps['framer-motion'] ? 'framer-motion' : null
    }
    if (dirname(dir) === dir) return null
  }
}
/** The stylesheet that holds the Tailwind theme: one with an @theme block, else one importing tailwindcss. */
function themeFile(root: string): string | null {
  const found: { file: string; theme: boolean }[] = []
  const scan = (dir: string, depth: number) => {
    if (depth > 4 || found.length > 50) return
    for (const d of readdirSync(dir, { withFileTypes: true })) {
      if (d.name.startsWith('.') || d.name === 'node_modules' || d.name === 'dist' || d.name === 'build') continue
      const p = resolve(dir, d.name)
      if (d.isDirectory()) scan(p, depth + 1)
      else if (d.name.endsWith('.css')) { const t = readFileSync(p, 'utf8'); if (/@theme\b|@import\s+["']tailwindcss/.test(t)) found.push({ file: p, theme: /@theme\b/.test(t) }) }
    }
  }
  scan(root, 0)
  return (found.find(f => f.theme) ?? found[0])?.file ?? null
}
/** Inside the project (no ../ escapes) and of the right kind. */
const editable = (abs: string, ext: RegExp) => { const rel = relative(process.cwd(), abs); return ext.test(abs) && !rel.startsWith('..') && !isAbsolute(rel) && existsSync(abs) }

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

// React hands its renderer (which can override a component's props) only to a DevTools hook that exists
// before React loads. Installed unless the React DevTools extension already put one there.
const DEVTOOLS_HOOK = `if(!window.__REACT_DEVTOOLS_GLOBAL_HOOK__){var r=new Map(),n=0,f=function(){};` +
  `window.__REACT_DEVTOOLS_GLOBAL_HOOK__={renderers:r,supportsFiber:true,inject:function(i){r.set(++n,i);return n},` +
  `onScheduleFiberRoot:f,onCommitFiberRoot:f,onCommitFiberUnmount:f,onPostCommitFiberRoot:f,checkDCE:f}}`

export function watcher(opts: WatcherPluginOptions = {}): Plugin {
  let root = process.cwd()
  let ver: TwVersion = 4
  let cfg: { enabled?: boolean; shortcut?: string } = {}
  let motion: string | null = null
  return {
    name: 'watcher-ui',
    apply: 'serve',
    enforce: 'pre', // stamp the JSX before React's transform turns it into calls
    transformIndexHtml: () => [{
      tag: 'script', injectTo: 'head-prepend',
      children: DEVTOOLS_HOOK + (Object.keys(cfg).length ? `;window.__WATCHER__=${JSON.stringify(cfg).replace(/</g, '\\u003c')}` : ''),
    }],
    configResolved(c) {
      root = c.root
      ver = opts.tailwind ?? detectTailwind(root)
      motion = detectMotion(root)
      cfg = envConfig(c.mode, typeof c.envDir === 'string' ? c.envDir : root)
    },
    transform(code, id) {
      const file = id.split('?')[0]
      if (!/\.[jt]sx$/.test(file) || file.includes(`${sep}node_modules${sep}`) || file.includes('/node_modules/')) return
      const ms = stampSource(code, relative(root, file).split(sep).join('/'))
      return ms ? { code: ms.toString(), map: ms.generateMap({ hires: true, source: file }) } : undefined
    },
    configureServer(server) {
      server.middlewares.use('/__watcher', async (req, res) => {
        if (req.method === 'GET' && req.url === '/ping') {
          const theme = themeFile(root)
          return send(res, 200, { ok: true, tailwind: ver, motion, theme: theme && relative(root, theme).split(sep).join('/') })
        }
        if (req.method !== 'POST' || (req.url !== '/apply' && req.url !== '/css')) return send(res, 404, { error: 'not found' })
        // it writes files: only same-origin requests carrying our header (blocks cross-site POSTs to localhost)
        const origin = req.headers.origin
        if (req.headers['x-watcher'] !== '1' || (origin && new URL(origin).host !== req.headers.host)) return send(res, 403, { error: 'forbidden' })
        if (req.url === '/css') {
          // keyframe declarations in the stylesheet a rule came from, and variables in the theme file
          type CssEdit = { kind: 'keyframes'; file: string; name: string; offset: string; prop: string; value: string | null } | { kind: 'theme'; name: string; value: string }
          try {
            const { edits, dryRun } = JSON.parse(await body(req)) as { edits: CssEdit[]; dryRun?: boolean }
            const texts = new Map<string, { before: string; now: string }>()
            const results = edits.map(e => {
              const abs = e.kind === 'theme' ? themeFile(root) : resolve(root, e.file)
              if (!abs || !editable(abs, /\.css$/)) return { ok: false, error: e.kind === 'theme' ? 'no stylesheet with a Tailwind @theme or tailwindcss import found' : 'not an editable stylesheet' }
              const t = texts.get(abs) ?? { before: readFileSync(abs, 'utf8'), now: '' }
              const cur = t.now || t.before
              if (e.kind === 'theme') t.now = setThemeVar(cur, e.name, e.value)
              else { const r = editKeyframes(cur, e.name, e.offset, e.prop, e.value); if ('error' in r) return { ok: false, error: r.error }; t.now = r.css }
              texts.set(abs, t)
              return { ok: true, file: relative(root, abs).split(sep).join('/') }
            })
            if (!dryRun) for (const [abs, t] of texts) if (t.now && t.now !== t.before) writeFileSync(abs, t.now)
            return send(res, 200, { results })
          } catch (err) { return send(res, 400, { error: String((err as Error).message ?? err) }) }
        }
        try {
          const { edits, dryRun } = JSON.parse(await body(req)) as { edits: (ElementEdit & { file: string })[]; dryRun?: boolean }
          const byFile = new Map<string, ElementEdit[]>()
          for (const e of edits) byFile.set(e.file, [...(byFile.get(e.file) ?? []), e])
          const files = []
          for (const [file, list] of byFile) {
            const abs = resolve(root, file)
            if (!editable(abs, /\.[jt]sx$/)) { // stay inside the project, and only JSX sources
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
