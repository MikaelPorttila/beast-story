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
  `test-keybinds.mjs`, `test-viewport.mjs`, `test-pause.mjs`, `test-npc.mjs`,
  `test-dive.mjs`, `test-gfx.mjs`, `test-cursor.mjs`. `tools/capture-set.ps1` (PowerShell,
  project root) captures the full critic shot set. The one exception is
  `test-zfight.mjs`, which opens no browser at all — see the note below.
- **THE FRAME RATE IS CAPPED AT 120 BY DEFAULT** (`DEFAULT_FPS_CAP` in main.ts;
  `?fps=<n>` overrides, `?fps=0` removes it). A browser already pins rAF to the
  display, so "uncapped" never meant unbounded — it meant "as fast as this
  particular monitor", which on a 165 Hz panel is 165 frames of a scene costing
  4.97 ms of MAIN THREAD each. The frame COUNT is the only term in that product
  the game controls. Measured on a 165 Hz display, walking: **80.5% of a core ->
  55.5%**, fps 161.8 -> 118.7, with cpu/frame essentially unchanged. 120 rather
  than 60 because the difference between 60 and 120 is something an action game
  player feels and the difference between 120 and 165 is not; on a 60 Hz display
  the cap never binds. Note what happens to the PER-FRAME gameplay sections when
  you read the profiler under a cap: `world`, `combat` and `beasts` all go UP
  (+42%, +49%, +29%) because each frame now drains more simulation slices and
  more of the chunk-build budget. The total work is the same, spread over fewer
  frames — which is exactly why `render` is the only section a cap actually
  reduces, and why `cpu` x `fps` is the number to reason about rather than
  either alone.
- **F3 IS THE REMEDY F2 DIAGNOSES.** The panel
  ([src/ui/perf-panel.ts](src/ui/perf-panel.ts), model in
  [src/core/gfx.ts](src/core/gfx.ts)) switches nine things off on a live frame —
  frame cap, AO, glow, antialiasing, shadows, grass, trees, clouds, water — and
  every row carries what it MEASURED at, because a wall of switches with no
  numbers asks the player to guess which one is worth losing. It is meant to be
  read beside F2: flip a row, watch the number move. `/gfx` sets the same
  values from the console and `/gfx` alone lists them; `__dbgGfx(id, value)` is
  the test hook. Settings persist one key per setting under
  `game.settings.graphics.*`, the default is stored as the ABSENCE of a key, and
  a `?` flag (`ao=0`, `bloom=0`, `shadows=0`) is a stronger statement that the
  panel cannot undo — a pass that was never created stays absent.
- **IT IS THE ONE PANEL IN THE GAME THAT IS NOT A MODAL**, and that is
  deliberate rather than an oversight. Every other one freezes the hero so a
  player who stopped to read does not walk off a cliff; this one must not,
  because the whole point is to watch a frame that is doing real work get
  cheaper, and a frozen world streams nothing and animates nothing.
  `tools/test-gfx.mjs` asserts the hero still travels with it open.
- **"SHOW THE WORLD" MEANS "SHOW IT AS CONFIGURED".** `World.setVisible(true)`
  goes through the same `applyLayers` the streamer uses rather than setting
  every mesh visible, and that is a bug fix rather than a preference. The
  ZoneManager hides the active world for a moment to warm the DESTINATION zone's
  shaders against its own light population, then turns it back on — and a
  blanket `visible = true` there re-showed every layer the F3 panel had switched
  off. The symptom was exactly what a player reports and nothing like what you
  would guess from the code: grass stayed off while you stood still and came
  back in a lump as you wandered near a gateway. Measured, 80 of 89 grass meshes
  lit up again. `hiddenLayers` is the world's own memory of the panel, and every
  path that shows a mesh has to consult it.
- **THAT GUARD NEEDS A FRESH PAGE, and the two versions of it that did not are
  the lesson.** Reaching the preload means walking toward a gateway from the
  spawn, `KeyW` follows the CAMERA, and by the time the earlier assertions in
  `test-gfx.mjs` have run the camera is pointing somewhere else — so a section
  that drove the hero from wherever he happened to be passed against the broken
  build twice, once while walking and once while parked next to the gate. It
  opens its own context now. A reproduction that depends on state the rest of
  the file has been mutating is not a reproduction.
- **EVERY TOGGLE IS GUARDED BY A MEASUREMENT, NOT BY ITS OWN FLAG.** A settings
  panel is the easiest thing in a codebase to get wrong in a way that tests
  green — the row renders, the value flips, the key is written, and the renderer
  never hears about it. So `test-gfx.mjs` judges each row by what the FRAME does:
  AO 47 draw calls, trees 70, grass 44, glow 23, and the cap by the measured
  frame rate (30 and 120 exactly). Two rows CANNOT be judged that way and the
  file says so instead of inventing a number: shadows render into their own
  target, which three does not add to `info.render.calls`, and antialiasing is
  three fullscreen quads, inside the counter's own frame-to-frame variance.
  Those two are checked for round-tripping. The draw thresholds are FLOORS, not
  the measured values, and the restore check is RELATIVE to the off-state: the
  absolute count drifts while the streamer works, and "back to within 5% of
  where it started" fails on scene drift rather than on a stuck switch.
