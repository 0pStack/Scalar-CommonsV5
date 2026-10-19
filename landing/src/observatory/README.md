# /observatory — the instruments

This directory is the client side of `/observatory`: one shared context and
one module per instrument, bundled by esbuild into `dist/observatory.js`.
The page frame (labels, sentences, empty reading slots, the upgrade rail and
the posture strip) is rendered at build time by `src/observatory.mjs`; the
design system is `src/observatory.css`. Nothing here ships a figure. Every
figure is fetched in the reader's browser.

## The three rules

1. **Provenance.** Every response is a *record* — `{ ok, at, label, link, raw,
   data | error, source }` — from `ctx.fetch`, `ctx.watch`, `ctx.watchAll` or
   `ctx.subscribe`. A figure is shown with `ctx.readout.showValue(target,
   record, …)`, which prints the endpoint and UTC time beneath it and links the
   figure to the raw bytes. Never show a number without the record it came from.
2. **No stale values.** A record with `ok: false` is handed to you the same way
   a success is. Call `ctx.readout.showError(target, record)` (or use
   `ctx.readout.apply`), which replaces the figure with *unavailable* and the
   reason. Never leave the previous figure standing, never substitute a zero.
3. **No guessed fields.** Read responses with `ctx.field(data, 'a.b.c')`, which
   throws on a missing key; `ctx.readout.apply(targets, record, render)` turns
   that throw into an *unavailable* reading. The test suite checks every
   `field(…, '…')` path against the indexer's source, so read only what
   `indexer/src/api.ts` and `chainState.ts` emit.

Two more, from the design brief: **nothing loops forever** (every tween runs
once; `ctx.motion.tween` is the only animation primitive, and it is a no-op
under `prefers-reduced-motion`), and **nothing runs while the tab is hidden**
(use `ctx.watch`/`ctx.watchAll`/`ctx.subscribe`, never `setInterval`).

## The contract

Each instrument is `src/observatory/instruments/<name>.js` exporting
`init(root, ctx)`, where `root` is its `<section data-instrument="<name>">`
and `ctx` is created by `context.js`:

| Member | What it is |
|---|---|
| `ctx.SOURCES` | every source, keyed by name — see `data.js` |
| `ctx.fetch(source)` | one HTTP or RPC read → record |
| `ctx.watch(name, handler, ms)` | poll `SOURCES[name]` every `ms`, shared with every other watcher; the handler gets the latest record immediately if one exists; returns a stop function |
| `ctx.watchAll(name, handler, ms, { maxPages })` | the same for a list endpoint read whole: the record has `items`, `total`, `complete` |
| `ctx.watchSince(name, since, handler, ms, { maxPages })` | a newest-first event list read only back to the block `since()` returns at each fetch; the record adds `since` and `reachedStart` (false when the page cap stopped it first, so a count is a floor) |
| `ctx.fetchAll(source, { maxPages })` | one whole-list read |
| `ctx.subscribe(name, handler)` | a pushed source (`newHeads`, `finalizedHeads`); the hero owns these |
| `ctx.bus.on(event, fn)` | page events: `head` `{ record, number, header, author: { kind, authorityIndex, slot } \| null, forked, arrivedAt }` (a live header from the socket, always with a header), `finalized` `{ record, number }`, `poll` `{ record, number, finalized, arrivedAt }` (a height from the polling fallback or the first indexed position: no header, no author; `number` and `finalized` are null when the read failed), `cadence` `{ perMinute, intervalMs, blocks, record }`, `socket` `{ state, detail, attempts }` (`state` is `open` \| `closed` \| `failed`; `attempts` is the reconnect count, and the status bar reads it to tell a first drop from a give-up), `visibility` `{ hidden }`, `theme` `{ dark }` |
| `ctx.reading(key, root)` | the `[data-reading=key]` element |
| `ctx.readout` | `showValue`, `showError`, `showAbsent`, `apply`, `provenance`, `rawLink` — see `readout.js` |
| `ctx.format` | `formatInteger`, `formatDuration`, `formatCmn`, `cmnNumber`, `shortAddress`, `shortHash`, `utcTime`, `relativeTime` |
| `ctx.motion` | `reduced()`, `tween(ms, frame, { ease, done })` → cancel |
| `ctx.theme` | `color('live' \| 'settled' \| 'active' \| 'disputed' \| 'slashed' \| 'idle' \| 'slash' \| 'text' \| 'text-dim' \| 'border' \| 'grid' \| 'bg' \| 'surface')`, `font('mono' \| 'serif' \| 'sans')`, `isDark()` — read at draw time; re-read on the `theme` event |
| `ctx.fitCanvas(canvas, onResize)` | sizes a canvas to its CSS box at device resolution; returns `() => { context, width, height, dpr }` |
| `ctx.history`, `ctx.posture` | the two checked-in records embedded in the page |
| `ctx.announce(text)` | polite screen-reader status |
| `ctx.EXPLORER_ORIGIN` | `https://explorer.scalarnet.io` — agent links go to `/activity?agent=<address>`, validators to `/account/<address>` |

