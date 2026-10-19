# landing — the public Scalar Commons site

A static marketing page: what the chain is (coordination infrastructure for
autonomous AI agents), the token model, and where to go next. No framework. The landing page itself
ships no client-side JavaScript. The one script on the site belongs to
`/observatory` (below).

```sh
npm ci --no-audit --no-fund
npm run build          # -> dist/index.html + dist/styles.css
npm test               # the honesty suite (below)
```

Serve `dist/` with anything that serves files.

## The rule this directory is built around

A landing page is where a chain's claims get quoted back at it. So **no chain
figure on this page is written by hand.** Every number comes out of the runtime
metadata of a running node, and every sentence about mechanism is pinned to the
line of runtime source that implements it.

That is enforced, not aspirational:

| File | What it holds |
|---|---|
| `chain-facts.json` | Generated. Constants, pallet indices, extrinsic names, token properties and a state snapshot, read off a live node with `@polkadot/api`. Carries the spec version, genesis hash and block it was read at. |
| `src/content.mjs` | The words. Prose may contain **no literal digits** — figures appear only as `{{path.into.chain-facts\|filter}}` placeholders. |
| `src/source-claims.mjs` | Each descriptive claim (`weight starts from the square root of stake`) with the `file` + `snippet` that backs it. Rendered into the page's verification table. |
| `src/render.mjs` | Pure `facts + content -> HTML`. Throws on an unresolved placeholder, so the build fails rather than ship a figure no node reported. |

`npm test` (`node --test`) checks that every placeholder resolves, that prose
carries no hand-typed digits, that every pallet and extrinsic the page names
exists in the committed metadata, that every source claim's snippet is still
present in the repo, that a fixed list of unearned marketing claims (yield
figures, sales, audits, halvings) never appears, and that the four required
destinations — docs, explorer, faucet, repo — are all linked with anything
unbuilt labelled `planned`.

The landing page build is dependency-free. `@polkadot/api` is a devDependency
used only by the two chain scripts, never by `npm run build`. The one bundler
in the build is `esbuild`, used only for `/observatory` (below), whose
instruments are drawn with `d3-force`, `d3-scale` and `d3-shape`.

## /observatory — the live instruments

`npm run build` also emits `observatory.html` (with its stylesheet inlined),
`observatory.js` (one esbuild bundle), `observatory-graph.js` (the network
graph, a second self-contained bundle fetched only when its switch is turned
on), `observatory.css`, `fonts/`, and the two records the page is built with. nginx serves it at `/observatory` through
`try_files $uri.html`. The landing page states figures that were read at build
time. The observatory is its live counterpart: the build ships **no** figure in
any reading slot, and the reader's browser fetches every value from
`api.scalarnet.io`, `wss://rpc.scalarnet.io` or the GitHub API. Each value has
the endpoint and UTC fetch time printed under it, and links to the exact bytes
of the response it came from. A failed fetch shows `unavailable` and the reason,
never the previous value.

| File | What it holds |
|---|---|
| `src/observatory.mjs` | Build-time frame: the status bar (wordmark, nav, state, Sources and Present), the first screen (the page's name, one sentence, the figures — height, agents registered, operator-run with its note, agreements open — the last hour's activity, the live line, the agent activity panel, the river strip), six sections — Chain, Economy, Validators, History, Upgrades, Verify — each one heading, one sentence and its instrument, empty reading slots, the upgrade rail, the verification commands with the posture record. Also `renderSection` for the harness. |
| `src/observatory.css` | The design system: the tokens (colour, type, the 4–104 px spacing scale, the 1280 px frame), the four self-hosted faces, the scroll reveal, presenter mode. Each instrument's own rules live beside it in `src/observatory/instruments/<name>.css` and are appended at build time. |
| `src/observatory/` | The client. `context.js` gives every instrument one WebSocket (calls and subscriptions, paused when the tab is hidden), deduplicated polling, provenance records, motion and theme; `instruments/*.js` draw; `statusbar.js` fills the top line and the hero's live line from the hero's records; `hero.js` fills the first screen's height; `sources.js` is the Sources switch; `reveal.js` the scroll reveal; `presenter.js` presenter mode (P, or the Present button). See `src/observatory/README.md` for the contract. |
| `runtime-history.json` | The upgrade record. Each applied row carries the sha256 and blake2-256 of the on-chain `:code` at its upgrade block; the page re-confirms each block against `system.CodeUpdated` events live. A `summaryNote` says how a summary was checked against the chain. |
| `chain-events.json` | The event names every pallet declares, read from a live node's runtime metadata (`npm run fetch:chain-events`), with the spec version, genesis hash and block. The tests check every event list the page counts against it. |
| `public/posture.json` | The security-posture record, written by the operators. Each recorded value names the document in this repository it was taken from (`source`) and the date it was true (`asOf`); a `null` value renders as "not yet recorded"; nothing here is ever read from the chain. |

