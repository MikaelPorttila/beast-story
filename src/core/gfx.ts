/**
 * LIVE GRAPHICS TOGGLES — the F3 panel's model, and the one place that owns
 * what can be turned off, what it costs, and where the answer is stored.
 *
 * WHY THIS IS NOT `flags.ts`. The URL flags next door answer "what is this
 * costing?" for a DEVELOPER: they are read once at construction, they cannot
 * change without a reload, and several of them (`towns=0`, `solids=0`) change
 * the world rather than the picture. These are the same question asked by a
 * PLAYER whose machine is struggling: every one of them flips on a live frame,
 * none of them changes gameplay, and the answer is remembered. A setting that
 * needs a reload to try is a setting nobody tries.
 *
 * WHY IT IS NOT `prefs.ts` EITHER — it stores THROUGH it, under the same
 * `game.settings.graphics.*` convention and the same one-key-per-setting rule,
 * but the shape is different: prefs is a fixed record of named fields that the
 * settings panel renders by hand, and this is a LIST that three surfaces
 * enumerate (the F3 panel, the `/gfx` console command, and `__dbgGfx`). Adding
 * a toggle here is one entry in `OPTIONS` and one line in the sink interface;
 * nothing else has to learn about it.
 *
 * THE SINKS ARE INJECTED, and that is what keeps this file at the bottom of the
 * dependency graph. It knows that "bloom" is a boolean that defaults on and is
 * stored under a key; it does not know what a bloom pass is. main.ts is the
 * composition root and hands over the eleven functions that actually do the work,
 * exactly as it does for FeedbackDeps.
 *
 * EVERY `cost` STRING IS MEASURED, not guessed — walking, 1280x800, on a
 * 165 Hz display with the frame capped at 120. They are in the panel because a
 * toggle with no number beside it is a guess the player has to make, and the
 * measurements are the whole reason this feature exists.
 */
import type { StringKey } from '../i18n';

/** What one option can be. Numbers are for the choice rows (fps, foliage distance). */
export type GfxValue = boolean | number;

/**
 * Everything the panel can switch. Called by the registry, implemented by
 * main.ts against the engine, the world and the post chain.
 *
 * One method per option rather than a generic `set(id, value)` so that adding
 * an option is a COMPILE ERROR until something implements it — the failure mode
 * for the generic form is a row in the panel that quietly does nothing.
 */
export interface GfxSinks {
  grass(on: boolean): void;
  terrainDistance(metres: number): void;
  foliageDistance(metres: number): void;
  props(on: boolean): void;
  shadows(on: boolean): void;
  ao(on: boolean): void;
  bloom(on: boolean): void;
  aa(on: boolean): void;
  clouds(on: boolean): void;
  water(on: boolean): void;
  fpsCap(fps: number): void;
}

export interface GfxOption {
  id: keyof GfxSinks;
  labelKey: StringKey;
  /** Measured saving, shown in the panel. See the note at the top. */
  costKey: StringKey;
  /** Absent for a boolean; the allowed values in order for a choice. */
  choices?: readonly number[];
  def: GfxValue;
}

