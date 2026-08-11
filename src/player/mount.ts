import * as THREE from 'three';
import type { Input } from '../core/input';
import {
  MOUNT_KIND_KEYS, MOUNT_KIND_OF, MOUNT_KINDS,
  type CarrierInfo, type EventBus, type Locomotion, type MountKind, type World,
} from '../core/types';
import { CarrierRide } from '../world/carriers';
import { t } from '../i18n';
import type { BeastActor, BeastRideState } from '../beasts/framework';
import type { Player } from './index';

// ---------------------------------------------------------------------------
// Mounting — hold F, ride your beast
// ---------------------------------------------------------------------------
// The whole feature lives here: the hold-to-mount timer, the refusal rules, and
// the locomotion of a mounted beast (which is the hero's locomotion problem, not
// the beast framework's — a ridden beast is steered, not followed).
//
// Two things it deliberately does NOT own:
//   - the aim of a mounted cast. That is main.ts's business; this class only
//     answers "is a beast being ridden, and which one".
//   - anything about which beast is mountable. main.ts offers a candidate (the
//     primary) every slice and this class decides whether it can be climbed on.
//
// Everything below runs on a FIXED 60 Hz slice that may tick several times per
// rendered frame, so nothing here reads an input edge from the input layer: the
// F edge is latched off held state (see `fWasHeld`), exactly as Player does for
// the jump, and the hold timer accumulates dt on held state.

/**
 * Seconds of held F to climb into the saddle.
 *
 * 0.8 s, down from the 2.0 s this shipped with: two seconds was long enough to
 * be legible but it read as waiting for the game rather than as an action, and
 * mounting is something you do mid-stride. It is still far longer than any
 * accidental brush of F in a fight, which is the only thing the hold is
 * defending against.
 */
const MOUNT_HOLD = 0.8;
/**
 * How fast the fill drains when F is let go early, as a fraction of the bar per
 * second. Deliberately faster than it fills (1/MOUNT_HOLD = 1.25/s): a full bar
 * is gone in 0.16 s, so mashing F can never accumulate progress across taps —
 * the only way to mount is one continuous hold — while still reading as the bar
 * falling back rather than blinking out. Raised with MOUNT_HOLD to keep that
 * relationship; at the old 2.5 the drain was barely quicker than the fill.
 */
const RELEASE_DRAIN = 6.0;

/**
 * Ground mounts gallop: the beast's own follow speed times this.
 *
 * The speeds this multiplies are the species' (Sproutle 3.2 … Galebird 8.0)
 * against a hero who walks at 6 and sprints at 9.6, so the multiplier is what
 * decides whether a mount is worth having.
 *
 * 2.25 measured: Sparkit and Umbrakit 12.2, Emberfox 11.7, Graveborn 11.3,
 * Graveback 9.9, Boulderpup 9.5, Sproutle 7.2. The old 1.85 put the whole
 * middle of that table at or under a sprint (Emberfox 9.6, Boulderpup 7.8,
 * Sproutle 5.9) and argued the slow tank SHOULD be slower than running. It
 * should not: the sprint is holdable forever, so a mount that merely ties it is
 * a downgrade you paid a bond for. Issue #107. What survives of that stance is
 * the ORDER — the two tanks are still the slowest things you can ride, and
 * Sproutle at 7.2 still trades travel for what it is otherwise good at — while
 * everything from Graveback up now travels better than the hero's own legs.
 *
 * The ceiling is FLY_CRUISE, not comfort: 2.25 puts the fastest gallop at 12.2
 * just under Galebird's 12.4, so the sky is still the fastest way to cross the
 * map and that constant needs no matching nudge. Tuned here and not in
 * `stats.speed`, which also drives follow and combat.
 */
const GALLOP = 2.25;
/**
 * Flyers cruise a little more gently than the ground gallop, because they also
 * get a third axis and never have to go around anything: Galebird 12.4 u/s,
 * Frostwing 10.1, Lumimoth 8.1.
 */
const FLY_CRUISE = 1.55;
/**
 * What a water beast is worth IN WATER: the beast's own follow speed times
 * this, against the ground gallop's 2.25 and the hero's 6 on foot / 9.6 at a
 * sprint.
 *
 * 3.2, and it is deliberately the biggest number in this file. A mount has to
 * beat walking or nobody rides one (that is the whole argument on GALLOP), and
 * a WATER mount has to beat walking AROUND — the shore of a bay is always a
 * detour, so the honest comparison is not "is this faster than running" but "is
 * cutting straight across faster than the long way round". At 3.2 Finnick makes
 * 21.8 u/s and Rivotter 16.6, which is roughly two and a half times a sprint;
 * crossing a 120-unit basin takes six seconds against a twenty-second run round
 * it, and that gap is the point of the animal.
 */
const SWIM_GALLOP = 3.2;
/**
 * ...and what it is worth on land, for a beast that only swims.
 *
 * A `swimming` species has no legs worth the name — the framework already
 * waddles one at 0.55 of its follow speed when it is on foot (BeastActor's
 * `mediumMult`), and a saddle that ignored that would make the pure swimmers
 * strictly better than the amphibians everywhere in the world. `amphibious` is
 * exempt: being genuinely good in both is what that word is for, and it is the
 * reason to pick Rivotter over Finnick.
 */
const LAND_FLOP = 0.55;
/** Seconds between two "this animal will not swim that" toasts. */
const DEEP_TOAST_GAP = 6;

/** Horizontal acceleration lambda, in the house `1 - exp(-l*dt)` form. */
const ACCEL_LAMBDA = 5.5;
/** Heading damping. Slower than the hero's TURN_RATE 14 — a mount has mass. */
const TURN_LAMBDA = 7;
const GRAVITY = 24;
/**
 * Jump velocity for a GROUND mount, against the hero's own JUMP_VEL of 8.8.
 *
 * Same gravity, so apex scales as v^2/2g: 10.8 gives 2.43 units against his
 * 1.61 — half again as high, which is the point of being on an animal. It also
 * changes what the world is: a 2-unit face is the first thing the hero cannot
 * clear on foot (that gap is deliberate, see MAX_STEP_UP in player/index.ts),
 * and a mount clears it with room to spare. Anything past ~12 starts clearing
 * the 3-unit faces that climbing exists for, so the ceiling here is not comfort
 * but keeping climbing worth doing.
 */
const MOUNT_JUMP_VEL = 10.8;

/**
 * Highest ledge a ground mount walks onto, against the hero's MAX_STEP_UP 0.5.
 *
 * Terrain steps in whole units, so 1.1 means exactly one thing: a mount takes
 * the single terrace the hero has to jump, and is still stopped by the 2-unit
 * face that is the wall climbing exists for. That difference IS the ground
 * mount's traversal perk, and it is why the number is not simply the hero's.
 */
const MOUNT_STEP_UP = 1.1;
/**
 * Furthest DOWN a step-off may reach for ground, the mirror of MOUNT_STEP_UP.
 *
 * A step off a mount is a step, in both directions: the rider looks for footing
 * beside the saddle, not for the world floor. Without this bound the step-off
 * test ("is that column no higher than my feet plus a step?") is trivially true
 * for every column below — so unmounting a ground beast in mid-air, over a
 * cliff, or off the deck of a sky island planted the hero on the terrain far
 * below in one frame. That is issue #125. Out of reach, he leaves the saddle
 * where it was and falls, which is the same rule the flyer has always used.
 */
