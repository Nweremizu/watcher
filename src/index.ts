/**
 * watcher-ui: open your running React app like a design file.
 *
 *   import { Watcher } from 'watcher-ui'
 *   <Watcher />
 *
 * Cost to your app:
 * - production builds resolve this package to ./noop (the "production" export condition), so none of
 *   the overlay ships; the NODE_ENV check below is a second line of defence for bundlers without conditions.
 * - in development this entry is ~1 kB. The overlay is a separate chunk fetched when the browser is idle,
 *   so it never competes with your first render (or right away if it was open before a reload).
 * - while closed it renders one button; while open it re-renders only when something it draws moved.
 */
import { useEffect } from 'react'

declare const process: { env: { NODE_ENV?: string } }
const isProd = (() => { try { return process.env.NODE_ENV === 'production' } catch { return false } })()

const later = (fn: () => void) => {
  if ('requestIdleCallback' in window) { const id = requestIdleCallback(fn, { timeout: 3000 }); return () => cancelIdleCallback(id) }
  const id = setTimeout(fn, 200)
  return () => clearTimeout(id)
}

let unmount: (() => void) | null = null
let users = 0

export type WatcherOptions = {
  /** URL of a Timeless Sans woff2 served by your app, used for Watcher's UI. Optional; never bundled. */
  font?: string
  /**
   * Turn Watcher off (false) or on (true). Default: on in development. Production builds don't contain
   * Watcher at all, so `true` can't turn it on there. The WATCHER env var (via watcher-ui/vite) overrides this.
   */
  enabled?: boolean
  /** Keys that open and close Watcher, e.g. "Alt+D" (default), "Mod+Shift+K", "F2". See the README for the format. */
  shortcut?: string
}
/** Set by watcher-ui/vite from the WATCHER and WATCHER_SHORTCUT env vars: one developer's override, without touching shared code. */
const envConfig = (): Pick<WatcherOptions, 'enabled' | 'shortcut'> => (window as unknown as { __WATCHER__?: WatcherOptions }).__WATCHER__ ?? {}

/** Load and mount Watcher without React components (or from any framework). Returns a cleanup function. */
export function mountWatcher(options: WatcherOptions = {}): () => void {
  // inside a responsive preview frame (window.name 'watcher-viewport') this mounts the overlay's frame mode
  if (isProd || typeof window === 'undefined') return () => {}
  const env = envConfig()
  if (!(env.enabled ?? options.enabled ?? true)) return () => {}
  options = { ...options, shortcut: env.shortcut ?? options.shortcut }
  users++
  let cancelled = false
  const load = () => { void import('./overlay').then(m => { if (!cancelled && !unmount) unmount = m.mount(options) }) }
  const wasOpen = (() => { try { return sessionStorage.getItem('watcher') === '1' } catch { return false } })()
  const cancel = wasOpen ? (load(), () => {}) : later(load)
  return () => {
    cancelled = true
    cancel()
    if (--users === 0) { unmount?.(); unmount = null }
  }
}

/** Drop it anywhere in your tree. Renders nothing itself; Alt+D (or your `shortcut`) toggles the overlay. */
export function Watcher({ font, enabled, shortcut }: WatcherOptions = {}): null {
  useEffect(() => mountWatcher({ font, enabled, shortcut }), [font, enabled, shortcut])
  return null
}

export default Watcher
