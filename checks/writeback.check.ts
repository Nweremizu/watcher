// node checks/writeback.check.ts: write-back edits real source files, so it gets a runnable check.
import assert from 'node:assert/strict'
import { cssToTailwind, mergeClasses } from '../src/tailwind.ts'
import { editSource, stampSource } from '../src/writeback.ts'
import { forceSelectors, muteSelectors } from '../src/states.ts'

const tw = (p: string, v: string, ver: 3 | 4 = 4) => { const r = cssToTailwind(p, v, ver); return 'cls' in r ? r.cls : `!${r.reason}` }

// spacing scale, px, arbitrary, negatives
assert.equal(tw('padding-top', '44px'), 'pt-11')
assert.equal(tw('padding-left', '6px'), 'pl-1.5')
assert.equal(tw('padding-left', '22px'), 'pl-[22px]')
assert.equal(tw('margin-top', '-8px'), '-mt-2')
assert.equal(tw('margin-top', '1px'), 'mt-px')
assert.equal(tw('gap', '12px'), 'gap-3')
assert.equal(tw('width', '100%'), 'w-full')
assert.equal(tw('width', '293.33px'), 'w-[293.33px]')
// type, colour, radius, misc
assert.equal(tw('font-size', '48px'), 'text-5xl')
assert.equal(tw('font-size', '15px'), 'text-[15px]')
assert.equal(tw('font-weight', '600'), 'font-semibold')
assert.equal(tw('color', '#ff0000'), 'text-[#ff0000]')
assert.equal(tw('background-color', 'rgb(1, 2, 3)'), 'bg-[rgb(1,2,3)]')
assert.equal(tw('border-radius', '12px'), 'rounded-xl')
assert.equal(tw('border-radius', '4px'), 'rounded-[4px]') // v3/v4 disagree on the name, so arbitrary
assert.equal(tw('opacity', '0.83', 3), 'opacity-[0.83]')
assert.equal(tw('opacity', '0.8', 3), 'opacity-80')
assert.equal(tw('display', 'none'), 'hidden')
assert.equal(tw('justify-content', 'space-between'), 'justify-between')
assert.equal(tw('box-shadow', '0 1px 2px red'), 'shadow-[0_1px_2px_red]')
assert.ok(tw('translate', '10px 0px').startsWith('!'))

// design tokens
assert.equal(tw('color', 'var(--color-brand)'), 'text-brand')
assert.equal(tw('background-color', 'var(--color-orange-500)'), 'bg-orange-500')
assert.equal(tw('color', 'var(--brand)'), 'text-(--brand)')
assert.equal(tw('color', 'var(--brand)', 3), 'text-[var(--brand)]')
assert.equal(tw('font-size', 'var(--text-lg)'), 'text-lg')
assert.equal(tw('font-size', 'var(--fs-body)'), 'text-(length:--fs-body)')
assert.equal(tw('border-radius', 'var(--radius)'), 'rounded-(--radius)')
assert.equal(tw('border-radius', 'var(--radius-card)'), 'rounded-card')
assert.equal(tw('padding-top', 'var(--spacing-gutter)'), 'pt-gutter')
assert.ok(tw('display', 'var(--x)').startsWith('!'))

// motion
assert.equal(tw('transition-duration', '0.3s'), 'duration-300')
assert.equal(tw('transition-duration', '250ms'), 'duration-250')
assert.equal(tw('transition-duration', '250ms', 3), 'duration-[250ms]')
assert.equal(tw('transition-delay', '150ms', 3), 'delay-150')
assert.ok(tw('transition-duration', '0.2s, 0.4s').startsWith('!'))
assert.equal(tw('transition-timing-function', 'cubic-bezier(0, 0, .2, 1)'), 'ease-out')
assert.equal(tw('transition-timing-function', 'linear'), 'ease-linear')
assert.equal(tw('transition-timing-function', 'cubic-bezier(0.2, 0, 0, 1)'), 'ease-[cubic-bezier(0.2,0,0,1)]')
assert.equal(tw('transition-timing-function', 'var(--ease-snappy)'), 'ease-snappy')
assert.equal(tw('transition-property', 'opacity'), 'transition-opacity')
assert.equal(tw('transition-property', 'transform, translate, scale, rotate'), 'transition-transform')
assert.equal(tw('transition-property', 'opacity, scale'), 'transition-[opacity,scale]')
assert.equal(tw('animation-duration', '1.2s'), '[animation-duration:1.2s]')
assert.equal(tw('animation-timing-function', 'var(--ease-out)'), '[animation-timing-function:var(--ease-out)]')

