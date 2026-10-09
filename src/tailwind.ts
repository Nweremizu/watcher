// CSS declarations → Tailwind utilities, and merging them into an existing className.
// Used by the Vite plugin when writing inspector edits back to source.

export type TwVersion = 3 | 4
export type Mapped = { prop: string; value: string; cls: string }
export type Skipped = { prop: string; value: string; reason: string }

const px = (v: string) => { const m = /^(-?\d*\.?\d+)px$/.exec(v.trim()); return m ? +m[1] : null }
/** Arbitrary value: spaces become underscores, as Tailwind expects. */
const arb = (v: string) => `[${v.trim().replace(/\s*,\s*/g, ',').replace(/\s+/g, '_')}]`

/** Spacing scale: 4px steps (plus the 0.5/1.5/2.5/3.5 half steps), `px` for 1px, arbitrary otherwise. */
function spacing(prefix: string, v: string, allowNeg: boolean): string | null {
  const t = v.trim()
  if (t === 'auto') return `${prefix}-auto`
  const n = px(t)
  if (n === null) return /^-?\d*\.?\d+(%|rem|em|vh|vw)$/.test(t) ? `${prefix}-${arb(t)}` : null
  if (n < 0 && !allowNeg) return null
  const neg = n < 0 ? '-' : '', a = Math.abs(n), q = a / 4
  if (a === 0) return `${prefix}-0`
  if (a === 1) return `${neg}${prefix}-px`
  return Number.isInteger(q) || [0.5, 1.5, 2.5, 3.5].includes(q) ? `${neg}${prefix}-${q}` : `${neg}${prefix}-[${a}px]`
}
function size(prefix: string, v: string): string | null {
  const t = v.trim()
  const named: Record<string, string> = { auto: 'auto', '100%': 'full', 'fit-content': 'fit', 'min-content': 'min', 'max-content': 'max', '100vw': 'screen', '100vh': 'screen' }
  if (named[t]) return `${prefix}-${named[t]}`
  return spacing(prefix, t, false)
}

