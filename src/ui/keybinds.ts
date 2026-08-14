/**
 * Every binding in the game, declared by hand — the data behind the F1 sheet.
 * Bindings live inline at their read sites, so there is no registry to derive
 * this from. Add or change a binding and change this file in the same commit;
 * tools/test-keybinds.mjs fails on a code the game reads that no row names.
 */
import type { PadAction } from "../core/gamepad";
import type { StringKey } from "../i18n";

/** Tapped or leaned on. `hold` is the highlighted chip in the panel. */
export type BindMode = "press" | "hold";

export interface Binding {
  label: StringKey;
  mode: BindMode;
  /** Codes the game reads. Empty for a mouse-only row; test-keybinds scans these. */
  codes: readonly string[];
  /** Device labels, as printed on the key — never translated. */
  caps: readonly string[];
  /** Separator between caps. Default is a space; `1`–`4` wants a dash. */
  join?: string;
  /** Controller faces, or null where the pad has no binding at all. */
  pad: readonly PadAction[] | null;
  note?: StringKey;
}

export interface BindSection {
  title: StringKey;
  rows: readonly Binding[];
}

export const CONTROL_SECTIONS: readonly BindSection[] = [
  {
    title: "keys.section.movement",
    rows: [
      {
        label: "keys.move",
        mode: "hold",
        codes: ["KeyW", "KeyA", "KeyS", "KeyD"],
        caps: ["WASD"],
        pad: ["move"],
      },
      { label: "keys.look", mode: "hold", codes: [], caps: ["Mouse"], pad: ["look"] },
      {
        label: "keys.sprint",
        mode: "hold",
        codes: ["ShiftLeft"],
        caps: ["Shift"],
        pad: ["sprint"],
      },
      {
        label: "keys.climb",
        mode: "hold",
        codes: ["ShiftLeft"],
        caps: ["Shift"],
        pad: ["sprint"],
        note: "keys.climb.note",
      },
      { label: "keys.jump", mode: "press", codes: ["Space"], caps: ["Space"], pad: ["jump"] },
      { label: "keys.swim", mode: "hold", codes: ["Space"], caps: ["Space"], pad: ["jump"] },
      { label: "keys.zoom", mode: "press", codes: [], caps: ["Wheel"], pad: ["zoom"] },
    ],
  },
  {
    title: "keys.section.combat",
    rows: [
      {
        label: "keys.attack",
        mode: "press",
        codes: [],
        caps: ["LMB"],
        pad: ["attack"],
        note: "keys.attack.note",
      },
      {
        label: "keys.skills",
        mode: "press",
        codes: ["Digit1", "Digit2", "Digit3", "Digit4"],
        caps: ["1", "4"],
        join: "–",
        pad: ["skill1", "skill2", "skill3", "skill4"],
      },
    ],
  },
  {
    title: "keys.section.beasts",
    rows: [
      { label: "keys.mount", mode: "hold", codes: ["KeyF"], caps: ["F"], pad: ["mount"] },
      { label: "keys.dismount", mode: "press", codes: ["KeyF"], caps: ["F"], pad: ["dismount"] },
      { label: "keys.ascend", mode: "hold", codes: ["Space"], caps: ["Space"], pad: ["altUp"] },
      { label: "keys.descend", mode: "hold", codes: ["KeyC"], caps: ["C"], pad: ["altDown"] },
      { label: "keys.swap", mode: "press", codes: ["Tab"], caps: ["Tab"], pad: ["swap"] },
      {
        label: "keys.cycleLead",
        mode: "press",
        codes: ["BracketRight"],
        caps: ["]"],
        pad: ["cyclePrimary"],
      },
      {
        label: "keys.cycleSupport",
        mode: "press",
        codes: ["BracketLeft"],
        caps: ["["],
        pad: ["cycleSupport"],
      },
      // No pad row: every controller face is already spoken for.
      {
        label: "keys.throwOrb",
        mode: "press",
        codes: ["KeyQ"],
        caps: ["Q"],
        pad: null,
        note: "keys.throwOrb.note",
      },
    ],
  },
  {
    title: "keys.section.world",
    rows: [
      { label: "keys.interact", mode: "press", codes: ["KeyE"], caps: ["E"], pad: ["interact"] },
      // View / Create — see B_SELECT in core/gamepad.ts.
      { label: "keys.inventory", mode: "press", codes: ["KeyI"], caps: ["I"], pad: ["inventory"] },
      { label: "keys.journal", mode: "press", codes: ["KeyJ"], caps: ["J"], pad: null },
      { label: "keys.map", mode: "press", codes: ["KeyM"], caps: ["M"], pad: null },
      // Two keys, two rows: F10 toggles the menu, Escape dismisses the topmost
      // panel. Escape alone was unreliable — the browser claims it.
      { label: "keys.menu", mode: "press", codes: ["F10"], caps: ["F10"], pad: ["menu"] },
      { label: "keys.cancel", mode: "press", codes: ["Escape"], caps: ["Esc"], pad: ["cancel"] },
      { label: "keys.controls", mode: "press", codes: ["F1"], caps: ["F1"], pad: null },
      { label: "keys.debugOverlay", mode: "press", codes: ["F2"], caps: ["F2"], pad: null },
      { label: "keys.perfPanel", mode: "press", codes: ["F3"], caps: ["F3"], pad: null },
      {
        label: "keys.cursor",
        mode: "hold",
        codes: ["AltLeft", "AltRight"],
        caps: ["Alt"],
        pad: null,
      },
      // One row for six panel-navigation codes, read by ui/perf-panel.ts — the
      // test-keybinds scan needs every code named somewhere.
      {
        label: "keys.panelNav",
        mode: "press",
        codes: ["ArrowUp", "ArrowDown", "ArrowLeft", "ArrowRight", "Enter", "KeyR"],
        caps: ["↑", "↓", "←", "→", "Enter", "R"],
        pad: null,
      },
    ],
  },
];
