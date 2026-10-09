// SVG path model for the pen tool: any `d` → anchor nodes with bezier handles → `d`.
// Everything is normalised to absolute M / L / C / Z (arcs and quadratics become cubics).

export type Pt = [number, number]
export type PNode = { x: number; y: number; in?: Pt; out?: Pt }
export type Sub = { nodes: PNode[]; closed: boolean }

const NUM = /[\s,]*([-+]?(?:\d*\.\d+|\d+\.?)(?:e[-+]?\d+)?)/iy
const FLAG = /[\s,]*([01])/y
const CMD = /[\s,]*([a-z])/iy
const ARGS: Record<string, number> = { m: 2, l: 2, h: 1, v: 1, c: 6, s: 4, q: 4, t: 2, a: 7, z: 0 }

export function parsePath(d: string): Sub[] {
  const subs: Sub[] = []
  let i = 0, cx = 0, cy = 0, sx = 0, sy = 0, cmd = '', prev = ''
  let lc: Pt | null = null, lq: Pt | null = null // last cubic / quadratic control, for S and T
  let sub: Sub | null = null
  const read = (re: RegExp) => { re.lastIndex = i; const m = re.exec(d); if (!m) return NaN; i = re.lastIndex; return +m[1] }
  const ensure = () => { if (!sub || sub.closed) { sub = { nodes: [{ x: cx, y: cy }], closed: false }; subs.push(sub) } return sub }
  const line = (x: number, y: number) => { ensure().nodes.push({ x, y }) }
  const cubic = (x1: number, y1: number, x2: number, y2: number, x: number, y: number) => {
    const s = ensure()
    s.nodes[s.nodes.length - 1].out = [x1, y1]
    s.nodes.push({ x, y, in: [x2, y2] })
  }
  const quad = (qx: number, qy: number, x: number, y: number) =>
    cubic(cx + (2 / 3) * (qx - cx), cy + (2 / 3) * (qy - cy), x + (2 / 3) * (qx - x), y + (2 / 3) * (qy - y), x, y)

  while (i < d.length) {
    CMD.lastIndex = i
    const m = CMD.exec(d)
    if (m) { cmd = m[1]; i = CMD.lastIndex }
    else if (!cmd || cmd.toLowerCase() === 'z') break
    const lo = cmd.toLowerCase(), rel = cmd !== cmd.toUpperCase()
    if (!(lo in ARGS)) break
    if (lo === 'z') {
      if (sub) {
        const n = sub.nodes, a = n[0], b = n[n.length - 1]
        // an explicit point back at the start is the same node: fold its in-handle into the first node
        if (n.length > 1 && Math.abs(a.x - b.x) < 1e-6 && Math.abs(a.y - b.y) < 1e-6) { a.in = b.in; n.pop() }
        sub.closed = true
      }
      cx = sx; cy = sy; prev = 'z'
      continue
    }
    const a: number[] = []
    for (let k = 0; k < ARGS[lo]; k++) {
      const v = read(lo === 'a' && (k === 3 || k === 4) ? FLAG : NUM)
      if (isNaN(v)) break
      a.push(v)
    }
    if (a.length < ARGS[lo]) break
    const ox = rel ? cx : 0, oy = rel ? cy : 0
    switch (lo) {
      case 'm':
        cx = a[0] + ox; cy = a[1] + oy; sx = cx; sy = cy
        sub = { nodes: [{ x: cx, y: cy }], closed: false }; subs.push(sub)
        cmd = rel ? 'l' : 'L' // extra coordinate pairs after M are lines
        break
      case 'l': cx = a[0] + ox; cy = a[1] + oy; line(cx, cy); break
      case 'h': cx = a[0] + ox; line(cx, cy); break
      case 'v': cy = a[0] + oy; line(cx, cy); break
      case 'c':
        cubic(a[0] + ox, a[1] + oy, a[2] + ox, a[3] + oy, a[4] + ox, a[5] + oy)
        lc = [a[2] + ox, a[3] + oy]; cx = a[4] + ox; cy = a[5] + oy
        break
      case 's': {
        const [x1, y1] = (prev === 'c' || prev === 's') && lc ? [2 * cx - lc[0], 2 * cy - lc[1]] : [cx, cy]
        cubic(x1, y1, a[0] + ox, a[1] + oy, a[2] + ox, a[3] + oy)
        lc = [a[0] + ox, a[1] + oy]; cx = a[2] + ox; cy = a[3] + oy
        break
      }
      case 'q': {
        const qx = a[0] + ox, qy = a[1] + oy, x = a[2] + ox, y = a[3] + oy
        quad(qx, qy, x, y); lq = [qx, qy]; cx = x; cy = y
        break
      }
      case 't': {
        const smooth = (prev === 'q' || prev === 't') && lq
        const qx: number = smooth ? 2 * cx - lq![0] : cx, qy: number = smooth ? 2 * cy - lq![1] : cy
        const x = a[0] + ox, y = a[1] + oy
        quad(qx, qy, x, y); lq = [qx, qy]; cx = x; cy = y
        break
      }
      case 'a': {
        const x = a[5] + ox, y = a[6] + oy
        for (const c of arcToCubic(cx, cy, a[0], a[1], a[2], a[3], a[4], x, y)) cubic(c[0], c[1], c[2], c[3], c[4], c[5])
        cx = x; cy = y
        break
      }
    }
    prev = lo
  }
  return subs
}