const MOUNT_STEP_DOWN = 1.1;

/**
 * THE ALTITUDE A TRANSFER KEEPS — the one rule for moving a body between the
 * saddle and its own feet, asked by BOTH getting on and getting off.
 *
 * It is one function because it was two, and both copies were the same defect
 * (issue #125): the surface under the destination column is a BOUND on the
 * altitude a body already has, never a destination of its own. Mounting a
 * ground beast thirty units up assigned the surface, and dismounting one
 * compared against it in a way that was true of every column below — so both
 * halves of the transfer teleported the hero to the terrain, in mid-air, for
 * the same reason, and each was fixed on its own. The flyer's half already had
 * the rule (issue #91, `max(y, floorFor)`) and is the same call here.
 *
 *   support at or above the body  -> the support. It is a FLOOR: nothing is
 *                                   ever placed inside the ground.
 *   support within `stepDown`     -> the support. A step down, and taken.
 *   further below than that       -> the altitude it had. That is a FALL, and
 *                                   gravity is what finishes it.
 *
 * `stepDown` is 0 for a mount-up, where nothing moves sideways and the only
 * question is the floor, and MOUNT_STEP_DOWN for a step off the saddle, which
 * lands beside the animal. It says nothing about walls — the step UP is the
 * caller's, because refusing to climb one also means refusing to move sideways.
 */
function transferY(y: number, support: number, stepDown: number): number {
  return support >= y - stepDown ? support : y;
}
/**
 * Extra half-width on the collision probe beyond the mount's own body radius,
 * so it is stopped with its shoulder at the rock like the hero is (see
 * BODY_RADIUS in player/index.ts — this world has no horizontal collision
 * geometry beyond these probes).
 */
const BODY_MARGIN = 0.15;
/**
 * How deep a mount sits when it is floating rather than standing — the float
 * line, measured down from `world.waterLevel`.
 *
 * A mount that cannot swim wades: it is simply held here whatever the bed is
 * doing underneath, so a puddle and a lake are the same walk. A mount that CAN
 * swim uses the same number as its CEILING and dives below it (see
 * `integrateSwim`), which is what makes the two rules one number: the surface a
 * wader is stuck at is the surface a swimmer starts from.
 */
const WADE_DEPTH = 0.45;

/** Vertical rates for a flyer, world units/s. Descending is a little faster. */
const FLY_CLIMB = 7.0;
const FLY_DIVE = 8.5;
/** Vertical damping toward the commanded rate. */
const FLY_VY_LAMBDA = 6;

/**
 * DIVING A WATER MOUNT (issue #103), and the four numbers it needs.
 *
 * THE CONTROLS ARE THE ONES THE PLAYER ALREADY HAS: C goes down, Space goes up.
 * That is the flyer's pair (`integrateFlying`) and the hero's own pair in a lake
 * (DIVE_ACCEL in player/index.ts), so the third place a player can be under a
 * surface reads the same two keys as the first two — no new binding, and
 * ui/keybinds.ts's `keys.descend` row already covers it.
 *
 * Slower than the flyer's 7.0/8.5 because the medium and the distances are both
 * smaller: water is thicker than air, and a swimmable basin is four to ten units
 * deep against a flight ceiling of 78. At 5.0 down the deepest water in the
 * world is reached in about two seconds, which is long enough to read as sinking
 * and short enough that nobody lets go of the key waiting for it.
 *
 * `SWIM_RISE_MAX` is the one that is not obvious, and it is the same correction
 * the hero needed when he learned to dive: the return to the surface is a spring
 * on the distance to the float line, and from the bed of a deep basin an
 * uncapped spring surfaces the pair of them faster than they can swim — a cork,
 * not an animal. Capping it at the deliberate climb rate makes letting go of the
 * keys a slow float up, and costs nothing near the surface where the spring
 * never reaches the cap anyway.
 */
const SWIM_CLIMB = 4.5;
const SWIM_DIVE = 5.0;
const SWIM_BUOYANCY = 6;
const SWIM_RISE_MAX = SWIM_CLIMB;
/**
 * Clearance a flyer keeps over terrain or water. 1.3 is the mount's own belly
 * height plus a little: the floor clamp below is what guarantees a flying mount
 * can never end up inside a hill it flew at, so it has to sit above the surface
 * rather than on it.
 */
const FLY_CLEARANCE = 1.3;
/**
 * How far one slice may shove a body out of a carrier's mass, in world units,
 * and in how many probes.
 *
 * SIZED AGAINST THE ISLAND'S OWN SPEED, not against the recovery. A carrier
 * cruises at about a unit a second, so what it actually buries in a body in one
 * slice is a hundredth of a unit and the first probe clears it — the march is
 * for the case that is not a collision at all, a body put inside the rock by a
 * teleport or by a frame that grew under it, where the honest answer is to walk
 * it out rather than to leave it in the dark. Two units a slice is a hundred and
 * twenty a second: a mount dropped into the middle of the island is outside it
 * inside a second, which reads as being pushed and not as being deleted.
 *
 * The step is under the cell size (1.2) so the march cannot stride over a
 * pocket, and the count is what bounds the cost of a query that answers `false`
 * for every body in the world that is not currently in a rock.
 */
const SHOVE_STEP = 0.25;
const SHOVE_STEPS = 8;
/**
 * Ceiling above the ground under you. Enough to clear anything; not orbit.
 *
 * RAISED FROM 60 WHEN THE SKY BECAME SOMEWHERE TO GO (issue #68). The flying
 * island cruises at 78-104 and the ground under it is often near sea level, so
 * at 60 the ceiling sat below the deck over exactly the terrain a player
 * approaches it across — an invisible floor-to-the-sky twenty units short of
 * the only place in the world that can be reached by no other means.
 * `CarrierRegistry.ceilingAt` is the other half of that fix and the one that
 * removes the step; this is the part that means a player who never goes near
 * the island can still get over the highest peak with room to look around.
 */
const FLY_CEILING = 78;

/**
 * The hero rig's hip height. His origin is at his FEET, but in the riding pose
 * nothing hangs below the hips (the legs swing forward over the mount's
 * shoulders), so the origin is placed a hip BELOW the beast's saddle and the seat
 * lands on the mount's back. Where that saddle is, is the beast's business —
 * BeastActor.saddleY, measured off its own silhouette.
 */
const HERO_HIP_Y = 0.6;
/**
 * How far back from the mount's centre the rider sits, as a fraction of its
 * body radius. A quadruped is ridden over the shoulders-to-hips span, not on
 * its skull; sitting half a radius back leaves the mount's own head and neck
 * visible in FRONT of the rider from the follow camera, which is what makes the
 * pair read as rider-and-mount rather than as one stacked silhouette (captured
 * at 0.35, the hero hid the fox almost completely from directly behind).
 */
const SEAT_BACK = 0.55;

