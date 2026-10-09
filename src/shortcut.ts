// Keyboard shortcuts written as text: "Alt+D", "Mod+Shift+K", "Ctrl+.", "F2".
// Matched on the physical key (KeyboardEvent.code), so they work on every keyboard layout, and on macOS
// where Option changes the character (⌥D types ∂).

export type Shortcut = { ctrl: boolean; alt: boolean; shift: boolean; meta: boolean; code: string }
type Mod = 'ctrl' | 'alt' | 'shift' | 'meta' | 'mod'

export const DEFAULT_SHORTCUT = 'Alt+D'

const MODS: Record<string, Mod> = {
  ctrl: 'ctrl', control: 'ctrl', ctl: 'ctrl', alt: 'alt', option: 'alt', opt: 'alt', shift: 'shift',
  meta: 'meta', cmd: 'meta', command: 'meta', win: 'meta', windows: 'meta', super: 'meta', mod: 'mod',
}
// key name → KeyboardEvent.code (lower-case lookup)
const NAMED: Record<string, string> = {
  esc: 'Escape', escape: 'Escape', enter: 'Enter', return: 'Enter', space: 'Space', spacebar: 'Space', tab: 'Tab',
  backspace: 'Backspace', delete: 'Delete', del: 'Delete', insert: 'Insert', ins: 'Insert', home: 'Home', end: 'End',
  pageup: 'PageUp', pgup: 'PageUp', pagedown: 'PageDown', pgdn: 'PageDown',
  up: 'ArrowUp', down: 'ArrowDown', left: 'ArrowLeft', right: 'ArrowRight',
  '.': 'Period', period: 'Period', dot: 'Period', ',': 'Comma', comma: 'Comma', '/': 'Slash', slash: 'Slash',
  ';': 'Semicolon', semicolon: 'Semicolon', "'": 'Quote', quote: 'Quote', apostrophe: 'Quote',
  '[': 'BracketLeft', ']': 'BracketRight', '\\': 'Backslash', backslash: 'Backslash',
  '-': 'Minus', minus: 'Minus', dash: 'Minus', '=': 'Equal', equal: 'Equal', equals: 'Equal', plus: 'Equal',
  '`': 'Backquote', backquote: 'Backquote', backtick: 'Backquote', grave: 'Backquote', tilde: 'Backquote',
}
for (const code of Object.values(NAMED)) NAMED[code.toLowerCase()] = code // "BracketLeft", "ArrowUp"… work too
const SYMBOL: Record<string, string> = {
  Period: '.', Comma: ',', Slash: '/', Semicolon: ';', Quote: "'", BracketLeft: '[', BracketRight: ']', Backslash: '\\',
  Minus: '-', Equal: '=', Backquote: '`', ArrowUp: '↑', ArrowDown: '↓', ArrowLeft: '←', ArrowRight: '→',
}

export const isMac = () => typeof navigator !== 'undefined' && /Mac|iPhone|iPad/.test(navigator.platform || navigator.userAgent)

function keyCode(k: string) {
  const l = k.toLowerCase()
  if (/^[a-z]$/.test(l)) return 'Key' + l.toUpperCase()
  if (/^[0-9]$/.test(l)) return 'Digit' + l
  if (/^f([1-9]|1\d|2[0-4])$/.test(l)) return 'F' + l.slice(1)
  if (NAMED[l]) return NAMED[l]
  if (/^(Key[A-Z]|Digit\d|Numpad\w+)$/.test(k)) return k // raw KeyboardEvent.code values
  return ''
}

/** "Mod+Shift+K" → Shortcut, or null if it can't be read. Case and spaces don't matter; Mod is ⌘ on Mac, Ctrl elsewhere. */
export function parseShortcut(text: string, mac = isMac()): Shortcut | null {
  const parts = text.trim().replace(/\+\s*\+$/, '+Plus').split(/\s*\+\s*/) // "Ctrl++" means Ctrl+Plus
  if (!parts[0]) return null
  const s: Shortcut = { ctrl: false, alt: false, shift: false, meta: false, code: '' }
  for (const [i, part] of parts.entries()) {
    if (i < parts.length - 1) {
      const m = MODS[part.toLowerCase()]
      if (!m) return null
      s[m === 'mod' ? (mac ? 'meta' : 'ctrl') : m] = true
    } else if (!(s.code = keyCode(part))) return null
  }
  return s
}

export const matchesShortcut = (e: KeyboardEvent, s: Shortcut) =>
  e.code === s.code && e.ctrlKey === s.ctrl && e.altKey === s.alt && e.shiftKey === s.shift && e.metaKey === s.meta

export const shortcutFromEvent = (e: KeyboardEvent): Shortcut => ({ ctrl: e.ctrlKey, alt: e.altKey, shift: e.shiftKey, meta: e.metaKey, code: e.code })

const keyName = (code: string) => code.replace(/^(Key|Digit)/, '')

/** The text form, ready to paste into `shortcut="…"`: "Ctrl+Shift+K". */
export const stringifyShortcut = (s: Shortcut, mac = isMac()) =>
  [s.ctrl && 'Ctrl', s.alt && 'Alt', s.shift && 'Shift', s.meta && (mac ? 'Cmd' : 'Meta'), keyName(s.code)].filter(Boolean).join('+')

/** How to show it in the UI: "⌥⇧K" on Mac, "Alt+Shift+K" elsewhere. */
export function shortcutLabel(s: Shortcut, mac = isMac()) {
  const key = SYMBOL[s.code] ?? keyName(s.code)
  if (mac) return `${s.ctrl ? '⌃' : ''}${s.alt ? '⌥' : ''}${s.shift ? '⇧' : ''}${s.meta ? '⌘' : ''}${key}`
  return [s.ctrl && 'Ctrl', s.alt && 'Alt', s.shift && 'Shift', s.meta && 'Win', key].filter(Boolean).join('+')
}
