# Agent guidelines — Beast Story: Bonds of Red

TypeScript + three.js action game. No framework, no engine, no asset pipeline:
every model, animation and effect is generated in code.

- [game-story.md](game-story.md) — the campaign: plot, cast, four acts, the
  twenty main quests. Read its §1 before authoring content.
- [LAB.md](LAB.md) — `lab.html`, the isolated model/VFX stage.
- [models/README.md](models/README.md) — Blender source for the hero's
  proportions. Design drawings, kept so they are not lost; **nothing there is
  loaded by the game**, which still generates everything it draws.

## Commands

Use **Bun** (`>= 1.3.14`) for every JS/TS command: `bun install`, `bun add [-d]`,
`bun remove`, `bun run <script>`, `bunx`, `bun tools/foo.mjs`. `bun.lock` is the
only lockfile — delete any `package-lock.json` that appears.

| Task                                | Command                                                                             |
| ----------------------------------- | ----------------------------------------------------------------------------------- |
| Dev server (game + lab)             | `bun run dev` → http://localhost:5187                                               |
| Typecheck + build                   | `bun run build`                                                                     |
| Typecheck the COMMIT before pushing | `bun run verify`                                                                    |
| Lint (oxlint)                       | `bun run lint` · `bun run lint:fix` · `bun run lint:ci` (warnings fail)             |
| Format (oxfmt)                      | `bun run format` · `bun run format:check`                                           |
| Timestamped build to `dist/`        | `bun run snapshot [label]`                                                          |
| Serve a build                       | `bun x vite preview --outDir dist`                                                  |
| Re-export every `.blend` to `.glb`  | `bun run glb` (the dev server does it on save)                                      |
| Run probes                          | `bun tools/probe.mjs <name...\|all> [--jobs N] [--json]`                            |
| Read a debug hook                   | `bun tools/q.mjs "__dbgTowns().spawn" [--wait ms] [--url "?…"] [--lab "…"] [--raw]` |
| Screenshot                          | `bun tools/screenshot.mjs shots/x.png "photo=1" 1920 1080 3500`                     |
| Lab shot                            | `bun tools/lab-shot.mjs shots/x.png "beast=emberfox&t=2"`                           |

Tools need `BROWSER_EXECUTABLE` in `.env.local` ([.env.example](.env.example)).
Browser automation is **`puppeteer-core`** (Playwright does not run under Bun),
and everything browser-related goes through
[tools/browser.mjs](tools/browser.mjs).

## Debug surface

| Purpose                                 | Flags                                                                                                                                                               |
| --------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Boot                                    | `menu=0` skip title · `menu=1` force it · `photo=1` staged capture (implies `menu=0`) · `warmup=0` skip the shader sweep                                            |
| Framing                                 | `cam=x,y,z` / `look=x,y,z` **offsets from `world.spawnPoint`** · `beast=<id>` · `anim=` · `a=<deg>` · `hud=0` · `npct=<s>` NPC clock · `colliders=1` draw colliders |
| Performance                             | `fps=<n>` cap (default 120, `0` = off) · `simhz=` · `view=<n>` streaming radius · `debug=1` developer mode: F3 and the `§` console reachable, starter beast bonded · `perf=1` pin the profiler                                  |
| A/B switches                            | `towns=0` · `solids=0` · `sway=0` · `props=0` · `clouds=0` · `water=0` · `enemies=0` · `beasts=0` · `aim=0` · `shadows=0` · `shadowcache=0` (must move no pixel)    |
| Post                                    | `post=0` · `ao=` · `bloom=` · `aa=0` · `grade=0` · `roll=` · `aoview=1`                                                                                             |
| Preferences (one load, never persisted) | `vol=<0..1>` · `lang=<iso639-1>` · `fs=<0\|1>` fullscreen on start · `haptics=` · `shake=` · `invx=` · `invy=`                                                      |
| World tuning                            | `nature=<param>:<n>[,<area>.<param>:<n>]` before the first chunk                                                                                                    |
| Progression                             | `mounts=all` / `mounts=ground,water,flying` start with those mounts unlocked; riding is locked on a new character                                                   |

Lab flags are in [LAB.md](LAB.md).

