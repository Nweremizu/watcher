// Watcher's model of an animation, and every translation around it. Pure (no DOM): checks/anim.check.ts runs it in Node.
//
//   read   Motion props → Anim                     fromMotion
//          Tailwind classes → which classes animate what (structure only)   classifyTailwind
//          computed CSS values → Anim values (the browser resolves themes, vars and plain CSS for us)   cssToValues
//   write  Anim → Motion prop edits, only what changed, into the objects/variants where it lives   motionEdits
//          Anim → Tailwind class edits, keeping classes whose value didn't change, or @keyframes when it has steps   tailwindEdits
//   show   Anim → a sentence (describe), Anim → a Web Animations preview (toWaapi)
import { cssToTailwind, transitionClass, transitionCovers, type TwVersion } from './tailwind.ts'

export type Trigger = 'enter' | 'hover' | 'press' | 'focus' | 'inView' | 'loop'
export type Value = number | string
export type Values = Record<string, Value>
/** One keyframe: where it sits (0–1) and the values it sets. An empty first frame means "from wherever it is". */
export type Frame = { at: number; values: Values }
/** Motion's transition object (seconds): type, duration, ease, delay, bounce, visualDuration, stiffness, repeat… */
export type Transition = Record<string, unknown>
export type Anim = { trigger: Trigger; frames: Frame[]; transition: Transition }

export const TRIGGERS: Record<Trigger, { label: string; motion: string; variant: string | null }> = {
  enter: { label: 'On enter', motion: 'animate', variant: 'starting' },
  hover: { label: 'On hover', motion: 'whileHover', variant: 'hover' },
  press: { label: 'On press', motion: 'whileTap', variant: 'active' },
  focus: { label: 'On focus', motion: 'whileFocus', variant: 'focus-visible' },
  inView: { label: 'In view', motion: 'whileInView', variant: null },
  loop: { label: 'Loop', motion: 'animate', variant: null },
}
/** Values that mean "unchanged": an animation to these is a return to rest. */
export const IDENTITY: Values = { opacity: 1, x: 0, y: 0, scale: 1, scaleX: 1, scaleY: 1, rotate: 0, filter: 'none' }

type Obj = Record<string, unknown>
const isObj = (v: unknown): v is Obj => !!v && typeof v === 'object' && !Array.isArray(v)
export const r4 = (n: number) => Math.round(n * 1e4) / 1e4
export const sameValue = (a: unknown, b: unknown) =>
  typeof a === 'number' && typeof b === 'number' ? Math.abs(a - b) < 1e-3 : a !== undefined && b !== undefined && String(a).replace(/\s+/g, ' ').trim() === String(b).replace(/\s+/g, ' ').trim()
const kebab = (k: string) => k.replace(/[A-Z]/g, c => '-' + c.toLowerCase())
const camel = (p: string) => p.replace(/-([a-z])/g, (_, c: string) => c.toUpperCase())
export const fromTo = (from: Values, to: Values): Frame[] => [{ at: 0, values: from }, { at: 1, values: to }]
export const keysOf = (a: Anim) => [...new Set(a.frames.flatMap(f => Object.keys(f.values)))]

// ── easing ──────────────────────────────────────────────────────────────────
export type Bez = [number, number, number, number]
const CSS_EASES: Record<string, Bez> = { ease: [0.25, 0.1, 0.25, 1], 'ease-in': [0.42, 0, 1, 1], 'ease-out': [0, 0, 0.58, 1], 'ease-in-out': [0.42, 0, 0.58, 1], linear: [0, 0, 1, 1] }
/** Motion's named easings as curves (anticipate overshoots backwards first; this curve approximates it). */
export const MOTION_EASES: Record<string, Bez> = {
  linear: [0, 0, 1, 1], easeIn: [0.42, 0, 1, 1], easeOut: [0, 0, 0.58, 1], easeInOut: [0.42, 0, 0.58, 1],
  circIn: [0.55, 0, 1, 0.45], circOut: [0, 0.55, 0.45, 1], circInOut: [0.85, 0, 0.15, 1],
  backIn: [0.31, 0.01, 0.66, -0.59], backOut: [0.33, 1.53, 0.69, 0.99], backInOut: [0.68, -0.6, 0.32, 1.6], anticipate: [0.36, 0, 0.66, -0.56],
}
const MOTION_DEFAULT_EASE: Bez = [0.25, 0.1, 0.35, 1] // motion-dom's tween default
export function parseBezier(css: string): Bez | null {
  const t = css.trim()
  if (CSS_EASES[t]) return CSS_EASES[t]
  const n = /^cubic-bezier\(([^)]+)\)$/.exec(t)?.[1].split(',').map(Number)
  return n?.length === 4 && n.every(Number.isFinite) ? (n as Bez) : null
}
export const bezCss = (b: readonly number[]) => `cubic-bezier(${b.map(n => r4(n)).join(', ')})`
/** Any ease Watcher meets (Motion name, bezier array, CSS text) as CSS. */
export function easeToCss(e: unknown): string {
  if (Array.isArray(e) && e.length === 4 && e.every(n => typeof n === 'number')) return bezCss(e)
  if (Array.isArray(e)) return easeToCss(e[0]) // Motion: one ease per keyframe segment; CSS takes one
  if (typeof e === 'string') return MOTION_EASES[e] ? (e === 'linear' ? 'linear' : bezCss(MOTION_EASES[e])) : e
  return bezCss(MOTION_DEFAULT_EASE)
}
const NAMED_CURVES: [string, Bez][] = [
  ['ease-out', [0, 0, 0.2, 1]], ['ease-in-out', [0.4, 0, 0.2, 1]], ['ease-in', [0.4, 0, 1, 1]], ['snappy', [0.2, 0, 0, 1]],
  ['ease-out', [0, 0, 0.58, 1]], ['ease-in', [0.42, 0, 1, 1]], ['ease-in-out', [0.42, 0, 0.58, 1]], ['ease', [0.25, 0.1, 0.25, 1]], ['linear', [0, 0, 1, 1]], ['default ease', MOTION_DEFAULT_EASE],
]
export function easeName(e: unknown): string {
  const b = Array.isArray(e) && e.length === 4 ? (e as Bez) : typeof e === 'string' ? (MOTION_EASES[e] ?? parseBezier(e)) : MOTION_DEFAULT_EASE
  if (!b) return typeof e === 'string' && e.startsWith('linear(') ? 'custom curve' : String(e)
  return NAMED_CURVES.find(([, c]) => c.every((n, i) => Math.abs(n - b[i]) < 1e-3))?.[0] ?? `curve (${b.map(n => r4(n)).join(', ')})`
}

