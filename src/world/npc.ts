/**
 * NPCs — the people standing in the world, and the generic half of one.
 *
 * THE SPLIT IS THE BEAST SPLIT. `BeastActor` (beasts/framework.ts) owns steering,
 * state and the frame tick while a species file owns a body and one
 * `animate(rig, ctx)`; this file owns placement, culling, the interact test, the
 * talk state and the per-frame tick, while a character file (npc-gain.ts) owns
 * a body and one `animate(rig, ctx)`. Adding a second NPC is a second character
 * file, one line in `NPC_BODIES` below, and an `npc:` asset — no new placement
 * code, no new collider code, no new interaction code.
 *
 * AND SINCE ISSUE #60 THAT SPLIT HAS A SECOND CUT ACROSS IT: `build()` and
 * `animate()` are BEHAVIOUR and stay in TypeScript, while who he is, which town
 * he stands in, how far out he wants to be and what he says are CONTENT and live
 * in `src/content/data/core.json`. Data selects a body by name off the
 * `npc-body` factory kind (`"body": "gain"`) and never supplies one.
 *
 * WHICH IS WHY THE BODIES ARE A PLAIN MODULE CONSTANT. `tools/test-zfight.mjs`
 * imports this file STRAIGHT INTO BUN to build every rig in the game and look
 * for coincident surfaces, and there is no content runtime in that process and
 * nothing to boot one with. `NPC_BODIES` is what it walks: a record of builders
 * and animators, with no placement, no identity and no dependency on anything
 * being loaded. WHAT HE SAYS is a question that needs content; WHAT HE LOOKS
 * LIKE is not, and the tool only ever asked the second.
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
import * as THREE from "three";
import {
  inRise,
  type NpcField,
  type NpcInfo,
  type NpcTalk,
  type TownRegistry,
} from "../core/types";
import type { StringKey } from "../i18n";
import { StructureField } from "./structures";
import type { SolidBox } from "./props";
import { type RoadClearance } from "./roads";
import { flags } from "../core/flags";
import { GAIN_BODY } from "./npc-gain";
import {
  COIL_BODY,
  MERA_BODY,
  SKY_GARDENER_BODY,
  SKY_LAMPLIGHTER_BODY,
  SKY_PILOT_BODY,
} from "./npc-villagers";
import { content, defineFactory, NPC_BODY_KIND, type NpcData, type NpcTalkLine } from "../content";
import type { ContentText } from "../content/types";
import { displayKey, reportContentIssue } from "../core/content-bridge";

// ---------------------------------------------------------------------------
// The contract a character file implements
// ---------------------------------------------------------------------------

/**
 * A built body: a root to hang in the scene, the joints its `animate` poses,
 * and the footprint it blocks.
 *
 * `parts` rather than named fields, exactly like `BeastRig`: the framework never
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
   * Here for the same reason `BeastAnimCtx.cycle` keeps its phases per beast: an
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

/**
 * A character's BODY: the half of him that is code.
 *
 * Everything else about a person — his name, his town, how near the middle he
 * wants to stand, what he says — is content, and the two meet at
 * `NpcData.body`, which names one of these.
 */
export interface NpcBody {
  build(): NpcRig;
  animate(rig: NpcRig, ctx: NpcAnimCtx): void;
}

/**
 * Every character BODY in the game. The module list is the roster, like
 * beasts/registry.ts.
 *
 * EXPORTED for the same reason `ALL_SPECIES` is, and the reason is sharper here
 * than it used to be: `tools/test-zfight.mjs` builds every rig in the game and
 * checks it for coincident surfaces, and it does that under plain Bun with no
 * content runtime anywhere. A roster it has to be told about by hand is a roster
 * that silently stops covering the character somebody added last week — so this
 * is the one place a body is named, and both the tool and the factory
 * registration below read it.
 */
export const NPC_BODIES: Readonly<Record<string, NpcBody>> = {
  gain: GAIN_BODY,
  // The working people: three on the flying island (issue #68), Redbriar's
  // miller (issue #149) and Stonewatch's warden (issue #151). One builder, one palette and one idle each — see
  // world/npc-villagers.ts for why the variety is in the skin rather than in
  // four copies of a skeleton.
  "sky-pilot": SKY_PILOT_BODY,
  "sky-gardener": SKY_GARDENER_BODY,
  "sky-lamplighter": SKY_LAMPLIGHTER_BODY,
  mera: MERA_BODY,
  coil: COIL_BODY,
};

