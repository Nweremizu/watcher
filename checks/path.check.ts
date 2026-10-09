// node checks/path.check.ts — the pen tool rewrites real SVGs, so the parser gets a runnable check.
import assert from 'node:assert/strict'
import { parsePath, serializePath, splitSeg, shapeD } from '../src/path.ts'

const rt = (d: string) => serializePath(parsePath(d))
const near = (a: number, b: number, eps = 0.01) => assert.ok(Math.abs(a - b) < eps, `${a} ≉ ${b}`)

// absolute, relative, H/V, implicit lineto after M
assert.equal(rt('M0 0 L10 0 L10 10 Z'), 'M0 0L10 0L10 10Z')
assert.equal(rt('m5 5h10v10h-10z'), 'M5 5L15 5L15 15L5 15Z')
assert.equal(rt('M0 0 10 0 10 10'), 'M0 0L10 0L10 10')
// compact numbers: "1.5.5" is 1.5 then .5, "-1-2" is -1 then -2
assert.equal(rt('M1.5.5L-1-2'), 'M1.5 0.5L-1 -2')

// arc with compact flags ("0110 10" = large 0, sweep 1, x 10, y 10): quarter circle, handle ≈ 0.5523·r
const arc = parsePath('M0 0a10 10 0 0110 10')[0].nodes
near(arc.at(-1)!.x, 10); near(arc.at(-1)!.y, 10)
near(Math.hypot(arc[0].out![0], arc[0].out![1]), 5.523)

// quadratic → cubic control points at 2/3
const q = parsePath('M0 0Q5 10 10 0')[0].nodes
near(q[0].out![0], 10 / 3); near(q[0].out![1], 20 / 3); near(q[1].in![0], 20 / 3)

// S reflects the previous control point
const s = parsePath('M0 0C0 10 10 10 10 0S20 -10 20 0')[0].nodes
near(s[1].out![0], 10); near(s[1].out![1], -10)

// a closing curve back to the start folds into the first node and round-trips
const c = parsePath('M0 0C5 0 10 5 10 10C10 5 5 0 0 0Z')
assert.equal(c[0].nodes.length, 2); assert.ok(c[0].closed)
assert.equal(serializePath(c), 'M0 0C5 0 10 5 10 10C10 5 5 0 0 0Z')

// two subpaths
assert.equal(parsePath('M0 0L1 1ZM5 5L6 6').length, 2)

// splitting a straight segment and a curve
const l = parsePath('M0 0L10 0')[0].nodes
assert.deepEqual(splitSeg(l[0], l[1], 0.5), { x: 5, y: 0 })
const cv = parsePath('M0 0C0 10 10 10 10 0')[0].nodes
const mid = splitSeg(cv[0], cv[1], 0.5)
near(mid.x, 5); near(mid.y, 7.5)

// shapes → paths
assert.equal(shapeD('rect', n => ({ x: 1, y: 2, width: 10, height: 5 } as Record<string, number>)[n] ?? 0), 'M1 2H11V7H1Z')
assert.equal(shapeD('polygon', () => 0, '0,0 10,0 5,5'), 'M0 0L10 0L5 5Z')
assert.equal(parsePath(shapeD('circle', n => ({ cx: 5, cy: 5, r: 5 } as Record<string, number>)[n] ?? 0))[0].nodes.length, 4)

console.log('path checks ok')