// merging: replaces only the same family and variant
const m = (cls: string, s: Record<string, string>, v = '') => mergeClasses(cls, s, v).className
assert.equal(m('p-4 pt-2 text-lg text-red-500', { 'padding-top': '44px' }), 'p-4 text-lg text-red-500 pt-11')
assert.equal(m('text-lg text-red-500 text-center', { color: '#000' }), 'text-lg text-center text-[#000]')
assert.equal(m('text-lg text-red-500', { 'font-size': '12px' }), 'text-red-500 text-xs')
assert.equal(m('bg-white bg-cover', { 'background-color': '#eee' }), 'bg-cover bg-[#eee]')
assert.equal(m('border border-gray-200 border-dashed', { 'border-width': '2px' }), 'border-gray-200 border-dashed border-2')
assert.equal(m('pt-2 md:pt-4 hover:pt-6', { 'padding-top': '8px' }), 'md:pt-4 hover:pt-6 pt-2')
assert.equal(m('pt-2 md:pt-4', { 'padding-top': '8px' }, 'md:'), 'pt-2 md:pt-2')
assert.equal(m('flex', { display: 'grid' }), 'grid')
// token classes replace (and are replaced by) the same family
assert.equal(m('text-lg text-[#666]', { color: 'var(--brand)' }), 'text-lg text-(--brand)')
assert.equal(m('text-lg text-(--brand)', { color: '#000' }), 'text-lg text-[#000]')
assert.equal(m('text-lg text-brand-soft', { color: 'var(--color-ink)' }), 'text-lg text-ink')
assert.equal(m('text-(length:--fs) text-red-500', { 'font-size': '16px' }), 'text-red-500 text-base')
assert.equal(m('rounded-(--radius) p-2', { 'border-radius': '8px' }), 'p-2 rounded-lg')
assert.equal(m('transition duration-150 ease-in delay-75', { 'transition-duration': '300ms', 'transition-timing-function': 'cubic-bezier(0, 0, 0.2, 1)' }), 'transition delay-75 duration-300 ease-out')
assert.equal(m('animate-spin [animation-duration:2s]', { 'animation-duration': '600ms' }), 'animate-spin [animation-duration:600ms]')

// stamping
const src = `export const A = () => (\n  <div className="p-4">\n    <h3>Hi</h3>\n    <Card title="x" />\n  </div>\n)\n`
const stamped = stampSource(src, 'App.tsx')!.toString()
assert.ok(stamped.includes('<div data-wsrc="App.tsx:2:2" className="p-4">'))
assert.ok(stamped.includes('<h3 data-wsrc="App.tsx:3:4">'))
assert.ok(stamped.includes('<Card data-wsrc-c="App.tsx:4:4" title="x" />')) // components get their call site
assert.ok(!stampSource('const a = <><Fragment><Ctx.Provider value={1}><b /></Ctx.Provider></Fragment></>', 'a.tsx')!.toString().includes('wsrc-c'))
assert.ok(stampSource('const a = <Select<number> v={1} />', 'a.tsx')!.toString().includes('<Select<number> data-wsrc-c'))

// editing: className string, added className, text, attributes
let out = editSource(src, [{ loc: '2:2', styles: { 'padding-top': '44px' } }, { loc: '3:4', styles: { color: '#f00' }, text: 'Hello there' }])
assert.ok(out.code.includes('<div className="p-4 pt-11">'), out.code)
assert.ok(out.code.includes('<h3 className="text-[#f00]">Hello there</h3>'), out.code)
out = editSource(src, [{ loc: '3:4', text: 'a {b}' }])
assert.ok(out.code.includes('<h3>{"a {b}"}</h3>'))
out = editSource(`const x = <a href="/x" className={cn("p-2", on && "bg-red-500")}>Go</a>`, [{ loc: '1:10', styles: { padding: '16px' }, attrs: { href: '/y', title: 'T' } }])
assert.ok(out.code.includes('<a title="T" href="/y" className={cn("p-4", on && "bg-red-500")}>'), out.code)
out = editSource(`const x = <div className={styles.box}>x</div>`, [{ loc: '1:10', styles: { padding: '16px' } }])
assert.equal(out.results[0].ok, false)
out = editSource(src, [{ loc: '9:9', text: 'x' }])
assert.equal(out.results[0].ok, false)