/**
 * ORDERED BY WHAT YOU GET FOR WHAT YOU GIVE UP, and that ordering IS the advice
 * — it is the closest this panel comes to telling a struggling player what to
 * do. Draw counts are measured by tools/test-gfx.mjs, which flips each row and
 * reads the frame either side of it, so they are re-derivable rather than
 * remembered.
 *
 * The frame cap leads because it is the only row that changes how MANY frames
 * are drawn rather than what one costs: 80.5% of a core to 55.5%, going from a
 * 165 Hz display to 120, with the frame itself unchanged.
 *
 * Then the FINISHING effects, which cost real work and change how the picture
 * is polished rather than what is in it — ambient occlusion (47 draws, because
 * GTAO re-renders the scene into its own depth/normal buffer), glow (23), and
 * antialiasing (three fullscreen quads, small enough that the draw counter
 * cannot see it above its own frame-to-frame variance).
 *
 * Then the WORLD's contents, which are more expensive still and which a player
 * will notice immediately: trees and rocks are 70 draws and grass 44. Grass is
 * also by far the heaviest geometry in the game — roughly 30k vertices a chunk
 * across the streamed set, of about 3.1M triangles in the frame — so it buys
 * more than its draw count suggests on a GPU-bound machine.
 *
 * `shadows` sits between the two groups deliberately. It costs a whole extra
 * render pass, which is more than anything above it, but a voxel world with no
 * contact shadows reads as though every object is floating — so it is offered
 * late, and its cost string says what it takes as well as what it gives.
 *
 * A NOTE ON A NUMBER THAT WAS WRONG. An earlier reading of the F2 overlay
 * attributed all 198 "post" draw calls to bloom. They are the whole post chain,
 * and AO is the larger half of it — bloom alone is 23. The panel says 23.
 */
export const GFX_OPTIONS: readonly GfxOption[] = [
  { id: 'fpsCap', labelKey: 'gfx.fpsCap', costKey: 'gfx.fpsCap.cost', choices: [0, 30, 60, 120, 144], def: 120 },
  { id: 'ao', labelKey: 'gfx.ao', costKey: 'gfx.ao.cost', def: true },
  { id: 'bloom', labelKey: 'gfx.bloom', costKey: 'gfx.bloom.cost', def: true },
  { id: 'aa', labelKey: 'gfx.aa', costKey: 'gfx.aa.cost', def: true },
  { id: 'shadows', labelKey: 'gfx.shadows', costKey: 'gfx.shadows.cost', def: true },
  { id: 'terrainDistance', labelKey: 'gfx.terrainDistance', costKey: 'gfx.terrainDistance.cost', choices: [480, 600, 900], def: 600 },
  { id: 'grass', labelKey: 'gfx.grass', costKey: 'gfx.grass.cost', def: true },
  { id: 'foliageDistance', labelKey: 'gfx.foliageDistance', costKey: 'gfx.foliageDistance.cost', choices: [64, 96, 128], def: 128 },
  { id: 'props', labelKey: 'gfx.props', costKey: 'gfx.props.cost', def: true },
  { id: 'clouds', labelKey: 'gfx.clouds', costKey: 'gfx.clouds.cost', def: true },
  { id: 'water', labelKey: 'gfx.water', costKey: 'gfx.water.cost', def: true },
];

const KEY = (id: string): string => `game.settings.graphics.${id}`;

function readRaw(id: string): string | null {
  try {
    return window.localStorage.getItem(KEY(id));
  } catch {
    return null;   // storage denied: everything falls back to its default
  }
}

function writeRaw(id: string, value: string | null): void {
  try {
    if (value === null) window.localStorage.removeItem(KEY(id));
    else window.localStorage.setItem(KEY(id), value);
  } catch { /* storage denied — the session still honours the value */ }
}

/**
 * Validate on READ, the same rule prefs.ts follows and for the same reason:
 * stored values are user-writable text, and a hand-edited key must land on a
 * default rather than put a NaN into a frame-rate cap.
 */
function parse(opt: GfxOption, raw: string | null): GfxValue {
  if (raw === null || raw.trim() === '') return opt.def;
  if (opt.choices) {
    const v = Number(raw);
    return opt.choices.includes(v) ? v : opt.def;
  }
  if (raw === 'true') return true;
  if (raw === 'false') return false;
  return opt.def;
}

/**
 * One toggle's value, read straight out of storage with no live `Gfx`.
 *
 * The settings panel (ui/settings.ts) is the caller, and it needs this because
 * of WHEN it is shown: the title screen's Settings step is usable all the way
 * through the boot phases, and main.ts does not construct the `Gfx` that owns
 * the sinks until the engine and the world it drives exist. There is nothing to
 * ask at that moment — but there is something to read, and it is the same
 * source of truth `Gfx`'s own constructor reads, because every `set` persists.
 * So a panel that reads here can never disagree with one that read the instance.
 */