/**
 * Camera framing while mounted; see ThirdPersonCamera.setFraming. The arm grows
 * 35% because the subject is now two bodies, and the aim point drops 0.6 units
 * because the middle of that subject is the saddle rather than the rider's
 * chest — captured without the drop, the mount itself sat behind the hotbar.
 */
const MOUNT_CAM_SCALE = 1.35;
const MOUNT_CAM_DROP = 0.6;

const _wish = new THREE.Vector3();

const clamp = (v: number, a: number, b: number): number => (v < a ? a : v > b ? b : v);

function angleDelta(a: number, b: number): number {
  let d = (b - a) % (Math.PI * 2);
  if (d > Math.PI) d -= Math.PI * 2;
  else if (d < -Math.PI) d += Math.PI * 2;
  return d;
}

function dampAngle(cur: number, target: number, lambda: number, dt: number): number {
  return cur + angleDelta(cur, target) * (1 - Math.exp(-lambda * dt));
}

export type MountRefusal = 'swimming' | 'climbing' | 'dead' | 'beastDead' | 'locked' | 'none';

/**
 * WHICH MOUNTS THE STORY HAS HANDED OVER — session state, and empty on a new
 * game.
 *
 * Riding is not a thing the hero can do from the fire on the first morning. It
 * is three unlocks, one per act (game-story.md §5), and until an act gives one
 * the beast beside you is a companion and not a vehicle. Nothing in the shipped
 * content grants them yet — the quest system that would is §7's list of what the
 * engine still needs — so the doors today are the F3 Debug panel's Mounts rows,
 * `/mount unlock`, and `mounts=` in the URL.
 *
 * IT LIVES HERE, next to the controller that asks it, and not in main.ts: this
 * is the one fact `refusal()` needs that is neither about the hero nor about the
 * animal, and a predicate reaching back into the composition root for it would
 * be the same reach every other rule in this file avoids. Owning it also means
 * owning the reset — see the twin rules in AGENTS.md — so `reset()` is here and
 * `exitToTitle` calls it beside `player.reset()`.
 *
 * A SET AND NOT THREE BOOLEANS, so `list()` is what a save stores and
 * `restore()` is what checks it against the kinds this build has.
 */
export class MountUnlocks {
  private readonly have = new Set<MountKind>();

  has(kind: MountKind): boolean { return this.have.has(kind); }

  /** Whether a beast of this gait may be ridden. See `MOUNT_KIND_OF`. */
  allows(loco: Locomotion): boolean { return this.have.has(MOUNT_KIND_OF[loco]); }

  set(kind: MountKind, on: boolean): void {
    if (on) this.have.add(kind);
    else this.have.delete(kind);
  }

  /** In `MOUNT_KINDS` order, so a save round-trips to the same document. */
  list(): MountKind[] {
    return MOUNT_KINDS.filter((k) => this.have.has(k));
  }

  /**
   * Take what a save (or a URL flag) says, keeping only kinds this build has.
   *
   * The id rule from AGENTS.md, applied to the smallest possible id set: a
   * document written against a build with a fourth kind loads here as the three
   * it recognises rather than as a throw.
   */
  restore(kinds: readonly string[]): void {
    this.have.clear();
    for (const k of kinds) {
      if ((MOUNT_KINDS as readonly string[]).includes(k)) this.have.add(k as MountKind);
    }
  }

  reset(): void { this.have.clear(); }
}

export class MountController {
  /** The beast being ridden, or null. */
  beast: BeastActor | null = null;
  /** 0..1 hold progress, for the HUD ring. */
  hold = 0;

  private flying = false;
  /**
   * True while the mount can cross deep water — locomotion 'swimming' or
   * 'amphibious'. Cached at `mount()` rather than asked per slice because it is
   * a fact about the species, and because two different rules read it (the
   * speed over water and the deep-water step) and they must never disagree.
   */
  private swimmer = false;
  /** True while the mount can only swim — no gallop, see LAND_FLOP. */
  private waterOnly = false;
  private pos = new THREE.Vector3();
  /**
   * Where the ANIMAL is, which is not where the rider is: the hero is seated
   * `saddleY - HERO_HIP_Y` above this and `SEAT_BACK` behind it (`seatHero`).
   * Every clamp in this file is applied here, so a probe asserting on one has
   * to read this and not the hero's position — the seat offset is a couple of
   * units and the clearances being asserted on are about that big.
   */
  get bodyY(): number { return this.pos.y; }
  private vel = new THREE.Vector3();
  private vy = 0;
  private grounded = true;
  /** Space edge for the ground-mount jump; see update()/jumpEdge(). */
  private jumpPressed = false;
  private jumpWasHeld = false;
  private yaw = 0;
  private pitch = 0;
  private bank = 0;
  private speed01 = 0;
  private topSpeed = 1;
  /** F held on the previous slice, so a press edge can be derived from it. */
  private fWasHeld = false;
  /**
   * Seconds before the deep sea may refuse this rider out loud again. Same
   * throttle, same reason and the same gap as the hero's own (Player).
   */
  private deepToastT = 0;
  /** One refusal toast per hold attempt, not one per slice. */
  private refusedFor: MountRefusal = 'none';
  /** Reused every slice; the beast copies out of it and keeps nothing. */
  private ride: BeastRideState = {
    x: 0, y: 0, z: 0, yaw: 0, pitch: 0, bank: 0, vx: 0, vz: 0,
    speed01: 0, action: 'idle',
  };

  constructor(
    private player: Player,
    private world: World,
    private input: Input,
    private bus: EventBus,
    private unlocks: MountUnlocks,
  ) {}

  /**
   * Rebind to another zone's ground (see world/zones.ts). The caller dismounts
   * first — a saddle pose computed against one world's heightfield and applied
   * in another is exactly the teleport-into-rock this whole rebinding exists to
   * avoid — so there is no ride state left to fix up here.
   */
  setWorld(world: World): void {
    this.world = world;
    // The caller dismounts first, so nothing is riding — but a carrier id from
    // the zone being left means nothing in the new one, and clearing it here
    // keeps the release beside the rebind.
    this.carrier.clear();
  }

  /**
   * The moving frame under the mount's feet, if any. See world/carriers.ts.
   *
   * `carrier`, not `ride`: `this.ride` is already the saddle pose this
   * controller hands the beast every slice (`BeastRideState`), and the two
   * words mean opposite halves of the same sentence — what the mount is
   * standing on, and what the mount is doing.
   */
  private readonly carrier = new CarrierRide();

  get isMounted(): boolean { return this.beast !== null; }
  /**
   * Is the mount SWIMMING right now — a water beast over a flooded column?
   *
   * The one question the dive rules turn on, asked in three places (the
   * vertical integration, the step exemption that goes with it and the HUD's
   * choice of badge), so it is one getter and not three copies of the same
   * `swimmer && afloat` pair that could disagree.
   */
  get isSwimming(): boolean {
    return this.beast !== null && this.swimmer && this.afloat(this.pos.x, this.pos.z);
  }
  /**
   * How far the ANIMAL is below the float line, or 0 when it is not swimming.
   * Measured from the float line rather than from `waterLevel` so a mount
   * bobbing at the surface reads exactly 0 — see WADE_DEPTH.
   */
  get diveDepth(): number {
    if (!this.isSwimming) return 0;
    return Math.max(0, this.world.waterLevel - WADE_DEPTH - this.pos.y);
  }
  /** 0..1 fill for the indicator. */
  get progress(): number { return clamp(this.hold / MOUNT_HOLD, 0, 1); }
  /** Horizontal speed of the mount, for probes and the HUD. */
  get speed(): number { return Math.hypot(this.vel.x, this.vel.z); }

