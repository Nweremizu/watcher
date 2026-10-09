// node checks/guard.check.ts: contrast and token maths decide what Watcher flags, so they get a runnable check.
import assert from 'node:assert/strict'
import { contrast, deltaE, fixContrast, fromOklab, isLargeText, nearestColor, nearestLength, over, toHex, toOklab, type RGB } from '../src/guard.ts'

const c = (hex: string, a = 1): RGB => ({ r: parseInt(hex.slice(1, 3), 16), g: parseInt(hex.slice(3, 5), 16), b: parseInt(hex.slice(5, 7), 16), a })
const near = (x: number, y: number, eps = 0.01) => assert.ok(Math.abs(x - y) < eps, `${x} ≈ ${y}`)
const white = c('#ffffff'), black = c('#000000')

// WCAG reference values
near(contrast(black, white), 21)
near(contrast(white, white), 1)
near(contrast(c('#777777'), white), 4.48) // the classic "just fails AA" grey
near(contrast(c('#767676'), white), 4.54)
near(contrast(c('#f38020'), white), 2.65)
assert.equal(isLargeText(24, 400), true)
assert.equal(isLargeText(19, 700), true)
assert.equal(isLargeText(19, 400), false)

// alpha compositing
assert.deepEqual(over(c('#000000', 0.5), white), { r: 127.5, g: 127.5, b: 127.5, a: 1 })

// OKLab round trip
for (const hex of ['#f38020', '#1d1f24', '#fde6d2', '#00ff00']) assert.equal(toHex(fromOklab(toOklab(c(hex)))), hex)
assert.ok(deltaE(c('#f38020'), c('#f38021')) < 0.6)
assert.ok(deltaE(c('#f38020'), c('#ff0000')) > 10)

// contrast fix: smallest lightness change that passes, same hue
const fixed = fixContrast(c('#999999'), white, 4.5)!
assert.ok(contrast(fixed, white) >= 4.5)
assert.ok(contrast(fixed, white) < 4.7, 'should stop just past the target')
const onDark = fixContrast(c('#555555'), c('#111111'), 4.5)!
assert.ok(toOklab(onDark).L > toOklab(c('#555555')).L, 'lightens on a dark background')
assert.equal(fixContrast(c('#777777'), c('#777777'), 22), null)

// nearest tokens
const tokens = [{ name: '--brand', rgb: c('#f38020') }, { name: '--muted', rgb: c('#666666') }, { name: '--radius', px: 12 }]
assert.equal(nearestColor(c('#f38020'), tokens)!.exact, true)
assert.equal(nearestColor(c('#6a6a6a'), tokens)!.token.name, '--muted')
assert.equal(nearestColor(c('#6a6a6a'), tokens)!.exact, false)
assert.equal(nearestColor(c('#f38020', 0.5), tokens), null) // a translucent colour is never "the same" token
assert.deepEqual(nearestLength(22, [], 4), { value: 24, token: undefined, exact: false, close: true })
assert.equal(nearestLength(6, [], 4)!.exact, true) // p-1.5
assert.equal(nearestLength(18, [], 4)!.exact, false) // half steps only below 16px
assert.equal(nearestLength(48, [{ name: '--text-lg', px: 18 }])!.close, false) // flagged, but not worth suggesting
assert.equal(toHex(fixContrast(c('#999999'), c('#fafafa'), 4.5)!).slice(1, 3), toHex(fixContrast(c('#999999'), c('#fafafa'), 4.5)!).slice(3, 5)) // greys stay grey
assert.equal(nearestLength(24, [], 4)!.exact, true)
assert.equal(nearestLength(11, tokens)!.token!.name, '--radius')
assert.equal(nearestLength(5, []), null)

console.log('guard checks ok')
