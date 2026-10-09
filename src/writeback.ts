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
  variant?: string // Tailwind variant for responsive / state edits, e.g. 'md:' or 'hover:'
  props?: Record<string, unknown> // component props, written where the component is used; null removes one.
                                   // A dotted name edits inside an object prop: 'transition.duration'
}
export type EditResult = {
  loc: string; ok: boolean; error?: string; note?: string
  before?: string; after?: string; mapped: Mapped[]; skipped: Skipped[]; text?: boolean; props?: string[]; variant?: string
}

// minimal Babel AST shapes we touch
type Pos = { line: number; column: number }
type N = { type: string; start: number; end: number; loc: { start: Pos }; [k: string]: unknown }
type Attr = N & { name: N & { name: string }; value: (N & { value?: string; expression?: N }) | null }
type Opening = N & { name: N & { name?: string; property?: { name: string } }; attributes: Attr[]; typeArguments?: N; typeParameters?: N }
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

// <div>, and Motion's <motion.div> / <m.div>: they render that DOM element and pass data-* through to it
const isIntrinsic = (o: Opening) => (o.name.type === 'JSXIdentifier' && /^[a-z]/.test(o.name.name ?? '')) ||
  (o.name.type === 'JSXMemberExpression' && /^(motion|m)$/.test((o.name as unknown as { object: { name?: string } }).object.name ?? '') && /^[a-z]/.test(o.name.property?.name ?? ''))