  /**
   * Why the hero cannot climb on right now, or 'none'.
   *
   * Swimming and climbing both REFUSE rather than interrupt. They are the two
   * places where the hero controller owns his position against the world (a
   * float height, a held face), and a mount that took over mid-hold would
   * teleport him out of the water or off the rock. Surfacing or letting go is
   * one keypress away, which makes refusing the honest answer instead of a
   * special case in three controllers.
   *
   * `locked` is LAST, and that ordering is the message: every refusal above it
   * is something the player can fix in a second, so being told to go and finish
   * an act is the answer only once none of them applies. It is also asked of a
   * live candidate, which is what lets the toast name the KIND — "you cannot
   * ride" is not worth saying without "…things that fly".
   */
  refusal(candidate: BeastActor | null): MountRefusal {
    if (this.player.isDead) return 'dead';
    if (this.player.isSwimming) return 'swimming';
    if (this.player.isClimbing) return 'climbing';
    if (!candidate || candidate.isDead) return 'beastDead';
    if (!this.unlocks.allows(candidate.species.locomotion)) return 'locked';
    return 'none';
  }

  /**
   * Move the pair of them with whatever is carrying them, and nothing else.
   *
   * The saddle's half of `Player.carry` and it exists for the same reason: a
   * modal freezes the controller, and a frozen rider on a flying island is
   * still standing on it. `seatHero` is called too, because the hero's position
   * is written FROM `this.pos` — moving the mount without re-seating him leaves
   * him hanging where the island used to be.
   *
   * A no-op when nothing is being ridden; the hero carries himself then.
   */
  carryFrozen(dt: number): void {
    if (!this.beast) return;
    this.carryFrame();
    // THE ANIMAL TOO, not just the saddle. `seatHero` alone moves the rider and
    // leaves the beast wherever its rig was last written, which is what put a
    // hovering mount adrift under a frozen player. It also keeps the wings
    // beating, which is consistent with the rest of the party: a follower is
    // never frozen by a modal either.
    //
    // ONLY ON THE FROZEN PATH. `updateRide` poses the beast at the end of every
    // ordinary slice, so doing it here as well would call `rideUpdate` twice a
    // slice and run the animal's whole animation clock at double rate.
    this.poseBeast(dt);
  }

  /**
   * Put the MOUNT somewhere, and the rider with it. `__dbgTp`'s half of the
   * saddle.
   *
   * A no-op when nothing is being ridden, so the caller never has to ask.
   *
   * THIS EXISTS BECAUSE A TELEPORT WAS A SILENT NO-OP IN THE SADDLE, which is
   * the worst shape a debug hook can have. `__dbgTp` writes `player.position`,
   * and while mounted `seatHero` writes that same field from `this.pos` on
   * every slice — so the hero was moved and then put straight back, with
   * nothing anywhere reporting that the request had been dropped. A probe that
   * placed a rider and then measured a drive from there was measuring a drive
   * from wherever the previous section left him (caught in
   * tools/test-deepwater.mjs, where a crossing started 26 units from its
   * intended launch point and reached the basin by luck).
   *
   * The carrier frame is RE-TAKEN rather than kept: the deck the pair were
   * standing on has nothing to do with wherever they have just been put, and a
   * stale attachment would apply the old island's delta to the new position on
   * the next slice. A fresh attach applies no delta (see `CarrierRide.carry`).
   */
  teleport(x: number, z: number, y?: number): void {
    if (!this.beast) return;
    this.pos.set(x, 0, z);
    this.carrier.clear();
    this.carrier.carry(this.world, this.pos);
    this.pos.y = y ?? (this.flying
      ? this.floorFor(x, z)
      : Math.max(this.blockTop(x, z), this.world.waterLevel - WADE_DEPTH));
    this.vel.set(0, 0, 0);
    this.vy = 0;
    this.grounded = !this.flying;
    this.poseBeast(0);
  }

  /** The carrier's delta applied to the saddle. See `CarrierRide`. */
  private carryFrame(): void {
    this.carrier.carry(this.world, this.pos);
    this.yaw += this.carrier.dyaw;
  }

  /** Take the pending Space edge, if any. One press, one jump. */
  private consumeJump(): boolean {
    if (!this.jumpPressed) return false;
    this.jumpPressed = false;
    return true;
  }

  /**
   * One simulation slice. `candidate` is the beast F would mount — main.ts hands
   * over the primary — and may be null when the party is hidden.
   */
  update(dt: number, candidate: BeastActor | null): void {
    const input = this.input;
    // `pressed` is OR-ed in for the same reason Player's jump does it: a tap
    // shorter than one 16.7 ms slice (a virtual button, an automated press)
    // never shows up in held state. The latch is what stops a rendered frame
    // that drains two slices from spending the same tap twice.
    const fHeld = input.down('KeyF') || input.pressed('KeyF');
    const fEdge = fHeld && !this.fWasHeld;
    this.fWasHeld = fHeld;

    // Space, latched the same way, so a ground mount's jump fires once per press
    // however many slices the frame drains. Consumed in updateGround(); a flyer
    // and a swimming water beast both read Space as a held RATE instead and
    // never look at this latch.
    const jumpHeld = input.down('Space') || input.pressed('Space');
    this.jumpPressed = jumpHeld && !this.jumpWasHeld;
    this.jumpWasHeld = jumpHeld;
    if (this.deepToastT > 0) this.deepToastT -= dt;

    if (this.beast) {
      // THE GROUND MOVES FIRST, exactly as it does for the hero on foot: if the
      // pair of them are standing on something that travels, this is where they
      // travel with it, before the reins are read. The rider needs no carry of
      // his own while mounted — `seatHero` places him off `this.pos` at the end
      // of the ride, and `Player.update` skips its own frame while mounted, so
      // applying it here applies it exactly once.
      this.carryFrame();
      // A tap of F gets off. The F that MOUNTED you is still down at this
      // point, and no edge can be produced from it because fWasHeld was already
      // true when the mount happened — you have to let go and press again.
      if (fEdge) { this.dismount(); return; }
      if (this.beast.isDead || this.player.isDead) {
        this.dismount(this.beast.isDead
          ? t('toast.mount.beastDown', { beast: t(this.beast.species.nameKey) })
          : undefined);
        return;
      }
      this.updateRide(dt);
      return;
    }

    if (!fHeld) {
      this.hold = Math.max(0, this.hold - RELEASE_DRAIN * MOUNT_HOLD * dt);
      this.refusedFor = 'none';
      return;
    }

    const why = this.refusal(candidate);
    if (why !== 'none') {
      this.hold = 0;
      if (this.refusedFor !== why) {
        this.refusedFor = why;
        this.bus.emit({ type: 'toast', text: refusalText(why, candidate) });
      }
      return;
    }
    this.refusedFor = 'none';
    this.hold += dt;
    if (this.hold >= MOUNT_HOLD) this.mount(candidate!);
  }

