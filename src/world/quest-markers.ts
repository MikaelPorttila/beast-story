/**
 * WHO TO TALK TO, AND WHAT TO GO AND DO IT TO — the floating marks over a quest
 * giver and over the things a quest is counting.
 *
 * A SPRITE IN THE WORLD, NOT A DIV OVER IT, and that is this file's one
 * structural decision. The alternative was projecting a world position into
 * screen space and moving a DOM node, which the cursor director already does
 * once (`screenGap` in main.ts) — but a DOM marker has to be re-projected every
 * frame for every marked thing, cannot be occluded by the hut the NPC is
 * standing behind, and would be the first HUD element in this project anchored
 * to a world position. A sprite is billboarded by three, depth-tested for free,
 * and lands beside the two precedents already in the scene: the shop's element
 * glyph (world/shops.ts) and an enemy's health bar (combat/enemies.ts).
 *
 * THE MARKS ARE POOLED AND THE POOL IS THE ONLY ALLOCATION. `set()` is called
 * every frame with however many spots the campaign currently wants; sprites
 * above that count are hidden rather than destroyed, and the array of spots is
 * the caller's own scratch (see `questMarkerSpots` in main.ts). Nothing here
 * allocates per frame except the first time a pool slot is needed.
 *
 * WHAT THE THREE KINDS MEAN, and the words are the player's rather than ours:
 *   offer   — this person has work for you.            A filled "!".
 *   turnIn  — you have done it; go back and say so.    A filled "?".
 *   target  — this is the thing the quest is counting. A ring.
 * The first two are gold because a main quest's dot on the tracker is gold; the
 * third is white, because it is a fact about the world rather than about a
 * person, and a third colour would be a third thing to learn.
 */

import * as THREE from "three";

export type QuestMarkerKind = "offer" | "turnIn" | "target";

/** One mark, in WORLD coordinates. `y` is where the mark floats, not the feet. */
export interface QuestMarkerSpot {
  x: number;
  y: number;
  z: number;
  kind: QuestMarkerKind;
}

/** How far a mark is still drawn. Past this it is a pixel of clutter. */
const MAX_DIST = 90;

/** Bob amplitude and rate — the same gentle idle the shop glyph has. */
const BOB_AMP = 0.11;
const BOB_RATE = 2.2;

const SIZE = 64;

/**
 * One glyph, painted once and cached.
 *
 * Drawn rather than typed: a canvas `fillText` would put whatever font the
 * device has under a mark the player is meant to read at a glance, and the two
 * shapes here are a stroke and a couple of arcs.
 */
function glyphTexture(kind: QuestMarkerKind): THREE.Texture {
  const canvas = document.createElement("canvas");
  canvas.width = SIZE;
  canvas.height = SIZE;
  const ctx = canvas.getContext("2d")!;
  const gold = "#ffc44d";
  const ink = kind === "target" ? "#ffffff" : gold;

  ctx.strokeStyle = "rgba(0,0,0,0.55)";
  ctx.fillStyle = ink;
  ctx.lineJoin = "round";
  ctx.lineWidth = 5;

  if (kind === "target") {
    // A RING, not a filled disc: it sits over an animal that is moving, and a
    // solid dot at this size reads as a hole in the beast rather than a mark on
    // it. Two strokes, dark under bright, so it holds on snow and on grass.
    ctx.beginPath();
    ctx.arc(32, 32, 19, 0, Math.PI * 2);
    ctx.lineWidth = 12;
    ctx.strokeStyle = "rgba(0,0,0,0.5)";
    ctx.stroke();
    ctx.lineWidth = 7;
    ctx.strokeStyle = ink;
    ctx.stroke();
    return finish(canvas);
  }

  // The stem of "!" and of "?" are the same bar and the same dot; only the head
  // differs, which is what keeps the two readable as one family.
  const stroke = (fn: () => void): void => {
    ctx.beginPath();
    fn();
    ctx.lineWidth = 13;
    ctx.strokeStyle = "rgba(0,0,0,0.5)";
    ctx.stroke();
    ctx.lineWidth = 7;
    ctx.strokeStyle = ink;
    ctx.stroke();
  };

  if (kind === "offer") {
    stroke(() => {
      ctx.moveTo(32, 9);
      ctx.lineTo(32, 38);
    });
  } else {
    stroke(() => {
      ctx.moveTo(21, 19);
      ctx.arc(32, 19, 11, Math.PI, Math.PI * 2);
      ctx.lineTo(43, 22);
      ctx.quadraticCurveTo(43, 31, 32, 34);
      ctx.lineTo(32, 38);
    });
  }
  // The dot, both kinds.
  ctx.beginPath();
  ctx.arc(32, 52, 6.5, 0, Math.PI * 2);
  ctx.fillStyle = "rgba(0,0,0,0.5)";
  ctx.arc(32, 52, 6.5, 0, Math.PI * 2);
  ctx.fill();
  ctx.beginPath();
  ctx.arc(32, 52, 4.5, 0, Math.PI * 2);
  ctx.fillStyle = ink;
  ctx.fill();
  return finish(canvas);
}

