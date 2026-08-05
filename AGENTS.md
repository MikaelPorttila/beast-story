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

### A NEW PACKAGE IS A LICENCE, AND THE CREDIT SHIPS IN THE SAME COMMIT

Issue #65. Adding a dependency — or any content that arrives under a licence, a
font, a sound, a picture, a data table someone else compiled — means editing
[src/ui/about.ts](src/ui/about.ts) in the same commit as the `bun add`. There is
no second pass and no ticket for it: a credits list that is caught up only when
somebody remembers is a credits list that is wrong, and being wrong about a
licence is a different kind of wrong from being wrong about a frame rate.

Three questions, in order, and the first one decides the other two:

1. **Does it SHIP?** A `dependencies` entry ends up inside the build a player
   downloads. A `devDependencies` entry builds or tests the game and reaches
   nobody. That distinction is what separates an obligation from a courtesy —
   most licences bind on DISTRIBUTION, and a compiler that never left the
   developer's machine was never distributed.
2. **What does its licence oblige?** Read the package's own `LICENSE` file
   rather than the SPDX id in `package.json`; the id is a label and the file is
   the text, and the file is what carries the copyright line — which is the
   thing the panel reproduces verbatim, per package. Apache-2.0 additionally
   wants any NOTICE file and a statement of changes if you modified it.
   Anything copyleft (GPL, LGPL, AGPL) is a decision about the whole project
   rather than a line in a credits panel — stop and ask.

   THE FULL LICENCE BODIES ARE DELIBERATELY NOT IN THE PANEL. They were, and
   the heading "The MIT License" sitting at the bottom of a page about this
   game reads as a statement about THIS GAME rather than about three.js — which
   it is not, and the game's own terms are not published. What is carried is
   the name, the SPDX id and the copyright holder. That is thinner than MIT's
   letter, and it is a considered trade: if a body goes back in, it goes under
   a heading that names the package it belongs to.
3. **Which list does it go in?** `SHIPPED` for the first case, with its
   copyright line; `TOOLS` for the second, name and SPDX id. `bun tools/test-about.mjs`
   reads `package.json`'s `dependencies` and fails on any that the panel does
   not credit, so the SHIPPED half is enforced rather than remembered. The
   `TOOLS` half is not — it cannot be, since a dev dependency list includes
   things nobody would call a credit — so that one is on you.

Two things the panel is NOT allowed to do. A licence is never translated: names,
SPDX ids and copyright lines stay in `about.ts` as constants and are English in
every language (the prose around them is `en.ts` keys, and follows the picker).
And a licence is never SUMMARISED into our own words — the notice is the notice.

One more, and it is not about licences: **THE REPOSITORY IS PRIVATE**, so the
panel carries no link to it and no invitation to read the source.
`test-about.mjs` asserts that too, because "the source is public" is exactly the
sentence a credits section grows on its own.