export function storedGfx(id: keyof GfxSinks): GfxValue {
  const opt = GFX_OPTIONS.find((o) => o.id === id);
  return opt ? parse(opt, readRaw(id)) : false;
}

/**
 * Persist one toggle WITHOUT applying it — the other half of the pair above.
 *
 * The panel writes here and its host applies through the live `Gfx` when there
 * is one, which is exactly the split a `Prefs` row already has: the panel saves,
 * a hook tells the running game. A change made before the instance exists is
 * picked up when it is built, since that constructor reads storage.
 *
 * The DEFAULT is stored as the ABSENCE of a key, the same rule `Gfx.set` obeys
 * and the reason the two writers share this function rather than each spelling
 * it out — two writers with two opinions about that is two different profiles.
 */
export function storeGfx(id: keyof GfxSinks, value: GfxValue): void {
  const opt = GFX_OPTIONS.find((o) => o.id === id);
  if (!opt) return;
  writeRaw(id, value === opt.def ? null : String(value));
}

export class Gfx {
  private readonly values = new Map<string, GfxValue>();

  constructor(private readonly sinks: GfxSinks) {
    for (const o of GFX_OPTIONS) this.values.set(o.id, parse(o, readRaw(o.id)));
  }

  get(id: keyof GfxSinks): GfxValue {
    return this.values.get(id) ?? GFX_OPTIONS.find((o) => o.id === id)!.def;
  }

  /**
   * Push every current value at the game.
   *
   * Called once at boot and again after `exitToTitle` rebuilds the session —
   * the world's meshes are new objects then, and a visibility flag set on the
   * old ones went with them.
   */
  applyAll(): void {
    for (const o of GFX_OPTIONS) this.apply(o.id);
  }

  /** Set, persist and apply. Returns the value actually stored. */
  set(id: keyof GfxSinks, value: GfxValue): GfxValue {
    const opt = GFX_OPTIONS.find((o) => o.id === id);
    if (!opt) return false;
    const v: GfxValue = opt.choices
      ? (opt.choices.includes(Number(value)) ? Number(value) : opt.def)
      : Boolean(value);
    this.values.set(id, v);
    // The DEFAULT is stored as the absence of a key, which is what keeps
    // "never touched it" distinct from "chose the default" — the same rule
    // prefs.ts states for the language. Through `storeGfx` so the settings
    // panel, which writes without an instance, cannot spell that differently.
    storeGfx(id, v);
    this.apply(id);
    return v;
  }

  /** Step a choice row to its next value, or flip a boolean. For the panel. */
  cycle(id: keyof GfxSinks): GfxValue {
    const opt = GFX_OPTIONS.find((o) => o.id === id);
    if (!opt) return false;
    if (!opt.choices) return this.set(id, !this.get(id));
    const i = opt.choices.indexOf(Number(this.get(id)));
    return this.set(id, opt.choices[(i + 1) % opt.choices.length]);
  }

  /** Put everything back to its default, clearing the stored keys with it. */
  reset(): void {
    for (const o of GFX_OPTIONS) this.set(o.id, o.def);
  }

  private apply(id: keyof GfxSinks): void {
    const v = this.get(id);
    if (id === 'fpsCap' || id === 'terrainDistance' || id === 'foliageDistance') {
      this.sinks[id](Number(v));
    }
    else this.sinks[id](Boolean(v));
  }

  /** For `__dbgGfx` and the `/gfx` command with no arguments. */
  snapshot(): Record<string, GfxValue> {
    const out: Record<string, GfxValue> = {};
    for (const o of GFX_OPTIONS) out[o.id] = this.get(o.id);
    return out;
  }
}