function finish(canvas: HTMLCanvasElement): THREE.Texture {
  const tex = new THREE.CanvasTexture(canvas);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.minFilter = THREE.LinearFilter;
  tex.generateMipmaps = false;
  return tex;
}

/**
 * The marks currently in the world.
 *
 * Owned by the composition root, which is the only place that knows what a
 * quest is AND what an NPC is (main.ts). This class knows neither: it is handed
 * positions and kinds and draws them.
 */
export class QuestMarkers {
  private readonly sprites: THREE.Sprite[] = [];
  private readonly materials = new Map<QuestMarkerKind, THREE.SpriteMaterial>();
  private readonly textures: THREE.Texture[] = [];
  private time = 0;

  constructor(private readonly scene: THREE.Scene) {}

  private material(kind: QuestMarkerKind): THREE.SpriteMaterial {
    const had = this.materials.get(kind);
    if (had) {
      return had;
    }
    const map = glyphTexture(kind);
    this.textures.push(map);
    const mat = new THREE.SpriteMaterial({
      map,
      transparent: true,
      // NOT depth-written, and depth-TESTED: a mark behind a hut is behind the
      // hut. An always-on-top marker is a wallhack the player did not ask for,
      // and the compass already answers "which way", which is the question you
      // ask about something you cannot see.
      depthWrite: false,
      toneMapped: false,
    });
    this.materials.set(kind, mat);
    return mat;
  }

  /** Advance the idle bob. Seconds, from the frame loop. */
  update(dt: number): void {
    this.time += dt;
  }

  /**
   * Draw exactly these marks, reusing the pool.
   *
   * `camera` is only used to cull by distance — the sprites billboard
   * themselves, so nothing here touches the camera's orientation.
   */
  set(spots: readonly QuestMarkerSpot[], count: number, camera: THREE.Camera): void {
    let used = 0;
    for (let i = 0; i < count; i++) {
      const spot = spots[i];
      const dx = spot.x - camera.position.x;
      const dz = spot.z - camera.position.z;
      if (dx * dx + dz * dz > MAX_DIST * MAX_DIST) {
        continue;
      }
      let sprite = this.sprites[used];
      if (!sprite) {
        sprite = new THREE.Sprite(this.material(spot.kind));
        sprite.renderOrder = 14;
        this.scene.add(sprite);
        this.sprites.push(sprite);
      }
      sprite.material = this.material(spot.kind);
      sprite.position.set(
        spot.x,
        spot.y + Math.sin(this.time * BOB_RATE + spot.x * 0.7) * BOB_AMP,
        spot.z,
      );
      sprite.scale.setScalar(spot.kind === "target" ? 0.5 : 0.62);
      sprite.visible = true;
      used++;
    }
    for (let i = used; i < this.sprites.length; i++) {
      this.sprites[i].visible = false;
    }
  }

  dispose(): void {
    for (const s of this.sprites) {
      this.scene.remove(s);
    }
    this.sprites.length = 0;
    for (const m of this.materials.values()) {
      m.dispose();
    }
    this.materials.clear();
    for (const t of this.textures) {
      t.dispose();
    }
    this.textures.length = 0;
  }
}
