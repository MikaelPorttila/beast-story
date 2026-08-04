/**
 * SKYHAVEN'S ARCHITECTURE — the voxel parts bin for the flying town, and the
 * `TownParts` of world/town-parts.ts for a settlement that is nothing like a
 * camp.
 *
 * IT IS A SEPARATE BIN BECAUSE IT IS A DIFFERENT PLACE. The Encampment is
 * canvas, rough log and thatch: things you put up in a week and could take down
 * again. Skyhaven in the reference art is the opposite — plastered walls with
 * exposed timber framing, cut-stone footings, BLUE SLATE roofs, a stone tower
 * with a flag on it. Those are not the camp's parts recoloured; the courses
 * step differently, the roofs are shallower, the windows are lit. Reusing
 * `TownParts` would have meant either a camp in the sky or a parameter on every
 * builder in that file for a second architecture.
 *
 * THE VOXEL IS COARSER THAN THE TOWN'S, and that is the whole visual brief.
 * `V` in town-parts.ts is 0.28; this is 0.6, so a wall course is twice as tall
 * and a roof reads as individual slates rather than as a surface. The
 * reference's blocks are large relative to its buildings and that chunkiness is
 * most of what makes it look the way it does — at 0.28 the same models come out
 * smooth and generic. It is still small enough to carry a door, a window and a
 * chimney, which is the floor on how coarse this can go.
 *
 * COLOURS ARE READ OFF THE REFERENCE, not invented, and the roof blue is the
 * one that matters: it is the only saturated colour in the picture and it is
 * what makes the town read as one settlement from a mile away. Keep it.
 */
import { VoxelModel } from '../core/voxel';
import { bakeSolid } from './structures';
import type { Template } from './props';
import { mulberry32 } from './noise';

/** World units per voxel here. See the header — deliberately not the town's. */
export const SV = 0.6;

// ---------------------------------------------------------------------------
// Palette
// ---------------------------------------------------------------------------

/** Cut stone: footings, the tower, the well. */
const STONE = 0x93938f;
const STONE_D = 0x6f6f6c;
const STONE_L = 0xaeaea8;
/** Plaster between the timbers — warm off-white, the walls' main mass. */
const PLASTER = 0xe4dabf;
const PLASTER_D = 0xc6ba9c;
/** The frame. Dark enough to draw the building's lines at distance. */
const TIMBER = 0x7a5330;
const TIMBER_D = 0x593b21;
/** Fences, doors, shutters, the mill of the well. */
const WOOD = 0x9a7043;
const WOOD_D = 0x77552f;
/**
 * THE SLATE. The reference's one saturated colour, and the town's signature.
 * Three values so a roof has a lit face, a shaded face and a ridge line.
 */
const ROOF = 0x4a5e96;
const ROOF_D = 0x2f3f70;
const ROOF_L = 0x6a7fb4;
/**
 * THE SECOND ROOF, and the town does not read as a town without it. Every
 * dwelling in the first pass wore the same slate and the settlement came back
 * as eight copies of one asset in a ring; the reference is roughly half blue
 * slate and half warm brown wood shingle, and it is that alternation which
 * makes a cluster of roofs read as separate buildings from the air.
 *
 * The blue stays on the tower and on the houses facing the square, so the
 * signature colour still binds the place together.
 */
const SHINGLE = 0x8a6540;
const SHINGLE_D = 0x63472a;
const SHINGLE_L = 0xa88055;
/** Lit windows and lantern glass. Emissive — see `markEmissive` below. */
const LAMP = 0xffc561;
const IRON = 0x4b4b53;
const FLAG_C = 0x3f5bb5;
const FLAG_W = 0xe8e4d8;

/** Per-voxel value jitter, so a flat wall is not one flat colour. */
function shade(hex: number, k: number): number {
  const r = Math.min(255, Math.round(((hex >> 16) & 255) * k));
  const g = Math.min(255, Math.round(((hex >> 8) & 255) * k));
  const b = Math.min(255, Math.round((hex & 255) * k));
  return (r << 16) | (g << 8) | b;
}

