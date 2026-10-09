// What production builds resolve `watcher-ui` to (package.json "production" export condition): nothing.
import type { WatcherOptions } from './index'
export type { WatcherOptions }
export const Watcher = (_?: WatcherOptions): null => null
export const mountWatcher = (_?: WatcherOptions): (() => void) => () => {}
export default Watcher
