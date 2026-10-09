// node checks/anim.check.ts: the animation model reads and rewrites people's code, so it gets a thorough check.
import assert from 'node:assert/strict'
import {
  classifyTailwind, cssToValues, describe, fromMotion, keyframesCss, matrixValues, motionEdits, motionRemove, motionShape, parseClass,
  PRESETS, sanitizeAnim, springEasing, tailwindEdits, timingText, toWaapi, transformFns, transitionCss, transitionFromCss, utilityFor,
  type Anim, type MotionFound,
} from '../src/anim.ts'

const setIn = (o: Record<string, unknown>, path: string[], v: unknown): Record<string, unknown> =>
  !path.length ? (v as Record<string, unknown>) : { ...o, [path[0]]: setIn((o[path[0]] ?? {}) as Record<string, unknown>, path.slice(1), v) }
/** Apply dotted edits to a props object the way the write-back does (null removes). */
const applyEdits = (props: Record<string, unknown>, edits: Record<string, unknown>) => {
  let p = structuredClone(props)
  for (const [k, v] of Object.entries(edits)) {
    const path = k.split('.')
    if (v === null) { const parent = path.slice(0, -1).reduce<Record<string, unknown>>((o, s) => (o[s] ?? {}) as Record<string, unknown>, p); delete parent[path.at(-1)!] }
    else p = setIn(p, path, v)
  }
  return p
}

// ── Motion: read ────────────────────────────────────────────────────────────
{
  const [enter, hover, press] = fromMotion({
    initial: { opacity: 0, y: 8 }, animate: { opacity: 1, y: 0 }, transition: { type: 'spring', visualDuration: 0.3, bounce: 0 },
    whileHover: { scale: 1.03, transition: { duration: 0.15 } }, whileTap: { scale: 0.96 },
  })
  assert.equal(enter.anim.trigger, 'enter')
  assert.deepEqual(enter.anim.frames, [{ at: 0, values: { opacity: 0, y: 8 } }, { at: 1, values: { opacity: 1, y: 0 } }])
  assert.deepEqual(enter.at, { target: 'animate', from: 'initial', transition: 'transition' })
  assert.deepEqual(hover.at, { target: 'whileHover', from: undefined, transition: 'whileHover.transition' })
  assert.deepEqual(hover.anim.transition, { duration: 0.15 })
  assert.deepEqual(press.anim.transition, { type: 'spring', visualDuration: 0.3, bounce: 0 }) // the shared transition applies
  assert.deepEqual(press.anim.frames[0].values, {}) // a gesture starts from wherever the element is
}
{ // variant labels, resolved through variants; keyframe arrays with times; a repeating animate is a loop
  const [enter] = fromMotion({ variants: { hidden: { opacity: 0 }, visible: { opacity: 1, transition: { delay: 0.1 } } }, initial: 'hidden', animate: 'visible' })
  assert.deepEqual(enter.at, { target: 'variants.visible', from: 'variants.hidden', transition: 'variants.visible.transition' })
  assert.equal(enter.label, 'visible')
  const [loop] = fromMotion({ animate: { y: [0, -4, 0], transition: { duration: 3, repeat: Infinity, times: [0, 0.3, 1] } } })
  assert.equal(loop.anim.trigger, 'loop')
  assert.deepEqual(loop.anim.frames.map(f => f.at), [0, 0.3, 1])
  assert.deepEqual(loop.anim.frames[1].values, { y: -4 })
  assert.equal(loop.anim.transition.times, undefined) // times live in the frames
}
{ // things Motion allows that Watcher can't show, said so instead of guessed at
  const found = fromMotion({ initial: false, animate: { opacity: 1, x: { get: () => 1 } }, whileHover: 'hover', whileTap: { start: () => {} }, transition: { default: { duration: 0.2 }, opacity: { duration: 1 } } })
  const enter = found.find(f => f.anim.trigger === 'enter')!
  assert.ok(enter.notes.some(n => n.includes('initial={false}')))
  assert.ok(enter.notes.some(n => n.includes('x isn’t a plain value')))
  assert.ok(enter.notes.some(n => n.includes('opacity has a transition of its own')))
  assert.equal(enter.anim.transition.duration, 0.2) // transition.default
  assert.ok(found.find(f => f.anim.trigger === 'hover')!.notes[0].includes('variant “hover” isn’t defined'))
  assert.ok(found.find(f => f.anim.trigger === 'press')!.notes[0].includes('animation controls'))
  const [view] = fromMotion({ initial: { opacity: 0 }, whileInView: { opacity: 1 } })
  assert.equal(view.anim.trigger, 'inView')
  assert.deepEqual(view.anim.frames[0].values, { opacity: 0 })
}