// component props at the call site
out = editSource(src, [{ loc: '4:4', props: { title: 'New', count: 3, open: true, gone: null } }])
assert.ok(out.code.includes('<Card count={3} open title="New" />'), out.code)
out = editSource(`const x = <Card title={t('a')} label='a"b' on>Hi</Card>`, [{ loc: '1:10', props: { title: 'x', label: 'q', on: false, children: 'Yo' } }])
assert.ok(out.code.includes(`<Card title={t('a')} label="q" on={false}>Yo</Card>`), out.code)
assert.deepEqual(out.results[0].skipped.map(s => s.prop), ['title'])
assert.deepEqual(out.results[0].props, ['label', 'on', 'children'])
out = editSource(src, [{ loc: '4:4', props: { title: 'say "hi" & bye' } }])
assert.ok(out.code.includes('<Card title={"say \\"hi\\" & bye"} />'), out.code)

// Motion: motion.div is stamped like a DOM element; object props are edited in place
const msrc = `import { motion } from 'motion/react'
const item = { hidden: { opacity: 0, y: 8 }, visible: { opacity: 1, y: 0, transition: { type: 'spring', bounce: 0 } } }
export const A = () => <motion.div className="p-2" variants={item} transition={{ duration: 0.3, ease: 'easeOut' }} whileTap={{ scale: 0.96 }} />
`
assert.ok(stampSource(msrc, 'M.tsx')!.toString().includes('<motion.div data-wsrc="M.tsx:3:23"'))
assert.ok(!stampSource('const a = <Motion.div />', 'a.tsx')!.toString().includes('data-wsrc="'))
out = editSource(msrc, [{ loc: '3:23', props: { 'transition.duration': 0.5, 'transition.ease': [0.2, 0, 0, 1], 'transition.repeat': '__Infinity__', 'whileTap.scale': 0.95 } }])
assert.ok(out.code.includes(`transition={{ duration: 0.5, ease: [0.2, 0, 0, 1], repeat: Infinity }}`), out.code)
assert.ok(out.code.includes(`whileTap={{ scale: 0.95 }}`), out.code)
// variants={item}: edited where the const is declared, missing keys added
out = editSource(msrc, [{ loc: '3:23', props: { 'variants.visible.transition.bounce': 0.2, 'variants.visible.transition.visualDuration': 0.4, 'variants.hidden.y': null } }])
assert.ok(out.code.includes(`visible: { opacity: 1, y: 0, transition: { type: 'spring', bounce: 0.2, visualDuration: 0.4 } }`), out.code)
assert.ok(out.code.includes(`hidden: { opacity: 0 }`), out.code)
// a new object prop, and ones Watcher won't guess at
out = editSource(msrc, [{ loc: '3:23', props: { 'animate.opacity': 1, 'className.x': 1 } }])
assert.ok(out.code.includes(`<motion.div animate={{ opacity: 1 }} className="p-2"`), out.code)
assert.deepEqual(out.results[0].skipped.map(s => s.prop), ['className.x'])
out = editSource(`const x = <motion.div transition={{ duration: d }} />`, [{ loc: '1:10', props: { 'transition.duration': 1 } }])
assert.deepEqual(out.results[0].skipped.map(s => s.prop), ['transition.duration'])

// presets: grouped new objects (one transition={{…}}, not two), div → motion.div with its import
out = editSource(`import { useState } from 'react'
export const A = () => <div className="p-2">Hi</div>
`, [{ loc: '2:23', motion: 'motion/react',
  props: { 'initial.opacity': 0, 'initial.y': 8, 'animate.opacity': 1, 'animate.y': 0, 'transition.type': 'spring', 'transition.bounce': 0 } }])
