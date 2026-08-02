# Agent guidelines — Beast Story: Bonds of Red

## Use Bun, not Node/npm

Bun (`bun >= 1.3.14`) is the runtime and package manager for this project. Prefer
it for **every** JavaScript/TypeScript command. Reach for `node`/`npm` only when
Bun genuinely cannot do the job, and say so when you do.

| Instead of | Use |
| --- | --- |
| `npm install` | `bun install` |
| `npm install <pkg>` | `bun add <pkg>` (`bun add -d <pkg>` for dev deps) |
| `npm uninstall <pkg>` | `bun remove <pkg>` |
| `npm run dev` / `build` / `preview` | `bun run dev` / `build` / `preview` |
| `npx <tool>` | `bunx <tool>` |
| `node tools/foo.mjs …` | `bun tools/foo.mjs …` |

`bun.lock` is the only lockfile. `package-lock.json` is gitignored — never mix
`npm install` into a Bun-managed tree, and if one appears, delete it rather than
committing it.

### The capture / lab tools

The scripts in `tools/` are plain ESM and run under Bun:

```bash
bun tools/screenshot.mjs shots/overview.png "photo=1" 1920 1080 3500
```

```bash
bun tools/lab-shot.mjs shots/lab-fox.png "beast=emberfox&t=2"
```

They need the dev server up (`bun run dev`) and `BROWSER_EXECUTABLE` set in
`.env.local`, which Bun loads automatically — see [.env.example](.env.example).

### Browser automation: puppeteer-core, not Playwright

**Playwright cannot be used in this project.** It does not work on the Bun
runtime at all — neither of its transports comes up:

- `chromium.launch()` hangs on the `--remote-debugging-pipe` handshake (the
  browser starts, but nothing ever answers on fd 4);
- `connectOverCDP()` times out even though a raw `WebSocket` to the same
  endpoint replies instantly.

There is no Node on this machine to fall back to, so the tools use
**`puppeteer-core`**, which works under Bun. `puppeteer-core` deliberately
ships no browser of its own — it drives a browser already installed on the
machine, named by `BROWSER_EXECUTABLE`.

Everything browser-related lives in [tools/browser.mjs](tools/browser.mjs) —
launch flags, viewport/phone emulation, and small helpers that replace the
Playwright APIs puppeteer lacks (`wait` for the removed `page.waitForTimeout`,
`count`, `isVisible`, `glRenderer`). Import from there; don't call
`puppeteer.launch()` in a tool.

### Tests use hardware acceleration when it is available

Captures and tests render through whatever GPU the host has. Headless Brave
finds it on its own, so **pass no GL flags** — `glRenderer()` reports which path
a run actually got.

Do not reintroduce `--use-angle=swiftshader` / `--enable-unsafe-swiftshader` as a
default. Those force every pixel through the CPU rasteriser, which is
dramatically slower per frame and is where the CPU spikes during test runs came
from. A host without a usable GPU can opt into that fallback with
`SOFTWARE_GL=1`, and still get correct — just slow — renders.

Frame-rate-sensitive assertions must therefore hold across a wide range of frame
rates, from a software-rendered host to an accelerated one. Tools cap captures at
`fps=30` for deterministic stills, and anything measuring motion has to survive a
much faster host — e.g. `test-touch.mjs` sums shortest-arc yaw deltas because
`__dbgCamYaw()` is an `atan2` that wraps past half a circle within one stick hold
once frames come quickly.

## Everything else

- Dev server: `bun run dev` → http://localhost:5187 (`index.html` = game,
  `lab.html` = isolated stage, see [LAB.md](LAB.md)). The port is pinned because
  every tool in `tools/` hardcodes it.
- **ONE WORKTREE, ONE PORT. 5187 belongs to the main checkout.** Sessions in
  `.claude/worktrees/*` run concurrently and each serves a DIFFERENT tree, so
  sharing a port does not mean queueing for it — it means one session's probe
  quietly measuring another session's code. `bun run dev` cannot be shared
  either way: `vite.config.ts` pins 5187 with `strictPort`, so the second one to
  start simply fails. In a worktree:

  1. **Claim a port in 5190–5199.** The claims are already written down —
     every worktree has its own `.claude/launch.json` (gitignored, per-worktree,
     never in a commit), so read the siblings' and take the lowest free number.
     Put it in yours as `"port"`, which is also what makes the Browser pane's
     `preview_start` open on your server rather than refusing because 5187 is
     busy.
  2. **Serve it with the flag, not the config.** `bun x vite --port 5191
     --strictPort`. Do not edit `vite.config.ts` to do this: 5187 is what every
     tool in `tools/` hardcodes, and that pin is load-bearing for the main
     checkout.
  3. **`--strictPort`, ALWAYS.** Without it vite takes the next free port
     instead, and nothing tells you: the run looks perfect while your probe
     drives a game built from somebody else's branch. A hard failure is the only
     acceptable outcome of a clash.
  4. **Point probes at it with a throwaway COPY, and delete it.**
     `sed 's|5187|5191|' tools/test-x.mjs > tools/_tmp-x.mjs`, run that, remove
     it. Never edit the tool itself — the hardcoded 5187 is the contract for
     everyone else. `_tmp-*.mjs` is not gitignored, so a forgotten copy lands in
     the commit.
- **STOP THE DEV SERVER WHEN THE WORK IS DONE — in the same turn you report it
  done, and say that you did.** A server an agent left running is not a stray
  process, it is a STATUS LIGHT pointing the wrong way: from the outside a live
  `vite` says "still working" indefinitely, and there is nothing on the developer's
  screen that distinguishes yours from their own. This applies to every server
  started for a single probe run or one screenshot, not just to a long session —
  those are the ones that get forgotten, because they were only meant to live for
  a minute. It applies at the end of EVERY turn that finishes a piece of work,
  not only the last one in a conversation. It also frees the port you claimed
  above for the next session.
- **Never stop a server you did not start.** The corollary of owning a port is
  not touching anyone else's: 5187 already up means the developer or another
  session is on it, and the answer is to take a port of your own, never to evict
  them.
- Typecheck + build: `bun run build` (runs `tsc --noEmit` first — keep it clean).
  `bun run snapshot [label]` writes a timestamped, self-contained build to `dist/`.