// ── Motion: write ───────────────────────────────────────────────────────────
{
  const props = { initial: { opacity: 0, y: 8 }, animate: { opacity: 1, y: 0 }, transition: { type: 'spring', visualDuration: 0.3, bounce: 0 }, whileHover: { scale: 1.03 } }
  const [enter, hover] = fromMotion(props)
  // only what changed, where it already lives
  const a: Anim = { ...enter.anim, frames: [{ at: 0, values: { opacity: 0, y: 12 } }, { at: 1, values: { opacity: 1, y: 0 } }] }
  assert.deepEqual(motionEdits(a, enter), { 'initial.y': 12 })
  // a shared transition moves into the target when others still use it
  const b: Anim = { ...enter.anim, transition: { ...enter.anim.transition, bounce: 0.2 } }
  assert.deepEqual(motionEdits(b, enter), { 'transition.bounce': 0.2 })
  assert.deepEqual(motionEdits(b, enter, { isolate: true }), { 'animate.transition.type': 'spring', 'animate.transition.visualDuration': 0.3, 'animate.transition.bounce': 0.2 })
  // removing a value, and moving an animation to another trigger
  const c: Anim = { ...hover.anim, trigger: 'press' }
  const moved = motionEdits(c, hover)
  assert.equal(moved.whileHover, null)
  assert.equal(moved['whileTap.scale'], 1.03)
  // round trip: written, read back, the same animation
  for (const { anim } of PRESETS.filter(p => p.anim.trigger !== 'loop' || true)) {
    const written = applyEdits({}, motionEdits(anim))
    const back = fromMotion(written).find(f => f.anim.trigger === anim.trigger)!
    assert.deepEqual(back.anim.frames, anim.frames.map(f => ({ ...f })), `${anim.trigger} frames round trip`)
  }
  // loops get repeat: Infinity, keyframe arrays, and times only when uneven
  const loop = motionEdits({ trigger: 'loop', frames: [{ at: 0, values: { y: 0 } }, { at: 0.25, values: { y: -4 } }, { at: 1, values: { y: 0 } }], transition: { duration: 2 } })
  assert.deepEqual(loop['animate.y'], [0, -4, 0])
  assert.deepEqual(loop['animate.transition.times'], [0, 0.25, 1])
  assert.equal(loop['animate.transition.repeat'], Infinity)
  // keyframes fill gaps: a key missing at a middle frame is interpolated
  assert.deepEqual(motionShape({ trigger: 'loop', frames: [{ at: 0, values: { y: 0, opacity: 1 } }, { at: 0.5, values: { y: -4 } }, { at: 1, values: { y: 0, opacity: 0 } }], transition: {} }).target.opacity, [1, 0.5, 0])
  // removing: a variant-driven animation loses its label, not the variant
  const [v] = fromMotion({ variants: { visible: { opacity: 1 } }, initial: { opacity: 0 }, animate: 'visible' })
  assert.deepEqual(motionRemove(v), { animate: null, initial: null })
}

// ── Tailwind: read ──────────────────────────────────────────────────────────
{
  assert.deepEqual(parseClass('md:group-hover/card:-translate-y-0.5!'), { cls: 'md:group-hover/card:-translate-y-0.5!', utility: 'translate-y-0.5', neg: true, trigger: 'hover', via: 'group-hover/card', scope: 'md:' })
  assert.equal(parseClass('hover:bg-[url(a:b)]').utility, 'bg-[url(a:b)]')
  assert.equal(parseClass('starting:opacity-0').trigger, 'enter')
  const m = classifyTailwind('p-4 transition duration-150 ease-out hover:-translate-y-0.5 hover:shadow-lg active:scale-[0.96] focus-visible:ring-2 motion-safe:hover:opacity-90 md:hover:scale-105 data-[open]:opacity-100 animate-pulse hover:underline')
  assert.deepEqual(m.timing.map(c => c.cls), ['transition', 'duration-150', 'ease-out'])
  assert.deepEqual(m.states.hover!.map(c => c.cls), ['hover:-translate-y-0.5', 'hover:shadow-lg', 'motion-safe:hover:opacity-90'])
  assert.deepEqual(m.states.press!.map(c => c.cls), ['active:scale-[0.96]'])
  assert.deepEqual(m.states.focus!.map(c => c.cls), ['focus-visible:ring-2'])
  assert.deepEqual(m.other.map(c => c.cls), ['md:hover:scale-105']) // another breakpoint: left as written
  assert.deepEqual(m.animate.map(c => c.cls), ['animate-pulse'])
}

