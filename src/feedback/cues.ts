/**
 * The cue table: what each gameplay moment feels like.
 *
 * One table, so tuning the game's feel is an edit here rather than a hunt
 * through combat and player code for the call that shakes the camera. Every
 * number is per-cue and multiplied by the player's own intensity preferences at
 * drain time (see FeedbackSystem), so a player who turns rumble down turns ALL
 * of it down proportionally rather than losing the quiet cues first.
 */

export type CueKind =
  | 'playerHurt' | 'playerDied' | 'playerLanded'
  | 'hit' | 'hitCrit' | 'hitSuper' | 'kill'
  | 'mounted' | 'levelUp' | 'pickup'
  | 'orbThrow' | 'orbWobble' | 'tameSuccess' | 'tameFail';

export interface CueSpec {
  /** Heavy motor, at intensity 0. */
  strong: number;
  /** Added to `strong` at intensity 1. Zero means the cue does not scale. */
  strongGain: number;
  /** Light motor — the "tick" channel; it reads as sharpness, not weight. */
  weak: number;
  /** Envelope length, seconds. */
  dur: number;
  /** Camera trauma added, on the same 0..1 scale `addShake` clamps to. */
  shake: number;
  /** Minimum intensity before the shake fires at all. See `playerLanded`. */
  shakeMin: number;
}

/**
 * TUNING NOTES, since these are exactly the constants that go stale silently:
 *
 * The shake figures for `playerHurt` (0.32), `playerDied` (0.5) and
 * `playerLanded` (0.15) are NOT new. They are the three values that lived as
 * literal `cam.addShake()` calls in player/index.ts, moved here unchanged so
 * that the camera keeps behaving exactly as it did while gaining a second
 * channel alongside it. If the feel of being hit changes, this is the table
 * that changed it — the camera code did not.
 *
 * `playerLanded` carries `shakeMin` because the old code had TWO thresholds
 * that did not agree: the hero's body squash starts at a fall of -7 units/s
 * while the camera shake only started at -15. Reproduced rather than tidied
 * away, because a gentle hop compressing the hero without kicking the camera is
 * correct, and 0.6 is where the old -15 lands on the 0..1 landing ramp.
 *
 * The weak motor carries the light, fast cues (`hit`, `pickup`) and the strong
 * motor carries weight (`playerHurt`, `mounted`). A hit landing on an ENEMY is
 * deliberately faint and short: it happens several times a second in a fight,
 * and anything with presence turns a skirmish into a massage chair. What should
 * stand out is what happens to YOU, which is why `playerHurt` is the only cue
 * that both scales with severity and pushes the heavy motor hard.
 */
export const CUES: Readonly<Record<CueKind, CueSpec>> = {
  // The headline. Scales with the share of the health bar the hit took, so a
  // scratch and a near-death land differently in the hands.
  playerHurt: { strong: 0.45, strongGain: 0.40, weak: 0.35, dur: 0.18, shake: 0.32, shakeMin: 0 },
  playerDied: { strong: 1.00, strongGain: 0, weak: 0.80, dur: 0.45, shake: 0.50, shakeMin: 0 },
  playerLanded: { strong: 0, strongGain: 0.30, weak: 0.10, dur: 0.10, shake: 0.15, shakeMin: 0.6 },

  hit: { strong: 0, strongGain: 0, weak: 0.22, dur: 0.06, shake: 0, shakeMin: 0 },
  hitCrit: { strong: 0.35, strongGain: 0, weak: 0.45, dur: 0.10, shake: 0, shakeMin: 0 },
  hitSuper: { strong: 0.28, strongGain: 0, weak: 0.40, dur: 0.12, shake: 0, shakeMin: 0 },
  kill: { strong: 0.40, strongGain: 0, weak: 0.25, dur: 0.14, shake: 0, shakeMin: 0 },

  mounted: { strong: 0.50, strongGain: 0, weak: 0.30, dur: 0.25, shake: 0, shakeMin: 0 },
  levelUp: { strong: 0.20, strongGain: 0, weak: 0.35, dur: 0.30, shake: 0, shakeMin: 0 },
  pickup: { strong: 0, strongGain: 0, weak: 0.12, dur: 0.05, shake: 0, shakeMin: 0 },

  // THE BOND, and its four moments. The whole point of the ceremony is two
  // seconds in which the player does not know yet (see combat/taming.ts), so
  // these are tuned as a RISE and read as one gesture rather than four cues.
  //
  // The throw is the lightest thing in the table after `pickup`: it is a lob,
  // not a shot, and anything with weight would make it feel like firing a gun.
  orbThrow: { strong: 0, strongGain: 0, weak: 0.16, dur: 0.07, shake: 0, shakeMin: 0 },
  // Each wobble is a knock, and `strongGain` is what makes the THIRD one hit
  // harder than the first — FeedbackSystem scales it by the intensity the
  // emitter passes, and main.ts passes the wobble's own index. That ramp is the
  // suspense, and it is the reason this cue scales at all when `hit` does not.
  orbWobble: { strong: 0.22, strongGain: 0.30, weak: 0.18, dur: 0.09, shake: 0.04, shakeMin: 0 },
  // Kept: a bigger, longer thump than `levelUp`, because bonding a beast is the
  // rarest good thing that happens in the game and the one the mechanic is for.
  tameSuccess: { strong: 0.55, strongGain: 0, weak: 0.45, dur: 0.35, shake: 0.10, shakeMin: 0 },
  // Broke: short and hard, and then nothing. A failure should stop rather than
  // fade — a long envelope on a loss reads as the game commiserating.
  tameFail: { strong: 0.40, strongGain: 0, weak: 0.20, dur: 0.12, shake: 0.08, shakeMin: 0 },
};