  /**
   * Climb on. The ride starts at the HERO's own column rather than wherever the
   * beast happens to be trotting, so mounting can never begin with the mount
   * inside a hillside or a body-length away from its rider — the beast comes to
   * you, which is also what it looks like.
   */
  mount(beast: BeastActor): void {
    if (this.beast) return;
    this.beast = beast;
    this.hold = 0;
    const loco = beast.species.locomotion;
    this.flying = loco === 'flying';
    this.swimmer = loco === 'swimming' || loco === 'amphibious';
    this.waterOnly = loco === 'swimming';

    const p = this.player.position;
    this.topSpeed = this.gaitSpeed(p.x, p.z);
    // `blockTop`, not `getHeight`: mounting up while standing ON something —
    // a crate, a cart, the low end of a tent — must not drop the animal to the
    // dirt underneath it and leave the rider buried in the thing he was just
    // standing on. Measured on a 1.96-unit crate in the Encampment while this
    // read `getHeight`: on foot 13.96, mounted 12.91. See `blockTop`.
    // TAKE THE FRAME BEFORE ASKING WHAT THE GROUND IS. `blockTop` and
    // `floorFor` both consult the ride, and the ride is gated on being attached
    // — so a mount-up on a flying island's deck asked with no frame gets the
    // terrain eighty units below and drops the pair of them off the island. A
    // fresh attach applies no delta (see `CarrierRide.carry`), so this is a
    // lookup and not a move.
    this.pos.set(p.x, p.y, p.z);
    this.carrier.clear();
    this.carrier.carry(this.world, this.pos);
    // THE ANIMAL MEETS THE RIDER WHERE HE IS, whatever it walks on: the floor
    // under his column is the lower bound and not the destination (`transferY`,
    // with no step down, because nothing moves sideways to get on). A flyer has
    // read it this way since issue #91; a walker assigned the floor outright,
    // so mounting one during a fall put the pair of them on the terrain in the
    // same frame — the mount-up half of issue #125.
    //
    // The two floors differ and only the floors differ: a flyer's is the
    // surface plus its flight clearance, a walker's is the deepest it may wade.
    const support = this.flying
      ? this.floorFor(p.x, p.z)
      : Math.max(this.blockTop(p.x, p.z), this.world.waterLevel - WADE_DEPTH);
    this.pos.y = transferY(p.y, support, 0);
    this.vel.set(0, 0, 0);
    this.vy = 0;
    // Standing on that floor, or falling toward it. Reading `!this.flying` alone
    // told a walker mounted in mid-air that it was already on the ground, which
    // is a landed pose and a jump it has not earned.
    this.grounded = !this.flying && this.pos.y <= support;
    this.yaw = Math.atan2(this.player.forward.x, this.player.forward.z);
    this.pitch = 0;
    this.bank = 0;
    this.speed01 = 0;

    beast.setRidden(true);
    this.player.setMounted(true);
    this.player.setCameraFraming(MOUNT_CAM_SCALE, MOUNT_CAM_DROP);
    this.seatHero();
    this.bus.emit({ type: 'mounted', beastId: beast.species.id, flying: this.flying });
    this.bus.emit({
      type: 'toast',
      // The persistent badge already spells the controls out, so the toast is
      // the flourish, not a second copy of the key hints.
      text: t(this.flying ? 'toast.mount.flying' : 'toast.mount.ground', {
        beast: t(beast.species.nameKey),
      }),
    });
  }

  /**
   * Get off. On the ground the hero steps down beside the mount; in the air he
   * simply leaves the saddle with the mount's momentum and falls, which is both
   * the simplest rule and the one players expect.
   */
  dismount(reason?: string): void {
    const beast = this.beast;
    if (!beast) return;
    this.beast = null;
    this.hold = 0;
    beast.setRidden(false);
    this.player.setMounted(false);
    this.player.setCameraFraming(1, 0);

    // Step off to the camera's right, clear of the mount's body, and take the
    // ground there only if it is within a step. DOWN is `transferY`, the same
    // rule the mount-up above asks; UP is this file's own step ceiling, because
    // a wall is refused sideways as well as vertically. Out of reach either way
    // he leaves the saddle where it was and gravity sorts it out.
    const side = this.player.camRight;
    const r = beast.scaledRadius + 0.7;
    const x = this.pos.x + side.x * r;
    const z = this.pos.z + side.z * r;
    // The third of the same query, and the reason all three are `blockTop` now
    // rather than only the two the issue is a photograph of: a step-off that
    // asks the terrain alone will put the rider inside the crate he dismounts
    // beside, and will call a hut wall an empty patch of ground. His own
    // physics would shove him out on the next slice, so this one was never
    // visible — which is exactly why it would have been the one left behind.
    const gh = this.blockTop(x, z);
    const p = this.player.position;
    const step = transferY(this.pos.y, gh, MOUNT_STEP_DOWN);
    if (!this.flying && gh <= this.pos.y + MOUNT_STEP_UP && step === gh) {
      p.set(x, step, z);
      this.player.onGround = true;
    } else {
      p.set(this.pos.x, this.pos.y + (this.flying ? 0.2 : 0), this.pos.z);
      this.player.onGround = false;
    }
    this.player.velocity.set(this.vel.x, this.flying ? 0 : this.vy, this.vel.z);
    this.bus.emit({ type: 'dismounted', beastId: beast.species.id });
    this.bus.emit({
      type: 'toast',
      text: reason ?? t('toast.dismounted', { beast: t(beast.species.nameKey) }),
    });
  }

  // -- ride ------------------------------------------------------------------

  /**
   * Lowest a flyer may be at this column: terrain or water, plus clearance —
   * and a carrier's deck when it is riding one, which is what lets a galebird
   * come to rest on a flying island instead of sinking through it to the ground
   * eighty units below.
   */
  private floorFor(x: number, z: number): number {
    const deck = this.carrier.support(x, z);
    const ground = Math.max(this.world.getHeight(x, z), this.world.waterLevel);
    return Math.max(ground, deck) + FLY_CLEARANCE;
  }

  /**
   * Top of everything solid at a column — terrain, a tree's bole, and anything
   * a settlement built there.
   *
   * Deliberately the same three queries the hero asks on foot (Player.blockTop):
   * a mount that could walk through a hut its rider cannot would make riding
   * into camp the way to get inside the buildings.
   */
  private blockTop(x: number, z: number): number {
    const ground = this.world.getHeight(x, z);
    const trunk = this.world.trunkSolidTopAt(x, z);
    let top = trunk > ground ? trunk : ground;
    const built = this.world.structureTopAt(x, z);
    if (built > top) top = built;
    // ...and the deck of whatever is carrying it. -Infinity unless the mount is
    // riding one, which is what makes it safe to ask with (x, z) alone — see
    // `CarrierRide.support`, and Player.blockTop, which folds in the same query
    // for the same reason. A mount that could walk through the island its rider
    // cannot is the same defect as one that could walk through a hut.
    const deck = this.carrier.support(x, z);
    if (deck > top) top = deck;
    return top;
  }