- **A NUMBER THAT WAS WRONG, kept because the mistake is repeatable.** The F2
  line reads `scene 396 +229 post`, and an early reading attributed all of that
  post figure to bloom. It is the whole chain, and AO is the larger half —
  bloom alone is 23. If you quote a draw count for one pass, get it by
  TOGGLING that pass, which is what the guard does.
- **PERFORMANCE HAS TWO INSTRUMENTS, AND NEITHER OF THEM IS FPS.** Press **F2**
  in game and the overlay now ends with a `where it went` block: every profiler
  section as a rolling mean with a bar, then `cpu` (time inside our own frame
  callback) and `off-cpu` (wall minus cpu — GPU wait, compositing, a
  collection). That last pair is the one that decides what to do next, because a
  frame that is mostly `off-cpu` and a frame that is mostly `render` need
  opposite fixes. Sampling is turned on only while the panel is open, so it
  costs nothing the rest of the time; `?perf=1` still pins it on for the whole
  run and closing the panel cannot silence that. Measured on this machine, the
  answer is not what anyone guesses: `render` is 67% of the frame and every
  gameplay system TOGETHER is 3%.
- **`bun tools/perf-baseline.mjs record` writes a baseline that is YOURS, and
  `bun tools/perf-baseline.mjs` compares against it.** `.perf-baseline.json` is
  gitignored and must stay that way: frame cost is a property of the hardware as
  much as of the code, so a committed baseline fails for everyone whose GPU is
  not the one that recorded it. The file stores the GPU string and the viewport
  and the comparison warns when either has moved. It exits non-zero when
  cpu/frame is more than 8% over. Record on a quiet machine, on a commit you
  trust; re-record after a deliberate change.
- **THAT TOOL LEAVES VSYNC ALONE, AND THE REASON IS A MISTAKE WORTH NOT
  REPEATING.** An investigation once passed `--disable-gpu-vsync` to "measure
  properly", got 186-368 fps, and concluded from it that making the frame
  cheaper does NOT reduce CPU — turning off the whole post chain halved the cost
  of a frame and moved core load only 89% -> 80%. That is true of an unlocked
  loop and true of nothing else: the loop simply ran more often and ate every
  saving. A real player is pinned to their monitor, so the FRAME COUNT IS FIXED
  and a cheaper frame is directly less CPU. Measured properly (vsync on, 165 Hz
  display): 4.97 ms of CPU per frame and **80.5% of a core**, on `main`, before
  any of the water work. `fps` is reported by the tool and is explicitly NOT the
  regression signal — pinned to the display it barely moves until things are
  dire. `cpu` is.
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
  is the only thing that can see grass standing up THROUGH the gravel: **0 of
  5295 samples**, against 22 of 5300 before the junction apron and 300 of 5283
  before `SHOULDER_IN` tied the two ramps together. Every one of the last 22 was
  at the fork — see the junction note below. `furniture` is where the lamps and
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
  last three sections are the only ones in `tools/` that leave the well-trodden
  path, and all three have to. One runs UNCAPPED — ten presses of F1 must give
  `1010101010`, which is exactly the assertion `fps=30` cannot make, see the
  frame-edge note under Conventions. The second drops `menu=0` and walks the
  STAGED boot to New Game, because that is the only way to reach the handover:
  an F1 pressed at the poster must not survive `beginPlay()`'s latch drain and
  pop the sheet open on the first gameplay frame. The third goes FULLSCREEN with
  a stubbed `navigator.keyboard` — see the Escape note under the title screen.
- `test-pause.mjs` guards the in-game menu, and it is the second probe in
  `tools/` that has to run TWO PAGES for one feature. Everything about the menu
  itself is measured under the usual `menu=0` — Escape raises it, the hero
  travels **0** with it up against 6.85 the moment Continue closes it, its
  Settings step is the same four toggles the title screen shows with the
  language chips disabled, and Escape inside that step goes BACK rather than
  closing. `Exit to title` cannot be: it raises a `StartMenu`, and
  `StartMenu.offer` refuses to build one under `menu=0`, so that arm drops the
  flag and walks the staged boot — New Game, play, stand somewhere 47 units from
  the spawn, Exit, and then round again to prove the second game is a game (back
  at the spawn, and walking) rather than a husk. Its arm 1b is the ESCAPE THE
  BROWSER ATE — a pointer lock taken away must raise the menu once, closing with
  Escape must NOT take a fresh lock (the menu reopening itself), a click must,
  and Alt freeing the cursor must raise nothing; see the Escape note under the
  title screen. It exits non-zero.
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
- `test-npc.mjs` guards the talk test, and it is a PAIR in the same sense
  `test-menu.mjs`'s two holds of W are: the same hero at the same xz either side
  of one change of altitude. On the ground beside Gain the prompt must be up and
  E must open a conversation; a long way over him the prompt must be gone, E
  must do nothing, and a talk begun lower down must have ended by itself. Only
  asserting the second half would pass just as well if the prompt were broken
  everywhere. Between them sits the case that makes the number defensible: a
  flying mount at REST hovers 2.21 units up, which is his head height, and is
  deliberately still talkable — see `NPC_TALK_RISE`. It exits non-zero, and it
  is the only probe in `tools/` that has to get the hero AIRBORNE, which it does
  by typing `/mount galebird` at the dev console and holding Space.