- **To look at a BUILD, serve it statically** — `bun x vite preview --outDir dist`
  (what `bun run snapshot` prints), or any static server. Two ways that look
  right and are not:
  - `file://` cannot work at all. The game loads ES modules and the browser
    refuses them cross-origin from that scheme; you get a blank page, no canvas.
  - **`bun ./dist/index.html` is a bundler, not a static server.** Bun's HTML
    entry point treats the page as SOURCE and re-bundles it, so pointing it at
    already-built output re-processes the bundles, serves its own chunks, and
    answers everything else with the index.html SPA fallback — measured:
    `/assets/main-*.js` came back as `text/html`. Vite's `base:'./'` builds also
    resolve assets through `import.meta.url`, which in Bun's re-bundle is a
    `file://` path on disk, so the menu art ends up pointing outside the server
    entirely. Nothing is wrong with the build when this happens.
  - `bun ./index.html` on the SOURCE, however, works fine (Bun bundles
    `src/main.ts` and serves the menu art from `/_bun/asset/`) — it is just not
    the pinned dev server the tools talk to.
- There is no unit-test runner. The tests are browser probe scripts that print
  JSON: `bun tools/test-f2.mjs [lab]`, `test-touch.mjs`, `test-crosshair.mjs`,
  `measure-layout.mjs`, `test-beastanim.mjs`, `test-structures.mjs`,
  `test-sway.mjs`, `test-menu.mjs`, `test-road.mjs`, `test-settings.mjs`,
  `test-keybinds.mjs`, `test-viewport.mjs`. `tools/capture-set.ps1` (PowerShell,
  project root) captures the full critic shot set. The one exception is
  `test-zfight.mjs`, which opens no browser at all — see the note below.
- **`test-zfight.mjs` is the only probe that needs no dev server**, because
  everything it asks about is arithmetic: it imports the rig builders straight
  out of `src/`, builds every model in the game in headless three.js, poses each
  one through its own animator, and looks for surfaces two models painted onto
  the SAME PLANE. Run it after touching any builder — `bun tools/test-zfight.mjs`,
  and `--verbose` names the two parts, the patch and where to put a camera to
  see it. It is fast (~2 s) and it is the reason the rule below is a run rather
  than a wish.
- `test-road.mjs` asks the one question nothing else could: **is the road you
  SEE the road you STAND ON?** Every other probe compares the world against
  itself, so none of them can see a hero standing exactly where the physics puts
  him and buried to the chest because the ribbon in front of him was drawn over
  his feet. It raycasts the real scene just above the walking surface
  (`__dbgSurfaceY` in main.ts, which is why the ribbon and chunk meshes carry
  names) and reports four numbers. `worstSink` is how far the drawn surface
  floats over the walked one — measured 0.04 / 0.03 / 0.03, against 1.66 / 0.08 /
  0.82 before the ribbon was made to sample the surface. `worstStepOver025` is
  the largest jump in the WALKING surface on a carriageway, against a
  `MAX_STEP_UP` of 0.5: **0.034**, and it was a known failure at **0.801** until
  the fork was made three roads instead of one — see the roads note below.
  `crossSection` sweeps the section rim to rim rather than the centreline, and
  is the only thing that can see grass standing up THROUGH the gravel: 22 of
  5300 samples, against 300 of 5283. `furniture` is where the lamps and
  fingerposts ended up — the smallest gap between any two (16.19) and how near a
  centreline the nearest one comes (5.62, i.e. off the road).
- **Every probe that drives the game passes `menu=0`.** The title screen is a
  gate — the frame loop does not start until New Game — so a tool that forgets it
  measures a poster. It is also what keeps the boot UNSTAGED: with no menu there
  is no progress indicator, no yielding between phases and no waiting for the
  streaming ring, so a probe sees the same immediate game it always did.
  `tools/screenshot.mjs` adds it for you unless the query already names `menu=`;
  the rest have it in their URL.
- `test-menu.mjs` is the title-screen guard, and it now makes two assertions that
  matter. The first is a PAIR: hold W with the poster up and the hero must travel
  0, hold W after New Game and he must travel what the identical hold travels
  under `menu=0` (measured: 0 then 6.87, against 6.97). The second is
  `menuShownAtMs`, the moment the poster is actually on screen — measured 221 ms
  against 14890 ms before the boot was staged, and the whole of the issue that
  prompted it. Alongside them: `playingBehindMenu` must be false (there is no
  frame loop behind the poster to run at all), and `handover` must show the
  loading cover reaching full opacity while the menu is still visible on top of
  it, over a `menuFadeMs` of about 450. Everything else it reports — any key
  leaving the splash, Settings opening and Escaping back, the language chips
  re-captioning the menu live, the "Fullscreen on start" switch being there and
  on, and the phone run — is about the flow.
- `test-settings.mjs` is the settings-storage guard, and it drives the real menu
  rather than calling `savePrefs`: a fresh profile must store NOTHING (defaults
  are the absence of a key, which is what keeps "never chose a language" distinct
  from "chose English"), a seeded `bs:prefs` blob must migrate to the
  `game.settings.*` keys and bring its language onto the screen with it, and
  toggling a row must write exactly one key, take effect live in
  `__dbgFeedback()`, and still be true after a reload.
- `test-keybinds.mjs` guards the F1 controls sheet, and the half worth knowing
  about is not the DOM half. It scans src/ for every `pressed('…')` /
  `takePress('…')` / `down('…')` / `keys.has('…')` and requires each code to
  appear in the table in
  [src/ui/keybinds.ts](src/ui/keybinds.ts) — `unlisted` MUST be empty, which is
  how "update the sheet when you add a binding" became a run rather than a
  wish. `listedNotScanned` is expected to hold exactly `Digit1`–`Digit4`: the
  hotbar is read through a loop variable, which no regex over the source can
  see. It also opens the panel with F1, holds W to prove the sheet is a real
  modal (measured: 0 units with it up, 6.77 with it down), closes it with Escape,
  and picks up a synthetic DualSense mid-read to check the faces swap live. Its
  last two sections are the only ones in `tools/` that leave the well-trodden
  path, and both have to. One runs UNCAPPED — ten presses of F1 must give
  `1010101010`, which is exactly the assertion `fps=30` cannot make, see the
  frame-edge note under Conventions. The other drops `menu=0` and walks the
  STAGED boot to New Game, because that is the only way to reach the handover:
  an F1 pressed at the poster must not survive `beginPlay()`'s latch drain and
  pop the sheet open on the first gameplay frame.