**Console** (`§`, under `debug=1`): `/gfx` · `/nature` · `/content` · `/give` · `/path` · `/tp` · `/zone` ·
`/mount <species>` · `/mount unlock [<kind>|all]` · `/show-colliders` · `/volume` · `/haptics` · `/vibration` ·
`/shake` · `/invertlook`

**Hooks.** The `__dbg*` globals are the probe surface —
`grep -rhoE "__dbg[A-Za-z]+" src/ | sort -u` lists them all. Most are readers
`q.mjs` can call; some take arguments (`__dbgSurfaceY(x, z)`) and some drive
state, which is a probe's job (`__dbgTp(x, z, y?)`, `__dbgGfx(id, value)`). Keep
them and the `bs-*` class names working when refactoring; `tools/` asserts on
both.

## Development

- **Own your dev server.** Port 5187 belongs to the main checkout. In a
  worktree, claim a free port in 5190–5199, record it in that worktree's
  `.claude/launch.json`, and serve with `bun x vite --port 519N --strictPort`.
  [tools/target.mjs](tools/target.mjs) resolves the port for every probe.
- **Stop the server you started, in the same turn you report the work done, and
  say so.** Leave servers you did not start alone — take a port of your own.
- **Serve builds statically** with `vite preview` or any static server;
  `file://` and `bun ./dist/index.html` both break module loading.
- **Fix a deprecation warning in the commit that first sees it**, and note in a
  comment what replaced it and what is subtle about the swap. The boot console
  is expected to be empty.
- **Lab shots are iteration, never sign-off** — re-verify in `index.html`.

**A new dependency or licensed asset is credited in the same commit**, in
[src/ui/about.ts](src/ui/about.ts):

| Case                                     | Action                                                               |
| ---------------------------------------- | -------------------------------------------------------------------- |
| `dependencies`, fonts, art, sounds, data | `SHIPPED` + the copyright line from the package's own `LICENSE` file |
| `devDependencies`                        | `TOOLS` + name and SPDX id                                           |
| Copyleft (GPL / LGPL / AGPL)             | Stop and ask — it is a project-level decision                        |

Keep those notices verbatim and in English at every display language. Keep
repository links out of the panel: the repo is private, and
`bun tools/test-about.mjs` asserts both that and the shipped credits.

## Code Style

- Keep code and solution simple yet scaleable. Channel "yagni" energy unless told otherwise.
- Write TypeScript / TS code in a respectable way and don't write code like a Python dev.
- Avoid one-line functions that are just casting wrappers.
- `any` creates harm, Inferred types create value.
- Tests are good! Enless smoke tests, "regression tests" for feature deletions and etc are much less good. Tests should be focused, not slop. Tests must ran fast.
- Comments: max 2 lines, one per symbol, only the non-obvious WHY (units,
  invariants, magic numbers, `issue #NNN`). Never restate a name, never narrate
  steps, no banner dividers. Tuning history and measurements go in the commit
  message, not the source. Keep comments in sync with the code they describe.

## Testing

Tests are browser probe scripts in `tools/` that print JSON. Give every new
probe a real assertion and a non-zero exit — several existing ones only print
readings.

- **Flake is a bug, not noise.** Run a test once per change: a re-run with no
  code change proves nothing and buries the flake. The only reason to run the
  same test again unchanged is to hunt a flake you have already seen — then
  repeat it deliberately, fix the cause, and say that is what you did.
- `bun tools/probe.mjs all` runs the roster listed in `probe.mjs` itself — add a
  new probe to its `SOLO` or `PARALLEL` set or `all` will skip it. **SOLO is the
  default**; only a probe that drives no hero and measures no motion belongs in
  `PARALLEL`.
- A test may not run longer than 1 minute, if the test require a mock or tooling to match time budget feel free to create such.
- `bun tools/test-zfight.mjs` needs no dev server: it builds every rig and
  settlement part in headless three.js and finds coincident faces. Run it after
  touching any model builder.
- **A probe that measures the world passes `menu=0`** (the title screen gates
  the frame loop). One that must walk the staged boot — pointer lock, New Game,
  Exit — drops it. Pass `fs=0` wherever New Game is clicked, so the
  viewport is not resized under a measurement.
- **Debug loads are muted automatically.** Open a browser preview at `?vol=0`;
  pass `vol=0.01` only for audio work, and say that you did.
