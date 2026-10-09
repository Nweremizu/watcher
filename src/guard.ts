// Colour maths for the token guardrails and WCAG contrast checks. Pure (no DOM), so checks/guard.check.ts runs it in Node.

export type RGB = { r: number; g: number; b: number; a: number } // 0–255 channels, alpha 0–1
export type Token = { name: string; px?: number; rgb?: RGB } // a CSS custom property resolved to a length or a colour

const lin = (c: number) => { c /= 255; return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4 }
const gam = (c: number) => { c = Math.min(1, Math.max(0, c)); return 255 * (c <= 0.0031308 ? 12.92 * c : 1.055 * c ** (1 / 2.4) - 0.055) }

/** WCAG relative luminance. */
export const luminance = ({ r, g, b }: RGB) => 0.2126 * lin(r) + 0.7152 * lin(g) + 0.0722 * lin(b)
/** WCAG contrast ratio, 1–21. */
export function contrast(a: RGB, b: RGB) { const x = luminance(a), y = luminance(b); return (Math.max(x, y) + 0.05) / (Math.min(x, y) + 0.05) }
/** `top` painted over an opaque `bottom`. */
export const over = (top: RGB, bottom: RGB): RGB => ({
  r: top.r * top.a + bottom.r * (1 - top.a), g: top.g * top.a + bottom.g * (1 - top.a), b: top.b * top.a + bottom.b * (1 - top.a), a: 1,
})
/** WCAG "large text": 24px, or 18.66px (14pt) bold. Needs 3:1 instead of 4.5:1. */
export const isLargeText = (px: number, weight: number) => px >= 24 || (px >= 18.66 && weight >= 700)
export const contrastNeed = (large: boolean) => ({ aa: large ? 3 : 4.5, aaa: large ? 4.5 : 7 })

type Lab = { L: number; a: number; b: number }
export function toOklab({ r, g, b }: RGB): Lab {
  const R = lin(r), G = lin(g), B = lin(b)
  const l = Math.cbrt(0.4122214708 * R + 0.5363325363 * G + 0.0514459929 * B)
  const m = Math.cbrt(0.2119034982 * R + 0.6806995451 * G + 0.1073969566 * B)
  const s = Math.cbrt(0.0883024619 * R + 0.2817188376 * G + 0.6299787005 * B)
  return { L: 0.2104542553 * l + 0.793617785 * m - 0.0040720468 * s, a: 1.9779984951 * l - 2.428592205 * m + 0.4505937099 * s, b: 0.0259040371 * l + 0.7827717662 * m - 0.808675766 * s }
}
export function fromOklab({ L, a, b }: Lab, alpha = 1): RGB {
  const l = (L + 0.3963377774 * a + 0.2158037573 * b) ** 3, m = (L - 0.1055613458 * a - 0.0638541728 * b) ** 3, s = (L - 0.0894841775 * a - 1.291485548 * b) ** 3
  const ch = (v: number) => Math.round(gam(v))
  return { r: ch(4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s), g: ch(-1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s), b: ch(-0.0041960863 * l - 0.7034186147 * m + 1.707614701 * s), a: alpha }
}
/** Perceptual colour distance (OKLab ×100): under ~1 looks identical, ~2 is just noticeable. */
export function deltaE(x: RGB, y: RGB) { const p = toOklab(x), q = toOklab(y); return 100 * Math.hypot(p.L - q.L, p.a - q.a, p.b - q.b) }
export const toHex = ({ r, g, b }: RGB) => '#' + [r, g, b].map(v => Math.round(v).toString(16).padStart(2, '0')).join('')

/** The closest colour to `fg` (same hue, only lightness moves) that reaches `target` contrast on `bg`; null if none can. */
export function fixContrast(fg: RGB, bg: RGB, target: number): RGB | null {
  const lab = toOklab(fg)
  if (Math.hypot(lab.a, lab.b) < 0.004) lab.a = lab.b = 0 // keep greys grey
  let best: RGB | null = null, bestD = Infinity
  for (const end of [0, 1]) { // try darker, then lighter; keep whichever needs the smaller change
    const at = (L: number) => fromOklab({ ...lab, L })
    if (contrast(at(end), bg) < target) continue
    let lo = lab.L, hi = end // invariant: `hi` passes
    for (let i = 0; i < 24; i++) { const mid = (lo + hi) / 2; if (contrast(at(mid), bg) >= target) hi = mid; else lo = mid }
    const c = at(hi), d = Math.abs(hi - lab.L)
    if (contrast(c, bg) >= target && d < bestD) { best = c; bestD = d }
  }
  return best
}

/** Nearest token to a colour; `exact` when it's the same colour (rounding aside), `close` when it's a sensible swap. */
export function nearestColor(c: RGB, tokens: Token[]) {
  let best: { token: Token; d: number } | null = null
  for (const t of tokens) if (t.rgb && Math.abs(t.rgb.a - c.a) < 0.02) { const d = deltaE(c, t.rgb); if (!best || d < best.d) best = { token: t, d } }
  return best && { token: best.token, d: best.d, exact: best.d < 0.6, close: best.d < 20 }
}
/** Nearest length token, or step on the `step` grid (Tailwind's --spacing; half steps below 4 steps, like p-1.5), to `px`.
 *  `close` when snapping to it is a small nudge rather than a different design. */
export function nearestLength(px: number, tokens: Token[], step?: number) {
  let best: { value: number; token?: Token } | null = null
  const consider = (value: number, token?: Token) => { if (!best || Math.abs(value - px) < Math.abs(best.value - px)) best = { value, token } }
  for (const t of tokens) if (t.px !== undefined) consider(t.px, t)
  if (step) { consider(Math.round(px / step) * step); if (Math.abs(px) < 4 * step) consider(Math.round(px / (step / 2)) * (step / 2)) }
  const b = best as { value: number; token?: Token } | null
  const d = b ? Math.abs(b.value - px) : 0
  return b && { ...b, exact: d < 0.01, close: d <= Math.max(2, Math.abs(px) * 0.15) }
}
