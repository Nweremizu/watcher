// Forced states: browsers can't fake :hover from script, so Watcher copies every rule that uses a state
// with the pseudo-class swapped for [data-wforce~="hover"], then sets that attribute on the element.

// a state pseudo-class, but not an escaped Tailwind class name (`hover\:x`) or a media feature (`(hover:hover)`)
const STATE_RE = /(?<!\\)(?<!\((?:any-)?hover\s*):(hover|active|focus-visible|focus-within|focus)(?![\w-])/g

export const hasState = (css: string) => /:(hover|active|focus)/.test(css)
export const forceSelectors = (css: string) => css.replace(STATE_RE, (_, s: string) => `[data-wforce~="${s}"]`)
/** The same selector with real states made impossible: `:hover` never matches, so `:not(:hover)` always does. Lets Watcher
 *  read an element's resting look even while the pointer is over it. */
export const muteSelectors = (sel: string) => sel.replace(STATE_RE, ':not(*)')
