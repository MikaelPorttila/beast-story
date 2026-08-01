/**
 * Gamepad support, injected into the same virtual layer the touch overlay uses.
 *
 * Nothing in the game knows a controller exists. `Input` already had everything
 * a third device needs — an analog pair, a look accumulator shared with the
 * mouse, and buttons addressed by their keyboard-equivalent codes — so this
 * module's whole job is to poll the pad and translate. `MountController` still
 * reads `down('KeyF')`; it is simply Y that holds it down now.
 *
 * WHERE THIS IS POLLED MATTERS, and main.ts calls it once per RENDERED frame,
 * before the fixed-step accumulator loop, for two reasons:
 *
 *   - Look delta then behaves exactly like accumulated mouse movement:
 *     integrated over wall-clock, consumed by whichever sim slice runs, and held
 *     across a frame that ran no slices at all (`endFrame` only fires when one
 *     did). Polling per slice instead would multiply the look rate by the slice
 *     count, so the camera would whip on a hitching machine.
 *   - Button edges land before slice 0, which is the slice `first` is true for —
 *     and the hotbar, Tab, the beast cycles and the shop key are ALL gated on
 *     `first`. Poll after it and every discrete action on the pad silently does
 *     nothing.
 *
 * ALLOCATION: `navigator.getGamepads()` allocates a fresh array, and in Chrome a
 * fresh snapshot with fresh `axes`/`buttons` arrays with it. There is no
 * non-allocating form of the API — it is a snapshot API by design. Two things
 * keep it inside the house rule: `poll` returns on its first line until a pad
 * has actually connected, so a keyboard-and-mouse machine never calls it at
 * all, and it is one call per rendered frame rather than up to four.
 */
import type { Input } from './input';

export type PadGlyphs = 'xbox' | 'playstation';

/** Everything the HUD may need to print a button for. */
export type PadAction =
  | 'move' | 'look' | 'jump' | 'attack' | 'interact' | 'mount' | 'dismount'
  | 'swap' | 'altUp' | 'altDown' | 'cyclePrimary' | 'cycleSupport'
  | 'sprint' | 'menu' | 'zoom'
  | 'skill1' | 'skill2' | 'skill3' | 'skill4';

/**
 * Button faces, per vendor.
 *
 * These are DEVICE LABELS, not translations, which is why they live here and
 * not in the string table: the button on an Xbox pad is stamped "A" in every
 * language, and a Swedish player looking down at their hands sees "A". i18n
 * supplies the sentence around them through the existing `{key}` placeholder,
 * exactly as it already does for `kbd('F')`.
 */
export const PAD_GLYPHS: Readonly<Record<PadGlyphs, Readonly<Record<PadAction, string>>>> = {
  xbox: {
    move: 'L', look: 'R', jump: 'A', attack: 'RT', interact: 'X',
    mount: 'Y', dismount: 'Y', swap: 'L3', altUp: 'A', altDown: 'B',
    cyclePrimary: 'RB', cycleSupport: 'LB', sprint: 'LT', menu: 'Start',
    zoom: 'R3', skill1: '↑', skill2: '→', skill3: '↓', skill4: '←',
  },
  playstation: {
    move: 'L', look: 'R', jump: '✕', attack: 'R2', interact: '□',
    mount: '△', dismount: '△', swap: 'L3', altUp: '✕', altDown: '○',
    cyclePrimary: 'R1', cycleSupport: 'L1', sprint: 'L2', menu: 'Options',
    zoom: 'R3', skill1: '↑', skill2: '→', skill3: '↓', skill4: '←',
  },
};

// ---- W3C "standard" mapping indices ---------------------------------------
const B_A = 0, B_B = 1, B_X = 2, B_Y = 3;
const B_LB = 4, B_RB = 5, B_LT = 6, B_RT = 7;
const B_START = 9, B_L3 = 10, B_R3 = 11;
const B_DUP = 12, B_DDOWN = 13, B_DLEFT = 14, B_DRIGHT = 15;
const BUTTON_COUNT = 17;