/**
 * Publish the bodies to the content layer, at module load and therefore before
 * `bootstrapContent()` — see the same note at the bottom of world/towns.ts.
 *
 * DRIVEN OFF THE ROSTER rather than written out per character, so a body cannot
 * be in `NPC_BODIES` and not registered, or registered and not in it. That is
 * the failure the roster exists to prevent, and repeating the list would put it
 * straight back.
 */
for (const [name, body] of Object.entries(NPC_BODIES)) {
  defineFactory(NPC_BODY_KIND, name, body);
}

/**
 * One placed character, as this file needs him: the content asset's statement
 * resolved against a registered body.
 *
 * `nameKey` and `name` are the SAME text read two ways, and both are needed.
 * `NpcInfo.nameKey` (core/types.ts) is a `StringKey` — the interact prompt and
 * the compass are typed against the shipped table — while `NpcTalk.name` is a
 * `ContentText`, because a conversation is a thing the game merely prints and a
 * pack may legitimately carry its own words. See core/content-bridge.ts.
 */
interface Character {
  /** The stable IDENTIFIER — what a quest stores and what `talk(id)` takes. */
  id: string;
  /** DISPLAY name, as a string-table key. */
  nameKey: StringKey;
  /** The same name, unresolved, for the dialogue payload. */
  name: ContentText;
  /** Which settlement he stands in, by registry id. */
  townId: string;
  /**
   * How far from that town's centre he would LIKE to stand, in world units.
   * 0 means the middle; the search below only ever pushes him further out, and
   * only as far as it has to to get him off the road and out of the furniture.
   */
  homeOffset: number;
  /**
   * Stand on the far side of the town's focus from wherever he would otherwise
   * have stood — see `NpcSite.focusOf`. Opt-in, because it only means anything
   * in a settlement that HAS a focus.
   */
  acrossFocus: boolean;
  body: NpcBody;
  /**
   * What he might say, IN ORDER, first match wins. THE QUEST SEAM, and it is
   * data now rather than a function: an entry carries an optional `when` and an
   * optional list of actions, so an offer that is only available once a flag is
   * set is a row in a JSON file. The shipped Gain has exactly one entry with no
   * `when`, so he says what he always said.
   */
  talk: readonly NpcTalkLine[];
}

/**
 * The roster, resolved from content.
 *
 * A character is REFUSED, with a diagnostic, when the engine cannot build him: a
 * body no factory implements, or a name that is not a string-table key. Refusing
 * is the honest answer for the same reason it is in world/towns.ts — a person
 * the prompt cannot name is a blank interact pill, which reads as a broken HUD
 * rather than as missing content (issue #17, from the other end).
 */
