/**
 * NPCs — the people standing in the world, and the generic half of one.
 *
 * THE SPLIT IS THE PAL SPLIT. `PalActor` (pals/framework.ts) owns steering,
 * state and the frame tick while a species file owns a body and one
 * `animate(rig, ctx)`; this file owns placement, culling, the interact test, the
 * talk state and the per-frame tick, while a character file (npc-gain.ts) owns
 * a body and one `animate(rig, ctx)`. Adding a second NPC is a second character
 * file and one line in `CHARACTERS` below — no new placement code, no new
 * collider code, no new interaction code.
 *
 * PLACEMENT GOES THROUGH THE TOWN REGISTRY. A character says which town it
 * lives in and how near the middle it wants to stand; where exactly is decided
 * here, by walking rings outward from the centre until a spot is found that is
 * clear of the CARRIAGEWAY and of everything the settlement already built.
 * Nothing in this file knows where the Encampment's fire or its huts are — it
 * asks `RoadClearance` and the settlement's own collision field, which is the
 * same rule the town layout follows (see `place` in towns.ts) and the reason a
 * quest giver cannot end up standing in a hut or in the middle of the cart road.
 *
 * AND HE IS SOLID, by the same primitive as everything else in a settlement.
 * The footprint is MEASURED off the voxel model the character builder painted
 * (`measureFootprint`, world/structures.ts) and stamped into a `StructureField`,
 * so it reaches the hero as `World.structureTopAt` and resolves against the same
 * `MAX_STEP_UP` a crate does. There is no second kind of collision here, and no
 * number stating his size that is not his body.
 */
import * as THREE from 'three';
import type { NpcField, NpcInfo, NpcTalk, TownRegistry } from '../core/types';
import type { StringKey } from '../i18n';
import { StructureField } from './structures';
import type { SolidBox } from './props';
import { DECK_EDGE, type RoadClearance } from './roads';
import { flags } from '../core/flags';
import { GAIN } from './npc-gain';

// ---------------------------------------------------------------------------
// The contract a character file implements
// ---------------------------------------------------------------------------

/**
 * A built body: a root to hang in the scene, the joints its `animate` poses,
 * and the footprint it blocks.
 *
 * `parts` rather than named fields, exactly like `PalRig`: the framework never
 * touches a joint, so naming them here would be a list this file has to grow
 * every time a character has a different body plan.
 */
export interface NpcRig {
  root: THREE.Group;
  parts: Record<string, THREE.Object3D>;
  /** Approximate standing height; the root's origin is at the feet. */
  height: number;
  /** Approximate body radius, used to keep him off other people's furniture. */
  radius: number;
  /**
   * What he BLOCKS, in the root's own frame — `measureFootprint` of whichever
   * model carries his standing mass. Empty for a character that is scenery.
   *
   * MEASURED, not authored: Gain's comes out as one box, 0.60 x 0.40 in
   * half-extents with its top 1.80 above his feet, which is his robe and
   * shoulders and neither the head that nods nor the weight that swings.
   * Driving the hero into him from four bearings, the closest his centre gets
   * to Gain's is 0.71-0.86 — half-extent plus the hero's 0.32 body radius —
   * against 0.02-0.17 with `solids=0`, i.e. straight through the middle of him.
   *
   * The box is stamped at the pose he was PLACED in and does not follow the
   * quarter-turn he makes to face a visitor. That is the one place his mesh and
   * his collider disagree, and at 0.60 by 0.40 the worst the corner sweeps is
   * about 0.2 — less than the hero's own radius, so it can never open a gap you
   * could walk through.
   */
  solid: readonly SolidBox[];
  /**
   * Per-instance scratch for the character's own smoothing, keyed by whatever
   * names it likes.
   *
   * Here for the same reason `PalAnimCtx.cycle` keeps its phases per pal: an
   * `animate` that has to smooth anything needs somewhere to keep the previous
   * value, and a module-level variable would make two of the same character
   * share one. Written in place every frame, so it allocates nothing.
   */
  state: Record<string, number>;
  /** Everything with GPU memory behind it. See `Npcs.dispose`. */
  disposables: Array<{ dispose(): void }>;
}

