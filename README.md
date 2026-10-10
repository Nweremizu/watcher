<p align="center"><img src="assets/logo.svg" width="64" height="64" alt="Watcher"></p>

<h1 align="center">@nweremizu/watcher-ui</h1>

<p align="center">Open your running React app like a design file.</p>

Rulers and guides, live style editing, a free canvas, an SVG editor, design-system extraction and a profiler, all on top of the real page. Dev-only: production builds ship none of it.

## Contents

- [Getting started](#getting-started)
- [When Watcher runs](#when-watcher-runs): dev only, turning it off, environment variables
- [Keyboard shortcut](#keyboard-shortcut): changing the key, and how to write any key
- [Options](#options)
- [Write edits back to your code](#write-edits-back-to-your-code-tailwind)
- [Component props](#component-props) · [Forced states](#forced-states) · [Checks: tokens & accessibility](#checks-tokens--accessibility) · [Sessions](#sessions)
- [What it costs your app](#what-it-costs-your-app) · [Features](#features)

## Getting started

**1. Install** it as a dev dependency:

```bash
npm i -D @nweremizu/watcher-ui
```

**2. Render it** once, next to your app:

```tsx
// main.tsx
import { Watcher } from '@nweremizu/watcher-ui'

root.render(
  <>
    <App />
    <Watcher />
  </>,
)
```

**3. Add the Vite plugin** (optional, but it's what lets edits go back into your code, and lets you edit component props live):

```ts
// vite.config.ts
import { watcher } from '@nweremizu/watcher-ui/vite'

export default defineConfig({
  plugins: [watcher(), react(), tailwindcss()],
})
```

**4. Open it.** Start your dev server and press **Alt+D** (**⌥D** on a Mac), or click the button in the bottom-right corner. Press the same keys again to close it.

Not mounting with React components? `mountWatcher(options)` does the same as `<Watcher />` and returns a cleanup function.

**Requirements:** React 18 or later. The Vite plugin needs Vite 5 or later and Node 18 or later. Writing edits back to code expects Tailwind CSS (v3 or v4); everything else works with any styling.

## When Watcher runs

**Watcher runs in development only, automatically.** You don't need to wrap it in an `if`.

- **In production builds it doesn't exist.** The package has a `production` export condition, so Vite and webpack swap it for an empty module and none of the overlay is in your bundle. With other bundlers, a `process.env.NODE_ENV === 'production'` check keeps it from loading.
- **The Vite plugin only runs on the dev server** (`apply: 'serve'`). It does nothing during `vite build`.

That means `enabled` and the environment variables below can only turn Watcher **off** during development, or leave it on. Nothing can turn it on in a production build. That's deliberate.

### Turning it off in code

```tsx
<Watcher enabled={false} />
```

Or from your own environment variable. Watcher can't read your env vars itself (every bundler exposes them differently), so pass the value in:

```tsx
// Vite: VITE_WATCHER=false in .env.local turns it off
<Watcher enabled={import.meta.env.VITE_WATCHER !== 'false'} />

// Next.js: NEXT_PUBLIC_WATCHER=false in .env.local
<Watcher enabled={process.env.NEXT_PUBLIC_WATCHER !== 'false'} />
```

### Turning it off with an environment variable (Vite plugin)

If you use `@nweremizu/watcher-ui/vite`, it reads two variables. Put them in your shell or in any `.env` file next to your Vite root (`.env.local` keeps them to your machine):

| Variable | Values | Effect |
|---|---|---|
| `WATCHER` | `false`, `0`, `off` or `no` turns it off; `true`, `1`, `on` or `yes` turns it on | Overrides `enabled` |
| `WATCHER_SHORTCUT` | a shortcut, e.g. `Ctrl+Shift+K` | Overrides `shortcut` |

```bash
# one-off, from the shell
WATCHER=false npm run dev
```

```ini
# .env.local (keep it out of git)
WATCHER_SHORTCUT=Ctrl+Shift+K
```

These variables beat the props on purpose. That way one developer can switch Watcher off, or move its key, without changing code the team shares. Restart the dev server after editing a `.env` file.

### Which setting wins

| What | Highest priority first |
|---|---|
| **On / off** | production build (always off) → `WATCHER` env var → `enabled` prop → on |
| **Shortcut** | the key you recorded in Settings (this browser only) → `WATCHER_SHORTCUT` env var → `shortcut` prop → `Alt+D` |

When Watcher is off, it renders nothing: no button, no key listener, and the overlay code is never downloaded.

## Keyboard shortcut

The default is **Alt+D** (**⌥D** on a Mac). There are three ways to change it.

**For everyone on the project**, in code:

```tsx
<Watcher shortcut="Mod+Shift+K" />
```

**For your machine only**, with `WATCHER_SHORTCUT=Mod+Shift+K` in `.env.local` (needs the Vite plugin, see above).

**For your browser only**, without writing anything: open Watcher → the gear icon at the bottom of the left sidebar → **Shortcut**. Click the button, press the keys you want, and that's it. Press **Esc** to cancel, and use the ↺ button to go back to the app's shortcut. The panel also shows the exact `shortcut="…"` text for what you pressed, ready to paste into your code. That's the easiest way to get a key's name right.

### How to write a shortcut

Write the modifiers first and the key last, joined with `+`. Upper or lower case and spaces don't matter, so `Ctrl+Shift+K`, `ctrl+shift+k` and `Ctrl + Shift + K` are the same.

**Modifiers**

| Write | Means | Also accepted |
|---|---|---|
| `Ctrl` | Control | `Control`, `Ctl` |
| `Alt` | Alt, or Option (⌥) on a Mac | `Option`, `Opt` |
| `Shift` | Shift | |
| `Meta` | ⌘ Command on a Mac, the ⊞ Windows key on Windows | `Cmd`, `Command`, `Win`, `Super` |
| `Mod` | **⌘ on a Mac, Ctrl everywhere else.** Use this when your team mixes Macs and PCs. | |

**Keys**

| Key | Write |
|---|---|
| Letters | `A` … `Z` |
| Numbers (top row) | `0` … `9` |
| Function keys | `F1` … `F24` |
| Arrows | `Up`, `Down`, `Left`, `Right` (or `ArrowUp` …) |
| Space, Enter, Tab, Esc | `Space`, `Enter`, `Tab`, `Esc` |
| Editing and navigation | `Backspace`, `Delete`, `Insert`, `Home`, `End`, `PageUp`, `PageDown` |
| `.` `,` `/` `;` `'` | the character itself, or `Period`, `Comma`, `Slash`, `Semicolon`, `Quote` |
| `[` `]` `\` | the character itself, or `BracketLeft`, `BracketRight`, `Backslash` |
| `-` `=` `` ` `` | the character itself, or `Minus`, `Equal`, `Backquote` |
| `+` | `Plus` (it's the `=` key, so `Ctrl+Plus` is the same as `Ctrl+=`) |
| Number pad | `Numpad0` … `Numpad9`, `NumpadAdd`, `NumpadEnter` … |

Any [`KeyboardEvent.code`](https://developer.mozilla.org/docs/Web/API/UI_Events/Keyboard_event_code_values) value works as the key too, such as `KeyD`, `Digit1` or `Numpad5`.

**Examples**

| Shortcut | Press |
|---|---|
| `Alt+D` | Alt and D (⌥D on a Mac). The default. |
| `Mod+Shift+K` | ⌘⇧K on a Mac, Ctrl+Shift+K on Windows and Linux |
| `Ctrl+.` | Ctrl and the full stop |
| `Alt+Backquote` | Alt and the `` ` `` key, top-left on most keyboards |
| `F2` | just F2 |
| `Shift+F10` | Shift and F10 |

### Things to know

- **Keys are matched by position, not by the character they type.** `Alt+D` is the key labelled D on a US keyboard, wherever your layout puts it. It still works on a Mac, where ⌥D types `∂`. On AZERTY, QWERTZ and other layouts, a letter or punctuation name means the key in that *US* position. When in doubt, record it in Settings and copy the text it shows.
- **Modifiers must match exactly.** `Alt+D` doesn't fire on Alt+Shift+D.
- **Include Ctrl, Alt or ⌘** unless you're using a function key. A shortcut like `F2` or `Shift+K` is ignored while you're typing in an input on the page, so it never steals your typing. The Settings recorder asks for a modifier for the same reason.
- **Avoid keys the browser or OS keeps.** The page never sees combinations like Ctrl+W, Ctrl+T, Ctrl+N, ⌘Q or ⌘Tab.
- **Don't reuse one of Watcher's own keys.** While it's open, Watcher uses single letters (V, R, P, T, H, X…) and Ctrl+Z, Ctrl+Shift+Z, Ctrl+D, Ctrl+C, Ctrl+V and Ctrl+0. Your shortcut takes priority, so `Ctrl+D` would close Watcher instead of duplicating. The full list is in the inspector when nothing is selected.
- **If Watcher can't read your shortcut**, it uses Alt+D and logs a warning in the browser console with examples.

## Options

| Option | Type | Default | |
|---|---|---|---|
| `enabled` | `boolean` | `true` in development | `false` turns Watcher off. Can't turn it on in a production build. |
| `shortcut` | `string` | `'Alt+D'` | Keys that open and close Watcher. See [Keyboard shortcut](#keyboard-shortcut). |
| `font` | `string` | | Optional. URL of a Timeless Sans `.woff2` your app serves, for Watcher's own UI. The font isn't included in this package (its license doesn't allow it); without it, Watcher uses Timeless Sans if it's installed on your machine, and the system UI font otherwise. |

```tsx
<Watcher enabled={import.meta.env.VITE_WATCHER !== 'false'} shortcut="Mod+Shift+K" />
```

`mountWatcher({ enabled, shortcut, font })` takes the same options.

## Write edits back to your code (Tailwind)

With the [Vite plugin](#getting-started) installed, inspector edits can be written into your JSX as Tailwind classes. Edit an element, then open **Apply to code** (in the toolbar, or the `</>` button under the inspector). Each element shows its file and line, the class diff, and how every value maps (`padding-top: 44px → pt-11`). Click **Apply to code** and the plugin rewrites the className, hot reload takes over, and the live preview is cleared.

- **Styles** become Tailwind utilities on the scale where possible (`pt-11`, `text-5xl`, `rounded-xl`) and arbitrary values otherwise (`text-[#d4570f]`, `w-[293px]`). The class for the same property is replaced; `md:`/`hover:` variants are left alone.
- **Text** and **attributes** (href, alt, aria-*) are written too, when the JSX holds them literally.
- **Responsive previews** write with the matching breakpoint: an edit made in the 820px preview becomes `md:gap-6`.
- It edits plain `className` strings, static templates, and the first string passed to `cn()` / `clsx()`. Fully computed classNames are left for you to edit by hand.
- Elements rendered by a `.map()` share one line of JSX, so the panel warns that the change applies to all of them.
- Drag offsets, canvas-mode positions and elements from libraries aren't written; the panel says why.

The plugin only runs on the dev server, only writes `.jsx`/`.tsx` files inside your project, and only accepts same-origin requests. Your editor's git diff is the review step.

## Component props

Select anything inside a component and the inspector lists that component's props. Text, number and boolean props can be edited live. Other props, such as functions, elements and objects, are shown read-only. Prop edits are undoable. **Apply to code** writes them where the component is *used* (`<FeatureCard title="…" />`), not inside it. A prop that your code sets with an expression is left for you to edit by hand.

Live editing uses React's DevTools hook, which the Vite plugin installs before React loads. The React DevTools extension provides the same hook. Like in React DevTools, an edited prop holds until the parent re-renders with its own value. Prop edits aren't kept across reloads.

## Forced states

The **Default · Hover · Focus · Active** bar at the top of the inspector shows the selected element in that state. This works with your real CSS, including Tailwind `hover:` and `group-hover:`, because Watcher mirrors each rule that uses a state onto an attribute it can toggle. Hover and active also apply to ancestors, and focus gives ancestors `focus-within`, just as a real pointer would. While a state is showing, inspector edits apply only to that state and are written as `hover:` / `focus:` / `active:` classes, combined with the breakpoint when made in a responsive preview (`md:hover:…`).

## Checks: tokens & accessibility

Watcher checks the page against your design tokens and the common WCAG rules. It runs in two places:

- **The inspector's Checks section** checks the selected element and updates as you edit. It shows the text contrast, with a swatch and the ratio, plus any problems.
- **The Checks panel** (the shield in the toolbar) checks the whole page. It has an **Accessibility** tab and a **Tokens** tab. Click a finding to select the element.

Most findings come with a one-click fix. Fixes are ordinary edits: you can undo them, they're saved with your session, and they go through **Apply to code**.

**Design tokens** are the CSS variables declared on `:root`, which is where Tailwind v4's theme puts them. Watcher sorts them by name:

| Token | Used for |
|---|---|
| any variable holding a colour | text, background and border colours |
| `--text-*`, `--font-size*` | font sizes |
| names containing `radius` | corner radius |
| `--spacing` (Tailwind's 4px step) and `--spacing-*`, `--space-*`, `--gap-*` | padding, vertical margins and gaps. Multiples of the step are on the scale, plus half steps below 16px (`p-1.5`) |

A value that isn't a token is flagged. The fix offers the nearest token, but only when it's a small nudge: Watcher won't suggest turning 48px into an 18px token. Inherited text colours and sizes aren't counted against the child. With **Snap all** in the Tokens tab you can fix every element using the same stray value at once.

**Writing tokens back:** a value that *equals* a token is written as that token's utility, not as an arbitrary value. Theme variables get their named class (`var(--color-brand)` becomes `text-brand`, and `--radius-card` becomes `rounded-card`). Other variables use the shorthand (`text-(--brand)`, or `text-[var(--brand)]` on Tailwind v3).

**Accessibility checks:**

| Check | Severity | Rule |
|---|---|---|
| Text contrast below 4.5:1, or 3:1 for large text (24px, or 18.66px bold) | error | WCAG 1.4.3 |
| Image without `alt` | error | 1.1.1 |
| Button or link with no accessible name | error | 4.1.2 |
| Form field with no label (a placeholder alone is a warning) | error | 1.3.1, 3.3.2 |
| Focusable element inside `aria-hidden="true"` | error | 4.1.2 |
| `<html>` without `lang`, page without `<title>` | error | 3.1.1, 2.4.2 |
| Target smaller than 24×24 with another target within 12px (links in running text are exempt) | warning | 2.5.8 |
| Heading levels skipped, or no `<h1>` | warning | 1.3.1 |
| Positive `tabindex` | warning | 2.4.3 |

The contrast fix suggests a passing token if one is close. Otherwise it suggests the nearest colour of the same hue that passes. Contrast is measured against the backgrounds of the element and its ancestors. When there's a background image or gradient behind the text, it isn't measured, because Watcher can't know which pixels sit behind the text. These checks catch the common, mechanical problems. They don't replace testing with a screen reader and a keyboard.

## Sessions

Edits you haven't applied yet, added elements, guides and canvas mode are saved in your browser, per page, and come back when you reload. A toast says how many were restored, with **Discard** to drop them. The launcher shows a dot when a page has saved work. Applying edits to code or undoing them removes them from the session. Turn it off under Settings → *Remember edits across reloads*.

## What it costs your app

| | |
|---|---|
| **Production** | 0 bytes with Vite and webpack: the package's `production` export condition resolves to an empty module. Other bundlers still emit the lazy chunk, but a `NODE_ENV` check means it never loads. |
| **Development, before opening** | under 1 kB gzipped. The overlay is a separate ~103 kB (gzipped) chunk, fetched when the browser is idle so it never competes with your first render. |
| **Open** | It runs in its own shadow root and React root, so your app's CSS can't reach it and it never re-renders your tree. It redraws only when something it shows actually moved. |

## Features

- **Inspect & measure:** select anything; hold **Alt** for redlines to the hovered element or the parent; padding/margin overlay; breadcrumbs with React component names.
- **Anatomy:** hold **Shift** over any element (or press **A** to keep it on) to dim the rest of the page and break the element down: padding, margin and flex/grid gaps as striped bands with their sizes, the content box, its children and its name and size.
- **Inspector:** every value edits live (frame, constraints, sizing, layout, spacing, typography, appearance, raw CSS), with an advanced colour picker and screen eyedropper. **Copy CSS** exports your edits.
- **Rulers & guides:** drag guides out of the rulers; set axis, position, pattern, colour or lock them; elements snap to guides and siblings.
- **Canvas:** pan and zoom the page like an artboard without reflowing it. **Free canvas** mode (⇧C) freezes the layout so you can move, resize, duplicate and add elements freely.
- **Responsive preview:** (⇧V) live copies of the page at Mobile (390×844), Tablet (820×1180), Desktop (1440×900) or any custom size. Type it, drag the frame's edges, or rotate. **All** shows the three side by side. Each copy is a real viewport, so media queries and `vw` units respond as they would on the device. **Inspect** works inside the previews: select, measure, nudge and edit there, with one shared history, and Copy CSS wraps preview edits in a matching `@media (max-width: …)`. **Interact** lets clicks reach the page again.
- **Pen & SVG editor:** draw Bézier paths onto the page, or open any SVG in the editor tab to drag anchors and handles, bend curves and add or remove points.
- **Pages:** finds your site's pages from its links, React Router routes and `sitemap.xml`, and navigates between them without a reload.
- **Design system:** extracts colours, type styles, radii, spacing, shadows and CSS variables from the page, and exports them as CSS variables.
- **Profiler:** frame rate, DOM updates, JS heap, long tasks and layout shifts, with on-page highlighting.
- **X-ray:** every painted element outlined and coloured by depth.

Edits preview live on the page. They're kept per page until you apply or discard them (see [Sessions](#sessions)). **Apply to code** writes them into your JSX, and **Copy CSS** copies them.

## Development

```bash
npm run dev     # demo app at http://localhost:5179, using src/ directly
npm run check   # type-check + path, write-back, shortcut, guard, CSS and animation checks
npm run build   # dist/: entry, production no-op, lazy overlay chunk, types
npm run icons   # pull the latest Framework7 Icons and regenerate src/icons.ts
```

## Credits

Icons: [Framework7 Icons](https://github.com/framework7io/framework7-icons) (MIT), drawn to match Apple's SF Symbols. SF Symbols themselves can't be used here: Apple's license limits them to apps for Apple platforms.
