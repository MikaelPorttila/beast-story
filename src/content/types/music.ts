/**
 * Music as content — one asset per AREA, and the id IS the area (`music:overworld`).
 * The title screen plays before content loads, so its track stays in audio/music.ts.
 * No asset = the fallback playlist; `"tracks": []` = deliberate silence.
 */

import type { ContentAsset, ContentId, ContentTypeDef, ParseCtx, ValidateCtx } from "../types";
import { bool, list, obj, opt, readerFor, str } from "../schema";

/** The factory kind a `tracks` entry selects. `music-track/overworld`. */
export const MUSIC_TRACK_KIND = "music-track";

/** A track name: the same narrow alphabet as the `name` half of an id. */
const TRACK_RE = /^[a-z][a-z0-9-]*$/;

/** A guard against untrusted JSON: a huge playlist keeps that many URLs live. */
const MAX_TRACKS = 32;

export interface MusicData {
  /** Registered `music-track` names, IN ORDER, wrapping. Empty is legal and means silence. */
  readonly tracks: readonly string[];
  /** The playlist an area with no asset gets. Exactly one, checked below. */
  readonly fallback: boolean;
}

/** Registered track names; null skips the check. See `knownLayouts` in town.ts. */
let knownTracks: ReadonlySet<string> | null = null;

export function setKnownMusicTracks(names: Iterable<string>): void {
  knownTracks = new Set(names);
}

function parse(body: unknown, ctx: ParseCtx): MusicData | null {
  const r = readerFor(ctx);
  const b = obj(body, r);
  return {
    tracks: list(
      (v, c) => str(v, c, { min: 1, max: 64, pattern: TRACK_RE, what: "a music track name" }),
      { max: MAX_TRACKS },
    )(b.tracks, r.at("tracks")),
    fallback: opt(b.fallback, r.at("fallback"), bool) ?? false,
  };
}

/** `tracks` are factory names, not content ids, so they are deliberately not refs. */
function* refs(_data: MusicData): Iterable<ContentId> {}

function validate(asset: ContentAsset<MusicData>, ctx: ValidateCtx): void {
  if (knownTracks !== null) {
    asset.data.tracks.forEach((track, i) => {
      if (knownTracks!.has(track)) {
        return;
      }
      ctx.report({
        severity: "error",
        code: "unknown-factory",
        message: `no "${MUSIC_TRACK_KIND}/${track}" is registered`,
        field: `data.tracks[${i}]`,
        fix: `defineFactory("${MUSIC_TRACK_KIND}", "${track}", url), or use one that exists`,
      });
    });
  }

  // Whole-table rule, run ONCE from the first playlist in load order — see town.ts.
  const all = ctx.content.all<MusicData>("music");
  if (all.length === 0 || all[0].id !== asset.id) {
    return;
  }

  const fallbacks = all.filter((m) => m.data.fallback);
  if (fallbacks.length !== 1) {
    ctx.report({
      severity: "error",
      code: "bad-field",
      message:
        fallbacks.length === 0
          ? 'no music asset declares "fallback": true'
          : `${fallbacks.length} music assets declare "fallback": true (${fallbacks.map((m) => m.id).join(", ")})`,
      field: "data.fallback",
      related: fallbacks.map((m) => m.id),
      fix: "exactly one playlist is what an area with none of its own plays",
    });
    return;
  }

  // Warn: legitimate to mean, but an empty fallback looks exactly like an unwired resolver.
  if (fallbacks[0].data.tracks.length === 0) {
    ctx.report({
      severity: "warn",
      code: "bad-field",
      assetId: fallbacks[0].id,
      message: "the fallback playlist is empty, so an area with no music asset is silent",
      field: "data.tracks",
      fix: "name a track here, or ignore this if silence is what was meant",
    });
  }
}

export const MUSIC_TYPE: ContentTypeDef<MusicData> = {
  name: "music",
  schema: 1,
  parse,
  refs,
  validate,
  template: {
    id: "music:new-area",
    schema: 1,
    data: { tracks: ["overworld"], fallback: false },
  },
};