// ── springs (motion-dom's resolution of duration/bounce, simulated) ─────────
const SPRING = { stiffness: 100, damping: 10, mass: 1, bounce: 0.3 }
const num = (t: Transition, k: string) => (typeof t[k] === 'number' ? (t[k] as number) : undefined)
export const isSpring = (t: Transition) => t.type === 'spring' || (t.type === undefined && ['stiffness', 'damping', 'mass', 'bounce', 'visualDuration'].some(k => t[k] !== undefined))
export const hasPhysics = (t: Transition) => ['stiffness', 'damping', 'mass'].some(k => num(t, k) !== undefined)
export function springOf(t: Transition) {
  if (hasPhysics(t) || (num(t, 'visualDuration') === undefined && num(t, 'duration') === undefined && num(t, 'bounce') === undefined))
    return { k: num(t, 'stiffness') ?? SPRING.stiffness, c: num(t, 'damping') ?? SPRING.damping, m: num(t, 'mass') ?? SPRING.mass, approx: false }
  const bounce = num(t, 'bounce') ?? SPRING.bounce
  const ratio = bounce < 0 ? 1 / Math.max(1 + bounce, 0.05) : Math.max(1 - bounce, 0.05)
  const vd = num(t, 'visualDuration') ?? (num(t, 'duration') ?? 0.8) / 2.4 // duration is time-to-settle; Motion solves for it, this estimates it
  const k = ((2 * Math.PI) / (vd * 1.2)) ** 2
  return { k, c: 2 * ratio * Math.sqrt(k), m: 1, approx: num(t, 'visualDuration') === undefined || bounce < 0 }
}
/** The spring from 0 to 1: points for a curve, and when it settles (seconds). */
export function springCurve(t: Transition) {
  const { k, c, m, approx } = springOf(t)
  const pts: [number, number][] = []
  let x = 0, v = 0, settle = 0
  for (let i = 0, dt = 1 / 240; i < 240 * 4; i++) {
    const a = (-k * (x - 1) - c * v) / m
    v += a * dt; x += v * dt
    if (Math.abs(x - 1) > 0.005 || Math.abs(v) > 0.05) settle = (i + 1) * dt
    if (i % 4 === 0) pts.push([(i + 1) * dt, x])
  }
  return { pts: pts.filter(([s]) => s <= Math.max(0.3, settle * 1.15)), settle, approx }
}
/** A spring as a CSS linear() easing and its duration, so CSS (and previews) move the way the spring does. */
export function springEasing(t: Transition) {
  const { pts, settle } = springCurve(t)
  const end = pts.at(-1)?.[0] ?? 1, step = Math.max(1, Math.ceil(pts.length / 24))
  const stops = pts.filter((_, i) => i % step === 0).map(([s, x]) => `${r4(Math.round(x * 1000) / 1000)} ${Math.round((s / end) * 1000) / 10}%`)
  return { easing: `linear(0, ${stops.join(', ')}, 1 100%)`, ms: Math.max(100, Math.round(settle * 1000)) }
}
/** Timing as CSS: duration and delay in ms, easing (springs become linear()). */
export function transitionCss(t: Transition): { durationMs: number; easing: string; delayMs: number } {
  const delayMs = Math.round((num(t, 'delay') ?? 0) * 1000)
  if (t.type === false) return { durationMs: 0, easing: 'linear', delayMs }
  if (isSpring(t)) { const s = springEasing(t); return { durationMs: s.ms, easing: s.easing, delayMs } }
  return { durationMs: Math.round((num(t, 'duration') ?? 0.3) * 1000), easing: easeToCss(t.ease), delayMs }
}
/** Read CSS timing (computed transition / animation entries) as a Motion-shaped transition. */
export function transitionFromCss(durationMs: number, easing: string, delayMs = 0, iterations?: string, direction?: string): Transition {
  const t: Transition = { type: 'tween', duration: r4(durationMs / 1000) }
  const b = parseBezier(easing)
  t.ease = easing.trim() === 'linear' ? 'linear' : b ? [...b] : easing.trim()
  if (delayMs) t.delay = r4(delayMs / 1000)
  if (iterations && iterations !== '1') t.repeat = iterations === 'infinite' ? Infinity : Math.max(0, parseFloat(iterations) - 1)
  if (direction && /alternate/.test(direction)) t.repeatType = 'reverse'
  return t
}
const fmtMs = (ms: number) => (ms >= 1000 ? `${r4(ms / 1000)}s` : `${Math.round(ms)}ms`)
export function timingText(t: Transition): string {
  if (t.type === false) return 'instant'
  let s: string
  if (isSpring(t)) {
    if (hasPhysics(t)) s = `spring (stiffness ${num(t, 'stiffness') ?? SPRING.stiffness}, damping ${num(t, 'damping') ?? SPRING.damping}${num(t, 'mass') && num(t, 'mass') !== 1 ? `, mass ${num(t, 'mass')}` : ''})`
    else { const b = num(t, 'bounce') ?? (num(t, 'visualDuration') !== undefined ? 0 : SPRING.bounce); s = `spring ${num(t, 'visualDuration') ?? num(t, 'duration') ?? 0.3}s${b ? `, bounce ${b}` : ''}` }
  } else if (t.type === undefined && t.duration === undefined && t.ease === undefined) s = 'Motion’s default timing'
  else s = `${fmtMs((num(t, 'duration') ?? 0.3) * 1000)} ${easeName(t.ease)}`
  const d = num(t, 'delay')
  if (d) s += `, after ${fmtMs(d * 1000)}`
  if (t.repeat === Infinity) s += t.repeatType === 'reverse' || t.repeatType === 'mirror' ? ', back and forth forever' : ', repeating forever'
  else if (num(t, 'repeat')) s += `, ${num(t, 'repeat')! + 1} times`
  return s
}

