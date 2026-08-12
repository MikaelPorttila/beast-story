# SKYHAVEN — the block spec, read off `map-top.png`

This is the authority for **where things go** on the flying island. It was
derived by measuring `shots/ref/map-top.png` pixel by pixel, cross-checked
against `shots/ref/ref-hero.png` and `shots/ref/ref-angles.png`. Later agents
build from this file and do not need to re-read the map.

---

## 0. Frame, units and how to read every number below

**The map.** `map-top.png` is 1254 x 1254 px. The island's disc is centred on
pixel **(628, 630)** with a radius of **597 px**. The plan is 52 map-blocks
across, so:

| quantity                   | value                               |
| -------------------------- | ----------------------------------- |
| `MAP_R`                    | 26 blocks (radius)                  |
| 1 map-block on the map     | **22.96 px**                        |
| 1 map-block in cells       | `MAP_BLOCK` = 3                     |
| 1 map-block in world units | 3 x `CELL` = **3.6**                |
| `ISLAND_R` (= 1.00 R)      | 26 x 3 x 1.2 = **93.6** world units |
| 1 block as a fraction of R | **0.03846 R**                       |

**Every distance in this spec is a fraction of the island radius R.** Multiply
by `ISLAND_R` for world units, or by 26 for map-blocks.

**Bearings are compass bearings**: `000` = north = the TOP of the map = **−Z**.
`090` = east = **+X**. Clockwise. To place something at bearing `B` degrees and
radius fraction `f`:

```ts
const b = (B * Math.PI) / 180;
const x = Math.sin(b) * ISLAND_R * f;
const z = -Math.cos(b) * ISLAND_R * f;
```

> **TRAP.** `planSkyhaven`'s existing `at(a, d)` helper returns
> `[sin(a)*d, cos(a)*d]` — **+cos for z**, so its angle 0 points SOUTH and its
> angles run anticlockwise in compass terms. Every bearing in this document is
> compass. Either fix `at` to negate z, or convert at every call site. Do not
> mix the two; every misplaced feature in the current build that is 180 degrees
> from where it should be would come from exactly this.

**Vertical.** The deck's top face is local y = 0. Height differences below are
quoted in map-blocks and in world units; see §3 for the one place the two
cannot both be honoured.

---

## 1. THE OUTLINE

**It is a circle, not a rounded square.** This is the single most misread thing
about the plan. Measured radius against bearing, over 96 rows of the map:

- Between bearings **300 and 090** (the whole northern half, NW through N to E)
  the outline sits at **1.00 R ± 0.03 R**. There is no lobing you can see.
- Between **150 and 220** (the south) it is flattened to **0.92–0.95 R** — the
  single largest departure from a circle anywhere on the plan, and it is a
  gentle chord, not a bite.
- One shallow scallop at bearing **205**, reaching in to **0.90 R** over about
  25 degrees of arc.
- Everywhere else: **|r(θ) − 1.00 R| ≤ 0.05 R**.

Two things stick OUT past 1.00 R and neither is terrain:

- the **gate causeway** at bearing 180, out to **1.02 R** (§7);
- the **dock platform** at bearing 108, out to **1.03 R** (§7).

**The coastline is quantised, and that is what makes it read as blocks.** The
map's edge steps in staggers of **2–3 map-blocks** along the perimeter — never a
smooth arc, never a single long straight. Building it at `CELL` gives a finer
notch than the map draws; that is correct and desirable (the plan is drawn at a
coarser gauge than the world is built at), but the _envelope_ must stay inside
±0.05 R.

**There are no inlets and no bays.** Nothing on the map cuts more than 0.10 R
into the disc. Anything deeper than that is an invention.

Prescription for `outlineAt`: mean **1.00 x RC**, with the total amplitude of
all harmonics **≤ 0.05**, plus a per-cell quantisation. A 4-lobe term at 0.15
squares the island off and is wrong.

---

## 2. RINGS — what the ground is made of, outward from the centre

The plan has **no paved central plaza**. The middle of the island is grass with
the street cross running through it. Bands, by radius:

| band              | surface                                                                                                                                                                       |
| ----------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **0.00 – 0.16 R** | Open **grass**, crossed by the two main avenues (§4). Two or three specimen trees, low flower dots. Nothing is built here.                                                    |
| **0.16 – 0.30 R** | **Grass** with hedge rows and flower beds along the street edges. The two inner cottages (B5, B7) stand at its outer limit.                                                   |
| **0.30 – 0.70 R** | **The settled band.** All eight buildings (§5), their lanes, their hedges, their door aprons of paving. Grass between them, never bare.                                       |
| **0.70 – 0.88 R** | **Outer meadow.** The perimeter fence runs somewhere inside this band (§7) and the tree belt straddles it (§8). Denser rough grass, more flowers, fewer paths.                |
| **0.88 – 0.97 R** | **Rim meadow.** Turf only. No buildings, no paths except the gate causeway. Trees thin out to nothing in the last 2 blocks.                                                   |
| **0.97 – 1.00 R** | **The rim lip.** The outermost 1–2 blocks read from above as a stepped grey **stone** collar under an overhanging green turf edge. This is the top of the cliff, seen end-on. |

Overlaid on those bands, and taking priority over them:

- **Paving** wherever a street or lane runs (§4), and on each building's door
  apron (2 x 2 blocks in front of every door).
- **Water** along the watercourse and pond (§6).
- **The raised terrace** north of 0.16 R (§3), which is grass on top like the
  rest but sits one block higher.
- **Tilled soil**: _the map shows none._ See §8 for what to do about that.

---

## 3. HEIGHT LEVELS — the terrace and its stair

The map shows exactly **two** ground levels. Everything else is flat.

**The raised region.** A rectangular terrace occupying the north-centre:

- **South edge** (the retaining face): a straight E–W line at **0.16 R north** of
  the centre.
- **East / west extent**: from **0.18 R west** to **0.18 R east** — about
  **9.4 map-blocks** wide. It is _not_ the full width of the island.
- **North extent**: it runs north under the great hall and dies out into the
  meadow around **0.75 R north**. Its north end has no wall; the ground rises to
  meet it.
- **Rise**: **1 map-block on the map** as drawn (the wall shows one course of
  dressed stone plus a dirt cap).