The same routine covers content that is not code. If a font, a texture, a sound
or a body of text ever enters this project under someone's terms, it is a
`SHIPPED` entry with those terms beside it, whatever the "everything is generated
in code" rule (below) has to say about it being there at all.

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
  4. **Probes find the port by themselves — there is nothing left to copy.**
     [tools/target.mjs](tools/target.mjs) resolves it (`BS_PORT`, then this
     worktree's `.claude/launch.json`, then 5187) and every tool imports it, so
     `bun tools/test-x.mjs` runs against YOUR server with no edit and no
     throwaway. The old instruction here was `sed 's|5187|5191|' tools/test-x.mjs
     > tools/_tmp-x.mjs`, and it was a fork per run: `_tmp-*.mjs` is not
     gitignored, so a forgotten copy lands in the commit. The DEFAULT is still
     5187, which is why nothing changes for the main checkout.
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
  `test-dive.mjs`, `test-gfx.mjs`, `test-cursor.mjs`, `test-shadowcache.mjs`,
  `test-nature.mjs`, `test-music.mjs`, `test-textsize.mjs`, `test-content.mjs`,
  `test-safezone.mjs`, `test-about.mjs`, `test-carrier.mjs`, `test-companion.mjs`,
  `test-inventory.mjs`.
  `tools/capture-set.ps1` (PowerShell,
  project root) captures the full critic shot set. The one exception is
  `test-zfight.mjs`, which opens no browser at all — see the note below.
- **`bun tools/probe.mjs <name...|all> [--jobs N] [--json]` runs a SET of them
  and answers in one screen** — a line per probe, the tail of anything that
  failed, and a non-zero exit. It spawns the same `bun tools/test-x.mjs` you
  would, so a probe behaves identically inside a batch, and shares one browser
  with the batch (BS_BROWSER_WS; a launch is 288 ms, which is the small half).
  The large half is CONCURRENCY: measured on five probes, **140 s serially ->
  56 s at `--jobs 5`**. Read its SOLO list before adding to `--jobs`: a probe
  that asserts on frames, motion or CPU is run alone, because three games
  sharing one GPU are not one game. That list was written by RUNNING the A/B —
  `sway` reported 3 movers instead of 4 and an 11.94 area radius instead of
  18.56, `aim-assist`'s widest selected angle collapsed from 66.29 deg to 0.18 —
  and by one worse case: `test-f2` read `null` for every field because the
  overlay was not built 2.5 s after the canvas, **and still exited 0**, since it
  asserts nothing. Fourteen of the probes assert nothing; that is what keeps the
  parallel list at four.
- **`bun tools/q.mjs "<expression>" [more...]` reads a debug hook without a
  script.** `bun tools/q.mjs "__dbgTowns().spawn" "__dbgPlayerPos()"` boots the
  game once and prints one JSON value per expression, in order, so several
  questions cost one boot rather than one throwaway probe each. `--wait ms`,
  `--url "?..."`, `--lab "beast=..."`, `--size WxH`, `--raw` for a bare scalar.
  It is a READER: the value has to survive structuredClone, and driving input
  over time is still a real probe's job.
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
  the test hook. FIVE of the nine are also in the Settings menu's Graphics tab
  (see the settings note below) — the same model and the same keys, so the two
  panels can never disagree; this one keeps the measurements and the four rows
  that delete the world rather than the way it is drawn. Settings persist one
  key per setting under
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
- **A DEBUG SESSION IS MUTED, AND IT IS THE BUILD THAT MAKES IT SO.** There is
  music now (see the Music note below), and a probe run should not put 2.4 MB of
  song through a headless browser or startle whoever is at the keyboard. So
  `flags.silentBoot` (core/flags.ts) resolves the volume to 0 for any load
  carrying `menu=0`, `photo=1`, `fs=0` or `fps=` — the four markers no player's
  URL has, and between them every URL in `tools/`. Nothing loads at zero: no
  element, no request, nothing to unload.
  **When a change DOES need audio, pass `vol=0.01`** — one per cent, which is
  enough for `__dbgMusic()` to report the element playing and the envelope
  moving, and quiet enough to run a batch beside. `vol=` beats the inference
  everywhere it is read, and like `haptics=` and `shake=` it pins for one load
  and never writes the preference back. The rule is a property of the build
  rather than a parameter twenty tools have to remember, which is deliberate:
  covering only `menu=0` would have left the staged-boot arms of `test-menu`,
  `test-pause` and `test-keybinds` streaming a song each.
- **THE INFERENCE ONLY COVERS URLS THAT CARRY A MARKER, AND A PREVIEW TAB DOES
  NOT.** The rule above reads the four flags in the query string, so it silences
  everything in `tools/` and NOTHING ELSE. A browser opened at the bare origin —
  which is what the Browser pane's `preview_start` does, and what typing the
  address does — is by construction a real player's load: the title screen comes
  up and plays at the STORED volume, 0.8 by default, out of the developer's
  speakers, and no probe run is involved for anyone to blame. So **an agent
  opening a preview opens it at `?vol=0`**, and navigates an already-open one
  there before doing anything else. Zero rather than `vol=0.01`, because the
  point is not a quiet song: at zero no element is constructed and nothing is
  fetched. Pass `vol=0.01` only for a change that is ABOUT audio, or a probe
  asserting on it (`test-music.mjs`), and say so when you do.
- `test-music.mjs` is the music guard, and the only thing it CANNOT assert on is
  sound — headless has no speakers, so the honest signal is the element's own
  volume, read through `__dbgMusic()` as `output` (master x envelope x swap).
  Seven claims: a debug boot loads nothing at all, `vol=` beats that, the head of
  a track fades in (0.005 at 0.19 s against a master of 0.5, and 0.5 by 2.4 s),
  New Game and Exit to title are scene changes that unload the outgoing track
  (`starts` 1 -> 2 -> 4 over one session), the OFF chip unloads and writes one
  key, and the LOOP SEAM is what the fades are for. That one is the reason
  `__dbgMusicSeek` exists: the tail is 210 seconds in, so the probe moves the
  playhead to 1.4 s from the end and watches the envelope come down (0.073 at
  209.05), the wrap happen (`loops` 1) and the envelope come back up. A test
  that waited for a real loop is a test nobody runs.
  The seventh is the PLAYLIST, and it is the only claim in the file the
  arrangement it replaced could also have satisfied — half of it. "The overworld
  plays the overworld song" is equally true of content and of the hard-coded map,
  so what is actually asserted is an area that DOES NOT EXIST: driven to
  `nowhere-at-all`, the director must still name a track (the fallback) and must
  NOT restart the one already playing, because an identical playlist is kept
  rather than swapped — a reload there is the music jumping back to its head
  every time the player crosses a gateway. `__dbgMusicScene` is what drives it,
  for the reason `__dbgMusicSeek` exists: the alternative is a minute of walking
  to a gateway to read one field, and it could only ever reach the two zones this
  build ships. Its CONTROL is a null scene, which must unload — without it every
  assertion above would read the same against a hook that moved nothing.
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
  on, and the phone run — is about the flow. Its `intro` section is the only one
  in `tools/` that STOPS THE CLOCK: the entrance below is 1.7 s long and every
  wall-clock reading of it lands after it is over (a screenshot asked for at
  1200 ms arrived at 5695 ms), so it pauses the animations it finds and scrubs
  them — logo 0.84 with the art at 0 at 300 ms, art 0.91 under a full logo at
  1000 ms, everything up at 1900 ms. Finding no animations to scrub is itself the
  failure; see the entrance note below for why that is the assertion.
- **THE POSTER ASSEMBLES ITSELF: logo, then painting, then "press start."**
  Issue #49, and the order is the argument — the eye lands on whichever thing is
  brightest, which on a fade-in-as-one-image splash is a noon sky rather than the
  game's name. The wordmark lights alone against the dark plate for half a second
  and the painting arrives underneath something already read. It waits for
  `HTMLImageElement.decode()` on BOTH images first (measured: both decoded by
  1.08 s on a cold dev server), because an `<img>` fades in with whatever it has
  and a fade begun on a cold cache is a fade of nothing followed by a pop.
- **THE BEATS ARE CSS ANIMATIONS, AND THE OBVIOUS SHAPE CANNOT WORK.** Light a
  layer, `setTimeout`, light the next — measured, the second beat's 550 ms timer
  fired at **4066 ms**, because the boot is running behind the poster and its
  phases are long tasks. The painting turned up four seconds after the wordmark
  and the whole thing read as a stall. A compositor opacity animation goes on
  running through exactly that block, so JS decides only WHEN the sequence starts
  and the stylesheet owns the ordering in `animation-delay`. `photo=1` and Exit
  to title get the end state (`.lit`) rather than a run, the first being a screen
  whose animations are all paused and the second a poster whose art has been in
  the cache all session. Nothing about `menuShownAtMs` moved: 232 ms, and the
  dark plate under the beats is the menu element's own background.
- `test-settings.mjs` is the settings-storage guard, and it drives the real menu
  rather than calling `savePrefs`: a fresh profile must store NOTHING (defaults
  are the absence of a key, which is what keeps "never chose a language" distinct
  from "chose English"), a seeded `bs:prefs` blob must migrate to the
  `game.settings.*` keys and bring its language onto the screen with it, and
  toggling a row must write exactly one key, take effect live in
  `__dbgFeedback()`, and still be true after a reload. Its fifth claim is the
  GRAPHICS tab, and the interesting half is not the key: a row flipped at the
  title screen is flipped before the renderer it drives exists, so the assertion
  is what `__dbgGfx` says once New Game has built one. Note that every probe
  reaching a settings row now has to click its TAB first — the other sections are
  in the DOM but `visibility:hidden`, so a real click on one lands on nothing.
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
  Its FIRST section is the OPENING POSE, and it is first because every other one
  teleports the hero — a reading taken after a `__dbgTp` is a reading of the
  probe's own arithmetic. Four numbers make one composition (3.20 units from the
  greeter, 0.00 degrees of facing between them, 0.00 between the camera arm and
  the hero's heading, same ground height), plus the CONTROL that stops all four
  passing against a pose that quietly fell back to the road: the start must be
  more than 20 units from `spawnPoint`, and it measures 54.77. Nothing in it
  names a coordinate or a character — see the `playerStart` note below.
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

The exceptions are 2D chrome the renderer never touches and, since issue #42,
the MUSIC: `src/ui/menu-bg.webp` / `src/ui/menu-logo.webp`, the title screen's
painting and wordmark; `src/ui/cursors.webp`, the sixteen-state mouse cursor
sheet (issue #38); `src/ui/weapons.webp`, the ten weapon and blueprint icons the
inventory draws (issue #74, repacked by `tools/pack-weapon-icons.mjs` and read
through `background-position` — nothing is sliced at runtime); and
`src/audio/title.webm` / `src/audio/overworld.webm`, the two composed tracks. Everything the RENDERER draws is still generated in code,
which is the line that actually matters — a texture, a model or a font
file is still a no. They are not a crack in the rule: nothing
the renderer draws comes from a file, and these are a 2D poster shown before the
renderer is on screen at all — the one place where an image *is* the design
rather than a shortcut around building one. Keep it that way. A texture, a
model, a sprite sheet or a font file is still a no.

A SONG IS THE SAME KIND OF EXCEPTION, and it is worth saying why it is not the
one `src/feedback/audio.ts` forbids. That file's header says whatever lands in
the SFX channel should be generated — oscillators and noise bursts shaped in
code — and that stays true of a sword hit and a level-up, which genuinely are
things a few oscillators do better than a sample. A composed two-minute piece is
not a shortcut around building one; there is nothing to build. The renderer
still touches nothing here. A sample-based sound EFFECT is still a no.

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

**Content.** [src/content/](src/content/) is the data-driven content system —
issue #60, and the second contract hub in the project. The engine implements
reusable BEHAVIOUR; JSON describes what exists, where, when it is available and
what happens when the player touches it. A settlement's name, radius and colour,
an NPC's placement and dialogue, an enemy's stats and palette are CONTENT. The
streamer, the voxel builders, the follow steering and the combat loop are ENGINE.
[src/content/types.ts](src/content/types.ts) is the contract every module in there
depends on instead of on each other, exactly as `core/types.ts` is for the game;
read its header first, it argues the whole design.

**CONTENT SELECTS A BEHAVIOUR BY NAME; IT NEVER CARRIES ONE.** A town says
`"layout": "camp"`, an NPC says `"body": "gain"`, an enemy says
`"model": "gloopling"`, and each of those is a lookup into a factory the engine
registers (`town-layout`, `npc-body`, `enemy-model`). That is what keeps a voxel
builder in TypeScript where it belongs while its CHOICE is data, and it is also
the security property: remote JSON can be validated, inspected and migrated, and
can never be a script. A layout name no builder implements is a diagnostic rather
than a silent hamlet.

**THE CORE PACKAGE IS IMPORTED, NOT FETCHED**, and that is what makes the issue's
hard requirement true — the starting world must come up with no extra data loaded
at all. [src/content/data/core.json](src/content/data/core.json) is a static
`import`, so Vite inlines it into the main chunk beside `main.ts`: there is no
request that can fail, no ordering to get wrong, and a build that shipped is a
build whose content shipped. Everything else is lazy —
`src/content/data/example-quest.json` is its own 1.99 kB chunk that nothing loads
at boot, and `/content load example-quest` is how you watch the lazy path work.
Measured: `bootstrapContent()` costs **2.4 ms**, inside the noise of a `world`
stage that runs 381-422 ms, so it gets no progress chip of its own.

**AN ID IS `type:name`, AND IT IS NEVER A POSITION.** `town:encampment`,
`npc:gain`, `enemy:gloopling`. The type lives INSIDE the id so a reference is
self-describing — a validator can tell that a `spawns` entry points at the wrong
KIND of thing without loading the target — and the package does NOT, so an asset
can move between packages without breaking a save. The start town used to be
`SITES[0]`, i.e. a fact expressed as an array index; it is `"start": true` now,
and `order` carries what the position used to mean. The same rule is why the save
stores completed quest IDs rather than a `mainQuestProgress = 7`: inserting a
quest into an existing line must not move an existing player backward, and it
cannot when availability is recomputed from ids and flags.

**ONE NUMBER IS DELIBERATELY NOT IN THE DATA.** A town's `outerRadius` is
`CAMP_WALL_HALF * Math.SQRT2` — derived from the constant that builds the wall
itself. Copying it into JSON would fork a load-bearing number, so the LAYOUT
supplies it and the asset may only override it. When you are tempted to migrate a
value, ask whether the thing that draws it already knows it.

**THE ENGINE REFUSES A NAME IT CANNOT KEY.** `StringKey` is `keyof typeof en`,
which is the one build-time guarantee the i18n design rests on, and data authored
outside the repo cannot have it. So a `ContentText` is either `{ "key": … }` (the
shipped table, checked at build time) or `{ "text": { "en": … } }` (carried
inline, for content that arrives after the build). Everything migrated uses the
key form, so nothing about `src/i18n/en.ts` changed.
[src/core/content-bridge.ts](src/core/content-bridge.ts) is the one place the two
meet: a town, an NPC or an enemy whose NAME is inline text is skipped with a
diagnostic rather than given an invented key, because a nameless town in the world
is issue #17's blank label. Resolution happens on the way to the DOM
(`resolveText`), so content names follow a live language switch for free.

**THE MIGRATION MOVED NOTHING.** Every value in `core.json` was copied from the
table it replaced and verified line by line, and the assertion is not that the
registry agrees with itself — it is that `__dbgTowns()` and `__dbgNpcs()` come
back BYTE-IDENTICAL to the pre-migration baseline, which they do. The seven biome
assets carry `nature` multipliers that are all exactly 1, and `setArea` DELETES an
entry set to 1, so `nature.isDefault()` stays true and `test-nature.mjs`'s
identity control never sees them. `tools/test-content.mjs` is the guard and it
exits non-zero.

**NOTHING UNDER `src/content/` MAY STATICALLY IMPORT `./storage/`.** The bundled
provider uses Vite's `import.meta.glob`, which does not exist under plain Bun —
and `tools/test-zfight.mjs` imports game modules straight into Bun with no Vite.
So the two Vite entry points (`main.ts`, `lab/index.ts`) construct
`BundledProvider` and hand it to `content.addProvider`, and `bootstrapContent`
keeps a dynamic import only as a fallback. That fallback is why it is not the
default: measured, dynamic-import-only put a fetch on the boot path and took
`bootstrapContent` from 2.4 ms to **15.8 ms**, because a dynamic import is a chunk
boundary.

**Rendering.** `Engine` ([src/core/engine.ts](src/core/engine.ts)) owns renderer,
scene, camera, sun, sky dome, fog and the post chain. Two things there are easy to
break unknowingly:

- `installAerialPerspective()` monkey-patches three's fog `ShaderChunk`s *globally
  at module load*, so distance haze samples the sky gradient per fragment. Every
  fogged material inherits it; there are no per-material hooks to add.
- **THE SHADOW MAP IS TWO HALVES, AND ONLY ONE OF THEM IS REDRAWN PER FRAME.**
  Terrain, trees, roads and the settlements are pure functions of the seed and
  never move, so they are rendered ONCE into a cache of their own
  ([src/core/shadow-cache.ts](src/core/shadow-cache.ts)) and composited back over
  a live pass that draws only the actors. Measured on an RTX 3070 Ti at
  1280x800: **681 draw calls -> 572 and 3.73M triangles -> 2.66M**, for -0.18 to
  -0.26 ms of frame CPU standing and nothing readable walking. The split is by
  LAYER (`STATIC_SHADOW_LAYER`, bit 1) and the STATIC side is the one that opts
  in, deliberately: an actor wrongly marked static drags a frozen shadow behind
  it, where scenery that nobody marked is merely redrawn every frame. So only
  `markStaticShadowCaster` moves anything, and only world geometry calls it —
  never the shop crystals (they bob and spin), never Gain (he curls a dumbbell),
  never a beast. It is a real layer, so THE CAMERA HAS TO ENABLE IT and so does
  any `Raycaster` (`__dbgSurfaceY` calls `layers.enableAll()` for exactly that).
  `shadowcache=0` is the A/B and is the one flag in core/flags.ts that must move
  no pixels; `tools/test-shadowcache.mjs` holds it to that against a control,
  and separately steps the hero less than `SHADOW_RECENTER` to prove his shadow
  still moves when the cache does not rebuild. `__dbgShadows()` reports
  frames-per-rebuild and the caster census.
- **THE BOX MOVES IN JUMPS, AND THE JUMPS ARE WHOLE SHADOW TEXELS.** A cached
  static map is only valid while the light matrix it was rendered with is, so
  `updateSunFocus` lets the focus wander `SHADOW_RECENTER` units inside the box
  before recentring, and adds the same 8 units to the ortho extent so the
  guaranteed shadowed radius around the hero is unchanged. The recentre is
  quantised on the shadow camera's OWN axes rather than on a world lattice —
  the previous 0.5-unit world rounding claimed in a comment to be a light-space
  quantisation and was not (0.5 units is 14.2 texels), so every step re-rolled
  which texel each shadow edge fell in.
- **`scene.matrixWorldAutoUpdate` IS OFF, and `Engine.render()` calls
  `scene.updateMatrixWorld()` once.** Required, because the shadow passes now run
  before the post chain and read every caster's `matrixWorld` — and worth more
  than the cache they were done for: a frame makes four `renderer.render()`
  calls, three had nothing to recompute, and hoisting the traversal measured
  **-0.46 ms standing and -0.58 ms walking**, unanimous across every alternation
  of the A/B. Anything that moves an object AFTER that call in `render()` (the
  sky dome and the sun disk do, a few lines earlier) has to be above it.
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

- **THE AO PASS CURATES ITS G-BUFFER TWICE, AND THE SECOND QUESTION IS NOT THE
  FIRST.** "Did you write depth in the beauty pass" keeps transparent VFX out.
  "Are you a thing another thing can rest against" is a different question, and
  issue #39 is what answering only the first one looks like: the grass carpet
  and the cloud deck are opaque, wrote depth, occluded — and printed a mottled
  grey smear across the meadow around every hedge clump and dotted black dashes
  down every crease where two cumulus meet. `excludeFromAO`
  ([src/core/types.ts](src/core/types.ts)) is how the world says no, and it is a
  statement about GEOMETRY rather than a performance knob: the bar is that the
  occlusion is wrong, not that it is expensive. The chunk's SOFT prop mesh and
  `Clouds.group` are the only two users; trees, rocks, huts, the hero and the
  beasts all stay in.
- **THAT DEFECT IS INVISIBLE TO A TWO-PAGE A/B.** Two separate loads of one
  framing differ by **2.02 code values** everywhere from streaming and settling
  alone, which is larger than the artefact being measured — three separate
  metrics over pairs of page loads all read flat while the pictures were
  obviously different. The `aoOccluders` section of `tools/test-gfx.mjs`
  screenshots ONE page either side of a `__dbgGfx` toggle instead, so the frames
  differ by exactly the layer that moved: hiding grass must move the AO buffer
  by under 1 code value (**0.10** today, **16.30** on the build that shipped the
  bug), hiding props must move it by more than 3 (**7.08**, the control that
  stops a stuck capture passing the first assertion), and a frame full of
  cumulus must be under 2% occluded (**0.034%**, against **13.98%**).
- **THINGS THAT SOUND LIKE THE FIX FOR AO GRAIN AND ARE NOT.** Measured against
  the same framing: replacing three's tiled 5×5 magic-square rotation noise with
  a 64×64 one, adding the per-pixel radius jitter its generator disables, and
  widening the Poisson denoise (radius 4 → 8, 24 samples, 3 rings) each moved
  the picture by nothing an eye could find. Quadrupling the GTAO sample count
  (32 → 128) does smooth it, at four times the fill, and still leaves the smear
  — a smooth wrong answer. The grain was never the estimator's; it was what the
  estimator was pointed at.

**World.** [src/world/terrain.ts](src/world/terrain.ts) is the height/biome
authority: pure functions of `(seed, x, z)`, so anything can ask for a height
without touching loaded chunks. `createWorld()` streams 32-unit chunks around the
focus (`VIEW_RADIUS` 5, 1–2 builds per frame) and assembles terrain + water +
props + skill dens + clouds behind the `World` interface.

**A CARRIER IS A PIECE OF THE WORLD THAT MOVES, AND CARRIES WHAT STANDS ON IT.**
That is issue #68, and the flying town is one implementation of it rather than
the feature itself: `CarrierInfo`/`CarrierRegistry` are in
[src/core/types.ts](src/core/types.ts) and the machinery is in
[src/world/carriers.ts](src/world/carriers.ts), with nothing about islands in
either. A boat, a lift and a monster big enough to climb are the same problem,
and would write only what [src/world/sky-island.ts](src/world/sky-island.ts)
writes — a shape, a surface, and a rule for where it goes next.

**IT IS NOT A REPARENTING, and that is the decision the whole design rests on.**
There are FOUR physics loops in this codebase and they agree about almost
nothing: the hero has a step test, a canopy platform and a climb state; the
saddle has a flight ceiling; a beast walks through walls it can see over; an
enemy has a leash. All four integrate in WORLD SPACE and resolve their feet
against a column-top query. Hanging any of them off a `THREE.Object3D` means
rewriting all four in local space and forking every measured constant in them.
So a carrier does two much smaller things instead: it publishes the motion it
performed THIS SLICE (`dx/dy/dz/dyaw`), which a rider adds to its own world
position before its ordinary physics runs; and it answers `topAt`, so its deck
is a floor by exactly the mechanism a hut roof is. A mover gains ONE field and
TWO calls (`CarrierRide`), and learns nothing about frames.

**JUMPING OFF RETURNS YOU TO THE WORLD BY CONSTRUCTION**, which the issue asks
for explicitly and which nobody had to write: a rider is attached exactly while
it is inside `contains`, so the frame stops being applied on the first slice the
body is outside it. There is no detach event to miss and nothing to reset.

**`contains` TAKES A `y`, AND THAT IS THE WHOLE SAFETY OF THE FEATURE.** The
deck is ninety units over a meadow somebody is walking across; a containment
test that could only see the column would teleport that walker into the sky the
moment the island drifted overhead. The volume is the airspace ABOVE the deck
(`RIDE_CEILING` 22, `RIDE_FLOOR` 1.2) and never below it, so walking, swimming
or flying UNDER a carrier is unaffected — and stepping off the rim is a fall.
`CarrierRide.support` is gated on being attached for the same reason, which is
what makes it safe to fold into a step test that only takes (x, z).
`CarrierRegistry.ceilingAt` is the ONE query that ignores the volume, and it
exists for one caller: a flying mount's ceiling is clearance over the ground
under you, and with an island overhead the ground under you is eighty units up —
without it the one place in the world that can ONLY be reached by air is the one
place the flight ceiling forbids. It must never be used as a surface.

**`carriers.advance(dt)` RUNS AT THE TOP OF THE SLICE**, in `simulate()`
(main.ts) and NOT inside `World.update`. The world update streams chunks and runs
at the END of a slice, so a delta published there could only be spent by the
riders on the NEXT slice, and a hero standing still on a deck would lag it by a
slice's travel every time it changed speed.

**Skyhaven** ([src/world/sky-island.ts](src/world/sky-island.ts)) is the one
carrier this build ships, and it is BUILT OUT OF CUBES. It shipped once as a
smooth radial mesh, on the reasoning that a voxel island at the town's own 0.28
gauge would cost 148k columns. That reasoning was right about the scale and
wrong about the conclusion: the answer is a COARSER CELL, not a smooth surface.
Everything else in this game is cubes and the reference art for this island is
emphatically cubes, so a smooth landmass in the middle of it reads as an object
from another game.

**THE PLAN IS DRAWN AT A COARSER GAUGE THAN THE WORLD IS BUILT AT, AND THAT IS
TWO NUMBERS ON PURPOSE.** The island is authored from a top-down block map
(`shots/ref/map-top.png`, and `shots/ref/SPEC.md` is that map read out into
numbers). The map is 52 blocks across; ONE OF ITS BLOCKS IS THREE OF OUR CELLS.
So `CELL` is 1.2 world units — twice the settlement's own `SV` of 0.6, which
puts a cottage wall at two courses to a cliff's one — `MAP_BLOCK` is 3, and
`MAP_R` is 26, giving `ISLAND_R = MAP_R * MAP_BLOCK * CELL` = 93.6, i.e. 187
units across. Keeping the two gauges apart is what lets the LAYOUT be authored
in whole readable blocks while the ROCK keeps a finer silhouette.

**IT GOT THREE TIMES BIGGER AND THAT WAS A CORRECTION, NOT A WHIM.** It was
53.7 units of radius — "8 times the AREA of the Encampment", a defensible
reading of the issue, and a landmass you could see whole from the ground. It was
also far too small for the town the plan puts on it: at that size a dozen
buildings and a tower already filled it, and every critique of the early passes
came back to density and to empty lawn. The cost is real and worth stating: the
scene's aerial perspective fades a surface into the sky over 150..420 units, so
an island 187 across cannot be framed whole without some haze on the far side.
`tools/shot-sky.mjs` frames at about 1.5 radii for that reason.

**`deckAt` IS THE AUTHORITY TWICE OVER** — the mesh's top course is painted from
it and `localTop` answers every step test with it — which is the road ribbon's
rule (below) applied to a second surface and for the same reason: what you see
is what you stand on BY CONSTRUCTION, not because two formulas currently agree.
It is asked of the CELL rather than of the point, because the mesh is painted
per column: a query on the continuous position would put the edge of the ground
up to half a cell from the edge of the cube, and you would walk half a metre out
over the drop.

**THE DECK IS ONE LEVEL, AND THE REASON IS AN ENGINE RULE RATHER THAN A
PREFERENCE.** The plan shows a raised quarter with a stone stair up to it, and
it is not built. `MAX_STEP_UP` is 0.5 and `measureFootprint`
(world/structures.ts) only turns material ABOVE 0.5 into a collider, so a
STAMPED voxel staircase can never be climbed at any voxel size: a step under 0.5
is not a floor, and one over it is a wall. The island's own deck is the one
surface that could carry a walkable ramp — `deckAt` is a function rather than a
collider — but the painted mesh would have to agree with it to a fraction of a
cell, and that is unbuilt work. Terracing the plateau properly means changing
how a footprint becomes a floor, which touches every settlement in the game.

**ONLY THE SHELL IS PAINTED.** A filled island at this size is hundreds of
thousands of voxels, which is a second of boot and a great deal of Map for
material nobody can see. `paintColumn` paints a cell when a face of it can be
seen: in the top courses, at the bottom of its own column, or where a neighbour
is shallower. The keel's taper is QUANTISED to `LEDGE` so the underside is a
stack of shelves rather than a cone with a staircase texture, and the roughness
is applied in whole ledges at a coarse hash — noise finer than a shelf erases
the terracing it was meant to break up, which is how one pass shipped an
underside that looked like a hairbrush.

**IT DOES NOT FLY INTO MOUNTAINS, AND THE MECHANISM IS A FLOOR RATHER THAN AN
AVOIDANCE BEHAVIOUR.** `steer` samples the height field under its own footprint
and along its heading (13 samples a slice) and holds the keel `KEEL_MARGIN` (14)
over the worst of them, rate-limited so it rides up a ridge instead of snapping
over it. The horizontal wander is then free to go anywhere, because there is
nowhere it can go that the altitude rule does not already cover — a steering
behaviour would have to be right every time to avoid the one case that matters,
where this is right by not being able to be wrong.

**THE ROCK IS TWO MESHES AND THE REASON IS THE SHADOW MAP.** It was one, sharing
the rim ring so there could be no seam — and a mesh that both casts and receives
shadows SHADOWS ITSELF, which for a hundred-unit lid directly over its own
underside means the keel renders uniformly black whatever its normals or its
colours say. The deck receives (the huts' shadows on the grass are most of what
tells you the town is standing on something) and the keel does not; the rim ring
is emitted into both from the same `pushRing` at the same `d`, so the two share
vertex positions exactly and there is no crack. Its normals are then bent
OUTWARD (`wrapKeelNormals`): the underside of a floating island is the one
surface in this game that faces away from every light in the scene, so it is lit
as a cliff rather than as a ceiling. Two more things learned by capture — ONE
winding serves both halves, because the deck's rings ascend in radius and the
keel's descend so the facing flips on its own, and "winding the second half the
other way to compensate" ships an island whose grass is a black disc from above;
and the keel needs LOBES, because a pure function of the radius is a bowl and
the silhouette is the only part of the underside a player ever sees clearly.

**CLOUDS ARE DROPPED AROUND IT, NOT MOVED, AND THE TWO ANSWERS THAT MOVE THEM
WERE BOTH BUILT FIRST.** `Clouds.setKeepOut` takes the island's deck, its keel
depth and a radius, and `writeMatrices` gives a zero scale to any puff whose box
overlaps that cylinder. Pushed radially OUT, every puff the island touches lands
on ONE CIRCLE and it sits in a canyon of cumulus with a white wall across every
frame. Pushed VERTICALLY they land on one PLANE — a solid ceiling thirty units
over the town, which is worse, because it is between the island and the sun.
Widening either only moves the artefact further out and takes a bald patch of
sky with it: a displaced cloud has to go somewhere, and everywhere is somewhere
another cloud already is. Not drawing it has no pile-up to have, and the hole is
in the one place a player cannot see a hole — the island is standing in it. The
bubble is deliberately generous (`koR * 2.4`, and `KEEP_OUT_GAP` 48 above the
deck) because the island cruises INSIDE the 80-142 cumulus bands, so anything
tighter leaves a cloud between the camera and the town from every angle a player
can fly to.

**THE FLYING TOWN IS ON THE TOWN REGISTRY LIKE ANY OTHER, AND ITS POSITION IS A
READING.** `TownInfo.carried` says so, and it is on the QUEST-FACING contract
because it changes what a consumer may DO with the position rather than merely
what the position is: a compass chip has to be re-read every frame (`_townChips`
in main.ts, which is the whole of "the compass is aware of the town's updated
location"), an objective cannot cache a distance, and anything reasoning about
the ground under it has to ask the carrier rather than the height field.
`TownData.carried` is where it is authored; `planSettlements` skips those
outright — no siting, no road, no yard — and a carried town's layout is selected
from a SECOND factory kind (`carried-layout`), because a ground layout is handed
a road network and a site on the height field while a carried one is handed a
deck and its own local origin, and a factory table where a lookup can return the
wrong SHAPE of function is a runtime error in exchange for one fewer variable.
`tools/test-structures.mjs` skips carried towns for the same reason its walks
would be meaningless: their colliders are in the carrier's frame.

**THE PEOPLE ON IT ARE THE ORDINARY NPC SYSTEM IN A DIFFERENT FRAME.** `Npcs`
takes an optional `NpcFrame` (world/npc.ts) and everything inside it — the
placement search, the clearance tests, the conversation state, the culling —
runs in that frame's coordinates and never finds out which one it is; `update`
republishes `NpcInfo` in WORLD coordinates once a slice, because the talk test
in main.ts is asked about a hero whose position is a world position and must not
have to know either. The three residents are one parameterised body
([src/world/npc-skyfolk.ts](src/world/npc-skyfolk.ts)) rather than three files:
what distinguishes one villager from another at conversation distance is colour,
prop and idle, not skeleton. `World.npcs` is then a COMPOSITE of the two crews
(`NpcFields` in world/index.ts) — two instances, rather than a per-character
frame and a branch in every loop.

**A NEW RIG'S Z-FIGHTING OFFSETS ARE FOUND BY RUNNING THE TOOL, NOT BY READING
THE GEOMETRY.** The skyfolk needed four separate parts — the shoulder in x, the
elbow in x AND z, and the held prop in x, y and z, two of them per-character —
and none of them is derivable from the numbers in the file, because which joint
lands on a shared face grid depends on where each model's own bounds fall on the
voxel lattice. Two measured facts worth keeping: a part of 0.002 does NOT work
(`test-zfight.mjs` calls two faces coincident within 0.004, so it is still one
plane), and a prop is a THIRD joint out — the offset that parts it from the arm
holding it is not the offset that parts it from the torso behind it. All three
rigs are at 0.

`tools/test-carrier.mjs` is the guard and it exits non-zero. Everything it
asserts is about `onDeck` — the hero's position in the island's OWN coordinates
— because that is the one thing neither a world position nor a screenshot can
say: a man on a deck looks identical whether he is riding it or falling past it.
It is a PAIR twice over. Parked on the deck, the island must travel (17.86 units
in 9 s) and `onDeck` must not (drift 0.000) — the first half alone passes in a
world where the island never moved. Stepped past the rim, he must detach and
fall (34 units in 0.9 s) — without it, "onDeck never changes" also passes for a
hero glued to a frame he can never leave, which is the opposite defect and the
one the issue explicitly asks against. And parked on the GROUND UNDERNEATH he
must not attach and must not be dragged, which is the assertion that would catch
a `contains` that forgot its `y`; it is measured against the island's own travel
rather than against zero, because a hero standing in open country moves 1.56
units in four seconds from a wild spawn's knockback alone.

**Towns and roads.** [src/world/towns.ts](src/world/towns.ts) sites the named
settlements, cuts the roads between them and picks `World.spawnPoint` — a point
on the road to the start town, not in it. Towns are OVERWORLD LANDMARKS, not
zones: you walk in and out and nothing loads. The `TownRegistry` it returns is
on the `World` contract (`world.towns`), and everything else is derived from it —
the roads, the spawn, the compass chips, the trodden mud each settlement wears
its ground down to (`Terrain.grounds`, a `GroundPatch` per entry), and whatever a
quest system asks next; nothing outside these files reads town geometry.

**`spawnPoint` IS THE WORLD'S REFERENCE POINT; `playerStart` IS WHERE THE PLAYER
WAKES UP, AND THEY ARE NO LONGER THE SAME PLACE.** The hero used to begin on that
scenic stretch of road with the camp a destination fifty units off. He now begins
INSIDE it — beside the start town's greeter, at the fire, facing the way the
greeter faces, with the camera in FRONT of him rather than over his shoulder.
Measured on seed 1337: start (113.71, 12, 58.21) against Gain at (116.9, 12,
58.10), 3.20 apart, 0.00 degrees of facing between them, 0.00 degrees between the
camera arm and the hero's own heading, and 54.77 from `spawnPoint`.

Both numbers exist because they answer different questions, and collapsing them
would be wrong in four places at once: the skill dens are sited on rings around
`spawnPoint` (`placeShops`), the streaming ring is warmed from it, `?cam=`/`?look=`
are OFFSETS FROM IT so every capture in `shots/` is framed against it, and a
zone's return gateway lands on it. None of those wants to follow the hero into a
camp. So `spawnPoint` is unchanged and unmoved, and `World.playerStart`
([core/types.ts](src/core/types.ts)) is a POSE — a position AND a yaw, because an
opening shot is a composition and half of a composition is the facing.

**IT IS DERIVED, NOT AUTHORED.** `pickPlayerStart` in
[world/index.ts](src/world/index.ts) takes the start town, finds whoever stands
nearest its middle, and steps `START_BESIDE` (3.2) PERPENDICULAR to that
character's rest facing. Nothing in it names Gain or the Encampment: a package
that moves the start elsewhere moves the player with it, and a zone with no
settlement or nobody in it falls back to the road, which is exactly what the game
did before. Two things fall out of the perpendicular and are the reason it is not
"three metres in any free direction" — the hero lands the same distance from the
fire the greeter is, so he is AT it rather than three metres further into the
dark, and he never lands between the greeter and what the greeter is looking at.
The candidate is tested with `spotIsFree`, the NPC placement search's OWN test
(exported from [world/npc.ts](src/world/npc.ts) rather than restated), because a
spot the hero may stand on and a spot a character may stand on are the same spot
— and the camp's cart road ends in the middle of camp, so that is not a
formality.

**3.2 IS PICKED AGAINST `NPC_TALK_RANGE` (2.8), JUST OUTSIDE IT.** Inside, Gain
turns to attend the hero on frame one, so the two of them face each other, the
side-by-side composition is gone before anyone sees it, and an interact pill sits
over the shot. One step closes it, so the conversation is still the obvious first
thing to do.

**A PROBE THAT DRIVES THE HERO CAN NO LONGER ASSUME OPEN GROUND, and three of
them had to be told.** Two facts about the opening pose bite anything that holds
W: the camera is in FRONT, so `cam.forward` runs through the hero into whatever
is behind him — measured, **2.73 units and then a hut wall**, against **8.66**
along his own facing — and he is inside a WALLED camp, so a straight line in any
direction ends at the palisade unless it goes through the gate. Aimed at the zone
gateway from the fire, eight seconds of walking closed 4.3 units of a 43.2-unit
approach.

So `travel > 4` as a proxy for "the hero is being simulated" now reads the camp
rather than the feature under test. `tools/test-pause.mjs`'s `walk()` aims at the
hero's own facing before every hold (re-aimed each time, because `Player.reset()`
puts the camera back on his face and its second arm exits to the title and starts
again). `tools/test-gfx.mjs` goes further and `__dbgTp`s to `spawnPoint` — the
road is what that file silently had when it was written, and saying so is better
than a spawn that happens to be convenient. Its gateway-preload section does the
same and then asserts `endedAtGateDist < 30`, which is the assertion that would
have caught this: without it the section passes VACUOUSLY, since grass switched
off stays off when nothing ever preloads. After a teleport it also waits on
`__dbgZone().streaming` rather than a clock — a 55-unit jump rebuilds the whole
view ring, and a chunk arriving mid-measurement moves a draw count more than some
of the toggles do (the failure reads as `propsOff` saving **minus 17** calls).

**THE CAMERA ARM IS THE HERO'S HEADING AND NOT ITS OPPOSITE**, which is the
reverse of every other camera write in the game — `cam.yaw` is the bearing FROM
the hero TO the camera, so the usual over-the-shoulder framing is `heading + PI`.
It is a SHOT, NOT A MODE, and it un-does itself: movement is camera-relative, so
the first press of W walks the hero toward the lens and his heading damps round
to meet it inside a few hundred milliseconds (`TURN_RATE`); a mouse movement
swings the arm and skips even that. That is intended — the composition is for the
moment before the player touches anything, and any input at all is the player
saying they are done looking at it. `Player.takeStartPose()` is the one writer,
called by the composition root's first placement AND by `Player.reset()`, so a
second New Game in one session opens on the same shot. `__dbgStart()` reports
every number above and the `openingPose` section of `tools/test-npc.mjs` asserts
them.

Roads are CARVED:
[src/world/roads.ts](src/world/roads.ts) folds a corridor into `heightCont` and
makes `getHeight` return a CONTINUOUS deck inside the carriageway, because a
floored column can only step a whole unit and `MAX_STEP_UP` is 0.5 — read the
header there before touching either. All of it (both towns' meshes, the road
ribbons, the lamps, fences, fingerposts and bridges) is built ONCE at world
creation on the shared prop/terrain materials, so the chunk streamer is
untouched; [src/world/town-parts.ts](src/world/town-parts.ts) holds the voxel
builders and the three rules they obey. `towns=0` removes the lot, and
`__dbgTowns()` reports the registry, each road's measured worst step and grade,
and where every lamp and fingerpost ended up. WHICH towns exist is no longer in
this file: since issue #60 the sites come from `town:` assets in
[src/content/data/core.json](src/content/data/core.json) — id, name, sign,
layout, radius, colour, order, and which one the player starts at — and
`towns.ts` owns only how they are SITED and BUILT. Adding a settlement is an
asset plus, if it needs a shape neither `camp` nor `hamlet` has, a
`town-layout` factory. Note the planner is a hub with one trunk and two spurs
and is written around exactly three roads: a fourth town is reported and left
unbuilt rather than silently misplaced.

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

**THE SKILL DENS ARE BUILDINGS TOO, and they were the last one that was not.**
A den ([src/world/shops.ts](src/world/shops.ts)) is not in the town registry —
it is sited on its own ring out of `placeShops` — so it was never reached by any
of the above, and the hero walked in one side of the pagoda and out the other,
through the back wall, the counter and the shelf of potion bottles. It has its
own `StructureField` for the same reason `Npcs` does (a field is frozen by
`build()` at the end of its owner's constructor, and the dens are placed before
`Towns` exists), and `structureTop` in world/index.ts takes the max of the
THREE. 24 boxes, six per den: the back-and-sides shell, two front corner posts,
the counter and a banner apiece. No town's budget moved — a den is never sited
inside one.

The ROOF is bracketed with `VoxelModel.region` and gets no ridge cylinder, and
both halves of that are deliberate. Bracketed, because the lowest course sits
1.95 units over the deck — a hair under `WALK_UNDER`'s 2.0 — so measured as body
material the eaves are a lid over every column of the den, the flood fill joins
the whole model into one 4.35-unit box, and the open front a player buys through
becomes a wall. No cylinder, because `measureRidge` fits an arc along a CREST
and a pagoda is a square stepped pyramid whose crest is a single finial voxel:
the roof is 1.95 up, unwalkable, and there is nothing here to climb onto it
from. The walls are what stops you, and the walls are boxes.

Its guard is the `dens` section of `tools/test-structures.mjs`, and the thing
worth knowing about it is that THE CONTROL ARM IS THE GATE. It walks in from
BEHIND, where the wall is, and separately from the FRONT to assert the opposite
thing — that the hero still ends within the 3.5 units `nearShop` opens a shop at,
because a collider that stops him five units out passes every "is it solid" test
there is and ships a shop nobody can buy from. Neither claim is made where the
`solids=0` walk did not reach the den: measured, one of the four dens sits above
ground that terraces a full unit against a `MAX_STEP_UP` of 0.5, so the terrace
stops him in both arms and that walk says nothing about the shop. It is reported
inconclusive, and the run fails only if no den could be measured at all. The
front makes no claim about reaching the middle either — a pagoda is open along
its sides between the counter and the corner posts, and a hero who walks in
through that gap has gone through a doorway rather than a wall.

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

Since issue #60 the split is one file deeper, and along the line the content
system draws everywhere else: `npc-gain.ts` keeps the BODY (`build`, `animate`,
registered as the `npc-body/gain` factory) and everything else about him — which
town, how near the middle, which side of the fire, and what he says — is the
`npc:gain` asset. The quest seam the paragraph above promised is now literally
data: `talk` is an ORDERED list of `{ when?, line, actions? }` and the engine
takes the first entry whose condition passes, so an offer and a turn-in are two
more entries rather than a rewrite. Gain ships with exactly one, ungated, which
is why he says today what he said yesterday. `NPC_BODIES` in
[src/world/npc.ts](src/world/npc.ts) is the code-side roster and stays a plain
module constant for a reason: `tools/test-zfight.mjs` builds every rig in the
game headless under Bun, where no content is bootstrapped, and a roster it could
only get from the content runtime would come back empty and silently stop
covering anybody.

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

**HOW MUCH OF EACH THING GROWS IS A NAMED NUMBER, AND AN AREA ADJUSTS THE
BASELINE RATHER THAN REPLACING IT.** That is issue #50, and it is why every
parameter in [src/world/nature.ts](src/world/nature.ts) is a dimensionless
MULTIPLIER whose default is exactly 1 — `trees`, `grass`, `flowers`, `bushes`,
`rocks`, `reeds`. The baseline IS the tuned world `props.ts` already builds,
with every measured threshold and every comment saying what it was captured at
left where it is; an area then says "half the trees" instead of "trees at 0.40
acceptance", so a per-area value cannot fork from the baseline it came from.
Move the baseline and every area moves with it. An "area" is a `BiomeId` today,
because that is the world's only existing notion of somewhere with its own
character and `props.ts` already dispatches its whole scatter off it.

`?nature=trees:0.5,forest.grass:0` before the first chunk, `/nature` live (no
arguments lists the table), `__dbgNature()` to read and `__dbgSetNature` to
write. A change fires `World.rebuildProps()`, which drops every streamed chunk
and builds it again — the densities are read inside `buildChunkProps`, so
nothing short of that reaches the ground already under your feet. It is a
TUNING path and nothing in the frame loop calls it.

**AT THE SHIPPED VALUES THE PLACEMENT IS BIT-FOR-BIT WHAT IT WAS**, and that is
the property that makes a knob safe to add to code tuned against captures for
months. It holds by construction rather than by luck: an acceptance rate is
multiplied (`roll < 0.80 * f`), a count goes through `natureCount`, which is a
`Math.round` of an integer at 1, and `thin` returns false WITHOUT hashing at
`f >= 1`. `tools/test-nature.mjs` measures it — its identity section sets a
parameter to its own baseline, rebuilds all 89 chunks and reads **drift 0**.
That section is the CONTROL, and without it every other number in the file is
equally consistent with "a rebuild changes the count".

Three rules about where a factor may be applied, all of them learned from the
shape of `props.ts`. A LADDER BAND is never moved — the scatter and mid-scale
passes are one shared `roll` against cumulative thresholds, so a boundary that
gives up width hands it to whatever prop is next, and "fewer rocks" would
silently mean "more hedges"; a lone stamp on a band is thinned by `thin`
instead, which is a positional hash and NOT an `rng()` draw, for exactly the
reason `trodden` gives — a draw here would re-scatter the vegetation of every
chunk in the world. An `else if` body is BRACED before a thinning test goes in
it, or a thinned grass blade falls through to the next band and plants
deadwood. And `thin` only ever REMOVES: things that come in groups (a clump's
tussocks, a boulder outcrop, a reed stand) scale their COUNT and so grow past 1,
where a lone stamp has nowhere to put a second one. Measured at the extremes:
`grass 0` leaves 7.5% of the soft mesh standing (reeds, shells, driftwood — not
grass), `trees 0` leaves 41% of the solid mesh (boulders, logs, hedges).

One consequence worth stating rather than discovering: a meadow CLUMP is the
unit `grass` scales, and a clump carries the flower and the bush inside it, so
`grass 0` in an area takes those with it. The mid-scale pass still plants hedges
there, so `bushes` is not lost with the sward.

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

**A SAFE ZONE IS A SPAWN RULE, NOT A WALL**, and that sentence is the whole
design. [src/world/safe-zones.ts](src/world/safe-zones.ts) is one registry of
discs the wild population may not APPEAR in, reached as `World.safeZones`
(contract and argument in [src/core/types.ts](src/core/types.ts)). A monster
that is hunting you follows you across one — being chased through the gate and
down the high street is the fantasy, and a leash that stopped at a line would
turn every settlement into a place the game visibly gives up at. What a zone
forbids is the two ways a hostile arrives WITHOUT the player's involvement:
materialising inside it (`trySpawn`, combat/index.ts) and idly ambling in off
the meadow (`pickWanderGoal`, combat/enemies.ts). Both are one squared-distance
refusal of a candidate POSITION, so neither can strand anything — a wanderer
already inside walks home, and a hunter never asks.

A REFUSAL AND NOT A RE-ROLL, deliberately: a rejected candidate means that tick
spawns nothing, so a keep-out THINS the population near a settlement. Shoving
each rejected enemy to the nearest legal metre instead would queue them along
the boundary, which is a worse picture than an empty meadow and reads as exactly
the wall the feature is not.

**A TOWN HAS ONE BY DEFAULT; A POINT OF INTEREST ASKS FOR IT.** That asymmetry
is the requirement rather than an omission — a settlement is somewhere the
player is meant to be able to stand still, where a landmark in the open world is
scenery until a designer decides otherwise, and a keep-out thins the meadow
around it. So a town's is DERIVED (`outerRadius + TOWN_NO_SPAWN_MARGIN`, 6:
neither shipped town authors one, and `outerRadius` rather than `radius` because
the question is what you can see from inside the walls) and content may override
it with `noSpawnRadius`, 0 being a real value that switches it off for a
settlement meant to be under siege. A POI's default is 0, i.e. none: the skill
dens say nothing (`DEN_NO_SPAWN_RADIUS`) and the zone gateway asks for 12 in
main.ts, because a threshold is somewhere the player is held still by a preload.
The margin's number comes from the spawn ring — a candidate lands 25-60 units
from the player, so with no margin the first legal ground is a metre past the
palisade, which from inside still reads as "it spawned in the camp".

`__dbgSafeZones()` is the census and `__dbgSafeZones(x, z)` asks the same
question `trySpawn` does; `tools/test-safezone.mjs` is the guard and it exits
non-zero. It is a PAIR at one column, and neither half means anything alone:
"nothing was ever seen inside the Encampment" is equally true of a working
keep-out and of a world where nothing spawned, so the hero is parked 40 units
out (where the ring sweeps the town but anything aggroing him walks away from
it) for a closest approach of 31.71 against a 29.76 disc, with 338 sightings
just outside it as the control — and is then LED in, which is the other half.
Teleporting him to the middle and waiting does not work and was tried: the
closest anything came was 31.08, an idle wanderer that had never noticed him.
An enemy has to be walked up to, acquired, and then walked into town in hops
short enough to stay inside its leash; done that way something reaches 22.

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

**A COMPANION THAT CANNOT WALK TO YOU TRAVELS AS LIGHT.** Issue #70, and the
thing to understand first is that it is not only the walkers: every companion in
this game follows your COLUMN rather than you. A walker resolves against
`getHeight` and a FLYER hovers 1.55 units over it (`updateFlying`), so a hero on
a galebird, on Skyhaven's deck, or on top of a cliff leaves both beasts piled up
on the meadow underneath, animating a follow they can never complete — and the
leash that was supposed to catch that, `TELEPORT_DIST`, measures x and z only,
so a hero ninety units up is nine units away by the only number it takes.

**IT IS A WITHDRAWAL, NOT A PATH.** Making the walkers climb means a second
locomotion for every species and a beast standing on nothing. So a beast whose
owner is out of reach dissolves into a streak of light (`LightBeam`), rides
along with him with no physics, no collision and nothing to target, and re-forms
beside him the moment there is a surface to stand on — which is both halves of
what the issue asks for, "once the player lands" and "flies next to ground and
gets attacked". `inTransit` is how the rest of the game knows: main.ts keeps a
travelling beast out of `world.disturb` (it has no feet to part the grass with)
and out of the friendlies list handed to combat (an enemy that picked it as a
target would stand under the hero swiping at nothing), and `takeDamage`,
`wantsSupportCast` and `beginFetch` all refuse while it stands.

**LEAVING AND ARRIVING READ THE SAME NUMBER.** `reach` is the owner's feet above
the surface a beast would be PUT DOWN ON at its own station point — the same
answer `teleportTo` produces, which is why it is a method and not an expression
at two sites. Out past `BEAM_RISE` (13), back inside `BEAM_LAND` (4.5), and the
gap between them is hysteresis: a hero standing on a canopy platform is fourteen
units over the forest floor his companion would land on, and a rule that used
two different measurements would strobe the beast in and out for as long as he
stood there. `BEAM_LAND_FIGHT` (14) is the combat exception — main.ts sets
`supportNeeded` when something hostile is within `SUPPORT_CALL_RANGE` of the
hero, and a wanted companion re-forms from three times as high. It still needs a
surface, so that can never put one in open sky.

`tools/test-companion.mjs` is the guard and it exits non-zero. It is a PAIR
twice: on the ground the beasts must be BODIES beside him (without which "in
transit while flying" passes equally for a build where they are permanently
light and never come back), and in the air they must be in transit AND still
report ~2 units away (without which it passes for a beast that dissolved where
it stood). The mounted beast is skipped — it is under the reins and never runs
follow steering at all, which is why the probe reads `ridden` rather than
assuming which slot the hero climbed onto.

**Combat.** `CombatSystem` ([src/combat/index.ts](src/combat/index.ts)) owns VFX,
damage numbers, shard pickups and the wild-enemy population, and executes casts by
switching on `SkillDef.targeting`. A new skill is usually data — a `SkillDef` in a
species file — not new code.

**Items and the inventory.** [src/core/items.ts](src/core/items.ts) is the
catalogue and the bag; [src/ui/inventory.ts](src/ui/inventory.ts) is the screen
and [src/ui/inventory-stage.ts](src/ui/inventory-stage.ts) the 3D preview at the
top of it; every RULE about what a player may do to a thing they own is in
main.ts beside the state it governs. Issue #74. `I` opens it (View/Create on a
pad, see `B_SELECT` in core/gamepad.ts) and it is a MODAL — the hero is frozen
while it is up, the F1 sheet's bargain — but it RELEASES POINTER LOCK, the
shop's, because it is a thing you click, drag in and right-click.