// ── values ⇄ CSS ────────────────────────────────────────────────────────────
const TRANSFORM_FNS = new Set(['rotateX', 'rotateY', 'rotateZ', 'skewX', 'skewY', 'z', 'perspective'])
/** IR values as CSS declarations: x/y → translate, scale, rotate, the rest kebab-cased. */
export function valuesToCss(v: Values): Record<string, string> {
  const out: Record<string, string> = {}, px = (x: Value | undefined) => (typeof x === 'number' ? `${x}px` : x ?? '0px')
  if ('x' in v || 'y' in v) out.translate = `${px(v.x)} ${px(v.y)}`
  if ('scale' in v) out.scale = String(v.scale)
  else if ('scaleX' in v || 'scaleY' in v) out.scale = `${v.scaleX ?? 1} ${v.scaleY ?? 1}`
  if ('rotate' in v) out.rotate = typeof v.rotate === 'number' ? `${v.rotate}deg` : String(v.rotate)
  const fns = Object.entries(v).filter(([k]) => TRANSFORM_FNS.has(k))
  if (fns.length) out.transform = fns.map(([k, x]) => `${k === 'z' ? 'translateZ' : k}(${typeof x === 'number' ? `${x}${/^(rotate|skew)/.test(k) ? 'deg' : 'px'}` : x})`).join(' ')
  for (const [k, x] of Object.entries(v)) if (!/^(x|y|scale|scaleX|scaleY|rotate)$/.test(k) && !TRANSFORM_FNS.has(k)) out[kebab(k)] = String(x)
  return out
}
const lengthPx = (s: string): Value => (/^-?[\d.]+px$/.test(s) ? r4(parseFloat(s)) : s === '0' ? 0 : s)
const toDeg = (s: string) => { const m = /^(-?[\d.]+)(deg|turn|rad|grad)?$/.exec(s.trim()); if (!m) return null; const n = +m[1]; return r4(m[2] === 'turn' ? n * 360 : m[2] === 'rad' ? (n * 180) / Math.PI : m[2] === 'grad' ? n * 0.9 : n) }
/** A matrix (what browsers compute for `transform`) as x, y, scale and rotate. */
export function matrixValues(t: string): Values {
  if (t.trim() === 'none') return { x: 0, y: 0, scale: 1, rotate: 0 }
  const m = /^matrix(3d)?\(([^)]+)\)$/.exec(t.trim())
  if (!m) return transformFns(t)
  const n = m[2].split(',').map(Number)
  const [a, b, c, d, e, f] = m[1] ? [n[0], n[1], n[4], n[5], n[12], n[13]] : n
  const sx = Math.hypot(a, b), sy = sx ? (a * d - b * c) / sx : 0
  const out: Values = { x: r4(e), y: r4(f), rotate: r4((Math.atan2(b, a) * 180) / Math.PI) }
  if (Math.abs(sx - sy) < 1e-4) out.scale = r4(sx); else { out.scaleX = r4(sx); out.scaleY = r4(sy) }
  return out
}
/** "translateY(-25%) rotate(360deg)", as written in @keyframes, as values; anything else stays a transform string. */
export function transformFns(t: string): Values {
  const out: Values = {}
  const re = /(\w+)\(([^)]*)\)/g
  let m: RegExpExecArray | null, rest = t.trim()
  while ((m = re.exec(t))) {
    const [fn, arg] = [m[1], m[2].trim()], args = arg.split(/\s*,\s*|\s+/)
    if (fn === 'translateX') out.x = lengthPx(arg)
    else if (fn === 'translateY') out.y = lengthPx(arg)
    else if (fn === 'translate') { out.x = lengthPx(args[0]); out.y = lengthPx(args[1] ?? '0px') }
    else if (fn === 'scale') { const [sx, sy = sx] = args.map(Number); if (sx === sy) out.scale = sx; else { out.scaleX = sx; out.scaleY = sy } }
    else if (fn === 'scaleX') out.scaleX = +arg
    else if (fn === 'scaleY') out.scaleY = +arg
    else if (fn === 'rotate' || fn === 'rotateZ') { const d = toDeg(arg); if (d === null) return { transform: t.trim() }; out.rotate = d }
    else return { transform: t.trim() }
    rest = rest.replace(m[0], '').trim()
  }
  return rest ? { transform: t.trim() } : out
}
/** A computed (or declared) CSS value as IR values. */
export function cssToValues(prop: string, value: string): Values {
  const v = value.trim()
  switch (prop) {
    case 'opacity': return { opacity: r4(v.endsWith('%') ? parseFloat(v) / 100 : parseFloat(v)) }
    case 'translate': { if (v === 'none') return { x: 0, y: 0 }; const [a, b = '0px'] = v.split(/\s+/); return { x: lengthPx(a), y: lengthPx(b) } }
    case 'scale': {
      if (v === 'none') return { scale: 1 }
      const [a, b] = v.split(/\s+/).map(s => (s.endsWith('%') ? parseFloat(s) / 100 : parseFloat(s)))
      return b === undefined || Math.abs(a - b) < 1e-4 ? { scale: r4(a) } : { scaleX: r4(a), scaleY: r4(b) }
    }
    case 'rotate': { if (v === 'none') return { rotate: 0 }; const d = toDeg(v.split(/\s+/).at(-1)!); return d === null ? { rotate: v } : { rotate: d } }
    case 'transform': return matrixValues(v)
    default: return { [camel(prop)]: v }
  }
}
/** CSS properties an animation of these keys touches (for transition-property). */
export function cssPropsOf(keys: string[]) {
  const out = new Set<string>()
  for (const k of keys) {
    if (k === 'x' || k === 'y') out.add('translate')
    else if (/^scale/.test(k)) out.add('scale')
    else if (k === 'rotate') out.add('rotate')
    else if (TRANSFORM_FNS.has(k)) out.add('transform')
    else out.add(kebab(k))
  }
  return [...out]
}

// ── frames ──────────────────────────────────────────────────────────────────
/** Every key's value at every frame: given, interpolated between neighbours (numbers), or carried (strings). */
export function filled(a: Anim, rest: Values = {}): Frame[] {
  const keys = keysOf(a), fr = a.frames
  const at = (i: number, k: string): Value | undefined => {
    if (k in fr[i].values) return fr[i].values[k]
    let p = i - 1, n = i + 1
    while (p >= 0 && !(k in fr[p].values)) p--
    while (n < fr.length && !(k in fr[n].values)) n++
    const pv = p >= 0 ? fr[p].values[k] : rest[k] ?? IDENTITY[k], nv = n < fr.length ? fr[n].values[k] : undefined
    if (pv === undefined) return nv
    if (nv === undefined) return i === fr.length - 1 ? rest[k] ?? IDENTITY[k] ?? pv : pv // like CSS: a missing 100% is the element's own value
    if (typeof pv === 'number' && typeof nv === 'number') {
      const p0 = p >= 0 ? fr[p].at : 0, t = (fr[i].at - p0) / ((fr[n].at - p0) || 1)
      return r4(pv + (nv - pv) * t)
    }
    return p >= 0 ? pv : nv
  }
  return fr.map((f, i) => ({ at: f.at, values: Object.fromEntries(keys.map(k => [k, at(i, k)]).filter(([, v]) => v !== undefined)) as Values }))
}