const f = (n: number) => String(Math.round(n * 100) / 100)
const p = (q: Pt) => `${f(q[0])} ${f(q[1])}`
const seg = (a: PNode, b: PNode) =>
  a.out || b.in ? `C${p(a.out ?? [a.x, a.y])} ${p(b.in ?? [b.x, b.y])} ${f(b.x)} ${f(b.y)}` : `L${f(b.x)} ${f(b.y)}`

export function serializePath(subs: Sub[]): string {
  let d = ''
  for (const s of subs) {
    const n = s.nodes
    if (!n.length) continue
    d += `M${f(n[0].x)} ${f(n[0].y)}`
    for (let k = 1; k < n.length; k++) d += seg(n[k - 1], n[k])
    if (s.closed) {
      const a = n[n.length - 1], b = n[0]
      if (n.length > 1 && (a.out || b.in)) d += seg(a, b)
      d += 'Z'
    }
  }
  return d
}

/** Point on the segment a→b at t. */
export function bezAt(a: PNode, b: PNode, t: number): Pt {
  const P0: Pt = [a.x, a.y], P3: Pt = [b.x, b.y], P1 = a.out ?? P0, P2 = b.in ?? P3, u = 1 - t
  const c = (k: 0 | 1) => u * u * u * P0[k] + 3 * u * u * t * P1[k] + 3 * u * t * t * P2[k] + t * t * t * P3[k]
  return [c(0), c(1)]
}

/** Split segment a→b at t (de Casteljau). Mutates a.out / b.in, returns the new middle node. */
export function splitSeg(a: PNode, b: PNode, t: number): PNode {
  const P0: Pt = [a.x, a.y], P3: Pt = [b.x, b.y]
  const L = (q: Pt, r: Pt): Pt => [q[0] + (r[0] - q[0]) * t, q[1] + (r[1] - q[1]) * t]
  if (!a.out && !b.in) { const [x, y] = L(P0, P3); return { x, y } }
  const P1 = a.out ?? P0, P2 = b.in ?? P3
  const p01 = L(P0, P1), p12 = L(P1, P2), p23 = L(P2, P3), p012 = L(p01, p12), p123 = L(p12, p23), [x, y] = L(p012, p123)
  a.out = p01; b.in = p23
  return { x, y, in: p012, out: p123 }
}

