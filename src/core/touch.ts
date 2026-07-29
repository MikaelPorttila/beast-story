import type { Input } from './input';

/**
 * Touch controls: a left analog stick for movement, a right look-drag pad, and
 * action buttons (attack, jump, interact, four skills, pal swap).
 *
 * The overlay is only created on devices that actually have a touch screen; on
 * mouse/keyboard machines `TouchControls.attach` returns null and nothing is
 * added to the DOM, so there is no overlay and no per-frame cost.
 */

/**
 * True only when touch is the device's PRIMARY pointer.
 *
 * Note `'ontouchstart' in window` is useless for this: desktop Chrome exposes
 * touch events regardless of hardware, so testing it puts a joystick overlay on
 * every desktop. Touch points plus a coarse primary pointer is the reliable
 * signal. Hybrid machines (touchscreen laptop with a mouse) report a *fine*
 * primary pointer and are handled by lazy activation instead — see `attach`.
 */
export function isTouchPrimary(): boolean {
  if (typeof window === 'undefined') return false;
  const points = navigator.maxTouchPoints ?? 0;
  const coarse = window.matchMedia?.('(pointer: coarse)').matches ?? false;
  return points > 0 && coarse;
}

/** True when the hardware can produce touches at all (may also have a mouse). */
export function hasTouchCapability(): boolean {
  return (navigator.maxTouchPoints ?? 0) > 0;
}

