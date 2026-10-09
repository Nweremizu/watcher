// node checks/writeback.check.ts: write-back edits real source files, so it gets a runnable check.
import assert from 'node:assert/strict'
import { cssToTailwind, mergeClasses } from '../src/tailwind.ts'
import { editSource, stampSource } from '../src/writeback.ts'

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

// stamping
const src = `export const A = () => (\n  <div className="p-4">\n    <h3>Hi</h3>\n    <Card title="x" />\n  </div>\n)\n`
const stamped = stampSource(src, 'App.tsx')!.toString()
assert.ok(stamped.includes('<div data-wsrc="App.tsx:2:2" className="p-4">'))
assert.ok(stamped.includes('<h3 data-wsrc="App.tsx:3:4">'))
assert.ok(!stamped.includes('<Card data-wsrc')) // components aren't DOM nodes

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

console.log('writeback checks ok')
