# Beast Story Lab — isolated iteration stage

`lab.html` renders **one subject on a bare stage**: no terrain streaming, no props,
no enemy spawner, no HUD, no gameplay loop. Use it to iterate on a model, an
animation, a skill effect or an enemy without paying for a whole world.

A lab shot lands in a fraction of the time a game capture takes — it skips world
streaming and most of the settle wait — and the `t=` parameter makes it
deterministic, the same frame every run.

```bash
bun tools/lab-shot.mjs shots/lab-fox.png "beast=emberfox&t=2"
```

## Rules

1. **The lab is for tweaking, never for signing off.** Lighting, fog, terrain
   colour, shadow contact and prop context all differ from the real game. Any
   change tuned here MUST be re-verified in `index.html` (via
   `tools/capture-set.ps1` or `tools/screenshot.mjs`) before it counts as done.
2. Anything a critic scores must come from real-game shots, not lab shots.
3. The lab imports the same modules the game does — it is not a copy. Never
   fork model or animation code into `src/lab/`.

## Parameters

| Parameter | Effect |
| --- | --- |
| `beast=<id>` | One beast — ids in `src/beasts/registry.ts` |
| `beasts=all` or `beasts=a,b,c` | Lineup, evenly spaced, framed to fit |
| `spacing=<units>` | Lineup spacing (default 2.0) |
| `enemy=gloopling\|snortle\|peckit` | One enemy (`variant=<n>` for palette variants) |
| `hero=1` | The player character rig, posed by the game's own `HeroAnimator` |
| `weapon=<id>` | What is in his hand — `sword greatsword bow dagger scythe` (default: the sword the rig is built with) |
| `stow=1` | Carry it on his back instead, as the game does out of combat |
| `hair=<id>` | Which hairstyle — ids in `src/player/hair.ts` (`classic buzz bowl curtain ponytail emo cloud mohawk saiyan`); default: whatever the player last picked |
| `haircolour=RRGGBB` | Draw it in this colour instead of the style's own |
| `skill=<skillId>` | Fires that skill on a loop at a dummy 6 units away |
| `anim=<action>` | `idle walk run swim fly attack cast special hurt happy` — the hero also answers to `climb ride dead` |
| `follow=1` | The owner teleports around the stage and the beasts chase it, instead of standing on their marks — the catch-up case, without a world |
| `jump=<seconds>` | How often it teleports (default 1.2) |
| `reach=<units>` | How far away it reappears (default 14) |
| `waterfall=1` | A waterfall VFX (`src/world/waterfall.ts`) on a bare stage |
| `fall=<units>` | How far it falls before it is invisible (default 48) |
| `push=<units>` | How far it is pushed sideways over that (default 0) |
| `spray=<n>` | Droplet budget (default 128, `0` = none) |
| `lean=<units/s>` | Fake a carrier's sideways motion, to see the plume trail |
| `fence=<demo>` | The paths and fences stage (`src/lab/paths-stage.ts`) — see below |
| `orbs=1` | The four taming orbs in a row, turning (`src/combat/tame-orb.ts`) |
| `gap=<units>` | Spacing between the orbs (default: 1.5 diameters, so they never touch) |
| `scale=<n>` | How big each orb is drawn (default 2.4) |
| `face=<deg>` | Turn the subject to an ABSOLUTE bearing, independent of the camera — `90` is broadside, `180` is the rump. Without it a lone subject turns with the lens and always presents its face, which makes a quadruped's profile unreachable |
| `t=<seconds>` | Simulate this long, render **one frozen frame**, stop |
| `spin=1` | Turntable |
| `water=1` | Flood the stage (swim / amphibious testing) |
| `dist` `height` `angle` | Camera framing (units, units, degrees) |
| `bg=RRGGBB` | Backdrop colour (also disables fog) |
| `grid=0` | Hide the floor |
| `fps=<n>` | Frame-rate cap; `0` = uncapped |

## Paths and fences

`fence=<demo>` builds a road, a bridge and fences over an analytic ground field
— no terrain streaming, no world, and the same modules the game uses
(`world/fences.ts`, `world/town-parts.ts`). It exists because the only way to
look at a bridge or a road fence used to be to load the world and walk to the
one the seed happened to build.

| Demo | What it is for |
| --- | --- |
| `slope` | A straight run over a ridge — the fence line moves under the fence |
| `turn` | A right angle, so a corner post has to carry both bays |
| `ring` | A closed ring: the last bay joins back to the first |
| `gate` | A run with refused bays in the middle — what a road crossing leaves |
| `variants` | Every post variant on one run, lanterns lit |
| `bridge` | A deck over a channel: soffit, piers and both railings |
| `transition` | A cart road becoming a footpath at a two-arm node |
| `all` | Every one of them, laid out around the origin |

`transition` is the second path PROFILE (`world/path-profile.ts`) beside the
first: same mechanism, half the width, its own palette, no lamps and no
bridging. The node between them is `buildJunctionApron` with two arms rather
than three, which is what a road-type change is.

`__dbgFence()` reports every post and bay in world coordinates plus the deck's
down-facing triangle count, and `bun tools/test-fence.mjs` asserts the fence
invariant over it AND over the fences the real world builds.

```bash
bun tools/lab-shot.mjs shots/_fence.png "fence=bridge&t=1&angle=70&height=6&dist=30"
```

## Debug overlay (F2)

Press **F2** in either the game or the lab to toggle a live performance
readout: measured FPS (wall-clock, not the cap), ms/frame, a 1%-low figure,
whether a cap is set and what it is, plus draw calls, triangles and
geometry/texture counts. `?debug=1` starts it already open, which is how
capture runs show it. F2 is `preventDefault`ed so it never reaches the
browser — verified by `bun tools/test-f2.mjs [lab]`.

## Frame-rate cap

`fps=<n>` works in both `lab.html` and the game (`index.html`). Both capture
tools append `fps=30` automatically: a still gains nothing from more frames, and
the cap stops an accelerated host rendering hundreds of them through the settle
wait — pass an explicit `fps=` in the query to override (`fps=0` for uncapped,
needed only when
measuring real frame timing or capturing fast motion). Frozen (`t=`) lab shots
render exactly once, so the cap does not apply to them.

Run `labInfo()` in the browser console to list every valid beast, enemy and skill id.

## Examples

```bash
# every beast side by side
bun tools/lab-shot.mjs shots/lab-all.png "beasts=all&t=1.5" 2000 700

# a quadruped in profile — the bearing its silhouette actually lives at
bun tools/lab-shot.mjs shots/lab-side.png "beast=graveback&face=90&t=2"

# one beast mid-cast, deterministic frame
bun tools/lab-shot.mjs shots/lab-cast.png "beast=drakelet&anim=cast&t=2.4"

# swimmer in water
bun tools/lab-shot.mjs shots/lab-swim.png "beast=aquaxol&water=1&t=3"

# skill VFX against a plain backdrop
bun tools/lab-shot.mjs shots/lab-vfx.png "skill=emberfox.flame-dart&t=2.2&bg=202830"

# a waterfall, blown hard sideways
bun tools/lab-shot.mjs shots/lab-fall.png "waterfall=1&fall=48&push=10&t=3&bg=8fa8c0"

# live (not frozen) turntable in the browser
#   http://localhost:5187/lab.html?beast=frostwing&spin=1
```
