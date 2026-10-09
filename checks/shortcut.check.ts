// node checks/shortcut.check.ts: shortcut strings are hand-written by users, so the parser gets a runnable check.
import assert from 'node:assert/strict'
import { matchesShortcut, parseShortcut, shortcutLabel, stringifyShortcut } from '../src/shortcut.ts'

const p = (s: string, mac = false) => parseShortcut(s, mac)
const key = (code: string, m: Partial<Record<'ctrlKey' | 'altKey' | 'shiftKey' | 'metaKey', boolean>> = {}) =>
  ({ code, ctrlKey: false, altKey: false, shiftKey: false, metaKey: false, ...m }) as KeyboardEvent

assert.deepEqual(p('Alt+D'), { ctrl: false, alt: true, shift: false, meta: false, code: 'KeyD' })
// forgiving spelling: case, spaces, aliases
assert.deepEqual(p(' alt + d '), p('Alt+D'))
assert.deepEqual(p('Option+D'), p('Alt+D'))
assert.deepEqual(p('control+shift+k'), p('Ctrl+Shift+K'))
assert.deepEqual(p('Cmd+K'), p('Meta+K'))
// Mod is Cmd on Mac, Ctrl elsewhere
assert.equal(p('Mod+K')!.ctrl, true)
assert.equal(p('Mod+K', true)!.meta, true)
// function keys, digits, named keys and punctuation
assert.equal(p('F2')!.code, 'F2')
assert.equal(p('shift+f12')!.code, 'F12')
assert.equal(p('Ctrl+1')!.code, 'Digit1')
assert.equal(p('Ctrl+.')!.code, 'Period')
assert.equal(p('Ctrl+Period')!.code, 'Period')
assert.equal(p('Alt+`')!.code, 'Backquote')
assert.equal(p('Ctrl+Space')!.code, 'Space')
assert.equal(p('Ctrl+Esc')!.code, 'Escape')
assert.equal(p('Ctrl++')!.code, 'Equal')
assert.equal(p('Alt+BracketLeft')!.code, 'BracketLeft')
assert.equal(p('Ctrl+Numpad0')!.code, 'Numpad0')
// unreadable
for (const bad of ['', 'Alt+', 'Ctrl+Shift', 'Hyper+D', 'Alt+DD', 'F25']) assert.equal(p(bad), null, bad)

// matching is exact on modifiers and uses the physical key
assert.ok(matchesShortcut(key('KeyD', { altKey: true }), p('Alt+D')!))
assert.ok(!matchesShortcut(key('KeyD', { altKey: true, shiftKey: true }), p('Alt+D')!))
assert.ok(!matchesShortcut(key('KeyD'), p('Alt+D')!))
assert.ok(matchesShortcut(key('F2'), p('F2')!))

// round trip and labels
assert.equal(stringifyShortcut(p('ctrl+shift+k')!, false), 'Ctrl+Shift+K')
assert.equal(stringifyShortcut(p('Mod+.', true)!, true), 'Cmd+Period')
assert.deepEqual(p(stringifyShortcut(p('Mod+.', true)!, true), true), p('Mod+.', true))
assert.equal(shortcutLabel(p('Alt+Shift+K')!, true), '⌥⇧K')
assert.equal(shortcutLabel(p('Alt+D')!, false), 'Alt+D')
assert.equal(shortcutLabel(p('Ctrl+.')!, false), 'Ctrl+.')

console.log('shortcut checks ok')