- `test-viewport.mjs` guards the box every full-screen layer is cut to, and it is
  the only probe in `tools/` that lies to the browser on purpose. Its first two
  sections are ordinary — desktop, where the measurement must equal
  `innerWidth`/`innerHeight` exactly, and a phone turned portrait -> landscape ->
  portrait, where no control may leave the frame. The third reproduces issue #16:
  CDP takes the layout viewport and the display as SEPARATE numbers, so a page
  told it has 961 px of viewport on an 851 px screen is in exactly the state a
  Samsung S22 was in when it entered fullscreen and resolved `100dvh` to 941.6 px
  on an 832 px display. Sized from the viewport the page believes in, the fan
  hangs **96.3 px** below the bottom edge (`overflowBefore`, and the twin sticks
  are entirely gone); sized from `src/core/viewport.ts` it is **0**. The one
  synthetic number in the run is `window.screen`, which the probe stubs because
  CDP's `screenWidth`/`screenHeight` are not reflected there.
- `test-structures.mjs` is the settlement-collision guard, and it DRIVES rather
  than computes: for every town the registry reports it aims the camera at a
  real collider (`__dbgStructures` finds them, so no coordinate is pinned to a
  seed), teleports the hero back along that bearing, holds W, and reads
  `__dbgPlayerPos`. Every case runs twice, the second time with `solids=0`, so
  the output is a before/after of the identical walk. A hut, a barrel and the
  perimeter must STOP him; the gate must not — it should land him as deep in
  camp as the run with no collision at all. It also parks him against a wall and
  reads `__dbgBodies` to check his beasts and the wild spawns are not inside it.
  Its last section is the only part that asks whether the collision is any GOOD
  rather than whether it works, and it is the one that EXITS NON-ZERO: a per-town
  collider budget that fails on any increase (64 / 39 / 26 today, of which 5 / 1 /
  1 are roofs) and a ceiling on how far a roof cylinder stands off its own thatch
  (0.577 against 0.6). See the settlement note below for why both exist.
- `test-beastanim.mjs` is the animation-continuity guard: it cycles the whole beast
  roster through the two active follow slots while yanking the hero around, and
  reports the largest per-frame rotation delta at every rig joint. Everything
  should stay under ~0.35 rad; a joint above a radian is teleporting, not
  animating, which on screen reads as a flicker or an impossibly fast flap.
- **Verify the COMMIT, not the working tree**: `bun run verify` typechecks HEAD in a
  throwaway worktree. A partial commit checked against a full tree proves nothing —
  `main.ts` once shipped referencing `player.onCanopy` one commit before
  `player/index.ts` declared it, `tsc` passed locally the whole time because the
  tree held both halves, and the deploy broke. Run it before every push, and always
  when staging a subset of your changes.
- Read [LAB.md](LAB.md) before iterating on models, animations or skill VFX;
  in particular, lab shots never count as sign-off — re-verify in `index.html`.

## Architecture

TypeScript + three.js, no framework and no asset files — every model, animation
and effect is generated in code. Vite serves two entries from the same modules.

The ONE exception is `src/ui/menu-bg.webp` and `src/ui/menu-logo.webp`, the
title screen's painting and wordmark. They are not a crack in the rule: nothing
the renderer draws comes from a file, and these are a 2D poster shown before the
renderer is on screen at all — the one place where an image *is* the design
rather than a shortcut around building one. Keep it that way. A texture, a
model, a sprite sheet or a font file is still a no.

They live in `src/` and are IMPORTED (`import bgUrl from './menu-bg.webp'`),
not dropped in a `public/` folder — there is no `public/` in this project and
adding one is the wrong move. `base:'./'` means a build can be served from any
subfolder, Vite does not rewrite string literals in JS, and a `public/` asset
therefore has to have its URL worked out at runtime against `document.baseURI`.
Imported, the bundler emits it content-hashed into `assets/` beside `main-*.js`
and writes the relative URL itself: if the page can load its own JavaScript it
can load these, on every way of serving the build.

**The contract hub.** [src/core/types.ts](src/core/types.ts) holds every
cross-module interface — `World`, `BeastSpecies`/`BeastRig`/`BeastAnimCtx`, `SkillDef`,
`Damageable`, `CastRequest`, `EventBus`. Subsystems depend on this file, not on
each other: combat never imports the world's implementation, beasts never import
combat. Widen a contract here rather than reaching across modules.

**Composition roots.** [src/main.ts](src/main.ts) is the only place that wires
Engine + World + Player + Beasts + Combat + HUD together, and the only frame loop in
the game; gameplay policy that is no subsystem's own business (roster, hotbar,
cooldowns, shop purchases, support-beast AI) lives there. Its module body is
`async` — it `await`s between boot phases so the title screen can paint before
the world is cut — so adding a statement to it means knowing which phase it lands
in. The note at the top of the file is the contract; read it first.
[src/lab/index.ts](src/lab/index.ts) is a second, much smaller loop over the *same*
modules with a `StubWorld` in place of the streamed one. Never fork model,
animation or VFX code into `src/lab/`.

**Rendering.** `Engine` ([src/core/engine.ts](src/core/engine.ts)) owns renderer,
scene, camera, sun, sky dome, fog and the post chain. Two things there are easy to
break unknowingly:

- `installAerialPerspective()` monkey-patches three's fog `ShaderChunk`s *globally
  at module load*, so distance haze samples the sky gradient per fragment. Every
  fogged material inherits it; there are no per-material hooks to add.
- The scene renders into a **linear HDR** target and tone-maps in the output pass.
  Colour constants in shaders are linear radiance, not sRGB swatches — the comments
  state what each value displays as after ACES at exposure 1.02.

`PostFX` ([src/core/post.ts](src/core/post.ts)) is RenderPass → GTAO → selective
emissive bloom → rolloff/ACES/grade → SMAA, in that order and for documented
reasons. Every knob has a URL override (`post=0`, `ao=`, `bloom=`, `roll=`,
`grade=0`, `aa=0`, `aoview=1`, …) — isolate a visual problem with those before
editing defaults.