// ── Motion: read ────────────────────────────────────────────────────────────
/** Where an animation lives in Motion props: its target ("whileHover" or "variants.hover"), initial, transition. */
export type MotionAt = { target: string; from?: string; transition: string }
export type MotionFound = { anim: Anim; at: MotionAt; label?: string; notes: string[] }
const TRANSITION_KEYS = new Set(['type', 'duration', 'delay', 'ease', 'bounce', 'visualDuration', 'stiffness', 'damping', 'mass', 'repeat', 'repeatType', 'repeatDelay', 'restDelta', 'restSpeed', 'velocity', 'times'])
function cleanTransition(t: unknown, notes: string[]): Transition {
  if (!isObj(t)) return {}
  const out: Transition = {}
  // Motion: transition.default applies to every value without its own; keys of the target name per-value transitions
  for (const [k, v] of Object.entries({ ...(isObj(t.default) ? t.default : {}), ...t })) {
    if (k === 'default' || k === 'times') continue
    if (TRANSITION_KEYS.has(k)) { if (typeof v === 'function') notes.push(`transition.${k} is a function, so it isn’t shown`); else out[k] = v }
    else if (isObj(v)) notes.push(`${k} has a transition of its own; editing changes the shared one`)
  }
  return out
}
type Raw = Record<string, Value | (Value | null)[]>
function readTarget(p: Obj, key: string, notes: string[]): { raw: Raw; path: string; own?: Obj; label?: string } | null {
  const v = p[key]
  let obj: Obj | undefined, path = key, label: string | undefined
  if (isObj(v)) {
    if (typeof v.start === 'function') { notes.push(`${key} uses animation controls, which only run in your code`); return null }
    obj = v
  } else if (typeof v === 'string' || (Array.isArray(v) && typeof v[0] === 'string')) {
    label = typeof v === 'string' ? v : (v[0] as string)
    if (Array.isArray(v) && v.length > 1) notes.push(`${key} combines variants (${v.join(', ')}); this shows “${label}”`)
    const vs = p.variants
    if (isObj(vs) && isObj(vs[label])) { obj = vs[label] as Obj; path = `variants.${label}` }
    else if (isObj(vs) && typeof vs[label] === 'function') { notes.push(`variant “${label}” is a function, so its values aren’t known until it runs`); return null }
    else { notes.push(`variant “${label}” isn’t defined on this element`); return null }
  } else return null
  const raw: Raw = {}
  for (const [k, x] of Object.entries(obj)) {
    if (k === 'transition' || k === 'transitionEnd') continue
    if (typeof x === 'number' || typeof x === 'string') raw[k] = x
    else if (Array.isArray(x) && x.every(e => e === null || typeof e === 'number' || typeof e === 'string')) raw[k] = x as (Value | null)[]
    else notes.push(`${k} isn’t a plain value (a motion value or function), so it isn’t shown`)
  }
  return { raw, path, own: isObj(obj.transition) ? obj.transition : undefined, label }
}
function framesOf(from: Values | undefined, raw: Raw, times: unknown): Frame[] {
  const m = new Map<number, Values>()
  const put = (at: number, k: string, v: Value) => { const a = r4(at); m.set(a, { ...(m.get(a) ?? {}), [k]: v }) }
  if (from) for (const [k, v] of Object.entries(from)) put(0, k, v)
  const ts = Array.isArray(times) && times.every(t => typeof t === 'number') ? (times as number[]) : undefined
  for (const [k, v] of Object.entries(raw)) {
    if (!Array.isArray(v)) { put(1, k, v); continue }
    // a null keyframe means "the current value": nothing to set there
    v.forEach((x, i) => { if (x != null) put(ts?.length === v.length ? ts[i] : v.length === 1 ? 1 : i / (v.length - 1), k, x) })
  }
  if (!m.has(0)) m.set(0, {})
  if (!m.has(1)) m.set(1, {})
  return [...m].sort((a, b) => a[0] - b[0]).map(([at, values]) => ({ at, values }))
}
const GESTURES: [Trigger, string][] = [['hover', 'whileHover'], ['press', 'whileTap'], ['focus', 'whileFocus'], ['inView', 'whileInView']]
/** Every animation a motion.* element's props describe. */
export function fromMotion(p: Obj): MotionFound[] {
  const out: MotionFound[] = []
  const shared = isObj(p.transition) ? p.transition : undefined
  const initNotes: string[] = []
  const init = p.initial === false ? null : readTarget(p, 'initial', initNotes)
  const initValues = init ? (Object.fromEntries(Object.entries(init.raw).filter(([, v]) => !Array.isArray(v))) as Values) : undefined
  const one = (trigger: Trigger, key: string) => {
    if (p[key] === undefined) return
    const notes: string[] = []
    const t = readTarget(p, key, notes)
    if (!t) { if (notes.length) out.push({ anim: { trigger, frames: fromTo({}, {}), transition: {} }, at: { target: key, transition: 'transition' }, notes }); return }
    const tr = t.own ?? shared
    const transition = cleanTransition(tr, notes)
    const usesFrom = trigger === 'enter' || trigger === 'inView'
    if (trigger === 'enter' && p.initial === false) notes.push('initial={false}: it starts at these values, so nothing plays on mount')
    out.push({
      anim: { trigger: trigger === 'enter' && transition.repeat === Infinity ? 'loop' : trigger, frames: framesOf(usesFrom ? initValues : undefined, t.raw, isObj(tr) ? tr.times : undefined), transition },
      at: { target: t.path, from: usesFrom && init ? init.path : undefined, transition: t.own ? `${t.path}.transition` : shared ? 'transition' : `${t.path}.transition` },
      label: t.label, notes: [...notes, ...(usesFrom ? initNotes : [])],
    })
  }
  one('enter', 'animate')
  for (const [trigger, key] of GESTURES) one(trigger, key)
  return out
}

