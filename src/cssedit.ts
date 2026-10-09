// Edit CSS source text: one declaration inside an @keyframes block, or one variable in Tailwind's @theme.
// Deliberately small: it only ever looks inside those two kinds of block, found by brace matching.

/** Index of the `}` that closes the `{` at `open`, skipping strings and comments. */
function closeOf(css: string, open: number) {
  let depth = 0
  for (let i = open; i < css.length; i++) {
    const c = css[i]
    if (c === '/' && css[i + 1] === '*') { i = css.indexOf('*/', i + 2); if (i < 0) return -1; i++; continue }
    if (c === '"' || c === "'") { const end = css.indexOf(c, i + 1); if (end < 0) return -1; i = end; continue }
    if (c === '{') depth++
    else if (c === '}' && --depth === 0) return i
  }
  return -1
}
const offsetKey = (sel: string) => sel.trim().toLowerCase().replace(/^from$/, '0%').replace(/^to$/, '100%').replace(/^(\d*\.?\d+)%$/, (_, n: string) => `${+n}%`)
const indentOf = (css: string, at: number) => /([ \t]*)[^\n]*$/.exec(css.slice(0, at))?.[1] ?? ''

/** Set (or with null, remove) `prop` at `offset` ("50%", "from") in `@keyframes name`. */
export function editKeyframes(css: string, name: string, offset: string, prop: string, value: string | null): { css: string } | { error: string } {
  const m = new RegExp(`@keyframes\\s+${name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\s*\\{`).exec(css)
  if (!m) return { error: `@keyframes ${name} isn’t in this file (it may come from Tailwind or an import); copy it here to change it` }
  const open = m.index + m[0].length - 1, close = closeOf(css, open)
  if (close < 0) return { error: `@keyframes ${name} isn’t closed` }
  // each keyframe block inside: "50% { … }" / "0%, 100% { … }"
  const want = offsetKey(offset)
  let i = open + 1
  while (i < close) {
    const b = css.indexOf('{', i)
    if (b < 0 || b > close) break
    const end = closeOf(css, b), sel = css.slice(i, b)
    if (sel.split(',').map(offsetKey).includes(want)) {
      const body = css.slice(b + 1, end)
      const decl = new RegExp(`(^|[;{\\s])(${prop.replace(/[-]/g, '\\-')}\\s*:\\s*)([^;}]*)(;?)`).exec(body)
      if (decl) {
        const at = b + 1 + decl.index + decl[1].length
        if (value == null) return { css: css.slice(0, at) + css.slice(at + decl[0].length - decl[1].length).replace(/^\s*/, '') }
        const v = at + decl[2].length
        return { css: css.slice(0, v) + value + css.slice(v + decl[3].length) }
      }
      if (value == null) return { css }
      const trimmed = body.replace(/\s+$/, ''), sep = trimmed && !trimmed.endsWith(';') && !trimmed.endsWith('{') ? ';' : ''
      return { css: css.slice(0, b + 1) + trimmed + `${sep} ${prop}: ${value};` + (body.endsWith('\n') || /\n\s*$/.test(body) ? body.slice(trimmed.length) : ' ') + css.slice(end) }
    }
    i = end + 1
  }
  if (value == null) return { css }
  const pad = indentOf(css, m.index) + '  '
  return { css: css.slice(0, close).replace(/\s*$/, '') + `\n${pad}${offset} { ${prop}: ${value}; }\n${indentOf(css, m.index)}` + css.slice(close) }
}

/** Replace a whole `@keyframes name { … }` block, add it at the end, or (block null) remove it. With `fresh`, a name
 *  that isn't in this file (Tailwind's own `pulse`, a package's) isn't overridden: the block gets a free name instead. */
export function setKeyframesBlock(css: string, name: string, block: string | null, fresh = false): { css: string; name: string } {
  const find = (n: string) => new RegExp(`@keyframes\\s+${n.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\s*\\{`).exec(css)
  const rename = (b: string, n: string) => b.replace(/^@keyframes\s+[\w-]+/, `@keyframes ${n}`)
  const m = find(name)
  if (m) {
    const close = closeOf(css, m.index + m[0].length - 1)
    if (close < 0) return { css, name }
    if (block == null) return { css: css.slice(0, m.index).replace(/\n+$/, '\n') + css.slice(close + 1).replace(/^\n/, ''), name }
    return { css: css.slice(0, m.index) + rename(block, name) + css.slice(close + 1), name }
  }
  if (block == null) return { css, name }
  let n = name
  if (fresh) { n = `${name}-2`; for (let i = 3; find(n); i++) n = `${name}-${i}` }
  return { css: css.replace(/\s*$/, '\n\n') + rename(block, n) + '\n', name: n }
}

/** Set a variable in the first @theme block, or add an @theme block after the imports. */
export function setThemeVar(css: string, name: string, value: string): string {
  const m = /@theme(\s+[a-z\s]+)?\s*\{/.exec(css)
  if (m) {
    const open = m.index + m[0].length - 1, close = closeOf(css, open)
    const body = css.slice(open + 1, close)
    const decl = new RegExp(`(${name.replace(/[-]/g, '\\-')}\\s*:\\s*)([^;}]*)`).exec(body)
    if (decl) { const v = open + 1 + decl.index + decl[1].length; return css.slice(0, v) + value + css.slice(v + decl[2].length) }
    const pad = indentOf(css, m.index) + '  '
    return css.slice(0, close).replace(/\s*$/, '') + `\n${pad}${name}: ${value};\n${indentOf(css, m.index)}` + css.slice(close)
  }
  const imports = [...css.matchAll(/^@import[^;]*;[^\n]*$/gm)].at(-1)
  const block = `@theme {\n  ${name}: ${value};\n}\n`
  if (!imports) return block + '\n' + css
  const at = imports.index! + imports[0].length
  return css.slice(0, at) + '\n\n' + block + css.slice(at).replace(/^\n/, '')
}
