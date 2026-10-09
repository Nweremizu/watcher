/**
 * Watcher: the overlay itself. Loaded lazily by ./index.ts, never imported by production builds.
 *
 * Alt+D toggles it. Every edit is an inline style on the live DOM, so it's gone on reload.
 * Use "Copy CSS" in the inspector footer to take your edits back to code.
 */
import { Fragment, memo, useCallback, useEffect, useId, useLayoutEffect, useRef, useState, type CSSProperties, type PointerEvent as RPointerEvent, type ReactNode } from 'react'
import { createPortal } from 'react-dom'
import { createRoot } from 'react-dom/client'
import { parsePath, serializePath, splitSeg, bezAt, shapeD, type PNode, type Sub } from './path'
import { ICONS, ICON_VIEWBOX } from './icons'

type Tool = 'select' | 'text' | 'draw' | 'hand' | 'rect' | 'pen'
type Guide = { id: number; axis: 'x' | 'y'; pos: number; pattern: 'solid' | 'dashed' | 'dotted'; color?: string; locked?: boolean }
// prop: CSS property, '#text' = innerHTML, '#node' = inserted node, '@name' = attribute (before '\u0000' = was absent)
type Edit = { el: HTMLElement; prop: string; before: string; t: number; imp?: boolean; parent?: Node | null; next?: Node | null }
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
const prefs = { spacing: true, snap: true, alwaysMeasure: false, flashUpdates: false, flashShifts: true }
try { Object.assign(prefs, JSON.parse(localStorage.getItem('watcher:prefs') ?? '{}')) } catch { /* storage blocked */ }
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
function record(el: HTMLElement, prop: string, before: () => string, imp = false) {
  const now = Date.now()
  redos.length = 0
  let e: Edit | undefined
  for (let i = hist.length - 1; i >= Math.max(0, hist.length - 4); i--) if (hist[i].el === el && hist[i].prop === prop) { e = hist[i]; break }
  if (e && now - e.t < 1000) e.t = now
  else hist.push({ el, prop, before: before(), t: now, imp })
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
  return { ...e, before: el.style.getPropertyValue(e.prop), imp: el.style.getPropertyPriority(e.prop) === 'important' }
}
function restore(e: Edit) {
  if (e.prop === '#unnode') e.parent?.insertBefore(e.el, e.next?.parentNode === e.parent ? e.next : null)
  else if (e.prop === '#node') e.el.remove()
  else if (e.prop[0] === '@') { const n = e.prop.slice(1); if (e.before === '\u0000') e.el.removeAttribute(n); else e.el.setAttribute(n, e.before) }
  else if (e.prop === '#text') e.el.innerHTML = e.before
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
    const lines = [...props].filter(p => !/^[#@]/.test(p) && el.style.getPropertyValue(p)).map(p => `  ${p}: ${el.style.getPropertyValue(p)};`)
    if (props.has('#text')) lines.push(`  /* text: ${JSON.stringify(el.textContent?.trim().slice(0, 120))} */`)
    const owner = reactName(el, true)
    if (!lines.length) continue
    const w = el.ownerDocument === document ? 0 : el.ownerDocument.defaultView?.innerWidth ?? 0
    if (!groups.has(w)) groups.set(w, [])
    groups.get(w)!.push(`${owner ? `/* <${owner}> */\n` : ''}${selector(el)} {\n${lines.join('\n')}\n}`)
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
const fmt = (v: string | number) => {
  if (typeof v === 'number') return String(round(v))
  const m = /^(-?[\d.]+)(px|deg)?$/.exec(v)
  return m ? String(round(+m[1], 2)) : v
}

/** Number field, value left, unit/axis suffix right. Takes any CSS value; ↑/↓ step (⇧ ×10); drag the suffix to scrub. */
function Num({ suffix, value, onChange, unit = 'px', step = 1 }: { suffix?: ReactNode; value: string | number; onChange: (v: string) => void; unit?: string; step?: number }) {
  const [draft, setDraft] = useState<string | null>(null)
  const shown = draft ?? fmt(value)
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
  const W = 240, left = Math.min(Math.max(8, anchor.right - W), innerWidth - W - 8)
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
const collapsed = new Set<string>()
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

function DesignTab({ el, select }: { el: HTMLElement; select: (el: HTMLElement | null) => void }) {
  const cs = getComputedStyle(el), r = el.getBoundingClientRect(), { o, z } = ctxOf(el)
  const get = (p: string) => cs.getPropertyValue(p)
  const set = (p: string) => (v: string) => setStyle(el, p, v)
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
          <Num suffix="%" value={round(parseFloat(cs.opacity) * 100)} unit="" onChange={v => { const n = parseFloat(v); if (!isNaN(n)) setStyle(el, 'opacity', String(Math.min(100, Math.max(0, n)) / 100)) }} />
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
  const set = (p: string) => (v: string) => setStyle(el, p, v)
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
      <Section title="Transition">
        <Row label="Property"><Field mono value={cs.transitionProperty} onChange={set('transition-property')} /></Row>
        <Row label="Duration"><Num suffix="ms" value={round(parseFloat(cs.transitionDuration) * 1000)} unit="ms" step={10} onChange={set('transition-duration')} /></Row>
        <Row label="Delay"><Num suffix="ms" value={round(parseFloat(cs.transitionDelay) * 1000)} unit="ms" step={10} onChange={set('transition-delay')} /></Row>
        <Row label="Easing"><Pick value={cs.transitionTimingFunction} options={['ease', 'linear', 'ease-in', 'ease-out', 'ease-in-out']} onChange={set('transition-timing-function')} /></Row>
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

const PREF_LABELS: [keyof typeof prefs, string][] = [['spacing', 'Show padding & margin'], ['snap', 'Smart snapping'], ['alwaysMeasure', 'Measure without holding Alt']]
function Settings({ theme, setTheme, onClose }: { theme: 'light' | 'dark'; setTheme: (t: 'light' | 'dark') => void; onClose: () => void }) {
  const [, force] = useState(0)
  return (
    <>
      <div className="backdrop" onPointerDown={onClose} />
      <div className="menu">
        <Row label="Theme"><Seg value={theme} options={[['light', 'Light'], ['dark', 'Dark']] as const} onChange={setTheme} /></Row>
        {PREF_LABELS.map(([k, l]) => <Check key={k} checked={prefs[k]} onChange={v => { prefs[k] = v; savePrefs(); force(n => n + 1) }}>{l}</Check>)}
      </div>
    </>
  )
}

const KEYS: [string, string][] = [
  ['Select & move', 'V'], ['Rectangle', 'R'], ['Pen · vector', 'P'], ['Pencil', '⇧P'], ['Text', 'T · dbl-click'], ['Pan', 'H · Space'],
  ['Measure spacing', 'hold Alt'], ['Open in SVG editor', 'Enter · dbl-click'], ['Pick colour from screen', 'I'], ['Pixel grid', '⇧G'],
  ['Zoom', 'Ctrl + scroll'], ['Fit / 100%', '⇧1 / Ctrl 0'],
  ['Parent / child', '⇧↵ / ↵'], ['Deep select', 'Ctrl click'], ['Nudge', '← ↑ → ↓'], ['Hide element', 'Del'], ['Undo / redo', 'Ctrl Z / Ctrl ⇧Z'],
  ['Canvas mode', '⇧C'], ['Responsive preview', '⇧V'], ['X-ray', 'X'], ['Duplicate', 'Ctrl D · Alt drag'], ['Copy / paste', 'Ctrl C / V'], ['Forward / back', '] / ['],
  ['Rulers', '⇧R'], ['Close overlay', 'Alt D'],
]
const Help = () => (
  <div className="help">
    <p>Click anything to inspect it. Every value edits live. Drag from a ruler to drop a guide, click a guide to edit it.</p>
    <dl>{KEYS.map(([a, k]) => <div key={a}><dt>{a}</dt><dd><kbd>{k}</kbd></dd></div>)}</dl>
  </div>
)

type InspectorProps = {
  el: HTMLElement | null; rev: number; select: (el: HTMLElement | null) => void
  guide: Guide | null; updateGuide: (p: Partial<Guide>) => void; removeGuide: () => void
  theme: 'light' | 'dark'; setTheme: (t: 'light' | 'dark') => void; onClose: () => void
}
const Inspector = memo(function Inspector({ el, rev, select, guide, updateGuide, removeGuide, theme, setTheme, onClose }: InspectorProps) {
  void rev // re-render trigger only
  const [tab, setTab] = useState<'design' | 'prototype'>('design')
  const [menu, setMenu] = useState(false)
  const [copied, setCopied] = useState(false)
  const n = [...changes.values()].reduce((s, p) => s + p.size, 0)
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
      <div className="tabbar"><Seg big value={tab} options={[['design', 'Design'], ['prototype', 'Prototype']] as const} onChange={setTab} /></div>
      <div className="pb">
        {guide ? <GuidePanel g={guide} update={updateGuide} remove={removeGuide} />
          : !el ? <Help />
          : tab === 'design' ? <DesignTab el={el} select={select} />
          : <PrototypeTab el={el} select={select} />}
      </div>
      {!guide && (
        <div className="foot">
          <span>{n ? `${n} edit${n > 1 ? 's' : ''}` : 'No edits yet'}</span>
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

  // CSS custom properties declared on :root / html, resolved to their current value
  const root = getComputedStyle(document.documentElement)
  const walk = (rules: CSSRuleList) => {
    for (const r of rules) {
      if (r instanceof CSSStyleRule && /(^|,)\s*(:root|html)\s*(,|$)/.test(r.selectorText)) {
        for (const p of r.style) if (p.startsWith('--')) ds.vars.set(p, root.getPropertyValue(p).trim())
      } else if ('cssRules' in r) walk((r as CSSGroupingRule).cssRules)
    }
  }
  for (const s of document.styleSheets) { try { walk(s.cssRules) } catch { /* cross-origin sheet */ } }
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
      muts += list.length; perf.mutTotal += list.length
      if (prefs.flashUpdates) for (const m of list.slice(0, 60)) flash(m.target, 'dom')
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
  const [right, setRight] = useState<'inspect' | 'ds' | 'perf'>('inspect')
  const [grid, setGrid] = useState(false)
  const [filter, setFilter] = useState('')
  const [settings, setSettings] = useState(false)
  const [href, setHref] = useState(location.href)
  const [toastMsg, setToastMsg] = useState<{ msg: string; action?: { label: string; run: () => void } } | null>(null)
  const [resp, setResp] = useState<Resp | null>(null)
  const [frameInspect, setFrameInspect] = useState(true)
  const [alt, setAlt] = useState(false)
  const [xray, setXray] = useState(false)
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
    const mo = new MutationObserver(() => { L.dirty = true })
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
      if (e.altKey && e.code === 'KeyD') { if (FRAME) return; e.preventDefault(); if (L.open) L.close(); else setOpen(true); return }
      if (!L.open) return
      // hold Alt to measure; preventDefault stops Windows focusing the browser menu on release
      if (e.key === 'Alt') { e.preventDefault(); setAlt(true); return }
      const p = e.composedPath()[0] as HTMLElement | undefined
      if (p?.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(p?.tagName ?? '')) return
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
    }
    const blur = () => { setAlt(false); L.space = false; setSpace(false) }

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
    for (const [t, f, o] of on) window.addEventListener(t, f, o ?? true)
    return () => { for (const [t, f, o] of on) window.removeEventListener(t, f, o ?? true) }
  }, [L, select])

  const toggleCanvas = () => {
    L.stopEdit?.()
    if (!cv.on) enterCanvas()
    else leaveCanvas()
  }
  const close = () => { if (!cv.on || leaveCanvas()) setOpen(false) }
  L.toggleCanvas = toggleCanvas
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
        <button className="launch ui" data-tip="Watcher · Alt D" onClick={() => setOpen(true)}><Mark size={26} /></button>
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
          {(hr || L.lastHov) && (() => { const b = hr ?? L.lastHov!; if (hr) L.lastHov = hr; return (
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
        {hv && hr && (
          <div className="htip" style={{ left: hr.left, top: Math.max(hr.top - 6, cy0 + 26) }}>
            <span className="tag">{hv.tagName.toLowerCase()}</span><span>{trail(hv)}</span>
          </div>
        )}
        {sel && sr && <>
          <div className="pill" style={{ left: sr.left, top: Math.max(sr.top - 4, cy0 + 22), transform: 'translateY(-100%)' }}>{label(sel)}</div>
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
        <button className={'b' + (right === 'ds' ? ' tg' : '')} data-tip="Design system" onClick={() => { setRight(r => (r === 'ds' ? 'inspect' : 'ds')); setShow(v => ({ ...v, inspector: true })) }}><Icon d={P.palette} /></button>
        <button className={'b' + (right === 'perf' ? ' tg' : '')} data-tip="Profiler" onClick={() => { setRight(r => (r === 'perf' ? 'inspect' : 'perf')); setShow(v => ({ ...v, inspector: true })) }}><Icon d={P.pulse} /></button>
        <button className={'b' + (resp ? ' on' : '')} data-tip="Responsive · ⇧V" onClick={() => { closeSvgEditor(); setResp(r => (r ? null : DEFAULT_RESP)) }}><Icon d={P.devices} /></button>
        <i className="sep" />
        <button className="b" data-tip="Undo · Ctrl Z" disabled={!hist.length} onClick={undo}><Icon d={P.undo} /></button>
        <button className="b" data-tip="Redo · Ctrl ⇧Z" disabled={!redos.length} onClick={redo}><Icon d={P.redo} /></button>
        {strokes.length > 0 && <button className="b" data-tip="Clear drawings" onClick={() => { strokes.length = 0; bump() }}><Icon d={P.trash} /></button>}
        <span className="sp" />
        <button className={'b' + (show.layers ? ' tg' : '')} data-tip="Left sidebar" onClick={() => setShow(v => ({ ...v, layers: !v.layers }))}><Icon d={P.sideL} /></button>
        <button className={'b' + (show.inspector ? ' tg' : '')} data-tip="Right sidebar" onClick={() => setShow(v => ({ ...v, inspector: !v.inspector }))}><Icon d={P.sideR} /></button>
        <i className="sep" />
        <button className="b" data-tip="Close · Alt D" onClick={close}><Icon d={P.x} /></button>
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
            : <Inspector el={sel} rev={rev} select={select} guide={guides.find(g => g.id === selGuide) ?? null}
              updateGuide={updateGuide} removeGuide={removeGuide} theme={theme} setTheme={setTheme} onClose={closeInspector} />}
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
export function mount({ font }: { font?: string } = {}): () => void {
  if (HOST || (FRAME && !parentHost)) return () => {} // a preview frame needs the Watcher page around it
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
.b.on, .b.on:hover { background: var(--primary); color: var(--on-primary); }
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
.launch:hover { box-shadow: var(--shadow-raised), 0 0 0 2px var(--primary); }
.mark { position: relative; display: grid; padding: 0 2px; }

/* stage */
.stage { position: absolute; inset: 0; overflow: visible; }
/* hover = dashed, selection = solid; the hover outline morphs between elements with a slight overshoot */
.stage .hov { transition: x .32s var(--goo), y .32s var(--goo), width .32s var(--goo), height .32s var(--goo), opacity .18s; }
.stage .hov.off { opacity: 0; }
.htip { transition: left .32s var(--goo), top .32s var(--goo); }
@media (prefers-reduced-motion: reduce) { .stage .hov, .htip { transition: none; } }
.stage .hov { fill: none; stroke: var(--primary); stroke-width: 1.25; stroke-dasharray: 4 3; }
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
.banner svg { color: var(--primary); }
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
.addr > .b:first-child { color: var(--primary); }
.url { all: unset; box-sizing: border-box; flex: 1; min-width: 0; height: 28px; padding: 0 10px; border-radius: 6px; font: 500 12px/28px var(--mono); color: var(--text); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.url:hover { background: var(--hover); }
.url:focus { background: var(--input); box-shadow: inset 0 0 0 1px var(--primary); }
.grp { display: flex; gap: 2px; margin-left: 6px; padding-left: 8px; border-left: 1px solid var(--border); }
.tabsrow { position: absolute; height: 36px; display: flex; align-items: center; gap: 4px; padding: 0 8px; background: var(--surface); border-bottom: 1px solid var(--border-soft); }
.tabsrow .sp, .toolrow .sp { flex: 1; }
.ptab { all: unset; box-sizing: border-box; max-width: 220px; height: 28px; padding: 0 6px 0 10px; display: inline-flex; align-items: center; gap: 7px; border-radius: 7px; color: var(--text-muted); font-weight: 500; white-space: nowrap; cursor: pointer; }
.ptab:hover { background: var(--hover); color: var(--text); }
.ptab.on { background: var(--hover-2); color: var(--text); }
.ptab > svg { color: var(--primary); }
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
.pg.on { background: var(--primary); color: var(--on-primary); }
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
.row.on, .row.on:hover { background: var(--primary); color: var(--on-primary); }
.row.on .ic, .row.on .cv, .row.on .sub, .row.on.comp .ic, .row.on.comp .nm { color: inherit; }
.row.on .sub { opacity: .75; }
.cv { flex: none; width: 12px; height: 12px; display: grid; place-items: center; color: var(--text-x); cursor: pointer; transition: transform .12s; }
.cv.open { transform: rotate(90deg); }
.ic { flex: none; display: grid; color: var(--text-x); }
.row.comp .ic, .row.comp .nm { color: var(--primary); }
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
.range { flex: 1.4 !important; accent-color: var(--primary); }
.hint { margin: 2px 0 0; color: var(--text-x); font-size: 11px; line-height: 17px; }
.hint kbd { font-size: 10px; padding: 0 4px; }
.g2 { display: grid; grid-template-columns: 1fr 1fr; gap: 6px; }

/* segmented controls, breadcrumbs, checkboxes */
.seg { display: flex; gap: 2px; padding: 2px; border-radius: 8px; background: var(--input); box-shadow: var(--shadow-field); }
.seg button { all: unset; flex: 1; min-width: 0; height: 26px; padding: 0 6px; display: grid; place-items: center; border-radius: 6px; color: var(--text-muted); font-size: 12px; white-space: nowrap; cursor: pointer; }
.seg button:hover { color: var(--text); }
.seg button.on { background: var(--primary); color: var(--on-primary); }
.seg.big { padding: 3px; border-radius: 10px; }
.seg.big button { height: 30px; border-radius: 8px; font-size: 13px; font-weight: 600; }
.seg.big button.on { background: var(--surface); color: var(--text); box-shadow: var(--shadow-btn); }
.crumbs { display: flex; flex-wrap: wrap; align-items: center; gap: 4px; padding: 10px 12px; border-bottom: 1px solid var(--border-soft); color: var(--text-x); }
.crumb { all: unset; max-width: 150px; height: 22px; padding: 0 7px; display: inline-flex; align-items: center; border-radius: 6px; background: var(--input); color: var(--text-muted); font: 500 11px/22px var(--mono); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; cursor: pointer; }
.crumb:hover { color: var(--text); }
.crumb.on { background: var(--primary); color: var(--on-primary); }
.compname { width: 100%; display: flex; align-items: center; gap: 6px; margin-top: 4px; color: var(--primary); font-weight: 600; }
.check { display: flex; align-items: center; gap: 8px; min-height: 28px; color: var(--text); cursor: pointer; }
.check input { display: none; }
.check .cb { flex: none; width: 16px; height: 16px; display: grid; place-items: center; border-radius: 4px; background: var(--input); box-shadow: inset 0 0 0 1px var(--border-strong); color: transparent; }
.check input:checked + .cb { background: var(--primary); box-shadow: none; color: var(--on-primary); }
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
.rtile.drag .box:active { box-shadow: inset 0 0 0 1px var(--primary); }
.ill { width: 64px; height: 44px; overflow: visible; }
.ill path { fill: none; stroke: var(--text-x); stroke-width: 1.6; stroke-linecap: round; stroke-linejoin: round; }
.ill .arm { cursor: pointer; }
.ill .arm.on path:not(.hit) { stroke: var(--primary); }
.ill .arm:hover path:not(.hit) { stroke: var(--text-muted); }
.ill .arm.on:hover path:not(.hit) { stroke: var(--primary); opacity: .8; }
.ill .arm .hit { stroke: transparent; stroke-width: 12; }
.ill .core { fill: var(--surface); stroke: var(--text-x); stroke-width: 1.4; }
.ill .knob { fill: var(--primary); }

/* prototype */
.ilist { display: grid; gap: 4px; }
.irow { display: flex; justify-content: space-between; gap: 8px; padding: 6px 8px; border-radius: 6px; background: var(--input); font: 500 11px var(--mono); }
.irow b { color: var(--primary); font-weight: 600; }
.irow span { min-width: 0; overflow: hidden; text-overflow: ellipsis; color: var(--text-muted); }
.empty { margin: 0; color: var(--text-x); }

/* profiler */
.metric { padding: 12px; display: grid; gap: 6px; border-bottom: 1px solid var(--border-soft); }
.mh { display: flex; align-items: baseline; justify-content: space-between; gap: 8px; }
.mh span { font-size: 11px; font-weight: 600; letter-spacing: .07em; text-transform: uppercase; color: var(--text-x); }
.mh b { font-size: 18px; line-height: 22px; font-weight: 600; }
.mh b small { margin-left: 3px; font-size: 11px; font-weight: 500; color: var(--text-muted); }
.spark { display: block; width: 100%; height: 36px; border-radius: 6px; background: var(--input); }
.spark rect { fill: var(--primary); }
.spark rect.bad { fill: oklch(62% .22 25); }
.spark polyline { fill: none; stroke: var(--primary); stroke-width: 1.5; vector-effect: non-scaling-stroke; }
.spark line { stroke: var(--text-x); stroke-dasharray: 2 2; vector-effect: non-scaling-stroke; }
.msub { font-size: 11px; color: var(--text-muted); }
.mlist { display: grid; gap: 2px; font: 500 11px var(--mono); color: var(--text-muted); }
.mlist div { display: flex; justify-content: space-between; }
.good { color: oklch(62% .17 150); } .warn { color: oklch(70% .16 75); } .bad { color: oklch(60% .22 25); }
.mono { font-family: var(--mono) !important; font-size: 11px !important; }

/* fields */
.f { position: relative; display: flex; align-items: center; height: 30px; min-width: 0; border-radius: 6px; background: var(--input); box-shadow: var(--shadow-field); }
.f:hover { box-shadow: var(--shadow-field), inset 0 0 0 1px var(--border-strong); }
.f:focus-within { box-shadow: inset 0 0 0 1px var(--primary); }
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
.rlabel svg { color: var(--primary); }
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
.cp { position: fixed; z-index: 20; width: 240px; padding: 12px; display: grid; gap: 10px; border-radius: 12px; background: var(--surface); box-shadow: var(--shadow-overlay, var(--shadow-raised)), 0 0 0 1px var(--border); }
.cp-sv { position: relative; height: 156px; border-radius: 8px; cursor: crosshair; touch-action: none; box-shadow: inset 0 0 0 1px oklch(0% 0 0/.08); }
.cp-bar { position: relative; height: 12px; border-radius: 6px; cursor: pointer; touch-action: none; box-shadow: inset 0 0 0 1px oklch(0% 0 0/.08); }
.cp-hue { background: linear-gradient(to right, #f00, #ff0, #0f0, #0ff, #00f, #f0f, #f00); }
.cp-alpha { background-size: 100% 100%, 8px 8px; }
.cp-thumb { position: absolute; width: 14px; height: 14px; margin: -7px 0 0 -7px; border-radius: 50%; border: 2px solid #fff; box-shadow: 0 0 0 1px oklch(0% 0 0/.35), 0 1px 3px oklch(0% 0 0/.3); pointer-events: none; }
.cp-bar .cp-thumb { top: 50%; }
.cp-row { display: flex; align-items: center; gap: 6px; }
.cp-row .f { flex: 1; min-width: 0; }
.cp-row .sw.big { width: 26px; }
.cp-a { width: 64px; flex: none; }
.cp-cap { font-size: 11px; font-weight: 600; color: var(--text-x); margin-bottom: -4px; }
.cp-sws { display: flex; flex-wrap: wrap; gap: 5px; }
.cp-sws button { all: unset; width: 20px; height: 20px; border-radius: 5px; cursor: pointer; box-shadow: inset 0 0 0 1px oklch(0% 0 0/.12); }
.cp-sws button:hover { box-shadow: 0 0 0 2px var(--surface), 0 0 0 3.5px var(--primary); }

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
.tile:hover i { box-shadow: inset 0 0 0 1px oklch(0% 0 0/.08), 0 0 0 2px var(--surface), 0 0 0 3.5px var(--primary); }
.tile span { font: 500 10px/12px var(--mono); color: var(--text-muted); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.tile:hover span { color: var(--text); }
.tile.grad i { height: 28px; }
.tile.rad i { background: var(--input); box-shadow: inset 0 0 0 1.5px var(--text-x); }
.tile.shd { padding: 12px 10px 6px; border-radius: 8px; background: var(--canvas); }
.tile.shd i { height: 28px; background: var(--surface); }
.tile.shd:hover { box-shadow: inset 0 0 0 1px var(--primary); }
.tile.shd:hover i { box-shadow: none; }
.chips { display: flex; flex-wrap: wrap; gap: 4px; }
.chip { all: unset; box-sizing: border-box; height: 24px; padding: 0 8px; display: inline-flex; align-items: center; gap: 6px; border-radius: 6px; background: var(--input); color: var(--text); font: 500 11px var(--mono); cursor: pointer; }
.chip:hover { box-shadow: inset 0 0 0 1px var(--primary); }
.cnt { flex: none; font-size: 10px; color: var(--text-x); font-family: "Watcher UI", "Timeless Sans", Inter, ui-sans-serif, system-ui, sans-serif; }
.list { display: grid; gap: 1px; margin: 0 -6px; }
.dsrow { all: unset; box-sizing: border-box; min-width: 0; min-height: 32px; padding: 4px 6px; display: flex; align-items: center; gap: 10px; border-radius: 6px; color: var(--text); cursor: pointer; }
.dsrow:hover { background: var(--hover); }
.grow { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.ag { flex: none; width: 40px; text-align: center; line-height: 1.15; color: var(--text); }
.meta { flex: 1; min-width: 0; display: grid; line-height: 15px; }
.meta b { font-weight: 600; }
.meta small { font-size: 11px; color: var(--text-x); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.bar { flex: none; height: 8px; min-width: 2px; border-radius: 2px; background: var(--primary); opacity: .8; }
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