// ── Motion: write ───────────────────────────────────────────────────────────
/** What Motion needs for an animation: target values (keyframe arrays when it has steps), times, initial values. */
export function motionShape(a: Anim, rest: Values = {}): { target: Record<string, Value | Value[]>; times?: number[]; from?: Values } {
  const first = a.frames[0].values, from = Object.keys(first).length ? first : undefined
  if (a.frames.length <= 2 && a.trigger !== 'loop') return { target: { ...a.frames.at(-1)!.values }, from }
  const full = filled(a, rest), even = a.frames.every((f, i) => Math.abs(f.at - i / (a.frames.length - 1)) < 1e-3)
  return { target: Object.fromEntries(keysOf(a).map(k => [k, full.map(f => f.values[k])])), times: even ? undefined : a.frames.map(f => r4(f.at)) }
}
const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b)
/** Prop edits (dotted path → value, null removes) that write `a`: only what changed, where it already lives. */
export function motionEdits(a: Anim, old?: MotionFound, opts: { isolate?: boolean } = {}): Record<string, unknown> {
  const out: Record<string, unknown> = {}
  const key = TRIGGERS[a.trigger].motion
  const moved = old && TRIGGERS[old.anim.trigger].motion !== key
  if (moved) Object.assign(out, motionRemove(old!, { keepInitial: a.trigger === 'enter' || a.trigger === 'inView' }))
  const at = old && !moved ? old.at : undefined
  const target = at?.target ?? key
  const now = motionShape(a), was = at ? motionShape(old!.anim) : undefined
  for (const [k, v] of Object.entries(now.target)) if (!was || !same(was.target[k], v)) out[`${target}.${k}`] = v
  if (was) for (const k of Object.keys(was.target)) if (!(k in now.target)) out[`${target}.${k}`] = null
  if (a.trigger === 'enter' || a.trigger === 'inView') {
    const fromPath = at?.from ?? 'initial'
    for (const [k, v] of Object.entries(now.from ?? {})) if (!was?.from || !same(was.from[k], v)) out[`${fromPath}.${k}`] = v
    if (was?.from && at?.from) for (const k of Object.keys(was.from)) if (!(k in (now.from ?? {}))) out[`${fromPath}.${k}`] = null
  }
  // a transition shared with other animations moves into this target, so editing one doesn't retime the rest
  let tPath = at?.transition ?? `${target}.transition`
  const isolate = tPath === 'transition' && opts.isolate
  if (isolate) tPath = `${target}.transition`
  const tNow: Transition = { ...a.transition, ...(now.times ? { times: now.times } : {}) }
  if (a.trigger === 'loop' && tNow.repeat === undefined) tNow.repeat = Infinity
  const tWas: Transition = at && !isolate ? { ...old!.anim.transition, ...(was?.times ? { times: was.times } : {}) } : {}
  for (const [k, v] of Object.entries(tNow)) if (!same(tWas[k], v)) out[`${tPath}.${k}`] = v
  for (const k of Object.keys(tWas)) if (!(k in tNow)) out[`${tPath}.${k}`] = null
  return out
}
/** Prop edits that take an animation off a motion element. A variant-driven one loses its label, not the variant. */
export function motionRemove(f: MotionFound, opts: { keepInitial?: boolean } = {}): Record<string, unknown> {
  const key = TRIGGERS[f.anim.trigger].motion, out: Record<string, unknown> = { [key]: null }
  if ((f.anim.trigger === 'enter' || f.anim.trigger === 'inView') && f.at.from === 'initial' && !opts.keepInitial) out.initial = null
  if (f.anim.trigger === 'inView') out.viewport = null
  return out
}

// ── Tailwind: read (structure; the values come from the browser) ────────────
export type TwClass = { cls: string; utility: string; neg: boolean; trigger: Trigger | null; via: string; scope: string }
const STATE_TRIGGER: Record<string, Trigger> = {
  hover: 'hover', 'group-hover': 'hover', 'peer-hover': 'hover', active: 'press', 'group-active': 'press', 'peer-active': 'press',
  focus: 'focus', 'focus-visible': 'focus', 'focus-within': 'focus', 'group-focus': 'focus', 'group-focus-visible': 'focus', 'peer-focus': 'focus', 'peer-focus-visible': 'focus',
  starting: 'enter',
}
/** "md:group-hover/card:-translate-y-0.5!" → variants, utility, negative, important. Colons inside [] or () don't split. */
export function splitClass(cls: string) {
  const parts: string[] = []
  let depth = 0, cur = ''
  for (const ch of cls) {
    if (ch === '[' || ch === '(') depth++
    else if (ch === ']' || ch === ')') depth--
    if (ch === ':' && !depth) { parts.push(cur); cur = '' } else cur += ch
  }
  let utility = cur
  const important = /^!|!$/.test(utility)
  utility = utility.replace(/^!|!$/g, '')
  const neg = utility.startsWith('-')
  return { variants: parts, utility: neg ? utility.slice(1) : utility, neg, important }
}
export function parseClass(cls: string): TwClass {
  const { variants, utility, neg } = splitClass(cls)
  let trigger: Trigger | null = null, via = ''
  const scope: string[] = []
  for (const v of variants) {
    const t = STATE_TRIGGER[v.replace(/\/[\w-]+$/, '')] // group-hover/card → group-hover
    if (t && !trigger) { trigger = t; via = v } else scope.push(v)
  }
  return { cls, utility, neg, trigger, via, scope: scope.length ? scope.join(':') + ':' : '' }
}
const VISUAL = /^(opacity|translate|scale|rotate|skew|blur|brightness|contrast|grayscale|saturate|sepia|hue-rotate|invert|drop-shadow|filter|backdrop-|shadow|inset-shadow|ring|bg|text|border|outline|decoration|fill|stroke|rounded)(-|$)/
export type TwModel = { timing: TwClass[]; states: Partial<Record<Trigger, TwClass[]>>; animate: TwClass[]; other: TwClass[] }
/** Which classes animate what: shared timing, the values each state sets, keyframe animations, and the rest we leave alone. */
export function classifyTailwind(className: string): TwModel {
  const m: TwModel = { timing: [], states: {}, animate: [], other: [] }
  for (const cls of className.split(/\s+/).filter(Boolean)) {
    const c = parseClass(cls)
    const plainScope = c.scope.replace(/(^|:)(motion-safe|dark):/g, '$1').replace(/^:/, '') === ''
    if (/^animate-/.test(c.utility)) m.animate.push(c)
    else if (/^(transition|duration|ease|delay)(-|$)/.test(c.utility)) (!c.trigger && plainScope ? m.timing : m.other).push(c)
    else if (c.trigger && VISUAL.test(c.utility)) (plainScope ? (m.states[c.trigger] ??= []) : m.other).push(c)
  }
  return m
}
/** The IR keys a utility sets (for keeping or replacing it when that value changes). */
export function tokenKeys(utility: string): string[] {
  const u = utility
  if (/^opacity(-|$)/.test(u)) return ['opacity']
  if (/^translate-x/.test(u)) return ['x']
  if (/^translate-y/.test(u)) return ['y']
  if (/^translate(-|$)/.test(u)) return ['x', 'y']
  if (/^scale-x/.test(u)) return ['scaleX']
  if (/^scale-y/.test(u)) return ['scaleY']
  if (/^scale(-|$)/.test(u)) return ['scale', 'scaleX', 'scaleY']
  if (/^rotate(-|$)/.test(u)) return ['rotate']
  if (/^skew-/.test(u)) return ['skewX', 'skewY']
  if (/^(blur|brightness|contrast|grayscale|saturate|sepia|hue-rotate|invert|drop-shadow|filter)(-|$)/.test(u)) return ['filter']
  if (/^backdrop-/.test(u)) return ['backdropFilter']
  if (/^(shadow|inset-shadow|ring)(-|$)/.test(u)) return ['boxShadow']
  if (/^bg-/.test(u)) return ['backgroundColor']
  if (/^text-/.test(u)) return ['color']
  if (/^border(-|$)/.test(u)) return ['borderColor']
  if (/^outline(-|$)/.test(u)) return ['outlineColor']
  if (/^decoration-/.test(u)) return ['textDecorationColor']
  if (/^fill-/.test(u)) return ['fill']
  if (/^stroke-/.test(u)) return ['stroke']
  if (/^rounded/.test(u)) return ['borderRadius']
  return []
}
const SPACING3 = [0, 0.5, 1, 1.5, 2, 2.5, 3, 3.5, 4, 5, 6, 7, 8, 9, 10, 11, 12, 14, 16, 20, 24, 28, 32, 36, 40, 44, 48, 52, 56, 60, 64, 72, 80, 96]
const arbEsc = (v: string) => v.trim().replace(/\s*,\s*/g, ',').replace(/\s+/g, '_')
/** The utility for one IR value: on the scale when it is, arbitrary otherwise. */
export function utilityFor(k: string, v: Value, ver: TwVersion = 4): string | null {
  const n = typeof v === 'number' ? v : null, minus = n !== null && n < 0 ? '-' : '', a = n === null ? 0 : Math.abs(n)
  switch (k) {
    case 'opacity': { if (n === null) return `opacity-[${arbEsc(String(v))}]`; const p = r4(n * 100); return Number.isInteger(p) && (ver === 4 || p % 5 === 0) ? `opacity-${p}` : `opacity-[${n}]` }
    case 'x': case 'y': {
      if (n === null) return `translate-${k}-[${arbEsc(String(v))}]`
      const q = a / 4, step = a === 0 ? '0' : a === 1 ? 'px' : Number.isInteger(a) && (ver === 4 || SPACING3.includes(q)) ? String(q) : `[${a}px]`
      return `${minus}translate-${k}-${step}`
    }
    case 'scale': case 'scaleX': case 'scaleY': {
      const axis = k === 'scale' ? '' : k === 'scaleX' ? '-x' : '-y'
      if (n === null) return `scale${axis}-[${arbEsc(String(v))}]`
      const p = r4(a * 100)
      return `${minus}scale${axis}-${Number.isInteger(p) && (ver === 4 || [0, 50, 75, 90, 95, 100, 105, 110, 125, 150].includes(p)) ? p : `[${a}]`}`
    }
    case 'rotate': {
      if (n === null) return `rotate-[${arbEsc(String(v))}]`
      return `${minus}rotate-${Number.isInteger(a) && (ver === 4 || [0, 1, 2, 3, 6, 12, 45, 90, 180].includes(a)) ? a : `[${a}deg]`}`
    }
    case 'filter': {
      const s = String(v).trim()
      if (s === 'none') return 'filter-none'
      const blur = /^blur\(([^)]+)\)$/.exec(s)
      return blur ? `blur-[${blur[1]}]` : `[filter:${arbEsc(s)}]`
    }
  }
  const css = kebab(k), r = cssToTailwind(css, String(v), ver)
  return 'cls' in r ? r.cls : `[${css}:${arbEsc(String(v))}]`
}