- **Let tests use the host GPU** — pass no GL flags; `SOFTWARE_GL=1` is the
  opt-in fallback. Assertions must hold from a software rasteriser to a 165 Hz
  host, so measure deltas and shortest arcs rather than absolute counts.
- **Assert on the measurement, not on the flag.** Prove a toggle by what the
  frame does — draw calls, pixels, distance travelled.
- **Assert both halves of a pair.** "Nothing happened with the panel up" only
  means something beside "it happened with the panel down".
- **Aim before you walk.** The hero starts inside a walled camp with the camera
  in front of him, so `KeyW` heads into a hut. Aim along his own facing, or
  `__dbgTp` to `spawnPoint` first, and wait on `__dbgZone().streaming` rather
  than a clock after a teleport.
- Give a section its own page when it needs a clean camera or position; click a
  settings TAB before clicking a row in it; run frame-edge assertions with no
  `fps=` in the URL.
- Performance signal is `cpu` × `fps`, never fps alone. F2 shows where the frame
  went; F3 (the Debug panel) switches things off live, and its spawner tree puts
  items, beasts, enemies and settlement parts into a running world.
  `bun tools/perf-baseline.mjs record`, then
  `bun tools/perf-baseline.mjs` to compare — the baseline is per-machine and
  gitignored.
- Add a feature, add a section to its guard (see the map below). Move a budget —
  collider counts, fit errors — and re-baseline it in the same commit.

## Deploying and pull requests

Deployment is Vercel's Git integration, configured outside the repo — there is
no config file, CI workflow or deploy script here. It comments a preview
deployment on every pull request. `bun run snapshot` is for handing someone a
self-contained build, not for shipping.

1. `bun run verify` — typechecks HEAD in a throwaway worktree, which is the only
   way a partial commit is proven.
2. `bun tools/probe.mjs all`, plus the guard for the area you touched.
3. Branch, commit, push, open the PR.
4. **Report the PR with its Vercel preview URL in the chat, always suffixed
   `?vol=0&nostore=1&debug=1`** so an opened preview is muted, ignores stored
   state and has the developer's instruments (F3, `§`, the starter beast). Poll
   `gh pr view <n> --json comments` until the deployment comment lands (about a
   minute). If it does not arrive, say so and give the PR link alone.

## Architecture

**Contract hubs — widen these rather than reaching across modules.**
[src/core/types.ts](src/core/types.ts) holds every cross-module interface
(`World`, `BeastSpecies`, `SkillDef`, `Damageable`, `CarrierInfo`, `EventBus`).
[src/content/types.ts](src/content/types.ts) does the same for content.

**Composition roots.** [src/main.ts](src/main.ts) is the only place subsystems
are wired together and the only frame loop; gameplay policy belonging to no
subsystem lives there. Read the boot note at the top of that file before
reordering anything in it. [src/lab/index.ts](src/lab/index.ts) is a second,
smaller loop over the same modules — keep model and VFX code out of it.

