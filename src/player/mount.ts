import * as THREE from 'three';
import type { Input } from '../core/input';
import type { EventBus, World } from '../core/types';
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
 * decides whether a mount is worth having. 1.85 measured: Emberfox 9.6 (a
 * sprint you can hold forever), Boulderpup 7.8, Sproutle 5.9 — the slow tank
 * really is slower than running, which is the point of picking a mount at all.
 */
const GALLOP = 1.85;
/**
 * Flyers cruise a little more gently than the ground gallop, because they also
 * get a third axis and never have to go around anything: Galebird 12.4 u/s,
 * Frostwing 10.1, Lumimoth 8.1.
 */
const FLY_CRUISE = 1.55;
/**
 * What a water beast is worth IN WATER: the beast's own follow speed times
 * this, against the ground gallop's 1.85 and the hero's 6 on foot / 9.6 at a
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
 * Extra half-width on the collision probe beyond the mount's own body radius,
 * so it is stopped with its shoulder at the rock like the hero is (see
 * BODY_RADIUS in player/index.ts — this world has no horizontal collision
 * geometry beyond these probes).
 */
const BODY_MARGIN = 0.15;
/**
 * How deep a ground mount wades before it is simply held at the surface. There
 * is no swim gait for a mount, so deep water is crossed at a wade rather than
 * walked along the lake bed with the rider underwater.
 */
const WADE_DEPTH = 0.45;

/** Vertical rates for a flyer, world units/s. Descending is a little faster. */
const FLY_CLIMB = 7.0;
const FLY_DIVE = 8.5;
/** Vertical damping toward the commanded rate. */
const FLY_VY_LAMBDA = 6;
/**
 * Clearance a flyer keeps over terrain or water. 1.3 is the mount's own belly
 * height plus a little: the floor clamp below is what guarantees a flying mount
 * can never end up inside a hill it flew at, so it has to sit above the surface
 * rather than on it.
 */
const FLY_CLEARANCE = 1.3;
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

export type MountRefusal = 'swimming' | 'climbing' | 'dead' | 'beastDead' | 'none';

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
   */
  refusal(candidate: BeastActor | null): MountRefusal {
    if (this.player.isDead) return 'dead';
    if (this.player.isSwimming) return 'swimming';
    if (this.player.isClimbing) return 'climbing';
    if (!candidate || candidate.isDead) return 'beastDead';
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
    // reads Space as held altitude instead and never looks at this.
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
    this.pos.y = Math.max(this.blockTop(p.x, p.z), this.world.waterLevel - WADE_DEPTH);
    if (this.flying) this.pos.y = this.floorFor(p.x, p.z);
    this.vel.set(0, 0, 0);
    this.vy = 0;
    this.grounded = !this.flying;
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

    // Step off to the camera's right, clear of the mount's body, and only take
    // the ground there if it is not a wall — otherwise stay where the saddle
    // was and let gravity sort it out.
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
    if (!this.flying && gh <= this.pos.y + MOUNT_STEP_UP) {
      p.set(x, gh, z);
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
      : this.swimmer && this.afloat(this.pos.x, this.pos.z) ? 'swim'
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
    const stepCeil = feetY + MOUNT_STEP_UP;
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

  private integrateFlying(dt: number): void {
    this.pos.x += this.vel.x * dt;
    this.pos.z += this.vel.z * dt;

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
    // Asked LAST, so it wins over the ceiling above — which `ceilingAt` has
    // deliberately raised near the island to let the approach happen at all.
    // `bodyAt` has no `y` in it and cannot move anything on its own; the two
    // faces of the slab decide everything, which is what makes it safe here.
    const body = this.world.carriers.bodyAt(this.pos.x, this.pos.z);
    if (body) {
      const keel = body.bottomAt(this.pos.x, this.pos.z);
      if (this.pos.y < keel) {
        // UNDER IT: the keel is a ceiling, so the way up is round the rim and
        // not through the middle. That is the honest reading of a mountain in
        // the sky, and it is the half that stops the exploit in the report.
        const under = keel - FLY_CLEARANCE;
        if (this.pos.y > under) {
          this.pos.y = under;
          if (this.vy > 0) this.vy = 0;
        }
      } else {
        // IN IT OR OVER IT: the deck is a floor. Same rule as the hillside
        // above — "a flyer steered into a hillside rides up over it rather than
        // through it" — and the same rule the attached case already followed
        // through `floorFor`, now applying one slice earlier, on the approach.
        const deck = body.topAt(this.pos.x, this.pos.z) + FLY_CLEARANCE;
        if (this.pos.y < deck) {
          this.pos.y = deck;
          if (this.vy < 0) this.vy = 0;
        }
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
    default: return t('toast.mount.refuse.other');
  }
}