// colour utilities share their prefix with non-colour ones (text-lg, bg-cover, border-2…)
const NONCOLOR: Record<string, Set<string>> = {
  text: new Set(['xs', 'sm', 'base', 'lg', 'xl', 'left', 'center', 'right', 'justify', 'start', 'end', 'wrap', 'nowrap', 'balance', 'pretty', 'ellipsis', 'clip']),
  bg: new Set(['clip', 'origin', 'repeat', 'no', 'fixed', 'local', 'scroll', 'cover', 'contain', 'auto', 'center', 'top', 'bottom', 'left', 'right', 'none', 'gradient', 'linear', 'radial', 'conic', 'blend', 'size', 'position']),
  border: new Set(['solid', 'dashed', 'dotted', 'double', 'hidden', 'none', 'collapse', 'separate', 'x', 'y', 't', 'r', 'b', 'l', 's', 'e', 'spacing']),
}
const colorFamily = (prefix: string) => (cls: string) => {
  if (!cls.startsWith(prefix + '-')) return false
  const rest = cls.slice(prefix.length + 1)
  if (rest.startsWith('[')) return /^\[(#|rgb|hsl|oklch|oklab|lab\(|lch|color\(|var\(--)/.test(rest)
  if (rest.startsWith('(')) return !rest.startsWith('(length:') // text-(--brand); text-(length:--x) is a size
  return /^[a-z]+(-[a-z]+)*(-\d{2,3})?(\/\d+)?$/.test(rest) && !NONCOLOR[prefix].has(rest.split('-')[0]) && !/^\d?xl$/.test(rest)
}
const color = (prefix: string): Rule => ({
  cls: v => (v === 'transparent' ? `${prefix}-transparent` : `${prefix}-${arb(v)}`),
  family: colorFamily(prefix),
})

const FONT: Record<number, string> = { 12: 'xs', 14: 'sm', 16: 'base', 18: 'lg', 20: 'xl', 24: '2xl', 30: '3xl', 36: '4xl', 48: '5xl', 60: '6xl', 72: '7xl', 96: '8xl', 128: '9xl' }
const WEIGHT: Record<string, string> = { 100: 'thin', 200: 'extralight', 300: 'light', 400: 'normal', 500: 'medium', 600: 'semibold', 700: 'bold', 800: 'extrabold', 900: 'black' }
// radius names that mean the same px in v3 and v4; anything else goes arbitrary
const RADIUS: Record<number, string> = { 0: 'none', 6: 'md', 8: 'lg', 12: 'xl', 16: '2xl', 24: '3xl' }

type Rule = { cls: (v: string, ver: TwVersion) => string | null; family: (cls: string) => boolean }

// motion: durations, delays, easing curves and which properties transition
const ms = (v: string) => { const m = /^(-?\d*\.?\d+)(ms|s)$/.exec(v.trim()); return m ? Math.round(+m[1] * (m[2] === 's' ? 1000 : 1)) : null }
const DURATIONS3 = [0, 75, 100, 150, 200, 300, 500, 700, 1000] // v3's scale; v4 takes any number
const hasList = (v: string) => { let d = 0; for (const ch of v) { if (ch === '(') d++; else if (ch === ')') d--; else if (ch === ',' && !d) return true } return false }
const time = (prefix: string): Rule => ({
  cls: (v, ver) => { const n = hasList(v) ? null : ms(v); return n === null || n < 0 ? null : ver === 4 || DURATIONS3.includes(n) ? `${prefix}-${n}` : `${prefix}-[${n}ms]` },
  family: (c: string) => new RegExp(`^${prefix}-(\\d+|\\[[^\\]]+\\])$`).test(c),
})
/** "cubic-bezier(.4,0,.2,1)" and "cubic-bezier(0.4, 0, 0.2, 1)" are the same curve. */
export const normEase = (v: string) => v.trim().replace(/cubic-bezier\(([^)]*)\)/, (_, a: string) => `cubic-bezier(${a.split(',').map(n => +n).join(', ')})`)
const EASES: Record<string, string> = { // Tailwind's own curves (same in v3 and v4); CSS's ease-in/ease-out keywords are different curves
  linear: 'ease-linear', 'cubic-bezier(0.4, 0, 1, 1)': 'ease-in', 'cubic-bezier(0, 0, 0.2, 1)': 'ease-out', 'cubic-bezier(0.4, 0, 0.2, 1)': 'ease-in-out',
}
const COLORS_T = ['color', 'background-color', 'border-color', 'outline-color', 'text-decoration-color', 'fill', 'stroke']
const same = (a: string[], b: string[]) => a.length === b.length && a.every(x => b.includes(x))
function transitionProperty(v: string) {
  const t = v.trim()
  if (t === 'none') return 'transition-none'
  if (t === 'all') return 'transition-all'
  const set = t.split(/\s*,\s*/).filter(p => !p.startsWith('--tw-'))
  if (same(set, ['opacity'])) return 'transition-opacity'
  if (same(set, ['box-shadow'])) return 'transition-shadow'
  if (same(set, ['transform', 'translate', 'scale', 'rotate']) || same(set, ['transform'])) return 'transition-transform'
  if (same(set, COLORS_T)) return 'transition-colors'
  return `transition-[${set.join(',')}]`
}
/** Tailwind has no animation-duration utilities, so those become arbitrary properties: [animation-duration:300ms]. */
const arbProp = (prop: string): Rule => ({
  cls: v => `[${prop}:${v.trim().replace(/\s*,\s*/g, ',').replace(/\s+/g, '_')}]`,
  family: (c: string) => c.startsWith(`[${prop}:`),
})
const re = (r: RegExp) => (c: string) => r.test(c)
const sp = (p: string, neg = false): Rule => ({ cls: v => spacing(p, v, neg), family: re(new RegExp(`^-?${p}-`)) })
const keyword = (map: Record<string, string>, family: RegExp): Rule => ({ cls: v => map[v.trim()] ?? null, family: re(family) })

const RULES: Record<string, Rule> = {
  'padding-top': sp('pt'), 'padding-right': sp('pr'), 'padding-bottom': sp('pb'), 'padding-left': sp('pl'), padding: sp('p'),
  'margin-top': sp('mt', true), 'margin-right': sp('mr', true), 'margin-bottom': sp('mb', true), 'margin-left': sp('ml', true), margin: sp('m', true),
  gap: { cls: v => spacing('gap', v, false), family: re(/^gap-(?![xy]-)/) },
  'row-gap': sp('gap-y'), 'column-gap': sp('gap-x'),
  width: { cls: v => size('w', v), family: re(/^w-/) },
  height: { cls: v => size('h', v), family: re(/^h-/) },
  'min-width': { cls: v => size('min-w', v), family: re(/^min-w-/) },
  'max-width': { cls: v => (v === 'none' ? 'max-w-none' : size('max-w', v)), family: re(/^max-w-/) },
  'font-size': {
    cls: v => { const n = px(v); return n !== null && FONT[n] ? `text-${FONT[n]}` : `text-${arb(v)}` },
    family: re(/^text-(xs|sm|base|lg|[2-9]?xl|\[-?\d*\.?\d+(px|rem|em)\]|\(length:--[\w-]+\)|\[length:var\(--[\w-]+\)\])$/),
  },
  'font-weight': { cls: v => `font-${WEIGHT[v.trim()] ?? arb(v)}`, family: re(/^font-(thin|extralight|light|normal|medium|semibold|bold|extrabold|black|\[\d+\]|\(--[\w-]+\)|\[var\(--[\w-]+\)\])$/) },
  'line-height': { cls: v => (v === 'normal' ? 'leading-normal' : `leading-${arb(v)}`), family: re(/^leading-/) },
  'letter-spacing': { cls: v => (v === 'normal' ? 'tracking-normal' : `tracking-${arb(v)}`), family: re(/^tracking-/) },
  'text-align': keyword({ start: 'text-start', left: 'text-left', center: 'text-center', right: 'text-right', justify: 'text-justify', end: 'text-end' }, /^text-(left|center|right|justify|start|end)$/),
  color: color('text'), 'background-color': color('bg'), 'border-color': color('border'),
  'border-radius': {
    cls: v => { const n = px(v); if (v.trim() === '9999px' || v.trim() === '50%') return 'rounded-full'; return n !== null && RADIUS[n] ? `rounded-${RADIUS[n]}` : `rounded-${arb(v)}` },
    family: re(/^rounded(-(none|xs|sm|md|lg|[2-4]?xl|full|\[[^\]]+\]|\([^)]+\)))?$/),
  },
  'border-width': {
    cls: v => { const n = px(v); return n === 0 ? 'border-0' : n === 1 ? 'border' : n !== null && [2, 4, 8].includes(n) ? `border-${n}` : `border-${arb(v)}` },
    family: re(/^border(-(0|2|4|8|\[[\d.]+px\]))?$/),
  },
  'border-style': keyword({ solid: 'border-solid', dashed: 'border-dashed', dotted: 'border-dotted', double: 'border-double', none: 'border-none', hidden: 'border-hidden' }, /^border-(solid|dashed|dotted|double|hidden|none)$/),
  opacity: {
    cls: (v, ver) => { const p = Math.round(parseFloat(v) * 100); return isNaN(p) ? null : ver === 4 || p % 5 === 0 ? `opacity-${p}` : `opacity-${arb(v)}` },
    family: re(/^opacity-/),
  },
  display: keyword({ block: 'block', inline: 'inline', 'inline-block': 'inline-block', flex: 'flex', 'inline-flex': 'inline-flex', grid: 'grid', 'inline-grid': 'inline-grid', contents: 'contents', none: 'hidden' },
    /^(block|inline|inline-block|flex|inline-flex|grid|inline-grid|contents|hidden|table|flow-root)$/),
  position: keyword({ static: 'static', relative: 'relative', absolute: 'absolute', fixed: 'fixed', sticky: 'sticky' }, /^(static|relative|absolute|fixed|sticky)$/),
  'flex-direction': keyword({ row: 'flex-row', column: 'flex-col', 'row-reverse': 'flex-row-reverse', 'column-reverse': 'flex-col-reverse' }, /^flex-(row|col)(-reverse)?$/),
  'flex-wrap': keyword({ wrap: 'flex-wrap', nowrap: 'flex-nowrap', 'wrap-reverse': 'flex-wrap-reverse' }, /^flex-(wrap|nowrap|wrap-reverse)$/),
  'justify-content': keyword({ 'flex-start': 'justify-start', start: 'justify-start', center: 'justify-center', 'flex-end': 'justify-end', end: 'justify-end', 'space-between': 'justify-between', 'space-around': 'justify-around', 'space-evenly': 'justify-evenly', normal: 'justify-normal', stretch: 'justify-stretch' },
    /^justify-(start|end|center|between|around|evenly|normal|stretch)$/),
  'align-items': keyword({ 'flex-start': 'items-start', start: 'items-start', center: 'items-center', 'flex-end': 'items-end', end: 'items-end', baseline: 'items-baseline', stretch: 'items-stretch', normal: 'items-stretch' }, /^items-/),
  'z-index': {
    cls: (v, ver) => { if (v === 'auto') return 'z-auto'; const n = parseInt(v); return isNaN(n) ? null : (ver === 4 || n % 10 === 0) && n >= 0 && n <= (ver === 4 ? 9999 : 50) ? `z-${n}` : `z-[${n}]` },
    family: re(/^-?z-/),
  },
  rotate: {
    cls: (v, ver) => { const m = /^(-?\d*\.?\d+)deg$/.exec(v.trim()); if (!m) return v === 'none' ? 'rotate-0' : null; const n = +m[1], neg = n < 0 ? '-' : '', a = Math.abs(n); return (ver === 4 && Number.isInteger(a)) || [0, 1, 2, 3, 6, 12, 45, 90, 180].includes(a) ? `${neg}rotate-${a}` : `rotate-[${n}deg]` },
    family: re(/^-?rotate-/),
  },
  'box-shadow': { cls: v => (v === 'none' ? 'shadow-none' : `shadow-${arb(v)}`), family: re(/^shadow(-|$)/) },
  'transition-property': { cls: transitionProperty, family: re(/^transition(-|$)/) },
  'transition-duration': time('duration'), 'transition-delay': time('delay'),
  'transition-timing-function': { cls: v => (hasList(v) ? null : EASES[normEase(v)] ?? `ease-${arb(v)}`), family: re(/^ease-/) },
  'animation-duration': arbProp('animation-duration'), 'animation-delay': arbProp('animation-delay'),
  'animation-timing-function': arbProp('animation-timing-function'), 'animation-iteration-count': arbProp('animation-iteration-count'),
  'animation-direction': arbProp('animation-direction'), 'animation-fill-mode': arbProp('animation-fill-mode'),
}