// ---------------------------------------------------------------------------
// Buildings
// ---------------------------------------------------------------------------

/**
 * A cottage: stone footing, plastered timber-framed walls, blue slate gable.
 *
 * `kind` picks the silhouette — 0 is the plain one, 1 grows a chimney up a
 * gable, 2 is longer with a lean-to porch. Three is enough for a town of eight
 * once each is yawed to face the square: what a player reads at fifty units is
 * the roof line and the chimney, and beyond three variants of those the
 * settlement stops looking hand-placed and starts looking procedural.
 *
 * THE ROOF IS BRACKETED (`VoxelModel.region`) exactly as a hut's thatch is, so
 * its collider is a cylinder along the ridge rather than a slab at the height
 * of it, and everything at or above the eaves is out of the box measurement —
 * see `measureFootprint` and `measureRidge` in world/structures.ts.
 */
export function skyCottage(kind: 0 | 1 | 2, shingle = false): Template {
  const v = new VoxelModel();
  const r = mulberry32(0x5c07 + kind * 977 + (shingle ? 5501 : 0));
  // The roof's three values, picked once. See SHINGLE.
  const RF = shingle ? SHINGLE : ROOF;
  const RF_D = shingle ? SHINGLE_D : ROOF_D;
  const RF_L = shingle ? SHINGLE_L : ROOF_L;
  /** Half-width along x, half-depth along z, wall height in cells. */
  const W = kind === 2 ? 8 : 6;
  const D = 5;
  const H = 7;

  // -- stone footing, one course proud of the wall -------------------------
  for (let x = -W - 1; x <= W + 1; x++) {
    for (let z = -D - 1; z <= D + 1; z++) {
      if (Math.abs(x) <= W && Math.abs(z) <= D) continue;
      v.set(x, 0, z, shade(x + z & 1 ? STONE : STONE_D, 0.9 + r() * 0.25));
    }
  }
  // -- walls ---------------------------------------------------------------
  for (let x = -W; x <= W; x++) {
    for (let z = -D; z <= D; z++) {
      if (Math.abs(x) !== W && Math.abs(z) !== D) continue;
      for (let y = 1; y <= H; y++) {
        const corner = Math.abs(x) === W && Math.abs(z) === D;
        // The frame: corners, a sill course and a head course, plus an upright
        // every third cell. Everything else is plaster.
        const post = Math.abs(x) === W ? (z + D) % 3 === 0 : (x + W) % 3 === 0;
        const band = y === 1 || y === 4 || y === H;
        const c = corner || band || post ? (y > 4 ? TIMBER : TIMBER_D) : PLASTER;
        v.set(x, y, z, shade(c, 0.88 + r() * 0.24));
      }
    }
  }
  // -- doorway on +z, with a timber lintel ---------------------------------
  for (let x = -1; x <= 1; x++) for (let y = 1; y <= 4; y++) v.set(x, y, D, shade(WOOD_D, 0.8));
  for (let x = -2; x <= 2; x++) v.set(x, 5, D, shade(TIMBER, 1.05));
  // -- windows: lit, because a town seen from the air at dusk is its windows -
  const win = (x: number, z: number): void => {
    for (let dx = 0; dx <= 1; dx++) {
      for (let y = 3; y <= 4; y++) v.setEmissive(x + dx, y, z, LAMP, 1.1);
    }
  };
  win(-W + 2, D);
  win(W - 3, D);
  win(-W + 2, -D);
  if (kind === 2) win(1, -D);
  // Shutters either side, so the lit square reads as a window and not a hole.
  for (const wx of [-W + 1, W - 4]) {
    for (let y = 3; y <= 4; y++) {
      v.set(wx, y, D, shade(ROOF_D, 1.0));
      v.set(wx + 3, y, D, shade(ROOF_D, 1.0));
    }
  }

  // -- the slate roof ------------------------------------------------------
  // Courses stepping in from an overhanging eave to the ridge, laid along x.
  // Two cells of overhang at the eave, which is what gives the reference's
  // buildings their heavy top-lit look from above.
  const roof = v.region(() => {
    const rise = D + 2;
    for (let k = 0; k <= rise; k++) {
      const y = H + 1 + k;
      const zEdge = D + 2 - k;
      if (zEdge < 0) break;
      // Alternating courses, and the lit value on the +x-facing run so the
      // gable has a bright side even when the sun is behind it.
      const c = k % 2 === 0 ? RF : RF_D;
      for (let x = -W - 2; x <= W + 2; x++) {
        const j = 0.9 + r() * 0.22;
        v.set(x, y, zEdge, shade(c, j));
        v.set(x, y, -zEdge, shade(k % 2 === 0 ? RF_D : RF, j));
        // Fill the gable ends solid so the roof is not a hollow shell seen
        // from the side.
        if (Math.abs(x) === W + 2) {
          for (let z = -zEdge; z <= zEdge; z++) v.set(x, y, z, shade(RF_D, j * 0.94));
        }
      }
    }
    // Ridge cap, one value up, running the full length.
    for (let x = -W - 2; x <= W + 2; x++) v.set(x, H + 2 + rise, 0, shade(RF_L, 1.06));
  });

  if (kind === 1) {
    // Stone chimney up the -x gable, with a smoke-blackened lip.
    for (let y = 1; y <= H + D + 6; y++) {
      v.box(-W - 2, y, -1, -W - 1, y, 1, shade(y > H ? STONE : STONE_D, 0.88 + r() * 0.26));
    }
    v.box(-W - 3, H + D + 7, -2, -W, H + D + 7, 2, shade(STONE_L, 1.04));
  }
  if (kind === 2) {
    // A lean-to porch over the door: two posts and a slate skirt.
    for (let y = 1; y <= 5; y++) {
      v.set(-3, y, D + 2, shade(TIMBER, 0.95));
      v.set(3, y, D + 2, shade(TIMBER, 0.95));
    }
    for (let x = -4; x <= 4; x++) {
      v.set(x, 6, D + 2, shade(RF, 1.0));
      v.set(x, 7, D + 1, shade(RF_D, 1.0));
    }
  }
  return bakeSolid(v, SV, roof);
}