/** Where a new attribute goes: after the tag name and any `<Select<T>` type arguments. */
const afterName = (o: Opening) => (o.typeArguments ?? o.typeParameters)?.end ?? o.name.end
/** `="text"` when that's safe in JSX, else `={expression}`; `true` becomes a bare attribute. */
const jsxValue = (v: unknown) => (v === true ? '' : typeof v === 'string' && !/["&\n]/.test(v) ? `="${v}"` : `={${JSON.stringify(v)}}`)
const LITERAL = /^(String|Numeric|Boolean|Null)Literal$/
// JS (not JSX) values, for inside objects: transition={{ type: "spring", ease: [0.2, 0, 0, 1], repeat: Infinity }}
const keyText = (k: string) => (/^[A-Za-z_$][\w$]*$/.test(k) ? k : JSON.stringify(k))
const INF = '__Infinity__' // JSON can't carry Infinity, so the overlay sends this instead
const jsValue = (v: unknown): string =>
  v === INF || v === Infinity ? 'Infinity'
  : Array.isArray(v) ? `[${v.map(jsValue).join(', ')}]`
  : v && typeof v === 'object' ? `{ ${Object.entries(v).map(([k, x]) => `${keyText(k)}: ${jsValue(x)}`).join(', ')} }`
  : JSON.stringify(v)
type Obj = N & { properties: (N & { key: N & { name?: string; value?: string }; value: N; computed?: boolean })[] }
const isPlain = (v: N & { elements?: N[]; expressions?: N[]; operator?: string; argument?: N; name?: string }): boolean =>
  LITERAL.test(v.type) || (v.type === 'Identifier' && v.name === 'Infinity') ||
  (v.type === 'UnaryExpression' && v.operator === '-' && v.argument?.type === 'NumericLiteral') ||
  (v.type === 'TemplateLiteral' && !v.expressions?.length) || (v.type === 'ArrayExpression' && !!v.elements?.every(e => e && isPlain(e)))
const isLiteral = (v: N & { expression?: N & { expressions?: N[] } }) =>
  LITERAL.test(v.type) || (v.type === 'JSXExpressionContainer' && !!v.expression &&
    (LITERAL.test(v.expression.type) || (v.expression.type === 'TemplateLiteral' && !v.expression.expressions?.length)))

export function editSource(code: string, edits: ElementEdit[], ver: TwVersion = 4) {
  const ast = parseJSX(code)
  const byLoc = new Map<string, El>()
  // objects declared once in this file (const variants = { … }), so variants={variants} can be edited where it's defined
  const consts = new Map<string, N | null>()
  walk(ast, n => {
    if (n.type === 'JSXElement') byLoc.set(`${n.loc.start.line}:${n.loc.start.column}`, n as El)
    const d = n as N & { id?: N & { name?: string }; init?: N }
    if (n.type === 'VariableDeclarator' && d.id?.type === 'Identifier' && d.init) consts.set(d.id.name!, consts.has(d.id.name!) ? null : d.init)
  })
  const asObject = (n: N | undefined | null): Obj | null => {
    const x = n?.type === 'TSAsExpression' || n?.type === 'TSSatisfiesExpression' ? (n as N & { expression: N }).expression : n
    if (x?.type === 'ObjectExpression') return x as Obj
    if (x?.type === 'Identifier') return asObject(consts.get((x as N & { name: string }).name))
    return null
  }
  const ms = new MagicString(code)
  const results: EditResult[] = []

  for (const e of edits) {
    const r: EditResult = { loc: e.loc, variant: e.variant, ok: true, mapped: [], skipped: [] }
    results.push(r)
    const el = byLoc.get(e.loc)
    if (!el) { r.ok = false; r.error = 'element not found at this position (file changed? reload the page)'; continue }
    const op = el.openingElement
    const attrOf = (name: string) => op.attributes.find(a => a.type === 'JSXAttribute' && a.name.name === name)
    const setAttr = (name: string, value: unknown) => {
      const a = attrOf(name)
      if (value == null) { if (a) ms.remove(a.start - 1, a.end); return } // drop the attribute and its leading space
      const v = jsxValue(value)
      if (!a) ms.appendLeft(afterName(op), ` ${name}${v}`)
      else if (a.end > a.name.end) { if (v) ms.overwrite(a.name.end, a.end, v); else ms.remove(a.name.end, a.end) }
      else if (v) ms.appendLeft(a.end, v)
    }
    /** Set `path` inside the object prop `name`, adding whatever keys are missing. Returns why it couldn't, or null. */
    const setDeep = (name: string, path: string[], value: unknown): string | null => {
      const nest = (keys: string[]): unknown => keys.reduceRight<unknown>((acc, k) => ({ [k]: acc }), value)
      const a = attrOf(name)
      if (!a) { if (value != null) ms.appendLeft(afterName(op), ` ${name}={${jsValue(nest(path))}}`); return null }
      let obj = a.value?.type === 'JSXExpressionContainer' ? asObject(a.value.expression) : null
      if (!obj) return `${name} isn’t an object written in this file; edit it by hand`
      for (let i = 0; i < path.length; i++) {
        const prop = obj.properties.find(p => p.type === 'ObjectProperty' && !p.computed && (p.key.name ?? p.key.value) === path[i])
        const last = i === path.length - 1
        if (!prop) {
          if (value == null) return null // nothing to remove
          const text = `${keyText(path[i])}: ${jsValue(nest(path.slice(i + 1)))}`
          const tail = obj.properties.at(-1)
          if (tail) ms.appendLeft(tail.end, `, ${text}`); else ms.overwrite(obj.start, obj.end, `{ ${text} }`)
          return null
        }
        if (last) {
          if (!isPlain(prop.value)) return `${path.join('.')} is set by an expression; edit it by hand`
          if (value == null) { // take the comma with it: the one after, or for the last key the one before
            const ps = obj.properties, i = ps.indexOf(prop)
            if (ps[i + 1]) ms.remove(prop.start, ps[i + 1].start); else if (ps[i - 1]) ms.remove(ps[i - 1].end, prop.end); else ms.remove(prop.start, prop.end)
          }
          else ms.overwrite(prop.value.start, prop.value.end, jsValue(value))
          return null
        }
        const next = asObject(prop.value)
        if (!next) return `${path.slice(0, i + 1).join('.')} isn’t an object written in this file; edit it by hand`
        obj = next
      }
      return null
    }
    const writeText = (t: string) => {
      const kids = el.children
      if (!kids.length || !kids.every(k => k.type === 'JSXText')) return 'text mixes in expressions or elements; edit it by hand'
      // plain JSX text when safe, otherwise a string expression
      const safe = /^[^{}<>\n]*$/.test(t) && t === t.trim()
      ms.overwrite(kids[0].start, kids[kids.length - 1].end, safe ? t : `{${JSON.stringify(t)}}`)
      return null
    }

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
        if (!lit) ms.appendLeft(afterName(op), ` className="${m.className}"`)
        else if (lit.type === 'TemplateLiteral') ms.overwrite(lit.start + 1, lit.end - 1, m.className)
        else { const q = code[lit.start]; ms.overwrite(lit.start, lit.end, q + m.className + q) }
      }
    }

    if (e.attrs) for (const [name, value] of Object.entries(e.attrs)) setAttr(name, value)

    if (e.props) for (const [name, value] of Object.entries(e.props)) {
      const skip = (reason: string) => r.skipped.push({ prop: name, value: String(value), reason })
      if (name.includes('.')) {
        const [head, ...rest] = name.split('.')
        const err = setDeep(head, rest, value)
        if (err) { skip(err); continue }
      } else if (name === 'children') {
        if (typeof value !== 'string') { skip('only text children are written'); continue }
        const err = writeText(value)
        if (err) { skip(err); continue }
      } else {
        if (value != null && !['string', 'number', 'boolean'].includes(typeof value)) { skip('only text, numbers and booleans are written'); continue }
        const a = attrOf(name)
        if (a?.value && !isLiteral(a.value)) { skip('set by an expression in your code; edit it by hand'); continue }
        setAttr(name, value)
      }
      ;(r.props ??= []).push(name)
    }

    if (e.text != null) {
      const err = writeText(e.text)
      if (err) { r.ok = false; r.error = err; continue }
      r.text = true
    }
  }
  return { code: ms.toString(), results }
}

const SKIP_COMPONENT = /^(Fragment|Provider|Consumer)$/ // Fragment rejects extra props; context wrappers render nothing
const tagName = (o: Opening) => (o.name.type === 'JSXIdentifier' ? o.name.name : o.name.type === 'JSXMemberExpression' ? o.name.property?.name : undefined)

/** Inject data-wsrc="file:line:col" on every intrinsic element (what the overlay reads to find source),
 *  and data-wsrc-c on component elements (a prop React keeps on the fiber: where to write that component's props). */
export function stampSource(code: string, file: string) {
  if (code.includes('@watcher-ignore')) return null
  let ast: N
  try { ast = parseJSX(code) } catch { return null }
  const ms = new MagicString(code)
  let n = 0
  walk(ast, node => {
    if (node.type !== 'JSXElement') return
    const op = (node as El).openingElement
    const intrinsic = isIntrinsic(op), attr = intrinsic ? 'data-wsrc' : 'data-wsrc-c'
    if (!intrinsic && SKIP_COMPONENT.test(tagName(op) ?? 'Fragment')) return
    if (op.attributes.some(a => a.type === 'JSXAttribute' && a.name.name === attr)) return
    ms.appendLeft(afterName(op), ` ${attr}="${file}:${node.loc.start.line}:${node.loc.start.column}"`)
    n++
  })
  return n ? ms : null
}