const WHY: Record<string, string> = {
  translate: 'a drag offset, not a design value: use margin or layout instead',
  left: 'canvas-mode position', top: 'canvas-mode position', right: 'canvas-mode position', bottom: 'canvas-mode position',
}

// design tokens: var(--color-brand) → text-brand (a theme variable has a named utility), var(--brand) → text-(--brand)
const SPACE: Record<string, string> = {
  'padding-top': 'pt', 'padding-right': 'pr', 'padding-bottom': 'pb', 'padding-left': 'pl', padding: 'p',
  'margin-top': 'mt', 'margin-right': 'mr', 'margin-bottom': 'mb', 'margin-left': 'ml', margin: 'm', gap: 'gap', 'row-gap': 'gap-y', 'column-gap': 'gap-x',
}
const TOKEN: Record<string, [prefix: string, namespace: string, hint?: string]> = {
  color: ['text', 'color'], 'background-color': ['bg', 'color'], 'border-color': ['border', 'color'],
  'font-size': ['text', 'text', 'length'], 'font-weight': ['font', 'font-weight'], 'line-height': ['leading', 'leading'],
  'letter-spacing': ['tracking', 'tracking'], 'border-radius': ['rounded', 'radius'], 'box-shadow': ['shadow', 'shadow'],
  'transition-timing-function': ['ease', 'ease'],
  ...Object.fromEntries(Object.entries(SPACE).map(([p, pre]) => [p, [pre, 'spacing']])),
}
function tokenClass(prop: string, name: string, ver: TwVersion) {
  const t = TOKEN[prop]
  if (!t) return null
  const [prefix, ns, hint] = t
  const named = new RegExp(`^--${ns}-([\\w-]+)$`).exec(name)?.[1]
  if (ver === 4 && named && !named.includes('--')) return `${prefix}-${named}`
  return ver === 4 ? `${prefix}-(${hint ? hint + ':' : ''}${name})` : `${prefix}-[${hint ? hint + ':' : ''}var(${name})]`
}