/**
 * THE TOWER, and the town's landmark: a square stone shaft with a plastered
 * upper storey, a stepped blue spire and a flag.
 *
 * It is the one thing on the island visible from the ground, so its silhouette
 * does the work — a shaft tall enough to break the tree line, a corbelled band
 * where the storey changes, and a spire that steps rather than cones (a smooth
 * cone in a voxel world reads as a modelling mistake).
 *
 * NOT BRACKETED AS A ROOF. `measureRidge` fits an arc along a CREST and a
 * stepped pyramid's crest is a single cell — the same argument the skill den's
 * pagoda makes in world/shops.ts. The walls are what stop you, and the walls
 * are a box.
 */
export function skyTower(): Template {
  const v = new VoxelModel();
  const r = mulberry32(0x7011);
  const W = 4;
  /**
   * THE SHAFT, and it is tall on purpose. At 16 courses the tower measured 9.6
   * units and was shorter than the oaks around it — captured from above
   * (`shots/sky/4-topdown.png`, first pass) the island's landmark read as one
   * more cottage with a pointed roof. 26 puts the belfry over the tree line and
   * the pennant at 24 units, which is the only part of the island visible from
   * the ground before the rest of it comes over the horizon.
   */
  const SHAFT = 26;
  const UPPER = 8;

  // A PLINTH. The reference stands its tower on a raised terrace; the plateau
  // here is deliberately flat (see the header of world/sky-island.ts), so the
  // lift the tower needs is built into the tower. One course, oversailing by
  // two — enough to read as a footing and low enough to walk onto, which is
  // what stops it being a wall round the town's one landmark.
  for (let x = -W - 2; x <= W + 2; x++) {
    for (let z = -W - 2; z <= W + 2; z++) {
      v.set(x, 0, z, shade((x + z) % 2 === 0 ? STONE : STONE_D, 0.9 + r() * 0.2));
    }
  }
  for (let y = 1; y <= SHAFT + UPPER; y++) {
    const upper = y > SHAFT;
    // The upper storey oversails by a cell — a corbel, which is what stops the
    // tower reading as an extruded square.
    const w = upper ? W + 1 : W;
    for (let x = -w; x <= w; x++) {
      for (let z = -w; z <= w; z++) {
        if (Math.abs(x) !== w && Math.abs(z) !== w) continue;
        const quoin = Math.abs(x) === w && Math.abs(z) === w;
        let c: number;
        if (upper) c = quoin || y === SHAFT + 1 ? TIMBER : PLASTER;
        // A COURSED WALL, not a chequerboard. `(x + z + y) % 2` alternates
        // every cell in all three axes, which at this gauge is a draughts board
        // painted on a tower; real coursing alternates by COURSE, with the
        // joints broken every other one.
        else c = quoin ? STONE_L : (y + Math.floor((x + z) / 3)) % 2 === 0 ? STONE : STONE_D;
        v.set(x, y, z, shade(c, 0.88 + r() * 0.24));
      }
    }
  }
  // Door, and a lit slit window every few courses up the shaft.
  for (let x = -1; x <= 1; x++) for (let y = 1; y <= 4; y++) v.set(x, y, W, shade(WOOD_D, 0.8));
  for (let y = 6; y < SHAFT; y += 5) {
    v.setEmissive(0, y, W, LAMP, 1.1);
    v.setEmissive(0, y + 1, W, LAMP, 1.1);
    v.setEmissive(W, y + 2, 0, LAMP, 1.1);
  }
  // The belfry openings, on all four faces of the upper storey.
  for (let y = SHAFT + 3; y <= SHAFT + 5; y++) {
    for (const d of [-1, 0, 1]) {
      v.setEmissive(d, y, W + 1, LAMP, 1.3);
      v.setEmissive(d, y, -(W + 1), LAMP, 1.3);
      v.setEmissive(W + 1, y, d, LAMP, 1.3);
      v.setEmissive(-(W + 1), y, d, LAMP, 1.3);
    }
  }
  // Spire: stepped, each course a cell narrower, with the eaves oversailing.
  const base = SHAFT + UPPER + 1;
  for (let k = 0; k <= W + 2; k++) {
    const w = W + 2 - k;
    const y = base + k;
    for (let x = -w; x <= w; x++) {
      for (let z = -w; z <= w; z++) {
        if (k > 0 && Math.abs(x) !== w && Math.abs(z) !== w) continue;
        v.set(x, y, z, shade(k % 2 === 0 ? ROOF : ROOF_D, 0.9 + r() * 0.2));
      }
    }
  }
  // Flagpole and pennant — the one thing in the reference that says which way
  // the wind is going, and the top of the whole island's silhouette.
  const top = base + W + 3;
  for (let y = top; y <= top + 5; y++) v.set(0, y, 0, shade(IRON, 1.0));
  for (let x = 1; x <= 4; x++) {
    for (let y = top + 3; y <= top + 4; y++) {
      v.set(x, y, 0, shade(x % 2 === 0 ? FLAG_C : FLAG_W, 1.0));
    }
  }
  return bakeSolid(v, SV);
}