**IT IS A RIGHT-HAND DOCK, FULL HEIGHT, and the reason is the stage.** The top of
the panel is a live WebGL canvas showing the hero with his two beasts, each
standing over the gear slot that holds it — lead beast, weapon, support beast,
left to right — and three figures only read as a PARTY given height to stand in.
A centred box tall and wide enough for that covers the world it is a view of;
docked, half the frame is still the place you are standing in, and the panel gets
the one axis a slot wall actually grows along.

**THE WALL IS ELEVEN ACROSS AND THREE DEEP, and every one of the thirty-three
cells is drawn whether or not there is anything in it.** That is the difference
between an inventory and a receipt: a player learns where things are by their
POSITION, and a grid that reflows every time a stack empties has no positions to
learn. `INV_COLS` sets the panel's width, is handed to the stylesheet through
`--cols`, and is what the keyboard's up/down steps by to mean "the row below" —
a media query that narrowed one without the other would leave arrow-down
skipping slots on a phone with nothing failing, so the phone shrinks the SLOTS
and keeps the eleven. Past thirty-three the wall grows a fourth row and scrolls;
a cap that REFUSED items is a different and crueller feature.

**THE PANEL KNOWS NO GAME RULES.** It is handed an `InventoryModel` — rows with a
name, an icon, some stats and a LIST OF ACTIONS the host is willing to accept —
and reports which one was asked for. It does not know that a quest item cannot be
dropped, that unequipping a sword lowers a stat, or that equipping a beast pushes
another one sideways. That is the split ui/settings.ts already draws (the panel
owns the screen, the host owns what a click means) and the same one
content/types.ts argues for with its factories: adding a RULE is an edit to
main.ts, adding a KIND OF ACTION is an edit to `InvAction` plus one label, and
neither is an edit to the layout. What the panel added when it grew gestures is a
MAPPING, which is a different thing — dropping something on the weapon slot MEANS
`equip` — and each mapping is gated on the host having already listed that action
for the row, so a slot refuses a drag exactly where the host would have refused
the button.

