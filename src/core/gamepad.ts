/**
 * Gamepad support, injected into the virtual layer the touch overlay uses. POLL ONCE PER
 * RENDERED FRAME, before the fixed-step loop: per slice would multiply the look rate, and
 * after it would land button edges past the slice `first` is true for.
 * `navigator.getGamepads()` allocates by design; the early-out in `poll` is the guard.
 */
import type { Input } from './input';

export type PadGlyphs = 'xbox' | 'playstation';

export type PadAction =
  | 'move' | 'look' | 'jump' | 'attack' | 'interact' | 'mount' | 'dismount'
  | 'swap' | 'altUp' | 'altDown' | 'cyclePrimary' | 'cycleSupport'
  // `cancel` shares B with `altDown` but is never printed in the same place.
  | 'sprint' | 'menu' | 'cancel' | 'inventory' | 'zoom'
  | 'skill1' | 'skill2' | 'skill3' | 'skill4';

/** DEVICE LABELS, not translations — an Xbox A is stamped "A" in every language. */
export const PAD_GLYPHS: Readonly<Record<PadGlyphs, Readonly<Record<PadAction, string>>>> = {
  xbox: {
    move: 'L', look: 'R', jump: 'A', attack: 'RT', interact: 'X',
    mount: 'Y', dismount: 'Y', swap: 'L3', altUp: 'A', altDown: 'B',
    cyclePrimary: 'RB', cycleSupport: 'LB', sprint: 'LT', menu: 'Start',
    cancel: 'B',
    inventory: 'View', zoom: 'R3', skill1: '↑', skill2: '→', skill3: '↓', skill4: '←',
  },
  playstation: {
    move: 'L', look: 'R', jump: '✕', attack: 'R2', interact: '□',
    mount: '△', dismount: '△', swap: 'L3', altUp: '✕', altDown: '○',
    cyclePrimary: 'R1', cycleSupport: 'L1', sprint: 'L2', menu: 'Options',
    cancel: '○',
    inventory: 'Create', zoom: 'R3', skill1: '↑', skill2: '→', skill3: '↓', skill4: '←',
  },
};

// W3C "standard" mapping indices.
const B_A = 0, B_B = 1, B_X = 2, B_Y = 3;
const B_LB = 4, B_RB = 5, B_LT = 6, B_RT = 7;
/** View / Create-Share — where a console player already looks for an inventory. */
const B_SELECT = 8;
const B_START = 9, B_L3 = 10, B_R3 = 11;
const B_DUP = 12, B_DDOWN = 13, B_DLEFT = 14, B_DRIGHT = 15;
const BUTTON_COUNT = 17;

/** Analog triggers read as buttons past this — above resting noise, below "pulled". */
const TRIGGER_ON = 0.35;

/** Drift tolerance: a worn potentiometer rests as far out as ~0.18. */
const DZ_MOVE = 0.22;
const DZ_LOOK = 0.15;

/** Movement stays LINEAR — `Player.update` already shapes the low end from the magnitude. */
const EXPO_MOVE = 1.0;
const EXPO_LOOK = 2.2;

/**
 * Look rate in the pixels-per-second `Input.addLook` expects: 3.22 rad/s yaw and 2.03 rad/s
 * pitch at full deflection, the latter set to cross the camera's 1.73 rad clamp in 0.85 s.
 */
const LOOK_PX_PER_SEC_X = 1150;
const LOOK_PX_PER_SEC_Y = 780;

/** Camera arm presets cycled by R3. Index 1 matches `ThirdPersonCamera`'s starting arm. */
const ZOOM_PRESETS = [3.5, 7.4, 11];
/** `wheelDelta` units per world unit of arm; the camera applies `* 0.01`. */
const WHEEL_PER_UNIT = 100;

/** Module-level scratch, so polling allocates nothing. */
const _stick = { x: 0, y: 0, mag: 0 };

/** RADIAL deadzone: a per-axis one squares off the diagonals and speeds up corner pushes. */
function shape(x: number, y: number, dz: number, expo: number): boolean {
  const mag = Math.hypot(x, y);
  if (mag < dz) { _stick.x = 0; _stick.y = 0; _stick.mag = 0; return false; }
  const n = Math.pow(Math.min(1, (mag - dz) / (1 - dz)), expo);
  _stick.x = (x / mag) * n;
  _stick.y = (y / mag) * n;
  _stick.mag = n;
  return true;
}

/** Which way each look axis runs. Defaults in core/prefs.ts, per-load override in flags.ts. */
export interface LookAxes {
  invertX: boolean;
  invertY: boolean;
}