/**
 * A fence panel: two posts and two rails, six cells long.
 *
 * IT MARKS THE RIM, IT DOES NOT CLOSE IT. The reference rings the plateau with
 * one, and the island's whole character is that it has an edge you can walk off
 * — so these are stamped with GAPS (see the layout in world/sky-island.ts). Its
 * footprint measures to nothing above `MAX_STEP_UP` at the rails, which is the
 * right answer for a thing you are meant to be able to vault.
 */
export function skyFence(): Template {
  const v = new VoxelModel();
  const r = mulberry32(0x0fe4);
  for (let y = 0; y <= 3; y++) {
    v.set(-3, y, 0, shade(WOOD_D, 0.9 + r() * 0.2));
    v.set(3, y, 0, shade(WOOD_D, 0.9 + r() * 0.2));
  }
  for (let x = -3; x <= 3; x++) {
    v.set(x, 1, 0, shade(WOOD, 0.9 + r() * 0.2));
    v.set(x, 3, 0, shade(WOOD, 0.9 + r() * 0.2));
  }
  return bakeSolid(v, SV);
}

/** A lamp post: timber shaft, iron bracket, lit lantern. */
export function skyLamp(): Template {
  const v = new VoxelModel();
  for (let y = 0; y <= 8; y++) v.set(0, y, 0, shade(y < 2 ? STONE_D : WOOD_D, 1.0));
  v.set(0, 9, 0, shade(IRON, 1.0));
  v.box(-1, 7, -1, 1, 8, 1, shade(IRON, 0.9));
  v.setEmissive(0, 8, 0, LAMP, 2.2);
  return bakeSolid(v, SV);
}

