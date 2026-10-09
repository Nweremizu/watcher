// Edit JSX source in place: className (via Tailwind), static text and attributes of one element,
// found by the `line:col` the Vite plugin stamped on it. Uses a real parser, never regexes on code.
import { parse } from '@babel/parser'
import MagicString from 'magic-string'
import { mergeClasses, type Mapped, type Skipped, type TwVersion } from './tailwind.ts'

export type ElementEdit = {
  loc: string // "line:col" of the element's `<`
  styles?: Record<string, string>
  text?: string
  attrs?: Record<string, string | null>
  variant?: string // Tailwind variant for responsive edits, e.g. 'md:'
}
export type EditResult = {
  loc: string; ok: boolean; error?: string; note?: string
  before?: string; after?: string; mapped: Mapped[]; skipped: Skipped[]; text?: boolean
}

// minimal Babel AST shapes we touch
type Pos = { line: number; column: number }
type N = { type: string; start: number; end: number; loc: { start: Pos }; [k: string]: unknown }
type Attr = N & { name: N & { name: string }; value: (N & { value?: string; expression?: N }) | null }
type Opening = N & { name: N & { name?: string }; attributes: Attr[] }
type El = N & { openingElement: Opening; children: (N & { value?: string })[] }

export const parseJSX = (code: string) =>
  parse(code, { sourceType: 'module', plugins: ['jsx', 'typescript'], errorRecovery: true }) as unknown as N

/** Depth-first walk over every AST node. */
export function walk(node: unknown, fn: (n: N) => void) {
  if (!node || typeof node !== 'object') return
  if (Array.isArray(node)) { for (const c of node) walk(c, fn); return }
  const n = node as N
  if (typeof n.type === 'string') fn(n)
  for (const k in n) if (k !== 'loc' && k !== 'leadingComments' && k !== 'trailingComments' && k !== 'extra') walk(n[k], fn)
}

const isIntrinsic = (o: Opening) => o.name.type === 'JSXIdentifier' && /^[a-z]/.test(o.name.name ?? '')

export function editSource(code: string, edits: ElementEdit[], ver: TwVersion = 4) {
  const ast = parseJSX(code)
  const byLoc = new Map<string, El>()
  walk(ast, n => { if (n.type === 'JSXElement') byLoc.set(`${n.loc.start.line}:${n.loc.start.column}`, n as El) })
  const ms = new MagicString(code)
  const results: EditResult[] = []

  for (const e of edits) {
    const r: EditResult = { loc: e.loc, ok: true, mapped: [], skipped: [] }
    results.push(r)
    const el = byLoc.get(e.loc)
    if (!el) { r.ok = false; r.error = 'element not found at this position (file changed? reload the page)'; continue }
    const op = el.openingElement

    if (e.styles && Object.keys(e.styles).length) {
      const attr = op.attributes.find(a => a.type === 'JSXAttribute' && a.name.name === 'className')
      // where the class string lives: a plain string, a static template, or the first string passed to cn()/clsx()
      let lit: (N & { value?: string; quasis?: (N & { value: { raw: string } })[] }) | null = null
      if (attr?.value?.type === 'StringLiteral') lit = attr.value
      else if (attr?.value?.type === 'JSXExpressionContainer') {
        const x = attr.value.expression as N & { arguments?: N[]; expressions?: N[] }
        if (x.type === 'StringLiteral') lit = x
        else if (x.type === 'TemplateLiteral' && !x.expressions?.length) lit = x
        else if (x.type === 'CallExpression' && x.arguments?.[0]?.type === 'StringLiteral') { lit = x.arguments[0]; r.note = 'edited the first string passed to the class helper' }
      }
      if (attr && !lit) { r.ok = false; r.error = 'className is computed at runtime; edit it by hand'; continue }
      const before = lit ? (lit.type === 'TemplateLiteral' ? lit.quasis![0].value.raw : lit.value ?? '') : ''
      const m = mergeClasses(before, e.styles, e.variant ?? '', ver)
      r.before = before; r.after = m.className; r.mapped = m.mapped; r.skipped = m.skipped
      if (m.className !== before) {
        if (!lit) ms.appendLeft(op.name.end, ` className="${m.className}"`)
        else if (lit.type === 'TemplateLiteral') ms.overwrite(lit.start + 1, lit.end - 1, m.className)
        else { const q = code[lit.start]; ms.overwrite(lit.start, lit.end, q + m.className + q) }
      }
    }

    if (e.attrs) for (const [name, value] of Object.entries(e.attrs)) {
      const a = op.attributes.find(x => x.type === 'JSXAttribute' && x.name.name === name)
      if (value == null) { if (a) ms.remove(a.start - 1, a.end); continue } // drop the attribute and its leading space
      const lit = JSON.stringify(value)
      if (!a) ms.appendLeft(op.name.end, ` ${name}=${lit}`)
      else if (a.value) ms.overwrite(a.value.start, a.value.end, lit)
      else ms.appendLeft(a.end, `=${lit}`)
    }

    if (e.text != null) {
      const kids = el.children
      if (!kids.length || !kids.every(k => k.type === 'JSXText')) { r.ok = false; r.error = 'text mixes in expressions or elements; edit it by hand'; continue }
      // plain JSX text when safe, otherwise a string expression
      const t = e.text
      const safe = /^[^{}<>\n]*$/.test(t) && t === t.trim()
      ms.overwrite(kids[0].start, kids[kids.length - 1].end, safe ? t : `{${JSON.stringify(t)}}`)
      r.text = true
    }
  }
  return { code: ms.toString(), results }
}

/** Inject data-wsrc="file:line:col" on every intrinsic element (what the overlay reads to find source). */
export function stampSource(code: string, file: string) {
  if (code.includes('@watcher-ignore')) return null
  let ast: N
  try { ast = parseJSX(code) } catch { return null }
  const ms = new MagicString(code)
  let n = 0
  walk(ast, node => {
    if (node.type !== 'JSXElement') return
    const op = (node as El).openingElement
    if (!isIntrinsic(op) || op.attributes.some(a => a.type === 'JSXAttribute' && a.name.name === 'data-wsrc')) return
    ms.appendLeft(op.name.end, ` data-wsrc="${file}:${node.loc.start.line}:${node.loc.start.column}"`)
    n++
  })
  return n ? ms : null
}