export function cssToTailwind(prop: string, value: string, ver: TwVersion = 4): { cls: string } | { reason: string } {
  const rule = RULES[prop]
  if (!rule) return { reason: WHY[prop] ?? `no Tailwind mapping for ${prop}` }
  const v = /^var\((--[\w-]+)\)$/.exec(value.trim())
  if (v) { const cls = tokenClass(prop, v[1], ver) ?? rule.cls(value, ver); return cls ? { cls } : { reason: `no token utility for ${prop}` } }
  const cls = rule.cls(value, ver)
  return cls ? { cls } : { reason: `can't express ${prop}: ${value} as a utility` }
}

/** Replace utilities for each edited property in `className`. `variant` like 'md:' scopes both removal and the new class. */
export function mergeClasses(className: string, styles: Record<string, string>, variant = '', ver: TwVersion = 4) {
  let tokens = className.split(/\s+/).filter(Boolean)
  const mapped: Mapped[] = [], skipped: Skipped[] = []
  for (const [prop, value] of Object.entries(styles)) {
    const r = cssToTailwind(prop, value, ver)
    if ('reason' in r) { skipped.push({ prop, value, reason: r.reason }); continue }
    const family = RULES[prop].family
    // only touch classes with exactly this variant (keep hover:, md: etc. when editing the base, and vice versa);
    // a variant's colon comes before any bracket, so text-(length:--x) and bg-[url(a:b)] have none
    tokens = tokens.filter(t => !(t.startsWith(variant) && !/^[^[(]*:/.test(t.slice(variant.length)) && family(t.slice(variant.length))))
    tokens.push(variant + r.cls)
    mapped.push({ prop, value, cls: variant + r.cls })
  }
  return { className: tokens.join(' '), mapped, skipped }
}

// ── presets: adding utilities ───────────────────────────────────────────────
// what each transition-* utility transitions (Tailwind's defaults, same in v3 and v4)
const TRANSITION_SETS: Record<string, string[]> = {
  'transition-colors': COLORS_T, 'transition-opacity': ['opacity'], 'transition-shadow': ['box-shadow'],
  'transition-transform': ['transform', 'translate', 'scale', 'rotate'],
}
const transitionSet = (c: string) => TRANSITION_SETS[c] ?? /^transition-\[([^\]]+)\]$/.exec(c)?.[1].split(',')
/** "transition-shadow" + "transition-transform" → "transition-[box-shadow,transform,translate,scale,rotate]";
 *  plain `transition` and `transition-all` already cover everything a preset moves. */
function unionTransition(a: string, b: string) {
  if (a === 'transition' || a === 'transition-all' || b === 'transition-none') return a
  const x = transitionSet(a), y = transitionSet(b)
  if (!x || !y) return b
  const all = [...new Set([...x, ...y])]
  return Object.entries(TRANSITION_SETS).find(([, set]) => same(set, all))?.[0] ?? `transition-[${all.join(',')}]`
}
/** The slot a utility fills: its variants plus its root ("hover:-translate-y-0.5" → "hover:translate-y"). */
const slot = (c: string) => { const m = /^((?:[^:[\]()]+:)*)-?([a-z]+(?:-[xy](?=-|$))?)/.exec(c); return m ? m[1] + m[2] : c }
/** Add utilities from a preset to a className: each replaces whatever fills the same slot (duration-150 → duration-300). */
export function addClasses(className: string, add: string[]) {
  let tokens = className.split(/\s+/).filter(Boolean)
  for (const c of add) {
    const old = tokens.find(t => slot(t) === slot(c))
    const next = old && slot(c) === 'transition' ? unionTransition(old, c) : c
    tokens = tokens.filter(t => slot(t) !== slot(c))
    tokens.push(next)
  }
  return tokens.join(' ')
}
/** What a transition utility transitions: a property list, '*' for everything (transition, transition-all), or null. */
export function transitionCovers(cls: string): string[] | '*' | null {
  if (cls === 'transition' || cls === 'transition-all') return '*'
  if (cls === 'transition-none') return []
  return transitionSet(cls) ?? null
}
/** The utility for a set of properties: a named one when it matches (transition-opacity), else transition-[a,b]. */
export function transitionClass(props: string[]) {
  const all = [...new Set(props)]
  return Object.entries(TRANSITION_SETS).find(([, set]) => same(set, all))?.[0] ?? `transition-[${all.join(',')}]`
}