function readCharacters(): readonly Character[] {
  const out: Character[] = [];
  for (const asset of content.all<NpcData>("npc")) {
    const { data } = asset;
    const body = content.factory<NpcBody>(NPC_BODY_KIND, data.body);
    if (!body) {
      reportContentIssue({
        severity: "error",
        code: "unknown-factory",
        message: `"${asset.id}" wants body "${data.body}", which no builder implements`,
        assetId: asset.id,
        assetType: asset.type,
        pkg: asset.pkg,
        source: asset.source,
        field: "data.body",
        fix: `one of ${Object.keys(NPC_BODIES).join(", ")}`,
      });
      continue;
    }
    const nameKey = displayKey(asset);
    if (nameKey === null || asset.name === undefined) {
      continue;
    }
    out.push({
      // The `name` half of the content id, the same split world/towns.ts makes.
      id: asset.id.slice(asset.type.length + 1),
      nameKey,
      name: asset.name,
      // ...and the town REFERENCE is an id, where `TownRegistry.get` keys on the
      // name half. One split, made in one direction, in both files.
      townId: data.town.slice(data.town.indexOf(":") + 1),
      homeOffset: data.homeOffset,
      acrossFocus: data.acrossFocus,
      body,
      talk: data.talk,
    });
  }
  return out;
}

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
 * How far ABOVE OR BELOW him you may be and still be talking to him, in world
 * units of separation between his feet and yours.
 *
 * A CYLINDER, not a sphere, and that is the point — the argument is written out
 * once, at `inReach` in core/types.ts, which every other proximity test in the
 * game now goes through as well (issue #78). `NPC_TALK_RANGE` above is
 * tuned against a hero who walked up to him on flat camp ground; folding the
 * height into one radius would quietly shorten that reach on every slope, for a
 * defect nobody reported. The two questions are different — "did you come over
 * to him" and "are you at his level" — so they get two numbers.
 *
 * There was no vertical test at all until issue #25: the query took (x, z) and
 * nothing else, so a hero flying over the Encampment was offered "Press E —
 * Talk to Deckard Gains Armstrong" the whole way across. Measured on a galebird
 * climbing straight up out of the camp, the prompt was still up at dy 36.92.
 *
 * 2.5 is picked off the four cases that matter, all measured beside Gain:
 *
 *   standing next to him       dy 0.00   talks
 *   jump apex, on foot         dy 1.54   talks — a hop must not blink the prompt
 *   flying mount at rest hover dy 2.21   talks — that is his head height, and
 *                                        a bobbing hover either side of a
 *                                        tighter bound would flicker
 *   half a second of climb     dy 4.88   silent
 *
 * The gap it has to fit in is 1.54..2.21, and 2.5 clears the jump by nearly a
 * unit while leaving the settled hover comfortably inside rather than balanced
 * on the edge. Anything a player reaches by CLIMBING is out on the first frame.
 */
const NPC_TALK_RISE = 2.5;
/**
 * Where a conversation ends because you walked off. Deliberately wider than it
 * begins — a dialogue that blinked out the instant you shifted your weight at
 * the hysteresis edge would be worse than one that lingers a step too long.
 *
 * The same slack applies to the height, and for a stronger reason than the
 * horizontal: a mount bobs on its hover where a walker does not, so a leave
 * bound equal to the entry bound would end a conversation on the down-beat.
 */
const NPC_LEAVE_RANGE = NPC_TALK_RANGE * 1.5;
const NPC_LEAVE_RISE = NPC_TALK_RISE * 1.5;
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
 * A margin OUTSIDE the rim of whatever path answers, asked through
 * `edgeDistanceTo`: 1.2 is his own body radius plus enough that he is visibly
 * standing OFF the gravel rather than on the verge of it. The same shape of
 * number as `FENCE_ROAD_CLEAR` in towns.ts, and it matters more here: the
 * Encampment's cart road ENDS at the middle of the camp, so "the middle" is a
 * road, and this is the whole reason the search has to walk outward at all.
 */
const NPC_ROAD_CLEAR = 1.2;
/** Rings the placement search tries, in world units out from the town centre. */
const SPOT_RINGS = [0, 2.5, 4.5, 6.5, 8.5, 10.5, 12.5];
/** Bearings per ring. 16 puts a candidate every 22.5 degrees. */
const SPOT_BEARINGS = 16;

// ---------------------------------------------------------------------------

/**
 * `NpcInfo` with its position writable, because on a moving frame it is not a
 * placement, it is a per-slice reading. Off a frame it is written once and never
 * again, exactly as it always was.
 */
type LiveNpcInfo = {
  -readonly [K in keyof NpcInfo]: NpcInfo[K];
};

interface Placed {
  char: Character;
  rig: NpcRig;
  info: LiveNpcInfo;
  /** Where he stands in the SITE's coordinates — the frame's, or the world's. */
  localX: number;
  localZ: number;
  localY: number;
  /** The bearing he faces when nobody is with him, in the site's frame. */
  restYaw: number;
  yaw: number;
}

/**
 * A MOVING FRAME the whole crew stands in — a flying island's deck today, a
 * boat's or a caravan's tomorrow. Absent means the ordinary case: the ground,
 * which does not move and needs no transform.
 *
 * This is the narrow half of `CarrierBody` (world/carriers.ts) and it is
 * declared here rather than imported so the NPC system depends on the SHAPE of
 * a frame and not on carriers existing. Everything a placed character needs is
 * the three things below: where the frame's origin is, which way it is turned,
 * and how to get from its coordinates to the world's.
 *
 * WHAT IT CHANGES IS ONLY THE BOOKKEEPING. Placement, the clearance tests, the
 * conversation state and the culling all run in the frame's own coordinates and
 * never find out which frame it is; `NpcInfo` is then republished in WORLD
 * coordinates once per update, because the talk test in main.ts is asked about
 * a hero whose position is a world position and must not have to know either.
 */
export interface NpcFrame {
  readonly y: number;
  readonly yaw: number;
  toWorld(lx: number, lz: number, out: { x: number; z: number }): void;
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
  /**
   * A settlement's SOCIAL CENTRE — the camp's fire, and whatever a later town
   * kind puts in the same role — or null where it has none.
   *
   * Here because "stand across the fire" is a thing a character can want and
   * this file cannot work out: the fire is stamped inside `buildEncampment`
   * from a coin flip on the town's own stream, so it is not derivable from a
   * `TownInfo` and not worth widening that contract for. A lookup keeps the
   * geometry on the side of the file that owns it.
   */
  focusOf?(townId: string): { x: number; z: number } | null;
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

  /**
   * @param frame The moving reference frame this crew stands in, if any. See
   *   `NpcFrame`. Every coordinate in `site` is then in that frame, and so is
   *   everything this constructor computes; `update` publishes world positions.
   */
  constructor(
    site: NpcSite,
    private readonly frame: NpcFrame | null = null,
  ) {
    const infos: NpcInfo[] = [];
    for (const char of readCharacters()) {
      const town = site.towns.get(char.townId);
      if (!town) {
        continue;
      } // a zone without his town simply has no him
      const rig = char.body.build();
      let spot = findSpot(site, town.x, town.z, char.homeOffset, rig.radius);
      // ACROSS THE FIRE from wherever the plain search put him.
      //
      // Two passes and not one, because the mirror is defined against the spot
      // the first pass chose: reflect it through the fire, take the bearing of
      // that reflection from the middle of town, and search again preferring
      // it. The second pass runs the same rings and the same `free` tests, so
      // he cannot end up somewhere the first pass would have refused — if the
      // far side is full, the preference simply loses to crowding and he stays
      // where he was.
      const focus = char.acrossFocus ? (site.focusOf?.(char.townId) ?? null) : null;
      if (focus) {
        const mx = 2 * focus.x - spot.x;
        const mz = 2 * focus.z - spot.z;
        spot = findSpot(
          site,
          town.x,
          town.z,
          char.homeOffset,
          rig.radius,
          Math.atan2(mx - town.x, mz - town.z),
        );
      }
      const y = site.getHeight(spot.x, spot.z);
      // Facing the GATE, so the first thing a visitor walking in off the road
      // sees is his face rather than the back of his mantle.
      const restYaw = Math.atan2(town.gateX - spot.x, town.gateZ - spot.z);
      rig.root.position.set(spot.x, y, spot.z);
      rig.root.rotation.y = restYaw;
      this.group.add(rig.root);
      // The record starts out holding the SITE's coordinates, which off a frame
      // is already the world's. On a frame the first `update` overwrites it —
      // and nothing reads it in between, because the field is not on the World
      // contract until the world that owns it has been returned.
      const info: LiveNpcInfo = {
        id: char.id,
        nameKey: char.nameKey,
        x: spot.x,
        y,
        z: spot.z,
        restYaw,
      };
      infos.push(info);
      this.placed.push({
        char,
        rig,
        info,
        restYaw,
        yaw: restYaw,
        localX: spot.x,
        localY: y,
        localZ: spot.z,
      });
      // The same call shape `SolidStamp.add` uses, and the same field type —
      // his box is stamped at the pose he was placed in.
      this.solids.add(rig, spot.x, y, spot.z, restYaw, 1, 1);
    }
    this.solids.build();
    this.all = infos;
  }

  // -- NpcField -------------------------------------------------------------

  nearest(x: number, y: number, z: number, range: number): NpcInfo | null {
    let best: NpcInfo | null = null;
    let bd2 = range * range;
    for (const p of this.placed) {
      // Height first: it rejects the whole airborne case with one subtraction
      // and an absolute, where the horizontal test cannot tell a hero standing
      // in front of him from one thirty units over his head. See NPC_TALK_RISE.
      if (!inRise(y, p.info.y, NPC_TALK_RISE)) {
        continue;
      }
      const dx = p.info.x - x;
      const dz = p.info.z - z;
      const d2 = dx * dx + dz * dz;
      if (d2 < bd2) {
        bd2 = d2;
        best = p.info;
      }
    }
    return best;
  }

  get talking(): NpcTalk | null {
    return this.talkState;
  }

  /**
   * Begin (or restart) a conversation.
   *
   * FIRST MATCH WINS, which is what makes an entry with no `when` a DEFAULT
   * rather than an alternative. The list is ordered by the author, `evaluate`
   * answers against live `ContentState`, and an entry's actions run when it is
   * the one chosen — so "offer the quest if it is available, otherwise say
   * hello" is two rows in a JSON file rather than a branch in this function.
   * Content's own validator warns when an unconditional entry has rows after it.
   *
   * A character every one of whose entries is refused says NOTHING and no
   * conversation opens, rather than one opening with an empty panel in it.
   */
  talk(id: string): NpcTalk | null {
    const p = this.placed.find((q) => q.char.id === id);
    if (!p) {
      return null;
    }
    const entry = p.char.talk.find((line) => content.evaluate(line.when));
    if (!entry) {
      return null;
    }
    content.run(entry.actions);
    this.talkState = { id: p.char.id, name: p.char.name, line: entry.line };
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
    const frame = this.frame;
    for (const p of this.placed) {
      // ON A MOVING FRAME, WHERE HE IS IS A READING. Republished first, so
      // every test below — the cull, the leave range, the bearing he turns on —
      // is asked in world space against a world position, which is exactly what
      // they were asked in before frames existed. `restYaw` and the placement
      // stay in the frame's coordinates; only the published record moves.
      if (frame) {
        frame.toWorld(p.localX, p.localZ, _fw);
        p.info.x = _fw.x;
        p.info.z = _fw.z;
        p.info.y = frame.y + p.localY;
        p.info.restYaw = p.restYaw + frame.yaw;
      }
      const dx = p.info.x - focus.x;
      const dz = p.info.z - focus.z;
      const d2 = dx * dx + dz * dz;
      // CULLING STAYS FLAT. This one is about pixels on the screen, and a man
      // you are flying over is the case where you can see him best — gating the
      // draw on height would delete him from under his own shadow.
      const visible = d2 < NPC_CULL2;
      p.rig.root.visible = visible;
      // Whether you are STILL WITH HIM, though, is the same cylinder `nearest`
      // uses, one hysteresis step wider: taking off mid-sentence ends it, the
      // way walking away does. Without this the height check would only govern
      // the prompt, and a talk begun on the ground would follow you into the
      // sky and stay open there.
      const near =
        d2 < NPC_LEAVE_RANGE * NPC_LEAVE_RANGE && inRise(focus.y, p.info.y, NPC_LEAVE_RISE);
      if (this.talkState?.id === p.char.id && !near) {
        this.talkState = null;
      }
      if (!visible) {
        continue;
      }
      const attended = near;
      // Frame-rate independent, per the convention: an exponential approach to
      // the wanted bearing, never a fixed lerp factor.
      // IN THE FRAME'S OWN ANGLES, because that is what the rig's rotation is:
      // the root hangs under the frame, so its yaw is relative to the frame's.
      // The bearing to the visitor is a WORLD bearing, so it comes back through
      // `frame.yaw` — and `restYaw` never left the frame, which is why it is
      // used raw here and offset above.
      const toFocus = Math.atan2(focus.x - p.info.x, focus.z - p.info.z) - (frame ? frame.yaw : 0);
      const want = attended ? toFocus : p.restYaw;
      p.yaw = approachAngle(p.yaw, want, TURN_LAMBDA, dt);
      p.rig.root.rotation.y = p.yaw;
      this.ctx.attended = attended;
      p.char.body.animate(p.rig, this.ctx);
    }
  }

  setVisible(v: boolean): void {
    this.group.visible = v;
  }

  dispose(): void {
    for (const p of this.placed) {
      for (const d of p.rig.disposables) {
        d.dispose();
      }
      this.group.remove(p.rig.root);
    }
    this.placed.length = 0;
    this.talkState = null;
  }
}

// ---------------------------------------------------------------------------

/** Frame->world scratch for `update`. Per the no-per-frame-allocation rule. */
const _fw = { x: 0, z: 0 };

/** Shortest-arc exponential approach; the same helper the player camera uses. */
function approachAngle(cur: number, target: number, rate: number, dt: number): number {
  let d = target - cur;
  while (d > Math.PI) {
    d -= Math.PI * 2;
  }
  while (d < -Math.PI) {
    d += Math.PI * 2;
  }
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
/**
 * Can a body of `radius` stand at (x, z) — off the carriageway, and clear of
 * everything the settlement built?
 *
 * EXPORTED because the player's opening pose asks the identical question one
 * module up (`pickPlayerStart` in world/index.ts), and the alternative was a
 * second copy of the two rules that decide it. They are rules with a history:
 * the road test exists because the Encampment's cart road ENDS at the middle of
 * camp, so "the middle" is a road; the four-corner probe exists because a body
 * half inside a barrel is still inside a barrel, and its own centre is clear.
 * A spot the hero may stand on and a spot an NPC may stand on are the same spot.
 */
export function spotIsFree(site: NpcSite, x: number, z: number, radius: number): boolean {
  const clearOf = radius + 0.35;
  // The BUILT query: a person standing on a settlement's beaten track is
  // standing where people walk, which is the whole reason the track is there.
  // What he may not stand in is a carriageway. See `RoadClearance`.
  if (site.roads.builtEdgeDistanceTo(x, z) < NPC_ROAD_CLEAR) {
    return false;
  }
  if (site.structureTopAt(x, z) > -Infinity) {
    return false;
  }
  for (let k = 0; k < 4; k++) {
    const a = (k / 4) * Math.PI * 2;
    if (site.structureTopAt(x + Math.sin(a) * clearOf, z + Math.cos(a) * clearOf) > -Infinity) {
      return false;
    }
  }
  return true;
}

function findSpot(
  site: NpcSite,
  cx: number,
  cz: number,
  offset: number,
  radius: number,
  preferBearing: number | null = null,
): { x: number; z: number } {
  const free = (x: number, z: number): boolean => spotIsFree(site, x, z, radius);
  /** How much furniture is within arm's reach and a step beyond it. */
  const crowding = (x: number, z: number): number => {
    let n = 0;
    for (const rr of [1.7, 2.7, 3.7]) {
      for (let k = 0; k < 12; k++) {
        const a = (k / 12) * Math.PI * 2;
        if (site.structureTopAt(x + Math.sin(a) * rr, z + Math.cos(a) * rr) > -Infinity) {
          n++;
        }
      }
    }
    return n;
  };
  for (const ring of SPOT_RINGS) {
    const d = ring + offset;
    if (d === 0) {
      if (free(cx, cz)) {
        return { x: cx, z: cz };
      }
      continue;
    }
    let best: { x: number; z: number } | null = null;
    let bestCrowd = Infinity;
    for (let k = 0; k < SPOT_BEARINGS; k++) {
      const a = (k / SPOT_BEARINGS) * Math.PI * 2;
      const x = cx + Math.sin(a) * d;
      const z = cz + Math.cos(a) * d;
      if (!free(x, z)) {
        continue;
      }
      // The tie-break LEARNS A SECOND TERM rather than being replaced: the ring
      // order still decides how far out he stands, and every `free` test is
      // untouched. A bearing preference costs the same as three units of
      // crowding at the far side of the circle, which is enough to swing the
      // choice between two comparably open spots and not enough to park him in
      // a tent wall — the failure the crowding term was added to fix.
      let crowd = crowding(x, z);
      if (preferBearing !== null) {
        let da = a - preferBearing;
        while (da > Math.PI) {
          da -= Math.PI * 2;
        }
        while (da < -Math.PI) {
          da += Math.PI * 2;
        }
        crowd += (Math.abs(da) / Math.PI) * 3;
      }
      if (crowd < bestCrowd) {
        bestCrowd = crowd;
        best = { x, z };
      }
    }
    if (best) {
      return best;
    }
  }
  // Nothing was clear anywhere in range — stand him at the offset he asked for,
  // rather than dropping the character entirely. A settlement this crowded is a
  // layout bug, and an NPC standing in a crate is how it gets noticed.
  return { x: cx, z: cz + Math.max(offset, 1) };
}
