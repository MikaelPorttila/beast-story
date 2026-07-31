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
- Typecheck + build: `bun run build` (runs `tsc --noEmit` first — keep it clean).
  `bun run snapshot [label]` writes a timestamped, self-contained build to `dist/`.
- There is no unit-test runner. The tests are browser probe scripts that print
  JSON: `bun tools/test-f2.mjs [lab]`, `test-touch.mjs`, `test-crosshair.mjs`,
  `measure-layout.mjs`, `test-beastanim.mjs`, `test-structures.mjs`,
  `test-sway.mjs`.
  `tools/capture-set.ps1` (PowerShell, project root) captures the full critic
  shot set.
- `test-structures.mjs` is the settlement-collision guard, and it DRIVES rather
  than computes: for every town the registry reports it aims the camera at a
  real collider (`__dbgStructures` finds them, so no coordinate is pinned to a
  seed), teleports the hero back along that bearing, holds W, and reads
  `__dbgPlayerPos`. Every case runs twice, the second time with `solids=0`, so
  the output is a before/after of the identical walk. A hut, a barrel and the
  perimeter must STOP him; the gate must not — it should land him as deep in
  camp as the run with no collision at all. It also parks him against a wall and
  reads `__dbgBodies` to check his beasts and the wild spawns are not inside it.
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

**The contract hub.** [src/core/types.ts](src/core/types.ts) holds every
cross-module interface — `World`, `BeastSpecies`/`BeastRig`/`BeastAnimCtx`, `SkillDef`,
`Damageable`, `CastRequest`, `EventBus`. Subsystems depend on this file, not on
each other: combat never imports the world's implementation, beasts never import
combat. Widen a contract here rather than reaching across modules.

**Composition roots.** [src/main.ts](src/main.ts) is the only place that wires
Engine + World + Player + Beasts + Combat + HUD together, and the only frame loop in
the game; gameplay policy that is no subsystem's own business (roster, hotbar,
cooldowns, shop purchases, support-beast AI) lives there.
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
`__dbgTowns()` reports the registry plus each road's measured worst step and
grade.

Settlements are SOLID, and the collider is never authored twice.
[src/world/structures.ts](src/world/structures.ts) measures a footprint off the
voxel model a builder just painted — the boxes are the mesh — and `SolidStamp`
makes one call push both the vertices and the collider, so a hut cannot be
placed without being made solid. The primitive is an ORIENTED BOX because a hut
is a rectangle; the footprint counts only material between `MAX_STEP_UP` and
head height, which is what leaves the Encampment's gate an opening rather than a
wall and lets a road run under a lamp's bracket. It reaches the player as
`World.structureTopAt`, a third column-top query beside `getHeight` and
`trunkSolidTopAt`, so everything that moves — hero, saddle, beast, enemy —
resolves it against the same `MAX_STEP_UP` ([src/core/types.ts](src/core/types.ts))
it already used for terrain. `solids=0` keeps the meshes and removes the
blocking, which is the A/B `tools/test-structures.mjs` runs; `/show-colliders`
draws the boxes green.

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

**Game URL parameters.** `photo=1` with `cam=x,y,z` / `look=x,y,z` / `beast=<id>` /
`anim=` / `a=<deg>` / `hud=0` stages captures. **`cam` and `look` are OFFSETS
FROM `world.spawnPoint`, not world coordinates** — feeding them the absolute
position of a thing you want to photograph silently puts the camera twice as far
out, which renders a plausible picture of the wrong place rather than an error.
Subtract the spawn (`__dbgTowns().spawn`) first. `npct=<seconds>` pins the NPC
animation clock so two stills of the same 4.6 s curl are reproducible;
`fps=<n>` caps the frame rate;
`debug=1` opens the F2 overlay; `fsprompt=1` forces the touch fullscreen offer
past the device test and any remembered answer (`fsprompt=0` suppresses it, and
it never appears in `photo=1`); plus every post-processing override above.
`lang=<iso639-1>` pins the display language (default `navigator.language`, then
`en` — see **Strings** below). Lab parameters are in [LAB.md](LAB.md).

**Strings.** Every player-visible name and sentence comes from
[src/i18n/en.ts](src/i18n/en.ts), the BASE table and the source of truth for
every key; other languages are `src/i18n/<iso639-1>.ts` holding only what they
have translated, and anything missing falls back to `en` — never to a blank or a
raw key. One lookup function, `t(key, vars?)` (plus `tn(base, count)` for
one/other plurals), and keys are typed off the base table so a typo is a compile
error. **IDs are keys; names are display**: the currency's id is still `'shard'`
because saves, the drop table and the fetch rule key on it, while it displays as
"Cubloons". Rename a thing by editing the table, never the id.

## Conventions

- **No per-frame allocation** in update paths. Module-level scratch vectors (`_a`,
  `_dummy`, …), instanced meshes and object pools are the norm; keep them that way.
- **Frame-rate independence.** Smoothing uses `1 - exp(-lambda * dt)`, never a fixed
  lerp factor. `Engine.tick()` clamps `dt` to 0.05 s.
- **Tuned constants carry their rationale.** The long comments explaining why a value
  is what it is — and what the previous value looked like when captured — are the
  point, not clutter. When you change such a value, update its comment with what you
  measured; don't delete the history.
- Everything that adds to the scene has a matching `dispose()` path.
- Curated captures in `shots/` are tracked; scratch names (`_*`, `r<n>-*`, `c<n>-*`,
  `cur-*`) are gitignored.