// ── Tailwind: write ─────────────────────────────────────────────────────────
{
  assert.equal(utilityFor('y', -2), '-translate-y-0.5')
  assert.equal(utilityFor('y', -3), '-translate-y-0.75')
  assert.equal(utilityFor('y', -3, 3), '-translate-y-[3px]')
  assert.equal(utilityFor('x', 1), 'translate-x-px')
  assert.equal(utilityFor('scale', 0.96), 'scale-96')
  assert.equal(utilityFor('scale', 0.96, 3), 'scale-[0.96]')
  assert.equal(utilityFor('scale', 0.955), 'scale-[0.955]')
  assert.equal(utilityFor('rotate', -3), '-rotate-3')
  assert.equal(utilityFor('opacity', 0.5), 'opacity-50')
  assert.equal(utilityFor('filter', 'blur(4px)'), 'blur-[4px]')
  assert.equal(utilityFor('backgroundColor', '#f38020'), 'bg-[#f38020]')
  assert.equal(utilityFor('boxShadow', '0 8px 24px rgba(0,0,0,.08)'), 'shadow-[0_8px_24px_rgba(0,0,0,.08)]')

  const cls = 'transition-shadow duration-150 ease-out hover:shadow-lg hover:-translate-y-0.5'
  const m = classifyTailwind(cls)
  const old: Anim = { trigger: 'hover', frames: [{ at: 0, values: { y: 0, boxShadow: 'none' } }, { at: 1, values: { y: -2, boxShadow: '0 10px 15px x' } }], transition: transitionFromCss(150, 'cubic-bezier(0, 0, 0.2, 1)') }
  const ctx = { ver: 4 as const, timing: m.timing, current: old.transition, others: [], old: { anim: old, classes: m.states.hover! } }
  // only y changed: the shadow keeps hover:shadow-lg; transform joins the transition list
  const e = tailwindEdits({ ...old, frames: [old.frames[0], { at: 1, values: { y: -4, boxShadow: '0 10px 15px x' } }] }, ctx)
  assert.deepEqual(e.remove.sort(), ['hover:-translate-y-0.5', 'transition-shadow'])
  assert.deepEqual(e.add, ['hover:-translate-y-1', 'transition-[box-shadow,translate]'])
  // only timing changed: values untouched, duration and ease swapped (and the lift, which snapped because
  // transition-shadow doesn't cover translate, joins the transition list)
  const t = tailwindEdits({ ...old, transition: { duration: 0.3, ease: [0.2, 0, 0, 1] } }, ctx)
  assert.deepEqual(t.remove.sort(), ['duration-150', 'ease-out', 'transition-shadow'])
  assert.deepEqual(t.add, ['transition-[box-shadow,translate]', 'duration-300', 'ease-[cubic-bezier(0.2,0,0,1)]'])
  // when the transition already covers everything, timing edits touch only timing
  const full = classifyTailwind('transition duration-150 ease-out hover:shadow-lg hover:-translate-y-0.5')
  const t2 = tailwindEdits({ ...old, transition: { duration: 0.3, ease: [0, 0, 0.2, 1] } }, { ...ctx, timing: full.timing, old: { anim: old, classes: full.states.hover! } })
  assert.deepEqual(t2, { remove: ['duration-150'], add: ['duration-300'], notes: [] })
  // a value removed loses its class; group-hover and scopes are kept
  const g = classifyTailwind('transition motion-safe:group-hover:opacity-80')
  const gOld: Anim = { trigger: 'hover', frames: [{ at: 0, values: { opacity: 1 } }, { at: 1, values: { opacity: 0.8 } }], transition: transitionFromCss(150, 'ease') }
  const ge = tailwindEdits({ ...gOld, frames: [gOld.frames[0], { at: 1, values: { opacity: 0.6 } }] }, { ver: 4, timing: g.timing, current: gOld.transition, others: [], old: { anim: gOld, classes: g.states.hover! } })
  assert.deepEqual(ge.add, ['motion-safe:group-hover:opacity-60'])
  assert.deepEqual(ge.remove, ['motion-safe:group-hover:opacity-80'])
  // a new enter animation: starting: classes, and a transition for what it moves
  const enter = tailwindEdits(PRESETS[1].anim, { ver: 4, timing: [], others: [] })
  assert.ok(enter.add.includes('starting:opacity-0') && enter.add.includes('starting:translate-y-2'), enter.add.join(' '))
  assert.ok(enter.add.includes('transition-[opacity,translate]'))
  assert.ok(enter.add.some(c => /^ease-\[linear\(/.test(c)), 'a spring becomes a linear() easing')
  // steps or loops: @keyframes plus one animate-[…] class
  const float = tailwindEdits(PRESETS.find(p => p.name === 'Float')!.anim, { ver: 4, timing: [], others: [], name: 'float' })
  assert.deepEqual(float.add, ['animate-[float_3000ms_cubic-bezier(0.42,0,0.58,1)_infinite]'])
  assert.equal(float.keyframes!.css, '@keyframes float {\n  0% { translate: 0px 0px; }\n  50% { translate: 0px -4px; }\n  100% { translate: 0px 0px; }\n}')
  const hoverWiggle = tailwindEdits({ trigger: 'hover', frames: [{ at: 0, values: { rotate: 0 } }, { at: 0.5, values: { rotate: 3 } }, { at: 1, values: { rotate: 0 } }], transition: { duration: 0.4 } }, { ver: 4, timing: [], others: [], name: 'wiggle' })
  assert.ok(hoverWiggle.add[0].startsWith('hover:animate-[wiggle_400ms_'))
  // editing a keyframe animation's steps only (same name and timing): the class stays, only @keyframes changes
  const wm = classifyTailwind('btn hover:animate-[wiggle_400ms_cubic-bezier(0,0,0.2,1)]')
  const wOld: Anim = { trigger: 'hover', frames: [{ at: 0, values: { rotate: 0 } }, { at: 0.5, values: { rotate: 3 } }, { at: 1, values: { rotate: 0 } }], transition: { type: 'tween', duration: 0.4, ease: [0, 0, 0.2, 1] } }
  const we = tailwindEdits({ ...wOld, frames: [wOld.frames[0], { at: 0.5, values: { rotate: 5 } }, wOld.frames[2]] }, { ver: 4, timing: [], others: [], old: { anim: wOld, classes: wm.animate }, name: 'wiggle' })
  assert.deepEqual([we.remove, we.add], [[], []])
  assert.ok(we.keyframes!.css.includes('50% { rotate: 5deg; }'))
  // in view needs JavaScript
  assert.ok(tailwindEdits(PRESETS.find(p => p.anim.trigger === 'inView')!.anim, { ver: 4, timing: [], others: [] }).notes[0].includes('Motion'))
  // v3 has no starting: — enter becomes keyframes
  assert.ok(tailwindEdits(PRESETS[0].anim, { ver: 3, timing: [], others: [], name: 'fade' }).keyframes)
}

// ── CSS values ──────────────────────────────────────────────────────────────
{
  assert.deepEqual(cssToValues('translate', '0px -2px'), { x: 0, y: -2 })
  assert.deepEqual(cssToValues('translate', '10px'), { x: 10, y: 0 })
  assert.deepEqual(cssToValues('translate', 'none'), { x: 0, y: 0 })
  assert.deepEqual(cssToValues('scale', '0.96'), { scale: 0.96 })
  assert.deepEqual(cssToValues('scale', '1.1 0.9'), { scaleX: 1.1, scaleY: 0.9 })
  assert.deepEqual(cssToValues('rotate', '0.5turn'), { rotate: 180 })
  assert.deepEqual(cssToValues('opacity', '50%'), { opacity: 0.5 })
  assert.deepEqual(cssToValues('box-shadow', 'none'), { boxShadow: 'none' })
  assert.deepEqual(matrixValues('matrix(1, 0, 0, 1, 0, -2)'), { x: 0, y: -2, rotate: 0, scale: 1 })
  const r = matrixValues('matrix(0.96, 0, 0, 0.96, 4, 0)')
  assert.deepEqual(r, { x: 4, y: 0, rotate: 0, scale: 0.96 })
  assert.equal(matrixValues('matrix(0, 1, -1, 0, 0, 0)').rotate, 90)
  assert.deepEqual(matrixValues('matrix3d(1,0,0,0,0,1,0,0,0,0,1,0,5,6,0,1)'), { x: 5, y: 6, rotate: 0, scale: 1 })
  assert.deepEqual(transformFns('translateY(-25%) rotate(360deg)'), { y: '-25%', rotate: 360 })
  assert.deepEqual(transformFns('skew(10deg)'), { transform: 'skew(10deg)' })
}

// ── timing ──────────────────────────────────────────────────────────────────
{
  const t = transitionFromCss(150, 'cubic-bezier(0, 0, 0.2, 1)', 50, 'infinite', 'alternate')
  assert.deepEqual(t, { type: 'tween', duration: 0.15, ease: [0, 0, 0.2, 1], delay: 0.05, repeat: Infinity, repeatType: 'reverse' })
  assert.deepEqual(transitionCss(t), { durationMs: 150, easing: 'cubic-bezier(0, 0, 0.2, 1)', delayMs: 50 })
  assert.equal(transitionCss({ ease: 'easeInOut' }).easing, 'cubic-bezier(0.42, 0, 0.58, 1)')
  assert.equal(transitionCss({}).durationMs, 300)
  const s = springEasing({ type: 'spring', visualDuration: 0.3, bounce: 0 })
  assert.ok(s.easing.startsWith('linear(0, ') && s.easing.endsWith(', 1 100%)'))
  assert.ok(s.ms > 300 && s.ms < 700, String(s.ms))
  assert.equal(timingText(t), '150ms ease-out, after 50ms, back and forth forever')
  assert.equal(timingText({ type: 'spring', visualDuration: 0.3, bounce: 0 }), 'spring 0.3s')
  assert.equal(timingText({ stiffness: 300, damping: 30 }), 'spring (stiffness 300, damping 30)')
  assert.equal(timingText({}), 'Motion’s default timing')
}

// ── show ────────────────────────────────────────────────────────────────────
{
  assert.equal(describe(PRESETS[1].anim), 'fades in and rises 8px · spring 0.3s')
  assert.equal(describe(PRESETS.find(p => p.name === 'Press')!.anim), 'shrinks to 96% · 150ms ease-out')
  assert.equal(describe(PRESETS.find(p => p.name === 'Icon swap')!.anim), 'fades in, scales up from 25% and unblurs · spring 0.3s')
  assert.equal(describe(PRESETS.find(p => p.name === 'Float')!.anim), 'y 0 → -4 → 0 · 3s ease-in-out, repeating forever')
  assert.equal(describe({ trigger: 'hover', frames: [{ at: 0, values: {} }, { at: 1, values: { boxShadow: 'x' } }], transition: {} }), 'shadow changes · Motion’s default timing')
  assert.equal(describe({ trigger: 'hover', frames: [{ at: 0, values: {} }, { at: 1, values: { backgroundColor: 'rgb(243, 128, 32)' } }], transition: { duration: 0.15, ease: [0.4, 0, 0.6, 1] } }), 'background turns #f38020 · 150ms curve (0.4, 0, 0.6, 1)')
  // CSS keyframes that only set 50% (Tailwind's pulse): 0% and 100% are the element's own value, and a key that
  // never moves isn't described
  const pulse: Anim = { trigger: 'loop', frames: [{ at: 0, values: {} }, { at: 0.5, values: { opacity: 0.5, x: 0 } }, { at: 1, values: {} }], transition: { duration: 2, repeat: Infinity } }
  assert.equal(describe(pulse, { opacity: 1, x: 0 }), 'opacity 1 → 0.5 → 1 · 2s default ease, repeating forever')

  const w = toWaapi(PRESETS.find(p => p.name === 'Hover lift')!.anim)
  assert.equal(w.keyframes.length, 4) // in, hold, out
  assert.deepEqual(w.keyframes.map(k => k.translate), ['0px 0px', '0px -2px', '0px -2px', '0px 0px'])
  const l = toWaapi(PRESETS.find(p => p.name === 'Pulse')!.anim)
  assert.equal(l.options.iterations, 3)
  assert.deepEqual(l.keyframes.map(k => k.opacity), ['1', '0.5', '1'])
  assert.equal(keyframesCss('x', [{ at: 0, values: { scale: 0.9, backgroundColor: 'red' } }]), '@keyframes x {\n  0% { scale: 0.9; background-color: red; }\n}')
}

// ── presets from a file are untrusted ───────────────────────────────────────
{
  assert.equal(sanitizeAnim({ trigger: 'nope', frames: [] }), null)
  assert.equal(sanitizeAnim({ trigger: 'hover', frames: [{ at: 0, values: {} }] }), null)
  const s = sanitizeAnim({ trigger: 'hover', frames: [{ at: 2, values: { y: -2, 'a;b': 1, z: {} } }, { at: -1, values: {} }], transition: { duration: 0.2, onComplete: 'x', ease: [0, 0, 1, 1] } })!
  assert.deepEqual(s, { trigger: 'hover', frames: [{ at: 0, values: {} }, { at: 1, values: { y: -2 } }], transition: { duration: 0.2, ease: [0, 0, 1, 1] } })
}

console.log('anim checks ok')
const _unused: MotionFound | undefined = undefined; void _unused