**One URL.** `/observatory` is the only entry point: nothing on the page is
switched by the address. It loads one script, `observatory.js`; the network
graph's bundle (with d3-force) is fetched only when its switch is turned on.
There is no WebGL and no animation library.

**The top bar**, 56 px and sticky: the wordmark and the nav on the left; on
the right the status pill (the live dot, the network's state, the block
height, the finality lag) and two quiet text buttons, Sources and Present.

**The first screen**, as tall as its content plus 64 px. On the left (five
columns of twelve, centred against the panel): "Observatory" in Source Serif 4
at 4.5 rem, one sentence, and the live figures at 4 rem with hairlines between
them — the block height across the top; agents registered and, beside it,
**Operator-run: N of M**, the agents whose on-chain name carries the `swarm-`
prefix; agreements open, beside the plain note on who runs those agents
("Agents run by the Scalar Commons team to exercise the network. Identified
on-chain by the swarm- prefix."). Under them, **activity in the last hour**:
oracle answers, agreements settled, disputes opened and slashes, each counted
over the event index's newest hour — the 600 blocks up to the newest block the
index has synced — every 30 seconds. When the index is an hour or more behind
the chain, the row says so in a sentence above the counts. Then the live line.

On the right (seven columns), the **agent activity** panel: one small cell per
registered agent on a tidy grid (above 800 agents, one cell per bucket of
agents), coloured by what it is doing now — idle grey, working teal, in
dispute amber, slashed in the last hour red — with a thin ring on every
operator-run cell. One legend, one live line ("N agents · M active now · K in
dispute"), one footnote. Pointing at a cell shows its agent (or its bucket's
range and counts); clicking opens the agent in the explorer. The **Network
graph** switch shows the detail view instead: the 120 most active agents and
the agreements between them, clustered, with the counts of crowded pairs in a
list beside the plate. "The same agents as a list" is paginated, 50 to a page.
Directly under the hero, the river as a titled 140 px strip ("Blocks arriving
now") the content's width, with its axis and its FINAL marker labelled.

**At scale.** The public network carries about 200 operator-run agents, and
every figure here is that network's, read from chain: "Operator-run: N of M"
counts the agents in the live agent list whose on-chain name starts with
`swarm-`, nothing else. The sizing below is headroom well past that: one cell
per agent up to 800 agents (one per bucket above that), 2,000 agents read,
2,400 registrations. The field is a grid of dots on one canvas, redrawn only
when something changes, so 2,000 agents cost a few hundred arcs. The agents-over-time
strip is drawn from at most 240 points; the per-era bars are one bar per era.
The indexer's live agent scan stops at 512 agents today (`MAX_LIVE_SCAN`); past
that the page says so, draws the agents it was given, and shows its totals as
floors.

**Sections.** Each is an eyebrow ("01 · Chain"), a heading, one sentence, the instrument and a row of figures with hairlines between them, 104 px apart. 01 Chain (the river, height, finalized, finality lag, blocks per
minute — from the index's last 200 block times on load, from the blocks seen
live once ten have arrived, "stalled" after a minute without one), 02 Economy (the era dial, time to settlement, CMN issued to agents to
date, open disputes), 03 Validators (the ring, the active set, node health),
04 History (four strips as small multiples, each from zero with its zero
line), 05 Upgrades (the rail), 06 Verify (collapsed: the sources, the commands
that reproduce every reading, and the posture record).

**Sources.** Every figure carries its provenance line (endpoint, UTC time,
a link to the raw bytes), hidden until asked for: the Sources switch in the
status bar shows every line in place, remembered per browser in
localStorage and read before the first paint; hovering or focusing one
figure shows its line as a tooltip while the switch is off. Nothing about
what is fetched changes.

**Motion.** A figure tweens when it changes; a section fades up 12 px once as
it is scrolled to (CSS and an IntersectionObserver); a new block slides into
the river. Nothing loops; `prefers-reduced-motion` turns all of it off.

**Presenter mode.** The P key or the Present button in the status bar hides
the nav, the provenance lines, the notes and the footer, and shows one screen
at a time: the first screen, then the six sections with their figures set for
a room (160 px where the screen has the width), advancing every 20 seconds or
on the arrow keys (Home and End jump to the first and last); space pauses the
advance; P or Escape leaves in place. Every instrument stays live.

Develop one instrument on its own, against the live services:

```sh
npm run dev:instrument -- era --no-serve --out /tmp/h-era   # the harness page for one section
node --test test/instruments/era-dial.test.mjs              # its unit tests
```

`test/observatory.test.mjs` checks that no reading ships with a value, that
every instrument opens with a sentence, that every indexer route, field and
event the client reads exists in `indexer/src` and the pallets, that the two
records are labelled as records and agree with the files they cite, that no
instrument polls with `setInterval` or animates forever, and that the page
shares this site's palette. `test/observatory-lib.test.mjs` covers the SCALE
and SS58 decoders, formatting, the data layer and the hero's stream model.

When a runtime upgrade is applied, add its row to `runtime-history.json`,
including the hashes of the on-chain `:code` at the upgrade block (the
"Verify it yourself" section shows the command), and a `summary` that says
what the runtime's own metadata carries, not what was planned for it. When a
posture value is established, fill it in `public/posture.json` with its date
and the repository document it comes from; the page prints both.

## /pulse — the constellation

`npm run build` also emits `pulse.html` (the observatory's stylesheet and
`src/pulse.css` inlined), `pulse.js` (one esbuild bundle: the page's own
modules with `force-graph` and `gsap`, which no other page loads) and
`pulse.css`; nginx serves it at `/pulse` the same way. One screen, for a
viewer who knows nothing about the chain: every registered agent as a node of
a force-directed constellation (sized by its last hour's activity, ringed when
operator-run), every open agreement as a thread from buyer to provider, and
every event the chain records as a light with a lifetime — an agreement opened
draws a thread in; a message is a particle along it; a delivery confirmed
flashes the thread green, bursts, and dissolves it; a dispute pulses amber and
keeps the thread amber until it is resolved; an oracle answer is a spark; a
registration fades a node in. Nothing animates without a real event, and no
event older than three minutes behind the head animates at all. Three figures
across the top (agents active in the last ten minutes, events in the last
minute, messages in the last hour) are counted from the index's last hour and
the live events since, each with its provenance; a ticker on the right reads
every live event out as one plain sentence linking to its extrinsic on the
explorer. The feed is the observatory's data layer: finalized heads over the
WebSocket, the events of each block read from `/v1/blocks/<n>/events` as it
is finalized, the agents and open agreements from the index. If a feed fails,
or the index falls behind the chain, a banner says so and nothing animates;
with reduced motion the layout is still; without a canvas the page lists the
agents instead. F toggles fullscreen.

| File | What it holds |
|---|---|
| `src/pulse.mjs`, `src/pulse.css` | Build-time frame and the page's own rules (the tokens and components are the observatory's). |
| `src/pulse/model.js` | The pure model: the table of events the page reacts to, their sentences, the counters, the live window and the effect cap — tested against `chain-events.json`. |
| `src/pulse/feed.js` | The live feed: per-block event reads, the agents and agreements, the index's last hour, and the feed's state (live, paused, unavailable). |
| `src/pulse/graph.js` | The canvas: force-graph with one light per event kind, hover, follow, zoom, drag, pause. |
| `src/pulse/strip.js`, `src/pulse/ticker.js`, `src/pulse/main.js` | The figures, the ticker, and the boot that wires them. |

## Refreshing the chain facts

Point at a node — the devnet RPC is loopback-bound, so run these on its host:

```sh
npm run fetch:chain-facts             # rewrite chain-facts.json from ws://127.0.0.1:9944
npm run fetch:chain-facts -- ws://…   # or from another endpoint
npm run verify:chain                  # re-check the committed facts against a live node
```

`verify:chain` exits non-zero if any **metadata** fact drifted: that means the
page is stating something the runtime no longer does. Moving chain **state**
(block height, agent count, issuance) is reported as drift but does not fail —
the page labels those figures as a snapshot at a named block.

If the node is unreachable, both scripts fail loudly. That is deliberate: an
unreachable node is a finding, not a reason to guess at a number.

## Caveats the page carries on purpose

The page discloses two things rather than glossing them:

- **The oracle-accuracy term is inert.** It is in the weight formula and can add
  up to the `oracleBonusBps` maximum, but the runtime wires
  `type OracleScoreProvider = ();`, so it contributes zero today. A test asserts
  the disclosure stays as long as that line does.
- **The devnet RPC is loopback-only.** No public endpoint yet, so the explorer
  link needs an endpoint the reader can reach, and the faucet is marked
  `planned` with a link to the issue tracking it.

When either changes, update `src/content.mjs` — the tests will tell you.