// ── Tailwind: write ─────────────────────────────────────────────────────────
export type TwEdit = { remove: string[]; add: string[]; keyframes?: { name: string; css: string }; notes: string[] }
export type TwContext = {
  ver: TwVersion
  timing: TwClass[] // the element's transition/duration/ease/delay classes
  current?: Transition // the element's transition timing as the browser has it now
  others: Anim[] // the element's other CSS state animations (their properties must stay in transition-property)
  old?: { anim: Anim; classes: TwClass[] } // the animation being edited, and the classes behind it
  name?: string // @keyframes name, for animations with steps
}
export function keyframesCss(name: string, frames: Frame[]) {
  const body = frames.map(f => `  ${r4(f.at * 100)}% { ${Object.entries(valuesToCss(f.values)).map(([p, v]) => `${p}: ${v};`).join(' ')} }`).join('\n')
  return `@keyframes ${name} {\n${body}\n}`
}
const timingKind = (c: TwClass) => c.utility.split('-')[0]
/** Class edits that write `a`. Values that didn't change keep the class they were written with. */
export function tailwindEdits(a: Anim, ctx: TwContext): TwEdit {
  const notes: string[] = [], remove = new Set<string>(), add: string[] = []
  if (a.trigger === 'inView') return { remove: [], add: [], notes: ['Tailwind can’t start an animation when an element scrolls into view: that needs JavaScript. Write it with Motion instead.'] }
  const oldCls = ctx.old?.classes ?? []
  const was = oldCls.find(c => c.trigger === a.trigger || /^animate-/.test(c.utility))
  const scope = was?.scope ?? ''
  const wasSteps = oldCls.some(c => /^animate-/.test(c.utility))
  const steps = a.frames.length > 2 || a.trigger === 'loop' || (a.trigger === 'enter' && ctx.ver === 3) || wasSteps

  if (steps) {
    // a sequence: @keyframes plus one animate-[…] class (the shorthand keeps it to one class, in v3 and v4)
    const name = ctx.name ?? `${a.trigger}-${Math.abs(hash(JSON.stringify(a.frames))).toString(36).slice(0, 5)}`
    const t = transitionCss(a.transition)
    const reps = a.transition.repeat === Infinity || (a.trigger === 'loop' && a.transition.repeat === undefined) ? 'infinite' : String((Number(a.transition.repeat) || 0) + 1)
    const dir = a.transition.repeatType === 'reverse' || a.transition.repeatType === 'mirror' ? 'alternate' : ''
    const value = [name, `${t.durationMs}ms`, t.easing, t.delayMs ? `${t.delayMs}ms` : '', reps === '1' ? '' : reps, dir, a.trigger === 'enter' ? 'both' : ''].filter(Boolean).join(' ')
    const prefix = scope + (a.trigger === 'loop' || a.trigger === 'enter' ? '' : (was?.via || TRIGGERS[a.trigger].variant) + ':')
    for (const c of oldCls) remove.add(c.cls)
    add.push(`${prefix}animate-[${arbEsc(value)}]`)
    // a class that stays the same isn't taken off and put back (only the @keyframes changed)
    return { remove: [...remove].filter(c => !add.includes(c)), add: add.filter(c => !oldCls.some(o => o.cls === c)), keyframes: { name, css: keyframesCss(name, filled(a)) }, notes }
  }

  const isEnter = a.trigger === 'enter'
  const prefix = scope + (was?.via || TRIGGERS[a.trigger].variant) + ':'
  const stateNow = isEnter ? a.frames[0].values : a.frames.at(-1)!.values, baseNow = isEnter ? a.frames.at(-1)!.values : a.frames[0].values
  const old = ctx.old?.anim
  const stateWas = old ? (isEnter ? old.frames[0].values : old.frames.at(-1)!.values) : {}, baseWas = old ? (isEnter ? old.frames.at(-1)!.values : old.frames[0].values) : {}
  const tokensFor = (k: string) => oldCls.filter(c => c.trigger === a.trigger && tokenKeys(c.utility).includes(k))
  for (const [k, v] of Object.entries(stateNow)) {
    const toks = tokensFor(k)
    if (toks.length && sameValue(stateWas[k], v)) continue // unchanged: hover:shadow-lg stays hover:shadow-lg
    toks.forEach(c => remove.add(c.cls))
    const u = utilityFor(k, v, ctx.ver)
    if (u) add.push(prefix + u); else notes.push(`${k}: ${v} has no Tailwind utility`)
  }
  for (const k of Object.keys(stateWas)) if (!(k in stateNow)) tokensFor(k).forEach(c => remove.add(c.cls))
  // rest values only when they were set on purpose (new, or changed): the element's own classes already say the rest
  for (const [k, v] of Object.entries(baseNow)) {
    if (old ? sameValue(baseWas[k], v) : sameValue(IDENTITY[k], v)) continue
    const u = utilityFor(k, v, ctx.ver)
    if (u) add.push(scope + u)
  }

  // timing is shared by every CSS state change on the element: one transition-property, duration, easing
  const need = cssPropsOf([...Object.keys(stateNow), ...ctx.others.flatMap(keysOf)])
  const tp = ctx.timing.filter(c => timingKind(c) === 'transition')
  const covered = new Set<string>(), all = tp.some(c => transitionCovers(c.utility) === '*')
  for (const c of tp) { const cov = transitionCovers(c.utility); if (Array.isArray(cov)) cov.forEach(p => covered.add(p)) }
  if (covered.has('transform')) ['translate', 'scale', 'rotate'].forEach(p => covered.add(p))
  if (!all && !need.every(p => covered.has(p))) { tp.forEach(c => remove.add(c.cls)); add.push(transitionClass([...covered, ...need])) }
  const now = transitionCss(a.transition), before = ctx.current ? transitionCss(ctx.current) : null
  const swap = (kind: string, cls: string | null) => { ctx.timing.filter(c => timingKind(c) === kind).forEach(c => remove.add(c.cls)); if (cls) add.push(cls) }
  const twCls = (prop: string, v: string) => { const r = cssToTailwind(prop, v, ctx.ver); return 'cls' in r ? r.cls : null }
  if (!before || before.durationMs !== now.durationMs) swap('duration', twCls('transition-duration', `${now.durationMs}ms`))
  if (!before || before.easing.replace(/\s+/g, '') !== now.easing.replace(/\s+/g, '')) swap('ease', twCls('transition-timing-function', now.easing))
  if ((before?.delayMs ?? 0) !== now.delayMs) swap('delay', now.delayMs ? twCls('transition-delay', `${now.delayMs}ms`) : null)
  if (isEnter && ctx.ver === 4) notes.push('Plays when the element first appears (CSS @starting-style, Tailwind’s starting:).')
  return { remove: [...remove].filter(c => !add.includes(c)), add: add.filter(c => !oldCls.some(o => o.cls === c) || remove.has(c)), notes }
}
function hash(s: string) { let h = 0; for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) | 0; return h }