export interface NpcAnimCtx {
  /** Free-running seconds. Safe to multiply out: nothing here changes rate. */
  time: number;
  dt: number;
  /**
   * True while the hero is close enough to be talked to. A character may use it
   * for a glance or a pause; the TURN toward the visitor is the framework's, so
   * that every NPC acknowledges one the same way.
   */
  attended: boolean;
}

export interface NpcCharacter {
  /** The stable IDENTIFIER — what a quest stores and what `talk(id)` takes. */
  id: string;
  /** DISPLAY name, as a string-table key. */
  nameKey: StringKey;
  /** Which settlement he stands in, by registry id. */
  townId: string;
  /**
   * How far from that town's centre he would LIKE to stand, in world units.
   * 0 means the middle; the search below only ever pushes him further out, and
   * only as far as it has to to get him off the road and out of the furniture.
   */
  homeOffset: number;
  build(): NpcRig;
  animate(rig: NpcRig, ctx: NpcAnimCtx): void;
  /**
   * What he says right now. THE QUEST SEAM: this returns a PAYLOAD (NpcTalk in
   * core/types.ts), so the day quests land, this function starts choosing
   * between an offer, a turn-in and this idle line, and nothing else in the NPC
   * system, the HUD or the frame loop changes shape.
   */
  talk(): NpcTalk;
}

/** Every NPC in the game. The module list is the roster, like pals/registry.ts. */
const CHARACTERS: readonly NpcCharacter[] = [GAIN];

// ---------------------------------------------------------------------------
// Tuning
// ---------------------------------------------------------------------------

/**
 * How close the hero has to be for the talk prompt, in world units.
 *
 * 2.8, against the skill den's 3.5. A den is a building you stand in front of;
 * a person is someone you walk up to, and the prompt should appear at
 * conversation distance rather than across the yard. Measured by walking into
 * Gain on the keyboard: the hero comes to rest 2.49 units out with the prompt
 * up and his face filling a readable part of the frame, and his own collider
 * stops anyone closer than ~0.8 (see the note on `solid` in NpcRig).
 */
export const NPC_TALK_RANGE = 2.8;
/**
 * Where a conversation ends because you walked off. Deliberately wider than it
 * begins — a dialogue that blinked out the instant you shifted your weight at
 * the hysteresis edge would be worse than one that lingers a step too long.
 */
const NPC_LEAVE_RANGE = NPC_TALK_RANGE * 1.5;
/**
 * Past this the body is not drawn or animated at all, in world units. The same
 * argument `Towns.update` makes about its 420: an NPC is resident for the life
 * of the session, and a rig with eight joints submitted to the shadow pass from
 * the far side of the map is a cost with nothing on screen to show for it. 140
 * is well past the distance he stops being more than two pixels of robe.
 */
const NPC_CULL = 140;
const NPC_CULL2 = NPC_CULL * NPC_CULL;
/**
 * How fast he turns to face a visitor, as the lambda of `1 - exp(-lambda*dt)`.
 *
 * 4.5 covers a quarter turn in a little under half a second — an old man
 * noticing you, not a turret acquiring you.
 */
const TURN_LAMBDA = 4.5;
/**
 * How far his timber has to stay from a carriageway centreline, world units.
 *
 * `DECK_EDGE` (5.0) is the outer rim of the surface that is both drawn and
 * walked, and the +1.2 is his own body radius plus enough that he is visibly
 * standing OFF the gravel rather than on the verge of it. The same shape of
 * number as `FENCE_ROAD_CLEAR` in towns.ts, and it matters more here: the
 * Encampment's cart road ENDS at the middle of the camp, so "the middle" is a
 * road, and this is the whole reason the search has to walk outward at all.
 */
const NPC_ROAD_CLEAR = DECK_EDGE + 1.2;
/** Rings the placement search tries, in world units out from the town centre. */
const SPOT_RINGS = [0, 2.5, 4.5, 6.5, 8.5, 10.5, 12.5];
/** Bearings per ring. 16 puts a candidate every 22.5 degrees. */
const SPOT_BEARINGS = 16;

// ---------------------------------------------------------------------------

interface Placed {
  char: NpcCharacter;
  rig: NpcRig;
  info: NpcInfo;
  /** The bearing he faces when nobody is with him. */
  restYaw: number;
  yaw: number;
}