  /**
   * Is the mount ON water at this column — floating rather than standing?
   *
   * `isWater` is the column being flooded at all, which for a wader is the
   * wrong question: a shin-deep puddle would otherwise pay the swim boost. The
   * extra quarter-unit is the same margin the beast framework uses to decide a
   * follower has started swimming (BeastActor), so the mount and the party
   * agree about where the water begins.
   */
  private afloat(x: number, z: number): boolean {
    return this.world.isWater(x, z)
      && this.world.getHeight(x, z) < this.world.waterLevel - 0.25;
  }

  /**
   * Top speed for the column the mount is over. A flyer's never changes; a
   * ground mount gallops; a water beast is transformed by water and, if it can
   * do nothing else, hobbled out of it. See SWIM_GALLOP and LAND_FLOP.
   */
  private gaitSpeed(x: number, z: number): number {
    const base = this.beast!.stats.speed;
    if (this.flying) return base * FLY_CRUISE;
    if (this.swimmer && this.afloat(x, z)) return base * SWIM_GALLOP;
    return base * GALLOP * (this.waterOnly ? LAND_FLOP : 1);
  }

  /**
   * May this mount put a foot in that column?
   *
   * The saddle's half of the deep-sea rule, and the same shape as the hero's
   * (Player.update): a column of dark water is refused, and refused per axis so
   * a blocked diagonal slides along the edge of the basin. Only the animal's
   * ability differs — a water beast crosses, and crossing is the entire reason
   * to own one.
   */
  private deepRefused(x: number, z: number): boolean {
    return !this.swimmer && this.world.isDeepWater(x, z);
  }

  /**
   * Say why the mount stopped, at most once every DEEP_TOAST_GAP seconds.
   *
   * A DIFFERENT SENTENCE FROM THE HERO'S, because the player is in a different
   * situation: on foot he needs telling that a beast would solve this, in the
   * saddle he needs telling that THIS beast will not — he has one, he is on it,
   * and the water still says no. Naming the animal is what makes that read as a
   * fact about Boulderpup rather than as the game being broken.
   */
  private refuseDeep(): void {
    if (this.deepToastT > 0 || !this.beast) return;
    this.deepToastT = DEEP_TOAST_GAP;
    this.bus.emit({
      type: 'toast',
      text: t('toast.mount.refuse.deepGround', { beast: t(this.beast.species.nameKey) }),
    });
  }

  private updateRide(dt: number): void {
    const beast = this.beast!;
    const input = this.input;
    // The gait is re-read EVERY SLICE, not taken at mount-up: the whole feature
    // is a speed that changes when the ground under you turns to water, and a
    // top speed cached at the shore would be the one number that never noticed.
    this.topSpeed = this.gaitSpeed(this.pos.x, this.pos.z);

    // ---- steering: camera-relative, exactly as on foot ----
    const fwd = input.axisFwd;
    const side = input.axisSide;
    _wish.set(0, 0, 0)
      .addScaledVector(this.player.camForward, fwd)
      .addScaledVector(this.player.camRight, side);
    const tilt = Math.min(1, Math.hypot(fwd, side));
    const moving = _wish.lengthSq() > 1e-6;
    if (moving) _wish.normalize();

    // The mount's top speed is the BEAST's, not the hero's — that is the whole
    // point of riding one. A half-deflected stick still walks.
    let target = this.topSpeed;
    if (tilt > 0 && tilt < 0.98) target *= Math.max(0.35, tilt);

    const k = 1 - Math.exp(-ACCEL_LAMBDA * dt);
    this.vel.x += ((moving ? _wish.x * target : 0) - this.vel.x) * k;
    this.vel.z += ((moving ? _wish.z * target : 0) - this.vel.z) * k;

    if (this.flying) this.integrateFlying(dt);
    else this.integrateGround(dt);

    // ---- facing / banking ----
    const speed = Math.hypot(this.vel.x, this.vel.z);
    const prevYaw = this.yaw;
    if (speed > 0.35) {
      this.yaw = dampAngle(this.yaw, Math.atan2(this.vel.x, this.vel.z), TURN_LAMBDA, dt);
    }
    const turnVel = dt > 0 ? angleDelta(prevYaw, this.yaw) / dt : 0;
    const targetBank = this.flying ? clamp(-turnVel * 0.3, -0.5, 0.5) : 0;
    this.bank += (targetBank - this.bank) * (1 - Math.exp(-5 * dt));
    this.speed01 = Math.min(1, speed / Math.max(0.001, this.topSpeed));

    // ---- hand the beast its pose, and sit the hero on top of it ----
    this.poseBeast(dt);
  }

  /**
   * Write this slice's saddle pose onto the beast, and seat the rider on it.
   *
   * EXTRACTED BECAUSE TWO PATHS NEED IT AND ONE OF THEM WAS MISSING IT. The
   * mount's POSITION lives in `this.pos` and the beast's rig only learns about
   * it here, through `rideUpdate` — so `carry`, which moves `this.pos` with a
   * carrier while the controller is frozen, moved the saddle and the rider and
   * left the animal behind. On a flying island in a menu that reads as the
   * mount sliding out from under its own rider, which is exactly what was
   * reported.
   *
   * `seatHero` last, because it places the hero FROM `this.pos`.
   */
  private poseBeast(dt: number): void {
    const beast = this.beast;
    if (!beast) return;
    const s = this.ride;
    s.x = this.pos.x; s.y = this.pos.y; s.z = this.pos.z;
    s.yaw = this.yaw; s.pitch = this.pitch; s.bank = this.bank;
    s.vx = this.vel.x; s.vz = this.vel.z;
    s.speed01 = this.speed01;
    // 'swim' AT ANY SPEED, including standing still: a beast floating in a lake
    // is swimming even when it is not going anywhere, and dropping to 'idle'
    // there would stand it up on the water like a dog on a lawn. Every species
    // animates 'swim'; the ones that never see water fold it into 'fly' or the
    // gait (see the case labels in the species files).
    s.action = this.flying ? 'fly'
      : this.isSwimming ? 'swim'
      : this.speed01 > 0.5 ? 'run' : this.speed01 > 0.06 ? 'walk' : 'idle';
    beast.rideUpdate(dt, s);
    this.seatHero();
  }