const CSS = `
/* The overlay always covers the game viewport — it is fixed to the viewport and
   sized in dvw/dvh so it lies ON TOP of the canvas in both orientations rather
   than ever being laid out beside it. */
.cp-touch{position:fixed;left:0;top:0;width:100vw;width:100dvw;height:100vh;height:100dvh;
  z-index:30;pointer-events:none;touch-action:none;overflow:hidden;
  font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,sans-serif;
  -webkit-user-select:none;user-select:none;-webkit-tap-highlight-color:transparent}
.cp-touch.hidden{display:none}

/* Twin sticks, one per bottom corner: left = movement, right = camera. */
.cp-stick{position:absolute;bottom:max(24px,env(safe-area-inset-bottom));
  width:min(30vw,130px);aspect-ratio:1;pointer-events:auto;border-radius:50%;
  background:radial-gradient(circle,rgba(255,255,255,.09),rgba(255,255,255,.03) 70%);
  border:1px solid rgba(255,255,255,.16);transition:opacity .2s ease;opacity:.5}
.cp-stick.move{left:max(24px,env(safe-area-inset-left))}
.cp-stick.look{right:max(24px,env(safe-area-inset-right))}
.cp-stick.active{opacity:1}
.cp-stick .knob{position:absolute;left:50%;top:50%;width:38%;aspect-ratio:1;margin:0;
  transform:translate(-50%,-50%);border-radius:50%;
  background:radial-gradient(circle at 36% 30%,rgba(255,255,255,.9),rgba(210,228,245,.55) 60%,rgba(150,180,210,.4));
  box-shadow:0 4px 14px rgba(0,0,0,.4),inset 0 1px 0 rgba(255,255,255,.6)}
/* tiny glyph so the two sticks are distinguishable at a glance */
.cp-stick .tag{position:absolute;left:50%;bottom:8%;transform:translateX(-50%);
  font-size:9px;font-weight:800;letter-spacing:.14em;color:rgba(255,255,255,.5)}

/* Action buttons and skills live in the middle, clear of both corner sticks. */
.cp-btns{position:absolute;left:50%;transform:translateX(-50%);
  bottom:calc(max(24px,env(safe-area-inset-bottom)) + min(30vw,130px) + 30px);
  display:flex;gap:10px;pointer-events:none}
.cp-btn{pointer-events:auto;display:grid;place-items:center;border-radius:50%;
  width:clamp(44px,12vw,62px);aspect-ratio:1;
  background:linear-gradient(165deg,rgba(34,44,62,.82),rgba(16,20,30,.88));
  border:1px solid rgba(255,255,255,.18);color:#eef2f8;
  font-weight:800;font-size:clamp(9px,2.4vw,11px);letter-spacing:.04em;
  box-shadow:0 6px 18px rgba(0,0,0,.42),inset 0 1px 0 rgba(255,255,255,.1);
  backdrop-filter:blur(8px);-webkit-backdrop-filter:blur(8px);
  transition:transform .08s ease,filter .08s ease}
.cp-btn:active,.cp-btn.on{transform:scale(.92);filter:brightness(1.5)}
.cp-btn.attack{background:linear-gradient(165deg,rgba(214,86,52,.9),rgba(150,48,26,.92))}
.cp-btn.swap{background:linear-gradient(165deg,rgba(52,96,150,.85),rgba(24,52,92,.9))}

.cp-skills{position:absolute;left:50%;transform:translateX(-50%);
  bottom:calc(max(24px,env(safe-area-inset-bottom)) + 8px);
  display:flex;gap:8px;pointer-events:none}
.cp-skill{pointer-events:auto;width:clamp(40px,11vw,52px);aspect-ratio:1;border-radius:14px;
  display:grid;place-items:center;font-weight:900;font-size:clamp(12px,3.2vw,15px);color:#eef2f8;
  background:linear-gradient(165deg,rgba(30,38,54,.8),rgba(14,18,28,.86));
  border:1px solid rgba(255,255,255,.16);
  box-shadow:0 5px 14px rgba(0,0,0,.38),inset 0 1px 0 rgba(255,255,255,.09);
  backdrop-filter:blur(8px);-webkit-backdrop-filter:blur(8px);
  transition:transform .08s ease,filter .08s ease}
.cp-skill:active{transform:scale(.9);filter:brightness(1.5)}

/* Portrait / narrow: the gap between the corner sticks is too small for the
   centre rows, so they stack ABOVE the sticks instead of between them. */
@media (max-aspect-ratio: 1/1){
  .cp-skills{bottom:calc(max(24px,env(safe-area-inset-bottom)) + min(30vw,130px) + 30px)}
  .cp-btns{bottom:calc(max(24px,env(safe-area-inset-bottom)) + min(30vw,130px) + 30px
    + clamp(40px,11vw,52px) + 14px)}
}

/* Short landscape phones: shrink so the whole cluster stays over the viewport. */
@media (max-height: 460px){
  .cp-stick{width:min(24vh,112px);bottom:max(16px,env(safe-area-inset-bottom))}
  .cp-stick.move{left:max(16px,env(safe-area-inset-left))}
  .cp-stick.look{right:max(16px,env(safe-area-inset-right))}
  .cp-btns{gap:8px;bottom:calc(max(16px,env(safe-area-inset-bottom))
    + clamp(40px,11vw,52px) + 22px)}
  .cp-skills{gap:7px;bottom:calc(max(16px,env(safe-area-inset-bottom)) + 8px)}
}
`;

interface StickState {
  id: number;
  cx: number;
  cy: number;
  radius: number;
}

/** One joystick widget: its DOM, its active touch and its normalized output. */
class Stick {
  readonly el: HTMLDivElement;
  private knob: HTMLDivElement;
  private active: StickState | null = null;
  /** -1..1, +y is screen-up */
  x = 0;
  y = 0;

  constructor(kind: 'move' | 'look', tag: string, onChange: () => void) {
    this.el = document.createElement('div');
    this.el.className = `cp-stick ${kind}`;
    this.knob = document.createElement('div');
    this.knob.className = 'knob';
    this.el.appendChild(this.knob);
    const label = document.createElement('div');
    label.className = 'tag';
    label.textContent = tag;
    this.el.appendChild(label);

    this.el.addEventListener('touchstart', (e) => {
      if (this.active) return;
      const t = e.changedTouches[0];
      const r = this.el.getBoundingClientRect();
      this.active = {
        id: t.identifier,
        cx: r.left + r.width / 2,
        cy: r.top + r.height / 2,
        radius: r.width * 0.42,
      };
      this.el.classList.add('active');
      this.move(t.clientX, t.clientY);
      onChange();
      e.preventDefault();
      e.stopPropagation();
    }, { passive: false });
  }