/** A stone well with a timber winch and a little slate roof over it. */
export function skyWell(): Template {
  const v = new VoxelModel();
  const r = mulberry32(0x3e11);
  for (let x = -2; x <= 2; x++) {
    for (let z = -2; z <= 2; z++) {
      if (Math.abs(x) < 2 && Math.abs(z) < 2) continue;
      for (let y = 0; y <= 2; y++) v.set(x, y, z, shade((x + z + y) % 2 ? STONE : STONE_D, 0.9 + r() * 0.2));
    }
  }
  for (let y = 3; y <= 7; y++) { v.set(-2, y, 0, shade(WOOD_D, 1.0)); v.set(2, y, 0, shade(WOOD_D, 1.0)); }
  for (let x = -2; x <= 2; x++) v.set(x, 7, 0, shade(WOOD, 1.05));
  for (let x = -3; x <= 3; x++) {
    for (let z = -1; z <= 1; z++) v.set(x, 8 + (z === 0 ? 1 : 0), z, shade(z === 0 ? ROOF_L : ROOF, 1.0));
  }
  return bakeSolid(v, SV);
}

/**
 * A market stall: four posts, a striped awning and a loaded counter. The
 * reference's square has two of these, and they are what stop the middle of the
 * town being an empty lawn between houses.
 */
export function skyStall(): Template {
  const v = new VoxelModel();
  for (const [px, pz] of [[-3, -2], [3, -2], [-3, 2], [3, 2]] as const) {
    for (let y = 0; y <= 5; y++) v.set(px, y, pz, shade(WOOD_D, 1.0));
  }
  for (let x = -4; x <= 4; x++) {
    for (let z = -3; z <= 3; z++) {
      v.set(x, 6, z, shade(Math.floor((x + 8) / 2) % 2 === 0 ? ROOF : PLASTER, 1.0));
    }
  }
  for (let x = -3; x <= 3; x++) {
    for (let z = -2; z <= 2; z++) v.set(x, 2, z, shade(WOOD, 1.0));
  }
  v.box(-2, 3, -1, -1, 3, 0, shade(0xc4622f, 1.0));
  v.box(1, 3, 0, 2, 3, 1, shade(0x6fae4a, 1.0));
  return bakeSolid(v, SV);
}

/**
 * THE GATE, and the front 3/4 view's focal point.
 *
 * Two heavy timber posts, a crossbeam and a hanging heraldic banner over a
 * stone-stepped threshold. It has no wall attached to it and it is not meant to
 * — the island's edge is the wall, and this is the place the reference tells
 * you is the way in. It is the one piece of the settlement that exists purely
 * to break the rim's silhouette, which is why it stands ON the rim rather than
 * in the town.
 */