**THREE WAYS TO DO ONE THING, AND A LEFT CLICK IS NOT ONE OF THEM.**
RIGHT-CLICK — or Enter, or A on a pad — runs the row's PRIMARY action, which is
the first one that does not destroy it. DRAGGING onto a gear slot says the same
thing by saying where the item should go, and dragging OFF the panel onto the
scrim drops it in the world. The footer strip carries salvage and drop as real
buttons, on whatever is selected. A left click only SELECTS: nothing destructive
is ever one click from anything, and `DESTRUCTIVE` (ui/inventory.ts) is the one
set that keeps salvage and drop out of the primary, out of the right-click and
out of every drag target at once.

**ESCAPE HAS ONE READER, AND IT IS THE HOST'S SLICE.** A keyboard's Escape, the
pad's B and Start, and the touch overlay's MENU button all arrive as one code in
main.ts's cancel branch, which closes the TOPMOST thing — so a panel that also
listens for the key on its own gets one press handled twice. ui/pause.ts's
`onKeyDown` says this and deliberately omits Escape; ui/inventory.ts does the
same. THE SHOP DID NOT: it added a `document` keydown listener while it was
open, which closed the den SYNCHRONOUSLY, and by the time the slice read the
same press there was no modal left — so the slice took its other branch and the
in-game menu came up behind the closing shop. One key, two panels. The listener
is gone; the X and the scrim stay, because those are clicks.