- `test-dive.mjs` guards diving and the underwater view, and it is the only
  probe in `tools/` that ASSERTS ON PIXELS. It has to: every number the
  underwater effect is built from — `amount`, the fog, the tint colour — read
  perfectly correct while the frame was white, because what broke it was the
  tone curve downstream of all of them. So it screenshots the frame and requires
  blue to lead by 20 code values, saturation over 0.30 and luma under 200. The
  three numbers it is defending against are the white-out: (201, 226, 232) at
  saturation 0.131 and luma 221. It reads (25, 64, 111) at 0.775 and 59 today.
  Reading the canvas directly is
  not an option — a WebGL context without `preserveDrawingBuffer` returns an
  empty buffer through `drawImage`, and the first version of this reported
  (0,0,0) above water too, which is how that was caught; the screenshot is taken
  by the browser and handed back into the page to be decoded. The movement half
  is ordinary: hold C and the hero must descend and STOP at the bed, release and
  he must surface at under 6 units/s (uncapped buoyancy peaked near 10), and the
  effect must clear when the lens comes back up. Note it holds KeyC across the
  picture test — pitching the camera under takes seconds, and a hero who floated
  up during them would be photographed at the surface. It drives the camera with
  a MONOTONIC mouse sweep on the way back up: under pointer lock the page sees
  deltas, so "jump back and drag again" nets zero.
- `test-cursor.mjs` guards the in-game cursor, and it is written around the one
  thing it CANNOT do: a headless browser draws no pointer, and
  `getComputedStyle(document.body).cursor` reports the string we assigned rather
  than anything a compositor drew — so reading that back would be asserting our
  own assignment. What it checks instead is the sheet DECODING into sixteen
  distinct states, Alt genuinely releasing and re-taking pointer lock (the
  feature: a player who cannot reach the F3 panel does not care what the pointer
  looks like), the resolver answering correctly at real targets driven through
  the REAL mousemove listener, and the panel actually moving when its title bar
  is dragged.
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
  Its `mounted` section is the only case in the file that is not on foot, and it
  is a PAIR at one column for a reason: the hero must come to rest exactly on a
  piece of camp furniture (13.96 on a 1.96-unit crate) and the rider must then
  rest ABOVE it rather than inside it. Only asserting the mounted half would
  pass in a world where nothing is solid at all. `riderY` is the rider and so
  sits a saddle over the surface, which is what makes it a clean discriminator —
  on the crate it is over `structureTop`, through it, under. It was 12.91.
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
- **A PR IS NOT REPORTED DONE UNTIL ITS PREVIEW URL IS IN THE CHAT.** Vercel
  builds every pull request and posts the deployment as a comment on the PR
  thread, which takes roughly a minute — so opening the PR is not the last step.
  Wait for that comment, pull the preview URL out of it, and print the URL in
  the session chat beside the PR link. The reason is that this is a GAME: the
  reviewer's first question is "what does it look like", and a link they have to
  go and find themselves is a link they open a day later. Poll rather than sleep
  blindly — `gh pr view <n> --json comments` until the bot's comment is there —
  and if it has not arrived after a few minutes, say so plainly and give the PR
  link on its own rather than waiting in silence.
- Read [LAB.md](LAB.md) before iterating on models, animations or skill VFX;
  in particular, lab shots never count as sign-off — re-verify in `index.html`.

## Architecture

TypeScript + three.js, no framework and no asset files — every model, animation
and effect is generated in code. Vite serves two entries from the same modules.

