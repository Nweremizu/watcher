# Animation (not shipped yet)

Design notes for the Animate tab and timeline drawer. Both are hidden in released builds; set `ANIMATE_TAB` to `true` in `src/overlay.tsx` to try them.

## Animations: what an element already does

The **Animations** list at the top of the Animate tab says, in plain words, every animation the selected element has, wherever it comes from:

| Source | Read from |
|---|---|
| Motion (`motion.*` elements) | `initial`, `animate`, `whileHover`, `whileTap`, `whileFocus`, `whileInView`; objects or variant labels; keyframe arrays with `times`; `transition` on the target, on the element, `transition.default`. A child that only has `variants` follows the labels of the nearest Motion parent (staggered lists). |
| Tailwind | hover, press (`active:`), focus and enter (`starting:`) changes, including `group-hover:`; `animate-*` keyframe animations, built-in or `animate-[…]` |
| Plain CSS | the same, for any stylesheet: `:hover` rules, `@starting-style`, `@keyframes` |

For example: *On hover · Tailwind: shadow changes · 150ms ease-in-out*, *On enter · Motion: fades in and rises 8px · spring 0.3s*, *Loop · Tailwind · pulse: opacity 1 → 0.5 → 1 · 2s*.

**How it reads them:**

- **Values come from the browser.** Watcher forces each state for an instant, with every transition switched off, and compares the computed styles. Theme values, CSS variables, `calc()`, `group-hover:`, CSS modules and plain CSS all read exactly.
- **The pointer doesn't sway it.** The page's real `:hover`, `:active` and `:focus` rules are muted during the read, and restored in the same instant.
- **Running animations don't either.** An element's own values are read from an unanimated copy beside it, so a running animation is never restarted.
- **Classes are structure only.** The className just says which classes are behind each animation, so an edit replaces exactly those.

It also points out what's quietly wrong. For example, a property that changes on hover but isn't in `transition-property` (it jumps instead of animating), or Motion props it can't show (motion values, functions, animation controls).

**▶** plays an animation the way it really runs: Motion's own gestures, the forced CSS state, `@starting-style` (by re-showing the element), or keyframes.

## Custom animations

**New animation**, or **Edit** on any listed animation, opens the builder:

- **Trigger:** On enter, On hover, On press, On focus, In view, or Loop.
- **Write as:**
  - **Motion** (when your project has it).
  - **Tailwind.**
  - **CSS**, to keep plain-CSS keyframes as plain CSS.
- **Keyframes:** a track with as many steps as you like. Add a keyframe after the selected one, move it to any percentage, and give it any values: opacity, x, y, scale, rotate, filter, colours, shadow, radius or any other CSS property. A gesture's first keyframe can stay empty, which means "from however it looks now".
- **Timing:** tween (duration, a Motion easing or a curve you drag) or spring (duration and bounce, or physics, with a preview curve), plus delay and repeat (forever, a number of times, back and forth).
- **Preview** plays it on the element. It reads as a sentence as you build it, and the panel shows exactly what will be written before you write it.

**Save to code** writes it in the system you picked, as small an edit as it can:

- **Tailwind:** a value that didn't change keeps the class it was written with (`hover:shadow-lg` stays `hover:shadow-lg`), and only what changed is replaced. Timing is shared by an element's CSS state changes, so the transition list grows to cover what each one needs. A simple from–to becomes utilities (`hover:-translate-y-1`, `starting:opacity-0`). Steps, loops, and enter on Tailwind v3 become a `@keyframes` block plus one `animate-[name_400ms_…]` class. The block goes where the name is already defined, or in your theme stylesheet. A name that belongs to Tailwind or a package (`pulse`) gets a fresh one (`pulse-2`) rather than overriding it everywhere.
- **Motion:** only changed keys are written, into the objects and same-file variant constants where they already live. A transition shared by several animations is copied into the edited one, so editing one doesn't retime the others. A plain element becomes `motion.*`, with `motion` imported. In view adds `viewport={{ once: true }}`.
- **Switching systems** (Tailwind → Motion or back) removes the old classes or props.

**Delete** removes an animation from the code. **Save as preset…** stores it in `watcher.animations.json` at your project root; commit it and the team shares the presets. Built-in starting points include Fade in, Slide up, Scale in, Icon swap, Press, Hover lift, Reveal on scroll, Float and Pulse.

Limits:

- **In view needs JavaScript**, so it's Motion only.
- **One `animate` at a time:** Motion runs one per element, so an element can't have both an enter and a loop. Watcher says so and suggests a wrapper.
- **Inherited animations:** for one that follows a Motion parent's labels, only its values are edited, in its own variants.
- **Plain-CSS rules stay put:** when a plain-CSS animation is rewritten as Tailwind or Motion, the original rule stays until you remove it.

## Fine-tune

The raw controls sit under **Fine-tune**, collapsed by default:


- **Transition:** which properties animate, plus duration, delay and easing, edited live. **Play Hover / Focus / Active** runs the transition by forcing that state for a moment, so you never have to move the mouse to see it.
- **Keyframe animations** (Tailwind's `animate-*` or your own `@keyframes`): duration, delay, repeat, direction, fill, easing, the keyframes themselves, and **Replay**.
- **Easing editor:** drag the curve's two handles, or pick a preset. Ease out comes first, because state changes should respond at once and then settle. Your theme's `--ease-*` tokens are offered too, and a small dot previews the curve at the element's own duration.
- **Motion checks:**
  - `transition: all`.
  - `ease-in` on state changes, with a one-click switch to ease-out.
  - Transitions over 400ms, which feel sluggish for hover and press.
  - `will-change` on properties the GPU can't composite.

**The timeline** (**M**, or the timer in the toolbar) opens a drawer under the canvas:

- It records every animation that runs on the page: CSS transitions, keyframe animations, and `element.animate()` (the Web Animations API).
- Animations that start together are grouped as one interaction.
- **Speed:** **100% · 25% · 10%** slows everything down, which is the best way to see what feels off.
- **Replay** runs a group again with its original offsets, so staggers stay staggered.
- **Pause** freezes the whole page.
- Click a row to select that element in the Animate tab.

**Back to code:**

| Edit | Written as |
|---|---|
| transition duration / delay | `duration-250`, `delay-100` (on Tailwind v3, the scale or `duration-[250ms]`) |
| easing | `ease-out`, `ease-in-out`, `ease-linear` when it's Tailwind's curve; your token's class (`ease-snappy`); otherwise `ease-[cubic-bezier(0.2,0,0,1)]` |
| transitioned properties | `transition-opacity`, `transition-transform`, `transition-colors`, `transition-[opacity,scale]` |
| keyframe timing | arbitrary properties, e.g. `[animation-duration:1200ms]`, since Tailwind has no utilities for those |

The Checks panel also warns when keyframe animations run on a page that has no `prefers-reduced-motion` handling. Use Tailwind's `motion-safe:` or a media query.

## Motion (motion.dev)

Select a `motion.div` (or any `motion.*` / `m.*` element) and the Animate tab adds three sections:

- **States:** `initial`, `animate`, `whileHover`, `whileTap`, `whileFocus`, `whileInView` and `exit`, each with its values (opacity, x, scale…) to scrub, edit, add or remove. A state that names a variant (`animate="visible"`) shows that variant's values.
- **Motion transition:** Default, Tween or Spring.
  - **Tween:** duration, plus a Motion easing name or a curve you drag.
  - **Spring:** duration and bounce, or stiffness, damping and mass, with a live curve of the spring and how long it takes to settle. A new spring starts at bounce 0: it settles without wobbling, which suits interfaces.
  - **Also:** delay, repeat, and, on the element that runs a variants sequence, stagger and children delay.
  - **Which transition is edited:** the one that actually drives the animation. That's the transition on the target, otherwise the component's `transition` prop, otherwise the transition inside the variant it animates to.
- **Variants:** every other variant, editable the same way.

**Play** runs it without touching the page:

- **Enter** jumps to `initial` instantly and plays to `animate` with the current transition. Variant labels are flipped, so staggered children replay too.
- **Hover**, **Press** and **Focus** trigger Motion's own gestures and hold them for a moment.

Edits apply live and are undoable. **Apply to code** writes them into the JSX objects where you wrote them (`transition={{ type: "spring", bounce: 0.2 }}`), adding missing keys. When the prop is a constant in the same file (`variants={item}`, with `const item = { … }`, `as const` / `satisfies` included), the constant itself is edited. Values computed by expressions are left for you.

## Keyframes and theme tokens

**Keyframes** (under Fine-tune): a `@keyframes` section shows a track with a diamond for each keyframe. Pick one to edit, add or remove its values, or add a keyframe at any percentage. Edits apply to the page's stylesheet as you type, and they're undoable. **Apply to code** writes them to the CSS file Vite served the rule from, changing only that declaration. Keyframes that come from Tailwind or a package (like `pulse`) can't be edited where they live; copy them into your CSS first.

**Theme tokens:** under the easing editor, **Save as a theme token…** adds the curve to your Tailwind theme as `--ease-<name>`. That goes in the first `@theme` block, or a new one after your imports. The element then uses it, and writes back as `ease-<name>`.

**Motion check:** Watcher warns when a CSS transition (often Tailwind's `transition`) covers a property Motion animates. Motion sets that property every frame, each write restarts the CSS transition, and the motion turns mushy. The fix drops those properties from the CSS transition.

**Limits:**

- **Timeline:** Motion runs opacity and similar values in the browser's animation engine, so the timeline shows those as `motion`. Springs on x, y and scale run in JavaScript, so they don't show there and the speed control doesn't slow them. Use Play in the Animate tab for those.
- **Live edits:** like other prop edits, they hold until the parent re-renders with its own values.
- **Exit animations:** they run only when the element is removed, so there's no Play button for them.