/** What the NPC system needs to know about the world it is being placed in. */
export interface NpcSite {
  towns: TownRegistry;
  roads: RoadClearance;
  getHeight(x: number, z: number): number;
  /**
   * What the SETTLEMENT already blocks. Read-only here, and read only at
   * placement time: it is how a candidate spot discovers there is a hut, a
   * brazier or a palisade on it without this file knowing what those are.
   */
  structureTopAt(x: number, z: number): number;
}

/**
 * Every NPC in one zone: their bodies, their colliders and the conversation in
 * progress.
 *
 * Built once at world creation next to the towns and never streamed, for the
 * same reason they are not — there are a handful of them and they stand in
 * fixed places.
 */
export class Npcs implements NpcField {
  readonly group = new THREE.Group();
  /** His footprint, in the same primitive the settlement uses. */
  readonly solids = new StructureField();
  readonly all: readonly NpcInfo[];

  private readonly placed: Placed[] = [];
  private talkState: NpcTalk | null = null;
  /** Reused every frame; see the no-per-frame-allocation rule. */
  private readonly ctx: NpcAnimCtx = { time: 0, dt: 0, attended: false };

  constructor(site: NpcSite) {
    const infos: NpcInfo[] = [];
    for (const char of CHARACTERS) {
      const town = site.towns.get(char.townId);
      if (!town) continue; // a zone without his town simply has no him
      const rig = char.build();
      const spot = findSpot(site, town.x, town.z, char.homeOffset, rig.radius);
      const y = site.getHeight(spot.x, spot.z);
      // Facing the GATE, so the first thing a visitor walking in off the road
      // sees is his face rather than the back of his mantle.
      const restYaw = Math.atan2(town.gateX - spot.x, town.gateZ - spot.z);
      rig.root.position.set(spot.x, y, spot.z);
      rig.root.rotation.y = restYaw;
      this.group.add(rig.root);
      const info: NpcInfo = { id: char.id, nameKey: char.nameKey, x: spot.x, y, z: spot.z };
      infos.push(info);
      this.placed.push({ char, rig, info, restYaw, yaw: restYaw });
      // The same call shape `SolidStamp.add` uses, and the same field type —
      // his box is stamped at the pose he was placed in.
      this.solids.add(rig, spot.x, y, spot.z, restYaw, 1, 1);
    }
    this.solids.build();
    this.all = infos;
  }

  // -- NpcField -------------------------------------------------------------

  nearest(x: number, z: number, range: number): NpcInfo | null {
    let best: NpcInfo | null = null;
    let bd2 = range * range;
    for (const p of this.placed) {
      const dx = p.info.x - x;
      const dz = p.info.z - z;
      const d2 = dx * dx + dz * dz;
      if (d2 < bd2) { bd2 = d2; best = p.info; }
    }
    return best;
  }

  get talking(): NpcTalk | null {
    return this.talkState;
  }

  talk(id: string): NpcTalk | null {
    const p = this.placed.find((q) => q.char.id === id);
    if (!p) return null;
    this.talkState = p.char.talk();
    return this.talkState;
  }

  endTalk(): void {
    this.talkState = null;
  }

  // -- frame ----------------------------------------------------------------

  /**
   * Pose everyone, and end a conversation the player walked out of.
   *
   * Allocates nothing: the animation context is a field, the yaw is a number,
   * and the distance test is the same two subtractions `nearest` does.
   */
  update(dt: number, time: number, focus: THREE.Vector3): void {
    // A staged capture may PIN the clock so a still of someone mid-movement is
    // reproducible; see flags.npcTime. Absent — i.e. always, in play — this is
    // the world's own clock.
    this.ctx.time = flags.npcTime ?? time;
    this.ctx.dt = dt;
    for (const p of this.placed) {
      const dx = p.info.x - focus.x;
      const dz = p.info.z - focus.z;
      const d2 = dx * dx + dz * dz;
      const visible = d2 < NPC_CULL2;
      p.rig.root.visible = visible;
      if (this.talkState?.id === p.char.id && d2 > NPC_LEAVE_RANGE * NPC_LEAVE_RANGE) {
        this.talkState = null;
      }
      if (!visible) continue;
      const attended = d2 < NPC_LEAVE_RANGE * NPC_LEAVE_RANGE;
      // Frame-rate independent, per the convention: an exponential approach to
      // the wanted bearing, never a fixed lerp factor.
      const want = attended ? Math.atan2(focus.x - p.info.x, focus.z - p.info.z) : p.restYaw;
      p.yaw = approachAngle(p.yaw, want, TURN_LAMBDA, dt);
      p.rig.root.rotation.y = p.yaw;
      this.ctx.attended = attended;
      p.char.animate(p.rig, this.ctx);
    }
  }