There are TWO exceptions and they are both 2D chrome the renderer never
touches: `src/ui/menu-bg.webp` / `src/ui/menu-logo.webp`, the title screen's
painting and wordmark, and `src/ui/cursors.webp`, the sixteen-state mouse
cursor sheet (issue #38). Everything the RENDERER draws is still generated in
code, which is the line that actually matters — a texture, a model or a font
file is still a no. They are not a crack in the rule: nothing
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
- **`scene.fog.color` is an ABSORPTION MULTIPLIER on that sky, not a fog colour**,
  and it is WHITE above water. The patched chunk fades a fragment toward
  `bsSkyRadiance(elevation)` rather than toward a constant, which is the whole
  point of aerial perspective and left no way to say "the light reaching you
  through this distance has been filtered" — so underwater more fog meant
  BRIGHTER. `world/underwater.ts` is the only writer, and it restores white on
  the way out. three keeps the `fogColor` uniform live from this on every fogged
  material, which is why one number reaches every shader with no new uniform.
- The scene renders into a **linear HDR** target and tone-maps in the output pass.
  Colour constants in shaders are linear radiance, not sRGB swatches — the comments
  state what each value displays as after ACES at exposure 1.02.
- **A FULL-SCREEN EFFECT DRAWN IN THE SCENE LANDS BEFORE THE TONE CURVE, AND
  THAT IS WHY THE UNDERWATER VIEW IS A POST PASS.** This is issue #23 and it is
  the trap in the point above. The effect began as a multiplicative quad drawn
  with the world, which multiplies linear HDR radiance: sunlit lake bed renders
  near 2.6 linear, so taking its red to 0.38 still leaves 1.0, which ACES maps to
  201/255 and desaturates on the way. Every uniform in the effect read correct
  while the frame came back white — measured (201, 226, 232) at saturation 0.13,
  against (75, 175, 255) at 0.71 for the same view under `?post=0`, where the
  multiply lands on already-tone-mapped values instead. The colour, murk,
  refraction and caustics now live in a block at the end of the OUTPUT PASS
  (`uWaterAmt` and friends in post.ts), display-referred and after the grade,
  where "drop the contrast and the saturation" mean what they say. It costs no
  new program and no new round trip, and at amount 0 the whole thing sits behind
  one branch — the daylight frame measures identically either side of the change
  (71, 138, 165 at luma 126).
- **TWO THINGS STILL HAVE TO HAPPEN BEFORE THAT PASS, and they are the reason
  the effect is in two files.** Absorption genuinely happens in the scene, so
  `Engine.setExposureScale(k)` dims the frame ahead of the curve — there is less
  light down there and nothing after ACES can un-blow a blown highlight. And
  bloom runs BEFORE the output pass, so by the time the grade could darken
  anything the halos are already in the buffer: `PostFX.setUnderwater` damps
  bloom strength with depth, which is the "everything shines" half of the
  report. Both are driven from `world/underwater.ts`'s single smoothed `amount`,
  so the scene half and the post half can never disagree about how wet the lens
  is.

`PostFX` ([src/core/post.ts](src/core/post.ts)) is RenderPass → GTAO → selective
emissive bloom → rolloff/ACES/grade/underwater → SMAA, in that order and for
documented reasons. The underwater block is the tail of the output pass rather
than a pass of its own — it borrows the AO pass's depth texture for its distance
fog exactly as the bloom pass does, and falls back to a flat mid-distance under
`?ao=0` rather than disappearing. Every knob has a URL override (`post=0`, `ao=`, `bloom=`, `roll=`,
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

**Clean now — 0 of 5295 cross-section samples draw terrain over the ribbon**,
against 22 and, before that, 300. Five things had to agree to get there.
`SHOULDER_IN` ties the carve's shoulder ramp and the walking surface's to one
number, `carveAt` cuts the ground to that surface minus a sink so a column can
never stand above what is drawn over it, `XS` puts a ribbon vertex on the corner
where the ramp ends, and `RIM_GUARD` lets a rim vertex rise to cover the column
beside it. The fifth is the apron below: the last 22 were every one of them at
the fork, thin flakes where a chord between two 3-unit-apart rings of one arm
passed under a column the OTHER arm's shoulder had rounded the other way. An arm
that starts eleven units out has no such rings to draw.

**THE FORK IS ONE PIECE, AND THE ARMS GROW OUT OF IT.** That is issue #45, and
it is the other half of the fork work above rather than a new subject: making
the arms three separate roads fixed what you WALK on at the junction and left
what you LOOK at unchanged. Three ribbons still ran all the way to the node, so
the middle of the fork was two or three ten-unit gravel slabs stacked on one
another — and a road end is a square cross-section, so what the reporter
photographed is a rectangle with two right-angled corners lying across a bend.
Measured on seed 1337, 203 of the 2144 drawn columns within sixteen units of the
node had more than one ribbon over them; it is 3 now, and those three are the
apron's own fan meeting itself at its centre vertex.

Each arm's ribbon now stops at `APRON_R` (11 — the arms separate about a unit per
unit of arc, so two carriageways stop overlapping at 2 * `DECK_EDGE`), and
`buildJunctionApron` (town-parts.ts) draws what is left as one fan. Two things
about it are worth knowing before touching it. Its rim in the three directions
an arm leaves on IS that arm's first ring — the same nine vertices from the same
`sectionAt` on the same `clipToApron` deck, so the seam is a shared edge rather
than two edges that nearly meet. And BETWEEN two arms the rim is the two arms'
own kerb lines run on until they cross, which pinches to
`DECK_EDGE / cos((pi - gap) / 2)`: 7.3 units between arms a right angle apart,
5.0 between two that are nearly one straight road.

**NOTHING IN THE HEIGHT FIELD KNOWS ABOUT THE APRON**, and the version that made
it a disc in `RoadNetwork` is the mistake worth not repeating. Bounded by the
arms' kerbs, every square unit of the apron is already inside a corridor one of
them carves, so it needs no earthworks of its own — and giving it some was
actively wrong. A disc centred on the node sinks the ground by `carveAt`'s 0.62
in EVERY direction, including the wedges between the arms that the apron does not
cover, and captured, each of those wedges was a one-unit trench with the apron's
skirt standing in it. `JUNCTION_HOLD` had already levelled all three decks
across the node; the junction was a drawing problem and it is fixed where the
drawing is. Two more numbers from getting it wrong on the way: a rim that was a
plain circle of radius 11 paved a lobe of meadow behind the fork and read as a
roundabout, and taking the NEARER of two kerb lines instead of the farther cut
the apron back to a five-unit star with the arms hanging over its points — two
kerbs CROSS inside a junction, so the nearer one is a line straight through it.

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

**BEING STOPPED BY A THING AND STANDING ON IT ARE ONE QUESTION, AND THE SADDLE
USED TO ANSWER THEM SEPARATELY.** Everything that moves keeps two column
heights: the one it probes AHEAD to decide whether a step is legal, and the one
it CLAMPS to when gravity has finished. Those must come from the same query or
the mover is refused at a crate's wall and then falls through its lid — which is
exactly what `MountController` did, because its step test asked `blockTop`
(terrain + trunks + structures) and its vertical clamp asked `getHeight` alone.
Measured on a 1.96-unit crate in the Encampment: hero on foot 13.96, rider
12.91, a metre inside the box. That is issue #32, and there were THREE
terrain-only queries to fix, not the one the screenshots show — mounting up
while standing on something dropped the animal to the dirt, and the dismount
step-off placed the hero inside whatever he got off beside. The third was
invisible because the hero's own physics shoved him out on the next slice, which
is precisely why it would have been the one left behind.

A FOLLOWER and an ENEMY do the same split DELIBERATELY and must not be
"fixed" to match: they are stopped by a settlement (a beast's head poking out of
a hut wall beside you reads worse than no collision at all) but keep their
footing on `getHeight`, so they walk up terraces and through trees like the
height field says. The note at `BeastActor.updateGrounded`
([src/beasts/framework.ts](src/beasts/framework.ts)) is the statement of that,
and the mount is different only because a player is sitting on it.

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

**"NEAR HIM" IS A CYLINDER, AND IT HAS TO BE ASKED IN THREE AXES.** `nearest`
took `(x, z)` and nothing else until issue #25, so a hero flying over the
Encampment was offered a conversation with everyone in it — measured, the prompt
was still up **36.92 units** above Gain's head on a climbing galebird. It now
takes the caller's feet `y` as well, and both it and the conversation's own
leave test in `NpcField.update` reject anyone outside `NPC_TALK_RISE` of his
feet. A cylinder rather than a sphere on purpose: `NPC_TALK_RANGE` is tuned
against a hero who walked up to him on the flat, and folding height into one
radius would quietly shorten that reach on every slope to fix a defect nobody
reported. Two questions — "did you come over to him" and "are you at his level"
— so two numbers, and the constant's comment carries the four measurements it
was picked from. The CULL stays flat: a man you are flying over is the case
where you can see him best. `tools/test-npc.mjs` is the guard.

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

**DIVING IS THE DESCEND KEY, NOT A NEW ONE.** Hold `KeyC` (pad B) in water out
of your depth and the hero swims down; it is the same code `MountController`
reads to bring a flyer lower, so the control learned on a galebird is the one
that works in a lake, and `ui/keybinds.ts`'s existing row covers both. Two things
in `Player` make it work and only one of them is the dive. `DIVE_ACCEL` fights
the buoyancy rather than switching it off, so the hero bobs for a moment before
he sinks. `SWIM_RISE_MAX` is the other, and it is the change diving forced: the
buoyancy was an unclamped spring toward the float line, harmless while nothing
could get more than about a metre under it and a CORK the moment you could reach
the bed — from 4 units down it surfaced him at ~10 units/s. Capped, the ascent
peaks at 3.29 measured, which is `SWIM_SPEED`. There is no separate floor test:
the vertical clamp runs for a swimmer exactly as for a walker, so the bed catches
a diver for free (measured, he rests at 4.00 on a bed of 4.00).
`tools/test-dive.mjs` is the guard.

**ALT FREES THE MOUSE, AND IT IS A HOLD.** Keep it down and the pointer is
yours; let go and the game takes it back. It shipped as a TOGGLE first, on the
reasoning that flipping several F3 rows in a row would be easier that way, and
that was the wrong trade: a hold has no state to get out of step with what the
player believes and cannot strand anyone with the pointer released and no idea
why. The cost is real and worth knowing — Alt+click is claimed by the window
manager on most Linux desktops. It is NOT a modal: the hero keeps taking input,
exactly as he does with the F3 panel open, because both exist to change
something while the world carries on doing real work. What is traded away is
mouse LOOK, which IS the pointer lock. `AltLeft`/`AltRight` are in
`Input.CAPTURED` because Alt focuses the browser's own menu bar in Firefox and
Edge.

**A MENU SHOWS THE CURSOR TOO, and that is the ordinary case rather than a
special one.** The title screen, the Escape menu, the shop and the F1 sheet are
all things you CLICK and have all already released the pointer, so a player
looking at buttons is shown something to click them with. Gated on
`Input.lastSource === 'kbm'` rather than on a latch: a pad player driving the
same menu with the stick gets no cursor, and touching the mouse brings it back
on the next event. `updateCursorMode` is driven by DOM EVENTS as well as per
frame, because `frame()` does not run until New Game — a cursor that only
updated per frame would never appear on the poster, which is one of the two
places it is explicitly wanted.

**THE CURSOR IS A CSS CURSOR, NOT A DIV THAT FOLLOWS THE MOUSE**
([src/ui/cursor.ts](src/ui/cursor.ts)). A DOM cursor is composited a frame late,
so at 120 fps it trails the pointer by 8 ms and every click feels like it landed
behind where you aimed; a CSS cursor is drawn by the compositor against the OS
pointer and cannot lag, and it keeps working while the main thread is building a
chunk. `cursor: url(...)` needs one image per state, so the 4x4 sheet is sliced
into sixteen data URIs once at boot rather than shipping sixteen files — the
source art was 1254x1254 and 1.06 MB, repacked to 64px tiles it is 23.5 KB. 64
is a ceiling rather than a taste: browsers refuse a cursor over 128x128 and fall
back silently. Hotspots are MEASURED off each tile's opaque box — pointers act
at their tip, everything else at the red gem the artist put on its centre.

**THE CURSOR PROPERTY INHERITS, WHICH IS NOT THE SAME AS REACHING ANYTHING.**
Setting it on `<body>` reaches the whole page right up until an element declares
its own, and this stylesheet declares `cursor:pointer` on every button, menu
row and buy button — an explicit declaration on an element beats an inherited
value, so the custom cursor was correct everywhere except the things a player
actually points at, and the native arrow came back over each one. `Cursors.enable`
puts a class on the body and one rule turns those declarations into `inherit`
for as long as the custom cursor is up, so ordinary hover behaviour is untouched
whenever it is not. The GUARD for it reads the COMPUTED cursor off the element
rather than asking the resolver what state it picked — the resolver was right
the whole time, which is exactly why the first version of that test passed.

**SIXTEEN STATES NEED SIXTEEN HOMES, and finding them is most of the work.** The
DOM answers for itself: an element declares `data-cursor`, or its tag decides
(`BUTTON`/`[data-act]` clickable, `[disabled]` forbidden, `INPUT` text). Over the
CANVAS the world is asked through one callback, which PROJECTS enemy and NPC
positions to screen rather than raycasting — a matrix multiply each against
walking hundreds of chunk meshes for an answer no more true. The six drag
states are why the F3 panel is draggable and resizable at all: `grab`/`grabbing`
on its title bar, `move` on its frame, and four resize cursors on four edges and
four corners, which is what makes `resize-nwse` and `resize-nesw` two different
answers instead of one generic one. Note the panel's rows scroll but THE PANEL
DOES NOT — `overflow` on the panel clips the handles on its edges, and its
scrollbar lands exactly where the east and south-east handles are.

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

**ESCAPE IS THE GAME'S KEY, AND TAKING IT NEEDS A SECOND API.** Escape opens the
in-game menu and is also the browser's own "leave fullscreen" key, so one press
did both: the menu came up AND the screen shrank, having been asked for neither
half. `preventDefault` does not reach that — the exit is a user-agent action
taken over the page's head, which is why `Input.CAPTURED` left Escape out for so
long and why `PauseMenu` had to record `wasFullscreen` and put it back on the way
out (best-effort, and only on a CLICK). The fix is the KEYBOARD LOCK:
`installEscapeLock()` takes `navigator.keyboard.lock(['Escape'])` on every entry
into fullscreen and releases it on every exit, and under that lock Escape is
delivered to the page as an ordinary key — so it is in `Input.CAPTURED` now and
the preventDefault means something. The browser keeps ONE escape hatch no page
may close: press and HOLD Escape for about a second and it leaves fullscreen
anyway, with its own notice. That is the spec's anti-trap rule, not a gap.

It is armed off the `fullscreenchange` EVENT rather than beside the
`requestFullscreen()` call, because `lock()` is under no gesture deadline and a
lock is scoped to the fullscreen session — a player who alt-tabs or F11s out and
back needs it re-taken. `escapeIsLocked()` keeps the browser's ANSWER beside the
request, because the two disagree in exactly the cases the feature is broken in,
and `__dbgFullscreen()` reports both.

**BRAVE HAS NO KEYBOARD LOCK, WHICH IS WHY THERE IS A SECOND MECHANISM.**
Measured, headful, on this machine: Brave answers `navigator.brave: true` and
`navigator.keyboard: null` — the property is declared and the object is not
there, which is its fingerprinting protection removing the API — while Edge on
the same page answers `[object Keyboard]`. It is null in headless Chromium too.
So in the browser this project's own tools drive, the lock CANNOT be taken and
Escape stays the browser's key, whatever this file would prefer.

That costs more than fullscreen, and the second cost is the one a player
reports. **A page holding pointer lock is never given the Escape that releases
it** — the browser spends the key itself — so the menu key did nothing on the
press that mattered and worked on the one after, by which time the lock was
already gone. "Escape only opens the menu every other time" is that, and it is
one missing edge rather than a race. `Input.onLockLost` is the answer: a lock
that vanishes while `lockWanted` still stands was TAKEN, and main.ts taps the
same virtual `Escape` the pad's Start and the touch MENU button already tap. One
reader still decides what Escape MEANS, so it closes the topmost modal when
there is one and opens the menu when there is not. No timer and no correlation
window — `tapVirtual` is one `press()` into a Set keyed by code, so a browser
that delivers the real key AND drops the lock in the same frame yields exactly
one edge. Note what it must NOT do: every deliberate release (Alt freeing the
cursor, a shop opening) goes through `releaseLock`, which clears the intent
first, and a rule written as "the lock went away" instead of "the lock was
taken" pops a menu in the player's face every time they hold Alt.

**AND NOTHING MAY TAKE THE POINTER BACK INSIDE THAT SAME KEY.** The fallback
above has a twin failure and it is the one that shipped first: closing the menu
with Escape made it reopen a moment later, on its own. One Escape does two
things a page cannot see, and they land as separate events — measured, LEAVING
FULLSCREEN RELEASES THE POINTER LOCK 8 ms LATER. So a close that immediately
re-took the lock handed the browser something to knock straight back out, and
that loss is indistinguishable from the player pressing Escape again. There were
TWO callers doing it, which is why the first fix did not take: `PauseMenu`'s own
`onClose`, and `updateCursorMode`'s menu branch — the latter one keyup EARLIER,
and against a comment that already said a menu takes its own pointer back and
that asking there would race it. It now re-locks only for an Alt RELEASE, which
is what that comment always claimed. `onClose` carries `by: 'key' | 'click'`,
and the host re-takes the pointer after a click, or after a key when
`escapeIsLocked()` says the browser is not spending Escape at all. After a key
in a browser without the lock, nothing takes it back and nothing needs to: the
next click does, as it always has.

`fullscreenWanted()` is the same distinction for the other half. `PauseMenu`
used to sample `isFullscreen()` when it opened, and where there is no keyboard
lock the browser has usually LEFT fullscreen by then — so the sample said "no"
and Continue restored nothing. The INTENT is set by `enterFullscreen`, cleared
by `exitFullscreen`, and deliberately not cleared by the browser leaving on its
own. A click on Continue then puts it back; Escape and the pad cannot, because
`requestFullscreen` needs an activation and neither is one.

Two guards, because there are two mechanisms. Section 6 of
`tools/test-keybinds.mjs` covers the lock, and lies to the browser to do it:
with `navigator.keyboard` null in headless, a stub in its place records that
entering fullscreen asks for exactly `Escape`, that leaving unlocks, and that a
real Escape comes back `defaultPrevented`. Arm 1b of `tools/test-pause.mjs`
covers the fallback, driven by `document.exitPointerLock()` from the page —
exactly what the browser does to that lock, and the only way in, since a
synthetic Escape over CDP makes the browser release nothing. What NO automated
run on this machine can see is a real lock refusing a real Escape: it needs a
browser that has the API, a display and a hand.

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

**THE SETTINGS PANEL IS ONE VIEW SHOWN FROM TWO PLACES**, and that is a rule
rather than an observation: [src/ui/settings.ts](src/ui/settings.ts) owns the
rows, what a click on one writes and what it tells the running game, and both
the title screen ([ui/menu.ts](src/ui/menu.ts)) and the in-game menu
([ui/pause.ts](src/ui/pause.ts)) render what it returns into a container of
their own. A host owns the SCREEN — where the panel sits, what surrounds it,
which button the cursor starts on, what "back" means; the panel owns the
SETTINGS. Add a row here and it appears in both, which is the point: two copies
do not diverge on the day they are written, they diverge on the day someone adds
a row to one of them. The CSS follows the same rule — `.bs-opts` and
`.bs-menu-btn` are deliberately NOT scoped to `.bs-menu`, because a selector
naming one host is how a shared view stops being shared.

It takes a `place` (`'title' | 'game'`), and that is load-bearing today rather
than provision for later. LANGUAGE is disabled in game, with a line under it
saying where to change it: `setLanguage` re-derives every string on its way to
the DOM, but a fingerpost's letters are voxel geometry carved once at world
creation and no live switch can re-cut them, so offering the picker mid-game
would leave a player walking a world signposted in the language they just left.
Disabled and explained rather than hidden — a setting that vanishes reads as a
bug, and it keeps the two panels the same shape.

**The in-game menu** is Escape, the pad's Start, and the touch overlay's MENU
button (top-left, the one corner of the screen the HUD leaves empty and no thumb
crosses mid-fight). All three arrive as the SAME key edge: Start and the touch
button both tap a virtual `Escape` into `Input`, so main.ts reads it in one
place for every device. Escape means "up one" — out of Settings, then out of the
menu — which is what makes one key both the way in and the whole way out.

It is a MODAL like the F1 sheet (the hero is frozen while you read), but it
RELEASES POINTER LOCK like the shop, and the split is what the player does with
each: a sheet is read and closed with the key that opened it, where this is
clicked, and Exit needs a cursor that can reach it.

**THE LAST CALLER WINS, AND IT DID NOT USED TO.** `requestPointerLock()` resolves
a tick or more after it is called, and `document.pointerLockElement` stays null
for the whole of that window — so `Input.releaseLock`, which asked exactly that
question, was a no-op against a lock that had been REQUESTED but not yet
granted. `Exit to title` does both in that order and one call apart: `close()`
hands the pointer back to the game (correct on Continue, and it cannot know
which button was pressed), then `exitToTitle` releases it. The release lost, the
grant landed a moment later, and the title screen came up with the pointer
captured by the canvas UNDERNEATH the poster: no cursor, and every click on New
Game delivered to the world instead of to the button, so the painting sat there
with its fairies and lit lanterns and nothing the mouse did would start a game.
That is issue #29. `Input` now keeps `lockWanted` beside `pointerLocked` — the
INTENT beside the browser's answer — and hands back, in `pointerlockchange`, any
lock that arrives after somebody asked for it to be given up. Fixed in `Input`
rather than at either call site because the hazard belongs to the PAIR: any
future take-then-give-back inside one turn of the event loop would have raced
the same way. Note what this means for a probe: `el.click()` is dispatched
straight at the button and passes however the pointer is behaving, so
`test-pause.mjs` stayed green through the whole life of the bug — its second New
Game is now a REAL mouse click, and it asserts the lock is null at the title
screen and that no `.fly` or `.lamp` survives the handover.

`Exit to title` returns IN PROCESS — no navigation. Everything that is a play
session is reset by the object that owns it (`Player.reset`, `BeastActor.reset`,
`CombatSystem.reset`), so a field added to one of those is reset by the file that
added it; `exitToTitle` in main.ts is the list of everything else. The engine,
the world and the rigs are deliberately KEPT: rebuilding the world costs 602 ms
and re-linking the shaders that come with it costs 13477 ms (see the boot note at
the top of main.ts), so disposing them would put fifteen seconds behind the New
Game that follows — and nothing in a world or a rig is per-session anyway, since
terrain, towns and roads are pure functions of the seed. The seam is that one
function if the trade ever needs revisiting.

The player's surface is that Settings panel, which shows SWITCHES; the dials
(`/haptics`, `/shake`, `/invertlook`, `/vibration`) are dev-console commands
writing the same keys. **A setting has to be respected
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
- **AN INTEGRATED QUANTITY MUST BE CONSUMED BY THE SLICE THAT SPENDS IT**, and
  that is the same rule seen from the other end. Look and zoom delta
  (`mouseDX`/`mouseDY`/`wheelDelta`) want the survival an edge gets — they are
  accumulated over wall-clock, and dropping them on a slice-less frame scales
  sensitivity DOWN at 165 Hz — and the exact opposite of an edge's tolerance for
  being read twice: `ThirdPersonCamera.update` runs once per SLICE, so a delta
  merely read there is applied once per slice and sensitivity is multiplied by
  the frame's slice count. Measured on the pad's look stick at full deflection,
  degrees of yaw per second against a nominal 184: **fps=120 174, fps=60 221,
  fps=40 263, fps=30 350, fps=20 511**, i.e. 1x / 1.3x / 1.5x / 2x / 3x, and up
  to `MAX_STEPS` = 4x on one long frame. That is issue #37 — the player-facing
  report is a camera that "all of a sudden moves around" when an enemy connects,
  because a hit is exactly when a frame hitches and one hitched frame spends the
  whole hitch's worth of mouse movement four times over. `input.takeLook()` is
  the read that consumes, the camera is its only caller, and `endFrame()` is now
  only the backstop for a frame that ran no camera update at all. Section 7 of
  `test-gamepad.mjs` is the guard: the same hold at `fps=20` and `fps=120` must
  agree to within 15% (2.856 before, 1.025 after).
- **Tuned constants carry their rationale.** The long comments explaining why a value
  is what it is — and what the previous value looked like when captured — are the
  point, not clutter. When you change such a value, update its comment with what you
  measured; don't delete the history.
- Everything that adds to the scene has a matching `dispose()` path.
- Curated captures in `shots/` are tracked; scratch names (`_*`, `r<n>-*`, `c<n>-*`,
  `cur-*`) are gitignored.
