/**
 * Live graphics toggles: the F3 panel's model. Every row flips on a live frame and
 * persists under `game.settings.graphics.*`. Sinks are injected by main.ts.
 * Adding a toggle is one `GFX_OPTIONS` entry plus one sink method.
 */
import type { StringKey } from '../i18n';

/** Numbers are for the choice rows (fps, foliage distance). */
export type GfxValue = boolean | number;

/** One method per option, so an unimplemented option is a compile error. */
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
  /** Measured saving (walking, 1280x800, 165 Hz display capped at 120). */
  costKey: StringKey;
  /** Absent for a boolean; the allowed values in order for a choice. */
  choices?: readonly number[];
  def: GfxValue;
}

/** Ordered by gain per sacrifice — that order is the advice. Draw counts: tools/test-gfx.mjs. */
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

/** Validate on read: stored text is user-writable and must never yield a NaN cap. */
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

/** One toggle's value with no live `Gfx` — the title screen's settings panel predates it. */
export function storedGfx(id: keyof GfxSinks): GfxValue {
  const opt = GFX_OPTIONS.find((o) => o.id === id);
  return opt ? parse(opt, readRaw(id)) : false;
}

/** Persist without applying. The default is stored as the ABSENCE of a key. */
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

  /** Boot, and again after `exitToTitle` — the rebuilt session has new meshes. */
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
    storeGfx(id, v);
    this.apply(id);
    return v;
  }

  /** Step a choice row, or flip a boolean. */
  cycle(id: keyof GfxSinks): GfxValue {
    const opt = GFX_OPTIONS.find((o) => o.id === id);
    if (!opt) return false;
    if (!opt.choices) return this.set(id, !this.get(id));
    const i = opt.choices.indexOf(Number(this.get(id)));
    return this.set(id, opt.choices[(i + 1) % opt.choices.length]);
  }

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