**AND EVERY DELIBERATE RELEASE GOES THROUGH `Input.releaseLock`, NEVER STRAIGHT
TO THE DOM.** `tryOpenShop` called `document.exitPointerLock()`, which skips the
one thing that call is for: `releaseLock` clears the INTENT first, and that
intent is the whole of how `onLockLost` tells "the browser took the pointer
because the player pressed Escape" from "we gave it up on purpose". Released
raw, the lock vanished while `lockWanted` still stood, `onLockLost` tapped a
virtual Escape, and the next slice closed the shop that had just opened —
measured, on a machine actually holding a lock the den never stayed open at all.
Anything that hands the pointer back owes this call rather than the DOM's.

**AND NOTHING MAY TAKE THE POINTER BACK INSIDE AN ESCAPE — the inventory was
the third caller to learn this.** `InvCloseBy` says HOW the panel was dismissed
(`escape` / `hotkey` / `click`) and the host re-takes the lock for the last two
and, after Escape, only when `escapeIsLocked()`. The panel shipped with an
unconditional `requestLock()` under a comment arguing the rule did not apply
because it is "closed with `I` as often as with Escape" — it is closed with
Escape just as often, and that is the key the browser is spending. Where there
is no keyboard lock the same press is also leaving fullscreen, which drops the
pointer lock ~8 ms later, and `Input.onLockLost` reads the loss as a fresh
Escape: one press closed the inventory and opened the in-game menu behind it.
That is the SAME defect `PauseMenu.onClose` and `updateCursorMode` were both
fixed for, so a new panel that releases the pointer on the way in owes this
question on the way out. Section 10 of `tools/test-inventory.mjs` is the guard,
and it is a PAIR: the menu must not appear after Escape, and a lock taken with
NOTHING open must still raise it — without the second half the first passes
against a build where the hook is simply dead.

