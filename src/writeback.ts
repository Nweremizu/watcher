// Edit JSX source in place: className (via Tailwind), static text and attributes of one element,
// found by the `line:col` the Vite plugin stamped on it. Uses a real parser, never regexes on code.
import { parse } from '@babel/parser'
import MagicString from 'magic-string'
import { addClasses, mergeClasses, type Mapped, type Skipped, type TwVersion } from './tailwind.ts'

export type ElementEdit = {
  loc: string // "line:col" of the element's `<`
  styles?: Record<string, string>
  text?: string
  attrs?: Record<string, string | null>
  variant?: string // Tailwind variant for responsive / state edits, e.g. 'md:' or 'hover:'
  props?: Record<string, unknown> // component props, written where the component is used; null removes one.
                                   // A dotted name edits inside an object prop: 'transition.duration'
  classes?: string[] // utilities to add (an animation preset); ones of the same kind and variant are replaced
  removeClasses?: string[] // utilities to take off first (the classes behind an animation being rewritten)
  motion?: string // make a plain element a motion one (<div> → <motion.div>), importing `motion` from this package
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
/** A copy of `o` with `path` set. */
const setIn = (o: unknown, path: string[], v: unknown): unknown =>
  !path.length ? v : { ...(o && typeof o === 'object' ? o : {}), [path[0]]: setIn((o as Record<string, unknown> | undefined)?.[path[0]], path.slice(1), v) }
type Leaf = [path: string[], value: unknown]
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
  let needMotion = '' // a package to import `motion` from, once an element has become motion.*

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
    /** New keys for an object, built once: several leaves under a missing parent become one nested object. */
    const build = (ls: Leaf[]) => ls.reduce<unknown>((acc, [p, v]) => (v == null ? acc : setIn(acc, p, v)), undefined)
    const removeProp = (obj: Obj, prop: Obj['properties'][number]) => { // take the comma with it: the one after, or for the last key the one before
      const ps = obj.properties, i = ps.indexOf(prop)
      if (ps[i + 1]) ms.remove(prop.start, ps[i + 1].start); else if (ps[i - 1]) ms.remove(ps[i - 1].end, prop.end); else ms.remove(prop.start, prop.end)
    }
    /** Write leaves (paths relative to `obj`) into an object literal. Returns why it couldn't, or null. */
    const into = (obj: Obj, leaves: Leaf[], at: string): string | null => {
      const groups = new Map<string, Leaf[]>()
      for (const [p, v] of leaves) groups.set(p[0], [...(groups.get(p[0]) ?? []), [p.slice(1), v]])
      const added: string[] = []
      for (const [key, ls] of groups) {
        const prop = obj.properties.find(p => p.type === 'ObjectProperty' && !p.computed && (p.key.name ?? p.key.value) === key)
        const here = `${at}.${key}`, own = ls.find(([p]) => !p.length)
        if (!prop) { const v = own ? own[1] : build(ls); if (v != null) added.push(`${keyText(key)}: ${jsValue(v)}`); continue }
        if (own) {
          if (!isPlain(prop.value)) return `${here} is set by an expression; edit it by hand`
          if (own[1] == null) removeProp(obj, prop); else ms.overwrite(prop.value.start, prop.value.end, jsValue(own[1]))
          continue
        }
        const next = asObject(prop.value)
        if (!next) return `${here} isn’t an object written in this file; edit it by hand`
        const err = into(next, ls, here)
        if (err) return err
      }
      if (added.length) { const tail = obj.properties.at(-1); if (tail) ms.appendLeft(tail.end, `, ${added.join(', ')}`); else ms.overwrite(obj.start, obj.end, `{ ${added.join(', ')} }`) }
      return null
    }
    /** Set paths inside the object prop `name` (transition={{ … }}, or a const it names), adding what's missing. */
    const setObject = (name: string, leaves: Leaf[]): string | null => {
      const a = attrOf(name)
      if (!a) { const v = build(leaves); if (v !== undefined) ms.appendLeft(afterName(op), ` ${name}={${jsValue(v)}}`); return null }
      const obj = a.value?.type === 'JSXExpressionContainer' ? asObject(a.value.expression) : null
      return obj ? into(obj, leaves, name) : `${name} isn’t an object written in this file; edit it by hand`
    }
    const writeText = (t: string) => {
      const kids = el.children
      if (!kids.length || !kids.every(k => k.type === 'JSXText')) return 'text mixes in expressions or elements; edit it by hand'
      // plain JSX text when safe, otherwise a string expression
      const safe = /^[^{}<>\n]*$/.test(t) && t === t.trim()
      ms.overwrite(kids[0].start, kids[kids.length - 1].end, safe ? t : `{${JSON.stringify(t)}}`)
      return null
    }

    if (e.motion && op.name.type === 'JSXIdentifier') {
      if (!isIntrinsic(op)) { r.ok = false; r.error = 'only DOM elements can become motion elements'; continue }
      const tag = `motion.${op.name.name}`, close = (el as El & { closingElement?: { name: N } | null }).closingElement
      ms.overwrite(op.name.start, op.name.end, tag, { contentOnly: true })
      if (close) ms.overwrite(close.name.start, close.name.end, tag, { contentOnly: true })
      needMotion = e.motion
      r.note = `now <${tag}>`
    }

    if ((e.styles && Object.keys(e.styles).length) || e.classes?.length || e.removeClasses?.length) {
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
      let base = before
      if (e.removeClasses?.length) {
        const gone = new Set(e.removeClasses), tokens = before.split(/\s+/).filter(Boolean)
        const missing = e.removeClasses.filter(c => !tokens.includes(c))
        if (missing.length) r.note = `${missing.join(' ')} ${missing.length === 1 ? 'isn’t' : 'aren’t'} in this className (it comes from elsewhere); left as is`
        base = tokens.filter(t => !gone.has(t)).join(' ')
      }
      const m = mergeClasses(base, e.styles ?? {}, e.variant ?? '', ver)
      if (e.classes?.length) m.className = addClasses(m.className, e.classes)
      r.before = before; r.after = m.className; r.mapped = m.mapped; r.skipped = m.skipped
      if (m.className !== before) {
        if (!lit) ms.appendLeft(afterName(op), ` className="${m.className}"`)
        else if (lit.type === 'TemplateLiteral') ms.overwrite(lit.start + 1, lit.end - 1, m.className)
        else { const q = code[lit.start]; ms.overwrite(lit.start, lit.end, q + m.className + q) }
      }
    }

    if (e.attrs) for (const [name, value] of Object.entries(e.attrs)) setAttr(name, value)

    const deep = new Map<string, Leaf[]>() // dotted props, grouped by the prop they live in
    if (e.props) for (const [name, value] of Object.entries(e.props)) {
      const skip = (reason: string) => r.skipped.push({ prop: name, value: String(value), reason })
      if (name.includes('.')) {
        const [head, ...rest] = name.split('.')
        deep.set(head, [...(deep.get(head) ?? []), [rest, value]])
        continue
      } else if (name === 'children') {
        if (typeof value !== 'string') { skip('only text children are written'); continue }
        const err = writeText(value)
        if (err) { skip(err); continue }
      } else if (value == null) {
        setAttr(name, null) // removing a prop works whatever it was written as
      } else {
        if (!['string', 'number', 'boolean'].includes(typeof value)) { skip('only text, numbers and booleans are written'); continue }
        const a = attrOf(name)
        if (a?.value && !isLiteral(a.value)) { skip('set by an expression in your code; edit it by hand'); continue }
        setAttr(name, value)
      }
      ;(r.props ??= []).push(name)
    }
    for (const [head, leaves] of deep) {
      const err = setObject(head, leaves)
      for (const [p, v] of leaves) {
        const name = [head, ...p].join('.')
        if (err) r.skipped.push({ prop: name, value: String(v), reason: err }); else (r.props ??= []).push(name)
      }
    }

    if (e.text != null) {
      const err = writeText(e.text)
      if (err) { r.ok = false; r.error = err; continue }
      r.text = true
    }
  }
  if (needMotion) importMotion(ast, code, ms, needMotion)
  return { code: ms.toString(), results }
}

/** Make sure `motion` is imported: reuse an import from the package if there is one, else add a line after the imports. */
function importMotion(ast: N, code: string, ms: MagicString, pkg: string) {
  type Spec = N & { local: { name: string } }
  type Imp = N & { source: N & { value: string }; specifiers: Spec[]; importKind?: string }
  const imports = ((ast as N & { program: { body: N[] } }).program.body).filter(n => n.type === 'ImportDeclaration') as Imp[]
  if (imports.some(i => i.specifiers.some(s => s.local.name === 'motion'))) return
  const same = imports.find(i => i.source.value === pkg && i.importKind !== 'type' && i.specifiers.at(-1)?.type === 'ImportSpecifier')
  if (same) { ms.appendLeft(same.specifiers.at(-1)!.end, ', motion'); return }
  const q = imports[0] ? code[imports[0].source.start] : "'"
  const line = `import { motion } from ${q}${pkg}${q}`
  if (imports.length) ms.appendLeft(imports.at(-1)!.end, `\n${line}`); else ms.prepend(`${line}\n`)
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