// ── show ────────────────────────────────────────────────────────────────────
const pct = (n: number) => `${r4(n * 100)}%`
/** rgb()/rgba() as #hex, so colours read the way people write them. */
export function shortColor(v: Value): string {
  const m = /^rgba?\((\d+),\s*(\d+),\s*(\d+)(?:,\s*([\d.]+))?\)$/.exec(String(v).trim())
  if (!m) return String(v)
  const hex = '#' + [m[1], m[2], m[3]].map(x => (+x).toString(16).padStart(2, '0')).join('')
  return m[4] !== undefined && +m[4] < 1 ? `${hex} at ${Math.round(+m[4] * 100)}%` : hex
}
const COLOR_KEYS = /^(backgroundColor|color|borderColor|outlineColor|textDecorationColor|fill|stroke)$/
const LABEL: Record<string, string> = { backgroundColor: 'background', color: 'text colour', borderColor: 'border colour', boxShadow: 'shadow', borderRadius: 'corner radius', filter: 'filter', outlineColor: 'outline' }
function phrase(k: string, f: Value | undefined, t: Value): string {
  if (typeof t === 'number' && (typeof f === 'number' || f === undefined)) {
    const from = f ?? IDENTITY[k] as number ?? 0, d = r4(t - from)
    if (k === 'opacity') return from === 0 && t > 0 ? (t === 1 ? 'fades in' : `fades in to ${pct(t)}`) : t === 0 ? 'fades out' : `opacity ${from} → ${t}`
    if (k === 'y') return d < 0 ? `rises ${-d}px` : d > 0 ? `drops ${d}px` : 'y stays'
    if (k === 'x') return d > 0 ? `slides ${d}px right` : d < 0 ? `slides ${-d}px left` : 'x stays'
    if (/^scale/.test(k)) return t > from ? (t === 1 ? `scales up from ${pct(from)}` : `grows to ${pct(t)}`) : t < from ? (t === 1 ? `settles to 100%` : `shrinks to ${pct(t)}`) : 'scale stays'
    if (k === 'rotate') return `turns ${d}°`
    return `${k} ${from} → ${t}`
  }
  if (k === 'filter') {
    const blur = (s: Value | undefined) => (s === undefined ? 0 : parseFloat(/blur\(([^)]+)\)/.exec(String(s))?.[1] ?? '0'))
    if (/blur/.test(String(t)) || /blur/.test(String(f))) return blur(t) < blur(f) ? 'unblurs' : 'blurs'
  }
  if (COLOR_KEYS.test(k)) return `${LABEL[k] ?? kebab(k)} turns ${shortColor(t)}`
  return `${LABEL[k] ?? kebab(k)} changes`
}
/** One sentence for an animation: what moves, then how ("rises 8px and fades in · spring 0.3s"). */
export function describe(a: Anim, rest: Values = {}): string {
  const keys = keysOf(a)
  if (!keys.length) return `nothing set yet · ${timingText(a.transition)}`
  let parts: string[]
  if (a.frames.length > 2) {
    const full = filled(a, rest)
    // a key that never changes (x stays 0 while y floats) isn't part of the story
    const moving = keys.filter(k => full.some(f => !sameValue(f.values[k], full[0].values[k])))
    parts = (moving.length ? moving : keys).map(k => `${LABEL[k] ?? k} ${full.map(f => (f.values[k] === undefined ? '…' : COLOR_KEYS.test(k) ? shortColor(f.values[k]) : f.values[k])).join(' → ')}`)
  } else {
    const from = a.frames[0].values, to = a.frames.at(-1)!.values
    parts = keys.filter(k => k in to).map(k => phrase(k, from[k] ?? rest[k], to[k]))
    if (!parts.length) parts = keys.map(k => `${LABEL[k] ?? k} set`)
  }
  const text = parts.length > 1 ? `${parts.slice(0, -1).join(', ')} and ${parts.at(-1)}` : parts[0]
  return `${text} · ${timingText(a.transition)}`
}
/** A Web Animations preview: plays it once on the element (a gesture goes in, holds, comes back). */
export function toWaapi(a: Anim, rest: Values = {}): { keyframes: Keyframe[]; options: KeyframeAnimationOptions } {
  const t = transitionCss(a.transition), full = filled(a, rest)
  const kf = (v: Values, offset: number, easing?: string): Keyframe => ({ ...Object.fromEntries(Object.entries(valuesToCss(v)).map(([p, x]) => [camel(p), x])), offset, ...(easing ? { easing } : {}) })
  const gesture = a.trigger === 'hover' || a.trigger === 'press' || a.trigger === 'focus'
  if (gesture && full.length === 2) {
    const d = Math.max(t.durationMs, 1), hold = 400, total = d * 2 + hold
    const restV = { ...full[0].values }
    for (const k of Object.keys(full[1].values)) if (!(k in restV)) restV[k] = rest[k] ?? IDENTITY[k] ?? full[1].values[k]
    return { keyframes: [kf(restV, 0, t.easing), kf(full[1].values, d / total), kf(full[1].values, (d + hold) / total, t.easing), kf(restV, 1)], options: { duration: total, easing: 'linear' } }
  }
  const reps = a.transition.repeat === Infinity || a.trigger === 'loop' ? 3 : (Number(a.transition.repeat) || 0) + 1
  const dir: PlaybackDirection = a.transition.repeatType === 'reverse' || a.transition.repeatType === 'mirror' ? 'alternate' : 'normal'
  return { keyframes: full.map(f => kf(f.values, f.at)), options: { duration: Math.max(t.durationMs, 1), easing: t.easing, delay: t.delayMs, iterations: reps, direction: dir } }
}

