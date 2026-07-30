# Agent guidelines — Cube Pals

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
bun tools/lab-shot.mjs shots/lab-fox.png "pal=emberfox&t=2"
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
  `measure-layout.mjs`. `tools/capture-set.ps1` (PowerShell, project root)
  captures the full critic shot set.
- Read [LAB.md](LAB.md) before iterating on models, animations or skill VFX;
  in particular, lab shots never count as sign-off — re-verify in `index.html`.

## Architecture

TypeScript + three.js, no framework and no asset files — every model, animation
and effect is generated in code. Vite serves two entries from the same modules.

**The contract hub.** [src/core/types.ts](src/core/types.ts) holds every
cross-module interface — `World`, `PalSpecies`/`PalRig`/`PalAnimCtx`, `SkillDef`,
`Damageable`, `CastRequest`, `EventBus`. Subsystems depend on this file, not on
each other: combat never imports the world's implementation, pals never import
combat. Widen a contract here rather than reaching across modules.

**Composition roots.** [src/main.ts](src/main.ts) is the only place that wires
Engine + World + Player + Pals + Combat + HUD together, and the only frame loop in
the game; gameplay policy that is no subsystem's own business (roster, hotbar,
cooldowns, shop purchases, support-pal AI) lives there.
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

**Pals.** Each species is one self-contained file in `src/pals/species/` exporting
`species: PalSpecies` and `skills: SkillDef[]`, building its body with `VoxelModel`
([src/core/voxel.ts](src/core/voxel.ts)) and animating procedurally in
`animate(rig, ctx)`. Adding a species means adding its import to
[src/pals/registry.ts](src/pals/registry.ts) — that module list is what populates
`ALL_SPECIES` and `SKILLS`. `voxelshade.ts` / `glowsprite.ts` are shared helpers,
not species. `PalActor` ([src/pals/framework.ts](src/pals/framework.ts)) is the
generic half: follow steering, per-locomotion vertical motion, the
transient-over-base action state machine, XP/levels, damage, death and revive. It
calls `species.animate()` once per frame with the resolved action; species code
holds no physics or state machine of its own.

**Combat.** `CombatSystem` ([src/combat/index.ts](src/combat/index.ts)) owns VFX,
damage numbers, shard pickups and the wild-enemy population, and executes casts by
switching on `SkillDef.targeting`. A new skill is usually data — a `SkillDef` in a
species file — not new code.

**UI and input.** The HUD is a DOM overlay ([src/ui/index.ts](src/ui/index.ts),
styles injected by `src/ui/styles.ts`), not canvas-drawn. Class names are `cp-*`
and the layout/crosshair/touch tools assert on them — renaming one breaks a tool.
`TouchControls` builds the twin-stick overlay only on touch-primary devices.
`main.ts` exposes read-only probes (`__dbgPlayerPos`, `__dbgCamYaw`, `__dbgInput`)
that exist purely for those tools; keep them working.

**Game URL parameters.** `photo=1` with `cam=x,y,z` / `look=x,y,z` / `pal=<id>` /
`anim=` / `a=<deg>` / `hud=0` stages captures; `fps=<n>` caps the frame rate;
`debug=1` opens the F2 overlay; plus every post-processing override above. Lab
parameters are in [LAB.md](LAB.md).

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