**The retaining edge.** Dressed warm-grey stone (**#726636 / #66664E**), one
block of visible face, capped by a single course of dirt-then-turf so the grass
overhangs it exactly as the island's own rim lip does. The wall's two ends
finish in a square stone newel; past the newels the level change is a short
grassed bank, not masonry.

**The stair.** On the meridian, dead centre:

- **Bearing 000, centred on x = 0.**
- **Width 3 map-blocks** (0.115 R) — the same width as the avenue it continues.
- Dressed stone, four visible risers on the map, flanked by a **1 x 1 block
  stone newel post** on each side, standing about 1.5 blocks proud.
- It lands at **0.10 R north** at the bottom and **0.16 R north** at the top.

### The engine constraint, and the one place this spec bends

`MAX_STEP_UP` is 0.5 world units, and `measureFootprint` only turns material
above 0.5 into a collider — so **a stamped voxel staircase can never be
climbed**: a tread under 0.5 is not a floor and one over it is a wall. The
terrace therefore has to live in **`deckAt`**, which is a function you control,
with the painted mesh made to agree with it.

- Terrace height: **3 cells = 3.6 world units = 1 map-block**. `deckAt` returns
  3.6 north of the retaining line and 0 south of it.
- **The stair corridor is a continuous RAMP in `deckAt`**, not a set of steps: a
  linear rise of 3.6 units over a run of **at least 8 cells (9.6 units)**, which
  is **0.45 units per cell** — under `MAX_STEP_UP` with margin at every frame
  rate. Ten cells (12 units, 3.3 blocks) is the recommended run; the map draws
  the flight shorter than that and the map loses this argument.
- **The drawn stair must be finer than `CELL`.** A ramp painted in 1.2-unit
  cubes steps by 1.2 and breaks "what you see is what you stand on". Draw the
  flight as its own model at a gauge of **0.4 units** (nine risers of 0.4, tread
  0.8 over the 9.6-unit run) so the treads and the continuous deck agree to
  within a fifth of a cell.
- Everywhere else along the retaining line the 3.6-unit face **is** a wall, and
  should be: it is the thing the stair exists to get round.

Nothing else on the island changes height. The cliff (§ below) is where the rest
of the vertical drama is, exactly as the current header argues.

---

## 4. STREETS

The network is a **cross plus six lanes**. It is not a ring road and it is not a
wheel.

### 4.1 The Avenue — the main N–S axis

- Bearing **000/180**, running along **x = 0**.
- **South end:** the gate at 0.67 R south, continuing as the causeway to 1.02 R.
- **North end:** the great hall's south porch at **0.285 R north**, up the stair
  at 0.10–0.16 R north.
- **Width:** **3 map-blocks (0.115 R)** from the stair south to 0.25 R south;
  **4 map-blocks (0.154 R)** from there down to the gate. The wide lower stretch
  is the market street.
- Surface: pale flagstone, **#DEC68A** lit / **#C6AE66** shaded, laid in a
  visible block grid with a worn darker kerb (**#8A661E**) at both edges.

### 4.2 The Cross Street — the E–W axis

- Bearing **090/270**, running along a line **0.07 R SOUTH of centre** (not
  through the centre — the crossroads is deliberately off the middle).
- **Width 2.5 map-blocks (0.096 R).**
- **West end:** dies into the meadow at **0.75 R west**.
- **East end:** dies into the meadow at **0.72 R east**, after crossing the
  watercourse on a plank footbridge (§7).
- Same paving as the Avenue.

### 4.3 The lanes

Six, one to each outer building, 2 map-blocks (0.077 R) wide, same paving but
with grass encroaching at the edges. Each runs from the nearer of the two
avenues to its building's door apron and stops there:

| lane    | from                        | to  | bearing |
| ------- | --------------------------- | --- | ------- |
| NW lane | Avenue at 0.20 R north      | B2  | 327     |
| NE lane | Avenue at 0.20 R north      | B3  | 034     |
| W lane  | Cross Street at 0.30 R west | B4  | 283     |
| E lane  | Cross Street at 0.30 R east | B6  | 083     |
| SW lane | Avenue at 0.28 R south      | B8  | 230     |
| SE lane | Avenue at 0.20 R south      | B7  | 134     |

**Every street terminates in something** — a door, a gate, or a fading verge in
the meadow. None of them run to the rim. There is no ring road at any radius.

---

## 5. THE BUILDINGS — eight, counted

The plan has **exactly eight buildings**. They are authored, not generated: each
has a fixed bearing, radius, footprint, roof material and storey count. Five
carry blue slate; three carry brown plank. The one big one is **the Great Hall**.

Footprints are given as **width x depth in map-blocks**, width across the
building's own facing and depth along it. "Faces" is the bearing the front door
looks along.

| #      | name                 | bearing | r/R      | footprint (blocks) | storeys   | roof                                   | faces |
| ------ | -------------------- | ------- | -------- | ------------------ | --------- | -------------------------------------- | ----- |
| **B1** | **The Great Hall**   | **000** | **0.59** | **10 x 16**        | 2 + tower | **blue slate**, cruciform              | 180   |
| B2     | North-west cottage   | 328     | 0.65     | 4 x 7              | 1 + loft  | blue slate                             | 147   |
| B3     | The Barn             | 033     | 0.68     | 5 x 7              | 1 tall    | **brown plank**                        | 214   |
| B4     | West longhouse       | 285     | 0.62     | 5 x 6              | 1 + loft  | **brown plank**                        | 103   |
| B5     | West cottage         | 269     | 0.35     | 5 x 7              | 1 + loft  | blue slate                             | 087   |
| B6     | East hall-and-barn   | 081     | 0.55     | 5 x 8              | 1 + loft  | **brown plank** with a blue-slate core | 263   |
| B7     | South-east cottage   | 131     | 0.29     | 5 x 7              | 1 + loft  | blue slate                             | 314   |
| B8     | South-west longhouse | 231     | 0.56     | 6 x 8              | 1 + loft  | **brown plank**                        | 050   |

### B1 — The Great Hall (the landmark)

The subject of the whole plan and the thing the current build is missing. It is
**a tenth of the island wide and nearly a third of it deep**, sitting on the
raised terrace at bearing 000.

- **Plan**: cruciform. A long N–S nave 6 blocks wide, with a pair of transept
  wings taking it out to the full 10 blocks between 0.45 R and 0.60 R north.
  A 3-block-deep porch projects south from the nave at 0.285 R north; the main
  door is in it, on the Avenue's centreline.
- **The tower**: a **4 x 4 block** square shaft of dressed grey stone rising out
  of the crossing, centred at **bearing 000, r 0.54 R**. It is the only part of
  the island visible over the horizon. Above the roofline it carries a belfry
  stage, a **stepped blue spire** and a pennant on an iron pole. From
  `ref-hero.png` it stands roughly **three times the hall's ridge height**.
- **Corner turrets**: four small square stone turrets, 1.5 x 1.5 blocks, one at
  each corner of the hall's own precinct — measured at ±0.19 R east/west and
  0.73 R / 0.26 R north.
- Two subsidiary doors, one in the west flank at 0.56 R and one in the east
  flank at 0.46 R, each with a small brown-roofed porch.
- Walls: pale plaster over a dressed-stone plinth, heavy timber framing.
  Windows lit.

### The other seven

All seven are the same architectural family: dressed-stone footing, plastered
timber-framed walls, a steep gable, lit windows, a stone chimney on one gable.
What varies is footprint, roof material and orientation. **Only three roof
axes appear on the map** — the buildings are not all turned to face the middle.

- B3 (the Barn) is a **plain rectangle with one very large cart door** in the
  centre of its south gable, no windows on the map, and the longest unbroken
  roof plane on the island.
- B6 is the odd one: a brown plank roof wrapping a smaller blue-slate ridge, i.e.
  a barn with a dwelling built into it. Draw it as one mass with two roof
  materials, not two separate buildings.
- B4 and B8 are longhouses — the roof runs the long axis, and the entrance is in
  the long side, not the gable.

**There is no well, no market stall and no free-standing tower.** All three are
in the current build and none of them is on the map.

---

## 6. WATER

**One watercourse, all of it on the east side.** No lake in the middle, no ring
of water.

- **Spring**: bearing **050**, r **0.85 R**. The stream simply begins there in
  the meadow — there is no visible source structure on the map.
- **Course**: an arc bending clockwise down the east flank, through
  bearing **080 / 0.80 R**, bearing **105 / 0.68 R**, bearing **120 / 0.55 R**.
  Channel width **2 map-blocks (0.077 R)** throughout, widening to 3 as it
  approaches the pond.
- **The pond**: centred **bearing 145, r 0.45 R**. It is a rough oval, **7
  blocks across (0.27 R) east–west by 9 blocks (0.35 R) north–south**, with a
  ragged block coastline — it is drawn as a pool that has spread, not a circle.
  Its water surface is one block below the surrounding turf, so it reads as a
  hollow, not a puddle painted on the lawn.
- **The outfall**: a 2-block channel leaving the pond's south-east lip and
  running to the rim.
- **The waterfall leaves at bearing 138, at 0.96–1.00 R.** Lip width **2
  map-blocks**; the plume widens to about 3 blocks in the first few courses,
  runs the full depth of the keel and dissolves rather than ending square. The
  head is white foam (**#BCE6F0**), the body is the same teal as the stream.
- The fall is on the island's **front-right quarter as the reference sheet
  frames it** — angle 1 (front 3/4) and angle 2 (side profile) both have the
  gate and the fall in one picture. Keep them a fixed 41 degrees apart
  (gate 180, fall 138); do not let a seed move either.

Water colour: **#1E8AA2** lit / **#1E7E96** body / **#127296** shadow. This is a
mid teal, considerably darker and greener than the current `WATER` constant.

---

## 7. RIM FURNITURE

### The fence

A timber post-and-rail fence, **continuous**, three rails, panels about
**3 map-blocks long**. It is the settlement's perimeter, **not** the island's
rim, and its radius therefore varies with bearing:

| bearing            | fence r/R |
| ------------------ | --------- |
| 000 (N)            | 0.93      |
| 045 / 315 (NE, NW) | 0.845     |
| 090 (E)            | 0.70      |
| 270 (W)            | 0.815     |
| 135 / 225 (SE, SW) | 0.72      |
| 180 (S)            | 0.68      |

Interpolate smoothly between those. The effect is that the fence hugs the rim on
the north and leaves a wide belt of open meadow and trees outside it on the
south and east — which is what gives the island somewhere to walk that is
outside the town.

**It breaks in exactly two places**, and nowhere else:

1. **At the gate**, bearing 180 — a 5-block opening (§ below).
2. **Where the watercourse crosses it**, bearing about 100, r 0.70 R — the fence
   stops at each bank and a plank footbridge carries the E lane over.

There are **no hashed random gaps**. The reference fence is a built thing.

### The gate and its banner

- **Bearing 180, r 0.67 R** — set well inside the rim, on the Avenue.
- Two heavy timber posts, 1 block square, about 4 blocks tall, on a stone
  threshold **5 blocks wide x 2 deep**, with a crossbeam and a carved lintel over
  the opening.
- **The banner** hangs in the opening: **2 blocks wide x 3 tall**, deep blue
  (**#12427E**) with a **gold five-pointed star** device (**#E8C24A**) and a
  swallow-tailed lower edge.
- A lantern on each post.

### The causeway

From the gate, the Avenue continues south as a **timber-railed stone causeway**:

- **5 map-blocks wide**, from r 0.72 R out to **1.02 R** — i.e. its last two
  blocks are cantilevered past the turf, over the drop.
- Post-and-rail on both sides, heavier than the perimeter fence, with newel
  posts at the outboard corners and a lamp on each.
- It is the reference sheet's front-3/4 focal point; it is what tells you which
  side of the island is the front.

### The dock and crane

On the **east rim, bearing 108**, cantilevered out to **1.03 R**:

- A **timber platform 3.5 blocks (E–W) x 5 blocks (N–S)**, its inboard edge
  meeting the turf at about 0.97 R, its deck level with the turf, carried on four
  posts that hang under the rim.
- A **jib crane**: a mast at the platform's inboard end and a horizontal boom
  running out east over the drop, with a rope, a block and a hanging crate on the
  outboard end. The boom overhangs the platform by about 1.5 blocks.
- Bollards/cleats along the outboard edge.
- This is the subject of a third of angle 1 and is entirely absent from the
  current build.

---

## 8. VEGETATION

**Trees.** Counted off the map:

- **~34 large trees** in the belt between **0.72 R and 0.95 R**. Canopy **3
  map-blocks across** (0.115 R), trunk 1 block. Not evenly spaced.
- **~10 medium trees** (canopy 2 blocks) inside the settled band, between
  0.20 R and 0.65 R, in ones and twos in the gaps between buildings.
- **Clustering, by bearing:** heaviest from **280 through 330 to 010** — an
  almost continuous wood down the west and north-west flank, four to six deep in
  places. Second cluster on the **east, bearings 060–110**, between the
  watercourse and the rim. **Thinnest on the south**, bearings 150–210: the gate
  approach is deliberately open so the causeway and the banner read clean.
- No trees stand on the causeway, on the dock, in the streets, or on the terrace
  in front of the hall.

**Hedges.** Low dark-green rows (**#729606 / #668A06**), one block wide, along:

- both edges of every lane in the settled band (not the two main avenues, which
  have kerbs instead);
- the foot of every building's back and side walls;
- around the pond's north and west margin.

**Orchard.** The north-west, **bearings 300–335, r 0.60–0.80 R**, carries about
a dozen small round trees in loose rows, with visible **orange and red fruit
dots** on the canopies. It is the one planted-in-rows thing on the map and it is
what the eye reads as "farmed".

**Flowers and low planting.** One-block dots in white, yellow, red and purple
scattered over essentially all open turf, at roughly one dot per 4 blocks in the
meadow and one per 2 blocks in the verges beside streets and around the hall.
Purple and pink clumps are concentrated along the east, near the watercourse and
the pond.

**Tilled soil.** _There are no tilled plots on the map._ The brown hatched masses
that read as fields at thumbnail size are the plank ROOFS of B3, B4, B6 and B8
seen from above. If a plot is wanted anyway, put **one**, 4 x 6 blocks, at
bearing 300 / r 0.70 R, at the inboard edge of the orchard — and do not scatter
nine of them around the island.

---

## 9. THE PALETTE

Sampled from `map-top.png` by modal quantised colour over hand-picked regions.
Where a family has three values they are lit face / body / shadow face.

| material                                                 | lit       | body      | shadow                |
| -------------------------------------------------------- | --------- | --------- | --------------------- |
| Sky                                                      | `#3FA3F8` | —         | —                     |
| **Grass**                                                | `#96AE12` | `#8AAE0C` | `#4E7A06`             |
| Grass, deepest (under trees)                             | —         | `#365A06` | `#2A4E06`             |
| **Path / paving**                                        | `#DEC68A` | `#C6AE66` | `#8A661E` (worn kerb) |
| **Rim & cliff stone**                                    | `#6E6E62` | `#55554A` | `#3A3A34`             |
| **Dressed masonry** (hall, tower, stair, retaining wall) | `#7E724E` | `#66664E` | `#4E4E42`             |
| Plaster (walls)                                          | `#E4DABF` | `#C6BA9C` | —                     |
| **Timber** (fence, gate, dock, crane)                    | `#96721E` | `#4E421E` | `#362A12`             |
| **Water**                                                | `#1E8AA2` | `#1E7E96` | `#127296`             |
| Waterfall foam                                           | `#BCE6F0` | —         | —                     |
| **Blue roof (slate)**                                    | `#3666AE` | `#2A5A96` | `#1E427E`             |
| **Brown roof (plank)**                                   | `#8A661E` | `#7E5A1E` | `#4E3612`             |
| Hedge                                                    | `#7E9606` | `#729606` | `#5A7E06`             |
| Banner blue                                              | —         | `#12427E` | —                     |
| Banner star                                              | `#E8C24A` | —         | —                     |
| Tilled soil (derived, not on map)                        | `#6B4E2A` | —         | `#513716` furrow      |

Three of these are meaningfully different from what the code ships today and are
called out in the gap list: the **path is a warm tan, not a cool grey**; the
**rim stone is a dark cool grey, not limestone**; the **water is a mid teal, not
pale ice blue**.

---

# GAP LIST — spec versus `src/world/sky-island.ts` + `sky-parts.ts`

Ordered by how much each one costs the picture.

### 1. There is no Great Hall. _(the single biggest gap)_

The plan's subject is a **10 x 16 block** cruciform manor at bearing 000 /
0.59 R with a stone tower rising out of its crossing. The build has
`skyTower()` alone — a 4-block shaft — stamped **dead centre** at scale 1.25,
and no hall at all. The result (`shots/sky/4-topdown.png`) has no landmark of
the right mass, and the one landmark it has is in the wrong place: the middle of
the plan is open grass and a crossroads.

### 2. The buildings are generated, not authored.

`planSkyhaven` builds `CLUSTERS` = 9 knots of 3–6 cottages, from six templates,
at seed-derived bearings and radii inside `HOUSE_IN`..`HOUSE_OUT`. That is
roughly **25–30 near-identical cottages**. The plan has **eight named buildings**
at fixed bearings, fixed radii, fixed footprints (4x7 up to 10x16) and a fixed
roof material each. Six of the eight are bigger than any template in
`sky-parts.ts`, and three of them (B3, B4, B8) are barn/longhouse types that do
not exist at all.

### 3. The street network is a wheel, not a cross.

The code paints a 16-segment **ring road at r = `PLAZA` (19 units = 0.20 R)**
plus one radial spoke per cluster, all at seed-derived bearings, plus a paved
disc filling the ring. The plan has: a **3–4 block N–S Avenue on x = 0** from the
gate to the hall porch, a **2.5 block E–W Cross Street 0.07 R south of centre**,
six 2-block lanes to the six outer buildings — and **no ring road and no paved
plaza anywhere**.

### 4. There is no raised terrace and no stair.

`deckAt` is a constant and the file's header argues at length that it must be.
The plan raises the whole north-centre — 0.18 R east/west by 0.16 R north to
0.75 R north — by one map-block behind a dressed-stone retaining wall, with a
3-block stone stair on the meridian. §3 above gives the ramp arithmetic that
makes it walkable within `MAX_STEP_UP`; the header's conclusion ("the plateau is
one level") is the thing that has to change, and the ramp is how.

### 5. The outline is too small and far too lumpy.

`outlineAt` runs a mean of **0.855 x RC** with four harmonics summing to a
possible **±0.31** — a rounded square with bites, deliberately. The plan is a
**circle at 1.00 R with a total wobble under ±0.05 R** and one gentle flattening
across the south. The island as built is up to 15% smaller than the plan in
places, and its silhouette from above (angle 4) reads as an amoeba where the
reference reads as a disc.

### 6. Water: no pond, wrong bearing, wrong shape.

`onStream` paints a straight radial channel **1.9 cells half-width (3.8 units,
about 1 block)** on `fallAngle = gateAngle + 0.42π`, from the plaza to the rim,
and there is **no pond at all**. The plan has a 2-block stream **arcing** down
the east flank from a spring at bearing 050 / 0.85 R, opening into a
**0.27 x 0.35 R pond** at bearing 145 / 0.45 R, one block below the turf, with
the fall leaving at bearing 138. The fall itself is well built; it is in roughly
the right place by luck of the seed and should be pinned.

### 7. Palette drift on three materials.

`PATH` is `0xb9b2a2` — a **cool grey**; the map's paving is a warm tan
`#DEC68A`/`#C6AE66`, and the difference is most of why the streets currently
read as concrete. `STONE` is `0xada79b`, a pale limestone, against the map's
much darker, cooler `#55554A` — the cliff is the largest single area of the
silhouette and it is currently too light. `WATER` is `0x8fd8ec`, pale ice blue,
against a mid teal `#1E7E96`. Grass and the two roofs are close enough to keep.

### 8. The fence is a constant radius with random gaps.

`fenceR = ISLAND_R * 0.93` for all bearings, with `hash2(...) < 0.26` deleting a
quarter of the panels. The plan's fence is **continuous** and its radius **varies
0.68 R (south) to 0.93 R (north)** — it encloses the town, not the island — and
it breaks in exactly two places, the gate and the stream crossing.

### 9. No causeway; the gate is in the wrong place.

`skyGate` is stamped at `ISLAND_R * 0.9` on a seed-derived bearing, with nothing
attached to it. The plan puts it at **bearing 180 / 0.67 R** with a **5-block
timber-railed causeway** running from it out past the rim to 1.02 R. The
causeway is the front-3/4 view's focal point and the reason that view has a
foreground at all.

### 10. There is no dock and no crane.

Nothing in either file cantilevers off the rim. The plan has a **3.5 x 5 block
timber platform with a jib crane** at bearing 108, hanging out to 1.03 R. It is
a named subject of the reference sheet.

### 11. The tree belt is a necklace; there is no orchard and no hedging.

Trees are placed on `TREE_RING` = 0.74 R ± 0.06 R, with a "wood" of 8 clusters
on one seed-derived bearing. The plan wants a belt **0.72–0.95 R** that is four
to six deep from bearing 280 round to 010, a second cluster east at 060–110,
and **deliberately thin from 150 to 210** so the gate reads. It also wants
**hedge rows along every lane and building wall** and a **dozen fruit trees in
rows** at bearing 300–335 — none of which exists.

### 12. Invented content: tilled plots, the well, the market stalls.

Up to nine `plots` of tilled soil are scattered by `planSkyhaven`; the map has
none (the brown masses are plank roofs). `skyWell` and two `skyStall`s stand on
a plaza the plan does not have. All of it should go, or in the plots' case be
reduced to the single optional bed at bearing 300 / 0.70 R.

### 13. `at()` measures angles the wrong way round.

`at(a, d) = [sin(a)*d, cos(a)*d]` puts angle 0 at **+Z = south**, and runs
anticlockwise in compass terms. Every bearing in this spec is compass
(0 = north = −Z, clockwise). Whoever wires the authored layout in has to fix
this once, at the helper, or place the whole town mirrored and half-turned.

### 14. Cottage models are too small for the plan's footprints.

`skyCottage` is 6–8 cells of half-width at `SV` 0.6, stamped at s = 1.2 — about
**11 x 8 world units**, i.e. **3 x 2 map-blocks**. The plan's smallest building
is 4 x 7 blocks (14 x 25 units) and B1 is 10 x 16 (36 x 58 units). Either the
stamp scale goes up substantially or the models need rebuilding at the plan's
gauge; scaling alone will make the wall courses and windows coarse, so B1 at
least wants a model of its own.