**World.** [src/world/terrain.ts](src/world/terrain.ts) is the height/biome
authority: pure functions of `(seed, x, z)`, so anything can ask for a height
without touching loaded chunks. `createWorld()` streams 32-unit chunks around the
focus (`VIEW_RADIUS` 5, 1–2 builds per frame) and assembles terrain + water +
props + skill dens + clouds behind the `World` interface.

**Towns and roads.** [src/world/towns.ts](src/world/towns.ts) sites the named
settlements, cuts the roads between them and picks the player's spawn — a point
on the road to the start town, not in it. Towns are OVERWORLD LANDMARKS, not
zones: you walk in and out and nothing loads. The `TownRegistry` it returns is
on the `World` contract (`world.towns`), and everything else is derived from it —
the roads, the spawn, the compass chips, the trodden mud each settlement wears
its ground down to (`Terrain.grounds`, a `GroundPatch` per entry), and whatever a
quest system asks next; nothing outside these files reads town geometry. Roads are CARVED:
[src/world/roads.ts](src/world/roads.ts) folds a corridor into `heightCont` and
makes `getHeight` return a CONTINUOUS deck inside the carriageway, because a
floored column can only step a whole unit and `MAX_STEP_UP` is 0.5 — read the
header there before touching either. All of it (both towns' meshes, the road
ribbons, the lamps, fences, fingerposts and bridges) is built ONCE at world
creation on the shared prop/terrain materials, so the chunk streamer is
untouched; [src/world/town-parts.ts](src/world/town-parts.ts) holds the voxel
builders and the three rules they obey. `towns=0` removes the lot, and
`__dbgTowns()` reports the registry, each road's measured worst step and grade,
and where every lamp and fingerpost ended up.

