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
