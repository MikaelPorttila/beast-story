# Cube Pals Lab — isolated iteration stage

`lab.html` renders **one subject on a bare stage**: no terrain streaming, no props,
no enemy spawner, no HUD, no gameplay loop. Use it to iterate on a model, an
animation, a skill effect or an enemy without paying for a whole world.

Screenshots that would take ~60 s through the game take ~10 s here, and the
`t=` parameter makes them deterministic (same frame every run).

```bash
node tools/lab-shot.mjs shots/lab-fox.png "pal=emberfox&t=2"
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
| `pal=<id>` | One pal — ids in `src/pals/registry.ts` |
| `pals=all` or `pals=a,b,c` | Lineup, evenly spaced, framed to fit |
| `spacing=<units>` | Lineup spacing (default 2.0) |
| `enemy=gloopling\|snortle\|peckit` | One enemy (`variant=<n>` for palette variants) |
| `hero=1` | The player character rig |
| `skill=<skillId>` | Fires that skill on a loop at a dummy 6 units away |
| `anim=<action>` | `idle walk run swim fly attack cast special hurt happy` |
| `t=<seconds>` | Simulate this long, render **one frozen frame**, stop |
| `spin=1` | Turntable |
| `water=1` | Flood the stage (swim / amphibious testing) |
| `dist` `height` `angle` | Camera framing (units, units, degrees) |
| `bg=RRGGBB` | Backdrop colour (also disables fog) |
| `grid=0` | Hide the floor |
| `fps=<n>` | Frame-rate cap; `0` = uncapped |

## Debug overlay (F2)

Press **F2** in either the game or the lab to toggle a live performance
readout: measured FPS (wall-clock, not the cap), ms/frame, a 1%-low figure,
whether a cap is set and what it is, plus draw calls, triangles and
geometry/texture counts. `?debug=1` starts it already open, which is how
capture runs show it. F2 is `preventDefault`ed so it never reaches the
browser — verified by `node tools/test-f2.mjs [lab]`.

## Frame-rate cap

`fps=<n>` works in both `lab.html` and the game (`index.html`). Both capture
tools append `fps=30` automatically, since software GL gains nothing from
more frames — pass an explicit `fps=` in the query to override (`fps=0` for
uncapped, needed only when measuring real frame timing or capturing fast
motion). Frozen (`t=`) lab shots render exactly once, so the cap does not
apply to them.

Run `labInfo()` in the browser console to list every valid pal, enemy and skill id.

## Examples

```bash
# every pal side by side
node tools/lab-shot.mjs shots/lab-all.png "pals=all&t=1.5" 2000 700

# one pal mid-cast, deterministic frame
node tools/lab-shot.mjs shots/lab-cast.png "pal=drakelet&anim=cast&t=2.4"

# swimmer in water
node tools/lab-shot.mjs shots/lab-swim.png "pal=aquaxol&water=1&t=3"

# skill VFX against a plain backdrop
node tools/lab-shot.mjs shots/lab-vfx.png "skill=emberfox.flame-dart&t=2.2&bg=202830"

# live (not frozen) turntable in the browser
#   http://localhost:5187/lab.html?pal=frostwing&spin=1
```