/**
 * Analog triggers read as buttons past this.
 *
 * Well above a resting trigger's noise and well below the point a player would
 * call "pulled". Sprint and attack are both held actions, so the exact figure
 * only decides how far the finger travels before the action starts, not whether
 * it starts.
 */
const TRIGGER_ON = 0.35;

/**
 * Radial deadzones.
 *
 * 0.22 on the move stick is drift tolerance, not taste: a used controller with a
 * worn potentiometer rests as far out as ~0.18, and anything under that has the
 * hero walking on his own while the pad sits on the table. The look stick can be
 * tighter because a slow drift there reads as a camera easing rather than as the
 * character leaving.
 */
const DZ_MOVE = 0.22;
const DZ_LOOK = 0.15;

/**
 * Response curves past the deadzone.
 *
 * Movement stays LINEAR (1.0) on purpose. The hero's own speed curve already
 * shapes the low end — `Player.update` scales its target speed by the stick
 * magnitude below 0.98 — so squaring here would compound two curves and make a
 * slow walk practically unreachable. The look stick gets the standard console
 * curve instead: fine aim near centre, fast whip at the rim.
 */
const EXPO_MOVE = 1.0;
const EXPO_LOOK = 2.2;

/**
 * Look rate, in the pixels-per-second `Input.addLook` expects.
 *
 * The camera turns `mouseDX * 0.0028` rad of yaw and `mouseDY * 0.0026` of
 * pitch, so these convert to 3.22 rad/s (~184 deg/s) of yaw and 2.03 rad/s of
 * pitch at full deflection. The pitch figure is set from the clamp rather than
 * picked: `ThirdPersonCamera` allows 1.73 rad end to end, so this crosses the
 * whole range in 0.85 s — quick enough to feel connected, slow enough that a
 * full push does not just slam into the stop.
 *
 * Deliberately NOT the touch overlay's 620 px/s. That is a thumb dragging across
 * glass, which is a different gesture with a different natural speed; reusing it
 * here felt like steering through treacle.
 *
 * Both figures are pending a pass on real hardware — the headless probe can
 * assert the rate lands in a band, not that it feels right.
 */
const LOOK_PX_PER_SEC_X = 1150;
const LOOK_PX_PER_SEC_Y = 780;

/**
 * Camera arm presets cycled by R3, spanning the camera's own clamp.
 *
 * Zoom is the one thing with no analog axis left to give it — both sticks and
 * both triggers are committed to things a player uses far more often — so it
 * steps instead of sliding. Index 1 matches `ThirdPersonCamera`'s starting arm,
 * so the first press is a real change either way.
 */
const ZOOM_PRESETS = [3.5, 7.4, 11];
/** `wheelDelta` units per world unit of arm; the camera applies `* 0.01`. */
const WHEEL_PER_UNIT = 100;

/** Scratch for the stick shaper — module level, so polling allocates nothing. */
const _stick = { x: 0, y: 0, mag: 0 };

/**
 * Apply a radial deadzone and response curve to a stick pair.
 *
 * Radial rather than per-axis: a per-axis deadzone squares off the diagonals,
 * so a stick pushed to a corner reports full deflection on both axes and the
 * hero moves faster diagonally than he does straight ahead.
 */
function shape(x: number, y: number, dz: number, expo: number): boolean {
  const mag = Math.hypot(x, y);
  if (mag < dz) { _stick.x = 0; _stick.y = 0; _stick.mag = 0; return false; }
  const n = Math.pow(Math.min(1, (mag - dz) / (1 - dz)), expo);
  _stick.x = (x / mag) * n;
  _stick.y = (y / mag) * n;
  _stick.mag = n;
  return true;
}

