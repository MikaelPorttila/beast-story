/**
 * EVERY BINDING IN THE GAME, in one table — the data behind the F1 sheet.
 *
 * THIS TABLE IS DECLARED, NOT DERIVED, and that is the one thing to know about
 * it. A binding is not a value anywhere in this codebase: `Player.update` reads
 * `input.down('ShiftLeft')` in the middle of a climb decision, `mount.ts` reads
 * `KeyF` inside its own hold latch, and `core/gamepad.ts` translates pad buttons
 * into those same codes. There is no registry to walk, so the sheet a player
 * reads is written by hand here.
 *
 * WHICH MEANS: **add or change a binding, and change this file in the same
 * commit.** `tools/test-keybinds.mjs` is the guard — it scans src/ for every
 * `pressed('…')` / `down('…')` / `keys.has('…')` and fails on a code the game
 * reads that no row here names. It cannot catch a MISLABELLED row, so the words
 * are still on you.
 *
 * `codes` is the machine's truth and `caps` is the player's: the game reads
 * `BracketRight`, the player is looking for the key stamped `]`. They are two
 * independent lists rather than a parallel pair — the four hotbar digits are one
 * printed range, `1`–`4`.
 *
 * Caps are DEVICE LABELS, exactly like the pad faces in core/gamepad.ts, and
 * for the same reason: `Space`, `Shift`, `Esc` and `F1` are the letters moulded
 * into the key in every language, and a player looking down at their hands sees
 * them. `LMB`, `Mouse` and `Wheel` sit in the same list — they name a piece of
 * hardware, not an action. Everything that IS a sentence — the action names, the
 * section headings, the HOLD/PRESS chips — is a string-table key.
 */
import type { PadAction } from '../core/gamepad';
import type { StringKey } from '../i18n';

/**
 * Whether the key is TAPPED or LEANED ON.
 *
 * The distinction is the reason the sheet exists rather than a list of keys: F
 * mounts by being held and dismounts by being tapped, Shift only ever does
 * anything while it is down, and a player who taps the key a held action wants
 * concludes the action is broken. `hold` is the highlighted chip in the panel.
 */
export type BindMode = 'press' | 'hold';

export interface Binding {
  /** The action's name, from the string table. */
  label: StringKey;
  /** See `BindMode`. */
  mode: BindMode;
  /**
   * KeyboardEvent codes the game actually reads for this action. Empty for a
   * mouse-only row. This is what tools/test-keybinds.mjs cross-checks against
   * the source; nothing renders it.
   */
  codes: readonly string[];
  /** What is PRINTED on the keyboard side — see the device-label note above. */
  caps: readonly string[];
  /** Separator between caps. Default is a space; `1`–`4` wants a dash. */
  join?: string;
  /** Controller faces, by action, or null where the pad has no binding at all. */
  pad: readonly PadAction[] | null;
  /** One quiet line under the row, for a binding that needs a caveat. */
  note?: StringKey;
}

export interface BindSection {
  title: StringKey;
  rows: readonly Binding[];
}