// ── presets: starting points (all of it editable afterwards) ────────────────
const SPRING_IN: Transition = { type: 'spring', visualDuration: 0.3, bounce: 0 } // settles without a wobble
const OUT: Transition = { duration: 0.15, ease: [0, 0, 0.2, 1] }
export const PRESETS: { name: string; anim: Anim }[] = [
  { name: 'Fade in', anim: { trigger: 'enter', frames: fromTo({ opacity: 0 }, { opacity: 1 }), transition: { duration: 0.3, ease: [0, 0, 0.2, 1] } } },
  { name: 'Slide up', anim: { trigger: 'enter', frames: fromTo({ opacity: 0, y: 8 }, { opacity: 1, y: 0 }), transition: SPRING_IN } },
  { name: 'Scale in', anim: { trigger: 'enter', frames: fromTo({ opacity: 0, scale: 0.95 }, { opacity: 1, scale: 1 }), transition: SPRING_IN } },
  { name: 'Icon swap', anim: { trigger: 'enter', frames: fromTo({ opacity: 0, scale: 0.25, filter: 'blur(4px)' }, { opacity: 1, scale: 1, filter: 'blur(0px)' }), transition: SPRING_IN } },
  { name: 'Press', anim: { trigger: 'press', frames: fromTo({}, { scale: 0.96 }), transition: OUT } },
  { name: 'Hover lift', anim: { trigger: 'hover', frames: fromTo({}, { y: -2 }), transition: OUT } },
  { name: 'Reveal on scroll', anim: { trigger: 'inView', frames: fromTo({ opacity: 0, y: 16 }, { opacity: 1, y: 0 }), transition: { type: 'spring', visualDuration: 0.5, bounce: 0 } } },
  { name: 'Float', anim: { trigger: 'loop', frames: [{ at: 0, values: { y: 0 } }, { at: 0.5, values: { y: -4 } }, { at: 1, values: { y: 0 } }], transition: { duration: 3, ease: 'easeInOut', repeat: Infinity } } },
  { name: 'Pulse', anim: { trigger: 'loop', frames: [{ at: 0, values: { opacity: 1 } }, { at: 0.5, values: { opacity: 0.5 } }, { at: 1, values: { opacity: 1 } }], transition: { duration: 2, ease: 'easeInOut', repeat: Infinity } } },
]
/** A saved preset is untrusted JSON (a file anyone can edit): keep only well-formed animations. */
export function sanitizeAnim(x: unknown): Anim | null {
  if (!isObj(x) || typeof x.trigger !== 'string' || !(x.trigger in TRIGGERS) || !Array.isArray(x.frames) || x.frames.length < 2) return null
  const frames: Frame[] = []
  for (const f of x.frames) {
    if (!isObj(f) || typeof f.at !== 'number' || !isObj(f.values)) return null
    const values: Values = {}
    for (const [k, v] of Object.entries(f.values)) if (/^[a-zA-Z]+$/.test(k) && (typeof v === 'number' || typeof v === 'string')) values[k] = v
    frames.push({ at: Math.min(1, Math.max(0, f.at)), values })
  }
  const transition: Transition = {}
  if (isObj(x.transition)) for (const [k, v] of Object.entries(x.transition)) if (TRANSITION_KEYS.has(k) && k !== 'times' && (typeof v === 'number' || typeof v === 'string' || typeof v === 'boolean' || (Array.isArray(v) && v.every(n => typeof n === 'number')))) transition[k] = v
  return { trigger: x.trigger as Trigger, frames: frames.sort((p, q) => p.at - q.at), transition }
}
