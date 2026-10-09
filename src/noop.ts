// What production builds resolve `watcher-ui` to (package.json "production" export condition): nothing.
export const Watcher = (): null => null
export const mountWatcher = (): (() => void) => () => {}
export default Watcher