  private integrateGround(dt: number): void {
    const world = this.world;
    // Horizontal first, axis by axis so a blocked diagonal slides along the
    // face instead of stopping dead — the same resolution the hero uses, with
    // the mount's own body radius and its higher step.
    const feetY = this.pos.y;
    // A SWIMMER IS EXEMPT FROM THE STEP TEST, exactly as the hero is on his own
    // (Player.update). The rule asks "does that column stand above my feet",
    // and a mount that has dived to the bed of a basin has its feet four units
    // under the shallows — so every slope out of the water, and every hump on
    // the bed it is swimming over, would be a wall. What actually stops a
    // swimmer going where it should not is the floor clamp below, which lifts
    // it over the bed, and `deepRefused`, which never refuses a water beast.
    const stepCeil = this.isSwimming ? Infinity : feetY + MOUNT_STEP_UP;
    const radius = this.beast!.scaledRadius + BODY_MARGIN;

    const nx = this.pos.x + this.vel.x * dt;
    const px = nx + Math.sign(this.vel.x) * radius;
    if (this.blockTop(px, this.pos.z) <= stepCeil && !this.deepRefused(px, this.pos.z)) {
      this.pos.x = nx;
    } else { this.vel.x = 0; if (this.deepRefused(px, this.pos.z)) this.refuseDeep(); }

    const nz = this.pos.z + this.vel.z * dt;
    const pz = nz + Math.sign(this.vel.z) * radius;
    if (this.blockTop(this.pos.x, pz) <= stepCeil && !this.deepRefused(this.pos.x, pz)) {
      this.pos.z = nz;
    } else { this.vel.z = 0; if (this.deepRefused(this.pos.x, pz)) this.refuseDeep(); }

    // A WATER BEAST OVER WATER OWNS ITS OWN ALTITUDE. Asked AFTER the horizontal
    // step, not before it, so a mount that has just swum onto a beach falls under
    // gravity on the same slice it stops being afloat instead of hanging a slice
    // at the old float line.
    if (this.isSwimming) { this.integrateSwim(dt); return; }

    // Space bounds a ground mount. The rider is a passenger — the beast jumps, so
    // the jump is the beast's, not the hero's, and it clears more than he can on
    // foot. Read as an EDGE (the same latched `pressed`-OR-`down` shape the rest
    // of this file uses for F) so holding Space does not pogo, and gated on
    // `grounded` so there is no second jump in mid-air.
    if (this.grounded && this.consumeJump()) {
      this.vy = MOUNT_JUMP_VEL;
      this.grounded = false;
    }
    this.vy -= GRAVITY * dt;
    this.pos.y += this.vy * dt;

    // WHAT HOLDS A MOUNT UP IS WHAT STOPPED IT GETTING HERE. This asked
    // `getHeight` — terrain and nothing else — while the horizontal test a
    // dozen lines above asked `blockTop`, so the two disagreed about every
    // crate, cart, barrel and tent in the world: the mount was refused entry to
    // a column by a box and then, once on top of one, sank straight through it
    // to the dirt. That is issue #32, and it is the same defect the hero's own
    // note calls "what makes a low crate something you walk ON rather than
    // something you sink into" (Player.update). Measured on a 1.96-unit crate
    // in the Encampment: hero 13.96, rider 12.91, a metre inside the box.
    //
    // Deep water is still waded, not swum: there is no swimming gait for a
    // mount, so the floor never goes further down than WADE_DEPTH below the
    // surface. `blockTop` already folds terrain in, so this is the same clamp
    // it always was with two more solids in the maximum.
    const gh = Math.max(this.blockTop(this.pos.x, this.pos.z), world.waterLevel - WADE_DEPTH);
    if (this.pos.y <= gh) {
      this.pos.y = gh;
      this.vy = 0;
      this.grounded = true;
    } else if (this.grounded && this.vy <= 0 && this.pos.y - gh < 0.5) {
      this.pos.y = gh;          // stay glued running down slopes
      this.vy = 0;
    } else {
      this.grounded = false;
    }
    this.pitch += (0 - this.pitch) * (1 - Math.exp(-8 * dt));
  }

  /**
   * A swimming mount's altitude: C dives, Space rises, neither floats it back
   * up. The vertical half of `integrateGround` for a water beast — the
   * horizontal half above is shared, because steering is steering.
   *
   * THE SURFACE IS A CEILING AND THE BED IS A FLOOR, and between them there is
   * nothing else: that pair is the whole of "you cannot dive through the world"
   * and "Space is a swim, not a leap out of the sea". Both clamps ask
   * `blockTop`, the same query the ground path uses, so a sunken crate is
   * something the mount rests on down there rather than something it sinks
   * through — the defect issue #32 was about, one medium over.
   */
  private integrateSwim(dt: number): void {
    // The pending Space edge is SPENT rather than left latched. Space means
    // "rise" out here, and a press made under water that stayed pending would
    // fire as a jump on whatever slice the mount reached the shore — a
    // bunny-hop out of the sea, several seconds after the key was pressed.
    this.consumeJump();

    const floatY = this.world.waterLevel - WADE_DEPTH;
    const up = this.input.down('Space') ? 1 : 0;
    const down = this.input.down('KeyC') ? 1 : 0;
    // Damped toward a commanded RATE, the same shape as the flyer's climb, and
    // not an acceleration against a buoyancy the way the hero's dive is: the
    // hero is a body in the water, a water beast is an animal that lives there,
    // and it goes down because it swims down rather than because it stopped
    // floating.
    const want = up || down
      ? up * SWIM_CLIMB - down * SWIM_DIVE
      // Nothing held: the water carries the pair of them back to the surface.
      // Capped — see SWIM_RISE_MAX.
      : Math.min((floatY - this.pos.y) * SWIM_BUOYANCY, SWIM_RISE_MAX);
    this.vy += (want - this.vy) * (1 - Math.exp(-FLY_VY_LAMBDA * dt));
    this.pos.y += this.vy * dt;

    // CEILING FIRST, FLOOR LAST, and the order is load-bearing: in water only
    // just deep enough to swim in, the bed stands ABOVE the float line, and
    // clamping in the other order would push the mount down into the ground it
    // had just been lifted out of.
    if (this.pos.y > floatY) {
      this.pos.y = floatY;
      if (this.vy > 0) this.vy = 0;
    }
    const bed = this.blockTop(this.pos.x, this.pos.z);
    if (this.pos.y <= bed) {
      this.pos.y = bed;
      if (this.vy < 0) this.vy = 0;
      this.grounded = true;
    } else {
      this.grounded = false;
    }
    // Nose down on the way down, up on the way up — the flyer's tilt, at the
    // flyer's gain, because it is the same read: which way is this animal going.
    this.pitch += (clamp(-this.vy * 0.055, -0.35, 0.35) - this.pitch)
      * (1 - Math.exp(-5 * dt));
  }

  /**
   * Would a body at this point be INSIDE a carrier's mass — in the rock rather
   * than over the lawn?
   *
   * `deckAt` and not `topAt` is the whole of this test. `topAt` is a max over
   * the deck and everything standing on it, so a flyer hovering beside a
   * cottage measures as inside the island; refusing his movement there would
   * make a house on a deck a wall to a creature that flies, and shoving him out
   * of it would throw him off the island for approaching a door. Between the
   * turf and the keel there is rock, and nothing else in a carrier is solid to
   * something in the air.
   */
  private inMass(x: number, z: number, y: number): boolean {
    const body = this.world.carriers.bodyAt(x, z);
    if (!body) return false;
    return y > body.bottomAt(x, z) && y < body.deckAt(x, z);
  }