An instrument owns exactly three files: `instruments/<name>.js`,
`instruments/<name>.css` (appended to the shipped stylesheet after the design
system; use only its tokens, never redefine `:root`) and
`test/instruments/<name>.test.mjs` (pure functions, `node --test`). It never
edits `context.js`, `data.js`, `readout.js`, `observatory.mjs` or
`observatory.css`; if it needs a change there, it says so in its report.

Five modules beside the instruments are not instruments. `statusbar.js`
fills the one line at the top of the page, and the hero's live line as a
second view of the same state, from the hero's bus events and the ring's
validator read (it fetches nothing of its own). `hero.js` fills the first
screen's block height from the hero's `head` and `poll` events; agents
registered, operator-run and agreements open are the agent field's
(`instruments/agent-field.js`), which draws the first screen's panel and
fetches the network graph (`instruments/constellation.js`, built as its own
bundle, `observatory-graph.js`) the first time its switch is turned on;
`instruments/last-hour.js` fills the row of the last hour's activity. `economy.js` is an instrument of section 02 beside the
era dial: CMN issued to agents (the exact running total of settled-era
payouts) and open disputes. `sources.js` is the Sources switch: every
provenance line is in the page and hidden by the stylesheet until
`html[data-sources]` (remembered in localStorage, read by the page's head
before first paint), or shown as a tooltip on hover or focus of one figure.
`presenter.js` is presenter mode, toggled by the P key or the Present button
— never by the URL — one screen at a time on a re-armed `setTimeout` (never
`setInterval`), cleared while the tab is hidden; space pauses, P or Escape
leaves in place. `reveal.js` fades each section up 12 px once with an
IntersectionObserver; a section is hidden only while `html.reveal-ready` is
set, which only that module sets, never under reduced motion.

## Developing one instrument

```sh
node scripts/dev-instrument.mjs era --no-serve --out /tmp/h-era   # build the harness
node --test test/instruments/era-dial.test.mjs                   # its unit tests
```

The harness page is the instrument's own section on the real stylesheet,
booted against the live services. Screenshot it (both schemes, both widths)
with the Playwright script the session provides; look at the result before
calling the instrument done.

## The plate, in one paragraph

A near-black plate (`--bg`, #0b0e12), a surface (#11151b), a hairline
(#1f252d), text #e8eaed and one secondary grey #a3acb7 that passes WCAG AA on
the plate and the surface; the same with equal care on paper (#f7f6f2) in
light mode. Source Serif 4 at optical size 60 for display and every figure —
the hero readouts, the dial, the ring's count — with its own tabular lining
figures (`font-variant-numeric: tabular-nums lining-nums`), so a figure that
counts up moves nothing beside it and is read once, whole; Inter for the
interface and reading (400 body at 1.0625 rem / 1.6 within 62 characters,
500 labels, 600 small caps; cv11 and ss01); JetBrains Mono at 0.75 rem only
for provenance, hashes, addresses and the river's axis. Nine type sizes and no
others (display, figure-xl, h2, figure-l, h3, body, label, eyebrow, mono). One
teal accent (`--live`, `--active`) for live state only; amber (`--disputed`)
for disputes only; red (`--slash`) for an agent slashed in the last hour only;
grey for everything settled and every idle agent (`--idle`). Every margin, padding and gap
is one of 4, 8, 16, 24, 40, 64 or 104 px; content is at most 1280 px wide.
One button, one disclosure, one tooltip, one focus ring (2 px accent, 2 px
offset). Hairlines (1 px), dots and type. No gradients, no glow, no icons, no
decoration. A reader who does not know what a block is must be able to read
the instrument from its sentence and its labels alone.
