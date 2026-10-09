<p align="center"><img src="assets/logo.svg" width="64" height="64" alt="Watcher"></p>

<h1 align="center">watcher-ui</h1>

<p align="center">Open your running React app like a design file.</p>

Rulers and guides, live style editing, a free canvas, an SVG editor, design-system extraction and a profiler, all on top of the real page. Dev-only: production builds ship none of it.

```bash
npm i -D watcher-ui
```

```tsx
import { Watcher } from 'watcher-ui'

root.render(
  <>
    <App />
    <Watcher />
  </>,
)
```

Press **Alt D** (or click the button in the bottom-right corner) to open it.

Not using React components at the mount point? `mountWatcher()` does the same and returns a cleanup function.

## Write edits back to your code (Tailwind)

Add the Vite plugin and inspector edits can be written into your JSX as Tailwind classes:

```ts
// vite.config.ts
import { watcher } from 'watcher-ui/vite'

export default defineConfig({
  plugins: [watcher(), react(), tailwindcss()],
})
```

Edit an element, then open **Apply to code** (in the toolbar, or the `</>` button under the inspector). Each element shows its file and line, the class diff, and how every value maps (`padding-top: 44px → pt-11`). Click **Apply to code** and the plugin rewrites the className, hot reload takes over, and the live preview is cleared.

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

## Sessions

Edits you haven't applied yet, added elements, guides and canvas mode are saved in your browser, per page, and come back when you reload. A toast says how many were restored, with **Discard** to drop them. The launcher shows a dot when a page has saved work. Applying edits to code or undoing them removes them from the session. Turn it off under Settings → *Remember edits across reloads*.

## What it costs your app

| | |
|---|---|
| **Production** | 0 bytes with Vite and webpack: the package's `production` export condition resolves to an empty module. Other bundlers still emit the lazy chunk, but a `NODE_ENV` check means it never loads. |
| **Development, before opening** | ~0.5 kB gzipped. The overlay is a separate ~60 kB chunk, fetched when the browser is idle so it never competes with your first render. |
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

Edits are inline styles on the live page, and they're gone on reload.

## Development

```bash
npm run dev     # demo app at http://localhost:5179, using src/ directly
npm run check   # type-check + path parser checks
npm run build   # dist/: entry, production no-op, lazy overlay chunk, types
npm run icons   # pull the latest Framework7 Icons and regenerate src/icons.ts
```

## Credits

Icons: [Framework7 Icons](https://github.com/framework7io/framework7-icons) (MIT), drawn to match Apple's SF Symbols. SF Symbols themselves can't be used here: Apple's license limits them to apps for Apple platforms.
