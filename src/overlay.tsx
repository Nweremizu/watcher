/** @watcher-ignore (the Vite plugin must not stamp the overlay itself)
 *
 * Watcher: the overlay itself. Loaded lazily by ./index.ts, never imported by production builds.
 *
 * Alt+D (or the `shortcut` option) toggles it. Edits preview live (inline styles, forced-state rules, prop overrides), are kept per page
 * until applied or discarded, and go back to source through the Code panel (watcher-ui/vite) or Copy CSS.
 */
import { Fragment, memo, useCallback, useEffect, useId, useLayoutEffect, useRef, useState, type CSSProperties, type PointerEvent as RPointerEvent, type ReactNode } from 'react'
import { createPortal } from 'react-dom'
import { createRoot } from 'react-dom/client'
import { parsePath, serializePath, splitSeg, bezAt, shapeD, type PNode, type Sub } from './path'
import { ICONS, ICON_VIEWBOX } from './icons'
import { forceSelectors, hasState, muteSelectors } from './states'
import * as A from './anim'
import { contrast, contrastNeed, deltaE, fixContrast, isLargeText, nearestColor, nearestLength, over, toHex, type RGB, type Token } from './guard'
import { DEFAULT_SHORTCUT, matchesShortcut, parseShortcut, shortcutFromEvent, shortcutLabel, stringifyShortcut, type Shortcut } from './shortcut'

type Tool = 'select' | 'text' | 'draw' | 'hand' | 'rect' | 'pen'
type Guide = { id: number; axis: 'x' | 'y'; pos: number; pattern: 'solid' | 'dashed' | 'dotted'; color?: string; locked?: boolean }
// prop: CSS property, '#text' = innerHTML, '#node' = inserted node, '@name' = attribute (before '\u0000' = was absent)
type Edit = { el: HTMLElement; prop: string; before: string; t: number; imp?: boolean; parent?: Node | null; next?: Node | null; fiber?: Fiber }
type Fiber = { type: unknown; memoizedProps: Record<string, unknown> | null; return: Fiber | null; alternate: Fiber | null; child: Fiber | null; stateNode: unknown }
type Box = { l: number; t: number; w: number; h: number }
type SnapLine = { axis: 'x' | 'y'; pos: number; a: number; b: number }
type Gesture =
  | { k: 'move'; el: HTMLElement; x: number; y: number; x0: number; y0: number; r: Box; cands: Box[]; moved: boolean; fresh?: boolean }
  | { k: 'resize'; el: HTMLElement; dir: string; x: number; y: number; w: number; h: number; x0: number; y0: number; create?: boolean }
  | { k: 'pan'; x: number; y: number }
  | { k: 'draw' }
  | { k: 'node'; el: SVGPathElement; subs: Sub[]; si: number; ni: number; part: 'anchor' | 'in' | 'out'; inv: DOMMatrix; x: number; y: number; orig: PNode }
  | { k: 'bend'; el: SVGPathElement; subs: Sub[]; si: number; i: number; t: number; inv: DOMMatrix; x: number; y: number; p1: [number, number]; p2: [number, number] }

const RULER = 20
const STEPS = [1, 2, 5, 10, 20, 50, 100, 200, 500, 1000, 2000, 5000, 10000]
const SKIP = new Set(['SCRIPT', 'STYLE', 'LINK', 'META', 'NOSCRIPT', 'TEMPLATE', 'BR'])
const TOOL_KEYS: Record<string, Tool> = { v: 'select', t: 'text', p: 'pen', h: 'hand', r: 'rect' }
const SVGNS = 'http://www.w3.org/2000/svg'
const SHAPES = new Set(['path', 'rect', 'circle', 'ellipse', 'line', 'polyline', 'polygon'])
const SHAPE_SEL = [...SHAPES].join(',')
const GEOM = new Set(['d', 'x', 'y', 'width', 'height', 'rx', 'ry', 'cx', 'cy', 'r', 'x1', 'y1', 'x2', 'y2', 'points'])

// ── module state (one overlay per page) ─────────────────────────────────────
let HOST: HTMLElement | null = null
let bump = () => {}

// ── frame bridge ──
// Inside a responsive preview the overlay runs in "frame mode": it draws only the in-page layer (hover,
// selection, handles, measuring) and leaves panels, history and Copy CSS to the Watcher on the page around it.
/** window.name of the preview frames. Duplicated in index.ts, which mustn't import this module. */
const VIEWPORT_NAME = 'watcher-viewport'
type HostEvent = { t: 'select' | 'hover'; el: HTMLElement | null } | { t: 'inspect'; on: boolean } | { t: 'bump' }
type Host = {
  hist: Edit[]; redos: Edit[]; changes: Map<HTMLElement, Set<string>>; inspecting: boolean
  select: (el: HTMLElement | null) => void; bumpHost: () => void
  notify: (msg: string, action?: { label: string; run: () => void }) => void
  listen: (fn: (e: HostEvent) => void) => () => void
}
const FRAME = window.name === VIEWPORT_NAME && window.parent !== window
const parentHost: Host | null = FRAME ? (() => { try { return (window.parent as unknown as { __watcherHost?: Host }).__watcherHost ?? null } catch { return null } })() : null

const vp = { z: 1, x: 0, y: 0 }
const hist: Edit[] = parentHost?.hist ?? []
const changes: Map<HTMLElement, Set<string>> = parentHost?.changes ?? new Map()
const strokes: number[][] = []
const prefs = { spacing: true, snap: true, alwaysMeasure: false, flashUpdates: false, flashShifts: true, persist: true }
try { Object.assign(prefs, JSON.parse(localStorage.getItem('watcher:prefs') ?? '{}')) } catch { /* storage blocked */ }
// the open/close shortcut: this browser's own choice (Settings) beats the app's `shortcut` option, which beats Alt+D
let configShortcut: Shortcut = parseShortcut(DEFAULT_SHORTCUT)!
const OWN_SHORTCUT = 'watcher:shortcut'
const ownShortcut = () => { try { return localStorage.getItem(OWN_SHORTCUT) } catch { return null } }
const activeShortcut = () => { const own = ownShortcut(); return (own && parseShortcut(own)) || configShortcut }
const toggleLabel = () => shortcutLabel(activeShortcut())
let recordingShortcut = false
const savePrefs = () => { try { localStorage.setItem('watcher:prefs', JSON.stringify(prefs)) } catch { /* storage blocked */ } bump() }
// pen: the path being drawn; pe: the path whose anchors are being edited
type PenState = { svg: SVGSVGElement; path: SVGPathElement; subs: Sub[]; drag: boolean }
const pen = { cur: null as PenState | null, hover: null as [number, number] | null }
const pe = { el: null as SVGPathElement | null, node: null as [number, number] | null, view: null as SVGGraphicsElement | null, lastFill: '' }
// svg editor tab: the page svg being edited (shown magnified in the editor), its zoom, and each path's original d
const ed = { svg: null as SVGSVGElement | null, zoom: 0, orig: new Map<Element, string>() }
let notify: (msg: string, action?: { label: string; run: () => void }) => void = () => {}
const UI = { root: null as HTMLElement | null } // portal target for popovers (inside the shadow root)
// profiler flashes (DOM updates / layout shifts), drawn on the stage for 700ms
type Flash = { el?: Element; b: Box; t: number; kind: 'dom' | 'shift' }
const flashes: Flash[] = []

const round = (n: number, d = 1) => +n.toFixed(d)
const fromOverlay = (e: Event) => !!HOST && e.composedPath().includes(HOST)
const origin = () => { const r = document.body.getBoundingClientRect(); return { x: r.left, y: r.top } }
const parseTranslate = (s: string) => {
  if (!s || s === 'none') return [0, 0]
  const [a, b] = s.split(' ').map(parseFloat)
  return [a || 0, b || 0]
}

function applyVP() {
  const s = document.body.style
  if (vp.z === 1 && !vp.x && !vp.y) { s.removeProperty('transform'); s.removeProperty('transform-origin'); return }
  // ponytail: owns <body>'s transform while zoomed; an app that transforms body itself gets overridden until reset
  s.transformOrigin = '0 0'
  s.transform = `translate(${vp.x}px, ${vp.y}px) scale(${vp.z})`
}
function zoomAt(nz: number, cx: number, cy: number) {
  nz = Math.min(16, Math.max(0.05, nz))
  const o = origin(), dx = (cx - o.x) / vp.z, dy = (cy - o.y) / vp.z
  vp.x += cx - nz * dx - o.x
  vp.y += cy - nz * dy - o.y
  vp.z = nz
  applyVP()
}
const resetZoom = () => { Object.assign(vp, { z: 1, x: 0, y: 0 }); applyVP() }

// ── docked layout: address bar on top, sidebars left/right, tabs + toolbar above the canvas ──
const TOPBAR = 40, TABS = 36, TOOLROW = 40, LEFT_W = 248, RIGHT_W = 296
const lay = { l: 0, t: 0, r: 0 } // canvas area insets (left, top incl. tabs + toolbar, right); set every render
/** Put the page "artboard" inside the canvas area: fitted to its width, or at 100%. */
function frame(mode: 'fit' | 'actual') {
  const cs = getComputedStyle(document.body), ml = parseFloat(cs.marginLeft) || 0, mt = parseFloat(cs.marginTop) || 0
  const pageW = document.documentElement.clientWidth
  const ax = lay.l + RULER + 32, ay = lay.t + RULER + 40, avail = innerWidth - lay.r - ax - 32
  const z = mode === 'fit' ? Math.min(1, avail / pageW) : 1
  if (!(z > 0) || !Number.isFinite(z)) return // a 0×0 window (mid-reload, a hidden tab): keep the last good zoom
  const left = ax + Math.max(0, (avail - pageW * z) / 2)
  // <body> scales about its own top-left, which sits at its margin, so page x=0 lands at body.left - margin·z
  vp.z = z
  vp.x = left - ml + ml * z + scrollX
  vp.y = ay - mt + mt * z + scrollY
  applyVP()
}

// ── edits + history ─────────────────────────────────────────────────────────
function track(el: HTMLElement, prop: string) {
  if (!changes.has(el)) changes.set(el, new Set())
  changes.get(el)!.add(prop)
}
/** Coalesces rapid edits of the same prop (typing, scrubbing, dragging) into one undo step. */
const redos: Edit[] = parentHost?.redos ?? []
function pushHist(e: Edit) { hist.push(e); redos.length = 0 }

// host side of the bridge (top page only): preview frames share this history and talk through these
const frameListeners = new Set<(e: HostEvent) => void>()
function emit(e: HostEvent) { for (const fn of frameListeners) { try { fn(e) } catch { frameListeners.delete(fn) } } }
const hostApi: Host = {
  hist, redos, changes, inspecting: true, select: () => {}, bumpHost: () => {},
  notify: (m, a) => notify(m, a),
  listen: fn => { frameListeners.add(fn); return () => { frameListeners.delete(fn) } },
}
if (!FRAME) (window as unknown as { __watcherHost?: Host }).__watcherHost = hostApi
/** Coordinate frame for an element: its own document's body. Only the top page is ever zoomed. */
function ctxOf(el: Element) {
  if (el.ownerDocument === document) return { o: origin(), z: vp.z }
  const r = el.ownerDocument.body.getBoundingClientRect()
  return { o: { x: r.left, y: r.top }, z: 1 }
}
const isSvgEl = (el: Element) => el.namespaceURI === SVGNS // instanceof fails across frames
function record(el: HTMLElement, prop: string, before: () => string, imp = false, fiber?: Fiber) {
  const now = Date.now()
  redos.length = 0
  let e: Edit | undefined
  for (let i = hist.length - 1; i >= Math.max(0, hist.length - 4); i--) if (hist[i].el === el && hist[i].prop === prop) { e = hist[i]; break }
  if (e && now - e.t < 1000) e.t = now
  else hist.push({ el, prop, before: before(), t: now, imp, fiber })
  track(el, prop)
}
function setStyle(el: HTMLElement, prop: string, value: string) {
  record(el, prop, () => el.style.getPropertyValue(prop), el.style.getPropertyPriority(prop) === 'important')
  el.style.setProperty(prop, value, 'important')
  bump()
}
function setAttr(el: Element, name: string, value: string) {
  record(el as HTMLElement, '@' + name, () => el.getAttribute(name) ?? '\u0000')
  if (value === '') el.removeAttribute(name); else el.setAttribute(name, value)
  bump()
}
/** The edit that would undo `restore(e)`, captured before it runs: undo feeds redo and vice versa. */
function invert(e: Edit): Edit {
  const el = e.el
  if (e.prop === '#node') return { ...e, prop: '#unnode', parent: el.parentNode, next: el.nextSibling }
  if (e.prop === '#unnode') return { ...e, prop: '#node' }
  if (e.prop === '#text') return { ...e, before: el.innerHTML }
  if (e.prop[0] === '@') return { ...e, before: el.getAttribute(e.prop.slice(1)) ?? '\u0000' }
  if (e.prop[0] === '%') return { ...e, before: encodeProp(getPath(currentProps(e.fiber!), e.prop.slice(1).split('.'))) }
  if (isStateKey(e.prop)) return { ...e, before: getStateRule(el, e.prop) }
  if (e.prop[0] === '&') { const [n, off, cp] = e.prop.slice(1).split('|'); return { ...e, before: kfRule(el.ownerDocument, n, off, false)?.style.getPropertyValue(cp) || '\u0000' } }
  return { ...e, before: el.style.getPropertyValue(e.prop), imp: el.style.getPropertyPriority(e.prop) === 'important' }
}
function restore(e: Edit) {
  if (e.prop === '#unnode') e.parent?.insertBefore(e.el, e.next?.parentNode === e.parent ? e.next : null)
  else if (e.prop === '#node') e.el.remove()
  else if (e.prop[0] === '@') { const n = e.prop.slice(1); if (e.before === '\u0000') e.el.removeAttribute(n); else e.el.setAttribute(n, e.before) }
  else if (e.prop === '#text') e.el.innerHTML = e.before
  else if (e.prop[0] === '%') writeProp(e.el, e.fiber!, e.prop.slice(1), e.before)
  else if (isStateKey(e.prop)) setStateRule(e.el, e.prop, e.before)
  else if (e.prop[0] === '&') { const [n, off, cp] = e.prop.slice(1).split('|'); writeKeyframe(e.el.ownerDocument, n, off, cp, e.before) }
  else if (e.before) e.el.style.setProperty(e.prop, e.before, e.imp ? 'important' : '')
  else e.el.style.removeProperty(e.prop)
}
function undo() {
  if (cv.on && hist.length <= cv.mark) return // don't undo past the moment the canvas was frozen
  const e = hist.pop()
  if (e) { redos.push(invert(e)); restore(e); bump() }
}
function redo() {
  const e = redos.pop()
  if (e) { hist.push(invert(e)); restore(e); bump() }
}
function resetEdits(el?: HTMLElement) {
  for (let i = hist.length - 1; i >= 0; i--) if (!el || hist[i].el === el) { restore(hist[i]); hist.splice(i, 1) }
  if (el) changes.delete(el); else changes.clear()
  redos.length = 0
  bump()
}
/** Live edits: (element, prop) pairs that still have an undo entry, i.e. that haven't been undone or written to code. */
function liveEdits() {
  const m = new Map<HTMLElement, Set<string>>()
  for (const h of hist) if (h.prop !== '#node' && h.el.isConnected) { if (!m.has(h.el)) m.set(h.el, new Set()); m.get(h.el)!.add(h.prop) }
  return m
}

// ── component props: read from React's fiber, overridden through its DevTools renderer ──
type Renderer = { overrideProps: (f: Fiber, path: string[], v: unknown) => void; overridePropsDeletePath: (f: Fiber, path: string[]) => void }
const fiberOf = (el: Element) => { const k = Object.keys(el).find(k => k.startsWith('__reactFiber$')); return k ? (el as unknown as Record<string, Fiber>)[k] : null }
function typeName(t: unknown): string | null {
  if (!t || typeof t !== 'object' && typeof t !== 'function') return null
  const x = t as { displayName?: string; name?: string; render?: { displayName?: string; name?: string }; type?: { displayName?: string; name?: string } }
  return x.displayName || x.name || x.render?.displayName || x.render?.name || x.type?.displayName || x.type?.name || null
}
/** Nearest named component above `el`. */
function componentFiber(el: Element) { for (let f = fiberOf(el)?.return ?? null; f; f = f.return) if (typeName(f.type)) return f; return null }
/** React keeps two copies of each fiber; the committed one is in the tree that hangs off the root's `current`. */
function currentFiber(f: Fiber) { let r = f; while (r.return) r = r.return; return (r.stateNode as { current?: Fiber } | null)?.current === r ? f : f.alternate ?? f }
const currentProps = (f: Fiber) => currentFiber(f).memoizedProps ?? {}
const hostOf = (f: Fiber) => { for (let c = f.child; c; c = c.child) if (typeof c.type === 'string') return c.stateNode as HTMLElement; return null }
/** The renderer React gave the DevTools hook (installed by watcher-ui/vite, or by the React DevTools extension). */
function renderer(doc: Document): Renderer | null {
  const h = (doc.defaultView as unknown as { __REACT_DEVTOOLS_GLOBAL_HOOK__?: { renderers?: Map<number, Partial<Renderer>> } } | null)?.__REACT_DEVTOOLS_GLOBAL_HOOK__
  for (const r of h?.renderers?.values() ?? []) if (r.overrideProps) return r as Renderer
  return null
}
type Vals = Record<string, unknown>
const isObj = (v: unknown): v is Vals => !!v && typeof v === 'object' && !Array.isArray(v)
/** props.transition.duration for ['transition', 'duration'] */
const getPath = (o: unknown, path: string[]) => path.reduce<unknown>((x, k) => (isObj(x) ? x[k] : undefined), o)
/** A copy of `o` with `path` set (undefined deletes it), sharing everything else. */
function setIn(o: unknown, path: string[], v: unknown): unknown {
  if (!path.length) return v
  const out: Vals = isObj(o) ? { ...o } : {}
  const next = setIn(out[path[0]], path.slice(1), v)
  if (next === undefined) delete out[path[0]]; else out[path[0]] = next
  return out
}
const INF = '__Infinity__' // JSON has no Infinity (Motion's repeat: Infinity), so it travels as this
const toJson = (v: unknown) => JSON.stringify(v, (_, x) => (x === Infinity ? INF : x))
const fromJson = (s: string) => JSON.parse(s, (_, x) => (x === INF ? Infinity : x))
const encodeProp = (v: unknown) => (v === undefined ? '\u0000' : toJson(v))
// React's overrideProps copies from the last *committed* props, so two edits in one tick would drop the first.
// Stage each top-level prop until React has rendered (its sync flush is a microtask queued before ours).
const staged = new Map<Fiber, Vals>()
function writeProp(el: HTMLElement, f: Fiber, name: string, enc: string) {
  const r = renderer(el.ownerDocument)
  if (!r) return
  const cur = currentFiber(f), [head, ...rest] = name.split('.')
  let stage = staged.get(cur)
  if (!stage) { staged.set(cur, (stage = {})); queueMicrotask(() => staged.delete(cur)) }
  const value = enc === '\u0000' ? undefined : fromJson(enc)
  const next = rest.length ? setIn(head in stage ? stage[head] : currentProps(f)[head], rest, value) : value
  stage[head] = next
  if (next === undefined) r.overridePropsDeletePath(cur, [head]); else r.overrideProps(cur, [head], next)
  setTimeout(bump) // React re-renders in a microtask; refresh the inspector after it
}
/** Edit a component prop live. It lasts until the parent re-renders with its own value (as in React DevTools), or you apply it to code. */
function setProp(f: Fiber, host: HTMLElement, name: string, value: unknown) {
  record(host, '%' + name, () => encodeProp(getPath(currentProps(f), name.split('.'))), false, f)
  writeProp(host, f, name, encodeProp(value))
}

// ── forced states: show :hover / :focus / :active without the pointer, and edit them ──
const STATES = ['hover', 'focus', 'active'] as const
type State = (typeof STATES)[number]
const forced = new Map<HTMLElement, State>()
const stateRules = new Map<HTMLElement, Map<string, string>>() // 'hover:color' → value: edits that only apply in that state
const isStateKey = (p: string) => /^[a-z-]+:/.test(p)
const getStateRule = (el: HTMLElement, key: string) => stateRules.get(el)?.get(key) ?? ''
const stateSheets = new WeakMap<Document, { mirror: CSSStyleSheet; edits: CSSStyleSheet }>()
function sheetsOf(doc: Document) {
  let s = stateSheets.get(doc)
  if (!s) {
    const C = doc.defaultView!.CSSStyleSheet // a frame's sheets must come from its own realm
    s = { mirror: new C(), edits: new C() }
    doc.adoptedStyleSheets = [...doc.adoptedStyleSheets, s.mirror, s.edits]
    stateSheets.set(doc, s)
  }
  return s
}
/** Every rule that mentions a state, still wrapped in its @media / @layer / @supports. */
function stateCss(rules: CSSRuleList): string {
  let out = ''
  for (const r of rules) {
    const sub = (r as CSSImportRule).styleSheet
    if (sub) { try { out += stateCss(sub.cssRules) } catch { /* cross-origin */ } continue }
    const t = r.cssText
    if (!hasState(t)) continue
    const kids = (r as CSSGroupingRule).cssRules
    out += 'selectorText' in r || !kids ? t + '\n' : t.slice(0, t.indexOf('{')) + '{\n' + stateCss(kids) + '}\n'
  }
  return out
}
const mirrorCache = new WeakMap<Document, { sig: string; at: number; css: string; applied: string }>()
function applyStates(doc: Document) {
  const s = sheetsOf(doc)
  let css = ''
  const c = mirrorCache.get(doc)
  if ([...forced.keys()].some(el => el.ownerDocument === doc)) {
    // the scan reads every rule's text: reuse it while the stylesheets look the same (and for at most 2s)
    const sig = `${doc.styleSheets.length}:${[...doc.styleSheets].reduce((n, sh) => { try { return n + sh.cssRules.length } catch { return n } }, 0)}`
    if (c && c.sig === sig && performance.now() - c.at < 2000) css = c.css
    else { for (const sh of doc.styleSheets) { try { css += stateCss(sh.cssRules) } catch { /* cross-origin sheet */ } } }
    mirrorCache.set(doc, { sig, at: c && c.sig === sig && c.css === css ? c.at : performance.now(), css, applied: c?.applied ?? '' })
  }
  const text = forceSelectors(css), entry = mirrorCache.get(doc)
  if (!entry || entry.applied !== text) {
    try { s.mirror.replaceSync(text) } catch { /* leave the previous mirror */ }
    if (entry) entry.applied = text; else mirrorCache.set(doc, { sig: '', at: 0, css: '', applied: text })
  }
  for (const e of doc.querySelectorAll('[data-wforce]')) e.removeAttribute('data-wforce')
  const add = (e: Element, t: string) => e.setAttribute('data-wforce', ((e.getAttribute('data-wforce') ?? '') + ' ' + t).trim())
  for (const [el, st] of forced) {
    if (el.ownerDocument !== doc || !el.isConnected) continue
    add(el, st === 'focus' ? 'focus focus-visible focus-within' : st)
    // a real hover or press applies to every ancestor too (group-hover relies on it); focus gives them focus-within
    for (let p = el.parentElement; p; p = p.parentElement) add(p, st === 'focus' ? 'focus-within' : st)
  }
}
function forceState(el: HTMLElement, st: State | null) {
  if (st) forced.set(el, st); else forced.delete(el)
  applyStates(el.ownerDocument)
  bump()
}
function clearForced() { const docs = new Set([...forced.keys()].map(e => e.ownerDocument)); forced.clear(); docs.forEach(applyStates) }
/** State edits live in a stylesheet: [data-wsid="7"]:is(:hover, [data-wforce~="hover"]) { … } */
function setStateRule(el: HTMLElement, key: string, value: string) {
  let m = stateRules.get(el)
  if (!m) stateRules.set(el, (m = new Map()))
  if (value) m.set(key, value); else m.delete(key)
  el.setAttribute('data-wsid', String(idOf(el)))
  const doc = el.ownerDocument
  let css = ''
  for (const [e, rules] of stateRules) {
    if (e.ownerDocument !== doc) continue
    const by = new Map<string, string[]>()
    for (const [k, v] of rules) { const i = k.indexOf(':'); by.set(k.slice(0, i), [...(by.get(k.slice(0, i)) ?? []), `${k.slice(i + 1)}: ${v} !important;`]) }
    for (const [st, decls] of by) css += `[data-wsid="${idOf(e)}"]:is(:${st}, [data-wforce~="${st}"]) { ${decls.join(' ')} }\n`
  }
  sheetsOf(doc).edits.replaceSync(css)
}
function setStateStyle(el: HTMLElement, key: string, value: string) {
  record(el, key, () => getStateRule(el, key))
  setStateRule(el, key, value)
  bump()
}
/** Inspector edits: into the forced state when the element is shown in one, else inline. */
function editStyle(el: HTMLElement, prop: string, value: string) {
  const st = forced.get(el)
  if (st) setStateStyle(el, `${st}:${prop}`, value); else setStyle(el, prop, value)
}

// ── sessions: unapplied work survives reloads (per page, in this browser) ──
const SESSION_KEY = 'watcher:session'
type ElLoc = { src?: string; n?: number; path: number[] }
type SavedEdit = { at: ElLoc; prop: string; value: string | null; canvas?: boolean }
type SavedNode = { parent: ElLoc; index: number; html: string; canvas?: boolean }
type SavedPage = { at: number; edits: SavedEdit[]; nodes: SavedNode[]; guides: Guide[]; canvas: boolean }
const pageKey = () => location.pathname + location.search
const restoredPages = new Set<string>() // a page is restored once per load; saving waits until then
function readSession(): Record<string, SavedPage> { try { return JSON.parse(localStorage.getItem(SESSION_KEY) ?? '{}') } catch { return {} } }
function writePage(page: SavedPage | null) {
  const all = readSession(), key = pageKey()
  if (page && (page.edits.length || page.nodes.length || page.guides.length || page.canvas)) all[key] = page; else delete all[key]
  try { localStorage.setItem(SESSION_KEY, JSON.stringify(all)) } catch { /* storage full or blocked */ }
}
const bySrc = (src: string) => [...document.querySelectorAll('[data-wsrc]')].filter(e => e.getAttribute('data-wsrc') === src)
/** How to find an element again after a reload: its stamped source line (and which copy), plus its child path. */
function locate(el: Element): ElLoc {
  const path: number[] = []
  for (let e = el; e.parentElement && e !== document.body; e = e.parentElement) path.unshift([...e.parentElement.children].indexOf(e))
  const src = el.getAttribute('data-wsrc')
  return src ? { src, n: bySrc(src).indexOf(el), path } : { path }
}
function findLoc(at: ElLoc): HTMLElement | null {
  if (at.src) { const list = bySrc(at.src); if (list.length) return (list[at.n ?? 0] ?? list[0]) as HTMLElement }
  let e: Element | undefined = document.body
  for (const i of at.path) { e = e?.children[i]; if (!e) return null } // source moved (or no plugin): fall back to the path
  return e as HTMLElement
}
function capturePage(guides: Guide[]): SavedPage {
  const lastIndex = (el: HTMLElement, prop: string) => { for (let i = hist.length - 1; i >= 0; i--) if (hist[i].el === el && hist[i].prop === prop) return i; return -1 }
  const inCanvas = (i: number) => cv.on && i >= cv.mark
  // added nodes are saved whole (their own styles included); skip ones nested in another added node
  const added = hist.filter(h => h.prop === '#node' && h.el.isConnected && h.el.ownerDocument === document && h.el.parentElement)
  const addedEls = new Set(added.map(h => h.el))
  const insideAdded = (el: Element) => { for (let e = el.parentElement; e; e = e.parentElement) if (addedEls.has(e as HTMLElement)) return true; return false }
  const nodes: SavedNode[] = added.filter(h => !insideAdded(h.el)).map(h => ({
    parent: locate(h.el.parentElement!), index: [...h.el.parentElement!.children].indexOf(h.el), html: h.el.outerHTML, canvas: inCanvas(hist.indexOf(h)),
  }))
  const edits: SavedEdit[] = []
  for (const [el, props] of liveEdits()) {
    if (el.ownerDocument !== document || addedEls.has(el) || insideAdded(el)) continue
    const at = locate(el)
    for (const prop of props) {
      if (prop[0] === '%') continue // component props live in React's tree; they don't survive a reload
      const value = prop === '#text' ? el.innerHTML : prop[0] === '@' ? el.getAttribute(prop.slice(1)) : isStateKey(prop) ? getStateRule(el, prop) : el.style.getPropertyValue(prop)
      if (prop[0] !== '#' && prop[0] !== '@' && !value) continue
      edits.push({ at, prop, value, canvas: inCanvas(lastIndex(el, prop)) })
    }
  }
  return { at: Date.now(), edits, nodes, guides, canvas: cv.on }
}
/** Re-apply a saved page through the normal edit paths, so everything is undoable and shows up in Apply to code. */
function restorePage(page: SavedPage) {
  let applied = 0, missed = 0
  const phase = (canvas: boolean) => {
    for (const n of page.nodes.filter(x => !!x.canvas === canvas)) {
      const parent = findLoc(n.parent), tpl = document.createElement('template')
      tpl.innerHTML = n.html
      const el = tpl.content.firstElementChild as HTMLElement | null
      if (!parent || !el) { missed++; continue }
      parent.insertBefore(el, parent.children[n.index] ?? null)
      pushHist({ el, prop: '#node', before: '', t: 0 })
      applied++
    }
    for (const e of page.edits.filter(x => !!x.canvas === canvas)) {
      const el = findLoc(e.at)
      if (!el) { missed++; continue }
      if (e.prop === '#text') { const before = el.innerHTML; el.innerHTML = e.value ?? ''; pushHist({ el, prop: '#text', before, t: 0 }); track(el, '#text') }
      else if (e.prop[0] === '@') setAttr(el, e.prop.slice(1), e.value ?? '')
      else if (isStateKey(e.prop)) setStateStyle(el, e.prop, e.value ?? '')
      else setStyle(el, e.prop, e.value ?? '')
      applied++
    }
  }
  phase(false) // page edits first, so canvas mode freezes the edited layout
  if (page.canvas && !cv.on) enterCanvas()
  phase(true)
  for (const h of hist) h.t = 0 // don't let the next real edit coalesce into a restored one
  return { applied, missed }
}

// ── canvas mode: freeze the live layout into absolutely positioned layers ──
const cv = { on: false, mark: 0, snap: new Map<HTMLElement, string | null>() }
const LEAF = new Set(['IMG', 'VIDEO', 'CANVAS', 'IFRAME', 'PICTURE', 'INPUT', 'TEXTAREA', 'SELECT', 'BUTTON', 'TABLE'])
const hasText = (el: Element) => [...el.childNodes].some(n => n.nodeType === 3 && n.textContent!.trim())
/** Text blocks, media and controls stay whole, like text/image layers in Figma. */
const isLeaf = (el: Element) => hasText(el) || LEAF.has(el.tagName) || el instanceof SVGElement

function enterCanvas() {
  const items: [HTMLElement, HTMLElement][] = []
  const walk = (p: HTMLElement) => {
    for (const el of layerKids(p)) {
      const d = getComputedStyle(el).display
      if (d === 'none' || d === 'contents') continue
      items.push([el, p])
      if (!isLeaf(el)) walk(el)
    }
  }
  walk(document.body)
  // read every layout box first (transforms + zoom off, so existing transforms keep applying on top), then write
  const off = document.createElement('style')
  off.textContent = '* { transform: none !important; translate: none !important; rotate: none !important; scale: none !important; transition: none !important; }'
  document.head.appendChild(off)
  const boxes = items.map(([el, p]) => {
    const r = el.getBoundingClientRect(), pr = p.getBoundingClientRect()
    return { l: r.left - pr.left - p.clientLeft + p.scrollLeft, t: r.top - pr.top - p.clientTop + p.scrollTop, w: r.width, h: r.height }
  })
  const bodyH = document.body.getBoundingClientRect().height
  off.remove()

  const body = document.body
  cv.snap.set(body, body.getAttribute('style'))
  body.style.setProperty('position', 'relative', 'important')
  body.style.setProperty('min-height', bodyH + 'px', 'important')
  items.forEach(([el], i) => {
    const b = boxes[i], set = (p: string, v: string) => el.style.setProperty(p, v, 'important')
    cv.snap.set(el, el.getAttribute('style'))
    set('position', 'absolute'); set('left', b.l + 'px'); set('top', b.t + 'px'); set('right', 'auto'); set('bottom', 'auto')
    set('width', b.w + 'px'); set('margin', '0'); set('box-sizing', 'border-box'); set('min-width', '0'); set('max-width', 'none'); set('max-height', 'none')
    // text grows with edits (auto height) but never shrinks below what it was
    if (hasText(el)) { set('height', 'auto'); set('min-height', b.h + 'px') } else { set('height', b.h + 'px'); set('min-height', '0') }
  })
  cv.on = true
  cv.mark = hist.length
  applyVP(); bump()
}
function exitCanvas() {
  for (let i = hist.length - 1; i >= cv.mark; i--) restore(hist[i])
  hist.length = cv.mark
  redos.length = 0
  for (const [el, s] of cv.snap) { if (s == null) el.removeAttribute('style'); else el.setAttribute('style', s) }
  cv.snap.clear()
  cv.on = false
  applyVP(); bump()
}
/** Canvas changes are a sandbox: leaving discards them (after asking, if there are any). */
function leaveCanvas() {
  if (hist.length > cv.mark && !confirm('Exit canvas mode? Your canvas changes will be discarded.')) return false
  exitCanvas()
  return true
}

/** Position = left/top for absolutely placed layers (canvas mode, inserted shapes), `translate` for elements in flow. */
const canvasPositioned = (el: HTMLElement) => el.style.left !== '' && getComputedStyle(el).position === 'absolute'
function getPos(el: HTMLElement) {
  const cs = getComputedStyle(el)
  return canvasPositioned(el) ? [parseFloat(cs.left) || 0, parseFloat(cs.top) || 0] : parseTranslate(cs.translate)
}
function setPos(el: HTMLElement, x: number, y: number) {
  if (canvasPositioned(el)) { setStyle(el, 'left', round(x) + 'px'); setStyle(el, 'top', round(y) + 'px') }
  else setStyle(el, 'translate', `${round(x)}px ${round(y)}px`)
}

function insertNode(el: HTMLElement, parent: HTMLElement) {
  parent.appendChild(el)
  pushHist({ el, prop: '#node', before: '', t: 0 })
  bump()
  return el
}
function duplicate(el: HTMLElement, offset = 16) {
  const c = el.cloneNode(true) as HTMLElement
  c.removeAttribute('contenteditable')
  c.setAttribute('data-layer', label(el))
  el.after(c)
  pushHist({ el: c, prop: '#node', before: '', t: 0 })
  if (offset && canvasPositioned(c)) {
    const [x, y] = getPos(c)
    c.style.setProperty('left', x + offset + 'px', 'important')
    c.style.setProperty('top', y + offset + 'px', 'important')
  }
  bump()
  return c
}
/** Nearest non-leaf element under a point: where new layers get inserted. */
function containerAt(x: number, y: number) {
  let el = hitAt(x, y)
  while (el && isLeaf(el)) el = el.parentElement
  return el ?? document.body
}
/** Insert `el` absolutely positioned at client (x, y): drop it at 0,0, measure where that landed, correct.
 *  Works whatever the containing block is, so shapes can be added outside canvas mode too.
 *  ponytail: if that block is the initial one, zooming (which transforms <body>) shifts it by body's margin. */
function place<T extends Element>(el: T, c: HTMLElement, x: number, y: number) {
  const s = (el as unknown as HTMLElement).style
  s.position = 'absolute'; s.left = '0px'; s.top = '0px'
  insertNode(el as unknown as HTMLElement, c)
  const r = el.getBoundingClientRect()
  s.left = round((x - r.left) / vp.z) + 'px'
  s.top = round((y - r.top) / vp.z) + 'px'
  return el
}
function newText(c: HTMLElement, x: number, y: number, text = 'Text') {
  const el = document.createElement('div')
  el.setAttribute('data-layer', 'Text')
  el.textContent = text
  el.style.cssText = 'white-space:pre-wrap;font-size:16px;line-height:1.4;max-width:480px'
  return place(el, c, x, y)
}

// ── pen + vector editing ──
const ownerSvg = (el: Element) => (el.tagName === 'svg' ? el : (el as SVGElement).ownerSVGElement ?? el) as unknown as HTMLElement
/** Start editing the anchors of a shape (or an svg's first shape). Non-path shapes are swapped for an equivalent path. */
function enterPathEdit(t: Element): SVGPathElement | null {
  let shape: Element | null = SHAPES.has(t.tagName) ? t : t.tagName === 'svg' ? t.querySelector(SHAPE_SEL) : null
  if (!shape) return null
  if (shape.tagName !== 'path') {
    const src = shape, num = (n: string) => parseFloat(src.getAttribute(n) ?? '') || 0
    const p = document.createElementNS(SVGNS, 'path')
    for (const a of src.attributes) if (!GEOM.has(a.name)) p.setAttribute(a.name, a.value)
    p.setAttribute('d', shapeD(src.tagName, num, src.getAttribute('points') ?? ''))
    src.after(p)
    pushHist({ el: p as unknown as HTMLElement, prop: '#node', before: '', t: 0 })
    setStyle(src as HTMLElement, 'display', 'none')
    shape = p
  }
  pe.el = shape as SVGPathElement
  pe.node = null
  bump()
  return pe.el
}
/** Open the SVG editor tab on a page svg (or one of its shapes). */
function openSvgEditor(t: Element) {
  if (FRAME) return false // the editor lives on the top page
  const svg = (t.tagName === 'svg' ? t : (t as SVGElement).ownerSVGElement) as SVGSVGElement | null
  if (!svg || !enterPathEdit(t)) return false
  if (ed.svg !== svg) ed.zoom = 0 // 0 = fit on first render
  ed.svg = svg
  for (const p of svg.querySelectorAll('path')) if (!ed.orig.has(p)) ed.orig.set(p, p.getAttribute('d') ?? '')
  bump()
  return true
}
function closeSvgEditor() { ed.svg = null; pe.el = null; pe.node = null; pe.view = null; bump() }
/** Element whose screen matrix maps the edited path's coordinates: the magnified clone in the editor, else the page path. */
const editView = () => (pe.view?.isConnected ? pe.view : pe.el?.isConnected ? pe.el : null)
/** Nearest point on any segment of `subs` to (x, y), in path coordinates. */
function nearestSeg(subs: Sub[], x: number, y: number) {
  let best: { d: number; si: number; i: number; t: number } | null = null
  subs.forEach((sp, si) => {
    const n = sp.nodes, count = sp.closed ? n.length : n.length - 1
    for (let i = 0; i < count; i++) for (let k = 1; k < 40; k++) {
      const [px, py] = bezAt(n[i], n[(i + 1) % n.length], k / 40), d = Math.hypot(px - x, py - y)
      if (!best || d < best.d) best = { d, si, i, t: k / 40 }
    }
  })
  return best as { d: number; si: number; i: number; t: number } | null
}
const editSubs = () => parsePath(pe.el?.getAttribute('d') ?? '')
const writeEdit = (subs: Sub[]) => { if (pe.el) setAttr(pe.el, 'd', serializePath(subs)) }
function penLocal(x: number, y: number) {
  const p = new DOMPoint(x, y).matrixTransform(pen.cur!.path.getScreenCTM()!.inverse())
  return [p.x, p.y] as const
}
function startPen(x: number, y: number) {
  const svg = document.createElementNS(SVGNS, 'svg')
  svg.setAttribute('data-layer', 'Vector')
  svg.style.cssText = 'overflow:visible;width:1px;height:1px'
  const path = document.createElementNS(SVGNS, 'path')
  for (const [k, v] of Object.entries({ fill: 'none', stroke: '#1e1e1e', 'stroke-width': '2', 'stroke-linecap': 'round', 'stroke-linejoin': 'round', d: 'M0 0' })) path.setAttribute(k, v)
  svg.appendChild(path)
  place(svg, containerAt(x, y), x, y)
  pen.cur = { svg, path, subs: [{ nodes: [{ x: 0, y: 0 }], closed: false }], drag: true }
  pe.el = path; pe.node = [0, 0]
}
function addPenNode(x: number, y: number) {
  const c = pen.cur!, n = c.subs[0].nodes, [lx, ly] = penLocal(x, y)
  n.push({ x: lx, y: ly })
  c.drag = true
  pe.node = [0, n.length - 1]
  c.path.setAttribute('d', serializePath(c.subs))
}
/** Finish the pen path: trim the svg box to the path's bounds. Returns the svg (or null if it was a single click). */
function finishPen() {
  const c = pen.cur
  if (!c) return null
  pen.cur = null; pen.hover = null; pe.el = null; pe.node = null
  if (c.subs[0].nodes.length < 2) {
    c.svg.remove()
    const i = hist.findIndex(h => h.el === (c.svg as unknown as HTMLElement))
    if (i >= 0) hist.splice(i, 1)
    bump()
    return null
  }
  const pad = 2, b = c.path.getBBox(), dx = pad - b.x, dy = pad - b.y
  for (const n of c.subs.flatMap(s => s.nodes)) {
    n.x += dx; n.y += dy
    if (n.in) n.in = [n.in[0] + dx, n.in[1] + dy]
    if (n.out) n.out = [n.out[0] + dx, n.out[1] + dy]
  }
  c.path.setAttribute('d', serializePath(c.subs))
  const st = c.svg.style
  st.left = round(parseFloat(st.left) - dx) + 'px'; st.top = round(parseFloat(st.top) - dy) + 'px'
  st.width = round(b.width + pad * 2) + 'px'; st.height = round(b.height + pad * 2) + 'px'
  bump()
  return c.svg
}

// ── pages: links on the page + React Router route tables + sitemap.xml, remembered across navigation ──
type Page = { path: string; title: string; dynamic: boolean }
const knownPages = new Map<string, string>() // path → title
const pageRank = new Map<string, number>() // how trustworthy that title is
const pageTitle = (path: string) => {
  const seg = path.split('?')[0].split('/').filter(Boolean).pop()
  return seg ? seg.replace(/[-_]+/g, ' ').replace(/^./, c => c.toUpperCase()) : 'Home'
}
function samePath(href: string) {
  try {
    const u = new URL(href, location.href)
    if (u.origin !== location.origin || /\.(pdf|zip|png|jpe?g|gif|webp|svg|ico|xml|txt|json)$/i.test(u.pathname)) return null
    return u.pathname + u.search
  } catch { return null }
}
/** Route paths from a mounted React tree: `<Route path>` elements under Routes/Switch, and RouterProvider route objects. */
function routePaths() {
  const out = new Set<string>()
  const host = [document.body, ...document.body.children].find(el => Object.keys(el).some(k => k.startsWith('__reactContainer$')))
  if (!host) return out
  const join = (base: string, path: string) => (path.startsWith('/') ? path : `${base.replace(/\/$/, '')}/${path}`)
  const walkRoutes = (routes: { path?: string; index?: boolean; children?: unknown[] }[], base: string) => {
    for (const r of routes) {
      const p = r.path ? join(base, r.path) : base
      if (r.path || r.index) out.add(p || '/')
      if (Array.isArray(r.children)) walkRoutes(r.children as typeof routes, p)
    }
  }
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const walkEls = (children: any, base: string, depth = 0) => {
    if (depth > 12) return
    for (const c of Array.isArray(children) ? children.flat(9) : [children]) {
      if (!c || typeof c !== 'object' || !c.props) continue
      const p = typeof c.props.path === 'string' ? join(base, c.props.path) : base
      if (typeof c.props.path === 'string' || c.props.index) out.add(p || '/')
      walkEls(c.props.children, p, depth + 1)
    }
  }
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const stack: any[] = [(host as any)[Object.keys(host).find(k => k.startsWith('__reactContainer$'))!]]
  for (let n = 0; stack.length && n < 50000; n++) {
    const f = stack.pop()
    if (!f) continue
    const props = f.memoizedProps, name = typeof f.type === 'function' ? f.type.displayName || f.type.name : ''
    if (props && typeof props === 'object') {
      if (Array.isArray(props.router?.routes)) walkRoutes(props.router.routes, '')
      if (/Routes|Switch/.test(name ?? '')) walkEls(props.children, '')
    }
    if (f.sibling) stack.push(f.sibling)
    if (f.child) stack.push(f.child)
  }
  return out
}
async function discoverPages(): Promise<Page[]> {
  const add = (path: string | null, title = '', rank = 0) => {
    if (!path || !(rank > (pageRank.get(path) ?? -1) || (!knownPages.get(path) && title))) return
    knownPages.set(path, title); pageRank.set(path, rank)
  }
  // link labels name pages best, and labels inside navigation beat ones elsewhere (a logo, a "read more")
  for (const a of document.querySelectorAll<HTMLAnchorElement>('a[href]')) {
    if (/^(#|mailto:|tel:|javascript:)/.test(a.getAttribute('href') ?? '')) continue
    const text = a.textContent?.trim().replace(/\s+/g, ' ').slice(0, 40) ?? ''
    const rank = text ? (a.closest('nav, [role=navigation], aside') ? 2 : 1) - (a.querySelector('img, svg') ? 0.5 : 0) : 0 // logos rank lower
    add(samePath(a.href), text, rank)
  }
  add(location.pathname + location.search)
  for (const p of routePaths()) add(p)
  try {
    const r = await fetch('/sitemap.xml')
    if (r.ok && /xml/.test(r.headers.get('content-type') ?? '')) for (const m of (await r.text()).matchAll(/<loc>\s*([^<\s]+)\s*<\/loc>/g)) add(samePath(m[1]))
  } catch { /* no sitemap */ }
  return [...knownPages]
    .map(([path, title]) => ({ path, title: title || pageTitle(path), dynamic: /[:*[]/.test(path) }))
    .sort((a, b) => (a.path === '/' ? -1 : b.path === '/' ? 1 : a.path.localeCompare(b.path)))
}
/** Client-side navigation (pushState + popstate, which React Router and most SPA routers follow);
 *  falls back to a full load if the page didn't react. The overlay re-opens itself after a reload. */
function goTo(path: string) {
  if (path === location.pathname + location.search) return
  let changed = false
  const mo = new MutationObserver(() => { changed = true })
  mo.observe(document.body, { childList: true, subtree: true })
  history.pushState(null, '', path)
  dispatchEvent(new PopStateEvent('popstate', { state: null }))
  setTimeout(() => { mo.disconnect(); if (!changed) location.assign(path) }, 400)
}

// ── screenshot + eyedropper ──
/** Capture the tab (the browser asks which surface to share), crop to `r`, copy as PNG and offer a download. */
async function screenshot(r: DOMRect) {
  let stream: MediaStream
  try {
    stream = await navigator.mediaDevices.getDisplayMedia({ video: { displaySurface: 'browser' }, audio: false, preferCurrentTab: true } as DisplayMediaStreamOptions)
  } catch { notify('Screenshot cancelled'); return }
  const video = document.createElement('video')
  video.srcObject = stream; video.muted = true
  await video.play()
  HOST!.style.visibility = 'hidden' // keep the overlay out of the shot
  await new Promise(res => setTimeout(res, 300))
  const k = video.videoWidth / innerWidth, c = document.createElement('canvas')
  c.width = Math.max(1, Math.round(r.width * k)); c.height = Math.max(1, Math.round(r.height * k))
  c.getContext('2d')!.drawImage(video, r.x * k, r.y * k, r.width * k, r.height * k, 0, 0, c.width, c.height)
  HOST!.style.visibility = ''
  stream.getTracks().forEach(t => t.stop())
  const blob = await new Promise<Blob | null>(res => c.toBlob(res))
  if (!blob) return
  const download = () => Object.assign(document.createElement('a'), { href: URL.createObjectURL(blob), download: `screenshot-${Date.now()}.png` }).click()
  try { await navigator.clipboard.write([new ClipboardItem({ 'image/png': blob })]); notify('Screenshot copied', { label: 'Download', run: download }) }
  catch { notify('Screenshot ready', { label: 'Download', run: download }) }
}
type EyeDropperCtor = new () => { open: () => Promise<{ sRGBHex: string }> }
async function eyedrop() {
  const c = await pickScreenColor()
  if (c) { navigator.clipboard?.writeText(c); notify(`Copied ${c.toUpperCase()}`) }
}
async function pickScreenColor(): Promise<string | null> {
  const ED = (window as unknown as { EyeDropper?: EyeDropperCtor }).EyeDropper
  if (!ED) { notify('The EyeDropper API needs a Chromium browser'); return null }
  try { return (await new ED().open()).sRGBHex } catch { return null }
}

// ── profiler flashes ──
function flash(n: Node, kind: Flash['kind']) {
  const el = n.nodeType === 1 ? (n as Element) : n.parentElement
  if (!el || el === document.body || !el.isConnected) return
  const f = flashes.find(x => x.el === el), b = docBox(el), t = performance.now()
  if (f) { f.b = b; f.t = t } else if (flashes.length < 300) flashes.push({ el, b, t, kind })
}
function flashRect(r: DOMRectReadOnly, kind: Flash['kind']) {
  const o = origin()
  flashes.push({ b: { l: (r.x - o.x) / vp.z, t: (r.y - o.y) / vp.z, w: r.width / vp.z, h: r.height / vp.z }, t: performance.now(), kind })
}
const docBox = (el: Element): Box => {
  const r = el.getBoundingClientRect(), o = origin()
  return { l: (r.left - o.x) / vp.z, t: (r.top - o.y) / vp.z, w: r.width / vp.z, h: r.height / vp.z }
}
/** Snap the moving box's edges/centre to sibling + parent edges/centres and to ruler guides. */
function snapMove(r: Box, dx: number, dy: number, cands: Box[], guides: Guide[]) {
  const tol = 6 / vp.z
  const solve = (axis: 'x' | 'y', d: number) => {
    const [s, len] = axis === 'x' ? [r.l, r.w] : [r.t, r.h]
    const pts: [number, Box | undefined][] = []
    for (const c of cands) { const [cs, cl] = axis === 'x' ? [c.l, c.w] : [c.t, c.h]; pts.push([cs, c], [cs + cl / 2, c], [cs + cl, c]) }
    for (const g of guides) if (g.axis === axis) pts.push([g.pos, undefined])
    let best: { diff: number; pos: number; c?: Box } | null = null
    for (const [pos, c] of pts) for (const m of [s, s + len / 2, s + len]) {
      const diff = pos - (m + d)
      if (Math.abs(diff) < (best ? Math.abs(best.diff) : tol)) best = { diff, pos, c }
    }
    return best
  }
  const bx = solve('x', dx), by = solve('y', dy)
  if (bx) dx += bx.diff
  if (by) dy += by.diff
  const m = { l: r.l + dx, t: r.t + dy }, lines: SnapLine[] = []
  if (bx?.c) lines.push({ axis: 'x', pos: bx.pos, a: Math.min(m.t, bx.c.t), b: Math.max(m.t + r.h, bx.c.t + bx.c.h) })
  if (by?.c) lines.push({ axis: 'y', pos: by.pos, a: Math.min(m.l, by.c.l), b: Math.max(m.l + r.w, by.c.l + by.c.w) })
  return { dx, dy, lines }
}

function selector(el: Element): string {
  if (el.id) return '#' + CSS.escape(el.id)
  const tag = el.tagName.toLowerCase()
  const cls = [...el.classList].slice(0, 3).map(c => '.' + CSS.escape(c)).join('')
  if (cls) return tag + cls
  const p = el.parentElement
  return p && p !== el.ownerDocument.body ? `${selector(p)} > ${tag}:nth-child(${[...p.children].indexOf(el) + 1})` : tag
}
/** Edits as CSS. Ones made inside a responsive preview are wrapped in a max-width media query for its width. */
function exportCSS() {
  const groups = new Map<number, string[]>() // 0 = the page itself, else the preview's viewport width
  for (const [el, props] of changes) {
    if (!el.isConnected) continue
    const lines = [...props].filter(p => !/^[#@%]/.test(p) && !isStateKey(p) && el.style.getPropertyValue(p)).map(p => `  ${p}: ${el.style.getPropertyValue(p)};`)
    if (props.has('#text')) lines.push(`  /* text: ${JSON.stringify(el.textContent?.trim().slice(0, 120))} */`)
    const st = [...(stateRules.get(el) ?? [])]
    const blocks = [lines.length ? `${selector(el)} {\n${lines.join('\n')}\n}` : '', ...STATES.map(s => {
      const l = st.filter(([k]) => k.startsWith(s + ':')).map(([k, v]) => `  ${k.slice(s.length + 1)}: ${v};`)
      return l.length ? `${selector(el)}:${s} {\n${l.join('\n')}\n}` : ''
    })].filter(Boolean)
    const owner = reactName(el, true)
    if (!blocks.length) continue
    const w = el.ownerDocument === document ? 0 : el.ownerDocument.defaultView?.innerWidth ?? 0
    if (!groups.has(w)) groups.set(w, [])
    groups.get(w)!.push(`${owner ? `/* <${owner}> */\n` : ''}${blocks.join('\n')}`)
  }
  const out = [...(groups.get(0) ?? [])]
  for (const [w, blocks] of [...groups].filter(([w]) => w).sort((a, b) => b[0] - a[0])) {
    out.push(`/* edited in the ${w}px responsive preview */\n@media (max-width: ${w}px) {\n${blocks.join('\n\n').replace(/^/gm, '  ')}\n}`)
  }
  return out.join('\n\n')
}

// ── DOM / React helpers ─────────────────────────────────────────────────────
/** Component that renders `el` as its root node, or (owner=true) the nearest component above it. */
function reactName(el: Element, owner = false): string | null {
  const key = Object.keys(el).find(k => k.startsWith('__reactFiber$'))
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let f: any = key && (el as any)[key]?.return
  while (f) {
    const t = f.type
    if (typeof t === 'string') { if (!owner) return null }
    else if (t && typeof t !== 'symbol') {
      const n = t.displayName || t.name || t.render?.displayName || t.render?.name || t.type?.displayName || t.type?.name
      if (n) return n
    }
    f = f.return
  }
  return null
}
const label = (el: Element) => reactName(el) ?? el.getAttribute('data-layer') ?? el.tagName.toLowerCase()
const layerKids = (el: Element) => [...el.children].filter(c => !SKIP.has(c.tagName) && c !== HOST) as HTMLElement[]
function hitAt(x: number, y: number): HTMLElement | null {
  let el = document.elementFromPoint(x, y)
  if (!el || el === HOST || el === document.documentElement || el === document.body) return null
  if (el instanceof SVGElement && el.ownerSVGElement) el = el.ownerSVGElement
  return el as HTMLElement
}
const ids = new WeakMap<Element, number>()
let nextId = 0
const idOf = (el: Element) => ids.get(el) ?? (ids.set(el, ++nextId), nextId)

let ctx2d: CanvasRenderingContext2D | null = null
function rgba(c: string) {
  ctx2d ??= Object.assign(document.createElement('canvas'), { width: 1, height: 1 }).getContext('2d', { willReadFrequently: true })
  const x = ctx2d!
  x.clearRect(0, 0, 1, 1); x.fillStyle = '#000'; x.fillStyle = c; x.fillRect(0, 0, 1, 1)
  const [r, g, b, a] = x.getImageData(0, 0, 1, 1).data
  return { r, g, b, hex: '#' + [r, g, b].map(v => v.toString(16).padStart(2, '0')).join(''), a: round(a / 255, 2) }
}

type Line = { x1: number; y1: number; x2: number; y2: number; v: number }
/** Figma-style redlines between selected `a` and hovered `b` (client px). */
function measure(a: DOMRect, b: DOMRect, z: number): Line[] {
  const L: Omit<Line, 'v'>[] = []
  const inside = (i: DOMRect, o: DOMRect) => i.left >= o.left && i.right <= o.right && i.top >= o.top && i.bottom <= o.bottom
  if (inside(a, b) || inside(b, a)) {
    const [i, o] = inside(a, b) ? [a, b] : [b, a]
    const cx = i.left + i.width / 2, cy = i.top + i.height / 2
    L.push({ x1: cx, y1: o.top, x2: cx, y2: i.top }, { x1: cx, y1: i.bottom, x2: cx, y2: o.bottom },
      { x1: o.left, y1: cy, x2: i.left, y2: cy }, { x1: i.right, y1: cy, x2: o.right, y2: cy })
  } else {
    const t = Math.max(a.top, b.top), bt = Math.min(a.bottom, b.bottom)
    const y = t < bt ? (t + bt) / 2 : a.top + a.height / 2
    if (a.right <= b.left) L.push({ x1: a.right, y1: y, x2: b.left, y2: y })
    else if (b.right <= a.left) L.push({ x1: b.right, y1: y, x2: a.left, y2: y })
    const l = Math.max(a.left, b.left), r = Math.min(a.right, b.right)
    const x = l < r ? (l + r) / 2 : a.left + a.width / 2
    if (a.bottom <= b.top) L.push({ x1: x, y1: a.bottom, x2: x, y2: b.top })
    else if (b.bottom <= a.top) L.push({ x1: x, y1: b.bottom, x2: x, y2: a.top })
  }
  return L.map(l => ({ ...l, v: round(Math.hypot(l.x2 - l.x1, l.y2 - l.y1) / z) })).filter(l => l.v > 0)
}

// ── icons ───────────────────────────────────────────────────────────────────
const P = ICONS // Framework7 Icons (SF Symbols style), generated by scripts/icons.ts
const LID = 'M15.8 -15.8C5 -21 -21 -14 -25 0H-10'
const SPARK = 'M-2.2 -11.5H2.2A9.3 9.3 0 0 0 11.5 -2.2V2.2A9.3 9.3 0 0 0 2.2 11.5H-2.2A9.3 9.3 0 0 0 -11.5 2.2V-2.2A9.3 9.3 0 0 0 -2.2 -11.5Z' +
  'M0 -4.6A15 15 0 0 0 4.6 0A15 15 0 0 0 0 4.6A15 15 0 0 0 -4.6 0A15 15 0 0 0 0 -4.6Z'
/** The Watcher mark, app-icon cut: two eyelids around a spark on an orange tile. Same drawing as assets/logo.svg. */
function Mark({ size = 20 }: { size?: number }) {
  const g = useId()
  return (
    <svg width={size} height={size} viewBox="0 0 64 64" aria-label="Watcher">
      <defs><linearGradient id={g} x1="0" y1="0" x2="0" y2="1"><stop offset="0" stopColor="#F7933F" /><stop offset="1" stopColor="#EC7010" /></linearGradient></defs>
      <rect width="64" height="64" rx="15" fill={`url(#${g})`} />
      <rect x="0.75" y="0.75" width="62.5" height="62.5" rx="14.25" fill="none" stroke="#fff" strokeOpacity=".22" strokeWidth="1.5" />
      <g transform="translate(32 32) scale(.8)" fill="none" stroke="#fff" strokeWidth="4.4" strokeMiterlimit="10">
        <path d={LID} />
        <path d={LID} transform="rotate(180)" />
        <path d={SPARK} fill="#fff" stroke="none" fillRule="evenodd" />
      </g>
    </svg>
  )
}
function Icon({ d, size = 16 }: { d: string; size?: number }) {
  return (
    <svg width={size} height={size} viewBox={`0 0 ${ICON_VIEWBOX} ${ICON_VIEWBOX}`} fill="currentColor" aria-hidden="true">
      <path d={d} />
    </svg>
  )
}
const SIDE = { t: 'M3 3h6', r: 'M9 3v6', b: 'M3 9h6', l: 'M3 3v6' }
const Side = ({ s }: { s: keyof typeof SIDE }) => (
  <svg width={12} height={12} viewBox="0 0 12 12" fill="none" stroke="currentColor">
    <rect x={3} y={3} width={6} height={6} opacity={0.35} />
    <path d={SIDE[s]} strokeWidth={1.6} strokeLinecap="round" />
  </svg>
)

// ── fields ──────────────────────────────────────────────────────────────────
const NUM = /^-?\d*\.?\d+$/
const fmt = (v: string | number, digits = 1) => {
  if (typeof v === 'number') return String(round(v, digits))
  const m = /^(-?[\d.]+)(px|deg)?$/.exec(v)
  return m ? String(round(+m[1], 2)) : v
}

/** Number field, value left, unit/axis suffix right. Takes any CSS value; ↑/↓ step (⇧ ×10); drag the suffix to scrub. */
function Num({ suffix, value, onChange, unit = 'px', step = 1, digits = 1 }: { suffix?: ReactNode; value: string | number; onChange: (v: string) => void; unit?: string; step?: number; digits?: number }) {
  const [draft, setDraft] = useState<string | null>(null)
  const shown = draft ?? fmt(value, digits)
  const apply = (raw: string) => { setDraft(raw); const v = raw.trim(); if (v) onChange(NUM.test(v) ? v + unit : v) }
  const scrub = (e: RPointerEvent) => {
    e.preventDefault()
    const t = e.currentTarget as HTMLElement
    try { t.setPointerCapture(e.pointerId) } catch { /* pointer already released */ }
    const x0 = e.clientX, v0 = parseFloat(shown) || 0
    const move = (ev: PointerEvent) => apply(String(round(v0 + Math.round((ev.clientX - x0) / 2) * step * (ev.shiftKey ? 10 : 1), 2)))
    const up = () => { t.removeEventListener('pointermove', move); t.removeEventListener('pointerup', up); setDraft(null) }
    t.addEventListener('pointermove', move); t.addEventListener('pointerup', up)
  }
  return (
    <label className="f num">
      <input
        value={shown}
        onFocus={e => { setDraft(shown); e.currentTarget.select() }}
        onBlur={() => setDraft(null)}
        onChange={e => apply(e.target.value)}
        onKeyDown={e => {
          if (e.key === 'ArrowUp' || e.key === 'ArrowDown') {
            e.preventDefault()
            apply(String(round((parseFloat(shown) || 0) + (e.key === 'ArrowUp' ? 1 : -1) * step * (e.shiftKey ? 10 : 1), 2)))
          } else if (e.key === 'Enter') e.currentTarget.blur()
        }}
      />
      {suffix != null && <span className="sx" onPointerDown={scrub}>{suffix}</span>}
    </label>
  )
}
function Txt({ value, onChange, mono, placeholder }: { value: string; onChange: (v: string) => void; mono?: boolean; placeholder?: string }) {
  const [draft, setDraft] = useState<string | null>(null)
  return (
    <input
      className={mono ? 'mono' : undefined} value={draft ?? value} placeholder={placeholder} spellCheck={false}
      onFocus={() => setDraft(value)} onBlur={() => setDraft(null)}
      onChange={e => { setDraft(e.target.value); onChange(e.target.value) }}
      onKeyDown={e => e.key === 'Enter' && e.currentTarget.blur()}
    />
  )
}
const Field = ({ value, onChange, mono, placeholder }: { value: string; onChange: (v: string) => void; mono?: boolean; placeholder?: string }) => (
  <div className="f"><Txt value={value} onChange={onChange} mono={mono} placeholder={placeholder} /></div>
)
// ── colour picker ──
const hsvToRgb = (h: number, s: number, v: number) => {
  const f = (n: number) => { const k = (n + h / 60) % 6; return v - v * s * Math.max(0, Math.min(k, 4 - k, 1)) }
  return [f(5), f(3), f(1)].map(x => Math.round(x * 255))
}
const rgbToHsv = (r: number, g: number, b: number): [number, number, number] => {
  r /= 255; g /= 255; b /= 255
  const mx = Math.max(r, g, b), d = mx - Math.min(r, g, b)
  const h = !d ? 0 : (mx === r ? ((g - b) / d + 6) % 6 : mx === g ? (b - r) / d + 2 : (r - g) / d + 4) * 60
  return [h, mx ? d / mx : 0, mx]
}
const hex2 = (n: number) => Math.round(n).toString(16).padStart(2, '0')
const clamp01 = (n: number) => Math.min(1, Math.max(0, n))
/** Drag inside `el`, reporting the pointer as 0..1 fractions of its box. */
function dragIn(e: RPointerEvent, fn: (x: number, y: number) => void) {
  e.preventDefault()
  const t = e.currentTarget as HTMLElement, r = t.getBoundingClientRect()
  const at = (ev: { clientX: number; clientY: number }) => fn(clamp01((ev.clientX - r.left) / r.width), clamp01((ev.clientY - r.top) / r.height))
  try { t.setPointerCapture(e.pointerId) } catch { /* pointer already released */ }
  at(e)
  const up = () => { t.removeEventListener('pointermove', at); t.removeEventListener('pointerup', up) }
  t.addEventListener('pointermove', at); t.addEventListener('pointerup', up)
}
/** Saturation/value square, hue + alpha sliders, eyedropper, hex + alpha fields and the page's own palette. */
function ColorPicker({ value, anchor, onChange, onClose }: { value: string; anchor: DOMRect; onChange: (v: string) => void; onClose: () => void }) {
  const [hsva, setHsva] = useState(() => { const c = rgba(value); return [...rgbToHsv(c.r, c.g, c.b), c.a] as [number, number, number, number] })
  const [h, sat, val, a] = hsva
  const [r, g, b] = hsvToRgb(h, sat, val)
  const hex = '#' + hex2(r) + hex2(g) + hex2(b)
  const set = (next: [number, number, number, number]) => {
    setHsva(next)
    const [nr, ng, nb] = hsvToRgb(next[0], next[1], next[2])
    onChange('#' + hex2(nr) + hex2(ng) + hex2(nb) + (next[3] < 1 ? hex2(next[3] * 255) : ''))
  }
  const fromCss = (v: string) => { if (!CSS.supports('color', v)) return; const c = rgba(v); set([...rgbToHsv(c.r, c.g, c.b), c.a]) }
  if (!ds.elements) scanStyles() // the page palette below needs one scan
  const palette = paletteSort(ds.colors).slice(0, 16)
  const W = 248, left = Math.min(Math.max(8, anchor.right - W), innerWidth - W - 8)
  const top = anchor.bottom + 360 > innerHeight ? Math.max(8, anchor.top - 356) : anchor.bottom + 6
  return createPortal(
    <>
      <div className="backdrop ui fixed" onPointerDown={onClose} />
      <div className="cp ui" style={{ left, top }} onKeyDown={e => e.key === 'Escape' && onClose()}>
        <div className="cp-sv" style={{ background: `linear-gradient(to top, #000, transparent), linear-gradient(to right, #fff, hsl(${h} 100% 50%))` }}
          onPointerDown={e => dragIn(e, (x, y) => set([h, x, 1 - y, a]))}>
          <i className="cp-thumb" style={{ left: `${sat * 100}%`, top: `${(1 - val) * 100}%`, background: hex }} />
        </div>
        <div className="cp-bar cp-hue" onPointerDown={e => dragIn(e, x => set([x * 360, sat, val, a]))}>
          <i className="cp-thumb" style={{ left: `${(h / 360) * 100}%`, background: `hsl(${h} 100% 50%)` }} />
        </div>
        <div className="cp-bar cp-alpha" style={{ backgroundImage: `linear-gradient(to right, transparent, ${hex}), repeating-conic-gradient(#ccc 0 25%, #fff 0 50%)` }}
          onPointerDown={e => dragIn(e, x => set([h, sat, val, round(x, 2)]))}>
          <i className="cp-thumb" style={{ left: `${a * 100}%`, background: hex }} />
        </div>
        <div className="cp-row">
          <button className="b sm" data-tip="Pick from screen · I" onClick={async () => { const c = await pickScreenColor(); if (c) fromCss(c) }}><Icon d={P.dropper} /></button>
          <span className="sw big"><i style={{ background: a < 1 ? `${hex}${hex2(a * 255)}` : hex }} /></span>
          <div className="f"><Txt mono value={hex.toUpperCase()} onChange={fromCss} /></div>
          <div className="cp-a"><Num value={Math.round(a * 100)} unit="" suffix="%" onChange={v => { const n = parseFloat(v); if (!isNaN(n)) set([h, sat, val, clamp01(n / 100)]) }} /></div>
        </div>
        {palette.length > 0 && <>
          <span className="cp-cap">On this page</span>
          <div className="cp-sws">{palette.map(c => <button key={c.v} title={colorOut(c.v)} style={{ background: c.v }} onClick={() => fromCss(c.v)} />)}</div>
        </>}
      </div>
    </>,
    UI.root ?? document.body,
  )
}
function Swatch({ value, onChange, big }: { value: string; onChange: (v: string) => void; big?: boolean }) {
  const [anchor, setAnchor] = useState<DOMRect | null>(null)
  return (
    <>
      <button className={'sw' + (big ? ' big' : '')} onClick={e => setAnchor(e.currentTarget.getBoundingClientRect())}><i style={{ background: value }} /></button>
      {anchor && <ColorPicker value={value} anchor={anchor} onChange={onChange} onClose={() => setAnchor(null)} />}
    </>
  )
}
function Color({ value, onChange }: { value: string; onChange: (v: string) => void }) {
  const { hex, a } = rgba(value)
  return (
    <div className="f">
      <Swatch value={value} onChange={onChange} />
      <Txt mono value={a === 0 ? 'transparent' : hex.toUpperCase() + (a < 1 ? ` / ${Math.round(a * 100)}%` : '')} onChange={v => CSS.supports('color', v) && onChange(v)} />
    </div>
  )
}
function Pick({ value, options, onChange }: { value: string; options: readonly string[]; onChange: (v: string) => void }) {
  const opts = options.includes(value) ? options : [value, ...options]
  return (
    <label className="f sel">
      <select value={value} onChange={e => onChange(e.target.value)}>{opts.map(o => <option key={o}>{o}</option>)}</select>
      <Icon d={P.down} size={12} />
    </label>
  )
}
function Seg<T extends string>({ value, options, onChange, big }: { value: T; options: readonly (readonly [T, ReactNode])[]; onChange: (v: T) => void; big?: boolean }) {
  return (
    <div className={'seg' + (big ? ' big' : '')}>
      {options.map(([v, l]) => <button key={v} className={v === value ? 'on' : undefined} onClick={() => onChange(v)}>{l}</button>)}
    </div>
  )
}
const Check = ({ checked, onChange, children }: { checked: boolean; onChange: (v: boolean) => void; children: ReactNode }) => (
  <label className="check">
    <input type="checkbox" checked={checked} onChange={e => onChange(e.target.checked)} />
    <span className="cb"><Icon d={P.check} size={12} /></span>{children}
  </label>
)
const collapsed = new Set<string>(['Fine-tune']) // raw controls start closed; the Animations list comes first
/** Collapsible section; collapsed state survives re-selection. */
function Section({ title, n, children }: { title: string; n?: number; children: ReactNode }) {
  const [open, setOpen] = useState(!collapsed.has(title))
  const toggle = () => { if (open) collapsed.add(title); else collapsed.delete(title); setOpen(!open) }
  return (
    <div className="sec">
      <button className={'sh' + (open ? '' : ' shut')} onClick={toggle}>
        <span>{title}</span>{n != null && <span className="n">{n}</span>}<i /><Icon d={P.down} size={12} />
      </button>
      {open && <div className="sb">{children}</div>}
    </div>
  )
}
const Row = ({ label, children }: { label: ReactNode; children: ReactNode }) => <div className="prow"><span className="pl">{label}</span><div className="pc">{children}</div></div>
const Lbl = ({ children }: { children: ReactNode }) => <div className="lbl">{children}</div>

// ── inspector ───────────────────────────────────────────────────────────────
const DISPLAY = ['block', 'inline', 'inline-block', 'flex', 'inline-flex', 'grid', 'inline-grid', 'contents', 'none']
const POSITION = ['static', 'relative', 'absolute', 'fixed', 'sticky']
const WEIGHTS = ['100', '200', '300', '400', '500', '600', '700', '800', '900']
const BORDER = ['none', 'solid', 'dashed', 'dotted', 'double']
const SIDES = [['t', 'top'], ['r', 'right'], ['b', 'bottom'], ['l', 'left']] as const
const TEXT_ALIGN = [['left', <Icon key="l" d={P.alL} size={14} />], ['center', <Icon key="c" d={P.alC} size={14} />], ['right', <Icon key="r" d={P.alR} size={14} />], ['justify', <Icon key="j" d={P.alJ} size={14} />]] as const
const reactProps = (el: Element): Record<string, unknown> | null => {
  const k = Object.keys(el).find(k => k.startsWith('__reactProps$'))
  return k ? (el as unknown as Record<string, Record<string, unknown>>)[k] : null
}
const crumbLabel = (el: Element) => el.tagName.toLowerCase() + (el.id ? '#' + el.id : el.classList[0] ? '.' + el.classList[0] : '')

function AddProp({ el }: { el: HTMLElement }) {
  const [p, setP] = useState(''), [v, setV] = useState('')
  const add = () => { if (p && CSS.supports(p, v)) { setStyle(el, p, v); setP(''); setV('') } }
  return (
    <div className="kv">
      <div className="f"><input className="mono" placeholder="property" value={p} onChange={e => setP(e.target.value)} spellCheck={false} /></div>
      <div className="f"><input className="mono" placeholder="value" value={v} onChange={e => setV(e.target.value)} onKeyDown={e => e.key === 'Enter' && add()} spellCheck={false} /></div>
      <button className="b xs" onClick={add} disabled={!p || !CSS.supports(p, v)}><Icon d={P.plus} size={12} /></button>
    </div>
  )
}

function Crumbs({ el, select }: { el: HTMLElement; select: (el: HTMLElement | null) => void }) {
  const chain: HTMLElement[] = []
  for (let p: HTMLElement | null = el; p && p !== el.ownerDocument.body && chain.length < 4; p = p.parentElement) chain.unshift(p)
  const name = reactName(el) ?? reactName(el, true)
  return (
    <div className="crumbs">
      {chain.map((c, i) => (
        <Fragment key={idOf(c)}>
          {i > 0 && <Icon d={P.chev} size={10} />}
          <button className={'crumb' + (c === el ? ' on' : '')} title={selector(c)} onClick={() => select(c)}>{c.getAttribute('data-layer') ?? crumbLabel(c)}</button>
        </Fragment>
      ))}
      {name && <div className="compname"><Icon d={P.comp} size={13} />{reactName(el) ? name : <>in &lt;{name}&gt;</>}</div>}
      {sourceOf(el) && <button className="srclink" data-tip="Open in your editor" onClick={() => openInEditor(el)}><Icon d={P.code} size={12} />{sourceOf(el)!.file}:{sourceOf(el)!.line}</button>}
    </div>
  )
}

/** Constraints: which edges a positioned element is pinned to. Left+right (or top+bottom) = stretch with the parent. */
function PinnedTile({ el, cs }: { el: HTMLElement; cs: CSSStyleDeclaration }) {
  const positioned = cs.position === 'absolute' || cs.position === 'fixed'
  const has = (side: string) => { const v = el.style.getPropertyValue(side); return v !== '' && v !== 'auto' }
  const on = { left: has('left'), right: has('right'), top: has('top'), bottom: has('bottom') }
  if (!on.left && !on.right) on.left = true
  if (!on.top && !on.bottom) on.top = true
  const toggle = (side: keyof typeof on) => {
    if (!positioned) return
    const horiz = side === 'left' || side === 'right', [a, b] = horiz ? (['left', 'right'] as const) : (['top', 'bottom'] as const)
    const next = { ...on, [side]: !on[side] }
    if (!next[a] && !next[b]) next[side === a ? b : a] = true // keep at least one pin per axis
    const dim = horiz ? 'width' : 'height', size = cs.getPropertyValue(dim)
    for (const s of [a, b]) setStyle(el, s, next[s] ? cs.getPropertyValue(s) : 'auto')
    setStyle(el, dim, next[a] && next[b] ? 'auto' : size)
  }
  const arm = (side: keyof typeof on, d: string) => (
    <g className={'arm' + (on[side] ? ' on' : '')} onClick={() => toggle(side)}><path d={d} /><path className="hit" d={d} /></g>
  )
  return (
    <div className={'rtile' + (positioned ? '' : ' dis')} data-tip={positioned ? 'Click an edge to pin / unpin' : 'Set position to absolute to pin edges'}>
      <div className="box">
        <svg className="ill" viewBox="0 0 64 44">
          {arm('left', 'M5 22H25 M5 18V26')}{arm('right', 'M39 22H59 M59 18V26')}
          {arm('top', 'M32 3V15 M28 3H36')}{arm('bottom', 'M32 29V41 M28 41H36')}
          <rect className="core" x={26} y={16} width={12} height={12} rx={2} />
        </svg>
      </div>
      Pinned
    </div>
  )
}

type SizeMode = 'fixed' | 'hug' | 'fill' | 'auto'
const sizeMode = (el: HTMLElement, dim: 'width' | 'height'): SizeMode => {
  const v = el.style.getPropertyValue(dim)
  return !v ? 'auto' : v.endsWith('%') ? 'fill' : /content|auto/.test(v) ? 'hug' : 'fixed'
}
/** Arm drawing for one axis of the sizing tile: ticks = fixed, inward arrows = hug, spring = fill. */
function sizeArm(mode: SizeMode, horiz: boolean) {
  const P2 = (a: number, c: number) => (horiz ? `${a} ${c}` : `${c} ${a}`)
  const [s, e, c] = horiz ? [8, 56, 22] : [3, 41, 32]
  if (mode === 'fixed') return `M${P2(s, c)}L${P2(e, c)} M${P2(s, c - 5)}L${P2(s, c + 5)} M${P2(e, c - 5)}L${P2(e, c + 5)}`
  if (mode === 'fill') {
    let d = `M${P2(s, c)}`
    for (let a = s + 4, k = 0; a <= e; a += 4, k++) d += `L${P2(a, a >= e ? c : c + (k % 2 ? 3 : -3))}`
    return d
  }
  const m = (s + e) / 2
  return `M${P2(s, c)}L${P2(m - 6, c)} M${P2(m + 6, c)}L${P2(e, c)} M${P2(m - 9, c - 3)}L${P2(m - 6, c)}L${P2(m - 9, c + 3)} M${P2(m + 9, c - 3)}L${P2(m + 6, c)}L${P2(m + 9, c + 3)}`
}
const MODE_NAME: Record<SizeMode, string> = { fixed: 'Fixed', hug: 'Hug', fill: 'Fill', auto: 'Auto' }
/** Width/height sizing: click an arm to cycle fixed → hug → fill. */
function SizingTile({ el, cs }: { el: HTMLElement; cs: CSSStyleDeclaration }) {
  const w = sizeMode(el, 'width'), h = sizeMode(el, 'height')
  // ponytail: fill = 100%; inside a flex row `flex: 1` would be the more faithful mapping
  const cycle = (dim: 'width' | 'height') => {
    const m = sizeMode(el, dim), next = m === 'fixed' ? 'hug' : m === 'hug' ? 'fill' : 'fixed'
    setStyle(el, dim, next === 'fixed' ? cs.getPropertyValue(dim) : next === 'hug' ? 'fit-content' : '100%')
  }
  return (
    <div className="rtile" data-tip="Click an arm: fixed → hug → fill">
      <div className="box">
        <svg className="ill" viewBox="0 0 64 44">
          <g className={'arm' + (w === 'fixed' || w === 'fill' ? ' on' : '')} onClick={() => cycle('width')}><path d={sizeArm(w, true)} /><path className="hit" d="M8 22H56" /></g>
          <g className={'arm' + (h === 'fixed' || h === 'fill' ? ' on' : '')} onClick={() => cycle('height')}><path d={sizeArm(h, false)} /><path className="hit" d="M32 3V41" /></g>
        </svg>
      </div>
      {w === h ? (w === 'fixed' ? 'Fixed size' : MODE_NAME[w]) : `${MODE_NAME[w]} × ${MODE_NAME[h]}`}
    </div>
  )
}
/** Press and drag sideways to temporarily resize the parent and watch this element respond. Released = restored. */
function PreviewTile({ el }: { el: HTMLElement }) {
  const [live, setLive] = useState<{ w: number; w0: number } | null>(null)
  const down = (e: RPointerEvent) => {
    const p = el.parentElement
    if (!p) return
    e.preventDefault()
    const t = e.currentTarget as HTMLElement
    try { t.setPointerCapture(e.pointerId) } catch { /* pointer already released */ }
    const prev = p.style.getPropertyValue('width'), prio = p.style.getPropertyPriority('width')
    const k = ctxOf(el).z, w0 = p.getBoundingClientRect().width / k, x0 = e.clientX
    const move = (ev: PointerEvent) => {
      const w = Math.max(40, Math.round(w0 + (ev.clientX - x0) / k))
      p.style.setProperty('width', w + 'px', 'important')
      setLive({ w, w0 })
    }
    const up = () => {
      t.removeEventListener('pointermove', move); t.removeEventListener('pointerup', up)
      if (prev) p.style.setProperty('width', prev, prio); else p.style.removeProperty('width')
      setLive(null)
    }
    t.addEventListener('pointermove', move); t.addEventListener('pointerup', up)
  }
  const kx = live ? 32 + Math.max(-24, Math.min(24, (live.w - live.w0) / 6)) : 32
  return (
    <div className="rtile drag" data-tip="Drag sideways to preview the parent resizing">
      <div className="box" onPointerDown={down}>
        <svg className="ill" viewBox="0 0 64 44">
          <path d={`M6 22H${kx - 5}`} />
          <path d={`M${kx + 5} 22q2 -3 4 0t4 0t4 0t4 0t4 0t4 0`} opacity={0.5} />
          <rect className="knob" x={kx - 4} y={16} width={8} height={12} rx={2} />
        </svg>
      </div>
      {live ? `${live.w}px` : 'Preview'}
    </div>
  )
}

const STATE_OPTS = [['default', 'Default'], ['hover', 'Hover'], ['focus', 'Focus'], ['active', 'Active']] as const
function StateBar({ el }: { el: HTMLElement }) {
  const st = forced.get(el)
  return (
    <div className="stbar">
      <Seg value={st ?? 'default'} options={STATE_OPTS} onChange={v => forceState(el, v === 'default' ? null : v)} />
      {st && <p className="stnote">Showing :{st}. Edits apply only in this state and write as <code>{st}:</code> classes.</p>}
    </div>
  )
}
/** Read-only summary of a prop that isn't a plain value. */
function describe(v: unknown): string {
  if (typeof v === 'function') return `ƒ ${v.name || 'anonymous'}()`
  if (v === null || v === undefined) return String(v)
  if (Array.isArray(v)) return `[${v.length} item${v.length === 1 ? '' : 's'}]`
  if (typeof v === 'object') {
    const t = (v as { $$typeof?: unknown; type?: unknown }).$$typeof ? (v as { type: unknown }).type : undefined
    if (t !== undefined) return `<${typeof t === 'string' ? t : typeName(t) ?? 'Element'} />`
    const k = Object.keys(v)
    return `{ ${k.slice(0, 3).join(', ')}${k.length > 3 ? ', …' : ''} }`
  }
  return String(v)
}
function PropsSection({ el }: { el: HTMLElement }) {
  const f = componentFiber(el)
  if (!f) return null
  const props = Object.entries(currentProps(f)).filter(([k]) => k !== 'data-wsrc-c' && k !== 'data-wsrc')
  if (!props.length) return null
  const host = hostOf(f) ?? el, live = !!renderer(el.ownerDocument)
  const set = (k: string) => (v: unknown) => setProp(f, host, k, v)
  return (
    <Section title={`<${typeName(f.type)}> props`} n={props.length}>
      {props.map(([k, v]) => (
        <Row key={k} label={<span className="mono" title={k}>{k}</span>}>
          {live && typeof v === 'string' ? <Field value={v} onChange={set(k)} />
            : live && typeof v === 'number' ? <Num value={v} unit="" onChange={s => { const n = parseFloat(s); if (!isNaN(n)) set(k)(n) }} />
            : live && typeof v === 'boolean' ? <Check checked={v} onChange={set(k)}>{String(v)}</Check>
            : <span className="pval mono" title={describe(v)}>{describe(v)}</span>}
        </Row>
      ))}
      {!live && <p className="empty">Add the <code>watcher-ui/vite</code> plugin to edit props live.</p>}
    </Section>
  )
}

const RULE_TITLES: Record<string, string> = {
  contrast: 'Low contrast', name: 'No accessible name', alt: 'Images without alt text', label: 'Unlabelled form fields',
  target: 'Small targets', tabindex: 'Positive tabindex', 'hidden-focus': 'Focusable but hidden', heading: 'Headings', lang: 'Page language', title: 'Page title',
  motion: 'Reduced motion',
}
function IssueRow({ it, pick, all }: { it: Issue; pick?: (el: HTMLElement) => void; all?: Issue[] }) {
  const n = all?.length ?? 1
  return (
    <div className={'ck ' + it.sev}>
      <Icon d={P.warn} size={12} />
      <span className="ckmsg" role={pick && it.el ? 'button' : undefined} onClick={() => pick && it.el && pick(it.el)}>
        {pick && it.el && !all && <b>{label(it.el)} · </b>}{it.msg}{n > 1 && <em> · {n} elements</em>}
      </span>
      {it.fix && <button className="b xs ckfix" data-tip={n > 1 ? `Snap all ${n}` : 'Fix'} onClick={() => (all ?? [it]).forEach(i => i.fix?.run())}>{it.fix.label}</button>}
    </div>
  )
}
/** Contrast, accessibility and token checks for the selected element, live as you edit. */
function ChecksSection({ el }: { el: HTMLElement }) {
  const c = textContrast(el)
  const issues = [...a11yIssues(el).filter(i => i.rule !== 'contrast'), ...tokenIssues(el)]
  if (!c && !issues.length) return null
  const fails = !!c && c.ratio < c.aa
  const fix = fails ? contrastFix(el, c!) : undefined
  return (
    <Section title="Checks" n={issues.length + (fails ? 1 : 0) || undefined}>
      {c && (
        <div className={'ck ' + (fails ? 'error' : 'ok')}>
          <span className="ckswatch" style={{ background: toHex(c.bg), color: toHex(c.fg) }}>Aa</span>
          <span className="ckmsg"><b>{round(c.ratio, 2)}:1</b> {c.ratio >= c.aaa ? 'passes AAA' : c.ratio >= c.aa ? 'passes AA' : `fails AA (needs ${c.aa}:1)`}</span>
          {fix && <button className="b xs ckfix" data-tip="Closest colour that passes" onClick={fix.run}>{fix.label}</button>}
        </div>
      )}
      {issues.map((it, i) => <IssueRow key={i} it={it} />)}
    </Section>
  )
}
function ChecksPanel({ rev, select }: { rev: number; select: (el: HTMLElement) => void }) {
  const [tab, setTab] = useState<'a11y' | 'tokens'>('a11y')
  const [res, setRes] = useState<ReturnType<typeof audit> | null>(null)
  useEffect(() => { const t = setTimeout(() => setRes(audit()), res ? 400 : 0); return () => clearTimeout(t) }, [rev]) // eslint-disable-line react-hooks/exhaustive-deps
  const group = (list: Issue[], by: (i: Issue) => string) => { const m = new Map<string, Issue[]>(); for (const i of list) m.set(by(i), [...(m.get(by(i)) ?? []), i]); return [...m] }
  const errors = res?.a11y.filter(i => i.sev === 'error').length ?? 0
  const T = themeTokens()
  return (
    <>
      <div className="tabbar"><Seg big value={tab} options={[['a11y', `Accessibility${res ? ` · ${res.a11y.length}` : ''}`], ['tokens', `Tokens${res ? ` · ${group(res.tokens, i => i.key!).length}` : ''}`]] as const} onChange={setTab} /></div>
      <div className="pb">
        {!res ? <p className="empty pad">Checking the page…</p>
          : tab === 'a11y' ? (
            res.a11y.length ? group(res.a11y, i => i.rule).map(([rule, list]) => (
              <Section key={rule} title={RULE_TITLES[rule] ?? rule} n={list.length}>{list.map((it, i) => <IssueRow key={i} it={it} pick={select} />)}</Section>
            )) : <p className="empty pad">No accessibility problems found on this page.</p>
          ) : (
            !T.colors.length && !T.sizes.length && !T.radii.length && !T.step && !T.spaces.length
              ? <p className="empty pad">No design tokens found. Declare them as CSS variables on <code>:root</code> (Tailwind v4’s theme does this) and Watcher checks values against them.</p>
              : res.tokens.length ? group(res.tokens, i => i.key!).sort((a, b) => b[1].length - a[1].length).map(([k, list]) => <IssueRow key={k} it={list[0]} pick={select} all={list} />)
              : <p className="empty pad">Every checked value on this page is a token.</p>
          )}
      </div>
      <div className="foot">
        <span>{!res ? 'Checking…' : tab === 'a11y' ? `${errors} error${errors === 1 ? '' : 's'} · ${res.a11y.length - errors} warning${res.a11y.length - errors === 1 ? '' : 's'}` : `${T.colors.length} colour, ${T.sizes.length + T.radii.length + T.spaces.length} size tokens${T.step ? ` · ${T.step}px grid` : ''}`}</span>
        <button className="b sm" data-tip="Check again" onClick={() => setRes(audit())}><Icon d={P.refresh} /></button>
      </div>
    </>
  )
}

/** Bézier curve editor: drag the two handles, or pick a preset or one of the app's --ease-* tokens. */
function EasingEditor({ value, duration, onChange, chips: showChips = true }: { value: string; duration: number; onChange: (v: string) => void; chips?: boolean }) {
  const p = parseEase(value)
  const info = useServerInfo()
  const [naming, setNaming] = useState<string | null>(null)
  // a curve worth keeping becomes --ease-<name> in the theme, and this element uses it (written back as ease-<name>)
  const save = async (raw: string) => {
    const slug = raw.trim().toLowerCase().replace(/^--ease-|^ease-/, '').replace(/[^a-z0-9-]+/g, '-').replace(/^-|-$/g, '')
    if (!slug || !p) return
    const name = `--ease-${slug}`, curve = bezText(p)
    try {
      const [r] = await postCss([{ kind: 'theme', name, value: curve }], false)
      if (!r.ok) { notify(`Couldn’t save: ${r.error}`); return }
      document.documentElement.style.setProperty(name, curve) // until Tailwind emits it (once a class uses it)
      tokCache = null
      onChange(`var(${name})`)
      setNaming(null)
      notify(`Saved ${name} in ${r.file}. Write this element back and it uses ease-${slug}.`)
    } catch (e) { notify(`Couldn’t save: ${(e as Error).message}`) }
  }
  const X = (t: number) => 16 + t * 168, Y = (v: number) => 126 - v * 102 // room above and below for overshoot
  const drag = (i: 0 | 1) => (e: RPointerEvent<SVGCircleElement>) => {
    e.preventDefault()
    const t = e.currentTarget, r = t.ownerSVGElement!.getBoundingClientRect(), start = p!
    try { t.setPointerCapture(e.pointerId) } catch { /* pointer already released */ }
    const move = (ev: PointerEvent) => {
      const x = ((ev.clientX - r.left) * 200) / r.width, y = ((ev.clientY - r.top) * 150) / r.height
      const next = [...start]
      next[i * 2] = round(clamp01((x - 16) / 168), 2)
      next[i * 2 + 1] = round(Math.min(1.5, Math.max(-0.5, (126 - y) / 102)), 2)
      onChange(bezText(next))
    }
    const up = () => { t.removeEventListener('pointermove', move); t.removeEventListener('pointerup', up) }
    t.addEventListener('pointermove', move); t.addEventListener('pointerup', up)
  }
  const cur = normEase(value)
  const chips = [...EASE_PRESETS.map(([l, v]) => ({ l, v, on: normEase(v) === cur })), ...themeTokens().eases.map(e => ({ l: e.name === '--default-transition-timing-function' ? 'default' : e.name.replace(/^--(ease-)?/, ''), v: `var(${e.name})`, on: normEase(e.value) === cur }))]
  return (
    <div className="ez">
      {p ? (
        <svg viewBox="0 0 200 150" className="ezsvg">
          <rect x={16} y={24} width={168} height={102} className="ezbox" />
          <line x1={X(0)} y1={Y(0)} x2={X(1)} y2={Y(1)} className="ezref" />
          <line x1={X(0)} y1={Y(0)} x2={X(p[0])} y2={Y(p[1])} className="ezarm" />
          <line x1={X(1)} y1={Y(1)} x2={X(p[2])} y2={Y(p[3])} className="ezarm" />
          <path d={`M${X(0)} ${Y(0)}C${X(p[0])} ${Y(p[1])} ${X(p[2])} ${Y(p[3])} ${X(1)} ${Y(1)}`} className="ezcurve" />
          <circle cx={X(p[0])} cy={Y(p[1])} r={5} className="ezh" onPointerDown={drag(0)} />
          <circle cx={X(p[2])} cy={Y(p[3])} r={5} className="ezh" onPointerDown={drag(1)} />
        </svg>
      ) : <p className="stnote">{value} isn’t a curve that can be drawn. Pick one below to replace it.</p>}
      {showChips && <div className="ezchips">{chips.map(c => <button key={c.l + c.v} className={'ezchip' + (c.on ? ' on' : '')} onClick={() => onChange(c.v)}>{c.l}</button>)}</div>}
      <div className="eztrack" data-tip="Preview"><i className="ezdot" style={{ '--ez': value, '--ezd': `${Math.min(2000, Math.max(200, duration))}ms` } as CSSProperties} /></div>
      <Field mono value={value} onChange={onChange} />
      {showChips && p && info?.theme && !value.startsWith('var(') && (naming == null
        ? <button className="linkb" onClick={() => setNaming('')}>Save as a theme token…</button>
        : <div className="kv"><span className="k mono">--ease-</span><div className="f"><input className="mono" autoFocus placeholder="snappy" value={naming} onChange={e => setNaming(e.target.value)} onKeyDown={e => { if (e.key === 'Enter') void save(naming); if (e.key === 'Escape') setNaming(null) }} spellCheck={false} /></div><button className="b xs" data-tip={`Add to ${info.theme}`} disabled={!naming.trim()} onClick={() => void save(naming)}><Icon d={P.check} size={12} /></button></div>)}
    </div>
  )
}
/** A track of the animation's keyframes; pick one to edit, add or remove its values. Written back to the CSS file. */
function KeyframeEditor({ el, name }: { el: HTMLElement; name: string }) {
  const [sel, setSel] = useState(0)
  const [np, setNp] = useState(''), [nv, setNv] = useState(''), [off, setOff] = useState('')
  const r = keyframesRule(el.ownerDocument, name)
  if (!r) return <p className="empty">@keyframes {name} isn’t in a stylesheet Watcher can read.</p>
  const frames = [...r.cssRules] as CSSKeyframeRule[], k = frames[Math.min(sel, frames.length - 1)]
  const file = sheetFile(r)
  const pos = (o: string) => (o.trim() === 'from' ? 0 : o.trim() === 'to' ? 100 : parseFloat(o))
  const add = () => { if (k && np.trim() && nv.trim()) { setKeyframeProp(el, name, k.keyText, np.trim(), nv.trim()); setNp(''); setNv('') } }
  const addFrame = () => { const o = off.trim().replace(/^(\d*\.?\d+)$/, '$1%'); if (/^\d*\.?\d+%$/.test(o)) { r.appendRule(`${o} {}`); setSel(r.cssRules.length - 1); setOff(''); bump() } }
  return (
    <div className="kfe">
      <div className="kftrack">
        {frames.flatMap((f, i) => f.keyText.split(',').map(o => (
          <button key={i + o} className={'kfd' + (f === k ? ' on' : '')} style={{ left: `${pos(o)}%` }} data-tip={f.keyText} onClick={() => setSel(i)} />
        )))}
      </div>
      {k && <>
        <Lbl>{k.keyText}</Lbl>
        {[...k.style].map(prop => (
          <div className="kv" key={prop}>
            <span className="k mono" title={prop}>{prop}</span>
            <Field mono value={k.style.getPropertyValue(prop)} onChange={v => setKeyframeProp(el, name, k.keyText, prop, v)} />
            <button className="b xs" data-tip="Remove" onClick={() => setKeyframeProp(el, name, k.keyText, prop, '')}><Icon d={P.x} size={12} /></button>
          </div>
        ))}
        <div className="kv">
          <div className="f"><input className="mono" placeholder="opacity" value={np} onChange={e => setNp(e.target.value)} spellCheck={false} /></div>
          <div className="f"><input className="mono" placeholder="0.5" value={nv} onChange={e => setNv(e.target.value)} onKeyDown={e => e.key === 'Enter' && add()} spellCheck={false} /></div>
          <button className="b xs" data-tip="Add value" disabled={!np.trim() || !nv.trim()} onClick={add}><Icon d={P.plus} size={12} /></button>
        </div>
      </>}
      <div className="kv kfadd">
        <span className="k">Keyframe at</span>
        <div className="f"><input className="mono" placeholder="25%" value={off} onChange={e => setOff(e.target.value)} onKeyDown={e => e.key === 'Enter' && addFrame()} spellCheck={false} /></div>
        <button className="b xs" data-tip="Add keyframe" onClick={addFrame}><Icon d={P.plus} size={12} /></button>
      </div>
      {!file && <p className="stnote">Edits preview live, but this stylesheet wasn’t served by Vite, so they can’t be written back.</p>}
    </div>
  )
}

// ── presets: add an animation, previewed on the element, written as Motion props or Tailwind classes ──
/** One state's values (opacity, x, scale…): numbers scrub, strings type, add or remove a key. */
function MotionValues({ values, set }: { values: Vals; set: (k: string, v: unknown) => void }) {
  const [k, setK] = useState(''), [v, setV] = useState('')
  const add = () => { if (k.trim()) { set(k.trim(), v.trim() !== '' && !isNaN(+v) ? +v : v.trim()); setK(''); setV('') } }
  return (
    <>
      {Object.entries(values).filter(([key]) => key !== 'transition' && key !== 'transitionEnd').map(([key, val]) => (
        <div className="kv" key={key}>
          <span className="k mono" title={key}>{key}</span>
          {typeof val === 'number' ? <Num value={val} unit="" digits={2} step={Math.abs(val) <= 2 ? 0.05 : 1} onChange={x => { const n = parseFloat(x); if (!isNaN(n)) set(key, n) }} />
            : typeof val === 'string' ? <Field mono value={val} onChange={x => set(key, x)} />
            : <span className="pval mono" title={toJson(val)}>{toJson(val)}</span>}
          <button className="b xs" data-tip="Remove" onClick={() => set(key, undefined)}><Icon d={P.x} size={12} /></button>
        </div>
      ))}
      <div className="kv">
        <div className="f"><input className="mono" placeholder="opacity" value={k} onChange={e => setK(e.target.value)} spellCheck={false} /></div>
        <div className="f"><input className="mono" placeholder="1" value={v} onChange={e => setV(e.target.value)} onKeyDown={e => e.key === 'Enter' && add()} spellCheck={false} /></div>
        <button className="b xs" data-tip="Add value" disabled={!k.trim()} onClick={add}><Icon d={P.plus} size={12} /></button>
      </div>
    </>
  )
}
// Motion's named easings, as curves where they are one (anticipate overshoots backwards and isn't a bezier)
const MOTION_EASES: Record<string, Bez | null> = {
  easeOut: [0, 0, 0.58, 1], easeInOut: [0.42, 0, 0.58, 1], easeIn: [0.42, 0, 1, 1], linear: [0, 0, 1, 1],
  circOut: [0, 0.55, 0.45, 1], backOut: [0.33, 1.53, 0.69, 0.99], anticipate: null,
}
const easeCss = (e: unknown) => (Array.isArray(e) && e.length === 4 ? bezText(e as number[]) : typeof e === 'string' && MOTION_EASES[e] ? bezText(MOTION_EASES[e]!) : String(e ?? 'easeOut'))
function SpringPreview({ t }: { t: Vals }) {
  const { pts, settle, approx } = A.springCurve(t)
  const maxT = pts.at(-1)?.[0] || 1, hi = Math.max(1.1, ...pts.map(p => p[1])), lo = Math.min(0, ...pts.map(p => p[1]))
  const X = (s: number) => 8 + (s / maxT) * 184, Y = (x: number) => 72 - ((x - lo) / (hi - lo)) * 60
  return (
    <div className="spring">
      <svg viewBox="0 0 200 80" className="ezsvg">
        <line x1={8} x2={192} y1={Y(1)} y2={Y(1)} className="ezref" />
        <polyline points={pts.map(([s, x]) => `${X(s).toFixed(1)},${Y(x).toFixed(1)}`).join(' ')} className="ezcurve" />
      </svg>
      <span>{approx ? '≈ ' : ''}settles in {fmtMs(settle * 1000)}</span>
    </div>
  )
}
/** Motion's transition object: default, tween (duration + ease) or spring (duration + bounce, or physics). */
function MotionTransition({ t, set, stagger }: { t: Vals | undefined; set: (k: string, v: unknown) => void; stagger: boolean }) {
  const has = (k: string) => t?.[k] !== undefined
  const num = (k: string, d: number) => (typeof t?.[k] === 'number' ? (t[k] as number) : d)
  const physics = ['stiffness', 'damping', 'mass'].some(has)
  const type = t?.type === false ? 'instant' : typeof t?.type === 'string' ? t.type : physics || has('bounce') || has('visualDuration') ? 'spring' : has('duration') || has('ease') ? 'tween' : 'default'
  const setType = (v: 'default' | 'tween' | 'spring') => {
    if (v === 'default') { set('type', undefined); return }
    set('type', v)
    // a fresh spring starts critically damped (bounce 0): it settles without wobbling, which suits UI
    if (v === 'spring' && !physics && !has('visualDuration') && !has('duration')) { set('visualDuration', 0.3); set('bounce', 0) }
    if (v === 'spring' && has('ease')) set('ease', undefined)
    if (v === 'tween') {
      for (const k of ['bounce', 'visualDuration', 'stiffness', 'damping', 'mass']) if (has(k)) set(k, undefined) // spring-only keys
      if (!has('duration')) set('duration', 0.3)
      if (!has('ease')) set('ease', 'easeOut')
    }
  }
  const secs = (k: string) => (x: string) => { const n = parseFloat(x); if (!isNaN(n)) set(k, n) }
  const durKey = has('visualDuration') || !has('duration') ? 'visualDuration' : 'duration'
  return (
    <>
      <Seg value={type === 'instant' || type === 'keyframes' || type === 'inertia' ? 'default' : (type as 'default' | 'tween' | 'spring')} options={[['default', 'Default'], ['tween', 'Tween'], ['spring', 'Spring']] as const} onChange={setType} />
      {type === 'default' && <p className="stnote">Motion picks per value: a spring for x, y, scale and rotate, a 0.3s ease for opacity and colours.</p>}
      {type === 'instant' && <p className="stnote">type: false, so values jump without animating.</p>}
      {type === 'tween' && <>
        <Row label="Duration"><Num suffix="s" value={num('duration', 0.3)} unit="" digits={2} step={0.05} onChange={secs('duration')} /></Row>
        <div className="ezchips mease">{Object.keys(MOTION_EASES).map(e => <button key={e} className={'ezchip' + (t?.ease === e ? ' on' : '')} onClick={() => set('ease', e)}>{e}</button>)}</div>
        <EasingEditor value={easeCss(t?.ease)} duration={num('duration', 0.3) * 1000} chips={false} onChange={css => { const b = parseEase(css); set('ease', b ? b.map(n => round(n, 2)) : css) }} />
      </>}
      {type === 'spring' && <>
        {physics ? <>
          <Row label="Stiffness"><Num value={num('stiffness', 100)} unit="" step={10} onChange={secs('stiffness')} /></Row>
          <Row label="Damping"><Num value={num('damping', 10)} unit="" step={1} onChange={secs('damping')} /></Row>
          <Row label="Mass"><Num value={num('mass', 1)} unit="" digits={2} step={0.1} onChange={secs('mass')} /></Row>
          <button className="linkb" onClick={() => { set('stiffness', undefined); set('damping', undefined); set('mass', undefined); set('visualDuration', 0.3); set('bounce', 0) }}>Use duration and bounce</button>
        </> : <>
          <Row label="Duration"><Num suffix="s" value={num(durKey, durKey === 'duration' ? 0.8 : 0.3)} unit="" digits={2} step={0.05} onChange={secs(durKey)} /></Row>
          <Row label="Bounce"><Num value={num('bounce', has(durKey) ? 0.3 : 0)} unit="" digits={2} step={0.05} onChange={x => { const n = parseFloat(x); if (!isNaN(n)) set('bounce', Math.min(1, Math.max(-1, n))) }} /></Row>
          <button className="linkb" onClick={() => { set('visualDuration', undefined); set('duration', undefined); set('bounce', undefined); set('stiffness', 300); set('damping', 30); set('mass', 1) }}>Use stiffness and damping</button>
        </>}
        <SpringPreview t={t ?? {}} />
      </>}
      <Row label="Delay"><Num suffix="s" value={num('delay', 0)} unit="" digits={2} step={0.05} onChange={secs('delay')} /></Row>
      <Row label="Repeat"><Field mono value={has('repeat') ? String(t!.repeat) : ''} placeholder="0, 2 or Infinity" onChange={x => set('repeat', x.trim() === '' ? undefined : /^inf/i.test(x.trim()) ? Infinity : parseFloat(x) || 0)} /></Row>
      {has('repeat') && <Row label="Repeat type"><Pick value={String(t!.repeatType ?? 'loop')} options={['loop', 'reverse', 'mirror']} onChange={x => set('repeatType', x)} /></Row>}
      {stagger && <>
        <Row label="Stagger"><Num suffix="s" value={num('staggerChildren', 0)} unit="" digits={2} step={0.01} onChange={secs('staggerChildren')} /></Row>
        <Row label="Children delay"><Num suffix="s" value={num('delayChildren', 0)} unit="" digits={2} step={0.05} onChange={secs('delayChildren')} /></Row>
      </>}
    </>
  )
}
function MotionSection({ el, f }: { el: HTMLElement; f: Fiber }) {
  const p = currentProps(f) as Vals, live = !!renderer(el.ownerDocument)
  const at = (path: string) => (k: string, v: unknown) => setProp(f, el, `${path}.${k}`, v)
  const states = MOTION_STATES.map(([key, name]) => ({ key, name, s: stateOf(p, key) })).filter(x => p[x.key] !== undefined)
  const shown = new Set(states.map(x => x.s?.label).filter(Boolean))
  const anim = stateOf(p, 'animate')
  // the transition behind the enter animation: one on the target itself, else the component's transition prop,
  // else (a child driven by a parent's labels) the one inside the variant it animates to
  const inVariant = !anim && !isObj(p.transition) && isObj(p.variants)
    ? Object.entries(p.variants).filter(([, v]) => isObj(v) && isObj(v.transition)).sort(([a], [b]) => +/^(visible|show|animate|enter|in|open)$/.test(b) - +/^(visible|show|animate|enter|in|open)$/.test(a))[0]?.[0]
    : undefined
  const tPath = anim && isObj(anim.values.transition) ? `${anim.path}.transition` : inVariant ? `variants.${inVariant}.transition` : 'transition'
  const t = getPath(p, tPath.split('.'))
  const variants = isObj(p.variants) ? Object.entries(p.variants).filter(([l, v]) => isObj(v) && !shown.has(l)) : []
  const gestures = (['whileHover', 'whileTap', 'whileFocus'] as const).filter(g => p[g] !== undefined)
  const canEnter = p.initial !== undefined && p.initial !== false && (p.animate !== undefined || p.whileInView !== undefined)
  return (
    <>
      <Section title={`<${typeName(f.type)}>`}>
        {!live && <p className="empty">Add the <code>watcher-ui/vite</code> plugin to edit Motion props live.</p>}
        {(canEnter || gestures.length > 0) && <>
          <Lbl>Play</Lbl>
          <div className="playrow">
            {canEnter && <button className="b sm" onClick={() => replayEnter(el, f)}><Icon d={P.replay} size={11} />Enter</button>}
            {gestures.map(g => <button key={g} className="b sm" onClick={() => playGesture(el, g)}><Icon d={P.play} size={11} />{g === 'whileHover' ? 'Hover' : g === 'whileTap' ? 'Press' : 'Focus'}</button>)}
          </div>
        </>}
        {states.map(({ key, name, s }) => (
          <div key={key} className="mstate">
            <Lbl>{name}{s?.label && <span className="mlabel"> · variant “{s.label}”</span>}</Lbl>
            {s ? <MotionValues values={s.values} set={at(s.path)} /> : <p className="empty mono">{toJson(p[key])}</p>}
          </div>
        ))}
        {!states.length && <p className="empty">No states on this element. Its values come from a parent’s variants.</p>}
      </Section>
      <Section title="Motion transition">
        {tPath !== 'transition' && <p className="stnote">Editing the transition inside <code>{tPath.replace(/\.transition$/, '')}</code>.</p>}
        <MotionTransition t={isObj(t) ? t : undefined} set={at(tPath)} stagger={typeof p.animate === 'string'} />
      </Section>
      {variants.length > 0 && (
        <Section title="Variants" n={variants.length}>
          {variants.map(([label, v]) => <div key={label} className="mstate"><Lbl>{label}</Lbl><MotionValues values={v as Vals} set={at(`variants.${label}`)} /></div>)}
        </Section>
      )}
    </>
  )
}

// ── custom animations: the list of what the element does, and a builder to make or change one ──
type Draft = { anim: A.Anim; system: System; found?: Found; name: string }
type SavedPreset = { name: string; anim: A.Anim }
let presetsP: Promise<SavedPreset[]> | null = null
const loadPresets = () => (presetsP ??= fetch('/__watcher/presets').then(r => (r.ok ? r.json() : { presets: [] })).then(j => (Array.isArray(j.presets) ? j.presets : [])
  .map((p: { name?: unknown; anim?: unknown }) => ({ name: String(p.name ?? ''), anim: A.sanitizeAnim(fromJson(toJson(p.anim ?? null))) })).filter((p: { anim: A.Anim | null }) => p.anim) as SavedPreset[]).catch(() => []))
async function savePresets(list: SavedPreset[]) {
  const r = await fetch('/__watcher/presets', { method: 'POST', headers: { 'content-type': 'application/json', 'x-watcher': '1' }, body: toJson({ presets: list }) })
  const j = await r.json()
  if (j.error) throw new Error(j.error)
  presetsP = Promise.resolve(list)
}
const SYSTEM_LABEL: Record<System, string> = { motion: 'Motion', tailwind: 'Tailwind', css: 'CSS' }
const BLANK: A.Anim = { trigger: 'hover', frames: A.fromTo({}, {}), transition: { duration: 0.2, ease: [0, 0, 0.2, 1] } }
const COMMON_KEYS = ['opacity', 'x', 'y', 'scale', 'rotate', 'filter', 'backgroundColor', 'color', 'boxShadow', 'borderRadius']
const KEY_START: A.Values = { opacity: 0, x: 0, y: 8, scale: 0.95, rotate: 0, filter: 'blur(4px)', backgroundColor: '#ffffff', color: '#000000', boxShadow: '0 8px 24px rgba(0,0,0,.12)', borderRadius: '8px' }
const restOf = (el: HTMLElement): A.Values => { const sn = snap(el); return Object.assign({}, ...Object.entries(sn).filter(([p]) => p !== 'animation-name' && p !== 'transform').map(([p, v]) => A.cssToValues(p, v))) }
const isGesture = (t: A.Trigger) => t === 'hover' || t === 'press' || t === 'focus'
/** What the Tailwind writer needs to know about the element besides the animation. */
function twContext(el: HTMLElement, d: Draft, founds: Found[], info: ServerInfo | null, name?: string): A.TwContext {
  const model = A.classifyTailwind(el.getAttribute('class') ?? '')
  const css = founds.filter(o => o.system !== 'motion' && !o.kfName)
  return {
    ver: info?.tailwind === 3 ? 3 : 4, timing: model.timing,
    current: (d.found && !d.found.kfName && d.found.system !== 'motion' ? d.found : css[0])?.anim.transition,
    others: css.filter(o => o !== d.found).map(o => o.anim),
    old: d.found?.system === 'tailwind' ? d.found.tw : undefined,
    name: name ?? (d.name.trim() || undefined),
  }
}
/** Write a draft to source in its system. Resolves with a message; rejects with why it couldn't. */
async function saveAnim(el: HTMLElement, d: Draft, founds: Found[], info: ServerInfo | null): Promise<string> {
  const f = d.found
  if (d.system === 'css') {
    // plain-CSS keyframes stay plain CSS: the block is rewritten where it's defined
    const rule = f?.kfName ? keyframesRule(el.ownerDocument, f.kfName) : null, file = rule && sheetFile(rule)
    if (!f?.kfName || !file) throw new Error('these keyframes aren’t in a stylesheet Vite serves, so they can’t be written back')
    const [r] = await postCss([{ kind: 'keyframes-block', file, name: f.kfName, css: A.keyframesCss(f.kfName, A.filled(d.anim, f.rest)) }], false)
    if (!r.ok) throw new Error(r.error)
    return `Saved @keyframes ${f.kfName} in ${r.file}. Its duration and easing live in the CSS rule that runs it.`
  }
  const src = sourceOf(el)
  if (!src) throw new Error('this element isn’t in your source (a library component, or added in canvas mode)')
  const edit: Partial<Pending> = {}
  let extra = ''
  if (d.system === 'motion') {
    const mf = motionFiber(el), old = f?.system === 'motion' ? f.motion : undefined
    const animate = A.TRIGGERS[d.anim.trigger].motion === 'animate'
    if (animate && founds.some(o => o !== f && o.system === 'motion' && A.TRIGGERS[o.anim.trigger].motion === 'animate'))
      throw new Error('Motion runs one `animate` per element, and this one already has an enter or loop animation. Edit that one, or put this on a wrapper.')
    const isolate = founds.some(o => o !== f && o.system === 'motion' && o.motion?.at.transition === 'transition')
    const props = A.motionEdits(d.anim, old, { isolate })
    if (d.anim.trigger === 'inView' && !old) props['viewport.once'] = true
    edit.props = props
    if (!mf) edit.motion = info?.motion ?? 'motion/react'
    if (f?.system === 'tailwind') edit.removeClasses = f.tw!.classes.map(c => c.cls)
    if (f?.system === 'css') extra = ' The original CSS rule is still there; remove it when you’re happy.'
  } else {
    let ctx = twContext(el, d, founds, info), e = A.tailwindEdits(d.anim, ctx)
    if (!e.add.length && !e.remove.length && !e.keyframes) throw new Error(e.notes[0] ?? 'Nothing changed.')
    if (e.keyframes) {
      // a name already used on the page is replaced where it's defined, or (Tailwind's own, a package's) given a fresh one
      const existing = keyframesRule(el.ownerDocument, e.keyframes.name)
      const [r] = await postCss([{ kind: 'keyframes-block', file: existing ? sheetFile(existing) ?? undefined : undefined, name: e.keyframes.name, css: e.keyframes.css, fresh: !!existing }], false)
      if (!r.ok) throw new Error(r.error)
      if (r.name && r.name !== e.keyframes.name) { ctx = twContext(el, d, founds, info, r.name); e = A.tailwindEdits(d.anim, ctx) }
      extra = ` @keyframes ${r.name ?? e.keyframes!.name} is in ${r.file}.`
    }
    edit.classes = e.add
    edit.removeClasses = e.remove
    if (f?.system === 'motion') edit.props = A.motionRemove(f.motion!)
    if (f?.system === 'css' && !f.kfName) extra += ' The original CSS rule is still there; remove it when you’re happy.'
  }
  const res = await postApply([{ els: [el], file: src.file, loc: src.loc, line: src.line, styles: {}, variant: '', repeats: 1, ...edit }], false)
  const r = res.files[0]?.results[0]
  if (!r?.ok) throw new Error(r?.error ?? res.error ?? 'couldn’t write')
  const skipped = r.skipped.length ? ` ${r.skipped.map(x => x.prop).join(', ')}: ${r.skipped[0].reason}.` : ''
  return `Saved to ${src.file.split('/').pop()}:${src.line}.${extra}${skipped}${r.note ? ` ${r.note}` : ''}`
}
async function deleteAnim(el: HTMLElement, f: Found, founds: Found[], info: ServerInfo | null): Promise<string> {
  const src = sourceOf(el)
  if (f.system === 'css') throw new Error('this comes from your CSS; remove it there')
  if (!src) throw new Error('this element isn’t in your source')
  const edit: Partial<Pending> = {}
  if (f.system === 'motion') {
    const initialUsed = founds.some(o => o !== f && o.system === 'motion' && o.motion?.at.from === 'initial')
    edit.props = A.motionRemove(f.motion!, { keepInitial: initialUsed })
  } else {
    const model = A.classifyTailwind(el.getAttribute('class') ?? '')
    const lastCss = !founds.some(o => o !== f && o.system !== 'motion' && !o.kfName)
    edit.removeClasses = [...f.tw!.classes.map(c => c.cls), ...(lastCss && !f.kfName ? model.timing.map(c => c.cls) : [])]
  }
  void info
  const res = await postApply([{ els: [el], file: src.file, loc: src.loc, line: src.line, styles: {}, variant: '', repeats: 1, ...edit }], false)
  const r = res.files[0]?.results[0]
  if (!r?.ok) throw new Error(r?.error ?? res.error ?? 'couldn’t write')
  return `Removed it from ${src.file.split('/').pop()}:${src.line}.`
}
function PresetMenu({ onPick }: { onPick: (anim: A.Anim, name: string) => void }) {
  const [saved, setSaved] = useState<SavedPreset[]>([])
  useEffect(() => { void loadPresets().then(setSaved) }, [])
  const drop = async (name: string) => {
    const next = saved.filter(p => p.name !== name)
    try { await savePresets(next); setSaved(next) } catch (e) { notify(`Couldn’t remove it: ${(e as Error).message}`) }
  }
  return (
    <div className="pmenu">
      <button className="preset" onClick={() => onPick(BLANK, '')}><b>Blank</b><span>start from nothing</span></button>
      {A.PRESETS.map(p => <button key={p.name} className="preset" onClick={() => onPick(p.anim, '')}><b>{p.name}</b><span>{A.describe(p.anim)}</span></button>)}
      {saved.map(p => (
        <div key={'s' + p.name} className="preset saved" role="button" onClick={() => onPick(p.anim, p.name.toLowerCase().replace(/[^a-z0-9]+/g, '-'))}>
          <b>{p.name}</b><span>{A.describe(p.anim)}</span>
          <button className="b xs" data-tip="Remove preset" onClick={e => { e.stopPropagation(); void drop(p.name) }}><Icon d={P.x} size={10} /></button>
        </div>
      ))}
    </div>
  )
}
function AnimationsSection({ el, rev, select }: { el: HTMLElement; rev: number; select: (el: HTMLElement | null) => void }) {
  const info = useServerInfo()
  const [founds, setFounds] = useState<Found[] | null>(null)
  const [tick, setTick] = useState(0), [draft, setDraft] = useState<Draft | null>(null), [menu, setMenu] = useState(false)
  const cls = el.getAttribute('class')
  useEffect(() => { setDraft(null); setMenu(false) }, [el])
  useEffect(() => {
    const t = setTimeout(() => { try { setFounds(interpret(el)) } catch (e) { console.warn('[watcher] reading animations failed', e); setFounds([]) } }, 120)
    return () => clearTimeout(t)
  }, [el, rev, cls, tick])
  // hot reload swaps the element's classes and props, and a new element type (div → motion.div) is a new DOM node:
  // find it again by where it is in the source
  const refresh = () => {
    const where = locate(el)
    setTick(n => n + 1)
    for (const ms of [500, 1200, 2500]) setTimeout(() => { if (!el.isConnected) { const next = findLoc(where); if (next && next.isConnected) select(next) } else setTick(n => n + 1) }, ms)
  }
  if (info === undefined) return null
  if (draft) return <AnimationBuilder el={el} draft={draft} setDraft={setDraft} founds={founds ?? []} info={info} onDone={msg => { setDraft(null); if (msg) notify(msg); refresh() }} />
  const canMotion = !!(info?.motion || motionFiber(el))
  return (
    <Section title="Animations" n={founds?.length || undefined}>
      {founds === null ? <p className="empty">Reading this element’s animations…</p>
        : !founds.length ? <p className="empty">No animations here yet.</p>
        : founds.map(f => (
          <div key={f.key} className="anim">
            <div className="animh">
              <b>{A.TRIGGERS[f.anim.trigger].label}</b>
              <span className={'sys ' + f.system}>{SYSTEM_LABEL[f.system]}{f.kfName ? ` · ${f.kfName}` : f.motion?.label ? ` · “${f.motion.label}”` : ''}</span>
              <span className="sp" />
              <button className="b xs" data-tip="Play it" onClick={() => playFound(el, f)}><Icon d={P.play} size={11} /></button>
              <button className="b xs" data-tip="Edit" onClick={() => setDraft({ anim: structuredClone(f.anim), system: f.system, found: f, name: f.kfName ?? '' })}><Icon d={P.sliders} size={12} /></button>
            </div>
            <p className="animd">{A.describe(f.anim, f.rest)}</p>
            {f.notes.map((n, i) => <p key={i} className="animn">{n}</p>)}
          </div>
        ))}
      <button className="b sm animnew" onClick={() => setMenu(m => !m)}><Icon d={P.plus} size={12} />New animation</button>
      {menu && <PresetMenu onPick={(anim, name) => { setMenu(false); setDraft({ anim: structuredClone(anim), system: anim.trigger === 'inView' || canMotion ? (canMotion ? 'motion' : 'tailwind') : 'tailwind', name }) }} />}
    </Section>
  )
}
const TRIGGER_CHIPS: A.Trigger[] = ['enter', 'hover', 'press', 'focus', 'inView', 'loop']
function AnimationBuilder({ el, draft, setDraft, founds, info, onDone }: {
  el: HTMLElement; draft: Draft; setDraft: (d: Draft | null | ((d: Draft | null) => Draft | null)) => void; founds: Found[]; info: ServerInfo | null; onDone: (msg?: string) => void
}) {
  const [sel, setSel] = useState(draft.anim.frames.length - 1)
  const [busy, setBusy] = useState(false), [err, setErr] = useState(''), [naming, setNaming] = useState<string | null>(null)
  const [nk, setNk] = useState(''), [confirmDel, setConfirmDel] = useState(false)
  const a = draft.anim, i = Math.min(sel, a.frames.length - 1), frame = a.frames[i], f = draft.found
  const rest = f?.rest ?? restOf(el)
  const mf = motionFiber(el), canMotion = !!(info?.motion || mf)
  const update = (fn: (a: A.Anim) => A.Anim) => { setErr(''); setDraft(d => (d ? { ...d, anim: fn(d.anim) } : d)) }
  const setValues = (idx: number, fn: (v: A.Values) => A.Values) => update(x => ({ ...x, frames: x.frames.map((fr, j) => (j === idx ? { ...fr, values: fn(fr.values) } : fr)) }))
  const setT = (k: string, v: unknown) => update(x => { const t = { ...x.transition }; if (v === undefined) delete t[k]; else t[k] = v; return { ...x, transition: t } })
  const setTrigger = (t: A.Trigger) => {
    setErr('')
    setDraft(d => {
      if (!d) return d
      const tr = { ...d.anim.transition }
      if (t === 'loop' && tr.repeat === undefined) tr.repeat = Infinity
      if (t !== 'loop' && d.anim.trigger === 'loop' && tr.repeat === Infinity) delete tr.repeat
      const system: System = t === 'inView' && d.system !== 'motion' && canMotion ? 'motion' : d.system
      return { ...d, system, anim: { ...d.anim, trigger: t, transition: tr } }
    })
  }
  const addFrame = () => {
    const j = i < a.frames.length - 1 ? i : i - 1
    const pos = A.r4((a.frames[j].at + a.frames[j + 1].at) / 2)
    update(x => ({ ...x, frames: [...x.frames.slice(0, j + 1), { at: pos, values: {} }, ...x.frames.slice(j + 1)] }))
    setSel(j + 1)
  }
  const removeFrame = () => { if (i > 0 && i < a.frames.length - 1) { update(x => ({ ...x, frames: x.frames.filter((_, j) => j !== i) })); setSel(i - 1) } }
  const moveFrame = (pct: number) => { if (i > 0 && i < a.frames.length - 1) update(x => ({ ...x, frames: x.frames.map((fr, j) => (j === i ? { ...fr, at: Math.min(x.frames[i + 1].at - 0.01, Math.max(x.frames[i - 1].at + 0.01, pct / 100)) } : fr)) })) }
  const addKey = (k: string) => { if (!k || k in frame.values) return; setValues(i, v => ({ ...v, [k]: i === a.frames.length - 1 ? rest[k] ?? A.IDENTITY[k] ?? KEY_START[k] ?? 0 : KEY_START[k] ?? rest[k] ?? 0 })); setNk('') }
  const frameName = (j: number) => j === 0 ? (isGesture(a.trigger) ? 'Rest' : 'From') : j === a.frames.length - 1 ? (a.trigger === 'loop' ? 'End' : 'To') : `${Math.round(a.frames[j].at * 100)}%`
  const steps = a.frames.length > 2 || a.trigger === 'loop'
  // what will be written, worked out as you edit
  let code = '', notes: string[] = []
  try {
    if (draft.system === 'motion') {
      const props = A.motionEdits(a, f?.system === 'motion' ? f.motion : undefined, { isolate: founds.some(o => o !== f && o.system === 'motion' && o.motion?.at.transition === 'transition') })
      code = Object.entries(props).map(([k, v]) => (v === null ? `− ${k}` : `${k} = ${toJson(v).replace(/"__Infinity__"/g, 'Infinity')}`)).join('\n')
      if (!mf) code = `<${el.tagName.toLowerCase()}> → <motion.${el.tagName.toLowerCase()}>\n` + code
    } else if (draft.system === 'tailwind') {
      const e = A.tailwindEdits(a, twContext(el, draft, founds, info))
      notes = e.notes
      code = [...e.remove.map(c => `− ${c}`), ...e.add.map(c => `+ ${c}`), ...(e.keyframes ? ['', e.keyframes.css] : [])].join('\n')
    } else code = A.keyframesCss(f?.kfName ?? 'name', A.filled(a, rest))
  } catch (e) { code = `(${(e as Error).message})` }
  const run = async (fn: () => Promise<string>) => { setBusy(true); setErr(''); try { onDone(await fn()) } catch (e) { setErr((e as Error).message) } setBusy(false) }
  const keepPreset = async (name: string) => {
    if (!name.trim()) return
    try { const list = await loadPresets(); await savePresets([...list.filter(p => p.name !== name.trim()), { name: name.trim(), anim: a }]); setNaming(null); notify(`Saved “${name.trim()}” to watcher.animations.json`) }
    catch (e) { setErr(`Couldn’t save the preset: ${(e as Error).message}`) }
  }
  const systems: [System, string][] = f?.inherited ? [['motion', 'Motion']] : [...(canMotion ? [['motion', 'Motion'] as [System, string]] : []), ['tailwind', 'Tailwind'], ...(f?.system === 'css' && f.kfName ? [['css', 'CSS'] as [System, string]] : [])]
  return (
    <Section title={f ? `Edit · ${A.TRIGGERS[f.anim.trigger].label}` : 'New animation'}>
      <div className="trigs">{TRIGGER_CHIPS.map(t => <button key={t} className={'ezchip' + (a.trigger === t ? ' on' : '')} onClick={() => setTrigger(t)}>{A.TRIGGERS[t].label}</button>)}</div>
      {systems.length > 1 && <Seg value={draft.system} options={systems as unknown as readonly (readonly [System, ReactNode])[]} onChange={v => setDraft(d => (d ? { ...d, system: v } : d))} />}
      <Lbl>Keyframes</Lbl>
      <div className="kftrack">
        {a.frames.map((fr, j) => <button key={j} className={'kfd' + (j === i ? ' on' : '')} style={{ left: `${fr.at * 100}%` }} data-tip={frameName(j)} onClick={() => setSel(j)} />)}
      </div>
      <div className="framebar">
        <b>{frameName(i)}</b>
        {i > 0 && i < a.frames.length - 1 && <Num suffix="%" value={Math.round(frame.at * 100)} unit="" onChange={x => moveFrame(parseFloat(x))} />}
        <span className="sp" />
        <button className="b xs" data-tip="Add a keyframe after this one" onClick={addFrame}><Icon d={P.plus} size={12} /></button>
        {i > 0 && i < a.frames.length - 1 && <button className="b xs" data-tip="Remove this keyframe" onClick={removeFrame}><Icon d={P.trash} size={12} /></button>}
      </div>
      {i === 0 && isGesture(a.trigger) && !Object.keys(frame.values).length && <p className="stnote">Starts from however the element looks. Set values here only to change its resting look too.</p>}
      {Object.entries(frame.values).map(([k, v]) => (
        <div className="kv" key={k}>
          <span className="k mono" title={k}>{k}</span>
          {typeof v === 'number' ? <Num value={v} unit="" digits={2} step={Math.abs(v) <= 2 ? 0.05 : 1} onChange={x => { const n = parseFloat(x); if (!isNaN(n)) setValues(i, vals => ({ ...vals, [k]: n })) }} />
            : <Field mono value={String(v)} onChange={x => setValues(i, vals => ({ ...vals, [k]: x }))} />}
          <button className="b xs" data-tip="Remove" onClick={() => setValues(i, vals => { const n = { ...vals }; delete n[k]; return n })}><Icon d={P.x} size={12} /></button>
        </div>
      ))}
      <div className="kv">
        <div className="f"><input className="mono" list="w-anim-keys" placeholder="add a value: opacity, y, scale…" value={nk} onChange={e => setNk(e.target.value)} onKeyDown={e => e.key === 'Enter' && addKey(nk.trim())} spellCheck={false} /></div>
        <button className="b xs" data-tip="Add" disabled={!nk.trim()} onClick={() => addKey(nk.trim())}><Icon d={P.plus} size={12} /></button>
        <datalist id="w-anim-keys">{COMMON_KEYS.filter(k => !(k in frame.values)).map(k => <option key={k} value={k} />)}</datalist>
      </div>
      <Lbl>Timing</Lbl>
      <MotionTransition t={a.transition} set={setT} stagger={false} />
      {draft.system !== 'motion' && steps && <Row label="Keyframes name"><Field mono value={draft.name} placeholder="auto" onChange={x => setDraft(d => (d ? { ...d, name: x.replace(/[^\w-]/g, '-') } : d))} /></Row>}
      <p className="animd">{A.describe(a, rest)}</p>
      <pre className="pcode">{code || 'Nothing to write yet.'}</pre>
      {notes.map((n, j) => <p key={j} className="stnote">{n}</p>)}
      {err && <p className="cerr">{err}</p>}
      <div className="bldbar">
        <button className="b sm" onClick={() => previewAnim(el, a, rest)}><Icon d={P.play} size={11} />Preview</button>
        <button className="b sm save" disabled={busy} onClick={() => void run(() => saveAnim(el, draft, founds, info))}><Icon d={P.code} size={13} />{busy ? 'Saving…' : 'Save to code'}</button>
      </div>
      <div className="bldbar soft">
        {naming == null ? <button className="b sm" onClick={() => setNaming('')}>Save as preset…</button>
          : <div className="kv"><div className="f"><input autoFocus placeholder="preset name" value={naming} onChange={e => setNaming(e.target.value)} onKeyDown={e => { if (e.key === 'Enter') void keepPreset(naming); if (e.key === 'Escape') setNaming(null) }} /></div><button className="b xs" disabled={!naming.trim()} onClick={() => void keepPreset(naming)}><Icon d={P.check} size={12} /></button></div>}
        {f && f.system !== 'css' && !f.inherited && (confirmDel
          ? <button className="b sm danger" disabled={busy} onClick={() => void run(() => deleteAnim(el, f, founds, info))}>Remove it from code</button>
          : <button className="b sm" onClick={() => setConfirmDel(true)}><Icon d={P.trash} size={12} />Delete</button>)}
        <button className="b sm" onClick={() => onDone()}>Cancel</button>
      </div>
    </Section>
  )
}

function AnimateTab({ el, select, rev }: { el: HTMLElement; select: (el: HTMLElement | null) => void; rev: number }) {
  const cs = getComputedStyle(el)
  const set = (p: string) => (v: string) => editStyle(el, p, v)
  const durs = splitList(cs.transitionDuration).map(toMs), props = splitList(cs.transitionProperty)
  const moves = durs.some(d => d > 0)
  const names = splitList(cs.animationName).filter(n => n !== 'none')
  // one value per running animation; CSS repeats shorter lists, so expand before editing one entry
  const setAt = (p: string, i: number) => (v: string) => editStyle(el, p, names.map((_, j) => (j === i ? v : at(cs.getPropertyValue(p), j))).join(', '))
  const issues = motionIssues(el)
  const mf = motionFiber(el)
  return (
    <>
      <Crumbs el={el} select={select} />
      <AnimationsSection el={el} rev={rev} select={select} />
      {issues.length > 0 && <Section title="Motion checks" n={issues.length}>{issues.map((it, i) => <IssueRow key={i} it={it} />)}</Section>}
      <Section title="Fine-tune">
      {mf && <MotionSection el={el} f={mf} />}
      {(!mf || moves) && <Section title={mf ? 'CSS transition' : 'Transition'}>
        {!moves && <p className="empty">No transition yet. Give it a duration and state changes (hover, focus, press) animate.</p>}
        <Row label="Property"><Field mono value={cs.transitionProperty} onChange={set('transition-property')} placeholder="opacity, scale" /></Row>
        <Row label="Duration"><Num suffix="ms" value={durs[0] ?? 0} unit="ms" step={10} onChange={set('transition-duration')} /></Row>
        <Row label="Delay"><Num suffix="ms" value={toMs(at(cs.transitionDelay, 0))} unit="ms" step={10} onChange={set('transition-delay')} /></Row>
        {durs.length > 1 && <p className="stnote">These apply to all {props.length} transitioned properties.</p>}
        <Lbl>Easing</Lbl>
        <EasingEditor value={at(cs.transitionTimingFunction, 0) || 'ease'} duration={durs[0] || 300} onChange={set('transition-timing-function')} />
        <Lbl>Play</Lbl>
        <div className="playrow">{STATES.map(st => <button key={st} className="b sm" disabled={!moves} onClick={() => playState(el, st)}><Icon d={P.play} size={11} />{st[0].toUpperCase() + st.slice(1)}</button>)}</div>
      </Section>}
      {names.map((n, i) => (
        <Section key={n + i} title={`@keyframes ${n}`}>
          <Row label="Duration"><Num suffix="ms" value={toMs(at(cs.animationDuration, i))} unit="ms" step={10} onChange={setAt('animation-duration', i)} /></Row>
          <Row label="Delay"><Num suffix="ms" value={toMs(at(cs.animationDelay, i))} unit="ms" step={10} onChange={setAt('animation-delay', i)} /></Row>
          <Row label="Repeat"><Field mono value={at(cs.animationIterationCount, i)} onChange={setAt('animation-iteration-count', i)} placeholder="1 or infinite" /></Row>
          <Row label="Direction"><Pick value={at(cs.animationDirection, i)} options={['normal', 'reverse', 'alternate', 'alternate-reverse']} onChange={setAt('animation-direction', i)} /></Row>
          <Row label="Fill"><Pick value={at(cs.animationFillMode, i)} options={['none', 'forwards', 'backwards', 'both']} onChange={setAt('animation-fill-mode', i)} /></Row>
          <Lbl>Easing</Lbl>
          <EasingEditor value={at(cs.animationTimingFunction, i)} duration={toMs(at(cs.animationDuration, i))} onChange={setAt('animation-timing-function', i)} />
          <Lbl>Keyframes</Lbl>
          <KeyframeEditor el={el} name={n} />
          <button className="wide" onClick={() => replayKeyframes(el)}><Icon d={P.replay} />Replay</button>
        </Section>
      ))}
      </Section>
      <p className="stnote">Press <kbd>M</kbd> for the timeline: it catches animations as they run, and replays them at 25% or 10% speed.{mf && ' Motion runs some values (springs on x, y, scale) in JavaScript; those don’t show there, so replay them here.'}</p>
    </>
  )
}
/** Bottom drawer: every animation on the page as it runs, grouped by interaction; replay and slow motion. */
function Timeline({ area, pick }: { area: { l: number; t: number; w: number; h: number }; pick: (el: HTMLElement) => void }) {
  const [, tick] = useState(0)
  const [speed, setSpeedState] = useState(String(rec.rate) as '1' | '0.25' | '0.1')
  const [chosen, setChosen] = useState<number | null>(null) // a past group; null follows the latest
  const [paused, setPaused] = useState(false)
  useEffect(() => {
    let id = 0, n = -1
    const loop = () => {
      capture()
      if (rec.list.length !== n || rec.list.some(x => x.a.playState === 'running')) { n = rec.list.length; tick(v => v + 1) }
      id = requestAnimationFrame(loop)
    }
    id = requestAnimationFrame(loop)
    return () => { cancelAnimationFrame(id); setSpeed(1) } // closing the timeline puts the page back at full speed
  }, [])
  const gs = groupsOf(rec.list), gi = chosen ?? gs.length - 1, g = gs[gi] ?? [], g0 = g[0]?.t0 ?? 0
  const rows = g.map(x => {
    const t = x.a.effect?.getComputedTiming(), r = Math.abs(x.a.playbackRate) || 1
    const delay = (Number(t?.delay) || 0) / r, active = Number(t?.activeDuration) / r
    const off = x.t0 - g0
    return { x, off, delay, active, local: x.a.playState === 'running' ? off + (Number(x.a.currentTime) || 0) / r : null }
  })
  const finite = rows.filter(r => Number.isFinite(r.active)).map(r => r.off + r.delay + r.active)
  const span = Math.max(300, ...finite, ...rows.filter(r => !Number.isFinite(r.active)).map(r => r.off + r.delay + 1200))
  const pct = (ms: number) => `${(Math.min(span, ms) / span) * 100}%`
  const room = Math.max(2, Math.floor((area.w - (area.w < 560 ? area.w * 0.4 + 64 : 290)) / 64)) // labels need ~64px each
  const step = [50, 100, 250, 500, 1000, 2000, 5000, 10000].find(s => span / s <= room) ?? 20000
  const ticks = Array.from({ length: Math.floor(span / step) + 1 }, (_, i) => i * step)
  const shown = gs.slice(-10), first = gs.length - shown.length
  const H = 200
  const pauseAll = () => {
    for (const a of document.getAnimations()) { const t = (a.effect as KeyframeEffect | null)?.target; if (t && t.getRootNode() === document) { if (paused) a.play(); else a.pause() } }
    setPaused(!paused)
  }
  return (
    <div className="tl" style={{ left: area.l, top: area.t + area.h - H, width: area.w, height: H }}>
      <div className="tlh">
        <Icon d={P.timer} size={14} /><b>Timeline</b>
        <div className="tlgroups">
          {shown.map((x, i) => <button key={first + i} className={'tlg' + (first + i === gi ? ' on' : '')} data-tip={`${x.length} animation${x.length === 1 ? '' : 's'}`} onClick={() => setChosen(first + i === gs.length - 1 ? null : first + i)}>{x.length}</button>)}
        </div>
        <span className="sp" />
        <Icon d={P.slow} size={14} />
        <Seg value={speed} options={[['1', '100%'], ['0.25', '25%'], ['0.1', '10%']] as const} onChange={v => { setSpeed(+v); setSpeedState(v) }} />
        <button className="b sm" data-tip={paused ? 'Resume all' : 'Pause all'} onClick={pauseAll}><Icon d={paused ? P.play : P.pause} /></button>
        <button className="b sm" data-tip="Replay" disabled={!g.length} onClick={() => { replayGroup(g); tick(v => v + 1) }}><Icon d={P.replay} /></button>
        <button className="b sm" data-tip="Clear" disabled={!rec.list.length} onClick={() => { rec.list.length = 0; setChosen(null); tick(v => v + 1) }}><Icon d={P.trash} /></button>
      </div>
      {!g.length ? <p className="empty pad">Hover, click or scroll the page (or press Play in the Animate tab). Animations show up here as they run.</p> : (
        <div className="tlbody">
          <div className="tlrow tlaxis"><span /><div className="tltrack">{ticks.map(t => <span key={t} style={{ left: pct(t) }}>{fmtMs(t)}</span>)}</div><span /></div>
          {rows.map(({ x, off, delay, active, local }, i) => (
            <div key={i} className="tlrow" role="button" onClick={() => pick(x.el)}>
              <span className="tln" title={`${label(x.el)} · ${x.name}`}><b>{label(x.el)}</b> {x.name}</span>
              <div className="tltrack">
                <i className={'tlbar ' + x.kind + (Number.isFinite(active) ? '' : ' inf')} style={{ left: pct(off + delay), width: Number.isFinite(active) ? `max(2px, ${pct(active)})` : `calc(100% - ${pct(off + delay)})` }} />
                {local != null && <i className="tlhead" style={{ left: pct(local) }} />}
              </div>
              <span className="tld">{Number.isFinite(active) ? fmtMs(active) : '∞'}</span>
            </div>
          ))}
        </div>
      )}
    </div>
  )
}

function DesignTab({ el, select }: { el: HTMLElement; select: (el: HTMLElement | null) => void }) {
  const cs = getComputedStyle(el), r = el.getBoundingClientRect(), { o, z } = ctxOf(el)
  const get = (p: string) => cs.getPropertyValue(p)
  const set = (p: string) => (v: string) => editStyle(el, p, v)
  const [px, py] = getPos(el)
  const x = (r.left - o.x) / z, y = (r.top - o.y) / z
  const flex = cs.display.includes('flex'), grid = cs.display.includes('grid')
  const moveTo = (axis: 'x' | 'y') => (v: string) => {
    const n = parseFloat(v)
    if (isNaN(n)) return
    if (axis === 'x') setPos(el, px + n - x, py); else setPos(el, px, py + n - y)
  }
  const box = (kind: 'padding' | 'margin') => (
    <div className="g2">{SIDES.map(([s, side]) => <Num key={s} suffix={s.toUpperCase()} value={get(`${kind}-${side}`)} onChange={set(`${kind}-${side}`)} />)}</div>
  )
  const align = cs.textAlign === 'start' ? 'left' : cs.textAlign === 'end' ? 'right' : cs.textAlign
  const shapes = !isSvgEl(el) ? [] : el.tagName === 'svg' ? [...el.querySelectorAll(SHAPE_SEL)] : [el]
  const s0 = shapes[0] ? getComputedStyle(shapes[0]) : null
  const setShapes = (p: string) => (v: string) => shapes.forEach(s => setStyle(s as HTMLElement, p, v))
  const paint = (v: string) => (v === 'none' || v.startsWith('url') ? 'transparent' : v)

  return (
    <>
      <Crumbs el={el} select={select} />
      <StateBar el={el} />
      <ChecksSection el={el} />
      <PropsSection el={el} />
      <Section title="Frame">
        <Lbl>Position</Lbl>
        <div className="g2"><Num suffix="X" value={x} onChange={moveTo('x')} /><Num suffix="Y" value={y} onChange={moveTo('y')} /></div>
        <Lbl>Dimensions</Lbl>
        <div className="g2"><Num suffix="W" value={get('width')} onChange={set('width')} /><Num suffix="H" value={get('height')} onChange={set('height')} /></div>
        <div className="g2">
          <Num suffix="°" value={cs.rotate === 'none' ? 0 : cs.rotate} unit="deg" onChange={set('rotate')} />
          <Num suffix="Z" value={cs.zIndex} unit="" onChange={set('z-index')} />
        </div>
      </Section>

      <Section title="Resizing">
        <div className="tiles3"><PinnedTile el={el} cs={cs} /><SizingTile el={el} cs={cs} /><PreviewTile el={el} /></div>
      </Section>

      <Section title="Layout">
        <Row label="Display"><Pick value={cs.display} options={DISPLAY} onChange={set('display')} /></Row>
        <Row label="Position"><Pick value={cs.position} options={POSITION} onChange={set('position')} /></Row>
        {flex && <>
          <Row label="Direction"><Pick value={cs.flexDirection} options={['row', 'column', 'row-reverse', 'column-reverse']} onChange={set('flex-direction')} /></Row>
          <Row label="Wrap"><Pick value={cs.flexWrap} options={['nowrap', 'wrap', 'wrap-reverse']} onChange={set('flex-wrap')} /></Row>
          <Row label="Justify"><Pick value={cs.justifyContent} options={['normal', 'flex-start', 'center', 'flex-end', 'space-between', 'space-around', 'space-evenly']} onChange={set('justify-content')} /></Row>
          <Row label="Align"><Pick value={cs.alignItems} options={['normal', 'stretch', 'flex-start', 'center', 'flex-end', 'baseline']} onChange={set('align-items')} /></Row>
        </>}
        {grid && <Row label="Columns"><Field mono value={cs.gridTemplateColumns} onChange={set('grid-template-columns')} /></Row>}
        {(flex || grid) && <Row label="Gap"><Num suffix="px" value={cs.columnGap} onChange={set('gap')} /></Row>}
        <Lbl>Padding</Lbl>{box('padding')}
        <Lbl>Margin</Lbl>{box('margin')}
      </Section>

      {s0 && <Section title="Vector">
        <Row label="Fill"><Color value={paint(s0.fill)} onChange={setShapes('fill')} /></Row>
        <Row label="Stroke"><Color value={paint(s0.stroke)} onChange={setShapes('stroke')} /></Row>
        <Row label="Weight"><Num suffix="px" value={s0.strokeWidth} onChange={setShapes('stroke-width')} /></Row>
        <button className="wide" onClick={() => openSvgEditor(el)}><Icon d={P.nib} />Open in SVG editor · Enter</button>
      </Section>}

      <Section title="Typography">
        <Field value={firstFamily(cs.fontFamily)} onChange={set('font-family')} />
        <div className="g2">
          <Num suffix="px" value={cs.fontSize} onChange={set('font-size')} />
          <Pick value={cs.fontWeight} options={WEIGHTS} onChange={set('font-weight')} />
          <Num suffix="LH" value={cs.lineHeight} onChange={set('line-height')} />
          <Num suffix="LS" value={cs.letterSpacing} step={0.1} onChange={set('letter-spacing')} />
        </div>
        <Seg value={align} options={TEXT_ALIGN} onChange={set('text-align')} />
        <Row label="Colour"><Color value={cs.color} onChange={set('color')} /></Row>
      </Section>

      <Section title="Appearance">
        <Row label="Opacity">
          <Num suffix="%" value={round(parseFloat(cs.opacity) * 100)} unit="" onChange={v => { const n = parseFloat(v); if (!isNaN(n)) editStyle(el, 'opacity', String(Math.min(100, Math.max(0, n)) / 100)) }} />
        </Row>
        <Row label="Radius"><Num suffix="px" value={cs.borderTopLeftRadius} onChange={set('border-radius')} /></Row>
        <Row label="Fill"><Color value={cs.backgroundColor} onChange={set('background-color')} /></Row>
        <Row label="Border"><Num suffix="px" value={cs.borderTopWidth} onChange={set('border-width')} /><Pick value={cs.borderTopStyle} options={BORDER} onChange={set('border-style')} /></Row>
        <Row label="Stroke"><Color value={cs.borderTopColor} onChange={set('border-color')} /></Row>
        <Row label="Shadow"><Field mono value={cs.boxShadow} onChange={set('box-shadow')} placeholder="none" /></Row>
      </Section>

      <Section title="CSS">
        {[...Array(el.style.length)].map((_, i) => {
          const p = el.style[i]
          return (
            <div className="kv" key={p}>
              <span className="k mono" title={p}>{p}</span>
              <Field mono value={el.style.getPropertyValue(p)} onChange={set(p)} />
              <button className="b xs" onClick={() => setStyle(el, p, '')}><Icon d={P.x} size={12} /></button>
            </div>
          )
        })}
        <AddProp el={el} />
      </Section>
    </>
  )
}

function PrototypeTab({ el, select }: { el: HTMLElement; select: (el: HTMLElement | null) => void }) {
  const cs = getComputedStyle(el), tag = el.tagName.toLowerCase()
  const handlers = Object.entries(reactProps(el) ?? {}).filter(([k, v]) => /^on[A-Z]/.test(k) && typeof v === 'function') as [string, (...a: unknown[]) => unknown][]
  const attr = (n: string) => el.getAttribute(n) ?? ''
  const setA = (n: string) => (v: string) => setAttr(el, n, v)
  const set = (p: string) => (v: string) => editStyle(el, p, v)
  return (
    <>
      <Crumbs el={el} select={select} />
      <Section title="Interactions">
        {handlers.length
          ? <div className="ilist">{handlers.map(([k, fn]) => <div key={k} className="irow"><b>{k}</b><span>{fn.name || 'anonymous'}()</span></div>)}</div>
          : <p className="empty">No React event handlers on this element.</p>}
        {tag === 'a' && <>
          <Row label="Link"><Field mono value={attr('href')} onChange={setA('href')} placeholder="https://" /></Row>
          <Row label="Target"><Pick value={attr('target') || '_self'} options={['_self', '_blank']} onChange={setA('target')} /></Row>
        </>}
        {tag === 'button' && <Row label="Type"><Pick value={attr('type') || 'submit'} options={['submit', 'button', 'reset']} onChange={setA('type')} /></Row>}
      </Section>
      <Section title="Accessibility">
        <Row label="Role"><Field value={attr('role')} onChange={setA('role')} placeholder="implicit" /></Row>
        <Row label="Label"><Field value={attr('aria-label')} onChange={setA('aria-label')} placeholder="aria-label" /></Row>
        {tag === 'img' && <Row label="Alt"><Field value={attr('alt')} onChange={setA('alt')} /></Row>}
        <Row label="Title"><Field value={attr('title')} onChange={setA('title')} /></Row>
        <Row label="Tab index"><Field mono value={attr('tabindex')} onChange={setA('tabindex')} placeholder={String(el.tabIndex)} /></Row>
      </Section>
    </>
  )
}

function GuidePanel({ g, update, remove }: { g: Guide; update: (p: Partial<Guide>) => void; remove: () => void }) {
  return (
    <>
      <Section title="Guide">
        <Row label="Axis"><Seg value={g.axis} options={[['x', 'Vertical'], ['y', 'Horizontal']] as const} onChange={axis => update({ axis })} /></Row>
        <Row label="Position"><Num suffix={g.axis === 'x' ? 'X' : 'Y'} value={g.pos} unit="" onChange={v => { const n = parseFloat(v); if (!isNaN(n)) update({ pos: n }) }} /></Row>
        <Row label="Pattern"><Seg value={g.pattern} options={[['solid', 'solid'], ['dashed', 'dashed'], ['dotted', 'dotted']] as const} onChange={pattern => update({ pattern })} /></Row>
        <Row label="Colour">
          <Swatch big value={g.color ?? '#f38020'} onChange={color => update({ color })} />
          <button className="b sm" disabled={!g.color} onClick={() => update({ color: undefined })}>Reset</button>
        </Row>
        <Check checked={!!g.locked} onChange={locked => update({ locked })}>Locked</Check>
      </Section>
      <Section title="Actions">
        <button className="wide danger" onClick={remove}><Icon d={P.trash} />Delete guide</button>
      </Section>
    </>
  )
}

const PREF_LABELS: [keyof typeof prefs, string][] = [['spacing', 'Show padding & margin'], ['snap', 'Smart snapping'], ['alwaysMeasure', 'Measure without holding Alt'], ['persist', 'Remember edits across reloads']]
/** Record this browser's open/close shortcut by pressing it, and show the text to put in code for everyone. */
function ShortcutField() {
  const [rec, setRec] = useState(false)
  const [msg, setMsg] = useState('')
  const own = ownShortcut()
  useEffect(() => {
    if (!rec) return
    recordingShortcut = true
    const on = (e: KeyboardEvent) => {
      e.preventDefault(); e.stopPropagation()
      if (e.key === 'Escape') { setRec(false); return }
      if (['Control', 'Alt', 'Shift', 'Meta', 'AltGraph', 'OS'].includes(e.key)) return // wait for the actual key
      const s = shortcutFromEvent(e)
      if (!s.ctrl && !s.alt && !s.meta && !/^F\d/.test(s.code)) { setMsg('Add Ctrl, Alt or Cmd (or use a function key) so it can’t clash with typing.'); return }
      try { localStorage.setItem(OWN_SHORTCUT, stringifyShortcut(s)) } catch { /* storage blocked */ }
      setMsg(''); setRec(false); bump()
    }
    addEventListener('keydown', on, true)
    return () => { recordingShortcut = false; removeEventListener('keydown', on, true) }
  }, [rec])
  const reset = () => { try { localStorage.removeItem(OWN_SHORTCUT) } catch { /* storage blocked */ } bump() }
  return (
    <div className="scut">
      <Row label="Shortcut">
        <button className={'b sm kbtn' + (rec ? ' tg' : '')} onClick={() => { setMsg(''); setRec(r => !r) }}>{rec ? 'Press keys… (Esc cancels)' : toggleLabel()}</button>
        {own && !rec && <button className="b xs" data-tip="Back to the app’s shortcut" onClick={reset}><Icon d={P.undo} size={13} /></button>}
      </Row>
      <p className="stnote">{msg || <>Only in this browser. For everyone: <code>{`<Watcher shortcut="${stringifyShortcut(activeShortcut())}" />`}</code></>}</p>
    </div>
  )
}
function Settings({ theme, setTheme, onClose }: { theme: 'light' | 'dark'; setTheme: (t: 'light' | 'dark') => void; onClose: () => void }) {
  const [, force] = useState(0)
  return (
    <>
      <div className="backdrop" onPointerDown={onClose} />
      <div className="menu">
        <Row label="Theme"><Seg value={theme} options={[['light', 'Light'], ['dark', 'Dark']] as const} onChange={setTheme} /></Row>
        {PREF_LABELS.map(([k, l]) => <Check key={k} checked={prefs[k]} onChange={v => { prefs[k] = v; savePrefs(); force(n => n + 1) }}>{l}</Check>)}
        <ShortcutField />
      </div>
    </>
  )
}

// ponytail: the Animate tab and timeline drawer are unfinished, so they're hidden until they ship; flip this to bring them back
const ANIMATE_TAB = false
const KEYS: [string, string][] = [
  ['Select & move', 'V'], ['Rectangle', 'R'], ['Pen · vector', 'P'], ['Pencil', '⇧P'], ['Text', 'T · dbl-click'], ['Pan', 'H · Space'],
  ['Measure spacing', 'hold Alt'], ['Open in SVG editor', 'Enter · dbl-click'], ['Pick colour from screen', 'I'], ['Pixel grid', '⇧G'],
  ['Zoom', 'Ctrl + scroll'], ['Fit / 100%', '⇧1 / Ctrl 0'],
  ['Parent / child', '⇧↵ / ↵'], ['Deep select', 'Ctrl click'], ['Nudge', '← ↑ → ↓'], ['Hide element', 'Del'], ['Undo / redo', 'Ctrl Z / Ctrl ⇧Z'],
  ['Anatomy', 'hold ⇧ · A to lock'], ['Canvas mode', '⇧C'], ['Responsive preview', '⇧V'], ['X-ray', 'X'], ['Duplicate', 'Ctrl D · Alt drag'], ['Copy / paste', 'Ctrl C / V'], ['Forward / back', '] / ['],
  ['Rulers', '⇧R'], ...(ANIMATE_TAB ? [['Animation timeline', 'M'] as [string, string]] : []),
]
const Help = () => (
  <div className="help">
    <p>Click anything to inspect it. Every value edits live. Drag from a ruler to drop a guide, click a guide to edit it.</p>
    <dl>{[...KEYS, ['Open / close Watcher', toggleLabel()]].map(([a, k]) => <div key={a}><dt>{a}</dt><dd><kbd>{k}</kbd></dd></div>)}</dl>
  </div>
)

type InspectorProps = {
  el: HTMLElement | null; rev: number; select: (el: HTMLElement | null) => void
  guide: Guide | null; updateGuide: (p: Partial<Guide>) => void; removeGuide: () => void
  theme: 'light' | 'dark'; setTheme: (t: 'light' | 'dark') => void; onClose: () => void; onCode: () => void
}
let showInspectorTab: (t: 'design' | 'prototype' | 'animate') => void = () => {}
const Inspector = memo(function Inspector({ el, rev, select, guide, updateGuide, removeGuide, theme, setTheme, onClose, onCode }: InspectorProps) {
  void rev // re-render trigger only
  const [tab, setTab] = useState<'design' | 'prototype' | 'animate'>('design')
  showInspectorTab = setTab
  const [menu, setMenu] = useState(false)
  const [copied, setCopied] = useState(false)
  const n = [...liveEdits().values()].reduce((s, p) => s + p.size, 0)
  const copy = () => { navigator.clipboard?.writeText(exportCSS()); setCopied(true); setTimeout(() => setCopied(false), 1200) }
  return (
    <>
      <div className="ph ih">
        <b>{guide ? 'Guide' : el ? 'Inspecting' : 'Inspector'}</b>
        <span className="sp" />
        <button className={'b xs' + (menu ? ' tg' : '')} data-tip="Settings" onClick={() => setMenu(m => !m)}><Icon d={P.gear} size={15} /></button>
        <button className="b xs" data-tip="Close panel" onClick={onClose}><Icon d={P.x} size={15} /></button>
      </div>
      {menu && <Settings theme={theme} setTheme={setTheme} onClose={() => setMenu(false)} />}
      <div className="tabbar"><Seg big value={tab} options={[['design', 'Design'], ['prototype', 'Prototype'], ...(ANIMATE_TAB ? [['animate', 'Animate']] as const : [])] as const} onChange={setTab} /></div>
      <div className="pb">
        {guide ? <GuidePanel g={guide} update={updateGuide} remove={removeGuide} />
          : !el ? <Help />
          : tab === 'design' ? <DesignTab el={el} select={select} />
          : tab === 'prototype' ? <PrototypeTab el={el} select={select} />
          : <AnimateTab el={el} select={select} rev={rev} />}
      </div>
      {!guide && (
        <div className="foot">
          <span>{n ? `${n} edit${n > 1 ? 's' : ''}` : 'No edits yet'}</span>
          <button className="b sm" disabled={!n} onClick={onCode} data-tip="Apply to code"><Icon d={P.code} /></button>
          <button className="b sm" disabled={!n} onClick={copy} data-tip="Copy edits as CSS"><Icon d={copied ? P.check : P.copy} /></button>
          <button className="b sm" disabled={!n} onClick={() => resetEdits()} data-tip="Reset all edits"><Icon d={P.undo} /></button>
        </div>
      )}
    </>
  )
})

// ── layer tree ──────────────────────────────────────────────────────────────
type TreeCtx = { sel: HTMLElement | null; open: Set<Element>; toggle: (el: Element) => void; select: (el: HTMLElement) => void; hover: (el: HTMLElement | null) => void }

/** Label + icon for a layer row: component name, link/text content, .class, or tag. */
function layerInfo(el: Element) {
  const tag = el.tagName.toLowerCase(), comp = reactName(el), name = comp ?? el.getAttribute('data-layer')
  const text = hasText(el) ? el.textContent!.trim().replace(/\s+/g, ' ').slice(0, 60) : ''
  const leaf = !layerKids(el).length
  const icon = comp ? P.comp : tag === 'a' ? P.link : isSvgEl(el) ? P.nib : tag === 'img' ? P.image : text && leaf ? P.text : P.frame
  const cls = el.getAttribute('class')?.split(/\s+/)[0]
  const lbl = name ?? (text && (leaf || tag === 'a' || tag === 'button') ? text : cls ? '.' + cls : el.id ? '#' + el.id : tag)
  return { icon, label: lbl, comp: !!comp, sub: name ? text || tag : '' }
}
function Layer({ el, depth, c }: { el: HTMLElement; depth: number; c: TreeCtx }) {
  const kids = layerKids(el), isOpen = c.open.has(el), info = layerInfo(el)
  const on = c.sel === el
  return (
    <>
      <div className={'row' + (on ? ' on' : '') + (info.comp ? ' comp' : '')} style={{ paddingLeft: 6 + depth * 14 }} data-sel={on || undefined}
        onPointerEnter={() => c.hover(el)} onClick={() => c.select(el)}>
        <span className={'cv' + (isOpen ? ' open' : '')} onClick={e => { e.stopPropagation(); c.toggle(el) }}>{kids.length > 0 && <Icon d={P.chev} size={10} />}</span>
        <span className="ic"><Icon d={info.icon} size={13} /></span>
        <span className="nm">{info.label}</span>
        {info.sub && <span className="sub">{info.sub}</span>}
      </div>
      {isOpen && kids.map(k => <Layer key={idOf(k)} el={k} depth={depth + 1} c={c} />)}
    </>
  )
}

const LayerTree = memo(function LayerTree({ root, sel, rev, select, hover, filter }: { root: HTMLElement; sel: HTMLElement | null; rev: number; select: (el: HTMLElement) => void; hover: (el: HTMLElement | null) => void; filter: string }) {
  void rev
  const [open, setOpen] = useState<Set<Element>>(() => new Set(layerKids(root)))
  const box = useRef<HTMLDivElement>(null)
  useEffect(() => {
    if (!sel) return
    setOpen(o => { const n = new Set(o); for (let p = sel.parentElement; p && p !== root; p = p.parentElement) n.add(p); return n })
  }, [sel])
  useEffect(() => { box.current?.querySelector('[data-sel]')?.scrollIntoView({ block: 'nearest' }) }, [sel, open])
  const c: TreeCtx = { sel, open, select, hover, toggle: el => setOpen(o => { const n = new Set(o); if (!n.delete(el)) n.add(el); return n }) }
  if (filter) {
    // filter mode: a flat list of every matching element, with its parent for context
    const q = filter.toLowerCase()
    const hits = [...root.querySelectorAll<HTMLElement>('*')]
      .filter(el => !SKIP.has(el.tagName) && `${layerInfo(el).label} ${el.tagName} ${el.getAttribute('class') ?? ''} ${el.id}`.toLowerCase().includes(q))
      .slice(0, 300)
    return (
      <div className="pb tree" onPointerLeave={() => hover(null)}>
        {hits.length ? hits.map(el => { const info = layerInfo(el); return (
          <div key={idOf(el)} className={'row' + (el === sel ? ' on' : '')} style={{ paddingLeft: 12 }} onPointerEnter={() => hover(el)} onClick={() => select(el)}>
            <span className="ic"><Icon d={info.icon} size={13} /></span><span className="nm">{info.label}</span>
            <span className="sub">{el.parentElement ? crumbLabel(el.parentElement) : ''}</span>
          </div>
        ) }) : <p className="empty pad">No layers match “{filter}”.</p>}
      </div>
    )
  }
  return (
    <div className="pb tree" ref={box} onPointerLeave={() => hover(null)}>
      {layerKids(root).map(k => <Layer key={idOf(k)} el={k} depth={0} c={c} />)}
    </div>
  )
})

// ── design system extraction ────────────────────────────────────────────────
type Tally = Map<string, number>
const DS_KEYS = ['colors', 'gradients', 'families', 'textStyles', 'sizes', 'weights', 'lineHeights', 'tracking', 'radii', 'spacing', 'shadows', 'borders'] as const
type DSKey = (typeof DS_KEYS)[number]
const tallies = () => Object.fromEntries(DS_KEYS.map(k => [k, new Map()])) as Record<DSKey, Tally>
// Accumulates across scans: rescan after navigating your SPA and new routes' tokens merge in.
const ds = { ...tallies(), vars: new Map<string, string>(), elements: 0, pages: new Set<string>() }

function scanStyles() {
  const cur = tallies()
  const add = (k: DSKey, v: string) => { if (v) cur[k].set(v, (cur[k].get(v) ?? 0) + 1) }
  const px = (v: string) => { const n = Math.round(parseFloat(v) * 100) / 100; return n > 0 ? n + 'px' : '' }
  const color = (v: string) => { if (v && !v.startsWith('url') && v !== 'none' && rgba(v).a > 0) add('colors', v) }
  let n = 0
  for (const el of document.body.querySelectorAll<HTMLElement>('*')) {
    if (SKIP.has(el.tagName)) continue
    const cs = getComputedStyle(el)
    if (cs.display === 'none' || cs.visibility === 'hidden') continue
    n++
    if ([...el.childNodes].some(t => t.nodeType === 3 && t.textContent!.trim())) {
      color(cs.color)
      add('families', cs.fontFamily)
      add('sizes', px(cs.fontSize))
      add('weights', cs.fontWeight)
      add('lineHeights', cs.lineHeight === 'normal' ? 'normal' : px(cs.lineHeight))
      if (cs.letterSpacing !== 'normal') add('tracking', cs.letterSpacing)
      add('textStyles', `${cs.fontWeight} ${px(cs.fontSize)}/${cs.lineHeight === 'normal' ? 'normal' : px(cs.lineHeight)} ${cs.fontFamily}`)
    }
    color(cs.backgroundColor)
    if (cs.backgroundImage.includes('gradient')) add('gradients', cs.backgroundImage)
    if (parseFloat(cs.borderTopWidth) && cs.borderTopStyle !== 'none') { color(cs.borderTopColor); add('borders', `${px(cs.borderTopWidth)} ${cs.borderTopStyle}`) }
    if (el instanceof SVGElement) { color(cs.fill); color(cs.stroke) }
    if (parseFloat(cs.borderRadius)) add('radii', cs.borderRadius)
    // ponytail: vertical margins only, horizontal ones are mostly `auto` centering and resolve to noise
    for (const v of [cs.paddingTop, cs.paddingRight, cs.paddingBottom, cs.paddingLeft, cs.marginTop, cs.marginBottom]) add('spacing', px(v))
    if (/flex|grid/.test(cs.display)) for (const g of new Set([cs.rowGap, cs.columnGap])) add('spacing', px(g))
    if (cs.boxShadow !== 'none') add('shadows', cs.boxShadow)
  }
  for (const k of DS_KEYS) for (const [v, c] of cur[k]) ds[k].set(v, c)
  ds.elements = n
  ds.pages.add(location.pathname)

  for (const [k, v] of rootVars()) ds.vars.set(k, v)
}
/** CSS custom properties declared on :root / html, resolved to their current value. */
function rootVars() {
  const out = new Map<string, string>(), root = getComputedStyle(document.documentElement)
  const walk = (rules: CSSRuleList) => {
    for (const r of rules) {
      if (r instanceof CSSStyleRule && /(^|,)\s*(:root|html)\s*(,|$)/.test(r.selectorText)) {
        for (const p of r.style) if (p.startsWith('--')) out.set(p, root.getPropertyValue(p).trim())
      } else if ('cssRules' in r) walk((r as CSSGroupingRule).cssRules)
    }
  }
  for (const s of document.styleSheets) { try { walk(s.cssRules) } catch { /* cross-origin sheet */ } }
  return out
}

// ── motion: transitions, keyframes, easing, and a recorder for the timeline ──
/** Split a CSS list on top-level commas (cubic-bezier(…) has commas of its own). */
function splitList(v: string) {
  const out: string[] = []
  let depth = 0, cur = ''
  for (const ch of v) {
    if (ch === '(') depth++; else if (ch === ')') depth--
    if (ch === ',' && !depth) { out.push(cur.trim()); cur = '' } else cur += ch
  }
  if (cur.trim()) out.push(cur.trim())
  return out
}
const toMs = (v: string) => (v.trim().endsWith('ms') ? parseFloat(v) : parseFloat(v) * 1000) || 0
const fmtMs = (n: number) => (n >= 1000 ? `${round(n / 1000, 2)}s` : `${Math.round(n)}ms`)
const at = (list: string, i: number) => { const l = splitList(list); return l[i % l.length] ?? '' } // CSS repeats a short list
type Bez = [number, number, number, number]
const KEYWORD_EASE: Record<string, Bez> = { ease: [0.25, 0.1, 0.25, 1], 'ease-in': [0.42, 0, 1, 1], 'ease-out': [0, 0, 0.58, 1], 'ease-in-out': [0.42, 0, 0.58, 1], linear: [0, 0, 1, 1] }
function parseEase(v: string): Bez | null {
  const t = v.trim()
  if (KEYWORD_EASE[t]) return KEYWORD_EASE[t]
  const n = /^cubic-bezier\(([^)]+)\)$/.exec(t)?.[1].split(',').map(Number)
  return n?.length === 4 && n.every(Number.isFinite) ? (n as Bez) : null
}
const bezText = (p: number[]) => `cubic-bezier(${p.map(n => round(n, 2)).join(', ')})`
const normEase = (v: string) => { const p = parseEase(v); return p ? bezText(p) : v.trim() }
const isEaseIn = (v: string) => { const p = parseEase(v); return !!p && p[0] >= 0.3 && p[1] <= 0.1 && p[2] >= 0.9 && p[3] >= 0.9 }
// ease-out family first: interactions should respond at once and settle (cubic-bezier(0.2, 0, 0, 1) is the snappy one)
const EASE_PRESETS: [string, string][] = [
  ['Ease out', 'cubic-bezier(0, 0, 0.2, 1)'], ['Snappy', 'cubic-bezier(0.2, 0, 0, 1)'], ['In-out', 'cubic-bezier(0.4, 0, 0.2, 1)'], ['Linear', 'linear'], ['Ease in', 'cubic-bezier(0.4, 0, 1, 1)'],
]
function keyframesRule(doc: Document, name: string): CSSKeyframesRule | null {
  const walk = (rules: CSSRuleList): CSSKeyframesRule | null => {
    for (const r of rules) {
      if ('appendRule' in r && (r as CSSKeyframesRule).name === name) return r as CSSKeyframesRule
      const kids = (r as CSSGroupingRule).cssRules
      if (kids && !('keyText' in r)) { const f = walk(kids); if (f) return f }
    }
    return null
  }
  for (const sh of doc.styleSheets) { try { const f = walk(sh.cssRules); if (f) return f } catch { /* cross-origin sheet */ } }
  return null
}
// keyframe edits live in the page's stylesheet; history keys look like "&float|50%|translate"
function kfRule(doc: Document, name: string, off: string, create: boolean) {
  const r = keyframesRule(doc, name)
  if (!r) return null
  let k = r.findRule(off)
  if (!k && create) { r.appendRule(`${off} {}`); k = r.findRule(off) }
  return k
}
function writeKeyframe(doc: Document, name: string, off: string, prop: string, v: string) {
  const k = kfRule(doc, name, off, !!v && v !== '\u0000')
  if (!k) return
  if (!v || v === '\u0000') k.style.removeProperty(prop); else k.style.setProperty(prop, v)
}
function setKeyframeProp(el: HTMLElement, name: string, off: string, prop: string, v: string) {
  record(el, `&${name}|${off}|${prop}`, () => kfRule(el.ownerDocument, name, off, false)?.style.getPropertyValue(prop) || '\u0000')
  writeKeyframe(el.ownerDocument, name, off, prop, v)
  bump()
}
/** The file a rule came from: Vite tags the <style> it injects with its path. */
const sheetFile = (r: CSSRule) => (r.parentStyleSheet?.ownerNode as Element | null)?.getAttribute?.('data-vite-dev-id') ?? null

// what the Vite plugin knows about the project: Tailwind version, Motion package, the theme stylesheet
type ServerInfo = { tailwind: number; motion: string | null; theme: string | null }
let infoP: Promise<ServerInfo | null> | null = null
const serverInfo = () => (infoP ??= fetch('/__watcher/ping').then(r => (r.ok ? r.json() : null)).then(j => (j?.ok ? j : null)).catch(() => null))
function useServerInfo() {
  const [info, setInfo] = useState<ServerInfo | null | undefined>(undefined)
  useEffect(() => { void serverInfo().then(setInfo) }, [])
  return info
}
type CssEdit = { kind: 'keyframes'; file: string; name: string; offset: string; prop: string; value: string | null }
  | { kind: 'theme'; name: string; value: string }
  | { kind: 'keyframes-block'; file?: string; name: string; css: string | null; fresh?: boolean }
type CssResult = { ok: boolean; error?: string; file?: string; name?: string }
async function postCss(edits: CssEdit[], dryRun: boolean): Promise<CssResult[]> {
  const r = await fetch('/__watcher/css', { method: 'POST', headers: { 'content-type': 'application/json', 'x-watcher': '1' }, body: JSON.stringify({ dryRun, edits }) })
  const j = await r.json()
  if (j.error) throw new Error(j.error)
  return j.results
}

/** Play a state's transition: back to rest, into the state, hold, then back to whatever was showing. */
function playState(el: HTMLElement, st: State) {
  const was = forced.get(el) ?? null, cs = getComputedStyle(el)
  const total = Math.max(0, ...splitList(cs.transitionDuration).map((d, i) => toMs(d) + toMs(at(cs.transitionDelay, i))))
  forceState(el, null)
  requestAnimationFrame(() => requestAnimationFrame(() => {
    forceState(el, st)
    setTimeout(() => forceState(el, was), (total + 450) / rec.rate)
  }))
}
/** Restart an element's keyframe animations (a finished one isn't in getAnimations() any more). */
function replayKeyframes(el: HTMLElement) {
  const v = el.style.getPropertyValue('animation-name'), pri = el.style.getPropertyPriority('animation-name')
  el.style.setProperty('animation-name', 'none', 'important')
  void el.offsetWidth
  if (v) el.style.setProperty('animation-name', v, pri); else el.style.removeProperty('animation-name')
  setTimeout(() => { for (const a of el.getAnimations()) if (rec.rate !== 1) a.updatePlaybackRate(rec.rate) })
}
/** Motion that tends to feel wrong: what the make-interfaces-feel-better rules flag. */
function motionIssues(el: HTMLElement): Issue[] {
  const cs = getComputedStyle(el), out: Issue[] = []
  const add = (rule: string, msg: string, fix?: Issue['fix']) => out.push({ el, sev: 'warn', rule, msg, fix })
  const durs = splitList(cs.transitionDuration).map(toMs), moves = durs.some(d => d > 0)
  if (moves && splitList(cs.transitionProperty).includes('all'))
    add('motion-all', 'transition: all also animates layout and colours you didn’t mean to, and costs more. List the properties that should move.')
  if (moves && splitList(cs.transitionTimingFunction).some(isEaseIn)) {
    const tok = themeTokens().eases.find(e => e.name === '--ease-out')
    add('motion-ease', 'ease-in starts slowly, so the response feels late. Use ease-out for state changes.', { label: tok ? tok.name : 'ease-out', run: () => editStyle(el, 'transition-timing-function', tok ? `var(${tok.name})` : 'cubic-bezier(0, 0, 0.2, 1)') })
  }
  const max = Math.max(0, ...durs)
  if (max > 400) add('motion-slow', `A ${fmtMs(max)} transition feels sluggish for hover and press feedback. 150–300ms reads as responsive.`, { label: '200ms', run: () => editStyle(el, 'transition-duration', '200ms') })
  // Motion sets these every frame; a CSS transition on the same property restarts each frame and lags behind (mushy springs)
  const mf = motionFiber(el)
  if (mf && moves) {
    const fought = motionCssProps(currentProps(mf) as Vals), listed = splitList(cs.transitionProperty)
    const clash = listed.includes('all') ? [...fought] : listed.filter(x => fought.has(x))
    if (clash.length) {
      const keep = listed.filter(x => x !== 'all' && !fought.has(x) && !x.startsWith('--'))
      add('motion-fight', `Motion animates ${clash.join(', ')}, and a CSS transition does too, so every frame Motion sets restarts it and the animation lags. Leave those to Motion.`,
        keep.length ? { label: 'Drop from CSS', run: () => editStyle(el, 'transition-property', keep.join(', ')) } : undefined)
    }
  }
  if (cs.willChange !== 'auto' && splitList(cs.willChange).some(p => !/^(transform|translate|scale|rotate|opacity|filter|scroll-position|contents)$/.test(p)))
    add('motion-will-change', `will-change: ${cs.willChange} reserves memory for properties the GPU can’t composite. Keep it to transform, opacity or filter, and only where the first frame stutters.`)
  return out
}

// ── Motion (motion.dev): read and edit motion.* props, replay them, preview springs ──
/** The motion.* component rendering `el` (its render function is named "motion.div" and so on). */
function motionFiber(el: Element): Fiber | null {
  for (let f = fiberOf(el)?.return ?? null; f; f = f.return) {
    if (typeof f.type === 'string') return null // another DOM element in between: not this component's own node
    if (typeName(f.type)?.startsWith('motion.')) return f
  }
  return null
}
const MOTION_STATES = [['initial', 'Initial'], ['animate', 'Animate'], ['whileHover', 'Hover'], ['whileTap', 'Press'], ['whileFocus', 'Focus'], ['whileInView', 'In view'], ['exit', 'Exit']] as const
/** A state's values: written inline, or a variant label looked up in `variants`. */
function stateOf(p: Vals, key: string): { path: string; values: Vals; label?: string } | null {
  const v = p[key]
  if (isObj(v)) return { path: key, values: v }
  const label = typeof v === 'string' ? v : Array.isArray(v) && typeof v[0] === 'string' ? v[0] : undefined
  return label && isObj(p.variants) && isObj(p.variants[label]) ? { path: `variants.${label}`, values: p.variants[label] as Vals, label } : null
}
let synthetic = false // our own pointer events for Motion's gestures; the overlay's listeners ignore them
function fire(el: Element, type: string) {
  synthetic = true
  try { el.dispatchEvent(new PointerEvent(type, { bubbles: !/enter|leave/.test(type), cancelable: true, composed: true, pointerType: 'mouse', isPrimary: true, button: 0 })) }
  finally { synthetic = false }
}
/** Trigger whileHover / whileTap / whileFocus the way a person would, hold, then let go. */
function playGesture(el: HTMLElement, g: 'whileHover' | 'whileTap' | 'whileFocus') {
  const hold = 900
  if (g === 'whileHover') { fire(el, 'pointerenter'); setTimeout(() => fire(el, 'pointerleave'), hold) }
  else if (g === 'whileTap') { fire(el, 'pointerdown'); setTimeout(() => fire(el, 'pointerup'), hold) }
  else { el.focus({ focusVisible: true } as FocusOptions); setTimeout(() => el.blur(), hold) }
}
/** Play the enter animation again: jump to `initial` instantly, then hand `animate` back so it runs with its real transition. */
function replayEnter(el: HTMLElement, f: Fiber) {
  const r = renderer(el.ownerDocument), p = currentProps(f) as Vals
  if (!r) return
  const set = (v: unknown) => (v === undefined ? r.overridePropsDeletePath(currentFiber(f), ['animate']) : r.overrideProps(currentFiber(f), ['animate'], v))
  if (typeof p.animate === 'string' && typeof p.initial === 'string') {
    // variant labels: children follow the label, so flip it (their own transitions run both ways)
    set(p.initial); setTimeout(() => set(p.animate), 450); return
  }
  const from = stateOf(p, 'initial'), to = p.animate ?? stateOf(p, 'whileInView')?.values
  if (!from || to === undefined) { notify('Nothing to replay: there’s no initial state to start from.'); return }
  set({ ...from.values, transition: { type: false } }) // type: false is Motion's "no animation"
  setTimeout(() => set(to), 60)
  if (p.animate === undefined) setTimeout(() => set(undefined), 2500) // whileInView took over; give it back
}
const TRANSFORM_KEYS = /^(x|y|z|scale[XYZ]?|rotate[XYZ]?|skew[XY]?|translate[XYZ]|perspective)$/
/** CSS properties a motion component animates, across all its states and variants. */
function motionCssProps(p: Vals) {
  const out = new Set<string>()
  const scan = (v: unknown) => {
    if (!isObj(v)) return
    for (const k of Object.keys(v)) {
      if (k === 'transition' || k === 'transitionEnd') continue
      if (TRANSFORM_KEYS.test(k)) ['transform', 'translate', 'scale', 'rotate'].forEach(x => out.add(x))
      else out.add(k.replace(/[A-Z]/g, c => '-' + c.toLowerCase()))
    }
  }
  for (const [k] of MOTION_STATES) scan(p[k])
  if (isObj(p.variants)) Object.values(p.variants).forEach(scan)
  return out
}
// ── reading the animations an element already has ──
// Values come from the browser (themes, CSS variables, group-hover and plain CSS all resolved); the className only
// says which classes are behind each animation, so a rewrite replaces exactly those.
const PROBE = ['opacity', 'translate', 'scale', 'rotate', 'transform', 'filter', 'backdrop-filter', 'background-color', 'color', 'border-color', 'box-shadow', 'outline-color', 'border-radius', 'animation-name']
type Diff = Record<string, [string, string]>
const snap = (el: Element) => { const cs = getComputedStyle(el); return Object.fromEntries(PROBE.map(p => [p, cs.getPropertyValue(p)])) as Record<string, string> }
const diffOf = (a: Record<string, string>, b: Record<string, string>): Diff => Object.fromEntries(PROBE.filter(p => a[p] !== b[p]).map(p => [p, [a[p], b[p]]]))
/** Declarations from @starting-style rules that apply to `el` (top-level or nested), in source order. */
function startingDecls(el: Element): [string, string][] {
  const out: [string, string][] = [], win = el.ownerDocument.defaultView!
  const take = (st: CSSStyleDeclaration) => { for (const p of st) out.push([p, st.getPropertyValue(p)]) }
  const walk = (rules: CSSRuleList, starting: boolean, matched: boolean) => {
    for (const r of rules) {
      const text = r.cssText
      if ('selectorText' in r) {
        let m = false
        try { m = el.matches((r as CSSStyleRule).selectorText) } catch { /* a nested & selector */ }
        if (starting && m) take((r as CSSStyleRule).style)
        if (m && (r as CSSStyleRule).cssRules?.length) walk((r as CSSStyleRule).cssRules, starting, true)
      } else if ('style' in r && starting && matched) take((r as CSSStyleRule).style) // nested declarations inside @starting-style
      else if ((r as CSSGroupingRule).cssRules) {
        if (text.startsWith('@media') && !win.matchMedia((r as CSSMediaRule).conditionText).matches) continue
        walk((r as CSSGroupingRule).cssRules, starting || text.startsWith('@starting-style'), matched)
      }
    }
  }
  for (const sh of el.ownerDocument.styleSheets) { try { walk(sh.cssRules, false, false) } catch { /* cross-origin sheet */ } }
  return out
}
let probing = false
/** Make the page's real :hover/:active/:focus rules unmatchable until the returned function puts them back. */
function muteStates(doc: Document) {
  const changed: [CSSStyleRule, string][] = []
  const walk = (rules: CSSRuleList) => {
    for (const r of rules) {
      if ('selectorText' in r) {
        const sel = (r as CSSStyleRule).selectorText, muted = muteSelectors(sel)
        if (muted !== sel) { (r as CSSStyleRule).selectorText = muted; changed.push([r as CSSStyleRule, sel]) }
      }
      if ((r as CSSGroupingRule).cssRules) walk((r as CSSGroupingRule).cssRules)
    }
  }
  for (const sh of doc.styleSheets) { try { walk(sh.cssRules) } catch { /* cross-origin sheet */ } }
  return () => { for (const [r, sel] of changed) r.selectorText = sel }
}
const probeNodes = new WeakSet<Node>() // temporary copies the probe inserts; DOM observers ignore them
const onlyProbe = (list: MutationRecord[]) => list.every(r => [...r.addedNodes, ...r.removedNodes].every(n => probeNodes.has(n)))
// timing as the element has it at rest (and per state for keyframes that only run in that state)
const TIMING = ['transition-property', 'transition-duration', 'transition-timing-function', 'transition-delay',
  'animation-name', 'animation-duration', 'animation-timing-function', 'animation-delay', 'animation-iteration-count', 'animation-direction'] as const
type Timing = Record<(typeof TIMING)[number], string>
const timingOf = (el: Element) => { const cs = getComputedStyle(el); return Object.fromEntries(TIMING.map(p => [p, cs.getPropertyValue(p)])) as Timing }
type Probe = { rest: Record<string, string>; states: Partial<Record<State, Diff>>; starting: Diff | null; timing: Timing; stateTiming: Partial<Record<State, Timing>> }
/** What the element looks like at rest, in each state, and before it appears, with every transition switched off
 *  so nothing on the page animates while Watcher looks. */
function probe(el: HTMLElement): Probe {
  const doc = el.ownerDocument, quiet = new doc.defaultView!.CSSStyleSheet()
  // the copy the probe reads transition timing from keeps its transitions (it's new, so nothing on it can animate)
  quiet.replaceSync(':not([data-wprobe]), :not([data-wprobe])::before, :not([data-wprobe])::after { transition: none !important; }')
  doc.adoptedStyleSheets = [...doc.adoptedStyleSheets, quiet]
  const was = forced.get(el) ?? null, style = el.getAttribute('style')
  const out: Probe = { rest: {}, states: {}, starting: null, timing: {} as Timing, stateTiming: {} }
  probing = true
  // the forced-state copies are built from the real rules, so build them first; then the pointer can't sway the reading
  forced.set(el, 'hover'); applyStates(doc)
  const unmute = muteStates(doc)
  try {
    forced.delete(el); applyStates(doc)
    out.rest = snap(el)
    for (const st of STATES) {
      forced.set(el, st); applyStates(doc)
      const d = diffOf(out.rest, snap(el))
      if (Object.keys(d).length) out.states[st] = d
      if (d['animation-name']) out.stateTiming[st] = timingOf(el)
    }
    // timing, read while the page's real states are muted (the pointer may be over the element): from an untouched
    // copy beside it, since the element's own transitions are switched off. A running animation also shows in computed
    // values (opacity 0.82 mid-pulse), so the element's own values come from that copy with animations off; the real
    // animation is never restarted.
    const c = el.cloneNode(false) as HTMLElement
    probeNodes.add(c)
    c.setAttribute('data-wprobe', '')
    for (const [p, v] of [['visibility', 'hidden'], ['position', 'absolute'], ['pointer-events', 'none']]) c.style.setProperty(p, v, 'important')
    el.after(c)
    try {
      out.timing = timingOf(c)
      if (out.timing['animation-name'] !== 'none') {
        c.style.setProperty('animation', 'none', 'important')
        const own = snap(c)
        for (const p of PROBE) if (p !== 'animation-name') out.rest[p] = own[p]
      }
    } finally { c.remove() }
    forced.delete(el); applyStates(doc)
    // @starting-style can't be forced: apply its declarations inline for a moment (vars and calc resolve) and read them
    const decls = startingDecls(el)
    if (decls.length) {
      for (const [p, v] of decls) el.style.setProperty(p, v)
      const d = diffOf(snap(el), out.rest)
      if (Object.keys(d).length) out.starting = d
    }
  } finally {
    unmute()
    if (style == null) el.removeAttribute('style'); else el.setAttribute('style', style)
    if (was) forced.set(el, was); else forced.delete(el)
    applyStates(doc)
    void getComputedStyle(el).opacity // settle while transitions are still off, so putting things back doesn't animate
    doc.adoptedStyleSheets = doc.adoptedStyleSheets.filter(x => x !== quiet)
    probing = false
  }
  return out
}
/** Two snapshots of CSS values as IR from/to values: only what actually differs. */
function valuesOf(d: Diff) {
  const from: A.Values = {}, to: A.Values = {}
  for (const [p, [a, b]] of Object.entries(d)) {
    if (p === 'animation-name') continue
    const va = A.cssToValues(p, a), vb = A.cssToValues(p, b)
    for (const k of new Set([...Object.keys(va), ...Object.keys(vb)])) {
      if (A.sameValue(va[k], vb[k])) continue
      if (va[k] !== undefined) from[k] = va[k]
      if (vb[k] !== undefined) to[k] = vb[k]
    }
  }
  return { from, to }
}
/** The CSS transition entry that times these properties (lists repeat; `all` and `transform` cover more). */
function cssTiming(cs: Timing, props: string[]): { t: A.Transition; missing: string[] } {
  const list = splitList(cs['transition-property']), missing: string[] = []
  let idx = -1
  for (const p of props) {
    const i = list.findIndex(x => x === p || x === 'all' || (x === 'transform' && /^(translate|scale|rotate)$/.test(p)))
    if (i < 0) missing.push(p); else if (idx < 0) idx = i
  }
  if (idx < 0) return { t: { type: 'tween', duration: 0 }, missing }
  return { t: A.transitionFromCss(toMs(at(cs['transition-duration'], idx)), at(cs['transition-timing-function'], idx), toMs(at(cs['transition-delay'], idx))), missing }
}
function keyframeFrames(rule: CSSKeyframesRule): A.Frame[] {
  const m = new Map<number, A.Values>()
  for (const k of [...rule.cssRules] as CSSKeyframeRule[]) {
    const vals: A.Values = {}
    for (const p of k.style) if (!p.startsWith('--') && p !== 'animation-timing-function') Object.assign(vals, A.cssToValues(p, k.style.getPropertyValue(p)))
    for (const o of k.keyText.split(',')) { const t = o.trim(), pos = t === 'from' ? 0 : t === 'to' ? 1 : A.r4(parseFloat(t) / 100); m.set(pos, { ...(m.get(pos) ?? {}), ...vals }) }
  }
  if (!m.has(0)) m.set(0, {})
  if (!m.has(1)) m.set(1, {})
  return [...m].sort((a, b) => a[0] - b[0]).map(([pos, values]) => ({ at: pos, values }))
}
type System = 'motion' | 'tailwind' | 'css'
type Found = { key: string; anim: A.Anim; system: System; motion?: A.MotionFound; tw?: { anim: A.Anim; classes: A.TwClass[] }; kfName?: string; state?: State; rest: A.Values; notes: string[]; inherited?: boolean }
/** Variant labels a motion element follows from the nearest motion ancestor that sets them (staggered lists). */
function inheritedLabels(f: Fiber): { initial?: string; animate?: string; from?: string } {
  for (let p = f.return; p; p = p.return) {
    const n = typeName(p.type)
    if (!n?.startsWith('motion.')) continue
    const q = currentProps(p) as Record<string, unknown>
    if (typeof q.animate === 'string') return { initial: typeof q.initial === 'string' ? q.initial : undefined, animate: q.animate, from: n }
    if (q.animate !== undefined || q.inherit === false) return {}
  }
  return {}
}
const STATE_TRIGGER: Record<State, A.Trigger> = { hover: 'hover', active: 'press', focus: 'focus' }
const TRIGGER_ORDER: A.Trigger[] = ['enter', 'inView', 'hover', 'press', 'focus', 'loop']
/** Every animation an element has: CSS state changes, @starting-style, keyframes, and Motion props. */
function interpret(el: HTMLElement): Found[] {
  const out: Found[] = []
  const pr = probe(el), cs = pr.timing, model = A.classifyTailwind(el.getAttribute('class') ?? '')
  const rest: A.Values = Object.assign({}, ...Object.entries(pr.rest).filter(([p]) => p !== 'animation-name' && p !== 'transform').map(([p, v]) => A.cssToValues(p, v)))
  const jumpNote = (missing: string[]) => missing.length ? [`${missing.join(', ')} ${missing.length === 1 ? 'isn’t' : 'aren’t'} in transition-property, so ${missing.length === 1 ? 'it jumps' : 'they jump'} instead of animating`] : []
  for (const st of STATES) {
    const d = pr.states[st]
    if (!d) continue
    const trigger = STATE_TRIGGER[st], { from, to } = valuesOf(d)
    if (!Object.keys(to).length) continue
    const { t, missing } = cssTiming(cs, A.cssPropsOf(Object.keys(to)))
    const classes = model.states[trigger] ?? [], anim: A.Anim = { trigger, frames: A.fromTo(from, to), transition: t }
    out.push({ key: `css:${trigger}`, anim, system: classes.length ? 'tailwind' : 'css', tw: { anim, classes }, state: st, rest, notes: jumpNote(missing) })
  }
  if (pr.starting) {
    const { from, to } = valuesOf(pr.starting)
    if (Object.keys(from).length) {
      const { t, missing } = cssTiming(cs, A.cssPropsOf(Object.keys(from)))
      const classes = model.states.enter ?? [], anim: A.Anim = { trigger: 'enter', frames: A.fromTo(from, to), transition: t }
      out.push({ key: 'css:enter', anim, system: classes.length ? 'tailwind' : 'css', tw: { anim, classes }, rest, notes: jumpNote(missing) })
    }
  }
  // keyframe animations: running at rest, or only in a state (hover:animate-…)
  const named: { name: string; trigger: A.Trigger; i: number; tm: Timing; state?: State }[] = []
  splitList(cs['animation-name']).forEach((n, i) => { if (n !== 'none') named.push({ name: n, trigger: at(cs['animation-iteration-count'], i) === 'infinite' ? 'loop' : 'enter', i, tm: cs }) })
  for (const st of STATES) {
    const tm = pr.stateTiming[st]
    if (tm) splitList(tm['animation-name']).forEach((n, i) => { if (n !== 'none' && !named.some(x => x.name === n)) named.push({ name: n, trigger: STATE_TRIGGER[st], i, tm, state: st }) })
  }
  for (const { name, trigger, i, tm, state } of named) {
    const rule = keyframesRule(el.ownerDocument, name)
    if (!rule) continue
    const base = !state
    const classes = model.animate.filter(c => (base ? !c.trigger : c.trigger === trigger))
    const t = A.transitionFromCss(toMs(at(tm['animation-duration'], i)), at(tm['animation-timing-function'], i), toMs(at(tm['animation-delay'], i)), at(tm['animation-iteration-count'], i), at(tm['animation-direction'], i))
    const anim: A.Anim = { trigger, frames: keyframeFrames(rule), transition: t }
    out.push({ key: `kf:${name}`, anim, system: classes.length ? 'tailwind' : 'css', tw: { anim, classes }, kfName: name, state, rest, notes: [] })
  }
  const mf = motionFiber(el)
  if (mf) {
    const props = currentProps(mf) as Record<string, unknown>
    for (const m of A.fromMotion(props)) out.push({ key: `motion:${m.at.target}`, anim: m.anim, system: 'motion', motion: m, rest, notes: m.notes })
    // no animate of its own but variants: it follows the labels a motion parent animates through
    const own = props.animate === undefined && props.inherit !== false && props.variants && typeof props.variants === 'object'
    const inh = own ? inheritedLabels(mf) : {}
    if (inh.animate) {
      for (const m of A.fromMotion({ ...props, animate: inh.animate, initial: props.initial ?? inh.initial })) {
        if (m.anim.trigger !== 'enter' && m.anim.trigger !== 'loop') continue
        out.push({ key: `motion:inherited:${m.at.target}`, anim: m.anim, system: 'motion', motion: m, rest, inherited: true,
          notes: [`Follows its parent <${inh.from}> through “${inh.initial ?? '…'}” → “${inh.animate}”; edits go into this element’s variants.`, ...m.notes] })
      }
    }
  }
  return out.sort((a, b) => TRIGGER_ORDER.indexOf(a.anim.trigger) - TRIGGER_ORDER.indexOf(b.anim.trigger))
}
/** Play an animation the way it really runs: Motion's own gestures, the forced CSS state, @starting-style, keyframes. */
function playFound(el: HTMLElement, f: Found) {
  if (f.system === 'motion') {
    const mf = motionFiber(el), t = f.anim.trigger
    if (mf && (t === 'enter' || t === 'inView')) return replayEnter(el, mf)
    if (t === 'hover' || t === 'press' || t === 'focus') return playGesture(el, t === 'hover' ? 'whileHover' : t === 'press' ? 'whileTap' : 'whileFocus')
  } else if (f.kfName && !f.state) return replayKeyframes(el)
  else if (f.state) return playState(el, f.state)
  else if (f.anim.trigger === 'enter') {
    // @starting-style runs when an element starts being rendered: hide it for a frame
    const d = el.style.getPropertyValue('display'), pri = el.style.getPropertyPriority('display')
    el.style.setProperty('display', 'none', 'important'); void el.offsetWidth
    if (d) el.style.setProperty('display', d, pri); else el.style.removeProperty('display')
    return
  }
  previewAnim(el, f.anim, f.rest)
}
function previewAnim(el: HTMLElement, a: A.Anim, rest: A.Values) {
  const { keyframes, options } = A.toWaapi(a, rest)
  try { el.animate(keyframes, options).updatePlaybackRate(rec.rate) } catch (e) { notify(`Can’t preview: ${(e as Error).message}`) }
}

type Rec = { a: Animation; el: HTMLElement; kind: 'transition' | 'keyframes' | 'motion' | 'script'; name: string; t0: number }
const rec = { list: [] as Rec[], seen: new WeakSet<Animation>(), rate: 1 }
/** Pick up animations that just started. Events catch CSS ones; polling (while the timeline is open) catches el.animate(). */
function capture() {
  for (const a of document.getAnimations()) {
    if (rec.seen.has(a)) continue
    rec.seen.add(a)
    const el = (a.effect as KeyframeEffect | null)?.target as HTMLElement | null
    if (!el || el.getRootNode() !== document) continue // Watcher's own UI lives in a shadow root
    const kind = 'transitionProperty' in a ? 'transition' : 'animationName' in a ? 'keyframes' : motionFiber(el) ? 'motion' : 'script'
    // a script animation is named by what it moves: "opacity, transform"
    const moved = () => Object.keys((a.effect as KeyframeEffect).getKeyframes()[0] ?? {}).filter(k => !/^(offset|computedOffset|easing|composite)$/.test(k)).join(', ')
    const name = (a as CSSTransition).transitionProperty ?? (a as CSSAnimation).animationName ?? (a.id || moved() || 'animate()')
    if (rec.rate !== 1) a.updatePlaybackRate(rec.rate)
    rec.list.push({ a, el, kind, name, t0: performance.now() })
    if (rec.list.length > 120) rec.list.shift()
  }
}
function setSpeed(r: number) {
  rec.rate = r
  for (const x of rec.list) { try { x.a.updatePlaybackRate(r) } catch { /* animation gone */ } }
}
/** Animations that started within 300ms of each other belong to one interaction. */
function groupsOf(list: Rec[]) {
  const gs: Rec[][] = []
  for (const x of list) { const g = gs.at(-1); if (g && x.t0 - g.at(-1)!.t0 < 300) g.push(x); else gs.push([x]) }
  return gs
}
/** Replay a group with its original offsets (staggers stay staggered), at the current speed. */
function replayGroup(g: Rec[]) {
  const g0 = g[0].t0, now = performance.now()
  for (const x of g) {
    const off = x.t0 - g0
    x.t0 = now + off / rec.rate
    setTimeout(() => { try { x.a.updatePlaybackRate(rec.rate); x.a.currentTime = 0; x.a.play() } catch { /* animation gone */ } }, off / rec.rate)
  }
}

// ── checks: design-token guardrails + accessibility ─────────────────────────
type Tokens = { colors: Token[]; sizes: Token[]; radii: Token[]; spaces: Token[]; eases: { name: string; value: string }[]; step?: number }
type Issue = { el: HTMLElement | null; sev: 'error' | 'warn'; rule: string; msg: string; key?: string; fix?: { label: string; run: () => void } }
const rgbOf = (c: string): RGB => { const { r, g, b, a } = rgba(c); return { r, g, b, a } }
let tokCache: (Tokens & { at: number }) | null = null
/** The app's design tokens: :root variables that hold a colour or a length, sorted by what they're for (by name). */
function themeTokens(): Tokens {
  if (tokCache && performance.now() - tokCache.at < 3000) return tokCache
  const rem = parseFloat(getComputedStyle(document.documentElement).fontSize) || 16
  const t: Tokens = { colors: [], sizes: [], radii: [], spaces: [], eases: [] }
  for (const [name, v] of rootVars()) {
    if (name.startsWith('--tw-')) continue
    const len = /^(-?\d*\.?\d+)(px|rem)$/.exec(v)
    if (len) {
      const px = +len[1] * (len[2] === 'rem' ? rem : 1)
      if (name === '--spacing') t.step = px // Tailwind v4: every multiple of it is on the scale
      else if (/^--(text|font-size)/.test(name)) t.sizes.push({ name, px })
      else if (/radius|rounded/.test(name)) t.radii.push({ name, px })
      else if (/^--(spacing|space|gap)/.test(name)) t.spaces.push({ name, px })
    } else if (/^(cubic-bezier|steps|linear)\(/.test(v) || (name.startsWith('--ease') && /^(ease|linear)/.test(v))) t.eases.push({ name, value: v })
    else if (!/^[\d.\s%-]*$/.test(v) && !/^(inherit|initial|unset|currentcolor|transparent)$/i.test(v) && CSS.supports('color', v)) t.colors.push({ name, rgb: rgbOf(v) })
  }
  // namespaced theme tokens first: they become named utilities (text-brand) when written back
  for (const list of [t.colors, t.sizes, t.radii]) list.sort((a, b) => +/^--(color|text|radius)-/.test(b.name) - +/^--(color|text|radius)-/.test(a.name))
  tokCache = { ...t, at: performance.now() }
  return tokCache
}
/** The token an edited value equals exactly, as var(--x), so it's written back as text-brand rather than text-[#f38020]. */
function tokenRef(prop: string, v: string): string | null {
  if (v.startsWith('var(')) return null
  const T = themeTokens()
  if (prop.endsWith('timing-function')) { const n = normEase(v), e = T.eases.find(e => normEase(e.value) === n); return e ? `var(${e.name})` : null }
  if (/color$/.test(prop)) { if (!CSS.supports('color', v)) return null; const n = nearestColor(rgbOf(v), T.colors); return n?.exact ? `var(${n.token.name})` : null }
  const px = /^(-?\d*\.?\d+)px$/.exec(v)?.[1]
  const list = prop === 'font-size' ? T.sizes : prop === 'border-radius' ? T.radii : null
  const t = px !== undefined && list?.find(t => Math.abs(t.px! - +px) < 0.01)
  return t ? `var(${t.name})` : null
}

/** What's painted behind `el`: its and its ancestors' backgrounds, composited. Null when an image or gradient is involved. */
function backdrop(el: Element): RGB | null {
  const layers: RGB[] = []
  for (let e: Element | null = el; e; e = e.parentElement) {
    const cs = getComputedStyle(e)
    if (cs.backgroundImage !== 'none') return null
    const c = rgbOf(cs.backgroundColor)
    if (c.a > 0) { layers.push(c); if (c.a >= 1) break }
  }
  return layers.reverse().reduce((acc, l) => over(l, acc), { r: 255, g: 255, b: 255, a: 1 })
}
type Contrast = { ratio: number; aa: number; aaa: number; fg: RGB; bg: RGB }
function textContrast(el: HTMLElement): Contrast | null {
  if (!hasText(el) || document.documentElement.classList.contains('do-xray')) return null // x-ray tints every background
  const cs = getComputedStyle(el), bg = backdrop(el)
  if (!bg) return null
  const fg = over(rgbOf(cs.color), bg)
  return { ratio: contrast(fg, bg), ...contrastNeed(isLargeText(parseFloat(cs.fontSize), +cs.fontWeight || 400)), fg, bg }
}
/** Closest colour that passes AA: a token if one is near, else the same hue lightened or darkened. */
function contrastFix(el: HTMLElement, c: Contrast): Issue['fix'] {
  const tok = themeTokens().colors.filter(t => t.rgb!.a === 1 && contrast(t.rgb!, c.bg) >= c.aa).map(t => ({ t, d: deltaE(t.rgb!, c.fg) })).sort((a, b) => a.d - b.d)[0]
  const adj = fixContrast(c.fg, c.bg, c.aa)
  if (tok && (!adj || tok.d < 20)) return { label: tok.t.name, run: () => editStyle(el, 'color', `var(${tok.t.name})`) }
  return adj ? { label: toHex(adj), run: () => editStyle(el, 'color', toHex(adj)) } : undefined
}
function accessibleName(el: HTMLElement) {
  const by = el.getAttribute('aria-labelledby')?.split(/\s+/).map(id => el.ownerDocument.getElementById(id)?.textContent ?? '').join(' ')
  const inner = [...el.querySelectorAll('img[alt], [aria-label], svg title')].map(e => e.getAttribute('alt') || e.getAttribute('aria-label') || e.textContent || '').join('')
  return (el.getAttribute('aria-label') || by || el.textContent || inner || el.title || (el as HTMLInputElement).value || '').trim()
}
const FOCUSABLE = 'a[href], button, input:not([type=hidden]), select, textarea, [tabindex]:not([tabindex="-1"])'
/** WCAG 2.5.8's spacing exception: a small target is fine if a 24px circle on its centre touches no other target
 *  (and no other small target's circle). */
function crowded(el: HTMLElement, r: DOMRect, z: number) {
  const cx = r.left + r.width / 2, cy = r.top + r.height / 2, R = 12 * z
  for (const t of el.ownerDocument.querySelectorAll<HTMLElement>(FOCUSABLE)) {
    if (t === el || t.contains(el) || el.contains(t)) continue
    const q = t.getBoundingClientRect()
    if (!q.width || !q.height) continue
    if (Math.hypot(Math.max(q.left - cx, 0, cx - q.right), Math.max(q.top - cy, 0, cy - q.bottom)) < R) return true
    if ((q.width < 2 * R || q.height < 2 * R) && Math.hypot(q.left + q.width / 2 - cx, q.top + q.height / 2 - cy) < 2 * R) return true
  }
  return false
}
function a11yIssues(el: HTMLElement): Issue[] {
  const out: Issue[] = [], tag = el.tagName, role = el.getAttribute('role')
  const add = (sev: Issue['sev'], rule: string, msg: string, fix?: Issue['fix']) => out.push({ el, sev, rule, msg, fix })
  if (tag === 'IMG' && !el.hasAttribute('alt')) add('error', 'alt', 'Image has no alt text. Describe it, or use alt="" if it’s decorative.')
  const control = tag === 'BUTTON' || (tag === 'A' && el.hasAttribute('href')) || role === 'button' || role === 'link'
  if (control && !accessibleName(el)) add('error', 'name', `${tag === 'A' || role === 'link' ? 'Link' : 'Button'} has no accessible name. Add text or an aria-label.`)
  const field = (tag === 'INPUT' && !/^(hidden|submit|button|reset|image)$/.test((el as HTMLInputElement).type)) || tag === 'SELECT' || tag === 'TEXTAREA'
  if (field && !((el as HTMLInputElement).labels?.length || el.getAttribute('aria-label') || el.getAttribute('aria-labelledby') || el.title)) {
    const ph = el.getAttribute('placeholder')
    add(ph ? 'warn' : 'error', 'label', ph ? 'Only a placeholder labels this field, and it disappears once someone types.' : 'Form field has no label.')
  }
  // WCAG 2.5.8: 24×24 minimum, except links inside running text
  const inline = tag === 'A' && !!el.parentElement && hasText(el.parentElement)
  if ((control || field) && !inline) {
    const r = el.getBoundingClientRect(), z = ctxOf(el).z, w = r.width / z, h = r.height / z
    if (w && h && (w < 24 || h < 24) && crowded(el, r, z)) add('warn', 'target', `Target is ${round(w)}×${round(h)}px with others close by; make it at least 24×24 or space it out.`)
  }
  const ti = el.getAttribute('tabindex')
  if (ti && +ti > 0) add('warn', 'tabindex', `tabindex="${ti}" reorders keyboard focus; use 0 and order the DOM instead.`)
  if (el.matches(FOCUSABLE) && el.closest('[aria-hidden="true"]')) add('error', 'hidden-focus', 'Focusable inside aria-hidden="true": keyboard users reach it, screen readers can’t see it.')
  const c = textContrast(el)
  if (c && c.ratio < c.aa) add('error', 'contrast', `Contrast ${round(c.ratio, 2)}:1, AA needs ${c.aa}:1.`, contrastFix(el, c))
  return out
}
function pageIssues(): Issue[] {
  const out: Issue[] = []
  if (!document.documentElement.lang) out.push({ el: null, sev: 'error', rule: 'lang', msg: '<html> has no lang attribute, so screen readers guess the language.' })
  if (!document.title.trim()) out.push({ el: null, sev: 'error', rule: 'title', msg: 'The page has no <title>.' })
  const hs = [...document.body.querySelectorAll<HTMLElement>('h1, h2, h3, h4, h5, h6')].filter(h => h.checkVisibility?.() ?? true)
  if (hs.length && !hs.some(h => h.tagName === 'H1')) out.push({ el: hs[0], sev: 'warn', rule: 'heading', msg: 'No <h1> on this page.' })
  let prev = 0
  for (const h of hs) {
    const lvl = +h.tagName[1]
    if (prev && lvl > prev + 1) out.push({ el: h, sev: 'warn', rule: 'heading', msg: `<${h.tagName.toLowerCase()}> comes after <h${prev}>, skipping a level.` })
    prev = lvl
  }
  return out
}
const SPACING_PROPS = ['padding-top', 'padding-right', 'padding-bottom', 'padding-left', 'margin-top', 'margin-bottom']
/** Values on `el` that aren't one of the app's tokens (inherited text colour and size are the parent's business). */
function tokenIssues(el: HTMLElement): Issue[] {
  const T = themeTokens(), cs = getComputedStyle(el), out: Issue[] = []
  const parent = el.parentElement && getComputedStyle(el.parentElement)
  const own = (p: string) => !parent || parent.getPropertyValue(p) !== cs.getPropertyValue(p)
  const flag = (prop: string, shown: string, fix?: { to: string; label: string }) => out.push({
    el, sev: 'warn', rule: 'token', key: `${prop}|${shown}`, msg: `${prop} ${shown} isn’t a token`,
    fix: fix && { label: fix.label, run: () => editStyle(el, prop, fix.to) },
  })
  const color = (read: string, prop: string, when = true) => {
    if (!when || !T.colors.length) return
    const v = cs.getPropertyValue(read), c = rgbOf(v)
    if (!c.a) return
    const n = nearestColor(c, T.colors)
    if (!n?.exact) flag(prop, colorOut(v), n?.close ? { to: `var(${n.token.name})`, label: n.token.name } : undefined)
  }
  color('color', 'color', hasText(el) && own('color'))
  color('background-color', 'background-color')
  color('border-top-color', 'border-color', parseFloat(cs.borderTopWidth) > 0 && cs.borderTopStyle !== 'none')
  const len = (read: string, prop: string, list: Token[], step?: number, when = true) => {
    if (!when || (!list.length && !step)) return
    const px = parseFloat(cs.getPropertyValue(read))
    if (!px) return
    const n = nearestLength(px, list, step)
    if (n && !n.exact) flag(prop, `${round(px)}px`, !n.close ? undefined : n.token ? { to: `var(${n.token.name})`, label: n.token.name } : { to: `${n.value}px`, label: `${n.value}px` })
  }
  len('font-size', 'font-size', T.sizes, undefined, hasText(el) && own('font-size'))
  len('border-top-left-radius', 'border-radius', T.radii)
  for (const p of SPACING_PROPS) len(p, p, T.spaces, T.step)
  if (/flex|grid/.test(cs.display)) len('column-gap', 'gap', T.spaces, T.step)
  return out
}
function audit() {
  tokCache = null
  const a11y = pageIssues(), tokens: Issue[] = []
  let moving = false
  for (const el of document.body.querySelectorAll<HTMLElement>('*')) {
    if (SKIP.has(el.tagName) || !(el.checkVisibility?.() ?? true)) continue
    a11y.push(...a11yIssues(el)); tokens.push(...tokenIssues(el))
    moving ||= getComputedStyle(el).animationName !== 'none'
  }
  const respects = [...document.styleSheets].some(sh => { try { return [...sh.cssRules].some(r => r.cssText.includes('prefers-reduced-motion')) } catch { return false } })
  if (moving && !respects) a11y.push({ el: null, sev: 'warn', rule: 'motion', msg: 'Keyframe animations run, but no CSS honours prefers-reduced-motion. Use motion-safe: (Tailwind) or a reduced-motion media query.' })
  return { a11y, tokens }
}

const byCount = (t: Tally) => [...t].sort((a, b) => b[1] - a[1])
const byNum = (t: Tally, desc = false) => [...t].sort((a, b) => (parseFloat(a[0]) - parseFloat(b[0])) * (desc ? -1 : 1) || b[1] - a[1])
/** Neutrals first (light → dark), then chromatic colours by hue. */
function paletteSort(t: Tally) {
  return [...t].map(([v, c]) => {
    const { r, g, b } = rgba(v), mx = Math.max(r, g, b), mn = Math.min(r, g, b), d = mx - mn
    const h = !d ? 0 : mx === r ? ((g - b) / d + 6) % 6 : mx === g ? (b - r) / d + 2 : (r - g) / d + 4
    return { v, c, neutral: d < 20, l: mx + mn, h }
  }).sort((a, b) => (a.neutral !== b.neutral ? (a.neutral ? -1 : 1) : a.neutral ? b.l - a.l : a.h - b.h || b.l - a.l))
}
/** Copy value: hex for plain sRGB, the authored notation for oklch()/color() etc. */
function colorOut(v: string) {
  if (!/^rgba?\(/.test(v)) return v
  const { hex, a } = rgba(v)
  return a < 1 ? hex + Math.round(a * 255).toString(16).padStart(2, '0') : hex
}
const firstFamily = (f: string) => f.split(',')[0].replace(/["']/g, '').trim()
const parseTextStyle = (k: string) => { const [, w, size, lh, fam] = /^(\S+) (\S+)\/(\S+) (.+)$/.exec(k) ?? []; return { w, size, lh, fam } }

function exportTokens() {
  const out: string[] = []
  const put = (title: string, prefix: string, vals: string[]) => {
    if (!vals.length) return
    out.push(`  /* ${title} */`, ...vals.map((v, i) => `  --${prefix}-${i + 1}: ${v};`), '')
  }
  put('Colors', 'color', paletteSort(ds.colors).map(x => colorOut(x.v)))
  put('Font families', 'font', byCount(ds.families).map(([v]) => v))
  put('Font sizes', 'text', byNum(ds.sizes, true).map(([v]) => v))
  put('Font weights', 'weight', byNum(ds.weights).map(([v]) => v))
  put('Line heights', 'leading', byNum(ds.lineHeights).map(([v]) => v))
  put('Radius', 'radius', byNum(ds.radii).map(([v]) => v))
  put('Spacing', 'space', byNum(ds.spacing).map(([v]) => v))
  put('Shadows', 'shadow', byCount(ds.shadows).map(([v]) => v))
  return `:root {\n${out.join('\n').trimEnd()}\n}\n`
}

const Chips = ({ list, copy }: { list: [string, number][]; copy: (v: string) => void }) => (
  <div className="chips">{list.map(([v, c]) => <button key={v} className="chip" title={`Used ${c}×`} onClick={() => copy(v)}>{v}<span className="cnt">{c}</span></button>)}</div>
)
const checker = 'repeating-conic-gradient(#ccc 0 25%, #fff 0 50%) 0 0/8px 8px'

function DesignSystem() {
  const [, setVer] = useState(0)
  const [toast, setToast] = useState('')
  const timer = useRef(0)
  const rescan = useCallback(() => { scanStyles(); setVer(v => v + 1) }, [])
  useEffect(rescan, [rescan])
  const copy = (v: string, what = v) => {
    navigator.clipboard?.writeText(v).catch(() => {})
    setToast(what)
    clearTimeout(timer.current)
    timer.current = window.setTimeout(() => setToast(''), 1400)
  }

  const colors = paletteSort(ds.colors), styles = [...ds.textStyles].map(([k, c]) => ({ k, c, ...parseTextStyle(k) }))
    .sort((a, b) => parseFloat(b.size) - parseFloat(a.size) || b.c - a.c)
  const vars = [...ds.vars]

  return (
    <>
      <div className="pb">
        <div className="dsbar">
          <span>{ds.elements} elements · {ds.pages.size} page{ds.pages.size > 1 ? 's' : ''}</span>
          <button className="b sm" data-tip="Rescan page" onClick={rescan}><Icon d={P.refresh} /></button>
          <button className="b sm" data-tip="Copy all as CSS variables" onClick={() => copy(exportTokens(), 'design tokens')}><Icon d={P.export} /></button>
        </div>

        {colors.length > 0 && <Section title="Colors" n={colors.length}>
          <div className="tiles">
            {colors.map(({ v, c }) => {
              const { hex, a } = rgba(v)
              return (
                <button key={v} className="tile" title={`${v} · used ${c}×`} onClick={() => copy(colorOut(v))}>
                  <i style={{ background: `linear-gradient(${v}, ${v}), ${checker}` }} />
                  <span>{hex.slice(1).toUpperCase()}{a < 1 && ` ${Math.round(a * 100)}%`}</span>
                </button>
              )
            })}
          </div>
        </Section>}

        {ds.gradients.size > 0 && <Section title="Gradients" n={ds.gradients.size}>
          {byCount(ds.gradients).map(([v, c]) => <button key={v} className="tile grad" title={`${v} · used ${c}×`} onClick={() => copy(v, 'gradient')}><i style={{ background: v }} /></button>)}
        </Section>}

        {styles.length > 0 && <Section title="Text styles" n={styles.length}>
          <div className="list">
            {styles.map(s => (
              <button key={s.k} className="dsrow" title={`Used ${s.c}×`} onClick={() => copy(`font: ${s.k};`, 'font shorthand')}>
                <span className="ag" style={{ fontFamily: s.fam, fontWeight: s.w as never, fontSize: Math.min(parseFloat(s.size), 26) }}>Ag</span>
                <span className="meta"><b>{fmt(s.size)} / {fmt(s.lh)} · {s.w}</b><small>{firstFamily(s.fam)}</small></span>
                <span className="cnt">{s.c}</span>
              </button>
            ))}
          </div>
        </Section>}

        {ds.families.size > 0 && <Section title="Font families" n={ds.families.size}>
          <div className="list">
            {byCount(ds.families).map(([v, c]) => (
              <button key={v} className="dsrow" title={v} onClick={() => copy(v, firstFamily(v))}>
                <span className="grow" style={{ fontFamily: v, fontSize: 14 }}>{firstFamily(v)}</span><span className="cnt">{c}</span>
              </button>
            ))}
          </div>
        </Section>}

        {ds.sizes.size > 0 && <Section title="Font sizes" n={ds.sizes.size}><Chips list={byNum(ds.sizes, true)} copy={copy} /></Section>}
        {ds.weights.size > 0 && <Section title="Font weights" n={ds.weights.size}><Chips list={byNum(ds.weights)} copy={copy} /></Section>}
        {ds.lineHeights.size > 0 && <Section title="Line heights" n={ds.lineHeights.size}><Chips list={byNum(ds.lineHeights)} copy={copy} /></Section>}
        {ds.tracking.size > 0 && <Section title="Letter spacing" n={ds.tracking.size}><Chips list={byNum(ds.tracking)} copy={copy} /></Section>}

        {ds.radii.size > 0 && <Section title="Border radius" n={ds.radii.size}>
          <div className="tiles">
            {byNum(ds.radii).map(([v, c]) => (
              <button key={v} className="tile rad" title={`${v} · used ${c}×`} onClick={() => copy(v)}>
                <i style={{ borderRadius: /^[\d.]+px$/.test(v) ? Math.min(parseFloat(v), 18) : v }} /><span>{v}</span>
              </button>
            ))}
          </div>
        </Section>}

        {ds.spacing.size > 0 && <Section title="Spacing" n={ds.spacing.size}>
          <div className="list">
            {byNum(ds.spacing).map(([v, c]) => (
              <button key={v} className="dsrow" title={`Used ${c}×`} onClick={() => copy(v)}>
                <span className="bar" style={{ width: Math.min(parseFloat(v), 140) }} /><span className="grow mono">{v}</span><span className="cnt">{c}</span>
              </button>
            ))}
          </div>
        </Section>}

        {ds.shadows.size > 0 && <Section title="Shadows" n={ds.shadows.size}>
          <div className="tiles two">
            {byCount(ds.shadows).map(([v, c]) => (
              <button key={v} className="tile shd" title={`${v} · used ${c}×`} onClick={() => copy(v, 'shadow')}><i style={{ boxShadow: v }} /><span>{v}</span></button>
            ))}
          </div>
        </Section>}

        {ds.borders.size > 0 && <Section title="Borders" n={ds.borders.size}><Chips list={byNum(ds.borders)} copy={copy} /></Section>}

        {vars.length > 0 && <Section title="CSS variables" n={vars.length}>
          <div className="list">
            {vars.map(([k, v]) => (
              <button key={k} className="dsrow" title={`${k}: ${v}`} onClick={() => copy(`var(${k})`)}>
                {CSS.supports('color', v) && <span className="dot" style={{ background: v }} />}
                <span className="grow mono">{k}</span><span className="vv mono">{v}</span>
              </button>
            ))}
          </div>
        </Section>}
      </div>
      {toast && <div className="toast">Copied {toast.length > 40 ? toast.slice(0, 40) + '…' : toast}</div>}
    </>
  )
}

// ── profiler ────────────────────────────────────────────────────────────────
type Timed = { v: number; t: number }
const perf = { frames: [] as number[], mut: [] as number[], heap: [] as number[], long: [] as Timed[], shifts: [] as Timed[], cls: 0, mutTotal: 0 }
const pushCap = <T,>(a: T[], v: T, n: number) => { a.push(v); if (a.length > n) a.shift() }
type ChromeMemory = { usedJSHeapSize: number; jsHeapSizeLimit: number }

function Spark({ data, max, min = 0, mark, bad, line }: { data: number[]; max: number; min?: number; mark?: number; bad?: (v: number) => boolean; line?: boolean }) {
  const W = 120, H = 36, n = Math.max(data.length, 2)
  const y = (v: number) => H - Math.max(0, Math.min(1, (v - min) / (max - min || 1))) * (H - 2)
  return (
    <svg className="spark" viewBox={`0 0 ${W} ${H}`} preserveAspectRatio="none">
      {mark != null && <line x1={0} x2={W} y1={y(mark)} y2={y(mark)} />}
      {line
        ? <polyline points={data.map((v, i) => `${(i / (n - 1)) * W},${y(v)}`).join(' ')} />
        : data.map((v, i) => <rect key={i} className={bad?.(v) ? 'bad' : undefined} x={(i / n) * W} width={(W / n) * 0.7} y={y(v)} height={H - y(v)} />)}
    </svg>
  )
}
const Metric = ({ title, value, unit, sub, children }: { title: string; value: ReactNode; unit?: string; sub: ReactNode; children?: ReactNode }) => (
  <div className="metric">
    <div className="mh"><span>{title}</span><b>{value}{unit && <small>{unit}</small>}</b></div>
    {children}
    <div className="msub">{sub}</div>
  </div>
)

/** Live frames, DOM mutation rate, JS heap, long tasks and layout shifts for the page under the overlay. */
function Profiler() {
  const [, tick] = useState(0)
  useEffect(() => {
    let id = 0, last = 0, muts = 0
    const raf = (t: number) => { if (last) pushCap(perf.frames, t - last, 120); last = t; id = requestAnimationFrame(raf) }
    id = requestAnimationFrame(raf)
    const mo = new MutationObserver(list => {
      if (onlyProbe(list)) return // Watcher reading an element, not the app changing
      muts += list.length; perf.mutTotal += list.length
      if (prefs.flashUpdates) for (const m of list.slice(0, 60)) if (!m.attributeName?.startsWith('data-w')) flash(m.target, 'dom')
    })
    mo.observe(document.body, { childList: true, subtree: true, attributes: true, characterData: true })
    // buffered observers replay history, so start those lists from scratch on every mount
    perf.long = []; perf.shifts = []; perf.cls = 0
    const obs: PerformanceObserver[] = []
    const watch = (type: string, cb: (e: PerformanceEntry) => void) => {
      try { const o = new PerformanceObserver(l => l.getEntries().forEach(cb)); o.observe({ type, buffered: true }); obs.push(o) } catch { /* entry type unsupported */ }
    }
    watch('longtask', e => pushCap(perf.long, { v: e.duration, t: e.startTime }, 50))
    watch('layout-shift', e => {
      const s = e as PerformanceEntry & { value: number; hadRecentInput: boolean; sources?: { currentRect: DOMRectReadOnly }[] }
      if (s.hadRecentInput) return
      perf.cls += s.value
      pushCap(perf.shifts, { v: s.value, t: s.startTime }, 50)
      if (prefs.flashShifts) for (const src of s.sources ?? []) flashRect(src.currentRect, 'shift')
    })
    const iv = setInterval(() => {
      pushCap(perf.mut, muts * 2, 60); muts = 0
      const mem = (performance as Performance & { memory?: ChromeMemory }).memory
      if (mem) pushCap(perf.heap, mem.usedJSHeapSize, 60)
      tick(t => t + 1)
    }, 500)
    return () => { cancelAnimationFrame(id); mo.disconnect(); obs.forEach(o => o.disconnect()); clearInterval(iv) }
  }, [])

  const fr = perf.frames, avg = fr.length ? fr.reduce((a, b) => a + b, 0) / fr.length : 0
  const fps = avg ? Math.round(1000 / avg) : 0
  const p95 = fr.length ? [...fr].sort((a, b) => a - b)[Math.floor(fr.length * 0.95)] : 0
  const slow = fr.filter(f => f > 33.4).length
  const mem = (performance as Performance & { memory?: ChromeMemory }).memory
  const mb = (b: number) => (b / 1048576).toFixed(1)
  const tbt = perf.long.reduce((s, l) => s + Math.max(0, l.v - 50), 0)
  const rate = perf.cls < 0.1 ? 'good' : perf.cls < 0.25 ? 'warn' : 'bad'
  const ago = (t: number) => `${((performance.now() - t) / 1000).toFixed(1)}s ago`
  const toggle = (k: 'flashUpdates' | 'flashShifts') => (v: boolean) => { prefs[k] = v; savePrefs(); tick(t => t + 1) }
  const reset = () => { Object.assign(perf, { frames: [], mut: [], heap: [], long: [], shifts: [], cls: 0, mutTotal: 0 }); tick(t => t + 1) }

  return (
    <div className="pb">
      <div className="dsbar"><span>Live · updates every 0.5s</span><button className="b sm" data-tip="Reset" onClick={reset}><Icon d={P.refresh} /></button></div>
      <Metric title="Frames" value={fps || '—'} unit="fps" sub={`p95 ${(p95 ?? 0).toFixed(1)} ms · ${slow} slow frame${slow === 1 ? '' : 's'} (>33 ms)`}>
        <Spark data={fr} max={50} mark={16.7} bad={v => v > 33.4} />
      </Metric>
      <Metric title="DOM updates" value={perf.mut.at(-1) ?? 0} unit="/s" sub={`${perf.mutTotal.toLocaleString()} mutations since open`}>
        <Spark data={perf.mut} max={Math.max(10, ...perf.mut)} />
        <Check checked={prefs.flashUpdates} onChange={toggle('flashUpdates')}>Highlight updates</Check>
      </Metric>
      <Metric title="Heap" value={mem ? mb(mem.usedJSHeapSize) : '—'} unit={mem ? 'MB' : undefined} sub={mem ? `JS heap · limit ${mb(mem.jsHeapSizeLimit)} MB` : 'performance.memory is Chromium-only'}>
        {perf.heap.length > 1 && <Spark line data={perf.heap} max={Math.max(...perf.heap) * 1.05} min={Math.min(...perf.heap) * 0.95} />}
      </Metric>
      <Metric title="Long tasks" value={perf.long.length} sub={`${Math.round(tbt)} ms total blocking time`}>
        {perf.long.length > 0 && <div className="mlist">{perf.long.slice(-5).reverse().map((l, i) => <div key={i}><b className={l.v > 200 ? 'bad' : 'warn'}>{Math.round(l.v)} ms</b><span>{ago(l.t)}</span></div>)}</div>}
      </Metric>
      <Metric title="Layout shift" value={<span className={rate}>{perf.cls.toFixed(3)}</span>} unit="CLS" sub={`${perf.shifts.length} shift${perf.shifts.length === 1 ? '' : 's'} · good < 0.1, poor > 0.25`}>
        {perf.shifts.length > 0 && <div className="mlist">{perf.shifts.slice(-5).reverse().map((s, i) => <div key={i}><b>{s.v.toFixed(4)}</b><span>{ago(s.t)}</span></div>)}</div>}
        <Check checked={prefs.flashShifts} onChange={toggle('flashShifts')}>Highlight shifts</Check>
      </Metric>
    </div>
  )
}

// ── write-back: inspector edits → Tailwind classes in your JSX (via watcher-ui/vite) ──
type SrcResult = { loc: string; ok: boolean; error?: string; note?: string; before?: string; after?: string; text?: boolean
  mapped: { prop: string; value: string; cls: string }[]; skipped: { prop: string; value: string; reason: string }[]; props?: string[]; variant?: string }
type ApplyResponse = { files: { file: string; changed: boolean; results: SrcResult[] }[]; error?: string }
type Pending = { els: HTMLElement[]; file: string; loc: string; line: number; styles: Record<string, string>; text?: string; attrs?: Record<string, string | null>; variant: string; repeats: number
  props?: Record<string, unknown>; state?: string; comp?: string; classes?: string[]; removeClasses?: string[]; motion?: string }
const BREAKPOINTS: [string, number][] = [['sm', 640], ['md', 768], ['lg', 1024], ['xl', 1280], ['2xl', 1536]]
/** "file:line:col" stamped by the Vite plugin. */
const parseSrc = (s: string) => { const m = /^(.*):(\d+):(\d+)$/.exec(s); return m ? { file: m[1], line: +m[2], col: +m[3], loc: `${m[2]}:${m[3]}` } : null }
const sourceOf = (el: Element) => parseSrc(el.getAttribute('data-wsrc') ?? '')
const openInEditor = (el: Element) => { const s = sourceOf(el); if (s) void fetch(`/__open-in-editor?file=${encodeURIComponent(`${s.file}:${s.line}:${s.col + 1}`)}`) }
/** Edits that can go to source, grouped by the JSX element (and variant) they came from. */
type PendingCss = { key: string; els: HTMLElement[]; edit: Extract<CssEdit, { kind: 'keyframes' }> }
function pendingEdits() {
  const byKey = new Map<string, Pending>(), orphans: HTMLElement[] = [], css = new Map<string, PendingCss>()
  const put = (el: HTMLElement, src: { file: string; loc: string; line: number }, variant: string, part: Partial<Pending>, repeats: number) => {
    const key = `${src.file}|${src.loc}|${variant}`, prev = byKey.get(key)
    if (!prev) { byKey.set(key, { els: [el], file: src.file, loc: src.loc, line: src.line, variant, styles: {}, repeats, ...part }); return }
    if (!prev.els.includes(el)) prev.els.push(el)
    Object.assign(prev.styles, part.styles)
    if (part.props) prev.props = { ...prev.props, ...part.props }
  }
  const hex = (v: string) => (/^rgba?\(/.test(v) ? colorOut(v) : v) // the browser hands back rgb(); classes read better as hex
  for (const [el, props] of liveEdits()) {
    const styles: Record<string, string> = {}, attrs: Record<string, string | null> = {}, inState: Record<string, Record<string, string>> = {}
    const comp = new Map<Fiber, Record<string, unknown>>()
    let text: string | undefined
    for (const p of props) {
      if (p === '#text') text = el.textContent?.trim() ?? ''
      else if (p[0] === '&') { // a keyframe declaration: written to the stylesheet it came from
        const [name, offset, prop] = p.slice(1).split('|'), rule = keyframesRule(el.ownerDocument, name), file = rule && sheetFile(rule)
        if (!file) { orphans.push(el); continue }
        const prev = css.get(p)
        if (prev) prev.els.push(el)
        else css.set(p, { key: p, els: [el], edit: { kind: 'keyframes', file, name, offset, prop, value: kfRule(el.ownerDocument, name, offset, false)?.style.getPropertyValue(prop) || null } })
      }
      else if (p[0] === '@') attrs[p.slice(1)] = el.getAttribute(p.slice(1))
      else if (p[0] === '%') {
        const f = hist.filter(h => h.el === el && h.prop === p).at(-1)?.fiber
        if (f) { if (!comp.has(f)) comp.set(f, {}); comp.get(f)![p.slice(1)] = getPath(currentProps(f), p.slice(1).split('.')) ?? null }
      } else if (isStateKey(p)) { const i = p.indexOf(':'), v = getStateRule(el, p), css = p.slice(i + 1); if (v) (inState[p.slice(0, i)] ??= {})[css] = tokenRef(css, v) ?? hex(v) }
      else if (p[0] !== '#') { const v = el.style.getPropertyValue(p); if (v) styles[p] = tokenRef(p, v) ?? hex(v) }
    }
    // props are written where the component is used, not inside it
    for (const [f, vals] of comp) {
      const at = parseSrc(String(currentProps(f)['data-wsrc-c'] ?? currentProps(f)['data-wsrc'] ?? '')) // motion.div carries data-wsrc
      if (at) put(el, at, '', { props: vals, comp: typeName(f.type) ?? undefined }, 1); else orphans.push(el)
    }
    const own = Object.keys(styles).length || Object.keys(attrs).length || text !== undefined
    if (!own && !Object.keys(inState).length) continue
    const src = sourceOf(el)
    if (!src) { orphans.push(el); continue }
    // edits made inside a responsive preview get that width's Tailwind breakpoint (mobile-first); state edits add hover: etc.
    const w = el.ownerDocument === document ? 0 : el.ownerDocument.defaultView?.innerWidth ?? 0
    const bp = w ? BREAKPOINTS.filter(([, min]) => w >= min).at(-1)?.[0] : undefined
    const variant = bp ? bp + ':' : ''
    const repeats = el.ownerDocument.querySelectorAll(`[data-wsrc="${el.getAttribute('data-wsrc')!.replace(/"/g, '\\"')}"]`).length
    if (own) put(el, src, variant, { styles, text, attrs: Object.keys(attrs).length ? attrs : undefined }, repeats)
    for (const [st, css] of Object.entries(inState)) put(el, src, variant + st + ':', { styles: css, state: st }, repeats)
  }
  return { items: [...byKey.values()], orphans, css: [...css.values()] }
}
async function postApply(items: Pending[], dryRun: boolean): Promise<ApplyResponse> {
  const r = await fetch('/__watcher/apply', {
    method: 'POST', headers: { 'content-type': 'application/json', 'x-watcher': '1' },
    body: toJson({ dryRun, edits: items.map(({ file, loc, styles, text, attrs, variant, props, classes, removeClasses, motion }) => ({ file, loc, styles, text, attrs, variant, props, classes, removeClasses, motion })) }),
  })
  return r.json()
}
/** After a successful write: the source now carries the change, so drop our inline preview of it. */
function settle(it: Pending, r: SrcResult) {
  const pre = it.state ? it.state + ':' : ''
  const done = new Set([...r.mapped.map(m => pre + m.prop), ...(r.text ? ['#text'] : []), ...Object.keys(it.attrs ?? {}).map(a => '@' + a), ...(r.props ?? []).map(p => '%' + p)])
  for (const el of it.els) {
    for (let i = hist.length - 1; i >= 0; i--) if (hist[i].el === el && done.has(hist[i].prop)) hist.splice(i, 1)
    const set = changes.get(el)
    for (const p of done) set?.delete(p)
    if (set && !set.size) changes.delete(el)
    // keep the inline style until hot reload has put the new classes on the element, then remove it
    const styles = r.mapped.map(m => m.prop)
    if (!styles.length) continue
    const drop = () => { mo.disconnect(); clearTimeout(t); for (const p of styles) { if (pre) setStateRule(el, pre + p, ''); else el.style.removeProperty(p) } bump() }
    const mo = new MutationObserver(drop), t = setTimeout(drop, 2500)
    mo.observe(el, { attributes: true, attributeFilter: ['class'] })
  }
  redos.length = 0
}
function ClassDiff({ before, after }: { before: string; after: string }) {
  const b = before.split(/\s+/).filter(Boolean), a = after.split(/\s+/).filter(Boolean)
  return (
    <div className="cdiff">
      {b.filter(c => !a.includes(c)).map(c => <code key={'-' + c} className="del">{c}</code>)}
      {a.map(c => <code key={c} className={b.includes(c) ? 'keep' : 'add'}>{c}</code>)}
    </div>
  )
}
function CodePanel({ rev }: { rev: number }) {
  void rev
  const [server, setServer] = useState<'checking' | 'missing' | number>('checking')
  const [plan, setPlan] = useState<ApplyResponse | null>(null)
  const [busy, setBusy] = useState(false)
  useEffect(() => {
    fetch('/__watcher/ping').then(r => (r.ok ? r.json() : null)).then(j => setServer(j?.ok ? j.tailwind : 'missing')).catch(() => setServer('missing'))
  }, [])
  const { items, orphans, css } = pendingEdits()
  const key = JSON.stringify(items.map(i => [i.file, i.loc, i.variant, i.styles, i.text, i.attrs, i.props]))
  const cssKey = JSON.stringify(css.map(c => c.edit))
  const [cssPlan, setCssPlan] = useState<CssResult[] | null>(null)
  useEffect(() => {
    if (typeof server !== 'number' || !items.length) { setPlan(null); return }
    let alive = true
    postApply(items, true).then(p => { if (alive) setPlan(p) }).catch(() => {})
    return () => { alive = false }
  }, [key, server]) // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => {
    if (typeof server !== 'number' || !css.length) { setCssPlan(null); return }
    let alive = true
    postCss(css.map(c => c.edit), true).then(p => { if (alive) setCssPlan(p) }).catch(() => {})
    return () => { alive = false }
  }, [cssKey, server]) // eslint-disable-line react-hooks/exhaustive-deps
  const cssReady = css.filter((_, i) => cssPlan?.[i]?.ok)
  const resultFor = (it: Pending) => plan?.files.find(f => f.file === it.file)?.results.find(r => r.loc === it.loc && (r.variant ?? '') === it.variant)
  const writable = items.filter(it => { const r = resultFor(it); return r?.ok && (r.mapped.length || r.text || it.attrs || r.props?.length) })
  const apply = async () => {
    setBusy(true)
    try {
      const res = writable.length ? await postApply(writable, false) : { files: [] }
      let n = 0
      for (const it of writable) { const r = res.files.find(f => f.file === it.file)?.results.find(x => x.loc === it.loc && (x.variant ?? '') === it.variant); if (r?.ok) { settle(it, r); n++ } }
      let files = res.files.filter(f => f.changed).length
      if (cssReady.length) {
        // the stylesheet now says it; the CSSOM edit and its undo entries can go
        const done = await postCss(cssReady.map(c => c.edit), false)
        cssReady.forEach((c, i) => { if (!done[i]?.ok) return; n++; for (let j = hist.length - 1; j >= 0; j--) if (hist[j].prop === c.key) hist.splice(j, 1) })
        files += new Set(done.filter(d => d.ok).map(d => d.file)).size
      }
      notify(`Wrote ${n} element${n === 1 ? '' : 's'} to ${files} file${files === 1 ? '' : 's'}`)
      bump()
    } catch (e) { notify(`Couldn't write: ${(e as Error).message}`) }
    setBusy(false)
  }
  return (
    <>
      <div className="pb">
        {server === 'missing' && (
          <div className="cnote">
            <b>Connect your source</b>
            <p>Add the Watcher plugin to your Vite config to write edits back to your JSX as Tailwind classes:</p>
            <pre>{`import { watcher } from 'watcher-ui/vite'

plugins: [watcher(), react(), tailwindcss()]`}</pre>
          </div>
        )}
        {css.map((c, i) => (
          <div key={c.key} className="citem">
            <div className="chead"><b>@keyframes {c.edit.name}</b><span className="cvar">{c.edit.offset}</span><span className="sp" /><span className="clink">{c.edit.file.split('/').pop()}</span></div>
            {cssPlan?.[i]?.error ? <p className="cerr">{cssPlan[i].error}</p> : <div className="cmap"><span>{c.edit.prop}</span><code>{c.edit.value ?? 'removed'}</code></div>}
            <button className="b sm cdiscard" onClick={() => c.els.forEach(el => resetEdits(el))}>Discard</button>
          </div>
        ))}
        {typeof server === 'number' && !items.length && !css.length && <p className="empty pad">No edits yet. Change something in the inspector and it shows up here as Tailwind {server === 3 ? 'v3' : 'v4'} classes, ready to write to your code.</p>}
        {items.map(it => {
          const r = resultFor(it)
          return (
            <div key={it.file + it.loc + it.variant} className="citem">
              <div className="chead">
                <b>{it.comp ? `<${it.comp}>` : label(it.els[0])}</b>
                {it.variant && <span className="cvar" data-tip={it.state ? `Edited while showing :${it.state}, so it only applies in that state` : 'Edited in a responsive preview, so it applies from this breakpoint up'}>{it.variant}</span>}
                {it.props && <span className="cvar" data-tip="Props are written where the component is used">props</span>}
                <span className="sp" />
                <button className="clink" data-tip="Open in your editor" onClick={() => openInEditor(it.els[0])}>{it.file.split('/').pop()}:{it.line}</button>
              </div>
              {it.repeats > 1 && <p className="cwarn">This line renders {it.repeats} elements; the change applies to all of them.</p>}
              {r?.error && <p className="cerr">{r.error}</p>}
              {r && !r.error && r.before != null && r.after != null && r.before !== r.after && <ClassDiff before={r.before} after={r.after} />}
              {r?.mapped.map(m => <div key={m.prop} className="cmap"><span>{m.prop}: {m.value}</span><code>{m.cls}</code></div>)}
              {r?.text && <div className="cmap"><span>text</span><code>“{it.text}”</code></div>}
              {it.attrs && Object.entries(it.attrs).map(([k, v]) => <div key={k} className="cmap"><span>{k}</span><code>{v ?? 'removed'}</code></div>)}
              {r?.props?.map(k => <div key={'%' + k} className="cmap"><span>{k}</span><code>{it.props?.[k] == null ? 'removed' : JSON.stringify(it.props[k])}</code></div>)}
              {r?.skipped.map(sk => <div key={sk.prop} className="cskip">{sk.prop}: {sk.reason}</div>)}
              {r?.note && <p className="cnote2">{r.note}</p>}
              <button className="b sm cdiscard" onClick={() => it.els.forEach(el => resetEdits(el))}>Discard</button>
            </div>
          )
        })}
        {orphans.length > 0 && <p className="empty pad">{orphans.length} edited element{orphans.length === 1 ? ' isn’t' : 's aren’t'} in your source (a library component, or added in canvas mode), so {orphans.length === 1 ? 'it' : 'they'} can only be copied as CSS.</p>}
      </div>
      <div className="foot">
        <span>{writable.length + cssReady.length ? `${writable.length + cssReady.length} ready` : typeof server === 'number' ? 'Nothing to write' : server === 'missing' ? 'Plugin not found' : 'Connecting…'}</span>
        <button className="b sm apply" disabled={busy || !(writable.length + cssReady.length)} onClick={apply}><Icon d={P.code} size={14} />{busy ? 'Writing…' : 'Apply to code'}</button>
      </div>
    </>
  )
}

// ── sidebar pieces ──────────────────────────────────────────────────────────
function Group({ title, n, grow, right, children }: { title: string; n?: number; grow?: boolean; right?: ReactNode; children: ReactNode }) {
  const [open, setOpen] = useState(true)
  return (
    <div className={'sgroup' + (grow && open ? ' grow' : '')}>
      <div className={'shd' + (open ? '' : ' shut')} onClick={() => setOpen(!open)}>
        <span>{title}</span>{n != null && <span className="n">{n}</span>}<i />
        <span onClick={e => e.stopPropagation()}>{right}</span>
        <span className="chev"><Icon d={P.down} size={12} /></span>
      </div>
      {open && children}
    </div>
  )
}
function PagesList({ href, onNav }: { href: string; onNav: (path: string) => void }) {
  const [pages, setPages] = useState<Page[] | null>(null)
  const [ver, setVer] = useState(0)
  const here = samePath(href)
  useEffect(() => {
    let alive = true
    // give the router a beat to render the new page's links before scanning
    const t = setTimeout(() => discoverPages().then(p => { if (alive) setPages(p) }), 150)
    return () => { alive = false; clearTimeout(t) }
  }, [here, ver])
  return (
    <Group title="Pages" n={pages?.length} right={<button className="b xs" data-tip="Rescan pages" onClick={() => setVer(v => v + 1)}><Icon d={P.refresh} size={13} /></button>}>
      <div className="pages">
        {!pages ? <p className="empty pad">Scanning…</p> : pages.map(pg => (
          <button key={pg.path} className={'pg' + (pg.path === here ? ' on' : '') + (pg.dynamic ? ' dyn' : '')}
            title={pg.dynamic ? 'Dynamic route: open it from a link on the page' : pg.path} onClick={() => !pg.dynamic && onNav(pg.path)}>
            <Icon d={P.page} size={14} /><span className="grow">{pg.title}</span><small>{pg.path}</small>
          </button>
        ))}
      </div>
    </Group>
  )
}
/** Layers of the svg open in the editor: click a shape to edit its anchors (non-paths become paths). */
function SvgLayers() {
  const shapes = ed.svg ? [...ed.svg.querySelectorAll(SHAPE_SEL)].filter(s => getComputedStyle(s).display !== 'none') : []
  return (
    <Group title="Layers" n={shapes.length} grow>
      <div className="pb tree">
        {shapes.map((sh, i) => (
          <div key={i} className={'row' + (sh === pe.el ? ' on' : '')} style={{ paddingLeft: 12 }} onClick={() => { enterPathEdit(sh); bump() }}>
            <span className="ic"><Icon d={sh.tagName === 'path' ? P.nib : P.frame} size={13} /></span><span className="nm">{sh.tagName}</span>
            <span className="sub">{sh.getAttribute('id') ?? sh.getAttribute('class') ?? ''}</span>
          </div>
        ))}
      </div>
    </Group>
  )
}

// ── svg editor tab ──────────────────────────────────────────────────────────
/** The page svg, magnified on a checkerboard. It's a clone: anchors map through the clone, edits write to the page svg. */
function SvgEditor({ area }: { area: { l: number; t: number; w: number; h: number } }) {
  const svg = ed.svg!, ref = useRef<SVGSVGElement>(null), box = useRef<HTMLDivElement>(null)
  const vbAttr = svg.getAttribute('viewBox')
  const bb = vbAttr ? null : svg.getBBox()
  const vb = vbAttr ?? `${bb!.x} ${bb!.y} ${bb!.width || 1} ${bb!.height || 1}`
  const r = svg.getBoundingClientRect(), natW = r.width / vp.z || 24, natH = r.height / vp.z || 24
  if (!ed.zoom) ed.zoom = Math.min((area.w * 0.7) / natW, (area.h * 0.7) / natH)
  useLayoutEffect(() => {
    // page CSS doesn't reach into the shadow DOM, so copy each shape's computed paint onto the clone
    const src = [...svg.querySelectorAll(SHAPE_SEL)], dst = [...ref.current!.querySelectorAll(SHAPE_SEL)]
    dst.forEach((d, i) => {
      const cs = src[i] && getComputedStyle(src[i])
      if (cs) for (const p of ['fill', 'stroke', 'stroke-width', 'opacity', 'fill-rule', 'display']) (d as SVGElement).style.setProperty(p, cs.getPropertyValue(p))
    })
    ref.current!.style.color = getComputedStyle(svg).color
    const view = (dst[src.indexOf(pe.el!)] as SVGGraphicsElement | undefined) ?? null
    if (pe.view !== view) { pe.view = view; bump() }
  })
  useEffect(() => {
    const el = box.current!
    const wheel = (e: WheelEvent) => { e.preventDefault(); ed.zoom *= Math.exp(-Math.max(-50, Math.min(50, e.deltaY)) * 0.01); bump() }
    el.addEventListener('wheel', wheel, { passive: false })
    return () => el.removeEventListener('wheel', wheel)
  }, [])
  return (
    <div ref={box} className="sved" style={{ left: area.l, top: area.t, width: area.w, height: area.h }} onPointerDown={() => { pe.node = null; bump() }}>
      <svg ref={ref} viewBox={vb} width={natW * ed.zoom} height={natH * ed.zoom} preserveAspectRatio={svg.getAttribute('preserveAspectRatio') ?? undefined}
        dangerouslySetInnerHTML={{ __html: svg.innerHTML }} />
    </div>
  )
}
function VectorPanel({ onDone }: { onDone: () => void }) {
  const [copied, setCopied] = useState(false)
  const el = pe.el
  if (!el) return null
  const subs = editSubs(), total = subs.reduce((n, sp) => n + sp.nodes.length, 0)
  const at = pe.node ? subs.slice(0, pe.node[0]).reduce((n, sp) => n + sp.nodes.length, 0) + pe.node[1] + 1 : 0
  const cs = getComputedStyle(el), noFill = cs.fill === 'none', noStroke = cs.stroke === 'none'
  const set = (prop: string) => (v: string) => setStyle(el as unknown as HTMLElement, prop, v)
  const op = Math.round(parseFloat(cs.opacity) * 100)
  return (
    <>
      <div className="ph ih"><b>Vector</b><span className="sp" /><button className="b xs" data-tip="Done editing" onClick={onDone}><Icon d={P.x} size={15} /></button></div>
      <div className="crumbs"><span className="crumb on"><Icon d={P.nib} size={11} />&nbsp;{el.tagName}</span></div>
      <div className="pb">
        <Section title="Shape">
          <Row label="Type"><span className="rv">{el.tagName}</span></Row>
          <Row label="Anchors"><span className="rv">{at ? `${at} of ${total}` : total}</span></Row>
          <Row label="Contours"><span className="rv">{subs.length}</span></Row>
        </Section>
        <Section title="Fill">
          <Row label="Fill">
            <Color value={noFill ? 'transparent' : cs.fill} onChange={set('fill')} />
            <button className="b xs" data-tip={noFill ? 'Show fill' : 'Hide fill'} onClick={() => { if (!noFill) pe.lastFill = cs.fill; set('fill')(noFill ? pe.lastFill || '#000000' : 'none') }}>
              <Icon d={noFill ? P.eye : P.eyeOff} size={14} />
            </button>
          </Row>
        </Section>
        <Section title="Stroke">
          <Row label="Stroke">
            {noStroke ? <button className="b sm" onClick={() => set('stroke')('#000000')}>None · Add</button> : <>
              <Color value={cs.stroke} onChange={set('stroke')} />
              <button className="b xs" data-tip="Remove stroke" onClick={() => set('stroke')('none')}><Icon d={P.minus} size={14} /></button>
            </>}
          </Row>
          <Row label="Width"><Num suffix="px" value={cs.strokeWidth} onChange={set('stroke-width')} /></Row>
        </Section>
        <Section title="Opacity">
          <Row label="Opacity">
            <input className="range" type="range" min={0} max={100} value={op} onChange={e => set('opacity')(String(+e.target.value / 100))} />
            <Num suffix="%" value={op} unit="" onChange={v => { const n = parseFloat(v); if (!isNaN(n)) set('opacity')(String(clamp01(n / 100))) }} />
          </Row>
        </Section>
        <Section title="Actions">
          <button className="wide" onClick={() => { navigator.clipboard?.writeText(el.getAttribute('d') ?? ''); setCopied(true); setTimeout(() => setCopied(false), 1200) }}>
            <Icon d={copied ? P.check : P.copy} />{copied ? 'Copied' : 'Copy path data'}
          </button>
          <button className="wide" disabled={!ed.orig.has(el) || ed.orig.get(el) === el.getAttribute('d')} onClick={() => setAttr(el, 'd', ed.orig.get(el)!)}>
            <Icon d={P.refresh} />Restore the original shape
          </button>
          <button className="wide" onClick={onDone}><Icon d={P.check} />Done editing</button>
          <p className="hint">Drag a curve to bend it. <kbd>Alt</kbd>-click adds an anchor; double-click one to round it. <kbd>Del</kbd> removes the selected anchor.</p>
        </Section>
      </div>
    </>
  )
}

// ── responsive preview tab ──────────────────────────────────────────────────
type Device = 'mobile' | 'tablet' | 'desktop'
type Resp = { device: Device | 'custom' | 'all'; w: number; h: number }
const DEVICES: Record<Device, { label: string; w: number; h: number; icon: string }> = {
  mobile: { label: 'Mobile', w: 390, h: 844, icon: P.phone },
  tablet: { label: 'Tablet', w: 820, h: 1180, icon: P.tablet },
  desktop: { label: 'Desktop', w: 1440, h: 900, icon: P.desktop },
}
const DEFAULT_RESP: Resp = { device: 'mobile', w: 390, h: 844 }
const RESP_OPTS = [
  ['mobile', <><Icon d={P.phone} size={14} />Mobile</>],
  ['tablet', <><Icon d={P.tablet} size={14} />Tablet</>],
  ['desktop', <><Icon d={P.desktop} size={14} />Desktop</>],
  ['custom', <><Icon d={P.sliders} size={14} />Custom</>],
  ['all', <><Icon d={P.devices} size={14} />All</>],
] as const
const INSPECT_OPTS = [['inspect', <><Icon d={P.cursor} size={13} />Inspect</>], ['interact', <><Icon d={P.hand} size={13} />Interact</>]] as const
const sizeIn = (n: number, min: number, max: number) => Math.round(Math.min(max, Math.max(min, n)))

/** Live copies of this page in iframes at real viewport sizes, so media queries, vw units and
 *  container layout respond exactly as on the device. Scaled down to fit; never reflows the page itself. */
function Responsive({ area, value, onChange, href, inspect, onInspect }: { area: { l: number; t: number; w: number; h: number }; value: Resp; onChange: (r: Resp) => void; href: string; inspect: boolean; onInspect: (on: boolean) => void }) {
  const [reload, setReload] = useState(0)
  const [lock, setLock] = useState<number | null>(null) // scale held still while a frame edge is dragged
  const all = value.device === 'all'
  const frames = all
    ? (Object.keys(DEVICES) as Device[]).map(k => DEVICES[k])
    : [value.device === 'custom' ? { label: 'Custom', icon: P.sliders, w: value.w, h: value.h } : { ...DEVICES[value.device as Device], w: value.w, h: value.h }]
  const GAP = 40, PADX = 48, BAR = 52, LABEL = 24, PADY = 32
  const totalW = frames.reduce((n, f) => n + f.w, 0) + GAP * (frames.length - 1)
  const fit = Math.min(1, (area.w - PADX * 2) / totalW, (area.h - BAR - LABEL - PADY * 2) / Math.max(...frames.map(f => f.h)))
  const scale = lock ?? Math.max(0.1, fit)
  const pick = (d: Resp['device']) => onChange(d === 'custom' || d === 'all' ? { ...value, device: d } : { device: d, w: DEVICES[d].w, h: DEVICES[d].h })
  const typed = (k: 'w' | 'h') => (v: string) => { const n = parseFloat(v); if (!isNaN(n)) onChange({ ...value, device: 'custom', [k]: sizeIn(n, 1, k === 'w' ? 3840 : 2400) }) }
  const startResize = (e: RPointerEvent, dir: 'e' | 's' | 'se') => {
    e.preventDefault()
    const t = e.currentTarget as HTMLElement
    try { t.setPointerCapture(e.pointerId) } catch { /* pointer already released */ }
    const x0 = e.clientX, y0 = e.clientY, w0 = value.w, h0 = value.h, s0 = scale
    setLock(s0)
    const move = (ev: PointerEvent) => onChange({
      device: 'custom',
      // the frame is centred, so its right edge travels half as far as its width grows
      w: dir === 's' ? w0 : sizeIn(w0 + ((ev.clientX - x0) * 2) / s0, 200, 3840),
      h: dir === 'e' ? h0 : sizeIn(h0 + (ev.clientY - y0) / s0, 200, 2400),
    })
    const up = () => { t.removeEventListener('pointermove', move); t.removeEventListener('pointerup', up); setLock(null) }
    t.addEventListener('pointermove', move); t.addEventListener('pointerup', up)
  }
  return (
    <div className={'resp' + (lock != null ? ' dragging' : '')} style={{ left: area.l, top: area.t, width: area.w, height: area.h }}>
      <div className="rbar">
        <Seg value={inspect ? 'inspect' : 'interact'} options={INSPECT_OPTS} onChange={v => onInspect(v === 'inspect')} />
        <Seg value={value.device} options={RESP_OPTS} onChange={pick} />
        {!all && <>
          <div className="rsize">
            <Num suffix="W" value={value.w} unit="" onChange={typed('w')} />
            <span>×</span>
            <Num suffix="H" value={value.h} unit="" onChange={typed('h')} />
          </div>
          <button className="b sm" data-tip="Rotate" onClick={() => onChange({ ...value, w: value.h, h: value.w })}><Icon d={P.orient} size={15} /></button>
        </>}
        <button className="b sm" data-tip="Reload previews" onClick={() => setReload(r => r + 1)}><Icon d={P.refresh} size={15} /></button>
        <span className="rscale">{Math.round(scale * 100)}%</span>
      </div>
      <div className="rstage">
        {frames.map((f, i) => (
          <div key={i} className="rframe">
            <div className="rlabel"><Icon d={f.icon} size={13} /><b>{f.label}</b><span>{f.w} × {f.h}</span></div>
            <div className="rwrap" style={{ width: f.w * scale, height: f.h * scale }}>
              {/* keyed by slot, not device, so switching devices resizes the live frame instead of reloading it */}
              <div className="rbox"><iframe key={reload} name={VIEWPORT_NAME} title={`${f.label} preview`} src={href} style={{ width: f.w, height: f.h, transform: `scale(${scale})` }} /></div>
              {!all && <>
                <i className="rh e" onPointerDown={e => startResize(e, 'e')} />
                <i className="rh s" onPointerDown={e => startResize(e, 's')} />
                <i className="rh se" onPointerDown={e => startResize(e, 'se')} />
              </>}
            </div>
          </div>
        ))}
      </div>
    </div>
  )
}

// ── rulers ──────────────────────────────────────────────────────────────────
/** `o`, `hi` and `marks` are in the ruler's own coordinates (window coords minus where the ruler starts). */
function Ruler({ vertical, len, o, z, hi, marks, style, onDown }: { vertical?: boolean; len: number; o: number; z: number; hi: [number, number] | null; marks: { p: number; color?: string }[]; style: CSSProperties; onDown: (e: RPointerEvent) => void }) {
  const major = STEPS.find(s => s * z >= 64) ?? 1e4
  const minor = (major * z) / 10 >= 6 ? major / 10 : major / 2
  const from = Math.floor((RULER - o) / z / major) * major
  const count = Math.ceil(((len - o) / z - from) / minor)
  const ticks: ReactNode[] = []
  for (let i = 0; i <= count; i++) {
    const v = from + i * minor, p = Math.round(o + v * z) + 0.5
    if (p < RULER) continue
    const maj = Math.abs(v / major - Math.round(v / major)) < 1e-6, h = maj ? 7 : 3
    ticks.push(vertical
      ? <line key={i} x1={RULER - h} x2={RULER} y1={p} y2={p} />
      : <line key={i} y1={RULER - h} y2={RULER} x1={p} x2={p} />)
    if (maj) ticks.push(vertical
      ? <text key={'t' + i} transform={`translate(10 ${p + 3}) rotate(-90)`} textAnchor="end">{round(v)}</text>
      : <text key={'t' + i} x={p + 3} y={10}>{round(v)}</text>)
  }
  return (
    <svg className={'ruler ' + (vertical ? 'rv' : 'rh')} style={style} width={vertical ? RULER : len} height={vertical ? len : RULER} onPointerDown={onDown}>
      {hi && (vertical
        ? <rect x={0} y={hi[0]} width={RULER} height={hi[1] - hi[0]} className="hi" />
        : <rect y={0} x={hi[0]} height={RULER} width={hi[1] - hi[0]} className="hi" />)}
      {ticks}
      {marks.map((m, i) => vertical
        ? <line key={'m' + i} className="mk" x1={0} x2={RULER} y1={m.p} y2={m.p} stroke={m.color ?? 'var(--primary)'} />
        : <line key={'m' + i} className="mk" y1={0} y2={RULER} x1={m.p} x2={m.p} stroke={m.color ?? 'var(--primary)'} />)}
    </svg>
  )
}

// ── overlay ─────────────────────────────────────────────────────────────────
// ── anatomy: an element's box model laid out on screen ──
type ARect = { x: number; y: number; w: number; h: number }
type ARegion = ARect & { kind: 'pad' | 'mar' | 'gap'; v: number }
/** Margin/padding/gap regions of `el` in client px (z = page zoom), plus its content box and children. */
function anatomyOf(el: HTMLElement, z: number) {
  const r = el.getBoundingClientRect(), cs = getComputedStyle(el)
  const n = (p: string) => parseFloat(cs.getPropertyValue(p)) || 0
  const sides = (f: (d: string) => string) => ['top', 'right', 'bottom', 'left'].map(d => n(f(d)))
  const [mt, mr, mb, ml] = sides(d => `margin-${d}`), [bt, br, bb, bl] = sides(d => `border-${d}-width`), [pt, pr, pb, pl] = sides(d => `padding-${d}`)
  const B: ARect = { x: r.left, y: r.top, w: r.width, h: r.height }
  const inset = (o: ARect, t: number, rr: number, b: number, l: number): ARect => ({ x: o.x + l * z, y: o.y + t * z, w: o.w - (l + rr) * z, h: o.h - (t + b) * z })
  const M: ARect = { x: B.x - ml * z, y: B.y - mt * z, w: B.w + (ml + mr) * z, h: B.h + (mt + mb) * z }
  const I = inset(B, bt, br, bb, bl), C = inset(I, pt, pr, pb, pl)
  // four bands between an outer and an inner box: top/bottom full width, left/right between them
  const ring = (o: ARect, i: ARect, kind: ARegion['kind'], [t, rr, b, l]: number[]): ARegion[] => [
    { kind, v: t, x: o.x, y: o.y, w: o.w, h: i.y - o.y },
    { kind, v: b, x: o.x, y: i.y + i.h, w: o.w, h: o.y + o.h - (i.y + i.h) },
    { kind, v: l, x: o.x, y: i.y, w: i.x - o.x, h: i.h },
    { kind, v: rr, x: i.x + i.w, y: i.y, w: o.x + o.w - (i.x + i.w), h: i.h },
  ]
  const regions = [...ring(M, B, 'mar', [mt, mr, mb, ml]), ...ring(I, C, 'pad', [pt, pr, pb, pl])].filter(g => g.v > 0 && g.w > 0.5 && g.h > 0.5)
  // gaps: the space between consecutive children of a flex/grid container
  const kids = layerKids(el).map(k => k.getBoundingClientRect()).filter(k => k.width || k.height)
  if (/flex|grid/.test(cs.display)) for (let i = 1; i < kids.length; i++) {
    const a = kids[i - 1], b = kids[i]
    const top = Math.max(a.top, b.top), bot = Math.min(a.bottom, b.bottom), lft = Math.max(a.left, b.left), rgt = Math.min(a.right, b.right)
    if (b.left - a.right > 0.5 && bot > top) regions.push({ kind: 'gap', v: (b.left - a.right) / z, x: a.right, y: top, w: b.left - a.right, h: bot - top })
    else if (b.top - a.bottom > 0.5 && rgt > lft) regions.push({ kind: 'gap', v: (b.top - a.bottom) / z, x: lft, y: a.bottom, w: rgt - lft, h: b.top - a.bottom })
  }
  return { M, B, C, regions, kids }
}

const rp = (b: { x: number; y: number; w: number; h: number }) => `M${b.x} ${b.y}h${b.w}v${b.h}h${-b.w}z`
const TOOLS: [Tool, string, string][] = [
  ['select', P.cursor, 'Select & move · V'], ['rect', P.rect, 'Rectangle · R'], ['pen', P.nib, 'Pen · P'],
  ['draw', P.pen, 'Pencil · ⇧P'], ['text', P.text, 'Text · T'], ['hand', P.hand, 'Pan · H / Space'],
]
const depthColor = (d: number) => `oklch(66% .19 ${(d * 47) % 360})`
const HANDLES = [['nw', 0, 0], ['n', 0.5, 0], ['ne', 1, 0], ['w', 0, 0.5], ['e', 1, 0.5], ['sw', 0, 1], ['s', 0.5, 1], ['se', 1, 1]] as const

function Overlay() {
  const [open, setOpen] = useState(() => (FRAME ? !!parentHost?.inspecting : (() => { try { return sessionStorage.getItem('watcher') === '1' } catch { return false } })()))
  const [, setFrame] = useState(0)
  const [rev, setRev] = useState(0)
  const [tool, setTool] = useState<Tool>('select')
  const [space, setSpace] = useState(false)
  const [sel, setSel] = useState<HTMLElement | null>(null)
  const [guides, setGuides] = useState<Guide[]>([])
  const [dragging, setDragging] = useState<number | null>(null)
  const [show, setShow] = useState({ rulers: true, layers: true, inspector: true })
  const [right, setRight] = useState<'inspect' | 'ds' | 'perf' | 'code' | 'checks'>('inspect')
  const [timeline, setTimeline] = useState(false)
  const [grid, setGrid] = useState(false)
  const [filter, setFilter] = useState('')
  const [settings, setSettings] = useState(false)
  const [href, setHref] = useState(location.href)
  const [toastMsg, setToastMsg] = useState<{ msg: string; action?: { label: string; run: () => void } } | null>(null)
  const [resp, setResp] = useState<Resp | null>(null)
  const [frameInspect, setFrameInspect] = useState(true)
  const [alt, setAlt] = useState(false)
  const [xray, setXray] = useState(false)
  const [shiftDown, setShiftDown] = useState(false) // hold Shift = anatomy
  const [anatLock, setAnatLock] = useState(false) // A = keep anatomy on
  const [selGuide, setSelGuide] = useState<number | null>(null)
  const [theme, setTheme] = useState<'light' | 'dark'>(() => (matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light'))
  const L = useRef({
    open, tool, sel, guides, space, dirty: false,
    hover: null as HTMLElement | null, hoverSrc: '', lastHov: null as DOMRect | null, g: null as Gesture | null, editing: null as HTMLElement | null,
    stopEdit: null as (() => void) | null, snaps: [] as SnapLine[], clip: null as HTMLElement | null,
    toggleCanvas: () => {}, close: () => {}, selGuide: null as number | null, href: location.href,
  }).current
  Object.assign(L, { open, tool, sel, guides, selGuide })

  const select = useCallback((el: HTMLElement | null) => {
    L.sel = el; setSel(el); if (el) setSelGuide(null)
    if (FRAME) parentHost!.select(el); else emit({ t: 'select', el })
  }, [L])
  const hover = useCallback((el: HTMLElement | null) => { L.hover = el; L.hoverSrc = 'tree'; if (!FRAME) emit({ t: 'hover', el }) }, [L])
  useEffect(() => {
    const local = () => setRev(r => r + 1)
    if (!FRAME) {
      bump = () => { local(); emit({ t: 'bump' }) }
      hostApi.bumpHost = local
      hostApi.select = el => select(el)
      return
    }
    // frame mode: edits re-render the host's panels; the host tells us what's selected and whether to inspect
    bump = () => { local(); parentHost!.bumpHost() }
    const off = parentHost!.listen(ev => {
      if (ev.t === 'bump') local()
      else if (ev.t === 'inspect') setOpen(ev.on)
      else if (ev.t === 'select') { const mine = ev.el?.ownerDocument === document ? ev.el : null; L.sel = mine; setSel(mine) }
      else { L.hover = ev.el?.ownerDocument === document ? ev.el : null; L.hoverSrc = 'tree' }
    })
    addEventListener('pagehide', off) // a reloading frame never runs React cleanups
    return () => { off(); removeEventListener('pagehide', off) }
  }, [L, select])
  useEffect(() => { if (!FRAME) { hostApi.inspecting = frameInspect; emit({ t: 'inspect', on: frameInspect }) } }, [frameInspect])
  useEffect(() => {
    let t = 0
    notify = FRAME ? parentHost!.notify : (msg, action) => { setToastMsg({ msg, action }); clearTimeout(t); t = window.setTimeout(() => setToastMsg(null), action ? 6000 : 2500) }
  }, [])

  // open/close lifecycle: frame loop, global cursor style, DOM watcher, zoom reset
  useEffect(() => {
    if (!FRAME) try { sessionStorage.setItem('watcher', open ? '1' : '0') } catch { /* private mode */ }
    if (!open) return
    const html = document.documentElement
    html.classList.add('do-open')
    const st = document.createElement('style')
    st.textContent = GLOBAL_CSS
    document.head.appendChild(st)
    const mo = new MutationObserver(list => { if (!onlyProbe(list)) L.dirty = true })
    mo.observe(document.body, { childList: true, subtree: true })
    const sx = scrollX, sy = scrollY
    if (!FRAME) { scrollTo(0, 0); frame('fit') } // a frame keeps its own scroll and is never zoomed
    const onPop = () => setTimeout(() => setHref(location.href))
    addEventListener('popstate', onPop)
    let id = 0, sig = ''
    const rect = (el: HTMLElement | null) => { if (!el?.isConnected) return ''; const r = el.getBoundingClientRect(); return `${r.left},${r.top},${r.width},${r.height}` }
    const loop = () => {
      if (L.sel && !L.sel.isConnected) select(null)
      if (L.dirty) { L.dirty = false; bump() }
      if (location.href !== L.href) { L.href = location.href; setHref(location.href) }
      // re-render the stage only when something it draws actually moved
      const o = origin(), s = [o.x, o.y, innerWidth, innerHeight, vp.z, rect(L.sel), rect(L.hover), strokes.length, strokes.at(-1)?.length,
        flashes.length ? performance.now() : 0, pen.hover?.join()].join('|')
      if (s !== sig) { sig = s; setFrame(f => f + 1) }
      id = requestAnimationFrame(loop)
    }
    loop()
    return () => {
      cancelAnimationFrame(id); mo.disconnect(); st.remove(); html.classList.remove('do-open'); removeEventListener('popstate', onPop)
      L.stopEdit?.(); L.hover = null; L.g = null
      finishPen(); closeSvgEditor(); html.classList.remove('do-xray')
      if (cv.on) exitCanvas()
      if (!FRAME) { resetZoom(); scrollTo(sx, sy) }
      select(null)
    }
  }, [open, L, select])

  useEffect(() => {
    document.documentElement.style.setProperty('--do-cursor', space || tool === 'hand' ? 'grab' : tool === 'draw' || tool === 'rect' || tool === 'pen' ? 'crosshair' : tool === 'text' ? 'text' : 'default')
  }, [tool, space])

  useEffect(() => { document.documentElement.classList.toggle('do-xray', open && xray) }, [open, xray])
  // leaving the pen tool finishes the path being drawn
  useEffect(() => { if (tool !== 'pen' && pen.cur) { const svg = finishPen(); if (svg) select(svg as unknown as HTMLElement) } }, [tool, select])

  // window-level input: we sit above the app in the capture phase and swallow what we use
  useEffect(() => {
    const curTool = (): Tool => (L.space ? 'hand' : L.tool)
    const inEditing = (e: Event) => !!L.editing?.contains(e.target as Node)

    const startText = (el: HTMLElement) => {
      if (L.editing === el) return
      L.stopEdit?.()
      const before = el.innerHTML
      try { el.contentEditable = 'plaintext-only' } catch { el.contentEditable = 'true' }
      L.editing = el
      el.focus()
      const range = document.createRange()
      range.selectNodeContents(el)
      getSelection()?.removeAllRanges(); getSelection()?.addRange(range)
      const key = (e: KeyboardEvent) => {
        if (e.key === 'Escape' || (e.key === 'Enter' && !e.shiftKey)) { e.preventDefault(); end() }
        e.stopPropagation()
      }
      const end = () => {
        if (L.editing !== el) return
        el.removeEventListener('blur', end); el.removeEventListener('keydown', key)
        el.removeAttribute('contenteditable')
        L.editing = null; L.stopEdit = null
        getSelection()?.removeAllRanges()
        if (el.innerHTML !== before) { pushHist({ el, prop: '#text', before, t: 0 }); track(el, '#text') }
        bump()
      }
      L.stopEdit = end
      el.addEventListener('blur', end); el.addEventListener('keydown', key)
    }

    const block = (e: Event) => {
      if (!L.open || fromOverlay(e) || inEditing(e)) return
      e.preventDefault(); e.stopPropagation()
    }

    const down = (e: PointerEvent) => {
      if (!L.open || fromOverlay(e) || inEditing(e)) return
      L.stopEdit?.()
      e.preventDefault(); e.stopPropagation()
      const t = e.button === 1 ? 'hand' : curTool()
      if (t === 'hand') { L.g = { k: 'pan', x: e.clientX, y: e.clientY }; return }
      if (t === 'pen') {
        if (pen.cur) { addPenNode(e.clientX, e.clientY); bump(); return }
        // pen on an existing vector edits it; anywhere else starts a new path
        const raw = document.elementFromPoint(e.clientX, e.clientY)
        if (raw instanceof SVGElement && openSvgEditor(raw)) { select(ownerSvg(raw)); return }
        pe.el = null
        startPen(e.clientX, e.clientY)
        bump()
        return
      }
      if (pe.el) { pe.el = null; pe.node = null } // clicking away ends vector editing
      const o = origin()
      if (t === 'draw') { strokes.push([(e.clientX - o.x) / vp.z, (e.clientY - o.y) / vp.z]); L.g = { k: 'draw' }; return }
      const hit = hitAt(e.clientX, e.clientY)
      if (t === 'rect') {
        // drag out a new rectangle inside whatever container is under the pointer
        const el = document.createElement('div')
        el.setAttribute('data-layer', 'Rectangle')
        el.style.cssText = 'width:0;height:0;background:#d9d9d9;box-sizing:border-box'
        place(el, containerAt(e.clientX, e.clientY), e.clientX, e.clientY)
        select(el)
        L.g = { k: 'resize', el, dir: 'se', x: e.clientX, y: e.clientY, w: 0, h: 0, x0: parseFloat(el.style.left), y0: parseFloat(el.style.top), create: true }
        return
      }
      if (t === 'text') {
        if (hit && hasText(hit)) { select(hit); startText(hit); return }
        // a non-text spot drops a new text layer there
        const el = newText(containerAt(e.clientX, e.clientY), e.clientX, e.clientY)
        select(el); startText(el); setTool('select')
        return
      }
      if (!hit) { select(null); return }
      // clicking inside the current selection keeps it (so you can drag a parent by its child); Ctrl/Cmd forces deep select
      let el = L.sel
      if (!(el && el.contains(hit) && !e.metaKey && !e.ctrlKey)) { el = hit; select(hit) }
      const p = el.parentElement, [x0, y0] = getPos(el)
      const cands = p ? [...(p === document.body ? [] : [p]), ...layerKids(p).filter(k => k !== el)].slice(0, 300).map(docBox).filter(b => b.w || b.h) : []
      L.g = { k: 'move', el, x: e.clientX, y: e.clientY, x0, y0, r: docBox(el), cands, moved: false }
    }

    const move = (e: PointerEvent) => {
      const g = L.g
      if (pen.cur && !g) {
        pen.hover = [e.clientX, e.clientY]
        if (pen.cur.drag) {
          // dragging after placing an anchor pulls out symmetric bezier handles
          const n = pen.cur.subs[0].nodes.at(-1)!, [lx, ly] = penLocal(e.clientX, e.clientY)
          if (Math.hypot(lx - n.x, ly - n.y) > 1) { n.out = [lx, ly]; n.in = [2 * n.x - lx, 2 * n.y - ly] }
          pen.cur.path.setAttribute('d', serializePath(pen.cur.subs))
          bump()
        }
        return
      }
      if (!g) {
        if (!L.open) return
        if (fromOverlay(e)) { if (L.hoverSrc === 'app') L.hover = null; return }
        const t = curTool()
        L.hover = t === 'select' || t === 'text' ? hitAt(e.clientX, e.clientY) : null
        L.hoverSrc = 'app'
        return
      }
      if (g.k === 'bend') {
        // move the segment's control points so the curve passes through the pointer at the grabbed t
        const a0 = new DOMPoint(g.x, g.y).matrixTransform(g.inv), b0 = new DOMPoint(e.clientX, e.clientY).matrixTransform(g.inv)
        const dx = b0.x - a0.x, dy = b0.y - a0.y, t = g.t, c = 1 / (3 * t * (1 - t) * ((1 - t) ** 2 + t ** 2))
        const n = g.subs[g.si].nodes, a = n[g.i], b = n[(g.i + 1) % n.length]
        a.out = [g.p1[0] + dx * (1 - t) * c, g.p1[1] + dy * (1 - t) * c]
        b.in = [g.p2[0] + dx * t * c, g.p2[1] + dy * t * c]
        setAttr(g.el, 'd', serializePath(g.subs))
      } else if (g.k === 'node') {
        const a = new DOMPoint(g.x, g.y).matrixTransform(g.inv), b = new DOMPoint(e.clientX, e.clientY).matrixTransform(g.inv)
        const dx = b.x - a.x, dy = b.y - a.y, o = g.orig, n = g.subs[g.si].nodes[g.ni]
        if (g.part === 'anchor') {
          n.x = o.x + dx; n.y = o.y + dy
          if (o.in) n.in = [o.in[0] + dx, o.in[1] + dy]
          if (o.out) n.out = [o.out[0] + dx, o.out[1] + dy]
        } else {
          const h: [number, number] = [o[g.part]![0] + dx, o[g.part]![1] + dy], other = g.part === 'in' ? 'out' : 'in'
          n[g.part] = h
          // smooth node: mirror the opposite handle's angle (keeping its length); Alt breaks the pair
          if (!e.altKey && o[other]) {
            const len = Math.hypot(o[other]![0] - o.x, o[other]![1] - o.y), vx = h[0] - o.x, vy = h[1] - o.y, l = Math.hypot(vx, vy) || 1
            n[other] = [o.x - (vx / l) * len, o.y - (vy / l) * len]
          }
        }
        setAttr(g.el, 'd', serializePath(g.subs))
      } else if (g.k === 'pan') {
        vp.x += e.clientX - g.x; vp.y += e.clientY - g.y; g.x = e.clientX; g.y = e.clientY
        applyVP()
      } else if (g.k === 'draw') {
        const o = origin()
        strokes[strokes.length - 1].push((e.clientX - o.x) / vp.z, (e.clientY - o.y) / vp.z)
      } else if (g.k === 'resize') {
        const dx = (e.clientX - g.x) / vp.z, dy = (e.clientY - g.y) / vp.z
        let w = g.w, h = g.h, x = g.x0, y = g.y0
        if (g.dir.includes('e')) w += dx
        if (g.dir.includes('w')) { w -= dx; x += dx }
        if (g.dir.includes('s')) h += dy
        if (g.dir.includes('n')) { h -= dy; y += dy }
        w = Math.max(0, Math.round(w)); h = Math.max(0, Math.round(h))
        if (g.create) { g.el.style.width = w + 'px'; g.el.style.height = h + 'px'; return }
        if (/[ew]/.test(g.dir)) setStyle(g.el, 'width', w + 'px')
        if (/[ns]/.test(g.dir)) { setStyle(g.el, 'height', h + 'px'); if (cv.on) setStyle(g.el, 'min-height', '0px') }
        // left/top handles move the box so the opposite edge stays put
        if (/[nw]/.test(g.dir)) setPos(g.el, x, y)
      } else {
        const dx = (e.clientX - g.x) / vp.z, dy = (e.clientY - g.y) / vp.z
        if (!g.moved) {
          if (Math.hypot(dx, dy) * vp.z < 3) return
          g.moved = true
          // Alt-drag duplicates (canvas mode), leaving the original behind as a snap target
          if (e.altKey && cv.on) { g.cands.push(g.r); g.el = duplicate(g.el, 0); g.fresh = true; select(g.el) }
        }
        const s = prefs.snap ? snapMove(g.r, dx, dy, g.cands, L.guides) : { dx, dy, lines: [] }
        L.snaps = s.lines
        if (g.fresh) {
          // a just-duplicated layer: position it directly so the whole Alt-drag is one undo step (removing the node)
          g.el.style.setProperty('left', round(g.x0 + s.dx) + 'px', 'important')
          g.el.style.setProperty('top', round(g.y0 + s.dy) + 'px', 'important')
        } else setPos(g.el, g.x0 + s.dx, g.y0 + s.dy)
      }
    }
    const up = () => {
      if (pen.cur) pen.cur.drag = false
      const g = L.g
      if (g?.k === 'resize' && g.create) {
        if (g.el.offsetWidth < 4 && g.el.offsetHeight < 4) Object.assign(g.el.style, { width: '100px', height: '100px' }) // click = default size
        setTool('select'); bump()
      }
      L.g = null; L.snaps = []
    }

    const paste = (e: ClipboardEvent) => {
      if (!L.open || !cv.on || fromOverlay(e) || L.editing || !e.clipboardData) return
      const s = L.sel, c = s ? (isLeaf(s) ? s.parentElement ?? document.body : s) : document.body
      const text = e.clipboardData.getData('text/plain'), file = [...e.clipboardData.files].find(f => f.type.startsWith('image/'))
      const cx = innerWidth / 2, cy = innerHeight / 2
      if (L.clip?.isConnected && text === L.clip.outerHTML) select(duplicate(L.clip))
      else if (file) {
        const img = document.createElement('img')
        img.src = URL.createObjectURL(file)
        img.setAttribute('data-layer', file.name || 'Image')
        img.style.cssText = 'width:320px;height:auto'
        select(place(img, c, cx - 160 * vp.z, cy - 100 * vp.z))
      } else if (text.trim()) select(newText(c, cx, cy, text.trim()))
      else return
      e.preventDefault()
    }

    const dbl = (e: MouseEvent) => {
      if (!L.open || fromOverlay(e) || L.editing) return
      e.preventDefault(); e.stopPropagation()
      if (curTool() !== 'select') return
      const raw = document.elementFromPoint(e.clientX, e.clientY)
      if (raw instanceof SVGElement && openSvgEditor(raw)) { select(ownerSvg(raw)); return }
      const hit = hitAt(e.clientX, e.clientY)
      if (!hit) return
      select(hit)
      if (hasText(hit)) startText(hit)
    }

    const key = (e: KeyboardEvent) => {
      if (recordingShortcut) return // Settings is listening for a new shortcut
      const sc = activeShortcut()
      if (matchesShortcut(e, sc)) {
        if (FRAME) return
        // a shortcut without Ctrl/Alt/Cmd (F2, Shift+K) must not fire while someone types into the page
        const t = e.composedPath()[0] as HTMLElement | undefined
        const typing = t?.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(t?.tagName ?? '')
        if (!typing || sc.ctrl || sc.alt || sc.meta) { e.preventDefault(); if (L.open) L.close(); else setOpen(true); return }
      }
      if (!L.open) return
      // hold Alt to measure; preventDefault stops Windows focusing the browser menu on release
      if (e.key === 'Alt') { e.preventDefault(); setAlt(true); return }
      const p = e.composedPath()[0] as HTMLElement | undefined
      if (p?.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(p?.tagName ?? '')) return
      if (e.key === 'Shift') { if (!e.repeat) setShiftDown(true); return }
      const mod = e.metaKey || e.ctrlKey, s = L.sel, k = e.key, lk = k.toLowerCase()
      const pn = pe.node
      if (pen.cur && (k === 'Escape' || k === 'Enter')) { const svg = finishPen(); if (svg) select(svg as unknown as HTMLElement); setTool('select') }
      else if (ed.svg && (k === 'Escape' || k === 'Enter')) closeSvgEditor()
      else if (pe.el && pn && (k === 'Delete' || k === 'Backspace')) {
        const subs = editSubs(), nodes = subs[pn[0]]?.nodes
        if (nodes && nodes.length > 2) { nodes.splice(pn[1], 1); pe.node = null; writeEdit(subs) }
      }
      else if (L.selGuide != null && (k === 'Delete' || k === 'Backspace')) { setGuides(gs => gs.filter(g => g.id !== L.selGuide)); setSelGuide(null) }
      else if (L.selGuide != null && k === 'Escape') setSelGuide(null)
      else if (mod && (lk === 'y' || (lk === 'z' && e.shiftKey))) redo()
      else if (mod && lk === 'z') undo()
      else if (mod && k === '0') frame('actual')
      else if (mod && (k === '=' || k === '+')) zoomAt(vp.z * 1.25, innerWidth / 2, innerHeight / 2)
      else if (mod && k === '-') zoomAt(vp.z / 1.25, innerWidth / 2, innerHeight / 2)
      else if (mod && lk === 'd' && s && cv.on) select(duplicate(s))
      else if (mod && lk === 'c' && s) { L.clip = s; navigator.clipboard?.writeText(s.outerHTML).catch(() => {}) }
      else if (mod || e.altKey) return
      else if (k === ' ') { L.space = true; if (!e.repeat) setSpace(true) }
      else if (k === 'C' && e.shiftKey) L.toggleCanvas()
      else if (e.shiftKey && e.code === 'Digit1') frame('fit')
      else if (k === 'G' && e.shiftKey) setGrid(v => !v)
      else if (k === 'V' && e.shiftKey) { closeSvgEditor(); setResp(r => (r ? null : DEFAULT_RESP)) }
      else if (lk === 'i' && !e.shiftKey) eyedrop()
      else if (k === 'P' && e.shiftKey) setTool('draw')
      else if (lk === 'x' && !e.shiftKey) setXray(v => !v)
      else if (ANIMATE_TAB && lk === 'm' && !e.shiftKey && !FRAME) setTimeline(v => !v)
      else if (lk === 'a' && !e.shiftKey) setAnatLock(v => !v)
      else if (!e.shiftKey && TOOL_KEYS[k]) setTool(TOOL_KEYS[k])
      else if (k === 'R' && e.shiftKey) setShow(v => ({ ...v, rulers: !v.rulers }))
      else if (s && (k === ']' || k === '[')) setStyle(s, 'z-index', String(Math.max(0, (parseInt(getComputedStyle(s).zIndex) || 0) + (k === ']' ? 1 : -1))))
      else if (k === 'Escape') select(null)
      else if (k === 'Enter' && s && !e.shiftKey && s instanceof SVGElement) openSvgEditor(s)
      else if (k === 'Enter' && s) {
        const n = e.shiftKey ? s.parentElement : layerKids(s)[0]
        if (n && n !== document.body && n !== document.documentElement) select(n)
      } else if (s && k.startsWith('Arrow')) {
        const [x, y] = getPos(s), m = e.shiftKey ? 10 : 1
        setPos(s, x + (k === 'ArrowLeft' ? -m : k === 'ArrowRight' ? m : 0), y + (k === 'ArrowUp' ? -m : k === 'ArrowDown' ? m : 0))
      } else if (s && (k === 'Delete' || k === 'Backspace')) {
        setStyle(s, 'display', 'none')
        select(s.parentElement === document.body ? null : s.parentElement)
      } else return
      e.preventDefault(); e.stopPropagation()
    }
    const keyup = (e: KeyboardEvent) => {
      if (e.key === ' ') { L.space = false; setSpace(false) }
      if (e.key === 'Alt') { e.preventDefault(); setAlt(false) }
      if (e.key === 'Shift') setShiftDown(false)
    }
    const blur = () => { setShiftDown(false); setAlt(false); L.space = false; setSpace(false) }

    const wheel = (e: WheelEvent) => {
      if (FRAME || !L.open || fromOverlay(e)) return
      if (e.ctrlKey || e.metaKey) {
        e.preventDefault()
        zoomAt(vp.z * Math.exp(-Math.max(-50, Math.min(50, e.deltaY)) * 0.01), e.clientX, e.clientY)
      } else if (vp.z !== 1 || vp.x || vp.y) {
        // zoomed: wheel pans the canvas, like a design tool
        e.preventDefault()
        const [dx, dy] = e.shiftKey && !e.deltaX ? [e.deltaY, 0] : [e.deltaX, e.deltaY]
        vp.x -= dx; vp.y -= dy
        applyVP()
      }
    }

    const on: [string, EventListener, AddEventListenerOptions?][] = [
      ['pointerdown', down as EventListener], ['pointermove', move as EventListener], ['pointerup', up], ['pointercancel', up],
      ['mousedown', block], ['mouseup', block], ['click', block], ['auxclick', block], ['dblclick', dbl as EventListener],
      ['keydown', key as EventListener], ['keyup', keyup as EventListener], ['wheel', wheel as EventListener, { capture: true, passive: false }],
      ['paste', paste as EventListener], ['blur', blur],
    ]
    const guarded = on.map(([t, f, o]) => [t, (e: Event) => { if (!synthetic) f(e) }, o] as const) // Motion gesture replays aren't clicks
    for (const [t, f, o] of guarded) window.addEventListener(t, f, o ?? true)
    return () => { for (const [t, f, o] of guarded) window.removeEventListener(t, f, o ?? true) }
  }, [L, select])

  const toggleCanvas = () => {
    L.stopEdit?.()
    if (!cv.on) enterCanvas()
    else leaveCanvas()
  }
  const close = () => { if (!cv.on || leaveCanvas()) { saveNow(); clearForced(); setOpen(false) } }
  L.toggleCanvas = toggleCanvas
  // record CSS animations and transitions as they start, so the timeline can show what just happened
  useEffect(() => {
    if (!open || FRAME) return
    const on = () => capture()
    document.addEventListener('transitionrun', on, true); document.addEventListener('animationstart', on, true)
    return () => { document.removeEventListener('transitionrun', on, true); document.removeEventListener('animationstart', on, true) }
  }, [open])
  const saveNow = () => { if (!FRAME && prefs.persist && restoredPages.has(pageKey())) writePage(capturePage(L.guides)) }
  // restore this page's saved session once per load (after the app has had a moment to render)
  useEffect(() => {
    if (FRAME || !open || !prefs.persist || restoredPages.has(pageKey())) return
    const t = setTimeout(() => {
      restoredPages.add(pageKey())
      const page = readSession()[pageKey()]
      if (!page) return
      const { applied, missed } = restorePage(page)
      if (page.guides?.length) setGuides(page.guides)
      if (applied || page.guides?.length) {
        notify(`Restored ${applied} edit${applied === 1 ? '' : 's'} from your last session${missed ? ` · ${missed} no longer match the page` : ''}`,
          { label: 'Discard', run: () => { if (cv.on) exitCanvas(); resetEdits(); setGuides([]); writePage(null) } })
      }
      bump()
    }, 300)
    return () => clearTimeout(t)
  }, [open, href])
  // autosave (debounced) whenever edits or guides change
  useEffect(() => {
    if (FRAME || !open) return
    const t = setTimeout(saveNow, 400)
    return () => clearTimeout(t)
  }, [rev, guides, open, href]) // eslint-disable-line react-hooks/exhaustive-deps
  L.close = close

  const startResize = (e: RPointerEvent, dir: string) => {
    const el = L.sel
    if (!el) return
    e.preventDefault(); e.stopPropagation()
    const cs = getComputedStyle(el), r = el.getBoundingClientRect(), [x0, y0] = getPos(el)
    L.g = { k: 'resize', el, dir, x: e.clientX, y: e.clientY, w: parseFloat(cs.width) || r.width / vp.z, h: parseFloat(cs.height) || r.height / vp.z, x0, y0 }
  }

  const startGuide = (axis: 'x' | 'y', e: RPointerEvent, existing?: number) => {
    e.preventDefault(); e.stopPropagation()
    const id = existing ?? Date.now()
    if (existing != null && guides.find(g => g.id === id)?.locked) { select(null); setSelGuide(id); return }
    const pos = (ev: { clientX: number; clientY: number }) => { const o = origin(); return Math.round((axis === 'x' ? ev.clientX - o.x : ev.clientY - o.y) / vp.z) }
    if (existing == null) setGuides(gs => [...gs, { id, axis, pos: pos(e), pattern: 'solid' }])
    setDragging(id)
    let moved = false
    const mv = (ev: PointerEvent) => { moved = true; setGuides(gs => gs.map(g => (g.id === id ? { ...g, pos: pos(ev) } : g))) }
    const done = (ev: PointerEvent) => {
      window.removeEventListener('pointermove', mv); window.removeEventListener('pointerup', done)
      setDragging(null)
      if (existing != null && !moved) { select(null); setSelGuide(id) } // a click selects the guide
      else if (axis === 'x' ? ev.clientX < lay.l + RULER : ev.clientY < lay.t + RULER) { setGuides(gs => gs.filter(g => g.id !== id)); setSelGuide(null) } // dropped back on the ruler
    }
    window.addEventListener('pointermove', mv); window.addEventListener('pointerup', done)
  }
  const updateGuide = useCallback((patch: Partial<Guide>) => setGuides(gs => gs.map(g => (g.id === selGuide ? { ...g, ...patch } : g))), [selGuide])
  const removeGuide = useCallback(() => { setGuides(gs => gs.filter(g => g.id !== selGuide)); setSelGuide(null) }, [selGuide])
  const closeInspector = useCallback(() => setShow(v => ({ ...v, inspector: false })), [])
  const openCode = useCallback(() => setRight('code'), [])

  // vector editing: drag anchors / handles, double-click toggles smooth ↔ corner, click the outline to add a point
  const startNode = (e: RPointerEvent, si: number, ni: number, part: 'anchor' | 'in' | 'out') => {
    e.preventDefault(); e.stopPropagation()
    const el = pe.el, m = editView()?.getScreenCTM()
    if (!el || !m) return
    const subs = editSubs()
    if (pen.cur && part === 'anchor' && si === 0 && ni === 0 && subs[0].nodes.length > 1) {
      // clicking the first anchor closes the pen path
      pen.cur.subs[0].closed = true
      pen.cur.path.setAttribute('d', serializePath(pen.cur.subs))
      const svg = finishPen()
      if (svg) select(svg as unknown as HTMLElement)
      setTool('select')
      return
    }
    pe.node = [si, ni]
    L.g = { k: 'node', el, subs, si, ni, part, inv: m.inverse(), x: e.clientX, y: e.clientY, orig: structuredClone(subs[si].nodes[ni]) }
    bump()
  }
  const toggleSmooth = (si: number, ni: number) => {
    const subs = editSubs(), sp = subs[si], n = sp.nodes[ni]
    if (n.in || n.out) { delete n.in; delete n.out }
    else {
      const last = sp.nodes.length - 1
      const prev = sp.nodes[ni - 1] ?? (sp.closed ? sp.nodes[last] : n), next = sp.nodes[ni + 1] ?? (sp.closed ? sp.nodes[0] : n)
      const tx = next.x - prev.x, ty = next.y - prev.y, l = Math.hypot(tx, ty) || 1, len = l / 6
      n.in = [n.x - (tx / l) * len, n.y - (ty / l) * len]
      n.out = [n.x + (tx / l) * len, n.y + (ty / l) * len]
    }
    writeEdit(subs)
  }
  const insertAt = (e: RPointerEvent) => {
    e.preventDefault(); e.stopPropagation()
    const m = editView()?.getScreenCTM()
    if (!m) return
    const subs = editSubs(), q = new DOMPoint(e.clientX, e.clientY).matrixTransform(m.inverse())
    const best = nearestSeg(subs, q.x, q.y)
    if (!best) return
    const n = subs[best.si].nodes
    n.splice(best.i + 1, 0, splitSeg(n[best.i], n[(best.i + 1) % n.length], best.t))
    pe.node = [best.si, best.i + 1]
    writeEdit(subs)
  }
  /** Grab a segment and drag to bend it; straight segments become curves. */
  const startBend = (e: RPointerEvent) => {
    e.preventDefault(); e.stopPropagation()
    const el = pe.el, m = editView()?.getScreenCTM()
    if (!el || !m) return
    const subs = editSubs(), inv = m.inverse(), q = new DOMPoint(e.clientX, e.clientY).matrixTransform(inv)
    const hit = nearestSeg(subs, q.x, q.y)
    if (!hit) return
    const n = subs[hit.si].nodes, a = n[hit.i], b = n[(hit.i + 1) % n.length]
    if (!a.out && !b.in) { a.out = [a.x + (b.x - a.x) / 3, a.y + (b.y - a.y) / 3]; b.in = [a.x + (2 * (b.x - a.x)) / 3, a.y + (2 * (b.y - a.y)) / 3] }
    a.out ??= [a.x, a.y]; b.in ??= [b.x, b.y]
    pe.node = null
    L.g = { k: 'bend', el, subs, si: hit.si, i: hit.i, t: Math.min(0.9, Math.max(0.1, hit.t)), inv, x: e.clientX, y: e.clientY, p1: [...a.out], p2: [...b.in] }
  }

  const navigate = (path: string) => {
    if (cv.on && !leaveCanvas()) return
    closeSvgEditor(); select(null); L.hover = null
    goTo(path)
  }

  if (!open) {
    if (FRAME) return null
    return (
      <div className="root" data-theme={theme}>
        <button className="launch ui" data-tip={`Watcher · ${toggleLabel()}${readSession()[pageKey()] ? ' · unapplied edits saved' : ''}`} onClick={() => setOpen(true)}>
          <Mark size={26} />{!FRAME && prefs.persist && readSession()[pageKey()] && <i className="launch-dot" />}
        </button>
      </div>
    )
  }

  // docked layout: everything below is positioned against these insets
  const vw = innerWidth, vh = innerHeight
  lay.l = !FRAME && show.layers ? LEFT_W : 0
  lay.r = !FRAME && show.inspector ? RIGHT_W : 0
  lay.t = FRAME ? 0 : TOPBAR + TABS + TOOLROW
  const rul = show.rulers && !FRAME ? RULER : 0, cx0 = lay.l + rul, cy0 = lay.t + rul
  const area = { l: cx0, t: cy0, w: Math.max(0, vw - lay.r - cx0), h: Math.max(0, vh - cy0) }
  const z = vp.z, o = origin(), editing = !!ed.svg, covered = editing || !!resp
  // the page as an artboard: page x=0 sits at body.left - margin·z
  const bcs = getComputedStyle(document.body), bml = parseFloat(bcs.marginLeft) || 0, bmt = parseFloat(bcs.marginTop) || 0
  const pageW = document.documentElement.clientWidth
  const pageH = Math.max(document.documentElement.clientHeight, document.body.offsetHeight + bmt + (parseFloat(bcs.marginBottom) || 0))
  const ab = { x: o.x - bml * z, y: o.y - bmt * z, w: pageW * z, h: pageH * z }

  const sr = !covered && sel?.isConnected ? sel.getBoundingClientRect() : null
  const hv = !covered && L.hover && L.hover !== sel && L.hover.isConnected ? L.hover : null
  const hr = hv?.getBoundingClientRect()
  // hold Alt: redlines to the hovered element, or to the parent when hovering nothing else
  const parentEl = sel?.parentElement && sel.parentElement !== document.body ? sel.parentElement : null
  const target = sr && (alt || prefs.alwaysMeasure) ? hr ?? parentEl?.getBoundingClientRect() : undefined
  const lines = sr && target ? measure(sr, target, z) : []

  let rings: ReactNode = null
  if (sel && sr && prefs.spacing) {
    const cs = getComputedStyle(sel), px = (p: string) => (parseFloat(cs.getPropertyValue(p)) || 0) * z
    const inset = (b: { x: number; y: number; w: number; h: number }, s: string) => {
      const [t, r, bt, l] = ['top', 'right', 'bottom', 'left'].map(d => px(s.replace('*', d)))
      return { x: b.x + l, y: b.y + t, w: b.w - l - r, h: b.h - t - bt }
    }
    const box = { x: sr.left, y: sr.top, w: sr.width, h: sr.height }
    const ml = px('margin-left'), mt = px('margin-top')
    const marg = { x: box.x - ml, y: box.y - mt, w: box.w + ml + px('margin-right'), h: box.h + mt + px('margin-bottom') }
    const bord = inset(box, 'border-*-width'), cont = inset(bord, 'padding-*')
    rings = <>
      <path d={rp(marg) + rp(box)} fillRule="evenodd" className="mg" />
      <path d={rp(bord) + rp(cont)} fillRule="evenodd" className="pd" />
    </>
  }

  let vector: ReactNode = null
  const ctm = editView()?.getScreenCTM() ?? null
  if (ctm && pe.el) {
    const T = (x: number, y: number): [number, number] => { const q = new DOMPoint(x, y).matrixTransform(ctm); return [q.x, q.y] }
    const screen: Sub[] = editSubs().map(sp => ({
      closed: sp.closed,
      nodes: sp.nodes.map(n => { const [x, y] = T(n.x, n.y); return { x, y, in: n.in && T(...n.in), out: n.out && T(...n.out) } }),
    }))
    const [ssi, sni] = pe.node ?? [-1, -1]
    const near = (si: number, ni: number, len: number) => si === ssi && (Math.abs(ni - sni) <= 1 || (screen[si].closed && Math.abs(ni - sni) === len - 1))
    const d = serializePath(screen), last = pen.cur?.subs[0].nodes.at(-1)
    const lastS = last && T(last.x, last.y)
    vector = <>
      <path className="pe-line" d={d} />
      {!pen.cur && <path className="pe-hit" d={d} onPointerDown={e => (e.altKey ? insertAt(e) : startBend(e))} />}
      {pen.cur && lastS && pen.hover && !pen.cur.drag && <line className="rubber" x1={lastS[0]} y1={lastS[1]} x2={pen.hover[0]} y2={pen.hover[1]} />}
      {screen.map((sp, si) => sp.nodes.map((n, ni) => (
        <g key={si + ':' + ni}>
          {near(si, ni, sp.nodes.length) && (['in', 'out'] as const).map(h => n[h] && (
            <g key={h}>
              <line className="pe-h" x1={n.x} y1={n.y} x2={n[h]![0]} y2={n[h]![1]} />
              <circle className="pe-hd" cx={n[h]![0]} cy={n[h]![1]} r={3.5} onPointerDown={e => startNode(e, si, ni, h)} />
            </g>
          ))}
          <circle className={'pe-a' + (si === ssi && ni === sni ? ' on' : '') + (pen.cur && si === 0 && ni === 0 ? ' first' : '')}
            cx={n.x} cy={n.y} r={4}
            onPointerDown={e => startNode(e, si, ni, 'anchor')} onDoubleClick={() => toggleSmooth(si, ni)} />
        </g>
      )))}
    </>
  }
  const now = performance.now()
  while (flashes.length && now - flashes[0].t > 700) flashes.shift()

  const tab = editing ? 'svg' : resp ? 'resp' : cv.on ? 'canvas' : 'page'
  // selecting inside a responsive preview switches the layer tree to that frame's document
  const treeRoot = sel?.isConnected && sel.ownerDocument !== document ? sel.ownerDocument.body : document.body
  const host = location.host
  const fav = (document.querySelector('link[rel~="icon"]') as HTMLLinkElement | null)?.href
  const favicon = fav ? <img className="fav" src={fav} alt="" /> : <Icon d={P.globe} size={14} />
  const zoomBy = (k: number) => { if (editing) { ed.zoom *= k; bump() } else zoomAt(z * k, area.l + area.w / 2, area.t + area.h / 2) }
  const shotRect = () => {
    if (sel?.isConnected && !editing) return sel.getBoundingClientRect()
    const x = Math.max(editing ? area.l : ab.x, area.l), y = Math.max(editing ? area.t : ab.y, area.t)
    return new DOMRect(x, y, Math.min(editing ? vw - lay.r : ab.x + ab.w, vw - lay.r) - x, Math.min(editing ? vh : ab.y + ab.h, vh) - y)
  }
  const trail = (el: Element) => {
    const chain: Element[] = []
    for (let e: Element | null = el; e && e !== document.body && chain.length < 3; e = e.parentElement) chain.unshift(e)
    const s = chain.map(crumbLabel).join(' › ')
    return s.length > 38 ? '…' + s.slice(-37) : s
  }
  const tb = (t: Tool, d: string, tip: string) => (
    <button key={t} className={'b' + ((space ? 'hand' : tool) === t ? ' on' : '')} data-tip={tip} onClick={() => setTool(t)}><Icon d={d} /></button>
  )

  // anatomy (hold Shift / A): dim everything but the hovered (or selected) element and lay out its box model
  const anatEl = (shiftDown || anatLock) && !covered ? (hv ?? (sel?.isConnected ? sel : null)) : null
  const an = anatEl ? anatomyOf(anatEl, z) : null

  // the in-page layer: shared by the full overlay and frame mode
  const stage = <>
        <svg className="stage" width={vw} height={vh}>
          {!covered && strokes.map((s, i) => (
            <path key={i} className="ink" strokeWidth={2.5 * z}
              d={s.reduce((d, v, j) => (j % 2 ? d : `${d}${j ? 'L' : 'M'}${o.x + v * z} ${o.y + s[j + 1] * z}`), '')} />
          ))}
          {flashes.map((f, i) => (
            <rect key={'f' + i} className={'flash-' + f.kind} opacity={1 - (now - f.t) / 700} x={o.x + f.b.l * z} y={o.y + f.b.t * z} width={f.b.w * z} height={f.b.h * z} />
          ))}
          {/* always mounted, so moving to another element morphs the outline (CSS transition) instead of jumping */}
          {an && <>
            <defs>
              {(['pad', 'mar', 'gap'] as const).map(k => (
                <pattern key={k} id={'an-' + k} width="6" height="6" patternUnits="userSpaceOnUse" patternTransform="rotate(45)">
                  <rect width="6" height="6" className={'an-bg ' + k} /><line x1="0" y1="0" x2="0" y2="6" className={'an-ln ' + k} />
                </pattern>
              ))}
            </defs>
            <path className="an-dim" fillRule="evenodd" d={rp({ x: 0, y: 0, w: vw, h: vh }) + rp(an.M)} />
            {an.regions.map((g, i) => <rect key={i} x={g.x} y={g.y} width={g.w} height={g.h} fill={`url(#an-${g.kind})`} />)}
            {an.kids.map((k, i) => <rect key={'k' + i} className="an-kid" x={k.left + 0.5} y={k.top + 0.5} width={Math.max(0, k.width - 1)} height={Math.max(0, k.height - 1)} />)}
            <rect className="an-content" x={an.C.x} y={an.C.y} width={Math.max(0, an.C.w)} height={Math.max(0, an.C.h)} />
            <rect className="an-box" x={an.B.x} y={an.B.y} width={an.B.w} height={an.B.h} />
          </>}
          {!an && (hr || L.lastHov) && (() => { const b = hr ?? L.lastHov!; if (hr) L.lastHov = hr; return (
            <rect className={'hov' + (hr ? '' : ' off')} style={{ x: b.left + 0.5, y: b.top + 0.5, width: Math.max(0, b.width - 1), height: Math.max(0, b.height - 1) }} />
          ) })()}
          {!hr && target && <rect className="hov dash" x={target.left + 0.5} y={target.top + 0.5} width={Math.max(0, target.width - 1)} height={Math.max(0, target.height - 1)} />}
          {rings}
          {sr && <rect className="selr" x={sr.left} y={sr.top} width={sr.width} height={sr.height} />}
          {lines.map((l, i) => <line key={i} className="ml" x1={l.x1} y1={l.y1} x2={l.x2} y2={l.y2} />)}
          {L.g?.k === 'move' && L.snaps.map((s, i) => s.axis === 'x'
            ? <line key={'s' + i} className="snap" x1={o.x + s.pos * z} x2={o.x + s.pos * z} y1={o.y + s.a * z} y2={o.y + s.b * z} />
            : <line key={'s' + i} className="snap" y1={o.y + s.pos * z} y2={o.y + s.pos * z} x1={o.x + s.a * z} x2={o.x + s.b * z} />)}
          {vector}
        </svg>

        {lines.map((l, i) => <div key={i} className="pill" style={{ left: (l.x1 + l.x2) / 2, top: (l.y1 + l.y2) / 2, transform: 'translate(-50%,-50%)' }}>{l.v}</div>)}
        {an && anatEl && <>
          {an.regions.map((g, i) => (
            <div key={i} className={'an-pill ' + g.kind} style={{ left: g.x + g.w / 2, top: g.y + g.h / 2 }}>{round(g.v)}</div>
          ))}
          <div className="an-head" style={{ left: an.M.x, top: Math.max(an.M.y - 6, cy0 + 26) }}>
            <b>{label(anatEl)}</b><span>{round(an.B.w / z)} × {round(an.B.h / z)}</span>
            <i className="pad">padding</i><i className="mar">margin</i>{an.regions.some(g => g.kind === 'gap') && <i className="gap">gap</i>}
          </div>
        </>}
        {!an && hv && hr && (
          <div className="htip" style={{ left: hr.left, top: Math.max(hr.top - 6, cy0 + 26) }}>
            <span className="tag">{hv.tagName.toLowerCase()}</span><span>{trail(hv)}</span>
          </div>
        )}
        {sel && sr && <>
          <div className="pill" style={{ left: sr.left, top: Math.max(sr.top - 4, cy0 + 22), transform: 'translateY(-100%)' }}>{label(sel)}{forced.get(sel) && <span className="pstate">:{forced.get(sel)}</span>}</div>
          <div className="pill" style={{ left: sr.left + sr.width / 2, top: sr.bottom + 6, transform: 'translateX(-50%)' }}>{round(sr.width / z)} × {round(sr.height / z)}</div>
          {!pe.el && HANDLES.map(([d, fx, fy]) => (
            <div key={d} className={'hd ' + d} style={{ left: sr.left + sr.width * fx, top: sr.top + sr.height * fy }} onPointerDown={e => startResize(e, d)} />
          ))}
        </>}
  </>
  if (FRAME) return <div className="root" data-theme={theme} onKeyDown={e => e.stopPropagation()}>{stage}</div>

  return (
    <div className="root" ref={el => { UI.root = el }} data-theme={theme} onKeyDown={e => e.stopPropagation()}>
      {/* ── canvas: everything here is clipped to the area between the rulers and the sidebars ── */}
      <div className="viewport" style={{ clipPath: `inset(${cy0}px ${lay.r}px 0 ${cx0}px)` }}>
        <svg className="mask" width={vw} height={vh}>
          <defs>
            <pattern id="do-dots" width={16} height={16} patternUnits="userSpaceOnUse"><circle cx={1} cy={1} r={1} className="dot" /></pattern>
            <pattern id="do-grid" width={8} height={8} patternUnits="userSpaceOnUse" patternTransform={`translate(${ab.x} ${ab.y}) scale(${z})`}>
              <circle cx={0} cy={0} r={0.7 / Math.max(z, 0.3)} className="gdot" />
            </pattern>
          </defs>
          <path d={rp({ x: 0, y: 0, w: vw, h: vh }) + rp(ab)} fillRule="evenodd" className="cvbg" />
          <path d={rp({ x: 0, y: 0, w: vw, h: vh }) + rp(ab)} fillRule="evenodd" fill="url(#do-dots)" />
          <rect x={ab.x - 0.5} y={ab.y - 0.5} width={ab.w + 1} height={ab.h + 1} className="abline" />
          {grid && <rect x={ab.x} y={ab.y} width={ab.w} height={ab.h} fill="url(#do-grid)" />}
        </svg>
        {!covered && <div className="ablabel" style={{ left: ab.x, top: ab.y }}>{host}{location.pathname}</div>}
        {editing && <SvgEditor area={area} />}
        {resp && !editing && <Responsive area={area} value={resp} onChange={setResp} href={href} inspect={frameInspect} onInspect={setFrameInspect} />}
        {ANIMATE_TAB && timeline && !editing && <Timeline area={area} pick={el => { select(el); setRight('inspect'); setShow(v => ({ ...v, inspector: true })); if (ANIMATE_TAB) showInspectorTab('animate') }} />}

        {stage}

        {!covered && guides.map(g => {
          const p = g.axis === 'x' ? o.x + g.pos * z : o.y + g.pos * z
          const style = { [g.axis === 'x' ? 'left' : 'top']: p, '--gc': g.color, '--gp': g.pattern } as CSSProperties
          return (
            <div key={g.id} className={'gd ' + g.axis + (selGuide === g.id ? ' on' : '') + (g.locked ? ' lock' : '')} style={style} onPointerDown={e => startGuide(g.axis, e, g.id)}>
              {(dragging === g.id || selGuide === g.id) && (
                <span className="pill" style={{ ...(g.axis === 'x' ? { left: 8, top: cy0 + 8 } : { top: 8, left: cx0 + 8 }), background: g.color }}>{g.locked ? '🔒 ' : ''}{g.pos}</span>
              )}
            </div>
          )
        })}
      </div>

      {show.rulers && !covered && <>
        <Ruler style={{ left: lay.l, top: lay.t }} len={vw - lay.l - lay.r} o={o.x - lay.l} z={z} hi={sr ? [sr.left - lay.l, sr.right - lay.l] : null}
          marks={guides.filter(g => g.axis === 'x').map(g => ({ p: o.x + g.pos * z - lay.l, color: g.color }))} onDown={e => startGuide('y', e)} />
        <Ruler vertical style={{ left: lay.l, top: lay.t }} len={vh - lay.t} o={o.y - lay.t} z={z} hi={sr ? [sr.top - lay.t, sr.bottom - lay.t] : null}
          marks={guides.filter(g => g.axis === 'y').map(g => ({ p: o.y + g.pos * z - lay.t, color: g.color }))} onDown={e => startGuide('x', e)} />
        <div className="corner ui" style={{ left: lay.l, top: lay.t }} data-tip="Clear guides" onClick={() => setGuides([])}><Icon d={P.x} size={10} /></div>
      </>}

      {/* ── address bar ── */}
      <div className="addr ui">
        <button className="b xs" data-tip={document.title || host}><Icon d={P.info} size={15} /></button>
        <UrlField href={href} onGo={u => { const p = samePath(u); if (p) navigate(p); else location.assign(u) }} />
        <div className="grp">
          <button className="b xs" data-tip="Copy link" onClick={() => { navigator.clipboard?.writeText(location.href); notify('Link copied') }}><Icon d={P.link} size={15} /></button>
          <button className="b xs" data-tip={sel && !editing ? 'Screenshot selection' : 'Screenshot'} onClick={() => screenshot(shotRect())}><Icon d={P.camera} size={15} /></button>
        </div>
        <div className="grp">
          <button className="b xs" data-tip="Open in new tab" onClick={() => window.open(location.href, '_blank')}><Icon d={P.globe} size={15} /></button>
          <button className={'b xs' + (tool === 'select' ? ' tg' : '')} data-tip="Inspect · V" onClick={() => setTool('select')}><Icon d={P.target} size={15} /></button>
        </div>
        <div className="grp">
          <button className="b xs" data-tip="Toggle sidebars" onClick={() => setShow(v => { const on = !(v.layers || v.inspector); return { ...v, layers: on, inspector: on } })}><Icon d={P.sideR} size={15} /></button>
        </div>
      </div>

      {/* ── tabs: the page, the free canvas, the svg editor ── */}
      <div className="tabsrow ui" style={{ left: lay.l, right: lay.r, top: TOPBAR }}>
        <button className={'ptab' + (tab === 'page' ? ' on' : '')} onClick={() => { if (editing) closeSvgEditor(); setResp(null); if (cv.on) toggleCanvas() }}>{favicon}{host}</button>
        {cv.on && (
          <button className={'ptab' + (tab === 'canvas' ? ' on' : '')} onClick={() => { if (editing) closeSvgEditor(); setResp(null) }}>
            <Icon d={P.canvas} size={13} />Free canvas<span className="x" onClick={e => { e.stopPropagation(); toggleCanvas() }}><Icon d={P.x} size={11} /></span>
          </button>
        )}
        {resp && (
          <button className={'ptab' + (tab === 'resp' ? ' on' : '')} onClick={() => editing && closeSvgEditor()}><Icon d={P.devices} size={13} />Responsive<span className="x" onClick={e => { e.stopPropagation(); setResp(null) }}><Icon d={P.x} size={11} /></span></button>
        )}
        {editing && (
          <button className="ptab on"><Icon d={P.nib} size={13} />SVG<span className="x" onClick={e => { e.stopPropagation(); closeSvgEditor() }}><Icon d={P.x} size={11} /></span></button>
        )}
        {!cv.on && <button className="b xs" data-tip="New free canvas · ⇧C" onClick={toggleCanvas}><Icon d={P.plus} size={14} /></button>}
        <span className="sp" />
        {!resp && <div className="zoomctl">
          <button className="b xs" data-tip="Zoom out · Ctrl −" onClick={() => zoomBy(1 / 1.25)}><Icon d={P.minus} size={14} /></button>
          <button className="b xs zl" data-tip={editing ? 'Zoom' : 'Actual size · Ctrl 0'} onClick={() => !editing && frame('actual')}>{Math.round((editing ? ed.zoom : z) * 100)}%</button>
          <button className="b xs" data-tip="Zoom in · Ctrl +" onClick={() => zoomBy(1.25)}><Icon d={P.plus} size={14} /></button>
          <button className="b xs fitb" data-tip="Fit · ⇧1" onClick={() => { if (editing) { ed.zoom = 0; bump() } else frame('fit') }}>Fit</button>
        </div>}
      </div>

      {/* ── toolbar ── */}
      <div className="toolrow ui" style={{ left: lay.l, right: lay.r, top: TOPBAR + TABS }}>
        <span className="mark" data-tip={`Watcher ${__VERSION__}`}><Mark size={22} /></span>
        <i className="sep" />
        {TOOLS.map(([t, d, tip]) => tb(t, d, tip))}
        <button className="b" data-tip="Pick colour · I" onClick={eyedrop}><Icon d={P.dropper} /></button>
        <i className="sep" />
        <button className={'b' + (show.rulers ? ' tg' : '')} data-tip="Rulers · ⇧R" onClick={() => setShow(v => ({ ...v, rulers: !v.rulers }))}><Icon d={P.ruler} /></button>
        <button className={'b' + (grid ? ' tg' : '')} data-tip="Pixel grid · ⇧G" onClick={() => setGrid(v => !v)}><Icon d={P.grid} /></button>
        <i className="sep" />
        <button className={'b' + (xray ? ' on' : '')} data-tip="X-ray · X" onClick={() => setXray(v => !v)}><Icon d={P.xray} /></button>
        {ANIMATE_TAB && <button className={'b' + (timeline ? ' on' : '')} data-tip="Timeline · M" onClick={() => setTimeline(v => !v)}><Icon d={P.timer} /></button>}
        <button className={'b' + (right === 'ds' ? ' tg' : '')} data-tip="Design system" onClick={() => { setRight(r => (r === 'ds' ? 'inspect' : 'ds')); setShow(v => ({ ...v, inspector: true })) }}><Icon d={P.palette} /></button>
        <button className={'b' + (right === 'perf' ? ' tg' : '')} data-tip="Profiler" onClick={() => { setRight(r => (r === 'perf' ? 'inspect' : 'perf')); setShow(v => ({ ...v, inspector: true })) }}><Icon d={P.pulse} /></button>
        <button className={'b' + (right === 'checks' ? ' tg' : '')} data-tip="Checks: tokens & accessibility" onClick={() => { setRight(r => (r === 'checks' ? 'inspect' : 'checks')); setShow(v => ({ ...v, inspector: true })) }}><Icon d={P.shield} /></button>
        <button className={'b' + (resp ? ' on' : '')} data-tip="Responsive · ⇧V" onClick={() => { closeSvgEditor(); setResp(r => (r ? null : DEFAULT_RESP)) }}><Icon d={P.devices} /></button>
        <i className="sep" />
        <button className={'b' + (right === 'code' ? ' tg' : '')} data-tip="Apply to code" onClick={() => { setRight(r => (r === 'code' ? 'inspect' : 'code')); setShow(v => ({ ...v, inspector: true })) }}><Icon d={P.code} /></button>
        <button className="b" data-tip="Undo · Ctrl Z" disabled={!hist.length} onClick={undo}><Icon d={P.undo} /></button>
        <button className="b" data-tip="Redo · Ctrl ⇧Z" disabled={!redos.length} onClick={redo}><Icon d={P.redo} /></button>
        {strokes.length > 0 && <button className="b" data-tip="Clear drawings" onClick={() => { strokes.length = 0; bump() }}><Icon d={P.trash} /></button>}
        <span className="sp" />
        <button className={'b' + (show.layers ? ' tg' : '')} data-tip="Left sidebar" onClick={() => setShow(v => ({ ...v, layers: !v.layers }))}><Icon d={P.sideL} /></button>
        <button className={'b' + (show.inspector ? ' tg' : '')} data-tip="Right sidebar" onClick={() => setShow(v => ({ ...v, inspector: !v.inspector }))}><Icon d={P.sideR} /></button>
        <i className="sep" />
        <button className="b" data-tip={`Close · ${toggleLabel()}`} onClick={close}><Icon d={P.x} /></button>
      </div>

      {/* ── left sidebar: site, pages, layers ── */}
      {show.layers && (
        <div className="side left ui" style={{ top: TOPBAR, width: LEFT_W }}>
          <div className="brand">{favicon}<b title={document.title}>{document.title || host}</b><span className="sp" />
            <button className="b xs" data-tip="Reload page" onClick={() => location.reload()}><Icon d={P.refresh} size={14} /></button>
          </div>
          {editing ? <SvgLayers /> : <>
            <PagesList href={href} onNav={navigate} />
            <Group title={treeRoot === document.body ? 'Layers' : `Layers · ${treeRoot.ownerDocument.defaultView?.innerWidth}px preview`} n={treeRoot.getElementsByTagName('*').length} grow>
              <LayerTree key={treeRoot === document.body ? 'page' : 'frame'} root={treeRoot} sel={sel} rev={rev} select={select} hover={hover} filter={filter} />
            </Group>
          </>}
          <div className="sidefoot">
            <label className="f search"><Icon d={P.search} size={13} /><input placeholder="Filter layers" value={filter} onChange={e => setFilter(e.target.value)} spellCheck={false} /></label>
            <button className={'b sm' + (settings ? ' tg' : '')} data-tip="Settings" onClick={() => setSettings(v => !v)}><Icon d={P.gear} /></button>
          </div>
          {settings && <Settings theme={theme} setTheme={setTheme} onClose={() => setSettings(false)} />}
        </div>
      )}

      {/* ── right sidebar: inspector / vector / design system / profiler ── */}
      {show.inspector && (
        <div className="side right ui" style={{ top: TOPBAR, width: RIGHT_W }}>
          {editing ? <VectorPanel onDone={closeSvgEditor} />
            : right === 'ds' ? <><PanelHead title="Design system" icon={P.palette} onClose={() => setRight('inspect')} /><DesignSystem /></>
            : right === 'perf' ? <><PanelHead title="Profiler" icon={P.pulse} onClose={() => setRight('inspect')} /><Profiler /></>
            : right === 'code' ? <><PanelHead title="Apply to code" icon={P.code} onClose={() => setRight('inspect')} /><CodePanel rev={rev} /></>
            : right === 'checks' ? <><PanelHead title="Checks" icon={P.shield} onClose={() => setRight('inspect')} /><ChecksPanel rev={rev} select={select} /></>
            : <Inspector el={sel} rev={rev} select={select} guide={guides.find(g => g.id === selGuide) ?? null}
              updateGuide={updateGuide} removeGuide={removeGuide} theme={theme} setTheme={setTheme} onClose={closeInspector} onCode={openCode} />}
        </div>
      )}

      <div className="banners" style={{ top: cy0 + 10, left: area.l + area.w / 2 }}>
        {xray && (
          <div className="banner ui xr">
            <Icon d={P.xray} /><b>X-ray</b>
            <span className="ramp">{Array.from({ length: 12 }, (_, d) => <i key={d} style={{ background: depthColor(d) }} />)}</span>
            <span>depth 0 → 12+</span>
            <button className="b sm" onClick={() => setXray(false)}>Exit</button>
          </div>
        )}
        {anatLock && <div className="banner ui"><Icon d={P.frame} /><b>Anatomy</b><span>Hover any element to break it down. Hold Shift for a quick look anytime.</span><button className="b sm" onClick={() => setAnatLock(false)}>Exit · A</button></div>}
        {pen.cur && <div className="banner ui"><Icon d={P.nib} /><b>Pen</b><span>Click to add points, drag for curves. Click the first point or press Enter to finish.</span></div>}
      </div>

      {toastMsg && (
        <div className="gtoast ui" style={{ left: area.l + area.w / 2 }}>
          <span>{toastMsg.msg}</span>
          {toastMsg.action && <button className="b sm" onClick={() => { toastMsg.action!.run(); setToastMsg(null) }}>{toastMsg.action.label}</button>}
        </div>
      )}
    </div>
  )
}

const PanelHead = ({ title, icon, onClose }: { title: string; icon: string; onClose: () => void }) => (
  <div className="ph ih"><Icon d={icon} size={15} /><b>{title}</b><span className="sp" /><button className="b xs" data-tip="Back to inspector" onClick={onClose}><Icon d={P.x} size={15} /></button></div>
)
function UrlField({ href, onGo }: { href: string; onGo: (url: string) => void }) {
  const [draft, setDraft] = useState<string | null>(null)
  return (
    <input className="url" value={draft ?? href} spellCheck={false}
      onFocus={e => { setDraft(href); e.currentTarget.select() }} onBlur={() => setDraft(null)} onChange={e => setDraft(e.target.value)}
      onKeyDown={e => { if (e.key === 'Enter') { onGo(e.currentTarget.value); e.currentTarget.blur() } else if (e.key === 'Escape') e.currentTarget.blur() }} />
  )
}

// ── mount ───────────────────────────────────────────────────────────────────
declare const __VERSION__: string
/** Mount the overlay in its own shadow root + React root, outside the app's tree (so zooming <body> never
 *  scales it and the app's CSS never leaks in). Returns the unmount function. Idempotent. */
/** `font`: URL of a Timeless Sans woff2 your app serves. Watcher never ships the font itself (its license forbids
 *  redistribution); without it, an installed "Timeless Sans" is used, else the system UI font. */
export function mount({ font, shortcut }: { font?: string; shortcut?: string } = {}): () => void {
  if (HOST || (FRAME && !parentHost)) return () => {} // a preview frame needs the Watcher page around it
  const sc = shortcut ? parseShortcut(shortcut) : null
  if (shortcut && !sc) console.warn(`[watcher] Can't read shortcut "${shortcut}", using ${DEFAULT_SHORTCUT}. Examples: "Alt+D", "Mod+Shift+K", "F2".`)
  configShortcut = sc ?? parseShortcut(DEFAULT_SHORTCUT)!
  const host = document.createElement('watcher-ui')
  host.style.cssText = 'position:fixed;inset:0;z-index:2147483647;pointer-events:none;display:block'
  const shadow = host.attachShadow({ mode: 'open' })
  const style = document.createElement('style')
  style.textContent = CSS_TEXT
  const el = document.createElement('div')
  shadow.append(style, el)
  document.documentElement.appendChild(host)
  HOST = host
  // @font-face doesn't work inside a shadow root, so the face is declared on the page
  const face = document.createElement('style')
  face.textContent = `@font-face { font-family: "Watcher UI"; src: local("Timeless Sans")${font ? `, url(${JSON.stringify(font)}) format("woff2")` : ''}; font-weight: 100 900; font-display: swap; }`
  document.head.appendChild(face)
  const root = createRoot(el)
  root.render(<Overlay />)
  return () => { HOST = null; host.remove(); face.remove(); setTimeout(() => root.unmount()) }
}

// ── styles ──────────────────────────────────────────────────────────────────
const GLOBAL_CSS = `
html.do-open, html.do-open * { cursor: var(--do-cursor) !important; }
html.do-open body * { user-select: none !important; }
html.do-open [contenteditable], html.do-open [contenteditable] * { cursor: text !important; user-select: text !important; outline: none; }
html.do-xray body * { outline: 1px solid ${depthColor(16)} !important; outline-offset: -1px !important; }
${Array.from({ length: 16 }, (_, d) => `html.do-xray body${' > *'.repeat(d + 1)} { outline-color: ${depthColor(d)} !important; background-color: oklch(66% .19 ${(d * 47) % 360} / .08) !important; }`).join('\n')}
`

const CSS_TEXT = `
:host { all: initial; }
* { box-sizing: border-box; }
.root {
  position: fixed; inset: 0; pointer-events: none;
  font: 500 12px/16px "Watcher UI", "Timeless Sans", Inter, ui-sans-serif, system-ui, -apple-system, "Segoe UI", Roboto, sans-serif;
  color: var(--text); -webkit-font-smoothing: antialiased; font-variant-numeric: tabular-nums;
  --goo: cubic-bezier(.3, 1.45, .45, 1);
  --primary: #f38020; --on-primary: #fff;
  --primary-soft: color-mix(in oklch, var(--primary) 16%, transparent);
  --mono: ui-monospace, "SF Mono", "JetBrains Mono", Menlo, Consolas, monospace;
}
.root[data-theme=light] {
  color-scheme: light;
  --bg: oklch(98.5% .001 286.376); --text: oklch(24.7% .006 258.361); --text-muted: oklch(50.6% .01 264.477); --text-x: oklch(69.5% .009 264.505);
  --border: oklch(94.6% .003 264.542); --canvas: oklch(96.1% .002 247.84); --surface: oklch(100% 0 0);
  --hover: oklch(97% .002 247.839); --hover-2: oklch(93.3% .003 247.86); --border-strong: oklch(91.2% .005 258.326); --border-soft: oklch(96.6% .002 264.542);
  --input: oklch(96.1% .001 286.375);
  --tip-bg: oklch(27.2% .008 264.435); --tip-fg: oklch(97.6% .002 247.839); --tip-muted: oklch(73.1% .008 260.731); --tip-border: oklch(35.6% .007 264.474);
  --shadow-hairline: 0 0 0 1px var(--border);
  --shadow-btn: 0 0 0 1px var(--border-strong), 0 1px 2px oklch(0% 0 0/.06);
  --shadow-raised: 0 0 0 1px var(--border-strong), 0 2px 10px oklch(0% 0 0/.08);
  --shadow-field: none;
}
.root[data-theme=dark] {
  color-scheme: dark;
  --bg: oklch(20.9% .004 264.477); --canvas: oklch(23.1% .004 264.487); --surface: oklch(26% .006 271.191);
  --hover: oklch(28.9% .006 271.22); --hover-2: oklch(31.8% .007 274.747);
  --text: oklch(96.4% .002 247.839); --text-muted: oklch(73.1% .008 260.731); --text-x: oklch(54.1% .01 264.484);
  --border: oklch(30.8% .006 258.354); --border-strong: oklch(35.6% .007 264.474); --border-soft: oklch(27.8% .006 258.354);
  --input: oklch(29.3% .006 271.223);
  --tip-bg: oklch(18.2% .004 264.459); --tip-fg: oklch(96.4% .002 247.839); --tip-muted: oklch(73.1% .008 260.731); --tip-border: oklch(30.8% .006 258.354);
  --shadow-hairline: 0 0 0 1px var(--border);
  --shadow-btn: 0 0 0 1px oklch(100% 0 0/.1), 0 1px 2px oklch(0% 0 0/.3);
  --shadow-card: 0 0 0 1px oklch(100% 0 0/.11), 0 1px 2px oklch(0% 0 0/.2), 0 2px 6px oklch(0% 0 0/.2);
  --shadow-raised: 0 0 0 1px oklch(100% 0 0/.13), 0 2px 10px oklch(0% 0 0/.22);
  --shadow-overlay: 0 0 0 1px oklch(100% 0 0/.15), 0 8px 28px oklch(0% 0 0/.34);
  --shadow-field: inset 0 1px 2px oklch(0% 0 0/.4);
}
.ui { pointer-events: auto; cursor: default; }

/* buttons + tooltips */
.b { all: unset; box-sizing: border-box; position: relative; height: 32px; min-width: 32px; padding: 0 8px; display: inline-flex; align-items: center; justify-content: center; gap: 6px; border-radius: 8px; color: var(--text-muted); cursor: pointer; font: inherit; }
.b:hover { background: var(--hover); color: var(--text); }
.b.tg { background: var(--hover-2); color: var(--text); }
.b.on, .b.on:hover { background: var(--bg-hover-2); color: var(--text); }
.b:disabled { opacity: .35; pointer-events: none; }
.b:focus-visible { box-shadow: 0 0 0 2px var(--primary); }
.b.sm { height: 28px; min-width: 28px; padding: 0 6px; border-radius: 6px; }
.b.xs { height: 22px; min-width: 22px; padding: 0; border-radius: 6px; }
[data-tip] { position: relative; }
[data-tip]:hover::after {
  content: attr(data-tip); position: absolute; z-index: 10; bottom: calc(100% + 8px); left: 50%; transform: translateX(-50%);
  padding: 4px 8px; border-radius: 6px; background: var(--tip-bg); color: var(--tip-fg);
  box-shadow: 0 0 0 1px var(--tip-border), 0 4px 12px oklch(0% 0 0/.2);
  font-size: 11px; line-height: 14px; font-weight: 500; white-space: nowrap; pointer-events: none;
  animation: tip .12s .35s both;
}
.ih [data-tip]:hover::after, .rtile[data-tip]:hover::after, .addr [data-tip]:hover::after, .tabsrow [data-tip]:hover::after,
.toolrow [data-tip]:hover::after, .brand [data-tip]:hover::after, .shd [data-tip]:hover::after, .dsbar [data-tip]:hover::after { bottom: auto; top: calc(100% + 6px); }
.foot [data-tip]:hover::after, .ih [data-tip]:hover::after, .launch:hover::after, .sidefoot [data-tip]:hover::after,
.addr .grp:last-child [data-tip]:hover::after, .zoomctl [data-tip]:hover::after, .brand [data-tip]:hover::after { left: auto; right: 0; transform: none; }
.addr > [data-tip]:first-child:hover::after { left: 0; transform: none; }
.rtile[data-tip]:hover::after { white-space: normal; width: 150px; text-align: center; }
.corner[data-tip]:hover::after { bottom: auto; top: calc(100% + 6px); left: 0; transform: none; }
@keyframes tip { from { opacity: 0; } }

.launch { all: unset; position: absolute; right: 16px; bottom: 16px; width: 40px; height: 40px; border-radius: 12px; display: grid; place-items: center; background: var(--surface); color: var(--text); box-shadow: var(--shadow-raised); cursor: pointer; }
.launch:hover { box-shadow: var(--shadow-raised), 0 0 0 2px var(--border-strong); }
.stbar { margin: 2px 0 10px; }
.ez { display: grid; gap: 8px; margin-bottom: 4px; }
.ezsvg { display: block; width: 100%; height: auto; border-radius: 8px; background: var(--input); box-shadow: var(--shadow-inset-field); touch-action: none; }
.ezbox { fill: none; stroke: var(--border-soft); }
.ezref { stroke: var(--border-strong); stroke-dasharray: 3 3; }
.ezarm { stroke: var(--text-x); }
.ezcurve { fill: none; stroke: var(--primary); stroke-width: 2; stroke-linecap: round; }
.ezh { fill: var(--surface); stroke: var(--primary); stroke-width: 1.5; cursor: grab; transition: r .12s cubic-bezier(0.2, 0, 0, 1); }
.ezh:hover, .ezh:active { r: 6.5px; }
.ezchips { display: flex; flex-wrap: wrap; gap: 4px; }
.ezchip { all: unset; height: 22px; padding: 0 8px; border-radius: 6px; font-size: 11px; line-height: 22px; color: var(--text-muted); box-shadow: inset 0 0 0 1px var(--border); cursor: pointer; transition: background-color .12s, color .12s, box-shadow .12s; }
.ezchip:hover { background: var(--bg-hover); color: var(--text); }
.ezchip.on { color: var(--text); box-shadow: inset 0 0 0 1px var(--text); }
.eztrack { position: relative; height: 18px; border-radius: 9px; background: var(--input); box-shadow: var(--shadow-inset-field); container-type: inline-size; }
.ezdot { position: absolute; left: 3px; top: 3px; width: 12px; height: 12px; border-radius: 50%; background: var(--primary); animation: ezgo var(--ezd, 600ms) var(--ez, ease) infinite alternate; }
@keyframes ezgo { to { translate: calc(100cqw - 18px) 0; } }
@media (prefers-reduced-motion: reduce) { .ezdot { animation: none; } }
.playrow { display: grid; grid-template-columns: repeat(3, 1fr); gap: 4px; }
.playrow .b { box-shadow: inset 0 0 0 1px var(--border); font-size: 11.5px; gap: 5px; transition: scale .12s cubic-bezier(0.2, 0, 0, 1), background-color .12s; }
.playrow .b:active:not(:disabled) { scale: 0.96; }
.playrow .b:disabled { opacity: .45; cursor: default; }
.mstate + .mstate { margin-top: 6px; }
.mlabel { font-weight: 400; color: var(--text-x); text-transform: none; letter-spacing: 0; }
.mease { margin: 2px 0 6px; }
.spring { display: grid; gap: 4px; margin: 6px 0 8px; }
.spring span { font-size: 11px; color: var(--text-muted); font-variant-numeric: tabular-nums; }
.linkb { all: unset; display: block; margin: 2px 0 6px; font-size: 11px; color: var(--primary); cursor: pointer; }
.linkb:hover { text-decoration: underline; }
.sb > .sec { margin: 0 -12px; }
.sb > .sec:last-child { border-bottom: 0; }
.anim { padding: 6px 0; }
.anim + .anim { border-top: 1px solid var(--border-soft); }
.animh { display: flex; align-items: center; gap: 6px; }
.animh b { font-size: 12px; font-weight: 600; color: var(--text); }
.sys { font-size: 10px; line-height: 16px; padding: 0 6px; border-radius: 999px; color: var(--text-muted); box-shadow: inset 0 0 0 1px var(--border); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; max-width: 120px; }
.sys.motion { color: oklch(58% .17 350); box-shadow: inset 0 0 0 1px oklch(58% .17 350 / .35); }
.sys.tailwind { color: oklch(58% .12 215); box-shadow: inset 0 0 0 1px oklch(58% .12 215 / .35); }
.animd { margin: 3px 0 0; font-size: 11.5px; line-height: 1.4; color: var(--text-muted); }
.animn { margin: 3px 0 0; font-size: 10.5px; line-height: 1.4; color: oklch(64% .14 70); }
.animnew { justify-self: start; box-shadow: inset 0 0 0 1px var(--border); gap: 5px; }
.pmenu { display: grid; grid-template-columns: 1fr 1fr; gap: 4px; }
.preset.saved { position: relative; padding-right: 22px; }
.preset.saved .b { position: absolute; top: 4px; right: 4px; height: 16px; min-width: 16px; }
.trigs { display: flex; flex-wrap: wrap; gap: 4px; }
.framebar { display: flex; align-items: center; gap: 6px; min-height: 26px; }
.framebar b { font-size: 11.5px; font-weight: 600; color: var(--text); }
.framebar .num { width: 72px; flex: none; }
.bldbar { display: flex; gap: 4px; }
.bldbar .b { flex: 1; gap: 5px; box-shadow: inset 0 0 0 1px var(--border); transition: scale .12s cubic-bezier(0.2, 0, 0, 1), background-color .12s; }
.bldbar .b:active:not(:disabled) { scale: 0.96; }
.bldbar .save { background: var(--primary); color: var(--on-primary); font-weight: 600; box-shadow: none; }
.bldbar .save:hover { background: var(--primary); color: var(--on-primary); filter: brightness(1.05); }
.bldbar .danger { color: oklch(60% .2 25); box-shadow: inset 0 0 0 1px oklch(60% .2 25 / .5); }
.bldbar.soft .kv { flex: 2; }
.kftrack { position: relative; height: 22px; margin: 2px 7px 8px; border-radius: 6px; background: linear-gradient(var(--border), var(--border)) center / 100% 1px no-repeat; }
.kfd { all: unset; position: absolute; top: 50%; width: 10px; height: 10px; translate: -50% -50%; rotate: 45deg; border-radius: 2px; background: var(--surface); box-shadow: inset 0 0 0 1.5px var(--text-muted); cursor: pointer; transition: background-color .12s, box-shadow .12s; }
.kfd:hover { box-shadow: inset 0 0 0 1.5px var(--text); }
.kfd.on { background: var(--primary); box-shadow: none; }
.kfadd { margin-top: 6px; }
.kfadd .k { font-size: 11px; color: var(--text-muted); }
.presets { display: grid; grid-template-columns: 1fr 1fr; gap: 4px; margin: 8px 0; }
.preset { all: unset; display: grid; gap: 1px; padding: 7px 8px; border-radius: 8px; box-shadow: inset 0 0 0 1px var(--border); cursor: pointer; transition: background-color .12s, box-shadow .12s, scale .12s cubic-bezier(0.2, 0, 0, 1); }
.preset:hover { background: var(--bg-hover); }
.preset:active { scale: 0.96; }
.preset.on { box-shadow: inset 0 0 0 1.5px var(--primary); }
.preset b { font-size: 12px; font-weight: 600; color: var(--text); }
.preset span { font-size: 10.5px; color: var(--text-muted); }
.pcode { margin: 0 0 6px; padding: 8px; border-radius: 8px; background: var(--input); box-shadow: var(--shadow-inset-field); font-family: var(--mono); font-size: 10.5px; line-height: 1.5; white-space: pre-wrap; overflow-wrap: anywhere; color: var(--text); }
.addanim { width: 100%; justify-content: center; margin-top: 2px; background: var(--primary); color: var(--on-primary); font-weight: 600; }
.addanim:hover { background: var(--primary); color: var(--on-primary); filter: brightness(1.05); }
.kf { display: grid; gap: 3px; margin: 2px 0 8px; font-family: var(--mono); font-size: 10.5px; color: var(--text-muted); }
.kf div { display: flex; gap: 8px; min-width: 0; }
.kf b { flex: none; min-width: 36px; color: var(--text); font-weight: 500; }
.kf span { overflow-wrap: anywhere; }
.tl { position: absolute; display: flex; flex-direction: column; container-type: inline-size; pointer-events: auto; cursor: default; background: var(--surface); box-shadow: 0 -1px 0 var(--border), 0 -8px 24px oklch(0% 0 0 / .06); font-variant-numeric: tabular-nums; animation: tlin .2s cubic-bezier(0.2, 0, 0, 1) both; }
@keyframes tlin { from { opacity: 0; translate: 0 8px; } }
@media (prefers-reduced-motion: reduce) { .tl { animation: none; } }
.tlh { flex: none; display: flex; align-items: center; gap: 6px; height: 40px; padding: 0 8px 0 12px; border-bottom: 1px solid var(--border-soft); color: var(--text-muted); }
.tlh b { color: var(--text); font-weight: 600; }
.tlh .seg { flex: none; width: 168px; }
.tlgroups { display: flex; gap: 3px; margin-left: 8px; overflow: hidden; }
.tlg { all: unset; box-sizing: border-box; min-width: 20px; height: 20px; padding: 0 5px; border-radius: 6px; font-size: 10.5px; line-height: 20px; text-align: center; color: var(--text-muted); box-shadow: inset 0 0 0 1px var(--border); cursor: pointer; transition: background-color .12s, color .12s; }
.tlg:hover { background: var(--bg-hover); color: var(--text); }
.tlg.on { background: var(--primary); color: var(--on-primary); box-shadow: none; }
.tlbody { flex: 1; overflow: auto; padding: 0 12px 8px; }
.tlrow { display: grid; grid-template-columns: 200px minmax(0, 1fr) 52px; align-items: center; gap: 10px; height: 24px; padding: 0 4px; border-radius: 6px; }
.tlrow[role=button] { cursor: pointer; }
.tlrow[role=button]:hover { background: var(--bg-hover); }
.tlaxis { position: sticky; top: 0; z-index: 1; height: 24px; background: var(--surface); }
.tlaxis .tltrack span { position: absolute; top: 4px; padding-left: 3px; border-left: 1px solid var(--border); font-size: 10px; line-height: 14px; color: var(--text-x); white-space: nowrap; }
.tln { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-size: 11px; color: var(--text-muted); }
.tln b { color: var(--text); font-weight: 600; }
.tltrack { position: relative; height: 10px; }
.tlbar { position: absolute; top: 0; height: 10px; border-radius: 3px; background: var(--primary); }
.tlbar.keyframes { background: oklch(62% .19 300); }
.tlbar.script { background: oklch(64% .13 190); }
.tlbar.motion { background: oklch(66% .17 350); }
.tlbar.inf { mask-image: linear-gradient(90deg, #000 75%, transparent); }
.tlhead { position: absolute; top: -3px; width: 2px; height: 16px; margin-left: -1px; border-radius: 1px; background: var(--text); }
.tld { font-size: 10.5px; color: var(--text-x); text-align: right; }
.tlh { overflow: hidden; }
@container (max-width: 560px) {
  .tlh > svg:first-child, .tlh > b, .tlgroups, .tlh > svg:nth-of-type(2) { display: none; }
  .tlh { gap: 4px; padding-left: 8px; }
  .tlh .seg { width: 120px; }
  .tlrow { grid-template-columns: 40% minmax(0, 1fr) 40px; gap: 6px; }
}
.ck { display: flex; align-items: center; gap: 7px; padding: 5px 0; font-size: 11.5px; line-height: 1.35; color: var(--text-muted); }
.ck + .ck { border-top: 1px solid var(--border-soft); }
.ck > svg { flex: none; }
.ck.error > svg { color: oklch(62% .21 25); }
.ck.warn > svg { color: oklch(74% .16 75); }
.ck.ok .ckmsg b { color: oklch(56% .15 150); }
.ck.error .ckmsg > b:first-child { color: oklch(58% .21 25); }
.ckmsg { flex: 1; min-width: 0; overflow-wrap: anywhere; }
.ckmsg em { font-style: normal; color: var(--text-x); }
.ckmsg[role=button] { cursor: pointer; }
.ckmsg[role=button]:hover { color: var(--text); }
.ckfix { flex: none; max-width: 112px; padding: 0 7px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-family: var(--mono); font-size: 10.5px; color: var(--primary); box-shadow: inset 0 0 0 1px var(--border); }
.ckfix:hover { background: var(--bg-hover); }
.ckswatch { flex: none; width: 28px; height: 20px; border-radius: 5px; display: grid; place-items: center; font-weight: 700; font-size: 11px; box-shadow: inset 0 0 0 1px var(--border); }
.pb .sec .ck:first-child { padding-top: 0; }
.scut { margin-top: 6px; padding-top: 8px; border-top: 1px solid var(--border-soft); }
.scut .pc { gap: 4px; }
.kbtn { flex: 1; min-width: 0; font-family: var(--mono); justify-content: center; }
.stnote { margin: 6px 2px 0; font-size: 11px; line-height: 1.4; color: var(--text-muted); }
.stnote code, .empty code { font-family: var(--mono); color: var(--text); }
.pstate { margin-left: 3px; opacity: .8; }
.pval { min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-size: 11px; color: var(--text-muted); }
.launch-dot { position: absolute; top: 4px; right: 4px; width: 9px; height: 9px; border-radius: 50%; background: oklch(62% .2 300); box-shadow: 0 0 0 2px var(--surface); }
.mark { position: relative; display: grid; padding: 0 2px; }

/* stage */
.stage { position: absolute; inset: 0; overflow: visible; }
/* apply to code */
.srclink { all: unset; width: 100%; display: flex; align-items: center; gap: 5px; margin-top: 2px; color: var(--text-muted); font: 500 11px var(--mono); cursor: pointer; position: relative; }
.srclink:hover { color: var(--text); }
.citem { padding: 12px; display: grid; gap: 6px; border-bottom: 1px solid var(--border-soft); }
.chead { display: flex; align-items: center; gap: 6px; }
.chead b { font-weight: 600; }
.chead .sp { flex: 1; }
.clink { all: unset; position: relative; color: var(--text-muted); font: 500 11px var(--mono); cursor: pointer; }
.clink:hover { color: var(--text); }
.cvar { position: relative; padding: 0 5px; border-radius: 4px; background: oklch(58% .2 300 / .15); color: oklch(52% .2 300); font: 600 10px/16px var(--mono); }
.cdiff { display: flex; flex-wrap: wrap; gap: 4px; }
.cdiff code { padding: 1px 6px; border-radius: 4px; font: 500 11px/18px var(--mono); }
.cdiff .keep { background: var(--input); color: var(--text-muted); }
.cdiff .add { background: oklch(62% .17 150 / .14); color: oklch(48% .15 150); }
.cdiff .del { background: oklch(60% .22 25 / .12); color: oklch(52% .2 25); text-decoration: line-through; }
.cmap { display: flex; justify-content: space-between; gap: 8px; font-size: 11px; color: var(--text-muted); }
.cmap code { color: var(--text); font: 500 11px var(--mono); }
.cskip { font-size: 11px; color: var(--text-x); }
.cwarn, .cerr, .cnote2 { margin: 0; font-size: 11px; line-height: 15px; }
.cwarn { color: oklch(62% .15 75); } .cerr { color: oklch(56% .2 25); } .cnote2 { color: var(--text-x); }
.cdiscard { justify-self: start; margin-top: 2px; }
.cnote { margin: 12px; padding: 12px; display: grid; gap: 8px; border-radius: 8px; background: var(--input); }
.cnote p { margin: 0; color: var(--text-muted); line-height: 17px; }
.cnote pre { margin: 0; padding: 8px 10px; border-radius: 6px; background: var(--surface); font: 500 11px/16px var(--mono); white-space: pre-wrap; }
.foot .apply { background: var(--primary); color: var(--on-primary); padding: 0 10px; font-weight: 600; }
.foot .apply:hover { background: var(--primary); color: var(--on-primary); filter: brightness(1.05); }

/* anatomy */
.stage .an-dim { fill: oklch(0% 0 0 / .52); }
.stage .an-bg.pad { fill: color-mix(in oklch, var(--primary) 16%, transparent); } .stage .an-ln.pad { stroke: var(--primary); }
.stage .an-bg.mar { fill: oklch(80% .15 85 / .18); } .stage .an-ln.mar { stroke: oklch(74% .16 80); }
.stage .an-bg.gap { fill: oklch(65% .2 300 / .16); } .stage .an-ln.gap { stroke: oklch(62% .2 300); }
.stage .an-ln { stroke-width: 1.4; }
.stage .an-box { fill: none; stroke: var(--primary); stroke-width: 1.5; }
.stage .an-content { fill: none; stroke: #fff; stroke-width: 1; stroke-dasharray: 3 3; mix-blend-mode: difference; }
.stage .an-kid { fill: none; stroke: oklch(100% 0 0 / .45); stroke-width: 1; }
.an-pill { position: absolute; transform: translate(-50%, -50%); padding: 1px 5px; border-radius: 4px; font: 600 10px/13px var(--mono); color: #fff; pointer-events: none; box-shadow: 0 1px 3px oklch(0% 0 0 / .3); }
.an-pill.pad { background: var(--primary); } .an-pill.mar { background: oklch(70% .16 75); } .an-pill.gap { background: oklch(58% .2 300); }
.an-head { position: absolute; transform: translateY(-100%); display: flex; align-items: center; gap: 8px; padding: 4px 8px; border-radius: 7px; background: var(--tip-bg); color: var(--tip-fg); box-shadow: 0 0 0 1px var(--tip-border), 0 6px 18px oklch(0% 0 0 / .3); font-size: 11px; white-space: nowrap; pointer-events: none; }
.an-head span { color: var(--tip-muted); font-family: var(--mono); }
.an-head i { font-style: normal; display: inline-flex; align-items: center; gap: 4px; color: var(--tip-muted); }
.an-head i::before { content: ""; width: 8px; height: 8px; border-radius: 2px; }
.an-head i.pad::before { background: var(--primary); } .an-head i.mar::before { background: oklch(74% .16 80); } .an-head i.gap::before { background: oklch(62% .2 300); }

/* hover = dashed, selection = solid; the hover outline morphs between elements with a slight overshoot */
.stage .hov { transition: x .32s var(--goo), y .32s var(--goo), width .32s var(--goo), height .32s var(--goo), opacity .18s; }
.stage .hov.off { opacity: 0; }
.htip { transition: left .32s var(--goo), top .32s var(--goo); }
@media (prefers-reduced-motion: reduce) { .stage .hov, .htip { transition: none; } }
.stage .hov { fill: color-mix(in oklch, var(--primary) 9%, transparent); stroke: var(--primary); stroke-width: 1.25; stroke-dasharray: 4 3; }
.stage .hov.dash { fill: none; } /* the Alt-measure target stays an outline */
.stage .selr { fill: none; stroke: var(--primary); stroke-width: 1.5; }
.stage .mg { fill: oklch(82% .14 85 / .22); }
.stage .pd { fill: oklch(75% .14 150 / .2); }
.stage .ml { stroke: var(--primary); stroke-width: 1; }
.stage .ink { fill: none; stroke: var(--primary); stroke-linecap: round; stroke-linejoin: round; }
.pill { position: absolute; padding: 2px 5px; border-radius: 4px; background: var(--primary); color: var(--on-primary); font-size: 10px; line-height: 12px; font-weight: 600; white-space: nowrap; pointer-events: none; }
.pill.ghost { background: var(--surface); color: var(--primary); box-shadow: var(--shadow-btn); }
.hd { position: absolute; width: 8px; height: 8px; margin: -4px 0 0 -4px; background: #fff; border: 1.5px solid var(--primary); border-radius: 2px; pointer-events: auto; }
.hd.e, .hd.w { cursor: ew-resize; } .hd.n, .hd.s { cursor: ns-resize; } .hd.nw, .hd.se { cursor: nwse-resize; } .hd.ne, .hd.sw { cursor: nesw-resize; }
.stage .snap { stroke: oklch(63% .24 15); stroke-width: 1; }
.stage .pe-line { fill: none; stroke: var(--primary); stroke-width: 1.5; }
.stage .pe-hit { fill: none; stroke: transparent; stroke-width: 10; pointer-events: stroke; cursor: copy; }
.stage .pe-a { fill: var(--surface); stroke: var(--primary); stroke-width: 1.5; pointer-events: all; cursor: move; }
.stage .pe-a.on, .stage .pe-a.first:hover { fill: var(--primary); }
.stage .pe-h { stroke: var(--primary); stroke-width: 1; }
.stage .pe-hd { fill: #fff; stroke: var(--primary); stroke-width: 1.5; pointer-events: all; cursor: move; }
.stage .rubber { stroke: var(--primary); stroke-width: 1; stroke-dasharray: 4 3; }
.stage .flash-dom { fill: oklch(70% .2 300 / .12); stroke: oklch(62% .22 300); stroke-width: 1.5; }
.stage .flash-shift { fill: oklch(65% .22 25 / .15); stroke: oklch(60% .22 25); stroke-width: 1.5; }
.banner.xr .ramp { display: flex; }
.banner.xr .ramp i { width: 10px; height: 12px; }
.banner.xr .ramp i:first-child { border-radius: 3px 0 0 3px; } .banner.xr .ramp i:last-child { border-radius: 0 3px 3px 0; }
.banners { position: absolute; transform: translateX(-50%); display: grid; justify-items: center; gap: 6px; }
.banner { height: 36px; display: flex; align-items: center; gap: 8px; padding: 0 4px 0 12px; border-radius: 10px; background: var(--surface); box-shadow: var(--shadow-raised); white-space: nowrap; }
.banner svg { color: var(--text-muted); }
.banner b { font-weight: 600; }
.banner span { color: var(--text-muted); }
.banner .b { color: var(--text); background: var(--hover-2); font-weight: 600; }
.cvb { font-weight: 600; padding: 0 10px 0 8px; }
@media (max-width: 1100px) { .banner span:not(.ramp) { display: none; } }

/* guides */
.gd { position: absolute; pointer-events: auto; }
.gd.x { top: 0; bottom: 0; width: 7px; margin-left: -3px; cursor: ew-resize; }
.gd.y { left: 0; right: 0; height: 7px; margin-top: -3px; cursor: ns-resize; }
.gd::before { content: ""; position: absolute; }
.gd.x::before { left: 3px; top: 0; bottom: 0; border-left: 1px var(--gp, solid) var(--gc, var(--primary)); }
.gd.y::before { top: 3px; left: 0; right: 0; border-top: 1px var(--gp, solid) var(--gc, var(--primary)); }
.gd.on.x::before { border-left-width: 2px; left: 2.5px; }
.gd.on.y::before { border-top-width: 2px; top: 2.5px; }
.gd.lock { cursor: default; }

/* rulers */
.ruler { position: absolute; left: 0; top: 0; background: var(--canvas); pointer-events: auto; }
.rh { box-shadow: inset 0 -1px var(--border-strong); cursor: ns-resize; }
.rv { box-shadow: inset -1px 0 var(--border-strong); cursor: ew-resize; }
.ruler line { stroke: var(--text-x); stroke-width: 1; }
.ruler text { fill: var(--text-muted); font-size: 9px; font-weight: 500; user-select: none; }
.ruler .hi { fill: var(--primary-soft); }
.ruler .mk { stroke-width: 2; }
.corner { position: absolute; left: 0; top: 0; width: ${RULER}px; height: ${RULER}px; display: grid; place-items: center; background: var(--canvas); color: var(--text-x); box-shadow: inset -1px -1px var(--border-strong); cursor: pointer; }
.corner:hover { color: var(--text); }

/* docked chrome: address bar, tabs, toolbar, sidebars */
.addr { position: absolute; left: 0; right: 0; top: 0; height: 40px; display: flex; align-items: center; gap: 4px; padding: 0 8px; background: var(--surface); border-bottom: 1px solid var(--border); }
.addr .b.xs, .tabsrow .b.xs { height: 28px; min-width: 28px; }
.addr > .b:first-child { color: var(--text-muted); }
.url { all: unset; box-sizing: border-box; flex: 1; min-width: 0; height: 28px; padding: 0 10px; border-radius: 6px; font: 500 12px/28px var(--mono); color: var(--text); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.url:hover { background: var(--hover); }
.url:focus { background: var(--input); box-shadow: inset 0 0 0 1px var(--border-strong); }
.grp { display: flex; gap: 2px; margin-left: 6px; padding-left: 8px; border-left: 1px solid var(--border); }
.tabsrow { position: absolute; height: 36px; display: flex; align-items: center; gap: 4px; padding: 0 8px; background: var(--surface); border-bottom: 1px solid var(--border-soft); }
.tabsrow .sp, .toolrow .sp { flex: 1; }
.ptab { all: unset; box-sizing: border-box; max-width: 220px; height: 28px; padding: 0 6px 0 10px; display: inline-flex; align-items: center; gap: 7px; border-radius: 7px; color: var(--text-muted); font-weight: 500; white-space: nowrap; cursor: pointer; }
.ptab:hover { background: var(--hover); color: var(--text); }
.ptab.on { background: var(--hover-2); color: var(--text); }
.ptab > svg { color: var(--text-muted); }
.ptab .x { display: grid; place-items: center; width: 18px; height: 18px; border-radius: 4px; color: var(--text-x); }
.ptab .x:hover { background: var(--border-strong); color: var(--text); }
.zoomctl { display: flex; align-items: center; gap: 2px; }
.zoomctl .zl { min-width: 54px; font-variant-numeric: tabular-nums; }
.fitb { padding: 0 8px !important; font-weight: 600; }
.toolrow { position: absolute; height: 40px; display: flex; align-items: center; gap: 2px; padding: 0 8px; background: var(--surface); border-bottom: 1px solid var(--border); }
.toolrow .b { height: 30px; min-width: 30px; padding: 0 6px; }
.sep { width: 1px; height: 18px; margin: 0 5px; background: var(--border); flex: none; }
.fav { flex: none; width: 15px; height: 15px; border-radius: 3px; object-fit: contain; }
.side { position: absolute; bottom: 0; display: flex; flex-direction: column; background: var(--surface); overflow: hidden; }
.side.left { left: 0; border-right: 1px solid var(--border); }
.side.right { right: 0; border-left: 1px solid var(--border); }
.brand { flex: none; height: 48px; display: flex; align-items: center; gap: 8px; padding: 0 8px 0 14px; border-bottom: 1px solid var(--border-soft); }
.brand b { min-width: 0; font-size: 13px; font-weight: 700; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.brand .sp { flex: 1; }
.sgroup { display: flex; flex-direction: column; min-height: 0; border-bottom: 1px solid var(--border-soft); }
.sgroup.grow { flex: 1; }
.shd { flex: none; height: 38px; padding: 0 10px 0 14px; display: flex; align-items: center; gap: 6px; color: var(--text); font-size: 13px; font-weight: 700; cursor: pointer; user-select: none; }
.shd .n { color: var(--text-x); font-size: 12px; font-weight: 500; }
.shd i { flex: 1; }
.shd .chev { display: grid; color: var(--text-x); transition: transform .15s; }
.shd.shut .chev { transform: rotate(-90deg); }
.pages { max-height: 220px; overflow: auto; padding: 0 8px 8px; }
.pg { all: unset; box-sizing: border-box; width: 100%; height: 30px; padding: 0 10px; display: flex; align-items: center; gap: 8px; border-radius: 8px; color: var(--text); white-space: nowrap; cursor: pointer; }
.pg:hover { background: var(--hover); }
.pg svg { flex: none; color: var(--text-x); }
.pg small { max-width: 45%; overflow: hidden; text-overflow: ellipsis; color: var(--text-x); font: 500 11px var(--mono); }
.pg.on { background: var(--bg-hover-2); color: var(--text); }
.pg.on svg, .pg.on small { color: inherit; opacity: .85; }
.pg.dyn { opacity: .55; cursor: default; }
.sidefoot { flex: none; height: 48px; display: flex; align-items: center; gap: 6px; padding: 0 8px 0 10px; border-top: 1px solid var(--border-soft); }
.search { flex: 1; }
.search svg { flex: none; margin-left: 9px; color: var(--text-x); }
.search input { padding-left: 7px !important; }
.side.left .menu { top: auto; bottom: 56px; left: 8px; right: 8px; width: auto; }
.empty.pad { padding: 8px 14px; }
.ph { flex: none; height: 40px; display: flex; align-items: center; gap: 8px; padding: 0 12px; font-weight: 600; color: var(--text); border-bottom: 1px solid var(--border); }
.ph svg { color: var(--text-x); }
.pb { flex: 1; min-height: 0; overflow: auto; overscroll-behavior: contain; }
.pb::-webkit-scrollbar { width: 10px; }
.pb::-webkit-scrollbar-thumb { background: var(--border-strong); border-radius: 10px; border: 3px solid var(--surface); }
.foot { flex: none; height: 44px; display: flex; align-items: center; gap: 2px; padding: 0 8px 0 12px; border-top: 1px solid var(--border); color: var(--text-muted); }
.foot span { flex: 1; }
.ih b { font-size: 14px; font-weight: 700; }
.ih .sp { flex: 1; }
.tabbar { flex: none; padding: 10px 12px; border-bottom: 1px solid var(--border-soft); }

/* layer tree */
.tree { padding: 4px 0; }
.row { height: 28px; display: flex; align-items: center; gap: 6px; padding-right: 10px; white-space: nowrap; color: var(--text); }
.row:hover { background: var(--hover); }
.row.on, .row.on:hover { background: var(--bg-hover-2); color: var(--text); }
.row.on .ic, .row.on .cv, .row.on .sub, .row.on.comp .ic, .row.on.comp .nm { color: inherit; }
.row.on .sub { opacity: .75; }
.cv { flex: none; width: 12px; height: 12px; display: grid; place-items: center; color: var(--text-x); cursor: pointer; transition: transform .12s; }
.cv.open { transform: rotate(90deg); }
.ic { flex: none; display: grid; color: var(--text-x); }
.row.comp .ic, .row.comp .nm { color: var(--text); }
.nm { flex: 0 1 auto; min-width: 0; overflow: hidden; text-overflow: ellipsis; }
.sub { flex: 0 1000 auto; min-width: 0; overflow: hidden; text-overflow: ellipsis; color: var(--text-x); }

/* inspector */
.sec { border-bottom: 1px solid var(--border-soft); }
.sh { all: unset; box-sizing: border-box; width: 100%; height: 38px; padding: 0 12px; display: flex; align-items: center; gap: 6px; cursor: pointer; font-size: 11px; font-weight: 600; letter-spacing: .07em; text-transform: uppercase; color: var(--text-x); }
.sh:hover { color: var(--text-muted); }
.sh i { flex: 1; }
.sh svg { transition: transform .15s; }
.sh.shut svg { transform: rotate(-90deg); }
.sh .n { letter-spacing: 0; font-weight: 500; }
.sb { padding: 0 12px 14px; display: grid; gap: 8px; }
.lbl { font-size: 12px; font-weight: 600; color: var(--text); margin: 2px 0 -2px; }
.prow { display: grid; grid-template-columns: 80px 1fr; align-items: center; gap: 8px; min-height: 30px; }
.pl { color: var(--text); }
.pc { min-width: 0; display: flex; align-items: center; gap: 6px; }
.pc > * { flex: 1; min-width: 0; }
.pc > .b, .pc > .sw { flex: none; }
.pc .rv { text-align: right; color: var(--text-muted); font: 500 12px var(--mono); }
.range { flex: 1.4 !important; accent-color: var(--text); }
.hint { margin: 2px 0 0; color: var(--text-x); font-size: 11px; line-height: 17px; }
.hint kbd { font-size: 10px; padding: 0 4px; }
.g2 { display: grid; grid-template-columns: 1fr 1fr; gap: 6px; }

/* segmented controls, breadcrumbs, checkboxes */
.seg { display: flex; gap: 2px; padding: 2px; border-radius: 8px; background: var(--input); box-shadow: var(--shadow-field); }
.seg button { all: unset; flex: 1; min-width: 0; height: 26px; padding: 0 6px; display: grid; place-items: center; border-radius: 6px; color: var(--text-muted); font-size: 12px; white-space: nowrap; cursor: pointer; }
.seg button:hover { color: var(--text); }
.seg button.on { background: var(--surface); color: var(--text); box-shadow: var(--shadow-btn); }
.seg.big { padding: 3px; border-radius: 10px; }
.seg.big button { height: 30px; border-radius: 8px; font-size: 13px; font-weight: 600; }
.seg.big button.on { background: var(--surface); color: var(--text); box-shadow: var(--shadow-btn); }
.crumbs { display: flex; flex-wrap: wrap; align-items: center; gap: 4px; padding: 10px 12px; border-bottom: 1px solid var(--border-soft); color: var(--text-x); }
.crumb { all: unset; max-width: 150px; height: 22px; padding: 0 7px; display: inline-flex; align-items: center; border-radius: 6px; background: var(--input); color: var(--text-muted); font: 500 11px/22px var(--mono); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; cursor: pointer; }
.crumb:hover { color: var(--text); }
.crumb.on { background: var(--bg-hover-2); color: var(--text); }
.compname { width: 100%; display: flex; align-items: center; gap: 6px; margin-top: 4px; color: var(--text); font-weight: 600; }
.check { display: flex; align-items: center; gap: 8px; min-height: 28px; color: var(--text); cursor: pointer; }
.check input { display: none; }
.check .cb { flex: none; width: 16px; height: 16px; display: grid; place-items: center; border-radius: 4px; background: var(--input); box-shadow: inset 0 0 0 1px var(--border-strong); color: transparent; }
.check input:checked + .cb { background: var(--text); box-shadow: none; color: var(--bg); }
.wide { all: unset; box-sizing: border-box; width: 100%; height: 34px; display: flex; align-items: center; justify-content: center; gap: 8px; border-radius: 8px; background: var(--input); color: var(--text); font-weight: 600; cursor: pointer; }
.wide:hover { background: var(--hover-2); }
.wide.danger:hover { color: oklch(60% .2 25); }
.backdrop { position: absolute; inset: 0; z-index: 5; }
.menu { position: absolute; z-index: 6; top: 44px; right: 8px; width: 250px; padding: 10px 12px; display: grid; gap: 4px; border-radius: 10px; background: var(--surface); box-shadow: var(--shadow-overlay, var(--shadow-raised)); }

/* resizing tiles */
.tiles3 { display: grid; grid-template-columns: repeat(3, 1fr); gap: 8px; }
.rtile { display: grid; gap: 6px; justify-items: center; font-size: 11px; color: var(--text-muted); text-align: center; }
.rtile .box { width: 100%; height: 58px; display: grid; place-items: center; border-radius: 8px; background: var(--input); box-shadow: var(--shadow-field); }
.rtile.dis .box { opacity: .5; }
.rtile.dis .arm { cursor: default; }
.rtile.drag .box { cursor: ew-resize; touch-action: none; }
.rtile.drag .box:active { box-shadow: inset 0 0 0 1px var(--border-strong); }
.ill { width: 64px; height: 44px; overflow: visible; }
.ill path { fill: none; stroke: var(--text-x); stroke-width: 1.6; stroke-linecap: round; stroke-linejoin: round; }
.ill .arm { cursor: pointer; }
.ill .arm.on path:not(.hit) { stroke: var(--text); }
.ill .arm:hover path:not(.hit) { stroke: var(--text-muted); }
.ill .arm.on:hover path:not(.hit) { stroke: var(--text); opacity: .8; }
.ill .arm .hit { stroke: transparent; stroke-width: 12; }
.ill .core { fill: var(--surface); stroke: var(--text-x); stroke-width: 1.4; }
.ill .knob { fill: var(--text); }

/* prototype */
.ilist { display: grid; gap: 4px; }
.irow { display: flex; justify-content: space-between; gap: 8px; padding: 6px 8px; border-radius: 6px; background: var(--input); font: 500 11px var(--mono); }
.irow b { color: var(--text); font-weight: 600; }
.irow span { min-width: 0; overflow: hidden; text-overflow: ellipsis; color: var(--text-muted); }
.empty { margin: 0; color: var(--text-x); }

/* profiler */
.metric { padding: 12px; display: grid; gap: 6px; border-bottom: 1px solid var(--border-soft); }
.mh { display: flex; align-items: baseline; justify-content: space-between; gap: 8px; }
.mh span { font-size: 11px; font-weight: 600; letter-spacing: .07em; text-transform: uppercase; color: var(--text-x); }
.mh b { font-size: 18px; line-height: 22px; font-weight: 600; }
.mh b small { margin-left: 3px; font-size: 11px; font-weight: 500; color: var(--text-muted); }
.spark { display: block; width: 100%; height: 36px; border-radius: 6px; background: var(--input); }
.spark rect { fill: var(--text-muted); }
.spark rect.bad { fill: oklch(62% .22 25); }
.spark polyline { fill: none; stroke: var(--text-muted); stroke-width: 1.5; vector-effect: non-scaling-stroke; }
.spark line { stroke: var(--text-x); stroke-dasharray: 2 2; vector-effect: non-scaling-stroke; }
.msub { font-size: 11px; color: var(--text-muted); }
.mlist { display: grid; gap: 2px; font: 500 11px var(--mono); color: var(--text-muted); }
.mlist div { display: flex; justify-content: space-between; }
.good { color: oklch(62% .17 150); } .warn { color: oklch(70% .16 75); } .bad { color: oklch(60% .22 25); }
.mono { font-family: var(--mono) !important; font-size: 11px !important; }

/* fields */
.f { position: relative; display: flex; align-items: center; height: 30px; min-width: 0; border-radius: 6px; background: var(--input); box-shadow: var(--shadow-field); }
.f:hover { box-shadow: var(--shadow-field), inset 0 0 0 1px var(--border-strong); }
.f:focus-within { box-shadow: inset 0 0 0 1px var(--border-strong); }
.lb { flex: none; width: 26px; height: 100%; display: grid; place-items: center; color: var(--text-x); font-size: 11px; cursor: ew-resize; user-select: none; }
.f input, .f select { all: unset; box-sizing: border-box; flex: 1; min-width: 0; height: 100%; padding-right: 8px; font: inherit; color: var(--text); cursor: text; }
.f > input:first-child, .f > select:first-child { padding-left: 8px; }
.f input::placeholder { color: var(--text-x); }
.f input::selection { background: var(--primary-soft); }
.f.num input { padding-left: 10px; font-family: var(--mono); font-size: 12px; }
.sx { flex: none; height: 100%; padding: 0 9px 0 4px; display: grid; place-items: center; color: var(--text-x); font-size: 11px; cursor: ew-resize; user-select: none; }
.sx:hover { color: var(--text); }
.f select { cursor: pointer; padding-right: 22px; line-height: 30px; text-overflow: ellipsis; }
.f.sel > svg { position: absolute; right: 6px; color: var(--text-x); pointer-events: none; }
.sw { all: unset; box-sizing: border-box; position: relative; flex: none; width: 16px; height: 16px; margin: 0 8px; border-radius: 4px; overflow: hidden; cursor: pointer; background: repeating-conic-gradient(#ccc 0 25%, #fff 0 50%) 0 0/8px 8px; box-shadow: inset 0 0 0 1px oklch(0% 0 0/.12); }
.sw i { position: absolute; inset: 0; box-shadow: inset 0 0 0 1px oklch(0% 0 0/.12); border-radius: inherit; }
.sw.big { width: 44px; height: 26px; margin: 0; border-radius: 6px; }
button.sw:hover i { box-shadow: inset 0 0 0 1px oklch(0% 0 0/.12), 0 0 0 9px oklch(0% 0 0/.04) inset; }

/* responsive preview */
.resp { position: absolute; display: flex; flex-direction: column; pointer-events: auto; cursor: default; background-color: var(--canvas); background-image: radial-gradient(var(--border-strong) 1px, transparent 1px); background-size: 16px 16px; }
.resp.dragging iframe { pointer-events: none; }
.rbar { flex: none; height: 52px; display: flex; align-items: center; justify-content: center; gap: 8px; padding: 0 16px; }
.rbar .seg { flex: none; background: var(--surface); box-shadow: var(--shadow-btn); }
.rbar .seg button { display: inline-flex; align-items: center; justify-content: center; gap: 6px; padding: 0 10px; }
.rsize { display: flex; align-items: center; gap: 4px; color: var(--text-x); }
.rsize .f { width: 86px; background: var(--surface); box-shadow: var(--shadow-btn); }
.rscale { min-width: 40px; text-align: right; color: var(--text-muted); font: 500 12px var(--mono); }
.rstage { flex: 1; min-height: 0; display: flex; align-items: flex-start; justify-content: center; gap: 40px; padding: 0 48px 32px; overflow: auto; }
.rframe { flex: none; display: grid; gap: 8px; }
.rlabel { height: 16px; display: flex; align-items: center; gap: 6px; color: var(--text); font-size: 12px; white-space: nowrap; }
.rlabel svg { color: var(--text-muted); }
.rlabel b { font-weight: 600; }
.rlabel span { color: var(--text-x); font: 500 11px var(--mono); }
.rwrap { position: relative; }
.rbox { position: absolute; inset: 0; overflow: hidden; border-radius: 12px; background: #fff; box-shadow: var(--shadow-raised), 0 12px 32px oklch(0% 0 0/.12); }
.rbox iframe { display: block; border: 0; background: #fff; transform-origin: 0 0; }
.rh { position: absolute; display: grid; place-items: center; }
.rh::after { content: ""; border-radius: 3px; background: var(--border-strong); transition: background .12s; }
.rh:hover::after, .resp.dragging .rh::after { background: var(--primary); }
.rh.e { top: 0; bottom: 0; right: -18px; width: 14px; cursor: ew-resize; }
.rh.e::after { width: 4px; height: 40px; }
.rh.s { left: 0; right: 0; bottom: -18px; height: 14px; cursor: ns-resize; }
.rh.s::after { width: 40px; height: 4px; }
.rh.se { right: -18px; bottom: -18px; width: 14px; height: 14px; cursor: nwse-resize; }
.rh.se::after { width: 10px; height: 10px; }

/* colour picker */
.backdrop.fixed { position: fixed; z-index: 19; }
.cp { position: fixed; z-index: 20; width: 248px; padding: 12px; display: grid; grid-template-columns: minmax(0, 1fr); gap: 10px; border-radius: 12px; background: var(--surface); box-shadow: var(--shadow-overlay, var(--shadow-raised)), 0 0 0 1px var(--border); }
.cp-sv { position: relative; height: 156px; border-radius: 8px; cursor: crosshair; touch-action: none; box-shadow: inset 0 0 0 1px oklch(0% 0 0/.08); }
.cp-bar { position: relative; height: 12px; margin: 0 7px; border-radius: 6px; cursor: pointer; touch-action: none; box-shadow: inset 0 0 0 1px oklch(0% 0 0/.08); }
.cp-hue { background: linear-gradient(to right, #f00, #ff0, #0f0, #0ff, #00f, #f0f, #f00); }
.cp-alpha { background-size: 100% 100%, 8px 8px; }
.cp-thumb { position: absolute; width: 14px; height: 14px; margin: -7px 0 0 -7px; border-radius: 50%; border: 2px solid #fff; box-shadow: 0 0 0 1px oklch(0% 0 0/.35), 0 1px 3px oklch(0% 0 0/.3); pointer-events: none; }
.cp-bar .cp-thumb { top: 50%; }
/* fixed columns: dropper · swatch · hex (flexible) · alpha, so the row can never outgrow the popover */
.cp-row { display: grid; grid-template-columns: 28px 28px minmax(0, 1fr) 68px; align-items: center; gap: 6px; min-width: 0; }
.cp-row > * { min-width: 0; }
.cp-row .sw.big { width: 28px; height: 28px; border-radius: 7px; }
.cp-row .f input { width: 100%; text-transform: uppercase; }
.cp-row .b.sm { width: 28px; padding: 0; }
.cp-cap { font-size: 11px; font-weight: 600; color: var(--text-x); margin-bottom: -4px; }
.cp-sws { display: flex; flex-wrap: wrap; gap: 5px; }
.cp-sws button { all: unset; width: 20px; height: 20px; border-radius: 5px; cursor: pointer; box-shadow: inset 0 0 0 1px oklch(0% 0 0/.12); }
.cp-sws button:hover { box-shadow: 0 0 0 2px var(--surface), 0 0 0 3.5px var(--border-strong); }

/* canvas: artboard mask, hover tooltip, svg editor, toast */
.viewport { position: absolute; inset: 0; pointer-events: none; }
.mask { position: absolute; inset: 0; }
.mask .cvbg { fill: var(--canvas); }
.mask .dot { fill: var(--border-strong); }
.mask .gdot { fill: var(--primary); opacity: .35; }
.mask .abline { fill: none; stroke: var(--border-strong); }
.ablabel { position: absolute; transform: translateY(-100%); padding-bottom: 6px; color: var(--text-muted); font-size: 11px; white-space: nowrap; pointer-events: none; }
.htip { position: absolute; transform: translateY(-100%); display: flex; align-items: center; gap: 6px; padding: 3px 8px 3px 3px; border-radius: 6px; background: var(--tip-bg); color: var(--tip-muted); box-shadow: 0 0 0 1px var(--tip-border); font: 500 11px/16px var(--mono); white-space: nowrap; pointer-events: none; }
.htip .tag { padding: 0 5px; border-radius: 4px; background: oklch(100% 0 0/.14); color: var(--tip-fg); }
.sved { position: absolute; display: grid; place-items: center; overflow: hidden; pointer-events: auto; background-color: var(--canvas); background-image: conic-gradient(var(--hover-2) 25%, transparent 0 50%, var(--hover-2) 0 75%, transparent 0); background-size: 20px 20px; }
.sved svg { overflow: visible; }
.gtoast { position: absolute; bottom: 20px; transform: translateX(-50%); display: flex; align-items: center; gap: 10px; padding: 6px 6px 6px 12px; border-radius: 10px; background: var(--tip-bg); color: var(--tip-fg); box-shadow: 0 0 0 1px var(--tip-border), 0 8px 24px oklch(0% 0 0/.25); white-space: nowrap; animation: tip .15s both; }
.gtoast:not(:has(button)) { padding-right: 12px; }
.gtoast .b { color: var(--tip-fg); background: oklch(100% 0 0/.12); }
.kv { display: grid; grid-template-columns: 92px 1fr 22px; gap: 6px; align-items: center; }
.kv .k { color: var(--text-muted); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }


/* design system */
.dsbar { display: flex; align-items: center; gap: 2px; padding: 6px 8px 6px 12px; border-bottom: 1px solid var(--border-soft); color: var(--text-muted); }
.dsbar span { flex: 1; }
.dsbar [data-tip]:hover::after { bottom: auto; top: calc(100% + 6px); left: auto; right: 0; transform: none; }
.tiles { display: grid; grid-template-columns: repeat(4, 1fr); gap: 8px 6px; }
.tiles.two { grid-template-columns: 1fr 1fr; }
.tile { all: unset; box-sizing: border-box; min-width: 0; display: grid; gap: 4px; cursor: pointer; }
.tile i { display: block; height: 36px; border-radius: 6px; box-shadow: inset 0 0 0 1px oklch(0% 0 0/.08); transition: box-shadow .1s; }
.tile:hover i { box-shadow: inset 0 0 0 1px oklch(0% 0 0/.08), 0 0 0 2px var(--surface), 0 0 0 3.5px var(--border-strong); }
.tile span { font: 500 10px/12px var(--mono); color: var(--text-muted); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.tile:hover span { color: var(--text); }
.tile.grad i { height: 28px; }
.tile.rad i { background: var(--input); box-shadow: inset 0 0 0 1.5px var(--text-x); }
.tile.shd { padding: 12px 10px 6px; border-radius: 8px; background: var(--canvas); }
.tile.shd i { height: 28px; background: var(--surface); }
.tile.shd:hover { box-shadow: inset 0 0 0 1px var(--border-strong); }
.tile.shd:hover i { box-shadow: none; }
.chips { display: flex; flex-wrap: wrap; gap: 4px; }
.chip { all: unset; box-sizing: border-box; height: 24px; padding: 0 8px; display: inline-flex; align-items: center; gap: 6px; border-radius: 6px; background: var(--input); color: var(--text); font: 500 11px var(--mono); cursor: pointer; }
.chip:hover { box-shadow: inset 0 0 0 1px var(--border-strong); }
.cnt { flex: none; font-size: 10px; color: var(--text-x); font-family: "Watcher UI", "Timeless Sans", Inter, ui-sans-serif, system-ui, sans-serif; }
.list { display: grid; gap: 1px; margin: 0 -6px; }
.dsrow { all: unset; box-sizing: border-box; min-width: 0; min-height: 32px; padding: 4px 6px; display: flex; align-items: center; gap: 10px; border-radius: 6px; color: var(--text); cursor: pointer; }
.dsrow:hover { background: var(--hover); }
.grow { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.ag { flex: none; width: 40px; text-align: center; line-height: 1.15; color: var(--text); }
.meta { flex: 1; min-width: 0; display: grid; line-height: 15px; }
.meta b { font-weight: 600; }
.meta small { font-size: 11px; color: var(--text-x); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.bar { flex: none; height: 8px; min-width: 2px; border-radius: 2px; background: var(--text-muted); opacity: .8; }
.dot { flex: none; width: 12px; height: 12px; border-radius: 3px; box-shadow: inset 0 0 0 1px oklch(0% 0 0/.12); }
.vv { flex: none; max-width: 45%; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; color: var(--text-muted); }
.toast { position: absolute; left: 50%; bottom: 12px; transform: translateX(-50%); max-width: calc(100% - 24px); padding: 6px 10px; border-radius: 8px; background: var(--tip-bg); color: var(--tip-fg); box-shadow: 0 0 0 1px var(--tip-border), 0 4px 12px oklch(0% 0 0/.2); font-size: 11px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; animation: tip .12s both; pointer-events: none; }

/* help */
.help { padding: 12px; display: grid; gap: 14px; color: var(--text-muted); }
.help p { margin: 0; line-height: 18px; }
.help dl { margin: 0; display: grid; gap: 8px; }
.help dl div { display: flex; align-items: center; justify-content: space-between; gap: 8px; }
.help dt { color: var(--text); } .help dd { margin: 0; }
kbd { font-family: inherit; font-size: 11px; line-height: 16px; padding: 1px 6px; border-radius: 4px; background: var(--hover-2); color: var(--text-muted); white-space: nowrap; }


`
