// node checks/css.check.ts: these write the user's CSS files, so they get a runnable check.
import assert from 'node:assert/strict'
import { editKeyframes, setThemeVar } from '../src/cssedit.ts'

const kf = `.a { color: red; }
@keyframes float {
  0%, 100% { translate: 0 0; }
  50% { translate: 0 -3px; opacity: 1 }
}
`
const ok = (r: { css: string } | { error: string }) => { assert.ok('css' in r, 'error' in r ? r.error : ''); return (r as { css: string }).css }

// change, add, remove a declaration; offsets match from/to and shared selectors
assert.ok(ok(editKeyframes(kf, 'float', '50%', 'translate', '0 -6px')).includes('50% { translate: 0 -6px; opacity: 1 }'))
assert.ok(ok(editKeyframes(kf, 'float', '50%', 'scale', '1.1')).includes('50% { translate: 0 -3px; opacity: 1; scale: 1.1; }'))
assert.ok(ok(editKeyframes(kf, 'float', '50%', 'opacity', null)).includes('50% { translate: 0 -3px; }'))
assert.ok(ok(editKeyframes(kf, 'float', 'to', 'translate', '0 1px')).includes('0%, 100% { translate: 0 1px; }'))
// a keyframe that doesn't exist yet is added before the closing brace
assert.ok(ok(editKeyframes(kf, 'float', '25%', 'opacity', '0.5')).includes('  25% { opacity: 0.5; }\n}'))
// leaves everything else alone
assert.ok(ok(editKeyframes(kf, 'float', '50%', 'translate', '0 -6px')).startsWith('.a { color: red; }\n@keyframes float {\n  0%, 100% { translate: 0 0; }'))
assert.ok('error' in editKeyframes(kf, 'pulse', '50%', 'opacity', '0.5'))

// @theme: replace, add, or create after the imports
const theme = `@import "tailwindcss";\n@theme {\n  --ease-snappy: cubic-bezier(0.2, 0, 0, 1);\n}\n.a {}\n`
assert.ok(setThemeVar(theme, '--ease-snappy', 'linear').includes('--ease-snappy: linear;'))
assert.ok(setThemeVar(theme, '--ease-soft', 'ease').includes('  --ease-snappy: cubic-bezier(0.2, 0, 0, 1);\n  --ease-soft: ease;\n}'))
assert.equal(setThemeVar('@import "tailwindcss";\n.a {}\n', '--ease-soft', 'ease'), '@import "tailwindcss";\n\n@theme {\n  --ease-soft: ease;\n}\n.a {}\n')
assert.equal(setThemeVar('.a {}\n', '--x', '1'), '@theme {\n  --x: 1;\n}\n\n.a {}\n')

console.log('css checks ok')