  owns(id: number): boolean {
    return this.active !== null && this.active.id === id;
  }

  get engaged(): boolean {
    return this.active !== null;
  }

  move(px: number, py: number): void {
    if (!this.active) return;
    const dx = px - this.active.cx;
    const dy = py - this.active.cy;
    const len = Math.hypot(dx, dy) || 1;
    const clamped = Math.min(len, this.active.radius);
    this.x = (dx / len) * (clamped / this.active.radius);
    this.y = -(dy / len) * (clamped / this.active.radius); // screen-down is -y
    const kx = (dx / len) * clamped;
    const ky = (dy / len) * clamped;
    this.knob.style.transform = `translate(calc(-50% + ${kx}px), calc(-50% + ${ky}px))`;
  }

  release(): void {
    this.active = null;
    this.x = 0;
    this.y = 0;
    this.el.classList.remove('active');
    this.knob.style.transform = 'translate(-50%,-50%)';
  }
}

export class TouchControls {
  private root: HTMLDivElement;
  private moveStick: Stick;
  private lookStick: Stick;
  /**
   * Camera rotation rate at full stick deflection, in radians/second, converted
   * to the mouse-pixel units the camera consumes (0.0028 rad per px of yaw).
   */
  private static readonly LOOK_PX_PER_SEC = 620;
  private revealed = false;

  /**
   * Returns a controller on any touch-capable device, or null on pure
   * mouse hardware (where nothing is created and no listeners are registered).
   *
   * On touch-PRIMARY devices the overlay is shown immediately. On hybrid
   * machines (touchscreen laptop with a mouse) the instance exists but stays
   * hidden until the first real touch, so a desktop never sprouts a joystick
   * unless the user actually touches the screen.
   *
   * The instance is returned in BOTH cases on purpose: the right stick is a
   * rate control that needs a per-frame update() from the caller, so returning
   * null for the deferred case silently disabled camera rotation.
   */
  static attach(input: Input, onSkill?: (index: number) => void): TouchControls | null {
    if (!hasTouchCapability() && !isTouchPrimary()) return null;
    return new TouchControls(input, onSkill, !isTouchPrimary());
  }