  /**
   * Push a body the frame has moved INTO back out through its flank.
   *
   * OUTWARD FROM THE FRAME'S OWN CENTRE, which for a body that is being run
   * down by an island is the way it is already being pushed: the flank arrives
   * on one bearing, and out along that bearing is both the shortest way clear
   * and the direction the rock is travelling. So the island CARRIES him rather
   * than swallowing him, which is what a moving mass does to something in its
   * way, and he is never lifted over the top — the correction this whole branch
   * exists for.
   *
   * A march rather than a solve, because the outline carries four harmonics and
   * the keel is terraced (world/sky-island.ts): there is no closed form for the
   * exit, and asking the frame's own query is the only answer that cannot
   * disagree with the rock the player can see.
   */
  private shoveOut(body: CarrierInfo): void {
    let ux = this.pos.x - body.x;
    let uz = this.pos.z - body.z;
    const d = Math.hypot(ux, uz);
    // Dead centre: any bearing is as good as any other, and picking one beats
    // dividing by zero. It is a millimetre of the island's own axis.
    if (d < 1e-3) { ux = 0; uz = 1; } else { ux /= d; uz /= d; }
    for (let i = 0; i < SHOVE_STEPS; i++) {
      this.pos.x += ux * SHOVE_STEP;
      this.pos.z += uz * SHOVE_STEP;
      if (!this.inMass(this.pos.x, this.pos.z, this.pos.y)) return;
    }
  }

  private integrateFlying(dt: number): void {
    // PER AXIS, the same shape as the deep-water refusal and as the hero's own
    // step test: a flyer sliding along the island's cliff keeps the half of his
    // speed that is along it and loses only the half that is into it. A single
    // combined test stops him dead against a wall he is mostly travelling past.
    const nx = this.pos.x + this.vel.x * dt;
    const nz = this.pos.z + this.vel.z * dt;
    if (!this.inMass(nx, this.pos.z, this.pos.y)) this.pos.x = nx;
    if (!this.inMass(this.pos.x, nz, this.pos.y)) this.pos.z = nz;

    // Space climbs, C dives, neither holds altitude. Shift is deliberately not
    // involved: it is already sprint-or-grip on foot and a third meaning would
    // make it unreadable.
    const up = this.input.down('Space') ? 1 : 0;
    const down = this.input.down('KeyC') ? 1 : 0;
    const wantVy = up * FLY_CLIMB - down * FLY_DIVE;
    this.vy += (wantVy - this.vy) * (1 - Math.exp(-FLY_VY_LAMBDA * dt));
    this.pos.y += this.vy * dt;

    // The floor is not a suggestion: a flyer steered into a hillside rides up
    // over it rather than through it, and the ceiling stops the climb key from
    // being a lift into empty sky.
    const floor = this.floorFor(this.pos.x, this.pos.z);
    if (this.pos.y < floor) {
      this.pos.y = floor;
      if (this.vy < 0) this.vy = 0;
    }
    // THE CEILING IS CLEARANCE OVER THE GROUND UNDER YOU, and a carrier's deck
    // is ground — which matters here more than anywhere else in this file,
    // because the island is the one place in the world that can ONLY be reached
    // by air. Over low ground the plain ceiling is 68 and the deck is at 78:
    // without this, the flight ceiling forbids the only approach there is.
    // `ceilingAt` and not `ride.support`, deliberately — the mount is not on
    // the island yet, which is the whole point of asking. See CarrierRegistry.
    const overhead = this.world.carriers.ceilingAt(this.pos.x, this.pos.z);
    const ceil = Math.max(
      this.world.getHeight(this.pos.x, this.pos.z), this.world.waterLevel, overhead,
    ) + FLY_CEILING;
    if (this.pos.y > ceil) {
      this.pos.y = ceil;
      if (this.vy > 0) this.vy = 0;
    }
    // A CARRIER IS A SOLID BODY, and until this the only thing one could do to
    // a flyer was hold him up. `ride.support` is gated on being ATTACHED — it
    // has to be, or an island passing overhead would lift a walker off the
    // meadow — and a mount climbing at the keel is by definition not attached
    // yet, so the island simply was not there: you flew in through the rock and
    // sat inside the mountain (issue #80).
    //
    // UNDER THE KEEL IS THE ONLY CASE THIS BRANCH HANDLES, and that is the
    // correction: the first version pushed a body found inside the mass UP onto
    // the deck, which is a teleport onto the island and exactly the thing the
    // report was about read the other way round. Being in the rock is refused
    // horizontally (`inMass`, above) and resolved sideways (`shoveOut`); the
    // only vertical answers are "the keel is a ceiling" and "the deck is a
    // floor", and the second is `floorFor`'s job as it always was.
    //
    // Asked LAST, so it wins over the ceiling above — which `ceilingAt` has
    // deliberately raised near the island to let the approach happen at all.
    const body = this.world.carriers.bodyAt(this.pos.x, this.pos.z);
    if (body) {
      const keel = body.bottomAt(this.pos.x, this.pos.z);
      if (this.pos.y < keel && this.pos.y > keel - FLY_CLEARANCE) {
        // The way up is round the rim and not through the middle, which is the
        // honest reading of a mountain in the sky.
        this.pos.y = keel - FLY_CLEARANCE;
        if (this.vy > 0) this.vy = 0;
      } else if (this.pos.y >= keel && this.pos.y <= body.deckAt(this.pos.x, this.pos.z)) {
        // IN THE MASS, which the two rules above and `inMass` make unreachable
        // by flying — so the island flew into HIM. It carries him along rather
        // than through: the shove is outward, along the flank, and never up.
        this.shoveOut(body);
      }
    }
    this.grounded = false;
    this.pitch += (clamp(-this.vy * 0.055, -0.35, 0.35) - this.pitch)
      * (1 - Math.exp(-5 * dt));
  }

  /** Put the hero in the saddle and tell him which way he is pointing. */
  private seatHero(): void {
    const beast = this.beast!;
    const back = beast.scaledRadius * SEAT_BACK;
    this.player.position.set(
      this.pos.x - Math.sin(this.yaw) * back,
      this.pos.y + beast.saddleY - HERO_HIP_Y,
      this.pos.z - Math.cos(this.yaw) * back,
    );
    this.player.velocity.set(this.vel.x, this.flying ? this.vy : 0, this.vel.z);
    this.player.setRidePose(this.yaw, this.speed01, !this.flying && this.grounded);
  }
}

function refusalText(why: MountRefusal, candidate: BeastActor | null): string {
  switch (why) {
    case 'swimming': return t('toast.mount.refuse.swimming');
    case 'climbing': return t('toast.mount.refuse.climbing');
    case 'beastDead': return candidate
      ? t('toast.mount.refuse.beastDead', { beast: t(candidate.species.nameKey) })
      : t('toast.mount.refuse.noBeast');
    // Named by KIND and not by species: what is missing is the act, and a line
    // about this particular Emberfox would send the player looking for a
    // different ground beast.
    case 'locked': return candidate
      ? t('toast.mount.refuse.locked', {
          kind: t(MOUNT_KIND_KEYS[MOUNT_KIND_OF[candidate.species.locomotion]].name),
        })
      : t('toast.mount.refuse.other');
    default: return t('toast.mount.refuse.other');
  }
}