export const CONTROL_SECTIONS: readonly BindSection[] = [
  {
    title: 'keys.section.movement',
    rows: [
      { label: 'keys.move', mode: 'hold', codes: ['KeyW', 'KeyA', 'KeyS', 'KeyD'], caps: ['WASD'], pad: ['move'] },
      { label: 'keys.look', mode: 'hold', codes: [], caps: ['Mouse'], pad: ['look'] },
      { label: 'keys.sprint', mode: 'hold', codes: ['ShiftLeft'], caps: ['Shift'], pad: ['sprint'] },
      {
        label: 'keys.climb', mode: 'hold', codes: ['ShiftLeft'], caps: ['Shift'], pad: ['sprint'],
        note: 'keys.climb.note',
      },
      { label: 'keys.jump', mode: 'press', codes: ['Space'], caps: ['Space'], pad: ['jump'] },
      { label: 'keys.swim', mode: 'hold', codes: ['Space'], caps: ['Space'], pad: ['jump'] },
      { label: 'keys.zoom', mode: 'press', codes: [], caps: ['Wheel'], pad: ['zoom'] },
    ],
  },
  {
    title: 'keys.section.combat',
    rows: [
      {
        label: 'keys.attack', mode: 'press', codes: [], caps: ['LMB'], pad: ['attack'],
        note: 'keys.attack.note',
      },
      {
        label: 'keys.skills', mode: 'press',
        codes: ['Digit1', 'Digit2', 'Digit3', 'Digit4'], caps: ['1', '4'], join: '–',
        pad: ['skill1', 'skill2', 'skill3', 'skill4'],
      },
    ],
  },
  {
    title: 'keys.section.beasts',
    rows: [
      { label: 'keys.mount', mode: 'hold', codes: ['KeyF'], caps: ['F'], pad: ['mount'] },
      { label: 'keys.dismount', mode: 'press', codes: ['KeyF'], caps: ['F'], pad: ['dismount'] },
      { label: 'keys.ascend', mode: 'hold', codes: ['Space'], caps: ['Space'], pad: ['altUp'] },
      { label: 'keys.descend', mode: 'hold', codes: ['KeyC'], caps: ['C'], pad: ['altDown'] },
      { label: 'keys.swap', mode: 'press', codes: ['Tab'], caps: ['Tab'], pad: ['swap'] },
      { label: 'keys.cycleLead', mode: 'press', codes: ['BracketRight'], caps: [']'], pad: ['cyclePrimary'] },
      { label: 'keys.cycleSupport', mode: 'press', codes: ['BracketLeft'], caps: ['['], pad: ['cycleSupport'] },
      // No pad row, and it is the same story the journal's tells below: every
      // face on a controller is already spoken for — A, B, X, Y, both bumpers,
      // both triggers, both sticks, Start, View and all four d-pad directions —
      // and none of them is worth taking back for this. A pad player reaches the
      // throw through nothing yet; the sheet says so rather than leaving a blank.
      {
        label: 'keys.throwOrb', mode: 'press', codes: ['KeyQ'], caps: ['Q'], pad: null,
        note: 'keys.throwOrb.note',
      },
    ],
  },
  {
    title: 'keys.section.world',
    rows: [
      { label: 'keys.interact', mode: 'press', codes: ['KeyE'], caps: ['E'], pad: ['interact'] },
      // View / Create — button 8, the pad's other middle button and the only
      // face that was unclaimed. See B_SELECT in core/gamepad.ts for why that is
      // the right one rather than merely the free one.
      { label: 'keys.inventory', mode: 'press', codes: ['KeyI'], caps: ['I'], pad: ['inventory'] },
      // No pad row, for the reason spelled out below F1: every face on a
      // controller is already spoken for, and View/Create — the last one that
      // was not — went to the inventory. A pad player reaches the journal
      // through nothing yet; the sheet says so rather than leaving a blank.
      { label: 'keys.journal', mode: 'press', codes: ['KeyJ'], caps: ['J'], pad: null },
      // TWO ROWS, BECAUSE THERE ARE TWO KEYS. F10 opens and closes the in-game
      // menu; Escape dismisses whatever is on top. They were one row and one key
      // until the browser's own claim on Escape — it leaves fullscreen and drops
      // pointer lock over the page's head — made a menu key of it that only
      // worked half the time. Start keeps the menu on a pad, which is why the
      // pad column moved up with it.
      { label: 'keys.menu', mode: 'press', codes: ['F10'], caps: ['F10'], pad: ['menu'] },
      { label: 'keys.cancel', mode: 'press', codes: ['Escape'], caps: ['Esc'], pad: ['cancel'] },
      // No pad row for either: every face on a controller is already spoken for
      // by something a player does far more often, and neither of these is worth
      // taking one back for. The sheet says so rather than leaving a blank.
      { label: 'keys.controls', mode: 'press', codes: ['F1'], caps: ['F1'], pad: null },
      { label: 'keys.debugOverlay', mode: 'press', codes: ['F2'], caps: ['F2'], pad: null },
      { label: 'keys.perfPanel', mode: 'press', codes: ['F3'], caps: ['F3'], pad: null },
      // A HOLD, and the sheet has to say so: keep Alt down and the pointer is
      // yours, let go and the game takes it back. This is exactly the
      // distinction the mode column exists for — a player who reads a hold as a
      // press concludes the game is broken.
      { label: 'keys.cursor', mode: 'hold', codes: ['AltLeft', 'AltRight'], caps: ['Alt'], pad: null },
      // ONE ROW FOR SIX CODES, and it is honest rather than lazy: these do
      // nothing on their own, they steer whatever panel is open, and six rows
      // reading "Arrow up — move up a row" would bury the bindings a player
      // came to this sheet to find. It is also what keeps the scan in
      // tools/test-keybinds.mjs satisfied — every code the game reads has to
      // appear somewhere in this table, and these are read by ui/perf-panel.ts.
      {
        label: 'keys.panelNav',
        mode: 'press',
        codes: ['ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', 'Enter', 'KeyR'],
        caps: ['↑', '↓', '←', '→', 'Enter', 'R'],
        pad: null,
      },
    ],
  },
];