**NOTHING IS EXPLAINED IN A SENTENCE.** There was a line along the bottom
reading "I or Esc to close" and another reading "Right-click to Equip", and both
are gone: a control that is BOUND to something wears its key or its button as a
small glyph beside the action instead. The close X has the two caps printed next
to it; the primary action is a button with a mouse glyph on it; Salvage and Drop
have no binding and so carry nothing, which is the rule working rather than an
omission. Every glyph is class `.cap`, so the phone media query can take all of
them out at once — there is no keyboard to press Esc on and no right button to
click, and an icon for hardware that is not there is worse than no icon.

**THE TOOLTIP IS THE DESCRIPTION.** There was a detail pane and it cost a third
of the panel's width for the one row the cursor happened to be on — on a dock,
the difference between five columns and three. A tooltip costs nothing until the
pointer is over something, and the actions the pane used to carry moved to the
footer, because a tooltip cannot be clicked: that is exactly what makes it the
right place for a description and the wrong place for a button. It is clamped
into the window rather than flipped at a breakpoint — the dock is against the
right edge, so every slot in it is within a tooltip's width of that edge and
"left of the pointer" is the normal case. A GEAR SLOT PRINTS ITS ROLE AND NOT
THE NAME of what is in it: the picture already says which beast that is, and the
name was the only thing in the strip that changed width, so the three slots
jostled every time the party changed.

**THE STAGE IS A SECOND WebGLRenderer, and that is the decision that file rests
on.** One renderer draws to one canvas, so putting the cast through the main one
means rendering the world, rendering the cast, copying and rendering the world
again — and the world is 67% of the frame. A second context costs its own program
links, so it is built on FIRST OPEN and kept for the session; closing the panel
stops the loop and disposes nothing. ITS RIGS ARE ITS OWN, never the roster's: a
`BeastActor`'s rig is in the world scene with the world's shadow layers and the
framework's animator driving it, so borrowing one would either move it out of the
world or fight over its pose every frame. `species.buildRig()` is called again and
cached per species.

**`setCast` WORKS OUT THE WHOLE CAST BEFORE IT TOUCHES THE SCENE**, and that is
a bug fix rather than a tidy-up. Filling the two marks one at a time removed the
previous occupant of each before placing the new one — correct until the two
beasts SWAP, which is the commonest thing the method is asked to do: slot 0 took
the support beast's rig, then slot 1 removed "whatever used to be in slot 1",
the same rig one line later, and one of the two models vanished from the preview
and stayed gone. It now decides the set, removes only what is no longer wanted
and places the rest, so the survivor of a swap is never touched. It also refuses
to put ONE rig at two marks: a `THREE.Object3D` has one parent and one
transform, and a stage that renders what it is handed must not depend on a
caller's invariant to avoid drawing a hole. `__dbgInventory().panel.stageCast`
reports who is in the SCENE rather than who was asked for, because those are
exactly the two things that disagreed.

**A BEAST SLOT SHOWS THE MODEL, BAKED ONE PER FRAME.** `InventoryStage.iconFor`
queues a species, renders it alone into a render target, reads the pixels back
and hands the panel a data URI, which patches the slots showing that species in
place. ONE PER FRAME rather than ten on the first open, because ten rig builds
and ten renders in one task is a visible hitch on the frame the panel appears —
the frame a player is looking hardest at. A slot whose portrait has not arrived
draws the element-coloured lozenge, so nothing waits for anything. The readback
is FLIPPED: WebGL's origin is bottom-left and a canvas's is top-left, and a
portrait written straight in comes out upside down, which looks like a broken
model rather than a broken blit.

**THE FIGURES LINE UP WITH THE SLOTS BECAUSE THE CAMERA IS FRAMED ON WIDTH.** The
gear strip is `repeat(3,1fr)`, so its centres are at thirds of the panel; a
subject at a third of the STAGE's width is therefore drawn over its own slot at
every window size. Framed on the subjects' height instead — which is what shipped
first — the figures drift sideways as the dock's aspect changes and it reads as a
bug in the layout. `BEAST_X` is 0.30 rather than a clean third, and that inset is
measured: a Galebird's outer wing reaches about 1.0 world units and exactly on the
third it went past the canvas edge, where the alternative was a stage 25% wider
and a hero 25% smaller.

**THE GEAR SLOT IS A MODEL, NOT ONLY A NUMBER.**
[src/player/weapons.ts](src/player/weapons.ts) builds the five weapons the atlas
draws icons for, and `HeroRig.sword` is the HAND rather than a sword: it is the
mount `setWeaponModel` swaps what is in. The name is kept because
player/animations.ts writes `rig.sword.rotation` every frame and renaming it
would touch every pose for nothing. `ItemDef.model` names which one, as a plain
STRING — core/ may not import player/, so the rig, the stage and main.ts each
guard it against `WEAPON_MODEL_IDS` on the way in.

Every builder puts the GRIP at the origin with the business end up +Y and works
in the same 0.1 m voxel, so one set of swing keyframes drives all five and none
of them had to move; the only per-weapon numbers are `FIT`'s `scale` and `drop`.
`yaw` is there for exactly one of them: a bow is a FLAT object and the hand's
rest pose presents its plane edge-on, which captured as a hero holding a plain
staff. THE ONE-VOXEL PLANK PROBLEM applies to all of them — the note already on
the original sword — so every blade has a stepped cross-section and the bow gets
its depth from being a curve.

**BARE HANDS ARE A REAL LOADOUT.** Unequipping empties the mount, and
`AnimInput.unarmed` switches the animator to `PUNCHES` — three straight jabs
rather than three sword arcs, because a swing keyframe played with an empty fist
reads as a man flailing. It is an INPUT rather than something read off the rig,
since the animator is handed a rig and a state and reads nothing else.

**THE BOW FIRES AN ARROW, out of the same pool every skill projectile uses.**
`CombatSystem.arrowStrike` is the ranged twin of `meleeStrike` and takes the
same three arguments for the same reason: main.ts decides WHICH by reading
`player.weapon` (off the rig, so it cannot disagree with the model on screen),
combat does it. The arrow has NO element (a physical hit, like the sword), no
homing and no target — every other projectile in the game is cast at something
the game picked, and a bow that curved toward the nearest thing would take the
aiming away from the player who just aimed. It is built along +Z
([src/combat/arrow.ts](src/combat/arrow.ts)) because the pool points it with
`lookAt`, and it neither tumbles nor trails: a spinning arrow reads as a stick
thrown, and sparks off a wooden shaft read as fire. `__dbgShots()` is the
census, and its `arrow` flag is the whole assertion — a shot that came out as a
fireball would be indistinguishable from a working bow in any other reading.