| Area                                | Files                                                                                                                                                                                                                | Guard                                                                      |
| ----------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------- |
| Renderer, post chain, shadows       | `core/engine.ts`, `core/post.ts`, `core/shadow-cache.ts`                                                                                                                                                             | `test-gfx`, `test-shadowcache`                                             |
| Terrain, streaming                  | `world/terrain.ts`, `world/index.ts`, `world/chunk.ts`                                                                                                                                                               | `test-road`, `test-nature`, `test-f16`                                     |
| Water and diving                    | `world/water.ts`, `world/underwater.ts`                                                                                                                                                                              | `test-dive`                                                                |
| Towns, roads, buildings             | `world/towns.ts`, `world/roads.ts`, `world/town-parts.ts`, `world/structures.ts`, `world/spawned.ts`                                                                                                                 | `test-road`, `test-structures`, `test-spawn`, `test-road-fade`             |
| What KIND of path a path is         | `world/path-profile.ts`                                                                                                                                                                                              | `test-path-profile`, `test-road`                                           |
| Road cases on real voxel ground     | `lab/road-stage.ts` (`?road=<case>`)                                                                                                                                                                                 | `test-road-lab`                                                            |
| How steep the ground is             | `Terrain.steepnessAt` — there is no mountain biome                                                                                                                                                                   | `test-road-lab`                                                            |
| Authoring a path at runtime         | `World.addPath` (`world/index.ts`), `Towns.rebuildPaths`, `PathEditControl` in `ui/perf-panel.ts`                                                                                                                    | `test-path-edit`, `test-gfx`                                               |
| Beaten tracks and flagged streets   | `WEAR`/`wearTracks` in `world/towns.ts`, `streetNetwork` in `world/sky-island.ts`                                                                                                                                    | `test-road`, `test-carrier`                                                |
| Fences and bridge railings          | `world/fences.ts` (the chain), `world/town-parts.ts` (the kit)                                                                                                                                                       | `test-fence`                                                               |
| Moving world pieces                 | `world/carriers.ts`, `world/sky-island.ts`                                                                                                                                                                           | `test-carrier`                                                             |
| Zones and gateways                  | `world/zones.ts` (the rules), `world/portal.ts` (the arch), `world/dungeon.ts` (the hold and the vent: one shape, two specs)                                                                                         | `test-gateway`, `test-vent`                                                |
| Vegetation, wind                    | `world/nature.ts`, `world/props.ts`, `world/sway.ts`                                                                                                                                                                 | `test-nature`, `test-sway`                                                 |
| Foliage vs. buildings               | `SiteClearance` in `core/types.ts`, `world/structures.ts` (the field), `Accum.add` in `world/props.ts` (the one refusal)                                                                                             | `test-foliage-clip`                                                        |
| People                              | `world/npc.ts` + a file per body                                                                                                                                                                                     | `test-npc`, `test-escort`, `test-zfight` (carried-frame NPCs have no behavioural guard) |
| Beasts                              | `beasts/framework.ts`, `beasts/registry.ts`, `beasts/species/*`                                                                                                                                                      | `test-zfight`, `test-beastanim`, `test-companion`                          |
| Combat, enemies, drops              | `combat/index.ts`, `combat/enemies.ts`, `combat/pickups.ts`                                                                                                                                                          | `test-safezone`, `test-aim-assist`, `test-inventory`                       |
| "Is the player close?"              | `inReach` / `inRise` in `core/types.ts`, and every caller                                                                                                                                                            | `test-proximity`                                                           |
| Hero, camera, mount, weapons        | `player/*`                                                                                                                                                                                                           | `test-dive`, `test-structures`, `test-inventory`, `test-npc`               |
| Which mounts the story has unlocked | `MountUnlocks` in `player/mount.ts`, the badges in `ui/inventory.ts`, the F3 rows in `ui/perf-panel.ts`                                                                                                              | `test-mounts`, `test-saves`                                                |
| Hero hairstyles                     | `player/hair.ts` (the styles), `player/hero-rig.ts` (the mount)                                                                                                                                                      | `test-hair`, `test-zfight`                                                 |
| Input devices                       | `core/input.ts`, `core/gamepad.ts`, `core/touch.ts`                                                                                                                                                                  | `test-touch`, `test-gamepad`                                               |
| HUD, menus, panels                  | `ui/*` (DOM overlay, `bs-*` class names)                                                                                                                                                                             | `test-menu`, `test-pause`, `test-textsize`, `test-viewport`, `test-cursor` |
| F3 Debug panel and its spawner      | `ui/perf-panel.ts`, `core/gfx.ts`, `core/spawn.ts`                                                                                                                                                                   | `test-gfx`, `test-spawn`, `test-hair`, `test-path-edit`                    |
| Key bindings                        | `ui/keybinds.ts`                                                                                                                                                                                                     | `test-keybinds`                                                            |
| Items and the bag                   | `core/items.ts`, `ui/inventory.ts` (rules in `main.ts`)                                                                                                                                                              | `test-inventory`                                                           |
| Settings and storage                | `ui/settings.ts`, `core/prefs.ts`, `core/gfx.ts`                                                                                                                                                                     | `test-settings`                                                            |
| Saving and loading a character      | `core/saves.ts` (the store), `collectSave` / `applySave` / `resolveSafeGround` / `resolveOnCarrier` in `main.ts`, the restore seams on `Player`/`BeastActor`/`Inventory`/`SlotLayout`/`CombatSystem`/`DayNightCycle` | `test-saves`                                                               |
| Content system                      | `content/*`, `content/data/core.json`                                                                                                                                                                                | `test-content`                                                             |
| Strings                             | `i18n/en.ts` (base table), `i18n/<iso639-1>.ts`                                                                                                                                                                      | `test-about`, `test-settings` (keys are checked at build time)             |
| Music                               | `audio/music.ts`                                                                                                                                                                                                     | `test-music`                                                               |
| Credits and licences                | `ui/about.ts`                                                                                                                                                                                                        | `test-about`                                                               |