  private constructor(
    private input: Input,
    onSkill?: (index: number) => void,
    deferred = false,
  ) {
    const style = document.createElement('style');
    style.textContent = CSS;
    document.head.appendChild(style);

    this.root = document.createElement('div');
    this.root.className = 'cp-touch';

    // -- twin sticks: movement bottom-left, camera bottom-right --------------
    this.moveStick = new Stick('move', 'MOVE', () => {
      this.input.setStick(this.moveStick.x, this.moveStick.y);
    });
    this.lookStick = new Stick('look', 'LOOK', () => {
      this.input.setTouchLooking(true);
    });
    this.root.appendChild(this.moveStick.el);
    this.root.appendChild(this.lookStick.el);

    // -- skills --------------------------------------------------------------
    const skills = document.createElement('div');
    skills.className = 'cp-skills';
    for (let i = 0; i < 4; i++) {
      const b = document.createElement('button');
      b.className = 'cp-skill';
      b.textContent = String(i + 1);
      b.addEventListener('touchstart', (e) => {
        e.preventDefault();
        e.stopPropagation();
        this.input.tapVirtual(`Digit${i + 1}`);
        onSkill?.(i);
      }, { passive: false });
      skills.appendChild(b);
    }
    this.root.appendChild(skills);

    // -- action buttons ------------------------------------------------------
    const btns = document.createElement('div');
    btns.className = 'cp-btns';
    const mkButton = (
      cls: string, label: string,
      onDown: () => void, onUp?: () => void,
    ): void => {
      const b = document.createElement('button');
      b.className = `cp-btn ${cls}`;
      b.textContent = label;
      b.addEventListener('touchstart', (e) => {
        e.preventDefault();
        e.stopPropagation();
        b.classList.add('on');
        onDown();
      }, { passive: false });
      const release = (): void => { b.classList.remove('on'); onUp?.(); };
      b.addEventListener('touchend', release);
      b.addEventListener('touchcancel', release);
      btns.appendChild(b);
    };

    mkButton('attack', 'ATK',
      () => this.input.setVirtualAttack(true),
      () => this.input.setVirtualAttack(false));
    mkButton('jump', 'JUMP',
      () => this.input.setVirtualButton('Space', true),
      () => this.input.setVirtualButton('Space', false));
    mkButton('interact', 'USE', () => this.input.tapVirtual('KeyE'));
    mkButton('swap', 'SWAP', () => this.input.tapVirtual('Tab'));
    this.root.appendChild(btns);

    // Deferred (hybrid mouse+touch) devices keep the overlay hidden until the
    // user actually touches the screen; the instance still ticks, so nothing
    // depends on the DOM being attached.
    this.revealed = !deferred;
    if (deferred) this.root.classList.add('hidden');
    document.body.appendChild(this.root);

    // Global move/end handling so a finger that slides off its stick keeps working.
    window.addEventListener('touchmove', (e) => {
      for (const t of Array.from(e.changedTouches)) {
        if (this.moveStick.owns(t.identifier)) {
          this.moveStick.move(t.clientX, t.clientY);
          this.input.setStick(this.moveStick.x, this.moveStick.y);
          e.preventDefault();
        } else if (this.lookStick.owns(t.identifier)) {
          this.lookStick.move(t.clientX, t.clientY);
          e.preventDefault();
        }
      }
    }, { passive: false });

    const endTouch = (e: TouchEvent): void => {
      for (const t of Array.from(e.changedTouches)) {
        if (this.moveStick.owns(t.identifier)) {
          this.moveStick.release();
          this.input.setStick(0, 0);
        } else if (this.lookStick.owns(t.identifier)) {
          this.lookStick.release();
          this.input.setTouchLooking(false);
        }
      }
    };
    window.addEventListener('touchend', endTouch);
    window.addEventListener('touchcancel', endTouch);

    // First real touch anywhere marks the session as touch-driven (which also
    // stops the mouse handler from grabbing pointer lock) and reveals the
    // overlay on hybrid devices.
    window.addEventListener('touchstart', () => {
      this.input.touchActive = true;
      this.revealed = true;
      this.root.classList.remove('hidden');
    }, { passive: true });
  }

  /**
   * Call once per frame. The right stick is a RATE control — held deflection
   * turns the camera continuously — so it must feed the look delta every frame
   * rather than only on touchmove like a drag would.
   */
  update(dt: number): void {
    if (!this.lookStick.engaged) return;
    const k = TouchControls.LOOK_PX_PER_SEC * Math.min(dt, 0.05);
    // Camera treats +mouseDY as looking down, matching a mouse; pushing the
    // stick up should look up, hence the negated y.
    this.input.addLook(this.lookStick.x * k, -this.lookStick.y * k);
    this.input.setTouchLooking(true);
  }

  /** True once a real touch has been seen (always true on touch-primary devices). */
  get isRevealed(): boolean { return this.revealed; }

  /**
   * Hide the overlay (e.g. while a modal shop is open). Never reveals a
   * deferred overlay — a mouse-driven touchscreen laptop must stay clean until
   * the user actually touches the screen, and this is called every frame.
   */
  setVisible(v: boolean): void {
    this.root.classList.toggle('hidden', !v || !this.revealed);
    if (!v) {
      this.moveStick.release();
      this.lookStick.release();
      this.input.setStick(0, 0);
      this.input.setTouchLooking(false);
      this.input.setVirtualAttack(false);
      this.input.setVirtualButton('Space', false);
    }
  }

  dispose(): void {
    this.root.remove();
  }
}