**Road furniture asks the NETWORK, and stands on the walking surface.** A lamp,
a fingerpost and a fence panel are placed by arc length along one road and
offset from its centreline, which is the right way to make them follow a bend
and the wrong way to know anything about the road next to them: at a fork, "6.1
units off my road" and "in the middle of the next road" are the same place.
Everything now goes through `place` (the whole network's clearance, plus one
`taken` list shared by all three roads and by the fork's own post) and is seated
with `seatOn` on `getHeight` rather than on the road's deck — the verge is not
the carriageway, and the deck is up to half a unit above it. That is issue #15's
signposts standing in the road with their cairn stones in the air. The fork's
three-armed post moved off the node onto the verge for the same reason, and a
road end AT the fork no longer gets an approach fingerpost of its own: the post
at the fork already names all three destinations.

**The ribbon draws itself on `getHeight`, per vertex.** `buildRoadRibbon` takes
the walking-surface query and samples it at every vertex of every ring, rather
than computing a cross-section from its own road's deck profile. That is not
tidiness, it is the only arrangement in which "what you see is what you stand
on" is true by CONSTRUCTION rather than by two formulas agreeing — and they
stopped agreeing the moment carriageways overlapped. Near the fork each ribbon
was drawn on its own deck while the surface underfoot is whichever road is
NEAREST: measured, `road:junction-stonewatch` was drawn 1.66 above the ground at
the spawn, so the hero stood exactly where the physics put him and was buried to
the chest.

The TESSELLATION stays coarse, and that is a second decision that had to be made
twice. A ribbon is a smooth band laid over stepped ground — its rim sits at
`round(deck)`, a whole-unit staircase, and the router's ~3.4-unit ring spacing
turns each step into a slope you cannot pick out. Subdividing the rings to 1.4
and the section to 0.7, to chase the last tenth of a unit of float at the fork,
turned every one of those into a 1-unit crease over 1.4 units and made the road
read as torn paper instead of one mass of earth. It bought 0.65 -> 0.49 at one
spot and was reverted; captured before/after, SSIM against the original was
0.939 dense and 0.971 coarse.

**A FORK IS THREE ROADS, and it took making it so to fix the step at it.** The
walking surface used to jump 0.801 there against a `MAX_STEP_UP` of 0.5 — an
invisible wall across the carriageway nine units from the player's spawn, with
0.65 of ribbon float beside it. The proximate cause is `RoadNetwork.surfaceAt`
answering with the NEAREST road's deck, a field that jumps across the line
equidistant from two decks of different heights; three attempts to make that
query better were all measured and all reverted (HIGHEST road instead: 1.09 at
the spawn, because a far road's verge ramp outranks a near road's carriageway;
an inverse-distance BLEND: 0.68, because the trim planes still cut a road off
abruptly at the junction; holding the decks level with the roads still on top of
one another: 0.861, the jump simply moved to the rim of the held disc).

It was the wrong question. The trunk and the Stonewatch spur were running **0.63
to 1.94 units apart for the first twenty units out of the fork** — two ten-unit
ribbons on two different deck profiles, drawn one over the other. There was no
fork to resolve; there was one wide ragged apron pretending to be two roads, and
that is what issue #15's screenshot is a picture of. Two changes together fix it,
and neither works alone: `routeRoad` now charges a route for running alongside a
road that already exists (`AVOID_R` / `AVOID_COST`, roads.ts), so the arms leave
the fork as separate roads; and `JUNCTION_HOLD` (towns.ts) holds all three decks
dead level across the node they share, the way a town footprint already holds
its high street level. Measured: step **0.801 -> 0.034**, worst ribbon float
**0.65 -> 0.04**. `bun tools/test-road.mjs` is the before/after.

**Still not clean: 22 of 5300 cross-section samples draw terrain over the
ribbon**, down from 300, and they are thin flakes at the verge rather than the
blocks in the carriageway that were reported. Four things had to agree to get
there — `SHOULDER_IN` ties the carve's shoulder ramp and the walking surface's
to one number, `carveAt` cuts the ground to that surface minus a sink so a
column can never stand above what is drawn over it, `XS` puts a ribbon vertex on
the corner where the ramp ends, and `RIM_GUARD` lets a rim vertex rise to cover
the column beside it. What survives is a chord between two 3-unit-apart rings
passing under a column whose shoulder rounded the other way. Closing it means
either subdividing the rings (see the tessellation note above — that was tried
for a different reason and made the road read as torn paper) or making the
shoulder a property of the road SAMPLE rather than of the query point, which is
a change to what `surfaceAt` means.

Settlements are SOLID, and the collider is never authored twice.
[src/world/structures.ts](src/world/structures.ts) measures a footprint off the
voxel model a builder just painted — the boxes are the mesh — and `SolidStamp`
makes one call push both the vertices and the collider, so a hut cannot be
placed without being made solid. The footprint counts only material between
`MAX_STEP_UP` and head height, which is what leaves the Encampment's gate an
opening rather than a wall and lets a road run under a lamp's bracket. It
reaches the player as `World.structureTopAt`, a third column-top query beside
`getHeight` and `trunkSolidTopAt`, so everything that moves — hero, saddle,
beast, enemy — resolves it against the same `MAX_STEP_UP`
([src/core/types.ts](src/core/types.ts)) it already used for terrain. `solids=0`
keeps the meshes and removes the blocking, which is the A/B
`tools/test-structures.mjs` runs; `/show-colliders` draws them green.

**There are TWO primitives, and picking the wrong one is issue #3.** An ORIENTED
BOX is for anything that meets the ground as a rectangle and stops being
interesting above your head — a wall, a crate, a palisade span, a cart. A ROOF is
a cylinder lying along its ridge (`SolidRidge`), because the whole character of a
gable or a ridge tent is its SLOPE, and the best a box can say about a slope is
"a slab at the ridge": a cage floating a metre over the thatch, which is what the
issue is a photograph of. A builder brackets the loop that paints its roof with
`VoxelModel.region` and every number — ridge line, axis, span, run, pitch — is
measured off those cells, so there is still no size written down twice. The
bracket is the one thing a measurement cannot recover: "everything above the
eaves" also catches the chimney, and a shape test catches every gable in the
world including a cart's hood.

**DO NOT ANSWER A SHAPE PROBLEM WITH MORE BOXES.** Decomposing each roof into
boxes that follow its steps is the obvious fix, was tried, and was reverted: it
took the world from 193 colliders to 2326 — about forty per hut — tripled
`structureTopAt` inside a camp, and still could not make a slope smooth, because
a staircase of box lids is what you get however many of them there are. A model
should be a handful of colliders. A hut is two, a tent is one.

That is a RUN rather than a wish. `tools/test-structures.mjs` carries a per-town
collider budget that fails on any INCREASE and a ceiling on how far a roof
cylinder may stand off its own thatch (`SolidRidge.fitError`, worst 0.577 today
against a limit of 0.6; the aim is under `MAX_STEP_UP`, and getting there means a
WEDGE primitive, not a finer fit). A town it has never seen is budgeted 0, so a
new settlement has to be looked at. Add a building and you re-baseline the number
in the same commit — the failure is the point, not a chore around it. The query
COST is reported there and deliberately not asserted: it is host-dependent, so
any threshold loose enough to be honest would have passed the 2326-box version
anyway. `__dbgRidges()` reports every roof and its fit.

**People.** [src/world/npc.ts](src/world/npc.ts) is the generic half — placement,
culling, the interact test, the talk state — and a character file is the other
half, exactly the way `BeastActor` and `src/beasts/species/*` are split; today the
only one is [src/world/npc-gain.ts](src/world/npc-gain.ts), the Encampment's
quest giver, who builds a body with `VoxelModel` and curls a dumbbell in
`animate(rig, ctx)`. Placement goes THROUGH THE TOWN REGISTRY: a character names
a town and how near the middle it wants to stand, and the search walks rings
outward until it finds a spot clear of the carriageway and of everything the
settlement built — which is why "the middle of camp" does not put him in the
middle of the cart road that ends there. He is SOLID by the same primitive as a
hut: the footprint is `measureFootprint` of his own body model, in his own
`StructureField`, and `World.structureTopAt` returns the max of the town's and
his. He reaches the rest of the game as `World.npcs` ([core/types.ts](src/core/types.ts)):
`nearest` for the prompt, `talk(id)` for the conversation. `talk()` returns a
PAYLOAD (`NpcTalk`) rather than a sentence — that is where a quest offer lands.
`__dbgNpcs()` reports who is standing where, and whether anyone is mid-sentence.

Grass NOTICES what walks through it.
[src/world/sway.ts](src/world/sway.ts) is one vertex shader carrying three
effects — a prevailing wind, a walker parting the blades, and a low flyer's
downwash — driven by a fixed six-slot uniform array rather than a displacement
texture, for the reasons in its header. Movers report themselves through
`World.disturb(id, x, y, z, radius, kind)`, once per simulation slice and
BEFORE `update`: the caller says what is where and the world decides what
reacts, so dust, ripples or snow tracks would want the same report. `id` must be
stable for the life of the mover, because the world keeps a lagged track per id
— that lag is what makes the gap open behind a runner and close over about a
third of a second. `sway=0` makes the meadow static geometry, `photo=1` freezes
the wind clock so a still is reproducible, and `tools/test-sway.mjs` is the
guard. Note when reading it: the shipped wash is `near(clearance) *
gain(climb)`, and those two move together on a follower dragged over rising
ground, so any assertion about clearance alone has to divide the climb term out
first.

**Beasts.** Each species is one self-contained file in `src/beasts/species/` exporting
`species: BeastSpecies` and `skills: SkillDef[]`, building its body with `VoxelModel`
([src/core/voxel.ts](src/core/voxel.ts)) and animating procedurally in
`animate(rig, ctx)`. Adding a species means adding its import to
[src/beasts/registry.ts](src/beasts/registry.ts) — that module list is what populates
`ALL_SPECIES` and `SKILLS`. `voxelshade.ts` / `glowsprite.ts` are shared helpers,
not species. `BeastActor` ([src/beasts/framework.ts](src/beasts/framework.ts)) is the
generic half: follow steering, per-locomotion vertical motion, the
transient-over-base action state machine, XP/levels, damage, death and revive. It
calls `species.animate()` once per frame with the resolved action; species code
holds no physics or state machine of its own.

**Combat.** `CombatSystem` ([src/combat/index.ts](src/combat/index.ts)) owns VFX,
damage numbers, shard pickups and the wild-enemy population, and executes casts by
switching on `SkillDef.targeting`. A new skill is usually data — a `SkillDef` in a
species file — not new code.

**UI and input.** The HUD is a DOM overlay ([src/ui/index.ts](src/ui/index.ts),
styles injected by `src/ui/styles.ts`), not canvas-drawn. Class names are `bs-*`
and the layout/crosshair/touch tools assert on them — renaming one breaks a tool.
`TouchControls` builds the twin-stick overlay only on touch-primary devices.
`main.ts` exposes read-only probes (`__dbgPlayerPos`, `__dbgCamYaw`, `__dbgInput`)
that exist purely for those tools; keep them working.

**THE VIEWPORT IS MEASURED, NOT ASKED FOR.** The game has three layers that must
cover exactly what the player can see — `#app` (which the canvas and therefore
the camera aspect follow), `.bs-touch` and `.bs-root` — and all three used to be
sized in `dvh`/`inset:0`. [src/core/viewport.ts](src/core/viewport.ts) measures
the visible box instead and publishes it as `--bs-vw` / `--bs-vh` / `--bs-vmin`;
each layer reads `var(--bs-vw, 100dvw)` so the pre-JS frames still behave as they
always did, and `installViewport()` runs BEFORE the engine because the renderer
takes its first size from `#app`.

The measurement is the SMALLEST of `innerHeight`, `documentElement.clientHeight`
and — on a coarse-pointer device in fullscreen only — `screen.height`, because
every failure in this class is an overhang: a layer taller than the screen puts
controls where no thumb can reach, a slightly short one merely insets them. That
last term is the one issue #16 needed and the one that is easy to get wrong
elsewhere: a fullscreen page cannot be taller than the display it covers, but a
WINDOWED page is legitimately shorter (the browser's chrome, which `innerHeight`
already reports) and a DESKTOP page is legitimately taller (zoom to 50% and
`innerHeight` doubles while the display does not), so the bound is applied
nowhere else. Re-measured on `resize`, `visualViewport` resize/scroll,
`orientationchange` and `fullscreenchange`, each followed by a settle sweep at
60/180/400/900 ms because Android answers with pre-transition metrics for several
frames into a transition it is still animating.

Issue #16 is what this is: on a Samsung S22 in Brave, entering fullscreen left
`100dvh` resolving to **941.6 CSS px on an 832 CSS px display** — fitting the fan
geometry in core/touch.ts to the reporter's screenshot puts the overlay's bottom
edge there from three different buttons — so the twin sticks and JUMP were 110 px
below the bottom of the screen. Nothing re-resolved it because nothing in a
CSS-unit layout re-asks; rotating the phone did, which is how it was found.
`__dbgViewport()` reports every number the decision was made from (it lives in
that module rather than main.ts, because the title screen is a full-screen layer
too and is up long before the world is), and `tools/test-viewport.mjs` is the
guard.

**The HUD names ONE device, and it is whichever you touched last.** There are two
different questions about a device and they need two different shapes, which is
the distinction `Input` now draws. `padActive`/`touchActive` are LATCHES — "is
there a controller player here at all" — and they are what the start gate and
the welcome toast ask, once, and must never un-set. `Input.lastSource`
(`'kbm' | 'touch' | 'gamepad'`) is a STAMP, rewritten on every real input, and it
is what the key caps and the rumble ask every frame. Reading the latch for a
per-frame question was the bug: a player who tried the pad once was shown
controller faces for the rest of the session, because a latch cannot un-set.

Two things about feeding it are easy to get wrong. A mouse stamp is gated on a
NON-ZERO movement delta, or a locked pointer's stray 0/0 move would steal the
labels from a controller player mid-turn. And the touch stamp is a CAPTURE-phase
listener, because every stick and button in the overlay calls `stopPropagation()`
on touchstart — a bubble listener only ever sees touches that land on the canvas,
so a phone player driving with the sticks would have stayed `'kbm'` forever.
`tools/test-gamepad.mjs` guards the round trip (pad -> keyboard -> pad, on the
hotbar badge AND the pad-cap count) and `tools/test-touch.mjs` guards the phone.

Anything that HOISTS a composed prompt out of the frame loop owes it a re-derive
on that edge, exactly as it does for a language change — `setPadPrompts` returns
whether it moved and `composeKeyHints()` in main.ts is the one writer of all
three (the skill-den pill, the talk pill, the dialogue footer). Read a cap on its
way to the DOM (`hud.interactPrompt`) and it is free; bake one in and you owe it.

**F1 is the controls sheet, and its table is DECLARED, NOT DERIVED.** A binding
is not a value anywhere in this codebase — the climb decision reads
`down('ShiftLeft')` in the middle of `Player.update`, `mount.ts` reads `KeyF`
inside its own hold latch, `core/gamepad.ts` translates pad buttons into those
same codes — so there is no registry to walk and the sheet a player reads is
written by hand in [src/ui/keybinds.ts](src/ui/keybinds.ts). **Add or change a
binding and change that file in the same commit**; `tools/test-keybinds.mjs`
fails on a code the game reads that no row names, which catches the omission but
never a wrong word. Rows carry the KeyboardEvent `codes` (the machine's truth,
what the guard scans) beside the printed `caps` (the player's — `]`, not
`BracketRight`), and each says whether it is a HOLD or a PRESS, which is the
distinction the whole panel exists for: F mounts by being held and dismounts by
being tapped, and a player who taps a held action concludes the game is broken.
Caps are DEVICE LABELS like the pad faces — `Space`, `Esc`, `LMB` are moulded
into hardware and are not translated; everything that is a sentence is a string
key. The panel is a MODAL (see `modal` in main.ts): a player who stopped to find
out what a key does must not have walked off a cliff while reading.

It is a modal that KEEPS POINTER LOCK, which is the one place it parts company
with the shop, and the reason is what the player DOES with each. A shop is
clicked — there are buy buttons and nothing else presses them — so `tryOpenShop`
hands the pointer back. A sheet is read, and closed by the key that opened it.
Releasing the lock for it made a one-key glance cost a click to undo: press F1,
read a line, press F1, and the game is deaf until you click it, mouse look dead
and a cursor sitting over the world. The X and the scrim stay for players with no
lock to lose. Keeping it costs one thing — the mouse goes on reporting movement
no simulation slice will spend, and `endFrame()` only clears on a frame that
drained one — so `frame()` calls `Input.clearLook()` while any modal is up, or a
couple of frames of it survive and land as a camera flick the moment the sheet
closes. `test-keybinds.mjs` asserts the lock across a full open/close and that
the yaw moves by 0 through both.

**Who takes the pointer in the first place** is the same question one step
earlier, and the answer used to be nobody. New Game is a click on a BUTTON, so
the canvas never sees the `mousedown` that `Input`'s constructor listens for, and
a player arrived in the world with a cursor over it and mouse look dead until
they clicked. `beginPlay` calls `Input.requestLock()` for that, on the staged
path only and never on touch. It is BEST-EFFORT by construction: a browser grants
a lock only off a recent user activation, so a boot slow enough to outlast the
click's (~5 s in Chrome) falls back to clicking, and the rejection is swallowed
rather than logged. The unstaged `menu=0` path never asks — there was no gesture
to ask with. Guarded by TURNING THE CAMERA with no click at all, because
`pointerLockElement` alone would pass on a lock nothing is reading.

**The title screen.** [src/ui/menu.ts](src/ui/menu.ts) is the first thing on
screen and the GATE on the game starting, and it is a gate in the strongest sense
available: there is no frame loop behind it. `frame()` is called by `beginPlay()`
in main.ts and by nothing else, so while the poster is up nothing is simulated,
nothing is drawn, and the hero cannot be walked into a tree by a key press that
belonged to the menu. Its steps are `press -> options -> settings`, driven by
keyboard, pointer and a pad poll of its own (edges only — `GamepadControls` is
for feeding a live hero and is the wrong shape for a menu). Everything moving on
it is CSS: the lantern pulse, the fairies and the logo's slide cost no
JavaScript per frame, and the glows stay on the painting's lanterns at every
aspect ratio because they are positioned inside `.plate`, which restates
`background-size:cover` in explicit numbers.

**THE POSTER GOES UP BEFORE THE GAME IS BUILT**, and the boot sequence that
makes that true is the long note at the top of [src/main.ts](src/main.ts). Read
it before changing the order of anything in that file. In short: the module body
`await`s between four named phases — world, actors, shaders, terrain — each
announced on a progress chip in the corner of the title screen
([src/ui/loading.ts](src/ui/loading.ts)) and separated from the next by a real
paint. New Game raises the same element as a full-screen loading cover UNDER the
poster, so the menu's own dissolve is the transition into it, and the game is
revealed only once every phase has finished. `__dbgBoot()` reports the phase
timings; `menu=0` and `photo=1` skip the staging entirely.

Everything below used to run in ONE unbroken task. Measured on the dev server at
1280x800: a single **14702 ms** long task and first contentful paint at
**15312 ms** — fifteen seconds of black page, because `createWorld`, ten beast
rigs and the whole shader warm-up all ran before the browser was handed a frame.
The same load now shows the title screen at **221 ms**. Nothing got faster; the
work is the same 602 / 85 / 13477 / 1193 ms it always was, and the shader sweep
is 88% of it (see `STAGES` in loading.ts for why a light sweep costs that much).
The player simply stopped being made to wait in the dark for it.

There USED to be a `MENU_FPS = 20` cap here instead, and it is worth knowing what
it was for. The loop ran behind the poster; uncapped that was **96.9%** of the
main thread at 1920x1080 (the world plus GTAO, bloom and SMAA, drawn behind an
opaque picture at 165 fps), capped **27%**. The cap was a good answer to the
wrong question — the point was to keep the world STREAMING, and rendering it was
only the means, because the streamer spends its budget per rendered frame. The
terrain phase now drains that queue directly and to completion, so there is no
loop left to cap and an idle title screen costs the poster's CSS and nothing
else.

Two more things there are easy to break. **`menu=0` is load-bearing for every
tool in `tools/`** — see the probe note above. And **FULLSCREEN IS TAKEN, NOT
ASKED FOR**: New Game goes fullscreen, and `Prefs.autoFullscreen` ("Fullscreen
on start", on by default) is the switch that stops it. There is no pill and no
question left — [src/ui/fullscreen.ts](src/ui/fullscreen.ts) is now a feature
detect and one `enterFullscreen()` call.

The rule that governs the whole feature is the GESTURE rule.
`requestFullscreen()` is honoured only while the browser can attribute it to a
user activation, so it is issued as the very first statement of `StartMenu.start`
— ahead of the class change, the hooks and the fade — and from nowhere else.
Defer it by so much as a promise tick and it silently stops working. Two
consequences fall straight out of that and neither is a bug: a PAD press is not
a user activation in any browser, so starting from a controller stays windowed;
and an iPhone has no element-level Fullscreen API at all, so nothing happens
there either. `fs=0` overrides the preference for one load — every probe in
`tools/` that clicks New Game passes it, or the viewport is resized under the
measurement it is taking.

**The vertical layout is a two-row grid meeting at a divider**, and that is
load-bearing rather than incidental. The logo sits in row one aligned to its
bottom, the panel in row two aligned to its top, so the facing edges both land
on the line between the rows and the distance between them is exactly `--gap`
at every window size — they cannot overlap however tall the panel grows. The
first version centred both in ONE cell and translated each away by a percentage
of viewport HEIGHT while the panel's own height was a fixed pixel count; those
do not scale together, and values tuned at 1080 put the New Game button through
the middle of the word "Story" at 540. Below 440px of height the logo is hidden
on the option steps entirely — at 844x390 the frame cannot hold a logo, a gap
and a 232px settings list, and the wordmark has already had the press screen.

**Game URL parameters.** `photo=1` with `cam=x,y,z` / `look=x,y,z` / `beast=<id>` /
`anim=` / `a=<deg>` / `hud=0` stages captures. **`cam` and `look` are OFFSETS
FROM `world.spawnPoint`, not world coordinates** — feeding them the absolute
position of a thing you want to photograph silently puts the camera twice as far
out, which renders a plausible picture of the wrong place rather than an error.
Subtract the spawn (`__dbgTowns().spawn`) first. `npct=<seconds>` pins the NPC
animation clock so two stills of the same 4.6 s curl are reproducible;
`fps=<n>` caps the frame rate;
`debug=1` opens the F2 overlay; `fs=<0|1>` overrides "fullscreen on start" for
this load without writing the preference back; plus every post-processing
override above.
`menu=0` removes the title screen and starts the game immediately — what every
probe in `tools/` passes, and what `photo=1` implies on its own; `menu=1` forces
it back, INCLUDING in photo mode, which is how the title screen itself gets
captured (`photo=1` then freezes its animations so two runs match, and do NOT
add `hud=0` — that hides every overlay including the menu).
`lang=<iso639-1>` pins the display language (default: the stored preference,
then `navigator.language`, then `en` — see **Strings** below). Lab parameters
are in [LAB.md](LAB.md).

**Strings.** Every player-visible name and sentence comes from
[src/i18n/en.ts](src/i18n/en.ts), the BASE table and the source of truth for
every key; other languages are `src/i18n/<iso639-1>.ts` holding only what they
have translated, and anything missing falls back to `en` — never to a blank or a
raw key. One lookup function, `t(key, vars?)` (plus `tn(base, count)` for
one/other plurals), and keys are typed off the base table so a typo is a compile
error. **IDs are keys; names are display**: the currency's id is still `'shard'`
because saves, the drop table and the fetch rule key on it, while it displays as
"Cubloons". Rename a thing by editing the table, never the id.

The language SWITCHES at runtime — `setLanguage(code)` from the start menu's
picker, persisted in `core/prefs.ts` — so the rule for new code is: look a
string up on its way to the DOM, and it is free. Capture one at construction and
you owe it a re-derive from `onLanguageChange`, which today is `HUD.relabel()`,
`TouchControls.relabel()` and one small block in `main.ts` listing every hoisted
string it holds. One thing cannot follow a live switch and is not meant to: a
fingerpost's letters are voxel geometry carved once at world creation, which is
why the picker lives in the menu, before the world is streamed.

**Settings.** [src/core/prefs.ts](src/core/prefs.ts) is the whole persistence
layer, and it is ONE localStorage KEY PER SETTING, named
`game.settings.<group>.<name>` — `controls`, `graphics` or `gameplay`, matching
the panel a setting is shown in rather than the module that reads it. Values are
plain strings (`'true'`/`'false'`, a decimal, an ISO 639-1 code); there is no
JSON anywhere in it. `STORAGE_KEYS` is the only place a key is spelled, which is
why `lang` can be a short field name and a readable `…gameplay.language` key at
once. Everything is validated ON READ, so a hand-edited value lands on a default
instead of a `NaN` in the haptics mixer. `savePrefs` touches only the fields it
is given: two tabs no longer write each other's stale values back, which the old
single `bs:prefs` blob did by construction. That blob still MIGRATES — once, on
the first `loadPrefs()`, field by field through the same key map, never over a
value the new keys already hold — and is then removed.

The player's surface is the title screen's Settings panel (`ui/menu.ts`), which
shows SWITCHES; the dials (`/haptics`, `/shake`, `/invertlook`, `/vibration`)
are dev-console commands writing the same keys. **A setting has to be respected
at ONE choke point, not at every site that could break it**: controller
vibration (`game.settings.controls.hapticFeedback`, on by default) is checked in
`FeedbackSystem.drain`, the single place every cue passes through on its way to
a pad motor or `navigator.vibrate`, and turning it off also stops what is
already ringing. Adding a switch means a `Prefs` field, a `STORAGE_KEYS` entry,
a row in the menu's `ToggleKey` list, an `en.ts` string — and one gate.

**Rumble belongs to the device in your HANDS**, and that is a second gate at the
same choke point rather than a second place to forget: `FeedbackDeps.tactileInput`
is polled per frame off `Input.tactile` (`lastSource !== 'kbm'`), and putting the
pad down stops what is already ringing for the same reason the switch does. A
controller left plugged in beside the keyboard used to buzz through a keyboard
player's whole session, because the only question asked was whether a pad was
connected. A phone keeps buzzing — there a finger IS the device. Camera shake is
deliberately NOT gated on it: it is something you see, not something you feel.

## Conventions

- **No per-frame allocation** in update paths. Module-level scratch vectors (`_a`,
  `_dummy`, …), instanced meshes and object pools are the norm; keep them that way.
- **Frame-rate independence.** Smoothing uses `1 - exp(-lambda * dt)`, never a fixed
  lerp factor. `Engine.tick()` clamps `dt` to 0.05 s.
- **TWO PARTS OF ONE BODY MUST NOT SHARE A FACE PLANE**, and the trap is that
  nothing in a builder file looks like it is choosing one. `VoxelModel.build`
  lays every face on a multiple of the voxel scale, re-based on that model's own
  bounds — so two parts share a face grid in an axis exactly when the joint
  between them is a whole multiple of the scale in that axis, which is what a
  joint offset written as a round number always is. Where two shared-grid parts
  also overlap in space, their faces are COINCIDENT, the depth buffer picks
  between them at random, and it picks differently either side of a quad's
  diagonal: the player sees a hard diagonal seam swimming across the model as
  the camera moves. There are two ways out and Gain (`world/npc-gain.ts`) has
  both — PART THE GRID at the joint, by offsetting the child group a fraction of
  a voxel (`NECK_Z = 0.02`, which is also what `NECK_Y = 1.32` had been quietly
  doing all along), or move the PAINT where an offset would show, as his cape
  and his shoulder corners do. `bun tools/test-zfight.mjs` measures it, carries
  a per-rig budget of the debt the roster already had, and fails on any increase.
  A clean run is necessary and not sufficient: it finds surfaces that are
  coincident, not two solids painted into the SAME voxel layer that sweep
  through each other as a joint turns — which looks identical on screen and is
  what his hair and his hood collar were also doing. Capture the model and look.
- **A key edge read in the FRAME loop must be consumed; one read in a
  SIMULATION slice must not.** `input.pressed()` deliberately survives frames
  that drained no slice — `endFrame()` only runs when one did, and clearing
  regardless was throwing away a third of every player's jumps. A toggle in
  `frame()` therefore sees the SAME press on two or three consecutive frames at
  165 Hz and toggles itself back off; `input.takePress()` is the read that
  consumes, and F1/F2 use it. **This class of bug is invisible to every probe in
  `tools/`**, because `fps=30` against a 60 Hz sim drains two slices on every
  frame and so clears every press — measured, ten presses of F1 gave a clean
  `1010101010` capped and `0011011101` uncapped. An assertion about a frame-loop
  edge has to run with NO `fps=` in its URL; `test-keybinds.mjs` has one.
- **Tuned constants carry their rationale.** The long comments explaining why a value
  is what it is — and what the previous value looked like when captured — are the
  point, not clutter. When you change such a value, update its comment with what you
  measured; don't delete the history.
- Everything that adds to the scene has a matching `dispose()` path.
- Curated captures in `shots/` are tracked; scratch names (`_*`, `r<n>-*`, `c<n>-*`,
  `cur-*`) are gitignored.