  setVisible(v: boolean): void {
    this.group.visible = v;
  }

  dispose(): void {
    for (const p of this.placed) {
      for (const d of p.rig.disposables) d.dispose();
      this.group.remove(p.rig.root);
    }
    this.placed.length = 0;
    this.talkState = null;
  }
}

// ---------------------------------------------------------------------------

/** Shortest-arc exponential approach; the same helper the player camera uses. */
function approachAngle(cur: number, target: number, rate: number, dt: number): number {
  let d = target - cur;
  while (d > Math.PI) d -= Math.PI * 2;
  while (d < -Math.PI) d += Math.PI * 2;
  return cur + d * (1 - Math.exp(-rate * dt));
}

/**
 * Somewhere in this town he can actually stand: off the carriageway, out of the
 * furniture, and as near the middle as those two allow.
 *
 * Rings outward from the centre, and the FIRST RING with anything free on it
 * wins, so "as central as possible" is a property of the search order rather
 * than of a score to tune. Within that ring the tie is broken toward the most
 * OPEN spot — measured by counting how many probes on two rings around each
 * candidate land on something the settlement built.
 *
 * Both halves earn their keep, and the second one is a fix rather than a
 * flourish: first-free-wins backed Gain into the wall of a tent (_gain-a.png,
 * first pass), which is a legal place to stand and a terrible place to be
 * talked to — the camera ends up inside the canvas behind him. The openness
 * count moves him to the clear side of the SAME ring, so he is no further from
 * the middle of camp than he was: 6.5 units either way, on seed 1337.
 *
 * The furniture test samples his own footprint's corners rather than his
 * centre, because a body half inside a barrel is still inside a barrel.
 *
 * Runs once per NPC at world creation, so it may allocate and may be generous
 * with probes.
 */
function findSpot(
  site: NpcSite, cx: number, cz: number, offset: number, radius: number,
): { x: number; z: number } {
  const clearOf = radius + 0.35;
  const free = (x: number, z: number): boolean => {
    if (site.roads.distanceTo(x, z) < NPC_ROAD_CLEAR) return false;
    if (site.structureTopAt(x, z) > -Infinity) return false;
    for (let k = 0; k < 4; k++) {
      const a = (k / 4) * Math.PI * 2;
      const px = x + Math.sin(a) * clearOf;
      const pz = z + Math.cos(a) * clearOf;
      if (site.structureTopAt(px, pz) > -Infinity) return false;
    }
    return true;
  };
  /** How much furniture is within arm's reach and a step beyond it. */
  const crowding = (x: number, z: number): number => {
    let n = 0;
    for (const rr of [1.7, 2.7, 3.7]) {
      for (let k = 0; k < 12; k++) {
        const a = (k / 12) * Math.PI * 2;
        if (site.structureTopAt(x + Math.sin(a) * rr, z + Math.cos(a) * rr) > -Infinity) n++;
      }
    }
    return n;
  };
  for (const ring of SPOT_RINGS) {
    const d = ring + offset;
    if (d === 0) {
      if (free(cx, cz)) return { x: cx, z: cz };
      continue;
    }
    let best: { x: number; z: number } | null = null;
    let bestCrowd = Infinity;
    for (let k = 0; k < SPOT_BEARINGS; k++) {
      const a = (k / SPOT_BEARINGS) * Math.PI * 2;
      const x = cx + Math.sin(a) * d;
      const z = cz + Math.cos(a) * d;
      if (!free(x, z)) continue;
      const crowd = crowding(x, z);
      if (crowd < bestCrowd) { bestCrowd = crowd; best = { x, z }; }
    }
    if (best) return best;
  }
  // Nothing was clear anywhere in range — stand him at the offset he asked for,
  // rather than dropping the character entirely. A settlement this crowded is a
  // layout bug, and an NPC standing in a crate is how it gets noticed.
  return { x: cx, z: cz + Math.max(offset, 1) };
}