/** Endpoint arc → cubic beziers (≤ 90° each). Returns [x1, y1, x2, y2, x, y] per segment. */
export function arcToCubic(x1: number, y1: number, rx: number, ry: number, rotDeg: number, large: number, sweep: number, x2: number, y2: number): number[][] {
  if (!rx || !ry || (x1 === x2 && y1 === y2)) return [[x1, y1, x2, y2, x2, y2]]
  const phi = (rotDeg * Math.PI) / 180, cos = Math.cos(phi), sin = Math.sin(phi)
  const dx = (x1 - x2) / 2, dy = (y1 - y2) / 2
  const x1p = cos * dx + sin * dy, y1p = -sin * dx + cos * dy
  rx = Math.abs(rx); ry = Math.abs(ry)
  const lam = (x1p * x1p) / (rx * rx) + (y1p * y1p) / (ry * ry)
  if (lam > 1) { rx *= Math.sqrt(lam); ry *= Math.sqrt(lam) }
  const num = rx * rx * ry * ry - rx * rx * y1p * y1p - ry * ry * x1p * x1p
  const co = (large === sweep ? -1 : 1) * Math.sqrt(Math.max(0, num / (rx * rx * y1p * y1p + ry * ry * x1p * x1p)))
  const cxp = (co * rx * y1p) / ry, cyp = (-co * ry * x1p) / rx
  const cx = cos * cxp - sin * cyp + (x1 + x2) / 2, cy = sin * cxp + cos * cyp + (y1 + y2) / 2
  const ang = (ux: number, uy: number, vx: number, vy: number) => Math.atan2(ux * vy - uy * vx, ux * vx + uy * vy)
  const t1 = ang(1, 0, (x1p - cxp) / rx, (y1p - cyp) / ry)
  let dt = ang((x1p - cxp) / rx, (y1p - cyp) / ry, (-x1p - cxp) / rx, (-y1p - cyp) / ry)
  if (!sweep && dt > 0) dt -= 2 * Math.PI
  else if (sweep && dt < 0) dt += 2 * Math.PI
  const n = Math.max(1, Math.ceil(Math.abs(dt) / (Math.PI / 2) - 1e-9)), step = dt / n, k = (4 / 3) * Math.tan(step / 4)
  const pt = (ex: number, ey: number) => [cos * rx * ex - sin * ry * ey + cx, sin * rx * ex + cos * ry * ey + cy]
  const out: number[][] = []
  for (let i = 0, t = t1; i < n; i++, t += step) {
    const c1 = Math.cos(t), s1 = Math.sin(t), c2 = Math.cos(t + step), s2 = Math.sin(t + step)
    out.push([...pt(c1 - k * s1, s1 + k * c1), ...pt(c2 + k * s2, s2 - k * c2), ...pt(c2, s2)])
  }
  return out
}

/** `d` for a basic shape, so any SVG shape can be edited as a path. */
export function shapeD(tag: string, num: (attr: string) => number, points = ''): string {
  if (tag === 'rect') {
    const x = num('x'), y = num('y'), w = num('width'), h = num('height')
    const rx = Math.min(num('rx') || num('ry'), w / 2), ry = Math.min(num('ry') || num('rx'), h / 2)
    if (!rx) return `M${x} ${y}H${x + w}V${y + h}H${x}Z`
    return `M${x + rx} ${y}H${x + w - rx}A${rx} ${ry} 0 0 1 ${x + w} ${y + ry}V${y + h - ry}A${rx} ${ry} 0 0 1 ${x + w - rx} ${y + h}` +
      `H${x + rx}A${rx} ${ry} 0 0 1 ${x} ${y + h - ry}V${y + ry}A${rx} ${ry} 0 0 1 ${x + rx} ${y}Z`
  }
  if (tag === 'circle' || tag === 'ellipse') {
    const cx = num('cx'), cy = num('cy'), rx = tag === 'circle' ? num('r') : num('rx'), ry = tag === 'circle' ? num('r') : num('ry')
    return `M${cx - rx} ${cy}A${rx} ${ry} 0 1 0 ${cx + rx} ${cy}A${rx} ${ry} 0 1 0 ${cx - rx} ${cy}Z`
  }
  if (tag === 'line') return `M${num('x1')} ${num('y1')}L${num('x2')} ${num('y2')}`
  const pts = points.trim().split(/[\s,]+/).map(Number)
  let d = ''
  for (let i = 0; i + 1 < pts.length; i += 2) d += `${i ? 'L' : 'M'}${pts[i]} ${pts[i + 1]}`
  return tag === 'polygon' ? d + 'Z' : d
}