/**
 * Which way each look axis runs. See `GamepadControls.setLookAxes`.
 *
 * A partial of this is what a settings screen will hand over; the stored
 * defaults live in core/prefs.ts and the per-load override in core/flags.ts.
 */
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
  private active = false;
  private glyphSet: PadGlyphs = 'xbox';
  private readonly onConnect: (e: GamepadEvent) => void;
  private readonly onDisconnect: (e: GamepadEvent) => void;

  private constructor(
    private input: Input,
    private onSkill?: (index: number) => void,
  ) {
    this.onConnect = (e: GamepadEvent) => {
      // First pad wins and keeps the slot until it goes away. Chrome only
      // surfaces a pad here after its first button press, which is exactly the
      // gesture we want to treat as "a controller is in use" anyway.
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

  /**
   * Wire up gamepad support, or return null where the API does not exist.
   *
   * Returns an instance even with nothing plugged in — a pad can arrive at any
   * point in a session and the connect listener has to be live to catch it. The
   * API is missing entirely on a non-secure origin, which is worth knowing when
   * testing over a LAN IP: everything degrades to keyboard and touch.
   */
  static attach(
    input: Input,
    opts?: { onSkill?: (i: number) => void; look?: Partial<LookAxes> },
  ): GamepadControls | null {
    if (typeof navigator === 'undefined' || typeof navigator.getGamepads !== 'function') return null;
    const g = new GamepadControls(input, opts?.onSkill);
    if (opts?.look) g.setLookAxes(opts.look);
    return g;
  }

  /**
   * Flip either look axis, at any time.
   *
   * A setter rather than a constructor argument because this is destined for a
   * settings toggle: a player changing it mid-session must not have to reload,
   * and nothing here caches a derived value that a later change would miss.
   * Partial, so a caller may set one axis without asserting the other.
   */
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
   * Modal UI (the shop, the dev console) is open: stand the pad down.
   *
   * Mirrors `TouchControls.setVisible(false)`. Everything held is released so a
   * button that happened to be down when the shop opened cannot stay down
   * behind it, and only cancel and confirm keep working — enough to get back
   * out. Choosing an offer is still mouse or touch; see the plan's follow-ups.
   */
  setModal(v: boolean): void {
    if (v === this.modal) return;
    this.modal = v;
    if (v) this.release();
  }

  /** Drop every held mapping and zero the analog state. */
  private release(): void {
    this.input.setStick(0, 0, 'gamepad');
    this.input.setPadLooking(false);
    for (const code of ['Space', 'KeyC', 'KeyF', 'ShiftLeft']) {
      this.input.setVirtualButton(code, false);
    }
    this.input.setVirtualAttack(false);
    this.prev.fill(0);
  }

  poll(dt: number): void {
    // The early-out that keeps a pad-less machine allocation-free. See the
    // header: this is the only guard against getGamepads() every frame.
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

    // Buttons are read for "the pad is the live device" BEFORE the modal branch,
    // because a player working the shop with B and X is on the controller and the
    // footer's hints have to say so. The sticks are stood down while a modal owns
    // the screen, so they are checked on the other side of it.
    //
    // `anyPressed` used to be short-circuited by the one-shot latch and now runs
    // every poll: a bounded scan of 17 buttons with an early exit, next to the
    // `getGamepads()` array this line already allocated.
    if (anyPressed(b)) this.noteUse();

    if (this.modal) {
      // B and Start cancel, X confirms — the two codes main.ts accepts to close
      // the shop. Nothing else reaches the game while a modal owns the screen.
      this.edge(B_B, () => this.input.tapVirtual('Escape'), held);
      this.edge(B_START, () => this.input.tapVirtual('Escape'), held);
      this.edge(B_X, () => this.input.tapVirtual('KeyE'), held);
      this.markPrev(held);
      return;
    }

    // ---- sticks ------------------------------------------------------------
    // Axis 1 is +down, and forward is -y.
    const moving = shape(pad.axes[0], -pad.axes[1], DZ_MOVE, EXPO_MOVE);
    this.input.setStick(_stick.x, _stick.y, 'gamepad');

    // Look inversion, per axis, as a SIGN — never a branch. Both axes go through
    // the same multiply whichever way they are set, so there is no second code
    // path that only one setting exercises and only one setting can regress.
    //
    // Y defaults to inverted (see `setLookAxes`), which is the flight-stick
    // convention a pad wants and nobody wants on a mouse. That the two devices
    // disagree here is correct: the mouse does not pass through this at all.
    // Also not the same question as the touch overlay's flip, which merely
    // cancels its own stick reporting +y as screen-up.
    const looking = shape(
      pad.axes[2] * this.lookSignX, pad.axes[3] * this.lookSignY, DZ_LOOK, EXPO_LOOK,
    );
    if (looking) {
      this.input.addLook(_stick.x * LOOK_PX_PER_SEC_X * dt, _stick.y * LOOK_PX_PER_SEC_Y * dt);
    }
    this.input.setPadLooking(looking);

    // ---- held buttons ------------------------------------------------------
    // Written only on a CHANGE, never every frame. A pad resting at zero must
    // not keep clearing a virtual button, or on a phone with a controller
    // attached it would stamp out the touch overlay's held Space fifty times a
    // second.
    this.hold(B_A, 'Space', held);
    this.hold(B_B, 'KeyC', held);
    this.hold(B_Y, 'KeyF', held);      // mount.ts reads down||pressed: hold AND tap
    this.hold(B_LT, 'ShiftLeft', held);
    if (held(B_RT) !== !!this.prev[B_RT]) this.input.setVirtualAttack(held(B_RT));

    // ---- tapped buttons ----------------------------------------------------
    this.edge(B_X, () => this.input.tapVirtual('KeyE'), held);
    this.edge(B_START, () => this.input.tapVirtual('Escape'), held);
    this.edge(B_L3, () => this.input.tapVirtual('Tab'), held);
    this.edge(B_LB, () => this.input.tapVirtual('BracketLeft'), held);
    this.edge(B_RB, () => this.input.tapVirtual('BracketRight'), held);
    this.edge(B_R3, () => this.stepZoom(), held);
    this.edge(B_DUP, () => this.skill(0), held);
    this.edge(B_DRIGHT, () => this.skill(1), held);
    this.edge(B_DDOWN, () => this.skill(2), held);
    this.edge(B_DLEFT, () => this.skill(3), held);

    // ---- "a controller is in use" -----------------------------------------
    if (moving || looking) this.noteUse();

    this.markPrev(held);
  }

  /**
   * The pad produced input this frame.
   *
   * Two different lifetimes come out of one moment, and conflating them is the
   * bug this split fixes. `input.padActive` is a LATCH — it answers "is there a
   * controller player here", which the start gate and the welcome toast ask once
   * and which must never un-set. `noteSource` is a STAMP — it answers "what is
   * in the player's hands right now", which the HUD's key caps and the rumble
   * gate ask every frame, and which has to hand back to the keyboard the moment
   * the keyboard is touched.
   */
  private noteUse(): void {
    this.input.noteSource('gamepad');
    if (!this.active) {
      this.active = true;
      this.input.padActive = true;
    }
  }

  private hold(i: number, code: string, held: (i: number) => boolean): void {
    const now = held(i);
    if (now !== !!this.prev[i]) this.input.setVirtualButton(code, now);
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

  /**
   * Step the camera arm to the next preset.
   *
   * Expressed as the wheel delta that would have got there, because the arm
   * lives in `ThirdPersonCamera` and `Input` has no window onto it. A player
   * who mixes a mouse wheel and R3 in the same session will find the first R3
   * press jumps rather than steps; a pad player has no wheel to mix.
   */
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

/**
 * Which button faces to print, from the pad's own id string.
 *
 * The id is free-form vendor text, so this matches on the two things that are
 * actually stable: Sony's USB vendor id (054c), which appears in Chrome's
 * "Vendor: 054c Product: ..." form, and the product names. Anything
 * unrecognised gets the Xbox faces, which is both the commoner pad and the
 * layout the W3C standard mapping is named after.
 */
function detectGlyphs(id: string): PadGlyphs {
  return /054c|dualsense|dualshock|playstation|sony/i.test(id) ? 'playstation' : 'xbox';
}