export class GamepadControls {
  private padIndex = -1;
  private pad: Gamepad | null = null;
  /** +1 straight through, -1 inverted. Defaults match DEFAULT_PREFS. */
  private lookSignX = 1;
  private lookSignY = -1;
  private prev = new Uint8Array(BUTTON_COUNT);
  private zoomStep = 1;
  private modal = false;
  /** A modal just closed: re-assert holds on the next poll, which is the next snapshot. */
  private resyncHolds = false;
  private active = false;
  private glyphSet: PadGlyphs = 'xbox';
  private readonly onConnect: (e: GamepadEvent) => void;
  private readonly onDisconnect: (e: GamepadEvent) => void;

  private constructor(
    private input: Input,
    private onSkill?: (index: number) => void,
  ) {
    this.onConnect = (e: GamepadEvent) => {
      // First pad wins and keeps the slot. Chrome only fires this after a button press.
      if (this.padIndex < 0) {
        this.padIndex = e.gamepad.index;
        this.glyphSet = detectGlyphs(e.gamepad.id);
      }
    };
    this.onDisconnect = (e: GamepadEvent) => {
      if (e.gamepad.index !== this.padIndex) return;
      this.padIndex = -1;
      this.pad = null;
      this.release();
    };
    window.addEventListener('gamepadconnected', this.onConnect);
    window.addEventListener('gamepaddisconnected', this.onDisconnect);
  }

  /** Null only where the API is missing (a non-secure origin); otherwise always an instance. */
  static attach(
    input: Input,
    opts?: { onSkill?: (i: number) => void; look?: Partial<LookAxes> },
  ): GamepadControls | null {
    if (typeof navigator === 'undefined' || typeof navigator.getGamepads !== 'function') return null;
    const g = new GamepadControls(input, opts?.onSkill);
    if (opts?.look) g.setLookAxes(opts.look);
    return g;
  }

  /** Live, so a settings change needs no reload. Partial: one axis without the other. */
  setLookAxes(a: Partial<LookAxes>): void {
    if (a.invertX !== undefined) this.lookSignX = a.invertX ? -1 : 1;
    if (a.invertY !== undefined) this.lookSignY = a.invertY ? -1 : 1;
  }

  get lookAxes(): LookAxes {
    return { invertX: this.lookSignX < 0, invertY: this.lookSignY < 0 };
  }

  get connected(): boolean { return this.padIndex >= 0 && this.pad !== null; }
  /** The snapshot from this frame's poll — the haptics channel rumbles through it. */
  get current(): Gamepad | null { return this.pad; }
  get glyphs(): PadGlyphs { return this.glyphSet; }

  /**
   * A modal is open: stand the pad down, leaving cancel and confirm. `prev` MUST NOT be
   * touched — zeroing the edge history makes a still-held button look newly pressed.
   */
  setModal(v: boolean): void {
    if (v === this.modal) return;
    this.modal = v;
    if (v) this.release();
    // Coming out, holds must be re-asserted: `hold()` only writes on a CHANGE, and a
    // trigger held through the modal has not changed.
    else this.resyncHolds = true;
  }

  private release(): void {
    this.input.setStick(0, 0, 'gamepad');
    this.input.setPadLooking(false);
    for (const code of ['Space', 'KeyC', 'KeyF', 'ShiftLeft']) {
      this.input.setVirtualButton(code, false);
    }
    this.input.setVirtualAttack(false);
  }

