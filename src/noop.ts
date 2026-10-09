// What production builds resolve `watcher-ui` to (package.json "production" export condition): nothing.
export const Watcher = (_?: { font?: string }): null => null
export const mountWatcher = (_?: { font?: string }): (() => void) => () => {}
export default Watcher