export function skyGate(): Template {
  const v = new VoxelModel();
  const r = mulberry32(0x9a7e);
  // Stone threshold, two courses, wider than the posts.
  for (let x = -5; x <= 5; x++) {
    for (let z = -3; z <= 3; z++) {
      v.set(x, 0, z, shade((x + z) % 2 === 0 ? STONE : STONE_D, 0.9 + r() * 0.2));
    }
  }
  // Posts, with a batter at the foot so they read as planted.
  for (const px of [-4, 4] as const) {
    for (let y = 1; y <= 12; y++) {
      const w = y <= 2 ? 1 : 0;
      for (let dx = -w; dx <= w; dx++) {
        for (let dz = -1; dz <= 1; dz++) {
          v.set(px + dx, y, dz, shade(y % 4 === 0 ? TIMBER_D : TIMBER, 0.9 + r() * 0.2));
        }
      }
    }
  }
  // Crossbeam and a carved lintel over it.
  for (let x = -5; x <= 5; x++) {
    for (let z = -1; z <= 1; z++) {
      v.set(x, 13, z, shade(TIMBER, 1.0));
      v.set(x, 14, z, shade(TIMBER_D, 0.95));
    }
  }
  // THE BANNER: the town's blue, with a device on it, hanging in the opening.
  for (let x = -2; x <= 2; x++) {
    for (let y = 7; y <= 12; y++) {
      const edge = x === -2 || x === 2 || y === 12;
      v.set(x, y, 0, shade(edge ? ROOF_D : ROOF, 0.95 + r() * 0.15));
    }
  }
  v.set(0, 10, 1, shade(FLAG_W, 1.05));
  v.set(-1, 9, 1, shade(FLAG_W, 1.05));
  v.set(1, 9, 1, shade(FLAG_W, 1.05));
  // A lantern on each post, so the gate reads at dusk and from below.
  for (const px of [-4, 4] as const) v.setEmissive(px, 12, 2, LAMP, 2.0);
  return bakeSolid(v, SV);
}

/**
 * A hedge / shrub clump for the foot of a wall.
 *
 * THE SMALLEST THING HERE AND ONE OF THE MOST IMPORTANT. Every building in the
 * reference meets the ground in planting — shrubs, flowers, a vine at the wall
 * foot — and ours met bare turf, which is the single clearest tell that a
 * settlement was placed by a loop rather than built. Two sizes of the same
 * lump, so a row of them along a wall is not a row of identical bushes.
 */
export function skyBush(big: boolean): Template {
  const v = new VoxelModel();
  const r = mulberry32(big ? 0x21b1 : 0x21b2);
  const R = big ? 2.6 : 1.7;
  v.ellipsoid(0, R * 0.8, 0, R, R * 0.8, R, 0x4f7a34);
  // A lit crown and a shaded belly, painted rather than lit, exactly as the
  // canopy builders in world/props.ts do it.
  v.ellipsoid(0, R * 1.1, 0, R * 0.8, R * 0.5, R * 0.8, 0x69973f);
  if (big && r() > 0.4) {
    v.set(1, Math.round(R * 1.4), 0, 0xd8d264);
    v.set(-1, Math.round(R * 1.2), 1, 0xd07a86);
  }
  return bakeSolid(v, SV);
}

/**
 * A chimney's smoke: four or five pale cubes drifting off the stack.
 *
 * STATIC GEOMETRY, NOT A PARTICLE SYSTEM, and that is the right trade here. The
 * reference has smoke over half its roofs and it is doing one job — telling you
 * the houses are lived in. A stack of translucent quads would need a second
 * material, a sort order and an update; five cubes cost nothing, live in the
 * same merged mesh as the town, and read exactly the same at the distance
 * anybody sees this island from.
 */
export function skySmoke(): Template {
  const v = new VoxelModel();
  const r = mulberry32(0x53a1);
  let x = 0;
  let z = 0;
  for (let k = 0; k < 6; k++) {
    const y = k * 2;
    const w = k < 2 ? 0 : 1;
    for (let dx = -w; dx <= w; dx++) {
      for (let dz = -w; dz <= w; dz++) {
        if (w > 0 && Math.abs(dx) + Math.abs(dz) > 1) continue;
        v.set(x + dx, y, z + dz, shade(0xd8d8d4, 0.9 + r() * 0.2));
      }
    }
    x += r() > 0.4 ? 1 : 0;
    z += r() > 0.7 ? 1 : 0;
  }
  return bakeSolid(v, SV);
}