Cross-cutting rules:

- **Generate everything the renderer draws.** The only files are 2D chrome and
  two music tracks, imported from `src/` — there is no `public/`. Build
  textures, models and fonts in code.
- **Reset session state in the object that owns it** — `Player.reset`,
  `BeastActor.reset`, `CombatSystem.reset`. `exitToTitle` in `main.ts` covers
  everything else; add a field, reset it in the file that added it.
- **Session state that is not SAVED is state the player loses** (issue #171).
  The rule above has a twin, and it is the one that rots quietly: `exitToTitle`
  is the authoritative list of what a play session IS, so anything added to it
  is something `collectSave` owes a field and `applySave` owes a restore. A
  field reset but never serialised costs nobody a test — it costs a player their
  progress, months later, in a report nobody can reproduce. Add a field, reset
  it, save it, load it, and add a case to `test-saves`.
- **LOADING IS A RESOLUTION PASS, NOT AN ASSIGNMENT.** This is the half that
  will keep needing work as the game grows, because the world is data-driven and
  a save outlives the data it was written against. A document holds ids and
  coordinates from an older build; what it must produce is a valid session in
  THIS one. So every kind of thing a save stores needs an answer to "and what if
  the world no longer has that?", and the answers already written down are the
  pattern for the next one:
  - **Ids are checked against what exists NOW** — `isKnownItem` for the bag and
    the gear slots, the roster for a species, `zones.zoneIds` for a zone,
    `world.carriers.get` for a moving frame. An id that no longer resolves is
    dropped, and the rest of the character still loads.
  - **Positions are re-resolved against the world as it is**, never trusted as
    written. `resolveSafeGround` finds the ground under the saved column because
    the terrain may have been reseeded and the hero may have been flying;
    `resolveOnCarrier` converts a deck position out of the frame's own
    coordinates because a flying island starts each session at its home. Both
    run at CAPTURE and again at LOAD — the second pass is not redundant. A hero
    STANDING ON SOMETHING — a crown, a roof, a crate — is the same rule pointed
    the other way: `perchY` is stored beside the ground and honoured as a
    bounded rise above the ground that is there now, because dropping him to the
    terrain reads as falling through the tree he stopped playing in.
  - **Derived state is recomputed, never stored.** `attackStat` comes back from
    re-equipping and `applyLoadout`; a beast's stats come back from its level.
    Storing a derived value is storing a second copy that a balance change puts
    out of step with the first.
  - **Nothing refuses a save.** Every unresolvable field degrades to a default
    and the load continues, because a throw out of a load costs the player the
    character. A save with no resolvable beast loads with an empty party, which
    is how every new game starts.
  - **A field whose MEANING changes is a version bump**, not an edit — bump
    `SAVE_DOC_VERSION` and add a branch to `migrateSaveDoc`. Adding a field
    needs neither, and needs no Dexie version either.

  Two things follow for content work in particular. Renaming a content id is a
  migration rather than an edit (`content/state.ts` says the same about quests),
  and a system that adds a new KIND of world state — a built structure, a
  claimed plot, a placed marker — owes a save both a field and a rule for what
  happens when the thing it points at is gone.

- **Keep `src/content/` free of static imports from `./storage/bundled.ts`** —
  it is the one file using `import.meta.glob`, which `test-zfight.mjs` (plain
  Bun, no Vite) cannot load. For the same reason `NPC_BODIES` stays a plain
  module constant.
- **Register content actions and factories above `bootstrapContent()`**, or the
  cross-asset pass reports them as unknown.
- **Nothing the world GROWS may stand inside something it BUILT.** The rule is
  one test in `Accum.add` (`world/props.ts`) against `SiteClearance`, so it
  holds for every foliage type and every structure, present and future — do not
  spell it again at a stamp site. It refuses a prop whose own MEASURED extent
  would pass through timber and refuses nothing else: grass grows against a
  palisade and around a fence post. A clearance disc is the other tool and it
  answers a different question ("no oaks in the camp", about the skyline); one
  wide enough to clear a wall strips the yard, which is issue #131.
- **Ask "is it close?" with `inReach` / `inRise`** (`core/types.ts`) — a radius
  AND a height band, never `dx² + dz²` alone, which is an infinite vertical
  column and reacts to a hero flying over it. Give the band its own number with
  its own rationale; a plain 3D distance is only right for something with no
  footprint (a projectile, a beam).

## UI and input

- **A modal takes the INPUT, never the clock.** The game never stops: with a
  panel up the hero still runs physics, so a jump lands and a fall finishes —
  he simply takes no input while it is up. `simulate()` sets `Input.suspended`
  around its gameplay block and clears it before reading the panel's own keys.
  The F3 performance panel is not a modal at all.
- **In game, `main.ts`'s cancel branch is the only reader of Escape** — it
  closes the topmost modal, and a panel reports its dismissal to its host. (The
  title screen and dev console are pre-game and handle their own.)
- **Release the pointer through `Input.releaseLock`**, never
  `document.exitPointerLock()`. Re-take it after a click, or after Escape only
  when `escapeIsLocked()`.
- **A panel owns the screen; the host owns what a click means.**
  `ui/inventory.ts` is handed a model and reports an action. `ui/settings.ts`
  owns its rows and writes the key; the host applies it.
- **Add a setting in five places**: a `Prefs` field, a `STORAGE_KEYS` entry, a
  row in the settings list, an `en.ts` string, and one choke point that respects
  it.
- **Store one localStorage key per setting**, `game.settings.<group>.<name>`,
  with the default as the absence of a key, validated on read.
- **Change a key binding and update [src/ui/keybinds.ts](src/ui/keybinds.ts) in
  the same commit**, saying whether it is a HOLD or a PRESS. `test-keybinds`
  fails on any code the game reads that no row names.
- **Player-facing text is 16px or larger at every screen size.** Write
  responsive sizes as `clamp(16px,…)` or `max(16px,…)` so the static scan reads
  the floor; on a phone, cut content rather than shrinking type. Developer
  instruments are exempt.
- **Size full-screen layers from `--bs-vw` / `--bs-vh`**
  ([core/viewport.ts](src/core/viewport.ts)), and call `installViewport()`
  before the engine.
- **Every player-visible name and sentence comes from `i18n/en.ts`** through
  `t()` / `tn()`. Look a string up on its way to the DOM and it follows a live
  language change for free; hoist one and you owe it a re-derive. IDs are keys,
  names are display: rename by editing the table.

## Content, game design and world building

Content is DATA; the engine implements reusable BEHAVIOUR.

- Settlements, NPCs, enemies, biomes, quests and playlists are assets in
  [src/content/data/core.json](src/content/data/core.json). The streamer, voxel
  builders, steering and combat loop are engine.
- **Content selects a behaviour by name**, never carries one: `"layout": "camp"`
  looks up a registered factory. A name nothing implements is a diagnostic.
- **An id is `type:name`** (`town:encampment`, `npc:gain`) and never a position.
  Flags such as `"start": true` express meaning; array order does not. Saves
  store ids.
- `core.json` is statically imported so the starting world needs no fetch;
  further packages load lazily (`/content load <name>`).
- **Text is `{ "key": … }`** for shipped strings, `{ "text": { "en": … } }` for
  content authored outside the build.
- **A town or enemy is an asset** — plus a factory only when it needs a shape no
  builder has. A town carries id, name, sign, layout, radius, colour, order,
  `start`, and `carried` for one that rides a moving piece of world;
  `outerRadius` and `noSpawnRadius` override what the layout and the safe-zone
  rule otherwise derive. The road planner is a hub with one trunk and two spurs,
  so a fourth GROUND settlement is reported and left unbuilt (three ship today;
  a carried town is sited by its carrier and takes no slot). A new settlement is
  budgeted 0 in `test-structures` until you baseline it.
- **Who stands in a town is data too.** An `npc:` asset's `present` condition says
  WHEN he is there (absent = always), `atFocus` rings him around the fire instead of
  the town centre, and `Npcs.reconcile` places and removes people live — on a package
  load, on a flag. A character who arrives with an act is a `present` row, not a
  spawn call (issue #162).
- **A body is code, and an asset points at it.** A beast is one file in
  `src/beasts/species/` exporting `species: BeastSpecies` and
  `skills: SkillDef[]`; a character is one file in `src/world/` registered in
  `NPC_BODIES`. Both paint with `VoxelModel` and pose in `animate(rig, ctx)`.
  Add a beast's import to [src/beasts/registry.ts](src/beasts/registry.ts),
  which populates `ALL_SPECIES` and `SKILLS`. Then run `test-zfight`.
- **A new skill is usually a `SkillDef`** in a species file; combat switches on
  `SkillDef.targeting`.
- **Towns are landmarks, not zones** — you walk in and out and nothing loads.
- **A safe zone is a spawn rule, not a wall.** A hunter follows you across it.
- **Every kind of path is the same system.** A cart road, a settlement's beaten
  track and a flagged street are all paths on a `RoadNetwork` (issue #142), and
  a profile declares its ROLES — does it own the walking surface, refuse what is
  BUILT, refuse what is GROWN, get drawn, wear the ground. Add a fourth kind by
  adding a profile, not a mechanism, and give it a role rather than a special
  case at the query site. A path the PLANNER drew from its own layout refuses
  nothing built: a camp's tracks point at its own huts and the island's lamps
  stand halfway along its streets.
- **A path's numbers come from its PROFILE, never from a constant.** Width,
  verge, shoulder ramp, carve band, sink, cross-section, apron radius and
  palette are one derived bundle (`world/path-profile.ts`) because four of them
  describe a single band and every sample of issue #15 lived in it while two of
  the four disagreed about where it ended. Pick a width and a carve mode; the
  band follows. And **ask a clearance from the RIM, not the centreline** —
  `edgeDistanceTo` / `spanEdgeDistanceTo` (`RoadClearance`), so a caller states
  its own margin and nothing carries the cart road's half-corridor inside a
  literal.
- **A fence is a PATH, not a row of panels.** Everything post-and-rail goes
  through `buildFence` (`world/fences.ts`): the caller hands over the line it
  means and the system chooses the posts, bounds the gaps, measures each plank
  against the gap it actually spans, lifts the line clear of the ground UNDER
  each bay, and refuses a bay it cannot clear — ending that chain and starting
  the next. A fixed-length panel stamped at a caller's own interval is issue
  #105 in every one of its forms.
- **A footprint is not a placement radius.** `place` in towns.ts claims 11 units
  around a lamp so two lamps do not crowd; what a plank must not pass through is
  the lamp's own timber, which is `footprintRadius` (`world/structures.ts`),
  measured off the same boxes the collider was.
- **Build a settlement the way you build a body**: a builder paints a voxel
  model and the collider is measured off it, so a shape is never authored twice.
  A roof is a ridge cylinder (bracket its paint loop with `VoxelModel.region`),
  a wall is an oriented box — a handful of colliders per model.
- **What you see is what you stand on, by construction.** Anything drawn over
  the walking surface samples that surface per vertex.
- **Never change a collider without saying so.** A probe cannot tell you a wall
  is in a sensible place; a person playing can. Report the change, do not bury
  it in a larger commit.
- **Test the collider MECHANISM once, not every structure.** Buildings that
  share a builder share its bugs. Hand-placed colliders need no test at all.

## Code conventions

- **Update paths reuse** module-level scratch vectors, instanced meshes and
  object pools; keep them allocation-free.
- **Smooth with `1 - exp(-lambda * dt)`** so behaviour is frame-rate
  independent.
- **Consume a frame-loop key edge with `takePress()`**, and let slice-read
  presses survive. Consume accumulated look and zoom deltas with `takeLook()` in
  the camera. Both classes of bug hide under `fps=30`.
- **Part the voxel grid at a joint** so two parts of one body never share a face
  plane; glow pieces go through `GLOW_PART`. Verify with `test-zfight`, then
  look at a capture.
- Everything added to the scene has a matching `dispose()` path.
- Curated captures in `shots/` are tracked; scratch names (`_*`, `r<n>-*`,
  `c<n>-*`, `cur-*`) are gitignored.