  poll(dt: number): void {
    // The only guard against getGamepads() every frame on a pad-less machine.
    if (this.padIndex < 0) return;

    const pad = navigator.getGamepads()[this.padIndex];
    if (!pad || !pad.connected || pad.axes.length < 4) {
      this.pad = null;
      return;
    }
    this.pad = pad;

    const b = pad.buttons;
    const held = (i: number): boolean =>
      i < b.length && (b[i].pressed || b[i].value > TRIGGER_ON);

    // Read BEFORE the modal branch: a player working a panel with B and X is on the pad.
    if (anyPressed(b)) this.noteUse();

    if (this.modal) {
      // B and Start cancel, X confirms. Start sends its own key so the button that opened
      // the menu closes it; B keeps Escape, the back the panels answer for.
      this.edge(B_B, () => this.input.tapVirtual('Escape'), held);
      this.edge(B_START, () => this.input.tapVirtual('F10'), held);
      this.edge(B_X, () => this.input.tapVirtual('KeyE'), held);
      // View/Create is the only other key through a modal: it closes the inventory too.
      this.edge(B_SELECT, () => this.input.tapVirtual('KeyI'), held);
      this.markPrev(held);
      return;
    }

    // Axis 1 is +down, and forward is -y.
    const moving = shape(pad.axes[0], -pad.axes[1], DZ_MOVE, EXPO_MOVE);
    this.input.setStick(_stick.x, _stick.y, 'gamepad');

    // Inversion is a SIGN, never a branch, so no setting gets its own code path.
    // Y defaults inverted: the flight-stick convention, and the mouse never comes here.
    const looking = shape(
      pad.axes[2] * this.lookSignX, pad.axes[3] * this.lookSignY, DZ_LOOK, EXPO_LOOK,
    );
    if (looking) {
      this.input.addLook(_stick.x * LOOK_PX_PER_SEC_X * dt, _stick.y * LOOK_PX_PER_SEC_Y * dt);
    }
    this.input.setPadLooking(looking);

    // Held buttons are written only on a CHANGE: a pad resting at zero must not keep
    // clearing the touch overlay's own virtual buttons. `force` covers a modal closing.
    const force = this.resyncHolds;
    this.resyncHolds = false;
    this.hold(B_A, 'Space', held, force);
    this.hold(B_B, 'KeyC', held, force);
    this.hold(B_Y, 'KeyF', held, force);      // mount.ts reads down||pressed: hold AND tap
    this.hold(B_LT, 'ShiftLeft', held, force);
    if (force || held(B_RT) !== !!this.prev[B_RT]) this.input.setVirtualAttack(held(B_RT));

    this.edge(B_X, () => this.input.tapVirtual('KeyE'), held);
    // The menu answers to F10, not Escape — the browser spends Escape on fullscreen and
    // pointer lock over the page's head (see core/input.ts).
    this.edge(B_START, () => this.input.tapVirtual('F10'), held);
    this.edge(B_SELECT, () => this.input.tapVirtual('KeyI'), held);
    this.edge(B_L3, () => this.input.tapVirtual('Tab'), held);
    this.edge(B_LB, () => this.input.tapVirtual('BracketLeft'), held);
    this.edge(B_RB, () => this.input.tapVirtual('BracketRight'), held);
    this.edge(B_R3, () => this.stepZoom(), held);
    this.edge(B_DUP, () => this.skill(0), held);
    this.edge(B_DRIGHT, () => this.skill(1), held);
    this.edge(B_DDOWN, () => this.skill(2), held);
    this.edge(B_DLEFT, () => this.skill(3), held);

    if (moving || looking) this.noteUse();

    this.markPrev(held);
  }

  /** `padActive` is a LATCH that never un-sets; `noteSource` a stamp the keyboard takes back. */
  private noteUse(): void {
    this.input.noteSource('gamepad');
    if (!this.active) {
      this.active = true;
      this.input.padActive = true;
    }
  }

  private hold(i: number, code: string, held: (i: number) => boolean, force = false): void {
    const now = held(i);
    if (force || now !== !!this.prev[i]) this.input.setVirtualButton(code, now);
  }

  private edge(i: number, fn: () => void, held: (i: number) => boolean): void {
    if (held(i) && !this.prev[i]) fn();
  }

  private markPrev(held: (i: number) => boolean): void {
    for (let i = 0; i < BUTTON_COUNT; i++) this.prev[i] = held(i) ? 1 : 0;
  }

  private skill(index: number): void {
    this.input.tapVirtual(`Digit${index + 1}`);
    this.onSkill?.(index);
  }

  /** Sent as the wheel delta that would get there — the arm lives in `ThirdPersonCamera`. */
  private stepZoom(): void {
    const from = ZOOM_PRESETS[this.zoomStep];
    this.zoomStep = (this.zoomStep + 1) % ZOOM_PRESETS.length;
    this.input.addWheel((ZOOM_PRESETS[this.zoomStep] - from) * WHEEL_PER_UNIT);
  }

  /** Read-only snapshot for `__dbgPad`. Allocates; not for the frame loop. */
  debugState(): unknown {
    return {
      connected: this.connected,
      id: this.pad?.id ?? null,
      mapping: this.pad?.mapping ?? null,
      glyphs: this.glyphSet,
      active: this.active,
      modal: this.modal,
      zoomStep: this.zoomStep,
      invertLookX: this.lookSignX < 0,
      invertLookY: this.lookSignY < 0,
      axes: this.pad ? Array.from(this.pad.axes) : [],
      pressed: this.pad
        ? this.pad.buttons.map((x, i) => (x.pressed || x.value > TRIGGER_ON ? i : -1)).filter((i) => i >= 0)
        : [],
    };
  }

  dispose(): void {
    window.removeEventListener('gamepadconnected', this.onConnect);
    window.removeEventListener('gamepaddisconnected', this.onDisconnect);
    this.release();
    this.padIndex = -1;
    this.pad = null;
  }
}

function anyPressed(b: readonly GamepadButton[]): boolean {
  for (let i = 0; i < b.length; i++) if (b[i].pressed || b[i].value > TRIGGER_ON) return true;
  return false;
}

/** The pad id is free-form, so match Sony's vendor id (054c) and product names; else Xbox. */
function detectGlyphs(id: string): PadGlyphs {
  return /054c|dualsense|dualshock|playstation|sony/i.test(id) ? 'playstation' : 'xbox';
}