**THREE THINGS ARE DELIBERATELY NOT IN THE BAG, and each for the same reason —
a second copy would be a second answer.** CURRENCY is one running total owned by
combat and spent in main.ts; folding it in would make "do I already hold one of
these?" answer yes for money, which is the fetch rule's whole question. A BEAST is
a `BeastActor` in the roster carrying its own level and learned skills, so the
panel DERIVES a `beast:<species>` row from it (`BEAST_ID_PREFIX`) and the two beast
gear slots write `primaryIdx`/`supportIdx` — the same two numbers Tab and the
bracket keys already move. The issue asks for exactly that ("these can be swapped
when running around in the world... that feature is already implemented"), and the
way to keep a feature working is to not build a second one beside it. And the
WEAPON slot is one id in main.ts rather than a flag on an item, because it is a
fact about the session rather than about any sword.

**A KIND EXISTS BECAUSE SOMETHING BEHAVES DIFFERENTLY ON IT.** That was the rule
when `ItemKind` had two members and it is why it now has seven rather than a
taxonomy: `weapon` moves `Player.attackStat`, `blueprint` carries a power BUDGET
instead of a power, `potion` has an `effect` and is consumed, `quest` is the one
thing the panel must refuse to destroy, `beast` is roster-derived, `stackable` is
what the fetch rule is written in terms of, `currency` is the purse. `salvage`,
`rarity`, `icon` and `descriptionKey` are on `ItemDef` on the same terms — the
panel reads every one of them.

**`applyLoadout()` IS THE ONLY WRITER OF `attackStat`.** Five things change the
answer (equip, unequip, a draught, that draught expiring, and Exit to title) and a
derived value edited at five sites is a derived value that is wrong at one of
them. `BASE_ATTACK` is read off `Player` once at boot rather than written down;
`Player.reset()` deliberately does not touch the stat — it is not session state
from the player controller's point of view — so the reset path calls
`giveStartingKit()`, which re-equips and recomputes.

**A DROP IS A POSITION RULE, NOT A TIMER.** An item dropped from the panel lands
at the hero's feet, and armed it magnets straight back into the bag it just left.
`Pickups.spawn(..., armed=false)` makes it ignore the player until they have
stepped outside `MAGNET_RANGE` once — walk away and it is a real drop, change your
mind and it is still there to walk back over. A hold-off in SECONDS is the obvious
alternative and cannot work: short enough to allow a second thought is short
enough to pick itself up, and long enough to be safe is long enough that changing
your mind no longer works. `findJob` skips unarmed drops too, or the support beast
fetches back the thing you just threw away.

**THE SUPPORT BEAST ONLY EVER FETCHES A STACKABLE.** `worthFetching` used to read
"currency, or anything you already hold", which was the same set when the only
non-currency items were sunberries. It is not now, and the HUD's chip row is the
readout for exactly this rule — a chip is up precisely when the beast will fetch
more of that kind — so weapons and blueprints are off both. Every rare drop is
therefore something the player walked over themselves, which is also what makes
the 1-in-25 in `killEnemy` mean something.

**THE FORGE IS NOT BUILT.** Blueprints are collectable, inspectable and carry
their `maxPower`; the Forge button says what it is waiting for, which is a better
answer than an item with nothing to do at all. When it lands, "some legendary
attributes might add a small bloom to the weapon" is the renderer's half of
`ItemRarity` — the field is already read by the panel's slot edge.

**A QUEST ITEM'S ONLY SOURCE IS CONTENT.** `item.give`
(`{ "do": "item.give", "item": "gain-token", "count": 1 }`) is registered in
main.ts above `bootstrapContent` — the cross-asset pass reports an action no
`defineAction` registered, so a later registration is a handler the validator
never saw. It is the seam a dialogue turn-in lands on, and no shipped content
uses it yet. `/give` reaches the same code from the console.

`tools/test-inventory.mjs` is the guard and it exits non-zero. Every claim in it
is about a number the SCREEN CANNOT SHOW — an icon in the weapon slot looks
identical whether or not equipping it did anything, so equipping is asserted on
`attackStat` (14 -> 18 -> 14); a dropped item looks identical to a deleted one, so
Drop is asserted on the thing being on the ground a second and a half later. Four
sections are PAIRS for the usual reason: `I` opens it AND the hero travels 0 with
it up against 6.47 with it down, right-click unequips AND puts it back, salvage
removes the stack AND pays the blueprint's 3, drop removes the stack AND leaves a
mote that does not come back. The quest item is the CONTROL — it is asked to drop
and to salvage through the HANDLER rather than through the panel, because a
refusal that lives only in which buttons were drawn is a panel bug away from
deleting someone's quest; the potion dropped on the weapon slot is the same
control for the drag mapping.

Three things in it are worth knowing before adding a section. `page.hover`, not
`page.mouse.move` — a bare CDP mouse move does not make the browser synthesise
the `pointerover` the tooltip listens for, and the version that used one read a
null tooltip against a panel that worked perfectly in the hand. A DRAG is real
`DragEvent`s with a real `DataTransfer` dispatched from the page, because CDP
cannot drive an HTML5 drag; they reach the same listeners a mouse does, which
read `event.target` and the panel's own `dragging` id and nothing else. And a
section that presses TAB has to SHUT the panel first: every modal freezes the
simulation slices Tab is read in, so a Tab pressed with the inventory up looks
exactly like the failure that section is hunting for. `portraits` is what says
the stage rendered ten distinct beasts into the wall rather than ten lozenges,
and `stageCast` is what says the swap did not eat one of them.

TWO MORE THINGS IT LEARNED THE HARD WAY. An arrow lives 1.6 s and the pool is
shared, so the bow's shot is still in the air when the sword swings a moment
later — section 8 measures a DELTA, and the version that counted failed against
a perfectly correct build. And `__dbgInvAction` goes straight to the handler
rather than through a button, so it owes the panel a `refresh()`: without it a
probe reads a screen one action behind the state it is asserting on, which is a
failure in the test and not in the game.

**UI and input.** The HUD is a DOM overlay ([src/ui/index.ts](src/ui/index.ts),
styles injected by `src/ui/styles.ts`), not canvas-drawn. Class names are `bs-*`
and the layout/crosshair/touch tools assert on them — renaming one breaks a tool.
`TouchControls` builds the twin-stick overlay only on touch-primary devices.
`main.ts` exposes read-only probes (`__dbgPlayerPos`, `__dbgCamYaw`, `__dbgInput`)
that exist purely for those tools; keep them working.

**NO PLAYER-FACING TEXT IS UNDER 16px, ANYWHERE, AT ANY SCREEN SIZE.** Issue #17,
and it is a hard floor rather than a target: the reporter's case is a TV across a
room, where this HUD's smallest labels — 8.5px — were not small type but absent
type, and the three the issue names are the mount prompt (10.5), the hotbar's key
numbers (10) and the NPC interact pill (13.5). `tools/test-textsize.mjs` is the
guard and it exits non-zero. It runs TWO passes because neither sees the whole
surface: a static scan of `src/ui/styles.ts` and `src/core/touch.ts` that reads a
lower bound on every `font-size` (so `clamp(9px,…)` counts as 9 and
`max(16px,.86em)` as 16, which is why a responsive size is written as one of
those rather than as a bare `calc()`), and a live computed-size sweep at desktop,
both phone orientations and the title screen's settings step, which is the only
thing that can see INHERITED sizes and a media query that undoes the floor.
`__dbgStageHud()` is the test hook it drives: half the panels the floor covers are
transient, so it raises the interact pill, the dialogue, the mount ring, the
riding badge, a toast, the level-up banner and the shop in one call.

**THE SCALE IS COMPRESSED, NOT MULTIPLIED**, which is the design decision the
whole change rests on. Scaling the sheet by 16/8.5 to lift the floor takes the
party panel to 540px and the hotbar to 109px slots — a HUD that eats the frame in
order to be readable, i.e. one accessibility problem traded for another. What the
old sheet spent on size this one spends on the axes it already used: weight,
colour, letter-spacing and the glass. The range closed from 8.5–19 to 16–22, and
the containers grew about a third. So when you add a row, **16 is a floor and not
a size** — a quiet label sits exactly on it and the thing beside it is 17, not 19.

Two consequences are worth knowing before touching either. On a PHONE there is no
slack, so the rule in that media block is CUT CONTENT, NOT TYPE: the title chip's
tagline is hidden outright, and the party panel and the toast column were
re-fitted against each other (206 + 180 of 393) rather than sized alone. And the
TOUCH FAN's arc packing was re-derived, because a button is as wide as the word on
it — JUMP at 16px does not fit a 40px circle, so the diameters grew and `--r` with
them; the arithmetic and what it costs are in the comment at `--b` in
[src/core/touch.ts](src/core/touch.ts). EXEMPT: the developer instruments (the §
console, the F2 overlay, the F3 panel), which are monospace readouts no player
opens and are deliberately dense so F3 can be read beside F2.

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

**ABOUT THE GAME IS THE SECOND LEAF OFF THE OPTION LIST**, beside Settings and
built the same way: [src/ui/about.ts](src/ui/about.ts) owns the content, the
title screen owns the screen around it, and the way back — the Back button,
Escape and the pad's B face — puts the cursor on the button that opened it
(`leaveLeaf` in ui/menu.ts). Issue #65. It holds what the game is in short
sentences, the AI disclaimer, and the third-party licences; the routine for
keeping that last part true is the licence note at the top of this file, and
`tools/test-about.mjs` is what makes it a run rather than a wish — it reads
`package.json`'s `dependencies` and fails on any the panel does not credit.

Two things about it are decisions rather than styling. It is the only box on
that screen that SCROLLS, because the notices are longer than any window this is
read in and the alternative is type under the 16px floor (issue #17) — it is
sized off `--bs-vh` (core/viewport.ts) rather than `dvh` for the reason issue
#16 gives, and the probe asserts the box AND the Back button under it stay
inside the frame on a phone. And up/down on that step SCROLLS rather than moving
the cursor, since there is one button and a page of prose; the keyboard and the
pad go through one helper so they cannot disagree.

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
this load without writing the preference back; `shadowcache=0` redraws the whole
shadow map from every caster every frame, the way it was before
[src/core/shadow-cache.ts](src/core/shadow-cache.ts) — the one `?` flag that must
not move a pixel;
`nature=<param>:<n>[,<area>.<param>:<n>]` sets the world's vegetation densities
before the first chunk is built (see **nature parameters** above; a term with a
dot is an area multiplier, one without is the baseline, and an unparseable term
is ignored rather than thrown);
plus every post-processing override above.
`menu=0` removes the title screen and starts the game immediately — what every
probe in `tools/` passes, and what `photo=1` implies on its own; `menu=1` forces
it back, INCLUDING in photo mode, which is how the title screen itself gets
captured (`photo=1` then freezes its animations so two runs match, and do NOT
add `hud=0` — that hides every overlay including the menu).
`lang=<iso639-1>` pins the display language (default: the stored preference,
then `navigator.language`, then `en` — see **Strings** below).
`vol=<0..1>` pins the music volume for this load without writing the preference
back, and is the ONLY way to hear anything in a debug session: `menu=0`,
`photo=1`, `fs=0` and `fps=` each imply volume 0 (see the muted-debug rule
above). `vol=0` is stronger than a mute — no element is created and nothing is
fetched. Lab parameters are in [LAB.md](LAB.md).

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

**Music.** [src/audio/music.ts](src/audio/music.ts) is one `MusicDirector`
playing one track at a time, keyed on a SCENE: `title` for the poster, and
otherwise a ZONE ID. main.ts is the only caller — the poster raises `title`,
`beginPlay` swaps to `overworld`, the zone manager's `onArrive` passes `def.id`
straight through, and `exitToTitle` goes back.

**A SCENE RESOLVES TO A PLAYLIST, AND THE PLAYLIST IS CONTENT.** Each area is a
`music:<zone id>` asset carrying an ordered `tracks` list
([src/content/types/music.ts](src/content/types/music.ts)); the director is handed
a RESOLVER rather than an import, because content/types.ts's first rule runs both
ways — the content runtime may not reach for the DOM, and an audio element has no
business knowing what a package is. `musicPlaylist` in main.ts is that resolver
and the one place the two meet. A track is SELECTED BY NAME from the
`music-track` factory kind (`"tracks": ["overworld"]`), registered from
`MUSIC_TRACKS` before `bootstrapContent()` so the cross-asset pass can answer a
typo with `unknown-factory` on the field that holds it — and so that content
names a song and never a URL, which is what stops a package choosing what the
page fetches.

**AN AREA NOBODY SCORED GETS THE FALLBACK; AN AREA SCORED `[]` GETS SILENCE.**
Those are two different statements and before this they were the same one. The
fallback is a `"fallback": true` flag on exactly one asset (`music:default`
today), validated the way `TownData.start` and `BiomeData.startArea` are — a flag
rather than a reserved id, because `music:default` would be a fact expressed as a
NAME. Note the consequence: **the dungeon has music now**. It was silent because
it was missing from the `TRACKS` map, which was the "deliberate answer" this
paragraph used to claim, and a missing entry cannot go on meaning that once
missing also means "fall back". Give `hold` an asset with `"tracks": []` to put
the silence back on purpose.

**THE TITLE SCREEN IS NOT AN AREA AND IS DELIBERATELY NOT CONTENT.** It plays at
~221 ms and `bootstrapContent()` runs inside the `world` phase three hundred lines
later, so a poster that asked the registry would ask an empty one, take the
FALLBACK, and play half a second of the overworld's song before swapping. Its
track stays in `MUSIC_TRACKS` and `musicPlaylist` short-circuits on it.

**A ONE-TRACK PLAYLIST STILL LOOPS NATIVELY** (`el.loop = true`), which is what
keeps the wrap sample-exact and the two ends of the envelope meeting across it —
every shipped area is one track, so nothing about the seam moved. Two or more
cannot: an element that loops never fires `ended`, so the list would never leave
its first song. There it advances on `ended`, and the outgoing track's `FADE_OUT`
tail plus the incoming one's `FADE_IN` head IS the transition a scene change
makes, which is why there is no third kind of fade in the file.

It is an `<audio>` element and not the Web Audio API, and the reason is the
size: `decodeAudioData` on these two would hold about 225 MB of decoded float in
memory and would do the decoding in one go during a boot this project has spent
a lot of effort making incremental. An element streams, and nothing here needs a
filter or a sample-accurate schedule — it needs a volume and a fade.

**BOTH TRACKS ARE CUT ROUGH, WHICH IS WHY THE FADE IS AN ENVELOPE AND NOT A
SCHEDULE.** They start and end mid-phrase, so a raw loop clicks every 85
seconds. The element loops natively (the wrap is the browser's and is
sample-exact, where a `timeupdate` seek fires at ~250 ms granularity and would
leave a hole at the seam) and a 50 ms timer shapes `volume` from `currentTime`:
up over `FADE_IN`, down over `FADE_OUT`, squared on the way out because
`HTMLMediaElement.volume` is linear amplitude and hearing is not. A TIMER rather
than the frame loop, because `frame()` does not run while the title screen is up
and that is exactly when the first track is playing.

**STOPPING IS UNLOADING.** `pause()` alone leaves a decoder, a buffer and
possibly a connection behind for a track nothing will play again, and dropping
the reference does not oblige the GC to be prompt — so every path that retires a
track empties `src` and calls `load()`. That is what a scene change does after
its 0.9 s fade, and what volume 0 does at once.

**VOLUME 0 IS THE FEATURE SWITCHED OFF, NOT A QUIET SETTING.** Nothing is
constructed and nothing is requested — `MusicDirector` never makes an element at
zero — which is what makes the muted debug boot above cost literally nothing.
It is ONE preference (`volume`, `game.settings.gameplay.volume`, 0.8 by default)
rather than a level plus a mute flag, because the second field could only ever
disagree with the first: "muted at 80%" and "0%" sound identical. The panel row
is a strip of chips (OFF · 20 · 40 · 60 · 80 · 100), so coming back from OFF is
the same one tap that leaving it was; `/volume <0..1>` is the dial half, as
`/haptics` is for rumble.

**A BROWSER WILL NOT LET A PAGE MAKE NOISE BEFORE IT IS TOUCHED**, and a refused
`play()` is a normal outcome rather than an error — the title screen is up
before anyone has clicked anything (measured: `blocked: true` at the splash, and
playing 1.19 s into the track after one key). The rejection arms capture-phase
listeners that retry on the first real gesture. CAPTURE, for the reason
core/input.ts stamps touches there: the menu's own handlers call
`stopPropagation()`, so a bubble listener never sees the press that leaves the
splash. And a track that was never allowed to play is DROPPED rather than faded
when the scene changes, or the first thing a player hears after New Game is 0.9
seconds of the poster's music behind them.

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

**IT IS FOUR SECTIONS BEHIND TABS — Gameplay · Controls · Graphics · Sound.**
One flat column was right at five rows and is not at eleven: this list is the
tallest thing the title screen shows, and the two height media queries in
[ui/styles.ts](src/ui/styles.ts) written about nothing else exist because ONE
added row put the Back button off the bottom of a 1000x560 window. Measured, the
tallest tab (Graphics) is 486px of list against 462 for the whole flat list it
replaced — so the tabs did not make anything shorter, they moved the height that
has to fit from "every setting there is" to "the worst single section", which is
what stops the next row added to Controls from mattering. The compaction band's
top went 660 -> 760 -> 880px with it.

**EVERY SECTION IS IN THE DOM AT ONCE, STACKED IN ONE GRID CELL**, and that is
what makes the panel's height CONSTANT — the box is as tall as the tallest
section whichever one is showing, so changing tabs cannot move the Back button
under a player's cursor. It swung 111px -> 327px when only the section showing
was rendered. The alternative was a fixed pixel height per screen band, and it is
worse in this file's own recurring way: a number written down has to be
re-measured every time a row is added or a translation wraps, and nothing fails
when it is not. The hidden sections are `visibility:hidden`, so they cannot be
clicked and the browser will not focus them; `FOCUSABLE` (ui/settings.ts) is the
selector BOTH hosts build their cursor list from, and its `.sec.off *` clause is
what keeps a pad out of a section nobody can see. `tools/test-pause.mjs` asserts
the height is identical on all four tabs. Only the ≤520px-tall band gives the box
an `overflow-y:auto` and a cap, because a scroll container clips the focus ring
of the row at each end — a real cost, paid only where the arithmetic runs out.

**A STRIP IS ONE CONTROL, NOT N BUTTONS.** The tabs, the volume levels and the
language picker are each a single stop in a host's cursor list — the roving
tabindex pattern, which is also what a keyboard user's Tab key sees — and
left/right CHANGES THE VALUE rather than walking the buttons inside it
(`stepGroup`). Before that a pad player stepped through four tabs to reach the
settings and then pressed A to commit each one. The ends differ per strip and
that is deliberate: the tabs and the languages are a RING (there is no first or
last section), the volume CLAMPS (one nudge past 100 landing on 20 is a thing
nobody wants and everybody would do). MUTE is deliberately NOT in the volume
strip — OFF is the feature switched off rather than a quieter level, so it keeps
a stop of its own and cannot be swept onto by accident.

A TAB IS NOT A STORAGE GROUP. Keys stay `game.settings.<group>.<name>` with the
group fixed on the day each setting shipped, and two no longer match the tab they
appear in — volume is `gameplay` and shows under Sound, `autoFullscreen` is
`graphics` and shows under Gameplay. Renaming a key silently resets the choice of
every player who already made one, which is worse than a name nobody sees.

TWO controls on this panel ask their host to re-render (`onRebuild`, carrying the
selector for the control the player is still standing on): a TAB and a VOLUME
STEP. What they have in common is that both change which elements are focus stops
— a tab lights a different section, a step moves the roving tabindex — and a
host's `focusables` list is built once per render. Everything else rewrites its
own pill in place, precisely so that list stays valid and a pad cursor does not
jump out from under the player's thumb.

**THE GRAPHICS TAB IS THE F3 PANEL'S OWN SWITCHES, NOT A COPY OF THEM.** Five of
the nine — ambient occlusion, glow, antialiasing, shadows, and grass under the
player-facing name "Foliage" — through the same `Gfx` model, the same ids and the
same `game.settings.graphics.*` keys, so a row flipped in one is flipped in the
other. The four left out are left out on purpose: the frame cap is a choice row
that means nothing without a measured frame rate beside it, and trees & rocks,
clouds and the water surface delete the WORLD rather than the way it is drawn.
The panel that offers those keeps its numbers next to them.

WHAT THE PANEL DOES NOT DO IS APPLY THEM. It writes through `storeGfx`
([core/gfx.ts](src/core/gfx.ts)) and tells its host, exactly as a `Prefs` row is
saved here and applied by a hook — because of the boot order in
[main.ts](src/main.ts): the title screen's Settings step is usable all the way
through the boot phases and the `Gfx` that owns the sinks does not exist yet
(`gfxLive` is the guard, and it is a flag rather than a `let ... = null` because
eight other call sites read the const). A change made in that window is picked up
by the constructor, which reads the same storage. `tools/test-settings.mjs` drives
exactly that: AO off at the poster, New Game, and `__dbgGfx` says `ao: false`.

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

The player's surface is that Settings panel, which shows SWITCHES and one strip
of STEPS; the dials (`/haptics`, `/shake`, `/invertlook`, `/vibration`,
`/volume`) are dev-console commands writing the same keys. Music volume is the
step strip, and it is the exception that proves the shape rather than a new
pattern: on/off is a choice and 0.62 rumble is a tuning session, but "quieter"
is a thing a player genuinely wants and cannot express with a switch. Six chips
rather than a slider because every control on that panel is a real `<button>` —
both hosts drive it from a pad by calling `.click()` on the focused one — and
because a −/+ stepper puts mute eight presses away. `stepGroup`
(ui/settings.ts) is what the two hosts hand left/right to, so the strip under the
cursor changes its own value — the tab strip is one of those, which is how a pad
steps between sections.
**A setting has to be respected
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

**LOOK INVERSION IS A PROPERTY OF STICKS, AND THE TOUCH PAD IS A STICK.** The
same choke-point argument, seen from the device end. `invertLookX`/`invertLookY`
reached `GamepadControls` and nothing else, so the overlay's look pad ran its own
fixed mapping — which meant a phone shipped push-up-looks-up, the exact mapping
`invertLookY`'s default of TRUE exists to say was tested on hardware and read as
backwards, and a phone player had a row on their settings screen that did
nothing whatever. Both stick devices now read the one pair of booleans, through
`TouchControls.setLookAxes` alongside `GamepadControls.setLookAxes`, with the
sign applied to a DOWN-POSITIVE axis in both (the overlay's stick is
screen-up-positive, so `update` negates it first). Three callers, and all three
move both: `settingsHooks.onLookAxes`, `/invertlook`, and the `invx`/`invy` URL
pins. THE MOUSE STAYS OUT — nobody expects an inverted mouse, and a pointer
disagreeing with a stick is correct rather than an inconsistency to tidy away.

The consequence is a real change of feel and is the fix rather than a side
effect: a phone's default look is now inverted, the way a pad's always was, and
a player who sets the switch on either device finds it set on the other. The
`invertY` section of `tools/test-touch.mjs` is the guard, and it is a PAIR at one
column — "held up, the camera pitched down" is equally true of a working inverted
stick and of one wired backwards, so only the two arms together say anything.
Same phone, same hold, the single difference being `invy`: measured **+34.3
degrees** of pitch uninverted against **-49.87** inverted. It asserts on PITCH
rather than yaw because `__dbgCam().pitch` is signed, bounded and does not wrap,
where `__dbgCamYaw` is an atan2 that passes half a circle inside one hold on a
fast host. It exits non-zero, and `__dbgInput().touchLookAxes` is what it reads
the overlay's own answer from — a phone run has no gamepad to ask.

## Conventions

- **No per-frame allocation** in update paths. Module-level scratch vectors (`_a`,
  `_dummy`, …), instanced meshes and object pools are the norm; keep them that way.
- **Frame-rate independence.** Smoothing uses `1 - exp(-lambda * dt)`, never a fixed
  lerp factor. `Engine.tick()` clamps `dt` to 0.05 s.
- **A DEPRECATION WARNING IS FIXED WHEN IT APPEARS, NOT CARRIED.** The boot
  console is expected to be EMPTY, and that is what makes it useful: one warning
  left standing is the noise the next real one hides in, and a console nobody
  trusts is a console nobody reads. So a dependency that says an API is going
  away is answered in the commit that first sees it — check what the installed
  version itself recommends (its own source, not memory), and say in a comment
  what was deprecated, what replaced it and what is SUBTLE about the swap, the
  way every other tuned decision in this codebase carries its reasoning.
  Worked example: `THREE.Clock` is deprecated since three r183 and logged
  "THREE.Clock: This module has been deprecated. Please use THREE.Timer
  instead." on every boot. It is `THREE.Timer` now (`Engine.tick`,
  core/engine.ts) — and the subtlety is worth the comment it got: `Timer`
  splits `update()` from `getDelta()` and stamps its origin at CONSTRUCTION, so
  without a `reset()` on the first tick frame one would bill the whole boot
  instead of reading ~0 the way `Clock`'s auto-start did.
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
- **A SETTLEMENT IS ASSEMBLED THE SAME WAY A BODY IS**, and the guard above
  covered only rigs until a campfire was reported for exactly this. A glow piece
  can NEVER share a `VoxelModel` with the thing holding it — the two go into
  different accumulators on different MATERIALS — so the face culling inside
  `build()` is precisely what cannot run across the pair, and everywhere a flame
  overlapped its logs, its bowl or its cage both models painted a face onto one
  plane. Measured: **0.0784 m2 on the campfire and on every road lamp**, one
  WHOLE voxel face of glowing orange flickering against a dark log, and 0.0154
  on a brazier. TURNING THE PIECE CANNOT FIX IT, which is the thing to know
  before reaching for a yaw: the campfire's body and flame already take two
  independent `rng() * 6.28` draws, and that parts the two VERTICAL grids while
  doing nothing whatever for the horizontal ones, because a +Y normal is +Y at
  every rotation. The other two do not even get that much — a lamp stamps body
  and lantern at one shared yaw so the bracket leans over the road, and a
  hamlet's braziers are both stamped at 0. `GLOW_PART`
  ([src/world/town-parts.ts](src/world/town-parts.ts)) parts the grid in all
  three axes inside `bakeAt`, the one function every glow piece in the file
  already passes through, so a new one inherits it without anyone remembering.
  `test-zfight.mjs` grew a town section to catch it, and that section sweeps
  RELATIVE YAW rather than a pose, because the angle between a body and its glow
  is a different number in every world.
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