assert.ok(out.code.includes(`import { useState } from 'react'
import { motion } from 'motion/react'`), out.code)
assert.ok(out.code.includes(`<motion.div initial={{ opacity: 0, y: 8 }} animate={{ opacity: 1, y: 0 }} transition={{ type: "spring", bounce: 0 }} className="p-2">Hi</motion.div>`), out.code)
out = editSource(`import { AnimatePresence } from "motion/react"
const a = <span />
`, [{ loc: '2:10', motion: 'motion/react', props: { 'whileTap.scale': 0.96 } }])
assert.ok(out.code.includes(`import { AnimatePresence, motion } from "motion/react"`), out.code)
assert.ok(out.code.includes(`<motion.span whileTap={{ scale: 0.96 }} />`), out.code)
out = editSource(msrc, [{ loc: '3:23', props: { 'transition.type': 'spring', 'transition.bounce': 0, 'whileHover.y': -2 } }]) // already motion: no import twice
assert.equal(out.code.match(/import \{[^}]*motion/g)!.length, 1)
assert.ok(out.code.includes(`transition={{ duration: 0.3, ease: 'easeOut', type: "spring", bounce: 0 }}`), out.code)
assert.ok(out.code.includes(`whileHover={{ y: -2 }}`), out.code)
// Tailwind presets: same slot replaced, transitions unioned, `transition` kept
const add = (cls: string, c: string[]) => editSource(`const a = <b className="${cls}" />`, [{ loc: '1:10', classes: c }]).code.match(/className="([^"]*)"/)![1]
assert.equal(add('p-2 transition-shadow duration-150', ['transition-transform', 'duration-150', 'ease-out', 'active:scale-[0.96]']), 'p-2 transition-[box-shadow,transform,translate,scale,rotate] duration-150 ease-out active:scale-[0.96]')
assert.equal(add('transition hover:translate-y-1', ['transition-transform', 'hover:-translate-y-0.5']), 'transition hover:-translate-y-0.5')
assert.equal(add('', ['transition-[opacity,translate]', 'starting:opacity-0', 'starting:translate-y-2']), 'transition-[opacity,translate] starting:opacity-0 starting:translate-y-2')
assert.equal(add('transition-opacity', ['transition-transform']), 'transition-[opacity,transform,translate,scale,rotate]')

// rewriting an animation: its classes come off, the new ones go on; a prop can be removed whatever it was written as
out = editSource(`const a = <b className="p-2 transition-shadow hover:shadow-lg hover:-translate-y-0.5" />`, [{ loc: '1:10', removeClasses: ['transition-shadow', 'hover:-translate-y-0.5', 'hover:opacity-90'], classes: ['transition-[box-shadow,translate]', 'hover:-translate-y-1'] }])
assert.ok(out.code.includes('className="p-2 hover:shadow-lg transition-[box-shadow,translate] hover:-translate-y-1"'), out.code)
assert.ok(out.results[0].note?.includes('hover:opacity-90'))
out = editSource(msrc, [{ loc: '3:23', props: { whileTap: null, transition: null } }])
assert.ok(out.code.includes('<motion.div data-wsrc') === false && out.code.includes('<motion.div className="p-2" variants={item} />'), out.code)

// forced states: rewrite pseudo-classes, but not escaped class names or media features
assert.equal(forceSelectors('.btn:hover{color:red}'), '.btn[data-wforce~="hover"]{color:red}')
assert.equal(forceSelectors('.hover\:bg-x{&:hover{@media (hover:hover){color:red}}}'), '.hover\:bg-x{&[data-wforce~="hover"]{@media (hover:hover){color:red}}}')
assert.equal(forceSelectors('a:focus-visible, a:focus, .g:focus-within'), 'a[data-wforce~="focus-visible"], a[data-wforce~="focus"], .g[data-wforce~="focus-within"]')
assert.equal(forceSelectors('.focus\:ring:focus'), '.focus\:ring[data-wforce~="focus"]')

assert.equal(muteSelectors('.group:hover .group-hover\:bg-x'), '.group:not(*) .group-hover\:bg-x')
assert.equal(muteSelectors('a:not(:hover)'), 'a:not(:not(*))') // never hovered: :not(:hover) still matches
assert.equal(muteSelectors('.hover\:x'), '.hover\:x')

console.log('writeback checks ok')
